#!/usr/bin/env python3
"""폰 안경 카메라 텍스트 인식 엔진 — macOS Vision OCR(한국어·영어)을 방향 불변·흐림 내성으로 감싼다.

- 8방향(정방향·90·180·270·좌우거울·상하거울·전치·역전치)을 병렬로 돌려 점수(신뢰도×글자수)가
  가장 높은 방향을 고른다 → 거꾸로 보거나 뒤(유리 너머 거울상)에서 봐도 읽는다.
- 속도: 직전에 이긴 방향만 매 프레임 인식하고, 전체 탐색은 결과가 약하거나 SWEEP_EVERY초마다.
- 흐린 글자: 탐색에서도 아무것도 없으면 선명화·대비·1.6배 확대한 프레임으로 한 번 더.
- 좌표는 항상 원본 프레임 기준 정규화(원점 왼쪽 위)로 되돌려 준다. 세로로 놓인 글자는 vertical=True.
"""
import io
import time
from concurrent.futures import ThreadPoolExecutor

from PIL import Image, ImageFilter, ImageOps

try:
    import Foundation
    import Vision
    AVAILABLE = True
except Exception:  # noqa: BLE001
    AVAILABLE = False

MIN_CONF = 0.3            # 흐린 글자 유추 허용 하한
GOOD_SCORE = 3.0          # 이 점수 이상이면 탐색 없이 직전 방향 유지
SWEEP_EVERY = 1.2         # 전체 방향 탐색 주기(초)
# 동점이면 앞선 것을 고르므로 흔한 상황 순서: 정방향 > 거울(유리 뒤) > 거꾸로 > 거울+거꾸로 > 세로들
VARIANTS = ("id", "mlr", "r180", "mtb", "r90", "r270", "tr", "tv")
_TRANSPOSE = {
    "r90": Image.Transpose.ROTATE_90, "r180": Image.Transpose.ROTATE_180, "r270": Image.Transpose.ROTATE_270,
    "mlr": Image.Transpose.FLIP_LEFT_RIGHT, "mtb": Image.Transpose.FLIP_TOP_BOTTOM,
    "tr": Image.Transpose.TRANSPOSE, "tv": Image.Transpose.TRANSVERSE,
}
VERTICAL = {"r90", "r270", "tr", "tv"}
LABEL = {"id": "", "r180": "거꾸로", "mlr": "거울상", "mtb": "상하 반전", "r90": "세로", "r270": "세로",
         "tr": "세로·거울", "tv": "세로·거울"}
_POOL = ThreadPoolExecutor(max_workers=8)


def _variant_point(v: str, x: float, y: float) -> tuple[float, float]:
    """변형 이미지의 정규화 좌표 → 원본 정규화 좌표 (PIL Transpose 정의 기준)."""
    if v == "id":
        return x, y
    if v == "r90":      # CCW 90: (x,y) → (y, 1-x)  역: x=1-y', y=x'
        return 1 - y, x
    if v == "r270":     # CW 90: (x,y) → (1-y, x)   역: x=y', y=1-x'
        return y, 1 - x
    if v == "r180":
        return 1 - x, 1 - y
    if v == "mlr":
        return 1 - x, y
    if v == "mtb":
        return x, 1 - y
    if v == "tr":       # transpose: (x,y) → (y,x)
        return y, x
    if v == "tv":       # transverse: (x,y) → (1-y, 1-x)
        return 1 - y, 1 - x
    return x, y


def _map_box(v: str, x: float, y: float, w: float, h: float) -> tuple[float, float, float, float]:
    pts = [_variant_point(v, px, py) for px, py in ((x, y), (x + w, y), (x, y + h), (x + w, y + h))]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)


def _ocr_pil(img: Image.Image) -> list[dict]:
    """PIL 이미지 → [{text, conf, x, y, w, h}] (이미지 자체의 정규화 좌표, 원점 왼쪽 위)."""
    if not AVAILABLE:
        return []
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    data = buf.getvalue()
    nsdata = Foundation.NSData.dataWithBytes_length_(data, len(data))
    handler = Vision.VNImageRequestHandler.alloc().initWithData_options_(nsdata, None)
    req = Vision.VNRecognizeTextRequest.alloc().init()
    req.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    req.setRecognitionLanguages_(["ko-KR", "en-US"])
    req.setUsesLanguageCorrection_(True)
    ok, _err = handler.performRequests_error_([req], None)
    out = []
    if not ok:
        return out
    for o in req.results() or []:
        cands = o.topCandidates_(1)
        if not cands:
            continue
        c = cands[0]
        text = str(c.string()).strip()
        conf = float(c.confidence())
        if len(text) < 2 or conf < MIN_CONF:
            continue
        b = o.boundingBox()
        out.append({"text": text, "conf": round(conf, 2),
                    "x": float(b.origin.x), "y": 1.0 - float(b.origin.y) - float(b.size.height),
                    "w": float(b.size.width), "h": float(b.size.height)})
    return out


def _plausible(token: str) -> float:
    """토큰이 진짜 글자로 보이는가 — 숫자+글자 섞임(예: '1로로', 'bN2')은 방향 오인식 흔적."""
    if not token:
        return 0.0
    digits = sum(ch.isdigit() for ch in token)
    letters = sum(ch.isalpha() for ch in token)
    others = len(token) - digits - letters - sum(ch in ".,!?%-'\"" for ch in token)
    base = 1.0
    if digits and letters:
        base = 0.4
    elif digits == len(token):
        base = 0.8
    elif letters == 0:
        base = 0.3
    return base * (0.6 ** max(0, others))       # 괄호·기호가 끼면 오인식 흔적


def _geo(item: dict) -> float:
    """가로로 읽힌 글줄이면 박스 가로/세로 비가 글자 수에 비례해야 한다 — 세로 글줄을 억지로 읽은 결과 억제."""
    n = max(1, len(item["text"].replace(" ", "")))
    aspect = item["w"] / max(item["h"], 1e-4)
    return max(0.25, min(1.0, aspect / (0.35 * n)))


def _score(items: list[dict]) -> float:
    total = 0.0
    for i in items:
        g = _geo(i)
        for tok in i["text"].split():
            total += i["conf"] * len(tok) * _plausible(tok) * g
    return total


def _enhance(img: Image.Image) -> Image.Image:
    """흐린·작은 글자용: 자동 대비 + 언샤프 + 확대."""
    g = ImageOps.autocontrast(img, cutoff=1)
    if g.width < 800:
        g = g.resize((int(g.width * 1.6), int(g.height * 1.6)), Image.LANCZOS)
    return g.filter(ImageFilter.UnsharpMask(radius=2.0, percent=160, threshold=2))


def _run_variant(img: Image.Image, v: str) -> tuple[str, list[dict]]:
    im = img if v == "id" else img.transpose(_TRANSPOSE[v])
    return v, _ocr_pil(im)


class OrientedOCR:
    def __init__(self):
        self.orient = "id"
        self.last_sweep = 0.0
        self.last_ms = 0
        self.last_mode = "primary"
        self.last_score = 0.0

    def recognize(self, jpeg: bytes) -> dict:
        """JPEG → {items:[원본 좌표 + vertical], orient, label, ms, mode}."""
        t0 = time.time()
        try:
            img = Image.open(io.BytesIO(jpeg)).convert("RGB")
        except Exception:  # noqa: BLE001
            return {"items": [], "orient": self.orient, "label": "", "ms": 0, "mode": "bad_frame"}
        now = t0
        best_v, best_items, mode = self.orient, [], "primary"
        # 결과가 약할수록 방향 재탐색을 자주 (거울상·회전 오인식을 빨리 바로잡기 위해)
        interval = 0.4 if self.last_score < 8 else SWEEP_EVERY
        need_sweep = now - self.last_sweep > interval
        if not need_sweep:
            _, best_items = _run_variant(img, self.orient)
            if _score(best_items) < GOOD_SCORE:
                need_sweep = True
        if need_sweep:
            mode = "sweep"
            self.last_sweep = now
            results = list(_POOL.map(lambda v: _run_variant(img, v), VARIANTS))
            best_v, best_items = max(results, key=lambda r: _score(r[1]))
            if _score(best_items) == 0:
                mode = "sweep+enhance"
                enh = _enhance(img)
                results = list(_POOL.map(lambda v: _run_variant(enh, v), ("id", "r180", "mlr", "r90", "r270")))
                best_v, best_items = max(results, key=lambda r: _score(r[1]))
            if _score(best_items) > 0:
                self.orient = best_v
        self.last_score = _score(best_items)
        mapped = []
        for it in best_items:
            x, y, w, h = _map_box(best_v, it["x"], it["y"], it["w"], it["h"])
            mapped.append({"text": it["text"], "conf": it["conf"], "x": round(x, 4), "y": round(y, 4),
                           "w": round(w, 4), "h": round(h, 4), "vertical": best_v in VERTICAL})
        self.last_ms = int((time.time() - t0) * 1000)
        self.last_mode = mode
        return {"items": mapped, "orient": best_v, "label": LABEL.get(best_v, ""), "ms": self.last_ms, "mode": mode}
