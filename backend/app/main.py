import hmac
import logging
import threading
import time
import uuid
from collections import defaultdict, deque
from fastapi import FastAPI, File, Header, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from . import config, ocr_service, recognition_service, known_plates, tesseract_engine, ai_engine

logging.basicConfig(level=logging.INFO, format='{"t":"%(asctime)s","lvl":"%(levelname)s","msg":"%(message)s"}')
log = logging.getLogger("docksense")
app = FastAPI(title="DockSense OCR Backend", version="2.0.0")

_hits: dict[str, deque] = defaultdict(deque)
_slots = threading.BoundedSemaphore(max(1, config.OCR_CONCURRENCY))   # จำกัดงาน OCR พร้อมกัน (คิวไม่สะสมไม่จำกัด)
_stats = {"started": time.time(), "ok": 0, "busy": 0, "errors": 0}

def _rate(key: str):
    q, now = _hits[key], time.time()
    while q and now - q[0] > 60:
        q.popleft()
    if len(q) >= config.RATE_PER_MIN:
        raise HTTPException(429, "too many requests")
    q.append(now)

def _auth(key: str | None):
    if not config.BACKEND_KEY:
        raise HTTPException(503, "BACKEND_KEY ยังไม่ได้ตั้งค่า")
    if not key or not hmac.compare_digest(key, config.BACKEND_KEY):
        raise HTTPException(401, "invalid api key")
    _rate("k")

def _engines(hdr: str | None) -> tuple[str, ...]:
    """x-ocr-engines: tesseract,ai (ผู้เรียกที่ไว้ใจได้ส่งสวิตช์มา) — ไม่ส่ง = ใช้ทั้งสอง · ว่าง = ปิดหมด"""
    if hdr is None:
        return ("tesseract", "ai")
    return tuple(x for x in (p.strip().lower() for p in hdr.split(",")) if x in ("tesseract", "ai"))

async def _images(request: Request, files: list[UploadFile] | None) -> list[bytes]:
    out = []
    if files:
        for f in files[:6]:
            out.append(await f.read())
    else:
        out.append(await request.body())
    for b in out:
        if len(b) > config.MAX_IMAGE_BYTES:
            raise HTTPException(413, "image too large")
        if len(b) < 2000 or not (b[:2] == b"\xff\xd8" or b[:4] == b"\x89PNG"):
            raise HTTPException(415, "JPEG or PNG only")
    return out

def _guarded(fn, *a):
    """เข้าคิวรอไม่เกิน OCR_QUEUE_WAIT วินาที เกินนั้นตอบ busy (กล้องจะลองใหม่รอบหน้า/ถอยไป Gemini)"""
    if not _slots.acquire(timeout=config.OCR_QUEUE_WAIT):
        _stats["busy"] += 1
        raise HTTPException(429, "busy")
    try:
        return fn(*a)
    finally:
        _slots.release()

def _status() -> dict:
    return {
        "tesseract": {"state": "READY" if tesseract_engine.available() and tesseract_engine.has_thai() else "UNAVAILABLE",
                      "version": tesseract_engine.version(), "thai_data": tesseract_engine.has_thai()},
        "ai": ai_engine.status(),
        "known_plates": known_plates.status(),
        "rss_mb": recognition_service.rss_mb(),
        "uptime_s": int(time.time() - _stats["started"]),
        "counters": {k: v for k, v in _stats.items() if k != "started"},
    }

@app.get("/api/v1/health")
def health():
    """ไม่ต้องใช้รหัส · บอกว่าบริการอยู่ และเครื่องยนต์พร้อมไหม (ไม่เปิดเผยค่า secret)"""
    import cv2
    st = _status()
    ready = st["tesseract"]["state"] == "READY" or st["ai"]["state"] == "READY"
    return {"ok": True, "opencv": cv2.__version__, "ocr_available": ready, "key_configured": bool(config.BACKEND_KEY),
            "tesseract": st["tesseract"]["state"], "ai": st["ai"]["state"], "known_plates": st["known_plates"]}

@app.get("/api/v1/ocr/status")
def ocr_status(x_api_key: str | None = Header(default=None)):
    _auth(x_api_key)
    return _status()

@app.post("/api/v1/recognition/process")
async def process(request: Request, files: list[UploadFile] = File(default=None), x_api_key: str | None = Header(default=None),
                  x_ocr_engines: str | None = Header(default=None), x_ocr_fallback: str | None = Header(default=None)):
    """ผลิตจริง: JPEG 1 ภาพ (body ดิบ) หรือหลายภาพ (multipart 'files' ≤ 6) → Tesseract ก่อน, AI เมื่อไม่ผ่านและอนุญาต"""
    _auth(x_api_key)
    engines = _engines(x_ocr_engines)
    if not engines:
        raise HTTPException(409, "recognition_disabled")
    imgs = await _images(request, files)
    rid = request.headers.get("x-request-id") or uuid.uuid4().hex[:12]
    try:
        out = await run_in_threadpool(_guarded, recognition_service.process, imgs, engines, x_ocr_fallback != "0")
    except HTTPException:
        raise
    except Exception:
        _stats["errors"] += 1
        log.exception("recognition failed rid=%s", rid)
        raise HTTPException(500, "recognition_failed")
    _stats["ok"] += 1
    out["request_id"] = rid
    log.info("rid=%s status=%s engines=%s ms=%s", rid, out.get("status"), out.get("engines_used"), out.get("ms"))
    return out

@app.post("/api/v1/ocr/test")
async def test(request: Request, mode: str = "compare", files: list[UploadFile] = File(default=None), x_api_key: str | None = Header(default=None)):
    """โหมดทดสอบ (ไม่เขียนฐานข้อมูล) — mode: tesseract | ai | compare (รันแยกกัน ไม่เขียนทับกัน) | fallback (Tesseract→AI ตามจริง)"""
    _auth(x_api_key)
    if mode not in ("tesseract", "ai", "compare", "fallback"):
        raise HTTPException(400, "mode must be tesseract|ai|compare|fallback")
    imgs = await _images(request, files)

    def run():
        if mode in ("tesseract", "ai"):
            r = recognition_service.run_engine(mode, imgs)
            return {"mode": mode, "results": {mode: r}, "final": None}
        if mode == "compare":
            res = {n: recognition_service.run_engine(n, imgs) for n in ("tesseract", "ai")}
            a, b = res["tesseract"].get("plate_norm"), res["ai"].get("plate_norm")
            return {"mode": mode, "results": res, "final": None, "match": (a == b) if a and b else None}
        out = recognition_service.process(imgs, ("tesseract", "ai"), True)
        return {"mode": mode, "results": out.pop("engines"), "final": out}

    try:
        return {"test": True, **(await run_in_threadpool(_guarded, run))}
    except HTTPException:
        raise
    except Exception:
        log.exception("test failed")
        raise HTTPException(500, "test_failed")

@app.post("/api/v1/camera/upload")
async def upload(request: Request, x_api_key: str | None = Header(default=None), x_ocr_engines: str | None = Header(default=None),
                 x_ocr_fallback: str | None = Header(default=None)):
    """ชื่อตามพรอมต์: กล้อง/เกตเวย์ส่ง JPEG ดิบ (ทำงานเหมือน /recognition/process แบบภาพเดียว)"""
    return await process(request, None, x_api_key, x_ocr_engines, x_ocr_fallback)

@app.get("/health")
def health_short():
    return health()

@app.post("/recognize")
async def recognize(request: Request, file: UploadFile | None = File(default=None), device_id: str | None = None,
                    x_api_key: str | None = Header(default=None), x_ocr_engines: str | None = Header(default=None),
                    x_ocr_fallback: str | None = Header(default=None)):
    """รูปแบบตามสเปก AI Worker: รับไฟล์ภาพ (multipart 'file' หรือ body ดิบ) + device_id/x-request-id (ไม่บังคับ) → JSON สรุป
    ผลของ Tesseract และ AI แยกกันอยู่ใน 'engines' · ไม่เดาตัวอักษร · ไม่ผ่านเกณฑ์ = NEEDS_REVIEW"""
    _auth(x_api_key)
    engines = _engines(x_ocr_engines)
    if not engines:
        raise HTTPException(409, "recognition_disabled")
    imgs = await _images(request, [file] if file else None)
    rid = request.headers.get("x-request-id") or uuid.uuid4().hex[:12]
    try:
        out = await run_in_threadpool(_guarded, recognition_service.process, imgs, engines, x_ocr_fallback != "0")
    except HTTPException:
        raise
    except Exception:
        _stats["errors"] += 1
        log.exception("recognize failed rid=%s", rid)
        raise HTTPException(500, "recognition_failed")
    _stats["ok"] += 1
    warns = []
    for name, r in (out.get("engines") or {}).items():
        if r.get("status") in ("ERROR", "UNAVAILABLE", "NOT_CONFIGURED"):
            warns.append(f"{name}: {r.get('status')}")
    if out.get("conflict"):
        warns.append("engines_disagree")
    if out.get("status") == "NEEDS_REVIEW":
        warns.append("needs_human_review")
    warns.append("province_not_extracted")
    return {
        "success": out.get("status") != "FAILED", "request_id": rid, "device_id": device_id,
        "status": out.get("status"), "plate_text": out.get("plate"), "province": None,
        "engine": out.get("decided_by"), "confidence": out.get("confidence"),
        "processing_time_ms": out.get("ms"), "review_required": bool(out.get("needs_review")),
        "warnings": warns, "raw_text": out.get("raw", []),
        "engines": {k: {"status": v.get("status"), "plate": v.get("plate"), "confidence": v.get("confidence"),
                        "ms": v.get("ms"), "rss_mb": v.get("rss_mb"), "error": v.get("error")} for k, v in (out.get("engines") or {}).items()},
    }
