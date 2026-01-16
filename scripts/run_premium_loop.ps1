$ErrorActionPreference = "Stop"

function Check-KillSwitch {
    if (Test-Path "STOP_LIQUIDATOR") {
        Write-Host "Create STOP_LIQUIDATOR file detected. Exiting..." -ForegroundColor Red
        exit
    }
    if ($env:STOP_LIQUIDATOR -eq "1") {
        Write-Host "STOP_LIQUIDATOR env var detected. Exiting..." -ForegroundColor Red
        exit
    }
}

function Run-Step {
    param($Name, $Command)
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Starting $Name..." -ForegroundColor Cyan
    try {
        Invoke-Expression $Command
    }
    catch {
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Error in $Name : $_" -ForegroundColor Red
        # Don't exit, just continue to next step or next loop
    }
}

# LUKX MEV HUNTER - Premium Loop
Write-Host "" 
Write-Host "🎯 [LUKX] Morpho Liquidator initialized" -ForegroundColor Cyan
Write-Host "⚡ Kill switch: Create 'STOP_LIQUIDATOR' file to abort mission" -ForegroundColor Yellow
Write-Host ""

$iter = 0

while ($true) {
    Check-KillSwitch

    $iter++
    Write-Host "━━━━━━━━━ [CYCLE #$iter] ━━━━━━━━━" -ForegroundColor Magenta

    # 1. SCAN
    Run-Step "SCAN" "npx tsx src/cli.ts scan"

    # 2. SIMULATE
    Run-Step "SIMULATE" "npx tsx src/cli.ts simulate"

    # 3. PLAN
    Run-Step "PLAN" "npx tsx src/cli.ts plan"

    # 4. EXEC (Only if enabled in env, otherwise it will just log 'blocked')
    # Use 'try' to catch the 'no executable order' or other errors without crashing loop
    Run-Step "EXEC" "npx tsx src/cli.ts exec"

    # Sleep slightly to avoid spamming excessively if cycle is too fast
    Start-Sleep -Seconds 5
}
