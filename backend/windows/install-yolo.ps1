# Add the YOLO character reader to the worker environment (venv-easyocr) WITHOUT touching torch/numpy/opencv.
# ASCII only on purpose (Windows PowerShell 5.1). Stop the worker first:  autostart.ps1 stop
#   powershell -ExecutionPolicy Bypass -File windows\install-yolo.ps1
$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$py = Join-Path $Root "venv-easyocr\Scripts\python.exe"
if (-not (Test-Path $py)) { Write-Host "Not found: $py"; exit 1 }
$bak = Join-Path $Root "pip-backup.txt"
& $py -m pip freeze | Out-File -Encoding ascii $bak
Write-Host "Saved package list to $bak (for rollback)"
& $py -m pip install --no-deps ultralytics ultralytics-thop ultralytics-platform
& $py -m pip install matplotlib polars pyyaml requests psutil huggingface_hub httpx nvidia-ml-py
Write-Host "---- checks ----"
& $py -c "import ultralytics; print('ultralytics OK', ultralytics.__version__)"
& $py -c "import easyocr, cv2, numpy; print('easyocr OK, opencv', cv2.__version__, 'numpy', numpy.__version__)"
Write-Host "If both lines above say OK, run: autostart.ps1 start"
