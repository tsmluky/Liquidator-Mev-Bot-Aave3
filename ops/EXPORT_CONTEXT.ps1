# ops/EXPORT_CONTEXT.ps1
# Exportador "LLM-ready" del estado del proyecto.
# Genera: ZIP limpio + TREE + MANIFEST + STATS + EXCLUSIONS + BUNDLE (single paste)
# Seguridad: excluye .env* y patrones típicos de secretos por defecto.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

param(
  [string]$ProjectRoot = "",
  [string]$OutDir = ".\_export",
  [int]$TreeDepth = 12,
  [switch]$Hash,                 # Calcula SHA256 para archivos (más lento)
  [int]$MaxFileMB = 20,          # Salta archivos muy grandes (útil para repos pesados)
  [switch]$IncludeGitIgnored      # Si lo activas, NO se usa .gitignore como referencia (solo patrones de este script)
)

function Write-Info([string]$msg) { Write-Host "[INFO] $msg" -ForegroundColor Cyan }
function Write-Warn([string]$msg) { Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Write-Ok([string]$msg)   { Write-Host "[OK]   $msg" -ForegroundColor Green }

function Resolve-Abs([string]$p) {
  if ([string]::IsNullOrWhiteSpace($p)) { return "" }
  return (Resolve-Path -LiteralPath $p).Path
}

function Find-ProjectRoot([string]$startDir) {
  $dir = Resolve-Abs $startDir
  if (-not $dir) { $dir = (Get-Location).Path }

  while ($true) {
    $markers = @("package.json","pnpm-lock.yaml","yarn.lock","requirements.txt","pyproject.toml","hardhat.config.ts","foundry.toml",".git")
    foreach ($m in $markers) {
      if (Test-Path -LiteralPath (Join-Path $dir $m)) { return $dir }
    }
    $parent = Split-Path -Parent $dir
    if ($parent -eq $dir -or [string]::IsNullOrWhiteSpace($parent)) { return (Get-Location).Path }
    $dir = $parent
  }
}

# --- Exclusiones (hard rules) ---
$excludeDirNames = @(
  ".git","node_modules","dist","build","out",".next",".turbo",
  "coverage",".nyc_output",
  ".venv","venv",".mypy_cache",".pytest_cache",
  "__pycache__",".ruff_cache",".cache",
  ".idea",".vscode",
  ".DS_Store"
)

# Archivos/patrones sensibles o ruido
$excludeFileGlobs = @(
  "*.env","*.env.*",".env*",
  "*.pem","*.key","*.p12","*.pfx","*.crt","*.cer",
  "id_rsa","id_ed25519","known_hosts",
  "*.log","*.tmp","*.swp","*.swo",
  "*.zip","*.7z","*.tar","*.gz",
  "*.sqlite","*.db",
  "secrets.*","secret.*","credentials.*","creds.*",
  "*private*key*","*mnemonic*","*seed*phrase*"
)

# Si existen carpetas típicas de secretos, exclúyelas directamente
$excludeDirGlobs = @("secrets","secret","keys","private","certs","certificates")

function Is-ExcludedPath([string]$fullPath, [string]$root, [ref]$reason) {
  $rel = $fullPath.Substring($root.Length).TrimStart('\','/')
  $relNorm = $rel -replace "\\","/"

  # Excluir directorios por nombre en cualquier parte del path
  $parts = $relNorm.Split("/") | Where-Object { $_ -ne "" }
  foreach ($p in $parts) {
    if ($excludeDirNames -contains $p) { $reason.Value = "Excluded dir name: $p"; return $true }
    foreach ($dg in $excludeDirGlobs) {
      if ($p -ieq $dg) { $reason.Value = "Excluded sensitive dir: $p"; return $true }
    }
  }

  # Excluir por globs de archivo (sobre nombre y sobre path relativo)
  $name = [IO.Path]::GetFileName($relNorm)
  foreach ($g in $excludeFileGlobs) {
    if ($name -like $g -or $relNorm -like $g) { $reason.Value = "Excluded glob: $g"; return $true }
  }

  return $false
}

function Format-Bytes([long]$bytes) {
  if ($bytes -ge 1GB) { return "{0:N2} GB" -f ($bytes / 1GB) }
  if ($bytes -ge 1MB) { return "{0:N2} MB" -f ($bytes / 1MB) }
  if ($bytes -ge 1KB) { return "{0:N2} KB" -f ($bytes / 1KB) }
  return "$bytes B"
}

function Get-Tree([string]$root, [int]$maxDepth) {
  # Árbol simple (sin depender de `tree.exe`)
  $sb = New-Object System.Text.StringBuilder
  $rootName = Split-Path -Leaf $root
  [void]$sb.AppendLine($rootName)

  function Walk([string]$dir, [string]$prefix, [int]$depth) {
    if ($depth -le 0) { return }
    $items = Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue |
      Sort-Object @{Expression={$_.PSIsContainer};Descending=$true}, Name

    # Filtrar excluidos a nivel árbol también
    $filtered = @()
    foreach ($it in $items) {
      $r = ""
      if (-not (Is-ExcludedPath -fullPath $it.FullName -root $root -reason ([ref]$r))) {
        $filtered += $it
      }
    }

    for ($i=0; $i -lt $filtered.Count; $i++) {
      $it = $filtered[$i]
      $isLast = ($i -eq $filtered.Count-1)
      $branch = $(if ($isLast) { "└─ " } else { "├─ " })
      [void]$sb.AppendLine($prefix + $branch + $it.Name)

      if ($it.PSIsContainer) {
        $nextPrefix = $prefix + $(if ($isLast) { "   " } else { "│  " })
        Walk -dir $it.FullName -prefix $nextPrefix -depth ($depth - 1)
      }
    }
  }

  Walk -dir $root -prefix "" -depth $maxDepth
  return $sb.ToString()
}

# --- MAIN ---
if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = Find-ProjectRoot (Get-Location).Path
} else {
  $ProjectRoot = Resolve-Abs $ProjectRoot
}

$root = Resolve-Abs $ProjectRoot
if (-not (Test-Path -LiteralPath $root)) { throw "ProjectRoot no existe: $root" }

$OutDir = Resolve-Abs $OutDir
if (-not $OutDir) { $OutDir = (Join-Path $root "_export") }
New-Item -ItemType Directory -Force $OutDir | Out-Null

$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$baseName = "EXPORT_$timestamp"
$zipPath = Join-Path $OutDir "$baseName.zip"
$treePath = Join-Path $OutDir "$baseName`_TREE.txt"
$manifestPath = Join-Path $OutDir "$baseName`_MANIFEST.csv"
$statsPath = Join-Path $OutDir "$baseName`_STATS.txt"
$exclPath = Join-Path $OutDir "$baseName`_EXCLUSIONS.txt"
$bundlePath = Join-Path $OutDir "$baseName`_BUNDLE.txt"

Write-Info "ProjectRoot: $root"
Write-Info "OutDir:      $OutDir"
Write-Info "Outputs:     $baseName.*"

# Recorrer archivos
$all = Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue

$included = New-Object System.Collections.Generic.List[object]
$excluded = New-Object System.Collections.Generic.List[object]

$maxBytes = [int64]$MaxFileMB * 1MB

foreach ($f in $all) {
  $reason = ""
  if (Is-ExcludedPath -fullPath $f.FullName -root $root -reason ([ref]$reason)) {
    $excluded.Add([pscustomobject]@{
      path = ($f.FullName.Substring($root.Length).TrimStart('\','/') -replace "\\","/")
      reason = $reason
      sizeBytes = [int64]$f.Length
    }) | Out-Null
    continue
  }

  if ($f.Length -gt $maxBytes) {
    $excluded.Add([pscustomobject]@{
      path = ($f.FullName.Substring($root.Length).TrimStart('\','/') -replace "\\","/")
      reason = "Excluded: too large (> $MaxFileMB MB)"
      sizeBytes = [int64]$f.Length
    }) | Out-Null
    continue
  }

  $hashValue = ""
  if ($Hash) {
    try { $hashValue = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash }
    catch { $hashValue = "" }
  }

  $included.Add([pscustomobject]@{
    path = ($f.FullName.Substring($root.Length).TrimStart('\','/') -replace "\\","/")
    sizeBytes = [int64]$f.Length
    lastWriteTime = $f.LastWriteTimeUtc.ToString("o")
    sha256 = $hashValue
  }) | Out-Null
}

# TREE
Write-Info "Generating TREE..."
(Get-Tree -root $root -maxDepth $TreeDepth) | Set-Content -LiteralPath $treePath -Encoding UTF8

# MANIFEST
Write-Info "Generating MANIFEST..."
$included | Sort-Object path | Export-Csv -LiteralPath $manifestPath -NoTypeInformation -Encoding UTF8

# EXCLUSIONS
Write-Info "Generating EXCLUSIONS..."
$excluded | Sort-Object path | Export-Csv -LiteralPath $exclPath -NoTypeInformation -Encoding UTF8

# STATS
Write-Info "Generating STATS..."
$totalBytes = ($included | Measure-Object -Property sizeBytes -Sum).Sum
$totalFiles = $included.Count
$extStats = $included |
  ForEach-Object {
    $ext = [IO.Path]::GetExtension($_.path).ToLowerInvariant()
    if ([string]::IsNullOrWhiteSpace($ext)) { $ext = "(noext)" }
    [pscustomobject]@{ ext=$ext; sizeBytes=$_.sizeBytes }
  } |
  Group-Object ext |
  ForEach-Object {
    $sz = ($_.Group | Measure-Object -Property sizeBytes -Sum).Sum
    [pscustomobject]@{ ext=$_.Name; count=$_.Count; sizeBytes=[int64]$sz }
  } |
  Sort-Object sizeBytes -Descending

$largest = $included | Sort-Object sizeBytes -Descending | Select-Object -First 25

$statsSb = New-Object System.Text.StringBuilder
[void]$statsSb.AppendLine("PROJECT EXPORT STATS")
[void]$statsSb.AppendLine("Root: $root")
[void]$statsSb.AppendLine("Generated: " + (Get-Date).ToString("o"))
[void]$statsSb.AppendLine("")
[void]$statsSb.AppendLine("INCLUDED")
[void]$statsSb.AppendLine("  Files: $totalFiles")
[void]$statsSb.AppendLine("  Size:  $(Format-Bytes $totalBytes) ($totalBytes bytes)")
[void]$statsSb.AppendLine("")
[void]$statsSb.AppendLine("EXCLUDED")
[void]$statsSb.AppendLine("  Files: " + $excluded.Count)
$exclBytes = ($excluded | Measure-Object -Property sizeBytes -Sum).Sum
[void]$statsSb.AppendLine("  Size:  $(Format-Bytes $exclBytes) ($exclBytes bytes)")
[void]$statsSb.AppendLine("")
[void]$statsSb.AppendLine("TOP EXTENSIONS (by size)")
foreach ($row in ($extStats | Select-Object -First 20)) {
  [void]$statsSb.AppendLine(("  {0,-10}  {1,6} files  {2,12}" -f $row.ext, $row.count, (Format-Bytes $row.sizeBytes)))
}
[void]$statsSb.AppendLine("")
[void]$statsSb.AppendLine("LARGEST FILES")
foreach ($lf in $largest) {
  [void]$statsSb.AppendLine(("  {0,12}  {1}" -f (Format-Bytes $lf.sizeBytes), $lf.path))
}
$statsSb.ToString() | Set-Content -LiteralPath $statsPath -Encoding UTF8

# ZIP limpio (sin copiar a temp): ZipArchive manual
Write-Info "Building ZIP (filtered)..."
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }

$zipFs = [IO.File]::Open($zipPath, [IO.FileMode]::CreateNew)
try {
  $zip = New-Object System.IO.Compression.ZipArchive($zipFs, [System.IO.Compression.ZipArchiveMode]::Create, $false)

  foreach ($row in ($included | Sort-Object path)) {
    $src = Join-Path $root ($row.path -replace "/","\")
    if (-not (Test-Path -LiteralPath $src)) { continue }

    $entry = $zip.CreateEntry($row.path, [System.IO.Compression.CompressionLevel]::Optimal)
    $entry.LastWriteTime = [DateTimeOffset]::Parse($row.lastWriteTime)

    $inStream = [IO.File]::OpenRead($src)
    try {
      $outStream = $entry.Open()
      try { $inStream.CopyTo($outStream) }
      finally { $outStream.Dispose() }
    } finally {
      $inStream.Dispose()
    }
  }

  $zip.Dispose()
} finally {
  $zipFs.Dispose()
}

# BUNDLE (single paste)
Write-Info "Generating BUNDLE (single paste)..."
$bundle = New-Object System.Text.StringBuilder
[void]$bundle.AppendLine("=== PROJECT EXPORT BUNDLE ===")
[void]$bundle.AppendLine("Root: $root")
[void]$bundle.AppendLine("Generated: " + (Get-Date).ToString("o"))
[void]$bundle.AppendLine("")
[void]$bundle.AppendLine("=== TREE ===")
[void]$bundle.AppendLine((Get-Content -LiteralPath $treePath -Raw))
[void]$bundle.AppendLine("")
[void]$bundle.AppendLine("=== STATS ===")
[void]$bundle.AppendLine((Get-Content -LiteralPath $statsPath -Raw))
[void]$bundle.AppendLine("")
[void]$bundle.AppendLine("=== EXCLUSIONS (summary top 200) ===")
$exclPreview = Import-Csv -LiteralPath $exclPath | Select-Object -First 200
foreach ($e in $exclPreview) {
  [void]$bundle.AppendLine(("  - {0}  [{1}]" -f $e.path, $e.reason))
}
if ((Import-Csv -LiteralPath $exclPath).Count -gt 200) {
  [void]$bundle.AppendLine("  ... (truncated)")
}
[void]$bundle.AppendLine("")
[void]$bundle.AppendLine("=== MANIFEST (preview top 200) ===")
$manPreview = Import-Csv -LiteralPath $manifestPath | Select-Object -First 200
foreach ($m in $manPreview) {
  $sha = $m.sha256
  if ([string]::IsNullOrWhiteSpace($sha)) { $sha = "-" }
  [void]$bundle.AppendLine(("  - {0}  ({1} bytes)  {2}" -f $m.path, $m.sizeBytes, $sha))
}
if ((Import-Csv -LiteralPath $manifestPath).Count -gt 200) {
  [void]$bundle.AppendLine("  ... (truncated)")
}

$bundle.ToString() | Set-Content -LiteralPath $bundlePath -Encoding UTF8

Write-Ok "Done."
Write-Host ""
Write-Host "Outputs:" -ForegroundColor Gray
Write-Host "  ZIP:        $zipPath" -ForegroundColor Gray
Write-Host "  TREE:       $treePath" -ForegroundColor Gray
Write-Host "  MANIFEST:   $manifestPath" -ForegroundColor Gray
Write-Host "  STATS:      $statsPath" -ForegroundColor Gray
Write-Host "  EXCLUSIONS: $exclPath" -ForegroundColor Gray
Write-Host "  BUNDLE:     $bundlePath" -ForegroundColor Gray
