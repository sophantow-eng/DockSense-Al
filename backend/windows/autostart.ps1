# Run the DockSense Worker automatically when you log in to Windows.
# (ASCII only on purpose: Windows PowerShell 5.1 misreads UTF-8 files without BOM.)
#   install   : powershell -ExecutionPolicy Bypass -File windows\autostart.ps1 install
#   uninstall : powershell -ExecutionPolicy Bypass -File windows\autostart.ps1 uninstall   (stop auto-start for good)
#   stop      : powershell -ExecutionPolicy Bypass -File windows\autostart.ps1 stop
#   start     : powershell -ExecutionPolicy Bypass -File windows\autostart.ps1 start
#   status    : powershell -ExecutionPolicy Bypass -File windows\autostart.ps1 status
param([Parameter(Mandatory = $true)][ValidateSet("install", "uninstall", "start", "stop", "status")][string]$Action)
$ErrorActionPreference = "Stop"
$TaskName = "DockSenseWorker"
$Backend = Split-Path -Parent $PSScriptRoot
$Root = Split-Path -Parent $Backend
$Venv = Join-Path $Root "venv-easyocr\Scripts\Activate.ps1"
$Start = Join-Path $PSScriptRoot "start-worker.ps1"
$Log = Join-Path $Root "worker.log"

function Stop-Worker {
  # Stops only the program listening on port 8000 (the worker), nothing else.
  $c = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue
  foreach ($x in $c) { try { Stop-Process -Id $x.OwningProcess -Force } catch {} }
}

switch ($Action) {
  "install" {
    if (-not (Test-Path $Venv)) { throw "Not found: $Venv (check the venv-easyocr folder)" }
    $cmd = "& '$Venv'; & '$Start' *>> '$Log'"
    $arg = "-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -Command `"$cmd`""
    $act = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arg -WorkingDirectory $Backend
    $trg = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $TaskName -Action $act -Trigger $trg -Settings $set -Description "DockSense AI Worker (EasyOCR)" -Force | Out-Null
    Write-Host "Installed. The worker will start by itself (hidden window) when you log in to Windows."
    Write-Host "Log file: $Log"
    Write-Host "Start now: autostart.ps1 start | Stop: autostart.ps1 stop | Remove auto-start: autostart.ps1 uninstall"
  }
  "uninstall" {
    Stop-Worker
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed. The worker is stopped and will not start by itself any more."
  }
  "start" {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Started. Wait about 30 seconds for the model to load, then run: autostart.ps1 status"
  }
  "stop" {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Stop-Worker
    Write-Host "Worker stopped. It will start again at next login (use uninstall to prevent that)."
  }
  "status" {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($t) { Write-Host ("Auto-start at login: YES (" + $t.State + ")") } else { Write-Host "Auto-start at login: NO" }
    try {
      $h = Invoke-RestMethod -Uri "http://127.0.0.1:8000/api/v1/health" -TimeoutSec 5
      Write-Host ("Worker is answering: ok=" + $h.ok + " ai=" + $h.ai)
    } catch { Write-Host "Worker is not answering (not started yet, or still loading the model)" }
  }
}
