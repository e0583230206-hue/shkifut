# Pulls EVERY database dump (db-*.tgz) that is on the server and not yet here (so a few days with the computer off lose no copy),
# checks each one (size equal to the server's, and the archive opens), and keeps the newest 14.
# The settings (.env) are NOT here: the read-only account cannot read them (pull-config-weekly.ps1 does it, with a different key, once a week).
. (Join-Path $PSScriptRoot 'common.ps1')
Set-RcloneEnv
New-Item -ItemType Directory -Force -Path $DbDir | Out-Null

$list = Invoke-Rclone @('lsf', 'BK:/db', '--include', 'db-*.tgz', '--format', 'sp', '--separator', '|')
if ($list.Code -ne 0) { Write-Log "db: cannot list the server's dumps: $($list.Err)"; exit 1 }

$new = 0
foreach ($line in $list.Lines) {
    $size, $name = $line -split '\|', 2
    if ($name -notmatch '^db-\d{4}-\d{2}-\d{2}_\d{4}\.tgz$') { continue }
    $target = Join-Path $DbDir $name
    if (Test-Path -LiteralPath $target) { continue }
    $part = "$target.part"
    Remove-Item -LiteralPath $part -ErrorAction SilentlyContinue
    $r = Invoke-Rclone @('copyto', "BK:/db/$name", $part)
    if ($r.Code -ne 0) { Write-Log "db: download of $name failed: $($r.Err)"; Remove-Item -LiteralPath $part -ErrorAction SilentlyContinue; exit 1 }
    if ((Get-Item -LiteralPath $part).Length -ne [int64]$size) { Write-Log "db: $name has a different size than on the server"; Remove-Item -LiteralPath $part; exit 1 }
    if (-not (Test-TarFile $part)) { Write-Log "db: $name does not open as an archive"; Remove-Item -LiteralPath $part; exit 1 }
    Move-Item -LiteralPath $part -Destination $target
    $new++
    Write-Log ('db: copied {0} ({1} MB)' -f $name, [math]::Round([int64]$size / 1MB, 2))
}

# keep the newest $KeepDb (the names carry the date and time), and drop old leftovers of interrupted downloads
Get-ChildItem -LiteralPath $DbDir -Filter 'db-*.tgz' | Sort-Object Name -Descending | Select-Object -Skip $KeepDb | ForEach-Object { Remove-Item -LiteralPath $_.FullName; Write-Log "db: removed (beyond $KeepDb copies): $($_.Name)" }
Get-ChildItem -LiteralPath $DbDir -Filter '*.part' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-1) } | Remove-Item

$have = @(Get-ChildItem -LiteralPath $DbDir -Filter 'db-*.tgz' | Sort-Object Name -Descending)
Set-Status 'db' @{ time = (Get-Date).ToString('s'); newest = $(if ($have.Count) { $have[0].Name } else { '' }); copies = $have.Count; newThisRun = $new }
Write-Log "db: ok, $($have.Count) copies here, $new new"
exit 0
