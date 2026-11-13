"""วัดความแม่นยำจริงจากภาพป้ายที่คุณรู้ทะเบียน — รันบนคอม (ต้องเปิด worker ค้างไว้)
วิธีตั้งชื่อไฟล์: ชื่อไฟล์ = ทะเบียนที่ถูกต้อง เช่น  1ฝง5738.jpg  หรือ  ฆว1053 (2).jpg  (วงเล็บ/ขีด/ช่องว่างท้ายชื่อไม่นับ)
รัน:  python benchmark.py "C:\\Users\\user\\Downloads\\plates"
ไม่แก้ฐานข้อมูล ไม่ส่งอะไรออกอินเทอร์เน็ต (คุยกับ worker ในเครื่องเท่านั้น)"""
import csv, json, os, re, sys, time, urllib.request
from collections import Counter

URL = os.environ.get("WORKER_URL", "http://127.0.0.1:8000")
ENV = os.environ.get("WORKER_ENV", r"C:\DockSenseAI-Worker\backend\.worker.env")
ENGINES = os.environ.get("ENGINES", "ai").split(",")   # ai = EasyOCR · เพิ่ม tesseract ได้: set ENGINES=ai,tesseract
KEEP = re.compile(r"[^ก-ฮ0-9]")

def key():
    k = os.environ.get("BACKEND_KEY")
    if k:
        return k
    for line in open(ENV, encoding="utf-8-sig"):
        if "=" in line and line.split("=", 1)[0].strip() == "BACKEND_KEY":
            return line.split("=", 1)[1].strip().strip('"')
    sys.exit("หา BACKEND_KEY ไม่เจอใน " + ENV)

def truth_of(fn):
    stem = os.path.splitext(fn)[0]
    stem = re.split(r"[ (_]", stem)[0]
    return KEEP.sub("", stem)

def read(path, eng, k):
    req = urllib.request.Request(URL + "/api/v1/recognition/process", data=open(path, "rb").read(), method="POST",
                                 headers={"x-api-key": k, "Content-Type": "image/jpeg", "x-ocr-engines": eng, "x-ocr-fallback": "0"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            j = json.loads(r.read())
        return KEEP.sub("", j.get("plate") or ""), j.get("status"), float(j.get("confidence") or 0), int((time.time() - t0) * 1000)
    except Exception as e:  # noqa: BLE001
        return "", "ERROR:" + type(e).__name__, 0.0, int((time.time() - t0) * 1000)

def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    sys.stdout.reconfigure(encoding="utf-8")
    folder, k = sys.argv[1], key()
    files = sorted(f for f in os.listdir(folder) if f.lower().endswith((".jpg", ".jpeg")))
    rows, conf = [], Counter()
    stats = {e: dict(n=0, exact=0, digits=0, letters=0, verified=0, verified_wrong=0, review=0, none=0, ms=[]) for e in ENGINES}
    for fn in files:
        t = truth_of(fn)
        if len(t) < 4:
            print("ข้าม (ชื่อไฟล์ไม่ใช่ทะเบียน):", fn); continue
        for e in ENGINES:
            p, st, c, ms = read(os.path.join(folder, fn), e, k)
            s = stats[e]; s["n"] += 1; s["ms"].append(ms)
            ok = p == t
            s["exact"] += ok
            td, pd = re.sub(r"\D", "", t), re.sub(r"\D", "", p); tl, pl = re.sub(r"\d", "", t), re.sub(r"\d", "", p)
            s["digits"] += td == pd; s["letters"] += tl == pl
            if not p: s["none"] += 1
            elif st == "VERIFIED":
                s["verified"] += 1; s["verified_wrong"] += (not ok)
            else: s["review"] += 1
            if p and not ok and len(p) == len(t):
                for a, b in zip(t, p):
                    if a != b: conf[(a, b)] += 1
            rows.append([fn, t, e, p, "ถูก" if ok else "ผิด", st, f"{c:.2f}", ms])
            print(f"{'✓' if ok else '✗'} {fn[:28]:28} จริง={t:10} {e:9} อ่านได้={p or '-':10} {st} {ms}ms")
    out = os.path.join(folder, "ผลทดสอบ.csv")
    with open(out, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f); w.writerow(["ไฟล์", "ทะเบียนจริง", "เครื่องยนต์", "อ่านได้", "ผล", "สถานะ", "ความมั่นใจ", "ms"]); w.writerows(rows)
    print("\n===== สรุป (จำนวนภาพน้อย = ยังไม่ใช่ตัวเลขที่เชื่อถือได้) =====")
    for e, s in stats.items():
        n = s["n"] or 1
        avg = sum(s["ms"]) // max(len(s["ms"]), 1)
        print(f"[{e}] ภาพ {s['n']}: ถูกทั้งป้าย {s['exact']}/{s['n']} ({100*s['exact']//n}%) · เลขถูก {s['digits']} · ตัวอักษรถูก {s['letters']}"
              f" · ผ่านอัตโนมัติ {s['verified']} (ในนั้น 'ผิดแต่มั่นใจ' {s['verified_wrong']}) · ส่งตรวจ {s['review']} · อ่านไม่ได้ {s['none']} · เฉลี่ย {avg} ms")
    if conf:
        print("\nตัวอักษรที่สับสนบ่อย (จริง→อ่านได้ : ครั้ง):")
        for (a, b), c in conf.most_common(15): print(f"  {a}→{b} : {c}")
    print("\nบันทึกตารางละเอียดที่:", out)

main()
