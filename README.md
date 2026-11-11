# DockSense AI

ระบบจดทะเบียนรถเข้า-ออก: ถ่ายรูป/กล้อง ESP32 → AI อ่านป้าย → บันทึก → แจ้ง Telegram
เว็บเป็นไฟล์สแตติก (ไม่มี build) + Supabase + Vercel · ติดตั้งเป็นแอปบนมือถือได้ (PWA)
เว็บจริง: https://docksense-al.vercel.app

## แผนผังโฟลเดอร์
```
index.html, scan.html     หน้าเว็บ (ต้องอยู่ชั้นบนสุด — Vercel เสิร์ฟจากราก ไม่มี build)
style.css, common.js      สไตล์ + ฟังก์ชันร่วม (common.js ลงทะเบียน sw.js)
camlive.js, config.js     ดูกล้องสด / ค่า Supabase (anon key)
sw.js, manifest.webmanifest, icon*.png|svg   PWA (เปิดเร็วแบบแอป)
vercel.json               header/แคช (sw.js ไม่แคช, ไอคอนแคช 7 วัน)
esp32/                    โค้ดบอร์ด + WIRING.md (วิธีต่อสาย)
supabase/functions/       Edge Functions (โค้ดต้นฉบับ)
  ocr-plate/              AI อ่านป้าย (Gemini อ่าน 1 รอบ; OCR_DOUBLE=1 = 2 รอบ)
  camera-ingest/          รับรูปจาก ESP32/มือถือ → กรอง → OCR → บันทึก
  notify-visit/           ส่งแจ้งเตือน Telegram (แยกตามบริษัท)
  telegram-bot/           บอทตอบคำถาม (ประวัติ/รถบริษัท/สรุป/รูป/สี-ยี่ห้อ-รุ่น)
supabase/migrations/      SQL ที่ใช้สร้างตาราง/คอลัมน์ (เรียงตามชื่อไฟล์)
```
หมายเหตุ: ฟังก์ชัน `device-ingest` บน Supabase เป็นของเก่า ไม่ได้ใช้และไม่อยู่ใน repo

## Deploy
- เว็บ: push เข้า `main` → Vercel deploy เอง (Framework = Other, ไม่ต้องมี Build/Output)
- ฟังก์ชัน: `supabase functions deploy <ชื่อ>` (camera-ingest และ telegram-bot ใช้ `--no-verify-jwt`; ocr-plate/notify-visit ตามค่าเดิมที่ตั้งไว้)
- แก้ไฟล์เว็บแล้วอยากให้แอปมือถือรีเฟรชแน่นอน: เพิ่มเลขเวอร์ชัน `V` ใน sw.js

## Secrets (Supabase → Edge Functions → Secrets)
GEMINI_API_KEY (ตัวหลัก) และ/หรือ ANTHROPIC_API_KEY (สำรอง) · TELEGRAM_BOT_TOKEN
ไม่บังคับ: GEMINI_MODEL, OCR_MODEL, OCR_PROVIDER, OCR_DOUBLE=1
ห้ามใส่ token/คีย์ลงใน repo หรือแชร์ในกลุ่ม

## ตั้งค่าครั้งแรก
1. Supabase → Authentication → URL Configuration: Site URL = https://docksense-al.vercel.app
2. เปิดเว็บ → สมัครสมาชิก (คนแรก = admin) → ตั้งค่า → ทดสอบการเชื่อมต่อ

## Telegram
1. สร้างบอทกับ @BotFather → ตั้ง secret `TELEGRAM_BOT_TOKEN`
2. เพิ่มบอทเข้ากลุ่ม → เว็บ: ตั้งค่า → แจ้งเตือน Telegram → ค้นหา Chat ID → เลือก → บันทึก
   (กลุ่มลูกค้า: เลือกบริษัท — กลุ่มนั้นเห็นเฉพาะรถบริษัทตัวเอง)
3. เปิดบอทตอบคำถาม (ครั้งเดียว): เปิด `https://dhqvdbdqhcbymqvhpqop.supabase.co/functions/v1/telegram-bot?setup=1`
   (`?status=1` ตรวจสถานะ, `?remove=1` ปิด)

## ระบบกล้อง: เร็วและประหยัดโควตา AI
ลำดับกรองใน camera-ingest (ผ่านด่านไหนไม่ถึง AI = ไม่เสียโควตา):
ภาพสด/พรีวิวไม่ใช้ AI → ไฟล์เล็ก <9 KB (เฟรมมืด/เลนส์บัง) → ภาพซ้ำเดิมภายใน 2 นาที → คูลดาวน์ 30 วินาที/กล้อง → AI อ่าน 1 รอบ
เสริม: ESP32 ถ่ายเมื่อเซ็นเซอร์ตรวจพบรถเท่านั้น, ลดรูปเหลือ 1280px, อัปโหลดรูปขนานกับการอ่าน, แจ้ง Telegram เบื้องหลัง, AI ล้มแล้วเก็บเข้า "รอตรวจสอบ"

## TypeScript (ตัวคุมภาระกล้องสด)
ซอร์สอยู่ที่ `src/*.ts` คอมไพล์เป็น JS ที่เว็บใช้จริงด้วย `npm run build` (หรือ `tsc -p .`) — ไฟล์ `.js` ที่คอมไพล์แล้วถูก commit ไว้ด้วย Vercel จึงไม่ต้องมีขั้นตอน build
`src/live-governor.ts` → `live-governor.js`: ลดความถี่/ขนาดภาพของกล้องสดและตัวตรวจป้ายอัตโนมัติเมื่อเครื่องร้อนหรือช้า แล้วค่อยๆ กลับเมื่อเย็นลง
