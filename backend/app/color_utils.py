"""ประมาณสีตัวรถจากพื้นที่รอบป้ายทะเบียน (ตัวถังเหนือ/ข้างป้าย เช่น กันชน ฝากระโปรง ฝาท้าย)
heuristic ด้วย OpenCV (HSV) — ไม่ใช่โมเดลเรียนรู้ · แสง/เงา/พื้นหลังมีผล จึงคืน "ค่าประมาณ" พร้อมความมั่นใจ ถ้าไม่ชัดคืน None (ไม่เดา)"""
import cv2
import numpy as np

# (ชื่อ, เงื่อนไข HSV) — H 0..179, S/V 0..255 ของ OpenCV
def _classify(h, s, v):
    out = np.full(h.shape, -1, np.int8)
    names = ["ดำ", "ขาว", "เทา/เงิน", "แดง", "ส้ม", "น้ำตาล", "เหลือง", "เขียว", "ฟ้า", "น้ำเงิน", "ม่วง/ชมพู"]
    I = {n: i for i, n in enumerate(names)}
    low_s = s < 45
    out[v < 55] = I["ดำ"]
    m = out < 0
    out[m & low_s & (v >= 185)] = I["ขาว"]
    out[(out < 0) & low_s] = I["เทา/เงิน"]
    col = (out < 0) & (s >= 45)
    red = col & ((h < 8) | (h >= 170))
    out[red & (v >= 90)] = I["แดง"]
    out[red & (v < 90)] = I["น้ำตาล"]
    o = col & (h >= 8) & (h < 20)
    out[o & (v >= 150) & (s >= 110)] = I["ส้ม"]
    out[o & ~((v >= 150) & (s >= 110))] = I["น้ำตาล"]
    out[col & (h >= 20) & (h < 36)] = I["เหลือง"]
    out[col & (h >= 36) & (h < 85)] = I["เขียว"]
    b = col & (h >= 85) & (h < 130)
    out[b & (v >= 170) & (s < 160)] = I["ฟ้า"]
    out[b & ~((v >= 170) & (s < 160))] = I["น้ำเงิน"]
    out[col & (h >= 130) & (h < 170)] = I["ม่วง/ชมพู"]
    return out, names

def estimate(img, plate_box=None):
    """คืน {"name","confidence","share"} หรือ None · plate_box=(x,y,w,h) ในพิกัดภาพ (ถ้าไม่มี ใช้กลางภาพส่วนบน-กลาง)"""
    H, W = img.shape[:2]
    if plate_box:
        x, y, w, h = plate_box[:4]
        # ตัวถังเหนือป้าย + สองข้างป้าย (ไม่เอาตัวป้ายเอง)
        regions = [(x - int(0.8 * w), y - int(2.6 * h), x + w + int(0.8 * w), y - int(0.25 * h))]
    else:
        regions = [(int(0.25 * W), int(0.2 * H), int(0.75 * W), int(0.6 * H))]
    px = []
    for x0, y0, x1, y1 in regions:
        x0, y0, x1, y1 = max(0, x0), max(0, y0), min(W, x1), min(H, y1)
        if x1 - x0 < 20 or y1 - y0 < 12:
            continue
        roi = img[y0:y1, x0:x1]
        roi = cv2.resize(roi, (64, max(8, int(64 * roi.shape[0] / roi.shape[1]))), interpolation=cv2.INTER_AREA)
        px.append(cv2.cvtColor(roi, cv2.COLOR_BGR2HSV).reshape(-1, 3))
    if not px:
        return None
    hsv = np.concatenate(px)
    cls, names = _classify(hsv[:, 0], hsv[:, 1], hsv[:, 2])
    cls = cls[cls >= 0]
    if cls.size < 100:
        return None
    cnt = np.bincount(cls, minlength=len(names)); i = int(cnt.argmax()); share = float(cnt[i] / cls.size)
    # แสงจ้า/เงา: ดำกับเทามักปนกัน ถ้าทั้งคู่ใกล้กันให้รวมเป็นกลุ่มโทนเข้ม/กลางเพื่อไม่ตัดสินใจผิดแบบมั่นใจ
    if share < 0.38:
        return None
    return {"name": names[i], "share": round(share, 2), "confidence": round(min(0.9, share), 2)}
