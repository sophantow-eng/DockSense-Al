# เริ่ม DockSense AI Worker บนแล็ปท็อป (Windows) — รันจากโฟลเดอร์ backend ด้วย venv-easyocr
# ครั้งแรกจะสร้างรหัส BACKEND_KEY สุ่มเก็บไว้ในไฟล์ .worker.env (ไม่แสดงบนจอ ไม่ขึ้น GitHub)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
$envFile = ".worker.env"
if (-not (Test-Path $envFile)) {
  $bytes = New-Object byte[] 24
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $key = [Convert]::ToBase64String($bytes).Replace("+","a").Replace("/","b").Replace("=","")
  Set-Content -Path $envFile -Value ("BACKEND_KEY=" + $key) -Encoding ascii
  Write-Host "สร้างรหัสใหม่ไว้ใน .worker.env แล้ว (ห้ามส่งให้ใคร)"
}
Get-Content $envFile | ForEach-Object { if ($_ -match "^\s*([A-Z_]+)\s*=\s*(.*)$") { Set-Item -Path ("Env:" + $Matches[1]) -Value $Matches[2] } }
$env:Path += ";C:\Program Files\Tesseract-OCR"
if (-not $env:AI_LOCAL) { $env:AI_LOCAL = "1" }
if (-not $env:OCR_CONCURRENCY) { $env:OCR_CONCURRENCY = "1" }
if (-not $env:TESS_LANG) { $env:TESS_LANG = "tha+eng" }
$env:OMP_NUM_THREADS = "4"
Write-Host "เริ่มที่ http://127.0.0.1:8000  (หยุด: กด Ctrl+C)"
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
