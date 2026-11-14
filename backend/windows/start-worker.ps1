# Start the DockSense AI Worker on a Windows laptop (run from the backend folder, venv-easyocr active).
# ASCII only on purpose (Windows PowerShell 5.1 misreads BOM-less UTF-8).
# First run creates a random BACKEND_KEY in .worker.env (never shown, never uploaded).
# If queue.env exists (QUEUE_URL / QUEUE_KEY) the worker also PULLS jobs from the cloud queue by itself,
# so no tunnel / public link into this laptop is needed.
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
$envFile = ".worker.env"
if (-not (Test-Path $envFile)) {
  $bytes = New-Object byte[] 24
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $key = [Convert]::ToBase64String($bytes).Replace("+","a").Replace("/","b").Replace("=","")
  Set-Content -Path $envFile -Value ("BACKEND_KEY=" + $key) -Encoding ascii
  Write-Host "Created a new key in .worker.env (keep it secret)"
}
foreach ($f in @($envFile, "queue.env")) {
  if (Test-Path $f) {
    Get-Content $f | ForEach-Object { if ($_ -match "^\s*([A-Z_]+)\s*=\s*(.*)$") { Set-Item -Path ("Env:" + $Matches[1]) -Value $Matches[2].Trim() } }
  }
}
$env:Path += ";C:\Program Files\Tesseract-OCR"
if (-not $env:AI_LOCAL) { $env:AI_LOCAL = "1" }
if (-not $env:OCR_CONCURRENCY) { $env:OCR_CONCURRENCY = "1" }
if (-not $env:TESS_LANG) { $env:TESS_LANG = "tha+eng" }
$env:OMP_NUM_THREADS = "4"
if ($env:QUEUE_URL -and $env:QUEUE_KEY) { Write-Host "Queue mode ON: pulling jobs from the cloud (no tunnel needed)" } else { Write-Host "Queue mode OFF (no queue.env)" }
Write-Host "Starting at http://127.0.0.1:8000  (stop: Ctrl+C)"
# cmd /c merges stderr into stdout inside cmd, so PowerShell never turns uvicorn's log lines into errors
# (with log redirection + ErrorActionPreference=Stop, the first stderr line used to kill the worker silently).
$ErrorActionPreference = "Continue"
cmd /c "python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 2>&1"
