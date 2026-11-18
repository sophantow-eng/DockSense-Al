// ตัดสินผล "อ่านซ้ำย้อนหลัง" ที่คอมแรง (EasyOCR + YOLO) ส่งกลับมา สำหรับรายการที่ค้าง "รอตรวจ" ตอนคอมออฟไลน์
// ฟังก์ชันล้วน (ไม่แตะฐานข้อมูล/เครือข่าย) เพื่อทดสอบได้ด้วย node: node --experimental-strip-types --test decide.test.ts
//
// หลักการ (แม่นก่อน): ยืนยันรายการอัตโนมัติเมื่อมี "เครื่องที่สองอิสระ" อ่านได้ตรงกันเท่านั้น
//   ก) ตรงกับที่บันทึกไว้ทุกตัว (Gemini เดิม + คอมแรงตอนนี้ = สองเครื่องอิสระ) และไม่มี YOLO ขัด
//   ข) รายการที่ว่าง ("รอตรวจทะเบียน" = ตอนนั้นอ่านไม่ออก) ต้องให้ YOLO กับ EasyOCR ตรงกันเองจึงเติมทะเบียนให้
//   นอกนั้น = ไม่แก้อะไร แค่แนบข้อเสนอให้คนกดยืนยัน (ไม่แก้ทะเบียนเอง)
export const PLACEHOLDER = "รอตรวจทะเบียน";
const LOCAL = ["yolo+easyocr", "yolo", "easyocr"];

export type Verdict =
  | { action: "promote"; plate: string; provider: string; conf: number; note: string }
  | { action: "note"; note: string }
  | { action: "none"; why: string };

// ทะเบียนที่ยอมให้ "เติมลงรายการว่าง" ได้ (กันข้อความแปลกปลอมจากผลที่ส่งมา): เลขนำ 0-2 ตัว + พยัญชนะ 1-3 ตัว + เลข 1-4 ตัว
export const cleanPlate = (s: unknown): string | null => { const t = String(s ?? "").trim(); return /^[0-9]{0,2}[ก-ฮ]{1,3}[ \-]?[0-9]{1,4}$/.test(t) ? t : null; };
const norm = (s: unknown) => String(s ?? "").replace(/[\s\-]/g, "").toUpperCase();

export function decideReread(loggedNormRaw: string, r: Record<string, unknown> | null | undefined): Verdict {
  if (!r || typeof r !== "object") return { action: "none", why: "no_result" };
  const status = String(r.status ?? "");
  if (status === "ERROR" || status === "UNAVAILABLE" || status === "NOT_CONFIGURED") return { action: "none", why: "reader_error" };
  const plate = String(r.plate ?? "").trim();
  const n = norm(r.plate_norm || plate);
  if (!plate || !n) return { action: "none", why: "nothing_read" };
  if (r.standard_format === false) return { action: "none", why: "not_standard_format" };   // รูปแบบไม่ใช่ทะเบียน (เช่น ตัวเกิน/ขาด) = ไม่เชื่อ
  const conf = Math.max(0, Math.min(1, Number(r.confidence ?? 0) || 0));
  if (conf < 0.5) return { action: "none", why: "low_confidence" };

  const logged = norm(loggedNormRaw);
  const placeholder = logged === norm(PLACEHOLDER);
  const yoloPlate = norm((r.yolo as Record<string, unknown> | undefined)?.plate);
  const yoloContradicts = yoloPlate !== "" && yoloPlate !== n;                              // YOLO อ่านได้อีกแบบ = ไม่ยืนยันอัตโนมัติ
  const provider = LOCAL.includes(String(r.provider)) ? String(r.provider) : "easyocr";
  const label = provider === "yolo+easyocr" ? "YOLO+EasyOCR" : provider === "yolo" ? "YOLO" : "EasyOCR";

  if (!placeholder && n === logged && !yoloContradicts) {
    return { action: "promote", plate, provider, conf, note: `อ่านซ้ำด้วยคอมแรง (${label}) ตรงกับที่บันทึก — ยืนยันอัตโนมัติ` };
  }
  if (placeholder && r.internal_agree === true && !yoloContradicts) {
    return { action: "promote", plate, provider: "yolo+easyocr", conf, note: `คอมแรงอ่านซ้ำได้ ${plate} (YOLO กับ EasyOCR ตรงกัน) — เติมทะเบียนให้อัตโนมัติ` };
  }
  if (n !== logged) {
    return { action: "note", note: `อ่านซ้ำคอมแรงได้: ${plate}${placeholder ? " (ยังไม่แน่ใจ)" : " (ต่างจากที่บันทึก)"} — ตรวจเทียบกับภาพ` };
  }
  return { action: "note", note: `อ่านซ้ำคอมแรงได้: ${plate} (ตรงกับที่บันทึก แต่ YOLO อ่านต่างออกไป) — ตรวจเทียบกับภาพ` };
}
