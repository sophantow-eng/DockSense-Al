import test from "node:test";
import assert from "node:assert/strict";
import { decideReread, PLACEHOLDER, cleanPlate } from "./decide.ts";

const ok = (o: Record<string, unknown> = {}) => ({ found: true, plate: "2ฒฐ 4183", plate_norm: "2ฒฐ4183", confidence: 0.9, standard_format: true, status: "VERIFIED", provider: "yolo+easyocr", internal_agree: true, yolo: { plate: "2ฒฐ4183" }, ...o });

test("ตรงกับที่บันทึก + ไม่มี YOLO ขัด → ยืนยันอัตโนมัติ", () => {
  const v = decideReread("2ฒฐ4183", ok());
  assert.equal(v.action, "promote");
  if (v.action === "promote") { assert.equal(v.provider, "yolo+easyocr"); assert.match(v.note, /ตรงกับที่บันทึก/); }
});
test("ตรงกัน แม้ EasyOCR เดี่ยว (YOLO อ่านไม่ได้) ก็ยืนยันได้", () => {
  const v = decideReread("2ฒฐ4183", ok({ provider: "easyocr", internal_agree: false, yolo: { plate: null }, status: "NEEDS_REVIEW" }));
  assert.equal(v.action, "promote");
});
test("ตรงกันแต่ YOLO อ่านเป็นอีกแบบ → ไม่ยืนยัน แค่แนบหมายเหตุ", () => {
  const v = decideReread("2ฒฐ4183", ok({ internal_agree: false, yolo: { plate: "2ณ48803" } }));
  assert.equal(v.action, "note");
});
test("ต่างจากที่บันทึก → ไม่แก้ทะเบียน แนบข้อเสนอเท่านั้น", () => {
  const v = decideReread("2ณฐ4183", ok());
  assert.equal(v.action, "note");
  if (v.action === "note") { assert.match(v.note, /อ่านซ้ำคอมแรงได้: 2ฒฐ 4183/); assert.match(v.note, /ต่างจากที่บันทึก/); }
});
test("รายการว่าง: YOLO+EasyOCR ตรงกันเอง → เติมทะเบียน", () => {
  const v = decideReread(PLACEHOLDER, ok());
  assert.equal(v.action, "promote");
  if (v.action === "promote") assert.equal(v.plate, "2ฒฐ 4183");
});
test("รายการว่าง: เครื่องเดียวอ่านได้ → เป็นข้อเสนอ ไม่เติมเอง", () => {
  const v = decideReread(PLACEHOLDER, ok({ internal_agree: false, provider: "easyocr", yolo: { plate: null } }));
  assert.equal(v.action, "note");
  if (v.action === "note") assert.match(v.note, /ยังไม่แน่ใจ/);
});
test("รูปแบบไม่ใช่ทะเบียน / ความมั่นใจต่ำ / error / ไม่มีผล → ไม่ทำอะไร", () => {
  assert.equal(decideReread("2ฒฐ4183", ok({ standard_format: false })).action, "none");
  assert.equal(decideReread("2ฒฐ4183", ok({ confidence: 0.3 })).action, "none");
  assert.equal(decideReread("2ฒฐ4183", { status: "ERROR", error: "x" }).action, "none");
  assert.equal(decideReread("2ฒฐ4183", { found: false, plate: null }).action, "none");
  assert.equal(decideReread("2ฒฐ4183", null).action, "none");
});
test("ช่องว่าง/ขีด/ตัวพิมพ์ไม่ทำให้เทียบพลาด", () => {
  assert.equal(decideReread("55-3011", ok({ plate: "55-3011", plate_norm: "553011", yolo: { plate: "553011" } })).action, "promote");
  assert.equal(decideReread(" 2ฒฐ 4183 ", ok()).action, "promote");
});
test("provider แปลกปลอม → ใช้ easyocr", () => {
  const v = decideReread("2ฒฐ4183", ok({ provider: "evil", yolo: { plate: null } }));
  assert.equal(v.action === "promote" && v.provider, "easyocr");
});

test("cleanPlate: รูปแบบทะเบียนปกติผ่าน ข้อความแปลกปลอมไม่ผ่าน", () => {
  for (const ok of ["2ฒฐ 4183", "1กฆ9151", "ฆว 1053", "55-3011".replace("55-", "กข-"), "7กณ 6929"]) assert.equal(cleanPlate(ok), ok);
  for (const bad of ["", "abc", "'; drop table", "2ฒฐ 41833", "<b>กข 12</b>", "กขคง 1234", null, undefined]) assert.equal(cleanPlate(bad), null);
});
