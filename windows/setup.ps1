<#
    SMK TV — dependency setup & doctor
    ==================================

    Run this on a PC where SMK TV misbehaves (most often: "push notifications
    don't arrive here"). It reports every dependency the app needs, says which
    ones are missing, and installs the ones it can.

    Usage (from windows\):
        .\setup.ps1              # check, then install what's missing
        .\setup.ps1 -CheckOnly   # report only, change nothing
        .\setup.ps1 -Verbose     # extra detail

    Why this file exists
    --------------------
    Most of what SMK TV needs is baked into the .exe: the Node.js runtime, the
    React UI, firebase-admin, express, ws, qrcode, selfsigned — plus a payload
    (yt-dlp.exe, cloudflared.exe, cookies.txt and .env) that the .exe unpacks
    next to itself on first run. So a fresh PC needs almost nothing installed.

    The two exceptions this script exists for:
      * Node.js — NOT needed for notifications, but the PO-Token provider
        (which keeps yt-dlp from tripping YouTube's bot checks) is a separate
        `node` process, so it needs a real Node.js >= 20 on PATH.
      * ffmpeg/ffprobe — optional; only the higher-quality split-mux relay path
        uses them. The relay falls back to proxy-combined without them.
#>

[CmdletBinding()]
param(
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Continue'

# ── Output helpers ───────────────────────────────────────────────────────────

$script:Problems = New-Object System.Collections.ArrayList
$script:Notes    = New-Object System.Collections.ArrayList

function Write-Head($text) {
    Write-Host ''
    Write-Host "  $text" -ForegroundColor Cyan
    Write-Host ('  ' + ('-' * $text.Length)) -ForegroundColor DarkGray
}
function Write-Ok($text)   { Write-Host "  [ OK ]   $text" -ForegroundColor Green }
function Write-Warn($text) { Write-Host "  [ !! ]   $text" -ForegroundColor Yellow }
function Write-Bad($text)  { Write-Host "  [FAIL]   $text" -ForegroundColor Red }
function Write-Info($text) { Write-Host "  [ .. ]   $text" -ForegroundColor Gray }

function Add-Problem($text) { [void]$script:Problems.Add($text) }
function Add-Note($text)    { [void]$script:Notes.Add($text) }

# ── Locate the install ───────────────────────────────────────────────────────
# Works both from a full repo checkout (windows\setup.ps1) and from a folder
# where someone copied only the exe and this script.

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $ScriptDir

$ExeDir = $null
foreach ($candidate in @((Join-Path $ScriptDir 'exe'), $ScriptDir, $RepoRoot)) {
    if (Test-Path $candidate) {
        $found = Get-ChildItem -Path $candidate -Filter 'SMK TV*.exe' -File -ErrorAction SilentlyContinue
        if ($found) { $ExeDir = $candidate; break }
    }
}
if (-not $ExeDir) { $ExeDir = Join-Path $ScriptDir 'exe' }

Write-Host ''
Write-Host '  ====================================================' -ForegroundColor White
Write-Host '   SMK TV — dependency setup & doctor' -ForegroundColor White
Write-Host '  ====================================================' -ForegroundColor White
Write-Info "App folder:  $ExeDir"
Write-Info "Repo root:   $RepoRoot"
if ($CheckOnly) { Write-Info 'Mode:        CHECK ONLY (nothing will be installed)' }

# ── 1. The app itself ────────────────────────────────────────────────────────

Write-Head '1. Application'

# Highest build number wins - build.cjs names them "SMK TV <N>.exe".
$exeFiles = @(Get-ChildItem -Path $ExeDir -Filter 'SMK TV*.exe' -File -ErrorAction SilentlyContinue |
    Sort-Object { [int]([regex]::Match($_.Name, '(\d+)').Groups[1].Value) } -Descending)

if ($exeFiles.Count -eq 0) {
    Write-Bad "No 'SMK TV <N>.exe' found in $ExeDir"
    Add-Problem 'Copy the SMK TV exe into this folder, then run setup again.'
} else {
    $exe = $exeFiles[0]
    $sizeMb = [math]::Round($exe.Length / 1MB, 1)
    Write-Ok "$($exe.Name)  ($sizeMb MB)"
    if ($exeFiles.Count -gt 1) { Write-Info "$($exeFiles.Count) builds present - newest is the one checked here" }
}

$hasRunOnce = Test-Path (Join-Path $ExeDir 'data')
if (-not $hasRunOnce) {
    Write-Info 'This app has never been started here - it unpacks its bundled files on first run.'
}

# ── 2. Bundled payload (unpacked by the exe on first run) ────────────────────

Write-Head '2. Bundled files (unpacked next to the app on first run)'

function Test-Payload($name, $purpose, $critical) {
    $p = Join-Path $ExeDir $name
    if (Test-Path $p) {
        $mb = [math]::Round((Get-Item $p).Length / 1MB, 2)
        Write-Ok "$name  ($mb MB) - $purpose"
        return $true
    }
    if ($critical) {
        if ($hasRunOnce) {
            Write-Bad "$name MISSING - $purpose"
            Add-Problem "$name is missing even though the app has run here. The exe was built without it in bundled-bin/ - rebuild with 'npm run build:exe' on the dev PC."
        } else {
            Write-Warn "$name not yet unpacked - $purpose"
            Add-Note "$name appears after the first launch."
        }
    } else {
        Write-Info "$name not present (optional) - $purpose"
    }
    return $false
}

[void](Test-Payload 'yt-dlp.exe'      'Direct Relay + recording' $true)
$hasCloudflared = Test-Payload 'cloudflared.exe' 'HTTPS tunnel - phones register from outside the LAN' $true
[void](Test-Payload 'cookies.txt'     'YouTube session for yt-dlp' $false)
[void](Test-Payload 'ffmpeg.exe'      'higher-quality split-mux relay (falls back without it)' $false)
[void](Test-Payload 'ffprobe.exe'     'stream inspection for the relay' $false)

# ── 3. Configuration / credentials  <- the usual culprit ─────────────────────

Write-Head '3. Configuration (.env) - push notification credentials'

$envPath = Join-Path $ExeDir '.env'
$controllerPort = 3004

if (-not (Test-Path $envPath)) {
    if ($hasRunOnce) {
        Write-Bad ".env MISSING at $envPath"
        Add-Problem 'No .env next to the app. Push notifications CANNOT work: the server reads FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY from there. Copy .env from the dev PC, or rebuild the exe so it carries one.'
    } else {
        Write-Warn '.env not yet unpacked - it arrives with the first launch.'
        Add-Note 'Start the app once, then re-run this script to verify the credentials.'
    }
} else {
    Write-Ok ".env found at $envPath"
    $envText = Get-Content $envPath -Raw

    $portMatch = [regex]::Match($envText, '(?m)^\s*CONTROLLER_PORT\s*=\s*(\d+)')
    if ($portMatch.Success) { $controllerPort = [int]$portMatch.Groups[1].Value }

    # Server-side (firebase-admin) - without these, every push is dropped.
    $serverKeys = @('FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY')
    $missingServer = @()
    foreach ($k in $serverKeys) {
        if ([regex]::IsMatch($envText, "(?m)^\s*$k\s*=\s*\S")) { Write-Ok "  $k is set" }
        else { Write-Bad "  $k is MISSING"; $missingServer += $k }
    }
    if ($missingServer.Count -gt 0) {
        Add-Problem "The .env here is missing $($missingServer -join ', '). notification-service.cjs refuses to initialize without all three, so every notification is silently dropped. Get these from Firebase Console > Project settings > Service accounts > Generate new private key."
    }

    # FIREBASE_PRIVATE_KEY must keep its \n escapes and stay quoted, or the
    # PEM parse fails later with an opaque app/invalid-credential.
    $pk = [regex]::Match($envText, '(?m)^\s*FIREBASE_PRIVATE_KEY\s*=\s*(.+)$')
    if ($pk.Success) {
        $val = $pk.Groups[1].Value.Trim()
        if ($val -notmatch '^["'']') {
            Write-Warn '  FIREBASE_PRIVATE_KEY is not quoted - wrap the value in double quotes'
            Add-Problem 'FIREBASE_PRIVATE_KEY must be wrapped in double quotes and keep its \n escape sequences, otherwise Firebase rejects it with app/invalid-credential.'
        }
        if ($val -notmatch 'BEGIN PRIVATE KEY') {
            Write-Warn '  FIREBASE_PRIVATE_KEY does not look like a PEM key'
        }
    }

    # Frontend keys are compiled into the UI bundle at build time, so a missing
    # one here is a build-machine problem, not a this-machine problem.
    $viteKeys = @('VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_PROJECT_ID', 'VITE_FIREBASE_MESSAGING_SENDER_ID',
                  'VITE_FIREBASE_APP_ID', 'VITE_FIREBASE_VAPID_KEY')
    $missingVite = @($viteKeys | Where-Object { -not [regex]::IsMatch($envText, "(?m)^\s*$_\s*=\s*\S") })
    if ($missingVite.Count -eq 0) {
        Write-Ok '  VITE_FIREBASE_* frontend keys present (baked into the UI at build time)'
    } else {
        Write-Warn "  Frontend keys missing from .env: $($missingVite -join ', ')"
        Add-Note 'VITE_* keys are compiled into the UI when the exe is built - fix them on the BUILD machine and rebuild; editing .env here has no effect on them.'
    }
}

# ── 4. Runtimes ──────────────────────────────────────────────────────────────

Write-Head '4. Runtimes'

Write-Ok 'Node.js runtime for the app itself - bundled inside the exe (node20-win-x64), nothing to install'
Write-Ok 'Python - not required; yt-dlp.exe is a standalone build with its own interpreter'

# Node.js on PATH: only the PO-Token provider needs it (spawned as `node`).
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$nodeOk = $false
if ($nodeCmd) {
    $nodeVer = (& node --version 2>$null)
    $major = 0
    if ($nodeVer -match 'v(\d+)') { $major = [int]$Matches[1] }
    if ($major -ge 20) { Write-Ok "Node.js $nodeVer on PATH (needed by the PO-Token provider)"; $nodeOk = $true }
    else { Write-Warn "Node.js $nodeVer is too old - the PO-Token provider needs >= 20" }
} else {
    Write-Warn 'Node.js NOT on PATH - the PO-Token provider cannot start (notifications are unaffected)'
}

if (-not $nodeOk -and -not $CheckOnly) {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        Write-Info 'Installing Node.js LTS via winget...'
        & winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -eq 0) {
            Write-Ok 'Node.js installed - CLOSE AND REOPEN this window so PATH refreshes, then re-run setup'
            Add-Note 'Node.js was just installed. Open a NEW terminal before re-running this script.'
        } else {
            Write-Bad "winget install failed (exit $LASTEXITCODE)"
            Add-Problem 'Install Node.js 20+ manually from https://nodejs.org/en/download'
        }
    } else {
        Write-Bad 'winget is not available on this PC'
        Add-Problem 'Install Node.js 20+ manually from https://nodejs.org/en/download'
    }
} elseif (-not $nodeOk) {
    Add-Note 'Node.js 20+ is missing. Not needed for notifications; needed for the PO-Token provider (YouTube bot checks).'
}

# ffmpeg is optional and only consulted next to the exe or on PATH.
if (-not (Test-Path (Join-Path $ExeDir 'ffmpeg.exe'))) {
    if (Get-Command ffmpeg -ErrorAction SilentlyContinue) { Write-Ok 'ffmpeg found on PATH' }
    else { Write-Info 'ffmpeg not installed (optional) - relay uses the proxy-combined fallback' }
}

# ── 5. PO-Token provider ─────────────────────────────────────────────────────

Write-Head '5. PO-Token provider (yt-dlp anti-bot helper)'

$potDirs = @((Join-Path $ExeDir 'pot-provider'), (Join-Path $RepoRoot 'pot-provider')) |
    Where-Object { Test-Path $_ }

if ($potDirs.Count -eq 0) {
    Write-Info 'pot-provider/ not deployed here - yt-dlp runs without it (more likely to hit "Sign in to confirm you are not a bot")'
    Add-Note 'To enable it, copy pot-provider/ next to the exe and re-run this script.'
} else {
    $potDir = $potDirs[0]
    $serverDir = Join-Path $potDir 'server'
    $mainJs = Join-Path $serverDir 'build\main.js'
    Write-Info "Found: $potDir"

    if (Test-Path $mainJs) {
        Write-Ok 'server\build\main.js is built'
    } elseif ($CheckOnly) {
        Write-Warn 'server\build\main.js is missing - needs npm install + npx tsc'
        Add-Problem 'PO-Token provider is not built. Re-run setup without -CheckOnly.'
    } elseif (-not $nodeOk) {
        Write-Warn 'Cannot build - Node.js 20+ is required first'
    } else {
        Write-Info 'Building the PO-Token provider (npm install + npx tsc)...'
        Push-Location $serverDir
        try {
            if (Test-Path 'package-lock.json') { & npm ci } else { & npm install }
            if ($LASTEXITCODE -eq 0) { & npx tsc }
            if ((Test-Path $mainJs)) { Write-Ok 'PO-Token provider built' }
            else { Write-Bad 'Build did not produce build\main.js'; Add-Problem 'PO-Token provider build failed - see the npm output above.' }
        } finally { Pop-Location }
    }

    $pluginDir = Join-Path $ExeDir 'yt-dlp-plugins\bgutil-ytdlp-pot-provider'
    if (Test-Path $pluginDir) { Write-Ok 'yt-dlp plugin installed next to the app' }
    else {
        Write-Warn "yt-dlp plugin missing at $pluginDir"
        Add-Note "Copy pot-provider\plugin\yt_dlp_plugins into $pluginDir so yt-dlp.exe loads it."
    }
}

# ── 6. Live check against a running server ───────────────────────────────────

Write-Head '6. Live check'

$statusUrl = "http://localhost:$controllerPort/api/notifications/status"
try {
    $resp = Invoke-RestMethod -Uri $statusUrl -TimeoutSec 5 -ErrorAction Stop
    if ($resp.ready) {
        Write-Ok "Notification service is READY (devices registered: $($resp.deviceCount), active: $($resp.activeDevices))"
        if ($resp.activeDevices -eq 0) {
            Write-Warn 'No active devices - open the Notifications panel, scan the QR on the phone and allow notifications'
            Add-Note 'Credentials are fine but no phone is registered on this install. Device registrations do not travel between PCs - each install has its own data\fcm-tokens.json.'
        }
    } else {
        Write-Bad "Notification service NOT ready: $($resp.initError)"
        Add-Problem "The running app reports: $($resp.initError)"
    }
} catch {
    Write-Info "App is not running on port $controllerPort - start it and re-run for a live check"
}

# ── Summary ──────────────────────────────────────────────────────────────────

Write-Host ''
Write-Host '  ====================================================' -ForegroundColor White
Write-Host '   SUMMARY' -ForegroundColor White
Write-Host '  ====================================================' -ForegroundColor White

if ($script:Problems.Count -eq 0) {
    Write-Host ''
    Write-Host '   No blocking problems found.' -ForegroundColor Green
} else {
    Write-Host ''
    Write-Host "   $($script:Problems.Count) problem(s) to fix:" -ForegroundColor Red
    $i = 1
    foreach ($p in $script:Problems) { Write-Host "     $i. $p" -ForegroundColor Red; $i++ }
}

if ($script:Notes.Count -gt 0) {
    Write-Host ''
    Write-Host '   Notes:' -ForegroundColor Yellow
    foreach ($n in $script:Notes) { Write-Host "     - $n" -ForegroundColor Yellow }
}

Write-Host ''
Write-Host '   Reminder: push notifications need the phone to open /setup over HTTPS' -ForegroundColor Gray
Write-Host '   (the tunnel URL, or https://<lan-ip>:3443/setup accepting the warning).' -ForegroundColor Gray
Write-Host '   Plain http://<lan-ip>:3004/setup can never register a device.' -ForegroundColor Gray
Write-Host ''
