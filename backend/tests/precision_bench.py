"""วัด "ความแม่นเมื่อระบบกล้าตอบ" บนภาพจำลอง: ในผลที่ความมั่นใจ >= เกณฑ์ ถูกกี่ % (precision) และครอบคลุมกี่ % (coverage)
ภาพจำลอง ไม่ใช่ป้ายจริง — ใช้เทียบก่อน/หลังเท่านั้น"""
import sys, time
sys.path.insert(0, ".")
from tests.synth_bench import make, CONDS
from app import image_utils as iu, recognition_service as rs, tesseract_engine as te

def run(n=10, thr=0.85):
    rows = []; t0 = time.time()
    for cname, kw in CONDS.items():
        for s in range(n):
            data, truth = make(2000 + s, **kw)
            fr = rs.read_frame(iu.decode(data), te.read, {"orig", "clahe"}); b = fr["best"]
            rows.append((b["text"], b["conf"], truth) if b else ("", 0.0, truth))
    N = len(rows); sure = [r for r in rows if r[0] and r[1] >= thr]; ok = [r for r in sure if r[0] == r[2]]
    allok = sum(1 for r in rows if r[0] == r[2])
    print(f"ทั้งหมด {N}: อ่านถูก {allok} · ตอบมั่นใจ(>= {thr}) {len(sure)} ({100*len(sure)/N:.0f}%) · ในนั้นถูก {len(ok)} = precision {100*len(ok)/max(1,len(sure)):.0f}% · ผิดแต่มั่นใจ {len(sure)-len(ok)} · {time.time()-t0:.0f}s")

if __name__ == "__main__":
    run(int(sys.argv[1]) if len(sys.argv) > 1 else 10)
