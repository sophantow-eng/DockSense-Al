"""ENGINE 2 — AI (ตัวสำรอง) เปลี่ยนตัวได้โดยไม่แก้ส่วนอื่น
 - AI_WORKER_URL + AI_WORKER_KEY : ส่งภาพไปคอมเครื่องแรง (โปรแกรมนี้เองรันบนแล็ปท็อปด้วย AI_LOCAL=1) ผ่าน HTTPS
 - AI_LOCAL=1 และลง easyocr แล้ว        : อ่านในเครื่องนี้ (ใช้บนแล็ปท็อป/ทดสอบ)
 - ไม่ตั้งอะไรเลย                       : NOT_CONFIGURED — ห้ามจำลองว่าอ่านได้"""
import json
import urllib.request
from . import config, ocr_service

def status() -> dict:
    if config.AI_WORKER_URL and config.AI_WORKER_KEY:
        return {"state": "READY", "kind": "worker", "note": "ส่งภาพไป worker ผ่าน HTTPS (ยังไม่ได้ตรวจการเชื่อมต่อจริงจนกว่าจะมีคำขอ)"}
    if config.AI_LOCAL and ocr_service.available():
        return {"state": "READY", "kind": "local-easyocr", "note": "อ่านด้วย EasyOCR ในเครื่องนี้"}
    why = "ยังไม่ได้ตั้ง AI_WORKER_URL/AI_WORKER_KEY" if not config.AI_LOCAL else "ตั้ง AI_LOCAL=1 แล้วแต่ยังไม่ได้ลง easyocr"
    return {"state": "NOT_CONFIGURED", "kind": None, "note": why}

def ready() -> bool:
    return status()["state"] == "READY"

def read_remote(jpeg: bytes) -> dict:
    """เรียก worker: ได้ผลรูปแบบเดียวกับ /recognition/process (engines=ai) — timeout/ล้มเหลวโยน Exception ให้ผู้เรียกจัดการ"""
    req = urllib.request.Request(config.AI_WORKER_URL.rstrip("/") + "/api/v1/recognition/process", data=jpeg, method="POST",
                                 headers={"x-api-key": config.AI_WORKER_KEY, "Content-Type": "image/jpeg", "x-ocr-engines": "ai"})
    with urllib.request.urlopen(req, timeout=config.AI_TIMEOUT) as r:
        return json.loads(r.read())
