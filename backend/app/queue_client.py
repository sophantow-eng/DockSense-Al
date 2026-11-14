"""คอมแรง (laptop): ไปดึงงานอ่านทะเบียนจากคิวเอง (long-poll) แล้วส่งผลกลับ — ไม่ต้องมีลิงก์/อุโมงค์เข้าคอมเลย
เปิดใช้เมื่อมี QUEUE_URL + QUEUE_KEY (ไฟล์ queue.env) · ล้มเหลว = รอ 5 วินาทีแล้วลองใหม่ ไม่ทำให้ worker ล่ม"""
import base64
import json
import logging
import threading
import time
import urllib.request
from . import config

log = logging.getLogger("queue")

def _post(body: dict, timeout: float) -> dict:
    req = urllib.request.Request(config.QUEUE_URL, data=json.dumps(body).encode(), method="POST",
                                 headers={"x-queue-key": config.QUEUE_KEY, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())

def step(runner) -> bool:
    """ดึง 1 งาน (รอได้ ~20 วินาที) · คืน True ถ้าได้งานและส่งผลแล้ว"""
    r = _post({"action": "claim"}, 45)
    job = r.get("job")
    if not job:
        return False
    try:
        out = runner(base64.b64decode(job["image_b64"]))
        res = json.loads(json.dumps(out, default=str))
    except Exception as e:  # noqa: BLE001 — อ่านไม่สำเร็จ: ส่งสถานะ ERROR กลับ (ฝั่งเซิร์ฟเวอร์ถือว่าเครื่องนี้ไม่ได้ผล)
        log.warning("job %s failed: %s", job.get("id"), e)
        res = {"found": False, "status": "ERROR", "plate": None, "error": f"{type(e).__name__}: {str(e)[:160]}"}
    _post({"action": "complete", "id": job["id"], "result": res}, 20)
    return True

def loop(runner, stop: threading.Event):
    log.info("queue worker started")
    while not stop.is_set():
        try:
            step(runner)
        except Exception as e:  # noqa: BLE001
            log.warning("queue error: %s", e)
            stop.wait(5)

def start(runner) -> threading.Event | None:
    if not (config.QUEUE_URL and config.QUEUE_KEY):
        return None
    stop = threading.Event()
    threading.Thread(target=loop, args=(runner, stop), daemon=True, name="queue-worker").start()
    return stop
