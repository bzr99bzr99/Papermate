#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$AppDataDir = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($AppDataDir)) {
    $AppDataDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}

$pidFile = Join-Path $AppDataDir "server.pid"
$configPath = Join-Path $AppDataDir "config.json"

$projectDir = ""
if (Test-Path -LiteralPath $configPath) {
    $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
    $projectDir = [string]$config.projectDir
}

$stopped = $false

if (Test-Path -LiteralPath $pidFile) {
    $savedPid = [int](Get-Content -LiteralPath $pidFile -Raw)
    $process = Get-Process -Id $savedPid -ErrorAction SilentlyContinue
    if ($process -and $projectDir) {
        $owner = $null
        try {
            $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $savedPid" -ErrorAction SilentlyContinue
        }
        catch {
            $owner = $null
        }
        $isPaperMate = $owner -and $owner.CommandLine -like "*$projectDir*" -and $owner.CommandLine -like "*next*start*"
        if (-not $isPaperMate -and -not $owner -and $process.ProcessName -eq "node") {
            $isPaperMate = $true
        }
        if ($isPaperMate) {
            Write-Host "正在停止 PaperMate 服务（PID $savedPid）..."
            Stop-Process -Id $savedPid -Force -ErrorAction SilentlyContinue
            $stopped = $true
        }
    }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

if (-not $stopped -and $projectDir) {
    $port = [int]$config.port
    $connection = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($connection) {
        $owner = $null
        try {
            $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($connection.OwningProcess)" -ErrorAction SilentlyContinue
        }
        catch {
            $owner = $null
        }
        $isPaperMate = $owner -and $owner.CommandLine -like "*next*start*" -and $owner.CommandLine -like "*$projectDir*"
        if (-not $isPaperMate -and -not $owner) {
            $ownerProcess = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue
            if ($ownerProcess -and $ownerProcess.ProcessName -eq "node") {
                $isPaperMate = $true
            }
        }
        if ($isPaperMate) {
            Write-Host "正在停止 PaperMate 服务（PID $($connection.OwningProcess)）..."
            Stop-Process -Id $connection.OwningProcess -Force -ErrorAction SilentlyContinue
            $stopped = $true
        }
    }
}

if (-not $stopped) {
    Write-Host "PaperMate 服务当前没有在运行。"
}
