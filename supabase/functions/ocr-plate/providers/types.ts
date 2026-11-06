export interface OcrResult {
  plate: string;
  province: string | null;
  vehicle_type: string | null;
  confidence: number | null; // 0..1
  found: boolean;
  needs_review?: boolean; // true = AI ไม่ชัวร์ ให้ผู้ใช้ตรวจกับภาพก่อนบันทึก
  alternatives?: string[]; // ผลอ่านอีกแบบที่ไม่ตรงกัน (ให้ผู้ใช้เลือก)
  model?: string;
}
export interface OcrProvider {
  name: string;
  keyName?: string;
  isConfigured(): boolean;
  read(imageBase64: string, mediaType: string): Promise<OcrResult>;
}
