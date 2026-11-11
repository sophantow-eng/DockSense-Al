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
