#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$ShortcutName = "PaperMate 论文助手",
    [string]$UninstallShortcutName = "卸载 PaperMate 论文助手",
    [string]$StopShortcutName = "停止 PaperMate 服务",
    [string]$StartMenuFolder = "PaperMate",
    [int]$PreferredPort = 3000,
    [string]$InstallDir = "",
    [string]$AppDataDir = "",
    [switch]$Upgrade,
    [switch]$ChooseInstallDir,
    [switch]$SkipShortcuts,
    [switch]$SkipDependencies,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$sourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceProjectDir = [System.IO.Path]::GetFullPath((Join-Path $sourceDir ".."))
$projectDir = $sourceProjectDir
$appName = "PaperMate"

if ([string]::IsNullOrWhiteSpace($AppDataDir)) {
    $AppDataDir = Join-Path $env:LOCALAPPDATA $appName
}

if ($ChooseInstallDir -and [string]::IsNullOrWhiteSpace($InstallDir)) {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = "选择 PaperMate 安装位置"
    $dialog.ShowNewFolderButton = $true
    if (Test-Path -LiteralPath "D:\") {
        $defaultInstall = Join-Path "D:\" $appName
        if (Test-Path -LiteralPath $defaultInstall) {
            $dialog.SelectedPath = $defaultInstall
        }
        else {
            $dialog.SelectedPath = "D:\"
        }
    }
    else {
        $dialog.SelectedPath = $env:USERPROFILE
    }
    if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
        throw "未选择安装位置，安装已取消。"
    }
    $InstallDir = $dialog.SelectedPath
}

if (-not [string]::IsNullOrWhiteSpace($InstallDir)) {
    $projectDir = [System.IO.Path]::GetFullPath($InstallDir)
}

function Test-SamePath {
    param([string]$First, [string]$Second)
    $firstFull = [System.IO.Path]::GetFullPath($First).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    $secondFull = [System.IO.Path]::GetFullPath($Second).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    return [System.String]::Equals($firstFull, $secondFull, [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-PathInside {
    param([string]$ParentPath, [string]$ChildPath)
    $parentFull = [System.IO.Path]::GetFullPath($ParentPath).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    $childFull = [System.IO.Path]::GetFullPath($ChildPath).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    return $childFull.StartsWith($parentFull + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

function Read-InstalledConfig {
    param([string]$AppDataDir)
    $configPath = Join-Path $AppDataDir "config.json"
    if (-not (Test-Path -LiteralPath $configPath)) {
        return $null
    }
    return (Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json)
}

function Get-PackageVersion {
    param([string]$ProjectPath)
    $packagePath = Join-Path $ProjectPath "package.json"
    if (-not (Test-Path -LiteralPath $packagePath)) {
        return "0.0.0"
    }
    try {
        $package = Get-Content -Raw -LiteralPath $packagePath | ConvertFrom-Json
        $version = [string]$package.version
        if (-not [string]::IsNullOrWhiteSpace($version)) {
            return $version
        }
    }
    catch {
        # Fall through to a safe default when package.json cannot be parsed.
    }
    return "0.0.0"
}

function Wait-ForPortFree {
    param([int]$Port, [int]$TimeoutSeconds = 15)
    for ($i = 0; $i -lt $TimeoutSeconds; $i++) {
        $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
        if (-not $listener) {
            return $true
        }
        Start-Sleep -Seconds 1
    }
    return $false
}

$installedConfig = Read-InstalledConfig -AppDataDir $AppDataDir

if ($Upgrade) {
    if (-not $installedConfig) {
        throw "未检测到已安装的 PaperMate，请先运行一键安装。"
    }

    if ([string]::IsNullOrWhiteSpace($InstallDir)) {
        $configuredInstallDir = [string]$installedConfig.projectDir
        if ([string]::IsNullOrWhiteSpace($configuredInstallDir)) {
            throw "已安装配置缺少 projectDir，无法执行升级。"
        }
        if (-not (Test-Path -LiteralPath $configuredInstallDir)) {
            throw "配置中的安装目录不存在：$configuredInstallDir"
        }
        $InstallDir = $configuredInstallDir
        $projectDir = [System.IO.Path]::GetFullPath($InstallDir)
    }
    else {
        $projectDir = [System.IO.Path]::GetFullPath($InstallDir)
    }

    if (-not $PSBoundParameters.ContainsKey("ShortcutName") -and $installedConfig.shortcutName) {
        $ShortcutName = [string]$installedConfig.shortcutName
    }
    if (-not $PSBoundParameters.ContainsKey("UninstallShortcutName") -and $installedConfig.uninstallShortcutName) {
        $UninstallShortcutName = [string]$installedConfig.uninstallShortcutName
    }
    if (-not $PSBoundParameters.ContainsKey("StopShortcutName") -and $installedConfig.stopShortcutName) {
        $StopShortcutName = [string]$installedConfig.stopShortcutName
    }
    if (-not $PSBoundParameters.ContainsKey("StartMenuFolder") -and $installedConfig.startMenuFolder) {
        $StartMenuFolder = [string]$installedConfig.startMenuFolder
    }
    if (-not $PSBoundParameters.ContainsKey("PreferredPort") -and $installedConfig.port) {
        $portFromConfig = 0
        if ([int]::TryParse([string]$installedConfig.port, [ref]$portFromConfig) -and $portFromConfig -gt 0) {
            $PreferredPort = $portFromConfig
        }
    }

    Write-Host "检测到已安装版本，将保留数据并升级到最新源码。" -ForegroundColor Yellow
    Write-Host "安装目录：$projectDir"
}

if (-not (Test-SamePath $projectDir $sourceProjectDir)) {
    $driveRoot = [System.IO.Path]::GetPathRoot($projectDir).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    $trimmedProjectDir = $projectDir.TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    if ([System.String]::Equals($driveRoot, $trimmedProjectDir, [System.StringComparison]::OrdinalIgnoreCase)) {
        $projectDir = [System.IO.Path]::GetFullPath((Join-Path $projectDir $appName))
        Write-Host "安装位置将使用：$projectDir"
    }
    if (Test-PathInside $projectDir $sourceProjectDir) {
        throw "安装位置不能选在项目文件夹的上级目录，请选择独立文件夹。"
    }
    if (Test-PathInside $sourceProjectDir $projectDir) {
        throw "安装位置不能选在项目文件夹内部，请选择其他位置。"
    }
}

if ($Upgrade -and -not (Test-SamePath $projectDir $sourceProjectDir)) {
    $markerPath = Join-Path $projectDir ".papermate-installed.json"
    if (-not (Test-Path -LiteralPath $markerPath)) {
        throw "安装目录中没有找到 .papermate-installed.json，请确认这是 PaperMate 的安装位置：$projectDir"
    }
}

function Write-Step {
    param([string]$Message)
    Write-Host "== $Message" -ForegroundColor Cyan
}

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

function Get-NpmPath {
    $node = Get-NodePath
    if (-not $node) {
        return $null
    }
    $npm = Join-Path (Split-Path -Parent $node) "npm.cmd"
    if (Test-Path -LiteralPath $npm) {
        return $npm
    }
    return $null
}

function Get-WingetPath {
    $command = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\winget.exe"),
        (Join-Path $env:ProgramFiles "WindowsApps\winget.exe")
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            return $candidate
        }
    }
    return $null
}

function Test-NodeVersion {
    param([string]$NodePath)
    try {
        $versionText = (& $NodePath --version) 2>$null
        $version = [version]($versionText.TrimStart("v"))
        return $version -ge [version]"22.5.0"
    }
    catch {
        return $false
    }
}

function Get-FreePort {
    param([int]$StartPort)
    for ($port = $StartPort; $port -lt ($StartPort + 20); $port++) {
        $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
        if (-not $listener) {
            return $port
        }
    }
    throw "找不到可用端口（$StartPort - $($StartPort + 19) 均被占用）"
}

function Stop-ProjectNodeProcesses {
    param([string]$ProjectPath)

    $projectFull = [System.IO.Path]::GetFullPath($ProjectPath).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    $processes = @()
    try {
        $processes = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop)
    }
    catch {
        try {
            $processes = @(Get-WmiObject Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop)
        }
        catch {
            $processes = @()
        }
    }

    foreach ($process in $processes) {
        $commandLine = [string]$process.CommandLine
        if ([string]::IsNullOrWhiteSpace($commandLine)) {
            continue
        }
        if ($commandLine.IndexOf($projectFull, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
            continue
        }
        $isAppProcess = $commandLine.IndexOf("node_modules\next", [System.StringComparison]::OrdinalIgnoreCase) -ge 0
        $isNpmProcess = $commandLine.IndexOf("npm-cli.js", [System.StringComparison]::OrdinalIgnoreCase) -ge 0
        if (-not ($isAppProcess -or $isNpmProcess)) {
            continue
        }
        Write-Host "正在停止占用项目的进程（PID $($process.ProcessId)）..."
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }

    Start-Sleep -Seconds 2
}

function Copy-ProjectToInstallDir {
    param([string]$Source, [string]$Destination)

    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    $sourceFull = [System.IO.Path]::GetFullPath($Source)
    $destFull = [System.IO.Path]::GetFullPath($Destination)
    $destData = Join-Path $destFull "data"
    $destHasData = Test-Path -LiteralPath $destData

    $robocopyArgs = @(
        $sourceFull,
        $destFull,
        "/E",
        "/XD",
        (Join-Path $sourceFull "node_modules"),
        (Join-Path $sourceFull ".next"),
        (Join-Path $sourceFull ".git"),
        "/NFL",
        "/NDL",
        "/NJH",
        "/NJS",
        "/NP"
    )
    if ($destHasData) {
        $robocopyArgs += @("/XD", (Join-Path $sourceFull "data"))
    }

    & robocopy @robocopyArgs
    if ($LASTEXITCODE -ge 8) {
        throw "复制项目文件失败（robocopy 退出码 $LASTEXITCODE）。"
    }

    if (-not $destHasData) {
        $sourceData = Join-Path $sourceFull "data"
        if (Test-Path -LiteralPath $sourceData) {
            & robocopy $sourceData $destData /E /NFL /NDL /NJH /NJS /NP
            if ($LASTEXITCODE -ge 8) {
                throw "复制数据文件失败（robocopy 退出码 $LASTEXITCODE）。"
            }
        }
    }
}

function New-AppShortcut {
    param(
        [string]$Path,
        [string]$Target,
        [string]$Arguments,
        [string]$WorkingDirectory,
        [string]$Description,
        [string]$Icon
    )

    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($Path)
    $shortcut.TargetPath = $Target
    if ($Arguments) {
        $shortcut.Arguments = $Arguments
    }
    if ($WorkingDirectory) {
        $shortcut.WorkingDirectory = $WorkingDirectory
    }
    if ($Description) {
        $shortcut.Description = $Description
    }
    if ($Icon) {
        $shortcut.IconLocation = $Icon
    }
    $shortcut.Save()
}

Write-Step "检查运行环境"
$node = Get-NodePath
if (-not $node) {
    $winget = Get-WingetPath
    if (-not $winget) {
        throw "没有检测到 Node.js，也没有找到 winget。请先安装 Node.js LTS，再重新运行一键安装。"
    }

    Write-Host "未检测到 Node.js，正在通过 winget 自动安装 Node.js LTS..."
    & $winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        throw "Node.js 自动安装失败，请手动安装 Node.js LTS 后重试。"
    }

    $node = Get-NodePath
    if (-not $node) {
        throw "Node.js 已安装但暂时找不到，请重启电脑后重试。"
    }
}

if (-not (Test-NodeVersion $node)) {
    $winget = Get-WingetPath
    if (-not $winget) {
        throw "Node.js 版本过低（需要 22.5.0 或更高），且没有找到 winget。请先升级 Node.js LTS，再重新运行一键安装。"
    }

    Write-Host "Node.js 版本过低，正在通过 winget 升级到 Node.js LTS..."
    & $winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        throw "Node.js 自动升级失败，请手动安装 Node.js LTS（22.5.0 或更高）后重试。"
    }

    $node = Get-NodePath
    if (-not $node -or -not (Test-NodeVersion $node)) {
        throw "Node.js 已升级但版本仍低于 22.5.0，请重启电脑或手动安装最新 LTS 后重试。"
    }
}

$npm = Get-NpmPath
if (-not $npm) {
    throw "找不到 npm，请检查 Node.js 安装是否完整。"
}

Write-Host "Node.js: $node"
Write-Host "npm: $npm"

$installedStop = Join-Path $AppDataDir "stop-papermate.ps1"
if (Test-Path -LiteralPath $installedStop) {
    Write-Step "停止正在运行的旧服务"
    & $installedStop -AppDataDir $AppDataDir -ErrorAction SilentlyContinue
}

Stop-ProjectNodeProcesses $projectDir
if (-not (Test-SamePath $projectDir $sourceProjectDir)) {
    Stop-ProjectNodeProcesses $sourceProjectDir
}
if ($Upgrade -and -not (Wait-ForPortFree $PreferredPort 15)) {
    Write-Host "端口 $PreferredPort 仍被占用，安装器会尝试其他可用端口。" -ForegroundColor Yellow
}

if (-not (Test-SamePath $projectDir $sourceProjectDir)) {
    Write-Step "复制项目到安装位置"
    Copy-ProjectToInstallDir -Source $sourceProjectDir -Destination $projectDir
    $packageVersion = Get-PackageVersion $sourceProjectDir
    $marker = [ordered]@{
        appName          = $appName
        version          = $packageVersion
        sourceProjectDir = $sourceProjectDir
        installedAt      = (Get-Date).ToString("s")
    }
    $markerPath = Join-Path $projectDir ".papermate-installed.json"
    [System.IO.File]::WriteAllText($markerPath, ($marker | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($true)))
}

if (-not $SkipDependencies) {
    Write-Step "安装项目依赖（首次可能需要几分钟）"
    $npmSucceeded = $false
    for ($attempt = 1; $attempt -le 3 -and -not $npmSucceeded; $attempt++) {
        Write-Host "npm install（第 $attempt 次尝试）..."
        Stop-ProjectNodeProcesses $projectDir
        Push-Location $projectDir
        try {
            & $npm install --no-audit --no-fund
            if ($LASTEXITCODE -eq 0) {
                $npmSucceeded = $true
            }
            else {
                Write-Host "依赖安装未成功，正在等待文件锁释放后重试..."
                Stop-ProjectNodeProcesses $projectDir
                Start-Sleep -Seconds 3
            }
        }
        finally {
            Pop-Location
        }
    }
    if (-not $npmSucceeded) {
        throw "依赖安装失败。请关闭 PaperMate 服务和其他占用 node_modules 的程序，然后重新运行一键安装。"
    }
}

if (-not $SkipBuild) {
    Write-Step "构建正式版本（首次可能需要几分钟）"
    Stop-ProjectNodeProcesses $projectDir
    Push-Location $projectDir
    try {
        & $npm run build
        if ($LASTEXITCODE -ne 0) {
            throw "构建失败，请查看上方输出。"
        }
    }
    finally {
        Pop-Location
    }
}
elseif (-not (Test-Path -LiteralPath (Join-Path $projectDir ".next\BUILD_ID"))) {
    throw "项目还没有生产构建，请去掉 -SkipBuild 后重新运行。"
}

Write-Step "生成启动器"
New-Item -ItemType Directory -Path $AppDataDir -Force | Out-Null

Copy-Item -LiteralPath (Join-Path $sourceDir "start-papermate.ps1") -Destination (Join-Path $AppDataDir "start-papermate.ps1") -Force
Copy-Item -LiteralPath (Join-Path $sourceDir "stop-papermate.ps1") -Destination (Join-Path $AppDataDir "stop-papermate.ps1") -Force
Copy-Item -LiteralPath (Join-Path $sourceDir "uninstall.ps1") -Destination (Join-Path $AppDataDir "uninstall.ps1") -Force

$vbsPath = Join-Path $AppDataDir "launcher.vbs"
$vbsContent = @'
Option Explicit
Dim shell, fs, appDir, startScript, command
Set shell = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
appDir = fs.GetParentFolderName(WScript.ScriptFullName)
startScript = appDir & "\start-papermate.ps1"
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & startScript & """"
shell.Run command, 0, False
'@
[System.IO.File]::WriteAllText($vbsPath, $vbsContent, [System.Text.Encoding]::ASCII)

$port = Get-FreePort $PreferredPort
$packageVersion = Get-PackageVersion $sourceProjectDir
$config = [ordered]@{
    appName               = $appName
    version               = $packageVersion
    projectDir            = $projectDir
    sourceProjectDir      = $sourceProjectDir
    installedCopy         = (-not (Test-SamePath $projectDir $sourceProjectDir))
    port                  = $port
    url                   = "http://127.0.0.1:$port"
    shortcutName          = $ShortcutName
    uninstallShortcutName = $UninstallShortcutName
    stopShortcutName      = $StopShortcutName
    startMenuFolder       = $StartMenuFolder
    installedAt           = (Get-Date).ToString("s")
}
$configJson = $config | ConvertTo-Json
$configPath = Join-Path $AppDataDir "config.json"
[System.IO.File]::WriteAllText($configPath, $configJson, (New-Object System.Text.UTF8Encoding($true)))

if (-not $SkipShortcuts) {
    Write-Step "创建桌面和开始菜单快捷方式"

    $desktop = [Environment]::GetFolderPath("Desktop")
    $startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
    $appMenuDir = Join-Path $startMenu $StartMenuFolder
    New-Item -ItemType Directory -Path $appMenuDir -Force | Out-Null

    $wscript = Join-Path $env:SystemRoot "System32\wscript.exe"
    $pwsh = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $uninstallScript = Join-Path $AppDataDir "uninstall.ps1"
    $uninstallArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$uninstallScript`""
    $uninstallCommand = "`"$pwsh`" $uninstallArgs"
    # papermate.png 是图标源文件，Windows 快捷方式使用转换后的 papermate.ico。
    $appIcon = Join-Path $projectDir "papermate.ico"
    if (-not (Test-Path -LiteralPath $appIcon)) {
        $appIcon = "$env:SystemRoot\System32\imageres.dll,3"
    }
    $uninstallIcon = Join-Path $projectDir "papermate-uninstall.ico"
    if (-not (Test-Path -LiteralPath $uninstallIcon)) {
        $uninstallIcon = $appIcon
    }

    New-AppShortcut `
        -Path (Join-Path $desktop "$ShortcutName.lnk") `
        -Target $wscript `
        -Arguments "`"$vbsPath`"" `
        -WorkingDirectory $AppDataDir `
        -Description "启动 PaperMate 论文助手" `
        -Icon $appIcon

    New-AppShortcut `
        -Path (Join-Path $appMenuDir "$ShortcutName.lnk") `
        -Target $wscript `
        -Arguments "`"$vbsPath`"" `
        -WorkingDirectory $AppDataDir `
        -Description "启动 PaperMate 论文助手" `
        -Icon $appIcon

    New-AppShortcut `
        -Path (Join-Path $appMenuDir "$StopShortcutName.lnk") `
        -Target $pwsh `
        -Arguments "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $AppDataDir 'stop-papermate.ps1')`"" `
        -WorkingDirectory $AppDataDir `
        -Description "停止 PaperMate 服务" `
        -Icon "$env:SystemRoot\System32\shell32.dll,27"

    New-AppShortcut `
        -Path (Join-Path $appMenuDir "$UninstallShortcutName.lnk") `
        -Target $pwsh `
        -Arguments $uninstallArgs `
        -WorkingDirectory $AppDataDir `
        -Description "卸载 PaperMate 论文助手" `
        -Icon $uninstallIcon

    New-AppShortcut `
        -Path (Join-Path $projectDir "$UninstallShortcutName.lnk") `
        -Target $pwsh `
        -Arguments $uninstallArgs `
        -WorkingDirectory $AppDataDir `
        -Description "卸载 PaperMate 论文助手" `
        -Icon $uninstallIcon

    Write-Step "注册到 Windows 应用列表"
    $regPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\PaperMate"
    New-Item -Path $regPath -Force | Out-Null
    New-ItemProperty -Path $regPath -Name "DisplayName" -Value $ShortcutName -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $regPath -Name "DisplayVersion" -Value $packageVersion -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $regPath -Name "Publisher" -Value "Local PaperMate" -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $regPath -Name "InstallLocation" -Value $projectDir -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $regPath -Name "DisplayIcon" -Value $uninstallIcon -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $regPath -Name "UninstallString" -Value $uninstallCommand -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $regPath -Name "NoModify" -Value 1 -PropertyType DWord -Force | Out-Null
    New-ItemProperty -Path $regPath -Name "NoRepair" -Value 1 -PropertyType DWord -Force | Out-Null
}

Write-Host ""
Write-Host "安装完成" -ForegroundColor Green
if ($SkipShortcuts) {
    Write-Host "启动器目录：$AppDataDir"
    Write-Host "服务地址：http://127.0.0.1:$port"
}
else {
    Write-Host "桌面已创建：$ShortcutName"
    Write-Host "开始菜单已创建：$UninstallShortcutName"
    Write-Host "服务地址：http://127.0.0.1:$port"
    Write-Host "现在可以双击桌面图标启动；卸载入口在开始菜单、安装目录和项目根目录的一键卸载.bat。"
}
