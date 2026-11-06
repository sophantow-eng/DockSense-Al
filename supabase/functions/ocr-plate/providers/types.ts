export interface OcrResult {
  plate: string;
  province: string | null;
  vehicle_type: string | null;
  confidence: number | null; // 0..1
  found: boolean;
}
export interface OcrProvider {
  name: string;
  isConfigured(): boolean;
  read(imageBase64: string, mediaType: string): Promise<OcrResult>;
}
