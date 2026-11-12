# The FIRST full copy of the media, meant for the quiet hours of the server (01:00-07:00 Israel time), in stages: channel_data first (the
# irreplaceable one), then training and logs (small), then blurred. Low priority, bandwidth capped, stops at 06:20 (the daily run is at 06:30)
# and continues from where it stopped the next time it is started. When every stage finished it runs the full verification (counts,
# sizes, SHA-256 of every original) and writes the report: backup-state\report-<date>.txt
#   first-copy.ps1 [-Force]      (-Force: ignore the quiet-hours window)
param([switch]$Force)
. (Join-Path $PSScriptRoot 'common.ps1')

$now = Get-Date
if (-not $Force -and ($now.Hour -lt 1 -or $now.Hour -ge 7)) { Write-Log 'first copy: outside the quiet hours 01:00-07:00 - not started (run with -Force to override)'; exit 4 }
if (-not (Test-Path -LiteralPath $GateFile)) { Write-Log "first copy: NOT started - the owner has not confirmed that the media folder is protected ($GateFile does not exist)"; exit 3 }

$minutes = 0
if (-not $Force) { $minutes = [int][math]::Floor(($now.Date.AddHours(6).AddMinutes(20) - $now).TotalMinutes); if ($minutes -le 0) { Write-Log 'first copy: the window (until 06:20) is over'; exit 4 } }

Write-Log "first copy: start$(if ($minutes) { ", window $minutes min" })"
& (Join-Path $PSScriptRoot 'pull-media.ps1') -Stage channel_data, training, logs, blurred -MaxMinutes $minutes -BwLimit 4M
$code = $LASTEXITCODE
Write-Log "first copy: copy finished with exit code $code"

if ($code -eq 0) {
    Set-Status 'first-copy' @{ time = (Get-Date).ToString('s'); done = $true }
    & (Join-Path $PSScriptRoot 'verify-media.ps1') -Full -Sha
    Write-Log "first copy: verification exit code $LASTEXITCODE (report in $StateDir)"
} else {
    Write-Log 'first copy: NOT complete (cut by the window or an error) - it continues the next time it is started'
}
exit $code
