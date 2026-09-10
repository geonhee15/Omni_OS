#!/usr/bin/env python3
"""폰 안경 손 추적 — 카메라 줌 제스처용 (MediaPipe HandLandmarker, 서버에서 실행).

폰이 보내는 풀 프레임에서 손 하나를 찾아
  present  손이 보이는가
  size     손 상자의 긴 변(프레임 대비 0~1) — 카메라에 가까울수록 큼
  fist     네 손가락이 모두 접힘(주먹)
  pinch    엄지 끝~검지 끝 거리 / 손 크기(손목~중지 뿌리) — 벌릴수록 큼
  extended 펴진 손가락 수
를 돌려준다. 줌 규칙은 폰 쪽(phone.html)에서: 주먹이 가까이 보이면 줌 모드 → 엄지·검지 벌림 = 확대.
"""
import io
import math
import os
import time

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, "models", "hand_landmarker.task")

try:
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions, vision
    AVAILABLE = os.path.exists(MODEL)
except Exception:  # noqa: BLE001
    AVAILABLE = False


def _d(a, b) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def analyze_landmarks(pts: list[tuple[float, float]]) -> dict:
    """21개 정규화 랜드마크 → 제스처 특징 (순수 기하, 테스트 가능)."""
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    size = max(max(xs) - min(xs), max(ys) - min(ys))
    wrist = pts[0]
    span = _d(wrist, pts[9]) or 1e-6
    curled = 0
    for mcp, pip, tip in ((5, 6, 8), (9, 10, 12), (13, 14, 16), (17, 18, 20)):
        if _d(wrist, pts[tip]) < _d(wrist, pts[pip]) * 1.05:
            curled += 1
    pinch = _d(pts[4], pts[8]) / span
    return {"present": True, "size": round(size, 3), "fist": curled == 4, "extended": 4 - curled,
            "pinch": round(pinch, 3), "cx": round(sum(xs) / 21, 3), "cy": round(sum(ys) / 21, 3)}


class HandTracker:
    def __init__(self):
        self.ok = AVAILABLE
        self.lm = None
        self.t0 = time.monotonic()
        self.last_ts = 0
        if self.ok:
            try:
                opts = vision.HandLandmarkerOptions(
                    base_options=BaseOptions(model_asset_path=MODEL),
                    running_mode=vision.RunningMode.VIDEO, num_hands=1,
                    min_hand_detection_confidence=0.5, min_hand_presence_confidence=0.5,
                    min_tracking_confidence=0.5)
                self.lm = vision.HandLandmarker.create_from_options(opts)
            except Exception:  # noqa: BLE001
                self.ok = False

    def analyze(self, jpeg: bytes) -> dict:
        if not self.ok or self.lm is None:
            return {"present": False, "off": True}
        try:
            img = Image.open(io.BytesIO(jpeg)).convert("RGB")
            arr = np.asarray(img, dtype=np.uint8)
            mimg = mp.Image(image_format=mp.ImageFormat.SRGB, data=arr)
            ts = int((time.monotonic() - self.t0) * 1000)
            if ts <= self.last_ts:
                ts = self.last_ts + 1
            self.last_ts = ts
            res = self.lm.detect_for_video(mimg, ts)
            if not res.hand_landmarks:
                return {"present": False}
            pts = [(l.x, l.y) for l in res.hand_landmarks[0]]
            return analyze_landmarks(pts)
        except Exception as e:  # noqa: BLE001
            return {"present": False, "error": str(e)[:80]}
