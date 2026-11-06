# DockSense AI (เวอร์ชันเว็บสแตติก)

ไม่ต้อง build — เป็นไฟล์ HTML/JS ล้วน เปิดผ่าน GitHub Pages (HTTPS) แล้วใช้บนมือถือได้ทันที

| ไฟล์ | หน้าที่ |
|---|---|
| `index.html` | หน้าหลัก: ล็อกอิน, ภาพรวม/กราฟ, ประวัติ (กรอง/แก้ไข/ลบ/CSV), ค้นหา, ตั้งค่า/จัดการผู้ใช้ |
| `scan.html` | หน้าสแกนทะเบียน: กล้อง → ครอป → AI OCR → ตรวจ/แก้ไข → บันทึก |
| `common.js` `config.js` `style.css` | ส่วนที่ใช้ร่วมกัน (config.js ใส่ค่าโปรเจกต์ Supabase ไว้แล้ว) |
| `supabase/functions/ocr-plate/` | โค้ด OCR ฝั่งเซิร์ฟเวอร์ (เก็บ API Key ปลอดภัย) |

## 1) ขึ้น GitHub Pages (ทำจากมือถือได้)
1. สร้าง repo ใหม่บน GitHub (Public) แล้วอัปโหลดไฟล์ทั้งหมดในโฟลเดอร์นี้ (แตก zip ก่อน)
2. Settings → Pages → Source: **Deploy from a branch** → Branch: `main` / `(root)` → Save
3. รอ 1-2 นาที จะได้ลิงก์ `https://<ชื่อคุณ>.github.io/<ชื่อ repo>/`
4. เปิดบนมือถือ แล้ว Chrome → ⋮ → "ติดตั้งแอป"

## 2) ตั้งค่า Supabase ให้ล็อกอินได้
Supabase Dashboard → Authentication → URL Configuration → ใส่ลิงก์ GitHub Pages ใน **Site URL**
(ถ้าต้องการทดสอบเร็ว ปิด "Confirm email" ที่ Authentication → Providers → Email)

## 3) เปิดใช้ AI OCR (ต้องทำเอง)
```bash
npm i -g supabase && supabase login
supabase link --project-ref dhqvdbdqhcbymqvhpqop
supabase functions deploy ocr-plate
supabase secrets set ANTHROPIC_API_KEY=sk-ant-xxxxxxxx
```
แล้วกด "ทดสอบการเชื่อมต่อ" ในหน้า ตั้งค่า — ถ้ายังไม่ทำข้อนี้ สแกนแล้วกรอกเลขทะเบียนเองได้ แต่ AI จะยังไม่อ่านให้

## สิทธิ์
ผู้สมัครคนแรก = admin, คนถัดไป = viewer (admin ปรับได้ที่ ตั้งค่า → จัดการผู้ใช้) · admin ทำได้ทุกอย่าง, staff บันทึก/แก้ไข, viewer ดูอย่างเดียว (บังคับด้วย RLS ในฐานข้อมูล)

## หมายเหตุ
- `config.js` ใช้ publishable key ซึ่งออกแบบให้เปิดเผยได้ ข้อมูลถูกป้องกันด้วยการล็อกอิน + RLS
- ส่งออกเป็น CSV (เปิดด้วย Excel ได้ รองรับภาษาไทย)
