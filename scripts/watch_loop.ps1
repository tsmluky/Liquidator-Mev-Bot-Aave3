$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = Split-Path $PSScriptRoot -Parent
$SleepSec = 30

Write-Host "============================================================"
Write-Host ("Morpho Liquidator v0 | WATCH loop | start={0} | interval={1}s" -f (Get-Date).ToString("o"), $SleepSec)
Write-Host "Ctrl+C to stop."
Write-Host "============================================================"

$iter = 0
while ($true) {
  $iter++
  $t0 = Get-Date
  Write-Host ""
  Write-Host ("---- [{0}] iter={1} ----" -f $t0.ToString("o"), $iter)

  Push-Location $RepoRoot
  try {
    $steps = @("scan","simulate","plan","preflight")
    foreach ($s in $steps) {
      $sw = [System.Diagnostics.Stopwatch]::StartNew()
      pnpm run $s | Out-Host
      $sw.Stop()
      if ($LASTEXITCODE -ne 0) { throw "pnpm run $s failed (exit=$LASTEXITCODE)" }
      Write-Host ("[OK] {0,-8} ms={1}" -f $s, $sw.ElapsedMilliseconds)
    }

    $planPath = Join-Path $RepoRoot "data\tx_plan.json"
    $plan = Get-Content $planPath -Raw | ConvertFrom-Json

    $items = @($plan.items)
    $watch = @($items | Where-Object { $_.action -eq "WATCH" })
    $exec  = @($items | Where-Object { $_.action -eq "EXEC" })

    $top = $items | Sort-Object netProfitUsd -Descending | Select-Object -First 1

    Write-Host ("[STAT] plan count={0} watch={1} exec={2} topAction={3} topNet={4} topProx={5}" -f `
      $items.Count, $watch.Count, $exec.Count, $top.action, $top.netProfitUsd, $top.proximity)

    if ($exec.Count -gt 0) {
      $best = $exec | Sort-Object netProfitUsd -Descending | Select-Object -First 1
      Write-Host ""
      Write-Host "FOUND EXEC (top):" -ForegroundColor Green
      $best | Format-List
      break
    }
  }
  catch {
    Write-Host ("[ERR] {0}" -f $_) -ForegroundColor Red
  }
  finally {
    Pop-Location
  }

  Start-Sleep -Seconds $SleepSec
}
