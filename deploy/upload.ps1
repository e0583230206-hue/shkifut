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
    [int]$Port = 8090,
    # Also send the original research models (YOLOv8 AGPL / InsightFace non-commercial) as a fallback.
    [switch]$IncludeResearchModels,
    # Also send tests/media/*.mp4 (not in git) to run the full leak check on the server.
    [switch]$WithTestMedia
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path $PSScriptRoot -Parent)

if (git status --porcelain --untracked-files=no) {
    Write-Warning 'There are uncommitted changes; only the last commit is uploaded.'
}
$code = Join-Path $env:TEMP 'thechannel-code.tgz'
$models = Join-Path $env:TEMP 'thechannel-models.tgz'
git archive --format=tar.gz -o $code HEAD
# Commercial-friendly models only, unless asked otherwise (the server downloads any that are missing).
$names = @('person_yolox.onnx', 'face_yunet.onnx', 'gender_omz.xml', 'gender_omz.bin', 'par.xml', 'par.bin')
if ($IncludeResearchModels) { $names += @('person.onnx', 'face_det.onnx', 'genderage.onnx') }
$modelFiles = $names | Where-Object { Test-Path "moderation_models/$_" } | ForEach-Object { "moderation_models/$_" }
if ($modelFiles) { tar -czf $models @modelFiles } else { Remove-Item $models -ErrorAction SilentlyContinue }

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
if ($WithTestMedia -and (Test-Path tests/media)) {
    ssh $Server "sudo mkdir -p $AppDir/tests/media && sudo chmod 777 $AppDir/tests/media"
    scp (Get-ChildItem tests/media -Filter *.mp4 | ForEach-Object FullName) "${Server}:$AppDir/tests/media/"
    Write-Host "test videos uploaded. Leak check on the server:"
    Write-Host "  cd $AppDir && sudo IMAGE=thechannel-moderation LEVEL=strict bash moderation/tests/run_leak_check.sh protest.mp4"
}
