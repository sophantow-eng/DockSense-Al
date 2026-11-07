/*
  DockSense CAM — ESP32-CAM (AI Thinker)   [โค้ดนี้สร้างจากหน้าเว็บ DockSense AI]

  ทำอะไรได้
    - เปิดกล้องอัตโนมัติ: ลอง JPEG ในตัวก่อน ถ้าเซนเซอร์ไม่รองรับ (err 0x106) จะใช้ RGB565 แล้วแปลง JPEG เอง
    - ส่งภาพตัวอย่างเข้าเว็บให้ปุ่ม "ดูภาพสด" (ไม่ผ่าน OCR ไม่กินโควตา)
        ว่าง ๆ ส่งทุก 15 วินาที · มีคนเปิดดูในเว็บ ส่งทุก ~1 วินาที
    - อ่านทะเบียน (OCR) ตามตัวสั่งที่เลือกในหน้าเว็บ (PIR / ตั้งเวลา / ปิด)
    - เปิดหน้าดูภาพสดบนตัวกล้องเองในวง Wi-Fi เดียวกัน  ->  http://<IP กล้อง>/   (/stream = วิดีโอ, /jpg = ภาพนิ่ง)
    - ต่อ Wi-Fi ใหม่/รีสตาร์ตเองเมื่อมีปัญหา

  ไฟแดงบนบอร์ด: กะพริบ 2 ครั้ง = พร้อม · 1 ครั้ง = ส่งอ่านทะเบียนสำเร็จ · 4 ครั้ง = ไม่สำเร็จ

  Arduino IDE:  Board = AI Thinker ESP32-CAM · Tools -> PSRAM = Enabled (สำคัญ) · Partition = Huge APP (3MB No OTA)
*/

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include "esp_camera.h"
#include "soc/soc.h"
#include "soc/rtc_cntl_reg.h"

// ===================== ตั้งค่า (หน้าเว็บใส่ให้แล้ว) =====================
const char* WIFI_SSID  = "__WIFI_SSID__";
const char* WIFI_PASSWORD = "__WIFI_PASS__";
const char* INGEST_URL = "__URL__";
const char* DEVICE_KEY = "__KEY__";
const char* SUPABASE_ANON_KEY = "";          // ปกติปล่อยว่าง

#define PIR_PIN __PIR__                      // ขาเซ็นเซอร์ตรวจจับ (PIR OUT) · -1 = ไม่ใช้
const uint32_t OCR_INTERVAL_MS = __INTERVAL__; // เมื่อไม่ใช้ PIR: อ่านทะเบียนทุกกี่ ms (0 = ปิดการอ่านทะเบียน ดูภาพสดอย่างเดียว)
const uint32_t SETTLE_MS   = 700;            // รอให้รถเข้ากรอบหลัง PIR ตรวจพบ
const uint32_t COOLDOWN_MS = 8000;           // พักหลังอ่านทะเบียนแต่ละครั้ง (กันส่งรถคันเดิมซ้ำ)

const bool     PREVIEW_ENABLED     = true;   // ส่งภาพตัวอย่างเข้าเว็บ (ปุ่ม ดูภาพสด)
const uint32_t WATCH_INTERVAL_MS   = 250;    // ช่วงพักระหว่างภาพตอนมีคนเปิดดู (ms) — ความเร็วจริงขึ้นกับอินเทอร์เน็ต ปกติ 2–4 ภาพ/วินาที

const framesize_t FRAME_SIZE       = FRAMESIZE_VGA;  // VGA 640x480 (ลอง FRAMESIZE_SVGA ได้ถ้าต้องการภาพละเอียดขึ้น)
const uint8_t  JPEG_QUALITY        = 80;     // คุณภาพ JPEG ของ OCR / ภาพนิ่ง (0-100)
const uint8_t  PREVIEW_JPEG_QUALITY = 55;    // ภาพสดในเว็บ (ใช้ค่านี้แค่ตอนต้องแปลง RGB565) · โหมด JPEG ในตัวใช้ PREVIEW_SENSOR_Q
const int      PREVIEW_SENSOR_Q    = 16;     // คุณภาพภาพสด (เลขน้อย = คมขึ้นแต่ไฟล์ใหญ่/ช้าลง · 10–30)
const framesize_t PREVIEW_SIZE     = FRAMESIZE_VGA;   // ภาพสดในเว็บ 640x480
const framesize_t OCR_SIZE         = FRAMESIZE_SXGA;  // ภาพอ่านทะเบียน 1280x1024 (คมชัดกว่ามาก)
const int      OCR_SENSOR_Q        = 10;     // ภาพอ่านทะเบียนให้คมชัด (เลขน้อย = คมขึ้น)
const bool     FLIP_VERTICAL       = false;  // ภาพกลับหัว -> true
const bool     MIRROR_HORIZONTAL   = false;  // ภาพกลับซ้ายขวา -> true
// ===============================================================================

// AI Thinker pins
#define PWDN_GPIO_NUM   32
#define RESET_GPIO_NUM  -1
#define XCLK_GPIO_NUM    0
#define SIOD_GPIO_NUM   26
#define SIOC_GPIO_NUM   27
#define Y9_GPIO_NUM     35
#define Y8_GPIO_NUM     34
#define Y7_GPIO_NUM     39
#define Y6_GPIO_NUM     36
#define Y5_GPIO_NUM     21
#define Y4_GPIO_NUM     19
#define Y3_GPIO_NUM     18
#define Y2_GPIO_NUM      5
#define VSYNC_GPIO_NUM  25
#define HREF_GPIO_NUM   23
#define PCLK_GPIO_NUM   22

#define LED_RED_PIN     33   // ไฟแดงหลังบอร์ด (active LOW)
#define LED_FLASH_PIN    4   // แฟลชขาว (ปิดไว้)

static bool nativeJpeg = false;
static int  sensorQ = 12;
static framesize_t curSize = FRAMESIZE_VGA;
WebServer server(80);

// ---------- LED ----------
static void blinkRed(int times) {
  for (int i = 0; i < times; i++) {
    digitalWrite(LED_RED_PIN, LOW);
    delay(120);
    digitalWrite(LED_RED_PIN, HIGH);
    delay(180);
  }
}

// ---------- Camera ----------
static camera_config_t makeConfig(pixformat_t fmt, uint32_t xclk = 20000000) {
  camera_config_t c = {};
  c.ledc_channel = LEDC_CHANNEL_0;
  c.ledc_timer   = LEDC_TIMER_0;
  c.pin_d0 = Y2_GPIO_NUM;  c.pin_d1 = Y3_GPIO_NUM;
  c.pin_d2 = Y4_GPIO_NUM;  c.pin_d3 = Y5_GPIO_NUM;
  c.pin_d4 = Y6_GPIO_NUM;  c.pin_d5 = Y7_GPIO_NUM;
  c.pin_d6 = Y8_GPIO_NUM;  c.pin_d7 = Y9_GPIO_NUM;
  c.pin_xclk  = XCLK_GPIO_NUM;
  c.pin_pclk  = PCLK_GPIO_NUM;
  c.pin_vsync = VSYNC_GPIO_NUM;
  c.pin_href  = HREF_GPIO_NUM;
  c.pin_sccb_sda = SIOD_GPIO_NUM;
  c.pin_sccb_scl = SIOC_GPIO_NUM;
  c.pin_pwdn  = PWDN_GPIO_NUM;
  c.pin_reset = RESET_GPIO_NUM;
  c.xclk_freq_hz = xclk;
  c.pixel_format = fmt;
  c.grab_mode    = CAMERA_GRAB_LATEST;
  c.fb_count     = 1;

  if (psramFound()) {
    c.fb_location  = CAMERA_FB_IN_PSRAM;
    c.frame_size   = (fmt == PIXFORMAT_JPEG) ? OCR_SIZE : FRAME_SIZE;   // JPEG: เปิดที่ขนาดใหญ่สุด แล้วลดลงได้ตามต้องการ
    c.jpeg_quality = 12;
  } else {
    c.fb_location  = CAMERA_FB_IN_DRAM;
    c.frame_size   = FRAMESIZE_QVGA;
    c.jpeg_quality = 15;
  }
  return c;
}

static bool initCamera() {
  // ลองหลายแบบ: JPEG 20MHz → JPEG 10MHz (สายแพ/ไฟไม่นิ่ง) → RGB565 (เซนเซอร์ที่ไม่รองรับ JPEG)
  const uint32_t clks[2] = {20000000, 10000000};
  bool ok = false;
  for (int i = 0; i < 2 && !ok; i++) {
    camera_config_t cfg = makeConfig(PIXFORMAT_JPEG, clks[i]);
    esp_err_t err = esp_camera_init(&cfg);
    if (err == ESP_OK) { ok = true; nativeJpeg = true; Serial.printf("camera: JPEG mode OK (%d MHz)\n", (int)(clks[i] / 1000000)); }
    else { Serial.printf("camera: JPEG init failed 0x%x (%d MHz)\n", (unsigned)err, (int)(clks[i] / 1000000)); esp_camera_deinit(); delay(300); }
  }
  if (!ok) {
    camera_config_t cfg = makeConfig(PIXFORMAT_RGB565, 10000000);
    esp_err_t err = esp_camera_init(&cfg);
    if (err != ESP_OK) {
      Serial.printf("camera: RGB565 init failed 0x%x  (0x105 = ไม่พบกล้อง ตรวจสายแพ · 0x101/0x20001 = หน่วยความจำ)\n", (unsigned)err);
      return false;
    }
    nativeJpeg = false;
    Serial.println("camera: RGB565 mode OK (software JPEG)");
  }

  sensor_t* s = esp_camera_sensor_get();
  if (s && nativeJpeg && psramFound()) { s->set_framesize(s, PREVIEW_SIZE); curSize = PREVIEW_SIZE; s->set_quality(s, PREVIEW_SENSOR_Q); sensorQ = PREVIEW_SENSOR_Q; }
  if (s) {
    Serial.printf("camera: sensor PID=0x%04x\n", s->id.PID);
    s->set_vflip(s, FLIP_VERTICAL ? 1 : 0);
    s->set_hmirror(s, MIRROR_HORIZONTAL ? 1 : 0);
  }

  for (int i = 0; i < 5; i++) {   // ทิ้งเฟรมแรก ๆ ให้แสงนิ่ง
    camera_fb_t* fb = esp_camera_fb_get();
    if (fb) esp_camera_fb_return(fb);
    delay(100);
  }
  return true;
}

// ถ่าย 1 รูป -> JPEG buffer (ต้อง free() เมื่อ needFree = true)
static bool captureJpeg(uint8_t** out, size_t* outLen, bool* needFree, uint8_t quality) {
  *out = nullptr; *outLen = 0; *needFree = false;

  if (nativeJpeg && psramFound()) {   // ภาพสด = VGA บีบพอดี · ภาพอ่านทะเบียน = SXGA คมชัด
    bool ocrShot = quality > PREVIEW_JPEG_QUALITY;
    framesize_t wantS = ocrShot ? OCR_SIZE : PREVIEW_SIZE;
    int wantQ = ocrShot ? OCR_SENSOR_Q : PREVIEW_SENSOR_Q;
    sensor_t* sn = esp_camera_sensor_get();
    if (sn && (wantS != curSize || wantQ != sensorQ)) {
      if (wantS != curSize) { sn->set_framesize(sn, wantS); curSize = wantS; }
      if (wantQ != sensorQ) { sn->set_quality(sn, wantQ); sensorQ = wantQ; }
      for (int i = 0; i < 3; i++) { camera_fb_t* d = esp_camera_fb_get(); if (d) esp_camera_fb_return(d); delay(30); }
    }
  }
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("capture: esp_camera_fb_get() failed");
    return false;
  }

  if (nativeJpeg && fb->format == PIXFORMAT_JPEG) {
    uint8_t* copy = (uint8_t*)malloc(fb->len);
    if (!copy) { esp_camera_fb_return(fb); return false; }
    memcpy(copy, fb->buf, fb->len);
    *out = copy; *outLen = fb->len; *needFree = true;
    esp_camera_fb_return(fb);
    return true;
  }

  uint8_t* jpg = nullptr;
  size_t jpgLen = 0;
  bool ok = fmt2jpg(fb->buf, fb->len, fb->width, fb->height,
                    fb->format, quality, &jpg, &jpgLen);
  esp_camera_fb_return(fb);

  if (!ok || !jpg || jpgLen == 0) {
    Serial.println("capture: software JPEG convert failed");
    if (jpg) free(jpg);
    return false;
  }
  *out = jpg; *outLen = jpgLen; *needFree = true;
  return true;
}

// ---------- Wi-Fi ----------
static bool connectWiFi(uint32_t timeoutMs = 20000) {
  if (WiFi.status() == WL_CONNECTED) return true;
  Serial.printf("wifi: connecting to %s ", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(false);            // ลดอาการภาพกระตุก
  WiFi.setTxPower(WIFI_POWER_19_5dBm);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < timeoutMs) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("wifi: connected, IP = ");
    Serial.println(WiFi.localIP());
    return true;
  }
  Serial.println("wifi: connect failed");
  return false;
}

// ---------- หน้าเว็บบนตัวกล้อง ----------
static void handleRoot() {
  String html =
    "<!doctype html><html><head><meta charset='utf-8'>"
    "<meta name='viewport' content='width=device-width,initial-scale=1'>"
    "<title>DockSense CAM</title>"
    "<style>body{margin:0;background:#0b1220;color:#e6edf7;font-family:sans-serif;text-align:center}"
    "img{max-width:100%;height:auto;margin-top:12px;border-radius:8px}"
    "a{color:#4fd1c5;margin:0 8px}</style></head><body>"
    "<h3>DockSense CAM - ภาพสด</h3>"
    "<img src='/stream'><br><p><a href='/jpg'>ภาพนิ่ง</a></p>"
    "</body></html>";
  server.send(200, "text/html; charset=utf-8", html);
}

static void handleJpg() {
  uint8_t* jpg; size_t len; bool nf;
  if (!captureJpeg(&jpg, &len, &nf, JPEG_QUALITY)) {
    server.send(503, "text/plain", "capture failed");
    return;
  }
  WiFiClient client = server.client();
  client.printf("HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\n"
                "Content-Length: %u\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n",
                (unsigned)len);
  client.write(jpg, len);
  if (nf) free(jpg);
}

static void handleStream() {
  WiFiClient client = server.client();
  client.print("HTTP/1.1 200 OK\r\n"
               "Content-Type: multipart/x-mixed-replace; boundary=frame\r\n"
               "Cache-Control: no-cache\r\nConnection: close\r\n\r\n");
  int fails = 0;
  while (client.connected()) {
    uint8_t* jpg; size_t len; bool nf;
    if (!captureJpeg(&jpg, &len, &nf, PREVIEW_JPEG_QUALITY)) {
      if (++fails >= 10) break;
      delay(100);
      continue;
    }
    fails = 0;
    client.printf("--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n", (unsigned)len);
    client.write(jpg, len);
    client.print("\r\n");
    if (nf) free(jpg);
    delay(1);
  }
}

// ---------- ส่งขึ้นเซิร์ฟเวอร์ ----------
// ใช้การเชื่อมต่อ HTTPS ค้างไว้ (keep-alive) ไม่ต้องจับมือ TLS ใหม่ทุกครั้ง -> ลดหน่วงมาก
static WiFiClientSecure secureClient;
static HTTPClient       httpc;
static bool             secureReady = false;

// preview = true  -> ส่งไป ?preview=1 (เก็บเป็น latest.jpg ไม่ผ่าน OCR)
// preview = false -> ส่งอ่านทะเบียน (OCR)
// nextMs: ค่าที่เซิร์ฟเวอร์บอกให้รอ (ถ้ามีคนดูอยู่ จะถูกแทนด้วย WATCH_INTERVAL_MS)
static bool postJpeg(const uint8_t* data, size_t len, bool preview, uint32_t* nextMs) {
  if (!secureReady) {
    secureClient.setInsecure();
    secureClient.setTimeout(10);
    secureReady = true;
  }

  String url = String(INGEST_URL) + (preview ? "?preview=1" : "");
  httpc.setReuse(true);
  httpc.setConnectTimeout(6000);
  httpc.setTimeout(preview ? 8000 : 30000);
  if (!httpc.begin(secureClient, url)) { secureClient.stop(); return false; }
  httpc.addHeader("Content-Type", "image/jpeg");
  httpc.addHeader("x-device-key", DEVICE_KEY);
  if (preview) httpc.addHeader("x-local-ip", WiFi.localIP().toString());   // ให้หน้าเว็บมีลิงก์ดูแบบลื่นในวง Wi-Fi เดียวกัน
  if (SUPABASE_ANON_KEY[0] != '\0') {
    httpc.addHeader("apikey", SUPABASE_ANON_KEY);
    httpc.addHeader("Authorization", String("Bearer ") + SUPABASE_ANON_KEY);
  }

  uint32_t t0 = millis();
  int code = httpc.POST((uint8_t*)data, len);
  Serial.printf("http: %s %u bytes -> %d (%u ms)\n", preview ? "preview" : "ocr",
                (unsigned)len, code, (unsigned)(millis() - t0));
  if (code > 0) {
    String body = httpc.getString();
    if (!preview || code >= 300) {
      if (body.length() > 600) body = body.substring(0, 600);
      Serial.println("http: response: " + body);
    }
    if (nextMs) {
      if (body.indexOf("\"watch\":true") >= 0) {
        *nextMs = WATCH_INTERVAL_MS;
      } else {
        int i = body.indexOf("\"next_ms\":");
        if (i >= 0) {
          long v = body.substring(i + 10).toInt();
          if (v >= 1000 && v <= 60000) *nextMs = (uint32_t)v;
        }
      }
    }
  } else {
    Serial.printf("http: error: %s\n", httpc.errorToString(code).c_str());
    secureClient.stop();            // บังคับเชื่อมต่อใหม่รอบหน้า
  }
  httpc.end();
  return code >= 200 && code < 300;
}

// ขนาดไฟล์ภาพสด (ใช้ตรวจว่าภาพในกรอบเปลี่ยน = มีรถเข้ามา) ไม่ส่งขึ้นเน็ต
static long probeLen() {
  if (nativeJpeg && psramFound()) {
    sensor_t* sn = esp_camera_sensor_get();
    if (sn && (curSize != PREVIEW_SIZE || sensorQ != PREVIEW_SENSOR_Q)) {
      sn->set_framesize(sn, PREVIEW_SIZE); curSize = PREVIEW_SIZE; sn->set_quality(sn, PREVIEW_SENSOR_Q); sensorQ = PREVIEW_SENSOR_Q;
      for (int i = 0; i < 3; i++) { camera_fb_t* d = esp_camera_fb_get(); if (d) esp_camera_fb_return(d); delay(30); }
    }
  }
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) return 0;
  long n = (long)fb->len;
  esp_camera_fb_return(fb);
  return n;
}

// ---------- setup / loop ----------
void setup() {
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);
  Serial.begin(115200);
  delay(500);
  Serial.println("\n=== DockSense CAM v4 ===");

  pinMode(LED_RED_PIN, OUTPUT);
  digitalWrite(LED_RED_PIN, HIGH);
  pinMode(LED_FLASH_PIN, OUTPUT);
  digitalWrite(LED_FLASH_PIN, LOW);
  if (PIR_PIN >= 0) pinMode(PIR_PIN, INPUT);

  Serial.printf("PSRAM: %s\n", psramFound() ? "found" : "NOT FOUND (เปิด Tools -> PSRAM)");

  if (!initCamera()) {
    Serial.println("กล้องเริ่มทำงานไม่ได้ — ปิดไฟ ถอดแล้วเสียบสายแพกล้องให้แน่น แล้วเสียบ USB ใหม่ (จะลองใหม่ใน 5 วินาที)");
    blinkRed(3);
    delay(5000);
    ESP.restart();
  }

  connectWiFi();

  server.on("/", handleRoot);
  server.on("/jpg", handleJpg);
  server.on("/stream", handleStream);
  server.begin();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("ดูภาพสดที่: http://");
    Serial.println(WiFi.localIP());
    blinkRed(2);   // กะพริบ 2 ครั้ง = กล้องพร้อม
  }
}

void loop() {
  server.handleClient();

  static uint32_t lastStatus = 0;
  if (millis() - lastStatus > 15000) {
    lastStatus = millis();
    if (WiFi.status() == WL_CONNECTED) {
      Serial.printf("status: online, http://%s/\n", WiFi.localIP().toString().c_str());
    } else {
      Serial.println("status: wifi lost, reconnecting");
      connectWiFi(10000);
    }
  }

  // ส่งภาพตัวอย่างเข้าเว็บ (ให้ปุ่ม "ดูภาพสด" ทำงาน)
  static uint32_t lastPreview = 0, previewEvery = 15000;
  static int previewFails = 0, captureFails = 0;
  if (PREVIEW_ENABLED && WiFi.status() == WL_CONNECTED &&
      (lastPreview == 0 || millis() - lastPreview >= previewEvery)) {
    lastPreview = millis();
    uint8_t* jpg = nullptr; size_t len = 0; bool nf = false;
    if (captureJpeg(&jpg, &len, &nf, PREVIEW_JPEG_QUALITY)) {
      captureFails = 0;
      bool ok = postJpeg(jpg, len, true, &previewEvery);
      if (nf && jpg) free(jpg);
      if (ok) {
        previewFails = 0;
      } else {
        previewEvery = 5000;
        previewFails++;
        if (previewFails == 5) {            // เน็ต/เซิร์ฟเวอร์มีปัญหา -> ต่อ Wi-Fi ใหม่
          Serial.println("recover: reconnect wifi");
          secureClient.stop();
          WiFi.disconnect();
          delay(500);
          connectWiFi(15000);
        } else if (previewFails >= 20) {    // ไม่หายจริง ๆ -> รีสตาร์ต
          Serial.println("recover: restart");
          delay(300);
          ESP.restart();
        }
      }
    } else {
      previewEvery = 3000;
      if (++captureFails >= 8) {            // กล้องค้าง -> รีสตาร์ต
        Serial.println("recover: camera stuck, restart");
        delay(300);
        ESP.restart();
      }
    }
  }

  // อ่านทะเบียน (OCR): ตาม PIR หรือตั้งเวลา (OCR_INTERVAL_MS = 0 และไม่มี PIR = ปิด)
  static uint32_t lastOcr = 0;
  bool trigger = false;
  if (PIR_PIN >= 0) {
    if (digitalRead(PIR_PIN) == HIGH && (lastOcr == 0 || millis() - lastOcr >= COOLDOWN_MS)) {
      uint32_t t0 = millis();
      while (millis() - t0 < SETTLE_MS) { server.handleClient(); delay(10); }
      trigger = true;
    }
  } else if (OCR_INTERVAL_MS > 0) {
    // อัตโนมัติ: ภาพในกรอบเปลี่ยน (รถเข้า) แล้วนิ่ง ~1.5 วินาที → อ่านทะเบียนทันที · นอกจากนั้นตรวจซ้ำตามรอบ
    static uint32_t lastChk = 0; static long base = 0; static bool changed = false; static int calm = 0;
    if (millis() - lastChk >= 700) {
      lastChk = millis();
      long L = probeLen();
      if (L > 0) {
        if (base == 0) base = L;
        float d = fabsf((float)(L - base)) / (float)base;
        if (d > 0.12f) { changed = true; calm = 0; }
        else if (changed && d < 0.06f && ++calm >= 2) { trigger = true; changed = false; calm = 0; }
        base = (long)(base * 0.6f + L * 0.4f);
      }
    }
    if (!trigger && (lastOcr == 0 || millis() - lastOcr >= OCR_INTERVAL_MS)) trigger = true;
    if (trigger && lastOcr != 0 && millis() - lastOcr < 3000) trigger = false;   // อย่าถี่กว่า 3 วินาที
  }
  if (trigger && WiFi.status() == WL_CONNECTED) {
    lastOcr = millis();
    uint8_t* jpg = nullptr; size_t len = 0; bool nf = false;
    if (captureJpeg(&jpg, &len, &nf, JPEG_QUALITY)) {
      bool ok = postJpeg(jpg, len, false, nullptr);
      if (nf && jpg) free(jpg);
      blinkRed(ok ? 1 : 4);
    } else {
      blinkRed(4);
    }
  }
}
