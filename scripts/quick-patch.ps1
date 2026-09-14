#Requires -Version 5.1
<#
.SYNOPSIS
    把本地源码的改动快速"打补丁"到已安装的 PaperMate 上，用于开发/测试。

.DESCRIPTION
    完整发版链路是：npm run build → 打包(8240 个文件 / 80 MB) → 压缩 → SHA-256 → 更新助手停服务换目录。
    这条链路要十几分钟，而且每一步都可能失败。但真正决定页面行为的东西只有很少：
    Next 的 .next 运行时产物（约 8 MB）、server.js、package.json。
    这个脚本就只同步这几样，跳过打包与压缩，通常 10 秒左右完成一次迭代。

        # 只同步当前源码（改完代码直接生效）
        powershell -ExecutionPolicy Bypass -File scripts\quick-patch.ps1

        # 先打一个补丁文件，再同步
        powershell -ExecutionPolicy Bypass -File scripts\quick-patch.ps1 -Patch ..\xxx.patch

        # 测试不满意，回滚上一次
        powershell -ExecutionPolicy Bypass -File scripts\quick-patch.ps1 -Undo

    安全设计：
      * 覆盖前把安装目录当前的 .next / server.js / package.json 备份到
        %LOCALAPPDATA%\PaperMate\dev-backups\<时间戳>（默认保留最近 5 份），可 -Undo 回滚；
      * 依赖清单有变化时自动补拷 standalone 追踪到的 node_modules，避免启动即 MODULE_NOT_FOUND；
      * public\ 下的提示词/拾句/人格默认不覆盖（那是用户数据），要覆盖得显式加 -IncludePublic。

    注意：同步完后安装目录里跑的是"你本地源码构建出来的产物"，不等于 GitHub Release 的正式包。
    想用正式包覆盖回来：scripts\install-package.ps1 -PackageZip <官方 zip> -Force

.PARAMETER Patch
    要应用的补丁文件（git diff 格式，a/ b/ 前缀）。会先 dry-run 校验，再真正打上。

.PARAMETER SourceDir
    本地源码目录。默认取本脚本所在 scripts\ 的上一级。

.PARAMETER InstallDir
    已安装的 PaperMate 目录。默认读 %LOCALAPPDATA%\PaperMate\config.json 里的 projectDir。

.PARAMETER Undo
    把最近一次 quick-patch 的备份还原回安装目录，然后重启服务。

.PARAMETER ListBackups
    只列出可回滚的备份，不做任何改动。
#>
[CmdletBinding()]
param(
    [string]$Patch = "",
    [string]$SourceDir = "",
    [string]$InstallDir = "",
    [string]$AppDataDir = "",
    [switch]$SkipTests,
    [switch]$SkipBuild,
    [switch]$IncludePublic,
    [switch]$ForcePublic,
    [switch]$IncludeNodeModules,
    [switch]$NoRestart,
    [switch]$Undo,
    [switch]$ListBackups,
    [switch]$OpenBrowser,
    [int]$KeepBackups = 5
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptDir ".."))
$backupRootName = "dev-backups"
$userPublicFiles = @("prompts.txt", "quotes.txt", "buddy-personas.txt")
# 运行时真正会用到的脚本：更新器 spawn 的启动器与助手、启动/停止/卸载入口。
# 部署时把这几个同步过去（其余 scripts\ 下的是开发工具与打包脚本，不进安装目录）。
$runtimeScripts = @("apply-update.ps1", "launch-update.ps1", "start-papermate.ps1", "stop-papermate.ps1", "uninstall.ps1")

if ([string]::IsNullOrWhiteSpace($AppDataDir)) {
    $AppDataDir = Join-Path $env:LOCALAPPDATA "PaperMate"
}
$AppDataDir = [System.IO.Path]::GetFullPath($AppDataDir)
$backupRoot = Join-Path $AppDataDir $backupRootName

function Write-Step {
    param([string]$Message)
    Write-Host "== $Message" -ForegroundColor Cyan
}

function Write-Note {
    param([string]$Message)
    Write-Host "   $Message" -ForegroundColor DarkGray
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

function Assert-ExitCode {
    param([int]$Code, [string]$What)
    if ($Code -ge 8) {
        throw "$What 失败（robocopy 退出码 $Code）。"
    }
}

function Get-PatchExe {
    $candidates = @(
        (Join-Path $env:ProgramFiles "Git\usr\bin\patch.exe"),
        (Join-Path $env:ProgramFiles "Git\bin\patch.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Git\usr\bin\patch.exe")
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            return $candidate
        }
    }
    $command = Get-Command patch.exe -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }
    return ""
}

function Get-ChangedFilesFromPatch {
    param([string]$Path)
    $files = @()
    foreach ($line in (Get-Content -LiteralPath $Path -Encoding UTF8)) {
        if ($line.StartsWith("+++ ")) {
            $target = $line.Substring(4).Trim()
            if ($target -eq "/dev/null") {
                continue
            }
            if ($target.StartsWith("b/")) {
                $target = $target.Substring(2)
            }
            $files += $target
        }
    }
    return @($files | Sort-Object -Unique)
}

# ---------- 1. 定位安装目录 ----------
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

if ([string]::IsNullOrWhiteSpace($InstallDir)) {
    if ($config -and -not [string]::IsNullOrWhiteSpace([string]$config.projectDir)) {
        $InstallDir = [string]$config.projectDir
    }
    else {
        throw "没有指定 -InstallDir，也没能在 $configPath 里找到 projectDir。请先安装 PaperMate，或用 -InstallDir 指定。"
    }
}
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)

if (-not (Test-Path -LiteralPath $InstallDir)) {
    throw "安装目录不存在：$InstallDir"
}

$port = 3000
if ($config -and -not [string]::IsNullOrWhiteSpace([string]$config.port)) {
    $parsedPort = 0
    if ([int]::TryParse([string]$config.port, [ref]$parsedPort) -and $parsedPort -gt 0) {
        $port = $parsedPort
    }
}
$url = "http://127.0.0.1:$port"

$installIsPackage = (Test-Path -LiteralPath (Join-Path $InstallDir "server.js")) -and (Test-Path -LiteralPath (Join-Path $InstallDir "node.exe")) -and (Test-Path -LiteralPath (Join-Path $InstallDir ".next\BUILD_ID"))
if (-not $installIsPackage) {
    throw @"
安装目录不是预编译包安装，quick-patch 无法覆盖运行时产物：
  $InstallDir

  预编译包安装应该有 server.js、node.exe、.next\BUILD_ID 三样。
  如果这是源码安装（含 app\ components\ lib\ 与 node_modules\next），请改用仓库根目录的「一键安装.bat」做增量升级。
"@
}

Write-Host "安装目录：$InstallDir"
Write-Host "服务地址：$url"

# ---------- 2. 备份管理（列表 / 回滚） ----------
function Get-DevBackups {
    if (-not (Test-Path -LiteralPath $backupRoot)) {
        return @()
    }
    return @(Get-ChildItem -LiteralPath $backupRoot -Directory | Sort-Object Name -Descending)
}

if ($ListBackups) {
    $backups = Get-DevBackups
    if ($backups.Count -eq 0) {
        Write-Host "还没有 quick-patch 备份。" -ForegroundColor Yellow
    }
    else {
        Write-Host "可回滚的备份（新 → 旧）："
        foreach ($item in $backups) {
            $meta = Join-Path $item.FullName "patch-info.json"
            $summary = ""
            if (Test-Path -LiteralPath $meta) {
                try {
                    $info = Get-Content -Raw -LiteralPath $meta | ConvertFrom-Json
                    $summary = "  版本 $($info.version)  补丁 $($info.patch)  构建 $($info.builtAt)"
                }
                catch {
                    $summary = ""
                }
            }
            Write-Host ("  " + $item.Name + $summary)
        }
    }
    return
}

function Restore-DevBackup {
    param([string]$BackupPath)

    Write-Step "停止服务"
    $stopScript = Join-Path $AppDataDir "stop-papermate.ps1"
    if (Test-Path -LiteralPath $stopScript) {
        & $stopScript -AppDataDir $AppDataDir -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 1

    Write-Step "还原运行时产物"
    $nextDir = Join-Path $InstallDir ".next"
    if (Test-Path -LiteralPath $nextDir) {
        Remove-Item -LiteralPath $nextDir -Recurse -Force
    }
    robocopy (Join-Path $BackupPath ".next") $nextDir /E /NFL /NDL /NJH /NJS /NP | Out-Null
    Assert-ExitCode $LASTEXITCODE "还原 .next"
    foreach ($name in @("server.js", "package.json", "papermate-version.json")) {
        $from = Join-Path $BackupPath $name
        if (Test-Path -LiteralPath $from) {
            Copy-Item -LiteralPath $from -Destination (Join-Path $InstallDir $name) -Force
        }
    }
    $backupScripts = Join-Path $BackupPath "scripts"
    $installScripts = Join-Path $InstallDir "scripts"
    if (Test-Path -LiteralPath $backupScripts) {
        if (Test-Path -LiteralPath $installScripts) {
            Remove-Item -LiteralPath $installScripts -Recurse -Force
        }
        robocopy $backupScripts $installScripts /E /NFL /NDL /NJH /NJS /NP | Out-Null
        Assert-ExitCode $LASTEXITCODE "还原 scripts"
    }
    Write-Host "已还原备份：$(Split-Path -Leaf $BackupPath)" -ForegroundColor Green
}

if ($Undo) {
    $backups = Get-DevBackups
    if ($backups.Count -eq 0) {
        throw "没有可回滚的备份（$backupRoot 为空）。"
    }
    $latest = $backups[0]
    Restore-DevBackup -BackupPath $latest.FullName
    if (-not $NoRestart) {
        Write-Step "重启服务"
        & (Join-Path $AppDataDir "start-papermate.ps1") -AppDataDir $AppDataDir -NoBrowser
        Start-Sleep -Seconds 3
        Write-Host "服务：$url" -ForegroundColor Green
    }
    if ($OpenBrowser) {
        Open-AppPage -Url $url
    }
    return
}

# ---------- 3. 源码目录检查 ----------
if ([string]::IsNullOrWhiteSpace($SourceDir)) {
    $SourceDir = $repoRoot
}
$SourceDir = [System.IO.Path]::GetFullPath($SourceDir)

foreach ($item in @("package.json", "next.config.ts", "app", "components", "lib")) {
    if (-not (Test-Path -LiteralPath (Join-Path $SourceDir $item))) {
        throw "源码目录不完整（缺少 $item）：$SourceDir"
    }
}
Write-Host "源码目录：$SourceDir"
$sourceVersion = (Get-Content -Raw -LiteralPath (Join-Path $SourceDir "package.json") | ConvertFrom-Json).version
Write-Host "源码版本：$sourceVersion"

# ---------- 4. 打补丁 ----------
$appliedPatchName = "none"
if (-not [string]::IsNullOrWhiteSpace($Patch)) {
    $patchPath = [System.IO.Path]::GetFullPath($Patch)
    if (-not (Test-Path -LiteralPath $patchPath)) {
        throw "找不到补丁文件：$patchPath"
    }
    $appliedPatchName = Split-Path -Leaf $patchPath
    $changedFiles = Get-ChangedFilesFromPatch -Path $patchPath

    $patchExe = Get-PatchExe
    Push-Location $SourceDir
    try {
        if ($patchExe) {
            Write-Step "校验补丁（dry-run）"
            $dry = (& $patchExe -p1 --binary --dry-run --no-backup-if-mismatch -i $patchPath 2>&1 | Out-String)
            if ($LASTEXITCODE -ne 0) {
                throw "补丁无法干净地应用到源码上（patch 退出码 $LASTEXITCODE）：`n$dry"
            }
            Write-Host $dry.Trim()

            Write-Step "应用补丁"
            $apply = (& $patchExe -p1 --binary --no-backup-if-mismatch -i $patchPath 2>&1 | Out-String)
            if ($LASTEXITCODE -ne 0) {
                throw "应用补丁失败（patch 退出码 $LASTEXITCODE）：`n$apply"
            }
            Write-Host $apply.Trim()
        }
        else {
            Write-Step "没有找到 patch.exe，退回 git apply"
            $apply = (& git apply --verbose $patchPath 2>&1 | Out-String)
            if ($LASTEXITCODE -ne 0) {
                throw "git apply 失败（退出码 $LASTEXITCODE）：`n$apply`n提示：源码目录若嵌在另一个 Git 仓库里，git apply 可能不生效，请安装 Git 的 patch.exe（随 Git for Windows 提供）。"
            }
            Write-Host $apply.Trim()
        }
    }
    finally {
        Pop-Location
    }

    # 只在补丁涉及的文件所在目录里找冲突残留，不要全树扫（node_modules 有三万多个文件），
    # 也不能用 -LiteralPath 配 -Include：那种组合下 -Include 会被忽略，把所有文件都当成冲突。
    $rejects = @()
    $searchRoots = @($SourceDir)
    if ($changedFiles.Count -gt 0) {
        $searchRoots = @($changedFiles | ForEach-Object { Split-Path -Parent (Join-Path $SourceDir $_) } | Sort-Object -Unique)
    }
    foreach ($root in $searchRoots) {
        if (-not (Test-Path -LiteralPath $root)) {
            continue
        }
        $rejects += @(Get-ChildItem -LiteralPath $root -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.Extension -eq ".rej" -or $_.Extension -eq ".orig" })
    }
    if ($rejects.Count -gt 0) {
        throw "补丁留下了冲突文件（$($rejects.Count) 个），请检查：`n  " + (($rejects | Select-Object -First 5 | ForEach-Object { $_.FullName }) -join "`n  ")
    }
    if ($changedFiles.Count -gt 0) {
        Write-Host "补丁涉及 $($changedFiles.Count) 个文件："
        foreach ($file in $changedFiles) {
            Write-Host "   $file"
        }
    }
}

# ---------- 5. 测试与构建 ----------
$npm = "npm"
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "找不到 npm，无法构建源码。请安装 Node.js 22.5+ 后重试。"
}

if (-not $SkipTests) {
    Write-Step "跑测试（npm test）"
    Push-Location $SourceDir
    try {
        & npm test
        if ($LASTEXITCODE -ne 0) {
            throw "测试未通过（退出码 $LASTEXITCODE），已中止，安装目录没有改动。"
        }
    }
    finally {
        Pop-Location
    }
}

if (-not $SkipBuild) {
    Write-Step "构建（npm run build）"
    Push-Location $SourceDir
    try {
        & npm run build
        if ($LASTEXITCODE -ne 0) {
            throw "构建失败（退出码 $LASTEXITCODE），已中止，安装目录没有改动。"
        }
    }
    finally {
        Pop-Location
    }
}

$standalone = Join-Path $SourceDir ".next\standalone"
if (-not (Test-Path -LiteralPath (Join-Path $standalone "server.js"))) {
    throw "缺少 $standalone\server.js：请确认 next.config.ts 里 output 是 ""standalone""，并先成功构建一次。"
}
if (-not (Test-Path -LiteralPath (Join-Path $SourceDir ".next\static"))) {
    throw "缺少 $SourceDir\.next\static，构建不完整。"
}
$buildId = (Get-Content -Raw -LiteralPath (Join-Path $SourceDir ".next\BUILD_ID")).Trim()

# 依赖清单是否变化：变了就必须把 standalone 追踪到的 node_modules 也补上，否则启动即 MODULE_NOT_FOUND。
function Get-DependencyMap {
    param([string]$PackageJsonPath)
    $package = Get-Content -Raw -LiteralPath $PackageJsonPath | ConvertFrom-Json
    $map = @{}
    if ($package.dependencies) {
        foreach ($property in $package.dependencies.PSObject.Properties) {
            $map[$property.Name] = [string]$property.Value
        }
    }
    return $map
}
$sourceDeps = Get-DependencyMap -PackageJsonPath (Join-Path $SourceDir "package.json")
$installDeps = Get-DependencyMap -PackageJsonPath (Join-Path $InstallDir "package.json")
$depsChanged = $false
foreach ($key in $sourceDeps.Keys) {
    if (-not $installDeps.ContainsKey($key) -or $installDeps[$key] -ne $sourceDeps[$key]) {
        $depsChanged = $true
    }
}
foreach ($key in $installDeps.Keys) {
    if (-not $sourceDeps.ContainsKey($key)) {
        $depsChanged = $true
    }
}

# ---------- 6. 备份当前运行时 ----------
Write-Step "停止服务"
$stopScript = Join-Path $AppDataDir "stop-papermate.ps1"
if (Test-Path -LiteralPath $stopScript) {
    & $stopScript -AppDataDir $AppDataDir -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 1

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupPath = Join-Path $backupRoot $stamp
Write-Step "备份当前运行时产物 → $backupRoot\$stamp"
New-Item -ItemType Directory -Path $backupPath -Force | Out-Null
robocopy (Join-Path $InstallDir ".next") (Join-Path $backupPath ".next") /E /NFL /NDL /NJH /NJS /NP | Out-Null
Assert-ExitCode $LASTEXITCODE "备份 .next"
foreach ($name in @("server.js", "package.json", "papermate-version.json")) {
    $from = Join-Path $InstallDir $name
    if (Test-Path -LiteralPath $from) {
        Copy-Item -LiteralPath $from -Destination (Join-Path $backupPath $name) -Force
    }
}
# scripts\ 也一起备份（体积很小），这样 -Undo 能把安装目录的脚本还原成部署前的样子。
$installScripts = Join-Path $InstallDir "scripts"
if (Test-Path -LiteralPath $installScripts) {
    robocopy $installScripts (Join-Path $backupPath "scripts") /E /NFL /NDL /NJH /NJS /NP | Out-Null
    Assert-ExitCode $LASTEXITCODE "备份 scripts"
}
$installVersionBefore = (Get-Content -Raw -LiteralPath (Join-Path $backupPath "package.json") | ConvertFrom-Json).version
[System.IO.File]::WriteAllText(
    (Join-Path $backupPath "patch-info.json"),
    ([ordered]@{
        version    = $installVersionBefore
        patch      = $appliedPatchName
        sourceDir  = $SourceDir
        builtAt    = (Get-Date).ToString("s")
        buildId    = (Get-Content -Raw -LiteralPath (Join-Path $backupPath ".next\BUILD_ID") -ErrorAction SilentlyContinue).Trim()
    } | ConvertTo-Json),
    (New-Object System.Text.UTF8Encoding($true))
)

# ---------- 7. 覆盖运行时产物 ----------
Write-Step "覆盖 .next（Next 运行时产物）"
$targetNext = Join-Path $InstallDir ".next"
if (Test-Path -LiteralPath $targetNext) {
    Remove-Item -LiteralPath $targetNext -Recurse -Force
}
robocopy (Join-Path $standalone ".next") $targetNext /E /NFL /NDL /NJH /NJS /NP | Out-Null
Assert-ExitCode $LASTEXITCODE "覆盖 .next"
robocopy (Join-Path $SourceDir ".next\static") (Join-Path $targetNext "static") /E /NFL /NDL /NJH /NJS /NP | Out-Null
Assert-ExitCode $LASTEXITCODE "覆盖 .next\static"

Write-Step "覆盖 server.js 与 package.json"
Copy-Item -LiteralPath (Join-Path $standalone "server.js") -Destination (Join-Path $InstallDir "server.js") -Force
Copy-Item -LiteralPath (Join-Path $SourceDir "package.json") -Destination (Join-Path $InstallDir "package.json") -Force

$syncedScripts = @()
$targetScripts = Join-Path $InstallDir "scripts"
if (Test-Path -LiteralPath $targetScripts) {
    foreach ($name in $runtimeScripts) {
        $from = Join-Path (Join-Path $SourceDir "scripts") $name
        if (Test-Path -LiteralPath $from) {
            Copy-Item -LiteralPath $from -Destination (Join-Path $targetScripts $name) -Force
            $syncedScripts += $name
        }
    }
    if ($syncedScripts.Count -gt 0) {
        Write-Host "已同步运行时脚本：$($syncedScripts -join '、')"
    }
}

if ($depsChanged -or $IncludeNodeModules) {
    Write-Step "补拷依赖（依赖清单有变化，或指定了 -IncludeNodeModules）"
    robocopy (Join-Path $standalone "node_modules") (Join-Path $InstallDir "node_modules") /E /NFL /NDL /NJH /NJS /NP | Out-Null
    Assert-ExitCode $LASTEXITCODE "补拷 node_modules"
}

if ($IncludePublic) {
    Write-Step "覆盖 public\"
    $skipNames = @()
    if (-not $ForcePublic) {
        $skipNames = $userPublicFiles
        Write-Note "默认跳过用户可改的 $($userPublicFiles -join '、')（要一起覆盖请加 -ForcePublic）"
    }
    $arguments = @((Join-Path $SourceDir "public"), (Join-Path $InstallDir "public"), "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP")
    if ($skipNames.Count -gt 0) {
        $arguments += @("/XF")
        $arguments += $skipNames
    }
    robocopy @arguments | Out-Null
    Assert-ExitCode $LASTEXITCODE "覆盖 public"
}

$versionFile = Join-Path $InstallDir "papermate-version.json"
$previousVersionFile = @{}
if (Test-Path -LiteralPath $versionFile) {
    try {
        $previous = Get-Content -Raw -LiteralPath $versionFile | ConvertFrom-Json
        $previousVersionFile = @{ createdAt = [string]$previous.createdAt }
    }
    catch {
    }
}
[System.IO.File]::WriteAllText($versionFile, (([ordered]@{
    name       = "papermate"
    version    = $sourceVersion
    tag        = "v$sourceVersion-dev"
    devBuild   = $true
    buildId    = $buildId
    sourceDir  = $SourceDir
    patch      = $appliedPatchName
    createdAt  = (Get-Date).ToUniversalTime().ToString("s") + "Z"
    platform   = "windows-x64"
}) | ConvertTo-Json) + "`n", (New-Object System.Text.UTF8Encoding($false)))

# 只保留最近 N 份备份
$backups = @(Get-ChildItem -LiteralPath $backupRoot -Directory | Sort-Object Name -Descending)
if ($backups.Count -gt $KeepBackups) {
    foreach ($stale in $backups[$KeepBackups..($backups.Count - 1)]) {
        Remove-Item -LiteralPath $stale.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-Note "已清理旧备份，保留最近 $KeepBackups 份。"
}

# ---------- 8. 重启并自检 ----------
$reportedVersion = ""
if (-not $NoRestart) {
    Write-Step "重启服务"
    & (Join-Path $AppDataDir "start-papermate.ps1") -AppDataDir $AppDataDir -NoBrowser
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 1
        try {
            $response = Invoke-WebRequest -Uri "$url/api/updates" -UseBasicParsing -TimeoutSec 3
            if ($response.StatusCode -eq 200) {
                $reportedVersion = ($response.Content | ConvertFrom-Json).currentVersion
                break
            }
        }
        catch {
        }
    }
    if (-not $reportedVersion) {
        Write-Host "服务在 60 秒内没有响应，请查看 $AppDataDir\server.err.log。" -ForegroundColor Yellow
        Write-Host "回滚命令：powershell -File `"$($MyInvocation.MyCommand.Path)`" -Undo" -ForegroundColor Yellow
        return
    }
}

Write-Host ""
Write-Host "补丁已生效" -ForegroundColor Green
Write-Host "  源码版本   $sourceVersion"
Write-Host "  构建 BUILD_ID  $buildId"
Write-Host "  备份       $backupPath"
Write-Host "  回滚       powershell -File `"$($MyInvocation.MyCommand.Path)`" -Undo"
if ($reportedVersion) {
    Write-Host "  服务上报版本   $reportedVersion   （$url）"
    if ($reportedVersion -ne $sourceVersion) {
        Write-Host "  注意：服务上报的版本和源码 package.json 不一致，可能是服务没重启成功（旧进程还在）。" -ForegroundColor Yellow
    }
}
Write-Host ""
Write-Host "提醒：安装目录现在跑的是开发版源码构建的产物，不等于 GitHub Release 的正式包。" -ForegroundColor Yellow
Write-Host "     开发版版本号固定为 1；正式版号在纯净上传仓库里维护（发版时在那里改成真实版本号再打 tag）。" -ForegroundColor Yellow
Write-Host "     开发版在应用里会显示「有新版本 4.x」，属于正常现象；点它会把这台机器恢复成正式包。" -ForegroundColor Yellow
Write-Host "     想立刻恢复成正式包：scripts\install-package.ps1 -PackageZip <官方 zip> -Force" -ForegroundColor Yellow
if ($OpenBrowser) {
    Open-AppPage -Url $url
}
