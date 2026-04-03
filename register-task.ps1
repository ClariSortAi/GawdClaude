# GawdClaude Task Scheduler Registration
# Run: powershell -ExecutionPolicy Bypass -File register-task.ps1

$nodePath = (Get-Command node).Source
$projectDir = $PSScriptRoot

# --- Task 1: Nightly Audit at 2:00 AM ---
$nightlyAction = New-ScheduledTaskAction `
  -Execute $nodePath `
  -Argument "`"$projectDir\audit.mjs`" --nightly" `
  -WorkingDirectory $projectDir

$nightlyTrigger = New-ScheduledTaskTrigger -Daily -At "2:00AM"

$nightlySettings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

Register-ScheduledTask `
  -TaskName "GawdClaude-Nightly" `
  -Action $nightlyAction `
  -Trigger $nightlyTrigger `
  -Settings $nightlySettings `
  -Description "GawdClaude nightly audit — scans all Claude Code configs and writes to Obsidian vault" `
  -Force

Write-Host "Registered: GawdClaude-Nightly (daily at 2:00 AM)" -ForegroundColor Green

# --- Task 2: Dashboard Server at Logon ---
$serverAction = New-ScheduledTaskAction `
  -Execute $nodePath `
  -Argument "`"$projectDir\server.mjs`"" `
  -WorkingDirectory $projectDir

$serverTrigger = New-ScheduledTaskTrigger -AtLogOn

$serverSettings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit 0

Register-ScheduledTask `
  -TaskName "GawdClaude-Server" `
  -Action $serverAction `
  -Trigger $serverTrigger `
  -Settings $serverSettings `
  -Description "GawdClaude dashboard server — localhost:6660" `
  -Force

Write-Host "Registered: GawdClaude-Server (at logon, auto-restart)" -ForegroundColor Green
Write-Host ""
Write-Host "Dashboard will be at: http://localhost:6660" -ForegroundColor Cyan
Write-Host "To start now: node $projectDir\server.mjs" -ForegroundColor Cyan
