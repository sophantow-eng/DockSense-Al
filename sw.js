/* DockSense service worker — เปิดเร็วแบบแอป + ใช้เปลือกแอปได้แม้เน็ตหลุด
   กติกาความปลอดภัย: แตะเฉพาะไฟล์ของเว็บเราเอง (same-origin GET) — ไม่แตะ Supabase / ฟังก์ชัน / รูปป้าย / realtime
   โค้ด (html/js/css) = เอาจากเน็ตก่อน (ได้เวอร์ชันล่าสุดเสมอ) ถ้าเน็ตช้า/หลุดใช้ของในเครื่อง
   ไอคอน/โลโก้ = ใช้ของในเครื่องก่อน (ไม่เปลี่ยนบ่อย) */
const V = "ds-v10";
const SHELL = ["./", "index.html", "scan.html", "style.css", "common.js", "plate-detect.js", "live-governor.js", "config.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon.svg", "logo.svg", "apple-touch-icon.png"];
const NET_TIMEOUT = 4000;

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(V);
    await Promise.all(SHELL.map((u) => c.add(u).catch(() => null)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== V) await caches.delete(k);
    await self.clients.claim();
  })());
});

const isCode = (u) => /\.(html|js|css|webmanifest)$/.test(u.pathname) || u.pathname.endsWith("/");

async function networkFirst(req) {
  const cache = await caches.open(V);
  try {
    const res = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), NET_TIMEOUT))]);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (_) {
    return (await cache.match(req, { ignoreSearch: true })) || (await cache.match("index.html")) || Response.error();
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(V);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone());
  return res;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const u = new URL(req.url);
  if (u.origin !== self.location.origin) return;               // Supabase, CDN ฯลฯ ปล่อยผ่านตามปกติ
  if (req.headers.has("range")) return;
  e.respondWith(isCode(u) || req.mode === "navigate" ? networkFirst(req) : cacheFirst(req));
});
