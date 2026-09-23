<#
.SYNOPSIS
  Fetch (or check an already-received) ToolsEnabled installer and
  independently verify it matches the release declaration -- WITHOUT
  trusting the transfer itself.

.DESCRIPTION
  Deliberately plain PowerShell with no dependency on Node, git, or this
  repository being present. The verifier can start from a clean environment,
  and verification does not become a hidden developer-tooling requirement.

  Two modes:
    - Network pull: pass -Uri and -Token to fetch from the builder's
      tools/release-packager/serve-candidate.mjs.
    - Already have the file (filesystem hand-off, or already downloaded):
      pass -ExistingFile instead of -Uri/-Token.

  Either way, the exact byte count and SHA-256 given by the release
  declaration are the only things trusted -- this script re-measures the
  file itself and compares. A copy that merely "downloaded without error" is
  not treated as evidence.

.EXAMPLE
  # Network pull from the builder. Use the exact -Uri and -Token that
  # serve-candidate.mjs printed there -- that URI is built from its own
  # direct-link address (TOOLSENABLED_DIRECT_LINK_ADDRESSES there), so it is
  # not a fixed value and 192.0.2.2 below is only a documentation stand-in.
  powershell -File verify-candidate.ps1 `
    -Uri "http://192.0.2.2:4787/candidate" -Token "<token from A>" `
    -OutFile "ToolsEnabled Setup 1.0.2.exe" `
    -ExpectedBytes 100286107 -ExpectedSha256 "68082E56818047665EAD88CABD41C0843F535E1F77057C8DB428EFF6C7554560"

.EXAMPLE
  # Already-received file, filesystem hand-off:
  powershell -File verify-candidate.ps1 `
    -ExistingFile "D:\incoming\ToolsEnabled Setup 1.0.2.exe" `
    -ExpectedBytes 100286107 -ExpectedSha256 "68082E56818047665EAD88CABD41C0843F535E1F77057C8DB428EFF6C7554560"
#>
param(
  [string]$Uri,
  [string]$Token,
  [string]$OutFile,
  [string]$ExistingFile,
  [Parameter(Mandatory = $true)][int64]$ExpectedBytes,
  [Parameter(Mandatory = $true)][string]$ExpectedSha256
)

$ErrorActionPreference = 'Stop'

function Fail($message) {
  Write-Host "FAILED: $message" -ForegroundColor Red
  exit 1
}

if ($ExistingFile) {
  if (-not (Test-Path -LiteralPath $ExistingFile)) { Fail "file does not exist: $ExistingFile" }
  $targetPath = (Resolve-Path -LiteralPath $ExistingFile).Path
} elseif ($Uri -and $Token -and $OutFile) {
  Write-Host "Downloading from $Uri ..."
  try {
    Invoke-WebRequest -Uri $Uri -Headers @{ Authorization = "Bearer $Token" } -OutFile $OutFile -UseBasicParsing
  } catch {
    Fail "download failed: $($_.Exception.Message)"
  }
  $targetPath = (Resolve-Path -LiteralPath $OutFile).Path
} else {
  Fail 'pass either -ExistingFile <path>, or all of -Uri, -Token, and -OutFile.'
}

# Length and digest come from one read-only handle. This also works when a
# PowerShell 7 parent passes a PSModulePath that cannot load Get-FileHash in
# Windows PowerShell: verification does not depend on that optional module.
$stream = [IO.File]::Open($targetPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
  $actualBytes = $stream.Length
  Write-Host "File:          $targetPath"
  Write-Host "Expected bytes: $ExpectedBytes"
  Write-Host "Actual bytes:   $actualBytes"
  if ($actualBytes -ne $ExpectedBytes) {
    Fail "byte count mismatch. This is NOT the declared candidate -- do not proceed with testing it."
  }
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { $actualHash = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '') }
  finally { $hasher.Dispose() }
} finally { $stream.Dispose() }
Write-Host "Expected SHA-256: $ExpectedSha256"
Write-Host "Actual SHA-256:   $actualHash"

if ($actualHash.ToUpperInvariant() -ne $ExpectedSha256.ToUpperInvariant()) {
  Fail "SHA-256 mismatch. This is NOT the declared candidate -- do not proceed with testing it."
}

Write-Host ""
Write-Host "VERIFIED: $targetPath matches the declared candidate exactly (byte count and SHA-256 both confirmed independently)." -ForegroundColor Green
exit 0
