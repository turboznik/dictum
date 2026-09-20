<#
.SYNOPSIS
    Resets this machine's Dictum application data for development testing.

.DESCRIPTION
    Dictum is a separate product from Handy, with its own identity and its own
    data. This script clears Dictum's data so a developer can re-test the
    first-run experience — onboarding, model download, settings defaults —
    without uninstalling anything.

    It moves data into a timestamped backup by default rather than deleting it,
    because the usual reason to run this is to get back to a clean state, not to
    destroy a transcription history. Pass -Delete when you actually mean gone.

    Downloaded models are preserved by default: they are large, they are slow to
    re-fetch, and almost no reset needs them gone. Pass -IncludeModels to test a
    genuinely cold model download.

    This script never touches Handy's data (com.pais.handy) or the shared
    Hugging Face cache, and it does not uninstall Dictum.

.PARAMETER Delete
    Delete the data irreversibly instead of moving it to a timestamped backup.

.PARAMETER IncludeModels
    Also reset downloaded models, for a cold model-download test. Off by
    default.

.PARAMETER Force
    Skip the confirmation prompt. Intended for scripted runs.

.EXAMPLE
    .\scripts\reset-dictum-data.ps1
    Backs up Dictum's settings, history, recordings, logs and WebView data,
    keeping downloaded models.

.EXAMPLE
    .\scripts\reset-dictum-data.ps1 -IncludeModels -Delete
    A full cold-start reset with no backup.
#>

[CmdletBinding()]
param(
    [switch]$Delete,
    [switch]$IncludeModels,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# Must match the Tauri identifier in src-tauri/tauri.conf.json. Dictum's whole
# separation from Handy rests on this string, so it is stated once, here.
$Identifier = 'io.github.turboznik.dictum'

$RoamingRoot = Join-Path $env:APPDATA   $Identifier
$LocalRoot   = Join-Path $env:LOCALAPPDATA $Identifier

# --- Refuse to run against anything that is not Dictum's own data -------------

function Assert-SafeTarget {
    param([string]$Path)

    # A resolved path that does not sit under a Dictum-identified root means
    # either a malformed environment or a path this script has no business
    # touching. Both are a stop, not a warning.
    $full = [System.IO.Path]::GetFullPath($Path)

    if (-not ($full.StartsWith($RoamingRoot, [StringComparison]::OrdinalIgnoreCase) -or
              $full.StartsWith($LocalRoot,   [StringComparison]::OrdinalIgnoreCase))) {
        throw "Refusing to touch a path outside Dictum's data roots: $full"
    }

    # Guard against an empty APPDATA turning a root into something enormous.
    $segments = $full.TrimEnd('\').Split('\').Where({ $_ -ne '' })
    if ($segments.Count -lt 4) {
        throw "Refusing to touch a suspiciously shallow path: $full"
    }

    if ($full -like '*com.pais.handy*') {
        throw "Refusing to touch Handy's data: $full"
    }
}

# --- Dictum must not be running ----------------------------------------------

$running = Get-Process -Name 'dictum' -ErrorAction SilentlyContinue
if ($running) {
    Write-Host ''
    Write-Host 'Dictum is running. Quit it before resetting its data.' -ForegroundColor Red
    Write-Host 'Running processes:' -ForegroundColor Red
    $running | ForEach-Object { Write-Host "  PID $($_.Id)  $($_.Path)" }
    Write-Host ''
    Write-Host 'Quit Dictum from its tray icon, then run this again.'
    exit 1
}

# --- Work out what would be affected -----------------------------------------

$targets = @()

foreach ($item in @(
    @{ Path = (Join-Path $RoamingRoot 'settings_store.json'); Label = 'settings' },
    @{ Path = (Join-Path $RoamingRoot 'history.db');          Label = 'transcription history' },
    @{ Path = (Join-Path $RoamingRoot 'recordings');          Label = 'saved recordings' },
    @{ Path = (Join-Path $LocalRoot   'logs');                Label = 'logs' },
    @{ Path = (Join-Path $LocalRoot   'EBWebView');           Label = 'WebView data' }
)) {
    if (Test-Path $item.Path) {
        Assert-SafeTarget $item.Path
        $targets += [pscustomobject]$item
    }
}

if ($IncludeModels) {
    $models = Join-Path $RoamingRoot 'models'
    if (Test-Path $models) {
        Assert-SafeTarget $models
        $targets += [pscustomobject]@{ Path = $models; Label = 'downloaded models' }
    }
}

if ($targets.Count -eq 0) {
    Write-Host 'Nothing to reset: no Dictum data found.' -ForegroundColor Green
    Write-Host "  looked in $RoamingRoot"
    Write-Host "  looked in $LocalRoot"
    exit 0
}

# --- Show exactly what will happen, then confirm ------------------------------

$mode = if ($Delete) { 'DELETE' } else { 'BACK UP' }

Write-Host ''
Write-Host "About to $mode the following Dictum data:" -ForegroundColor Yellow
foreach ($target in $targets) {
    Write-Host ("  {0,-22} {1}" -f $target.Label, $target.Path)
}

if (-not $IncludeModels) {
    Write-Host ''
    Write-Host '  Downloaded models are being KEPT (pass -IncludeModels to reset them too).'
}

Write-Host ''
Write-Host '  Handy''s data and the shared Hugging Face cache are not touched.'
Write-Host ''

if (-not $Force) {
    $answer = Read-Host "Type 'yes' to continue"
    if ($answer -ne 'yes') {
        Write-Host 'Cancelled.' -ForegroundColor Yellow
        exit 1
    }
}

# --- Do it --------------------------------------------------------------------

if ($Delete) {
    foreach ($target in $targets) {
        Assert-SafeTarget $target.Path
        Remove-Item -LiteralPath $target.Path -Recurse -Force -Confirm:$false
        Write-Host "  deleted  $($target.Path)"
    }
    Write-Host ''
    Write-Host 'Dictum data deleted.' -ForegroundColor Green
}
else {
    $stamp     = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backupDir = Join-Path $env:LOCALAPPDATA "$Identifier.backup-$stamp"
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

    foreach ($target in $targets) {
        Assert-SafeTarget $target.Path
        # Roaming and Local can hold like-named items, so keep the two apart
        # inside the backup rather than letting one overwrite the other.
        $scope = if ($target.Path.StartsWith($RoamingRoot, [StringComparison]::OrdinalIgnoreCase)) {
            'Roaming'
        } else {
            'Local'
        }
        $scopeDir = Join-Path $backupDir $scope
        New-Item -ItemType Directory -Path $scopeDir -Force | Out-Null

        Move-Item -LiteralPath $target.Path -Destination $scopeDir -Force
        Write-Host "  moved    $($target.Path)"
    }

    Write-Host ''
    Write-Host 'Dictum data backed up to:' -ForegroundColor Green
    Write-Host "  $backupDir"
    Write-Host ''
    Write-Host 'Delete that folder when you no longer need it.'
}

Write-Host ''
Write-Host 'Next launch of Dictum will behave as a first run.'
