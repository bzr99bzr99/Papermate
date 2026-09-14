#Requires -Version 5.1
<#
.SYNOPSIS
    一键升级：把这份源码部署到本机已安装的 PaperMate，并打开页面看效果。

.DESCRIPTION
    双击仓库根目录的「一键升级.bat」即可。脚本先判断本机安装属于哪种形态，再选对应的升级方式：

      * 预编译包安装（安装目录里有 server.js / node.exe，例如由 Release 的 zip 或应用内自动更新装的）
        -> 走“覆盖运行时产物”：构建当前源码，只覆盖 .next、server.js、package.json 与 scripts\*.ps1，
           重启服务并打开页面。约 1 分钟，比完整打包快一个数量级；用 -Undo 可回滚。
      * 源码安装（安装目录是一份源码，由 install.ps1 装的）
        -> 走 install.ps1 -Upgrade 的源码增量升级（指纹比对，只同步变化的文件，必要时才重新构建）。

    开发版（这份源码）的 package.json 版本号固定为 1：改代码不用动版本号，部署出去的开发构建在应用里也显示 1。
    正式版本号只在纯净上传仓库里维护——发版时在那里把版本号改成真实版本（如 4.1.1）再打 tag。

.PARAMETER Patch
    先应用一个 .patch 文件再部署（也可以直接把 .patch 拖到「一键升级.bat」上）。

.PARAMETER Undo
    回滚最近一次开发版部署，把安装目录还原成部署前的运行时。

.PARAMETER ListBackups
    只列出可回滚的备份，不做任何改动。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\upgrade-local.ps1
    powershell -ExecutionPolicy Bypass -File scripts\upgrade-local.ps1 -Patch ..\fix.patch
    powershell -ExecutionPolicy Bypass -File scripts\upgrade-local.ps1 -Undo
#>
[CmdletBinding()]
param(
    [string]$InstallDir = "",
    [string]$AppDataDir = "",
    [string]$SourceDir = "",
    [string]$Patch = "",
    [switch]$Undo,
    [switch]$ListBackups,
    [switch]$ForceFull,
    [switch]$SkipTests,
    [switch]$SkipBuild,
    [switch]$NoBrowser,
    [switch]$NoRestart
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptDir ".."))

function Write-Step {
    param([string]$Message)
    Write-Host "== $Message" -ForegroundColor Cyan
}

function Open-AppPage {
    param([string]$Url)
    try {
        Start-Process -FilePath $Url
    }
    catch {
        Write-Host "请手动打开 $Url" -ForegroundColor Yellow
    }
}

if ([string]::IsNullOrWhiteSpace($AppDataDir)) {
    $AppDataDir = Join-Path $env:LOCALAPPDATA "PaperMate"
}
$AppDataDir = [System.IO.Path]::GetFullPath($AppDataDir)
if ([string]::IsNullOrWhiteSpace($SourceDir)) {
    $SourceDir = $repoRoot
}
$SourceDir = [System.IO.Path]::GetFullPath($SourceDir)

# ---------- 1. 找安装目录与端口 ----------
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

if ([string]::IsNullOrWhiteSpace($InstallDir) -and $config -and -not [string]::IsNullOrWhiteSpace([string]$config.projectDir)) {
    $InstallDir = [string]$config.projectDir
}
if ([string]::IsNullOrWhiteSpace($InstallDir) -or -not (Test-Path -LiteralPath $InstallDir)) {
    throw @"
没有找到本机已安装的 PaperMate（安装信息：$configPath）。

  先装一次再升级：
    * 预编译包安装：下载 Release 的 papermate-windows-x64.zip，解压后双击「一键安装.bat」；
    * 源码安装：双击「一键安装.bat」。
"@
}
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)

$port = 3000
if ($config -and -not [string]::IsNullOrWhiteSpace([string]$config.port)) {
    $parsedPort = 0
    if ([int]::TryParse([string]$config.port, [ref]$parsedPort) -and $parsedPort -gt 0) {
        $port = $parsedPort
    }
}
$url = "http://127.0.0.1:$port"

# ---------- 2. 判断源码与安装的形态 ----------
$sourceIsDevTree = (Test-Path -LiteralPath (Join-Path $SourceDir "package.json")) -and
    (Test-Path -LiteralPath (Join-Path $SourceDir "next.config.ts")) -and
    (Test-Path -LiteralPath (Join-Path $SourceDir "app")) -and
    (Test-Path -LiteralPath (Join-Path $SourceDir "components")) -and
    (Test-Path -LiteralPath (Join-Path $SourceDir "lib"))

$installIsPackage = (Test-Path -LiteralPath (Join-Path $InstallDir "server.js")) -and
    (Test-Path -LiteralPath (Join-Path $InstallDir "node.exe")) -and
    (Test-Path -LiteralPath (Join-Path $InstallDir ".next\BUILD_ID"))

$installIsSource = (-not $installIsPackage) -and
    (Test-Path -LiteralPath (Join-Path $InstallDir ".next\BUILD_ID")) -and
    (Test-Path -LiteralPath (Join-Path $InstallDir "node_modules\next"))

Write-Host "源码目录：$SourceDir"
Write-Host "安装目录：$InstallDir"
Write-Host "服务地址：$url"

# ---------- 3. 分派 ----------
if ($installIsPackage) {
    if (-not $sourceIsDevTree) {
        throw @"
安装目录是预编译包安装，但这份源码目录不是完整的开发版源码（缺少 app\ / components\ / lib\ / next.config.ts）：
  $SourceDir

  预编译包安装请用应用内「检查更新」，或下载 Release 的 zip 后运行「一键安装.bat」。
"@
    }
    Write-Host "安装形态：预编译包安装 → 构建开发版并覆盖运行时产物（快，-Undo 可回滚）" -ForegroundColor Yellow
    $quickArgs = @{ SourceDir = $SourceDir; InstallDir = $InstallDir; AppDataDir = $AppDataDir }
    if ($Patch) { $quickArgs.Patch = $Patch }
    if ($Undo) { $quickArgs.Undo = $true }
    if ($ListBackups) { $quickArgs.ListBackups = $true }
    if ($SkipTests) { $quickArgs.SkipTests = $true }
    if ($SkipBuild) { $quickArgs.SkipBuild = $true }
    if ($NoRestart) { $quickArgs.NoRestart = $true }
    if (-not $NoBrowser) { $quickArgs.OpenBrowser = $true }
    & (Join-Path $scriptDir "quick-patch.ps1") @quickArgs
    return
}

if ($installIsSource) {
    if ($Undo -or $ListBackups) {
        throw "源码安装不支持 -Undo / -ListBackups（回滚只对「开发版覆盖运行时产物」那套有效）。"
    }
    if (-not $sourceIsDevTree) {
        throw "安装目录像是源码安装，但这份源码目录不完整：$SourceDir"
    }
    Write-Host "安装形态：源码安装 → install.ps1 -Upgrade 增量升级" -ForegroundColor Yellow
    & (Join-Path $scriptDir "install.ps1") -Upgrade -ForceFull:$ForceFull -AppDataDir $AppDataDir
    Write-Step "启动服务"
    & (Join-Path $AppDataDir "start-papermate.ps1") -AppDataDir $AppDataDir -NoBrowser
    Start-Sleep -Seconds 2
    Write-Host "服务：$url" -ForegroundColor Green
    if (-not $NoBrowser) {
        Open-AppPage -Url $url
    }
    return
}

throw @"
安装目录既不像预编译包安装，也不像源码安装：
  $InstallDir

  确认这是不是 PaperMate 的安装位置（也可以重新安装一次）。
"@
