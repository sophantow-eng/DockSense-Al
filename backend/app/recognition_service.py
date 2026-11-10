"""ไหลงาน: ตรวจคุณภาพ → หาป้าย → ปรับภาพ → OCR → ทำความสะอาด → ตรวจรูปแบบ → โหวตหลายเฟรม → ตัดสินใจ"""
import time
from collections import defaultdict
import os
from . import config, image_utils as iu, plate_utils as pu, ocr_service, known_plates, tesseract_engine, ai_engine

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

def read_frame(img, reader=None, variant_names=None) -> dict:
    reader = reader or ocr_service.read
    t0 = time.time()
    q = iu.quality(img)
    box = iu.find_plate(img)
    target = iu.crop(img, box) if box else img
    cands = []
    known = known_plates.get()
    for name, v in iu.variants(target).items():
        if variant_names and name not in variant_names:
            continue
        text, conf = _combine(reader(v))
        if text:
            cands.append({"variant": name, "text": text, "conf": conf, "std": pu.is_standard(text)})
            # ทางลัดรถเก่า: อ่านตรงทะเบียนที่ลงไว้ + มั่นใจสูง → ไม่ต้องลองปรับภาพแบบอื่น (ประหยัดเวลา)
            if text in known and conf >= config.KNOWN_EARLY:
                break
            if variant_names and pu.is_standard(text) and conf >= config.HIGH_CONF:   # ตัวช้า (Tesseract): ได้ผลดีแล้วไม่ต้องลองแบบอื่น
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

def _frames(images, reader, variant_names):
    frames = []
    for b in images:
        try:
            frames.append(read_frame(iu.decode(b), reader, variant_names))
        except ValueError as e:
            frames.append({"fp": "", "quality": {"problems": ["bad_image"]}, "plate_box": None, "raw": [], "best": None, "ms": 0, "error": str(e)})
    return frames

def rss_mb() -> float | None:
    """หน่วยความจำจริงของโปรเซสนี้ตอนนี้ (MB) — อ่านจาก /proc (Linux) · อ่านไม่ได้ = None (ไม่เดา)"""
    try:
        import psutil  # Windows/Linux (ถ้าลงไว้)
        return round(psutil.Process().memory_info().rss / 1048576, 1)
    except Exception:
        pass
    try:
        with open("/proc/self/statm") as f:
            return round(int(f.read().split()[1]) * os.sysconf("SC_PAGE_SIZE") / 1048576, 1)
    except Exception:
        return None

def run_engine(name: str, images: list[bytes]) -> dict:
    """รันเครื่องยนต์เดียว ผลของแต่ละตัวแยกกันเสมอ (ไม่เขียนทับกัน) · วัดเวลา/หน่วยความจำจริง"""
    t0 = time.time()
    try:
        if name == "tesseract":
            if not tesseract_engine.available():
                return {"engine": name, "status": "UNAVAILABLE", "error": "ไม่พบ tesseract/pytesseract ในเครื่องนี้", "ms": 0}
            out = decide(_frames(images, tesseract_engine.read, {"orig", "clahe"}))
            out["provider"] = "tesseract"
        elif name == "ai":
            st = ai_engine.status()
            if st["state"] != "READY":
                return {"engine": name, "status": "NOT_CONFIGURED", "error": st["note"], "ms": 0}
            if st["kind"] == "worker":
                out = ai_engine.read_remote(images[0])
                out["provider"] = "ai-worker"
            else:
                out = decide(_frames(images, ocr_service.read, None))
                out["provider"] = "easyocr"
        else:
            return {"engine": name, "status": "UNAVAILABLE", "error": "unknown engine", "ms": 0}
    except Exception as e:  # noqa: BLE001 — ล้มเหลว/หมดเวลา: รายงานตรง ๆ ไม่แต่งผล
        return {"engine": name, "status": "ERROR", "error": f"{type(e).__name__}: {str(e)[:160]}", "ms": int((time.time() - t0) * 1000), "rss_mb": rss_mb()}
    out["engine"] = name
    out["ms"] = int((time.time() - t0) * 1000)
    out["rss_mb"] = rss_mb()
    return out

def _final(results: dict) -> dict:
    """ตัดสินสุดท้ายจากผลแยกตามเครื่องยนต์ — ห้ามให้ผลที่ไม่ผ่านถูกยกเป็น VERIFIED"""
    t, a = results.get("tesseract"), results.get("ai")
    ok = lambda r: r and r.get("status") == "VERIFIED"
    if ok(t):
        return {**t, "decided_by": "tesseract"}
    if ok(a):
        return {**a, "decided_by": "ai"}
    found = [r for r in (t, a) if r and r.get("plate")]
    if not found:
        return {"found": False, "status": "FAILED", "plate": None, "confidence": 0.0, "needs_review": False, "decided_by": None}
    best = max(found, key=lambda r: r.get("confidence", 0))
    plates = {r.get("plate_norm") or r.get("plate") for r in found}
    status = "NEEDS_REVIEW" if best.get("status") in ("VERIFIED", "NEEDS_REVIEW") else best.get("status", "NEEDS_REVIEW")
    out = {**best, "status": status, "needs_review": status == "NEEDS_REVIEW", "decided_by": best.get("engine")}
    if len(plates) > 1:
        out.update(status="NEEDS_REVIEW", needs_review=True, conflict=sorted(p for p in plates if p))
    return out

def process(images: list[bytes], engines=("tesseract",), fallback: bool = True) -> dict:
    """ผลิตจริง: Tesseract ก่อน → (ผ่าน = จบ ไม่เรียก AI) → ไม่ผ่าน + เปิด fallback + AI พร้อม → AI
    engines คือสวิตช์ที่ "อนุญาต" ให้ใช้ · ปิดทั้งคู่ = ไม่ประมวลผล (ผู้เรียกต้องตอบ recognition_disabled)"""
    t0 = time.time()
    engines = set(engines)
    results = {}
    if "tesseract" in engines:
        results["tesseract"] = run_engine("tesseract", images)
    t = results.get("tesseract")
    need_ai = "ai" in engines and (t is None or (fallback and t.get("status") != "VERIFIED"))
    if need_ai:
        results["ai"] = run_engine("ai", images)
    final = _final(results)
    final["engines"] = results
    final["engines_used"] = [k for k, v in results.items() if v.get("status") not in ("UNAVAILABLE", "NOT_CONFIGURED")]
    final["ms"] = int((time.time() - t0) * 1000)
    final["quality_note"] = None
    return final
