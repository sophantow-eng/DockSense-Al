"""ทดสอบ worker ที่รันอยู่ (ใช้เฉพาะ stdlib): python tests\\smoke_worker.py <ไฟล์ภาพ> — ภาพสังเคราะห์ = ผลทดสอบสังเคราะห์เท่านั้น"""
import json, os, sys, time, urllib.request, urllib.error
BASE = os.environ.get("WORKER_URL", "http://127.0.0.1:8000")
KEY = os.environ.get("BACKEND_KEY", "")
if not KEY and os.path.exists(".worker.env"):
    for line in open(".worker.env", encoding="ascii"):
        if line.startswith("BACKEND_KEY="):
            KEY = line.split("=", 1)[1].strip()
path = sys.argv[1] if len(sys.argv) > 1 else "../tests/synthetic_plate.png"
img = open(path, "rb").read()

def call(method, url, data=None, key=KEY, ctype="image/jpeg"):
    h = {"Content-Type": ctype}
    if key:
        h["x-api-key"] = key
    t = time.time()
    try:
        r = urllib.request.urlopen(urllib.request.Request(BASE + url, data=data, method=method, headers=h), timeout=120)
        return r.status, json.loads(r.read()), int((time.time() - t) * 1000)
    except urllib.error.HTTPError as e:
        return e.code, e.read()[:120].decode("utf-8", "replace"), int((time.time() - t) * 1000)

out = []
def ok(name, cond, extra=""):
    out.append("%-34s %s %s" % (name, "PASS" if cond else "FAIL", extra))

s, j, ms = call("GET", "/health", key="")
ok("1 health", s == 200 and j.get("ok"), "tesseract=%s ai=%s" % (j.get("tesseract"), j.get("ai")) if s == 200 else str(s))
s, j, ms = call("POST", "/recognize", img, key="wrong")
ok("2 wrong key rejected (401)", s == 401, str(s))
s, j, ms = call("POST", "/recognize", b"not an image" * 400)
ok("3 invalid image rejected (415)", s == 415, str(s))
s, j, ms = call("POST", "/recognize", img, ctype="image/png")
ok("4 real upload", s == 200 and isinstance(j, dict), "status=%s plate=%s conf=%s ms=%s" % (j.get("status"), j.get("plate_text"), j.get("confidence"), ms) if s == 200 else str(s))
if s == 200:
    for k, v in j.get("engines", {}).items():
        out.append("   engine %-10s status=%s plate=%s conf=%s ms=%s rss=%s" % (k, v["status"], v["plate"], v["confidence"], v["ms"], v["rss_mb"]))
    out.append("   review_required=%s warnings=%s" % (j.get("review_required"), j.get("warnings")))
times = []
for i in range(5):
    s, j, ms = call("POST", "/recognize", img, ctype="image/png")
    times.append(ms if s == 200 else -1)
ok("5 repeated x5 (ms)", all(t > 0 for t in times), str(times))
res = "\n".join(out)
open("smoke_result.txt", "w", encoding="utf-8").write(res + "\n")
try:
    print(res)
except UnicodeEncodeError:
    print("(see smoke_result.txt)")
