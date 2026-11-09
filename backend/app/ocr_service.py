"""OCR engine: EasyOCR (th+en) โหลดครั้งแรกตอนใช้งาน · ไม่มี lib → available() = False"""
import threading
from . import config

_reader = None
_lock = threading.Lock()

def available() -> bool:
    try:
        import easyocr  # noqa: F401
        return True
    except Exception:
        return False

def _get():
    global _reader
    with _lock:
        if _reader is None:
            import easyocr
            _reader = easyocr.Reader(config.OCR_LANGS, gpu=False, verbose=False)
    return _reader

def read(img) -> list[tuple[str, float]]:
    """คืน [(ข้อความ, ความมั่นใจ 0..1)] ของแต่ละส่วนที่เจอ"""
    r = _get().readtext(img, detail=1, paragraph=False,
                        allowlist="0123456789กขฃคฅฆงจฉชซฌญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรลวศษสหฬอฮ กรุงเทพมหานครเชียงใหม่ภูเก็ตขอนแก่นนครราชสีมาชลบุรีสมุทรปราการนนทบุรีปทุมธานี")
    return [(t, float(c)) for _, t, c in r]
