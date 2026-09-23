$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  $requestLine = [Console]::ReadLine()
  if (!$requestLine -or $requestLine.Length -gt 24000) { throw 'Invalid bounded desktop request.' }
  $request = $requestLine | ConvertFrom-Json
  if ($request.command -notin @('windows', 'inspect', 'action')) { throw 'Unsupported desktop request.' }
  if ($null -ne $request.includeText -and $request.includeText -isnot [bool]) { throw 'Invalid text inspection option.' }
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -AssemblyName UIAutomationClientSideProviders
  $null = [System.Windows.Automation.AutomationElement]::RootElement
  [System.Windows.Automation.ClientSettings]::RegisterClientSideProviders(
    [UIAutomationClientsideProviders.UIAutomationClientSideProviders]::ClientSideProviderDescriptionTable)
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class AccessibilityNative {
  public delegate bool EnumCallback(IntPtr handle, IntPtr unused);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCallback callback, IntPtr unused);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder text, int size);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref uint size);
  [StructLayout(LayoutKind.Sequential)] public struct Keyboard { public ushort key; public ushort scan; public uint flags; public uint time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit, Size=32)] public struct InputUnion { [FieldOffset(0)] public Keyboard keyboard; }
  [StructLayout(LayoutKind.Sequential)] public struct Input { public uint type; public InputUnion data; }
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, Input[] input, int size);
  public static long[] Windows() {
    var list = new List<long>();
    EnumWindows((handle, unused) => { if(IsWindowVisible(handle)) list.Add(handle.ToInt64()); return true; }, IntPtr.Zero);
    return list.ToArray();
  }
  public static string OwnedImage(uint pid, string sid) {
    IntPtr process=OpenProcess(0x1000, false, pid), token=IntPtr.Zero;
    if(process==IntPtr.Zero) return null;
    try {
      if(!OpenProcessToken(process, 8, out token)) return null;
      using(var identity=new WindowsIdentity(token)) { if(identity.User.Value != sid) return null; }
      var text=new StringBuilder(32768); uint size=32768;
      return QueryFullProcessImageName(process, 0, text, ref size) ? text.ToString() : null;
    } finally { if(token!=IntPtr.Zero) CloseHandle(token); CloseHandle(process); }
  }
  public static void Send(string text, int key, IntPtr confirmedWindow) {
    foreach(int modifier in new int[]{16,17,18,91,92}) if((GetAsyncKeyState(modifier)&0x8000)!=0) throw new Exception("Release modifier keys before trying again.");
    var entries=new List<Input>();
    if(text != null) foreach(char ch in text) {
      entries.Add(new Input{type=1, data=new InputUnion{keyboard=new Keyboard{scan=ch,flags=4}}});
      entries.Add(new Input{type=1, data=new InputUnion{keyboard=new Keyboard{scan=ch,flags=6}}});
    } else {
      entries.Add(new Input{type=1, data=new InputUnion{keyboard=new Keyboard{key=(ushort)key}}});
      entries.Add(new Input{type=1, data=new InputUnion{keyboard=new Keyboard{key=(ushort)key,flags=2}}});
    }
    var batch=entries.ToArray();
    if(GetForegroundWindow()!=confirmedWindow) throw new Exception("Focus changed before input. Nothing was sent.");
    if(batch.Length>0 && SendInput((uint)batch.Length,batch,Marshal.SizeOf(typeof(Input))) != batch.Length) throw new Exception("Windows did not accept all input; inspect before retrying.");
  }
}
'@
  $ownerSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $interactiveSession = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
  $blockedNames = '^(electron|toolsenabled.*|cmd|powershell|pwsh|wt|windowsterminal|conhost|explorer|totalcmd.*|consent|credentialuibroker|logonui|regedit|mmc|taskmgr)$'
  $blockedLabels = '(?i)password|passcode|credential|api.?key|secret|sign.?in|log.?in|permission|confirm|approve|accessibility'
  function Get-Snapshot([Int64]$handle) {
    try {
      if (![AccessibilityNative]::IsWindowVisible([IntPtr]$handle)) { return $null }
      [uint32]$targetPid = 0
      $null = [AccessibilityNative]::GetWindowThreadProcessId([IntPtr]$handle, [ref]$targetPid)
      if ($targetPid -eq [uint32]$request.appPid) { return $null }
      # Establish account ownership before reading the image path or UI text.
      $imagePath = [AccessibilityNative]::OwnedImage($targetPid, $ownerSid)
      if (!$imagePath) { return $null }
      if ($imagePath -match '^[a-z]:\\Users\\' -and !$imagePath.StartsWith(([string]$request.profileRoot).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { return $null }
      $targetProcess = [System.Diagnostics.Process]::GetProcessById([int]$targetPid)
      if ($targetProcess.SessionId -ne $interactiveSession) { return $null }
      $name = [IO.Path]::GetFileNameWithoutExtension($imagePath)
      if ($name -match $blockedNames) { return $null }
      $caption = New-Object System.Text.StringBuilder 512
      $null = [AccessibilityNative]::GetWindowText([IntPtr]$handle, $caption, 512)
      $title = $caption.ToString()
      if (!$title -or $title -match $blockedLabels -or $title -match '(?i)ToolsEnabled') { return $null }
      foreach ($match in [regex]::Matches($title, '(?i)[a-z]:[\\/]users[\\/][^\\/\s]+')) {
        if ($match.Value.Replace('/', '\') -ine [string]$request.profileRoot) { return $null }
      }
      return @{ handle = [string]$handle; pid = $targetPid; start = [string]$targetProcess.StartTime.ToUniversalTime().Ticks; name = $name; title = $title }
    } catch { return $null }
  }
  function Assert-Window {
    $current = Get-Snapshot ([Int64]$request.window.handle)
    if (!$current -or $current.pid -ne $request.window.pid -or $current.start -cne $request.window.start -or $current.title -cne $request.window.title -or $current.name -cne $request.window.name) {
      throw 'The window changed, closed or is not permitted. Inspect again.'
    }
    return $current
  }
  function Describe-Control($element) {
    try {
      $info = $element.Current
      if ($info.IsPassword -or !$info.IsEnabled -or $info.IsOffscreen) { $script:excludedCount++; return $null }
      $type = $info.ControlType.ProgrammaticName.Replace('ControlType.', '')
      $script:observedTypes += $type
      $label = if ($type -in @('Edit', 'Document')) {
        if ($info.LabeledBy) { $info.LabeledBy.Current.Name } else { 'Text field' }
      } else { $info.Name }
      if (!$label -or $label -match $blockedLabels) { return $null }
      $label = $label.Substring(0, [Math]::Min(240, $label.Length))
      $actions = @()
      $pattern = $null
      if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { $actions += 'click' }
      if ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) { $actions += 'select' }
      if ($element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) { $actions += 'toggle' }
      if ($element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern) -and $pattern.Current.ExpandCollapseState -ne [System.Windows.Automation.ExpandCollapseState]::LeafNode) { $actions += 'expand' }
      if ($element.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$pattern) -and ($pattern.Current.HorizontallyScrollable -or $pattern.Current.VerticallyScrollable)) { $actions += 'scroll' }
      $textMode = $null
      $pattern = $null
      if ($type -in @('Edit', 'Document')) {
        if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
          if (!$pattern.Current.IsReadOnly) { $textMode = 'replace' }
        } elseif ($info.IsKeyboardFocusable) {
          $textPattern = $null; $readOnly = $null
          if ($element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$textPattern)) {
            $readOnly = $textPattern.DocumentRange.GetAttributeValue([System.Windows.Automation.TextPattern]::IsReadOnlyAttribute)
          }
          if ($readOnly -ne $true) { $textMode = 'insert' }
        }
        if ($textMode) { $actions += @('type', 'key') }
      }
      $row = @{ runtimeId = ($element.GetRuntimeId() -join '.'); label = $label; type = $type; actions = @($actions); textMode = $textMode }
      # Read only on a requested inspection, never on execution's revalidation.
      # The password/name/visibility checks above precede either text API.
      if ($request.command -eq 'inspect' -and $request.includeText -and $type -in @('Edit', 'Document')) {
        $limit = [Math]::Min(2000, $script:textBudget)
        $textPattern = $null; $valuePattern = $null; $content = $null
        if ($element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$textPattern)) {
          $content = $textPattern.DocumentRange.GetText($limit + 1)
        } elseif ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
          $content = $valuePattern.Current.Value
        }
        if ($null -ne $content) {
          $row.text = $content.Substring(0, [Math]::Min($limit, $content.Length))
          $row.textTruncated = $content.Length -gt $limit
          $script:textBudget -= $row.text.Length
        }
      }
      if ($actions.Count -eq 0 -and !$row.ContainsKey('text')) { return $null }
      return $row
    } catch { throw }
  }
  function Read-Controls($windowRoot) {
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue($windowRoot)
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $count = 0; $visited = 0
    while ($queue.Count -gt 0 -and $count -lt 150 -and $visited -lt 600) {
      $element = $queue.Dequeue(); $visited++; $script:visitedCount++
      $row = Describe-Control $element
      if ($row) { $count++; @{ element = $element; row = $row } }
      $child = $walker.GetFirstChild($element)
      while ($child -and $queue.Count -lt 600) { $queue.Enqueue($child); $child = $walker.GetNextSibling($child) }
    }
  }
  function Focus-Target($element) {
    $null = Assert-Window
    $handle = [IntPtr][Int64]$request.window.handle
    if ([AccessibilityNative]::IsIconic($handle)) { $null = [AccessibilityNative]::ShowWindow($handle, 9) }
    $null = [AccessibilityNative]::SetForegroundWindow($handle)
    if ($element) { $element.SetFocus() }
    if ([AccessibilityNative]::GetForegroundWindow() -ne $handle) { throw 'Windows did not focus the confirmed window. No text was sent.' }
    if ($element -and (([System.Windows.Automation.AutomationElement]::FocusedElement.GetRuntimeId() -join '.') -cne $request.control.runtimeId)) { throw 'The confirmed field did not receive focus. No text was sent.' }
  }
  function Window-Actions($element) {
    $pattern = $null
    if (!$element.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$pattern)) { return }
    if ($pattern.Current.WindowInteractionState -eq [System.Windows.Automation.WindowInteractionState]::BlockedByModalWindow) { return }
    'restore'; 'close'
    if ($pattern.Current.CanMinimize) { 'minimize' }
    if ($pattern.Current.CanMaximize) { 'maximize' }
  }
  if ($request.command -eq 'windows') {
    $result = @([AccessibilityNative]::Windows() | ForEach-Object { Get-Snapshot $_ } | Select-Object -First 80)
  } else {
    $null = Assert-Window
    $windowRoot = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][Int64]$request.window.handle)
    if ($request.command -eq 'inspect') {
      $script:visitedCount = 0; $script:excludedCount = 0; $script:observedTypes = @()
      $script:textBudget = 12000
      $rows = @(Read-Controls $windowRoot | ForEach-Object { $_.row })
      $result = @{ controls = $rows; windowActions = @(Window-Actions $windowRoot); visited = $script:visitedCount; hiddenDisabledOrPassword = $script:excludedCount; types = $script:observedTypes }
    } elseif ($request.kind -eq 'focus') {
      Focus-Target $null
      $result = @{ status = 'completed' }
    } elseif ($request.kind -eq 'window') {
      if ($request.value -notin @(Window-Actions $windowRoot)) { throw 'The requested window action is not available.' }
      $windowPattern = $windowRoot.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
      $null = Assert-Window
      if ($request.value -eq 'close') {
        # Normal application close only. An unsaved-work dialog may remain;
        # never dismiss it automatically, kill a process or claim it exited.
        $windowPattern.Close()
        $result = @{ status = 'close-requested'; message = 'Normal close requested. Inspect again for an unsaved-work dialog or to verify closure.' }
      } else {
        $states = @{ minimize = [System.Windows.Automation.WindowVisualState]::Minimized; maximize = [System.Windows.Automation.WindowVisualState]::Maximized; restore = [System.Windows.Automation.WindowVisualState]::Normal }
        if (!$states.ContainsKey([string]$request.value)) { throw 'Unsupported window state.' }
        $wanted = $states[[string]$request.value]
        $windowPattern.SetWindowVisualState($wanted)
        # Providers can acknowledge before the Windows transition finishes.
        # Observe briefly, without repeating the command or changing focus.
        $transition = [Diagnostics.Stopwatch]::StartNew()
        while ($windowPattern.Current.WindowVisualState -ne $wanted -and $transition.ElapsedMilliseconds -lt 1000) {
          [Threading.Thread]::Sleep(20)
        }
        if ($windowPattern.Current.WindowVisualState -ne $wanted) { throw 'The window did not reach the requested state. Inspect before retrying.' }
        $null = Assert-Window
        $result = @{ status = 'completed'; windowState = [string]$request.value }
      }
    } else {
      $target = @(Read-Controls $windowRoot | Where-Object { $_.row.runtimeId -ceq $request.control.runtimeId }) | Select-Object -First 1
      if (!$target -or $target.row.label -cne $request.control.label -or $target.row.type -cne $request.control.type -or $target.row.textMode -cne $request.control.textMode -or $request.kind -notin $target.row.actions) {
        throw 'The confirmed control changed or is no longer available. Inspect again.'
      }
      $null = Assert-Window
      if ($request.kind -eq 'click') {
        $target.element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
      } elseif ($request.kind -eq 'type') {
        if ($request.text.Length -gt 2000 -or $request.text -match '(?i)[a-z]:[\\/]|\\\\|file:|%[a-z_]+%') { throw 'Unsupported desktop text.' }
        if ($target.row.textMode -eq 'replace') {
          $target.element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue([string]$request.text)
        } else {
          Focus-Target $target.element
          [AccessibilityNative]::Send([string]$request.text, 0, [IntPtr][Int64]$request.window.handle)
        }
      } elseif ($request.kind -eq 'key') {
        $keys = @{ Enter = 13; Tab = 9; Escape = 27; Backspace = 8; ArrowUp = 38; ArrowDown = 40; ArrowLeft = 37; ArrowRight = 39; Home = 36; End = 35; PageUp = 33; PageDown = 34; Delete = 46 }
        if (!$keys.ContainsKey([string]$request.value)) { throw 'Unsupported desktop key.' }
        Focus-Target $target.element
        [AccessibilityNative]::Send($null, $keys[[string]$request.value], [IntPtr][Int64]$request.window.handle)
      } elseif ($request.kind -eq 'select') {
        $selection = $target.element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
        $selection.Select()
        if (!$selection.Current.IsSelected) { throw 'The item did not become selected. Inspect before retrying.' }
      } elseif ($request.kind -eq 'toggle') {
        if ($request.value -notin @('on', 'off')) { throw 'Unsupported toggle state.' }
        $toggle = $target.element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
        $wanted = if ($request.value -eq 'on') { [System.Windows.Automation.ToggleState]::On } else { [System.Windows.Automation.ToggleState]::Off }
        # Explicit target state, not a blind inversion or an automatic retry.
        if ($toggle.Current.ToggleState -ne $wanted) { $toggle.Toggle() }
        if ($toggle.Current.ToggleState -ne $wanted) { throw 'The control did not reach the requested state. Inspect before retrying.' }
      } elseif ($request.kind -eq 'expand') {
        $expand = $target.element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
        if ($request.value -eq 'open') { $expand.Expand() }
        elseif ($request.value -eq 'closed') { $expand.Collapse() }
        else { throw 'Unsupported expansion state.' }
        $wanted = if ($request.value -eq 'open') { [System.Windows.Automation.ExpandCollapseState]::Expanded } else { [System.Windows.Automation.ExpandCollapseState]::Collapsed }
        if ($expand.Current.ExpandCollapseState -ne $wanted) { throw 'The control did not reach the requested expansion state. Inspect before retrying.' }
      } elseif ($request.kind -eq 'scroll') {
        $scroll = $target.element.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)
        $horizontal = [System.Windows.Automation.ScrollAmount]::NoAmount
        $vertical = [System.Windows.Automation.ScrollAmount]::NoAmount
        switch ($request.value) {
          'up' { $vertical = [System.Windows.Automation.ScrollAmount]::LargeDecrement }
          'down' { $vertical = [System.Windows.Automation.ScrollAmount]::LargeIncrement }
          'left' { $horizontal = [System.Windows.Automation.ScrollAmount]::LargeDecrement }
          'right' { $horizontal = [System.Windows.Automation.ScrollAmount]::LargeIncrement }
          default { throw 'Unsupported scroll direction.' }
        }
        $scroll.Scroll($horizontal, $vertical)
      } else { throw 'Unsupported desktop action.' }
      $result = @{ status = 'completed' }
    }
  }
  [Console]::WriteLine((@{ ok = $true; result = $result } | ConvertTo-Json -Depth 12 -Compress))
} catch {
  # Exceptions from an application provider can contain window content.
  [Console]::WriteLine((@{ ok = $false; error = 'Windows could not safely complete this request. Inspect before retrying. Helper line: ' + $_.InvocationInfo.ScriptLineNumber } | ConvertTo-Json -Compress))
  exit 1
}
