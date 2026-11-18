// นโยบาย "ผลที่เครื่องเดียวอ่าน" (Gemini/Claude ตอนคอมแรงออฟไลน์หรือยังไม่แน่ใจ) — ฟังก์ชันล้วน ทดสอบด้วย node ได้
// ปัญหาที่แก้: ก่อนหน้านี้ Gemini เป็นผู้อ่านคนเดียว ให้ความมั่นใจ 0.95 เท่ากันทุกใบ (ไม่ใช่ค่าที่วัดจริง) แล้วระบบบันทึกเป็น "รถใหม่" ทันที
// หลักการ: ผลของเครื่องเดียวต้องมี "ตัวยืนยันอิสระ" ก่อนถึงจะบันทึกอัตโนมัติ/ลงทะเบียนรถใหม่ — ไม่งั้นเก็บภาพ+ทะเบียนที่อ่านได้ไว้ "รอตรวจ" (ไม่ทิ้ง ไม่ลงทะเบียนมั่ว)
export const LOCAL_PROVIDERS = ["yolo+easyocr", "yolo", "easyocr", "tesseract"];
export const nk = (x: unknown) => String(x ?? "").replace(/[\s\-]/g, "").toUpperCase();

export type SoloWhy = "not_solo" | "backend_match" | "registered_exact" | "unconfirmed";
export function soloVerdict(a: {
  provider?: string | null; viaBackend: boolean; plate: string;
  weakPlate?: string | null; weakConf?: number | null; registeredCount: number;
}): { solo: boolean; confirmed: boolean; why: SoloWhy } {
  const solo = !a.viaBackend && !LOCAL_PROVIDERS.includes(String(a.provider ?? ""));
  if (!solo) return { solo: false, confirmed: true, why: "not_solo" };
  // ก) เครื่องอ่านฝั่งเซิร์ฟเวอร์/คอมอ่านได้สตริงเดียวกันทุกตัว (ความมั่นใจ ≥ 50%)
  if (a.weakPlate && nk(a.weakPlate) === nk(a.plate) && Number(a.weakConf ?? 0) >= 0.5) return { solo, confirmed: true, why: "backend_match" };
  // ข) ตรงทะเบียนของรถที่ลงทะเบียนไว้เพียงคันเดียวเป๊ะ (โอกาสอ่านผิดแล้วบังเอิญตรงรถจริงต่ำมาก)
  if (a.registeredCount === 1) return { solo, confirmed: true, why: "registered_exact" };
  return { solo, confirmed: false, why: "unconfirmed" };
}

export const SOLO_NOTE = " · อ่านด้วยเครื่องเดียว (Gemini) ยังไม่มีเครื่องที่สองยืนยัน — ไม่ลงทะเบียนรถใหม่เอง รอคอมแรงอ่านซ้ำหรือพนักงานตรวจ";
