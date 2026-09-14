#Requires -Version 5.1
param([Parameter(Mandatory=$true)][string]$JobFile)
$ErrorActionPreference = 'Stop'
# -Encoding UTF8：本脚本由 Windows PowerShell 5.1 执行，默认按系统 ANSI 代码页读文件；
# 安装路径含中文时会把路径读成乱码、更新直接失败，这里显式按 UTF-8 解码
# （写入侧另见 lib/updater.ts：job.json / status.json 一律带 UTF-8 BOM）。
$job = Get-Content -LiteralPath $JobFile -Raw -Encoding UTF8 | ConvertFrom-Json
$project = [IO.Path]::GetFullPath($job.projectDir).TrimEnd('\')
$appData = [IO.Path]::GetFullPath($job.appData).TrimEnd('\')
$parent = Split-Path -Parent $project
$stamp = [Guid]::NewGuid().ToString('N')
$stage = Join-Path $parent ('.papermate-stage-' + $stamp)
$backup = Join-Path $parent ('.papermate-backup-' + $stamp)
$failed = Join-Path $parent ('.papermate-failed-' + $stamp)
$swapped = $false
$stopped = $false
$newProcess = $null
function Status([string]$phase, [string]$message, [int]$progress = -1) {
    $state = Get-Content -LiteralPath $job.statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $state.phase = $phase
    $state.message = $message
    $state | Add-Member -NotePropertyName updatedAt -NotePropertyValue ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) -Force
    $state | Add-Member -NotePropertyName installStage -NotePropertyValue $message -Force
    $state | Add-Member -NotePropertyName helperPid -NotePropertyValue $PID -Force
    if ($progress -ge 0) { $state | Add-Member -NotePropertyName installProgress -NotePropertyValue $progress -Force }
    Write-Output ((Get-Date -Format o) + ' ' + $phase + ' ' + $message)
    $temp = $job.statusPath + '.helper.tmp'
    [IO.File]::WriteAllText($temp, ($state | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temp -Destination $job.statusPath -Force
}
# 每次更新都会整份备份旧程序，长期累积可占几百 MB；只保留最近 7 天的回滚副本。
function Remove-StaleSiblings {
    try {
        foreach ($pattern in @('.papermate-backup-*', '.papermate-failed-*')) {
            Get-ChildItem -LiteralPath $parent -Directory -Filter $pattern -ErrorAction SilentlyContinue |
                Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) -and $_.FullName -ne $backup -and $_.FullName -ne $failed } |
                ForEach-Object { Assert-Sibling $_.FullName; Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }
    catch { }
}
function Assert-Sibling([string]$target) {
    $resolved = [IO.Path]::GetFullPath($target).TrimEnd('\')
    if ((Split-Path -Parent $resolved) -ne $parent -or $resolved -eq $parent) { throw 'Unsafe installation path' }
}
function Start-Version {
    $server = Join-Path $project 'server.js'
    $node = Join-Path $project 'node.exe'
    if (!(Test-Path -LiteralPath $node)) { $node = (Get-Command node.exe).Source }
    $env:PORT = [string]$job.port
    $env:HOSTNAME = '127.0.0.1'
    $env:PAPERMATE_APP_DATA = $appData
    if (Test-Path -LiteralPath $server) { $arguments = @(('"' + $server + '"')) }
    else {
        $cli = Join-Path $project 'node_modules\next\dist\bin\next'
        $arguments = @(('"' + $cli + '"'), 'start', '-H', '127.0.0.1', '-p', [string]$job.port)
    }
    $process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $project -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $appData 'server.out.log') -RedirectStandardError (Join-Path $appData 'server.err.log')
    Set-Content -LiteralPath (Join-Path $appData 'server.pid') -Value $process.Id -Encoding ASCII
    return $process
}
try {
    Status 'installing' '正在校验安装包' 5
    Assert-Sibling $project
    Assert-Sibling $stage
    Assert-Sibling $backup
    Assert-Sibling $failed
    $configPath = Join-Path $appData 'config.json'
    $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (!$config.installedCopy -or [IO.Path]::GetFullPath($config.projectDir).TrimEnd('\') -ne $project -or (Test-Path -LiteralPath (Join-Path $project '.git'))) { throw 'Only registered installations may be updated' }
    if ((Get-FileHash -LiteralPath $job.archive -Algorithm SHA256).Hash -ne $job.sha256) { throw 'Archive checksum mismatch' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    New-Item -ItemType Directory -Path $stage | Out-Null
    Status 'installing' '正在解压程序文件' 10
    $zip = [IO.Compression.ZipFile]::OpenRead($job.archive)
    try {
        [long]$total = 0
        $entryIndex = 0
        $lastProgressWrite = [DateTime]::MinValue
        foreach ($entry in $zip.Entries) {
            $entryIndex++
            if (([DateTime]::UtcNow - $lastProgressWrite).TotalSeconds -ge 1) {
                Status 'installing' '正在解压程序文件' (10 + [int](25 * $entryIndex / [Math]::Max(1, $zip.Entries.Count)))
                $lastProgressWrite = [DateTime]::UtcNow
            }
            $total += $entry.Length
            if ($total -gt 4GB) { throw 'Archive exceeds extraction limit' }
            $name = $entry.FullName.Replace('/', '\')
            $destination = [IO.Path]::GetFullPath((Join-Path $stage $name))
            if (!$destination.StartsWith($stage + '\', [StringComparison]::OrdinalIgnoreCase) -or $name.Contains(':') -or $name -match '^(data|\.git)(\\|$)' -or (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'Unsafe archive entry' }
            if (!$entry.Name) { New-Item -ItemType Directory -Path $destination -Force | Out-Null; continue }
            New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $false)
        }
    } finally { $zip.Dispose() }
    $package = Get-Content -LiteralPath (Join-Path $stage 'package.json') -Raw | ConvertFrom-Json
    if ($package.version -ne $job.version -or !(Test-Path -LiteralPath (Join-Path $stage 'server.js')) -or !(Test-Path -LiteralPath (Join-Path $stage 'node.exe'))) { throw 'Invalid update package' }
    $owner = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$job.serverPid)
    if (!$owner -or $owner.Name -ne 'node.exe' -or $owner.CommandLine.IndexOf($project, [StringComparison]::OrdinalIgnoreCase) -lt 0) { throw 'Cannot verify running PaperMate process' }
    # Give the installation HTTP response time to reach the browser.
    Start-Sleep -Seconds 2
    Status 'installing' '正在停止旧服务' 40
    Stop-Process -Id ([int]$job.serverPid) -Force
    Wait-Process -Id ([int]$job.serverPid) -Timeout 20 -ErrorAction SilentlyContinue
    $stopped = $true
    # Keep the complete old installation as the rollback copy, including SQLite WAL files.
    Status 'installing' '正在备份旧版本' 50
    $moved = $false
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        try { Move-Item -LiteralPath $project -Destination $backup; $moved = $true; break }
        catch { Start-Sleep -Seconds 1 }
    }
    if (!$moved) { throw 'Installation files are still in use' }
    $swapped = $true
    Status 'installing' '正在保留论文、笔记与设置' 60
    if (Test-Path -LiteralPath (Join-Path $backup 'data')) { Copy-Item -LiteralPath (Join-Path $backup 'data') -Destination (Join-Path $stage 'data') -Recurse }
    foreach ($name in @('public\prompts.txt', 'public\quotes.txt')) {
        $source = Join-Path $backup $name
        if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $stage $name) -Force }
    }
    Status 'installing' '正在替换程序文件' 75
    Move-Item -LiteralPath $stage -Destination $project
    Status 'installing' '正在启动新版本，页面将暂时断开连接' 85
    $newProcess = Start-Version
    $healthy = $false
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 1
        Status 'installing' '正在验证新版本启动状态' 90
        try {
            $health = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $job.port + '/api/updates') -TimeoutSec 2
            if ($health.currentVersion -eq $job.version) { $healthy = $true; break }
        } catch {}
        if ($newProcess.HasExited) { break }
    }
    if (!$healthy) { throw 'New version failed its startup health check' }
    $config.version = $job.version
    # 必须带 BOM：install.ps1 / start-papermate.ps1 都用 Windows PowerShell 读取 config.json，
    # 写回时去掉 BOM 会让含中文的安装路径与快捷方式名在下次启动时变成乱码。
    [IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($true)))
    foreach ($script in @('start-papermate.ps1', 'stop-papermate.ps1', 'uninstall.ps1')) {
        Copy-Item -LiteralPath (Join-Path $project ('scripts\' + $script)) -Destination (Join-Path $appData $script) -Force
    }
    Status 'complete' '更新完成，即将刷新页面' 100
    Remove-StaleSiblings
} catch {
    $reason = $_.Exception.Message
    Write-Output ($_ | Out-String)
    try {
        Status 'installing' '安装遇到问题，正在恢复旧版本'
        if ($newProcess -and !$newProcess.HasExited) { Stop-Process -Id $newProcess.Id -Force; Start-Sleep -Seconds 2 }
        if ($swapped) {
            if (Test-Path -LiteralPath $project) { Assert-Sibling $project; Assert-Sibling $failed; Move-Item -LiteralPath $project -Destination $failed }
            Assert-Sibling $backup; Assert-Sibling $project
            Move-Item -LiteralPath $backup -Destination $project
        }
        if ($stopped) { $null = Start-Version }
        Status 'error' ('更新失败，已恢复旧程序：' + $reason)
    } catch { Status 'error' ('更新失败，请使用启动快捷方式重试。备份：' + $backup + '；' + $reason + '；' + $_.Exception.Message) }
} finally {
    $lock = Join-Path (Split-Path -Parent $JobFile) 'lock'
    if (Test-Path -LiteralPath $lock) { Remove-Item -LiteralPath $lock }
    # 下载的更新包（含压缩包，约 100-200MB）已经用完，清掉以免反复更新撑爆磁盘。
    if ($job.job -and (Test-Path -LiteralPath $job.job)) {
        $cleanupPath = [IO.Path]::GetFullPath($job.job).TrimEnd('\')
        $updatesPath = [IO.Path]::GetFullPath((Split-Path -Parent $JobFile)).TrimEnd('\')
        if ((Split-Path -Parent $cleanupPath) -eq $updatesPath -and (Split-Path -Leaf $cleanupPath) -match '^[0-9a-f-]{36}$') {
            Remove-Item -LiteralPath $cleanupPath -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
