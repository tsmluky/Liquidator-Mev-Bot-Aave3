[CmdletBinding()]
param(
  [Parameter(Mandatory=$false)]
  [string]$Url = $env:MORPHO_API_URL,

  [Parameter(Mandatory=$true)]
  [int]$ChainId,

  [Parameter(Mandatory=$true)]
  [ValidatePattern("^0x[0-9a-fA-F]{64}$")]
  [string]$MarketKey,

  [Parameter(Mandatory=$false)]
  [double]$HealthFactorMax = 1.20,

  [Parameter(Mandatory=$false)]
  [int]$First = 200,

  [Parameter(Mandatory=$false)]
  [double]$MinBorrowUsd = 5000,

  [Parameter(Mandatory=$false)]
  [ValidateSet("healthFactor","priceVariationToLiquidationPrice")]
  [string]$SortBy = "healthFactor",

  [Parameter(Mandatory=$false)]
  [ValidateSet("json","csv")]
  [string]$OutFormat = "json",

  [Parameter(Mandatory=$false)]
  [string]$OutPath = ""
)

function Invoke-MorphoGraphQL {
  param(
    [Parameter(Mandatory=$true)][string]$Query,
    [Parameter(Mandatory=$true)][string]$Url
  )

  $payload = @{ query = $Query } | ConvertTo-Json -Depth 80
  $res = Invoke-RestMethod -Method Post -Uri $Url -ContentType "application/json" -Body $payload

  if ($null -ne $res -and ($res.PSObject.Properties.Name -contains "errors") -and $res.errors) {
    $errJson = ($res.errors | ConvertTo-Json -Depth 20)
    throw "GraphQL returned errors: $errJson"
  }

  if ($null -eq $res -or -not ($res.PSObject.Properties.Name -contains "data")) {
    throw "GraphQL response missing data."
  }

  return $res.data
}

function Convert-UnixTs {
  param([Parameter(Mandatory=$false)][object]$Ts)
  if ($null -eq $Ts) { return $null }
  try {
    $n = [int64]$Ts
    return [DateTimeOffset]::FromUnixTimeSeconds($n).ToString("yyyy-MM-ddTHH:mm:sszzz")
  } catch {
    return $null
  }
}

function Get-MarketPositionsPaged {
  param(
    [Parameter(Mandatory=$true)][string]$Url,
    [Parameter(Mandatory=$true)][int]$ChainId,
    [Parameter(Mandatory=$true)][string]$MarketKey,
    [Parameter(Mandatory=$true)][double]$HealthFactorMax,
    [Parameter(Mandatory=$true)][int]$First
  )

  $skip = 0
  $all = New-Object System.Collections.Generic.List[object]

  while ($true) {
    $q = @"
{
  marketPositions(
    first: $First,
    skip: $skip,
    where: {
      chainId_in: [$ChainId],
      marketUniqueKey_in: ["$MarketKey"],
      marketListed: true,
      healthFactor_lte: $HealthFactorMax
    }
  ) {
    items {
      healthFactor
      priceVariationToLiquidationPrice
      user { address }
      marketUniqueKey
      state {
        collateralUsd
        borrowAssetsUsd
        borrowShares
        collateral
        timestamp
      }
    }
  }
}
"@

    $data = Invoke-MorphoGraphQL -Query $q -Url $Url

    if ($null -eq $data.marketPositions) { break }
    $batch = $data.marketPositions.items
    if ($null -eq $batch) { break }

    $count = @($batch).Count
    if ($count -eq 0) { break }

    foreach ($p in $batch) { $all.Add($p) }

    if ($count -lt $First) { break }
    $skip += $First
  }

  return $all
}

if (-not $Url) { $Url = "https://api.morpho.org/graphql" }

$raw = Get-MarketPositionsPaged -Url $Url -ChainId $ChainId -MarketKey $MarketKey -HealthFactorMax $HealthFactorMax -First $First

$items = foreach ($p in $raw) {
  $hf = $null
  $pv = $null
  $borrowUsd = $null
  $collUsd = $null
  $tsIso = $null

  try { $hf = [double]$p.healthFactor } catch {}
  try { $pv = [double]$p.priceVariationToLiquidationPrice } catch {}
  try { $borrowUsd = [double]$p.state.borrowAssetsUsd } catch {}
  try { $collUsd = [double]$p.state.collateralUsd } catch {}
  $tsIso = Convert-UnixTs -Ts $p.state.timestamp

  if ($null -ne $borrowUsd -and $borrowUsd -lt $MinBorrowUsd) { continue }

  [pscustomobject]@{
    chainId = $ChainId
    marketKey = $p.marketUniqueKey
    user = $p.user.address
    healthFactor = $hf
    priceVarToLiq = $pv
    borrowUsd = $borrowUsd
    collateralUsd = $collUsd
    timestamp = $tsIso
    borrowShares = $p.state.borrowShares
    collateralRaw = $p.state.collateral
  }
}

if ($SortBy -eq "healthFactor") {
  $items = $items | Sort-Object -Property @{Expression="healthFactor"; Ascending=$true}, @{Expression="borrowUsd"; Ascending=$false}
} else {
  $items = $items | Sort-Object -Property @{Expression={ if ($null -eq $_.priceVarToLiq) { [double]::PositiveInfinity } else { [math]::Abs([double]$_.priceVarToLiq) } }; Ascending=$true},
                                   @{Expression="borrowUsd"; Ascending=$false}
}

if ($OutFormat -eq "json") {
  $json = $items | ConvertTo-Json -Depth 10
  if ($OutPath) {
    $dir = Split-Path -Parent $OutPath
    if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $json | Set-Content -Encoding UTF8 -Path $OutPath
  } else {
    $json
  }
}
else {
  if ($OutPath) {
    $dir = Split-Path -Parent $OutPath
    if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $items | Export-Csv -NoTypeInformation -Encoding UTF8 -Path $OutPath
    "Wrote CSV -> $OutPath"
  } else {
    $items | ConvertTo-Csv -NoTypeInformation
  }
}
