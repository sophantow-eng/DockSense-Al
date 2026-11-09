import hmac
import logging
from fastapi import FastAPI, File, Header, HTTPException, Request, UploadFile
import time
from collections import defaultdict, deque
from . import config, ocr_service, recognition_service, known_plates

log = logging.getLogger("docksense")
app = FastAPI(title="DockSense OCR Backend", version="1.0.0")

_hits: dict[str, deque] = defaultdict(deque)

def _rate(key: str):
    """จำกัดคำขอต่อนาที (กันลูปบนกล้อง/ถูกยิงถี่) · ใน memory ต่อ 1 instance"""
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
        if len(b) < 2000 or b[:2] != b"\xff\xd8":
            raise HTTPException(415, "JPEG only")
    return out

@app.get("/api/v1/health")
def health():
    """ไม่ต้องใช้รหัส · บอกว่าบริการอยู่ และ OCR พร้อมหรือไม่ (ไม่เปิดเผยค่า secret)"""
    import cv2
    return {"ok": True, "opencv": cv2.__version__, "ocr_available": ocr_service.available(),
            "key_configured": bool(config.BACKEND_KEY), "known_plates": known_plates.status()}

@app.post("/api/v1/recognition/process")
async def process(request: Request, files: list[UploadFile] = File(default=None), x_api_key: str | None = Header(default=None)):
    """รับ JPEG 1 ภาพ (body ดิบ) หรือหลายภาพ (multipart field 'files' สูงสุด 6) → ผลอ่านทะเบียน"""
    _auth(x_api_key)
    if not ocr_service.available():
        raise HTTPException(503, "engine_unavailable")
    imgs = await _images(request, files)
    try:
        return recognition_service.process(imgs)
    except Exception:
        log.exception("recognition failed")
        raise HTTPException(500, "recognition_failed")

@app.post("/api/v1/camera/upload")
async def upload(request: Request, x_api_key: str | None = Header(default=None)):
    """ชื่อเดียวกับพรอมต์: ESP32-CAM/เกตเวย์ส่ง JPEG ดิบมาที่นี่ได้ (ทำงานเหมือน /recognition/process แบบภาพเดียว)"""
    return await process(request, None, x_api_key)
