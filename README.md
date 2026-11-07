# DockSense AI (เว็บสแตติก + Supabase)

ไม่มี build step — โฟลเดอร์นี้คือ "Root" ที่ Vercel ต้องเสิร์ฟ (index.html ต้องอยู่ชั้นบนสุด)

## ไฟล์
index.html · scan.html · style.css · config.js · common.js · manifest.webmanifest · icon.svg · vercel.json
supabase/functions/ocr-plate/ (Edge Function)

## ขั้นตอน (ทำตามลำดับ)
1. (ทำแล้ว) ฐานข้อมูล, RLS, bucket และ config.js ตั้งค่าไว้แล้ว
2. Supabase secrets: ตั้ง GEMINI_API_KEY (ตัวหลัก) และ/หรือ ANTHROPIC_API_KEY (ตัวสำรอง) — ต้องมีอย่างน้อยหนึ่งตัว (ต้องทำเอง)
3. Supabase → Authentication → URL Configuration: Site URL = https://docksense-al.vercel.app
   (ทดสอบเร็ว: ปิด "Confirm email" ที่ Providers → Email)
4. Edge Function ocr-plate deploy แล้ว (ถ้าแก้โค้ดต้อง deploy ใหม่):
   supabase login
   supabase link --project-ref dhqvdbdqhcbymqvhpqop
   supabase functions deploy ocr-plate
   supabase secrets set ANTHROPIC_API_KEY=sk-ant-xxxx
   (ไม่ต้องใช้ --no-verify-jwt — ฟังก์ชันรับเฉพาะผู้ที่ล็อกอินแล้ว กันคนนอกใช้เครดิต API)
5. อัปโหลดทุกไฟล์ขึ้น GitHub (ให้ index.html อยู่ราก repo) → Vercel จะ deploy อัตโนมัติ
   Vercel → Project Settings → General: Framework Preset = Other, Root Directory = (ว่าง/โฟลเดอร์ที่มี index.html),
   Build Command และ Output Directory = ว่าง
6. เปิดเว็บ → สมัครสมาชิก (คนแรก = admin) → ตั้งค่า → "ทดสอบการเชื่อมต่อ"

## ตัวแปรสภาพแวดล้อม
- Vercel: ไม่ต้องตั้งค่า
- Supabase secrets: GEMINI_API_KEY และ/หรือ ANTHROPIC_API_KEY (ต้องมีอย่างน้อยหนึ่งตัว)
  - GEMINI_MODEL (ไม่บังคับ — ถ้าไม่ตั้ง ระบบหารุ่น Gemini flash ที่ใช้ได้เอง), OCR_MODEL (ไม่บังคับ ใช้กับ claude), OCR_PROVIDER (ไม่บังคับ: gemini | claude)
  - ลำดับใช้งาน: OCR_PROVIDER → gemini → claude (ตัวไหนล้มจะสลับไปตัวถัดไปที่ตั้ง key ไว้)
  - Gemini อ่านป้าย 2 รอบเทียบกัน ถ้าไม่ตรงกันหน้าสแกนจะเตือนและให้เลือก

## แจ้งเตือน Telegram (notify-visit)

1. สร้างบอทกับ @BotFather → ได้ Bot Token
2. ตั้ง secret `TELEGRAM_BOT_TOKEN` ใน Supabase (Edge Functions → Secrets)
3. เพิ่มบอทเข้ากลุ่ม แล้วพิมพ์ข้อความ 1 ข้อความ → เว็บ: ตั้งค่า → แจ้งเตือน Telegram → “ค้นหา Chat ID” → เลือกกลุ่ม → บันทึก → ทดสอบ
4. ตั้งค่า → บริษัท → แตะบริษัท → ติ๊ก “แจ้งเตือน Telegram”
