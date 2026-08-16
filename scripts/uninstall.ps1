#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$AppDataDir = "",
    [switch]$RemoveGenerated,
    [switch]$RemoveAllData,
    [switch]$SkipRegistry
)

$ErrorActionPreference = "Stop"

$appName = "PaperMate"
if ([string]::IsNullOrWhiteSpace($AppDataDir)) {
    $AppDataDir = Join-Path $env:LOCALAPPDATA $appName
}

Write-Host "正在卸载 PaperMate 论文助手..."

$configPath = Join-Path $AppDataDir "config.json"
$hasConfig = Test-Path -LiteralPath $configPath
$config = $null
if ($hasConfig) {
    $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
}

$stopScript = Join-Path $AppDataDir "stop-papermate.ps1"
if (Test-Path -LiteralPath $stopScript) {
    Write-Host "正在停止 PaperMate 服务..."
    & $stopScript -AppDataDir $AppDataDir -ErrorAction SilentlyContinue
}

if ($hasConfig) {
    $desktop = [Environment]::GetFolderPath("Desktop")
    $shortcutNames = @($config.shortcutName, $config.uninstallShortcutName)
    foreach ($name in $shortcutNames) {
        if ($name) {
            Remove-Item -LiteralPath (Join-Path $desktop "$name.lnk") -Force -ErrorAction SilentlyContinue
        }
    }

    $projectDirFromConfig = [string]$config.projectDir
    if ($projectDirFromConfig -and $config.uninstallShortcutName) {
        Remove-Item -LiteralPath (Join-Path $projectDirFromConfig "$($config.uninstallShortcutName).lnk") -Force -ErrorAction SilentlyContinue
    }

    $startMenuRoot = [System.IO.Path]::GetFullPath((Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"))
    $menuDir = [System.IO.Path]::GetFullPath((Join-Path $startMenuRoot ([string]$config.startMenuFolder)))
    if ($menuDir.StartsWith($startMenuRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $menuDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$regPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\PaperMate"
if (-not $SkipRegistry) {
    Remove-Item -LiteralPath $regPath -Recurse -Force -ErrorAction SilentlyContinue
}

$oldLocation = Get-Location
Set-Location -LiteralPath $env:TEMP
try {
    if (Test-Path -LiteralPath $AppDataDir) {
        Write-Host "正在删除启动器文件：$AppDataDir"
        Remove-Item -LiteralPath $AppDataDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
finally {
    Set-Location -LiteralPath $oldLocation
}

if ($SkipRegistry) {
    Write-Host "快捷方式和启动器已移除（跳过 Windows 应用列表清理）。" -ForegroundColor Green
}
else {
    Write-Host "快捷方式、启动器和 Windows 应用列表项已移除。" -ForegroundColor Green
}

$projectDir = ""
$installedCopy = $false
$sourceProjectDir = ""
if ($config) {
    $projectDir = [string]$config.projectDir
    $installedCopy = [bool]$config.installedCopy
    $sourceProjectDir = [string]$config.sourceProjectDir
}

if (-not $projectDir) {
    Write-Host "未找到项目安装信息，跳过项目文件清理。" -ForegroundColor Yellow
}
elseif ($installedCopy) {
    $projectFull = [System.IO.Path]::GetFullPath($projectDir)
    $driveRoot = [System.IO.Path]::GetPathRoot($projectFull).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    $trimmedProject = $projectFull.TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    $sourceFull = $null
    if ($sourceProjectDir) {
        $sourceFull = [System.IO.Path]::GetFullPath($sourceProjectDir).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    }
    $isProtectedPath = [System.String]::Equals($driveRoot, $trimmedProject, [System.StringComparison]::OrdinalIgnoreCase) -or
        ($sourceFull -and [System.String]::Equals($sourceFull, $trimmedProject, [System.StringComparison]::OrdinalIgnoreCase))
    if ($isProtectedPath) {
        Write-Host "已跳过受保护路径的删除操作：$projectFull" -ForegroundColor Yellow
    }
    elseif (-not (Test-Path -LiteralPath (Join-Path $projectFull ".papermate-installed.json"))) {
        Write-Host "安装位置中没有找到 PaperMate 安装标记，已跳过目录清理：$projectFull" -ForegroundColor Yellow
    }
    else {
        $dataDir = Join-Path $projectFull "data"
        $keepData = (Test-Path -LiteralPath $dataDir) -and (-not $RemoveAllData)

        if ($keepData) {
            Write-Host "正在删除安装位置中的应用文件：$projectFull"
            Write-Host "data 数据目录将保留：$dataDir"
            foreach ($item in Get-ChildItem -LiteralPath $projectFull -Force -ErrorAction SilentlyContinue) {
                if (-not [System.String]::Equals($item.FullName, $dataDir, [System.StringComparison]::OrdinalIgnoreCase)) {
                    Remove-Item -LiteralPath $item.FullName -Recurse -Force -ErrorAction SilentlyContinue
                }
            }
        }
        else {
            Write-Host "正在删除安装位置：$projectFull"
            Remove-Item -LiteralPath $projectFull -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
elseif ($sourceProjectDir) {
    Write-Host "项目仍保留在原开发目录：$sourceProjectDir"
}

if ($RemoveGenerated -and $projectDir) {
    $projectFull = [System.IO.Path]::GetFullPath($projectDir)
    foreach ($name in @("node_modules", ".next")) {
        $target = [System.IO.Path]::GetFullPath((Join-Path $projectFull $name))
        $prefix = $projectFull.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
        if ($target.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $target)) {
            Write-Host "正在删除：$target"
            Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

if (-not $installedCopy) {
    Write-Host "论文、笔记和本机备份仍保留在项目 data 文件夹中。"
}
elseif ($RemoveAllData) {
    Write-Host "论文、笔记和本机备份也已删除。"
}
else {
    Write-Host "论文、笔记和本机备份已保留在安装位置的 data 文件夹中。"
}

Write-Host "卸载完成。" -ForegroundColor Green
