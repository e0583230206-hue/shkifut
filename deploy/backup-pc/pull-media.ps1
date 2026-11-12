# Incremental PULL of the media from the live server, with the read-only account (chroot, internal-sftp -R):
#   channel_data (the originals + metadata), training, logs, blurred (the blurred copies, incl. manual).
# A file that appears is copied; a file that is deleted or changed on the server is NOT lost here: it is moved to _deleted\<date>\<stage>
# and kept 30 days. Low priority (BelowNormal here; the account runs at nice 19 on the server), bandwidth capped, never wipes more than 300 files in one run.
# Nothing media is copied until the owner creates the gate file (see common.ps1) AND the folder is private (no other local account can read it).
#
#   pull-media.ps1 [-Stage channel_data,training,logs,blurred | all] [-DryRun] [-MaxMinutes 90] [-BwLimit 4M]
param(
    [string[]]$Stage = @('all'),
    [switch]$DryRun,
    [string]$DestRoot,          # tests only: the default is the protected media folder
    [int]$MaxMinutes = 0,       # 0 = no limit; otherwise the copy stops starting new files after that (resumes in the next run)
    [string]$BwLimit = '4M'     # MiB/s
)
. (Join-Path $PSScriptRoot 'common.ps1')

function New-SyncArgs([string]$remote, [string]$local, [string]$backupDir, [string]$logFile, [string]$bw, [int]$minutes, [bool]$dry) {
    $a = @('sync', $remote, $local, '--backup-dir', $backupDir,
        '--transfers', '2', '--checkers', '4', '--bwlimit', $bw,
        '--retries', '3', '--low-level-retries', '8', '--contimeout', '30s', '--timeout', '120s',
        '--max-delete', '300', '--max-delete-size', '1G',
        '--exclude', '*.part', '--exclude', '*.partial',
        '--stats', '60s', '--stats-one-line', '--log-file', $logFile, '--log-level', 'INFO')
    if ($minutes -gt 0) { $a += @('--max-duration', "${minutes}m", '--cutoff-mode', 'soft') }
    if ($dry) { $a += '--dry-run' }
    return , $a
}

if ($MyInvocation.InvocationName -eq '.') { return }   # dot-sourced by a test: only the functions

Set-RcloneEnv
$allStages = @('channel_data', 'training', 'logs', 'blurred')
$stages = if ($Stage -contains 'all') { $allStages } else { $Stage }
foreach ($s in $stages) { if ($allStages -notcontains $s) { throw "unknown stage: $s" } }
$dest = if ($DestRoot) { $DestRoot } else { $MediaDir }
Assert-NotCloudFolder $dest

$mediaInvolved = @($stages | Where-Object { $MediaStages -contains $_ }).Count -gt 0
if ($mediaInvolved -and -not $DryRun) {
    if (-not $DestRoot -and -not (Test-Path -LiteralPath $GateFile)) {
        Write-Log "media: NOT started - the owner has not confirmed that the media folder is protected (the gate file $GateFile does not exist)"
        exit 3
    }
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    try { Assert-FolderPrivate $dest } catch { Write-Log "media: NOT started - $_"; exit 3 }
}

if (-not (Enter-Lock 'media')) { Write-Log 'media: another copy is running - skipped'; exit 0 }
$exitCode = 0
try {
    Enter-KeepAwake
    $date = Get-Date -Format 'yyyy-MM-dd'
    $logFile = Join-Path $StateDir "rclone-media-$date.log"
    $deadline = $null
    if ($MaxMinutes -gt 0) { $deadline = (Get-Date).AddMinutes($MaxMinutes) }
    $status = Get-Status 'media'
    $st = @{}
    if ($status -and $status.stages) { $status.stages.PSObject.Properties | ForEach-Object { $st[$_.Name] = $_.Value } }

    foreach ($s in $stages) {
        $minutes = 0
        if ($deadline) {
            $minutes = [int][math]::Floor(($deadline - (Get-Date)).TotalMinutes)
            if ($minutes -le 0) { Write-Log "media: the time window is over before '$s' - it continues in the next run"; $st[$s] = @{ time = (Get-Date).ToString('s'); exit = 10; note = 'not started: window over' }; if ($exitCode -eq 0) { $exitCode = 10 }; continue }
        }
        $local = Join-Path $dest $s
        $backupDir = Join-Path (Join-Path (Join-Path $dest '_deleted') $date) $s
        if (-not $DryRun) { New-Item -ItemType Directory -Force -Path $local | Out-Null }
        $syncArgs = New-SyncArgs "BK:/$s" $local $backupDir $logFile $BwLimit $minutes $DryRun.IsPresent
        $argString = ($syncArgs | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '
        Write-Log "media: stage '$s' starts$(if ($DryRun) { ' (dry run)' })$(if ($minutes) { ", at most $minutes min" }), bandwidth $BwLimit/s"
        $t0 = Get-Date
        $p = Start-Process -FilePath (Find-Rclone) -ArgumentList $argString -PassThru -NoNewWindow
        $null = $p.Handle
        try { $p.PriorityClass = [Diagnostics.ProcessPriorityClass]::BelowNormal } catch { }
        $p.WaitForExit()
        $code = $p.ExitCode
        $mins = [math]::Round(((Get-Date) - $t0).TotalMinutes, 1)
        Write-Log "media: stage '$s' finished with exit code $code after $mins min"
        $st[$s] = @{ time = (Get-Date).ToString('s'); exit = $code; minutes = $mins; dryRun = $DryRun.IsPresent }
        if ($code -ne 0 -and $exitCode -eq 0) { $exitCode = $(if ($code -eq 10) { 10 } else { 1 }) }
        elseif ($code -ne 0 -and $code -ne 10) { $exitCode = 1 }
    }
    if (-not $DryRun) { Set-Status 'media' @{ time = (Get-Date).ToString('s'); exit = $exitCode; stages = $st } }

    # old _deleted folders go after 30 days, only after a run that ended well
    if ($exitCode -eq 0 -and -not $DryRun -and (Test-Path -LiteralPath (Join-Path $dest '_deleted'))) {
        Get-ChildItem -LiteralPath (Join-Path $dest '_deleted') -Directory | Where-Object {
            $_.Name -match '^\d{4}-\d{2}-\d{2}$' -and [datetime]::ParseExact($_.Name, 'yyyy-MM-dd', $null) -lt (Get-Date).Date.AddDays(-$KeepDeletedDays)
        } | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force; Write-Log "media: removed old _deleted folder $($_.Name)" }
    }
} finally {
    Exit-KeepAwake
    Exit-Lock 'media'
}
exit $exitCode
