"""ตรรกะสวิตช์เครื่องยนต์ + Tesseract→AI fallback (ใช้ตัวจำลองเฉพาะ "การเรียก" ไม่จำลองผลสำเร็จของ AI จริง)"""
import cv2, numpy as np, pytest
from app import recognition_service as rs, tesseract_engine, ai_engine

def _res(engine, status, plate=None, conf=0.9):
    return {"engine": engine, "status": status, "plate": plate, "plate_norm": plate, "confidence": conf, "found": bool(plate), "raw": [], "ms": 1}

@pytest.fixture
def calls(monkeypatch):
    log = []
    table = {}
    def fake(name, images):
        log.append(name); return table[name]
    monkeypatch.setattr(rs, "run_engine", fake)
    monkeypatch.setattr(ai_engine, "ready", lambda: True)
    return log, table

IMG = [b"x"]

def test_both_engines_run_in_parallel_and_agree(calls):
    log, t = calls; t["tesseract"] = _res("tesseract", "VERIFIED", "กข1234"); t["ai"] = _res("ai", "VERIFIED", "กข1234")
    r = rs.process(IMG, ("tesseract", "ai"), True)
    assert sorted(log) == ["ai", "tesseract"] and r["status"] == "VERIFIED" and r["agree"]

def test_tesseract_verified_alone_needs_ai_confirmation(calls):
    log, t = calls; t["tesseract"] = _res("tesseract", "VERIFIED", "กข1234"); t["ai"] = _res("ai", "FAILED")
    r = rs.process(IMG, ("tesseract", "ai"), True)
    assert r["status"] == "NEEDS_REVIEW" and r.get("ai_no_confirm")

def test_ai_verified_but_tesseract_disagrees_goes_to_review(calls):
    log, t = calls; t["tesseract"] = _res("tesseract", "NEEDS_REVIEW", "1234", .8); t["ai"] = _res("ai", "VERIFIED", "กข1234")
    r = rs.process(IMG, ("tesseract", "ai"), True)
    assert sorted(log) == ["ai", "tesseract"] and r["status"] == "NEEDS_REVIEW" and r["conflict"]

def test_fallback_off_means_ai_not_called(calls):
    log, t = calls; t["tesseract"] = _res("tesseract", "NEEDS_REVIEW", "1234", .8); t["ai"] = _res("ai", "VERIFIED", "กข1234")
    r = rs.process(IMG, ("tesseract", "ai"), False)
    assert log == ["tesseract"] and r["status"] == "NEEDS_REVIEW"

def test_ai_off_and_tesseract_off(calls):
    log, t = calls; t["tesseract"] = _res("tesseract", "NEEDS_REVIEW", "1234", .8)
    rs.process(IMG, ("tesseract",), True); assert log == ["tesseract"]
    log.clear(); t["ai"] = _res("ai", "VERIFIED", "กข1234")
    r = rs.process(IMG, ("ai",), True); assert log == ["ai"] and r["status"] == "VERIFIED"
    log.clear(); r = rs.process(IMG, (), True); assert log == [] and r["status"] == "FAILED"

def test_conflicting_engines_never_verified(calls):
    log, t = calls; t["tesseract"] = _res("tesseract", "NEEDS_REVIEW", "กข1234", .8); t["ai"] = _res("ai", "NEEDS_REVIEW", "กข1284", .8)
    r = rs.process(IMG, ("tesseract", "ai"), True)
    assert r["status"] == "NEEDS_REVIEW" and r["conflict"] == ["กข1234", "กข1284"]

def test_ai_not_configured_is_reported_not_simulated():
    st = ai_engine.status()
    if st["state"] == "NOT_CONFIGURED":
        r = rs.run_engine("ai", IMG)
        assert r["status"] == "NOT_CONFIGURED" and "plate" not in r

@pytest.mark.skipif(not tesseract_engine.available(), reason="tesseract ไม่ได้ติดตั้ง")
def test_tesseract_runs_and_blank_image_is_not_verified():
    img = np.full((300, 500, 3), 200, np.uint8)
    ok, buf = cv2.imencode(".jpg", img)
    r = rs.run_engine("tesseract", [buf.tobytes()])
    assert r["engine"] == "tesseract" and r["status"] != "VERIFIED" and "ms" in r


def _strong(plate="1กฆ9151"):
    return {**_res("ai", "VERIFIED", plate, 0.9), "internal_agree": True, "provider": "yolo+easyocr"}

def test_strong_ai_pair_not_vetoed_by_weak_tesseract(calls):
    log, t = calls; t["tesseract"] = _res("tesseract", "NEEDS_REVIEW", "1กม9157", 0.55); t["ai"] = _strong()
    r = rs.process(IMG, ("tesseract", "ai"), True)
    assert r["status"] == "VERIFIED" and r["plate_norm"] == "1กฆ9151" and "tesseract_dissent" in r["warnings"] and "engines_disagree" not in r["warnings"]

def test_strong_ai_pair_not_vetoed_by_tesseract_garbage(calls):
    log, t = calls; t["tesseract"] = _res("tesseract", "REJECTED", "ชลบร", 0.2); t["ai"] = _strong()
    assert rs.process(IMG, ("tesseract", "ai"), True)["status"] == "VERIFIED"

def test_tesseract_verified_with_different_plate_still_goes_to_review(calls):
    log, t = calls; t["tesseract"] = _res("tesseract", "VERIFIED", "2ขง5738", 0.95); t["ai"] = _strong()
    r = rs.process(IMG, ("tesseract", "ai"), True)
    assert r["status"] == "NEEDS_REVIEW" and r["conflict"]

def test_single_easyocr_without_yolo_agreement_is_still_vetoed(calls):
    log, t = calls; t["tesseract"] = _res("tesseract", "NEEDS_REVIEW", "1กม9157", 0.55); t["ai"] = _res("ai", "VERIFIED", "1กฆ9151", 0.9)
    assert rs.process(IMG, ("tesseract", "ai"), True)["status"] == "NEEDS_REVIEW"
