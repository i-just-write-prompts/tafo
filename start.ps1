$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root
if (-not (Test-Path ".env")) { Copy-Item ".env.example" ".env" }
if (-not (Test-Path ".venv\Scripts\python.exe")) {
  if (Get-Command py -ErrorAction SilentlyContinue) { py -3 -m venv .venv }
  else { python -m venv .venv }
}
.\.venv\Scripts\python.exe -m pip install -e ".\backend[dev]"
if (-not (Test-Path ".\frontend\node_modules")) {
  Push-Location .\frontend
  npm install
  Pop-Location
}
New-Item -ItemType Directory -Force -Path .\data | Out-Null
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$Root'; .\.venv\Scripts\python.exe -m tafo"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$Root\frontend'; npm run dev"
Write-Host "TAFO API http://127.0.0.1:8787/docs"
Write-Host "TAFO UI  http://127.0.0.1:5173"
