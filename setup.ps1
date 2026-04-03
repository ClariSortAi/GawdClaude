# GawdClaude One-Shot Setup
# Run from an elevated PowerShell:
#   powershell -ExecutionPolicy Bypass -File setup.ps1
#
# Dry run (simulates a clean machine, changes nothing):
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -DryRun
#
# This script:
#   1. Checks for admin privileges
#   2. Installs Git and Node.js via winget if missing
#   3. Runs the interactive Node setup (config.json)
#   4. Optionally registers scheduled tasks

param(
  [switch]$SkipDeps,
  [switch]$SkipSchedule,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$projectDir = $PSScriptRoot

# ============================================================
# Helpers
# ============================================================

function Write-Step($msg) { Write-Host "`n--- $msg ---" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  OK: $msg" -ForegroundColor Green }
function Write-Skip($msg) { Write-Host "  SKIP: $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "  ERROR: $msg" -ForegroundColor Red }
function Write-Dry($msg)  { Write-Host "  [DRY RUN] $msg" -ForegroundColor DarkGray }

function Test-CommandExists($cmd) {
  $null = Get-Command $cmd -ErrorAction SilentlyContinue
  return $?
}

function Refresh-Path {
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath    = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path    = "$machinePath;$userPath"
}

# ============================================================
# 1. Admin check
# ============================================================

Write-Host ""
Write-Host "  GawdClaude Setup" -ForegroundColor Magenta
Write-Host "  ================" -ForegroundColor Magenta
if ($DryRun) {
  Write-Host "  MODE: Dry Run (no changes will be made)" -ForegroundColor DarkGray
}
Write-Host ""

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  if ($DryRun) {
    Write-Dry "Not running as admin. In a real run, this would exit with an error."
    Write-Dry "Continuing dry run to show remaining steps..."
  } else {
    Write-Err "This script requires Administrator privileges."
    Write-Host "  Right-click PowerShell and select 'Run as administrator', then try again." -ForegroundColor Yellow
    exit 1
  }
} else {
  Write-Ok "Running as Administrator"
}

# ============================================================
# 2. Check / install dependencies
# ============================================================

if (-not $SkipDeps) {
  Write-Step "Checking dependencies"

  # --- winget ---
  if (-not (Test-CommandExists "winget")) {
    if ($DryRun) {
      Write-Dry "winget not found. Would exit with error."
      Write-Dry "On a clean Windows 11 install, winget is pre-installed."
    } else {
      Write-Err "winget not found. winget ships with Windows 11 and recent Windows 10 builds."
      Write-Host "  Install 'App Installer' from the Microsoft Store, then re-run this script." -ForegroundColor Yellow
      exit 1
    }
  } else {
    Write-Ok "winget available"
  }

  # --- Git ---
  if (Test-CommandExists "git") {
    $gitVersion = (git --version) 2>&1
    Write-Ok "Git already installed ($gitVersion)"
    if ($DryRun) {
      Write-Dry "On a clean machine: would run 'winget install --id Git.Git --silent'"
    }
  } else {
    if ($DryRun) {
      Write-Dry "Git not found. Would run: winget install --id Git.Git --accept-source-agreements --accept-package-agreements --silent"
    } else {
      Write-Host "  Installing Git via winget..." -ForegroundColor Yellow
      winget install --id Git.Git --accept-source-agreements --accept-package-agreements --silent
      if ($LASTEXITCODE -ne 0) {
        Write-Err "Git installation failed (exit code $LASTEXITCODE)"
        exit 1
      }
      Refresh-Path
      if (Test-CommandExists "git") {
        Write-Ok "Git installed successfully"
      } else {
        Write-Skip "Git installed but not on PATH yet. You may need to restart your terminal."
      }
    }
  }

  # --- Node.js ---
  if (Test-CommandExists "node") {
    $nodeVersion = (node --version) 2>&1
    $major = [int]($nodeVersion -replace '^v(\d+)\..*', '$1')
    if ($major -lt 18) {
      if ($DryRun) {
        Write-Dry "Node.js $nodeVersion found (below 18). Would run: winget install --id OpenJS.NodeJS.LTS --silent"
      } else {
        Write-Host "  Node.js $nodeVersion found but GawdClaude requires 18+. Upgrading..." -ForegroundColor Yellow
        winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
        Refresh-Path
      }
    } else {
      Write-Ok "Node.js already installed ($nodeVersion)"
      if ($DryRun) {
        Write-Dry "On a clean machine: would run 'winget install --id OpenJS.NodeJS.LTS --silent'"
      }
    }
  } else {
    if ($DryRun) {
      Write-Dry "Node.js not found. Would run: winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent"
    } else {
      Write-Host "  Installing Node.js LTS via winget..." -ForegroundColor Yellow
      winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
      if ($LASTEXITCODE -ne 0) {
        Write-Err "Node.js installation failed (exit code $LASTEXITCODE)"
        exit 1
      }
      Refresh-Path
      if (Test-CommandExists "node") {
        $nodeVersion = (node --version) 2>&1
        Write-Ok "Node.js installed ($nodeVersion)"
      } else {
        Write-Err "Node.js installed but not on PATH. Restart your terminal and re-run this script."
        exit 1
      }
    }
  }

  # --- Final node check ---
  if (-not $DryRun) {
    $nodeVersion = (node --version) 2>&1
    $major = [int]($nodeVersion -replace '^v(\d+)\..*', '$1')
    if ($major -lt 18) {
      Write-Err "Node.js $nodeVersion is below the minimum (18+). Please update manually."
      exit 1
    }
  } else {
    Write-Dry "Would verify Node.js >= 18 is on PATH"
  }
}
else {
  Write-Skip "Dependency installation (--SkipDeps)"
}

# ============================================================
# 3. Run interactive Node setup
# ============================================================

Write-Step "Running interactive setup"
Write-Host ""
Write-Host "  This will ask you a few questions to configure GawdClaude." -ForegroundColor White
Write-Host "  - Where your project repos live" -ForegroundColor White
Write-Host "  - Dashboard port (default 6660)" -ForegroundColor White
Write-Host "  - Obsidian vault path (optional)" -ForegroundColor White
Write-Host ""

if ($DryRun) {
  Write-Dry "Would run: node setup.mjs (interactive prompts)"
  Write-Dry "  Asks for: devDir, port, Obsidian vault path"
  Write-Dry "  Writes: config.json with user-provided values"

  # Check if config.json already exists for remaining dry-run steps
  $configPath = Join-Path $projectDir "config.json"
  if (Test-Path $configPath) {
    Write-Dry "config.json already exists - using it for remaining validation steps"
  } else {
    Write-Dry "config.json does not exist - remaining steps would use values from the interactive setup"
    Write-Dry "Simulating with defaults: devDir=C:\Dev, port=6660, obsidian=null"
  }
} else {
  Push-Location $projectDir
  try {
    node setup.mjs
    if ($LASTEXITCODE -ne 0) {
      Write-Err "setup.mjs failed (exit code $LASTEXITCODE)"
      exit 1
    }
  }
  finally {
    Pop-Location
  }

  # Verify config.json was created
  if (-not (Test-Path (Join-Path $projectDir "config.json"))) {
    Write-Err "config.json was not created. Setup may have failed."
    exit 1
  }
  Write-Ok "config.json created"
}

# ============================================================
# 4. Validate the configured devDir exists
# ============================================================

Write-Step "Validating configuration"

$configPath = Join-Path $projectDir "config.json"
if (Test-Path $configPath) {
  $config = Get-Content $configPath | ConvertFrom-Json
  $devDir = $config.devDir
} else {
  # Dry run without existing config - use platform default
  $devDir = if ($env:OS -eq "Windows_NT") { "C:\Dev" } else { Join-Path $HOME "dev" }
}

if (-not (Test-Path $devDir)) {
  if ($DryRun) {
    Write-Dry "Projects directory does not exist: $devDir"
    Write-Dry "Would prompt: Create it? [Y/n]"
    Write-Dry "If yes: creates directory. If no: dashboard shows empty project list with guidance."
  } else {
    Write-Host "  Projects directory does not exist: $devDir" -ForegroundColor Yellow
    $create = Read-Host "  Create it? [Y/n]"
    if ($create -eq "" -or $create -eq "Y" -or $create -eq "y") {
      New-Item -ItemType Directory -Path $devDir -Force | Out-Null
      Write-Ok "Created $devDir"
    } else {
      Write-Skip "Directory not created. The dashboard will show no projects until this directory exists."
    }
  }
} else {
  $projectCount = (Get-ChildItem -Path $devDir -Directory).Count
  Write-Ok "Projects directory exists: $devDir ($projectCount subdirectories)"
}

# Check for Claude Code
if (Test-CommandExists "claude") {
  Write-Ok "Claude Code CLI found on PATH"
} else {
  Write-Host ""
  Write-Host "  NOTE: Claude Code CLI not found on PATH." -ForegroundColor Yellow
  Write-Host "  The dashboard and audit work without it, but the CLAUDE.md healing" -ForegroundColor Yellow
  Write-Host "  loop requires Claude Code to be installed and authenticated." -ForegroundColor Yellow
  Write-Host "  Install: npm install -g @anthropic-ai/claude-code" -ForegroundColor Yellow
  Write-Host "  Then:    claude auth login" -ForegroundColor Yellow
}

# ============================================================
# 5. Run initial audit
# ============================================================

Write-Step "Running initial audit"

if ($DryRun) {
  Write-Dry "Would run: node audit.mjs"
  Write-Dry "Scans ~/.claude/ and devDir for config health"
  Write-Dry "Result: JSON with overall status, issue count, project inventory"
} else {
  Push-Location $projectDir
  try {
    node audit.mjs | Out-Null
    if ($LASTEXITCODE -eq 0) {
      Write-Ok "Initial audit completed"
    } else {
      Write-Skip "Audit returned non-zero (non-fatal, dashboard will retry)"
    }
  }
  catch {
    Write-Skip "Audit failed: $($_.Exception.Message) (non-fatal)"
  }
  finally {
    Pop-Location
  }
}

# ============================================================
# 6. Scheduled tasks (optional)
# ============================================================

if (-not $SkipSchedule) {
  Write-Step "Scheduled tasks"
  Write-Host ""
  Write-Host "  GawdClaude can register two Windows Scheduled Tasks:" -ForegroundColor White
  Write-Host "    1. GawdClaude-Nightly  - daily audit at 2:00 AM" -ForegroundColor White
  Write-Host "    2. GawdClaude-Server   - dashboard server at logon (auto-restart)" -ForegroundColor White
  Write-Host ""

  if ($DryRun) {
    Write-Dry "Would prompt: Register scheduled tasks now? [Y/n]"
    Write-Dry "If yes: runs register-task.ps1 (requires admin)"
    Write-Dry "  -> Register-ScheduledTask 'GawdClaude-Nightly' -Daily -At '2:00AM'"
    Write-Dry "  -> Register-ScheduledTask 'GawdClaude-Server' -AtLogOn"
    Write-Dry "If no: prints manual instructions for later registration"
  } else {
    $schedule = Read-Host "  Register scheduled tasks now? [Y/n]"

    if ($schedule -eq "" -or $schedule -eq "Y" -or $schedule -eq "y") {
      & (Join-Path $projectDir "register-task.ps1")
      if ($LASTEXITCODE -eq 0) {
        Write-Ok "Scheduled tasks registered"
      } else {
        Write-Err "Task registration failed (exit code $LASTEXITCODE)"
      }
    } else {
      Write-Host ""
      Write-Host "  To register later, run:" -ForegroundColor White
      Write-Host "    powershell -ExecutionPolicy Bypass -File `"$projectDir\register-task.ps1`"" -ForegroundColor Yellow
      Write-Host ""
      Write-Host "  Or run manually anytime:" -ForegroundColor White
      Write-Host "    node audit.mjs              # one-shot audit" -ForegroundColor Yellow
      Write-Host "    node audit.mjs --nightly    # audit + write to Obsidian" -ForegroundColor Yellow
      Write-Host "    node server.mjs             # start dashboard" -ForegroundColor Yellow
    }
  }
}
else {
  Write-Skip "Scheduled task registration (--SkipSchedule)"
}

# ============================================================
# Done
# ============================================================

$port = if ($config) { $config.port } else { 6660 }

Write-Host ""
if ($DryRun) {
  Write-Host "  ====================================" -ForegroundColor DarkGray
  Write-Host "  Dry run complete - nothing modified" -ForegroundColor DarkGray
  Write-Host "  ====================================" -ForegroundColor DarkGray
  Write-Host ""
  Write-Host "  Summary of what a real run would do:" -ForegroundColor White
  Write-Host "    1. Install Git + Node.js LTS via winget (if missing)" -ForegroundColor DarkGray
  Write-Host "    2. Run interactive setup -> write config.json" -ForegroundColor DarkGray
  Write-Host "    3. Create devDir if it does not exist" -ForegroundColor DarkGray
  Write-Host "    4. Run initial audit" -ForegroundColor DarkGray
  Write-Host "    5. Optionally register scheduled tasks" -ForegroundColor DarkGray
  Write-Host ""
  Write-Host "  To run for real:" -ForegroundColor White
  Write-Host "    powershell -ExecutionPolicy Bypass -File setup.ps1" -ForegroundColor Cyan
} else {
  Write-Host "  ==============================" -ForegroundColor Green
  Write-Host "  GawdClaude setup complete!" -ForegroundColor Green
  Write-Host "  ==============================" -ForegroundColor Green
  Write-Host ""
  Write-Host "  Start the dashboard:" -ForegroundColor White
  Write-Host "    node server.mjs" -ForegroundColor Cyan
  Write-Host "    -> http://localhost:$($port)" -ForegroundColor Cyan
}
Write-Host ""
