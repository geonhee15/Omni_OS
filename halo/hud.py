"""OMNI x Halo HUD 렌더러 — 호스트 사이드 고품질 렌더링.

디스플레이는 256x256 원형, 16색 인덱스드(인덱스 0 = 투명).
글리프/아트를 펌웨어 폰트 대신 호스트에서 2x 슈퍼샘플링 + 안티앨리어싱으로
그린 뒤 시안 램프 팔레트(1=어두움 .. 10=흰색 코어)로 양자화해 4bpp
스프라이트로 전송한다. 결과: 부드러운 글로우 라인의 JARVIS풍 HUD.

패킷 프로토콜 (main.lua와 합의):
  0x12 | palette(48B RGB) | 4bpp 256x256      배경 아트 (부팅 시 1회)
  0x13 | x | y | w_px | 4bpp rows             상태 스프라이트 슬롯
  0x14 | x | y | w_px | 4bpp rows             자막 스프라이트 슬롯
  0x15 | x | y | w_px | 4bpp rows             알림 배너 슬롯
"""
import math

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONT_PATH = "/System/Library/Fonts/AppleSDGothicNeo.ttc"
_font_cache: dict[int, ImageFont.FreeTypeFont] = {}

W = H = 256
CX = CY = 128.0
S = 2  # 슈퍼샘플 배율

# 팔레트: 0 투명, 1..10 시안 램프(어두움->흰색), 11+ 상태 액센트
PALETTE = [
    (0, 0, 0),        # 0 (투명 처리됨)
    (6, 21, 32),      # 1
    (11, 37, 54),     # 2
    (18, 58, 84),     # 3
    (26, 82, 118),    # 4
    (36, 112, 156),   # 5
    (47, 144, 196),   # 6
    (69, 177, 232),   # 7
    (133, 207, 244),  # 8
    (201, 234, 251),  # 9
    (255, 255, 255),  # 10 코어 화이트
    (255, 180, 84),   # 11 앰버 (THINKING)
    (92, 224, 165),   # 12 그린 (LISTENING)
    (255, 107, 107),  # 13 레드 (ERROR)
    (127, 227, 240),  # 14 브라이트 시안 (HEARING/SPEAKING)
    (147, 167, 184),  # 15 쿨 그레이 (보조)
]
PAL_BYTES = bytes(c for rgb in PALETTE for c in rgb)

# 밝기 -> 램프 인덱스 경계 (어두운 픽셀은 투명으로 버림)
_RAMP_BINS = [18, 44, 70, 96, 122, 148, 176, 205, 235]


def _font(size: int) -> ImageFont.FreeTypeFont:
    if size not in _font_cache:
        _font_cache[size] = ImageFont.truetype(FONT_PATH, size)
    return _font_cache[size]


def _quantize(img: Image.Image) -> np.ndarray:
    """L 이미지(밝기) -> 팔레트 인덱스 배열 (0=투명, 1..10 램프)."""
    a = np.asarray(img, dtype=np.uint8)
    return np.digitize(a, _RAMP_BINS).astype(np.uint8)


def _pack4(idx: np.ndarray) -> bytes:
    """인덱스 배열 -> 4bpp (상위 니블 먼저). 폭은 짝수여야 한다."""
    if idx.shape[1] % 2:
        idx = np.pad(idx, ((0, 0), (0, 1)))
    return ((idx[:, 0::2] << 4) | idx[:, 1::2]).astype(np.uint8).tobytes()


def _glow(img: Image.Image, radius: float = 2.0, gain: float = 0.55) -> Image.Image:
    """텍스트/라인 주변에 은은한 시안 글로우(저밝기 번짐)."""
    from PIL import ImageChops
    halo = img.filter(ImageFilter.GaussianBlur(radius)).point(
        lambda v: int(v * gain))
    return ImageChops.lighter(img, halo)


def sprite_packet(idx: np.ndarray, x: int, y: int, tag: int) -> bytes:
    h, w = idx.shape
    return bytes([tag, x, y, w]) + _pack4(idx)


# ---------------------------------------------------------------- 배경 아트

def _polar(r: float, deg: float) -> tuple[float, float]:
    a = math.radians(deg)
    return CX * S + r * S * math.cos(a), CY * S + r * S * math.sin(a)


def render_background() -> bytes:
    """링 + 틱 + 액센트 아크 + 워드마크 + 구획선 배경. 0x12 패킷."""
    img = Image.new("L", (W * S, H * S), 0)
    d = ImageDraw.Draw(img)

    def ring(r: float, width: float, fill: int, start=0, end=360):
        bb = [CX * S - r * S, CY * S - r * S, CX * S + r * S, CY * S + r * S]
        d.arc(bb, start, end, fill=fill, width=int(width * S))

    # 외곽 파인 링 + 그 안쪽 희미한 링
    ring(122.5, 1.2, 95)
    ring(107.5, 0.8, 42)

    # 틱 링: 5도 간격, 15도마다 길고 밝게
    for k in range(72):
        deg = k * 5
        major = (k % 3 == 0)
        r0, r1 = (109.5, 118.5) if major else (113.5, 118.5)
        d.line([_polar(r0, deg), _polar(r1, deg)],
               fill=150 if major else 70, width=int(0.9 * S))

    # 대각선 브라이트 액센트 아크 4개 (흰 코어 + 시안 바디)
    for c in (45, 135, 225, 315):
        ring(119.5, 1.6, 215, c - 18, c + 18)
        ring(119.8, 0.7, 255, c - 18, c + 18)

    # 좌/우 짧은 데코 대시
    for deg in (180, 0):
        d.line([_polar(100, deg), _polar(106, deg)], fill=170, width=int(1.1 * S))
        for dd in (-4, 4):
            d.line([_polar(101, deg + dd), _polar(105, deg + dd)],
                   fill=80, width=int(0.8 * S))

    # 워드마크 O M N I (트래킹 수동, 좌우 다이아몬드)
    f = _font(17 * S)
    word = "OMNI"
    track = 9 * S
    tw = sum(f.getlength(ch) for ch in word) + track * (len(word) - 1)
    x = CX * S - tw / 2
    ytop = 30 * S
    for ch in word:
        d.text((x, ytop), ch, fill=250, font=f)
        x += f.getlength(ch) + track
    for sx in (-1, 1):
        px = CX * S + sx * (tw / 2 + 14 * S)
        py = ytop + 11.5 * S
        r = 2.6 * S
        d.polygon([(px, py - r), (px + r, py), (px, py + r), (px - r, py)],
                  fill=150)

    # 상태 존 브래킷 (y=76 라인 좌우)
    for sx in (-1, 1):
        x0, x1 = CX * S + sx * 62 * S, CX * S + sx * 86 * S
        y = 76 * S
        d.line([(x0, y), (x1, y)], fill=100, width=int(0.9 * S))
        d.line([(x1, y - 3 * S), (x1, y + 3 * S)], fill=100, width=int(0.9 * S))

    # 센터 크로스헤어 (시스루 고려, 아주 은은하게)
    d.ellipse([CX * S - 1.4 * S, CY * S - 1.4 * S,
               CX * S + 1.4 * S, CY * S + 1.4 * S], fill=110)
    for deg in (0, 90, 180, 270):
        d.line([_polar(9, deg), _polar(15, deg)], fill=60, width=int(0.8 * S))

    # 자막 구획선 (y=141, 중앙 다이아몬드)
    y = 141 * S
    for sx in (-1, 1):
        d.line([(CX * S + sx * 9 * S, y), (CX * S + sx * 76 * S, y)],
               fill=75, width=int(0.8 * S))
    r = 2.2 * S
    d.polygon([(CX * S, y - r), (CX * S + r, y), (CX * S, y + r),
               (CX * S - r, y)], fill=140)

    img = _glow(img, radius=2.5, gain=0.5)
    img = img.resize((W, H), Image.LANCZOS)
    idx = _quantize(img)
    return bytes([0x12]) + PAL_BYTES + _pack4(idx)


# ---------------------------------------------------------------- 상태 스프라이트

_LED = {  # 상태 -> 팔레트 인덱스
    "BOOT": 15, "LISTENING": 12, "HEARING": 14,
    "THINKING": 11, "SPEAKING": 14, "DONE": 12, "ERROR": 13,
}
_ST_W, _ST_H = 132, 18


def status_packet(state: str) -> bytes:
    """LED 도트 + 트래킹 들어간 상태 텍스트 스프라이트 (0x13, y=68)."""
    state = state.upper().rstrip(".")
    img = Image.new("L", (_ST_W * S, _ST_H * S), 0)
    d = ImageDraw.Draw(img)
    f = _font(12 * S)
    track = 2.2 * S
    tw = sum(f.getlength(c) for c in state) + track * (len(state) - 1)
    led_r = 2.8 * S
    gap = 7 * S
    total = led_r * 2 + gap + tw
    x = (_ST_W * S - total) / 2
    cy = _ST_H * S / 2
    d.ellipse([x, cy - led_r, x + led_r * 2, cy + led_r], fill=255)
    led_mask = _quantize(img.resize((_ST_W, _ST_H), Image.LANCZOS)) > 0
    img.paste(0, (0, 0, _ST_W * S, _ST_H * S))
    tx = x + led_r * 2 + gap
    for c in state:
        d.text((tx, cy - 7.5 * S), c, fill=235, font=f)
        tx += f.getlength(c) + track
    img = _glow(img, 1.8, 0.5)
    idx = _quantize(img.resize((_ST_W, _ST_H), Image.LANCZOS))
    idx[led_mask] = _LED.get(state, 15)
    return sprite_packet(idx, (W - _ST_W) // 2, 68, 0x13)


# ---------------------------------------------------------------- 자막 스프라이트

CAP_W = 208            # 짝수 (4bpp 104B/행)
CAP_Y = 146
LINE_H = 22
MAX_LINES = 3
_LINE_WIDTHS = [198, 176, 150]  # 원형 코드(chord)에 맞춘 줄별 최대 폭


def _wrap(text: str, font: ImageFont.FreeTypeFont,
          widths: list[int]) -> list[str]:
    lines: list[str] = []
    cur = ""
    for ch in text.replace("\n", " "):
        wmax = widths[min(len(lines), len(widths) - 1)]
        if font.getlength(cur + ch) > wmax:
            lines.append(cur)
            cur = ch.lstrip()
        else:
            cur += ch
    if cur.strip():
        lines.append(cur)
    return lines


BAN_W = 200            # 알림 배너 (상태 아래 ~ 자막 구획선 위)
BAN_Y = 96


def banner_packet(text: str, size: int = 14) -> bytes:
    """알림 배너 -> 다이아 불릿 + 한글 2줄 스프라이트 (0x15). 빈 텍스트=클리어."""
    font = _font(size * S)
    lines = _wrap(text, font, [180 * S])[:2]
    if not lines:
        return sprite_packet(np.zeros((1, BAN_W), np.uint8),
                             (W - BAN_W) // 2, BAN_Y, 0x15)
    lh = 19
    h = len(lines) * lh + 4
    img = Image.new("L", (BAN_W * S, h * S), 0)
    d = ImageDraw.Draw(img)
    for i, line in enumerate(lines):
        lw = font.getlength(line)
        d.text(((BAN_W * S - lw) / 2, (2 + i * lh) * S), line, fill=245,
               font=font)
    # 첫 줄 왼쪽 다이아 불릿
    lw0 = font.getlength(lines[0])
    bx = (BAN_W * S - lw0) / 2 - 9 * S
    by = (2 + lh / 2) * S
    r = 2.4 * S
    d.polygon([(bx, by - r), (bx + r, by), (bx, by + r), (bx - r, by)],
              fill=200)
    img = _glow(img, 2.0, 0.5)
    idx = _quantize(img.resize((BAN_W, h), Image.LANCZOS))
    # 불릿은 액센트 컬러(브라이트 시안)로
    mask = np.zeros_like(idx, bool)
    x0, x1 = int(bx / S - 4), int(bx / S + 5)
    y0, y1 = int(by / S - 4), int(by / S + 5)
    mask[max(0, y0):y1, max(0, x0):x1] = True
    idx[mask & (idx > 4)] = 14
    return sprite_packet(idx, (W - BAN_W) // 2, BAN_Y, 0x15)


def caption_packet(text: str, size: int = 16) -> bytes:
    """한글 자막 -> AA + 글로우 4bpp 스프라이트 (0x14). 줄별 중앙 정렬."""
    font = _font(size * S)
    widths = [w * S for w in _LINE_WIDTHS]
    lines = _wrap(text, font, widths)
    if len(lines) > MAX_LINES:  # 넘치면 원문을 최소 폭으로 재줄바꿈해 꼬리만
        lines = _wrap(text, font, [_LINE_WIDTHS[-1] * S])[-MAX_LINES:]
    h = max(1, len(lines) * LINE_H)
    img = Image.new("L", (CAP_W * S, h * S), 0)
    d = ImageDraw.Draw(img)
    for i, line in enumerate(lines):
        lw = font.getlength(line)
        d.text(((CAP_W * S - lw) / 2, i * LINE_H * S + 1 * S),
               line, fill=255, font=font)
    img = _glow(img, 2.2, 0.45)
    idx = _quantize(img.resize((CAP_W, h), Image.LANCZOS))
    return sprite_packet(idx, (W - CAP_W) // 2, CAP_Y, 0x14)
