"""ทะเบียนไทย: ทำความสะอาดข้อความ + ตรวจรูปแบบ (ไม่เดา/ไม่แทนที่ตัวอักษรเอง)"""
import re

THAI_CONS = "กขฃคฅฆงจฉชซฌญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรลวศษสหฬอฮ"
_KEEP = re.compile(rf"[^0-9{THAI_CONS}]")
# รถทั่วไป: [เลขนำ 0-9]? + พยัญชนะ 1-2 ตัว + เลข 1-4 หลัก  (เช่น กข1234, 1กก1234)
# รูปแบบพิเศษ/ราชการ ไม่ตรงอาจเป็นป้ายจริง จึงให้ "ต้องตรวจสอบ" ไม่ใช่ "ปฏิเสธ"
_STD = re.compile(rf"^[0-9]?[{THAI_CONS}]{{1,2}}[0-9]{{1,4}}$")

def clean(text: str) -> str:
    """เก็บเฉพาะเลขอารบิกกับพยัญชนะไทย (วรรณยุกต์/ช่องว่าง/ขีด หลุด OCR ทิ้ง)"""
    return _KEEP.sub("", (text or "").replace("๐", "0"))

def is_standard(norm: str) -> bool:
    return bool(_STD.match(norm))

def display(norm: str) -> str:
    """แสดงแบบมีช่องว่าง: 1กก 1234"""
    m = re.match(rf"^([0-9]?[{THAI_CONS}]{{1,2}})([0-9]{{1,4}})$", norm)
    return f"{m.group(1)} {m.group(2)}" if m else norm

def char_similarity(a: str, b: str) -> float:
    """อัตราตัวอักษรตรงกัน (Levenshtein) 0..1 — ใช้รวมผลหลายเฟรมที่ต่างกันนิดเดียว"""
    if not a and not b:
        return 1.0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return 1 - prev[-1] / max(len(a), len(b))

_FIND = re.compile(rf"[0-9]?[{THAI_CONS}]{{1,2}}[0-9]{{1,4}}")

def extract_standard(text: str) -> tuple[str, float]:
    """ตัดตัวอักษรขยะหัว/ท้าย (เส้นขอบป้าย ชิ้นส่วนบรรทัดจังหวัด) ออก เหลือส่วนที่เป็นรูปทะเบียนที่ยาวที่สุด
    ไม่แก้/เปลี่ยนตัวอักษรใดเลย · คืน (ข้อความ, สัดส่วนที่เก็บไว้ 0..1) — ตัดมากเท่าไรความมั่นใจยิ่งถูกลดตามสัดส่วน
    ไม่พบรูปทะเบียน = คืนข้อความเดิม สัดส่วน 1.0 (ปล่อยให้ผู้เรียกตัดสินว่าไม่ใช่รูปมาตรฐาน)"""
    t = clean(text)
    if not t or is_standard(t):
        return t, 1.0
    best = ""
    for st in range(len(t)):
        m = _FIND.match(t, st)
        if m and len(m.group(0)) > len(best):
            best = m.group(0)
    return (best, len(best) / len(t)) if best else (t, 1.0)
