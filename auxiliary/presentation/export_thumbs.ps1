param(
  [Parameter(Mandatory=$true)][string]$Path,
  [Parameter(Mandatory=$true)][string]$OutDir,
  [ValidateRange(1, 10000)][int]$Width = 1280,
  [switch]$KeepAlive
)

# Export every slide of a .pptx to PNG using PowerPoint COM without showing a
# window. All PNGs are staged before any live thumbnail is replaced.
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

function Get-LiteralOutputDirectoryPath($value) {
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw 'OutDir must be a nonempty file-system path'
  }
  try {
    $fullPath = [IO.Path]::GetFullPath($value)
  } catch {
    throw "OutDir is not a valid file-system path: $value"
  }
  if ([IO.File]::Exists($fullPath)) {
    throw "OutDir identifies a file, not a directory: $fullPath"
  }
  return $fullPath
}

function New-StagingDirectory([string]$outDir) {
  while ($true) {
    $candidate = [IO.Path]::Combine($outDir, ('.thumbs-stage-' + [guid]::NewGuid().ToString('N')))
    if (-not [IO.Directory]::Exists($candidate) -and -not [IO.File]::Exists($candidate)) {
      [void][IO.Directory]::CreateDirectory($candidate)
      return $candidate
    }
  }
}

function Remove-StagingDirectory([string]$stageDir, [string]$outDir) {
  if ([string]::IsNullOrWhiteSpace($stageDir) -or -not [IO.Directory]::Exists($stageDir)) {
    return
  }
  try {
    $actualParent = [IO.Path]::GetFullPath([IO.Path]::GetDirectoryName($stageDir))
    $expectedParent = [IO.Path]::GetFullPath($outDir)
    if ([string]::Equals($actualParent, $expectedParent, [StringComparison]::OrdinalIgnoreCase)) {
      [IO.Directory]::Delete($stageDir, $true)
    }
  } catch {}
}

function Commit-StagedFiles($items, [string]$stageDir) {
  $committed = New-Object 'System.Collections.Generic.List[object]'
  try {
    foreach ($item in $items) {
      if (-not [IO.File]::Exists($item.Staged)) {
        throw "staged export is missing: $($item.Staged)"
      }
      if ([IO.Directory]::Exists($item.Final)) {
        throw "thumbnail destination identifies a directory: $($item.Final)"
      }

      $hadExisting = [IO.File]::Exists($item.Final)
      $backup = $null
      if ($hadExisting) {
        $backup = [IO.Path]::Combine($stageDir, ('.backup-' + [guid]::NewGuid().ToString('N')))
        [IO.File]::Replace($item.Staged, $item.Final, $backup, $true)
      } else {
        [IO.File]::Move($item.Staged, $item.Final)
      }
      [void]$committed.Add([pscustomobject]@{
        Final = $item.Final
        Backup = $backup
        HadExisting = $hadExisting
      })
    }
  } catch {
    $commitError = $_.Exception
    for ($index = $committed.Count - 1; $index -ge 0; $index--) {
      $entry = $committed[$index]
      try {
        if ($entry.HadExisting -and [IO.File]::Exists($entry.Backup)) {
          if ([IO.File]::Exists($entry.Final)) {
            $discard = [IO.Path]::Combine($stageDir, ('.rollback-' + [guid]::NewGuid().ToString('N')))
            [IO.File]::Replace($entry.Backup, $entry.Final, $discard, $true)
          } else {
            [IO.File]::Move($entry.Backup, $entry.Final)
          }
        } elseif (-not $entry.HadExisting -and [IO.File]::Exists($entry.Final)) {
          [IO.File]::Delete($entry.Final)
        }
      } catch {}
    }
    throw $commitError
  }
}

$sourcePath = Get-LiteralSourcePath $Path
$outputDirectory = Get-LiteralOutputDirectoryPath $OutDir
[void][IO.Directory]::CreateDirectory($outputDirectory)

$app = $null
$ownsApp = $false
$exportSucceeded = $false
$pres = $null
$presentations = $null
$slides = $null
$pageSetup = $null
$stageDir = $null
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

  $slides = $pres.Slides
  $slideCount = [int]$slides.Count
  if ($slideCount -lt 1) {
    throw 'source presentation has no slides'
  }

  $pageSetup = $pres.PageSetup
  $slideWidth = [double]$pageSetup.SlideWidth
  $slideHeight = [double]$pageSetup.SlideHeight
  Release-ComObject $pageSetup
  $pageSetup = $null
  if ($slideWidth -le 0 -or $slideHeight -le 0) {
    throw 'source presentation has invalid slide dimensions'
  }
  $height = [int][Math]::Round($Width * $slideHeight / $slideWidth)
  if ($height -lt 1) {
    throw 'calculated thumbnail height is invalid'
  }

  $stageDir = New-StagingDirectory $outputDirectory
  $commitItems = New-Object 'System.Collections.Generic.List[object]'
  for ($index = 1; $index -le $slideCount; $index++) {
    $fileName = 'slide-{0}.png' -f $index
    $stagedPath = [IO.Path]::Combine($stageDir, $fileName)
    $finalPath = [IO.Path]::Combine($outputDirectory, $fileName)
    $slide = $null
    try {
      $slide = $slides.Item($index)
      $slide.Export($stagedPath, 'PNG', $Width, $height)
    } finally {
      Release-ComObject $slide
    }
    if (-not [IO.File]::Exists($stagedPath) -or ([IO.FileInfo]$stagedPath).Length -le 0) {
      throw "PowerPoint did not produce thumbnail for slide $index"
    }
    [void]$commitItems.Add([pscustomobject]@{ Staged = $stagedPath; Final = $finalPath })
  }

  Commit-StagedFiles $commitItems $stageDir
  $exportSucceeded = $true
  Write-Output "exported $slideCount slides -> $outputDirectory"
} finally {
  Remove-StagingDirectory $stageDir $outputDirectory
  Release-ComObject $pageSetup
  Release-ComObject $slides
  if ($null -ne $pres) {
    try { $pres.Close() } catch {}
    Release-ComObject $pres
  }
  Release-ComObject $presentations

  if ($null -ne $app) {
    if ($ownsApp -and (-not $KeepAlive -or -not $exportSucceeded)) {
      try { $app.Quit() } catch {}
    }
    Release-ComObject $app
  }
}
