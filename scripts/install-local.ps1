#Requires -Version 5.1
<#
.SYNOPSIS
    一键安装：按当前目录的形态自动选择安装方式。

.DESCRIPTION
    双击仓库根目录（或解压出来的发布包）里的「一键安装.bat」即可，脚本会判断当前目录是哪种形态：

      * 预编译包目录（有 server.js / node.exe / .next\BUILD_ID，也就是从 Release 的 zip 解压出来的）
        -> 调 scripts\install-package.ps1：校验包、复制到安装位置、建快捷方式、写 config.json、
           注册到 Windows 应用列表。不需要 Node.js、不需要联网、不构建，通常几十秒。
      * 完整源码目录（有 app\ / components\ / lib\ / next.config.ts）
        -> 调 scripts\install.ps1：首次安装是 -ChooseInstallDir（复制源码 + npm install + 构建），
           已经装过同一份源码时自动转成 -Upgrade 增量升级。
    也可以直接把一个 papermate-windows-x64.zip 拖到 bat 上，这时无论当前目录是什么，都会用那个 zip 安装。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\install-local.ps1
    powershell -ExecutionPolicy Bypass -File scripts\install-local.ps1 -PackageZip D:\Downloads\papermate-windows-x64.zip
    powershell -ExecutionPolicy Bypass -File scripts\install-local.ps1 -InstallDir D:\PaperMate
#>
[CmdletBinding()]
param(
    [string]$InstallDir = "",
    [string]$AppDataDir = "",
    [string]$SourceDir = "",
    [string]$PackageZip = "",
    [switch]$ForceFull,
    [switch]$SkipShortcuts,
    [switch]$Start,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptDir ".."))

function Write-Step {
    param([string]$Message)
    Write-Host "== $Message" -ForegroundColor Cyan
}

if ([string]::IsNullOrWhiteSpace($AppDataDir)) {
    $AppDataDir = Join-Path $env:LOCALAPPDATA "PaperMate"
}
$AppDataDir = [System.IO.Path]::GetFullPath($AppDataDir)
if ([string]::IsNullOrWhiteSpace($SourceDir)) {
    $SourceDir = $repoRoot
}
$SourceDir = [System.IO.Path]::GetFullPath($SourceDir)

$packageScript = Join-Path $scriptDir "install-package.ps1"
$sourceScript = Join-Path $scriptDir "install.ps1"
foreach ($script in @($packageScript, $sourceScript)) {
    if (-not (Test-Path -LiteralPath $script)) {
        throw "缺少 $script，这不是一份完整的 PaperMate 目录。"
    }
}

Write-Host "当前目录：$SourceDir"

# ---------- 1. 判断当前目录的形态 ----------
$dirIsPackage = (Test-Path -LiteralPath (Join-Path $SourceDir "server.js")) -and
    (Test-Path -LiteralPath (Join-Path $SourceDir "node.exe")) -and
    (Test-Path -LiteralPath (Join-Path $SourceDir ".next\BUILD_ID"))

$dirIsSource = (Test-Path -LiteralPath (Join-Path $SourceDir "package.json")) -and
    (Test-Path -LiteralPath (Join-Path $SourceDir "next.config.ts")) -and
    (Test-Path -LiteralPath (Join-Path $SourceDir "app")) -and
    (Test-Path -LiteralPath (Join-Path $SourceDir "components")) -and
    (Test-Path -LiteralPath (Join-Path $SourceDir "lib"))

# ---------- 2. 预编译包安装 ----------
if (-not [string]::IsNullOrWhiteSpace($PackageZip)) {
    Write-Host "安装方式：预编译包安装（用指定的 zip，不需要 Node.js）" -ForegroundColor Yellow
    $packageArgs = @{ PackageZip = $PackageZip; AppDataDir = $AppDataDir }
    if ($InstallDir) { $packageArgs.InstallDir = $InstallDir }
    if ($SkipShortcuts) { $packageArgs.SkipShortcuts = $true }
    if ($Start) { $packageArgs.Start = $true }
    if ($Force) { $packageArgs.Force = $true }
    & $packageScript @packageArgs
    return
}

if ($dirIsPackage) {
    Write-Host "安装方式：预编译包安装（当前目录就是包，不需要 Node.js）" -ForegroundColor Yellow
    $packageArgs = @{ PackageDir = $SourceDir; AppDataDir = $AppDataDir }
    if ($InstallDir) { $packageArgs.InstallDir = $InstallDir }
    if ($SkipShortcuts) { $packageArgs.SkipShortcuts = $true }
    if ($Start) { $packageArgs.Start = $true }
    if ($Force) { $packageArgs.Force = $true }
    & $packageScript @packageArgs
    return
}

# ---------- 3. 源码安装 / 增量升级 ----------
if ($dirIsSource) {
    $configPath = Join-Path $AppDataDir "config.json"
    $config = $null
    if (Test-Path -LiteralPath $configPath) {
        try {
            $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
        }
        catch {
            $config = $null
        }
    }

    $sourceArgs = @{ AppDataDir = $AppDataDir }
    if ($InstallDir) { $sourceArgs.InstallDir = $InstallDir }
    if ($SkipShortcuts) { $sourceArgs.SkipShortcuts = $true }

    if ($config -and -not [string]::IsNullOrWhiteSpace([string]$config.projectDir)) {
        Write-Host "安装方式：源码增量升级（检测到已安装的 PaperMate）" -ForegroundColor Yellow
        if ($ForceFull) { $sourceArgs.ForceFull = $true }
        & $sourceScript -Upgrade @sourceArgs
    }
    else {
        Write-Host "安装方式：源码安装（首次）" -ForegroundColor Yellow
        $sourceArgs.ChooseInstallDir = $true
        & $sourceScript @sourceArgs
    }

    if ($Start) {
        Write-Step "启动服务"
        & (Join-Path $AppDataDir "start-papermate.ps1") -AppDataDir $AppDataDir -NoBrowser
    }
    return
}

throw @"
当前目录既不是完整的源码目录，也不是预编译包目录：
  $SourceDir

  * 源码安装：应该在含 app\ components\ lib\ next.config.ts 的项目根目录运行；
  * 预编译包安装：应该在解压出来的发布包目录（含 server.js / node.exe）运行，
    或把一个 papermate-windows-x64.zip 直接拖到「一键安装.bat」上。
"@
