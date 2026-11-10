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

def test_tesseract_verified_never_calls_ai(calls):
    log, t = calls; t["tesseract"] = _res("tesseract", "VERIFIED", "กข1234")
    r = rs.process(IMG, ("tesseract", "ai"), True)
    assert log == ["tesseract"] and r["status"] == "VERIFIED" and r["decided_by"] == "tesseract"

def test_fallback_to_ai_when_tesseract_fails(calls):
    log, t = calls; t["tesseract"] = _res("tesseract", "NEEDS_REVIEW", "1234", .8); t["ai"] = _res("ai", "VERIFIED", "กข1234")
    r = rs.process(IMG, ("tesseract", "ai"), True)
    assert log == ["tesseract", "ai"] and r["status"] == "VERIFIED" and r["decided_by"] == "ai"

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
