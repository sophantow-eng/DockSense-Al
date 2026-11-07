// DockSense AI — ESP32-CAM (AI Thinker) ถ่ายรูปทะเบียนแล้วส่งเข้าระบบ
// ระบบจะอ่านทะเบียน บันทึกในเว็บ และแจ้ง Telegram พร้อมลิงก์ดูข้อมูลรถให้อัตโนมัติ
// Arduino IDE: Board = "AI Thinker ESP32-CAM" (ติดตั้ง esp32 by Espressif v2.x/3.x)

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include "esp_camera.h"

// ---------- ตั้งค่า ----------
const char* WIFI_SSID  = "__WIFI_SSID__";
const char* WIFI_PASS  = "__WIFI_PASS__";
const char* INGEST_URL = "__URL__";
const char* DEVICE_KEY = "__KEY__";

#define PIR_PIN __PIR__                  // ขาเซ็นเซอร์ตรวจจับ (PIR/อัลตราโซนิก ขา OUT) · -1 = ไม่ใช้ ถ่ายตามเวลา
const unsigned long INTERVAL_MS = __INTERVAL__;  // ใช้เมื่อ PIR_PIN = -1
const unsigned long SETTLE_MS   = 700;    // รอให้รถเข้ากรอบหลังเซ็นเซอร์ตรวจพบ
const unsigned long COOLDOWN_MS = 8000;   // พักหลังส่งแต่ละครั้ง (กันส่งรถคันเดิมซ้ำ)

// ---------- ขากล้อง AI Thinker ----------
#define PWDN_GPIO_NUM 32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 0
#define SIOD_GPIO_NUM 26
#define SIOC_GPIO_NUM 27
#define Y9_GPIO_NUM 35
#define Y8_GPIO_NUM 34
#define Y7_GPIO_NUM 39
#define Y6_GPIO_NUM 36
#define Y5_GPIO_NUM 21
#define Y4_GPIO_NUM 19
#define Y3_GPIO_NUM 18
#define Y2_GPIO_NUM 5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM 23
#define PCLK_GPIO_NUM 22
#define LED_RED 33  // ไฟแดงบนบอร์ด (ติดเมื่อ LOW)

void blink(int n, int ms = 120) {
  for (int i = 0; i < n; i++) { digitalWrite(LED_RED, LOW); delay(ms); digitalWrite(LED_RED, HIGH); delay(ms); }
}

bool initCamera() {
  camera_config_t c;
  c.ledc_channel = LEDC_CHANNEL_0; c.ledc_timer = LEDC_TIMER_0;
  c.pin_d0 = Y2_GPIO_NUM; c.pin_d1 = Y3_GPIO_NUM; c.pin_d2 = Y4_GPIO_NUM; c.pin_d3 = Y5_GPIO_NUM;
  c.pin_d4 = Y6_GPIO_NUM; c.pin_d5 = Y7_GPIO_NUM; c.pin_d6 = Y8_GPIO_NUM; c.pin_d7 = Y9_GPIO_NUM;
  c.pin_xclk = XCLK_GPIO_NUM; c.pin_pclk = PCLK_GPIO_NUM; c.pin_vsync = VSYNC_GPIO_NUM; c.pin_href = HREF_GPIO_NUM;
  c.pin_sccb_sda = SIOD_GPIO_NUM; c.pin_sccb_scl = SIOC_GPIO_NUM;
  c.pin_pwdn = PWDN_GPIO_NUM; c.pin_reset = RESET_GPIO_NUM;
  c.xclk_freq_hz = 20000000; c.pixel_format = PIXFORMAT_JPEG;
  c.frame_size = FRAMESIZE_SXGA;   // 1280x1024 พอสำหรับอ่านทะเบียน
  c.jpeg_quality = 12; c.fb_count = 2; c.grab_mode = CAMERA_GRAB_LATEST;
  if (!psramFound()) { c.frame_size = FRAMESIZE_SVGA; c.fb_count = 1; }
  if (esp_camera_init(&c) != ESP_OK) return false;
  sensor_t* s = esp_camera_sensor_get();
  if (s) { s->set_whitebal(s, 1); s->set_exposure_ctrl(s, 1); s->set_gain_ctrl(s, 1); }
  return true;
}

void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.mode(WIFI_STA); WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) delay(300);
}

bool captureAndSend() {
  connectWifi();
  if (WiFi.status() != WL_CONNECTED) return false;
  camera_fb_t* fb = esp_camera_fb_get();   // ทิ้งเฟรมเก่าที่ค้างในบัฟเฟอร์
  if (fb) esp_camera_fb_return(fb);
  fb = esp_camera_fb_get();
  if (!fb) return false;
  WiFiClientSecure client; client.setInsecure();
  HTTPClient http; http.setTimeout(45000);
  bool ok = false;
  if (http.begin(client, INGEST_URL)) {
    http.addHeader("Content-Type", "image/jpeg");
    http.addHeader("x-device-key", DEVICE_KEY);
    int code = http.POST(fb->buf, fb->len);
    String body = http.getString();
    Serial.printf("HTTP %d %s\n", code, body.c_str());
    ok = (code == 200);
    http.end();
  }
  esp_camera_fb_return(fb);
  return ok;
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_RED, OUTPUT); digitalWrite(LED_RED, HIGH);
  if (PIR_PIN >= 0) pinMode(PIR_PIN, INPUT);
  if (!initCamera()) { Serial.println("camera init failed"); while (true) { blink(3); delay(1000); } }
  connectWifi();
  Serial.println(WiFi.status() == WL_CONNECTED ? "WiFi OK" : "WiFi FAILED");
  blink(2);
}

void loop() {
  if (PIR_PIN >= 0) {
    if (digitalRead(PIR_PIN) != HIGH) { delay(50); return; }
    delay(SETTLE_MS);
  } else {
    delay(INTERVAL_MS);
  }
  bool ok = captureAndSend();
  blink(ok ? 1 : 4, ok ? 400 : 100);   // กะพริบ 1 ครั้ง = ส่งสำเร็จ · 4 ครั้ง = ส่งไม่สำเร็จ
  if (PIR_PIN >= 0) delay(COOLDOWN_MS);
}
