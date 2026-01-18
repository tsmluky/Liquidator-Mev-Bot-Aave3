$ErrorActionPreference = "SilentlyContinue"

Write-Host "Aave V3 MINER - Historical Discovery" -ForegroundColor Cyan
Write-Host "------------------------------------"

while ($true) {
    try {
        # Using --mode mining to only fetch logs
        pnpm scan --mode mining
    }
    catch {
        Write-Host "Miner Stumbled: $_" -ForegroundColor Yellow
    }
    
    # Wait 2 seconds before next mining cycle
    Start-Sleep -Seconds 2
}
