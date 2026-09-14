$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$appDir = Join-Path $env:LOCALAPPDATA 'PaperMate'
$config = Get-Content -Raw -LiteralPath (Join-Path $appDir 'config.json') | ConvertFrom-Json
$installedRoot = [IO.Path]::GetFullPath($config.projectDir)
if ($installedRoot.TrimEnd('\') -ne 'D:\papermate') { throw 'Unexpected installation path' }
$backupRoot = Join-Path $installedRoot ('asset-backups\websearch-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$files = @(
    'lib\web-search.ts',
    'lib\web-search-store.ts',
    'lib\web-search.test.ts',
    'lib\web-search-store.test.ts',
    'lib\types.ts',
    'lib\prompts.ts',
    'lib\prompts.test.ts',
    'public\prompts.txt',
    'app\api\chat\route.ts',
    'app\api\web-search\route.ts',
    'app\api\storage\search\route.ts',
    'app\page.tsx',
    'app\globals.css',
    'scripts\sync-prompt-defaults.mjs'
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
& (Join-Path $appDir 'stop-papermate.ps1') -AppDataDir $appDir
Push-Location $installedRoot
try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) {
        foreach ($relative in $files) {
            $backup = Join-Path $backupRoot $relative
            if (Test-Path -LiteralPath $backup) { Copy-Item -LiteralPath $backup -Destination (Join-Path $installedRoot $relative) -Force }
            else { Remove-Item -LiteralPath (Join-Path $installedRoot $relative) -Force -ErrorAction SilentlyContinue }
        }
        & npm.cmd run build
        if ($LASTEXITCODE -eq 0) { & (Join-Path $appDir 'start-papermate.ps1') -AppDataDir $appDir -NoBrowser }
        throw 'Update failed; restored previous source files and attempted recovery build'
    }
} finally { Pop-Location }
& (Join-Path $appDir 'start-papermate.ps1') -AppDataDir $appDir -NoBrowser
Write-Output "Web search update built and service restarted. Backup: $backupRoot"
