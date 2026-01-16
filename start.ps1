Write-Host "💀 The Reaper (Aave V3 Liquidator) - Started" -ForegroundColor Red

# Loop infinito de caza
while ($true) {
    $now = Get-Date -Format "HH:mm:ss"
    Write-Host "[$now] 🔎 Scanning..." -ForegroundColor Cyan
    
    # 1. Scan -> candidates.jsonl
    pnpm scan
    if ($LASTEXITCODE -ne 0) { 
        Write-Host "❌ Scan crashed, restarting loop..." -ForegroundColor Yellow
        Start-Sleep -Seconds 5
        continue 
    }

    # 2. Plan -> tx_plan.json
    # Write-Host "[$now] 📝 Planning..." -ForegroundColor Cyan
    pnpm plan

    # 3. Exec -> On-chain
    # Write-Host "[$now] ⚔️ Executing..." -ForegroundColor Red
    pnpm execute

    # Descanso antispam (Modo Turbo: 1s)
    # Descanso antispam (Modo Turbo: 0s - el propio scan tarda)
    # Start-Sleep -Seconds 0
}
