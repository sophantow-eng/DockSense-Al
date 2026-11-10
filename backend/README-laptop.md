# DockSense AI Worker บนแล็ปท็อป Windows

ตัวนี้คือโปรแกรมเดียวกับ backend บนคลาวด์ แต่รันบนเครื่องคุณ มีเครื่องยนต์สองตัวแยกกัน
- **Tesseract** (เร็ว เบา) — อ่านก่อน
- **AI = EasyOCR** (ช้ากว่า แต่อ่านทั้งแผ่นป้ายได้ดีกว่า) — ใช้เมื่อ Tesseract ไม่ผ่านเกณฑ์

ถ้าปิดแล็ปท็อป ระบบบนคลาวด์ยังทำงานต่อ (จะข้ามไปใช้ Gemini / รอตรวจสอบ) ไม่ค้าง

## ติดตั้ง (ครั้งเดียว) — ใน PowerShell ที่เปิด venv-easyocr แล้ว
```powershell
cd C:\DockSenseAI-Worker\backend
python -m pip install -r requirements-laptop.txt
```
(torch, easyocr, opencv-headless, numpy, psutil ลงไว้แล้ว ไม่ต้องลงซ้ำ)

## เริ่ม / หยุด
```powershell
powershell -ExecutionPolicy Bypass -File windows\start-worker.ps1
```
หยุดด้วย Ctrl+C · ครั้งแรกสคริปต์สร้างรหัสสุ่มไว้ในไฟล์ `.worker.env` (ห้ามส่งให้ใคร ห้ามอัปขึ้น GitHub)

## ทดสอบ (เปิด PowerShell หน้าต่างที่สอง ขณะ worker รันอยู่)
```powershell
cd C:\DockSenseAI-Worker\backend
.\..\venv-easyocr\Scripts\Activate.ps1
python tests\smoke_worker.py ..\tests\synthetic_plate.png
```
ผลเขียนลง `smoke_result.txt` · ภาพสังเคราะห์ = ผลทดสอบสังเคราะห์ ไม่ใช่ความแม่นยำจริง

## API
- `GET /health` — ไม่ต้องใช้รหัส บอกสถานะเครื่องยนต์
- `POST /recognize` — header `x-api-key` · ส่งไฟล์ภาพ (multipart ช่อง `file` หรือ body ดิบ JPEG/PNG) · `?device_id=` ไม่บังคับ
  คืน `status` (VERIFIED / NEEDS_REVIEW / REJECTED / FAILED), `plate_text`, `confidence`, `processing_time_ms`, `review_required`, `warnings` และผลแยกของแต่ละเครื่องยนต์ใน `engines`
  - ไม่เดาตัวอักษร ไม่ผ่านเกณฑ์ = NEEDS_REVIEW · `province` ยังเป็น null (ยังไม่ได้ทำการแยกอ่านจังหวัด)
- เอกสารอัตโนมัติ: http://127.0.0.1:8000/docs

## แก้ปัญหา
- `tesseract is not installed` → เพิ่ม `C:\Program Files\Tesseract-OCR` ใน PATH (สคริปต์เพิ่มให้เฉพาะหน้าต่างนั้นแล้ว)
- ขึ้น `AI: NOT_CONFIGURED` → ตัวแปร AI_LOCAL ต้องเป็น 1 (สคริปต์ตั้งให้) และ easyocr ต้องอยู่ใน venv ที่รันอยู่
- ตอบช้าครั้งแรก → EasyOCR โหลดโมเดลตอนมีคำขอแรก (ครั้งต่อไปเร็วขึ้น)
