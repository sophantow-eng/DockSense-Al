"""OpenCV: ตรวจคุณภาพภาพ, หาป้ายทะเบียน, ปรับภาพก่อน OCR"""
import hashlib
import cv2
import numpy as np

def decode(data: bytes):
    arr = np.frombuffer(data, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("ไฟล์ภาพเสียหรือไม่ใช่ JPEG/PNG")
    return img

def fingerprint(img) -> str:
    """ลายนิ้วมือภาพแบบย่อ (ภาพเกือบเหมือนกัน → ค่าเดียวกัน) ไว้กันนับเฟรมซ้ำเป็นหลักฐานคนละชิ้น"""
    small = cv2.resize(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), (16, 16), interpolation=cv2.INTER_AREA)
    bits = (small > small.mean()).astype(np.uint8).tobytes()
    return hashlib.sha1(bits).hexdigest()[:16]

def quality(img) -> dict:
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    sharp = float(cv2.Laplacian(g, cv2.CV_64F).var())
    bright = float(g.mean())
    h, w = g.shape
    problems = []
    if min(h, w) < 120: problems.append("small")
    if sharp < 20: problems.append("blurry")
    if bright < 35: problems.append("dark")
    if bright > 225: problems.append("overexposed")
    return {"width": w, "height": h, "sharpness": round(sharp, 1), "brightness": round(bright, 1), "problems": problems}

def find_plate(img):
    """หาสี่เหลี่ยมอัตราส่วนคล้ายป้าย (กว้าง:สูง ≈ 1.8–5) จากขอบ+morphology · คืน (x,y,w,h,score) หรือ None
    เป็นวิธี heuristic ไม่ใช่โมเดลตรวจจับเฉพาะ — ถ้าหาไม่เจอ ให้ OCR ทั้งภาพแทน"""
    H, W = img.shape[:2]
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    g = cv2.bilateralFilter(g, 9, 50, 50)
    edges = cv2.Canny(g, 60, 180)
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (max(9, W // 50), max(3, H // 120)))
    m = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, k)
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    best = None
    for c in cnts:
        x, y, w, h = cv2.boundingRect(c)
        if h < 12 or w < 40: continue
        ar = w / h
        area = w * h / (W * H)
        if not (0.85 <= ar <= 5.0 and 0.004 <= area <= 0.6): continue   # 0.85–1.8 = ป้ายมอเตอร์ไซค์ซ้อนสองแถว
        fill = cv2.contourArea(c) / (w * h)
        dens = float(edges[y:y + h, x:x + w].mean()) / 255
        score = 0.5 * min(1, dens * 6) + 0.3 * fill + 0.2 * max(0.0, 1 - min(abs(ar - 3.2), abs(ar - 1.2)) / 3.2)
        if best is None or score > best[4]:
            best = (x, y, w, h, score)
    return best

def crop(img, box, pad=0.08):
    H, W = img.shape[:2]
    x, y, w, h = box[:4]
    px, py = int(w * pad), int(h * pad * 2)
    return img[max(0, y - py):min(H, y + h + py), max(0, x - px):min(W, x + w + px)]

def variants(plate_img):
    """ภาพหลายแบบให้ OCR ลองอ่าน (ไม่ปรับทุกอย่างมั่ว ๆ: เลือกชุดที่ช่วยจริงในแสงต่างกัน)"""
    h, w = plate_img.shape[:2]
    s = 2.0 if w < 400 else 1.0
    big = cv2.resize(plate_img, None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC) if s != 1 else plate_img
    g = cv2.cvtColor(big, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8)).apply(g)
    den = cv2.fastNlMeansDenoising(clahe, None, 10, 7, 21)
    sharp = cv2.addWeighted(den, 1.5, cv2.GaussianBlur(den, (0, 0), 2), -0.5, 0)
    return {"orig": big, "clahe": clahe, "sharp": sharp}


DEBUG_ROWS = None

def find_text_blocks(img, k=3):
    """หาบล็อกตัวอักษรทะเบียนจากตัวอักษรเข้มบนพื้นสว่างที่เรียงเป็นแถวสม่ำเสมอ (สูงเท่ากัน ศูนย์กลางแนวเดียวกัน ระยะห่างพอดี)
    แถวที่ซ้อนกันในแนวตั้งและทับซ้อนแนวนอน (ป้ายมอเตอร์ไซค์ อักษรบน/เลขล่าง) ถูกรวมเป็นบล็อกเดียว
    คืนรายการ [(x,y,w,h,score,มุมเอียง°)] ดีที่สุดก่อน (สูงสุด k) หรือ [] ในพิกัดภาพเดิม · เป็น heuristic ด้วย OpenCV ไม่ใช่โมเดลเรียนรู้ — ไม่เจอ = ให้ผู้เรียกใช้ find_plate/ทั้งภาพ"""
    H0, W0 = img.shape[:2]
    s = min(1.0, 800.0 / max(H0, W0)) if max(H0, W0) > 800 else 1.0
    sm = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA) if s != 1 else img
    H, W = sm.shape[:2]
    g = cv2.cvtColor(sm, cv2.COLOR_BGR2GRAY)
    g = cv2.GaussianBlur(g, (3, 3), 0)
    bs = max(15, (min(H, W) // 12) | 1)
    bw = cv2.adaptiveThreshold(g, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, bs, 12)
    n, lab, st, _ = cv2.connectedComponentsWithStats(bw, 8)
    comps = []
    for i in range(1, n):
        x, y, w, h, a = st[i]
        if not (10 <= h <= 0.2 * H and 3 <= w <= 1.4 * h and a >= 0.18 * w * h and a >= 20):
            continue
        # ตัวอักษรบนป้าย: รอบ ๆ ตัวต้องสว่างกว่าตัวชัดเจน
        m = 3
        x0, y0, x1, y1 = max(0, x - m), max(0, y - m), min(W, x + w + m), min(H, y + h + m)
        roi = g[y0:y1, x0:x1]; mk = (lab[y0:y1, x0:x1] == i)
        if mk.all() or not (~mk).any():
            continue
        ink, ring = float(roi[mk].mean()), float(roi[~mk].mean())
        if ring - ink < 45:
            continue
        comps.append((x, y, w, h, ring))
    if len(comps) < 3:
        return []
    par = list(range(len(comps)))
    def f(a):
        while par[a] != a:
            par[a] = par[par[a]]; a = par[a]
        return a
    for i, a in enumerate(comps):
        for j in range(i + 1, len(comps)):
            b = comps[j]
            hr = a[3] / b[3]
            if not (0.6 <= hr <= 1.67):
                continue
            h = max(a[3], b[3])
            if abs((a[1] + a[3] / 2) - (b[1] + b[3] / 2)) > 0.45 * h:
                continue
            gap = max(a[0], b[0]) - min(a[0] + a[2], b[0] + b[2])
            if gap > 1.9 * h:
                continue
            par[f(i)] = f(j)
    groups = {}
    for i in range(len(comps)):
        groups.setdefault(f(i), []).append(comps[i])
    rows = []
    for gp in groups.values():
        if len(gp) >= 3:
            x0 = min(c[0] for c in gp); y0 = min(c[1] for c in gp)
            x1 = max(c[0] + c[2] for c in gp); y1 = max(c[1] + c[3] for c in gp)
            pts = np.array([[c[0] + c[2] / 2, c[1] + c[3] / 2] for c in gp], np.float32)
            vx, vy, _, _ = cv2.fitLine(pts, cv2.DIST_L2, 0, 0.01, 0.01)
            ang = float(np.degrees(np.arctan2(float(vy[0]), float(vx[0]))))
            if ang > 90: ang -= 180
            if ang < -90: ang += 180
            rows.append({"b": [x0, y0, x1, y1], "n": len(gp), "h": float(np.median([c[3] for c in gp])), "ring": float(np.mean([c[4] for c in gp])), "ang": ang if len(gp) >= 4 else 0.0})
    if not rows:
        return []
    # รวมแถวที่ซ้อนกันแนวตั้ง (ทับซ้อนแนวนอน, ห่างกันไม่เกิน ~2.2 เท่าของความสูงตัวอักษร)
    merged = True
    while merged:
        merged = False
        for i in range(len(rows)):
            for j in range(i + 1, len(rows)):
                a, b = rows[i], rows[j]
                ov = min(a["b"][2], b["b"][2]) - max(a["b"][0], b["b"][0])
                vgap = max(a["b"][1], b["b"][1]) - min(a["b"][3], b["b"][3])
                hh = max(a["h"], b["h"])
                if ov > 0.3 * min(a["b"][2] - a["b"][0], b["b"][2] - b["b"][0]) and vgap < 2.2 * hh and 0.6 <= a["h"] / b["h"] <= 1.67:
                    a["b"] = [min(a["b"][0], b["b"][0]), min(a["b"][1], b["b"][1]), max(a["b"][2], b["b"][2]), max(a["b"][3], b["b"][3])]
                    a["ang"] = a["ang"] if a["h"] >= b["h"] else b["ang"]; a["n"] += b["n"]; a["h"] = max(a["h"], b["h"]); a["ring"] = (a["ring"] + b["ring"]) / 2
                    rows.pop(j); merged = True; break
            if merged:
                break
    if DEBUG_ROWS is not None:
        DEBUG_ROWS[:] = [dict(r) for r in rows]
    # คะแนน = จำนวนตัว (สูงสุด 8) × ความสูงตัว × ความสว่างพื้นรอบตัว → แถวเลขทะเบียน (ตัวใหญ่) ชนะแถวจังหวัด (ตัวเล็กหลายตัว)
    rows.sort(key=lambda r: -min(r["n"], 8) * r["h"] * (0.5 + r["ring"] / 510.0))
    inv = 1.0 / s
    out = []
    for r in rows[:k]:
        x0, y0, x1, y1 = r["b"]
        pad = int(0.5 * r["h"])
        x0, y0, x1, y1 = max(0, x0 - pad), max(0, y0 - pad), min(W, x1 + pad), min(H, y1 + pad)
        out.append((int(x0 * inv), int(y0 * inv), int((x1 - x0) * inv), int((y1 - y0) * inv), min(1.0, r["n"] / 8.0), r["ang"]))
    return out

def find_text_block(img):
    r = find_text_blocks(img, 1)
    return r[0] if r else None

def deskew(c, ang):
    """หมุนภาพให้แถวตัวอักษรอยู่แนวนอน (ขยายผืนผ้าใบไม่ให้ขอบตัด) · มุมเล็กมาก = ไม่ทำอะไร"""
    if abs(ang) < 2.0 or abs(ang) > 40:
        return c
    h, w = c.shape[:2]
    M = cv2.getRotationMatrix2D((w / 2, h / 2), ang, 1.0)
    cs, sn = abs(M[0, 0]), abs(M[0, 1])
    nw, nh = int(h * sn + w * cs), int(h * cs + w * sn)
    M[0, 2] += nw / 2 - w / 2; M[1, 2] += nh / 2 - h / 2
    return cv2.warpAffine(c, M, (nw, nh), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


def estimate_skew(c, span=22, step=2):
    """ประมาณมุมเอียงของบรรทัดตัวอักษรจากโปรไฟล์ความเข้มแนวนอน (ภาพหมุนแล้วแถวตัวอักษรจะคมที่สุดที่มุมที่ถูก) · คืนองศา (บวก = ตามเข็มนาฬิกาในพิกัดภาพ)
    ถ้าได้ผลไม่ชัด (คะแนนต่างจากมุม 0 ไม่มาก) คืน 0"""
    g = cv2.cvtColor(c, cv2.COLOR_BGR2GRAY) if c.ndim == 3 else c
    k = 180.0 / max(g.shape)
    g = cv2.resize(g, None, fx=k, fy=k, interpolation=cv2.INTER_AREA) if k < 1 else g
    _, bw = cv2.threshold(cv2.GaussianBlur(g, (3, 3), 0), 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    if bw.mean() > 127:
        bw = 255 - bw
    h, w = bw.shape
    best, base, ba = -1.0, 0.0, 0.0
    for a in range(-span, span + 1, step):
        M = cv2.getRotationMatrix2D((w / 2, h / 2), a, 1.0)
        r = cv2.warpAffine(bw, M, (w, h))
        prof = r.sum(axis=1).astype(np.float64)
        v = float(np.var(prof))
        if a == 0:
            base = v
        if v > best:
            best, ba = v, a
    return float(ba) if best > base * 1.15 else 0.0
