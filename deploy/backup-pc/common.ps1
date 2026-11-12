# Shared settings and helpers of the PC side of the backup (dot-sourced by the other scripts in this folder).
# Windows PowerShell 5.1 compatible (that is what Task Scheduler runs). The backup is PULLED by this computer from the live server with a
# read-only, chrooted account (shkifut-backup, see docs/BACKUP.md): nothing here can change anything on the server.

$ErrorActionPreference = 'Stop'

$Root       = 'D:\shkifut-private'
$MediaDir   = Join-Path $Root 'media-backup'      # channel_data, blurred, training, logs, _deleted\<date>\...   (UNBLURRED originals: keep it private and encrypted)
$DbDir      = Join-Path $Root 'server-backups'    # the daily database dumps, 14 copies
$SecretsDir = Join-Path $Root 'secrets-weekly'    # the weekly copy of the settings (.env files): the secrets
$StateDir   = Join-Path $Root 'backup-state'      # logs, status files, reports, locks
$GateFile   = Join-Path $Root '.media-protection-confirmed'   # created BY THE OWNER once the media folder is encrypted/private: nothing media is copied before
$Server     = '83.229.70.68'
$PullUser   = 'shkifut-backup'
$PullKey    = Join-Path $env:USERPROFILE '.ssh\thechannel_backup'   # read-only account (chroot + internal-sftp -R)
$AdminKey   = Join-Path $env:USERPROFILE '.ssh\thechannel_deploy'   # root: used ONLY for the weekly copy of the settings
$KnownHosts = Join-Path $env:USERPROFILE '.ssh\known_hosts'
$KeepDb     = 14
$KeepConfig = 4
$KeepDeletedDays = 30
$MediaStages = @('channel_data', 'training', 'blurred')   # these hold media (training = crops of people): they need the gate; 'logs' does not

function Write-Log([string]$msg) {
    $line = '{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $msg
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    Add-Content -Path (Join-Path $StateDir 'backup.log') -Value $line -Encoding UTF8
    Write-Host $line
}

function Set-Status([string]$name, $obj) {
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    $obj | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $StateDir "last-$name.json") -Encoding UTF8
}
function Get-Status([string]$name) {
    $f = Join-Path $StateDir "last-$name.json"
    if (Test-Path $f) { try { return (Get-Content $f -Raw | ConvertFrom-Json) } catch { return $null } }
    return $null
}

function Find-Rclone {
    $c = Get-Command rclone.exe -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    $p = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages') -Recurse -Filter rclone.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($p) { return $p.FullName }
    throw 'rclone.exe not found (winget install --source winget Rclone.Rclone)'
}

# The connection "BK:" is defined by environment variables (no secret in any file; the key is the file named in $PullKey).
function Set-RcloneEnv {
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    $conf = Join-Path $StateDir 'rclone.conf'
    if (-not (Test-Path $conf)) { Set-Content -Path $conf -Value '' }
    $env:RCLONE_CONFIG = $conf
    $env:RCLONE_CONFIG_BK_TYPE = 'sftp'
    $env:RCLONE_CONFIG_BK_HOST = $Server
    $env:RCLONE_CONFIG_BK_USER = $PullUser
    $env:RCLONE_CONFIG_BK_KEY_FILE = $PullKey
    $env:RCLONE_CONFIG_BK_KNOWN_HOSTS_FILE = $KnownHosts
    $env:RCLONE_CONFIG_BK_CONNECTIONS = '3'
}

# Runs rclone and returns the exit code, the stdout lines and the stderr text (kept apart, so a list is never mixed with a notice).
function Invoke-Rclone([string[]]$ArgList) {
    $rc = Find-Rclone
    $errFile = [IO.Path]::GetTempFileName()
    try {
        $out = & $rc @ArgList 2>$errFile
        $code = $LASTEXITCODE
        $err = (Get-Content $errFile -Raw -ErrorAction SilentlyContinue)
        if ($null -eq $err) { $err = '' }
        return [pscustomobject]@{ Code = $code; Lines = @($out | Where-Object { $_ }); Err = $err.Trim() }
    } finally { Remove-Item $errFile -ErrorAction SilentlyContinue }
}

# Refuses a folder that is inside OneDrive (or any other cloud-synced / reparse-point folder).
function Assert-NotCloudFolder([string]$path) {
    $full = [IO.Path]::GetFullPath($path).TrimEnd('\')
    foreach ($r in @($env:OneDrive, $env:OneDriveConsumer, $env:OneDriveCommercial)) {
        if (-not $r) { continue }
        $rr = $r.TrimEnd('\')
        if ($full -eq $rr -or $full.StartsWith($rr + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "refusing: $full is inside OneDrive ($rr)" }
    }
    $p = $full
    while ($p) {
        if (Test-Path -LiteralPath $p) {
            $i = Get-Item -LiteralPath $p -Force
            if (($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "refusing: $p is a reparse point (maybe a synced folder)" }
        }
        $parent = Split-Path $p -Parent
        if (-not $parent -or $parent -eq $p) { break }
        $p = $parent
    }
}

# A folder is "private" when no group of other local accounts (Users / Authenticated Users / Everyone) can read it.
function Assert-FolderPrivate([string]$path) {
    $bad = @((Get-Acl -LiteralPath $path).Access | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -match '(^|\\)(Users|Authenticated Users|Everyone)$' })
    if ($bad.Count -gt 0) { throw "refusing: $path can be read by other local accounts ($($bad[0].IdentityReference.Value)); run register-tasks.ps1 to make it private" }
}
function Set-FolderPrivate([string]$path) {
    New-Item -ItemType Directory -Force -Path $path | Out-Null
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls $path /inheritance:r /grant:r "${me}:(OI)(CI)F" 'NT AUTHORITY\SYSTEM:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls failed on $path" }
}

# Keeps the computer awake while a copy runs; the state is dropped by itself when the script ends (the normal sleep policy comes back).
Add-Type -Namespace Win32 -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);' -ErrorAction SilentlyContinue
function Enter-KeepAwake { [void][Win32.Power]::SetThreadExecutionState([uint32]2147483649) }   # ES_CONTINUOUS | ES_SYSTEM_REQUIRED
function Exit-KeepAwake  { [void][Win32.Power]::SetThreadExecutionState([uint32]2147483648) }   # ES_CONTINUOUS only: back to normal

function Enter-Lock([string]$name) {
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    $f = Join-Path $StateDir "$name.lock"
    if (Test-Path $f) {
        $old = (Get-Content $f -ErrorAction SilentlyContinue | Select-Object -First 1) -as [int]
        if ($old -and (Get-Process -Id $old -ErrorAction SilentlyContinue)) { return $false }
    }
    Set-Content -Path $f -Value $PID
    return $true
}
function Exit-Lock([string]$name) { Remove-Item (Join-Path $StateDir "$name.lock") -ErrorAction SilentlyContinue }

function Test-TarFile([string]$file) {
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    & $tar -tzf $file *> $null
    return ($LASTEXITCODE -eq 0)
}
