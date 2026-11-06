import type { OcrProvider, OcrResult } from "./types.ts";

const PROMPT = `You read Thai vehicle license plates from photos.
Return ONLY a JSON object, no markdown, with keys:
- found: boolean (true if a license plate is clearly visible)
- plate: string, the registration exactly as printed, e.g. "1กก 1234" or "70-1234" (Thai letters and digits, single space between letter group and number; empty string if not found)
- province: string or null, the Thai province name printed on the plate (null if not visible)
- vehicle_type: one of "รถยนต์","รถกระบะ","รถบรรทุก","รถจักรยานยนต์","รถตู้","อื่นๆ" or null if unknown
- confidence: number 0..1, your honest certainty that the plate is read correctly
Do not guess characters you cannot see; lower the confidence instead.`;

export const claudeProvider: OcrProvider = {
  name: "claude",
  keyName: "ANTHROPIC_API_KEY",
  isConfigured: () => !!Deno.env.get("ANTHROPIC_API_KEY"),
  async read(imageBase64, mediaType): Promise<OcrResult> {
    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) throw new Error("API_KEY_MISSING: ANTHROPIC_API_KEY is not set in Edge Function secrets");
    const model = Deno.env.get("OCR_MODEL") ?? "claude-sonnet-5-5";
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model, max_tokens: 300,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
          { type: "text", text: PROMPT },
        ] }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const text: string = (data.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("OCR returned no JSON");
    const p = JSON.parse(m[0]);
    const conf = typeof p.confidence === "number" ? Math.max(0, Math.min(1, p.confidence)) : null;
    return {
      found: !!p.found && !!p.plate,
      plate: String(p.plate ?? "").trim(),
      province: p.province ? String(p.province).trim() : null,
      vehicle_type: p.vehicle_type ? String(p.vehicle_type).trim() : null,
      confidence: conf,
    };
  },
};
