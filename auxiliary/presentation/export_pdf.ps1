param(
  [Parameter(Mandatory=$true)][string]$Path,
  [Parameter(Mandatory=$true)][string]$OutPath,
  [switch]$KeepAlive
)

# Export a .pptx to PDF using PowerPoint COM without showing a window.
# A running PowerPoint instance may be reused, but is never quit by this
# script. A newly activated instance is quit only when PID differencing proves
# exactly one new POWERPNT process and -KeepAlive was not requested.
$ErrorActionPreference = 'Stop'

function CurrentPowerPointPids {
  @(Get-Process -Name 'POWERPNT' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
}

function Release-ComObject($value) {
  if ($null -ne $value) {
    try {
      if ([Runtime.InteropServices.Marshal]::IsComObject($value)) {
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($value)
      }
    } catch {}
  }
}

function Get-LiteralSourcePath($value) {
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw 'Path must be a nonempty file-system path'
  }
  try {
    $item = Get-Item -LiteralPath $value -ErrorAction Stop
  } catch {
    throw "Path does not exist or cannot be read: $value"
  }
  if ($item.PSProvider.Name -ne 'FileSystem' -or $item.PSIsContainer) {
    throw "Path must identify a file: $value"
  }
  return $item.FullName
}

function Get-LiteralOutputPath($value) {
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw 'OutPath must be a nonempty file-system path'
  }
  try {
    $fullPath = [IO.Path]::GetFullPath($value)
  } catch {
    throw "OutPath is not a valid file-system path: $value"
  }
  if ([IO.Directory]::Exists($fullPath)) {
    throw "OutPath identifies a directory: $fullPath"
  }
  return $fullPath
}

function Commit-StagedFile([string]$stagedPath, [string]$finalPath) {
  if (-not [IO.File]::Exists($stagedPath)) {
    throw "staged PDF is missing: $stagedPath"
  }
  if ([IO.Directory]::Exists($finalPath)) {
    throw "PDF destination identifies a directory: $finalPath"
  }
  if ([IO.File]::Exists($finalPath)) {
    $backupPath = [IO.Path]::Combine(
      [IO.Path]::GetDirectoryName($finalPath),
      ('.pdf-backup-' + [guid]::NewGuid().ToString('N'))
    )
    try {
      [IO.File]::Replace($stagedPath, $finalPath, $backupPath, $true)
    } finally {
      if ([IO.File]::Exists($backupPath)) {
        try { [IO.File]::Delete($backupPath) } catch {}
      }
    }
  } else {
    [IO.File]::Move($stagedPath, $finalPath)
  }
}

$sourcePath = Get-LiteralSourcePath $Path
$finalPath = Get-LiteralOutputPath $OutPath
if ([string]::Equals($sourcePath, $finalPath, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'OutPath must not overwrite the source presentation'
}

$outputDirectory = [IO.Path]::GetDirectoryName($finalPath)
[void][IO.Directory]::CreateDirectory($outputDirectory)
$stagePath = [IO.Path]::Combine(
  $outputDirectory,
  ('.pdf-stage-' + [guid]::NewGuid().ToString('N') + '.pdf')
)

$app = $null
$ownsApp = $false
$exportSucceeded = $false
$pres = $null
$presentations = $null
try {
  try {
    $app = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application')
  } catch {}

  if ($null -eq $app) {
    $before = CurrentPowerPointPids
    $app = New-Object -ComObject PowerPoint.Application
    $after = CurrentPowerPointPids
    $newPids = @($after | Where-Object { $before -notcontains $_ })
    $ownsApp = ($newPids.Count -eq 1)
  }

  $presentations = $app.Presentations
  $pres = $presentations.Open($sourcePath, -1, 0, 0)
  Release-ComObject $presentations
  $presentations = $null

  $ppSaveAsPDF = 32
  $pres.SaveAs($stagePath, $ppSaveAsPDF)
  if (-not [IO.File]::Exists($stagePath) -or ([IO.FileInfo]$stagePath).Length -le 0) {
    throw 'PowerPoint did not produce a PDF'
  }

  Commit-StagedFile $stagePath $finalPath
  $exportSucceeded = $true
  Write-Output "exported pdf -> $finalPath"
} finally {
  if ($null -ne $pres) {
    try { $pres.Close() } catch {}
    Release-ComObject $pres
  }
  Release-ComObject $presentations

  if ($null -ne $app) {
    # KeepAlive is useful only after a successful export. If activation
    # created PowerPoint but the job failed, quit it instead of leaking a
    # hidden process that has nothing useful to reuse.
    if ($ownsApp -and (-not $KeepAlive -or -not $exportSucceeded)) {
      try { $app.Quit() } catch {}
    }
    Release-ComObject $app
  }

  if ([IO.File]::Exists($stagePath)) {
    try { [IO.File]::Delete($stagePath) } catch {}
  }
}
