/* DockSense — ตัวคุมภาระของกล้องสด (TypeScript → live-governor.js)
   ปัญหา: ช่วงแรกลื่น แต่พอเครื่องร้อน เบราว์เซอร์ลดสัญญาณนาฬิกา (thermal throttle) งานตรวจป้าย/เข้ารหัสภาพที่ทำถี่ๆ
   จึงเริ่มกระตุก และยิ่งกินเครื่องหนักขึ้นอีก (วงจรร้อน→ช้า→ค้าง)
   วิธี: วัดว่าเครื่อง "ตามงานทันไหม" จริงๆ แล้วลดความถี่/ขนาดภาพอัตโนมัติ 4 ระดับ ฟื้นกลับช้าๆ เมื่อเครื่องเย็น
   สัญญาณที่ใช้: (1) เวลาที่งานของเราใช้ต่อวินาที (2) ความหน่วงของเธรดหลัก (setTimeout เลทกี่ ms)
   (3) Compute Pressure API ถ้าเบราว์เซอร์มี (4) แบตต่ำ/ไม่ชาร์จ — ไม่มีสัญญาณใดบอกอุณหภูมิตรงๆ ได้ จึงเป็นการประมาณ */

interface LiveLevel { detectMs: number; detectW: number; streamMs: number; streamW: number; streamQ: number; fps: number; label: string }

interface LoopOpts { everyMs: () => number; run: () => Promise<void> | void; pauseHidden?: boolean }

interface DSLiveApi {
  cfg: LiveLevel;
  level: number;
  loop(name: string, opts: LoopOpts): number;
  stop(id: number): void;
  stopAll(): void;
  jpegB64(c: HTMLCanvasElement, q: number): Promise<string>;
  onLevel(fn: (lv: number, cfg: LiveLevel) => void): () => void;
  note(): string;
  force(lv: number | null): void;
}

(function (root: Window & typeof globalThis): void {
  const LEVELS: LiveLevel[] = [
    { detectMs: 250, detectW: 400, streamMs: 170, streamW: 960, streamQ: 0.6, fps: 15, label: "" },
    { detectMs: 350, detectW: 400, streamMs: 250, streamW: 800, streamQ: 0.55, fps: 15, label: "ลดความถี่เล็กน้อยเพื่อถนอมเครื่อง" },
    { detectMs: 500, detectW: 320, streamMs: 400, streamW: 640, streamQ: 0.5, fps: 12, label: "โหมดประหยัด: เครื่องเริ่มร้อน/ช้า จึงลดความถี่และขนาดภาพสด" },
    { detectMs: 800, detectW: 280, streamMs: 700, streamW: 480, streamQ: 0.45, fps: 10, label: "โหมดประหยัดสูงสุด: ลดภาระเต็มที่ ให้เครื่องเย็นลง (การอ่านทะเบียนยังทำงาน)" },
  ];
  const WINDOW_MS = 3000, UP_BUSY = 0.35, UP_LAG = 70, DOWN_BUSY = 0.15, DOWN_LAG = 30, UP_NEED = 2, DOWN_NEED = 6, DWELL_MS = 10000;

  let level = 0, forced: number | null = null, pressureFloor = 0, batteryFloor = 0;
  let busyMs = 0, lagEma = 0, upCount = 0, downCount = 0, lastChange = 0;
  const listeners: Array<(lv: number, cfg: LiveLevel) => void> = [];
  const timers = new Map<number, number>();
  let seq = 0, monitorT = 0, beatT = 0, beatExpected = 0, windowStart = 0;

  const api: DSLiveApi = {
    cfg: LEVELS[0], level: 0,
    loop(name, opts) {
      const id = ++seq; let stopped = false, running = false;
      const tick = async (): Promise<void> => {
        if (stopped) return;
        const t0 = performance.now();
        if (!running && !(opts.pauseHidden && document.hidden)) {
          running = true;
          try { await opts.run(); } catch (_) { /* งานเดียวพลาดไม่ล้มทั้งวง */ }
          running = false;
        }
        const cost = performance.now() - t0; busyMs += cost;
        // ตั้งเวลารอบถัดไปแบบ "หลังงานจบ" (ไม่ใช้ setInterval) → ไม่มีงานสะสมแล้วรัวทีเดียวตอนเครื่องช้า
        if (!stopped) timers.set(id, window.setTimeout(tick, Math.max(30, opts.everyMs() - cost)));
      };
      void name; startMonitor();
      timers.set(id, window.setTimeout(tick, opts.everyMs()));
      return id;
    },
    stop(id) { const t = timers.get(id); if (t !== undefined) clearTimeout(t); timers.delete(id); if (!timers.size) stopMonitor(); },
    stopAll() { timers.forEach((t) => clearTimeout(t)); timers.clear(); stopMonitor(); },
    // เข้ารหัส JPEG แบบ async (toBlob) แทน toDataURL ที่บล็อกเธรดหลักทั้งก้อน แล้วคืน base64 ไม่มีหัว data:
    jpegB64(c, q) {
      return new Promise<string>((ok, bad) => {
        if (!c.toBlob) { ok(c.toDataURL("image/jpeg", q).split(",")[1] || ""); return; }
        c.toBlob((b) => {
          if (!b) { bad(new Error("encode")); return; }
          const fr = new FileReader();
          fr.onload = () => ok(String(fr.result).split(",")[1] || "");
          fr.onerror = () => bad(new Error("read"));
          fr.readAsDataURL(b);
        }, "image/jpeg", q);
      });
    },
    onLevel(fn) { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
    note() { return LEVELS[level].label; },
    force(lv) { forced = lv; apply(true); },
  };

  function apply(now?: boolean): void {
    const want = Math.min(3, Math.max(forced ?? level, pressureFloor, batteryFloor));
    if (want === api.level && forced === null) return;
    if (forced !== null || now || want !== api.level) { api.level = want; api.cfg = LEVELS[want]; listeners.forEach((f) => { try { f(want, LEVELS[want]); } catch (_) { /* ignore */ } }); }
  }

  function evaluate(): void {
    const span = Math.max(1, performance.now() - windowStart), busy = busyMs / span;
    busyMs = 0; windowStart = performance.now();
    const hot = busy > UP_BUSY || lagEma > UP_LAG, cool = busy < DOWN_BUSY && lagEma < DOWN_LAG;
    upCount = hot ? upCount + 1 : 0; downCount = cool ? downCount + 1 : 0;
    const t = performance.now();
    if (t - lastChange > DWELL_MS) {
      if (upCount >= UP_NEED && level < 3) { level++; lastChange = t; upCount = 0; downCount = 0; }
      else if (downCount >= DOWN_NEED && level > 0) { level--; lastChange = t; downCount = 0; }
    }
    apply();
  }

  function startMonitor(): void {
    if (monitorT) return;
    windowStart = performance.now(); busyMs = 0; lagEma = 0; upCount = 0; downCount = 0;
    beatExpected = performance.now() + 500;
    beatT = window.setInterval(() => { // วัดความหน่วงเธรดหลัก: นาฬิกาคาดว่าเด้งทุก 500 ms เลทเท่าไร = ยุ่งเท่านั้น
      const n = performance.now(), lag = Math.max(0, n - beatExpected); beatExpected = n + 500;
      lagEma = lagEma * 0.7 + lag * 0.3;
    }, 500);
    monitorT = window.setInterval(evaluate, WINDOW_MS);
    // Compute Pressure API (Chrome บนเครื่องที่รองรับ): serious/critical = เครื่องร้อนจริง → ลงระดับทันที ไม่รอวัดเอง
    try {
      const PO = (root as unknown as { PressureObserver?: new (cb: (r: Array<{ state: string }>) => void) => { observe(s: string, o?: object): Promise<void>; disconnect(): void } }).PressureObserver;
      if (PO) {
        const po = new PO((recs) => { const s = recs[recs.length - 1]?.state; pressureFloor = s === "critical" ? 3 : s === "serious" ? 2 : s === "fair" ? 1 : 0; apply(); });
        po.observe("cpu", { sampleInterval: 2000 }).catch(() => { /* ไม่รองรับ/ไม่อนุญาต */ });
        (api as unknown as { _po?: { disconnect(): void } })._po = po;
      }
    } catch (_) { /* ไม่มี API นี้ก็ใช้การวัดเองต่อ */ }
    try { // แบตต่ำและไม่ได้ชาร์จ → ลดอย่างน้อย 1 ระดับ
      const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number; charging: boolean; addEventListener(t: string, f: () => void): void }> };
      if (nav.getBattery) nav.getBattery().then((b) => { const f = (): void => { batteryFloor = !b.charging && b.level < 0.2 ? 1 : 0; apply(); }; f(); b.addEventListener("levelchange", f); b.addEventListener("chargingchange", f); }).catch(() => { /* ignore */ });
    } catch (_) { /* ignore */ }
  }

  function stopMonitor(): void {
    clearInterval(monitorT); clearInterval(beatT); monitorT = 0; beatT = 0;
    const po = (api as unknown as { _po?: { disconnect(): void } })._po; if (po) { try { po.disconnect(); } catch (_) { /* ignore */ } }
    level = 0; pressureFloor = 0; batteryFloor = 0; api.level = 0; api.cfg = LEVELS[0];
  }

  (root as unknown as { DSLive: DSLiveApi }).DSLive = api;
})(window);
