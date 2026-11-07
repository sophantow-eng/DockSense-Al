import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

// รับรูปจาก ESP32-CAM: POST image/jpeg + header x-device-key  →  OCR → บันทึก → แจ้ง Telegram
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "x-device-key, x-local-ip, content-type",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const url = Deno.env.get("SUPABASE_URL")!, svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(url, svc);
  try {
    const key = req.headers.get("x-device-key") || new URL(req.url).searchParams.get("key") || "";
    if (!key) return json({ error: "missing device key" }, 401);
    const { data: dev } = await sb.from("camera_devices").select("*").eq("device_key", key).eq("enabled", true).maybeSingle();
    if (!dev) return json({ error: "invalid device key" }, 401);
    await sb.from("camera_devices").update({ last_seen: new Date().toISOString() }).eq("id", dev.id);

    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length < 2000) return json({ error: "image too small" }, 400);
    if (bytes.length > 3_000_000) return json({ error: "image too large" }, 413);
    if (!(bytes[0] === 0xff && bytes[1] === 0xd8)) return json({ error: "JPEG only" }, 415);

    // 1) อ่านทะเบียน
    // ภาพตัวอย่างสำหรับหน้าเว็บ “ดูกล้อง” (ไม่อ่านทะเบียน ไม่บันทึกประวัติ)
    if (new URL(req.url).searchParams.get("preview") === "1") {
      const watching = !!dev.watch_until && new Date(dev.watch_until) > new Date();
      const ip = (req.headers.get("x-local-ip") || "").slice(0, 45);
      const upd: Record<string, unknown> = { preview_at: new Date().toISOString() };
      if (ip && ip !== dev.local_ip) upd.local_ip = ip;
      if (watching) {
        // มีคนดูอยู่: ส่งภาพเข้า Realtime ให้ทุกคนทันที (ลื่น) ไม่ต้องเขียน Storage ทุกเฟรม
        const r = await fetch(`${url}/realtime/v1/api/broadcast`, {
          method: "POST", headers: { apikey: svc, Authorization: `Bearer ${svc}`, "Content-Type": "application/json" },
          body: JSON.stringify({ messages: [{ topic: `live:${dev.id}`, event: "frame", private: false, payload: { b: encodeBase64(bytes), t: Date.now() } }] }),
        }).catch(() => null);
        if (!r || !r.ok) await sb.storage.from("plate-images").upload(`camera/${dev.id}/latest.jpg`, bytes, { contentType: "image/jpeg", upsert: true, cacheControl: "1" });
      } else {
        const pv = await sb.storage.from("plate-images").upload(`camera/${dev.id}/latest.jpg`, bytes, { contentType: "image/jpeg", upsert: true, cacheControl: "1" });
        if (pv.error) return json({ error: pv.error.message }, 500);
      }
      await sb.from("camera_devices").update(upd).eq("id", dev.id);
      return json({ ok: true, watch: watching, next_ms: watching ? 1000 : 15000 });
    }

    const ocrRes = await fetch(`${url}/functions/v1/ocr-plate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${svc}`, apikey: svc, "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64: encodeBase64(bytes), mediaType: "image/jpeg" }),
    });
    const ocr = await ocrRes.json();
    if (!ocrRes.ok) return json({ error: ocr.error || "OCR failed", code: ocr.code }, 502);
    if (!ocr.found || !ocr.plate) return json({ ok: true, found: false });

    const { data: th } = await sb.from("app_settings").select("value").eq("key", "ocr_thresholds").maybeSingle();
    const high = Number(th?.value?.high ?? 0.85), low = Number(th?.value?.low ?? 0.6);
    const conf = Number(ocr.confidence ?? 0);
    if (conf < low) return json({ ok: true, found: true, ignored: "low_confidence", plate: ocr.plate, confidence: conf });

    // 2) เก็บรูป
    const path = `camera/${dev.id}/${Date.now()}.jpg`;
    const up = await sb.storage.from("plate-images").upload(path, bytes, { contentType: "image/jpeg" });
    if (up.error) return json({ error: up.error.message }, 500);
    const drop = () => sb.storage.from("plate-images").remove([path]);

    // 3) บันทึก
    let visitId: string | null = null, status: string, vehicleId: string | null = null;
    if (conf >= high && !ocr.needs_review) {
      const { data, error } = await sb.rpc("record_visit", {
        p_plate: ocr.plate, p_province: ocr.province, p_vehicle_type: ocr.vehicle_type, p_note: `กล้อง: ${dev.name}`,
        p_image_path: path, p_confidence: conf, p_provider: ocr.provider ?? null, p_source: "esp32",
        p_vehicle_id: null, p_company_id: null, p_new_company_name: null, p_register: true, p_verified: false,
      });
      if (error) { await drop(); return json({ error: error.message }, 500); }
      if (data.duplicate) { await drop(); return json({ ok: true, duplicate: true, plate: ocr.plate }); }
      visitId = data.visit_id; status = data.status; vehicleId = data.vehicle_id;
    } else {
      // AI ไม่แน่ใจ: บันทึกเป็น "ต้องตรวจสอบ" ให้คนยืนยันในเว็บ (กันซ้ำภายใน 10 นาที)
      const norm = String(ocr.plate).replace(/[\s\-]/g, "").toUpperCase();
      const since = new Date(Date.now() - 10 * 60_000).toISOString();
      const { data: dup } = await sb.from("vehicle_logs").select("id").eq("plate_norm", norm).gt("capture_at", since).limit(1);
      if (dup?.length) { await drop(); return json({ ok: true, duplicate: true, plate: ocr.plate }); }
      const { data: ins, error } = await sb.from("vehicle_logs").insert({
        plate_number: ocr.plate, province: ocr.province, vehicle_type: ocr.vehicle_type, note: `กล้อง: ${dev.name}`,
        image_path: path, ocr_confidence: conf, ocr_provider: ocr.provider ?? null, status: "needs_review", source: "esp32",
      }).select("id").single();
      if (error) { await drop(); return json({ error: error.message }, 500); }
      visitId = ins.id; status = "needs_review";
    }
    await sb.from("camera_devices").update({ last_plate: ocr.plate }).eq("id", dev.id);

    // 4) แจ้ง Telegram (ไม่ให้ล้มทั้งงานถ้าส่งไม่สำเร็จ)
    let notified: unknown = null;
    try {
      const n = await fetch(`${url}/functions/v1/notify-visit`, {
        method: "POST", headers: { Authorization: `Bearer ${svc}`, apikey: svc, "Content-Type": "application/json" },
        body: JSON.stringify({ visit_id: visitId, force: true }),
      });
      notified = await n.json();
    } catch (e) { notified = { error: (e as Error).message }; }
    return json({ ok: true, plate: ocr.plate, province: ocr.province, confidence: conf, status, vehicle_id: vehicleId, notified });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
