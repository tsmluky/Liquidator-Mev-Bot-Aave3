$ErrorActionPreference = "SilentlyContinue"

Write-Host "INITIALIZING AAVE V3 LIQUIDATOR FLEET..." -ForegroundColor Cyan
Write-Host "------------------------------------------------"

# Miner
Write-Host "1. Launching Miner..."
Start-Process "powershell" -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-File", ".\run_miner.ps1"

Start-Sleep -Seconds 2

# Sentry
Write-Host "2. Launching Sentry..."
Start-Process "powershell" -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-File", ".\run_sentry.ps1"

Start-Sleep -Seconds 1

# Strategy
Write-Host "3. Launching Sniper..."
Start-Process "powershell" -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-File", ".\run_strategy.ps1"

Write-Host "------------------------------------------------"
Write-Host "TRI-FORCE DEPLOYED." -ForegroundColor Green
Write-Host "Please check the 3 new windows."
