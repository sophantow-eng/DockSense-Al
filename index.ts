import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { claudeProvider } from "./providers/claude.ts";
import type { OcrProvider } from "./providers/types.ts";

// To add a provider (Google Vision, etc.): create providers/<name>.ts implementing OcrProvider, register it here,
// then set the secret OCR_PROVIDER=<name>.
const providers: Record<string, OcrProvider> = { claude: claudeProvider };

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const body = await req.json();
    const name = Deno.env.get("OCR_PROVIDER") ?? "claude";
    const provider = providers[name];
    if (!provider) return json({ error: `Unknown OCR provider: ${name}`, code: "BAD_PROVIDER" }, 500);
    if (body.ping) {
      return provider.isConfigured()
        ? json({ ok: true, provider: provider.name })
        : json({ error: "ANTHROPIC_API_KEY is not set", code: "API_KEY_MISSING" }, 503);
    }
    const { imageBase64, mediaType } = body;
    if (!imageBase64 || typeof imageBase64 !== "string") return json({ error: "imageBase64 is required" }, 400);
    if (imageBase64.length > 14_000_000) return json({ error: "Image too large" }, 413);
    const mt = ["image/jpeg", "image/png", "image/webp"].includes(mediaType) ? mediaType : "image/jpeg";
    const result = await provider.read(imageBase64, mt);
    return json({ ...result, provider: provider.name });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = msg.includes("API_KEY_MISSING") ? "API_KEY_MISSING" : "OCR_FAILED";
    return json({ error: msg, code }, code === "API_KEY_MISSING" ? 503 : 502);
  }
});
