# View the REAL demo (the site on the server) from this computer at http://localhost:8080, through an SSH tunnel.
# Needed while NetFree blocks demo.30206.co.il. Nothing is published and no public port is opened: the tunnel listens only
# on 127.0.0.1 of this computer and reaches the site's loopback-only port on the server.
#
#   .\deploy\tunnel.ps1               # start (keep the window open; Ctrl+C or closing it closes the tunnel)
#   .\deploy\tunnel.ps1 -Background   # start hidden
#   .\deploy\tunnel.ps1 -Stop         # close a background tunnel
#
# Google login works only on a port registered in the Google console (http://localhost:8080/login). If 8080 is taken
# (e.g. by the local copy: docker compose -f docker-compose.local.yml down), the script uses -FallbackPort 8081; the site
# opens there, but "sign in with Google" needs http://localhost:8081/login added to the OAuth client's redirect URIs.
param(
    [string]$Server = '45.93.95.182',
    [string]$User = 'root',
    [int]$RemotePort = 8090,
    [int]$Port = 8080,
    [int]$FallbackPort = 8081,
    [string]$KeyFile = (Join-Path $env:USERPROFILE '.ssh\thechannel_deploy'),
    [switch]$Background,
    [switch]$Stop
)
$ErrorActionPreference = 'Stop'
$pidFile = Join-Path $env:TEMP 'thechannel-tunnel.pid'

if ($Stop) {
    if (Test-Path $pidFile) {
        $id = [int](Get-Content $pidFile)
        $p = Get-Process -Id $id -ErrorAction SilentlyContinue
        if ($p -and $p.ProcessName -in @('ssh', 'powershell', 'pwsh')) {
            # background mode runs a small loop that reconnects when the connection drops: stop the loop first, then its ssh
            Stop-Process -Id $id -Force
            Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" | Where-Object { $_.CommandLine -match '-L 127\.0\.0\.1:\d+:127\.0\.0\.1:\d+' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
            Write-Host "tunnel closed (pid $id)"
        } else { Write-Host 'no running tunnel found' }
        Remove-Item $pidFile -Force
    } else { Write-Host 'no background tunnel recorded' }
    return
}

function Test-PortFree([int]$p) {
    try {
        $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $p)
        $l.Start(); $l.Stop(); return $true
    } catch { return $false }
}

if (-not (Test-Path $KeyFile)) { throw "SSH key not found: $KeyFile" }
if (Test-Path $pidFile) {
    $old = Get-Process -Id ([int](Get-Content $pidFile)) -ErrorAction SilentlyContinue
    if ($old -and $old.ProcessName -in @('ssh', 'powershell', 'pwsh')) { throw "A background tunnel is already running (pid $($old.Id)). Close it with: .\deploy\tunnel.ps1 -Stop" }
}
$use = $Port
if (-not (Test-PortFree $use)) {
    if (-not (Test-PortFree $FallbackPort)) { throw "Ports $Port and $FallbackPort are both busy." }
    $use = $FallbackPort
    Write-Warning "Port $Port is busy, using $use. Google login will not work on this port unless http://localhost:$use/login is registered as a redirect URI."
}

$sshArgs = @('-N', '-L', "127.0.0.1:${use}:127.0.0.1:${RemotePort}", '-i', $KeyFile, '-o', 'IdentitiesOnly=yes',
    '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', "$User@$Server")
Write-Host "Site from the server: http://localhost:$use   (opens only on this computer)"
if ($Background) {
    # ssh -N exits when the connection is lost (network blip, Wi-Fi sleep, a filter resetting it): a hidden loop starts it again.
    $loopFile = Join-Path $env:TEMP 'thechannel-tunnel-loop.ps1'
    $quoted = ($sshArgs | ForEach-Object { "'" + ($_ -replace "'", "''") + "'" }) -join ', '
    Set-Content -Path $loopFile -Encoding UTF8 -Value ('$a = @(' + $quoted + ")`nwhile (`$true) { & ssh @a; Start-Sleep -Seconds 5 }")
    $ps = (Get-Command pwsh -ErrorAction SilentlyContinue) ?? (Get-Command powershell)
    $p = Start-Process -FilePath $ps.Source -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $loopFile) -WindowStyle Hidden -PassThru
    Start-Sleep -Seconds 4
    if ($p.HasExited) { throw 'The tunnel loop did not start.' }
    Set-Content -Path $pidFile -Value $p.Id
    Write-Host "Running in the background (pid $($p.Id)); it reconnects by itself when the connection drops. Close it with: .\deploy\tunnel.ps1 -Stop"
} else {
    Write-Host 'Tunnel is open. Press Ctrl+C to close it.'
    & ssh @sshArgs
}
