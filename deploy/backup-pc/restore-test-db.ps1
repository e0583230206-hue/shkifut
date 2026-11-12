# Proves that a database dump can be restored: opens the newest dump (or -Dump <file>) in a CLEAN kvrocks container on this computer
# (Docker Desktop) and prints how many messages it holds. Touches nothing on the server. The temporary copy (it contains the site's
# settings) is deleted at the end.  Compare the number with the live site:  ZCARD m_times:1  (a few more on the live site is normal).
param([string]$Dump)
. (Join-Path $PSScriptRoot 'common.ps1')

if (-not $Dump) { $Dump = (Get-ChildItem -LiteralPath $DbDir -Filter 'db-*.tgz' | Sort-Object Name -Descending | Select-Object -First 1).FullName }
if (-not $Dump -or -not (Test-Path -LiteralPath $Dump)) { throw 'no database dump found' }
$work = Join-Path $StateDir 'restore-test'
$name = 'tc-restore-test'
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $work 'extract'), (Join-Path $work 'data'), (Join-Path $work 'sock') | Out-Null
& docker rm -f $name *> $null
try {
    Write-Log "restore test: $(Split-Path $Dump -Leaf)"
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    & $tar -xzf $Dump -C (Join-Path $work 'extract')
    if ($LASTEXITCODE -ne 0) { throw 'the dump does not extract' }
    Move-Item (Join-Path $work 'extract\backup') (Join-Path $work 'data\db')     # a kvrocks checkpoint becomes the database directory
    Copy-Item (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'kvrocks.conf') (Join-Path $work 'kvrocks.conf')
    & docker run -d --name $name --user root -v "$($work)\data:/var/lib/kvrocks" -v "$($work)\sock:/data" -v "$($work)\kvrocks.conf:/kvrocks.conf:ro" apache/kvrocks:2.17.0 -c /kvrocks.conf | Out-Null
    $pong = ''
    for ($i = 0; $i -lt 30 -and $pong -notmatch 'PONG'; $i++) { Start-Sleep -Seconds 1; $pong = (& docker exec $name redis-cli -s /data/kvrocks.sock ping 2>$null) }
    if ($pong -notmatch 'PONG') { throw 'the restored database did not start' }
    $count = (& docker exec $name redis-cli -s /data/kvrocks.sock ZCARD m_times:1).Trim()
    $nextId = (& docker exec $name redis-cli -s /data/kvrocks.sock GET message:next_id).Trim()
    Write-Log "restore test: OK - $count messages in the restored database (next message id $nextId)"
    Write-Host "RESTORED MESSAGES: $count"
    exit 0
} catch {
    Write-Log "restore test: FAILED - $_"
    exit 1
} finally {
    & docker rm -f $name *> $null
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
