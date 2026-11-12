# Prepares the backup folders and registers the scheduled tasks for the CURRENT user (no administrator needed; the tasks run while this
# user is signed in, the screen may be locked). Run again to change the times; it replaces the tasks.
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy\backup-pc\register-tasks.ps1 [-FirstCopyAt '2026-11-12 03:00']
#
# 1. the folders are made private: only this account (and SYSTEM) can read them. D:\shkifut-private is otherwise open to every local account.
# 2. "TheChannel backup - daily"       06:30 every day; if the computer was off it runs at the next start.
# 3. "TheChannel backup - first copy"  once, at the given time (quiet hours of the server). Wakes the computer, keeps it awake while it runs.
#                                      It does nothing until the owner creates the gate file (see common.ps1).
# 4. "TheChannel backup - health"      at sign-in and at noon: a notification if the daily backup has not succeeded for 3 days.
param([datetime]$FirstCopyAt = '2026-11-12 03:00')
. (Join-Path $PSScriptRoot 'common.ps1')

foreach ($d in $MediaDir, $SecretsDir, $DbDir, $StateDir) { Set-FolderPrivate $d; Write-Host "private: $d" }

$me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$ps = (Get-Command powershell.exe).Source
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited

function Register-BackupTask([string]$name, [string]$script, $triggers, [bool]$wake, [int]$hours) {
    $argText = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f (Join-Path $PSScriptRoot $script)
    $action = New-ScheduledTaskAction -Execute $ps -Argument $argText -WorkingDirectory $PSScriptRoot
    $set = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours $hours)
    if ($wake) { $set.WakeToRun = $true }
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $triggers -Settings $set -Principal $principal -Force | Out-Null
    Write-Host "registered: $name"
}

Register-BackupTask 'TheChannel backup - daily' 'daily.ps1' (New-ScheduledTaskTrigger -Daily -At '06:30') $false 3
Register-BackupTask 'TheChannel backup - first copy' 'first-copy.ps1' (New-ScheduledTaskTrigger -Once -At $FirstCopyAt) $true 5
try {
    Register-BackupTask 'TheChannel backup - health' 'check-health.ps1' @((New-ScheduledTaskTrigger -AtLogOn -User $me), (New-ScheduledTaskTrigger -Daily -At '12:00')) $false 1
} catch {
    Write-Host "sign-in trigger not allowed here ($($_.Exception.Message)); using the noon trigger only"
    Register-BackupTask 'TheChannel backup - health' 'check-health.ps1' (New-ScheduledTaskTrigger -Daily -At '12:00') $false 1
}
Get-ScheduledTask | Where-Object { $_.TaskName -like 'TheChannel backup*' } | ForEach-Object {
    $i = Get-ScheduledTaskInfo $_
    '{0,-34} state={1,-8} next={2}' -f $_.TaskName, $_.State, $i.NextRunTime
}
