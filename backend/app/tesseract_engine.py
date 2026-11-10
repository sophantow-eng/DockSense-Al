"""ENGINE 1 — Tesseract OCR (เบา: ไม่ใช้ torch) สำหรับ Render ฟรี
ภาษา tha (+eng ถ้าตั้ง) · ไม่ใส่ whitelist ตายตัว (ป้ายพิเศษ/ตัวอักษรที่ไม่คาดคิดจะไม่ถูกตัดทิ้งตั้งแต่ต้น)
ข้อความดิบจะผ่าน plate_utils.clean() ภายหลัง ซึ่งเก็บเฉพาะเลข+พยัญชนะไทย แต่ ``raw`` เดิมยังถูกเก็บไว้ในผลลัพธ์"""
import shutil
from . import config

def available() -> bool:
    if not shutil.which("tesseract"):
        return False
    try:
        import pytesseract  # noqa: F401
        return True
    except Exception:
        return False

def has_thai() -> bool:
    try:
        import pytesseract
        return "tha" in pytesseract.get_languages(config="")
    except Exception:
        return False

def version() -> str | None:
    try:
        import pytesseract
        return str(pytesseract.get_tesseract_version())
    except Exception:
        return None

def _run(img, psm: int) -> list[tuple[str, float]]:
    import pytesseract
    cfg = f"--oem 1 --psm {psm}"
    d = pytesseract.image_to_data(img, lang=config.TESS_LANG, config=cfg, output_type=pytesseract.Output.DICT, timeout=config.TESS_TIMEOUT)
    out = []
    for t, c in zip(d["text"], d["conf"]):
        t = (t or "").strip()
        try:
            c = float(c)
        except (TypeError, ValueError):
            continue
        if t and c >= 0:
            out.append((t, c / 100.0))
    return out

def read(img) -> list[tuple[str, float]]:
    """คืน [(ข้อความ, ความมั่นใจ 0..1)] — รูปแบบเดียวกับ ocr_service.read เพื่อใช้ไหลงานร่วมกัน
    ลอง psm 7 (บรรทัดเดียว) กับ psm 6 (บล็อก) แล้วเลือกชุดที่ให้ข้อความมากกว่า/มั่นใจกว่า"""
    import cv2
    h, w = img.shape[:2]
    top = img[: max(1, int(h * 0.62)), :] if h > 0.45 * w else img   # ป้ายสองบรรทัด: บรรทัดบน = เลข/อักษรทะเบียน
    best = []
    for im, psm in ((top, 7), (img, 6)):
        if im.ndim == 2:
            im = cv2.cvtColor(im, cv2.COLOR_GRAY2BGR)
        res = _run(im, psm)
        score = sum(len(t) * c for t, c in res)
        if score > sum(len(t) * c for t, c in best):
            best = res
    return best
