param([string]$Root=(Resolve-Path ".").Path)
Set-StrictMode -Version Latest
$ErrorActionPreference="Stop"
Set-Location $Root
Write-Host "== test_safe (ascii) =="

pnpm run test
