#!/usr/bin/env python3
"""HUD 스프라이트 패킷 합성기 — 안경(Lua) 대신 호스트에서 256×256 원형 HUD를 그린다.

폰 안경 모드에서 쓴다: hud.py가 만드는 0x12(배경+팔레트) / 0x13(상태) / 0x14(자막) /
0x15(배너) 패킷을 그대로 받아 태그별 레이어로 겹쳐 PNG로 내보낸다.
안경 실기기가 보여 줄 수 있는 최대 화면 = 이 256×256 16색 원형 디스플레이.
"""
import io

import numpy as np
from PIL import Image

from hud import PALETTE, W, H

_TAGS = (0x13, 0x14, 0x15, 0x16)   # 상태 / 자막 / 배너 / 카메라 텍스트 리더


def _unpack4(data: bytes, w: int) -> np.ndarray:
    row_bytes = (w + 1) // 2
    h = len(data) // row_bytes if row_bytes else 0
    a = np.frombuffer(data[:h * row_bytes], dtype=np.uint8).reshape(h, row_bytes)
    idx = np.empty((h, row_bytes * 2), np.uint8)
    idx[:, 0::2] = a >> 4
    idx[:, 1::2] = a & 0x0F
    return idx[:, :w]


class HudCanvas:
    def __init__(self, minimal: bool = False):
        self.minimal = minimal      # True면 배경 아트(링·워드마크) 없이 상태·자막·배너·리더만
        self.palette = [tuple(c) for c in PALETTE]
        self.background = np.zeros((H, W), np.uint8)
        self.layers: dict[int, tuple[int, int, np.ndarray]] = {}
        self.version = 0

    def apply(self, packet: bytes) -> bool:
        """패킷 반영. 화면이 바뀌면 True."""
        if not packet:
            return False
        tag = packet[0]
        if tag == 0x12:
            pal = packet[1:49]
            self.palette = [tuple(pal[i * 3:i * 3 + 3]) for i in range(16)]
            self.background = _unpack4(packet[49:], W)[:H]
            self.version += 1
            return True
        if tag in _TAGS and len(packet) >= 4:
            x, y, w = packet[1], packet[2], packet[3]
            idx = _unpack4(packet[4:], w)
            self.layers[tag] = (x, y, idx)
            self.version += 1
            return True
        return False

    def compose(self) -> np.ndarray:
        canvas = np.zeros((H, W), np.uint8) if self.minimal else self.background.copy()
        for tag in _TAGS:
            if tag not in self.layers:
                continue
            x, y, idx = self.layers[tag]
            h, w = idx.shape
            y1, x1 = min(H, y + h), min(W, x + w)
            if y >= H or x >= W:
                continue
            sub = idx[:y1 - y, :x1 - x]
            region = canvas[y:y1, x:x1]
            mask = sub > 0
            region[mask] = sub[mask]
        # 원형 마스크 (안경 디스플레이 밖은 투명)
        yy, xx = np.mgrid[0:H, 0:W]
        outside = (xx - (W - 1) / 2) ** 2 + (yy - (H - 1) / 2) ** 2 > (W / 2) ** 2
        canvas[outside] = 0
        return canvas

    def png(self) -> bytes:
        idx = self.compose()
        lut = np.zeros((16, 4), np.uint8)
        for i, rgb in enumerate(self.palette):
            lut[i, :3] = rgb
            lut[i, 3] = 0 if i == 0 else 255
        rgba = lut[idx]
        buf = io.BytesIO()
        Image.fromarray(rgba, "RGBA").save(buf, format="PNG", optimize=True)
        return buf.getvalue()
