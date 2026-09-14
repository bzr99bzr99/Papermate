$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$appDir = Join-Path $env:LOCALAPPDATA 'PaperMate'
$config = Get-Content -Raw -LiteralPath (Join-Path $appDir 'config.json') | ConvertFrom-Json
$installedRoot = [IO.Path]::GetFullPath($config.projectDir)
if ($installedRoot.TrimEnd('\') -ne 'D:\papermate') { throw 'Unexpected installation path' }
$backupRoot = Join-Path $installedRoot ('asset-backups\buddy-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$files = @('components\buddy-system.tsx', 'app\visual-refresh.css', 'lib\buddy-layout.ts')
foreach ($relative in $files) {
    $destination = Join-Path $installedRoot $relative
    $backup = Join-Path $backupRoot $relative
    if (Test-Path -LiteralPath $destination) {
        New-Item -ItemType Directory -Force -Path (Split-Path $backup -Parent) | Out-Null
        Copy-Item -LiteralPath $destination -Destination $backup
    }
    Copy-Item -LiteralPath (Join-Path $sourceRoot $relative) -Destination $destination -Force
    if ((Get-FileHash -LiteralPath $destination).Hash -ne (Get-FileHash -LiteralPath (Join-Path $sourceRoot $relative)).Hash) { throw 'Asset verification failed' }
}
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
        if ($LASTEXITCODE -eq 0) { & (Join-Path $appDir 'start-papermate.ps1') -AppDataDir $appDir -NoBrowser }
        throw 'Update failed; restored previous source files and attempted recovery build'
    }
} finally { Pop-Location }
& (Join-Path $appDir 'start-papermate.ps1') -AppDataDir $appDir -NoBrowser
Write-Output "Buddy update built and service restarted. Backup: $backupRoot"
