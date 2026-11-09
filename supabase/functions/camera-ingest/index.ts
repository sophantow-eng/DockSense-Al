import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

// รับรูปจาก ESP32-CAM: POST image/jpeg + header x-device-key  →  OCR → บันทึก → แจ้ง Telegram
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "x-device-key, x-local-ip, content-type, authorization, apikey, x-client-info",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const lastWrite = new Map<string, number>(), frameN = new Map<string, number>(), lastOcrAt = new Map<string, number>(), lastPending = new Map<string, number>(), lastHash = new Map<string, { h: string; at: number }>();
// deno-lint-ignore no-explicit-any
const bg = (p: Promise<any>) => { const er = (globalThis as any).EdgeRuntime; if (er?.waitUntil) { er.waitUntil(p); return Promise.resolve(); } return p; };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const url = Deno.env.get("SUPABASE_URL")!, svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(url, svc);
  try {
    const key = req.headers.get("x-device-key") || new URL(req.url).searchParams.get("key") || "";
    const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    // deno-lint-ignore no-explicit-any
    let dev: any = null, isPhone = false;
    if (key) {
      const r = await sb.from("camera_devices").select("*").eq("device_key", key).eq("enabled", true).maybeSingle();
      dev = r.data;
      if (!dev) return json({ error: "invalid device key" }, 401);
    } else if (bearer) {
      // กล้องมือถือ: ผู้ใช้ที่ล็อกอิน (ผู้ดูแล/เจ้าหน้าที่) ส่งภาพมาอ่านทะเบียนอัตโนมัติ
      const { data: u } = await sb.auth.getUser(bearer);
      if (!u?.user) return json({ error: "Unauthorized" }, 401);
      const { data: prof } = await sb.from("profiles").select("role").eq("id", u.user.id).maybeSingle();
      if (!["admin", "staff"].includes(prof?.role)) return json({ error: "Forbidden" }, 403);
      isPhone = true;
      dev = { id: `phone-${u.user.id}`, name: (new URL(req.url).searchParams.get("name") || "มือถือ").slice(0, 30) };
    } else return json({ error: "missing device key" }, 401);
    const isPreview = new URL(req.url).searchParams.get("preview") === "1";
    if (isPhone && isPreview) return json({ error: "not supported" }, 400);
    const nowMs = Date.now(), due = nowMs - (lastWrite.get(dev.id) || 0) > 5000;
    if (!isPhone && (!isPreview || due)) { lastWrite.set(dev.id, nowMs); await sb.from("camera_devices").update({ last_seen: new Date().toISOString() }).eq("id", dev.id); }

    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length < 2000) return json({ error: "image too small" }, 400);
    if (bytes.length > 3_000_000) return json({ error: "image too large" }, 413);
    if (!(bytes[0] === 0xff && bytes[1] === 0xd8)) return json({ error: "JPEG only" }, 415);

    // ภาพตัวอย่างสำหรับหน้าเว็บ “ดูกล้อง” (ไม่อ่านทะเบียน ไม่บันทึกประวัติ)
    if (isPreview) {
      const watching = !!dev.watch_until && new Date(dev.watch_until) > new Date();
      const wantSnap = !!dev.snap_req_at && (!dev.snap_at || new Date(dev.snap_req_at) > new Date(dev.snap_at));
      const hd = new URL(req.url).searchParams.get("hd") === "1";
      const ip = (req.headers.get("x-local-ip") || "").slice(0, 45);
      const upd: Record<string, unknown> = { preview_at: new Date().toISOString() };
      if (ip && ip !== dev.local_ip) upd.local_ip = ip;
      if (hd) upd.snap_at = new Date().toISOString();
      const cast = (event: string) => fetch(`${url}/realtime/v1/api/broadcast`, {
        method: "POST", headers: { apikey: svc, Authorization: `Bearer ${svc}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ topic: `live:${dev.id}`, event, private: false, payload: { b: encodeBase64(bytes), t: Date.now() } }] }),
      }).catch(() => null);
      const saveStill = () => sb.storage.from("plate-images").upload(`camera/${dev.id}/latest.jpg`, bytes, { contentType: "image/jpeg", upsert: true, cacheControl: "1" });
      if (hd) {
        await cast("snap");                       // ภาพคมชัดที่คนในเว็บขอ
      } else if (watching) {
        // มีคนดูอยู่: ส่งภาพเข้า Realtime ให้ทุกคนทันที (ช่องชื่อใช้ id กล้อง ซึ่งเห็นได้เฉพาะคนที่ล็อกอิน) แล้วตอบกล้องทันทีไม่รอ
        const n = (frameN.get(dev.id) || 0) + 1; frameN.set(dev.id, n);
        await bg(cast("frame").then((r) => { if (!r || !r.ok || n % 4 === 0) return saveStill(); }));
      } else {
        const pv = await saveStill();
        if (pv.error) return json({ error: pv.error.message }, 500);
      }
      if (due || upd.local_ip || hd) await sb.from("camera_devices").update(upd).eq("id", dev.id);
      return json({ ok: true, watch: watching, snap: wantSnap && !hd, next_ms: watching ? 300 : 15000 });
    }

    // กรองก่อนเรียก AI (ไม่เสียโควตา): เฟรมว่าง/มืด/เลนส์ถูกบัง (ไฟล์เล็กผิดปกติ) และภาพซ้ำเฟรมเดิม
    if (bytes.length < 9000) return json({ ok: true, skipped: "blank_frame", bytes: bytes.length });
    {
      const h = encodeBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).slice(0, 22);
      const prev = lastHash.get(dev.id);
      if (prev && prev.h === h && Date.now() - prev.at < 120_000) return json({ ok: true, skipped: "same_frame" });
      lastHash.set(dev.id, { h, at: Date.now() });
    }

    // กันอ่านถี่เกิน (ประหยัดโควตา AI): ต่ออุปกรณ์ 1 ครั้งต่อ 30 วินาที (ภาพสดไม่ผ่าน AI จึงไม่กินโควตา)
    {
      const last = lastOcrAt.get(dev.id) || 0;
      if (Date.now() - last < 30000) return json({ ok: true, skipped: "cooldown" });
      lastOcrAt.set(dev.id, Date.now());
    }

    // เร่งความเร็ว: อัปโหลดรูป + โหลดเกณฑ์ความมั่นใจ "พร้อมกับ" ที่ AI กำลังอ่าน (ไม่รอต่อคิว)
    const path = `camera/${dev.id}/${Date.now()}.jpg`;
    const upP = sb.storage.from("plate-images").upload(path, bytes, { contentType: "image/jpeg" });
    const thP = sb.from("app_settings").select("value").eq("key", "ocr_thresholds").maybeSingle();
    const dropLater = () => bg(upP.then(() => sb.storage.from("plate-images").remove([path])).then(() => null, () => null));

    const ocrRes = await fetch(`${url}/functions/v1/ocr-plate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${svc}`, apikey: svc, "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64: encodeBase64(bytes), mediaType: "image/jpeg" }),
    });
    const ocr = await ocrRes.json().catch(() => ({}));
    if (!ocrRes.ok) {
      // AI อ่านไม่ได้ (เช่น โควตาเต็ม): เก็บภาพไว้ในหน้า "รอตรวจสอบ" ให้พนักงานพิมพ์ทะเบียนเอง (จำกัด 1 รายการ/นาที/อุปกรณ์)
      const lp = lastPending.get(dev.id) || 0;
      if (Date.now() - lp < 60_000) { await dropLater(); return json({ ok: true, pending: false, error: ocr.error || "OCR failed", code: ocr.code, skipped: "pending_rate_limit" }); }
      lastPending.set(dev.id, Date.now());
      const ppath = path;
      const pu = await upP;
      if (pu.error) return json({ error: pu.error.message }, 500);
      const { data: pin, error: pe } = await sb.from("vehicle_logs").insert({
        plate_number: "รอตรวจทะเบียน", note: `กล้อง: ${dev.name} — AI อ่านไม่ได้ (${ocr.code || "OCR_FAILED"}) กรุณาดูภาพแล้วพิมพ์ทะเบียน`,
        image_path: ppath, ocr_confidence: 0, status: "needs_review", source: isPhone ? "phone" : "esp32",
      }).select("id").single();
      if (pe) return json({ error: pe.message }, 500);
      await bg(fetch(`${url}/functions/v1/notify-visit`, { method: "POST", headers: { Authorization: `Bearer ${svc}`, apikey: svc, "Content-Type": "application/json" }, body: JSON.stringify({ visit_id: pin.id, force: true }) }).catch(() => null));
      return json({ ok: true, pending: true, code: ocr.code || "OCR_FAILED" }, 200);
    }
    if (!ocr.found || !ocr.plate) { await dropLater(); return json({ ok: true, found: false }); }

    const { data: th } = await thP;
    const high = Number(th?.value?.high ?? 0.85);
    const conf = Number(ocr.confidence ?? 0);

    // 2) รูปอัปโหลดไปแล้วระหว่างรอ AI
    const up = await upP;
    if (up.error) return json({ error: up.error.message }, 500);
    const drop = () => sb.storage.from("plate-images").remove([path]);

    // 3) บันทึก
    let visitId: string | null = null, status: string, vehicleId: string | null = null;
    if (conf >= high && !ocr.needs_review) {
      const { data, error } = await sb.rpc("record_visit", {
        p_plate: ocr.plate, p_province: ocr.province, p_vehicle_type: ocr.vehicle_type, p_note: `กล้อง: ${dev.name}`,
        p_image_path: path, p_confidence: conf, p_provider: ocr.provider ?? null, p_source: isPhone ? "phone" : "esp32",
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
        image_path: path, ocr_confidence: conf, ocr_provider: ocr.provider ?? null, status: "needs_review", source: isPhone ? "phone" : "esp32",
      }).select("id").single();
      if (error) { await drop(); return json({ error: error.message }, 500); }
      visitId = ins.id; status = "needs_review";
    }
    if (!isPhone) await sb.from("camera_devices").update({ last_plate: ocr.plate }).eq("id", dev.id);

    // 4) แจ้ง Telegram เบื้องหลัง (ตอบกล้องทันที ไม่รอ Telegram; ล้มก็ไม่กระทบการบันทึก)
    await bg(fetch(`${url}/functions/v1/notify-visit`, {
      method: "POST", headers: { Authorization: `Bearer ${svc}`, apikey: svc, "Content-Type": "application/json" },
      body: JSON.stringify({ visit_id: visitId, force: true }),
    }).catch(() => null));
    const notified = "queued";
    return json({ ok: true, plate: ocr.plate, province: ocr.province, confidence: conf, status, vehicle_id: vehicleId, notified });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
