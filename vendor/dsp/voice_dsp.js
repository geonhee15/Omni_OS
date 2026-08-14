// Voice DSP — 오프라인 음성 변환 엔진 (외부 의존성 없음, 순수 JS).
// 레퍼런스 음성에서 프로파일(기준 피치 + 장기평균 스펙트럼 포락선)을 추출하고,
// 대상 오디오를 그 피치에 맞춰 위상 보코더로 피치 시프트한 뒤 스펙트럼 포락선을
// 레퍼런스 쪽으로 매칭한다. 신경망 복제가 아닌 신호처리 기반 음색 전이.
//
// 브라우저에서는 window.OmniVoiceDSP, Node에서는 module.exports 로 노출된다.
(function (root) {
  "use strict";

  // ── radix-2 반복 FFT (in-place, 복소) ──
  function fft(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        const tr = re[i]; re[i] = re[j]; re[j] = tr;
        const ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (inverse ? 2 : -2) * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = i + k + len / 2;
          const tr = re[b] * cr - im[b] * ci;
          const ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }
  }

  function hann(N) {
    const w = new Float32Array(N);
    for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    return w;
  }

  // ── 선형 보간 리샘플 (길이 = round(x.length * factor)) ──
  function resample(x, factor) {
    const outLen = Math.max(1, Math.round(x.length * factor));
    const out = new Float32Array(outLen);
    const step = (x.length - 1) / (outLen - 1 || 1);
    for (let i = 0; i < outLen; i++) {
      const p = i * step;
      const i0 = Math.floor(p);
      const frac = p - i0;
      const a = x[i0] || 0;
      const b = x[i0 + 1] !== undefined ? x[i0 + 1] : a;
      out[i] = a + (b - a) * frac;
    }
    return out;
  }

  // ── 자기상관 기반 F0 추정 (프레임별 중앙값, 무성/저에너지 프레임 제외) ──
  function estimatePitch(x, sr, fmin, fmax) {
    fmin = fmin || 70;
    fmax = fmax || 400;
    const frame = Math.min(2048, 1 << Math.round(Math.log2(sr * 0.04)));
    const hop = Math.floor(frame / 2);
    const lagMin = Math.floor(sr / fmax);
    const lagMax = Math.min(frame - 1, Math.floor(sr / fmin));
    const pitches = [];
    let totalEnergy = 0, frames = 0;
    for (let s = 0; s + frame <= x.length; s += hop) {
      let energy = 0;
      for (let i = 0; i < frame; i++) energy += x[s + i] * x[s + i];
      energy /= frame;
      totalEnergy += energy;
      frames++;
    }
    const eThresh = (totalEnergy / Math.max(1, frames)) * 0.5;
    for (let s = 0; s + frame <= x.length; s += hop) {
      let energy = 0;
      for (let i = 0; i < frame; i++) energy += x[s + i] * x[s + i];
      energy /= frame;
      if (energy < eThresh || energy < 1e-6) continue;
      let bestLag = -1, best = 0, r0 = 0;
      for (let i = 0; i < frame; i++) r0 += x[s + i] * x[s + i];
      if (r0 <= 0) continue;
      for (let lag = lagMin; lag <= lagMax; lag++) {
        let sum = 0;
        for (let i = 0; i + lag < frame; i++) sum += x[s + i] * x[s + i + lag];
        const norm = sum / r0;
        if (norm > best) { best = norm; bestLag = lag; }
      }
      if (bestLag > 0 && best > 0.3) pitches.push(sr / bestLag);
    }
    if (!pitches.length) return 0;
    pitches.sort((a, b) => a - b);
    return pitches[Math.floor(pitches.length / 2)];
  }

  // ── 장기 평균 스펙트럼(LTAS) + 스펙트럼 무게중심 ──
  function analyzeProfile(x, sr) {
    const N = 1024, hop = 256;
    const w = hann(N);
    const half = N / 2;
    const ltas = new Float32Array(half);
    let frames = 0;
    const re = new Float32Array(N), im = new Float32Array(N);
    for (let s = 0; s + N <= x.length; s += hop) {
      for (let i = 0; i < N; i++) { re[i] = x[s + i] * w[i]; im[i] = 0; }
      fft(re, im, false);
      for (let k = 0; k < half; k++) {
        ltas[k] += Math.hypot(re[k], im[k]);
      }
      frames++;
    }
    if (frames > 0) for (let k = 0; k < half; k++) ltas[k] /= frames;
    // 스펙트럼 무게중심(밝기) — Hz
    let num = 0, den = 0;
    for (let k = 0; k < half; k++) {
      const f = (k * sr) / N;
      num += f * ltas[k];
      den += ltas[k];
    }
    const centroid = den > 0 ? num / den : 0;
    return {
      pitch: estimatePitch(x, sr),
      ltas,
      centroid,
      sr,
      frames,
      duration: x.length / sr,
    };
  }

  // 로그-주파수 스무딩 (포락선만 남기고 하모닉 리플 제거)
  function smoothLtas(ltas, octaveFrac) {
    const half = ltas.length;
    const out = new Float32Array(half);
    const frac = octaveFrac || 0.5;
    for (let k = 0; k < half; k++) {
      const lo = Math.max(1, Math.floor(k * Math.pow(2, -frac)));
      const hi = Math.min(half - 1, Math.ceil(k * Math.pow(2, frac)));
      let sum = 0, cnt = 0;
      for (let j = lo; j <= hi; j++) { sum += ltas[j]; cnt++; }
      out[k] = cnt > 0 ? sum / cnt : ltas[k];
    }
    return out;
  }

  // ── 위상 보코더 시간 신축 (길이 ≈ x.length * stretch) ──
  function timeStretch(x, stretch) {
    const N = 1024, hopA = 256;
    const hopS = Math.max(1, Math.round(hopA * stretch));
    const w = hann(N);
    const half = N / 2;
    const outLen = Math.ceil(x.length * stretch) + N;
    const out = new Float32Array(outLen);
    const winSum = new Float32Array(outLen);
    const re = new Float32Array(N), im = new Float32Array(N);
    const lastPhase = new Float32Array(half + 1);
    const sumPhase = new Float32Array(half + 1);
    const expct = new Float32Array(half + 1);
    for (let k = 0; k <= half; k++) expct[k] = (2 * Math.PI * hopA * k) / N;
    let outPos = 0;
    for (let s = 0; s + N <= x.length; s += hopA) {
      for (let i = 0; i < N; i++) { re[i] = x[s + i] * w[i]; im[i] = 0; }
      fft(re, im, false);
      for (let k = 0; k <= half; k++) {
        const mag = Math.hypot(re[k], im[k]);
        const phase = Math.atan2(im[k], re[k]);
        let dphi = phase - lastPhase[k] - expct[k];
        lastPhase[k] = phase;
        dphi = dphi - 2 * Math.PI * Math.round(dphi / (2 * Math.PI));
        const trueFreq = expct[k] + dphi;
        sumPhase[k] += (hopS / hopA) * trueFreq;
        const ph = sumPhase[k];
        re[k] = mag * Math.cos(ph);
        im[k] = mag * Math.sin(ph);
        if (k > 0 && k < half) {
          re[N - k] = mag * Math.cos(ph);
          im[N - k] = -mag * Math.sin(ph);
        }
      }
      fft(re, im, true);
      for (let i = 0; i < N; i++) {
        const idx = outPos + i;
        if (idx < outLen) {
          out[idx] += re[i] * w[i];
          winSum[idx] += w[i] * w[i];
        }
      }
      outPos += hopS;
    }
    // 윈도우 합이 충분히 쌓인 구간만 정규화 — 경계(합≈0)에서 나누면 진폭이 폭발한다
    let wMax = 0;
    for (let i = 0; i < outLen; i++) if (winSum[i] > wMax) wMax = winSum[i];
    const wFloor = Math.max(1e-6, wMax * 0.1);
    const finalLen = Math.round(x.length * stretch);
    const res = new Float32Array(finalLen);
    for (let i = 0; i < finalLen; i++) {
      res[i] = winSum[i] >= wFloor ? out[i] / winSum[i] : 0;
    }
    return res;
  }

  // 피치 시프트 (길이 보존): 시간 신축 후 리샘플로 되돌림
  function pitchShift(x, ratio) {
    if (Math.abs(ratio - 1) < 1e-3) return x.slice();
    const stretched = timeStretch(x, ratio);
    const back = resample(stretched, 1 / ratio);
    const out = new Float32Array(x.length);
    out.set(back.subarray(0, Math.min(out.length, back.length)));
    return out;
  }

  // ── 스펙트럼 포락선 매칭: 대상 각 프레임 크기에 (ref/tgt) 이득곡선 곱 ──
  function envelopeMatch(x, sr, refLtas, tgtLtas) {
    const N = 1024, hop = 256;
    const w = hann(N);
    const half = N / 2;
    const rs = smoothLtas(refLtas, 0.5);
    const ts = smoothLtas(tgtLtas, 0.5);
    const rMean = rs.reduce((a, b) => a + b, 0) / rs.length || 1;
    const tMean = ts.reduce((a, b) => a + b, 0) / ts.length || 1;
    // 이득곡선 = 정규화된 ref 포락선 / 정규화된 tgt 포락선 (과도 이득 제한)
    const gain = new Float32Array(half + 1);
    for (let k = 0; k < half; k++) {
      const r = rs[k] / rMean;
      const t = ts[k] / tMean;
      let g = t > 1e-6 ? r / t : 1;
      g = Math.max(0.05, Math.min(20, g));
      gain[k] = g;
    }
    gain[half] = gain[half - 1];
    const outLen = x.length;
    const out = new Float32Array(outLen);
    const winSum = new Float32Array(outLen);
    const re = new Float32Array(N), im = new Float32Array(N);
    for (let s = 0; s + N <= x.length + hop; s += hop) {
      for (let i = 0; i < N; i++) {
        const idx = s + i;
        re[i] = idx < x.length ? x[idx] * w[i] : 0;
        im[i] = 0;
      }
      fft(re, im, false);
      for (let k = 0; k <= half; k++) {
        re[k] *= gain[k];
        im[k] *= gain[k];
        if (k > 0 && k < half) {
          re[N - k] = re[k];
          im[N - k] = -im[k];
        }
      }
      fft(re, im, true);
      for (let i = 0; i < N; i++) {
        const idx = s + i;
        if (idx >= 0 && idx < outLen) {
          out[idx] += re[i] * w[i];
          winSum[idx] += w[i] * w[i];
        }
      }
    }
    let wMax = 0;
    for (let i = 0; i < outLen; i++) if (winSum[i] > wMax) wMax = winSum[i];
    const wFloor = Math.max(1e-6, wMax * 0.1);
    for (let i = 0; i < outLen; i++) {
      out[i] = winSum[i] >= wFloor ? out[i] / winSum[i] : 0;
    }
    return out;
  }

  function peak(x) {
    let m = 0;
    for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > m) m = a; }
    return m;
  }

  function normalize(x, target) {
    const p = peak(x);
    if (p < 1e-6) return x;
    const g = (target || 0.97) / p;
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) out[i] = x[i] * g;
    return out;
  }

  // ── 메인: 프로파일을 대상 오디오에 적용 ──
  // opts: { pitch:true, timbre:true, strength:0..1, formant:반음(선택) }
  function applyProfile(target, sr, refProfile, opts) {
    opts = opts || {};
    const strength = opts.strength != null ? opts.strength : 1;
    const tgtProfile = analyzeProfile(target, sr);
    let y = target;
    let pitchRatio = 1;
    if (opts.pitch !== false && refProfile.pitch > 0 && tgtProfile.pitch > 0) {
      pitchRatio = refProfile.pitch / tgtProfile.pitch;
      // 극단 시프트 방지 (±1 옥타브)
      pitchRatio = Math.max(0.5, Math.min(2, pitchRatio));
      // strength 로 보간 (1 = 완전 매칭)
      pitchRatio = Math.pow(pitchRatio, strength);
      y = pitchShift(y, pitchRatio);
    }
    if (opts.timbre !== false && refProfile.ltas) {
      // 피치 시프트가 이미 스펙트럼을 옮겼으므로, 보정 기준은 시프트 '후'의
      // 스펙트럼이어야 한다 (원본 기준으로 재보정하면 음색이 과하게 어두워짐)
      const curLtas = pitchRatio !== 1 ? analyzeProfile(y, sr).ltas : tgtProfile.ltas;
      const matched = envelopeMatch(y, sr, refProfile.ltas, curLtas);
      if (strength >= 0.999) {
        y = matched;
      } else {
        // dry/wet 블렌드
        const blended = new Float32Array(y.length);
        for (let i = 0; i < y.length; i++) {
          blended[i] = y[i] * (1 - strength) + matched[i] * strength;
        }
        y = blended;
      }
    }
    return {
      audio: normalize(y, 0.97),
      pitchRatio,
      tgtPitch: tgtProfile.pitch,
      refPitch: refProfile.pitch,
    };
  }

  const api = {
    fft, hann, resample, estimatePitch, analyzeProfile,
    smoothLtas, timeStretch, pitchShift, envelopeMatch,
    normalize, peak, applyProfile,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.OmniVoiceDSP = api;
})(typeof self !== "undefined" ? self : this);
