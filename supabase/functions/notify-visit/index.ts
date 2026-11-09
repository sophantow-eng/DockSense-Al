import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const TZ = "Asia/Bangkok";
const SITE = Deno.env.get("SITE_URL") || "https://docksense-al.vercel.app";

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
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const isService = jwt === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    let role: string | undefined;
    if (isService) role = "admin";
    else {
      const { data: u } = await sb.auth.getUser(jwt);
      if (!u?.user) return json({ error: "Unauthorized" }, 401);
      const { data: prof } = await sb.from("profiles").select("role").eq("id", u.user.id).maybeSingle();
      role = prof?.role;
    }
    const force = isService && body.force === true;

    if (body.ping) {
      const me = await tg(token, "getMe", {});
      return json({ ok: true, bot: me.username });
    }

    if (body.discover || body.test) {
      if (role !== "admin") return json({ error: "เฉพาะผู้ดูแลระบบ", code: "FORBIDDEN" }, 403);
      if (body.discover) {
        const seen = new Map<string, { chat_id: string; title: string; type: string }>();
        const { data: rows } = await sb.from("telegram_seen_chats").select("chat_id,title,type").order("seen_at", { ascending: false }).limit(50);
        for (const r of rows || []) seen.set(String(r.chat_id), { chat_id: String(r.chat_id), title: r.title || String(r.chat_id), type: r.type || "" });
        try {
          const ups = await tg(token, "getUpdates", { limit: 100, allowed_updates: ["message", "my_chat_member", "channel_post"] });
          for (const x of ups) {
            const c = x.message?.chat || x.channel_post?.chat || x.my_chat_member?.chat;
            if (c) seen.set(String(c.id), { chat_id: String(c.id), type: c.type, title: c.title || [c.first_name, c.last_name].filter(Boolean).join(" ") || c.username || String(c.id) });
          }
        } catch (_) { /* webhook active */ }
        return json({ chats: [...seen.values()] });
      }
      await tg(token, "sendMessage", { chat_id: body.chat_id, text: "✅ DockSense AI เชื่อมต่อ Telegram สำเร็จ\nจะแจ้งเตือนที่นี่เมื่อรถเข้าพื้นที่\nถามบอทได้ เช่น \"บอท ธห 7889 เข้ามาตอนไหน\" (พิมพ์ บอท นำหน้าในกลุ่ม)" });
      return json({ ok: true });
    }

    if (!body.visit_id) return json({ error: "visit_id is required" }, 400);
    if (!["admin", "staff"].includes(role as string)) return json({ error: "Forbidden", code: "FORBIDDEN" }, 403);

    const { data: v } = await sb.from("visit_details").select("*").eq("id", body.visit_id).maybeSingle();
    if (!v) return json({ error: "ไม่พบรายการ" }, 404);
    const { data: log } = await sb.from("vehicle_logs").select("notified_at").eq("id", v.id).maybeSingle();
    if (log?.notified_at) return json({ skipped: "already_notified" });

    const { data: co } = v.company_id ? await sb.from("companies").select("notify_telegram").eq("id", v.company_id).maybeSingle() : { data: null };
    const { data: wl } = await sb.from("watchlist").select("channel_id,label").eq("plate_norm", v.plate_norm);
    const { data: chans } = await sb.from("notification_channels").select("*").eq("type", "telegram").eq("enabled", true);
    // chat_id -> true ถ้าเป็นแชตลูกค้าเท่านั้น (ไม่มีแชตทีมงานที่ chat เดียวกัน)
    const targets = new Map<string, boolean>();
    const add = (c: { target: string; company_id?: string | null }) => { const prev = targets.get(c.target); targets.set(c.target, prev === undefined ? !!c.company_id : prev && !!c.company_id); };
    for (const c of chans || []) {
      // แชตลูกค้า: ได้เฉพาะรถของบริษัทตัวเอง และไม่ได้รับรายการที่รอตรวจสอบ
      if (c.company_id && (c.company_id !== v.company_id || v.status === "needs_review")) continue;
      if ((force || co?.notify_telegram) && c.notify_mode === "all") add(c);
      if ((wl || []).some((w) => !w.channel_id || w.channel_id === c.id)) add(c);
    }
    if (!targets.size) return json({ skipped: "no_match" });

    const when = new Intl.DateTimeFormat("th-TH", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" }).format(new Date(v.capture_at));
    const link = v.vehicle_id ? `${SITE}/#v=${v.vehicle_id}` : `${SITE}/#t=history`;
    // รถที่ยังไม่มีบริษัท/ข้อมูล (รถใหม่ หรือรถที่เคยบันทึกแต่ยังไม่ใส่บริษัท) → ขอให้ทีมงานเติมข้อมูล
    const needInfo = v.status !== "needs_review" && !!v.vehicle_id && !v.company_id;
    const reply_markup = { inline_keyboard: [[{ text: needInfo ? "✏️ ใส่ข้อมูลรถ" : "🔎 ดูข้อมูลรถ", url: link }]] };
    const carTxt = [v.vehicle_brand, v.vehicle_model].filter(Boolean).join(" ") + (v.vehicle_color ? ` (สี${v.vehicle_color})` : "");
    const head = `${v.source === "esp32" ? "📷" : "🚚"} <b>รถเข้าพื้นที่</b>${v.source === "esp32" ? " (กล้อง)" : ""}`;
    const core = [
      `ทะเบียน: <b>${esc(v.plate_number)}</b>${v.province ? " " + esc(v.province) : ""}`,
      v.company_name ? `บริษัท: <b>${esc(v.company_name)}</b>` : "",
      carTxt ? `รถ: ${esc(carTxt)}` : "",
      v.vehicle_type ? `ประเภท: ${esc(v.vehicle_type)}` : "",
      `เวลา: ${esc(when)}`,
    ];
    const linesTeam = [head, v.status === "needs_review" ? `⚠️ <b>AI ไม่แน่ใจ กรุณาตรวจทะเบียนในเว็บ</b>` : "", needInfo ? `🆕 <b>${v.status === "new_vehicle" ? "รถคันใหม่ ยังไม่มีข้อมูล" : "รถคันนี้ยังไม่ระบุบริษัท"}</b> — กดปุ่มด้านล่างเพื่อใส่บริษัท/ข้อมูลรถ` : "", ...core, v.note ? `หมายเหตุ: ${esc(v.note)}` : ""].filter(Boolean).join("\n");
    const linesCust = [head, ...core].filter(Boolean).join("\n"); // ลูกค้า: ไม่มีหมายเหตุภายใน และไม่มีปุ่มลิงก์เว็บทีมงาน

    let photo: string | null = null;
    if (v.image_path) {
      const { data: s } = await sb.storage.from("plate-images").createSignedUrl(v.image_path, 600);
      photo = s?.signedUrl ?? null;
    }
    let sent = 0; const errs: string[] = [];
    for (const [chat_id, custOnly] of targets) {
      const caption = custOnly ? linesCust : linesTeam;
      const markup = custOnly ? undefined : reply_markup;
      try {
        try {
          if (!photo) throw new Error("no photo");
          await tg(token, "sendPhoto", { chat_id, photo, caption, parse_mode: "HTML", ...(markup ? { reply_markup: markup } : {}) });
        } catch {
          await tg(token, "sendMessage", { chat_id, text: caption, parse_mode: "HTML", ...(markup ? { reply_markup: markup } : {}) });
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
