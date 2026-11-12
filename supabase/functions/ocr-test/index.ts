import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// โหมดทดสอบ: ผู้ดูแลส่งภาพ 1 รูป → รัน Tesseract และ/หรือ AI "แยกกัน" แล้วคืนผลคู่กัน
// ไม่เขียนประวัติ/ฐานข้อมูลใดๆ (ไม่มีการบันทึกรถ) · รหัส backend อยู่ฝั่งเซิร์ฟเวอร์ ไม่ส่งให้เบราว์เซอร์
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

type R = { state: string; plate?: string | null; confidence?: number | null; status?: string; ms?: number; provider?: string; error?: string; detail?: unknown };


// ---- เทียบกับรถที่ลงทะเบียนไว้ (ข้อเสนอให้คนยืนยัน ไม่แก้ทะเบียนเอง) ----
// ตัวเลขต้องตรงทุกตัว · พยัญชนะต่างได้เฉพาะกลุ่มที่หน้าตาคล้ายกัน (ข/ฆ/ช…) ไม่เกิน 2 ตำแหน่ง · ต้องเหลือรถคันเดียวเท่านั้น ไม่งั้นไม่เสนอ
const SIM = ["ขฃฆชซ", "พผฝฟ", "ญณฌ", "ดตคศ", "บปษ", "กถภ", "ลฬ", "รธ", "ฆฝ", "สศ"]; // ฆ↔ฝ, ข↔ฆ พบจากภาพจริงของระบบนี้ · กลุ่มอื่นเป็นหน้าตาคล้าย (ต้องปรับจากข้อมูลจริง)
const PAIR = new Set<string>(); SIM.forEach((g) => { for (const a of g) for (const b of g) if (a !== b) PAIR.add(a + b); });
const keyOf = (t: string) => String(t || "").replace(/[^ก-ฮ0-9]/g, "");
function matchKnown(cands: string[], known: { k: string; plate: string }[]) {
  const found = new Map<string, { plate: string; exact: boolean }>();
  for (const raw of cands) {
    const c = keyOf(raw); if (c.length < 4) continue;
    for (const v of known) {
      if (v.k.length !== c.length) continue;
      if (v.k === c) { found.set(v.k, { plate: v.plate, exact: true }); continue; }
      let soft = 0, ok = true;
      for (let i = 0; i < c.length && ok; i++) {
        if (c[i] === v.k[i]) continue;
        if (PAIR.has(c[i] + v.k[i])) soft++; else ok = false;
      }
      if (ok && soft >= 1 && soft <= 2 && !found.has(v.k)) found.set(v.k, { plate: v.plate, exact: false });
    }
  }
  const all = [...found.values()], exact = all.filter((x) => x.exact);
  if (exact.length === 1) return { plate: exact[0].plate, exact: true };
  if (!exact.length && all.length === 1) return all[0];
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const url = Deno.env.get("SUPABASE_URL")!, svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(url, svc);
  try {
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await sb.auth.getUser(jwt);
    if (!u?.user) return json({ error: "Unauthorized" }, 401);
    const { data: prof } = await sb.from("profiles").select("role").eq("id", u.user.id).maybeSingle();
    if (prof?.role !== "admin") return json({ error: "เฉพาะผู้ดูแลระบบ", code: "FORBIDDEN" }, 403);

    const body = await req.json().catch(() => ({}));
    const bUrl = (Deno.env.get("OCR_BACKEND_URL") || "").replace(/\/$/, ""), bKey = Deno.env.get("OCR_BACKEND_KEY") || "";
    const { data: row } = await sb.from("app_settings").select("value").eq("key", "ocr_control").maybeSingle();
    const ctl = { master: true, tesseract: true, ai: true, auto_fallback: true, ...(row?.value || {}) };

    // สถานะเครื่องยนต์จริง (ไม่ยิง OCR)
    if (body.status) {
      let tess: R = { state: "NOT_CONFIGURED" };
      if (bUrl && bKey) {
        try {
          const h = await fetch(`${bUrl}/api/v1/health`, { signal: AbortSignal.timeout(20000) });
          const j = await h.json();
          tess = { state: j.tesseract === "READY" ? "READY" : "ERROR", detail: { ai_worker: j.ai } };
        } catch { tess = { state: "OFFLINE" }; }
      }
      const ai = (await fetch(`${url}/functions/v1/ocr-plate`, { method: "POST", headers: { Authorization: `Bearer ${svc}`, apikey: svc, "Content-Type": "application/json" }, body: JSON.stringify({ ping: true }) })
        .then((r) => r.json()).catch(() => ({ error: "x" })));
      return json({ tesseract: tess, ai: ai.ok ? { state: "READY", provider: ai.provider } : { state: "NOT_CONFIGURED" }, ctl });
    }

    const mode = String(body.mode || "compare");
    if (!["tesseract", "ai", "compare", "fallback"].includes(mode)) return json({ error: "mode ไม่ถูกต้อง" }, 400);
    const b64 = String(body.imageBase64 || "");
    if (!b64 || b64.length > 6_000_000) return json({ error: "ต้องมีภาพ (ไม่เกิน ~4 MB)" }, 400);
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    if (!(bin[0] === 0xff && bin[1] === 0xd8)) return json({ error: "JPEG only" }, 415);
    if (!ctl.master) return json({ error: "สวิตช์หลัก (Master) ปิดอยู่", code: "MASTER_OFF" }, 409);

    const runTess = async (): Promise<R> => {
      if (!ctl.tesseract) return { state: "OFF" };
      if (!bUrl || !bKey) return { state: "NOT_CONFIGURED", error: "ยังไม่ได้ตั้ง OCR_BACKEND_URL / OCR_BACKEND_KEY" };
      const t0 = Date.now();
      try {
        const r = await fetch(`${bUrl}/api/v1/ocr/test?mode=tesseract`, { method: "POST", headers: { "x-api-key": bKey, "Content-Type": "image/jpeg" }, body: bin, signal: AbortSignal.timeout(60000) });
        if (!r.ok) return { state: r.status === 429 ? "BUSY" : "ERROR", error: `backend ${r.status}`, ms: Date.now() - t0 };
        const j = await r.json(), x = j.results?.tesseract || {};
        if (["UNAVAILABLE", "ERROR", "NOT_CONFIGURED"].includes(x.status)) return { state: x.status, error: x.error, ms: x.ms ?? Date.now() - t0 };
        return { state: x.found ? "DONE" : "NO_PLATE", plate: x.plate ?? null, confidence: x.confidence ?? null, status: x.status, ms: x.ms ?? Date.now() - t0, provider: "tesseract", detail: x };
      } catch (e) { return { state: "OFFLINE", error: (e as Error).message, ms: Date.now() - t0 }; }
    };
    const runAi = async (): Promise<R> => {
      if (!ctl.ai) return { state: "OFF" };
      const t0 = Date.now();
      try {
        const r = await fetch(`${url}/functions/v1/ocr-plate`, { method: "POST", headers: { Authorization: `Bearer ${svc}`, apikey: svc, "Content-Type": "application/json" }, body: JSON.stringify({ imageBase64: b64, mediaType: "image/jpeg" }), signal: AbortSignal.timeout(12000) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return { state: j.code === "API_KEY_MISSING" ? "NOT_CONFIGURED" : "ERROR", error: j.error || `ocr ${r.status}`, ms: Date.now() - t0, detail: { code: j.code } };
        return { state: j.found ? "DONE" : "NO_PLATE", plate: j.plate ?? null, confidence: j.confidence ?? null, status: j.needs_review ? "NEEDS_REVIEW" : j.found ? "VERIFIED" : undefined, ms: Date.now() - t0, provider: j.provider, detail: { province: j.province, cached: j.cached } };
      } catch (e) { return { state: "ERROR", error: (e as Error).message, ms: Date.now() - t0 }; }
    };

    const results: Record<string, R> = {};
    if (mode === "tesseract") results.tesseract = await runTess();
    else if (mode === "ai") results.ai = await runAi();
    else if (mode === "compare") { const [t, a] = await Promise.all([runTess(), runAi()]); results.tesseract = t; results.ai = a; }
    else { // fallback: จำลองสายผลิตจริง Tesseract → AI เมื่อไม่ผ่านและเปิด fallback
      results.tesseract = await runTess();
      const passed = results.tesseract.state === "DONE" && results.tesseract.status === "VERIFIED";
      results.ai = passed ? { state: "SKIPPED", error: "Tesseract ผ่านแล้ว ไม่ต้องใช้ AI" } : !ctl.auto_fallback ? { state: "SKIPPED", error: "Automatic Fallback ปิดอยู่" } : await runAi();
    }
    // เทียบกับรถที่ลงทะเบียนไว้ (ข้อเสนอเท่านั้น)
    try {
      const { data: vs } = await sb.from("vehicles").select("plate_norm,license_plate").not("plate_norm", "is", null).limit(20000);
      const known = (vs || []).map((v: { plate_norm: string; license_plate: string }) => ({ k: keyOf(v.plate_norm), plate: v.license_plate || v.plate_norm }));
      for (const r of Object.values(results)) {
        if (!r || r.state === "SKIPPED") continue;
        const raws = ((r.detail as { raw?: string[] } | undefined)?.raw || []) as string[];
        const m = known.length ? matchKnown([r.plate || "", ...raws], known) : null;
        if (m) (r as R & { suggestion?: unknown }).suggestion = m;
      }
    } catch (_e) { /* ไม่มีข้อเสนอ ไม่กระทบผลอ่าน */ }
    const a = results.tesseract?.plate, b = results.ai?.plate;
    return json({ test: true, mode, results, match: a && b ? String(a).replace(/[\s-]/g, "") === String(b).replace(/[\s-]/g, "") : null });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
