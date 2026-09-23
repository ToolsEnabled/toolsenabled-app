# Persistent PowerPoint COM host for thumbnail export.
#
# Holds one PowerPoint application for the process lifetime. Jobs and replies
# are newline-delimited JSON.
#
# Job:   {"id":1,"cmd":"thumbs","src":"...pptx","outDir":"...","width":1100,"slides":[1,4,7]}
#        "slides" omitted, null, or empty -> export every slide.
# Reply (ready):  {"id":0,"ok":true,"ready":true,"ms":N,"psPid":N,"powerpointPid":N|null}
# Reply (job):    {"id":N,"ok":true,"ms":N,"open":N,"export":N,"count":N}
#              or {"id":N,"ok":false,"error":"...","ms":N}
#
# Shutdown: send the literal line "quit", or close stdin. This host calls
# Application.Quit() only when PID differencing proved that its COM activation
# created exactly one new POWERPNT process. If COM attached to a user's
# existing PowerPoint instance, only this host's RCW is released.

$ErrorActionPreference = 'Stop'
$app = $null
$ownsApp = $false
$powerPointPid = $null
$MaxExportWidth = 10000

function Reply($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

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
  if (-not ($value -is [string]) -or [string]::IsNullOrWhiteSpace($value)) {
    throw 'src must be a nonempty file-system path'
  }

  try {
    $item = Get-Item -LiteralPath $value -ErrorAction Stop
  } catch {
    throw "src does not exist or cannot be read: $value"
  }

  if ($item.PSProvider.Name -ne 'FileSystem' -or $item.PSIsContainer) {
    throw "src must identify a file: $value"
  }
  return $item.FullName
}

function Get-LiteralOutputDirectoryPath($value) {
  if (-not ($value -is [string]) -or [string]::IsNullOrWhiteSpace($value)) {
    throw 'outDir must be a nonempty file-system path'
  }

  try {
    $fullPath = [IO.Path]::GetFullPath($value)
  } catch {
    throw "outDir is not a valid file-system path: $value"
  }

  if ([IO.File]::Exists($fullPath)) {
    throw "outDir identifies a file, not a directory: $fullPath"
  }
  return $fullPath
}

function Get-StrictInteger($value, [string]$name, [int]$minimum, [int]$maximum) {
  if ($null -eq $value -or $value -is [bool] -or $value -is [string] -or $value -is [char]) {
    throw "$name must be an integer from $minimum through $maximum"
  }

  $numericTypeCodes = @(
    [TypeCode]::Byte,
    [TypeCode]::SByte,
    [TypeCode]::Int16,
    [TypeCode]::UInt16,
    [TypeCode]::Int32,
    [TypeCode]::UInt32,
    [TypeCode]::Int64,
    [TypeCode]::UInt64,
    [TypeCode]::Single,
    [TypeCode]::Double,
    [TypeCode]::Decimal
  )
  if ($numericTypeCodes -notcontains [Type]::GetTypeCode($value.GetType())) {
    throw "$name must be an integer from $minimum through $maximum"
  }

  try {
    $number = [decimal]$value
  } catch {
    throw "$name must be an integer from $minimum through $maximum"
  }
  if ([decimal]::Truncate($number) -ne $number -or $number -lt $minimum -or $number -gt $maximum) {
    throw "$name must be an integer from $minimum through $maximum"
  }
  return [int]$number
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
            # Windows PowerShell's .NET Framework File.Replace overload does
            # not accept a null backup path. Keep the displaced failed output
            # in staging until the transaction cleanup removes it.
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

try {
  $startupTimer = [Diagnostics.Stopwatch]::StartNew()
  $before = CurrentPowerPointPids
  $app = New-Object -ComObject PowerPoint.Application
  $after = CurrentPowerPointPids
  $newPids = @($after | Where-Object { $before -notcontains $_ })

  # A single new PID is the only ownership signal strong enough to authorize
  # Application.Quit(). Zero means COM may have attached to a user's instance;
  # multiple means the process race was ambiguous.
  if ($newPids.Count -eq 1) {
    $ownsApp = $true
    $powerPointPid = $newPids[0]
  }

  Reply @{
    id = 0
    ok = $true
    ready = $true
    ms = $startupTimer.ElapsedMilliseconds
    psPid = $PID
    powerpointPid = $powerPointPid
  }

  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line -eq '') { continue }
    if ($line -ceq 'quit') { break }

    $job = $null
    $jobId = $null
    try {
      $job = $line | ConvertFrom-Json -ErrorAction Stop
      if ($null -eq $job) {
        throw 'job must be a JSON object'
      }
      $idProperty = $job.PSObject.Properties['id']
      if ($null -ne $idProperty) {
        $jobId = $idProperty.Value
      }
    } catch {
      Reply @{ id = $jobId; ok = $false; error = "bad job json: $($_.Exception.Message)" }
      continue
    }

    $jobTimer = [Diagnostics.Stopwatch]::StartNew()
    $pres = $null
    $presentations = $null
    $slides = $null
    $pageSetup = $null
    $stageDir = $null
    try {
      $cmdProperty = $job.PSObject.Properties['cmd']
      if ($null -eq $cmdProperty -or -not ($cmdProperty.Value -is [string]) -or
          -not [string]::Equals($cmdProperty.Value, 'thumbs', [StringComparison]::Ordinal)) {
        throw "unsupported job cmd; expected 'thumbs'"
      }

      $srcProperty = $job.PSObject.Properties['src']
      $outDirProperty = $job.PSObject.Properties['outDir']
      if ($null -eq $srcProperty) { throw 'src is required' }
      if ($null -eq $outDirProperty) { throw 'outDir is required' }
      $src = Get-LiteralSourcePath $srcProperty.Value
      $outDir = Get-LiteralOutputDirectoryPath $outDirProperty.Value

      $widthProperty = $job.PSObject.Properties['width']
      if ($null -eq $widthProperty) {
        $width = 1100
      } else {
        $width = Get-StrictInteger $widthProperty.Value 'width' 1 $MaxExportWidth
      }

      $presentations = $app.Presentations
      $pres = $presentations.Open($src, -1, 0, 0)
      Release-ComObject $presentations
      $presentations = $null
      $openMilliseconds = $jobTimer.ElapsedMilliseconds

      $slides = $pres.Slides
      $slideCount = [int]$slides.Count
      if ($slideCount -lt 1) {
        throw 'source presentation has no slides'
      }

      $slidesProperty = $job.PSObject.Properties['slides']
      $rawTargets = @()
      if ($null -ne $slidesProperty -and $null -ne $slidesProperty.Value) {
        $rawTargets = @($slidesProperty.Value)
      }

      if ($rawTargets.Count -eq 0) {
        $targets = @(1..$slideCount)
      } else {
        $targetsList = New-Object 'System.Collections.Generic.List[int]'
        $seenTargets = New-Object 'System.Collections.Generic.HashSet[int]'
        foreach ($rawTarget in $rawTargets) {
          $target = Get-StrictInteger $rawTarget 'slide number' 1 $slideCount
          if ($seenTargets.Add($target)) {
            [void]$targetsList.Add($target)
          }
        }
        $targets = @($targetsList)
      }

      $pageSetup = $pres.PageSetup
      $slideWidth = [double]$pageSetup.SlideWidth
      $slideHeight = [double]$pageSetup.SlideHeight
      Release-ComObject $pageSetup
      $pageSetup = $null
      if ($slideWidth -le 0 -or $slideHeight -le 0) {
        throw 'source presentation has invalid slide dimensions'
      }
      $height = [int][Math]::Round($width * $slideHeight / $slideWidth)
      if ($height -lt 1 -or $height -gt [int]::MaxValue) {
        throw 'calculated thumbnail height is invalid'
      }

      [void][IO.Directory]::CreateDirectory($outDir)
      $stageDir = New-StagingDirectory $outDir
      $commitItems = New-Object 'System.Collections.Generic.List[object]'

      foreach ($target in $targets) {
        $fileName = 'slide-{0}.png' -f $target
        $stagedPath = [IO.Path]::Combine($stageDir, $fileName)
        $finalPath = [IO.Path]::Combine($outDir, $fileName)
        $slide = $null
        try {
          $slide = $slides.Item($target)
          $slide.Export($stagedPath, 'PNG', $width, $height)
        } finally {
          Release-ComObject $slide
        }
        if (-not [IO.File]::Exists($stagedPath) -or ([IO.FileInfo]$stagedPath).Length -le 0) {
          throw "PowerPoint did not produce thumbnail for slide $target"
        }
        [void]$commitItems.Add([pscustomobject]@{ Staged = $stagedPath; Final = $finalPath })
      }

      # No live output is touched until every requested slide has exported.
      Commit-StagedFiles $commitItems $stageDir
      $exportMilliseconds = $jobTimer.ElapsedMilliseconds
      Reply @{
        id = $jobId
        ok = $true
        ms = $exportMilliseconds
        open = $openMilliseconds
        export = ($exportMilliseconds - $openMilliseconds)
        count = $targets.Count
        width = $width
        height = $height
      }
    } catch {
      Reply @{
        id = $jobId
        ok = $false
        error = $_.Exception.Message
        ms = $jobTimer.ElapsedMilliseconds
      }
    } finally {
      Remove-StagingDirectory $stageDir $outDir
      Release-ComObject $pageSetup
      Release-ComObject $slides
      if ($null -ne $pres) {
        try { $pres.Close() } catch {}
        Release-ComObject $pres
      }
      Release-ComObject $presentations
    }
  }
} catch {
  try {
    Reply @{ id = 0; ok = $false; ready = $false; error = $_.Exception.Message }
  } catch {}
} finally {
  if ($null -ne $app) {
    if ($ownsApp) {
      try { $app.Quit() } catch {}
    }
    Release-ComObject $app
  }
}
