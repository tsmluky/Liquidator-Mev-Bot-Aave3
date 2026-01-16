# Load environment variables from .env
if (Test-Path .env) {
    Get-Content .env | ForEach-Object {
        if ($_ -match '^\s*([^#][^=]+)\s*=\s*(.+)\s*$') {
            $name = $matches[1].Trim()
            $value = $matches[2].Trim()
            [Environment]::SetEnvironmentVariable($name, $value, 'Process')
        }
    }
}

$Executor = $env:EXECUTOR_ADDR
$SleepSec = if ($env:SCAN_INTERVAL) { [int]$env:SCAN_INTERVAL } else { 15 }
if (-not $Executor) {
    Write-Warning "EXECUTOR_ADDR not set in .env"
}

$host.UI.RawUI.WindowTitle = "LUKX ARBITRUM - Morpho Liquidator Bot"

$cycleCount = 0
$totalOpportunities = 0
$executedTransactions = 0

# Function to write a line with padding to clear residual characters
function Write-CleanLine {
    param(
        [string]$Text,
        [string]$Color = "White"
    )
    $paddedText = $Text.PadRight(100)
    Write-Host $paddedText -ForegroundColor $Color
}

# 1. Print Header (Once)
Write-Host ""
Write-Host "    ██╗     ██╗   ██╗██╗  ██╗██╗  ██╗     █████╗ ██████╗ ██████╗ " -ForegroundColor Cyan
Write-Host "    ██║     ██║   ██║██║ ██╔╝╚██╗██╔╝    ██╔══██╗██╔══██╗██╔══██╗" -ForegroundColor Cyan
Write-Host "    ██║     ██║   ██║█████╔╝  ╚███╔╝     ███████║██████╔╝██████╔╝" -ForegroundColor Cyan
Write-Host "    ██║     ██║   ██║██╔═██╗  ██╔██╗     ██╔══██║██╔══██╗██╔══██╗" -ForegroundColor Cyan
Write-Host "    ███████╗╚██████╔╝██║  ██╗██╔╝ ██╗    ██║  ██║██║  ██║██████╔╝" -ForegroundColor Cyan
Write-Host "    ╚══════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝    ╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝ " -ForegroundColor Cyan
Write-Host ""
Write-Host "    ═══════════════════════════════════════════════════════════════════════" -ForegroundColor DarkCyan
Write-Host "                   M O R P H O   L I Q U I D A T O R   B O T               " -ForegroundColor Green
Write-Host "                        [ ARBITRUM MAINNET HUNTER ]                         " -ForegroundColor Yellow
Write-Host "    ═══════════════════════════════════════════════════════════════" -ForegroundColor DarkCyan
Write-Host ""
Write-Host "    [*] " -NoNewline -ForegroundColor Green
Write-Host "Network       : " -NoNewline -ForegroundColor Gray
Write-Host "ARBITRUM ONE (42161)" -ForegroundColor Cyan
Write-Host "    [*] " -NoNewline -ForegroundColor Green
Write-Host "Executor      : " -NoNewline -ForegroundColor Gray
Write-Host "$Executor" -ForegroundColor Yellow
Write-Host "    [*] " -NoNewline -ForegroundColor Green
Write-Host "Scan Interval : " -NoNewline -ForegroundColor Gray
Write-Host "${SleepSec}s" -ForegroundColor Magenta
Write-Host "    [*] " -NoNewline -ForegroundColor Green
Write-Host "Status        : " -NoNewline -ForegroundColor Gray
Write-Host "ARMED & READY" -ForegroundColor Green
Write-Host ""
Write-Host "    ───────────────────────────────────────────────────────────────────────" -ForegroundColor DarkGray
Write-Host ""

while ($true) {
    $cycleCount++
    
    # Removed Clear-Host to allow log history

  
    $timestamp = (Get-Date).ToString("HH:mm:ss")
  
    # Cycle header
    $line1 = "    ┌─[lukx@morpho-hunter]─[$timestamp]─[cycle:$cycleCount]"
    Write-CleanLine $line1 -Color DarkCyan
  
    $line2 = "    └──> Scanning for liquidation opportunities..."
    Write-CleanLine $line2 -Color White
  
    Write-CleanLine "" -Color White
  
    # Run OPTIMIZED SINGLE-PROCESS CYCLE
    # This prevents spawning 5 separate node processes, saving ~15 seconds per loop
    
    Write-Host "    [" -NoNewline -ForegroundColor DarkGray
    Write-Host "⚡" -NoNewline -ForegroundColor Yellow
    Write-Host "] RUNNING OPTIMIZED CYCLE... " -NoNewline -ForegroundColor White
    
    # Run the cycle command and capture ALL output
    $cycleOutput = npx tsx src/cli.ts cycle 2>&1 | Out-String
    
    # Check overall success
    $cycleSuccess = $LASTEXITCODE -eq 0
    
    if ($cycleSuccess) {
        Write-Host "Completed" -ForegroundColor Green
    }
    else {
        Write-Host "Failed" -ForegroundColor Red
    }
    
    # Parse the output to update visual status of sub-steps
    # We look for the ">> STEP: X" markers we added in cycle.ts
    
    # SCAN
    $scanCheck = if ($cycleOutput -match ">> STEP: SCAN") { "✓" } else { "✗" }
    $scanColor = if ($scanCheck -eq "✓") { "Green" } else { "Red" }
    
    # SIMULATE
    $simCheck = if ($cycleOutput -match ">> STEP: SIMULATE") { "✓" } else { "✗" }
    $simColor = if ($simCheck -eq "✓") { "Green" } else { "Red" }
    
    # PLAN
    $planCheck = if ($cycleOutput -match ">> STEP: PLAN") { "✓" } else { "✗" }
    $planColor = if ($planCheck -eq "✓") { "Green" } else { "Red" }
    
    # PREFLIGHT
    $preCheck = if ($cycleOutput -match ">> STEP: PREFLIGHT") { "✓" } else { "✗" }
    $preColor = if ($preCheck -eq "✓") { "Green" } else { "Red" }
    
    # EXEC
    $execStatus = "Execution cycle completed"
    $txSubmitted = $cycleOutput -match "exec: submitted"
    
    if ($txSubmitted) {
        $execStatus = "TX BROADCASTED!"
        $execCheck = "✓"
        $execCheckColor = "Magenta"
    }
    else {
        $execCheck = "✓"
        $execCheckColor = "Green"
    }

    Write-CleanLine "" -Color White
    
    # Print sub-step statuses
    Write-Host "    [>] SCAN      :: Morpho markets queried                            [$scanCheck]" -ForegroundColor $scanColor
    Write-Host "    [>] SIMULATE  :: Profitability calculated                          [$simCheck]" -ForegroundColor $simColor
    Write-Host "    [>] PLAN      :: Execution strategy built                          [$planCheck]" -ForegroundColor $planColor
    Write-Host "    [>] PREFLIGHT :: System state validated                            [$preCheck]" -ForegroundColor $preColor
    Write-Host "    [>] EXEC      :: $execStatus".PadRight(67) + "[$execCheck]" -ForegroundColor $execCheckColor
  
    Write-CleanLine "" -Color White

    if (Test-Path .\data\tx_plan.json) {
        $plan = Get-Content .\data\tx_plan.json -Raw | ConvertFrom-Json
    
        $execCount = if ($plan.execBuilt) { $plan.execBuilt } else { 0 }
        $watchCount = if ($plan.items) { $plan.items.Count } else { 0 }
        $top = $plan.items | Select-Object -First 1

        if ($top) {
            $topProx = if ($top.proximity) { $top.proximity } else { 0 }
            $topNet = if ($top.netProfitUsd) { $top.netProfitUsd } else { 0 }
      
            Write-CleanLine "    ╔═══════════════════════════════════════════════════════════════╗" -Color DarkCyan
            Write-CleanLine "    ║ SCAN RESULTS                                                  ║" -Color Cyan
            Write-CleanLine "    ╠═══════════════════════════════════════════════════════════════╣" -Color DarkCyan
            Write-CleanLine "    ║ Plan: $execCount | Watch: $watchCount | Prox: $($topProx.ToString('N6')) | Net: `$$($topNet.ToString('N2'))       ║"

      
            Write-CleanLine "    ╚═══════════════════════════════════════════════════════════════╝" -Color DarkCyan
      
            # ONLY TRIGGER ALERT IF A REAL TX WAS SUBMITTED
            if ($txSubmitted) {
                # Increment counters (will show on next redraw)
                $totalOpportunities++
                $executedTransactions++
        
                [Console]::Beep(900, 300)
                [Console]::Beep(1100, 300)
                [Console]::Beep(1300, 500)
        
                Write-CleanLine "" -Color White
                Write-CleanLine "    ╔═══════════════════════════════════════════════════════════════╗" -Color Red
                Write-CleanLine "    ║ 🚀 LIQUIDATION CONFIRMED - TX SENT TO MEMPOOL 🚀             ║" -Color Yellow
                Write-CleanLine "    ╚═══════════════════════════════════════════════════════════════╝" -Color Red
            }
        }
        else {
            Write-CleanLine "    ╔═══════════════════════════════════════════════════════════════╗" -Color DarkGray
            Write-CleanLine "    ║ STATUS: NO TARGETS DETECTED                                   ║" -Color DarkGray
            Write-CleanLine "    ╚═══════════════════════════════════════════════════════════════╝" -Color DarkGray
        }
    }
    else {
        Write-CleanLine "    ╔═══════════════════════════════════════════════════════════════╗" -Color Yellow
        Write-CleanLine "    ║ ⚠ NO PLAN FILE FOUND                                          ║" -Color Yellow
        Write-CleanLine "    ╚═══════════════════════════════════════════════════════════════╝" -Color Yellow
    }

    # Parse the output for logs to display in the "Live Log Stream"
    # We filter for relevant lines (INFO, WARN, ERROR or specific bot messages)
    $logLines = $cycleOutput -split "`n" | Where-Object { 
        $_ -match '"level":' -or $_ -match '\[.+\]' -or $_ -match 'Error'
    } | Select-Object -Last 5

    Write-CleanLine "" -Color White
    Write-CleanLine "    ╔═══════════════════════════════════════════════════════════════╗" -Color DarkGray
    Write-CleanLine "    ║ LIVE LOG STREAM                                               ║" -Color Gray
    Write-CleanLine "    ╠═══════════════════════════════════════════════════════════════╣" -Color DarkGray
    
    if ($logLines) {
        foreach ($line in $logLines) {
            # Clean up JSON logs for display if possible, or just truncate
            $cleanLine = $line.Trim()
            if ($cleanLine.Length -gt 90) { $cleanLine = $cleanLine.Substring(0, 90) + "..." }
            
            $color = "Gray"
            if ($cleanLine -match "Error" -or $cleanLine -match '"level":50') { $color = "Red" }
            elseif ($cleanLine -match "Warn" -or $cleanLine -match '"level":40') { $color = "Yellow" }
            elseif ($cleanLine -match "success" -or $cleanLine -match "✓") { $color = "Green" }

            Write-CleanLine "    ║ $cleanLine" -Color $color
        }
    }
    else {
        Write-CleanLine "    ║ (No new logs this cycle)                                      " -Color DarkGray
    }
    Write-CleanLine "    ╚═══════════════════════════════════════════════════════════════╝" -Color DarkGray

    Write-CleanLine "" -Color White
  
    $statsLine = "    [*] Total Opportunities: $totalOpportunities | Next scan: ${SleepSec}s"
    Write-CleanLine $statsLine -Color DarkGray
  
    Start-Sleep -Seconds $SleepSec
}
