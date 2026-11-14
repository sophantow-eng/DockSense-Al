import cv2, numpy as np
from app import plate_utils as pu, image_utils as iu, recognition_service as rs

def test_clean_and_standard():
    assert pu.clean("กข 1234 ") == "กข1234"
    assert pu.clean("1กก-1234") == "1กก1234"
    assert pu.is_standard("กข1234") and pu.is_standard("1กก1234")
    assert not pu.is_standard("ABC123") and not pu.is_standard("กข")
    assert pu.display("1กก1234") == "1กก 1234"

def test_similarity():
    assert pu.char_similarity("กข1234", "กข1234") == 1.0
    assert 0.8 < pu.char_similarity("กข1234", "กข1284") < 1.0

def _frame(text, conf, fp):
    return {"fp": fp, "raw": [text], "quality": {}, "best": {"text": text, "conf": conf, "std": pu.is_standard(text), "variant": "x"}}

def test_vote_accepts_agreeing_frames():
    r = rs.decide([_frame("กข1234", .95, "a"), _frame("กข1234", .93, "b")])
    assert r["status"] == "VERIFIED" and r["plate_norm"] == "กข1234" and r["independent_frames"] == 2

def test_disagreeing_frame_lowers_confidence_to_review():
    r = rs.decide([_frame("กข1234", .95, "a"), _frame("กข1234", .93, "b"), _frame("กข1284", .6, "c")])
    assert r["plate_norm"] == "กข1234" and r["status"] == "NEEDS_REVIEW"

def test_duplicate_frames_count_once():
    r = rs.decide([_frame("กข1234", .9, "same")] * 5)
    assert r["independent_frames"] == 1

def test_nonstandard_goes_to_review_not_rejected():
    r = rs.decide([_frame("กก12345", .95, "a")])
    assert r["status"] in ("NEEDS_REVIEW", "REJECTED") and r["plate_norm"] == "กก12345"
    assert r["status"] != "VERIFIED"

def test_low_conf_rejected_and_empty_failed():
    assert rs.decide([_frame("กข1234", .3, "a")])["status"] == "REJECTED"
    assert rs.decide([{"fp": "a", "raw": [], "quality": {}, "best": None}])["status"] == "FAILED"

def test_quality_and_find_plate():
    img = np.full((480, 640, 3), 90, np.uint8)
    cv2.rectangle(img, (200, 300), (440, 380), (255, 255, 255), -1)
    cv2.putText(img, "1234", (230, 360), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (0, 0, 0), 4)
    q = iu.quality(img); assert q["width"] == 640
    b = iu.find_plate(img); assert b is not None and 150 < b[0] < 260
    ok, buf = cv2.imencode(".jpg", img); assert iu.decode(buf.tobytes()).shape == img.shape
    assert set(iu.variants(iu.crop(img, b))) == {"orig", "clahe", "sharp"}

def test_known_plate_fast_verify(monkeypatch):
    from app import known_plates
    monkeypatch.setattr(known_plates, "get", lambda: frozenset({"กข1234"}))
    r = rs.decide([_frame("กข1234", .78, "a")])      # ต่ำกว่า HIGH แต่เป็นรถที่ลงไว้เป๊ะ
    assert r["status"] == "VERIFIED" and r["known_vehicle"] is True
    r2 = rs.decide([_frame("กข9999", .78, "a")])     # ไม่รู้จัก: ยังต้องตรวจ
    assert r2["status"] == "NEEDS_REVIEW" and r2["known_vehicle"] is False

def test_near_match_is_suggestion_only(monkeypatch):
    from app import known_plates
    monkeypatch.setattr(known_plates, "get", lambda: frozenset({"กข1234"}))
    r = rs.decide([_frame("กข1284", .95, "a")])
    assert r["plate_norm"] == "กข1284" and r["suggestion"] == "กข1234" and r["known_vehicle"] is False


def test_with_yolo_agree_conflict_and_solo(monkeypatch):
    from app import recognition_service as rs, yolo_engine
    monkeypatch.setattr(yolo_engine, "enabled", lambda: True)
    base = lambda p: {"found": True, "status": "NEEDS_REVIEW", "plate": p, "plate_norm": p, "confidence": 0.6, "raw": [p], "needs_review": True}
    y = lambda p, m=0.9: {"status": "OK", "plate": p, "min_conf": m, "mean_conf": m, "province_code": "BKK", "plate_found": True, "n_chars": len(p or "")}
    monkeypatch.setattr(yolo_engine, "read", lambda j: y("1กฆ9151"))
    o = rs._with_yolo(base("1กฆ9151"), b"x")          # ตรงกัน → ผ่าน
    assert o["status"] == "VERIFIED" and o["plate"] == "1กฆ 9151" and o.get("internal_agree") and o["province_code"] == "BKK"
    o = rs._with_yolo(base("1กม9151"), b"x")          # ไม่ตรง → ตรวจ + conflict
    assert o["status"] == "NEEDS_REVIEW" and o["conflict"] == sorted({"1กฆ9151", "1กม9151"})
    o = rs._with_yolo({"found": False, "status": "FAILED", "plate": None, "raw": []}, b"x")   # EasyOCR ไม่เห็น → YOLO เดี่ยวไม่ผ่านเอง
    assert o["status"] == "NEEDS_REVIEW" and o["plate"] == "1กฆ 9151" and not o.get("internal_agree")
    monkeypatch.setattr(yolo_engine, "read", lambda j: y(None))
    e = base("1กฆ9151"); assert rs._with_yolo(e, b"x")["status"] == "NEEDS_REVIEW" and rs._with_yolo(e, b"x")["plate"] == "1กฆ9151"
    monkeypatch.setattr(yolo_engine, "enabled", lambda: False)
    assert rs._with_yolo(e, b"x") is e

def test_final_internal_agree_not_blocked_by_silent_tesseract():
    from app import recognition_service as rs
    a = {"engine": "ai", "status": "VERIFIED", "plate": "1กฆ 9151", "plate_norm": "1กฆ9151", "confidence": 0.9, "internal_agree": True}
    t = {"engine": "tesseract", "status": "FAILED", "plate": None}
    assert rs._final({"tesseract": t, "ai": a})["status"] == "VERIFIED"
    a2 = {**a}; a2.pop("internal_agree")
    assert rs._final({"tesseract": t, "ai": a2})["status"] == "NEEDS_REVIEW"
