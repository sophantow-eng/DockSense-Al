"""ENGINE 2 — AI (ตัวสำรอง) เปลี่ยนตัวได้โดยไม่แก้ส่วนอื่น
 - AI_WORKER_URL + AI_WORKER_KEY : ส่งภาพไปคอมเครื่องแรง (โปรแกรมนี้เองรันบนแล็ปท็อปด้วย AI_LOCAL=1) ผ่าน HTTPS
 - AI_LOCAL=1 และลง easyocr แล้ว        : อ่านในเครื่องนี้ (ใช้บนแล็ปท็อป/ทดสอบ)
 - ไม่ตั้งอะไรเลย                       : NOT_CONFIGURED — ห้ามจำลองว่าอ่านได้"""
import base64
import json
import time
import urllib.request
from . import config, ocr_service

def status() -> dict:
    if config.AI_QUEUE_URL and config.AI_QUEUE_KEY:
        return {"state": "READY", "kind": "queue", "note": "ส่งงานผ่านคิว (คอมแรงไปดึงเอง ไม่ต้องมีลิงก์) — ถ้าคอมปิดจะข้ามทันที"}
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

def _post(url: str, key: str, body: dict, timeout: float) -> dict:
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"x-queue-key": key, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())

def read_queue(jpeg: bytes) -> dict:
    """ส่งภาพเข้าคิว แล้วรอคอมแรง (EasyOCR) ดึงไปอ่านและส่งผลกลับ · คอมปิด/ไม่ตอบ = โยน Exception ทันที (ผู้เรียกถอยไปใช้ตัวอื่น)"""
    url, key = config.AI_QUEUE_URL, config.AI_QUEUE_KEY
    t0 = time.time()
    j = _post(url, key, {"action": "enqueue", "image_b64": base64.b64encode(jpeg).decode()}, 15)
    if j.get("offline"):
        raise RuntimeError("worker_offline (คอมแรงไม่ได้เปิด/ไม่ได้ต่อเน็ต)")
    jid = j["id"]
    while time.time() - t0 < config.AI_TIMEOUT:
        time.sleep(0.7)
        r = _post(url, key, {"action": "result", "id": jid}, 15)
        if r.get("status") == "done":
            return r["result"]
    try:
        _post(url, key, {"action": "cancel", "id": jid}, 5)
    except Exception:  # noqa: BLE001
        pass
    raise TimeoutError("worker did not answer in time")
