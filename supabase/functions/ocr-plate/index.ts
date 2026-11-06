import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { claudeProvider } from "./providers/claude.ts";
import { geminiProvider } from "./providers/gemini.ts";
import type { OcrProvider, OcrResult } from "./providers/types.ts";
import { matchProvince, normalizePlate, validPlate } from "./plate.ts";

// To add a provider (Google Vision, etc.): create providers/<name>.ts implementing OcrProvider, register it here,
// then set the secret OCR_PROVIDER=<name>.
const providers: Record<string, OcrProvider> = { claude: claudeProvider, gemini: geminiProvider };

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// ลำดับการใช้งาน: OCR_PROVIDER (ถ้าตั้ง) → gemini (ถ้ามี key) → claude (ถ้ามี key) — ตัวไหนล้มจะสลับไปตัวถัดไปที่ตั้ง key ไว้
function order(): OcrProvider[] {
  const pref = Deno.env.get("OCR_PROVIDER");
  const names = [pref, "gemini", "claude"].filter((n, i, a): n is string => !!n && a.indexOf(n) === i);
  return names.map((n) => providers[n]).filter(Boolean);
}

// ล้างผลลัพธ์ให้เป็นรูปแบบเดียวกันทุกผู้ให้บริการ (เผื่อ claude ที่ไม่ได้ผ่านการโหวต)
function finalize(r: OcrResult): OcrResult {
  const plate = normalizePlate(r.plate);
  const out: OcrResult = { ...r, plate, province: matchProvince(r.province) ?? (r.province || null) };
  if (out.found && !validPlate(plate)) {
    out.needs_review = true;
    out.confidence = Math.min(out.confidence ?? 0.5, 0.5);
  } else if (out.found && out.needs_review === undefined && (out.confidence ?? 0) < 0.85) {
    out.needs_review = true;
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const body = await req.json();
    const chain = order();
    const ready = chain.filter((p) => p.isConfigured());
    if (!ready.length) {
      const k = chain.map((p) => p.keyName ?? "API key").join(" หรือ ");
      return json({ error: `ยังไม่ได้ตั้งค่า ${k} ใน Edge Function secrets`, code: "API_KEY_MISSING" }, 503);
    }
    if (body.ping) return json({ ok: true, provider: ready[0].name, fallback: ready.slice(1).map((p) => p.name) });

    const { imageBase64, mediaType } = body;
    if (!imageBase64 || typeof imageBase64 !== "string") return json({ error: "imageBase64 is required" }, 400);
    if (imageBase64.length > 14_000_000) return json({ error: "Image too large" }, 413);
    const mt = ["image/jpeg", "image/png", "image/webp"].includes(mediaType) ? mediaType : "image/jpeg";

    const errors: string[] = [];
    for (const p of ready) {
      try {
        const result = finalize(await p.read(imageBase64, mt));
        return json({ ...result, provider: p.name });
      } catch (e) {
        errors.push(`${p.name}: ${e instanceof Error ? e.message : String(e)}`);
        console.error(JSON.stringify({ ev: "ocr_provider_failed", provider: p.name, error: errors[errors.length - 1] }));
      }
    }
    const msg = errors.join(" | ");
    return json({ error: msg, code: msg.includes("API_KEY_INVALID") ? "API_KEY_INVALID" : "OCR_FAILED" }, 502);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e), code: "OCR_FAILED" }, 502);
  }
});
