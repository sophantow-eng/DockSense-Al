import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import { cleanPlate, decideReread, PLACEHOLDER } from "./decide.ts";

// คิวงานระหว่างเซิร์ฟเวอร์ OCR (enqueue/result) กับคอมเครื่องแรง (claim/complete)
// คอมเป็นฝ่ายเชื่อมออกมาเอง จึงไม่ต้องมีลิงก์/อุโมงค์เข้าคอม
// สิทธิ์: header x-queue-key เทียบแฮช SHA-256 กับ public.ai_queue_keys (role: enqueue | worker)
//
// งานมี 2 ชนิด
//   live   = ภาพสดจากกล้อง รอผลทันที (หมดอายุ 25 วิ)
//   reread = "อ่านซ้ำย้อนหลัง" รายการที่ค้าง "รอตรวจ" ตอนคอมออฟไลน์ (Gemini เครื่องเดียว/อ่านไม่ออก)
//            สร้างเมื่อคอมกลับมาและว่างเท่านั้น · ยืนยันอัตโนมัติเฉพาะเมื่อมีเครื่องที่สองอิสระอ่านตรงกัน (ดู decide.ts)
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "x-queue-key, content-type" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// deno-lint-ignore no-explicit-any
type Sb = any;

// สร้างงานอ่านซ้ำ 1 งาน (ถ้ามีรายการค้างและคอมว่าง) · คืน true เมื่อสร้างได้ · ล้มเหลวทุกกรณีต้องไม่กระทบงานสด (ผู้เรียกครอบ try/catch)
async function queueReread(sb: Sb): Promise<boolean> {
  const live = await sb.from("ai_jobs").select("id").eq("kind", "live").gt("created_at", new Date(Date.now() - 60_000).toISOString()).limit(1);
  if (live.data?.length) return false;                      // มีงานสดเมื่อไม่นานนี้ → ไม่แทรกงานหนัก
  const busy = await sb.from("ai_jobs").select("id").eq("kind", "reread").in("status", ["pending", "processing"]).gt("created_at", new Date(Date.now() - 5 * 60_000).toISOString()).limit(1);
  if (busy.data?.length) return false;                      // อ่านซ้ำทีละงาน
  const since = new Date(Date.now() - 48 * 3600_000).toISOString();
  const cand = await sb.from("vehicle_logs").select("id,image_path").eq("status", "needs_review").is("reread_at", null).not("image_path", "is", null)
    .gt("capture_at", since).order("capture_at", { ascending: false }).limit(1);
  const c = cand.data?.[0];
  if (!c) return false;
  // จองรายการก่อน (กันสองคำขอหยิบรายการเดียวกัน และกันวนอ่านซ้ำไม่รู้จบ — ลองครั้งเดียวต่อรายการ)
  const mark = await sb.from("vehicle_logs").update({ reread_at: new Date().toISOString() }).eq("id", c.id).is("reread_at", null).select("id");
  if (!mark.data?.length) return false;
  const dl = await sb.storage.from("plate-images").download(c.image_path);
  if (dl.error || !dl.data) return false;
  const buf = new Uint8Array(await dl.data.arrayBuffer());
  if (buf.length < 2000 || buf.length > 3_000_000 || !(buf[0] === 0xff && buf[1] === 0xd8)) return false;
  const ins = await sb.from("ai_jobs").insert({ image: encodeBase64(buf), kind: "reread", log_id: c.id });
  return !ins.error;
}

// นำผลอ่านซ้ำไปใช้กับรายการ (เฉพาะรายการที่ยัง "รอตรวจ" อยู่ — ถ้าคนจัดการไปแล้วไม่แตะ)
async function applyReread(sb: Sb, logId: string, result: Record<string, unknown> | null | undefined) {
  const { data: l } = await sb.from("vehicle_logs").select("id,plate_number,plate_norm,status,note").eq("id", logId).maybeSingle();
  if (!l || l.status !== "needs_review") return;
  const v = decideReread(l.plate_norm, result);
  if (v.action === "none") return;
  const note = [l.note, v.note].filter(Boolean).join(" · ").slice(0, 600);
  const noteOnly = () => sb.from("vehicle_logs").update({ note }).eq("id", l.id).eq("status", "needs_review");
  if (v.action === "note") { await noteOnly(); return; }
  // promote: เติมทะเบียน (กรณีรายการว่าง) → ผูก/ลงทะเบียนรถ → สถานะแบบเดียวกับที่บันทึกอัตโนมัติ (matched/new_vehicle)
  let plate: string = l.plate_number;
  if (String(l.plate_norm) === String(PLACEHOLDER).replace(/[\s\-]/g, "").toUpperCase()) {
    const c = cleanPlate(v.plate);
    if (!c) { await noteOnly(); return; }
    const up = await sb.from("vehicle_logs").update({ plate_number: c }).eq("id", l.id).eq("status", "needs_review");
    if (up.error) return;
    plate = c;
  }
  const normNow = plate.replace(/[\s\-]/g, "").toUpperCase();
  const vs = await sb.from("vehicles").select("id").eq("plate_norm", normNow).limit(3);
  if (vs.error || (vs.data?.length ?? 0) > 1) { await noteOnly(); return; }   // กำกวม (ทะเบียนเดียวกันหลายจังหวัด) → ให้คนเลือก
  const existed = vs.data?.length === 1;
  const rl = await sb.rpc("relink_visit", { p_log_id: l.id, p_vehicle_id: existed ? vs.data[0].id : null, p_register: !existed, p_company_id: null, p_new_company_name: null, p_vehicle_type: null });
  if (rl.error) { await noteOnly(); return; }
  await sb.from("vehicle_logs").update({ status: existed ? "matched" : "new_vehicle", ocr_provider: v.provider, ocr_confidence: v.conf, note }).eq("id", l.id);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const key = req.headers.get("x-queue-key") || "";
  if (!key) return json({ error: "unauthorized" }, 401);
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const { data: kr } = await sb.from("ai_queue_keys").select("role").eq("key_hash", await sha(key)).maybeSingle();
    if (!kr) return json({ error: "unauthorized" }, 401);
    const role = kr.role as string;
    const b = await req.json().catch(() => ({}));
    const need = (r: string) => (role === r ? null : json({ error: "forbidden" }, 403));

    if (b.action === "enqueue") {
      const f = need("enqueue"); if (f) return f;
      const img = String(b.image_b64 || "");
      if (!img || img.length > 4_200_000) return json({ error: "bad image" }, 400);
      const { data: w } = await sb.from("ai_queue_keys").select("last_seen").eq("role", "worker").maybeSingle();
      const online = !!w?.last_seen && Date.now() - new Date(w.last_seen).getTime() < 60_000;
      if (!online) return json({ offline: true });   // คอมปิด: ตอบทันที ผู้เรียกถอยไปใช้ตัวสำรอง
      await sb.from("ai_jobs").delete().lt("created_at", new Date(Date.now() - 10 * 60_000).toISOString());
      const { data, error } = await sb.from("ai_jobs").insert({ image: img, kind: "live" }).select("id").single();
      if (error) return json({ error: error.message }, 500);
      return json({ id: data.id });
    }
    if (b.action === "result") {
      const f = need("enqueue"); if (f) return f;
      const { data } = await sb.from("ai_jobs").select("status,result").eq("id", String(b.id || "")).maybeSingle();
      return json(data ? { status: data.status, result: data.status === "done" ? data.result : null } : { status: "missing" });
    }
    if (b.action === "cancel") {
      const f = need("enqueue"); if (f) return f;
      await sb.from("ai_jobs").update({ status: "expired" }).eq("id", String(b.id || "")).in("status", ["pending", "processing"]);
      return json({ ok: true });
    }
    if (b.action === "claim") {
      const f = need("worker"); if (f) return f;
      await sb.from("ai_queue_keys").update({ last_seen: new Date().toISOString() }).eq("role", "worker");
      const end = Date.now() + 20_000;
      let triedReread = false;
      while (Date.now() < end) {
        const { data } = await sb.rpc("claim_ai_job");
        if (data && data.length) return json({ job: { id: data[0].job_id, image_b64: data[0].job_image } });
        if (!triedReread) {   // ไม่มีงานสดรออยู่ → ใช้เวลาว่างอ่านซ้ำรายการที่ค้าง (ครั้งเดียวต่อรอบ claim)
          triedReread = true;
          try { if (await queueReread(sb)) continue; } catch (e) { console.error("reread enqueue failed", (e as Error).message); }
        }
        await sleep(600);
      }
      return json({ job: null });
    }
    if (b.action === "complete") {
      const f = need("worker"); if (f) return f;
      const id = String(b.id || "");
      const { data: jb } = await sb.from("ai_jobs").update({ status: "done", result: b.result ?? null, done_at: new Date().toISOString() })
        .eq("id", id).eq("status", "processing").select("kind,log_id").maybeSingle();
      if (jb?.kind === "reread" && jb.log_id) {
        try { await applyReread(sb, jb.log_id, b.result); } catch (e) { console.error("apply reread failed", (e as Error).message); }
      }
      return json({ ok: true });
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
