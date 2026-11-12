# The daily run (Task Scheduler, 06:30 Israel time): the database dumps, the weekly settings copy, then the incremental media pull
# (only after the first full copy finished) and, on Sundays, a quick check of the counts. A missed run is made up at the next start (StartWhenAvailable).
. (Join-Path $PSScriptRoot 'common.ps1')
Write-Log 'daily: start'
$ok = $true

& (Join-Path $PSScriptRoot 'pull-db.ps1');            if ($LASTEXITCODE -ne 0) { $ok = $false; Write-Log "daily: database pull failed (exit $LASTEXITCODE)" }
& (Join-Path $PSScriptRoot 'pull-config-weekly.ps1'); if ($LASTEXITCODE -ne 0) { $ok = $false; Write-Log "daily: settings copy failed (exit $LASTEXITCODE)" }

if (Get-Status 'first-copy') {
    & (Join-Path $PSScriptRoot 'pull-media.ps1') -Stage all -MaxMinutes 120
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 10) { $ok = $false; Write-Log "daily: media pull failed (exit $LASTEXITCODE)" }
    if ((Get-Date).DayOfWeek -eq 'Sunday') { & (Join-Path $PSScriptRoot 'verify-media.ps1'); Write-Log "daily: weekly check exit $LASTEXITCODE" }
} else {
    Write-Log 'daily: media skipped - the first full copy has not been done yet'
}

Set-Status 'daily' @{ time = (Get-Date).ToString('s'); ok = $ok }
Write-Log "daily: end, ok=$ok"
exit $(if ($ok) { 0 } else { 1 })
