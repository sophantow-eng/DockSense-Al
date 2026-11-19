/* DockSense — ตัวตรวจ "ป้ายคล้ายทะเบียน" ในเบราว์เซอร์ (ไม่ใช้ AI/ไม่เสียโควตา ทำงานบนเครื่องล้วน)
   detect(gray,W,H) → {x,y,w,h,score} (หน่วยพิกเซลของภาพที่ส่งเข้ามา) หรือ null
   หลักคิด: ป้ายทะเบียน = กรอบสี่เหลี่ยมกว้างประมาณ 2.2–3.6 เท่าของสูง มีเส้นขอบแนวตั้งของตัวอักษรหนาแน่นช่วงกลางกรอบ
   และ "แยกตัวชัด" จากรอบข้าง (ตะแกรงหน้ารถ/ลายผนังจะมีเส้นหนาแน่นทั้งภาพ จึงถูกตัดทิ้ง)
   sharpness(gray,W,H,x,y,w,h) → ความคมชัด (ความแปรปรวนของ Laplacian) ใช้เลือกเฟรมที่ไม่เบลอ */
(function (root) {
  function detect(g, W, H, opt) {
    opt = opt || {};
    const minScore = opt.minScore || 0.68, T = opt.edge || 26, C = 2;           // C = ขนาดช่องตาราง (พิกเซล) เพื่อให้เร็ว
    const gw = Math.floor(W / C), gh = Math.floor(H / C), S = gw + 1;
    const IE = new Int32Array(S * (gh + 1)), IL = new Float64Array(S * (gh + 1)), IQ = new Float64Array(S * (gh + 1));
    for (let cy = 0; cy < gh; cy++) {
      let re = 0, rl = 0, rq = 0;
      for (let cx = 0; cx < gw; cx++) {
        for (let dy = 0; dy < C; dy++) for (let dx = 0; dx < C; dx++) {
          const x = cx * C + dx, i = (cy * C + dy) * W + x;
          if (x > 0 && x < W - 1 && Math.abs(g[i + 1] - g[i - 1]) > T) re++;
          rl += g[i]; rq += g[i] * g[i];
        }
        IE[(cy + 1) * S + cx + 1] = IE[cy * S + cx + 1] + re; IL[(cy + 1) * S + cx + 1] = IL[cy * S + cx + 1] + rl; IQ[(cy + 1) * S + cx + 1] = IQ[cy * S + cx + 1] + rq;
      }
    }
    const A = C * C;
    const sE = (x0, y0, x1, y1) => IE[y1 * S + x1] - IE[y0 * S + x1] - IE[y1 * S + x0] + IE[y0 * S + x0];
    const sL = (x0, y0, x1, y1) => IL[y1 * S + x1] - IL[y0 * S + x1] - IL[y1 * S + x0] + IL[y0 * S + x0];
    const sQ = (x0, y0, x1, y1) => IQ[y1 * S + x1] - IQ[y0 * S + x1] - IQ[y1 * S + x0] + IQ[y0 * S + x0];
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
          // ป้าย = พื้นสว่างตัวอักษรดำ → ความสว่างในกรอบแกว่งแรง (ส่วนเบี่ยงเบนมาตรฐาน) ต่างจากหญ้า/พื้น/ตะแกรง
          const varIn = sQ(x, y, x + w, y + h) / area - lIn * lIn, sd = Math.sqrt(Math.max(0, varIn));
          if (sd < (opt.minSd || 38)) continue;
          const eS = Math.max(0, 1 - Math.abs(e - 0.2) / 0.2), mS = Math.min(1, (midRatio - 1.4) / 1.6);
          const sdS = Math.min(1, sd / 70), sizeS = Math.min(1, w / (gw * 0.2));
          const score = eS * 0.18 + iso * 0.27 + con * 0.1 + mS * 0.15 + sdS * 0.2 + sizeS * 0.1;
          if (opt.all && score > 0.4) opt.all.push({ x: x * C, y: y * C, w: w * C, h: h * C, score: +score.toFixed(3), sd: +sd.toFixed(0), iso: +iso.toFixed(2) });
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
  /* glyphs(gray,W,H,rect) → {x,y,w,h,list:[{x,y,w,h}...]} หรือ null
     หา "ตัวอักษร/ตัวเลขทีละตัว" ในและรอบกรอบที่ detect ได้ (ไม่ใช่การอ่านตัวอักษร — แค่หาก้อนตัวหนังสือสูงเท่ากันเรียงแถวเดียวกัน)
     ใช้ 2 อย่าง: ขยับกรอบเขียวให้ครอบทั้งแถวทะเบียน และวางวงรีแดงรอบแต่ละตัว · เบา: ลดภาพให้สูง ≤ ~70px ก่อนวิเคราะห์ */
  function glyphs(g, W, H, r) {
    // กรอบที่ detect ได้อาจจับแค่บรรทัดจังหวัดหรือครึ่งเดียวของแถวทะเบียน → ขยายขึ้นด้านบนมาก (แถวทะเบียนอยู่เหนือบรรทัดจังหวัด) และออกด้านข้าง
    const px = Math.round(r.w * 0.6), pu = Math.round(r.h * 2.8), pd = Math.round(r.h * 0.35);
    const x0 = Math.max(1, r.x - px), y0 = Math.max(1, r.y - pu), x1 = Math.min(W - 1, r.x + r.w + px), y1 = Math.min(H - 1, r.y + r.h + pd);
    const rw = x1 - x0, rh = y1 - y0; if (rw < 30 || rh < 12) return null;
    const st = Math.max(1, Math.floor(rh / 70)), w = Math.floor(rw / st), h = Math.floor(rh / st), N = w * h;
    const a = new Uint8Array(N), hist = new Uint32Array(256);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = g[(y0 + y * st) * W + x0 + x * st] | 0; a[y * w + x] = v; hist[v]++; }
    let sumAll = 0; for (let i = 0; i < 256; i++) sumAll += i * hist[i];       // Otsu
    let wB = 0, sumB = 0, bestVar = -1, t = 128;
    for (let i = 0; i < 256; i++) { wB += hist[i]; if (!wB) continue; const wF = N - wB; if (!wF) break; sumB += i * hist[i]; const mB = sumB / wB, mF = (sumAll - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF); if (v > bestVar) { bestVar = v; t = i; } }
    const scan = (fgDark) => {
      const m = new Uint8Array(N);
      for (let i = 0; i < N; i++) m[i] = (fgDark ? a[i] <= t : a[i] > t) ? 1 : 0;
      const seen = new Uint8Array(N), stack = new Int32Array(N), comps = [];
      for (let s0 = 0; s0 < N; s0++) {
        if (!m[s0] || seen[s0]) continue;
        let sp = 0, n = 0, cx0 = w, cy0 = h, cx1 = 0, cy1 = 0; stack[sp++] = s0; seen[s0] = 1;
        while (sp) {
          const p = stack[--sp], py2 = (p / w) | 0, px2 = p - py2 * w; n++;
          if (px2 < cx0) cx0 = px2; if (px2 > cx1) cx1 = px2; if (py2 < cy0) cy0 = py2; if (py2 > cy1) cy1 = py2;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = px2 + dx, ny = py2 + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const q = ny * w + nx; if (m[q] && !seen[q]) { seen[q] = 1; stack[sp++] = q; }
          }
        }
        const bw = cx1 - cx0 + 1, bh = cy1 - cy0 + 1, fill = n / (bw * bh), ar = bw / bh;
        if (bh >= 6 && n >= 10 && ar >= 0.08 && ar <= 1.3 && fill >= 0.15 && fill <= 0.97) comps.push({ x0: cx0, y0: cy0, x1: cx1, y1: cy1, bh, cy: (cy0 + cy1) / 2 });
      }
      if (comps.length < 3) return null;
      let grp = null;                                                // กลุ่มสูงเท่ากัน+แถวเดียวกัน ≥3 ตัว · เลือกกลุ่ม "ตัวสูงสุด" (แถวทะเบียนใหญ่กว่าบรรทัดจังหวัด)
      for (const c of comps) {
        const gset = comps.filter((d) => Math.abs(d.bh - c.bh) <= 0.3 * c.bh && Math.abs(d.cy - c.cy) <= 0.4 * c.bh);
        if (gset.length < 3 || gset.length > 12) continue;
        const span = Math.max(...gset.map((d) => d.x1)) - Math.min(...gset.map((d) => d.x0)); if (span < 1.8 * c.bh || span > 14 * c.bh) continue;
        if (!grp || c.bh > grp.bh * 1.15 || (c.bh >= grp.bh * 0.87 && gset.length > grp.list.length)) grp = { list: gset, bh: c.bh };
      }
      if (!grp) return null; grp = grp.list;
      // ดึงตัวอักษรไทยที่สูง/ต่ำต่างจากตัวเลขเล็กน้อย แต่อยู่แถวเดียวกันและติดกลุ่ม (ไม่ดึงบรรทัดจังหวัด: คนละแถว/เล็กกว่ามาก)
      const bh0 = Math.max(...grp.map((d) => d.bh)); let grew = true;
      for (let it = 0; grew && it < 4; it++) { grew = false;
        const gx0 = Math.min(...grp.map((d) => d.x0)), gx1 = Math.max(...grp.map((d) => d.x1));
        for (const d of comps) { if (grp.includes(d)) continue;
          if (d.bh >= 0.55 * bh0 && d.bh <= 1.5 * bh0 && Math.abs(d.cy - grp[0].cy) <= 0.5 * bh0 && (d.x1 >= gx0 - 2.2 * bh0 && d.x0 <= gx1 + 2.2 * bh0)) { grp.push(d); grew = true; } } }
      if (grp.length > 12) return null;
      grp.sort((p, q) => p.x0 - q.x0);
      const mg = [];                                                 // รวมชิ้นส่วนของตัวอักษรเดียวกันที่แยกกัน (ซ้อนกันแนวนอน)
      for (const c of grp) {
        const l = mg[mg.length - 1];
        if (l && Math.min(l.x1, c.x1) - Math.max(l.x0, c.x0) > 0.5 * Math.min(l.x1 - l.x0 + 1, c.x1 - c.x0 + 1)) { l.x0 = Math.min(l.x0, c.x0); l.x1 = Math.max(l.x1, c.x1); l.y0 = Math.min(l.y0, c.y0); l.y1 = Math.max(l.y1, c.y1); } else mg.push({ ...c });
      }
      if (mg.length < 3 || mg.length > 9) return null;
      return { mg, bh: bh0 };
    };
    // ไม่รู้ว่าตัวอักษรเข้มบนพื้นสว่าง หรือกลับกัน (พื้นหลังรอบป้ายทำให้ Otsu สลับขั้ว) → ลองทั้งสองขั้ว เลือกแถวที่ตัวสูงกว่า/ครบ 4–8 ตัว
    const ra = scan(true), rb = scan(false);
    const okN = (q) => q && q.mg.length >= 4 && q.mg.length <= 8;
    const res = (okN(ra) && !okN(rb)) ? ra : (okN(rb) && !okN(ra)) ? rb : (ra && rb) ? (rb.bh > ra.bh * 1.15 ? rb : ra) : (ra || rb);
    if (!res) return null; const mg = res.mg;
    const list = mg.map((c) => ({ x: x0 + c.x0 * st, y: y0 + c.y0 * st, w: (c.x1 - c.x0 + 1) * st, h: (c.y1 - c.y0 + 1) * st }));
    let ux0 = Infinity, uy0 = Infinity, ux1 = 0, uy1 = 0, mh = 0;
    for (const q of list) { ux0 = Math.min(ux0, q.x); uy0 = Math.min(uy0, q.y); ux1 = Math.max(ux1, q.x + q.w); uy1 = Math.max(uy1, q.y + q.h); mh = Math.max(mh, q.h); }
    const padX = Math.round(mh * 0.35), padY = Math.round(mh * 0.25), bx = Math.max(0, ux0 - padX), by = Math.max(0, uy0 - padY);
    return { x: bx, y: by, w: Math.min(W, ux1 + padX) - bx, h: Math.min(H, uy1 + padY) - by, list };
  }
  function detectFull(g, W, H, opt) {
    const r = detect(g, W, H, opt); if (!r) return null;
    const f = glyphs(g, W, H, r); if (!f) return r;
    return { x: f.x, y: f.y, w: f.w, h: f.h, score: r.score, glyphs: f.list };
  }
  /* ตัวป้ายเองชิดขอบภาพ (<3%) และไม่ใช่ป้ายใหญ่เต็มจอ = ป้ายอาจถูกขอบภาพตัด → ไม่ควรถ่าย ให้ขยับกล้อง */
  function touchesEdge(r, W, H) { if (r.w > W * 0.8) return false; /* ถ่ายใกล้มาก ป้ายเต็มจอ = ปกติ */ return r.x < W * 0.03 || r.y < H * 0.03 || r.x + r.w > W * 0.97 || r.y + r.h > H * 0.97; }
  root.DSPlate = { detect, detectFull, glyphs, sharpness, touchesEdge };
  if (typeof module !== "undefined") module.exports = root.DSPlate;
})(typeof window !== "undefined" ? window : globalThis);
