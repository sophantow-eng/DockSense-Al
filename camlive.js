/*
  DockSense AI — ภาพสดจากกล้อง (เวอร์ชันลื่น/เสถียรขึ้น)
  ไฟล์นี้แทนที่ฟังก์ชัน camLive() เดิมใน index.html โดยไม่ต้องแก้โค้ดเดิม
  วิธีใช้: วางไฟล์นี้ไว้ข้าง index.html แล้วเพิ่มบรรทัดนี้ก่อน </body>
      <script src="camlive.js"></script>

  ปรับปรุงจากเดิม
   - เดิม: เรียก camera_watch -> ขอ signed URL -> ถามสถานะ ต่อกันทุกรอบ แล้วรออีก 2.5 วินาที
     ใหม่: แยก "แจ้งกล้องให้ส่งถี่" ออกจากการเช็กภาพ และเช็กภาพใหม่ทุก 0.7 วินาที
   - ใช้ signed URL ซ้ำ (ไม่ขอใหม่ทุกเฟรม) และโหลดภาพล่วงหน้าก่อนสลับ -> ไม่กะพริบ/ไม่ขาว
   - ถ้าเชื่อมต่อพลาด จะหน่วงรอแล้วลองใหม่เอง (exponential backoff) และบอกสถานะบนหน้าจอ
   - หยุดโหลดเมื่อสลับไปแท็บอื่น/ปิดหน้าต่าง ประหยัดแบตและโควตา
*/
(function () {
  "use strict";
  if (!window.DS) return;
  const DS = window.DS, db = DS.db;

  const FRAME_POLL_MS = 700;    // เช็กว่ามีภาพใหม่ทุกกี่ ms
  const WATCH_PING_MS = 3000;   // แจ้งกล้องว่ามีคนดูอยู่ ทุกกี่ ms
  const SIGN_TTL_S = 300;       // อายุ signed URL (วินาที)

  window.camLive = function (c) {
    if (!c) return;

    const m = DS.modal(
      "📷 " + c.name,
      `<div class="camwrap"><img id="clImg" alt="ภาพจากกล้อง" decoding="async"><div class="camload" id="clWait"><span class="spin"></span> กำลังโหลดภาพจากกล้อง…</div></div>
       <p class="muted" id="clInfo" style="margin:8px 0 0">กำลังขอให้กล้องส่งภาพถี่ขึ้น</p>
       <div class="row" style="margin-top:12px"><button class="ghost" id="clX" type="button">ปิด</button></div>`
    );

    const path = `camera/${c.id}/latest.jpg`;
    let stopped = false, pollTimer = null, pingTimer = null, infoTimer = null;
    let lastAt = "", shownAt = 0, fails = 0, signed = null;

    const stop = () => {
      stopped = true;
      clearTimeout(pollTimer); clearInterval(pingTimer); clearInterval(infoTimer);
    };
    m.querySelector("#clX").onclick = () => { stop(); m.remove(); };

    const alive = () => !stopped && m.isConnected;

    // signed URL ใช้ซ้ำได้จนใกล้หมดอายุ
    async function getSigned(force) {
      if (!force && signed && signed.exp > Date.now()) return signed.url;
      const { data, error } = await db.storage.from("plate-images").createSignedUrl(path, SIGN_TTL_S);
      if (error || !data) throw error || new Error("ขอลิงก์ภาพไม่สำเร็จ");
      signed = { url: data.signedUrl, exp: Date.now() + (SIGN_TTL_S - 60) * 1000 };
      return signed.url;
    }
    const withV = (url, v) => url + (url.includes("?") ? "&" : "?") + "v=" + encodeURIComponent(v);

    // โหลดภาพล่วงหน้าก่อนสลับ เพื่อไม่ให้ภาพกะพริบหรือว่างระหว่างโหลด
    const preload = (url) => new Promise((res) => {
      const im = new Image();
      im.onload = () => res(url);
      im.onerror = () => res(null);
      im.src = url;
    });

    async function ping() {
      if (!alive() || document.hidden) return;
      try { await db.rpc("camera_watch", { p_id: c.id }); } catch (e) {}
    }

    function showInfo() {
      if (!alive()) { stop(); return; }
      const info = m.querySelector("#clInfo"); if (!info) return;
      if (fails >= 3) { info.textContent = "เชื่อมต่อขัดข้อง กำลังลองใหม่อัตโนมัติ…"; return; }
      if (!shownAt) { info.textContent = lastAt ? "กำลังโหลดภาพ…" : "กล้องยังไม่เคยส่งภาพ — เช็กว่ากล้องเปิดและต่อ Wi-Fi อยู่"; return; }
      const age = Math.max(0, Math.round((Date.now() - shownAt) / 1000));
      info.textContent = age > 60
        ? `ภาพล่าสุดเมื่อ ${Math.round(age / 60)} นาทีที่แล้ว — กล้องอาจออฟไลน์`
        : `ภาพล่าสุด ${age} วินาทีที่แล้ว${age > 15 ? " · กล้องกำลังปรับให้ส่งถี่ขึ้น" : ""}`;
    }

    async function poll() {
      if (!alive()) { stop(); return; }
      if (document.hidden) { pollTimer = setTimeout(poll, 1500); return; }   // อยู่แท็บอื่น: พักก่อน
      try {
        const { data: st, error } = await db.from("camera_status").select("preview_at").eq("id", c.id).maybeSingle();
        if (error) throw error;
        const at = st && st.preview_at;
        if (at && at !== lastAt) {
          lastAt = at;
          let url = await getSigned(false), ok = await preload(withV(url, at));
          if (!ok) { url = await getSigned(true); ok = await preload(withV(url, at)); }   // ลิงก์หมดอายุ -> ขอใหม่ครั้งเดียว
          if (!ok) throw new Error("โหลดภาพไม่สำเร็จ");
          if (!alive()) return;
          const img = m.querySelector("#clImg"); if (img) img.src = ok;
          const w = m.querySelector("#clWait"); if (w) w.remove();
          shownAt = new Date(at).getTime() || Date.now();
        }
        fails = 0;
      } catch (e) {
        fails++;
        lastAt = "";    // ลองโหลดเฟรมนี้ใหม่รอบหน้า
      }
      showInfo();
      const delay = fails ? Math.min(1000 * Math.pow(2, Math.min(fails, 3)), 8000) : FRAME_POLL_MS;
      pollTimer = setTimeout(poll, delay);
    }

    ping();
    pingTimer = setInterval(ping, WATCH_PING_MS);
    infoTimer = setInterval(showInfo, 1000);
    poll();
  };
})();
