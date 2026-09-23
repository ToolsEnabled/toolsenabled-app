[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$QaRoot,
  [Parameter(Mandatory=$true)][string]$ExpectedProfileRoot,
  [Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$QaProcessId,
  [Parameter(Mandatory=$true)][string]$RequestPath,
  [Parameter(Mandatory=$true)][string]$ResultPath,
  [switch]$ValidateOnly
)

# This is an input driver for an already-owned QA process. It never discovers
# another account, launches a process, changes permissions, or ends a PID tree.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$safeResultPath = $null
$operation = $null
$nativeInputSent = $false

function Refuse([string]$Code, [string]$Message) {
  $errorObject = [InvalidOperationException]::new($Message)
  $errorObject.Data['code'] = $Code
  throw $errorObject
}

function NormalPath([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value) -or -not [IO.Path]::IsPathRooted($Value)) {
    Refuse 'QA_PATH_NOT_ABSOLUTE' 'An absolute QA path is required.'
  }
  $normal = [IO.Path]::GetFullPath($Value).TrimEnd('\')
  if ($normal.StartsWith('\\') -or $normal.Substring(2).Contains(':')) {
    Refuse 'QA_PATH_UNSUPPORTED' 'Network paths, device paths and alternate streams are refused.'
  }
  return $normal
}

function IsInside([string]$Value, [string]$Root) {
  return $Value.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)
}

function AssertBelow([string]$Value, [string]$Root, [bool]$AllowMissing = $false) {
  $normal = NormalPath $Value
  if (-not (IsInside $normal $Root)) { Refuse 'QA_PATH_OUTSIDE_ROOT' 'The path must be inside the owned QA root.' }
  # Lexical containment is checked BEFORE any filesystem call. Then check each
  # existing component without following a junction into an unrelated profile.
  $cursor = $Root
  $parts = $normal.Substring($Root.Length + 1).Split('\')
  foreach ($part in $parts) {
    $cursor = [IO.Path]::Combine($cursor, $part)
    if (-not (Test-Path -LiteralPath $cursor)) {
      if ($AllowMissing -and $cursor -eq $normal) { return $normal }
      Refuse 'QA_PATH_MISSING' 'A required QA path does not exist.'
    }
    $entry = Get-Item -LiteralPath $cursor -Force
    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $entry.LinkType -eq 'HardLink') {
      Refuse 'QA_PATH_LINK' 'Linked paths are refused by the native QA picker.'
    }
  }
  return $normal
}

function EmitResult($Value, [int]$ExitCode) {
  $json = $Value | ConvertTo-Json -Depth 7 -Compress
  if ($safeResultPath) { [IO.File]::WriteAllText($safeResultPath, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false)) }
  [Console]::Out.WriteLine($json)
  exit $ExitCode
}

try {
  # ExpectedProfileRoot is an assertion, not a way to select another account.
  $actualProfile = NormalPath ([Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile))
  $expectedProfile = NormalPath $ExpectedProfileRoot
  if (-not $expectedProfile.Equals($actualProfile, [StringComparison]::OrdinalIgnoreCase)) {
    Refuse 'QA_PROFILE_MISMATCH' 'The expected profile is not the current account profile.'
  }
  $profileItem = Get-Item -LiteralPath $actualProfile -Force
  if ($profileItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { Refuse 'QA_PATH_LINK' 'The current profile root is linked.' }
  $ownedRoot = AssertBelow $QaRoot $actualProfile
  if (-not (Get-Item -LiteralPath $ownedRoot).PSIsContainer) { Refuse 'QA_ROOT_NOT_DIRECTORY' 'The QA root must be a directory.' }
  $candidateResultPath = AssertBelow $ResultPath $ownedRoot $true
  if ((Test-Path -LiteralPath $candidateResultPath) -and (Get-Item -LiteralPath $candidateResultPath).PSIsContainer) { Refuse 'QA_RESULT_NOT_FILE' 'The result path must be a file.' }
  $safeResultPath = $candidateResultPath
  $safeRequestPath = AssertBelow $RequestPath $ownedRoot
  $requestFile = Get-Item -LiteralPath $safeRequestPath
  if ($requestFile.PSIsContainer -or $requestFile.Length -gt 65536) { Refuse 'QA_REQUEST_INVALID' 'The native request must be a bounded JSON file.' }
  $request = [IO.File]::ReadAllText($safeRequestPath) | ConvertFrom-Json
  $operation = [string]$request.operation
  if ($operation -notin @('inspect','select-path','cancel','dismiss-update','close-app','confirm-close')) {
    Refuse 'QA_OPERATION_UNKNOWN' 'The requested native operation is not supported.'
  }
  $selectedPath = $null
  if ($operation -eq 'select-path') { $selectedPath = AssertBelow ([string]$request.selectedPath) $ownedRoot }

  $qaProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $QaProcessId)
  if (-not $qaProcess) { Refuse 'QA_PROCESS_NOT_FOUND' 'The recorded QA process has ended.' }
  $owner = Invoke-CimMethod -InputObject $qaProcess -MethodName GetOwnerSid
  if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) {
    Refuse 'QA_PROCESS_OWNER_MISMATCH' 'The QA process is not owned by the current account.'
  }

  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Page2NativeMethods {
  [DllImport("shell32.dll", SetLastError=true)] public static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string cmd, out int count);
  [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr value);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint message, IntPtr w, string text);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint message, IntPtr w, IntPtr l);
}
'@
  $argumentCount = 0
  $argumentPointer = [Page2NativeMethods]::CommandLineToArgvW($qaProcess.CommandLine, [ref]$argumentCount)
  if ($argumentPointer -eq [IntPtr]::Zero) { Refuse 'QA_PROCESS_SCOPE_MISMATCH' 'The QA command line could not be read.' }
  $arguments = @()
  try {
    for ($index = 0; $index -lt $argumentCount; $index++) {
      $argument = [Runtime.InteropServices.Marshal]::ReadIntPtr($argumentPointer, $index * [IntPtr]::Size)
      $arguments += [Runtime.InteropServices.Marshal]::PtrToStringUni($argument)
    }
  } finally { $null = [Page2NativeMethods]::LocalFree($argumentPointer) }
  $userDataArguments = @()
  for ($index = 1; $index -lt $arguments.Count; $index++) {
    if ($arguments[$index].StartsWith('--user-data-dir=', [StringComparison]::OrdinalIgnoreCase)) { $userDataArguments += $arguments[$index].Substring(16) }
    elseif ($arguments[$index] -eq '--user-data-dir' -and $index + 1 -lt $arguments.Count) { $index++; $userDataArguments += $arguments[$index] }
  }
  if ($userDataArguments.Count -ne 1) { Refuse 'QA_PROCESS_SCOPE_MISMATCH' 'The QA process must have one explicit user-data directory.' }
  $qaUserData = AssertBelow $userDataArguments[0] $ownedRoot
  $desktopSession = [Diagnostics.Process]::GetCurrentProcess().SessionId
  if ($qaProcess.SessionId -ne $desktopSession) { Refuse 'QA_DESKTOP_SESSION_MISMATCH' 'Run the helper in the QA process desktop session.' }
  if ($ValidateOnly) {
    EmitResult ([ordered]@{ok=$true;code='QA_VALIDATED';operation=$operation;pid=$QaProcessId;qaRoot=$ownedRoot;userData=$qaUserData;desktopSession=$desktopSession;nativeInputSent=$false}) 0
  }
  if ($desktopSession -eq 0) { Refuse 'QA_DESKTOP_REQUIRED' 'Native input needs the owning interactive desktop session.' }

  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $processCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty, $QaProcessId)
  function OwnedWindows {
    return @([Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children, $processCondition))
  }
  function OwnedElements($Root) {
    return @($Root.FindAll([Windows.Automation.TreeScope]::Subtree, $processCondition))
  }
  function NativeButtons([string]$Name) {
    $found = @()
    foreach ($window in (OwnedWindows)) {
      $found += @(OwnedElements $window | Where-Object { $_.Current.Name -eq $Name -and $_.Current.NativeWindowHandle -ne 0 -and $_.Current.IsEnabled })
    }
    return @($found | Sort-Object { $_.Current.NativeWindowHandle } -Unique)
  }
  function PressNative($Button) {
    if (-not [Page2NativeMethods]::PostMessage([IntPtr]$Button.Current.NativeWindowHandle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)) {
      Refuse 'QA_NATIVE_INPUT_FAILED' 'Windows refused the native button press.'
    }
    $script:nativeInputSent = $true
  }
  $windows = OwnedWindows
  if (-not $windows.Count) { Refuse 'QA_WINDOW_NOT_FOUND' 'No window belongs to the recorded QA process.' }
  $windowFacts = @($windows | ForEach-Object {
    $nativeButtons = @(OwnedElements $_ | Where-Object {
      $_.Current.ControlType -eq [Windows.Automation.ControlType]::Button -and $_.Current.NativeWindowHandle -ne 0
    } | ForEach-Object { [ordered]@{name=$_.Current.Name;enabled=$_.Current.IsEnabled;automationId=$_.Current.AutomationId} })
    [ordered]@{title=$_.Current.Name;class=$_.Current.ClassName;enabled=$_.Current.IsEnabled;handle=$_.Current.NativeWindowHandle;buttons=$nativeButtons}
  })
  $action = 'inspected'
  if ($operation -in @('select-path','cancel')) {
    $candidates = @()
    foreach ($window in $windows) {
      $dialogs = @(OwnedElements $window | Where-Object { $_.Current.ClassName -eq '#32770' -and $_.Current.IsEnabled })
      foreach ($dialog in $dialogs) {
        if ($request.title -and $dialog.Current.Name -ne [string]$request.title) { continue }
        $elements = OwnedElements $dialog
        $edits = @($elements | Where-Object { $_.Current.ClassName -eq 'Edit' -and $_.Current.AutomationId -in @('1148','1152') -and $_.Current.IsEnabled })
        if ($edits.Count -eq 1) { $candidates += [pscustomobject]@{dialog=$dialog;edit=$edits[0];elements=$elements} }
      }
    }
    $candidates = @($candidates | Sort-Object { $_.dialog.Current.NativeWindowHandle } -Unique)
    if ($candidates.Count -ne 1) { Refuse 'QA_PICKER_AMBIGUOUS' 'Expected exactly one enabled native QA picker.' }
    $candidate = $candidates[0]
    $buttonId = '2'
    if ($operation -eq 'select-path') {
      $isFolder = (Get-Item -LiteralPath $selectedPath).PSIsContainer
      $expectedEditId = if ($isFolder) { '1152' } else { '1148' }
      if ($candidate.edit.Current.AutomationId -ne $expectedEditId) { Refuse 'QA_PICKER_KIND_MISMATCH' 'The selected path does not match the open picker kind.' }
      $null = [Page2NativeMethods]::SendMessage([IntPtr]$candidate.edit.Current.NativeWindowHandle, 0x000C, [IntPtr]::Zero, $selectedPath)
      $nativeInputSent = $true
      $buttonId = '1'
    }
    $buttons = @($candidate.elements | Where-Object { $_.Current.ClassName -eq 'Button' -and $_.Current.AutomationId -eq $buttonId -and $_.Current.IsEnabled })
    if ($buttons.Count -ne 1) { Refuse 'QA_PICKER_BUTTON_MISSING' 'The expected native picker button is absent.' }
    PressNative $buttons[0]
    $action = if ($operation -eq 'cancel') { 'picker-cancel-requested' } else { 'path-submitted' }
  }
  elseif ($operation -in @('dismiss-update','confirm-close')) {
    $name = if ($operation -eq 'dismiss-update') { 'Not now' } else { 'Close and end them' }
    $buttons = @(NativeButtons $name)
    if ($buttons.Count -ne 1) { Refuse 'QA_NATIVE_BUTTON_AMBIGUOUS' 'Expected exactly one matching QA dialog button.' }
    PressNative $buttons[0]
    $action = 'dialog-button-pressed'
  }
  elseif ($operation -eq 'close-app') {
    $mainWindows = @($windows | Where-Object { $_.Current.ClassName -eq 'Chrome_WidgetWin_1' })
    if ($mainWindows.Count -ne 1) { Refuse 'QA_MAIN_WINDOW_AMBIGUOUS' 'Expected exactly one QA main window.' }
    if (-not [Page2NativeMethods]::PostMessage([IntPtr]$mainWindows[0].Current.NativeWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) { Refuse 'QA_NATIVE_INPUT_FAILED' 'Windows refused the QA close request.' }
    $nativeInputSent = $true
    $action = 'close-requested'
    # Close is already authorized for this exact QA process. Handle its warning
    # without closing unrelated windows or changing the persistent warning pref.
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
      Start-Sleep -Milliseconds 100
      if (-not (Get-Process -Id $QaProcessId -ErrorAction SilentlyContinue)) { break }
      $buttons = @(NativeButtons 'Close and end them')
      if ($buttons.Count -eq 1) { PressNative $buttons[0]; $action = 'close-confirmed'; break }
      if ($buttons.Count -gt 1) { Refuse 'QA_NATIVE_BUTTON_AMBIGUOUS' 'Multiple QA close warnings are open.' }
    }
  }
  EmitResult ([ordered]@{ok=$true;at=[DateTime]::UtcNow.ToString('o');operation=$operation;pid=$QaProcessId;qaRoot=$ownedRoot;userData=$qaUserData;desktopSession=$desktopSession;action=$action;selectedPath=$selectedPath;windows=$windowFacts;nativeInputSent=$nativeInputSent}) 0
} catch {
  $code = [string]$_.Exception.Data['code']
  if (-not $code) { $code = 'QA_NATIVE_ERROR' }
  EmitResult ([ordered]@{ok=$false;at=[DateTime]::UtcNow.ToString('o');operation=$operation;pid=$QaProcessId;code=$code;error=$_.Exception.Message;nativeInputSent=$nativeInputSent}) 1
}
