import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// บอท Telegram ตอบคำถามจากข้อความ เช่น "ธห 7889 เข้ามาตอนไหน" / "Kerry Express วันนี้กี่คัน" / "ขอรถสีดำ"
// ไม่ใช้ AI (ไม่กินโควตา) — ตีความด้วยกฎ แล้วค้นฐานข้อมูลตรงๆ
// ตอบเฉพาะแชตที่ผูกไว้ในเว็บ (notification_channels) เท่านั้น
// แชตลูกค้า (channel.company_id มีค่า): เห็นเฉพาะรถของบริษัทนั้น และไม่เห็นรายการที่รอตรวจสอบ
const TZ = "Asia/Bangkok";
const H7 = 7 * 3600e3;
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmtDT = (d: string) => new Intl.DateTimeFormat("th-TH", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" }).format(new Date(d)) + " น.";
const dayStart = (off = 0) => { const d = new Date(Date.now() + H7); d.setUTCHours(0, 0, 0, 0); return new Date(d.getTime() + off * 86400e3 - H7); };
const monthStart = () => { const d = new Date(Date.now() + H7); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - H7); };

// อิโมจิวงกลมตามสีรถ (ไม่รู้จักสี → ไม่ใส่)
const COLOR_EMOJI: [RegExp, string][] = [
  [/ดำ|black/i, "⚫"], [/ขาว|ครีม|white|ivory/i, "⚪"], [/แดง|บรอนซ์แดง|red|maroon/i, "🔴"],
  [/ส้ม|orange/i, "🟠"], [/เหลือง|ทอง|yellow|gold/i, "🟡"], [/เขียว|green/i, "🟢"],
  [/น้ำเงิน|ฟ้า|คราม|blue/i, "🔵"], [/ม่วง|purple|violet/i, "🟣"], [/ชมพู|pink/i, "🩷"],
  [/น้ำตาล|กาแฟ|brown/i, "🟤"], [/เทา|เงิน|บรอนซ์|gr[ae]y|silver/i, "🩶"],
];
const colorEmoji = (c?: string | null) => { const s = String(c ?? ""); for (const [re, e] of COLOR_EMOJI) if (re.test(s)) return e; return ""; };

type Car = { vehicle_brand?: string | null; vehicle_model?: string | null; vehicle_color?: string | null };
const car = (r: Car) => [r.vehicle_brand, r.vehicle_model].filter(Boolean).join(" ") + (r.vehicle_color ? ` (${colorEmoji(r.vehicle_color)} สี${String(r.vehicle_color).replace(/^สี/, "")})`.replace("( ", "(") : "");

type Range = { from?: Date; to?: Date; label: string; multi: boolean };
function parseRange(t: string): Range | null {
  if (/เมื่อวาน/.test(t)) return { from: dayStart(-1), to: dayStart(0), label: "เมื่อวาน", multi: false };
  if (/วันนี้|today/i.test(t)) return { from: dayStart(0), to: dayStart(1), label: "วันนี้", multi: false };
  if (/สัปดาห์|อาทิตย์|7 ?วัน/.test(t)) return { from: dayStart(-6), to: dayStart(1), label: "7 วันล่าสุด", multi: true };
  if (/เดือนนี้/.test(t)) return { from: monthStart(), to: dayStart(1), label: "เดือนนี้", multi: true };
  if (/ทั้งหมด|ตลอด|ทุกวัน/.test(t)) return { label: "ทั้งหมด", multi: true };
  return null;
}

function findPlate(t: string): { norm: string } | null {
  const s = t.replace(/[๐-๙]/g, (d) => String("๐๑๒๓๔๕๖๗๘๙".indexOf(d)));
  let m = s.match(/(?<![ก-๙\d])(\d{1,2})?\s?([ก-ฮ]{1,3})\s?-?\s?(\d{1,4})(?!\d)/);
  if (m) return { norm: `${m[1] ?? ""}${m[2]}${m[3]}`.toUpperCase() };
  m = s.match(/(?<!\d)(\d{2})\s?-\s?(\d{4})(?!\d)/);
  if (m) return { norm: `${m[1]}${m[2]}` };
  m = s.match(/(?<![\d-])(\d{3,4})(?!\d)/);
  if (m) return { norm: m[1] };
  return null;
}

const HELP = `🤖 <b>DockSense บอท</b> ถามได้เลย เช่น
• <code>ธห 7889 เข้ามาตอนไหน</code>
• <code>ขอดูรูป ธห 7889</code> (ส่งรูปล่าสุดของรถคันนั้น)
• <code>7889 เข้ากี่ครั้ง</code> (ใส่เฉพาะเลขก็ได้)
• <code>Kerry Express วันนี้มากี่คัน</code>
• <code>สรุปวันนี้</code>
• <code>ขอรถสีดำ</code> · <code>รถ Audi</code> · <code>ขอรถที่มีสี</code> (ค้นจากสี ยี่ห้อ รุ่น)

ช่วงเวลาที่ใช้ได้: วันนี้ · เมื่อวาน · 7 วัน · เดือนนี้ · ทั้งหมด
ในกลุ่ม ให้พิมพ์ขึ้นต้นว่า <code>บอท</code> หรือ @ชื่อบอท หรือกดตอบข้อความของบอท`;
const HELP_CUST = `🤖 <b>DockSense บอท</b> ถามได้เฉพาะรถของบริษัทคุณ เช่น
• <code>วันนี้มากี่คัน</code>
• <code>สัปดาห์นี้</code> · <code>เดือนนี้</code>
• <code>ธห 7889 เข้ามาตอนไหน</code>
• <code>ขอดูรูป ธห 7889</code>
• <code>ขอรถสีดำ</code> · <code>รถ Isuzu</code>
ในกลุ่ม ให้พิมพ์ขึ้นต้นว่า <code>บอท</code> หรือกดตอบข้อความของบอท`;

// deno-lint-ignore no-explicit-any
type SB = any;
type Scope = string[] | null; // null = ทีมงาน (เห็นทุกบริษัท) · อาเรย์ = แชตลูกค้า (เห็นเฉพาะ company_id ที่อนุญาต)
const CAR_COLS = "vehicle_brand,vehicle_model,vehicle_color";
// deno-lint-ignore no-explicit-any
const scoped = (q: any, scope: Scope) => (scope ? q.in("company_id", scope).neq("status", "needs_review") : q);
// บรรทัดรถ: อิโมจิสีนำหน้า (ถ้าไม่รู้จักสีใช้ 🚗)
const carLine = (r: Car) => (car(r) ? `${colorEmoji(r.vehicle_color) || "🚗"} ${esc(car(r))}` : "");

async function byPlate(sb: SB, p: { norm: string }, range: Range | null, scope: Scope): Promise<string> {
  let q = sb.from("visit_details").select(`plate_number,province,company_name,capture_at,status,${CAR_COLS}`).ilike("plate_norm", `%${p.norm}%`).order("capture_at", { ascending: false }).limit(300);
  q = scoped(q, scope);
  if (range?.from) q = q.gte("capture_at", range.from.toISOString());
  if (range?.to) q = q.lt("capture_at", range.to.toISOString());
  const { data, error } = await q;
  if (error) return "ค้นหาไม่สำเร็จ: " + esc(error.message);
  const where = range ? ` ใน${range.label}` : "";
  if (!data?.length) return `ไม่พบทะเบียน <b>${esc(p.norm)}</b>${where} ${scope ? "ในรถของบริษัทคุณ" : "ในระบบ"}`;
  // deno-lint-ignore no-explicit-any
  const groups = new Map<string, any[]>();
  for (const r of data) { const k = r.plate_number; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(r); }
  const more = data.length >= 300 ? "+" : "";
  if (groups.size === 1) {
    const [plate, rows] = [...groups.entries()][0];
    const f = rows[0];
    const out = [
      `🔎 <b>${esc(plate)}</b>${f.province ? " " + esc(f.province) : ""}${f.company_name ? " · " + esc(f.company_name) : ""}`,
      carLine(f),
      `เข้า <b>${rows.length}${more}</b> ครั้ง${where}`,
      "",
      ...rows.slice(0, 15).map((r) => `• ${esc(fmtDT(r.capture_at))}${r.status === "needs_review" ? " ⚠️รอตรวจสอบ" : ""}`),
    ].filter((x, i) => x !== "" || i > 2);
    if (rows.length > 15) out.push(`…และอีก ${rows.length - 15} ครั้ง (พิมพ์ วันนี้ / 7 วัน / เดือนนี้ ต่อท้ายเพื่อแยกช่วง)`);
    out.push("", `📷 พิมพ์ <code>ขอดูรูป ${esc(plate)}</code> เพื่อดูภาพล่าสุด`);
    return out.join("\n");
  }
  const lines = [...groups.entries()].slice(0, 10).map(([plate, rows]) => `• <b>${esc(plate)}</b>${rows[0].company_name ? " · " + esc(rows[0].company_name) : ""}${car(rows[0]) ? "\n   " + carLine(rows[0]) : ""}\n   ${rows.length} ครั้ง · ล่าสุด ${esc(fmtDT(rows[0].capture_at))}`);
  return `🔎 พบ ${groups.size} ทะเบียนที่ตรงกับ <b>${esc(p.norm)}</b>${where}\n${lines.join("\n")}${groups.size > 10 ? `\n…และอีก ${groups.size - 10} ทะเบียน` : ""}\n\nพิมพ์ทะเบียนให้ครบเพื่อดูทุกครั้งที่เข้า`;
}

async function plateImage(sb: SB, p: { norm: string }, scope: Scope): Promise<{ url: string; caption: string } | string> {
  let q = sb.from("visit_details").select(`plate_number,province,company_name,capture_at,image_path,${CAR_COLS}`).ilike("plate_norm", `%${p.norm}%`).not("image_path", "is", null).order("capture_at", { ascending: false }).limit(1);
  q = scoped(q, scope);
  const { data, error } = await q;
  if (error) return "ค้นหาไม่สำเร็จ: " + esc(error.message);
  const r = data?.[0];
  if (!r) return `ไม่พบรูปของทะเบียน <b>${esc(p.norm)}</b>`;
  const { data: s } = await sb.storage.from("plate-images").createSignedUrl(r.image_path, 600);
  if (!s?.signedUrl) return "ไม่สามารถเปิดรูปได้ในขณะนี้";
  const caption = [`🔎 <b>${esc(r.plate_number)}</b>${r.province ? " " + esc(r.province) : ""}`, r.company_name ? `บริษัท: ${esc(r.company_name)}` : "", carLine(r), `เวลา: ${esc(fmtDT(r.capture_at))}`].filter(Boolean).join("\n");
  return { url: s.signedUrl, caption };
}

type Co = { id: string; company_name: string };
async function loadCompanies(sb: SB, scope: Scope): Promise<Co[]> {
  let q = sb.from("companies").select("id,company_name");
  if (scope) q = q.in("id", scope);
  return (await q).data || [];
}
function findCompany(cos: Co[], low: string): Co | null {
  let best: Co | null = null, bs = 0;
  for (const c of cos) {
    const n = String(c.company_name || "").toLowerCase().trim(); if (!n) continue;
    let sc = 0;
    if (low.includes(n)) sc = 100 + n.length;
    else for (const w of n.split(/[\s\-_.()]+/).filter((x) => x.length >= 3)) if (low.includes(w)) sc = Math.max(sc, w.length);
    if (sc > bs) { bs = sc; best = c; }
  }
  return best;
}

// ค้นจากสี / ยี่ห้อ / รุ่น เช่น "ขอรถสีดำ" "รถ Audi" "ขอรถที่มีสี"
type Attr = { color?: string; brand?: string; model?: string; anyColor?: boolean; anyBrand?: boolean; anyModel?: boolean };
const COLOR_STOP = new Set(["อะไร", "อะไรบ้าง", "ไหน", "บ้าง", "ใด", "ใดบ้าง", "ของ", "ไหนบ้าง"]);
async function parseAttr(sb: SB, t: string, scope: Scope): Promise<Attr | null> {
  const low = t.toLowerCase();
  const a: Attr = {};
  if (/ที่มีสี|ที่ระบุสี|มีข้อมูลสี|มีสี\s*$/.test(t)) a.anyColor = true;
  if (/ที่มียี่ห้อ|ที่ระบุยี่ห้อ|มียี่ห้อ\s*$/.test(t)) a.anyBrand = true;
  if (/ที่มีรุ่น|ที่ระบุรุ่น|มีรุ่น\s*$/.test(t)) a.anyModel = true;
  let q = sb.from("vehicles").select("brand,model,color").limit(2000);
  if (scope) q = q.in("company_id", scope);
  const { data } = await q;
  const best: Record<string, string> = {};
  for (const r of data || []) {
    for (const k of ["color", "brand", "model"] as const) {
      const v = String(r[k] ?? "").trim();
      if (v.length >= 2 && low.includes(v.toLowerCase()) && v.length > (best[k]?.length ?? 0)) best[k] = v;
    }
  }
  if (best.color) a.color = best.color.replace(/^สี/, "");
  if (best.brand) a.brand = best.brand;
  if (best.model) a.model = best.model;
  if (!a.color && !a.anyColor) {
    const m = low.match(/สี\s?([ก-ฮ][ก-๎]{1,})/);
    if (m && !COLOR_STOP.has(m[1])) a.color = m[1];
  }
  return Object.keys(a).length ? a : null;
}

async function byAttr(sb: SB, a: Attr, range: Range | null, scope: Scope, companyId?: string): Promise<string> {
  let q = sb.from("visit_details").select(`plate_number,company_name,capture_at,status,${CAR_COLS}`).order("capture_at", { ascending: false }).limit(1000);
  q = scoped(q, scope);
  if (companyId) q = q.eq("company_id", companyId);
  if (a.color) q = q.ilike("vehicle_color", `%${a.color}%`); else if (a.anyColor) q = q.not("vehicle_color", "is", null);
  if (a.brand) q = q.ilike("vehicle_brand", `%${a.brand}%`); else if (a.anyBrand) q = q.not("vehicle_brand", "is", null);
  if (a.model) q = q.ilike("vehicle_model", `%${a.model}%`); else if (a.anyModel) q = q.not("vehicle_model", "is", null);
  if (range?.from) q = q.gte("capture_at", range.from.toISOString());
  if (range?.to) q = q.lt("capture_at", range.to.toISOString());
  const { data, error } = await q;
  if (error) return "ค้นหาไม่สำเร็จ: " + esc(error.message);
  const what = [a.color ? `สี${a.color}` : a.anyColor ? "ที่ระบุสีไว้" : "", a.brand ? `ยี่ห้อ ${a.brand}` : a.anyBrand ? "ที่ระบุยี่ห้อไว้" : "", a.model ? `รุ่น ${a.model}` : a.anyModel ? "ที่ระบุรุ่นไว้" : ""].filter(Boolean).join(" · ");
  const when = range ? ` (${range.label})` : "";
  const head = `${colorEmoji(a.color) || "🚗"} <b>รถ ${esc(what)}</b>${when}`;
  if (!data?.length) return `${head}\nไม่พบรถที่ตรงกับที่ขอ\n(รถที่ไม่ได้กรอกข้อมูลนี้ไว้จะไม่ขึ้น กรอกได้ในเว็บ หน้ารายละเอียดรถ)`;
  // deno-lint-ignore no-explicit-any
  const g = new Map<string, any[]>();
  for (const r of data) { if (!g.has(r.plate_number)) g.set(r.plate_number, []); g.get(r.plate_number)!.push(r); }
  const items = [...g.entries()].slice(0, 25).map(([plate, rows]) => `${colorEmoji(rows[0].vehicle_color) || "•"} <b>${esc(plate)}</b>${rows[0].company_name ? " · " + esc(rows[0].company_name) : ""}\n   ${esc(car(rows[0]) || "-")} · เข้า ${rows.length} ครั้ง\n   ล่าสุด ${esc(fmtDT(rows[0].capture_at))}`);
  return `${head}\nพบ <b>${g.size}</b> คัน (เข้า ${data.length} ครั้ง)\n\n${items.join("\n")}${g.size > 25 ? `\n…และอีก ${g.size - 25} คัน` : ""}`;
}

const MAXLINES = 30;

async function byCompany(sb: SB, co: Co, range0: Range | null, scope: Scope): Promise<string> {
  const range: Range = range0 ?? { from: dayStart(0), to: dayStart(1), label: "วันนี้", multi: false };
  let q = sb.from("visit_details").select(`plate_number,capture_at,status,${CAR_COLS}`).eq("company_id", co.id).order("capture_at", { ascending: false }).limit(1000);
  q = scoped(q, scope);
  if (range.from) q = q.gte("capture_at", range.from.toISOString());
  if (range.to) q = q.lt("capture_at", range.to.toISOString());
  const { data, error } = await q;
  if (error) return "ค้นหาไม่สำเร็จ: " + esc(error.message);
  if (!data?.length) return `🏢 <b>${esc(co.company_name)}</b>\nไม่มีรถเข้า${range.label === "ทั้งหมด" ? "เลย" : "ใน" + range.label}${range0 ? "" : "\n(ลองพิมพ์เพิ่มว่า สัปดาห์นี้ หรือ ทั้งหมด)"}`;
  const plates = new Set(data.map((r: { plate_number: string }) => r.plate_number));
  const items = data.slice(0, MAXLINES).map((r: { plate_number: string; capture_at: string; status: string } & Car) => `${colorEmoji(r.vehicle_color) || "•"} <b>${esc(r.plate_number)}</b>${car(r) ? " · " + esc(car(r)) : ""}\n   ${esc(fmtDT(r.capture_at))}${r.status === "needs_review" ? " ⚠️" : ""}`);
  return `🏢 <b>${esc(co.company_name)}</b> — ${range.label}\nรถ <b>${plates.size}</b> คัน (เข้า ${data.length} ครั้ง)\n\n${items.join("\n")}${data.length > MAXLINES ? `\n…และอีก ${data.length - MAXLINES} ครั้ง` : ""}`;
}

async function summary(sb: SB, range0: Range | null, scope: Scope): Promise<string> {
  const range: Range = range0 ?? { from: dayStart(0), to: dayStart(1), label: "วันนี้", multi: false };
  let q = sb.from("visit_details").select(`plate_number,company_name,capture_at,status,${CAR_COLS}`).order("capture_at", { ascending: false }).limit(2000);
  q = scoped(q, scope);
  if (range.from) q = q.gte("capture_at", range.from.toISOString());
  if (range.to) q = q.lt("capture_at", range.to.toISOString());
  const { data, error } = await q;
  if (error) return "ค้นหาไม่สำเร็จ: " + esc(error.message);
  if (!data?.length) return `📊 ${range.label}: ยังไม่มีรถเข้า`;
  const plates = new Set(data.map((r: { plate_number: string }) => r.plate_number));
  const byCo = new Map<string, number>();
  for (const r of data) { const k = r.company_name || "ไม่ระบุบริษัท"; byCo.set(k, (byCo.get(k) || 0) + 1); }
  const cos = [...byCo.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, n]) => `• ${esc(k)} — ${n} ครั้ง`);
  const items = data.slice(0, MAXLINES).map((r: { plate_number: string; company_name: string | null; capture_at: string; status: string } & Car) => `${colorEmoji(r.vehicle_color) || "•"} <b>${esc(r.plate_number)}</b>${r.company_name ? " · " + esc(r.company_name) : ""}${car(r) ? "\n   " + esc(car(r)) : ""}\n   ${esc(fmtDT(r.capture_at))}${r.status === "needs_review" ? " ⚠️" : ""}`);
  return `📊 <b>สรุป${range.label}</b>\nรถ ${plates.size} คัน (เข้า ${data.length} ครั้ง)\n${cos.join("\n")}\n\n<b>รายการ (ล่าสุดก่อน)</b>\n${items.join("\n")}${data.length > MAXLINES ? `\n…และอีก ${data.length - MAXLINES} ครั้ง` : ""}`;
}

async function answer(sb: SB, text: string, scope: Scope): Promise<string> {
  const t = text.trim();
  const help = scope ? HELP_CUST : HELP;
  if (!t || /^(help|start|ช่วยเหลือ|วิธีใช้|ทำอะไรได้|คำสั่ง)/i.test(t)) return help;
  const range = parseRange(t);
  const pl = findPlate(t);
  if (pl) return await byPlate(sb, pl, range, scope);
  const cos = await loadCompanies(sb, scope);
  const co = findCompany(cos, t.toLowerCase());
  const at = await parseAttr(sb, t, scope);
  if (at) return await byAttr(sb, at, range, scope, co?.id);
  if (co) return await byCompany(sb, co, range, scope);
  const asks = /สรุป|กี่คัน|ทั้งหมด|รายงาน|รายละเอียด|เวลา|รายการ|รถ/.test(t) || !!range;
  if (asks && scope && cos.length === 1) return await byCompany(sb, cos[0], range, scope);
  if (asks) return await summary(sb, range, scope);
  return "ยังไม่เข้าใจคำถามครับ 🙏\n\n" + help;
}

async function sha(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 48);
}
const jres = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
let botUser = "";

Deno.serve(async (req) => {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!token) return new Response("no token", { status: 503 });
  const secret = await sha("ds-bot:" + token);
  const base = `${Deno.env.get("SUPABASE_URL")}/functions/v1/telegram-bot`;
  const api = (m: string, body: unknown) => fetch(`https://api.telegram.org/bot${token}/${m}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  if (req.method === "GET") {
    const u = new URL(req.url);
    if (u.searchParams.get("setup") === "1") {
      const r = await (await api("setWebhook", { url: base, secret_token: secret, allowed_updates: ["message", "my_chat_member"], drop_pending_updates: false })).json();
      return jres({ ok: r.ok, result: r.description || r.result, webhook: base });
    }
    if (u.searchParams.get("remove") === "1") {
      const r = await (await api("deleteWebhook", {})).json();
      return jres({ ok: r.ok, result: r.description || r.result });
    }
    if (u.searchParams.get("status") === "1") {
      const r = await (await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`)).json();
      const i = r.result || {};
      return jres({ ok: r.ok, url: i.url, pending: i.pending_update_count, last_error: i.last_error_message, last_error_at: i.last_error_date });
    }
    return new Response("DockSense bot webhook", { status: 200 });
  }
  if (req.method !== "POST") return new Response("ok");
  if (req.headers.get("x-telegram-bot-api-secret-token") !== secret) return new Response("unauthorized", { status: 401 });

  try {
    const up = await req.json();
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const chat = up.message?.chat || up.my_chat_member?.chat;
    if (chat) {
      const title = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username || String(chat.id);
      await sb.from("telegram_seen_chats").upsert({ chat_id: String(chat.id), title, type: chat.type, seen_at: new Date().toISOString() });
    }
    const msg = up.message;
    if (!msg?.text || !chat) return new Response("ok");

    const { data: chans } = await sb.from("notification_channels").select("target,company_id").eq("type", "telegram").eq("enabled", true);
    const mine = (chans || []).filter((c: { target: string }) => String(c.target) === String(chat.id));
    if (!mine.length) return new Response("ok");
    const scope: Scope = mine.every((c: { company_id: string | null }) => c.company_id) ? [...new Set<string>(mine.map((c: { company_id: string }) => c.company_id))] : null;

    if (!botUser) { try { botUser = (await (await fetch(`https://api.telegram.org/bot${token}/getMe`)).json()).result?.username || ""; } catch (_) { /* ignore */ } }
    const raw: string = msg.text;
    const isPrivate = chat.type === "private";
    const isCmd = raw.startsWith("/");
    const mentioned = !!botUser && raw.toLowerCase().includes("@" + botUser.toLowerCase());
    const replyToBot = !!msg.reply_to_message?.from?.is_bot;
    const named = /^\s*(บอท|bot)/i.test(raw);
    if (!(isPrivate || isCmd || mentioned || replyToBot || named)) return new Response("ok");

    let text = raw;
    if (botUser) text = text.replace(new RegExp("@" + botUser, "ig"), "");
    text = text.replace(/^\/\w+(@\w+)?\s*/, (m) => (/^\/(start|help)/i.test(m) ? "help " : "")).replace(/^\s*(บอท|bot)[\s,:]*/i, "").trim();

    const reply_to = { reply_to_message_id: msg.message_id, allow_sending_without_reply: true };
    if (/รูป|ภาพ|photo|pic/i.test(text)) {
      const pl = findPlate(text);
      if (pl) {
        const r = await plateImage(sb, pl, scope);
        if (typeof r === "string") await api("sendMessage", { chat_id: chat.id, text: r, parse_mode: "HTML", ...reply_to });
        else {
          const sent = await (await api("sendPhoto", { chat_id: chat.id, photo: r.url, caption: r.caption, parse_mode: "HTML", ...reply_to })).json();
          if (!sent.ok) await api("sendMessage", { chat_id: chat.id, text: r.caption + "\n\n(ส่งรูปไม่สำเร็จ)", parse_mode: "HTML", ...reply_to });
        }
        return new Response("ok");
      }
      await api("sendMessage", { chat_id: chat.id, text: "บอกทะเบียนด้วยนะครับ เช่น <code>บอท ขอดูรูป ธห 7889</code>", parse_mode: "HTML", ...reply_to });
      return new Response("ok");
    }
    const reply = await answer(sb, text, scope);
    await api("sendMessage", { chat_id: chat.id, text: reply.slice(0, 3900), parse_mode: "HTML", disable_web_page_preview: true, ...reply_to });
  } catch (e) {
    console.error("telegram-bot", (e as Error).message);
  }
  return new Response("ok");
});
