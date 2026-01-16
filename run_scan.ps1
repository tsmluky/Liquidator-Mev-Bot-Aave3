Write-Host "🕵️ Aave V3 SCANNER ONLY - High Frequency Mode" -ForegroundColor Cyan

while ($true) {
    # Solo escanea. No planea ni ejecuta.
    # Esto mantiene el candidates.jsonl fresco al milisegundo.
    $now = Get-Date -Format "HH:mm:ss"
    Write-Host "[$now] 🔎 Scanning..." -NoNewline -ForegroundColor DarkGray
    
    # Redirigir output a null o dejarlo ver? Dejarlo ver pero minimalista
    #scan.ts ya es bastante limpio en modo fast
    pnpm scan
    
    if ($LASTEXITCODE -ne 0) { 
        Write-Host "❌ Crash" -ForegroundColor Red
        Start-Sleep -Seconds 2
    }
    
    # 0 Latencia añadida. Apenas termina, vuelve a empezar.
}
