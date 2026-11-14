# จัดการให้ DockSense Worker เปิดเองตอนเข้า Windows
#   ติดตั้ง : powershell -ExecutionPolicy Bypass -File windows\autostart.ps1 install
#   ปิดถาวร : powershell -ExecutionPolicy Bypass -File windows\autostart.ps1 uninstall   (เลิกเปิดเองตอนเปิดเครื่อง)
#   หยุดตอนนี้: powershell -ExecutionPolicy Bypass -File windows\autostart.ps1 stop
#   เริ่มตอนนี้: powershell -ExecutionPolicy Bypass -File windows\autostart.ps1 start
#   ดูสถานะ  : powershell -ExecutionPolicy Bypass -File windows\autostart.ps1 status
param([Parameter(Mandatory = $true)][ValidateSet("install", "uninstall", "start", "stop", "status")][string]$Action)
$ErrorActionPreference = "Stop"
$TaskName = "DockSenseWorker"
$Backend = Split-Path -Parent $PSScriptRoot                    # ...\backend
$Root = Split-Path -Parent $Backend                            # ...\DockSenseAI-Worker
$Venv = Join-Path $Root "venv-easyocr\Scripts\Activate.ps1"
$Start = Join-Path $PSScriptRoot "start-worker.ps1"
$Log = Join-Path $Root "worker.log"

function Stop-Worker {
  # หยุดโปรแกรมที่ฟังพอร์ต 8000 (worker) เท่านั้น ไม่แตะโปรแกรมอื่น
  $c = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue
  foreach ($x in $c) { try { Stop-Process -Id $x.OwningProcess -Force } catch {} }
}

switch ($Action) {
  "install" {
    if (-not (Test-Path $Venv)) { throw "ไม่พบ $Venv (ตรวจโฟลเดอร์ venv-easyocr)" }
    $cmd = "& '$Venv'; & '$Start' *>> '$Log'"
    $act = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ("-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -Command `"$cmd`"") -WorkingDirectory $Backend
    $trg = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $TaskName -Action $act -Trigger $trg -Settings $set -Description "DockSense AI Worker (EasyOCR)" -Force | Out-Null
    Write-Host "ติดตั้งแล้ว: worker จะเปิดเองเมื่อล็อกอิน Windows (ซ่อนหน้าต่าง) · บันทึกการทำงาน: $Log"
    Write-Host "เริ่มตอนนี้เลย: ... autostart.ps1 start   |   หยุด: ... autostart.ps1 stop   |   เลิกเปิดเอง: ... autostart.ps1 uninstall"
  }
  "uninstall" {
    Stop-Worker
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "ปิดและลบการเปิดเองแล้ว (worker หยุดแล้ว และจะไม่เปิดเองอีก)"
  }
  "start" { Start-ScheduledTask -TaskName $TaskName; Write-Host "สั่งเริ่มแล้ว (รอ ~30 วินาทีให้โหลดโมเดล แล้วตรวจด้วย: status)" }
  "stop" { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue; Stop-Worker; Write-Host "หยุด worker แล้ว (ครั้งหน้าที่ล็อกอินจะเปิดเองอีก ถ้าไม่ต้องการให้ใช้ uninstall)" }
  "status" {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Write-Host ("ตั้งเปิดเองตอนเปิดเครื่อง: " + $(if ($t) { "ใช่ ($($t.State))" } else { "ไม่" }))
    try { $h = Invoke-RestMethod -Uri "http://127.0.0.1:8000/api/v1/health" -TimeoutSec 5; Write-Host ("worker ตอบกลับ: ok=" + $h.ok + " ai=" + $h.ai) } catch { Write-Host "worker ไม่ตอบกลับ (ยังไม่เปิด หรือกำลังโหลดโมเดล)" }
  }
}
