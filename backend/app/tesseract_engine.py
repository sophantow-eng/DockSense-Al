"""ENGINE 1 — Tesseract OCR (เบา: ไม่ใช้ torch) สำหรับ Render ฟรี
ภาษา tha (+eng ถ้าตั้ง) · ไม่ใส่ whitelist ตายตัว (ป้ายพิเศษ/ตัวอักษรที่ไม่คาดคิดจะไม่ถูกตัดทิ้งตั้งแต่ต้น)
ข้อความดิบจะผ่าน plate_utils.clean() ภายหลัง ซึ่งเก็บเฉพาะเลข+พยัญชนะไทย แต่ ``raw`` เดิมยังถูกเก็บไว้ในผลลัพธ์"""
import shutil, time
from . import config

class _Budget(Exception):
    """หมดงบเวลาอ่าน (CPU ช้า/ภาพยาก) — ผู้เรียกใช้ผลที่ได้มาแล้ว ไม่แต่งผลเพิ่ม"""

_deadline = 0.0

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
    left = _deadline - time.monotonic() if _deadline else config.TESS_TIMEOUT
    if left < 0.5:
        raise _Budget()
    try:
        d = pytesseract.image_to_data(img, lang=config.TESS_LANG, config=cfg, output_type=pytesseract.Output.DICT, timeout=min(config.TESS_TIMEOUT, left))
    except RuntimeError as e:
        raise _Budget() from e
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
    left = _deadline - time.monotonic() if _deadline else config.TESS_TIMEOUT
    if left < 0.5:
        raise _Budget()
    try:
        d = pytesseract.image_to_data(img, lang=config.TESS_LANG, config=cfg, output_type=pytesseract.Output.DICT, timeout=min(config.TESS_TIMEOUT, left))
    except RuntimeError as e:   # tesseract process timeout
        raise _Budget() from e
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

def _rows(gray):
    """หาแถวตัวอักษรทะเบียน เรียงบน→ล่าง (ไม่เอาแถวจังหวัดตัวเล็ก) · ป้ายปกติ = 1 แถว · ป้ายมอเตอร์ไซค์/สี่เหลี่ยมจัตุรัส = 2 แถว (อักษร / เลข)
    ใช้การแบ่งขาวดำ + connected components (ไม่ใช่โมเดลเรียนรู้) จึงอาจพลาดบนภาพแย่ ๆ → คืน [] แล้วผู้เรียกอ่านทั้งภาพแทน"""
    import cv2, numpy as np
    h, w = gray.shape
    g = cv2.GaussianBlur(gray, (3, 3), 0)
    _, bw = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    if bw.mean() > 127:
        bw = 255 - bw
    n, lab, st, _ = cv2.connectedComponentsWithStats(bw, 8)
    boxes = [(x, y, bw_, bh) for x, y, bw_, bh, a in st[1:] if 0.08 * h <= bh <= 0.9 * h and bw_ <= 0.5 * w and a > 20]
    if len(boxes) < 2:
        return []
    boxes.sort(key=lambda b: b[1] + b[3] / 2)
    groups, cur = [], [boxes[0]]
    for b in boxes[1:]:                       # จัดกลุ่มเป็นแถวตามศูนย์กลางแนวตั้ง
        cy = np.mean([c[1] + c[3] / 2 for c in cur]); ch = np.median([c[3] for c in cur])
        if abs((b[1] + b[3] / 2) - cy) < 0.55 * ch:
            cur.append(b)
        else:
            groups.append(cur); cur = [b]
    groups.append(cur)
    info = [(g_, float(np.median([b[3] for b in g_]))) for g_ in groups if len(g_) >= 1]
    top_h = max(hh for _, hh in info)
    keep = [g_ for g_, hh in info if hh >= 0.5 * top_h and (len(g_) >= 2 or hh >= 0.5 * top_h)]   # แถวที่สูงใกล้เคียงสูงสุด = แถวทะเบียน
    keep = keep[:2]
    out = []
    for g_ in keep:
        x0 = min(b[0] for b in g_); x1 = max(b[0] + b[2] for b in g_)
        y0 = min(b[1] for b in g_); y1 = max(b[1] + b[3] for b in g_)
        padx, pady = int(0.06 * (x1 - x0)) + 6, int(0.2 * (y1 - y0)) + 4
        out.append(gray[max(0, y0 - pady):min(h, y1 + pady), max(0, x0 - padx):min(w, x1 + padx)])
    return out

def _prep(line, target_h=110):
    import cv2
    h, w = line.shape[:2]
    s = target_h / max(1, h)
    s = min(max(s, 0.5), 5.0)
    big = cv2.resize(line, None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC if s > 1 else cv2.INTER_AREA)
    big = cv2.copyMakeBorder(big, 18, 18, 24, 24, cv2.BORDER_REPLICATE)
    return big

def _read_line_once(line, target_h, mode="single"):
    """อ่านหนึ่งแถว → (ข้อความ, ความมั่นใจ) หรือ None · mode: single=ทะเบียนทั้งแถว, letters=แถวอักษรหน้า(มอเตอร์ไซค์), digits=แถวเลข"""
    import re
    im = _prep(line, target_h)
    if mode == "digits":
        r = _run_wl(im, 7, "0123456789")
        return ("".join(t for t, _ in r), sum(c for _, c in r) / len(r)) if r else None
    head = _run_wl(im, 7, _WL)
    if not head:
        return None
    txt = "".join(t for t, _ in head)
    conf = sum(c for _, c in head) / len(head)
    if mode == "single":
        try:
            tail = _run_wl(im[:, int(im.shape[1] * 0.5):], 7, "0123456789")   # ครึ่งขวา = เลขท้าย อ่านเลขล้วน
        except _Budget:
            tail = []
        digits = "".join(t for t, _ in tail)
        if digits:
            tconf = sum(c for _, c in tail) / len(tail)
            m = re.search(r"([0-9]+)$", txt)
            if m and len(m.group(1)) == len(digits) and tconf >= conf - 0.05:
                txt = txt[: m.start(1)] + digits
    return txt, conf

def _read_rows(rows, th):
    """1 แถว = ป้ายปกติ · 2 แถว = ป้ายซ้อน (อักษรบน เลขล่าง) อ่านแยกแล้วต่อกัน"""
    if len(rows) == 1:
        return _read_line_once(rows[0], th, "single")
    a = _read_line_once(rows[0], th, "letters")
    b = _read_line_once(rows[1], th, "digits")
    if not a or not b:
        return None
    return a[0] + b[0], (a[1] + b[1]) / 2

def read(img) -> list[tuple[str, float]]:
    """คืน [(ข้อความ, ความมั่นใจ 0..1)] — รูปแบบเดียวกับ ocr_service.read
    เทา → หาแถวทะเบียน (1 แถวปกติ / 2 แถวมอเตอร์ไซค์) → อ่านที่ขนาดตัวอักษร 120px จำกัดตัวอักษรเป็น เลข+พยัญชนะไทย
    → ถ้ายังไม่ชัวร์และยังมีเวลา อ่านซ้ำที่ 90/160px แล้วโหวต → ตัดขยะหัวท้ายที่ไม่ใช่รูปทะเบียน (ไม่แก้ตัวอักษร)
    งบเวลา TESS_BUDGET วินาที/ภาพ (CPU ฟรีช้า): หมดงบ = ใช้ผลที่ได้แล้ว ไม่ error ทั้งก้อน · ตัดแถวไม่ได้ = วิธีเดิม"""
    import cv2
    from collections import defaultdict
    from . import plate_utils as pu
    global _deadline
    _deadline = time.monotonic() + config.TESS_BUDGET
    gray = img if img.ndim == 2 else cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    rows = _rows(gray)
    if not rows:
        try:
            return _read_legacy(img)
        except _Budget:
            return []
    votes, confs = defaultdict(float), defaultdict(list)
    n = 0
    for th in (120, 90, 160):
        try:
            r = _read_rows(rows, th)
        except _Budget:
            break
        if not r:
            continue
        n += 1
        t, keep = pu.extract_standard(r[0])
        if t:
            c = r[1] * keep
            votes[t] += c; confs[t].append(c)
        if n == 1 and t and pu.is_standard(t) and keep == 1.0 and r[1] >= config.HIGH_CONF:
            break   # ชัดแล้ว ไม่ต้องเสียเวลาอ่านซ้ำ
    if not votes:
        return []
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
