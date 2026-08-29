"""한글 자막 → Halo 1bpp 비트맵 패킷.

디스플레이 폰트에 한글 글리프가 없으므로 호스트에서 Apple SD 산돌고딕으로
래스터라이즈해 frame.display.bitmap(포맷 2 = 1bpp, 팔레트 1=WHITE)용
패킷(0x11 | y | width/8 | packed rows MSB-first)을 만든다.
"""
import numpy as np
from PIL import Image, ImageDraw, ImageFont

FONT_PATH = "/System/Library/Fonts/AppleSDGothicNeo.ttc"
_font_cache: dict[int, ImageFont.FreeTypeFont] = {}

CAP_WIDTH = 224          # 8의 배수 (28바이트/행)
LINE_H = 24
MAX_LINES = 3


def _font(size: int) -> ImageFont.FreeTypeFont:
    if size not in _font_cache:
        _font_cache[size] = ImageFont.truetype(FONT_PATH, size)
    return _font_cache[size]


def wrap_text(text: str, font: ImageFont.FreeTypeFont, width: int) -> list[str]:
    lines: list[str] = []
    cur = ""
    for ch in text.replace("\n", " "):
        if font.getlength(cur + ch) > width:
            lines.append(cur)
            cur = ch.lstrip()
        else:
            cur += ch
    if cur.strip():
        lines.append(cur)
    return lines[-MAX_LINES:]  # 넘치면 최신 줄 우선


def caption_packet(text: str, y: int = 148, size: int = 18) -> bytes:
    """텍스트를 1bpp 비트맵 자막 패킷으로. 빈 텍스트면 h=1 공백 비트맵."""
    font = _font(size)
    lines = wrap_text(text, font, CAP_WIDTH - 4)
    h = max(1, len(lines) * LINE_H)
    img = Image.new("L", (CAP_WIDTH, h), 0)
    draw = ImageDraw.Draw(img)
    for i, line in enumerate(lines):
        draw.text((2, i * LINE_H + 2), line, fill=255, font=font)
    bits = (np.array(img) > 96).astype(np.uint8)
    packed = np.packbits(bits, axis=1).tobytes()  # MSB-first, 행 단위
    return bytes([0x11, y, CAP_WIDTH // 8]) + packed
