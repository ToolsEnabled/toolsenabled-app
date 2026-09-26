# THE JOB OBJECT HOLDER: starts one process inside a Windows Job Object with
# JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, captures its stdout+stderr to a file,
# records start and exit in lifecycle.jsonl, and ends every descendant when
# the root dies.
#
# HOW THE ROOT'S DEATH ENDS ITS DESCENDANTS, AND WHY THIS SCRIPT'S DEATH DOES
# NOT END THE ROOT (the (g) design decision, chosen consciously):
#
#   A job with KILL_ON_JOB_CLOSE terminates every member when the LAST handle
#   to the job closes. If the only handle lived here, killing this script would
#   kill the app -- the app would depend on its wrapper, which is forbidden.
#   So the job handle is DUPLICATED INTO THE ROOT PROCESS ITSELF
#   (DuplicateHandle into Electron's handle table; Electron never learns of
#   it). Now:
#     - this script dies first  -> Electron still holds a handle; the job and
#                                  the app live on. Verified by the test
#                                  "holder killed, root keeps running".
#     - Electron dies (any way) -> the kernel closes its handle table, that
#                                  was the last handle, the job closes, every
#                                  descendant is terminated by the kernel. No
#                                  user-mode code has to be alive for this.
#   While this script IS alive it additionally waits on the root, lists the
#   surviving members (evidence: "these would have outlived it"), terminates
#   the job explicitly and writes the exit record with the code and its
#   meaning. Losing this script therefore loses the exit RECORD, never the
#   app and never the descendant kill.
#
#   The trade-off rejected: a tiny long-lived wrapper as the sole handle
#   holder. It is simpler, but a single Stop-Process on the wrapper (the
#   supervisor stops processes by command-line match) would take the owner's
#   app with it, silently, which is the exact class of death this
#   investigation exists to end.
#
# THE ROOT STARTS SUSPENDED and is assigned to the job before its first
# instruction runs, so no child can be created outside the job. Its stdout and
# stderr are ONE file handle opened for append (FILE_APPEND_DATA without
# FILE_WRITE_DATA: every WriteFile lands at the end, whichever process writes),
# inherited by every Chromium child that keeps the standard handles.
#
# Output: JSON lines appended to -Lifecycle (LF-terminated, UTF-8 no BOM).
# Never edit lifecycle.jsonl by hand.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $CommandLine,
  [Parameter(Mandatory = $true)] [string] $WorkingDirectory,
  [Parameter(Mandatory = $true)] [string] $LogDir,
  [Parameter(Mandatory = $true)] [string] $Stamp,
  [Parameter(Mandatory = $true)] [string] $LaunchId,
  [Parameter(Mandatory = $true)] [string] $Lifecycle,
  [string] $JobName = '',
  [string] $Watchdog = '',
  [string] $AppDir = '',
  [string] $UserDataDir = '',
  [string] $Electron = '',
  [string] $ChromiumLog = '',
  [int] $Port = 0,
  [switch] $NoDuplicate
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

function Write-Record([hashtable] $fields) {
  $ordered = [ordered]@{}
  $ordered['event'] = $fields['event']
  $ordered['at'] = [DateTime]::UtcNow.ToString('o')
  $ordered['launchId'] = $LaunchId
  foreach ($key in $fields.Keys) { if ($key -ne 'event') { $ordered[$key] = $fields[$key] } }
  $line = (ConvertTo-Json -InputObject $ordered -Compress -Depth 6) + "`n"
  $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($line)
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    try {
      $stream = [System.IO.File]::Open($Lifecycle, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
      try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush() } finally { $stream.Dispose() }
      return
    } catch { Start-Sleep -Milliseconds 50 }
  }
  Note "could not append to $Lifecycle after 20 attempts: $line"
}

# This process has no console of its own that anyone reads (it is started with
# CREATE_NO_WINDOW so the launcher's console can close without reaching it),
# so its own errors go to holder-<stamp>.log next to the app log.
$holderLog = Join-Path $LogDir ("holder-{0}.log" -f $Stamp)
function Note([string] $text) {
  try { [System.IO.File]::AppendAllText($holderLog, ("{0} {1}`n" -f [DateTime]::UtcNow.ToString('o'), $text), [System.Text.UTF8Encoding]::new($false)) } catch {}
}
$script:rootPid = 0
$script:started = $false

# Any terminating error anywhere below: say so in the holder log AND in
# lifecycle.jsonl, as launch-failed before the root exists and as an exit
# record with the error after it, so a lost exit code is never silent.
trap {
  $message = $_.Exception.Message
  Note ("TRAP: {0} at {1}" -f $message, $_.InvocationInfo.PositionMessage)
  if ($script:started) {
    Write-Record @{ event = 'exit'; pid = $script:rootPid; exitCode = $null; exitedAt = [DateTime]::UtcNow.ToString('o'); error = "holder failed after start: $message"; holderPid = $PID }
  } else {
    Write-Record @{ event = 'launch-failed'; reason = "holder error: $message"; stage = 'trap'; holderPid = $PID }
  }
  exit 2
}

$csharp = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class LiveJob {
  [StructLayout(LayoutKind.Sequential)]
  public struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }

  public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
  public const int JobObjectBasicProcessIdList = 3;
  public const int JobObjectExtendedLimitInformation = 9;
  public const uint CREATE_SUSPENDED = 0x4;
  public const uint CREATE_UNICODE_ENVIRONMENT = 0x400;
  public const int STARTF_USESTDHANDLES = 0x100;
  public const uint FILE_APPEND_DATA = 0x4;
  public const uint FILE_READ_ATTRIBUTES = 0x80;
  public const uint SYNCHRONIZE = 0x100000;
  public const uint GENERIC_READ = 0x80000000;
  public const uint FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2, FILE_SHARE_DELETE = 4;
  public const uint OPEN_ALWAYS = 4, OPEN_EXISTING = 3;
  public const uint DUPLICATE_SAME_ACCESS = 2;
  public const uint MOVEFILE_REPLACE_EXISTING = 1;
  public const uint INFINITE = 0xFFFFFFFF;

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr CreateJobObject(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length, out uint returned);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr CreateFile(string name, uint access, uint share, ref SECURITY_ATTRIBUTES sa, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool DuplicateHandle(IntPtr srcProc, IntPtr src, IntPtr dstProc, out IntPtr dst, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool MoveFileEx(string from, string to, uint flags);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);

  public static string Win32Message(int code) { return new System.ComponentModel.Win32Exception(code).Message; }

  public static IntPtr OpenAppendInheritable(string path) {
    SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES(); sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)); sa.bInheritHandle = 1;
    IntPtr h = CreateFile(path, FILE_APPEND_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, ref sa, OPEN_ALWAYS, 0x80, IntPtr.Zero);
    if (h == new IntPtr(-1)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "CreateFile(" + path + ")");
    return h;
  }

  public static IntPtr OpenNulInheritable() {
    SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES(); sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)); sa.bInheritHandle = 1;
    IntPtr h = CreateFile("NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, ref sa, OPEN_EXISTING, 0, IntPtr.Zero);
    if (h == new IntPtr(-1)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "CreateFile(NUL)");
    return h;
  }

  public static IntPtr CreateKillOnCloseJob(string name) {
    IntPtr job = CreateJobObject(IntPtr.Zero, string.IsNullOrEmpty(name) ? null : name);
    if (job == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
    IntPtr buffer = Marshal.AllocHGlobal(size);
    try {
      Marshal.StructureToPtr(info, buffer, false);
      if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject");
    } finally { Marshal.FreeHGlobal(buffer); }
    return job;
  }

  public static PROCESS_INFORMATION StartSuspended(string commandLine, string cwd, IntPtr stdin, IntPtr stdout) {
    STARTUPINFO si = new STARTUPINFO(); si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    si.dwFlags = STARTF_USESTDHANDLES; si.hStdInput = stdin; si.hStdOutput = stdout; si.hStdError = stdout;
    PROCESS_INFORMATION pi;
    StringBuilder cmd = new StringBuilder(commandLine);
    if (!CreateProcess(null, cmd, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, cwd, ref si, out pi)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "CreateProcess");
    return pi;
  }

  public static void Assign(IntPtr job, IntPtr process) {
    if (!AssignProcessToJobObject(job, process)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "AssignProcessToJobObject");
  }

  public static IntPtr DuplicateInto(IntPtr job, IntPtr process) {
    IntPtr dup;
    if (!DuplicateHandle(GetCurrentProcess(), job, process, out dup, 0, false, DUPLICATE_SAME_ACCESS)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "DuplicateHandle");
    return dup;
  }

  public static void Resume(IntPtr thread) {
    if (ResumeThread(thread) == 0xFFFFFFFF) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread");
  }

  public static int[] MemberPids(IntPtr job) {
    int size = 8 + 8 * 4096;
    IntPtr buffer = Marshal.AllocHGlobal(size);
    try {
      uint returned;
      if (!QueryInformationJobObject(job, JobObjectBasicProcessIdList, buffer, (uint)size, out returned)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "QueryInformationJobObject");
      int inList = Marshal.ReadInt32(buffer, 4);
      int[] pids = new int[inList];
      for (int i = 0; i < inList; i++) pids[i] = (int)Marshal.ReadInt64(buffer, 8 + 8 * i);
      return pids;
    } finally { Marshal.FreeHGlobal(buffer); }
  }

  public static long CreationTimeUtcTicks(IntPtr process) {
    long c, e, k, u;
    if (!GetProcessTimes(process, out c, out e, out k, out u)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "GetProcessTimes");
    return DateTime.FromFileTimeUtc(c).Ticks;
  }
}
'@

try {
  if (-not ([System.Management.Automation.PSTypeName]'LiveJob').Type) { Add-Type -TypeDefinition $csharp -Language CSharp }
} catch {
  Write-Record @{ event = 'launch-failed'; reason = "Add-Type failed: $($_.Exception.Message)"; stage = 'compile' }
  exit 2
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$pendingLog = Join-Path $LogDir ("app-{0}-pending.log" -f $Stamp)
$hLog = [IntPtr]::Zero; $hNul = [IntPtr]::Zero; $hJob = [IntPtr]::Zero
$pi = New-Object LiveJob+PROCESS_INFORMATION
$holderPid = $PID

try {
  $hLog = [LiveJob]::OpenAppendInheritable($pendingLog)
  $hNul = [LiveJob]::OpenNulInheritable()
  $hJob = [LiveJob]::CreateKillOnCloseJob($JobName)

  $pi = [LiveJob]::StartSuspended($CommandLine, $WorkingDirectory, $hNul, $hLog)
} catch {
  Write-Record @{ event = 'launch-failed'; reason = $_.Exception.Message; stage = 'create'; commandLine = $CommandLine; holderPid = $holderPid }
  if ($hLog -ne [IntPtr]::Zero) { [void][LiveJob]::CloseHandle($hLog) }
  if ($hNul -ne [IntPtr]::Zero) { [void][LiveJob]::CloseHandle($hNul) }
  if ($hJob -ne [IntPtr]::Zero) { [void][LiveJob]::CloseHandle($hJob) }
  exit 2
}

$rootPid = $pi.dwProcessId
$script:rootPid = $rootPid
Note "root pid $rootPid created suspended: $CommandLine"
$assigned = $false; $duplicated = $false; $assignError = $null; $dupError = $null
try { [LiveJob]::Assign($hJob, $pi.hProcess); $assigned = $true } catch { $assignError = $_.Exception.Message }
if ($assigned -and -not $NoDuplicate) {
  try { [void][LiveJob]::DuplicateInto($hJob, $pi.hProcess); $duplicated = $true } catch { $dupError = $_.Exception.Message }
}
$startedAt = [DateTime]::new([LiveJob]::CreationTimeUtcTicks($pi.hProcess), [DateTimeKind]::Utc).ToString('o')

# The log was opened before the pid existed. Rename it to the pid form now;
# the open handles (ours and the child's) follow the file, which was opened
# with FILE_SHARE_DELETE for exactly this.
$appLog = Join-Path $LogDir ("app-{0}-pid{1}.log" -f $Stamp, $rootPid)
if (-not [LiveJob]::MoveFileEx($pendingLog, $appLog, [LiveJob]::MOVEFILE_REPLACE_EXISTING)) { $appLog = $pendingLog }

# Resume: the root's first instruction runs only now, inside the job.
try { [LiveJob]::Resume($pi.hThread) } catch {
  Write-Record @{ event = 'launch-failed'; reason = $_.Exception.Message; stage = 'resume'; pid = $rootPid; holderPid = $holderPid }
  [void][LiveJob]::TerminateJobObject($hJob, 1)
  exit 2
}
[void][LiveJob]::CloseHandle($pi.hThread)
# Our copies of the inherited handles: the child owns its own now.
[void][LiveJob]::CloseHandle($hLog); [void][LiveJob]::CloseHandle($hNul)

$elevated = $false
try { $elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } catch {}

$watchCsv = Join-Path $LogDir ("watch-{0}.csv" -f $Stamp)
$watchdogPid = $null; $watchdogError = $null
if ($Watchdog -and (Test-Path -LiteralPath $Watchdog)) {
  try {
    $watchArgs = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $Watchdog,
      '-MainPid', $rootPid, '-LogDir', $LogDir, '-Stamp', $Stamp, '-LaunchId', $LaunchId, '-Lifecycle', $Lifecycle)
    if ($JobName) { $watchArgs += @('-JobName', $JobName) }
    $watchProc = Start-Process -FilePath 'powershell.exe' -ArgumentList $watchArgs -WindowStyle Hidden -PassThru
    $watchdogPid = $watchProc.Id
  } catch { $watchdogError = $_.Exception.Message }
}

Write-Record @{
  event = 'start'; pid = $rootPid; startedAt = $startedAt; commandLine = $CommandLine; workingDirectory = $WorkingDirectory
  electron = $Electron; appDir = $AppDir; userDataDir = $UserDataDir; port = $Port
  appLog = $appLog; chromiumLog = $ChromiumLog; watchCsv = $watchCsv; lifecycle = $Lifecycle
  job = @{ name = $JobName; killOnClose = $true; assigned = $assigned; assignError = $assignError; handleDuplicatedIntoApp = $duplicated; duplicateError = $dupError }
  holderPid = $holderPid; watchdogPid = $watchdogPid; watchdogError = $watchdogError; elevated = $elevated
}
$script:started = $true
Note "start recorded; job assigned=$assigned duplicated=$duplicated watchdog=$watchdogPid; waiting for pid $rootPid"

# Wait for the root. Polling with a timeout rather than INFINITE so a
# PowerShell host that is asked to stop can still get here.
while ([LiveJob]::WaitForSingleObject($pi.hProcess, 2000) -ne 0) { }

$exitedAt = [DateTime]::UtcNow.ToString('o')
[uint32] $code = 0
[void][LiveJob]::GetExitCodeProcess($pi.hProcess, [ref] $code)
$signed = [int64] $code; if ($signed -gt 2147483647) { $signed = $signed - 4294967296 }

$survivors = @()
try {
  foreach ($memberPid in [LiveJob]::MemberPids($hJob)) {
    if ($memberPid -eq $rootPid) { continue }
    $name = $null
    try { $name = (Get-Process -Id $memberPid -ErrorAction Stop).ProcessName } catch { $name = 'gone' }
    $survivors += @{ pid = $memberPid; name = $name }
  }
} catch { $survivors += @{ pid = -1; name = "MemberPids failed: $($_.Exception.Message)" } }

$terminated = $false
try { $terminated = [LiveJob]::TerminateJobObject($hJob, 0) } catch {}

$uptime = $null
try { $uptime = [math]::Round(([DateTime]::Parse($exitedAt).ToUniversalTime() - [DateTime]::Parse($startedAt).ToUniversalTime()).TotalSeconds, 1) } catch {}

Write-Record @{
  event = 'exit'; pid = $rootPid; exitCode = $signed; exitCodeUnsigned = [int64] $code; exitedAt = $exitedAt; startedAt = $startedAt; uptimeSeconds = $uptime
  descendantsAtExit = $survivors; descendantsTerminated = $terminated; appLog = $appLog; holderPid = $holderPid
}

Note "exit recorded: pid $rootPid code $signed; $($survivors.Count) descendants ended (TerminateJobObject=$terminated)"
[void][LiveJob]::CloseHandle($pi.hProcess)
[void][LiveJob]::CloseHandle($hJob)
exit 0
