// 실시간 그래뉼러 피치 시프터 — 지연선 + 이중 그레인 크로스페이드.
// 라이브 피치 시프터의 고전 기법: 링버퍼에 입력을 쓰고, 두 읽기 헤드가
// ratio 속도로 읽으며 반주기 어긋난 창으로 크로스페이드한다. 지연 ~40ms.
//
// 이 파일은 세 환경에서 로드된다:
//  - AudioWorklet 스코프: registerProcessor("omni-grain-shifter") 등록
//  - 일반 스크립트 태그: window.OmniGrainCore (ScriptProcessor 폴백용)
//  - Node: module.exports (수치 테스트용)
(function () {
  "use strict";

  class GrainCore {
    constructor(sampleRate) {
      this.sr = sampleRate || 48000;
      this.grain = Math.round(this.sr * 0.04); // 40ms 그레인
      this.size = 1 << Math.ceil(Math.log2(this.grain * 4));
      this.mask = this.size - 1;
      this.buf = new Float32Array(this.size);
      this.w = 0;          // 쓰기 위치
      this.phase = 0;      // 그레인 위상 [0,1)
    }

    // in/out: Float32Array 같은 길이, ratio: 0.5~2
    process(input, output, ratio) {
      const { buf, mask, grain } = this;
      // 읽기 위치 = w - phase*grain 이므로 d(pos)/dn = 1 - grain*step = ratio
      const step = (1 - ratio) / grain;
      for (let i = 0; i < input.length; i++) {
        buf[this.w & mask] = input[i];
        this.w++;
        this.phase += step;
        this.phase -= Math.floor(this.phase); // [0,1) 유지
        // 헤드 A: 지연 = phase*grain, 헤드 B: 반주기 오프셋
        let out = 0;
        for (let h = 0; h < 2; h++) {
          let ph = this.phase + h * 0.5;
          ph -= Math.floor(ph);
          const delay = ph * grain + 1;
          const pos = this.w - 1 - delay;
          const i0 = Math.floor(pos);
          const frac = pos - i0;
          const a = buf[i0 & mask];
          const b = buf[(i0 + 1) & mask];
          const s = a + (b - a) * frac;
          // Hann 창: 그레인 경계(위상 0/1)에서 0 → 점프 클릭 제거
          const g = 0.5 - 0.5 * Math.cos(2 * Math.PI * ph);
          out += s * g;
        }
        output[i] = out;
      }
    }
  }

  if (typeof registerProcessor === "function"
      && typeof AudioWorkletProcessor === "function") {
    // AudioWorklet 스코프
    class OmniGrainShifter extends AudioWorkletProcessor {
      static get parameterDescriptors() {
        return [{
          name: "ratio", defaultValue: 1,
          minValue: 0.4, maxValue: 2.5, automationRate: "k-rate",
        }];
      }

      constructor() {
        super();
        this.core = new GrainCore(sampleRate);
      }

      process(inputs, outputs, params) {
        const inp = inputs[0] && inputs[0][0];
        const out = outputs[0] && outputs[0][0];
        if (inp && out) this.core.process(inp, out, params.ratio[0]);
        return true;
      }
    }
    registerProcessor("omni-grain-shifter", OmniGrainShifter);
  } else if (typeof module !== "undefined" && module.exports) {
    module.exports = { GrainCore };
  } else if (typeof window !== "undefined") {
    window.OmniGrainCore = GrainCore;
  }
})();
