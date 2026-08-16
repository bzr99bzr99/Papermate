#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$AppDataDir = "",
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if ([string]::IsNullOrWhiteSpace($AppDataDir)) {
    $AppDataDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}

$configPath = Join-Path $AppDataDir "config.json"
if (-not (Test-Path -LiteralPath $configPath)) {
    throw "找不到 PaperMate 安装信息：$configPath"
}

$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$projectDir = $config.projectDir
$preferredPort = [int]$config.port
$pidFile = Join-Path $AppDataDir "server.pid"
$outLog = Join-Path $AppDataDir "server.out.log"
$errLog = Join-Path $AppDataDir "server.err.log"

function Get-NodePath {
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    $candidates = @(
        (Join-Path $env:ProgramFiles "nodejs\node.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe")
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            return $candidate
        }
    }
    return $null
}

function Test-PaperMate {
    param([int]$Port)
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port" -UseBasicParsing -TimeoutSec 2
        return ($response.StatusCode -eq 200 -and $response.Content -match "PaperMate")
    }
    catch {
        return $false
    }
}

function Wait-ForPaperMate {
    param([int]$Port, [int]$TimeoutSeconds)
    for ($i = 0; $i -lt $TimeoutSeconds; $i++) {
        if (Test-PaperMate $Port) {
            return $true
        }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Get-AppBrowser {
    $candidates = @(
        (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
        (Join-Path $env:LOCALAPPDATA "Microsoft\Edge\Application\msedge.exe"),
        (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
        (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            return $candidate
        }
    }
    return $null
}

$listener = Get-NetTCPConnection -State Listen -LocalPort $preferredPort -ErrorAction SilentlyContinue | Select-Object -First 1
$port = $preferredPort
$alreadyRunning = $false

if (-not $listener -and (Test-Path -LiteralPath $pidFile)) {
    $savedPid = [int](Get-Content -LiteralPath $pidFile -Raw)
    $savedProcess = Get-Process -Id $savedPid -ErrorAction SilentlyContinue
    if ($savedProcess) {
        Write-Host "PaperMate 服务正在启动，请稍候..."
        if (Wait-ForPaperMate $preferredPort 20) {
            $alreadyRunning = $true
        }
        elseif ($savedProcess.ProcessName -eq "node") {
            Stop-Process -Id $savedPid -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
        }
    }
}

if ($listener) {
    $savedPid = $null
    if (Test-Path -LiteralPath $pidFile) {
        $savedPid = [int](Get-Content -LiteralPath $pidFile -Raw)
        if (-not (Get-Process -Id $savedPid -ErrorAction SilentlyContinue)) {
            $savedPid = $null
        }
    }

    if ($savedPid -and (Wait-ForPaperMate $port 20)) {
        $alreadyRunning = $true
    }
    elseif (Test-PaperMate $port) {
        $alreadyRunning = $true
    }
    else {
        $savedProcess = Get-Process -Id $savedPid -ErrorAction SilentlyContinue
        if ($savedPid -and $savedProcess -and $savedProcess.ProcessName -eq "node") {
            Stop-Process -Id $savedPid -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
        }
        Write-Host "端口 $preferredPort 被其他程序占用，正在寻找可用端口..."
        $found = $false
        for ($candidate = $preferredPort + 1; $candidate -lt ($preferredPort + 20); $candidate++) {
            if (-not (Get-NetTCPConnection -State Listen -LocalPort $candidate -ErrorAction SilentlyContinue)) {
                $port = $candidate
                $found = $true
                break
            }
        }
        if (-not $found) {
            throw "端口 $preferredPort - $($preferredPort + 19) 均被占用，无法启动服务。"
        }
    }
}

if (-not $alreadyRunning) {
    $node = Get-NodePath
    if (-not $node) {
        throw "找不到 Node.js，请重新运行一键安装。"
    }

    $nextCli = Join-Path $projectDir "node_modules\next\dist\bin\next"
    if (-not (Test-Path -LiteralPath $nextCli)) {
        throw "项目依赖不完整，请重新运行一键安装。"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $projectDir ".next\BUILD_ID"))) {
        throw "项目还没有正式构建，请重新运行一键安装。"
    }

    Write-Host "正在启动 PaperMate 服务（端口 $port）..."
    $arguments = @($nextCli, "start", "-H", "127.0.0.1", "-p", "$port")
    $process = Start-Process `
        -FilePath $node `
        -ArgumentList $arguments `
        -WorkingDirectory $projectDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput $outLog `
        -RedirectStandardError $errLog `
        -PassThru

    Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ASCII

    if (-not (Wait-ForPaperMate $port 60)) {
        if ($process.HasExited) {
            $logText = ""
            if (Test-Path -LiteralPath $errLog) {
                $logText = Get-Content -Raw -LiteralPath $errLog
            }
            throw "PaperMate 服务启动失败：$logText"
        }
        throw "PaperMate 服务启动超时，请查看日志：$errLog"
    }

    if ($port -ne $preferredPort) {
        $config.port = $port
        $config.url = "http://127.0.0.1:$port"
        $configJson = $config | ConvertTo-Json
        [System.IO.File]::WriteAllText($configPath, $configJson, (New-Object System.Text.UTF8Encoding($true)))
    }
}

$url = "http://127.0.0.1:$port"
Write-Host "PaperMate 已启动：$url"

if (-not $NoBrowser) {
    $browser = Get-AppBrowser
    if ($browser) {
        try {
            Start-Process -FilePath $browser -ArgumentList @("--app=$url")
        }
        catch {
            Start-Process -FilePath $url
        }
    }
    else {
        Start-Process -FilePath $url
    }
}
