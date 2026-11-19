import test from "node:test";
import assert from "node:assert/strict";
import { decideWatch, fmtDur } from "./decide.ts";

const NOW = Date.parse("2026-11-19T00:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

test("เห็นสัญญาณเมื่อไม่นานนี้ + ยังไม่มีสถานะ → จดว่าออนไลน์เงียบๆ (ไม่แจ้ง)", () => {
  assert.deepEqual(decideWatch(ago(1), NOW, null), { action: "init_online" });
});
test("ออนไลน์ต่อเนื่อง → ไม่ทำอะไร", () => {
  assert.deepEqual(decideWatch(ago(2), NOW, { state: "online" }), { action: "none" });
});
test("เงียบเกิน 10 นาที → แจ้งเตือน (ครั้งแรก)", () => {
  const a = decideWatch(ago(15), NOW, { state: "online" });
  assert.equal(a.action, "alert"); assert.equal((a as { minutes: number }).minutes, 15);
});
test("เงียบ 10 นาทีพอดี → ยังไม่แจ้ง (ต้องเกิน)", () => {
  assert.equal(decideWatch(ago(10), NOW, { state: "online" }).action, "none");
});
test("ออฟไลน์ต่อเนื่อง และแจ้งไปแล้ว → ไม่แจ้งซ้ำ", () => {
  assert.deepEqual(decideWatch(ago(600), NOW, { state: "offline", since: ago(590) }), { action: "none" });
});
test("กลับมาออนไลน์หลังหลุด → แจ้งกลับมา พร้อมเวลาที่หายไป", () => {
  assert.deepEqual(decideWatch(ago(0), NOW, { state: "offline", since: ago(125) }), { action: "recovered", downMinutes: 125 });
});
test("ไม่เคยมีสัญญาณเลย → แจ้งเตือน (ไม่ทราบเวลา)", () => {
  assert.deepEqual(decideWatch(null, NOW, null), { action: "alert", minutes: null, since: null });
});
test("ค่าเวลาเพี้ยน → ถือเป็นไม่เคยเห็น ไม่ล้ม", () => {
  assert.equal(decideWatch("not-a-date", NOW, undefined).action, "alert");
});
test("รูปแบบข้อความระยะเวลา", () => {
  assert.equal(fmtDur(45), "45 นาที"); assert.equal(fmtDur(125), "2 ชม. 5 นาที"); assert.equal(fmtDur(120), "2 ชม.");
  assert.equal(fmtDur(60 * 60), "2 วัน 12 ชม."); assert.equal(fmtDur(null), "ไม่ทราบเวลา");
});
