export interface OcrResult {
  found: boolean;
  plate: string;
  province: string | null;
  vehicle_type: string | null;
  confidence: number | null;
  needs_review?: boolean;
  alternatives?: string[];
  model?: string;
  provider?: string;
}
export interface OcrProvider {
  name: string;
  keyName?: string;
  isConfigured(): boolean;
  read(imageBase64: string, mediaType: string): Promise<OcrResult>;
}
