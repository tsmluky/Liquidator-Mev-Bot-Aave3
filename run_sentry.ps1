$ErrorActionPreference = "SilentlyContinue"

Write-Host "Aave V3 SENTRY - High Frequency Watchdog" -ForegroundColor Cyan
Write-Host "----------------------------------------"

while ($true) {
    try {
        # Using --mode sentry for pure health checks
        pnpm scan --mode sentry
    }
    catch {
        Write-Host "Sentry Blinked: $_" -ForegroundColor Yellow
    }
    
    # Very short sleep for high frequency (50ms)
    Start-Sleep -Milliseconds 50
}
