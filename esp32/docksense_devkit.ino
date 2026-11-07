/*
  DockSense DevKit — ตัวควบคุมหน้าประตู (ESP32 DevKit ธรรมดา ไม่ต้องใช้ Wi-Fi)

  ทำอะไร
    1) HC-SR04 วัดระยะรถที่เข้ามาหยุดหน้ากล้อง
    2) พอรถเข้าระยะและนิ่ง → เปิดรีเลย์ 1 (ไฟส่องป้าย) → ส่งสัญญาณสั่ง ESP32-CAM ถ่ายภาพป้ายทะเบียน
    3) ESP32-CAM อ่านทะเบียนได้ → ส่งสัญญาณกลับมา → รีเลย์ 2 ทำงาน 2 วินาที (ไฟสถานะ/กริ่ง)
    4) รถออกไป → ปิดไฟ พร้อมรับคันต่อไป

  Arduino IDE: Board = "ESP32 Dev Module"

  การต่อสาย (GND ทุกตัวต้องต่อรวมกัน)
    HC-SR04   VCC → 5V(VIN)   GND → GND   TRIG → GPIO5
              ECHO → ตัวต้านทาน 1kΩ → GPIO18 และจากจุดเดียวกัน → ตัวต้านทาน 2kΩ → GND   (ลดไฟ 5V เป็น 3.3V กันบอร์ดพัง)
    รีเลย์ 2 ช่อง  VCC → 5V(VIN)   GND → GND   IN1 → GPIO26   IN2 → GPIO27
    DevKit GPIO25 → ตัวต้านทาน 1kΩ → ESP32-CAM GPIO13      (สั่งถ่าย)
    ESP32-CAM GPIO14 → ตัวต้านทาน 1kΩ → DevKit GPIO32      (แจ้งผลกลับ)
*/

#define TRIG_PIN       5
#define ECHO_PIN       18
#define RELAY1_PIN     26     // ไฟส่องป้าย
#define RELAY2_PIN     27     // ไฟสถานะ / กริ่ง  (อย่าต่อกับประตู/ไม้กั้นโดยตรง ถ้ายังไม่ได้ตรวจสิทธิ์รถ)
#define CAM_TRIGGER_PIN 25
#define CAM_RESULT_PIN  32

const bool RELAY_ACTIVE_LOW = true;       // รีเลย์โมดูลส่วนใหญ่: สั่ง LOW = ทำงาน · ถ้าของคุณกลับกัน ให้เปลี่ยนเป็น false
const int  TRIGGER_CM       = 150;        // รถเข้าใกล้กว่านี้ถึงเริ่มถ่าย (ปรับตามหน้างาน)
const int  MIN_CM           = 20;         // ใกล้กว่านี้ถือว่าเป็นสัญญาณรบกวน
const uint32_t SETTLE_MS    = 800;        // รอให้รถนิ่ง + ไฟส่องป้ายสว่างก่อนสั่งถ่าย
const uint32_t TRIGGER_MS   = 1500;       // ความยาวสัญญาณสั่งถ่าย
const uint32_t LIGHT_MAX_MS = 90000;      // ไฟส่องป้ายเปิดนานสุด (กันค้าง)
const bool RELAY2_ON_RECOGNIZED = true;   // รีเลย์ 2 ทำงานเมื่อกล้องอ่านทะเบียนได้

static void relay(int pin, bool on) { digitalWrite(pin, (on ^ RELAY_ACTIVE_LOW) ? HIGH : LOW); }

static float readCm() {
  digitalWrite(TRIG_PIN, LOW); delayMicroseconds(3);
  digitalWrite(TRIG_PIN, HIGH); delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  unsigned long us = pulseIn(ECHO_PIN, HIGH, 30000);   // รอสูงสุด 30 ms (~5 เมตร)
  if (us == 0) return 999;
  return us * 0.0343f / 2.0f;
}
static float medianCm() {                                // กลางของ 3 ครั้ง ลดค่าเพี้ยน
  float a = readCm(); delay(25); float b = readCm(); delay(25); float c = readCm();
  if (a > b) { float t = a; a = b; b = t; }
  if (b > c) { b = c; }
  return a > b ? a : b;
}

enum State { IDLE, WAIT_LEAVE };
State state = IDLE;
int nearCount = 0, farCount = 0;
uint32_t lightOnAt = 0, relay2Until = 0;
bool lastResult = false;

void setup() {
  // ตั้งรีเลย์เป็น "ปิด" ก่อนอย่างอื่น กันรีเลย์ดีดตอนเปิดเครื่อง
  pinMode(RELAY1_PIN, OUTPUT); relay(RELAY1_PIN, false);
  pinMode(RELAY2_PIN, OUTPUT); relay(RELAY2_PIN, false);
  pinMode(TRIG_PIN, OUTPUT); digitalWrite(TRIG_PIN, LOW);
  pinMode(ECHO_PIN, INPUT);
  pinMode(CAM_TRIGGER_PIN, OUTPUT); digitalWrite(CAM_TRIGGER_PIN, LOW);
  pinMode(CAM_RESULT_PIN, INPUT_PULLDOWN);
  Serial.begin(115200);
  Serial.println("\n== DockSense DevKit พร้อมทำงาน ==");
}

void loop() {
  float d = medianCm();
  bool present = d >= MIN_CM && d <= TRIGGER_CM;

  if (state == IDLE) {
    nearCount = present ? nearCount + 1 : 0;
    if (nearCount >= 3) {                                  // เจอรถนิ่งต่อเนื่อง ~0.5 วินาที
      Serial.printf("เจอรถ ระยะ %.0f ซม. → เปิดไฟ + สั่งกล้องถ่าย\n", d);
      relay(RELAY1_PIN, true); lightOnAt = millis();
      delay(SETTLE_MS);
      digitalWrite(CAM_TRIGGER_PIN, HIGH); delay(TRIGGER_MS); digitalWrite(CAM_TRIGGER_PIN, LOW);
      state = WAIT_LEAVE; farCount = 0; nearCount = 0;
    }
  } else {
    farCount = present ? 0 : farCount + 1;
    if (farCount >= 8 || millis() - lightOnAt > LIGHT_MAX_MS) {   // รถออกไปแล้ว (~1.5 วินาที) หรือครบเวลา
      Serial.println("รถออกแล้ว → ปิดไฟ");
      relay(RELAY1_PIN, false); state = IDLE; farCount = 0;
    }
  }

  // กล้องแจ้งว่าอ่านทะเบียนได้
  bool res = digitalRead(CAM_RESULT_PIN) == HIGH;
  if (res && !lastResult && RELAY2_ON_RECOGNIZED) { relay(RELAY2_PIN, true); relay2Until = millis() + 2000; Serial.println("อ่านทะเบียนได้ → รีเลย์ 2"); }
  lastResult = res;
  if (relay2Until && millis() > relay2Until) { relay(RELAY2_PIN, false); relay2Until = 0; }

  delay(40);
}
