"""ทะเบียนที่ลงทะเบียนไว้แล้ว (ตาราง vehicles) — ใช้ 'จำทะเบียนเก่า' ให้ตัดสินใจไวขึ้น
ใช้ service key ได้เฉพาะที่นี่ (ฝั่งเซิร์ฟเวอร์) ห้ามใส่ในเว็บหรือเฟิร์มแวร์ · ไม่ตั้งค่า = ปิดฟีเจอร์นี้ ระบบยังทำงานปกติ"""
import json
import logging
import threading
import time
import urllib.request
from . import config, plate_utils as pu

log = logging.getLogger("docksense")
_lock = threading.Lock()
_cache = {"at": 0.0, "set": frozenset(), "ok": False}

def enabled() -> bool:
    return bool(config.SUPABASE_URL and config.SUPABASE_SERVICE_KEY)

def _fetch() -> frozenset:
    url = f"{config.SUPABASE_URL.rstrip('/')}/rest/v1/vehicles?select=plate_norm&limit=20000"
    req = urllib.request.Request(url, headers={"apikey": config.SUPABASE_SERVICE_KEY, "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}"})
    with urllib.request.urlopen(req, timeout=4) as r:
        rows = json.loads(r.read())
    return frozenset(pu.clean(str(x.get("plate_norm") or "")) for x in rows if x.get("plate_norm"))

def get() -> frozenset:
    """รายการทะเบียนที่รู้จัก (แคช KNOWN_TTL วินาที) · โหลดไม่ได้ → ใช้ชุดเก่า/ว่าง ไม่ทำให้อ่านทะเบียนล้ม"""
    if not enabled():
        return frozenset()
    with _lock:
        if time.time() - _cache["at"] > config.KNOWN_TTL:
            try:
                _cache.update(set=_fetch(), ok=True)
            except Exception as e:  # noqa: BLE001
                _cache["ok"] = False
                log.warning("known_plates fetch failed: %s", e)
            _cache["at"] = time.time()
        return _cache["set"]

def status() -> dict:
    return {"enabled": enabled(), "loaded": _cache["ok"], "count": len(_cache["set"])}

def nearest(norm: str, known=None):
    """คืน (ทะเบียนที่ตรง/ใกล้สุด, ตรงเป๊ะไหม) · ใกล้ = ต่างกัน 1 ตัวอักษร และมีคันเดียวเท่านั้น (กำกวมไม่เดา)"""
    known = get() if known is None else known
    if norm in known:
        return norm, True
    close = [k for k in known if len(k) == len(norm) and pu.char_similarity(k, norm) >= 1 - 1 / max(1, len(norm)) - 1e-9]
    return (close[0], False) if len(close) == 1 else (None, False)
