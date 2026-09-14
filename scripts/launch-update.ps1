#Requires -Version 5.1
param([Parameter(Mandatory=$true)][string]$JobFile)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent ([IO.Path]::GetFullPath($JobFile))
$helper = Join-Path $root 'apply-update.ps1'
$arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $helper + '"'), '-JobFile', ('"' + $JobFile + '"'))
try {
    $process = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $root 'install.log') -RedirectStandardError (Join-Path $root 'install-error.log')
    $handoff = @{ helperPid = $process.Id } | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $root 'helper-pid.json'), $handoff, (New-Object Text.UTF8Encoding($true)))
    exit 0
} catch {
    Write-Error -ErrorAction Continue ($_ | Out-String)
    exit 1
}
