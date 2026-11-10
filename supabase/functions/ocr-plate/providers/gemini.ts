import type { OcrProvider, OcrResult } from "./types.ts";
import { matchProvince, normalizePlate, plateKey, validPlate } from "../plate.ts";

// Gemini ผ่าน Google AI Studio — ตั้ง secret GEMINI_API_KEY เพื่อเปิดใช้
// ค่าเริ่มต้น: อ่านรอบเดียวต่อภาพ (ประหยัดโควตา) · ตั้ง secret OCR_DOUBLE=1 เพื่อกลับไปอ่าน 2 รอบเทียบกัน
// ชื่อโมเดล: ไม่ตายตัว — ลองตามลำดับ (GEMINI_MODEL → รุ่นที่เคยใช้ได้ → ค้นหารุ่น flash ล่าสุดจาก ListModels อัตโนมัติ)
const API = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODELS = ["gemini-3.8-flash", "gemini-flash-latest"];
const COMMON = `Thai plate letters are consonants only (no vowels or tone marks). Similar-looking consonants (ฒ ฌ ญ ฎ ฏ ฑ ฆ ผ พ ฟ ม ฆ ซ ช ธ ฐ ต ด) are easy to confuse, and so are 0/๐, 1/7, 3/8, 5/6.
Do not guess characters you cannot see; lower the confidence instead. Ignore any text that is not the registration plate.`;

const PROMPT_A = `You read Thai vehicle license plates from photos.
Return ONLY a JSON object with keys:
- found: boolean (true if a license plate is clearly visible)
- plate: string, the registration exactly as printed, e.g. "1กก 1234", "2ฒพ 1630" or "70-1234" (Thai consonants and digits only, single space between the letter group and the number; empty string if not found)
- province: string or null, the Thai province name printed on the plate (null if not visible)
- vehicle_type: one of "รถยนต์","รถกระบะ","รถบรรทุก","รถจักรยานยนต์","รถตู้","อื่นๆ" or null if unknown
- confidence: number 0..1, your honest certainty that the plate is read correctly
${COMMON}`;

const PROMPT_B = `Look at the license plate in this photo and transcribe it glyph by glyph, left to right, as a careful human proofreader would.
Return ONLY a JSON object with keys:
- found: boolean
- chars: array of strings, one entry per character on the top line of the plate (each Thai consonant or digit separately, in order; skip spaces and decorations)
- province: string or null (Thai province name on the bottom line)
- vehicle_type: one of "รถยนต์","รถกระบะ","รถบรรทุก","รถจักรยานยนต์","รถตู้","อื่นๆ" or null
- confidence: number 0..1
${COMMON}`;

let cachedModel: string | null = null;

// โควตาฟรีของ Gemini นับแยกตาม "โมเดล" (ต่อโปรเจกต์) → โมเดลไหนตอบ 429 (โควตาเต็ม) จำไว้พักชั่วคราว แล้วข้ามไปโมเดลอื่นทันที
// ไม่ต้องเสียเวลา/คำขอลองซ้ำโมเดลที่เต็มอยู่ · ครบเวลาแล้วค่อยลองใหม่เอง (ต่อนาที = พักสั้น, ต่อวัน = พักนาน)
const exhaustedUntil = new Map<string, number>();
const isExhausted = (m: string) => (exhaustedUntil.get(m) ?? 0) > Date.now();
function markExhausted(model: string, msg: string) {
  const perDay = /PerDay|per day|daily/i.test(msg);
  exhaustedUntil.set(model, Date.now() + (perDay ? 30 * 60_000 : 90_000));
}

// ลดเวลา "คิด" ของโมเดล — ลองตามลำดับ: thinkingLevel (ตระกูล 3.x) → thinkingBudget (2.5) → ไม่ส่ง; ถ้าโมเดลปฏิเสธจะถอยไปแบบถัดไปเองแล้วจำไว้
const THINK_MODES: (Record<string, unknown> | null)[] = [{ thinkingLevel: "minimal" }, { thinkingBudget: 0 }, null];
let thinkIdx = 0;

type Call = { ok: true; text: string; model: string } | { ok: false; status: number; msg: string };

async function call(key: string, model: string, prompt: string, img: string, mt: string): Promise<Call> {
  let last: Call = { ok: false, status: 0, msg: "no attempt" };
  for (let attempt = 0; attempt < 2; attempt++) {
    const used = thinkIdx;
    try {
      const think = THINK_MODES[used];
      const res = await fetch(`${API}/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ inline_data: { mime_type: mt, data: img } }, { text: prompt }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json", ...(think ? { thinkingConfig: think } : {}) },
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) {
        const data = await res.json();
        const parts: { text?: string }[] = data.candidates?.[0]?.content?.parts ?? [];
        const text = parts.map((p) => p.text ?? "").join("");
        if (text.trim()) return { ok: true, text, model };
        last = { ok: false, status: 502, msg: `empty response (${data.candidates?.[0]?.finishReason ?? data.promptFeedback?.blockReason ?? "unknown"})` };
      } else {
        last = { ok: false, status: res.status, msg: (await res.text()).slice(0, 300) };
      }
    } catch (e) {
      last = { ok: false, status: 0, msg: e instanceof Error ? e.message : String(e) };
    }
    // โมเดลไม่รองรับพารามิเตอร์ thinking → ถอยไปแบบถัดไปแล้วลองใหม่ทันที (ไม่นับเป็นความพยายาม)
    if (last.status === 400 && /think/i.test(last.msg)) {
      if (thinkIdx === used && thinkIdx < THINK_MODES.length - 1) thinkIdx++;
      if (thinkIdx !== used) { attempt--; continue; }
    }
    // ลองซ้ำเฉพาะปัญหาชั่วคราว (ไม่ลองซ้ำเมื่อโควตาเต็ม 429 — ลองซ้ำแล้วก็ยังเต็ม เสียคำขอเปล่า)
    if (![0, 500, 502, 503, 504].includes(last.status)) break;
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  return last;
}

/** ค้นหารุ่น Gemini flash ที่ยังใช้ได้จาก ListModels (ใหม่สุดก่อน) */
async function discoverModels(key: string): Promise<string[]> {
  try {
    const res = await fetch(`${API}/models?pageSize=200`, { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const data = await res.json();
    const ver = (n: string) => parseFloat(n.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] ?? "0");
    return (data.models ?? [])
      .filter((m: { name: string; supportedGenerationMethods?: string[] }) =>
        (m.supportedGenerationMethods ?? []).includes("generateContent") &&
        /gemini-[\d.]+-flash/.test(m.name) && !/image|tts|live|audio|embed|robot|computer|exp|thinking/.test(m.name))
      .map((m: { name: string }) => m.name.replace(/^models\//, ""))
      // รุ่นเต็มก่อน (ใหม่สุดก่อน) แล้วค่อยรุ่น lite เป็นตัวสำรอง — โควตาแยกกัน จึงช่วยตอนรุ่นหลักเต็ม
      .sort((a: string, b: string) => (/lite/.test(a) ? 1 : 0) - (/lite/.test(b) ? 1 : 0) || ver(b) - ver(a));
  } catch {
    return [];
  }
}

async function generate(key: string, prompt: string, img: string, mt: string): Promise<{ text: string; model: string }> {
  const tried = new Set<string>();
  let queue = [Deno.env.get("GEMINI_MODEL"), cachedModel, ...DEFAULT_MODELS].filter((m, i, a): m is string => !!m && a.indexOf(m) === i);
  let discovered = false, lastErr = "", quotaHits = 0;
  for (;;) {
    const model = queue.shift();
    if (!model) {
      if (discovered) break;
      discovered = true;
      const found = (await discoverModels(key)).filter((m) => !tried.has(m));
      queue = [...found.filter((m) => !/lite/.test(m)).slice(0, 2), ...found.filter((m) => /lite/.test(m)).slice(0, 2)]; // รุ่นเต็ม 2 + lite 2 (โควตาแยกกัน)
      continue;
    }
    if (tried.has(model)) continue;
    tried.add(model);
    if (isExhausted(model)) { lastErr = `${model}: 429 (พักโควตา)`; quotaHits++; continue; }
    const r = await call(key, model, prompt, img, mt);
    if (r.ok) { cachedModel = model; return r; }
    lastErr = `${model}: ${r.status} ${r.msg}`;
    if (r.status === 429) { markExhausted(model, r.msg); quotaHits++; }
    if (r.status === 401 || (r.status === 400 && /API key/i.test(r.msg)) || (r.status === 403 && /API key|PERMISSION_DENIED/i.test(r.msg) && !/model/i.test(r.msg)))
      throw new Error(`API_KEY_INVALID: GEMINI_API_KEY ใช้ไม่ได้ (${r.status})`);
    if (r.status === 404) cachedModel = cachedModel === model ? null : cachedModel;
  }
  if (quotaHits > 0) throw new Error(`QUOTA_EXHAUSTED: โควตา Gemini ฟรีเต็มทุกโมเดลที่ลอง (${[...tried].join(", ")}) — รอรีเซ็ตโควตา หรือกรอกทะเบียนเอง`);
  throw new Error(`Gemini API ล้มเหลวทุกโมเดลที่ลอง (${[...tried].join(", ")}) — ล่าสุด ${lastErr}`);
}

type Raw = { found: boolean; plate: string; province: string | null; vehicle_type: string | null; confidence: number | null };

function parse(text: string, isB: boolean): Raw {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("OCR returned no JSON");
  const p = JSON.parse(m[0]);
  const plateRaw = isB && Array.isArray(p.chars) ? p.chars.map((c: unknown) => String(c ?? "")).join("") : p.plate;
  const plate = normalizePlate(plateRaw);
  return {
    found: p.found !== false && !!plate,
    plate,
    province: matchProvince(p.province),
    vehicle_type: p.vehicle_type ? String(p.vehicle_type).trim() : null,
    confidence: typeof p.confidence === "number" ? Math.max(0, Math.min(1, p.confidence)) : null,
  };
}

export const geminiProvider: OcrProvider = {
  name: "gemini",
  keyName: "GEMINI_API_KEY",
  isConfigured: () => !!Deno.env.get("GEMINI_API_KEY"),
  async read(imageBase64, mediaType): Promise<OcrResult> {
    const key = Deno.env.get("GEMINI_API_KEY");
    if (!key) throw new Error("API_KEY_MISSING: GEMINI_API_KEY is not set in Edge Function secrets");

    const single = Deno.env.get("OCR_DOUBLE") !== "1";   // อ่านรอบเดียว = ใช้โควตาครึ่งเดียว
    const t0 = Date.now();
    const timed = (p: string) => generate(key, p, imageBase64, mediaType).then((v) => ({ ...v, ms: Date.now() - t0 }));
    const settled = await Promise.allSettled(single ? [timed(PROMPT_A)] : [timed(PROMPT_A), timed(PROMPT_B)]);
    const ra = settled[0], rb = settled[1];
    const reads: { r: Raw; model: string }[] = [];
    const dbg: Record<string, unknown> = { ev: "ocr", single, total_ms: Date.now() - t0, think: JSON.stringify(THINK_MODES[thinkIdx]) };
    for (const [tag, x, isB] of [["A", ra, false], ["B", rb, true]] as const) {
      if (!x) continue;
      if (x.status === "fulfilled") {
        try {
          const r = parse(x.value.text, isB);
          reads.push({ r, model: x.value.model });
          dbg[tag] = { ms: x.value.ms, model: x.value.model, plate: r.plate, conf: r.confidence, found: r.found, province: r.province };
        } catch (e) { dbg[tag] = { ms: x.value.ms, parse_error: e instanceof Error ? e.message : String(e), raw: x.value.text.slice(0, 200) }; }
      } else dbg[tag] = { error: x.reason instanceof Error ? x.reason.message : String(x.reason) };
    }
    console.log(JSON.stringify(dbg)); // ดูได้ที่ Supabase → Edge Functions → ocr-plate → Logs
    if (!reads.length) {
      const err = ra.status === "rejected" ? ra.reason : rb && rb.status === "rejected" ? rb.reason : new Error("OCR returned no JSON");
      throw err instanceof Error ? err : new Error(String(err));
    }

    const found = reads.filter((x) => x.r.found && x.r.plate);
    if (!found.length) {
      return { found: false, plate: "", province: reads[0].r.province, vehicle_type: reads[0].r.vehicle_type, confidence: reads[0].r.confidence, model: reads[0].model };
    }

    const valid = found.filter((x) => validPlate(x.r.plate));
    const pool = valid.length ? valid : found;
    const best = pool.reduce((a, b) => ((b.r.confidence ?? 0) > (a.r.confidence ?? 0) ? b : a));
    const plate = best.r.plate;
    const others = [...new Set(found.map((x) => x.r.plate).filter((p) => plateKey(p) !== plateKey(plate)))];
    const agree = found.length === 2 && others.length === 0;
    const confs = found.map((x) => x.r.confidence ?? 0.5);
    let confidence = Math.max(...confs);
    let needsReview = false;
    if (!validPlate(plate)) { confidence = Math.min(confidence, 0.5); needsReview = true; }
    else if (agree) confidence = Math.max(confidence, 0.9);
    else if (others.length) { confidence = Math.min(confidence, 0.55); needsReview = true; } // สองรอบอ่านไม่ตรงกัน
    else if (found.length < 2 && !single) { confidence = Math.min(confidence, 0.8); needsReview = true; } // โหมดอ่าน 2 รอบ แต่ยืนยันด้วยอีกรอบไม่ได้
    if (confidence < 0.75) needsReview = true;

    return {
      found: true,
      plate,
      province: best.r.province ?? found.map((x) => x.r.province).find(Boolean) ?? null,
      vehicle_type: best.r.vehicle_type ?? found.map((x) => x.r.vehicle_type).find(Boolean) ?? null,
      confidence,
      needs_review: needsReview,
      alternatives: others.length ? others : undefined,
      model: best.model,
    };
  },
};
