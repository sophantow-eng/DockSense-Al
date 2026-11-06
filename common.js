/* DockSense AI — ส่วนที่ใช้ร่วมกัน (index.html + scan.html) */
(function () {
  const cfg = window.DS_CONFIG || {};
  const keyMissing = !cfg.SUPABASE_URL || !cfg.SUPABASE_KEY || /PASTE_/.test(cfg.SUPABASE_KEY);
  const db = supabase.createClient(cfg.SUPABASE_URL || "https://invalid.supabase.co", cfg.SUPABASE_KEY || "missing", {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  const TZ = "Asia/Bangkok";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // ต้องตรงกับคอลัมน์ plate_norm ในฐานข้อมูล: upper(regexp_replace(plate_number, '[\s\-]', '', 'g'))
  const norm = (s) => String(s ?? "").toUpperCase().replace(/[\s\-]/g, "");

  /* ธีม */
  const applyTheme = (t) => { if (t === "dark") document.documentElement.setAttribute("data-theme", "dark"); else document.documentElement.removeAttribute("data-theme"); };
  try {
    const saved = localStorage.getItem("ds_theme");
    applyTheme(saved || (window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  } catch (e) {}
  const toggleTheme = () => {
    const t = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    applyTheme(t); try { localStorage.setItem("ds_theme", t); } catch (e) {}
  };

  /* วันเวลา (แสดงตามเวลาไทยเสมอ ปี ค.ศ.) */
  const mkf = (o) => new Intl.DateTimeFormat("th-TH-u-ca-gregory", { timeZone: TZ, ...o });
  const fD = mkf({ day: "numeric", month: "short", year: "numeric" }), fT = mkf({ hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const ok = (v) => v && !isNaN(new Date(v));
  const fmt = {
    date: (v) => (ok(v) ? fD.format(new Date(v)) : "-"),
    time: (v) => (ok(v) ? fT.format(new Date(v)) : "-"),
    dateTime: (v) => (ok(v) ? fD.format(new Date(v)) + " " + fT.format(new Date(v)) : "-"),
    ago: (v) => {
      if (!ok(v)) return "-";
      const s = Math.max(0, (Date.now() - new Date(v)) / 1000);
      if (s < 60) return "เมื่อสักครู่";
      if (s < 3600) return Math.floor(s / 60) + " นาทีที่แล้ว";
      if (s < 86400) return Math.floor(s / 3600) + " ชั่วโมงที่แล้ว";
      if (s < 604800) return Math.floor(s / 86400) + " วันที่แล้ว";
      return fD.format(new Date(v));
    },
  };

  /* toast */
  function toast(msg, type) {
    let box = document.querySelector(".toasts");
    if (!box) { box = document.createElement("div"); box.className = "toasts"; document.body.appendChild(box); }
    const t = document.createElement("div"); t.className = "toast" + (type && type !== "ok" ? " " + type : ""); t.textContent = msg; box.appendChild(t);
    setTimeout(() => t.remove(), type === "error" ? 5000 : 3000);
  }

  /* modal: คืน element .modal ที่มี .sb (เนื้อหา) — ปิดด้วย m.remove() */
  function modal(title, html) {
    const m = document.createElement("div"); m.className = "modal";
    m.innerHTML = `<div class="sheet"><div class="sh"><b>${esc(title)}</b><button class="x" aria-label="ปิด">✕</button></div><div class="sb">${html || ""}</div></div>`;
    m.addEventListener("click", (e) => { if (e.target === m) m.remove(); });
    m.querySelector(".x").onclick = () => m.remove();
    document.body.appendChild(m); return m;
  }

  /* รูปภาพใน bucket private → signed URL (แคชไว้) */
  const sc = new Map();
  async function signedUrl(path) {
    const hit = sc.get(path); if (hit && hit.exp > Date.now()) return hit.url;
    const { data, error } = await db.storage.from("plate-images").createSignedUrl(path, 3600); if (error) throw error;
    sc.set(path, { url: data.signedUrl, exp: Date.now() + 3300 * 1000 }); return data.signedUrl;
  }
  const thumb = (p) => (p ? `<img class="ph" data-p="${esc(p)}" alt="" loading="lazy">` : '<div class="ph"></div>');
  function hydrateImages(root) {
    (root || document).querySelectorAll("img[data-p]").forEach(async (img) => {
      const p = img.dataset.p; img.removeAttribute("data-p");
      try { img.src = await signedUrl(p); } catch (e) { img.style.visibility = "hidden"; }
    });
  }

  /* สิทธิ์: admin ทำได้ทุกอย่าง · staff บันทึก/แก้ไข · viewer ดูอย่างเดียว (RLS ในฐานข้อมูลบังคับอีกชั้น) */
  const can = (me, a) => !!me && (a === "read" ? true : a === "write" ? me.role === "admin" || me.role === "staff" : me.role === "admin");

  /* session + โปรไฟล์: คืน null ถ้ายังไม่ล็อกอิน, {session, profile:null} ถ้ายังไม่มีโปรไฟล์ */
  async function requireAuth() {
    const { data: { session }, error } = await db.auth.getSession();
    if (error || !session) return null;
    const { data: profile, error: pe } = await db.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
    if (pe) console.error("profiles:", pe);
    return { session, profile: profile || null };
  }

  /* OCR ผ่าน Edge Function (API key อยู่ฝั่งเซิร์ฟเวอร์เท่านั้น) */
  async function fnErr(error) {
    let code = "OCR_FAILED", msg = error.message || "เรียก OCR ไม่สำเร็จ";
    const ctx = error.context;
    if (error.name === "FunctionsHttpError" && ctx) {
      try { const j = await ctx.json(); msg = j.error || j.message || msg; code = j.code || code; } catch (e) {}
      if (ctx.status === 404) code = "NOT_DEPLOYED";
      else if (ctx.status === 401) { code = "UNAUTHORIZED"; msg = "เซสชันหมดอายุหรือไม่ได้รับอนุญาต กรุณาเข้าสู่ระบบใหม่"; }
    } else { code = "NOT_DEPLOYED"; msg = "เชื่อมต่อ Edge Function ไม่ได้ (ยังไม่ได้ deploy หรืออินเทอร์เน็ตมีปัญหา)"; }
    const e = new Error(msg); e.code = code; return e;
  }
  const b64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = () => rej(new Error("อ่านไฟล์ภาพไม่ได้")); r.readAsDataURL(blob); });
  async function readPlate(blob) {
    const { data, error } = await db.functions.invoke("ocr-plate", { body: { imageBase64: await b64(blob), mediaType: blob.type || "image/jpeg" } });
    if (error) throw await fnErr(error); return data;
  }
  async function pingOcr() {
    const { data, error } = await db.functions.invoke("ocr-plate", { body: { ping: true } });
    if (error) throw await fnErr(error); return data.provider;
  }

  const VEHICLE_TYPES = ["รถยนต์", "รถกระบะ", "รถบรรทุก", "รถจักรยานยนต์", "รถตู้", "อื่นๆ"];
  const PROVINCES = ["กรุงเทพมหานคร","กระบี่","กาญจนบุรี","กาฬสินธุ์","กำแพงเพชร","ขอนแก่น","จันทบุรี","ฉะเชิงเทรา","ชลบุรี","ชัยนาท","ชัยภูมิ","ชุมพร","เชียงราย","เชียงใหม่","ตรัง","ตราด","ตาก","นครนายก","นครปฐม","นครพนม","นครราชสีมา","นครศรีธรรมราช","นครสวรรค์","นนทบุรี","นราธิวาส","น่าน","บึงกาฬ","บุรีรัมย์","ปทุมธานี","ประจวบคีรีขันธ์","ปราจีนบุรี","ปัตตานี","พระนครศรีอยุธยา","พะเยา","พังงา","พัทลุง","พิจิตร","พิษณุโลก","เพชรบุรี","เพชรบูรณ์","แพร่","ภูเก็ต","มหาสารคาม","มุกดาหาร","แม่ฮ่องสอน","ยโสธร","ยะลา","ร้อยเอ็ด","ระนอง","ระยอง","ราชบุรี","ลพบุรี","ลำปาง","ลำพูน","เลย","ศรีสะเกษ","สกลนคร","สงขลา","สตูล","สมุทรปราการ","สมุทรสงคราม","สมุทรสาคร","สระแก้ว","สระบุรี","สิงห์บุรี","สุโขทัย","สุพรรณบุรี","สุราษฎร์ธานี","สุรินทร์","หนองคาย","หนองบัวลำภู","อ่างทอง","อำนาจเจริญ","อุดรธานี","อุตรดิตถ์","อุทัยธานี","อุบลราชธานี"];

  window.addEventListener("offline", () => toast("ออฟไลน์อยู่ — ตรวจสอบอินเทอร์เน็ต", "error"));
  window.addEventListener("online", () => toast("กลับมาออนไลน์แล้ว", "info"));

  window.DS = { db, esc, norm, toggleTheme, fmt, toast, modal, signedUrl, thumb, hydrateImages, can, requireAuth, readPlate, pingOcr, VEHICLE_TYPES, PROVINCES, TZ };

  if (keyMissing) document.addEventListener("DOMContentLoaded", () => {
    const d = document.createElement("div");
    d.style.cssText = "position:fixed;left:0;right:0;top:0;z-index:200;background:#dc2626;color:#fff;padding:10px 14px;font-size:14px;text-align:center";
    d.textContent = "ยังไม่ได้ตั้งค่า SUPABASE_KEY ใน config.js — ล็อกอินและโหลดข้อมูลไม่ได้";
    document.body.appendChild(d);
  });
})();
