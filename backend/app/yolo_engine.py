"""ตัวอ่านตัวอักษรทีละตัวแบบ YOLO (ใช้บนคอมแรงร่วมกับ EasyOCR) — ขั้นตอน: หาตำแหน่งป้าย → ตัดเฉพาะป้าย → ตรวจหาตัวอักษร/เลข/จังหวัด
โมเดล (ชุมชน, ไม่ใช่ของเรา): tanawichsingpae/thai-license-plate-detector และ thai-license-plate-ocr (ใบอนุญาต MIT บนหน้าโมเดล)
ไม่เดาตัวอักษร · โหลดไม่ได้/ไม่ได้ลง ultralytics = ปิดตัวเองเงียบ ๆ ระบบใช้ EasyOCR ต่อได้ปกติ · ตั้ง YOLO_ENABLE=0 เพื่อปิด"""
import logging
import os
import re
import statistics
import threading
import time

log = logging.getLogger("yolo")
DET_REPO = os.environ.get("YOLO_DET_REPO", "tanawichsingpae/thai-license-plate-detector")
OCR_REPO = os.environ.get("YOLO_OCR_REPO", "tanawichsingpae/thai-license-plate-ocr")
CONF = float(os.environ.get("YOLO_CONF", "0.25"))
# รหัส A01..A44 = พยัญชนะไทยลำดับมาตรฐาน (ยืนยันด้วยผลทดสอบจริงบางตัว เช่น A18=ฒ) · A03/A11/A15/A17/A27/A29 (ฃ ซ ฏ ฑ ป ฝ) โมเดลไม่มีคลาส = อ่านตัวเหล่านี้ไม่ได้
THAI = "กขฃคฅฆงจฉชซฌญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรลวศษสหฬอฮ"

_lock = threading.Lock()
_models = None
_failed: str | None = None

def enabled() -> bool:
    return os.environ.get("YOLO_ENABLE", "1") != "0" and _failed is None

def _load():
    global _models, _failed
    with _lock:
        if _models is not None or _failed:
            return _models
        try:
            from huggingface_hub import hf_hub_download
            from ultralytics import YOLO
            _models = (YOLO(hf_hub_download(DET_REPO, "best.pt")), YOLO(hf_hub_download(OCR_REPO, "best.pt")))
            log.info("yolo models loaded")
        except Exception as e:  # noqa: BLE001
            _failed = f"{type(e).__name__}: {str(e)[:120]}"
            log.warning("yolo disabled: %s", _failed)
        return _models

def status() -> dict:
    if os.environ.get("YOLO_ENABLE", "1") == "0":
        return {"state": "DISABLED"}
    if _failed:
        return {"state": "UNAVAILABLE", "error": _failed}
    return {"state": "READY" if _models else "NOT_LOADED"}

def _to_char(name: str):
    if name.isdigit():
        return name
    m = re.fullmatch(r"A(\d\d)", name)
    return THAI[int(m.group(1)) - 1] if m and 1 <= int(m.group(1)) <= 44 else None   # None = รหัสจังหวัด

def _order(boxes):
    """boxes: (cx, cy, h, char) · แถวบนก่อน, ซ้าย→ขวาในแต่ละแถว"""
    if not boxes:
        return ""
    hs = statistics.median(b[2] for b in boxes)
    boxes = sorted(boxes, key=lambda b: b[1])
    rows, cur = [], [boxes[0]]
    for b in boxes[1:]:
        if b[1] - cur[-1][1] > 0.7 * hs:
            rows.append(cur); cur = [b]
        else:
            cur.append(b)
    rows.append(cur)
    return "".join(c[3] for r in rows for c in sorted(r, key=lambda b: b[0]))

def read(jpeg: bytes) -> dict:
    """คืน {status, plate, min_conf, mean_conf, province_code, plate_found, n_chars, ms} · plate = ตัวอักษร/เลขล้วน (ไม่มีช่องว่าง)"""
    t0 = time.time()
    m = _load()
    if not m:
        return {"status": "UNAVAILABLE", "error": _failed, "plate": None}
    import cv2
    import numpy as np
    det, ocr = m
    img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return {"status": "ERROR", "error": "bad_image", "plate": None}
    d = det.predict(img, imgsz=640, conf=0.2, verbose=False)[0]
    if not len(d.boxes):   # หาป้ายไม่เจอ → ลองใหม่แบบละเอียดขึ้น (ใช้เฉพาะตอนพลาด ใบที่เจอแล้วไม่ถูกแตะ; ผลยังต้องตรงกับ EasyOCR ถึงผ่าน)
        d = det.predict(img, imgsz=1280, conf=0.15, verbose=False)[0]
    crop, found = img, False
    if len(d.boxes):
        bi = max(range(len(d.boxes)), key=lambda i: float(d.boxes[i].conf))
        x1, y1, x2, y2 = [int(v) for v in d.boxes[bi].xyxy[0].tolist()]
        pw, ph = int((x2 - x1) * 0.08), int((y2 - y1) * 0.12)
        H, W = img.shape[:2]
        crop, found = img[max(0, y1 - ph):min(H, y2 + ph), max(0, x1 - pw):min(W, x2 + pw)], True
    r = ocr.predict(crop, imgsz=640, conf=CONF, verbose=False)[0]
    chars, confs, prov = [], [], []
    for b in r.boxes:
        name, cf = r.names[int(b.cls)], float(b.conf)
        c = _to_char(name)
        x1, y1, x2, y2 = b.xyxy[0].tolist()
        if c is None:
            prov.append((cf, name))
        else:
            chars.append(((x1 + x2) / 2, (y1 + y2) / 2, y2 - y1, c)); confs.append(cf)
    plate = _order(chars)
    return {"status": "OK" if plate else "NO_PLATE", "plate": plate or None, "plate_found": found, "n_chars": len(chars),
            "min_conf": round(min(confs), 3) if confs else 0.0, "mean_conf": round(sum(confs) / len(confs), 3) if confs else 0.0,
            "province_code": max(prov)[1] if prov else None, "ms": int((time.time() - t0) * 1000)}
