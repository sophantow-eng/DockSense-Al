import os

def _f(name, default):
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return float(default)

BACKEND_KEY = os.environ.get("BACKEND_KEY", "")
OCR_LANGS = [x.strip() for x in os.environ.get("OCR_LANGS", "th,en").split(",") if x.strip()]
MAX_IMAGE_BYTES = int(_f("MAX_IMAGE_BYTES", 3_000_000))
HIGH_CONF = _f("HIGH_CONF", 0.85)
LOW_CONF = _f("LOW_CONF", 0.50)

# จำทะเบียนเก่า (ไม่ตั้ง = ปิด)
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
KNOWN_TTL = _f("KNOWN_TTL", 60)
KNOWN_CONF = _f("KNOWN_CONF", 0.70)      # ทะเบียนตรงกับรถที่ลงทะเบียนไว้เป๊ะ + มั่นใจถึงค่านี้ = ผ่านเลย (ต้องปรับจากข้อมูลจริง)
KNOWN_EARLY = _f("KNOWN_EARLY", 0.80)    # ภาพแรกอ่านตรงรถเก่าและมั่นใจถึงค่านี้ = ไม่ต้องลองปรับภาพแบบอื่น (เร็วขึ้น)
RATE_PER_MIN = int(_f("RATE_PER_MIN", 60))
