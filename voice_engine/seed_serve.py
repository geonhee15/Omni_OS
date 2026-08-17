#!/usr/bin/env python3
"""OMNI_AI 외국어 로봇 보이스 데몬 — Seed-VC 상주 변환 서버.

kNN-VC(한국어 전용 매칭셋)는 외국어를 한국어 음소로 갈아끼워 억양이 생기므로,
비한국어는 Seed-VC로 변환한다: 발음(콘텐츠)은 소스를 그대로 보존하고 음색만
대사팩 프롬프트에서 가져와 전 언어에서 동일한 로봇 목소리가 된다.

모델과 레퍼런스 쪽 연산(시맨틱·멜·스타일·F0·프롬프트 조건)을 기동 시 1회만
수행하고, 요청마다 소스 쪽 연산 + 확산만 돌린다.

프로토콜: stdout "READY" 후, stdin JSON 라인 {"in": path, "out": path}
→ stdout JSON 라인 {"ok": true, "seconds": N} (모델 로그는 stderr로 우회)

사용: seed_serve.py <ref_prompt.wav> [diffusion_steps=15]
"""
import contextlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SEEDVC = os.path.join(HERE, "seedvc")

try:
    import certifi
    os.environ.setdefault("SSL_CERT_FILE", certifi.where())
    os.environ.setdefault("REQUESTS_CA_BUNDLE", certifi.where())
except ImportError:
    pass


def patch_torch():
    import numpy as np
    import soundfile as sf
    import torch
    import torchaudio

    def _load(path, normalize=True, **kw):
        data, sr = sf.read(str(path), dtype="float32", always_2d=True)
        return torch.from_numpy(np.ascontiguousarray(data.T)), sr

    def _save(path, tensor, sample_rate, **kw):
        arr = tensor.detach().cpu().numpy()
        if arr.ndim == 2:
            arr = arr.T
        sf.write(str(path), arr, sample_rate)

    torchaudio.load = _load
    torchaudio.save = _save

    # MPS는 float64 미지원 — F0(rmvpe) 결과 캐스팅
    _orig = torch.from_numpy

    def _f32(arr):
        if isinstance(arr, np.ndarray) and arr.dtype == np.float64:
            arr = arr.astype(np.float32)
        return _orig(arr)

    torch.from_numpy = _f32


def main():
    ref_path = sys.argv[1]
    steps = int(sys.argv[2]) if len(sys.argv) > 2 else 15
    real_stdout = sys.stdout

    patch_torch()
    os.chdir(SEEDVC)
    sys.path.insert(0, SEEDVC)

    with contextlib.redirect_stdout(sys.stderr):
        import librosa
        import numpy as np
        import torch
        import torchaudio
        import inference as inf

        class Args:
            f0_condition = True
            auto_f0_adjust = True
            semi_tone_shift = 0
            checkpoint = None
            config = None
            fp16 = False

        (model, semantic_fn, f0_fn, vocoder_fn,
         campplus_model, mel_fn, mel_fn_args) = inf.load_models(Args())
        device = inf.device
        sr = 44100          # f0-condition 모델
        hop_length = 512
        max_context_window = sr // hop_length * 30
        overlap_frame_len = 16
        overlap_wave_len = overlap_frame_len * hop_length

        # ── 레퍼런스(대사팩 프롬프트) 사전 계산 — 매 요청 재사용 ──
        ref_np = librosa.load(ref_path, sr=sr)[0]
        ref_audio = torch.tensor(ref_np[:sr * 25]).unsqueeze(0).float().to(device)
        ori_waves_16k = torchaudio.functional.resample(ref_audio, sr, 16000)
        S_ori = semantic_fn(ori_waves_16k)
        mel2 = mel_fn(ref_audio)
        target2_lengths = torch.LongTensor([mel2.size(2)]).to(device)
        feat2 = torchaudio.compliance.kaldi.fbank(
            ori_waves_16k, num_mel_bins=80, dither=0, sample_frequency=16000)
        feat2 = feat2 - feat2.mean(dim=0, keepdim=True)
        style2 = campplus_model(feat2.unsqueeze(0))
        F0_ori = torch.from_numpy(f0_fn(ori_waves_16k[0], thred=0.03)).to(device)[None]
        prompt_condition, _, _, _, _ = model.length_regulator(
            S_ori, ylens=target2_lengths, n_quantizers=3, f0=F0_ori)
        voiced_ori = F0_ori[F0_ori > 1]
        median_log_f0_ori = torch.median(torch.log(voiced_ori + 1e-5))
        max_source_window = max_context_window - mel2.size(2)

    print("READY", file=real_stdout, flush=True)

    import numpy as np
    import torch
    import torchaudio

    def crossfade(c1, c2, ov):
        fade_out = np.cos(np.linspace(0, np.pi / 2, ov)) ** 2
        fade_in = np.cos(np.linspace(np.pi / 2, 0, ov)) ** 2
        c2[:ov] = c2[:ov] * fade_in + c1[-ov:] * fade_out
        return c2

    @torch.no_grad()
    def convert(in_path, out_path):
        import librosa
        src = librosa.load(in_path, sr=sr)[0]
        source_audio = torch.tensor(src).unsqueeze(0).float().to(device)
        waves_16k = torchaudio.functional.resample(source_audio, sr, 16000)
        S_alt = semantic_fn(waves_16k)  # TTS 문장은 30초 미만
        mel = mel_fn(source_audio)
        target_lengths = torch.LongTensor([mel.size(2)]).to(device)

        F0_alt = torch.from_numpy(f0_fn(waves_16k[0], thred=0.03)).to(device)[None]
        voiced_alt = F0_alt[F0_alt > 1]
        log_f0_alt = torch.log(F0_alt + 1e-5)
        median_log_f0_alt = torch.median(torch.log(voiced_alt + 1e-5))
        shifted = log_f0_alt.clone()
        shifted[F0_alt > 1] = (log_f0_alt[F0_alt > 1]
                               - median_log_f0_alt + median_log_f0_ori)
        shifted_f0_alt = torch.exp(shifted)

        cond, _, _, _, _ = model.length_regulator(
            S_alt, ylens=target_lengths, n_quantizers=3, f0=shifted_f0_alt)

        processed = 0
        chunks = []
        previous = None
        while processed < cond.size(1):
            chunk_cond = cond[:, processed:processed + max_source_window]
            is_last = processed + max_source_window >= cond.size(1)
            cat = torch.cat([prompt_condition, chunk_cond], dim=1)
            vc_target = model.cfm.inference(
                cat, torch.LongTensor([cat.size(1)]).to(device),
                mel2, style2, None, steps, inference_cfg_rate=0.3)
            vc_target = vc_target[:, :, mel2.size(-1):]
            vc_wave = vocoder_fn(vc_target.float()).squeeze()[None, :]
            if processed == 0 and is_last:
                chunks.append(vc_wave[0].cpu().numpy())
                break
            if processed == 0:
                chunks.append(vc_wave[0, :-overlap_wave_len].cpu().numpy())
                previous = vc_wave[0, -overlap_wave_len:]
            elif is_last:
                chunks.append(crossfade(previous.cpu().numpy(),
                                        vc_wave[0].cpu().numpy(), overlap_wave_len))
            else:
                chunks.append(crossfade(previous.cpu().numpy(),
                                        vc_wave[0, :-overlap_wave_len].cpu().numpy(),
                                        overlap_wave_len))
                previous = vc_wave[0, -overlap_wave_len:]
            processed += vc_target.size(2) - overlap_frame_len
        out = np.concatenate(chunks).astype(np.float32)
        peak = max(abs(out).max(), 1e-9)
        import soundfile as sf
        sf.write(out_path, out / peak * 0.95, sr)
        return len(out) / sr

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            with contextlib.redirect_stdout(sys.stderr):
                seconds = convert(req["in"], req["out"])
            resp = {"ok": True, "seconds": round(seconds, 2)}
        except Exception as e:  # 요청 하나의 실패가 데몬을 죽이지 않게
            resp = {"ok": False, "error": str(e)[:200]}
        print(json.dumps(resp), file=real_stdout, flush=True)


if __name__ == "__main__":
    main()
