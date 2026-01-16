[CmdletBinding()]
param(
  [string]$PlanPath = ".\data\tx_plan.json",
  [int]$Top = 3,
  [switch]$Beep
)

function ShortHex([string]$s, [int]$keep=6) {
  if (-not $s) { return "" }
  $t = $s.Trim()
  if ($t.Length -le ($keep*2 + 2)) { return $t }
  return ($t.Substring(0, 2 + $keep) + "..." + $t.Substring($t.Length - $keep, $keep))
}

function WriteTag([string]$tag, [string]$msg, [ConsoleColor]$c) {
  Write-Host ("[{0}] {1}" -f $tag, $msg) -ForegroundColor $c
}

if (-not (Test-Path $PlanPath)) {
  WriteTag "WARN" ("Plan not found: {0}" -f $PlanPath) Yellow
  exit 0
}

$planRaw = Get-Content -LiteralPath $PlanPath -Raw -ErrorAction Stop
$plan = $planRaw | ConvertFrom-Json

$execCount = [int]($plan.execCount ?? 0)
$watchCount = [int]($plan.watchCount ?? 0)
$count = [int]($plan.count ?? 0)

if ($execCount -le 0) {
  WriteTag "OK" ("No EXEC. count={0} watch={1} exec={2}" -f $count,$watchCount,$execCount) Green
  exit 0
}

WriteTag "ALERT" ("EXEC candidates detected! exec={0} (total={1}, watch={2})" -f $execCount,$count,$watchCount) Red

# Mostrar top EXEC items (si existen en items)
$items = @($plan.items | Where-Object { $_.action -eq "EXEC" })
if ($items.Count -eq 0) {
  WriteTag "INFO" "execCount>0 but no EXEC items found in plan.items (check plan generation logic)" Yellow
} else {
  $topItems = $items | Select-Object -First $Top
  $i = 0
  foreach ($it in $topItems) {
    $i++
    $m = ShortHex ([string]$it.marketId)
    $b = ShortHex ([string]$it.borrower)
    $prox = [double]($it.proximity ?? [double]::NaN)
    $net  = [double]($it.netProfitUsd ?? [double]::NaN)
    $pass = [bool]($it.pass ?? $false)
    $line = ("#{0} prox={1:N6} net={2:N2} pass={3} market={4} borrower={5} {6}/{7}" -f $i,$prox,$net,$pass,$m,$b,([string]$it.collateral),([string]$it.loan))
    WriteTag "EXEC" $line Red
  }
}

if ($Beep) {
  try { [Console]::Beep(900, 250); Start-Sleep -Milliseconds 80; [Console]::Beep(900, 250) } catch { }
}

exit 0
