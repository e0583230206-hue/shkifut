# Copies the LATEST small backup (the database and the settings; never the media) from the live server to this computer, each run as separate files
# with the date in the name, and deletes the copies here that are older than 14 days. Safe to run again and again: a file that is already here is skipped.
#
# Run by hand (PowerShell):
#   powershell -NoProfile -ExecutionPolicy Bypass -File "D:\Users\user\Desktop\עבודה תיכנות\TheChannel-master\deploy\pull-backup.ps1"
# Once a day (Task Scheduler, no admin needed, runs while you are signed in):
#   schtasks /Create /SC DAILY /ST 04:30 /TN "TheChannel backup pull" /TR "powershell -NoProfile -ExecutionPolicy Bypass -File \"D:\Users\user\Desktop\עבודה תיכנות\TheChannel-master\deploy\pull-backup.ps1\""
# The copies are in D:\shkifut-private\server-backups (the log of every run: pull.log there). They contain the secrets of the site: keep the folder private.
param(
    [string]$Server = 'root@83.229.70.68',
    [string]$Key = (Join-Path $env:USERPROFILE '.ssh\thechannel_deploy'),
    [string]$Dest = 'D:\shkifut-private\server-backups',
    [int]$KeepDays = 14
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$log = Join-Path $Dest 'pull.log'
function Log([string]$m) { ('{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $m) | Tee-Object -FilePath $log -Append }

try {
    $remote = '/var/backups/thechannel'
    foreach ($kind in 'db', 'config') {
        $name = (ssh -i $Key -o BatchMode=yes -o ConnectTimeout=20 $Server "ls -1t $remote/$kind-*.tgz 2>/dev/null | head -1")
        if ($LASTEXITCODE -ne 0) { throw "cannot reach the server ($Server)" }
        $name = "$name".Trim()
        if (-not $name) { Log "no $kind backup on the server yet"; continue }
        $file = Split-Path $name -Leaf
        $target = Join-Path $Dest $file
        if (Test-Path $target) { Log "already here: $file"; continue }
        scp -i $Key -o BatchMode=yes -o ConnectTimeout=20 "${Server}:$name" "$target.part"
        if ($LASTEXITCODE -ne 0) { throw "scp failed for $file" }
        Move-Item -LiteralPath "$target.part" -Destination $target
        Log ('copied {0} ({1} MB)' -f $file, [math]::Round((Get-Item -LiteralPath $target).Length / 1MB, 1))
    }
    Get-ChildItem -LiteralPath $Dest -Filter '*.tgz' |
        Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) } |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName; Log "deleted (older than $KeepDays days): $($_.Name)" }
}
catch {
    Log "ERROR: $_"
    exit 1
}
