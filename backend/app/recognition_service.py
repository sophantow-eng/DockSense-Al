"""ไหลงาน: ตรวจคุณภาพ → หาป้าย → ปรับภาพ → OCR → ทำความสะอาด → ตรวจรูปแบบ → โหวตหลายเฟรม → ตัดสินใจ"""
import time
from collections import defaultdict
from . import config, image_utils as iu, plate_utils as pu, ocr_service, known_plates

def _combine(parts):
    """ข้อความหลายส่วนในป้ายเดียว (บรรทัดบน เลข/อักษร + บรรทัดล่าง จังหวัด): เอาส่วนที่ clean แล้วเป็นรูปทะเบียน"""
    texts = [(pu.clean(t), c) for t, c in parts if pu.clean(t)]
    if not texts:
        return "", 0.0
    joined = "".join(t for t, _ in texts)
    cs = [c for _, c in texts]
    if pu.is_standard(joined):
        return joined, sum(cs) / len(cs)
    best = max(texts, key=lambda x: (pu.is_standard(x[0]), x[1]))
    return best

def read_frame(img) -> dict:
    t0 = time.time()
    q = iu.quality(img)
    box = iu.find_plate(img)
    target = iu.crop(img, box) if box else img
    cands = []
    known = known_plates.get()
    for name, v in iu.variants(target).items():
        text, conf = _combine(ocr_service.read(v))
        if text:
            cands.append({"variant": name, "text": text, "conf": conf, "std": pu.is_standard(text)})
            # ทางลัดรถเก่า: อ่านตรงทะเบียนที่ลงไว้ + มั่นใจสูง → ไม่ต้องลองปรับภาพแบบอื่น (ประหยัดเวลา)
            if text in known and conf >= config.KNOWN_EARLY:
                break
    best = max(cands, key=lambda c: (c["std"], c["conf"]), default=None)
    return {"fp": iu.fingerprint(img), "quality": q, "plate_box": box[:4] if box else None,
            "raw": [c["text"] for c in cands], "best": best, "ms": int((time.time() - t0) * 1000)}

def decide(frames: list[dict]) -> dict:
    """โหวตถ่วงน้ำหนักด้วยความมั่นใจ · เฟรมที่ลายนิ้วมือซ้ำนับครั้งเดียว · ไม่แก้ตัวอักษรเอง"""
    seen, votes, raws = set(), defaultdict(float), []
    n_indep = 0
    for f in frames:
        raws += f["raw"]
        b = f["best"]
        if not b or f["fp"] in seen:
            continue
        seen.add(f["fp"]); n_indep += 1
        votes[b["text"]] += b["conf"] * (1.0 if b["std"] else 0.6)
    if not votes:
        return {"found": False, "status": "FAILED", "plate": None, "confidence": 0.0, "needs_review": False,
                "raw": raws, "frames": len(frames), "independent_frames": n_indep}
    plate, score = max(votes.items(), key=lambda kv: kv[1])
    # ความมั่นใจรวม = สัดส่วนคะแนนของผู้ชนะ × ความมั่นใจเฉลี่ยของเฟรมที่ให้ผู้ชนะ
    total = sum(votes.values())
    mine = [f["best"]["conf"] for f in frames if f["best"] and f["best"]["text"] == plate]
    conf = round((score / total) * (sum(mine) / len(mine)), 3)
    std = pu.is_standard(plate)
    near, exact = known_plates.nearest(plate)
    if n_indep == 1:
        conf = round(conf * 0.95, 3)  # เฟรมเดียวเชื่อถือน้อยกว่าหลายเฟรมที่ตรงกัน
    if conf < config.LOW_CONF:
        status, review = "REJECTED", False
    elif std and (conf >= config.HIGH_CONF or (exact and conf >= config.KNOWN_CONF)):
        status, review = "VERIFIED", False
    else:
        status, review = "NEEDS_REVIEW", True
    return {"found": status != "REJECTED", "status": status, "plate": pu.display(plate) if std else plate,
            "plate_norm": plate, "standard_format": std, "confidence": conf, "needs_review": review,
            "raw": raws, "frames": len(frames), "independent_frames": n_indep,
            "known_vehicle": exact,
            # ใกล้เคียงรถที่ลงไว้ (ต่าง 1 ตัวอักษร) = แค่ "ข้อเสนอ" ให้คนตรวจ ไม่แก้ทะเบียนเอง
            "suggestion": near if (near and not exact) else None}

def process(images: list[bytes]) -> dict:
    t0 = time.time()
    frames = []
    for b in images:
        try:
            frames.append(read_frame(iu.decode(b)))
        except ValueError as e:
            frames.append({"fp": "", "quality": {"problems": ["bad_image"]}, "plate_box": None, "raw": [], "best": None, "ms": 0, "error": str(e)})
    out = decide(frames)
    out["provider"] = "easyocr"
    out["quality"] = [f["quality"] for f in frames]
    out["ms"] = int((time.time() - t0) * 1000)
    return out
