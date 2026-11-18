$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$forgePort = 4317
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot '.env')) {
  foreach ($line in Get-Content -LiteralPath (Join-Path $PSScriptRoot '.env')) {
    if ($line -match '^\s*PORT\s*=\s*(\d+)\s*$') { $forgePort = [int]$Matches[1] }
  }
}
if ($env:PORT) { $forgePort = [int]$env:PORT }
$forgeUrl = "http://127.0.0.1:$forgePort"
try {
  $health = Invoke-RestMethod -Uri "$forgeUrl/api/health" -TimeoutSec 2
  if ($health.app -eq 'forge-local') { Start-Process $forgeUrl; exit 0 }
} catch {}
$nodePath = (Get-Command node -ErrorAction Stop).Source
# A hidden helper opens the browser only after the local server is ready.
$openScript = @'
param([int]$port)
for ($attempt = 0; $attempt -lt 40; $attempt++) {
  try {
    $result = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 1
    if ($result.app -eq 'forge-local') { Start-Process "http://127.0.0.1:$port"; break }
  } catch {}
  Start-Sleep -Milliseconds 250
}
'@
$helperPath = Join-Path $PSScriptRoot '.local-data/open-browser.ps1'
New-Item -ItemType Directory -Path (Split-Path $helperPath) -Force | Out-Null
Set-Content -LiteralPath $helperPath -Value $openScript -Encoding UTF8
Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $helperPath + '"'),$forgePort) -WindowStyle Hidden
Write-Host 'Local API Dev Lab is starting. Keep this window open; close it or press Ctrl+C to stop.' -ForegroundColor Green
& $nodePath (Join-Path $PSScriptRoot 'server.js')
