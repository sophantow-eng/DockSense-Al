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

# Tesseract (ตัวหลัก)
TESS_LANG = os.environ.get("TESS_LANG", "tha")
TESS_TIMEOUT = int(_f("TESS_TIMEOUT", 15))
TESS_BUDGET = _f("TESS_BUDGET", 9)               # งบเวลาอ่านต่อภาพ (วินาที) หมดแล้วใช้ผลที่ได้ ไม่ปล่อยให้หมดเวลาทั้งงาน
OCR_CONCURRENCY = int(_f("OCR_CONCURRENCY", 1))   # งาน OCR พร้อมกัน (Render ฟรี CPU น้อย → 1)
OCR_QUEUE_WAIT = _f("OCR_QUEUE_WAIT", 6)          # รอคิวสูงสุดกี่วินาที เกินแล้วตอบ busy (ไม่สะสมคิวไม่จำกัด)
# AI (ตัวสำรอง)
AI_WORKER_URL = os.environ.get("AI_WORKER_URL", "")
AI_WORKER_KEY = os.environ.get("AI_WORKER_KEY", "")
AI_LOCAL = os.environ.get("AI_LOCAL", "") == "1"
AI_TIMEOUT = _f("AI_TIMEOUT", 20)
READ_BUDGET = _f("READ_BUDGET", 9)   # วินาทีสูงสุดที่ใช้ลองแบบภาพต่อ 1 ภาพ (หลังมีผลอย่างน้อย 1 ค่า)
