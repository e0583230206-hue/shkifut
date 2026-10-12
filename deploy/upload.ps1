# Upload and install / update TheChannel on the server - one command from this computer:
#   .\deploy\upload.ps1
#   .\deploy\upload.ps1 -Domain demo.30206.co.il -AllowedEmails dev@example.com -ModerationCpus 1 -ModerationMem 600m
#
# Builds the Docker images HERE (the server only runs them), sends them with the committed code (no .env, no
# local data, no NetFree certificates) and the moderation models, then runs deploy/install.sh --prebuilt.
# Needs SSH access to the server (OpenSSH client is built into Windows): see docs/DEPLOY.md, "SSH key".
param(
    [string]$Server = 'root@45.93.95.182',
    [string]$Domain = 'demo.30206.co.il',
    [string]$Email = 'e0583230206@gmail.com',
    [string]$AppDir = '/opt/thechannel',
    [int]$Port = 8090,
    [string]$KeyFile = (Join-Path $env:USERPROFILE '.ssh\thechannel_deploy'),
    # Closed site: only these accounts (plus ADMIN_USERS) may log in. Comma separated. Empty = public site.
    [string]$AllowedEmails = '',
    # Closed site even when the list above is empty (then only ADMIN_USERS get in). Pass -Private:$false for a public site.
    [bool]$Private = $true,
    # Moderation service limits (only used when .env is created; edit .env on the server afterwards).
    [string]$ModerationCpus = '3',
    [string]$ModerationMem = '1500m',
    [string]$ModerationThreads = '3',
    # Also send the original research models (YOLOv8 AGPL / InsightFace non-commercial) as a fallback.
    [switch]$IncludeResearchModels,
    # Also send tests/media/*.mp4 (not in git) to run the full leak check on the server.
    [switch]$WithTestMedia,
    # Skip building the images (reuse the ones already built here).
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path $PSScriptRoot -Parent)
$sshOpts = @()
if (Test-Path $KeyFile) { $sshOpts = @('-i', $KeyFile, '-o', 'IdentitiesOnly=yes') }

if (git status --porcelain --untracked-files=no) {
    Write-Warning 'There are uncommitted changes; only the last commit is uploaded.'
}
if (-not $SkipBuild) {
    Write-Host 'building images (this computer) ...'
    docker compose -f docker-compose.prod.yml build
    if ($LASTEXITCODE -ne 0) { throw 'docker build failed' }
}
$tmp = $env:TEMP
$code = Join-Path $tmp 'thechannel-code.tgz'
$models = Join-Path $tmp 'thechannel-models.tgz'
$imagesTar = Join-Path $tmp 'thechannel-images.tar'
$images = Join-Path $tmp 'thechannel-images.tgz'
git archive --format=tar.gz -o $code HEAD
docker save -o $imagesTar thechannel-backend:latest thechannel-moderation:latest
if ($LASTEXITCODE -ne 0) { throw 'docker save failed' }
tar -czf $images -C $tmp 'thechannel-images.tar'
Remove-Item $imagesTar -ErrorAction SilentlyContinue
# Commercial-friendly models only, unless asked otherwise (the server downloads any that are missing).
$names = @('person_yolox.onnx', 'face_yunet.onnx', 'gender_omz.xml', 'gender_omz.bin', 'par.xml', 'par.bin')
if ($IncludeResearchModels) { $names += @('person.onnx', 'face_det.onnx', 'genderage.onnx') }
$modelFiles = $names | Where-Object { Test-Path "moderation_models/$_" } | ForEach-Object { "moderation_models/$_" }
if ($modelFiles) { tar -czf $models @modelFiles } else { Remove-Item $models -ErrorAction SilentlyContinue }

$files = @($code, $images) + @(if (Test-Path $models) { $models })
Write-Host ("uploading {0:N0} MB to $Server ..." -f (($files | Get-Item | Measure-Object Length -Sum).Sum / 1MB))
scp @sshOpts @files "${Server}:/tmp/"
if ($LASTEXITCODE -ne 0) { throw 'scp failed' }

$privateValue = if ($Private) { 'true' } else { 'false' }
$envVars = "PRIVATE_SITE='$privateValue' ALLOWED_EMAILS='$AllowedEmails' MODERATION_CPUS='$ModerationCpus' MODERATION_MEM='$ModerationMem' MODERATION_THREADS='$ModerationThreads'"
$remote = @"
set -e
sudo mkdir -p $AppDir
sudo tar xzf /tmp/thechannel-code.tgz -C $AppDir
[ -f /tmp/thechannel-models.tgz ] && sudo tar xzf /tmp/thechannel-models.tgz -C $AppDir || true
echo 'loading images ...'
sudo docker load -i /tmp/thechannel-images.tgz
rm -f /tmp/thechannel-code.tgz /tmp/thechannel-models.tgz /tmp/thechannel-images.tgz
cd $AppDir && sudo chmod +x deploy/*.sh
sudo env $envVars ./deploy/install.sh $Domain $Email --port $Port --prebuilt
"@
ssh @sshOpts $Server ($remote -replace "`r", '')
if ($LASTEXITCODE -ne 0) { throw 'remote install failed' }
if ($WithTestMedia -and (Test-Path tests/media)) {
    ssh @sshOpts $Server "sudo mkdir -p $AppDir/tests/media && sudo chmod 777 $AppDir/tests/media"
    scp @sshOpts (Get-ChildItem tests/media -Filter *.mp4 | ForEach-Object FullName) "${Server}:$AppDir/tests/media/"
    Write-Host 'test videos uploaded. Leak check on the server:'
    Write-Host "  cd $AppDir && sudo IMAGE=thechannel-moderation LEVEL=strict LEAK_CPUS=1 LEAK_MEM=600m bash moderation/tests/run_leak_check.sh protest.mp4"
}
