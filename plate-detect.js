/* DockSense — ตัวตรวจ "ป้ายคล้ายทะเบียน" ในเบราว์เซอร์ (ไม่ใช้ AI/ไม่เสียโควตา ทำงานบนเครื่องล้วน)
   detect(gray,W,H) → {x,y,w,h,score} (หน่วยพิกเซลของภาพที่ส่งเข้ามา) หรือ null
   หลักคิด: ป้ายทะเบียน = กรอบสี่เหลี่ยมกว้างประมาณ 2.2–3.6 เท่าของสูง มีเส้นขอบแนวตั้งของตัวอักษรหนาแน่นช่วงกลางกรอบ
   และ "แยกตัวชัด" จากรอบข้าง (ตะแกรงหน้ารถ/ลายผนังจะมีเส้นหนาแน่นทั้งภาพ จึงถูกตัดทิ้ง)
   sharpness(gray,W,H,x,y,w,h) → ความคมชัด (ความแปรปรวนของ Laplacian) ใช้เลือกเฟรมที่ไม่เบลอ */
(function (root) {
  function detect(g, W, H, opt) {
    opt = opt || {};
    const minScore = opt.minScore || 0.62, T = opt.edge || 26, C = 2;           // C = ขนาดช่องตาราง (พิกเซล) เพื่อให้เร็ว
    const gw = Math.floor(W / C), gh = Math.floor(H / C), S = gw + 1;
    const IE = new Int32Array(S * (gh + 1)), IL = new Float64Array(S * (gh + 1));
    for (let cy = 0; cy < gh; cy++) {
      let re = 0, rl = 0;
      for (let cx = 0; cx < gw; cx++) {
        for (let dy = 0; dy < C; dy++) for (let dx = 0; dx < C; dx++) {
          const x = cx * C + dx, i = (cy * C + dy) * W + x;
          if (x > 0 && x < W - 1 && Math.abs(g[i + 1] - g[i - 1]) > T) re++;
          rl += g[i];
        }
        IE[(cy + 1) * S + cx + 1] = IE[cy * S + cx + 1] + re; IL[(cy + 1) * S + cx + 1] = IL[cy * S + cx + 1] + rl;
      }
    }
    const A = C * C;
    const sE = (x0, y0, x1, y1) => IE[y1 * S + x1] - IE[y0 * S + x1] - IE[y1 * S + x0] + IE[y0 * S + x0];
    const sL = (x0, y0, x1, y1) => IL[y1 * S + x1] - IL[y0 * S + x1] - IL[y1 * S + x0] + IL[y0 * S + x0];
    let best = null;
    for (const wf of [0.08, 0.11, 0.15, 0.2, 0.27, 0.36, 0.48]) {
      for (const ar of [2.4, 3.0, 3.6]) {
        const w = Math.round(gw * wf), h = Math.round(w / ar); if (h < 5 || h * 2 > gh || w * 2 > gw) continue;
        const mx = Math.max(1, Math.round(w * 0.4)), my = Math.max(2, Math.round(h * 0.8));
        const t = Math.max(1, Math.round(h * 0.2)), area = w * h * A, sx = Math.max(1, w >> 3);
        for (let y = my; y + h + my <= gh; y++) for (let x = mx; x + w + mx <= gw; x += sx) {
          const ein = sE(x, y, x + w, y + h), e = ein / area;
          if (e < 0.08 || e > 0.5) continue;
          const top = sE(x, y, x + w, y + t) / (w * t * A), bot = sE(x, y + h - t, x + w, y + h) / (w * t * A);
          const mid = sE(x, y + t, x + w, y + h - t) / (w * (h - 2 * t) * A);
          const midRatio = mid / ((top + bot) / 2 + 0.02);
          if (midRatio < 1.4) continue;
          const eOut = sE(x - mx, y - my, x + w + mx, y + h + my), ringArea = ((w + 2 * mx) * (h + 2 * my) - w * h) * A;
          const ringD = (eOut - ein) / ringArea, iso = 1 - Math.min(1, ringD / (e + 1e-6));
          const lIn = sL(x, y, x + w, y + h) / area, lRing = (sL(x - mx, y - my, x + w + mx, y + h + my) - lIn * area) / ringArea;
          const con = Math.min(1, Math.abs(lIn - lRing) / 60);
          const eS = Math.max(0, 1 - Math.abs(e - 0.2) / 0.2), mS = Math.min(1, (midRatio - 1.4) / 1.6);
          const score = eS * 0.25 + iso * 0.35 + con * 0.2 + mS * 0.2;
          if (score >= minScore && (!best || score > best.score)) best = { x: x * C, y: y * C, w: w * C, h: h * C, score: +score.toFixed(3) };
        }
      }
    }
    return best;
  }
  function sharpness(g, W, H, x, y, w, h) {
    x = Math.max(1, x | 0); y = Math.max(1, y | 0); const x1 = Math.min(W - 1, (x + w) | 0), y1 = Math.min(H - 1, (y + h) | 0);
    let s = 0, s2 = 0, n = 0;
    for (let j = y; j < y1; j++) for (let i = x; i < x1; i++) { const k = j * W + i, l = 4 * g[k] - g[k - 1] - g[k + 1] - g[k - W] - g[k + W]; s += l; s2 += l * l; n++; }
    if (!n) return 0; const m = s / n; return s2 / n - m * m;
  }
  root.DSPlate = { detect, sharpness };
  if (typeof module !== "undefined") module.exports = root.DSPlate;
})(typeof window !== "undefined" ? window : globalThis);
