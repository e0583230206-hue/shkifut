# Proves that the copy here is whole.
#   1. counts and bytes of every stage here vs on the server;
#   2. (-Full) every remote file exists here with the same size (rclone check, size only: the read-only account has no way to compute hashes);
#   3. (-Sha) SHA-256 of every original in channel_data: the NAME of each original is the SHA-256 of its content, so each file proves
#      itself, independently of the copy tool and of the server.
# Writes backup-state\report-<date>.txt and last-verify.json.
#   verify-media.ps1 [-Full] [-Sha] [-DestRoot <folder>]
param([switch]$Full, [switch]$Sha, [string]$DestRoot)
. (Join-Path $PSScriptRoot 'common.ps1')

# Hash check of one folder: the files whose name is 64 hex characters must hash to that name. Returns counts and the list of bad files.
function Test-ContentHashNames([string]$dir) {
    $bad = New-Object System.Collections.Generic.List[string]
    $checked = 0; $bytes = [int64]0; $other = 0
    $hasher = [Security.Cryptography.SHA256]::Create()
    foreach ($f in (Get-ChildItem -LiteralPath $dir -Recurse -File -Force)) {
        if ($f.Name -notmatch '^[0-9a-f]{64}$') { $other++; continue }
        $fs = [IO.File]::OpenRead($f.FullName)
        try { $h = ([BitConverter]::ToString($hasher.ComputeHash($fs)) -replace '-', '').ToLowerInvariant() } finally { $fs.Dispose() }
        $checked++; $bytes += $f.Length
        if ($h -ne $f.Name) { $bad.Add($f.FullName) }
    }
    return [pscustomobject]@{ Checked = $checked; Bytes = $bytes; Other = $other; Bad = @($bad) }
}

function Get-SizeJson([string]$path) {
    $r = Invoke-Rclone @('size', $path, '--json')
    if ($r.Code -ne 0 -or -not $r.Lines) { return $null }
    try { return ($r.Lines -join '' | ConvertFrom-Json) } catch { return $null }
}

if ($MyInvocation.InvocationName -eq '.') { return }

Set-RcloneEnv
$dest = if ($DestRoot) { $DestRoot } else { $MediaDir }
$report = New-Object System.Collections.Generic.List[string]
function Add-Line([string]$s) { $report.Add($s); Write-Host $s }
$ok = $true
Add-Line ("Backup verification  {0:yyyy-MM-dd HH:mm}" -f (Get-Date))
Add-Line ("Folder: $dest")

$summary = @{}
foreach ($s in 'channel_data', 'blurred', 'training', 'logs') {
    $local = Join-Path $dest $s
    if (-not (Test-Path -LiteralPath $local)) { Add-Line "[$s] not copied yet"; $ok = $false; continue }
    $l = Get-SizeJson $local
    $r = Get-SizeJson "BK:/$s"
    if (-not $l -or -not $r) { Add-Line "[$s] could not read the sizes (server or folder)"; $ok = $false; continue }
    $same = ($l.count -eq $r.count -and $l.bytes -eq $r.bytes)
    Add-Line ("[{0}] here {1} files / {2:N2} GB   server {3} files / {4:N2} GB   {5}" -f $s, $l.count, ($l.bytes / 1GB), $r.count, ($r.bytes / 1GB), $(if ($same) { 'EQUAL' } else { 'DIFFERENT (new files since the copy started are normal)' }))
    $summary[$s] = @{ localFiles = $l.count; localBytes = $l.bytes; serverFiles = $r.count; serverBytes = $r.bytes; equal = $same }
    if (-not $same) { $ok = $false }
}

if ($Full) {
    foreach ($s in 'channel_data', 'blurred') {
        $local = Join-Path $dest $s
        if (-not (Test-Path -LiteralPath $local)) { continue }
        $miss = Join-Path $StateDir "missing-$s.txt"; $diff = Join-Path $StateDir "differ-$s.txt"
        Remove-Item $miss, $diff -ErrorAction SilentlyContinue
        $r = Invoke-Rclone @('check', "BK:/$s", $local, '--size-only', '--one-way', '--missing-on-dst', $miss, '--differ', $diff)
        $nm = if (Test-Path $miss) { @(Get-Content $miss).Count } else { 0 }
        $nd = if (Test-Path $diff) { @(Get-Content $diff).Count } else { 0 }
        Add-Line ("[{0}] every server file exists here with the same size: missing {1}, different size {2}  {3}" -f $s, $nm, $nd, $(if ($nm -eq 0 -and $nd -eq 0) { 'OK' } else { 'NOT OK (the files changed on the server since the copy are normal; see ' + $miss + ')' }))
        if ($nm -gt 0 -or $nd -gt 0) { $ok = $false }
    }
}

if ($Sha) {
    $dir = Join-Path $dest 'channel_data'
    if (Test-Path -LiteralPath $dir) {
        $t0 = Get-Date
        $h = Test-ContentHashNames $dir
        Add-Line ("[channel_data] SHA-256 of {0} originals ({1:N2} GB): {2} do not match their name; {3} other files (metadata) not hashed; {4:N1} min   {5}" -f $h.Checked, ($h.Bytes / 1GB), $h.Bad.Count, $h.Other, ((Get-Date) - $t0).TotalMinutes, $(if ($h.Bad.Count -eq 0 -and $h.Checked -gt 0) { 'ALL GOOD' } else { 'PROBLEM' }))
        foreach ($b in ($h.Bad | Select-Object -First 20)) { Add-Line "    BAD: $b" }
        $summary['sha256'] = @{ checked = $h.Checked; bad = $h.Bad.Count; other = $h.Other }
        if ($h.Bad.Count -gt 0 -or $h.Checked -eq 0) { $ok = $false }
    }
}

$db = Get-Status 'db'
if ($db) { Add-Line ("Database dumps here: {0} copies, newest {1}" -f $db.copies, $db.newest) }
$drv = Get-PSDrive -Name ($Root.Substring(0, 1)) -ErrorAction SilentlyContinue
if ($drv) { Add-Line ("Free space on {0}: {1:N0} GB" -f $Root.Substring(0, 2), ($drv.Free / 1GB)) }
Add-Line ("RESULT: " + $(if ($ok) { 'OK' } else { 'SEE ABOVE' }))

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$report | Set-Content -Path (Join-Path $StateDir ("report-{0:yyyy-MM-dd}.txt" -f (Get-Date))) -Encoding UTF8
Set-Status 'verify' @{ time = (Get-Date).ToString('s'); ok = $ok; full = $Full.IsPresent; sha = $Sha.IsPresent; stages = $summary }
exit $(if ($ok) { 0 } else { 1 })
