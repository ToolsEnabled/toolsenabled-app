# THE SAMPLER: one row every 3 s about the app's main process, and ONE
# minidump when it stops responding for 9 s or passes 3 GB of private bytes,
# at most once per ten minutes. It never signals, suspends for longer than a
# dump takes, or terminates anything: a watchdog that can end the app would be
# one more way for the app to die without a trace.
#
# It is started by launch-live-job.ps1 as a plain child of the holder (not a
# job member, so a job kill never takes it) and ends itself when the main
# process is gone.
#
# Columns of watch-<stamp>.csv:
#   time_utc, main_pid, responding, private_bytes, working_set, handle_count,
#   thread_count, commit_used_kb, commit_limit_kb, job_members, descendants,
#   descendants_by_image, note
#
#   responding      System.Diagnostics.Process.Responding (the main window's
#                   message pump answered within the .NET timeout)
#   commit_used_kb  = TotalVirtualMemorySize - FreeVirtualMemory of
#                     Win32_OperatingSystem, read here as
#                     GlobalMemoryStatusEx ullTotalPageFile - ullAvailPageFile
#                     (the same kernel counters, microseconds instead of a WMI
#                     round trip that stalls exactly when the machine is
#                     saturated). One Win32_OperatingSystem cross-check row is
#                     written at start so the equivalence is on record.
#   job_members     pids in the launch's Job Object (OpenJobObject by name),
#                   -1 when the job cannot be opened
#   descendants     processes under main_pid by parent-pid walk (Toolhelp32)
#   descendants_by_image  "electron=6;claude=2;node=3" style
#
# Minidump: MiniDumpWriteDump with MiniDumpWithThreadInfo | MiniDumpWithDataSegs
# | MiniDumpWithHandleData (0x1000 | 0x1 | 0x4) to hang-<stamp>-pid<pid>-<why>.dmp.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [int] $MainPid,
  [Parameter(Mandatory = $true)] [string] $LogDir,
  [Parameter(Mandatory = $true)] [string] $Stamp,
  [string] $LaunchId = '',
  [string] $Lifecycle = '',
  [string] $JobName = '',
  [int] $IntervalMs = 3000,
  [int] $HangSeconds = 9,
  [long] $PrivateBytesLimit = 3221225472,
  [int] $DumpCooldownMinutes = 10,
  [int] $MaxSamples = 0
)

$ErrorActionPreference = 'Continue'

$csharp = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class LiveWatch {
  [StructLayout(LayoutKind.Sequential)]
  public struct MEMORYSTATUSEX { public uint dwLength, dwMemoryLoad; public ulong ullTotalPhys, ullAvailPhys, ullTotalPageFile, ullAvailPageFile, ullTotalVirtual, ullAvailVirtual, ullAvailExtendedVirtual; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX buffer);
  public static ulong[] Commit() {
    MEMORYSTATUSEX m = new MEMORYSTATUSEX(); m.dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX));
    if (!GlobalMemoryStatusEx(ref m)) return new ulong[] { 0, 0 };
    return new ulong[] { (m.ullTotalPageFile - m.ullAvailPageFile) / 1024, m.ullTotalPageFile / 1024 };
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct PROCESSENTRY32W {
    public uint dwSize, cntUsage, th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID, cntThreads, th32ParentProcessID; public int pcPriClassBase; public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32W entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32W entry);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);

  /* Every process under root by parent-pid walk, as "pid|image" strings. A
     reused parent pid can misattribute one process; the job column is the
     exact answer and this is the independent cross-check. */
  public static string[] Descendants(uint root) {
    List<KeyValuePair<uint, PROCESSENTRY32W>> all = new List<KeyValuePair<uint, PROCESSENTRY32W>>();
    IntPtr snap = CreateToolhelp32Snapshot(2, 0);
    if (snap == new IntPtr(-1)) return new string[0];
    try {
      PROCESSENTRY32W e = new PROCESSENTRY32W(); e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
      if (Process32FirstW(snap, ref e)) {
        do { all.Add(new KeyValuePair<uint, PROCESSENTRY32W>(e.th32ProcessID, e)); } while (Process32NextW(snap, ref e));
      }
    } finally { CloseHandle(snap); }
    HashSet<uint> under = new HashSet<uint>(); under.Add(root);
    List<string> found = new List<string>();
    bool grew = true;
    while (grew) {
      grew = false;
      foreach (KeyValuePair<uint, PROCESSENTRY32W> kv in all) {
        if (under.Contains(kv.Key) || !under.Contains(kv.Value.th32ParentProcessID)) continue;
        under.Add(kv.Key); found.Add(kv.Key + "|" + kv.Value.szExeFile); grew = true;
      }
    }
    return found.ToArray();
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length, out uint returned);
  public static int JobMemberCount(string name) {
    if (string.IsNullOrEmpty(name)) return -1;
    IntPtr job = OpenJobObject(0x0004, false, name);
    if (job == IntPtr.Zero) return -1;
    int size = 8 + 8 * 4096; IntPtr buffer = Marshal.AllocHGlobal(size);
    try {
      uint returned;
      if (!QueryInformationJobObject(job, 3, buffer, (uint)size, out returned)) return -1;
      return Marshal.ReadInt32(buffer, 4);
    } finally { Marshal.FreeHGlobal(buffer); CloseHandle(job); }
  }

  [DllImport("dbghelp.dll", SetLastError = true)] static extern bool MiniDumpWriteDump(IntPtr process, uint pid, SafeFileHandle file, int type, IntPtr exception, IntPtr user, IntPtr callback);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  public const int MiniDumpWithDataSegs = 0x1, MiniDumpWithHandleData = 0x4, MiniDumpWithThreadInfo = 0x1000;
  public static string WriteDump(uint pid, string path) {
    IntPtr h = OpenProcess(0x0400 | 0x0010 | 0x1000, false, pid);
    if (h == IntPtr.Zero) return "OpenProcess failed: " + new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()).Message;
    try {
      using (System.IO.FileStream fs = new System.IO.FileStream(path, System.IO.FileMode.Create, System.IO.FileAccess.ReadWrite, System.IO.FileShare.None)) {
        bool ok = MiniDumpWriteDump(h, pid, fs.SafeFileHandle, MiniDumpWithThreadInfo | MiniDumpWithDataSegs | MiniDumpWithHandleData, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        if (!ok) return "MiniDumpWriteDump failed: " + new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()).Message;
      }
      return "ok";
    } finally { CloseHandle(h); }
  }
}
'@

try {
  if (-not ([System.Management.Automation.PSTypeName]'LiveWatch').Type) { Add-Type -TypeDefinition $csharp -Language CSharp }
} catch {
  [System.IO.File]::AppendAllText((Join-Path $LogDir ("watch-{0}.err" -f $Stamp)), "Add-Type failed: $($_.Exception.Message)`n")
  exit 2
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$csv = Join-Path $LogDir ("watch-{0}.csv" -f $Stamp)
$utf8 = [System.Text.UTF8Encoding]::new($false)

function Append-Line([string] $file, [string] $line) {
  for ($attempt = 0; $attempt -lt 10; $attempt++) {
    try {
      $stream = [System.IO.File]::Open($file, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
      try { $bytes = $utf8.GetBytes($line + "`n"); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush() } finally { $stream.Dispose() }
      return
    } catch { Start-Sleep -Milliseconds 30 }
  }
}

function Write-Trigger([string] $reason, [string] $dump, [string] $result, $sample) {
  if (-not $Lifecycle) { return }
  $record = [ordered]@{ event = 'watch-trigger'; at = [DateTime]::UtcNow.ToString('o'); launchId = $LaunchId; pid = $MainPid; reason = $reason; dump = $dump; result = $result
    responding = $sample.responding; privateBytes = $sample.privateBytes; workingSet = $sample.workingSet; handleCount = $sample.handleCount; threadCount = $sample.threadCount; watchdogPid = $PID }
  Append-Line $Lifecycle (ConvertTo-Json -InputObject $record -Compress -Depth 4)
}

if (-not (Test-Path -LiteralPath $csv)) {
  Append-Line $csv 'time_utc,main_pid,responding,private_bytes,working_set,handle_count,thread_count,commit_used_kb,commit_limit_kb,job_members,descendants,descendants_by_image,note'
}

# One WMI cross-check so the commit columns are provably the Win32_OperatingSystem numbers.
try {
  $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
  $gm = [LiveWatch]::Commit()
  Append-Line $csv ("{0},{1},,,,,,{2},{3},,,,wmi-crosscheck: Win32_OperatingSystem TotalVirtualMemorySize={4} FreeVirtualMemory={5} -> used={2}; GlobalMemoryStatusEx used={6} limit={7}" -f [DateTime]::UtcNow.ToString('o'), $MainPid, ($os.TotalVirtualMemorySize - $os.FreeVirtualMemory), $os.TotalVirtualMemorySize, $os.TotalVirtualMemorySize, $os.FreeVirtualMemory, $gm[0], $gm[1])
} catch {
  Append-Line $csv ("{0},{1},,,,,,,,,,,wmi-crosscheck failed: {2}" -f [DateTime]::UtcNow.ToString('o'), $MainPid, $_.Exception.Message.Replace(',', ';'))
}

$notRespondingSince = $null
$lastDump = $null
$samples = 0

while ($true) {
  $samples++
  $note = ''
  $proc = $null
  try { $proc = [System.Diagnostics.Process]::GetProcessById($MainPid) } catch { $proc = $null }
  if ($null -eq $proc -or $proc.HasExited) {
    Append-Line $csv ("{0},{1},,,,,,,,,,,main process gone; watchdog ends" -f [DateTime]::UtcNow.ToString('o'), $MainPid)
    break
  }
  $responding = $true; $priv = 0; $ws = 0; $handles = 0; $threads = 0
  try {
    $proc.Refresh()
    $responding = $proc.Responding
    $priv = $proc.PrivateMemorySize64; $ws = $proc.WorkingSet64; $handles = $proc.HandleCount; $threads = $proc.Threads.Count
  } catch { $note = "sample error: $($_.Exception.Message.Replace(',', ';'))" }
  $commit = [LiveWatch]::Commit()
  $members = [LiveWatch]::JobMemberCount($JobName)
  $desc = [LiveWatch]::Descendants([uint32] $MainPid)
  $byImage = @{}
  foreach ($row in $desc) { $img = ($row.Split('|')[1] -replace '\.exe$', ''); if ($byImage.ContainsKey($img)) { $byImage[$img]++ } else { $byImage[$img] = 1 } }
  $byImageText = (($byImage.Keys | Sort-Object) | ForEach-Object { "$_=$($byImage[$_])" }) -join ';'

  $now = [DateTime]::UtcNow
  if (-not $responding) { if ($null -eq $notRespondingSince) { $notRespondingSince = $now } } else { $notRespondingSince = $null }
  $reason = $null
  if ($null -ne $notRespondingSince -and ($now - $notRespondingSince).TotalSeconds -ge $HangSeconds) { $reason = 'hang' }
  if ($priv -gt $PrivateBytesLimit) { if ($reason) { $reason = 'hang-memory' } else { $reason = 'memory' } }
  if ($reason) {
    $cooled = ($null -eq $lastDump) -or (($now - $lastDump).TotalMinutes -ge $DumpCooldownMinutes)
    if ($cooled) {
      $dump = Join-Path $LogDir ("hang-{0}-pid{1}-{2}.dmp" -f $Stamp, $MainPid, $reason)
      $result = [LiveWatch]::WriteDump([uint32] $MainPid, $dump)
      $lastDump = $now
      $note = "dump($reason): $result -> $dump"
      Write-Trigger $reason $dump $result @{ responding = $responding; privateBytes = $priv; workingSet = $ws; handleCount = $handles; threadCount = $threads }
    } else {
      $note = "trigger($reason) within cooldown; no dump"
    }
  }

  Append-Line $csv ("{0},{1},{2},{3},{4},{5},{6},{7},{8},{9},{10},{11},{12}" -f $now.ToString('o'), $MainPid, $responding, $priv, $ws, $handles, $threads, $commit[0], $commit[1], $members, $desc.Length, $byImageText, $note)
  if ($MaxSamples -gt 0 -and $samples -ge $MaxSamples) { break }
  Start-Sleep -Milliseconds $IntervalMs
}
exit 0
