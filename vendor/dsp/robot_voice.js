// OMNI_AI 레트로 로봇 보이스 — TTS 출력에 옛날 기계 로봇 질감을 입히는 체인.
// 대역 제한(구형 스피커) → 링 모듈레이션(고전 SF 로봇 변조) →
// 비트크러시(초기 디지털 양자화) → 소프트클립 → 정규화.
// 피치 다운은 OmniVoiceDSP.pitchShift 로 이 체인 앞에서 따로 건다.
//
// 브라우저: window.OmniRobotVoice, Node: module.exports (수치 테스트용)
(function (root) {
  "use strict";

  // RBJ biquad (Direct Form 1) — 계수 고정, 새 배열 반환
  function biquad(x, b0, b1, b2, a1, a2) {
    const y = new Float32Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x[i];
      y2 = y1; y1 = v;
      y[i] = v;
    }
    return y;
  }

  function lowpass(x, sr, fc, q) {
    q = q || 0.707;
    const w = (2 * Math.PI * fc) / sr;
    const alpha = Math.sin(w) / (2 * q);
    const cw = Math.cos(w);
    const a0 = 1 + alpha;
    return biquad(x,
      ((1 - cw) / 2) / a0, (1 - cw) / a0, ((1 - cw) / 2) / a0,
      (-2 * cw) / a0, (1 - alpha) / a0);
  }

  function highpass(x, sr, fc, q) {
    q = q || 0.707;
    const w = (2 * Math.PI * fc) / sr;
    const alpha = Math.sin(w) / (2 * q);
    const cw = Math.cos(w);
    const a0 = 1 + alpha;
    return biquad(x,
      ((1 + cw) / 2) / a0, -(1 + cw) / a0, ((1 + cw) / 2) / a0,
      (-2 * cw) / a0, (1 - alpha) / a0);
  }

  function robotize(input, sr, opt) {
    opt = opt || {};
    const ringHz = opt.ringHz != null ? opt.ringHz : 42;   // 진폭 버즈 = 2×ringHz
    const wet = opt.wet != null ? opt.wet : 0.8;           // 링모드 비율
    const hold = opt.crushHold != null ? opt.crushHold : 2; // 샘플홀드 (22050→11k)
    const bits = opt.bits != null ? opt.bits : 9;
    const drive = opt.drive != null ? opt.drive : 1.6;

    // DC 제거 + 사전 정규화
    let y = new Float32Array(input.length);
    let mean = 0;
    for (let i = 0; i < input.length; i++) mean += input[i];
    mean /= Math.max(1, input.length);
    let peak = 1e-9;
    for (let i = 0; i < input.length; i++) {
      y[i] = input[i] - mean;
      const a = Math.abs(y[i]);
      if (a > peak) peak = a;
    }
    const pre = 0.95 / peak;
    for (let i = 0; i < y.length; i++) y[i] *= pre;

    // 1) 구형 스피커 대역 (300–3400Hz)
    y = highpass(y, sr, 300);
    y = lowpass(y, sr, 3400);

    // 2) 링 모듈레이션 — 저주파 사인 캐리어와 곱해 금속성 버즈를 만든다
    const w = (2 * Math.PI * ringHz) / sr;
    for (let i = 0; i < y.length; i++) {
      const m = Math.sin(w * i);
      y[i] = y[i] * (1 - wet) + y[i] * m * wet;
    }

    // 3) 비트크러시 — 샘플홀드 다운샘플 + 양자화 (초기 디지털 음성 질감)
    const q = 1 << (bits - 1);
    let held = 0;
    for (let i = 0; i < y.length; i++) {
      if (i % hold === 0) held = Math.round(y[i] * q) / q;
      y[i] = held;
    }

    // 4) 소프트클립 + 최종 정규화
    peak = 1e-9;
    for (let i = 0; i < y.length; i++) {
      y[i] = Math.tanh(y[i] * drive);
      const a = Math.abs(y[i]);
      if (a > peak) peak = a;
    }
    const post = 0.9 / peak;
    for (let i = 0; i < y.length; i++) y[i] *= post;
    return y;
  }

  const api = { robotize, highpass, lowpass };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.OmniRobotVoice = api;
})(typeof window !== "undefined" ? window : globalThis);
