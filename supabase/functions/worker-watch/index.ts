import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { decideWatch, fmtDur } from "./decide.ts";

// เฝ้าคอมแรง (EasyOCR+YOLO): ไม่เห็นสัญญาณเกิน 10 นาที → แจ้ง Telegram "ช่องทางทีมงาน" ครั้งเดียว · กลับมา → แจ้งอีกครั้ง
// เรียกจาก pg_cron ทุก 5 นาที ด้วยกุญแจ x-watch-key (สิทธิ์ต่ำ: เรียกได้แค่ฟังก์ชันนี้ ซึ่งส่งแจ้งเตือนทีมงานอย่างเดียว) · ?dry=1 / {"dry":true} = ดูผลตัดสินโดยไม่ส่ง
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "x-watch-key, content-type" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const SITE = Deno.env.get("SITE_URL") || "https://docksense-al.vercel.app";
const bkk = (iso: string | null) => iso ? new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)) : "ไม่ทราบ";

async function tg(token: string, chat_id: string, text: string) {
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ chat_id, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.description || `Telegram ${r.status}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const key = req.headers.get("x-watch-key") || "";
  if (!key) return json({ error: "unauthorized" }, 401);
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const { data: kr } = await sb.from("ai_queue_keys").select("role").eq("key_hash", await sha(key)).eq("role", "watch").maybeSingle();
    if (!kr) return json({ error: "unauthorized" }, 401);
    const body = await req.json().catch(() => ({}));
    const dry = body?.dry === true || new URL(req.url).searchParams.get("dry") === "1";

    const { data: w } = await sb.from("ai_queue_keys").select("last_seen").eq("role", "worker").maybeSingle();
    const { data: row } = await sb.from("app_settings").select("value").eq("key", "worker_watch").maybeSingle();
    const st = (row?.value ?? null) as { state?: "online" | "offline"; since?: string | null } | null;
    const now = Date.now();
    const act = decideWatch(w?.last_seen ?? null, now, st);
    if (dry) return json({ dry: true, last_seen: w?.last_seen ?? null, state: st, decision: act });

    const save = (value: Record<string, unknown>) => sb.from("app_settings").upsert({ key: "worker_watch", value }, { onConflict: "key" });
    if (act.action === "none") return json({ ok: true, decision: "none" });
    if (act.action === "init_online") { await save({ state: "online", since: null }); return json({ ok: true, decision: "init_online" }); }

    const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
    if (!token) return json({ error: "TOKEN_MISSING", decision: act.action }, 503);   // ไม่บันทึกสถานะ → รอบหน้าลองใหม่
    // เฉพาะช่องทางทีมงาน (ไม่ส่งเข้าแชตลูกค้า)
    const { data: chans } = await sb.from("notification_channels").select("target").eq("type", "telegram").eq("enabled", true).is("company_id", null);
    const targets = [...new Set((chans || []).map((c: { target: string }) => String(c.target)).filter(Boolean))];
    if (!targets.length) return json({ ok: true, decision: act.action, sent: 0, note: "no_team_channels" });

    const text = act.action === "alert"
      ? [
        "⚠️ <b>คอมแรง (EasyOCR + YOLO) ออฟไลน์</b>",
        `ไม่เห็นสัญญาณมาแล้ว ${fmtDur(act.minutes)} (ล่าสุด ${bkk(act.since)})`,
        "",
        "ระหว่างนี้ระบบอ่านทะเบียนด้วย Gemini คนเดียว ซึ่งยังไม่แม่นเท่า: จะ <b>ไม่ลงทะเบียนรถใหม่เอง</b> รายการที่ไม่มีเครื่องที่สองยืนยันจะรอตรวจ และระบบจะอ่านซ้ำให้เมื่อคอมกลับมา",
        "",
        "วิธีแก้: เปิดแล็ปท็อปและเช็กว่าไม่ได้หลับ แล้วรัน <code>autostart.ps1 start</code> (ตรวจด้วย <code>autostart.ps1 status</code>)",
        `ดูรายการรอตรวจ: ${SITE}/#t=history`,
      ].join("\n")
      : `🟢 <b>คอมแรงกลับมาออนไลน์แล้ว</b>\nหายไปประมาณ ${fmtDur(act.downMinutes)}\nระบบกำลังอ่านซ้ำรายการที่ค้างรอตรวจ (ย้อนหลัง 48 ชม.) ให้อัตโนมัติ`;

    let sent = 0; const errs: string[] = [];
    for (const t of targets) { try { await tg(token, t, text); sent++; } catch (e) { errs.push((e as Error).message); } }
    if (sent) await save(act.action === "alert" ? { state: "offline", since: act.since, alerted_at: new Date().toISOString() } : { state: "online", since: null, recovered_at: new Date().toISOString() });
    return json({ ok: sent > 0, decision: act.action, sent, errors: errs });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
