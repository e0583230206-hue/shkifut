# Upload and install / update TheChannel on the server - one command from this computer:
#   .\deploy\upload.ps1
#   .\deploy\upload.ps1 -Server root@45.93.95.182 -Domain 30206.co.il -Email e0583230206@gmail.com
#
# Sends only what is committed in git (no .env, no local data, no NetFree certificates) plus the
# moderation models built on this computer, then runs deploy/install.sh on the server.
# Needs SSH access to the server (OpenSSH client is built into Windows: ssh / scp).
param(
    [string]$Server = 'root@45.93.95.182',
    [string]$Domain = '30206.co.il',
    [string]$Email = 'e0583230206@gmail.com',
    [string]$AppDir = '/opt/thechannel',
    [int]$Port = 8090
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path $PSScriptRoot -Parent)

if (git status --porcelain --untracked-files=no) {
    Write-Warning 'There are uncommitted changes; only the last commit is uploaded.'
}
$code = Join-Path $env:TEMP 'thechannel-code.tgz'
$models = Join-Path $env:TEMP 'thechannel-models.tgz'
git archive --format=tar.gz -o $code HEAD
$modelFiles = Get-ChildItem moderation_models -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in '.onnx', '.xml', '.bin' }
if ($modelFiles) { tar -czf $models moderation_models } else { Remove-Item $models -ErrorAction SilentlyContinue }

Write-Host "uploading to $Server ..."
$files = @($code) + @(if (Test-Path $models) { $models })
scp @files "${Server}:/tmp/"
$remote = @"
set -e
sudo mkdir -p $AppDir
sudo tar xzf /tmp/thechannel-code.tgz -C $AppDir
[ -f /tmp/thechannel-models.tgz ] && sudo tar xzf /tmp/thechannel-models.tgz -C $AppDir || true
rm -f /tmp/thechannel-code.tgz /tmp/thechannel-models.tgz
cd $AppDir && sudo chmod +x deploy/*.sh
sudo ./deploy/install.sh $Domain $Email --port $Port
"@
ssh $Server ($remote -replace "`r", '')
