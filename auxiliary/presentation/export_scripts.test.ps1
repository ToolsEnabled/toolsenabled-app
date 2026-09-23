$ErrorActionPreference = 'Stop'

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Failures = New-Object 'System.Collections.Generic.List[string]'
$Passed = 0

function Check([bool]$condition, [string]$message) {
  if ($condition) {
    $script:Passed++
    Write-Output "PASS  $message"
  } else {
    [void]$script:Failures.Add($message)
    Write-Output "FAIL  $message"
  }
}

function Import-PureFunctions([string]$path, [string[]]$names) {
  $tokens = $null
  $errors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile(
    $path, [ref]$tokens, [ref]$errors
  )
  Check ($errors.Count -eq 0) ("{0} has no parse errors" -f [IO.Path]::GetFileName($path))
  foreach ($name in $names) {
    $definition = $ast.FindAll({
      param($node)
      $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq $name
    }, $true) | Select-Object -First 1
    if ($null -eq $definition) {
      throw "function $name was not found in $path"
    }
    $parameters = ($definition.Parameters | ForEach-Object { $_.Extent.Text }) -join ', '
    Invoke-Expression ("function global:{0}({1}) {2}" -f
      $name, $parameters, $definition.Body.Extent.Text)
  }
}

$ComHostPath = Join-Path $Here 'com_host.ps1'
$PdfPath = Join-Path $Here 'export_pdf.ps1'
$ThumbsPath = Join-Path $Here 'export_thumbs.ps1'

Import-PureFunctions $ComHostPath @(
  'Get-LiteralSourcePath',
  'Get-StrictInteger',
  'Commit-StagedFiles'
)
Import-PureFunctions $PdfPath @()
Import-PureFunctions $ThumbsPath @()

$root = [IO.Path]::Combine(
  [IO.Path]::GetTempPath(),
  ('suite-export-script-test-' + [guid]::NewGuid().ToString('N'))
)
[void][IO.Directory]::CreateDirectory($root)
try {
  $bracketPath = [IO.Path]::Combine($root, 'deck[final].pptx')
  [IO.File]::WriteAllText($bracketPath, 'fixture')
  Check (
    [string]::Equals(
      (Get-LiteralSourcePath $bracketPath),
      [IO.Path]::GetFullPath($bracketPath),
      [StringComparison]::OrdinalIgnoreCase
    )
  ) 'literal source paths preserve wildcard characters'

  Check ((Get-StrictInteger 3 'value' 1 10) -eq 3) 'strict integer accepts an in-range integer'
  foreach ($bad in @('3', 3.5, $true, 0, 11)) {
    $threw = $false
    try { [void](Get-StrictInteger $bad 'value' 1 10) } catch { $threw = $true }
    Check $threw ("strict integer rejects {0}" -f ($bad | ConvertTo-Json -Compress))
  }

  $stage = [IO.Path]::Combine($root, 'stage')
  [void][IO.Directory]::CreateDirectory($stage)
  $finalOne = [IO.Path]::Combine($root, 'slide-1.png')
  $stagedOne = [IO.Path]::Combine($stage, 'slide-1.png')
  $stagedTwo = [IO.Path]::Combine($stage, 'slide-2.png')
  $badFinal = [IO.Path]::Combine($root, 'destination-is-a-directory')
  [void][IO.Directory]::CreateDirectory($badFinal)
  [IO.File]::WriteAllText($finalOne, 'old')
  [IO.File]::WriteAllText($stagedOne, 'new')
  [IO.File]::WriteAllText($stagedTwo, 'second')
  $items = @(
    [pscustomobject]@{ Staged = $stagedOne; Final = $finalOne },
    [pscustomobject]@{ Staged = $stagedTwo; Final = $badFinal }
  )
  $commitThrew = $false
  try { Commit-StagedFiles $items $stage } catch { $commitThrew = $true }
  Check $commitThrew 'thumbnail batch commit surfaces a mid-batch failure'
  Check (([IO.File]::ReadAllText($finalOne)) -eq 'old') 'thumbnail batch rollback restores prior output'

  foreach ($path in @($ComHostPath, $PdfPath, $ThumbsPath)) {
    $source = [IO.File]::ReadAllText($path)
    Check ($source.Contains('FinalReleaseComObject')) (
      "{0} releases COM RCWs" -f [IO.Path]::GetFileName($path)
    )
    Check ($source.Contains('$ownsApp')) (
      "{0} tracks application ownership" -f [IO.Path]::GetFileName($path)
    )
  }
  $hostSource = [IO.File]::ReadAllText($ComHostPath)
  Check ($hostSource.Contains("unsupported job cmd; expected 'thumbs'")) 'COM host rejects unknown commands'
} finally {
  $fullRoot = [IO.Path]::GetFullPath($root)
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if ($fullRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and
      [IO.Path]::GetFileName($fullRoot).StartsWith('suite-export-script-test-')) {
    [IO.Directory]::Delete($fullRoot, $true)
  }
}

Write-Output ""
Write-Output ("{0} passed, {1} failed" -f $Passed, $Failures.Count)
if ($Failures.Count -gt 0) {
  foreach ($failure in $Failures) { Write-Error $failure }
  exit 1
}
