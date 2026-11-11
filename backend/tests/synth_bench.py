"""เบนช์มาร์กสังเคราะห์ (ไม่ใช่ป้ายจริง): เทียบวิธีอ่านของ Tesseract ภายใต้ภาพเสื่อมคุณภาพ — ใช้เทียบ "ก่อน/หลัง" เท่านั้น
ใช้ฟอนต์ Loma (ไม่ใช่ฟอนต์ป้ายจริง) จึงห้ามอ้างเป็นความแม่นยำจริง"""
import random, sys, cv2, numpy as np
from PIL import Image, ImageDraw, ImageFont
sys.path.insert(0, ".")
from app import plate_utils as pu, image_utils as iu, recognition_service as rs, tesseract_engine as te
FONT = "/usr/share/fonts/opentype/tlwg/Loma-Bold.otf"
PROV = ["กรุงเทพมหานคร", "เชียงใหม่", "ชลบุรี", "ขอนแก่น", "นครราชสีมา"]
CONS = "กขคงจชซดตทนบปพฟมยรลวสหอฮณฌ"

def make(seed, scale=1.0, blur=0.0, noise=0.0, tilt=0.0, bg="car", stack=False):
    r = random.Random(seed)
    plate = (r.choice(["", "", "1", "2", "3"]) + "".join(r.choice(CONS) for _ in range(r.choice([1, 2]))))
    num = str(r.randint(1, 9999))
    truth = plate + num
    W, H = (440, 220) if not stack else (300, 300)
    im = Image.new("RGB", (W, H), (246, 246, 240)); d = ImageDraw.Draw(im)
    d.rectangle([3, 3, W - 4, H - 4], outline=(30, 30, 30), width=4)
    t = f"{plate} {num}"
    if stack:   # ป้ายมอเตอร์ไซค์: อักษรบน · จังหวัดเล็ก · เลขล่างใหญ่
        fa = ImageFont.truetype(FONT, 78); fn = ImageFont.truetype(FONT, 110); fp = ImageFont.truetype(FONT, 30)
        w = d.textlength(plate, font=fa); d.text(((W - w) / 2, 8), plate, font=fa, fill=(20, 20, 25))
        p = r.choice(PROV); w = d.textlength(p, font=fp); d.text(((W - w) / 2, 100), p, font=fp, fill=(20, 20, 25))
        w = d.textlength(num, font=fn); d.text(((W - w) / 2, 150), num, font=fn, fill=(20, 20, 25))
        t = None
    fs = 104
    f1 = ImageFont.truetype(FONT, fs)
    while t and d.textlength(t, font=f1) > W - 50:   # ให้ข้อความพอดีป้าย (ไม่ให้ตัวอักษรล้นขอบ)
        fs -= 4; f1 = ImageFont.truetype(FONT, fs)
    f2 = ImageFont.truetype(FONT, 40)
    if t:
        w = d.textlength(t, font=f1); d.text(((W - w) / 2, 20), t, font=f1, fill=(20, 20, 25))
        p = r.choice(PROV); w = d.textlength(p, font=f2); d.text(((W - w) / 2, 150), p, font=f2, fill=(20, 20, 25))
    pl = np.array(im)[:, :, ::-1]
    if tilt:
        M = cv2.getRotationMatrix2D((W / 2, H / 2), tilt, 1); pl = cv2.warpAffine(pl, M, (W, H), borderMode=cv2.BORDER_REPLICATE)
    # วางลงในฉากรถ: พื้นหลังสีเข้ม/มีลาย แล้วย่อให้ป้ายกว้างตาม scale (px)
    FW, FH = 960, 720
    rng = np.random.RandomState(seed)
    scene = (rng.randint(30, 110, (FH, FW, 3))).astype(np.uint8)
    scene = cv2.GaussianBlur(scene, (0, 0), 6)
    cv2.rectangle(scene, (150, 380), (810, 600), (60, 60, 70), -1)
    pw = int(300 * scale); ph = int(pw * H / W)
    sm = cv2.resize(pl, (pw, ph), interpolation=cv2.INTER_AREA)
    x, y = (FW - pw) // 2, 430
    scene[y:y + ph, x:x + pw] = sm
    if blur: scene = cv2.GaussianBlur(scene, (0, 0), blur)
    if noise: scene = np.clip(scene + rng.normal(0, noise, scene.shape), 0, 255).astype(np.uint8)
    ok, buf = cv2.imencode(".jpg", scene, [cv2.IMWRITE_JPEG_QUALITY, 70])
    return buf.tobytes(), truth

CONDS = {"clean": dict(scale=1.0), "small": dict(scale=0.55), "blur": dict(scale=0.8, blur=1.6), "noisy": dict(scale=0.8, noise=14), "tilt": dict(scale=0.8, tilt=6), "hard": dict(scale=0.55, blur=1.2, noise=10, tilt=4), "moto": dict(scale=0.55, stack=True), "moto_blur": dict(scale=0.5, stack=True, blur=1.0)}

def run(read_fn, n=12):
    tot = {}
    for cname, kw in CONDS.items():
        ok = part = 0
        for s in range(n):
            data, truth = make(1000 + s, **kw)
            img = iu.decode(data)
            frame = rs.read_frame(img, read_fn, {"orig", "clahe"})
            b = frame["best"]; txt = b["text"] if b else ""
            ok += txt == truth; part += (txt != truth and pu.char_similarity(txt, truth) >= .7)
        tot[cname] = (ok, part, n)
    return tot

if __name__ == "__main__":
    import time; t = time.time()
    if len(sys.argv) > 2 and sys.argv[2] == "legacy": te.read = te._read_legacy
    r = run(te.read, int(sys.argv[1]) if len(sys.argv) > 1 else 12)
    print({k: f"{a}/{n} exact, {p} near" for k, (a, p, n) in r.items()}, f"{time.time()-t:.0f}s total={sum(a for a,_,_ in r.values())}/{sum(n for *_,n in r.values())}")
