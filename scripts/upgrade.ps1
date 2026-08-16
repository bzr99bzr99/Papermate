#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$InstallDir = "",
    [string]$AppDataDir = "",
    [switch]$SkipShortcuts,
    [switch]$SkipDependencies,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$sourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceProjectDir = [System.IO.Path]::GetFullPath((Join-Path $sourceDir ".."))
$appName = "PaperMate"

if ([string]::IsNullOrWhiteSpace($AppDataDir)) {
    $AppDataDir = Join-Path $env:LOCALAPPDATA $appName
}

$configPath = Join-Path $AppDataDir "config.json"
if (-not (Test-Path -LiteralPath $configPath)) {
    throw "未检测到已安装的 PaperMate，请先运行一键安装。"
}

$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$projectDir = ""
if (-not [string]::IsNullOrWhiteSpace($InstallDir)) {
    $projectDir = [System.IO.Path]::GetFullPath($InstallDir)
}
else {
    $projectDir = [string]$config.projectDir
}

if ([string]::IsNullOrWhiteSpace($projectDir)) {
    throw "已安装配置缺少 projectDir，无法执行升级。"
}
if (-not (Test-Path -LiteralPath $projectDir)) {
    throw "配置中的安装目录不存在：$projectDir"
}

Write-Host "== 检测到 PaperMate 安装" -ForegroundColor Cyan
Write-Host "安装目录：$projectDir"
Write-Host "升级将保留安装位置的 data 数据文件夹。" -ForegroundColor Yellow

$installScript = Join-Path $sourceDir "install.ps1"
$arguments = @{
    Upgrade    = $true
    AppDataDir = $AppDataDir
    InstallDir = $projectDir
}
if ($SkipShortcuts) {
    $arguments.SkipShortcuts = $true
}
if ($SkipDependencies) {
    $arguments.SkipDependencies = $true
}
if ($SkipBuild) {
    $arguments.SkipBuild = $true
}

& $installScript @arguments

Write-Host ""
Write-Host "升级完成。" -ForegroundColor Green
Write-Host "数据已保留在安装位置 data 文件夹。"
