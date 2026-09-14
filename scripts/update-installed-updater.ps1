$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$appDir = Join-Path $env:LOCALAPPDATA 'PaperMate'
$config = Get-Content -Raw -LiteralPath (Join-Path $appDir 'config.json') | ConvertFrom-Json
$installedRoot = [IO.Path]::GetFullPath($config.projectDir)
if ($installedRoot.TrimEnd('\') -ne 'D:\papermate') { throw 'Unexpected installation path' }
$backupRoot = Join-Path $installedRoot ('asset-backups\updater-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$files = @(
    'lib\update-version.ts',
    'lib\update-types.ts',
    'lib\update-activity.ts',
    'lib\updater.ts',
    'lib\update-version.test.ts',
    'lib\update-guard.ts',
    'lib\update-guard.test.ts',
    'lib\updater.test.ts',
    'components\update-manager.tsx',
    'app\api\updates\route.ts',
    'app\globals.css',
    'scripts\apply-update.ps1',
    'package.json',
    'package-lock.json'
)
foreach ($relative in $files) {
    $destination = Join-Path $installedRoot $relative
    $backup = Join-Path $backupRoot $relative
    if (Test-Path -LiteralPath $destination) {
        New-Item -ItemType Directory -Force -Path (Split-Path $backup -Parent) | Out-Null
        Copy-Item -LiteralPath $destination -Destination $backup
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent) | Out-Null
    Copy-Item -LiteralPath (Join-Path $sourceRoot $relative) -Destination $destination -Force
    if ((Get-FileHash -LiteralPath $destination).Hash -ne (Get-FileHash -LiteralPath (Join-Path $sourceRoot $relative)).Hash) { throw "Asset verification failed: $relative" }
}
# apply-update.ps1 必须保持 UTF-8 BOM（Windows PowerShell 5.1 否则按 ANSI 解码，中文路径会乱码）
$helper = Join-Path $installedRoot 'scripts\apply-update.ps1'
$bytes = [IO.File]::ReadAllBytes($helper)
if (-not ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)) { throw 'apply-update.ps1 lost its UTF-8 BOM' }
& (Join-Path $appDir 'stop-papermate.ps1') -AppDataDir $appDir
Push-Location $installedRoot
try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) {
        foreach ($relative in $files) {
            $backup = Join-Path $backupRoot $relative
            if (Test-Path -LiteralPath $backup) { Copy-Item -LiteralPath $backup -Destination (Join-Path $installedRoot $relative) -Force }
        }
        & npm.cmd run build
        if ($LASTEXITCODE -eq 0) { cmd /c start "" /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$appDir\start-papermate.ps1" -AppDataDir "$appDir" -NoBrowser }
        throw 'Update failed; restored previous source files and attempted recovery build'
    }
} finally { Pop-Location }
cmd /c start "" /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$appDir\start-papermate.ps1" -AppDataDir "$appDir" -NoBrowser
Write-Output "Updater feature built and service restarted. Backup: $backupRoot"
