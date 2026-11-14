"""ไหลงาน: ตรวจคุณภาพ → หาป้าย → ปรับภาพ → OCR → ทำความสะอาด → ตรวจรูปแบบ → โหวตหลายเฟรม → ตัดสินใจ"""
import re
import time
from collections import defaultdict
import os
from . import config, image_utils as iu, plate_utils as pu, ocr_service, known_plates, tesseract_engine, ai_engine

def _combine(parts):
    """ข้อความหลายส่วนในป้ายเดียว (บรรทัดบน เลข/อักษร + บรรทัดล่าง จังหวัด): หาส่วนที่ต่อกันตามลำดับ (ข้ามส่วนจังหวัดได้) แล้วเป็นรูปทะเบียนยาวที่สุด
    (ข้อมูลจริง: ข้อความจังหวัดปนมาทำให้ต่อทั้งหมดแล้วไม่ใช่รูปทะเบียน จึงเคยเหลือแต่ท่อนเดียว เช่น '3กล' กับ '7029' แยกกัน)"""
    texts = [(pu.clean(t), c) for t, c in parts if pu.clean(t)]
    if not texts:
        return "", 0.0
    from itertools import combinations
    texts = texts[:7]
    best_win = None
    for n in range(1, len(texts) + 1):
        for idx in combinations(range(len(texts)), n):   # คงลำดับเดิม ข้ามส่วนที่เป็นข้อความจังหวัดได้
            joined = "".join(texts[k][0] for k in idx)
            if pu.is_standard(joined):
                cs = [texts[k][1] for k in idx]
                cand = (len(joined), sum(cs) / len(cs), joined)
                if best_win is None or cand[:2] > best_win[:2]:
                    best_win = cand
    if best_win:
        return best_win[2], best_win[1]
    best = max(texts, key=lambda x: x[1])
    return best[0], min(best[1], 0.4)   # ไม่ใช่รูปทะเบียนเต็ม (ได้แต่เลข/อักษรเดี่ยว) ห้ามมีความมั่นใจสูง

_PRE = re.compile(rf"^[0-9]?[{pu.THAI_CONS}]{{1,2}}$")
_DIG = re.compile(r"^[0-9]{3,4}$")

def _merge_halves(cands: list[dict]) -> dict | None:
    """ข้อมูลจริง (3กล7029, 6ขห4243): แต่ละแบบภาพเห็นแค่ครึ่งเดียว (อักษรนำ หรือ เลขท้าย) ไม่มีแบบไหนเห็นครบ
    ถ้าไม่มีผลที่เป็นรูปทะเบียนเต็มเลย → ต่อ 'อักษรนำที่เห็นซ้ำมากสุด' + 'เลขท้ายที่เห็นซ้ำมากสุด' (ไม่แก้ตัวอักษรใด)
    ผลที่ต่อเองจำกัดความมั่นใจ ≤ 0.6 เพื่อไม่ผ่านอัตโนมัติ — ต้องมีคนยืนยัน"""
    if any(c["std"] for c in cands):
        return None
    def top(rx):
        grp = {}
        for c in cands:
            if rx.match(c["text"]):
                g = grp.setdefault(c["text"], [0, 0.0]); g[0] += 1; g[1] = max(g[1], c["conf"])
        return max(grp.items(), key=lambda kv: (kv[1][0], kv[1][1]), default=None)
    a, b = top(_PRE), top(_DIG)
    if not a or not b:
        return None
    joined = a[0] + b[0]
    if not pu.is_standard(joined):
        return None
    return {"variant": "merge", "text": joined, "conf": round(min(0.6, a[1][1], b[1][1]), 3), "std": True, "merged": True}

def read_frame(img, reader=None, variant_names=None) -> dict:
    reader = reader or ocr_service.read
    t0 = time.time()
    q = iu.quality(img)
    H0, W0 = img.shape[:2]
    if max(H0, W0) > 1280:   # ภาพใหญ่เกินจำเป็น: ย่อก่อนหาป้าย (เร็วขึ้นมากบน CPU ฟรี) ตัวอักษรป้ายยังใหญ่พอ
        import cv2
        k = 1280 / max(H0, W0); img = cv2.resize(img, None, fx=k, fy=k, interpolation=cv2.INTER_AREA)
    slow = bool(variant_names)   # Tesseract: ไล่หลายตำแหน่ง/หลายแบบภาพจนได้รูปทะเบียนแล้วหยุด
    blocks = iu.find_text_blocks(img, 3 if slow else 1)
    targets = []
    for bx in blocks:   # ตำแหน่งจากตัวอักษรที่เรียงเป็นแถว (หมุนให้ตรงถ้าป้ายเอียง)
        cr = iu.crop(img, bx, pad=0.0)
        ang = bx[5] if abs(bx[5]) >= 2 else iu.estimate_skew(cr)   # มุมจากแนวตัวอักษร ถ้าไม่ชัดใช้โปรไฟล์ความเข้ม
        targets.append((bx, iu.deskew(cr, ang)))
    box = iu.find_plate(img)
    if box:
        targets.append((box, iu.crop(img, box)))
    if not targets:
        targets.append((None, img))
    cands = []
    known = known_plates.get()
    done = False
    if not slow:
        targets.append((None, img))   # สำรองสุดท้าย: ทั้งภาพ (เมื่อตัดส่วนป้ายแล้วอักษรหาย)
    for ti, (bx, target) in enumerate(targets):
        for name, v in iu.variants(target).items():
            if variant_names and name not in variant_names:
                continue
            if ti > 0 and not slow and name not in ("orig", "clahe"):
                continue   # เป้าหมายสำรองใช้แค่ 2 แบบภาพ (คุมเวลา)
            if cands and time.time() - t0 > config.READ_BUDGET:
                done = True; break   # งบเวลาต่อภาพ: ข้อมูลจริงบางภาพใช้ 20-29 วินาที (เกินเวลารอของกล้อง) — หยุดแล้วใช้ผลที่ได้ ไม่เดาเพิ่ม
            text, conf = _combine(reader(v))
            if text:
                cands.append({"variant": name, "text": text, "conf": conf, "std": pu.is_standard(text)})
                if text in known and conf >= config.KNOWN_EARLY:
                    done = True; break
                if slow and pu.is_standard(text):
                    done = True; break
        if done or (not slow and any(c["std"] for c in cands)):
            break
    mg = _merge_halves(cands)
    if mg:
        cands.append(mg)
    box = targets[0][0]
    # เลือกผลต่อเฟรม: ข้อความเดียวกันที่หลายแบบภาพอ่านตรงกัน (ผลรวมความมั่นใจ) ชนะผลเดี่ยวที่มั่นใจสูงแต่ขาดตัว
    agg, cnt = defaultdict(float), defaultdict(int)
    for c in cands: agg[c["text"]] += c["conf"]; cnt[c["text"]] += 1
    # จำนวนแบบภาพที่เห็นตรงกันมาก่อน (ข้อมูลจริง: 'ขว1053' เห็น 2 แบบ ชนะ 'ข1053' ที่เห็นแบบเดียวแต่มั่นใจสูงซึ่งตกอักษรไป 1 ตัว)
    best = max(cands, key=lambda c: (c["std"], cnt[c["text"]], agg[c["text"]], c["conf"]), default=None)
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

def _norm(r):
    return (r.get("plate_norm") or r.get("plate") or "").replace(" ", "").replace("-", "")

def _final(results: dict) -> dict:
    """ตัดสินสุดท้ายจากผลแยกตามเครื่องยนต์ — ห้ามให้ผลที่ไม่ผ่านถูกยกเป็น VERIFIED
    สองเครื่องอ่านตรงกัน = เชื่อถือขึ้น · อ่านไม่ตรงกัน = ส่งให้คนตรวจเสมอ (แม้เครื่องหนึ่งจะมั่นใจ) · AI ตอบแล้วแต่ไม่เห็นป้าย = ไม่ให้ Tesseract ผ่านเดี่ยว"""
    t, a = results.get("tesseract"), results.get("ai")
    ok = lambda r: r and r.get("status") == "VERIFIED"
    alive = lambda r: r and r.get("status") not in ("ERROR", "UNAVAILABLE", "NOT_CONFIGURED")
    found = [r for r in (t, a) if r and r.get("plate")]
    if not found:
        return {"found": False, "status": "FAILED", "plate": None, "confidence": 0.0, "needs_review": False, "decided_by": None}
    plates = {_norm(r) for r in found}
    if len(found) == 2 and len(plates) == 1:  # ตรงกัน
        best = max(found, key=lambda r: r.get("confidence", 0))
        passed = ok(t) or ok(a)
        st = "VERIFIED" if passed else "NEEDS_REVIEW"
        return {**best, "status": st, "needs_review": st != "VERIFIED", "decided_by": best.get("engine"), "agree": True}
    if len(plates) > 1:  # ไม่ตรงกัน
        best = max(found, key=lambda r: r.get("confidence", 0))
        return {**best, "status": "NEEDS_REVIEW", "needs_review": True, "decided_by": best.get("engine"), "conflict": sorted(p for p in plates if p)}
    if ok(t) and a is not None and alive(a) and not a.get("plate"):  # AI ตอบแล้วแต่ไม่เห็นป้ายเลย
        return {**t, "status": "NEEDS_REVIEW", "needs_review": True, "decided_by": "tesseract", "ai_no_confirm": True}
    if ok(a) and t is not None and alive(t) and not t.get("plate"):  # Tesseract ตอบแล้วแต่ไม่เห็น = EasyOCR เดี่ยวไม่ผ่านอัตโนมัติ (ข้อมูลจริง: ผ่านเดี่ยวแล้วผิดได้)
        return {**a, "status": "NEEDS_REVIEW", "needs_review": True, "decided_by": "ai", "tess_no_confirm": True}
    if ok(t):
        return {**t, "decided_by": "tesseract"}
    if ok(a):
        return {**a, "decided_by": "ai"}
    best = found[0]
    status = "NEEDS_REVIEW" if best.get("status") in ("VERIFIED", "NEEDS_REVIEW") else best.get("status", "NEEDS_REVIEW")
    return {**best, "status": status, "needs_review": status == "NEEDS_REVIEW", "decided_by": best.get("engine")}

def _color(images) -> dict:
    """สีตัวรถโดยประมาณ (ค่าประมาณจากพื้นที่รอบป้าย ไม่ใช่ค่าแน่นอน) · ไม่ชัด/ผิดพลาด = None ไม่ทำให้การอ่านทะเบียนล้ม"""
    try:
        from . import color_utils
        img = iu.decode(images[0])
        if max(img.shape[:2]) > 1280:
            import cv2
            k = 1280 / max(img.shape[:2]); img = cv2.resize(img, None, fx=k, fy=k, interpolation=cv2.INTER_AREA)
        blocks = iu.find_text_blocks(img, 1)
        box = blocks[0][:4] if blocks else None
        r = color_utils.estimate(img, box) if box else None
        return {"vehicle_color": r["name"] if r else None, "color_confidence": r["confidence"] if r else None}
    except Exception:  # noqa: BLE001
        return {"vehicle_color": None, "color_confidence": None}

def process(images: list[bytes], engines=("tesseract",), fallback: bool = True) -> dict:
    """ผลิตจริง: ถ้าอนุญาตทั้งสองเครื่องและ AI (EasyOCR บนคอมแรง) พร้อม → อ่านพร้อมกัน แล้วเทียบกัน (เร็วกว่าอ่านต่อคิว + แม่นกว่าเพราะมีเครื่องที่สองยืนยัน)
    AI ไม่พร้อม/ล้มเหลว = ใช้ Tesseract ตามเดิม · เปิดแค่ตัวเดียว = ตัวนั้น · ปิดทั้งคู่ = ไม่ประมวลผล (ผู้เรียกต้องตอบ recognition_disabled)"""
    t0 = time.time()
    engines = set(engines)
    results = {}
    if "tesseract" in engines and "ai" in engines and fallback and ai_engine.ready():
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=2) as ex:
            ft = ex.submit(run_engine, "tesseract", images)
            fa = ex.submit(run_engine, "ai", images)
            results["tesseract"], results["ai"] = ft.result(), fa.result()
    else:
        if "tesseract" in engines:
            results["tesseract"] = run_engine("tesseract", images)
        t = results.get("tesseract")
        if "ai" in engines and (t is None or (fallback and t.get("status") != "VERIFIED")):
            results["ai"] = run_engine("ai", images)
    final = _final(results)
    final["engines"] = results
    final["engines_used"] = [k for k, v in results.items() if v.get("status") not in ("UNAVAILABLE", "NOT_CONFIGURED")]
    final["ms"] = int((time.time() - t0) * 1000)
    final["quality_note"] = None
    w = []
    if final.get("conflict"): w.append("engines_disagree")
    if final.get("agree"): w.append("engines_agree")
    if final.get("ai_no_confirm"): w.append("ai_no_confirm")
    if final.get("tess_no_confirm"): w.append("tess_no_confirm")
    final["warnings"] = w
    final.update(_color(images))
    return final
