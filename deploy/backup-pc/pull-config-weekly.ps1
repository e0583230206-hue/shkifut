# Once a week: copies the newest settings backup (config-*.tgz: the .env files of the site and the bridge, the compose files) to a PRIVATE folder,
# separate from the media and from the database dumps. These are the secrets of the site. The read-only backup account cannot read them,
# so this uses the owner's deploy key (root), only for this one file. Keeps the newest 4.
param([switch]$Force)
. (Join-Path $PSScriptRoot 'common.ps1')
Set-FolderPrivate $SecretsDir

$latest = Get-ChildItem -LiteralPath $SecretsDir -Filter 'config-*.tgz' -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
if (-not $Force -and $latest -and $latest.LastWriteTime -gt (Get-Date).AddDays(-7)) { Write-Log "config: skipped, the copy $($latest.Name) is less than 7 days old"; exit 0 }

# The nginx site file of the live site (it holds the Google verification block, which is in no repository). Small, not a secret.
$ng = Join-Path $SecretsDir ('nginx-{0:yyyy-MM-dd}.conf' -f (Get-Date))
& scp -i $AdminKey -o BatchMode=yes -o ConnectTimeout=20 "root@${Server}:/etc/nginx/sites-available/hashkifut.co.il.conf" "$ng.part"
if ($LASTEXITCODE -eq 0) { Move-Item -LiteralPath "$ng.part" -Destination $ng -Force; Write-Log "config: copied the nginx site file ($(Split-Path $ng -Leaf))" }
else { Write-Log 'config: the nginx site file could not be copied'; Remove-Item -LiteralPath "$ng.part" -ErrorAction SilentlyContinue }
Get-ChildItem -LiteralPath $SecretsDir -Filter 'nginx-*.conf' | Sort-Object Name -Descending | Select-Object -Skip $KeepConfig | Remove-Item

$name = (& ssh -i $AdminKey -o BatchMode=yes -o ConnectTimeout=20 "root@$Server" 'ls -1t /var/backups/thechannel/config-*.tgz 2>/dev/null | head -1')
if ($LASTEXITCODE -ne 0) { Write-Log 'config: cannot reach the server'; exit 1 }
$name = "$name".Trim()
if (-not $name) { Write-Log 'config: no settings backup on the server'; exit 1 }
$file = Split-Path $name -Leaf
$target = Join-Path $SecretsDir $file
if (Test-Path -LiteralPath $target) { Write-Log "config: already here: $file"; exit 0 }
& scp -i $AdminKey -o BatchMode=yes -o ConnectTimeout=20 "root@${Server}:$name" "$target.part"
if ($LASTEXITCODE -ne 0) { Write-Log "config: scp failed for $file"; Remove-Item -LiteralPath "$target.part" -ErrorAction SilentlyContinue; exit 1 }
if (-not (Test-TarFile "$target.part")) { Write-Log "config: $file does not open as an archive"; Remove-Item -LiteralPath "$target.part"; exit 1 }
Move-Item -LiteralPath "$target.part" -Destination $target
Get-ChildItem -LiteralPath $SecretsDir -Filter 'config-*.tgz' | Sort-Object Name -Descending | Select-Object -Skip $KeepConfig | Remove-Item
Set-Status 'config' @{ time = (Get-Date).ToString('s'); file = $file }
Write-Log "config: copied $file"
exit 0
