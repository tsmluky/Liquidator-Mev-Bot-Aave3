Write-Host "🧠 Aave V3 STRATEGIST - Plan & Execute Mode" -ForegroundColor Magenta

while ($true) {
    # Lee candidates.jsonl (generado por el scanner)
    # Muestra HUD Detallado (Tokens, Profit)
    # Ejecuta transacciones
    
    $now = Get-Date -Format "HH:mm:ss"
    
    # 1. Plan (Genera tx_plan.json + Rich HUD)
    pnpm plan
    
    # 2. Exec (Lee tx_plan.json + Envía TX)
    pnpm execute
    
    # Descanso breve para no saturar CPU y dar tiempo al scanner de actualizar
    Start-Sleep -Seconds 2
}
