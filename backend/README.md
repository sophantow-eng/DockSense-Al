# DockSense OCR Backend (Python)

FastAPI + OpenCV + EasyOCR (th+en) อ่านทะเบียนให้ระบบ ใช้ **เสริม** ไม่ใช่ตัวแทน:
`ESP32-CAM → camera-ingest (Supabase) → backend นี้ → ไม่ตอบ/ไม่มั่นใจ → ถอยไป Gemini (ocr-plate) เหมือนเดิม`

## ไหลงาน
ตรวจคุณภาพภาพ → หาป้าย (OpenCV, heuristic) → ปรับภาพ 3 แบบ → EasyOCR → ทำความสะอาดข้อความ → ตรวจรูปแบบทะเบียนไทย
→ โหวตหลายภาพ (ภาพซ้ำนับครั้งเดียว) → ตัดสินใจ `VERIFIED / NEEDS_REVIEW / REJECTED / FAILED`
- ไม่แก้ตัวอักษรเอง · ผลดิบ (`raw`) กับผลปรับแล้ว (`plate`) แยกกัน · รูปแบบพิเศษไม่ถูกปฏิเสธ (ไป NEEDS_REVIEW)
- **รถเก่า:** ถ้าตั้ง `SUPABASE_URL`+`SUPABASE_SERVICE_KEY` จะโหลดทะเบียนที่ลงไว้ (แคช 60 วิ) → อ่านตรงเป๊ะและมั่นใจ ≥ `KNOWN_CONF` ผ่านเลย และข้ามการลองปรับภาพแบบอื่น (เร็วขึ้น) · ต่างแค่ 1 ตัวอักษรเป็นแค่ `suggestion` ให้คนตรวจ

## Endpoint (ต้องมี header `x-api-key` = `BACKEND_KEY` ยกเว้น health)
| | |
|---|---|
| `GET /api/v1/health` | สถานะ, OpenCV, EasyOCR พร้อมไหม, จำนวนทะเบียนที่รู้จัก |
| `POST /api/v1/recognition/process` | body = JPEG ดิบ 1 ภาพ หรือ multipart `files` สูงสุด 6 ภาพ |
| `POST /api/v1/camera/upload` | เหมือนข้างบน (ภาพเดียว) ชื่อตามพรอมต์ |

ตอบ: `found, status, plate, plate_norm, confidence, needs_review, known_vehicle, suggestion, raw[], quality[], ms`

## รันบนเครื่อง / ทดสอบ
```
pip install -r requirements.txt
BACKEND_KEY=ตั้งเอง uvicorn app.main:app --port 7860
pytest            # 10 เทสต์ ไม่ต้องมี EasyOCR (เทสต์ตรรกะตัดสินใจ/ตรวจรูปแบบ/OpenCV)
```

## ติดตั้งให้ใช้งานจริง (ต้องมีที่รัน — Vercel รัน Python ค้างไม่ได้)
ใช้ `Dockerfile` ในโฟลเดอร์นี้ เช่น Hugging Face Spaces (Docker, ฟรี CPU) / Render / Fly.io / VPS
(ตัวฟรีมักหลับเมื่อไม่มีคนใช้ ตื่นช้า ระบบจึงตั้ง timeout 8 วิแล้วถอยไป Gemini อัตโนมัติ)
จากนั้นตั้ง secret ใน Supabase (Edge Functions → Secrets): `OCR_BACKEND_URL`, `OCR_BACKEND_KEY` (ค่าเดียวกับ `BACKEND_KEY`) ไม่ตั้ง = ใช้ Gemini ตามเดิม

## ข้อจำกัดที่ต้องรู้
- ยังไม่ได้วัดความแม่นยำกับภาพทะเบียนไทยจริง (เทสต์ในที่นี้ไม่ได้รัน EasyOCR) — ค่า `HIGH_CONF`/`KNOWN_CONF` เป็นค่าเริ่มต้นที่ต้องปรับจากภาพทดสอบที่มีเฉลย
- ตัวหาป้ายเป็น heuristic ไม่ใช่โมเดลตรวจจับเฉพาะ
