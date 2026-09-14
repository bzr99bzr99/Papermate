#Requires -Version 5.1
<#
.SYNOPSIS
    安装 PaperMate 预编译包（Release 里的 papermate-windows-x64.zip）。

.DESCRIPTION
    这个脚本随预编译包一起分发：从 GitHub Release 下载 papermate-windows-x64.zip 后解压，
    双击根目录的「一键安装.bat」即可安装；也可以直接把 zip 交给它：

        powershell -ExecutionPolicy Bypass -File scripts\install-package.ps1 -PackageZip D:\下载\papermate-windows-x64.zip

    与「一键安装.bat」（源码安装）的区别：
      * 不需要 Node.js、npm，也不需要联网——包内自带 node.exe；
      * 不复制源码、不 npm install、不构建，安装通常只要几十秒；
      * 覆盖安装时先把整个旧目录挪成同级的 .papermate-backup-<guid>（可回滚），
        再把用户数据还原回来：data\ 整个目录，以及用户改过的 public\*.txt。

    安全底线：
      * 只接受结构完整的包（server.js / node.exe / .next\BUILD_ID / package.json / scripts\apply-update.ps1）；
      * 目标目录不是空目录、又不像是 PaperMate 安装目录时，必须显式加 -Force；
      * 绝不会用包里的内容覆盖已有安装目录里的 data\（论文库与 API Key）。

.PARAMETER PackageDir
    预编译包根目录（含 server.js / node.exe 的那一层）。默认取本脚本所在 scripts\ 的上一级。

.PARAMETER PackageZip
    直接给一个 papermate-windows-x64.zip；同目录存在 .sha256 时会先逐字节校验再解压。

.PARAMETER InstallDir
    安装位置。不填时：已安装过就沿用原位置，否则弹窗选择（默认 D:\PaperMate）。

.PARAMETER Start
    安装完成后立刻启动服务并等待健康检查通过（默认不启动，由桌面快捷方式启动）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\install-package.ps1
    powershell -ExecutionPolicy Bypass -File scripts\install-package.ps1 -InstallDir D:\PaperMate -Start
#>
[CmdletBinding()]
param(
    [string]$PackageDir = "",
    [string]$PackageZip = "",
    [string]$InstallDir = "",
    [string]$AppDataDir = "",
    [int]$PreferredPort = 3000,
    [string]$ShortcutName = "PaperMate 论文助手",
    [string]$UninstallShortcutName = "卸载 PaperMate 论文助手",
    [string]$StopShortcutName = "停止 PaperMate 服务",
    [string]$StartMenuFolder = "PaperMate",
    [switch]$ChooseInstallDir,
    [switch]$Force,
    [switch]$SkipShortcuts,
    [switch]$Start
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$appName = "PaperMate"
$stagingDir = ""

if ([string]::IsNullOrWhiteSpace($AppDataDir)) {
    $AppDataDir = Join-Path $env:LOCALAPPDATA $appName
}
$AppDataDir = [System.IO.Path]::GetFullPath($AppDataDir)

function Write-Step {
    param([string]$Message)
    Write-Host "== $Message" -ForegroundColor Cyan
}

function Write-Note {
    param([string]$Message)
    Write-Host "   $Message" -ForegroundColor DarkGray
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

function Test-DirectoryEmpty {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        return $true
    }
    $first = Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue | Select-Object -First 1
    return ($null -eq $first)
}

function Read-InstalledConfig {
    param([string]$Directory)
    $configPath = Join-Path $Directory "config.json"
    if (-not (Test-Path -LiteralPath $configPath)) {
        return $null
    }
    try {
        return (Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json)
    }
    catch {
        return $null
    }
}

function Get-PackageVersion {
    param([string]$Path)
    try {
        $package = Get-Content -Raw -LiteralPath (Join-Path $Path "package.json") | ConvertFrom-Json
        if (-not [string]::IsNullOrWhiteSpace([string]$package.version)) {
            return [string]$package.version
        }
    }
    catch {
    }
    return "0.0.0"
}

function Get-FreePort {
    param([int]$StartPort)
    for ($port = $StartPort; $port -lt ($StartPort + 20); $port++) {
        $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
        if (-not $listener) {
            return $port
        }
    }
    throw "找不到可用端口（$StartPort - $($StartPort + 19) 均被占用）。"
}

function Test-PortFree {
    param([int]$Port)
    $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
    return ($null -eq $listener)
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
        Write-Host "正在停止占用安装目录的进程（PID $($process.ProcessId)）..."
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }

    Start-Sleep -Seconds 2
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

function Assert-PackageLayout {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "找不到预编译包目录：$Path"
    }

    $required = @(
        "server.js",
        "node.exe",
        "package.json",
        ".next\BUILD_ID",
        ".next\static",
        "node_modules\next\package.json",
        "public\prompts.txt",
        "scripts\apply-update.ps1",
        "scripts\start-papermate.ps1"
    )
    $missing = @()
    foreach ($item in $required) {
        if (-not (Test-Path -LiteralPath (Join-Path $Path $item))) {
            $missing += $item
        }
    }
    if ($missing.Count -gt 0) {
        throw @"
这个目录不是完整的 PaperMate 预编译包（缺少：$($missing -join '、')）。

  如果你要装的是源码仓库（含 app\ components\ lib\ 但没有 server.js），请改用仓库根目录的「一键安装.bat」。
  如果你要装的是下载来的 zip，请先用 -PackageZip 指定它，或先把 zip 完整解压再运行本脚本。
"@
    }

    foreach ($item in @("data", ".git")) {
        if (Test-Path -LiteralPath (Join-Path $Path $item)) {
            throw "预编译包里出现了不该有的目录：$item（可能不是官方发布的包）。"
        }
    }
}

# ---------- 1. 准备包来源（目录，或先校验并解压 zip） ----------
if (-not [string]::IsNullOrWhiteSpace($PackageZip)) {
    $zipPath = [System.IO.Path]::GetFullPath($PackageZip)
    if (-not (Test-Path -LiteralPath $zipPath)) {
        throw "找不到压缩包：$zipPath"
    }

    Write-Step "校验压缩包"
    $shaPath = $zipPath + ".sha256"
    if (Test-Path -LiteralPath $shaPath) {
        $expected = (((Get-Content -Raw -LiteralPath $shaPath) -split '\s+') | Where-Object { $_ } | Select-Object -First 1).Trim().ToLowerInvariant()
        $actual = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($expected -ne $actual) {
            throw "SHA-256 校验失败，已中止安装。`n  期望：$expected`n  实际：$actual"
        }
        Write-Host "SHA-256 校验通过：$actual"
    }
    else {
        Write-Host "同目录没有 .sha256 校验文件，跳过校验。" -ForegroundColor Yellow
    }

    $sizeMb = [math]::Round((Get-Item -LiteralPath $zipPath).Length / 1MB, 1)
    Write-Step "解压到临时目录（$sizeMb MB，请稍候）"
    $stagingDir = Join-Path $env:TEMP ("papermate-install-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null
    Expand-Archive -LiteralPath $zipPath -DestinationPath $stagingDir -Force
    $packageRoot = $stagingDir
}
else {
    if ([string]::IsNullOrWhiteSpace($PackageDir)) {
        $PackageDir = [System.IO.Path]::GetFullPath((Join-Path $scriptDir ".."))
    }
    $packageRoot = [System.IO.Path]::GetFullPath($PackageDir)
}

Assert-PackageLayout $packageRoot
$packageVersion = Get-PackageVersion $packageRoot

Write-Step "检查包内自带的 Node.js"
$bundledNode = Join-Path $packageRoot "node.exe"
$nodeVersionText = (& $bundledNode --version) 2>$null
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($nodeVersionText)) {
    throw "包内的 node.exe 无法运行：$bundledNode"
}
Write-Host "包内 Node：$($nodeVersionText.Trim())"

# ---------- 2. 决定安装位置 ----------
$installedConfig = Read-InstalledConfig -Directory $AppDataDir

if ([string]::IsNullOrWhiteSpace($InstallDir)) {
    $configuredDir = ""
    if ($installedConfig) {
        $configuredDir = [string]$installedConfig.projectDir
    }

    if (-not [string]::IsNullOrWhiteSpace($configuredDir) -and (Test-Path -LiteralPath $configuredDir)) {
        $InstallDir = $configuredDir
        Write-Host "检测到已安装版本，将覆盖升级原位置：$InstallDir" -ForegroundColor Yellow
    }
    else {
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
        $result = $dialog.ShowDialog()
        if ($result -ne [System.Windows.Forms.DialogResult]::OK) {
            throw "未选择安装位置，安装已取消。"
        }
        $InstallDir = $dialog.SelectedPath
    }
}

$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$driveRoot = [System.IO.Path]::GetPathRoot($InstallDir).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
if ([System.String]::Equals($driveRoot, $InstallDir.TrimEnd([System.IO.Path]::DirectorySeparatorChar), [System.StringComparison]::OrdinalIgnoreCase)) {
    $InstallDir = [System.IO.Path]::GetFullPath((Join-Path $InstallDir $appName))
    Write-Host "安装位置不能是磁盘根目录，改用：$InstallDir" -ForegroundColor Yellow
}

if (Test-SamePath $InstallDir $packageRoot) {
    throw "安装位置不能就是包所在目录，请选择另一个文件夹。"
}
if (Test-PathInside $InstallDir $packageRoot) {
    throw "安装位置不能选在包目录内部，请选择其他位置。"
}
if (Test-PathInside $packageRoot $InstallDir) {
    throw "安装位置不能是包目录的上级目录，请选择独立文件夹。"
}

Write-Host "版本：$packageVersion"
Write-Host "安装位置：$InstallDir"

# ---------- 3. 处理已有安装目录 ----------
$targetLooksInstalled = (Test-Path -LiteralPath (Join-Path $InstallDir "papermate-version.json")) -or (Test-Path -LiteralPath (Join-Path $InstallDir "server.js"))
$targetExists = Test-Path -LiteralPath $InstallDir
$targetEmpty = Test-DirectoryEmpty -Path $InstallDir
$backupDir = ""
$hadData = $false

if ($targetExists -and -not $targetEmpty) {
    if (-not $targetLooksInstalled -and -not $Force) {
        throw @"
目标目录已存在且不是空的，也不像是 PaperMate 安装目录：
  $InstallDir

  确认要覆盖它，请加上 -Force 重新运行。
"@
    }

    if ($targetLooksInstalled) {
        Write-Step "停止正在运行的旧服务"
        $installedStop = Join-Path $AppDataDir "stop-papermate.ps1"
        if (Test-Path -LiteralPath $installedStop) {
            & $installedStop -AppDataDir $AppDataDir -ErrorAction SilentlyContinue
        }
        Stop-ProjectNodeProcesses $InstallDir
    }

    $backupDir = Join-Path (Split-Path -Parent $InstallDir) (".papermate-backup-" + [guid]::NewGuid().ToString("N"))
    Write-Step "把原目录移到备份位置（可回滚）"
    Move-Item -LiteralPath $InstallDir -Destination $backupDir
    Write-Host "备份：$backupDir"
    if (Test-Path -LiteralPath (Join-Path $backupDir "data")) {
        $hadData = $true
    }
}

# ---------- 4. 落盘 ----------
Write-Step "复制程序文件到安装位置"
if (-not (Test-Path -LiteralPath $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}
robocopy $packageRoot $InstallDir /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) {
    throw "复制程序文件失败（robocopy 退出码 $LASTEXITCODE）。"
}

# ---------- 5. 还原用户数据 ----------
if ($hadData) {
    Write-Step "还原论文数据（data\）"
    robocopy (Join-Path $backupDir "data") (Join-Path $InstallDir "data") /E /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) {
        throw "还原 data\ 失败（robocopy 退出码 $LASTEXITCODE）。原目录仍保留在：$backupDir"
    }
    $restored = Get-ChildItem -LiteralPath (Join-Path $InstallDir "data") -File -Force -ErrorAction SilentlyContinue | Measure-Object
    Write-Host "已还原 $($restored.Count) 个数据文件（论文库、API Key、备份）。"
}

# public 下的提示词/拾句/人格是用户可改的：只有和包内默认值不一致时才还原用户的版本。
$publicFiles = @()
if (Test-Path -LiteralPath (Join-Path $packageRoot "public")) {
    $publicFiles += @(Get-ChildItem -LiteralPath (Join-Path $packageRoot "public") -Filter "*.txt" -File -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
}
if ($backupDir) {
    $backupPublic = Join-Path $backupDir "public"
    if (Test-Path -LiteralPath $backupPublic) {
        $publicFiles += @(Get-ChildItem -LiteralPath $backupPublic -Filter "*.txt" -File -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
    }
}
$publicFiles = @($publicFiles | Sort-Object -Unique)
$keptPublic = @()
$backupPublicDir = ""
if (-not [string]::IsNullOrWhiteSpace($backupDir)) {
    $backupPublicDir = Join-Path $backupDir "public"
}
foreach ($name in $publicFiles) {
    if ([string]::IsNullOrWhiteSpace($backupPublicDir)) {
        continue
    }
    $backupFile = Join-Path $backupPublicDir $name
    $targetFile = Join-Path (Join-Path $InstallDir "public") $name
    if (-not (Test-Path -LiteralPath $backupFile)) {
        continue
    }
    $same = $false
    if (Test-Path -LiteralPath $targetFile) {
        $same = (Get-FileHash -LiteralPath $backupFile -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $targetFile -Algorithm SHA256).Hash
    }
    if (-not $same) {
        New-Item -ItemType Directory -Path (Split-Path -Parent $targetFile) -Force | Out-Null
        Copy-Item -LiteralPath $backupFile -Destination $targetFile -Force
        $keptPublic += $name
    }
}
if ($keptPublic.Count -gt 0) {
    Write-Host "已保留你改过的 public 文件：$($keptPublic -join '、')"
}

# ---------- 6. 启动器与安装信息 ----------
Write-Step "生成启动器"
New-Item -ItemType Directory -Path $AppDataDir -Force | Out-Null

foreach ($name in @("start-papermate.ps1", "stop-papermate.ps1", "uninstall.ps1")) {
    $from = Join-Path (Join-Path $InstallDir "scripts") $name
    if (-not (Test-Path -LiteralPath $from)) {
        throw "预编译包缺少 scripts\$name，安装已中止（程序文件已复制到 $InstallDir）。"
    }
    Copy-Item -LiteralPath $from -Destination (Join-Path $AppDataDir $name) -Force
}

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

$port = 0
if ($installedConfig -and -not [string]::IsNullOrWhiteSpace([string]$installedConfig.port)) {
    $configuredPortInt = 0
    if ([int]::TryParse([string]$installedConfig.port, [ref]$configuredPortInt) -and $configuredPortInt -gt 0 -and (Test-PortFree $configuredPortInt)) {
        $port = $configuredPortInt
    }
}
if ($port -eq 0) {
    $port = Get-FreePort $PreferredPort
}

$config = [ordered]@{
    appName               = $appName
    version               = $packageVersion
    projectDir            = $InstallDir
    # 预编译包安装没有外部源码目录，这里留空；写成 $InstallDir 会让卸载器把安装目录误判成
    # “源码就地安装”的受保护路径，从而拒绝删除程序文件。
    sourceProjectDir      = ""
    installedCopy         = $true
    packageInstall        = $true
    port                  = $port
    url                   = "http://127.0.0.1:$port"
    shortcutName          = $ShortcutName
    uninstallShortcutName = $UninstallShortcutName
    stopShortcutName      = $StopShortcutName
    startMenuFolder       = $StartMenuFolder
    installedAt           = (Get-Date).ToString("s")
}
[System.IO.File]::WriteAllText((Join-Path $AppDataDir "config.json"), ($config | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($true)))

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

    $appIcon = Join-Path $InstallDir "papermate.ico"
    if (-not (Test-Path -LiteralPath $appIcon)) {
        $appIcon = "$env:SystemRoot\System32\imageres.dll,3"
    }
    $uninstallIcon = Join-Path $InstallDir "papermate-uninstall.ico"
    if (-not (Test-Path -LiteralPath $uninstallIcon)) {
        $uninstallIcon = $appIcon
    }

    New-AppShortcut -Path (Join-Path $desktop "$ShortcutName.lnk") -Target $wscript -Arguments "`"$vbsPath`"" -WorkingDirectory $AppDataDir -Description "启动 PaperMate 论文助手" -Icon $appIcon
    New-AppShortcut -Path (Join-Path $appMenuDir "$ShortcutName.lnk") -Target $wscript -Arguments "`"$vbsPath`"" -WorkingDirectory $AppDataDir -Description "启动 PaperMate 论文助手" -Icon $appIcon
    New-AppShortcut -Path (Join-Path $appMenuDir "$StopShortcutName.lnk") -Target $pwsh -Arguments "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $AppDataDir 'stop-papermate.ps1')`"" -WorkingDirectory $AppDataDir -Description "停止 PaperMate 服务" -Icon "$env:SystemRoot\System32\shell32.dll,27"
    New-AppShortcut -Path (Join-Path $appMenuDir "$UninstallShortcutName.lnk") -Target $pwsh -Arguments $uninstallArgs -WorkingDirectory $AppDataDir -Description "卸载 PaperMate 论文助手" -Icon $uninstallIcon
    New-AppShortcut -Path (Join-Path $InstallDir "$UninstallShortcutName.lnk") -Target $pwsh -Arguments $uninstallArgs -WorkingDirectory $AppDataDir -Description "卸载 PaperMate 论文助手" -Icon $uninstallIcon

    Write-Step "注册到 Windows 应用列表"
    $regPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\PaperMate"
    New-Item -Path $regPath -Force | Out-Null
    New-ItemProperty -Path $regPath -Name "DisplayName" -Value $ShortcutName -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $regPath -Name "DisplayVersion" -Value $packageVersion -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $regPath -Name "Publisher" -Value "Local PaperMate" -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $regPath -Name "InstallLocation" -Value $InstallDir -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $regPath -Name "DisplayIcon" -Value $uninstallIcon -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $regPath -Name "UninstallString" -Value $uninstallCommand -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $regPath -Name "NoModify" -Value 1 -PropertyType DWord -Force | Out-Null
    New-ItemProperty -Path $regPath -Name "NoRepair" -Value 1 -PropertyType DWord -Force | Out-Null
}

# ---------- 7. 可选：立刻启动并自检 ----------
$started = $false
if ($Start) {
    Write-Step "启动服务并自检"
    & (Join-Path $AppDataDir "start-papermate.ps1") -AppDataDir $AppDataDir -NoBrowser
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 1
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/updates" -UseBasicParsing -TimeoutSec 3
            if ($response.StatusCode -eq 200) {
                $status = $response.Content | ConvertFrom-Json
                Write-Host "服务已就绪：http://127.0.0.1:$port （自报版本 $($status.currentVersion)）" -ForegroundColor Green
                $started = $true
                break
            }
        }
        catch {
        }
    }
    if (-not $started) {
        Write-Host "服务在 60 秒内没有响应，请查看 $AppDataDir\server.err.log。" -ForegroundColor Yellow
    }
}

if ($stagingDir -and (Test-Path -LiteralPath $stagingDir)) {
    Remove-Item -LiteralPath $stagingDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "安装完成（版本 $packageVersion）" -ForegroundColor Green
Write-Host "安装位置：$InstallDir"
Write-Host "数据目录：$(Join-Path $InstallDir 'data')"
if ($backupDir) {
    Write-Host "旧版本备份：$backupDir"
    Write-Host "如需回滚：先停止服务，把备份目录改回 $InstallDir 即可。"
}
if ($SkipShortcuts) {
    Write-Host "（本次跳过了快捷方式创建）"
    Write-Host "启动方式：powershell -File `"$(Join-Path $AppDataDir 'start-papermate.ps1')`""
}
else {
    Write-Host "桌面已创建：$ShortcutName"
    Write-Host "开始菜单已创建：$UninstallShortcutName"
    if (-not $Start) {
        Write-Host "双击桌面图标即可启动，服务地址 http://127.0.0.1:$port"
    }
}
