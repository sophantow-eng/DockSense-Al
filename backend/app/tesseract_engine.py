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

_WL = "0123456789กขฃคฅฆงจฉชซฌญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรลวศษสหฬอฮ"

def _run_wl(img, psm: int, wl: str):
    import pytesseract
    cfg = f"--oem 1 --psm {psm} -c tessedit_char_whitelist={wl}"
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

def _main_line(gray):
    """หาบรรทัดทะเบียน (แถวตัวอักษรที่สูงสุด/อยู่บนสุด ไม่เอาบรรทัดจังหวัดตัวเล็กด้านล่าง) · คืนภาพบรรทัดนั้น หรือ None
    ใช้การแบ่งขาวดำ + ตัวอักษรที่เชื่อมกัน (connected components) — ไม่ใช่โมเดล จึงอาจพลาดบนภาพแย่ ๆ (ตกกลับไปอ่านทั้งภาพ)"""
    import cv2, numpy as np
    h, w = gray.shape
    g = cv2.GaussianBlur(gray, (3, 3), 0)
    _, bw = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)   # ตัวอักษรเข้ม = ขาว
    if bw.mean() > 127:   # ตัวหนังสือสว่างบนพื้นเข้ม (ป้ายเหลือง/ดำบางแบบ) → กลับ
        bw = 255 - bw
    n, lab, st, _ = cv2.connectedComponentsWithStats(bw, 8)
    boxes = [(x, y, bw_, bh) for x, y, bw_, bh, a in st[1:] if 0.18 * h <= bh <= 0.9 * h and bw_ <= 0.5 * w and a > 20]
    if len(boxes) < 2:
        return None
    # เอาแถวที่สูงที่สุดเป็นหลัก แล้วรวมตัวที่ศูนย์กลางแนวตั้งใกล้กัน
    ref = sorted(boxes, key=lambda b: -b[3])[: max(2, len(boxes) // 2)]
    cy = float(np.median([b[1] + b[3] / 2 for b in ref])); hh = float(np.median([b[3] for b in ref]))
    row = [b for b in boxes if abs((b[1] + b[3] / 2) - cy) < 0.6 * hh and b[3] > 0.5 * hh]
    if len(row) < 2:
        return None
    x0 = min(b[0] for b in row); x1 = max(b[0] + b[2] for b in row)
    y0 = min(b[1] for b in row); y1 = max(b[1] + b[3] for b in row)
    padx, pady = int(0.06 * (x1 - x0)) + 6, int(0.2 * (y1 - y0)) + 4
    return gray[max(0, y0 - pady):min(h, y1 + pady), max(0, x0 - padx):min(w, x1 + padx)]

def _prep(line, target_h=110):
    import cv2
    h, w = line.shape[:2]
    s = target_h / max(1, h)
    s = min(max(s, 0.5), 5.0)
    big = cv2.resize(line, None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC if s > 1 else cv2.INTER_AREA)
    big = cv2.copyMakeBorder(big, 18, 18, 24, 24, cv2.BORDER_REPLICATE)
    return big

def _read_line_once(line, target_h):
    """อ่านบรรทัดทะเบียนที่ขนาดตัวอักษรหนึ่งขนาด → (ข้อความ, ความมั่นใจ) หรือ None"""
    import re
    im = _prep(line, target_h)
    head = _run_wl(im, 7, _WL)
    if not head:
        return None
    txt = "".join(t for t, _ in head)
    conf = sum(c for _, c in head) / len(head)
    # ส่วนเลขท้าย: ครึ่งขวาของบรรทัด อ่านเลขล้วน (จำกัดตัวอักษรให้แคบลง = สับสนเลข/อักษรน้อยลง)
    tail = _run_wl(im[:, int(im.shape[1] * 0.5):], 7, "0123456789")
    digits = "".join(t for t, _ in tail)
    if digits:
        tconf = sum(c for _, c in tail) / len(tail)
        m = re.search(r"([0-9]+)$", txt)
        if m and len(m.group(1)) == len(digits) and tconf >= conf - 0.05:
            txt = txt[: m.start(1)] + digits
    return txt, conf

def read(img) -> list[tuple[str, float]]:
    """คืน [(ข้อความ, ความมั่นใจ 0..1)] — รูปแบบเดียวกับ ocr_service.read
    ขั้นตอน: เทา → ตัดบรรทัดทะเบียน → อ่านที่ 3 ขนาดตัวอักษร (เลือกที่ตรงกันมากสุด) โดยจำกัดตัวอักษรเป็น เลข+พยัญชนะไทย
    → ตัดขยะหัวท้ายที่ไม่ใช่รูปทะเบียน (ไม่แก้ตัวอักษร) · ตัดบรรทัดไม่ได้ = ใช้วิธีเดิม (ทั้งภาพ)
    ความมั่นใจ = เฉลี่ยของผู้ชนะ × สัดส่วนที่ตรงกัน × สัดส่วนที่ไม่ถูกตัดทิ้ง (ไม่ปั้นตัวเลขให้สูงกว่าที่เห็นจริง)"""
    import cv2
    from collections import defaultdict
    from . import plate_utils as pu
    gray = img if img.ndim == 2 else cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    line = _main_line(gray)
    if line is None:
        return _read_legacy(img)
    votes, confs = defaultdict(float), defaultdict(list)
    n = 0
    for th in (90, 120, 160):
        r = _read_line_once(line, th)
        if not r:
            continue
        n += 1
        t, keep = pu.extract_standard(r[0])
        if not t:
            continue
        c = r[1] * keep
        votes[t] += c; confs[t].append(c)
    if not votes:
        return _read_legacy(img)
    best = max(votes, key=lambda k: (pu.is_standard(k), votes[k]))
    agree = len(confs[best]) / max(1, n)
    return [(best, round(sum(confs[best]) / len(confs[best]) * (0.5 + 0.5 * agree), 3))]

def _read_legacy(img) -> list[tuple[str, float]]:
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
