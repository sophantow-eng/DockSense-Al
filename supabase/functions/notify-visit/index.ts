import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// แจ้งเตือน Telegram เมื่อรถของบริษัทที่ติดตาม (companies.notify_telegram) หรือทะเบียนใน watchlist เข้าพื้นที่
// secrets: TELEGRAM_BOT_TOKEN  (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY มีให้อัตโนมัติ)
// body: { visit_id } | { ping: true } | { test: true, chat_id } | { discover: true }
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const TZ = "Asia/Bangkok";

async function tg(token: string, method: string, payload: Record<string, unknown>) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.description || `Telegram ${r.status}`);
  return j.result;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
    const body = await req.json().catch(() => ({}));
    if (!token) return json({ error: "ยังไม่ได้ตั้งค่า TELEGRAM_BOT_TOKEN ใน Edge Function secrets", code: "TOKEN_MISSING" }, 503);

    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    // ตรวจผู้เรียก (verify_jwt เปิดอยู่แล้ว) และอ่านสิทธิ์จาก profiles
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await sb.auth.getUser(jwt);
    if (!u?.user) return json({ error: "Unauthorized" }, 401);
    const { data: prof } = await sb.from("profiles").select("role").eq("id", u.user.id).maybeSingle();
    const role = prof?.role;

    if (body.ping) {
      const me = await tg(token, "getMe", {});
      return json({ ok: true, bot: me.username });
    }

    // ผู้ดูแลเท่านั้นที่ทดสอบ/ค้นหา chat id ได้
    if (body.discover || body.test) {
      if (role !== "admin") return json({ error: "เฉพาะผู้ดูแลระบบ", code: "FORBIDDEN" }, 403);
      if (body.discover) {
        const ups = await tg(token, "getUpdates", { limit: 100, allowed_updates: ["message", "my_chat_member", "channel_post"] });
        const seen = new Map<string, { chat_id: string; title: string; type: string }>();
        for (const x of ups) {
          const c = x.message?.chat || x.channel_post?.chat || x.my_chat_member?.chat;
          if (c) seen.set(String(c.id), { chat_id: String(c.id), type: c.type, title: c.title || [c.first_name, c.last_name].filter(Boolean).join(" ") || c.username || String(c.id) });
        }
        return json({ chats: [...seen.values()] });
      }
      await tg(token, "sendMessage", { chat_id: body.chat_id, text: "✅ DockSense AI เชื่อมต่อ Telegram สำเร็จ\nจะแจ้งเตือนที่นี่เมื่อรถของบริษัทที่ติดตามเข้าพื้นที่" });
      return json({ ok: true });
    }

    if (!body.visit_id) return json({ error: "visit_id is required" }, 400);
    if (!["admin", "staff"].includes(role)) return json({ error: "Forbidden", code: "FORBIDDEN" }, 403);

    const { data: v } = await sb.from("visit_details").select("*").eq("id", body.visit_id).maybeSingle();
    if (!v) return json({ error: "ไม่พบรายการ" }, 404);
    const { data: log } = await sb.from("vehicle_logs").select("notified_at").eq("id", v.id).maybeSingle();
    if (log?.notified_at) return json({ skipped: "already_notified" });

    // เงื่อนไข: บริษัทเปิดแจ้งเตือน หรือทะเบียนอยู่ใน watchlist
    const { data: co } = v.company_id ? await sb.from("companies").select("notify_telegram").eq("id", v.company_id).maybeSingle() : { data: null };
    const { data: wl } = await sb.from("watchlist").select("channel_id,label").eq("plate_norm", v.plate_norm);
    const { data: chans } = await sb.from("notification_channels").select("*").eq("type", "telegram").eq("enabled", true);
    const targets = new Map<string, string>();
    for (const c of chans || []) {
      if (co?.notify_telegram && c.notify_mode === "all") targets.set(c.id, c.target);
      if ((wl || []).some((w) => !w.channel_id || w.channel_id === c.id)) targets.set(c.id, c.target);
    }
    if (!targets.size) return json({ skipped: "no_match" });

    const when = new Intl.DateTimeFormat("th-TH", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" }).format(new Date(v.capture_at));
    const lines = [
      `🚚 <b>รถเข้าพื้นที่</b>`,
      `ทะเบียน: <b>${esc(v.plate_number)}</b>${v.province ? " " + esc(v.province) : ""}`,
      v.company_name ? `บริษัท: <b>${esc(v.company_name)}</b>` : "",
      v.vehicle_type ? `ประเภท: ${esc(v.vehicle_type)}` : "",
      `เวลา: ${esc(when)}`,
      v.note ? `หมายเหตุ: ${esc(v.note)}` : "",
    ].filter(Boolean).join("\n");

    let photo: string | null = null;
    if (v.image_path) {
      const { data: s } = await sb.storage.from("plate-images").createSignedUrl(v.image_path, 600);
      photo = s?.signedUrl ?? null;
    }
    let sent = 0; const errs: string[] = [];
    for (const chat_id of new Set(targets.values())) {
      try {
        try {
          if (!photo) throw new Error("no photo");
          await tg(token, "sendPhoto", { chat_id, photo, caption: lines, parse_mode: "HTML" });
        } catch {
          await tg(token, "sendMessage", { chat_id, text: lines, parse_mode: "HTML" });
        }
        sent++;
      } catch (e) { errs.push((e as Error).message); }
    }
    if (sent) await sb.from("vehicle_logs").update({ notified_at: new Date().toISOString() }).eq("id", v.id);
    return json({ sent, errors: errs });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
