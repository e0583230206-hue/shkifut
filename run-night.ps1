# Night loop: runs Claude Code non-interactively, again and again, until ALL_DONE.txt exists.
#
# Run it yourself (it is NOT started automatically):
#   pwsh -ExecutionPolicy Bypass -File .\run-night.ps1
# Stop it at any time: create STOP_NIGHT.txt in this folder (or close the window).
#
# Requires the Claude Code CLI on PATH ("claude"). Install: npm install -g @anthropic-ai/claude-code
# Permission mode is "auto" (a classifier approves/denies each action). The script refuses to fall back
# to "bypassPermissions" if "auto" is not available.

$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath $PSScriptRoot
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8

$log        = Join-Path $PSScriptRoot 'night-log.txt'
$doneFile   = Join-Path $PSScriptRoot 'ALL_DONE.txt'
$stopFile   = Join-Path $PSScriptRoot 'STOP_NIGHT.txt'
$prompt     = 'המשך לעבוד לפי NIGHT_PLAN.md. בדוק ב-PROGRESS.md איפה עצרת.'
$waitMin    = 10
$startDelay = 3   # minutes: let any interactive session in this folder finish first

function Write-Log($text) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text
    Write-Host $line
    Add-Content -LiteralPath $log -Value $line -Encoding utf8
}

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Log 'claude CLI not found on PATH. Install it first: npm install -g @anthropic-ai/claude-code'
    exit 1
}
$help = (claude --help 2>&1 | Out-String)
if ($help -notmatch '--permission-mode' -or $help -notmatch '\bauto\b') {
    Write-Log 'This claude version does not offer --permission-mode auto. Not starting (will not bypass permissions).'
    exit 1
}

Write-Log "night loop starting in $startDelay minutes (claude $(claude --version))"
Start-Sleep -Seconds ($startDelay * 60)

$round = 0
while (-not (Test-Path $doneFile) -and -not (Test-Path $stopFile)) {
    $round++
    Write-Log "round ${round}: claude -p --continue"
    $out = & claude -p $prompt --continue --permission-mode auto 2>&1 | ForEach-Object { "$_" }
    $code = $LASTEXITCODE
    $out | Add-Content -LiteralPath $log -Encoding utf8

    # No previous conversation in this folder: start a fresh one (the plan + PROGRESS.md carry the state).
    if (($out -join "`n") -match 'No conversation found') {
        Write-Log 'no conversation to continue - starting a fresh session'
        $out = & claude -p $prompt --permission-mode auto 2>&1 | ForEach-Object { "$_" }
        $code = $LASTEXITCODE
        $out | Add-Content -LiteralPath $log -Encoding utf8
    }
    Write-Log "round $round ended (exit code $code)"

    if ((Test-Path $doneFile) -or (Test-Path $stopFile)) { break }
    Write-Log "waiting $waitMin minutes before the next round"
    Start-Sleep -Seconds ($waitMin * 60)
}
Write-Log $(if (Test-Path $doneFile) { 'ALL_DONE.txt found - night loop finished' } else { 'STOP_NIGHT.txt found - stopped' })
