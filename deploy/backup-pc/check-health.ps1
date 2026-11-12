# A balloon notification when the daily backup has not succeeded for more than 3 days (or never ran). Silent when everything is fine.
. (Join-Path $PSScriptRoot 'common.ps1')
$s = Get-Status 'daily'
$msg = $null
if (-not $s) { $msg = 'The site backup has not run yet.' }
else {
    $age = (Get-Date) - [datetime]$s.time
    if (-not $s.ok -and $age.TotalDays -lt 3) { $msg = 'The last site backup finished with an error. See D:\shkifut-private\backup-state\backup.log' }
    elseif ($age.TotalDays -ge 3) { $msg = ('The site backup has not run for {0:N0} days. Turn the computer on at 06:30 or run daily.ps1.' -f $age.TotalDays) }
}
if ($msg) {
    Write-Log "health: $msg"
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $n = New-Object System.Windows.Forms.NotifyIcon
    $n.Icon = [System.Drawing.SystemIcons]::Warning
    $n.Visible = $true
    $n.ShowBalloonTip(15000, 'Site backup', $msg, [System.Windows.Forms.ToolTipIcon]::Warning)
    Start-Sleep -Seconds 16
    $n.Dispose()
}
exit 0
