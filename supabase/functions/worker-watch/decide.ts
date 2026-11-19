// ตัดสินว่า "คอมแรง (EasyOCR+YOLO)" ออฟไลน์/กลับมา ต้องแจ้งเตือนไหม — ฟังก์ชันล้วน ทดสอบด้วย node:
//   node --experimental-strip-types --test decide.test.ts
// กติกา: แจ้งครั้งเดียวต่อการหลุด 1 ครั้ง (ไม่รัวทุก 5 นาที) + แจ้งอีกครั้งเมื่อกลับมา · ออฟไลน์ = ไม่เห็นสัญญาณเกิน 10 นาที
export const OFFLINE_AFTER_MS = 10 * 60_000;

export type WatchState = { state?: "online" | "offline"; since?: string | null } | null | undefined;
export type WatchAction =
  | { action: "alert"; minutes: number | null; since: string | null }
  | { action: "recovered"; downMinutes: number | null }
  | { action: "init_online" }
  | { action: "none" };

export function decideWatch(lastSeenIso: string | null | undefined, nowMs: number, st: WatchState): WatchAction {
  const t = lastSeenIso ? Date.parse(lastSeenIso) : NaN;
  const hasSeen = Number.isFinite(t);
  const offline = !hasSeen || nowMs - t > OFFLINE_AFTER_MS;
  if (offline) {
    if (st?.state === "offline") return { action: "none" };
    return { action: "alert", minutes: hasSeen ? Math.floor((nowMs - t) / 60_000) : null, since: hasSeen ? new Date(t).toISOString() : null };
  }
  if (st?.state === "offline") {
    const s = st.since ? Date.parse(st.since) : NaN;
    return { action: "recovered", downMinutes: Number.isFinite(s) ? Math.max(0, Math.floor((nowMs - s) / 60_000)) : null };
  }
  return st ? { action: "none" } : { action: "init_online" };
}

export function fmtDur(min: number | null): string {
  if (min === null || !Number.isFinite(min)) return "ไม่ทราบเวลา";
  if (min < 60) return `${min} นาที`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 48) return m ? `${h} ชม. ${m} นาที` : `${h} ชม.`;
  return `${Math.floor(h / 24)} วัน ${h % 24} ชม.`;
}
