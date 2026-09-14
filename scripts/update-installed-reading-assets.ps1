$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$config = Get-Content -Raw -LiteralPath (Join-Path $env:LOCALAPPDATA 'PaperMate\config.json') | ConvertFrom-Json
$installedRoot = [IO.Path]::GetFullPath($config.projectDir)
if ($installedRoot.TrimEnd('\') -ne 'D:\papermate') { throw 'Unexpected installed project location' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = Join-Path $installedRoot "asset-backups\$stamp"
$files = @('public\prompts.txt', 'lib\prompts.ts', 'papermate.png', 'papermate.ico', 'scripts\papermate-icon.svg', 'scripts\generate-papermate-icon.mjs', 'scripts\sync-prompt-defaults.mjs')
foreach ($relative in $files) {
    $source = Join-Path $sourceRoot $relative
    $destination = Join-Path $installedRoot $relative
    $backup = Join-Path $backupRoot $relative
    if (Test-Path -LiteralPath $destination) {
        New-Item -ItemType Directory -Force -Path (Split-Path $backup -Parent) | Out-Null
        Copy-Item -LiteralPath $destination -Destination $backup
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent) | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Force
    if ((Get-FileHash -LiteralPath $source).Hash -ne (Get-FileHash -LiteralPath $destination).Hash) { throw "Hash mismatch: $relative" }
}
# A new icon filename avoids stale Windows shortcut-icon cache entries.
$desktopIcon = Join-Path $installedRoot "papermate-reading-$stamp.ico"
Copy-Item -LiteralPath (Join-Path $sourceRoot 'papermate.ico') -Destination $desktopIcon
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'PaperMate 论文助手.lnk'
if (-not (Test-Path -LiteralPath $shortcutPath)) { throw 'PaperMate desktop shortcut missing' }
Copy-Item -LiteralPath $shortcutPath -Destination (Join-Path $backupRoot 'PaperMate 论文助手.lnk')
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$previousTarget = $shortcut.TargetPath
$previousArguments = $shortcut.Arguments
$shortcut.IconLocation = "$desktopIcon,0"
$shortcut.Save()
$verified = $shell.CreateShortcut($shortcutPath)
if ($verified.IconLocation -ne "$desktopIcon,0" -or $verified.TargetPath -ne $previousTarget -or $verified.Arguments -ne $previousArguments) { throw 'Shortcut verification failed' }
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class PaperMateIconRefresh { [DllImport("shell32.dll", CharSet=CharSet.Unicode)] public static extern void SHChangeNotify(uint e, uint f, string a, IntPtr b); }'
[PaperMateIconRefresh]::SHChangeNotify(0x00002000, 0x0005, $shortcutPath, [IntPtr]::Zero)
Write-Output "Verified 7 installed assets; desktop icon updated: $desktopIcon"
Write-Output "Original files backed up: $backupRoot"
