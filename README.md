# DockSense AI (เว็บสแตติก + Supabase)

ไม่มี build step — โฟลเดอร์นี้คือ "Root" ที่ Vercel ต้องเสิร์ฟ (index.html ต้องอยู่ชั้นบนสุด)

## ไฟล์
index.html · scan.html · style.css · config.js · common.js · manifest.webmanifest · icon.svg · vercel.json
supabase/functions/ocr-plate/ (Edge Function)

## ขั้นตอน (ทำตามลำดับ)
1. (ทำแล้ว) ฐานข้อมูล, RLS, bucket และ config.js ตั้งค่าไว้แล้ว
2. Supabase secrets: ตั้ง ANTHROPIC_API_KEY (ต้องทำเอง)
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
- Supabase secrets: ANTHROPIC_API_KEY (จำเป็น), OCR_MODEL (ไม่บังคับ ค่าเริ่มต้น claude-sonnet-5-5), OCR_PROVIDER (ไม่บังคับ)
