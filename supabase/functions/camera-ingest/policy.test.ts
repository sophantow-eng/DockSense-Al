import test from "node:test";
import assert from "node:assert/strict";
import { soloVerdict } from "./policy.ts";

const base = { provider: "gemini", viaBackend: false, plate: "2ฒฐ 4183", weakPlate: null, weakConf: null, registeredCount: 0 };

test("Gemini เดี่ยว ไม่มีตัวยืนยัน → ไม่ผ่าน (ไม่สร้างรถใหม่เอง)", () => {
  assert.deepEqual(soloVerdict(base), { solo: true, confirmed: false, why: "unconfirmed" });
});
test("ตรงรถที่ลงทะเบียนไว้ 1 คันเป๊ะ → ผ่าน", () => {
  assert.equal(soloVerdict({ ...base, registeredCount: 1 }).confirmed, true);
});
test("ทะเบียนซ้ำหลายคัน (กำกวม) → ไม่ผ่าน", () => {
  assert.equal(soloVerdict({ ...base, registeredCount: 2 }).confirmed, false);
});
test("เครื่องอ่านหลักอ่านได้สตริงเดียวกัน (ความมั่นใจ ≥ 50%) → ผ่าน แม้ต่างช่องว่าง/ขีด", () => {
  assert.equal(soloVerdict({ ...base, weakPlate: "2ฒฐ4183", weakConf: 0.62 }).why, "backend_match");
  assert.equal(soloVerdict({ ...base, plate: "55-3011", weakPlate: "55 3011", weakConf: 0.5 }).confirmed, true);
});
test("เครื่องอ่านหลักอ่านต่างกัน หรือมั่นใจต่ำ → ไม่นับเป็นตัวยืนยัน", () => {
  assert.equal(soloVerdict({ ...base, weakPlate: "2ฒฐ4188", weakConf: 0.9 }).confirmed, false);
  assert.equal(soloVerdict({ ...base, weakPlate: "2ฒฐ4183", weakConf: 0.3 }).confirmed, false);
});
test("ผลจากเครื่องอ่านฝั่งคอม/เซิร์ฟเวอร์เอง ไม่ใช่เดี่ยว → ผ่านตามเดิม", () => {
  assert.deepEqual(soloVerdict({ ...base, provider: "yolo+easyocr", viaBackend: true }), { solo: false, confirmed: true, why: "not_solo" });
  assert.equal(soloVerdict({ ...base, provider: "tesseract" }).solo, false);
});
test("ไม่มี provider (ไม่รู้ที่มา) และไม่ผ่านแบ็กเอนด์ → ถือเป็นเครื่องเดียว", () => {
  assert.equal(soloVerdict({ ...base, provider: undefined }).solo, true);
});
