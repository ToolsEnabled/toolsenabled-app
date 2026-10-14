import fs from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { registeredToolPaths, registeredToolSearchPath, registeredToolchainPolicyIdentity,
  assertRegisteredToolIdentity } from './registered-toolchain.mjs';
import { measureLinuxToolchain, linuxToolEnvironment } from './linux-toolchain.mjs';
import { runLinuxOwnedJobBatch } from './linux-owned-job.mjs';
import { DEV, TEMP, IDENTITY_LIMIT, fencedPath, unlinkedPath, fileIdentity, captureBytes } from './owned-job-files.mjs';
import { acquireOwnedExecution as acquireInternalOwnedExecution, createInertExecutionScopeFixture,
  cleanupError } from './owned-execution-admission.mjs';
export { fencedPath, unlinkedPath, fileIdentity, createInertExecutionScopeFixture };

const POWERSHELL = registeredToolPaths().powershell;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const moduleFile = fileURLToPath(import.meta.url);
const INSTALLED_READER = fileURLToPath(new URL('../guest/Read-InstalledState.ps1', import.meta.url));
const APPROVED_INSTALLED_READER_SHA256 = '1f7a596876f0d2a7796a89eb047529a9f4cd04b627fdfcc97fac51c4c301f1db';
const FIXTURE_NSIS = `${DEV}\\Desktop\\ToolsEnabled-1.0.41-WorkingFolder\\deps\\electron-builder-cache\\nsis-3.0.4.1\\nsis-3.0.4.1-1mx3n`;

// These extracted bytes were part of the shared transport before extraction.
// Keep their reviewed identities bound to this facade without changing the
// actual shared-file identity stored in existing transport receipts.
const OWNED_IMPLEMENTATION_DEPENDENCIES = Object.freeze([
  Object.freeze({ name: './owned-job-files.mjs', bytes: 9040, sha256: '4591d55487c1d8edc492e069cd12de1446e6db93f9f59ae0100b7032aba3ec56' }),
  Object.freeze({ name: './owned-execution-admission.mjs', bytes: 5886, sha256: 'ce83be38cc4a7f2772a709148b93e2cf425b6bd17011baa3ea99156a7644b27d' }),
]);
function assertOwnedImplementationDependencies() {
  for (const expected of OWNED_IMPLEMENTATION_DEPENDENCIES) {
    const current = fileIdentity(fileURLToPath(new URL(expected.name, import.meta.url)), { maximum: 4 * 1024 * 1024 });
    if (current.bytes !== expected.bytes || current.sha256 !== expected.sha256)
      throw new Error(`loaded owned-job dependency changed: ${expected.name}`);
  }
}
function measuredOwnedImplementation() {
  assertOwnedImplementationDependencies();
  return fileIdentity(moduleFile, { maximum: 4 * 1024 * 1024 });
}
const LOADED_IMPLEMENTATION = measuredOwnedImplementation();
export function ownedJobImplementationIdentity() {
  if (arguments.length) throw new Error('owned implementation identity accepts no caller input');
  const current = measuredOwnedImplementation();
  if (current.sha256 !== LOADED_IMPLEMENTATION.sha256 || current.bytes !== LOADED_IMPLEMENTATION.bytes)
    throw new Error('loaded shared owned-job implementation changed');
  return current;
}

// No caller paths, identities or trust overrides enter this measurement. Reuse
// the ordinary-file/current-account boundary used by actual owned execution.
export function measureRegisteredToolchain() {
  if (arguments.length) throw new Error('registered tool measurement accepts no caller inputs');
  if (process.platform === 'linux') return measureLinuxToolchain();
  if (process.platform !== 'win32') throw new Error('Windows qualification requires native Windows tools');
  const loaded = registeredToolchainPolicyIdentity();
  const measuredPolicy = fileIdentity(loaded.path, { maximum: 1024 * 1024 });
  if (measuredPolicy.sha256 !== loaded.sha256 || measuredPolicy.bytes !== loaded.bytes) throw new Error('loaded tool policy changed');
  const policy = { sha256: measuredPolicy.sha256, bytes: measuredPolicy.bytes };
  const tools = Object.fromEntries(Object.entries(registeredToolPaths()).map(([role, file]) => {
    const measured = Object.freeze(fileIdentity(file, { system: true }));
    assertRegisteredToolIdentity(role, measured);
    return [role, measured];
  }));
  return Object.freeze({ policy: Object.freeze(policy), tools: Object.freeze(tools) });
}

function capturedJson(input, maximum) {
  const captured = captureBytes(input, maximum);
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(captured.data);
  if (text.charCodeAt(0) === 0xfeff) throw new Error('native evidence JSON has an unexpected BOM');
  return { ...captured, value: JSON.parse(text) };
}

function boundSourceEnvironment(extra, { cwd, sourceBinding } = {}) {
  const keys = Object.keys(extra || {}).filter(key => key.toUpperCase() === 'MC_CANONICAL_ROOT');
  if (!keys.length && sourceBinding === undefined) return null;
  const refuse = () => { throw new Error('qualification source binding differs from the measured App/Engine inputs'); };
  if (keys.length !== 1 || keys[0] !== 'MC_CANONICAL_ROOT' || extra.TOOLSENABLED_TEST_STRICT !== '1' ||
      !sourceBinding || typeof sourceBinding !== 'object' || Array.isArray(sourceBinding) ||
      Object.keys(sourceBinding).sort().join(',') !== 'appRef,canonicalRoot,engineRef,root,sourceRecord' ||
      !/^[a-f0-9]{40}$/.test(sourceBinding.appRef || '') || !/^[a-f0-9]{40}$/.test(sourceBinding.engineRef || '')) refuse();
  const root = unlinkedPath(sourceBinding.root, { directory: true });
  const engine = unlinkedPath(sourceBinding.canonicalRoot, { directory: true });
  if (root !== sourceBinding.root || engine !== sourceBinding.canonicalRoot || cwd !== root || extra.MC_CANONICAL_ROOT !== engine) refuse();
  // Capture identity and parsed content through the same bounded descriptor.
  // Actual clean Git refs are independently measured by source qualification
  // before/after execution and on replay; this boundary cannot substitute its
  // own directory or a changed private record for that selected pair.
  const captured = capturedJson(path.join(root, 'private/capability-source.owner.json'), 65536);
  const record = sourceBinding.sourceRecord;
  if (!record || Object.keys(record).sort().join(',') !== 'bytes,sha256' ||
      record.bytes !== captured.identity.bytes || record.sha256 !== captured.identity.sha256 ||
      captured.value.path !== engine || captured.value.ref !== sourceBinding.engineRef) refuse();
  return engine;
}

export function registeredToolEnvironment(extra = {}, sourceContext) {
  const canonicalRoot = boundSourceEnvironment(extra, sourceContext);
  if (process.platform === 'linux') {
    const selected = canonicalRoot ? Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'MC_CANONICAL_ROOT')) : extra;
    const environment = linuxToolEnvironment(selected);
    if (canonicalRoot) environment.MC_CANONICAL_ROOT = canonicalRoot;
    return environment;
  }
  const environment = {
    SystemRoot: '\x43:\\Windows', WINDIR: '\x43:\\Windows', ComSpec: '\x43:\\Windows\\System32\\cmd.exe',
    PATH: registeredToolSearchPath(),
    NO_COLOR: '1', CI: '1', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1',
    TEMP, TMP: TEMP, USERPROFILE: DEV,
    APPDATA: `${DEV}\\AppData\\Roaming`, LOCALAPPDATA: `${DEV}\\AppData\\Local`,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0', GIT_PAGER: '', PAGER: '',
  };
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('invalid process environment');
  const reserved = new Map(Object.keys(environment).map(key => [key.toUpperCase(), key]));
  const seen = new Set();
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value !== 'string' || key.includes('=') || key.includes('\0') || value.includes('\0')) throw new Error('invalid process environment');
    const folded = key.toUpperCase();
    if (seen.has(folded)) throw new Error('duplicate case-insensitive environment key');
    seen.add(folded);
    if (reserved.has(folded)) {
      const canonical = reserved.get(folded);
      // Artifact decoding can use the narrower fixed system-only PATH. There
      // are no arbitrary additions, alternate casing duplicates or tool roots.
      if (value !== environment[canonical] && !(canonical === 'PATH' && value === '\x43:\\Windows\\System32;\x43:\\Windows')) throw new Error(`reserved environment value cannot change: ${canonical}`);
      environment[canonical] = value;
    } else if (folded === 'TOOLSENABLED_TEST_STRICT' && value === '1') environment.TOOLSENABLED_TEST_STRICT = value;
    else if (key === 'MC_CANONICAL_ROOT' && value === canonicalRoot) environment.MC_CANONICAL_ROOT = canonicalRoot;
    else if (folded === 'QUALIFICATION_SHELL_ROOT') environment.QUALIFICATION_SHELL_ROOT = unlinkedPath(value, { directory: true });
    else if (folded === 'NSISDIR' && value === FIXTURE_NSIS) environment.NSISDIR = unlinkedPath(value, { directory: true });
    else throw new Error(`unregistered environment key or value: ${key}`);
  }
  // A fixed spelling is not a fixed destination if an ancestor becomes a
  // junction. Validate every registered search directory, not just the outer
  // executable that happened to be selected for this job.
  for (const directory of environment.PATH.split(';')) unlinkedPath(directory, { directory: true, system: true });
  return environment;
}

// Guard the fixed production acquisition through this measured facade. The
// inert fixture export cannot replace the private production scope.
export function acquireOwnedExecution(details) {
  assertOwnedImplementationDependencies();
  return acquireInternalOwnedExecution(details);
}

// The job owns every child before its first instruction runs. Only the three
// redirected standard handles are inherited; the job handle cannot escape.
const NATIVE = String.raw`${"\nusing System;\nusing System.IO;\nusing System.Text;\nusing System.Threading;\nusing System.Runtime.InteropServices;\nusing System.Security.Principal;\nusing System.Collections.Generic;\nusing System.Net;\nusing System.Diagnostics;\nusing System.Security.Cryptography;\nusing Microsoft.Win32.SafeHandles;\npublic sealed class OwnedJobResult {\n  public bool processCreated, rootExited, timedOut, outputLimitExceeded, hadRemainingChildren, cleanupConfirmed, cancelled;\n  public long exitCode = -1, stdoutBytes, stderrBytes;\n  public string error, startIdentity, stdoutSha256, stderrSha256;\n}\npublic static class OwnedJob {\n  [StructLayout(LayoutKind.Sequential)] struct SA { public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }\n  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct SI { public int cb; public string reserved, desktop, title; public int x,y,xSize,ySize,xChars,yChars,fill,flags; public short show,reserved2; public IntPtr reservedPtr,input,output,error; }\n  [StructLayout(LayoutKind.Sequential)] struct SIX { public SI start; public IntPtr attributes; }\n  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process, thread; public uint pid, tid; }\n  [StructLayout(LayoutKind.Sequential)] struct BASIC { public long processTime, jobTime; public uint flags; public UIntPtr minWorking,maxWorking; public uint activeLimit; public UIntPtr affinity; public uint priority,scheduling; }\n  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }\n  [StructLayout(LayoutKind.Sequential)] struct LIMIT { public BASIC basic; public IO io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }\n  [StructLayout(LayoutKind.Sequential)] struct ACCOUNT { public long user,kernel,periodUser,periodKernel; public uint faults,total,active,terminated; }\n  [StructLayout(LayoutKind.Sequential)] struct FILEINFO { public uint attributes; public System.Runtime.InteropServices.ComTypes.FILETIME created,accessed,written; public uint volume,highSize,lowSize,links,highIndex,lowIndex; }\n  [DllImport(\"kernel32\",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr file,out FILEINFO value);\n  [DllImport(\"kernel32\",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);\n  [DllImport(\"kernel32\",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,ref LIMIT value,int size);\n  [DllImport(\"kernel32\",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int info,out ACCOUNT value,int size,IntPtr returned);\n  [DllImport(\"kernel32\",EntryPoint=\"QueryInformationJobObject\",SetLastError=true)] static extern bool QueryJobMembers(IntPtr job,int info,IntPtr value,int size,IntPtr returned);\n  [DllImport(\"kernel32\",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);\n  [DllImport(\"kernel32\",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool member);\n  [DllImport(\"kernel32\",SetLastError=true)] static extern IntPtr GetStdHandle(int kind);\n  [DllImport(\"kernel32\",SetLastError=true)] static extern bool PeekNamedPipe(IntPtr pipe,IntPtr buffer,uint size,IntPtr read,out uint available,IntPtr remaining);\n  [DllImport(\"kernel32\",SetLastError=true)] static extern bool ReadFile(IntPtr file,byte[] buffer,uint size,out uint read,IntPtr overlapped);\n  delegate bool WindowEnumerator(IntPtr window,IntPtr context);\n  [DllImport(\"user32\",SetLastError=true)] static extern bool EnumWindows(WindowEnumerator callback,IntPtr context);\n  [DllImport(\"user32\",SetLastError=true)] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);\n  [DllImport(\"user32\")] static extern bool IsWindowVisible(IntPtr window);\n  [DllImport(\"iphlpapi\",SetLastError=true)] static extern uint GetExtendedTcpTable(IntPtr table,ref int size,bool order,int family,int kind,uint reserved);\n  [DllImport(\"kernel32\",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);\n  [DllImport(\"kernel32\",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);\n  [DllImport(\"kernel32\",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);\n  [DllImport(\"kernel32\",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);\n  [DllImport(\"kernel32\",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);\n  [DllImport(\"kernel32\",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);\n  [DllImport(\"kernel32\",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);\n  [DllImport(\"kernel32\",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user);\n  [DllImport(\"kernel32\",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder name,ref uint size);\n  [DllImport(\"advapi32\",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);\n  [DllImport(\"userenv.dll\",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool GetUserProfileDirectory(IntPtr token,StringBuilder directory,ref uint size);\n  [DllImport(\"advapi32\",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr value,int size,out int needed);\n  [DllImport(\"kernel32\",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SA attributes,uint size);\n  [DllImport(\"kernel32\",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);\n  [DllImport(\"kernel32\",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateFile(string name,uint access,uint share,ref SA attributes,uint disposition,uint flags,IntPtr template);\n  [DllImport(\"kernel32\",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateDirectory(string name,IntPtr security);\n  [DllImport(\"kernel32\",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);\n  [DllImport(\"kernel32\",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);\n  [DllImport(\"kernel32\")] static extern void DeleteProcThreadAttributeList(IntPtr list);\n  [DllImport(\"kernel32\",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr environment,string cwd,ref SIX startup,out PI process);\n  static void Check(bool result,string action) { if (!result) throw new Exception(action + \" failed (Win32 \" + Marshal.GetLastWin32Error() + \")\"); }\n  static string OwnerProfile() {\n    using(WindowsIdentity owner=WindowsIdentity.GetCurrent()) {\n      uint size=32768; StringBuilder directory=new StringBuilder((int)size);\n      Check(GetUserProfileDirectory(owner.Token,directory,ref size),\"observe current OS account profile\");\n      string profile=directory.ToString();\n      if(profile.Length<3||profile[1]!=':'||profile[2]!='\\\\'||!Path.GetFullPath(profile).Equals(profile,StringComparison.OrdinalIgnoreCase))\n        throw new Exception(\"current OS account profile is not an ordinary absolute path\");\n      return profile;\n    }\n  }\n  static string Quote(string value) {\n    if (value.Length > 0 && value.IndexOfAny(new char[]{' ','\\t','\"'}) < 0) return value;\n    StringBuilder b = new StringBuilder(\"\\\"\"); int slash=0;\n    foreach(char c in value) { if(c=='\\\\') { slash++; continue; } if(c=='\"') b.Append('\\\\',slash*2+1); else b.Append('\\\\',slash); b.Append(c); slash=0; }\n    b.Append('\\\\',slash*2); return b.Append('\"').ToString();\n  }\n  static uint Active(IntPtr job) { ACCOUNT value; Check(QueryInformationJobObject(job,1,out value,Marshal.SizeOf(typeof(ACCOUNT)),IntPtr.Zero),\"query owned job\"); return value.active; }\n  static string Json(string value) {\n    StringBuilder b=new StringBuilder(\"\\\"\");\n    foreach(char c in value) { if(c=='\"'||c=='\\\\') b.Append('\\\\').Append(c); else if(c<32) b.Append(\"\\\\u\").Append(((int)c).ToString(\"x4\")); else b.Append(c); }\n    return b.Append('\"').ToString();\n  }\n  static IntPtr TokenInfo(IntPtr token,int kind) {\n    int size; GetTokenInformation(token,kind,IntPtr.Zero,0,out size);\n    if(size<=0||size>65536) throw new Exception(\"invalid token information size\");\n    IntPtr value=Marshal.AllocHGlobal(size);\n    try { Check(GetTokenInformation(token,kind,value,size,out size),\"observe owned token\"); return value; }\n    catch { Marshal.FreeHGlobal(value); throw; }\n  }\n  // Query the retained CreateProcess handle, never rediscover a PID. No token\n  // duplication/elevation or other-profile lookup is performed.\n  static string StartIdentity(PI process,string executable,string expectedProfile) {\n    long created,exited,kernel,user; Check(GetProcessTimes(process.process,out created,out exited,out kernel,out user),\"observe creation time\");\n    uint length=32768; StringBuilder image=new StringBuilder((int)length);\n    Check(QueryFullProcessImageName(process.process,0,image,ref length),\"observe executable image\");\n    if(executable.Length>0&&!String.Equals(image.ToString(),executable,StringComparison.OrdinalIgnoreCase)) throw new Exception(\"owned executable image differs\");\n    IntPtr token=IntPtr.Zero,elevation=IntPtr.Zero,integrity=IntPtr.Zero,session=IntPtr.Zero;\n    try {\n      Check(OpenProcessToken(process.process,8,out token),\"observe child token\");\n      elevation=TokenInfo(token,20); integrity=TokenInfo(token,25); session=TokenInfo(token,12);\n      bool elevated=Marshal.ReadInt32(elevation)!=0;\n      string integritySid=new SecurityIdentifier(Marshal.ReadIntPtr(integrity)).Value;\n      int level=Int32.Parse(integritySid.Substring(integritySid.LastIndexOf('-')+1));\n      string sid;\n      using(WindowsIdentity child=new WindowsIdentity(token))\n      using(WindowsIdentity owner=WindowsIdentity.GetCurrent()) {\n        if(child.User.Value!=owner.User.Value) throw new Exception(\"owned process account differs from current OS account\");\n        sid=child.User.Value;\n      }\n      if(expectedProfile==\"windows-x64-standard\"&&(elevated||level!=8192)) throw new Exception(\"chosen standard token was not observed\");\n      if(expectedProfile==\"windows-x64-administrator\"&&(!elevated||level!=12288)) throw new Exception(\"chosen administrator token was not observed\");\n      return \"{\\\"pid\\\":\"+process.pid+\",\\\"startedAt\\\":\"+Json(DateTime.FromFileTimeUtc(created).ToString(\"o\"))+\",\\\"imagePath\\\":\"+Json(image.ToString())+\n        \",\\\"userSid\\\":\"+Json(sid)+\",\\\"elevated\\\":\"+(elevated?\"true\":\"false\")+\",\\\"integrityLevel\\\":\"+level+\",\\\"sessionId\\\":\"+Marshal.ReadInt32(session)+\"}\";\n    } finally { if(elevation!=IntPtr.Zero) Marshal.FreeHGlobal(elevation); if(integrity!=IntPtr.Zero) Marshal.FreeHGlobal(integrity); if(session!=IntPtr.Zero) Marshal.FreeHGlobal(session); if(token!=IntPtr.Zero) CloseHandle(token); }\n  }\n  static void LiveMember(IntPtr process,IntPtr job) {\n    bool member; Check(IsProcessInJob(process,job,out member),\"query retained job membership\");\n    if(!member||WaitForSingleObject(process,0)!=258) throw new Exception(\"owned member is absent, exited or unreadable\");\n  }\n  static uint[] Members(IntPtr job) {\n    const int capacity=256; int size=8+capacity*IntPtr.Size;\n    IntPtr buffer=Marshal.AllocHGlobal(size);\n    try {\n      Check(QueryJobMembers(job,3,buffer,size,IntPtr.Zero),\"query complete job membership\");\n      int assigned=Marshal.ReadInt32(buffer),count=Marshal.ReadInt32(buffer,4);\n      if(count<1||count>capacity||assigned!=count) throw new Exception(\"incomplete or oversized job membership\");\n      uint[] result=new uint[count]; HashSet<uint> seen=new HashSet<uint>();\n      for(int i=0;i<count;i++) {\n        long pid=Marshal.ReadIntPtr(buffer,8+i*IntPtr.Size).ToInt64();\n        if(pid<=0||pid>UInt32.MaxValue||!seen.Add((uint)pid)) throw new Exception(\"invalid or duplicate job member\");\n        result[i]=(uint)pid;\n      }\n      Array.Sort(result); return result;\n    } finally { Marshal.FreeHGlobal(buffer); }\n  }\n  static string Windows(Dictionary<uint,IntPtr> members) {\n    List<string> rows=new List<string>(); string failure=null;\n    WindowEnumerator visit=delegate(IntPtr window,IntPtr ignored) {\n      try {\n        uint pid; uint thread=GetWindowThreadProcessId(window,out pid);\n        if(!members.ContainsKey(pid)) return true; // No title/content/other-process lookup.\n        if(thread==0||rows.Count>=1024) throw new Exception(\"owned window disappeared or window budget exceeded\");\n        bool visible=IsWindowVisible(window); uint after;\n        if(GetWindowThreadProcessId(window,out after)!=thread||after!=pid) throw new Exception(\"owned window identity changed\");\n        rows.Add(\"{\\\"hwnd\\\":\"+Json(\"0x\"+window.ToInt64().ToString(\"x\"))+\",\\\"pid\\\":\"+pid+\",\\\"threadId\\\":\"+thread+\",\\\"visible\\\":\"+(visible?\"true\":\"false\")+\"}\");\n        return true;\n      } catch(Exception e) { failure=e.Message; return false; }\n    };\n    bool success=EnumWindows(visit,IntPtr.Zero);\n    if(failure!=null) throw new Exception(failure);\n    Check(success,\"enumerate owned windows\");\n    rows.Sort(StringComparer.Ordinal); return \"[\"+string.Join(\",\",rows.ToArray())+\"]\";\n  }\n  static string Listeners(Dictionary<uint,IntPtr> members) {\n    List<string> rows=new List<string>();\n    foreach(int family in new int[]{2,23}) {\n      int size=0; uint status=GetExtendedTcpTable(IntPtr.Zero,ref size,true,family,3,0);\n      if((status!=0&&status!=122)||size<4||size>1024*1024) throw new Exception(\"TCP listener census unavailable or oversized\");\n      int capacity=size; IntPtr buffer=Marshal.AllocHGlobal(capacity);\n      try {\n        if(GetExtendedTcpTable(buffer,ref size,true,family,3,0)!=0||size>capacity) throw new Exception(\"TCP listener census changed or is unreadable\");\n        int count=Marshal.ReadInt32(buffer),width=family==2?24:56;\n        if(count<0||4L+(long)count*width>capacity) throw new Exception(\"TCP listener census is truncated\");\n        for(int i=0;i<count;i++) {\n          IntPtr row=IntPtr.Add(buffer,4+i*width);\n          uint pid=(uint)Marshal.ReadInt32(row,family==2?20:52);\n          if(!members.ContainsKey(pid)) continue; // Never report unrelated endpoints.\n          if(rows.Count>=2048||Marshal.ReadInt32(row,family==2?0:48)!=2) throw new Exception(\"invalid or oversized owned listener census\");\n          byte[] address=new byte[family==2?4:16]; Marshal.Copy(IntPtr.Add(row,family==2?4:0),address,0,address.Length);\n          uint packed=(uint)Marshal.ReadInt32(row,family==2?8:20);\n          uint port=((packed&255)<<8)|((packed>>8)&255),scope=family==2?0:(uint)Marshal.ReadInt32(row,16);\n          if(port==0) throw new Exception(\"owned listener has no measured port\");\n          rows.Add(\"{\\\"family\\\":\"+Json(family==2?\"IPv4\":\"IPv6\")+\",\\\"address\\\":\"+Json(new IPAddress(address).ToString())+\n            \",\\\"scopeId\\\":\"+scope+\",\\\"port\\\":\"+port+\",\\\"pid\\\":\"+pid+\"}\");\n        }\n      } finally { Marshal.FreeHGlobal(buffer); }\n    }\n    rows.Sort(StringComparer.Ordinal); return \"[\"+string.Join(\",\",rows.ToArray())+\"]\";\n  }\n  static string RuntimeObservation(IntPtr job,PI root,string executable,string profile,string identity,string controlId,int request) {\n    LiveMember(root.process,job);\n    uint[] before=Members(job);\n    if(Array.IndexOf(before,root.pid)<0) throw new Exception(\"retained root is missing from its job\");\n    Dictionary<uint,IntPtr> members=new Dictionary<uint,IntPtr>();\n    List<string> identities=new List<string>();\n    try {\n      foreach(uint pid in before) {\n        IntPtr handle=pid==root.pid?root.process:OpenProcess(0x00101000,false,pid);\n        Check(handle!=IntPtr.Zero,\"retain enumerated job member\");\n        members.Add(pid,handle); LiveMember(handle,job);\n        PI member=new PI(); member.pid=pid; member.process=handle;\n        string observed=StartIdentity(member,pid==root.pid?executable:\"\",profile);\n        if(pid==root.pid&&observed!=identity) throw new Exception(\"retained root creation identity changed\");\n        identities.Add(observed);\n      }\n      string windows=Windows(members),listeners=Listeners(members);\n      foreach(IntPtr handle in members.Values) LiveMember(handle,job);\n      if(string.Join(\",\",before)!=string.Join(\",\",Members(job))||windows!=Windows(members)||listeners!=Listeners(members))\n        throw new Exception(\"owned runtime changed during observation\");\n      foreach(IntPtr handle in members.Values) LiveMember(handle,job);\n      if(string.Join(\",\",before)!=string.Join(\",\",Members(job))) throw new Exception(\"owned membership changed before observation completion\");\n      LiveMember(root.process,job);\n      return \"{\\\"schema\\\":\\\"toolsenabled.owned-runtime-observation\\\",\\\"schemaVersion\\\":1,\\\"controlId\\\":\"+Json(controlId)+\n        \",\\\"requestId\\\":\"+request+\",\\\"operation\\\":\\\"observe-runtime\\\",\\\"observedAt\\\":\"+Json(DateTime.UtcNow.ToString(\"o\"))+\n        \",\\\"root\\\":\"+identity+\",\\\"processes\\\":[\"+string.Join(\",\",identities.ToArray())+\"],\\\"windows\\\":\"+windows+\",\\\"listeners\\\":\"+listeners+\"}\";\n    } finally {\n      foreach(KeyValuePair<uint,IntPtr> member in members) if(member.Key!=root.pid) CloseHandle(member.Value);\n    }\n  }\n  static string Boolean(bool value) { return value?\"true\":\"false\"; }\n  static string FileDigest(Stream input) {\n    using(SHA256 algorithm=SHA256.Create()) return BitConverter.ToString(algorithm.ComputeHash(input)).Replace(\"-\",\"\").ToLowerInvariant();\n  }\n  // A lease owns every fixed path component and the exact final handle. A\n  // capture is never closed/reopened between creation, pumping and hashing.\n  sealed class PlainLease : IDisposable {\n    readonly List<IntPtr> handles=new List<IntPtr>(); IntPtr leaf; FILEINFO original; bool disposed;\n    public FileStream stream;\n    static PlainLease Open(string file,bool finalDirectory,uint disposition,bool writable) {\n      string dev=OwnerProfile();\n      if(!file.Equals(dev,StringComparison.OrdinalIgnoreCase)&&!file.StartsWith(dev+@\"\\\",StringComparison.OrdinalIgnoreCase))\n        throw new Exception(\"leased path leaves current OS account fence\");\n      string[] parts=file.Length==dev.Length?new string[0]:file.Substring(dev.Length+1).Split('\\\\');\n      foreach(string part in parts) {\n        if(part.Length==0||part==\".\"||part==\"..\"||part.EndsWith(\".\")||part.EndsWith(\" \")||\n            part.IndexOfAny(new char[]{':','/','<','>','\"','|','?','*'})>=0||\n            System.Text.RegularExpressions.Regex.IsMatch(part,@\"^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\.|$)\"))\n          throw new Exception(\"ambiguous leased path\");\n        foreach(char character in part) if(character<32) throw new Exception(\"invalid leased path byte\");\n      }\n      PlainLease lease=new PlainLease();\n      try {\n        string current=Path.GetPathRoot(file);\n        string[] fullParts=file.Substring(current.Length).Split('\\\\');\n        for(int index=-1;index<fullParts.Length;index++) {\n          bool directory=index<fullParts.Length-1||finalDirectory;\n          if(index>=0) current=Path.Combine(current,fullParts[index]);\n          SA security=new SA(); security.length=Marshal.SizeOf(typeof(SA)); security.inherit=false;\n          uint access=directory?0x80u:writable?0xc0000000u:0x80000000u;\n          IntPtr handle=CreateFile(current,access,1,ref security,directory?3:disposition,0x02200000,IntPtr.Zero);\n          Check(handle!=new IntPtr(-1),\"retain plain leased path\"); lease.handles.Add(handle);\n          FILEINFO info; Check(GetFileInformationByHandle(handle,out info),\"observe plain leased path\");\n          if((info.attributes&0x400)!=0||directory!=((info.attributes&0x10)!=0)||(!directory&&info.links!=1))\n            throw new Exception(\"leased path is linked or not ordinary\");\n          if(!directory) {\n            lease.leaf=handle; lease.original=info;\n            lease.stream=new FileStream(new SafeFileHandle(handle,false),writable?FileAccess.ReadWrite:FileAccess.Read,65536,false);\n          }\n        }\n        return lease;\n      } catch { lease.Dispose(); throw; }\n    }\n    public static PlainLease DirectoryLease(string directory) { return Open(directory,true,3,false); }\n    public static PlainLease ReadLease(string file) { return Open(file,false,3,false); }\n    public static PlainLease Capture(string file,bool create) {\n      PlainLease lease=Open(file,false,create?1u:3u,true);\n      try { if(lease.stream.Length!=0) throw new Exception(\"capture placeholder is not empty\"); return lease; }\n      catch { lease.Dispose(); throw; }\n    }\n    public string Seal(long expected) {\n      if(disposed||stream==null||expected<0||stream.Length!=expected) throw new Exception(\"capture length differs\");\n      FILEINFO before,after; Check(GetFileInformationByHandle(leaf,out before),\"observe capture before seal\");\n      stream.Position=0; string digest=FileDigest(stream);\n      Check(GetFileInformationByHandle(leaf,out after),\"observe capture after seal\");\n      foreach(FILEINFO info in new FILEINFO[]{before,after}) {\n        if(info.volume!=original.volume||info.highIndex!=original.highIndex||info.lowIndex!=original.lowIndex||\n            info.links!=1||(info.attributes&0x410)!=0||(((long)info.highSize<<32)+info.lowSize)!=expected)\n          throw new Exception(\"capture identity changed while sealing\");\n      }\n      if(stream.Position!=expected||stream.Length!=expected) throw new Exception(\"capture read was incomplete\");\n      return digest;\n    }\n    public void Dispose() {\n      if(disposed) return; disposed=true;\n      List<Exception> failures=new List<Exception>();\n      try { if(stream!=null) stream.Dispose(); }\n      catch(Exception e) { failures.Add(e); }\n      finally {\n        stream=null;\n        // Attempt every release even if flushing or an earlier CloseHandle\n        // failed. Never retry an uncertain handle after its value can be reused.\n        for(int index=handles.Count-1;index>=0;index--) {\n          try { Check(CloseHandle(handles[index]),\"release plain leased path\"); }\n          catch(Exception e) { failures.Add(e); }\n          finally { handles[index]=IntPtr.Zero; }\n        }\n        handles.Clear();\n      }\n      if(failures.Count>0) throw new AggregateException(\"plain lease cleanup failed\",failures);\n    }\n  }\n  static string CapturedFile(Pump capture,long expected) {\n    if(capture==null||!capture.Join(0)||!capture.sealedCapture||capture.error!=null||capture.exceeded||\n        expected<0||expected>16*1024*1024||capture.bytes!=expected||capture.sha256==null)\n      throw new Exception(\"reader capture did not finish its same-handle seal\");\n    return \"{\\\"sha256\\\":\"+Json(capture.sha256)+\",\\\"bytes\\\":\"+expected+\"}\";\n  }\n  // A private subgroup inside the SAME retained parent Job. No blocking child\n  // runner or second admission: the parent loop ticks this operation while it\n  // continues checking root liveness, cancellation and its own output limits.\n  sealed class ReaderOperation : IDisposable {\n    const string Executable=@\"\x43:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\";\n    readonly IntPtr parent; readonly PI root; readonly string helper,expectedHash,product,profile,cancellationFile;\n    readonly string[] environment; readonly string directory; readonly Stopwatch watch=new Stopwatch(),phaseWatch=new Stopwatch();\n    IntPtr job=IntPtr.Zero,outRead=IntPtr.Zero,outWrite=IntPtr.Zero,errRead=IntPtr.Zero,errWrite=IntPtr.Zero,input=IntPtr.Zero,env=IntPtr.Zero,attrs=IntPtr.Zero,handles=IntPtr.Zero;\n    PI process=new PI(); public Pump output,error; PlainLease helperLease,stdoutLease,stderrLease;\n    bool assigned,attrReady,disposed; int phase;\n    public readonly OwnedJobResult result=new OwnedJobResult();\n    public bool finished,stdoutDrained,stderrDrained; public uint activeProcesses;\n    public string stdout,stderr;\n    public ReaderOperation(IntPtr owner,PI original,string script,string hash,string id,string selectedProfile,string[] variables,string cancel,string target) {\n      parent=owner; root=original; helper=script; expectedHash=hash; product=id; profile=selectedProfile; environment=(string[])variables.Clone(); cancellationFile=cancel; directory=target;\n    }\n    public void Begin() {\n      LiveMember(root.process,parent);\n      if(File.Exists(cancellationFile)) throw new OperationCanceledException(\"reader cancelled before creation\");\n      stdout=Path.Combine(directory,\"stdout.bin\"); stderr=Path.Combine(directory,\"stderr.bin\");\n      using(PlainLease parentPath=PlainLease.DirectoryLease(Path.GetDirectoryName(directory))) {\n        Check(CreateDirectory(directory,IntPtr.Zero),\"create exclusive reader evidence directory\");\n        using(PlainLease targetPath=PlainLease.DirectoryLease(directory)) {\n          stdoutLease=PlainLease.Capture(stdout,true); stderrLease=PlainLease.Capture(stderr,true);\n        }\n      }\n      // Retain fixed \x43:\\ and \x43:\\Users directory metadata without enumeration,\n      // then the Dev profile, every ancestor and the exact leaf. Keep them plain\n      // and immovable while PowerShell opens the script; no reparse is followed.\n      helperLease=PlainLease.ReadLease(helper);\n      if(helperLease.stream.Length<=0||helperLease.stream.Length>1024*1024||FileDigest(helperLease.stream)!=expectedHash) throw new Exception(\"fixed installed reader bytes differ\");\n      helperLease.stream.Position=0;\n      job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero,\"create reader subgroup\");\n      LIMIT limits=new LIMIT(); limits.basic.flags=0x2000; Check(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(LIMIT))),\"set reader kill-on-close\");\n      SA security=new SA(); security.length=Marshal.SizeOf(typeof(SA)); security.inherit=true;\n      Check(CreatePipe(out outRead,out outWrite,ref security,0),\"reader stdout pipe\"); Check(SetHandleInformation(outRead,1,0),\"reader stdout isolation\");\n      Check(CreatePipe(out errRead,out errWrite,ref security,0),\"reader stderr pipe\"); Check(SetHandleInformation(errRead,1,0),\"reader stderr isolation\");\n      input=CreateFile(\"NUL\",0x80000000,3,ref security,3,0,IntPtr.Zero); Check(input!=new IntPtr(-1),\"reader stdin NUL\");\n      IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size); attrs=Marshal.AllocHGlobal(size);\n      Check(InitializeProcThreadAttributeList(attrs,1,0,ref size),\"reader handle list\"); attrReady=true;\n      handles=Marshal.AllocHGlobal(IntPtr.Size*3); Marshal.WriteIntPtr(handles,0,input); Marshal.WriteIntPtr(handles,IntPtr.Size,outWrite); Marshal.WriteIntPtr(handles,IntPtr.Size*2,errWrite);\n      Check(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero),\"reader inherited handles\");\n      SIX startup=new SIX(); startup.start.cb=Marshal.SizeOf(typeof(SIX)); startup.start.flags=0x101; startup.start.show=0; startup.start.input=input; startup.start.output=outWrite; startup.start.error=errWrite; startup.attributes=attrs;\n      string[] args=new string[]{\"-NoProfile\",\"-NonInteractive\",\"-ExecutionPolicy\",\"Bypass\",\"-File\",helper,\"-Product\",product};\n      StringBuilder command=new StringBuilder(Quote(Executable)); foreach(string argument in args) command.Append(' ').Append(Quote(argument));\n      Array.Sort(environment,StringComparer.OrdinalIgnoreCase); env=Marshal.StringToHGlobalUni(string.Join(\"\\0\",environment)+\"\\0\\0\");\n      Check(CreateProcess(Executable,command,IntPtr.Zero,IntPtr.Zero,true,0x08080404,env,Path.GetDirectoryName(helper),ref startup,out process),\"create suspended reader\"); result.processCreated=true;\n      Check(AssignProcessToJobObject(parent,process.process),\"assign suspended reader to parent\");\n      Check(AssignProcessToJobObject(job,process.process),\"assign suspended reader to subgroup\"); assigned=true;\n      LiveMember(process.process,parent); LiveMember(process.process,job);\n      bool rootMember; Check(IsProcessInJob(root.process,job,out rootMember),\"check reader subgroup excludes product\");\n      if(rootMember) throw new Exception(\"reader subgroup incorrectly owns product root\");\n      result.startIdentity=StartIdentity(process,Executable,profile);\n      output=new Pump(outRead,stdoutLease,16*1024*1024); outRead=IntPtr.Zero; stdoutLease=null; output.Start();\n      error=new Pump(errRead,stderrLease,16*1024*1024); errRead=IntPtr.Zero; stderrLease=null; error.Start();\n      LiveMember(root.process,parent);\n      if(File.Exists(cancellationFile)) throw new OperationCanceledException(\"reader cancelled before resume\");\n      Check(ResumeThread(process.thread)!=0xffffffff,\"resume reader\");\n      CloseHandle(outWrite); outWrite=IntPtr.Zero; CloseHandle(errWrite); errWrite=IntPtr.Zero;\n      watch.Start(); phase=1;\n    }\n    void Stop() {\n      if(assigned) Check(TerminateJobObject(job,0xe011),\"terminate reader subgroup\");\n      else if(result.processCreated&&WaitForSingleObject(process.process,0)!=0) Check(TerminateProcess(process.process,0xe012),\"terminate retained suspended reader\");\n      if(outWrite!=IntPtr.Zero) { CloseHandle(outWrite); outWrite=IntPtr.Zero; }\n      if(errWrite!=IntPtr.Zero) { CloseHandle(errWrite); errWrite=IntPtr.Zero; }\n      phase=3; phaseWatch.Restart();\n    }\n    public void Tick() {\n      if(finished) return;\n      if(phase==1) {\n        if(File.Exists(cancellationFile)) { result.cancelled=true; Stop(); }\n        else if(output.exceeded||error.exceeded) { result.outputLimitExceeded=true; Stop(); }\n        else if(output.error!=null||error.error!=null) { result.error=\"reader output pump failed\"; Stop(); }\n        else if(watch.ElapsedMilliseconds>=60000) { result.timedOut=true; Stop(); }\n        else if(WaitForSingleObject(process.process,0)==0) { phase=2; phaseWatch.Restart(); }\n      }\n      if(phase==2) {\n        if(Active(job)==0) { phase=3; phaseWatch.Restart(); }\n        else if(phaseWatch.ElapsedMilliseconds>=300) { result.hadRemainingChildren=true; Stop(); }\n      }\n      if(phase==3) {\n        activeProcesses=assigned?Active(job):0;\n        result.rootExited=!result.processCreated||WaitForSingleObject(process.process,0)==0;\n        stdoutDrained=output==null||output.Join(0); stderrDrained=error==null||error.Join(0);\n        if(activeProcesses==0&&result.rootExited&&stdoutDrained&&stderrDrained) {\n          result.cleanupConfirmed=(output==null||!output.cleanupFailed)&&(error==null||!error.cleanupFailed); finished=true;\n          uint code; if(result.processCreated&&GetExitCodeProcess(process.process,out code)) result.exitCode=code;\n          if(output!=null) { result.stdoutBytes=output.bytes; result.outputLimitExceeded|=output.exceeded; if(output.error!=null) result.error=\"reader stdout capture: \"+output.error; }\n          if(error!=null) { result.stderrBytes=error.bytes; result.outputLimitExceeded|=error.exceeded; if(error.error!=null) result.error=\"reader stderr capture: \"+error.error; }\n        } else if(phaseWatch.ElapsedMilliseconds>=5000) { result.cleanupConfirmed=false; finished=true; }\n      }\n    }\n    public bool StopAndDrain(int budget) {\n      if(finished) return result.cleanupConfirmed;\n      try {\n        result.cancelled=true; Stop();\n        Stopwatch end=Stopwatch.StartNew();\n        while(!finished&&end.ElapsedMilliseconds<budget) { Tick(); if(!finished) Thread.Sleep(10); }\n        return finished&&result.cleanupConfirmed;\n      } catch { return false; }\n    }\n    public string Descriptor() {\n      if(!finished||!result.processCreated||!result.rootExited||!result.cleanupConfirmed||result.exitCode!=0||result.cancelled||result.timedOut||\n          result.outputLimitExceeded||result.hadRemainingChildren||result.error!=null||!stdoutDrained||!stderrDrained||activeProcesses!=0)\n        throw new Exception(\"installed reader failed or did not prove subgroup cleanup\"+\n          (result.error==null?\"\":\": \"+result.error));\n      return \"{\\\"processCreated\\\":true,\\\"rootExited\\\":true,\\\"timedOut\\\":false,\\\"outputLimitExceeded\\\":false,\\\"hadRemainingChildren\\\":false,\\\"cleanupConfirmed\\\":true,\\\"cancelled\\\":false,\\\"exitCode\\\":0,\"+\n        \"\\\"stdoutBytes\\\":\"+result.stdoutBytes+\",\\\"stderrBytes\\\":\"+result.stderrBytes+\",\\\"error\\\":null,\\\"startIdentity\\\":\"+result.startIdentity+\n        \",\\\"activeProcesses\\\":0,\\\"stdoutDrained\\\":true,\\\"stderrDrained\\\":true}\";\n    }\n    public void Dispose() {\n      if(disposed) return; disposed=true;\n      if(outWrite!=IntPtr.Zero) CloseHandle(outWrite); if(errWrite!=IntPtr.Zero) CloseHandle(errWrite);\n      if(input!=IntPtr.Zero&&input!=new IntPtr(-1)) CloseHandle(input);\n      if(job!=IntPtr.Zero) CloseHandle(job);\n      if(outRead!=IntPtr.Zero) CloseHandle(outRead); if(errRead!=IntPtr.Zero) CloseHandle(errRead);\n      if(process.thread!=IntPtr.Zero) CloseHandle(process.thread); if(process.process!=IntPtr.Zero) CloseHandle(process.process);\n      if(attrReady) DeleteProcThreadAttributeList(attrs); if(attrs!=IntPtr.Zero) Marshal.FreeHGlobal(attrs);\n      if(handles!=IntPtr.Zero) Marshal.FreeHGlobal(handles); if(env!=IntPtr.Zero) Marshal.FreeHGlobal(env);\n      if(output!=null) output.Release(); if(error!=null) error.Release();\n      if(stdoutLease!=null) stdoutLease.Dispose(); if(stderrLease!=null) stderrLease.Dispose();\n      if(helperLease!=null) helperLease.Dispose();\n    }\n  }\n  // The controller owns this private standard-input pipe. Product children\n  // inherit only their NUL/stdout/stderr handles, never either control pipe.\n  // Polling avoids a blocked reader thread during cancellation and shutdown.\n  sealed class RuntimeControl {\n    readonly IntPtr input; readonly string id; string pending=\"\"; int sequence;\n    readonly string readerProduct,readerHelper,readerHash,readerDirectory,cancellationFile;\n    readonly string[] environment; ReaderOperation reader; string readerRoot;\n    public RuntimeControl(string controlId,string product,string helper,string helperHash,string directory,string cancel,string[] variables) {\n      Guid parsed; if(!Guid.TryParseExact(controlId,\"D\",out parsed)) throw new Exception(\"invalid native control identity\");\n      id=controlId; input=GetStdHandle(-10);\n      if(input==IntPtr.Zero||input==new IntPtr(-1)) throw new Exception(\"private control input is absent\");\n      if(product!=\"\"&&product!=\"toolsenabled\"&&product!=\"scribe\"&&product!=\"web-editor\"&&product!=\"presentation-suite\") throw new Exception(\"unknown fixed reader product\");\n      readerProduct=product; readerHelper=helper; readerHash=helperHash; readerDirectory=directory; cancellationFile=cancel; environment=variables;\n      Console.OutputEncoding=new UTF8Encoding(false);\n    }\n    public bool StopReader(int cleanup) {\n      if(reader==null) return true;\n      bool clean=reader.StopAndDrain(cleanup); reader.Dispose(); reader=null; return clean;\n    }\n    public void Poll(IntPtr job,PI root,string executable,string profile,string identity) {\n      if(reader!=null) {\n        reader.Tick();\n        if(reader.finished) {\n          string descriptor=reader.Descriptor();\n          LiveMember(root.process,job);\n          string after=StartIdentity(root,executable,profile);\n          if(after!=identity||readerRoot!=identity) throw new Exception(\"product root changed during reader operation\");\n          string stdout=CapturedFile(reader.output,reader.result.stdoutBytes),stderr=CapturedFile(reader.error,reader.result.stderrBytes);\n          LiveMember(root.process,job);\n          string readerReply=\"{\\\"schema\\\":\\\"toolsenabled.owned-installed-state-reader\\\",\\\"schemaVersion\\\":1,\\\"controlId\\\":\"+Json(id)+\n            \",\\\"requestId\\\":\"+sequence+\",\\\"operation\\\":\\\"observe-installed-state\\\",\\\"product\\\":\"+Json(readerProduct)+\n            \",\\\"observedAt\\\":\"+Json(DateTime.UtcNow.ToString(\"o\"))+\",\\\"rootBefore\\\":\"+readerRoot+\",\\\"rootAfter\\\":\"+after+\n            \",\\\"reader\\\":\"+descriptor+\",\\\"stdout\\\":\"+stdout+\",\\\"stderr\\\":\"+stderr+\"}\";\n          if(Encoding.UTF8.GetByteCount(readerReply)>512*1024) throw new Exception(\"reader descriptor exceeds its bound\");\n          Console.Out.Write(readerReply+\"\\n\"); Console.Out.Flush();\n          reader.Dispose(); reader=null;\n        }\n      }\n      uint available; Check(PeekNamedPipe(input,IntPtr.Zero,0,IntPtr.Zero,out available,IntPtr.Zero),\"poll private control input\");\n      if(available==0) return;\n      if(available>64) throw new Exception(\"control request exceeds its bound\");\n      byte[] buffer=new byte[(int)available]; uint read;\n      Check(ReadFile(input,buffer,available,out read,IntPtr.Zero),\"read private control request\");\n      if(read==0||read>available) throw new Exception(\"control input is incomplete\");\n      for(int i=0;i<(int)read;i++) { if(buffer[i]!=10&&(buffer[i]<32||buffer[i]>126)) throw new Exception(\"invalid control byte\"); pending+=(char)buffer[i]; }\n      if(pending.Length>64) throw new Exception(\"control request exceeds its bound\");\n      if(pending.IndexOf('\\n')<0) return;\n      bool runtime=pending==\"observe-runtime:\"+(sequence+1)+\"\\n\";\n      bool installed=pending==\"observe-installed-state:\"+(sequence+1)+\"\\n\";\n      if(sequence>=128||reader!=null||(!runtime&&!installed)||(installed&&readerProduct==\"\")) throw new Exception(\"unknown, duplicate or out-of-order control request\");\n      pending=\"\"; sequence++;\n      if(installed) {\n        LiveMember(root.process,job);\n        readerRoot=StartIdentity(root,executable,profile);\n        if(readerRoot!=identity) throw new Exception(\"product root changed before reader operation\");\n        reader=new ReaderOperation(job,root,readerHelper,readerHash,readerProduct,profile,environment,cancellationFile,\n          Path.Combine(readerDirectory,\"installed-state-\"+sequence.ToString(\"D4\")));\n        reader.Begin(); return;\n      }\n      string reply=RuntimeObservation(job,root,executable,profile,identity,id,sequence);\n      if(Encoding.UTF8.GetByteCount(reply)>512*1024) throw new Exception(\"runtime observation exceeds its bound\");\n      Console.Out.Write(reply+\"\\n\"); Console.Out.Flush();\n    }\n  }\n  static void PublishStart(string file,string value) {\n    string temporary=file+\".writing\"; byte[] bytes=new UTF8Encoding(false).GetBytes(value);\n    using(FileStream output=new FileStream(temporary,FileMode.CreateNew,FileAccess.Write,FileShare.Read)) { output.Write(bytes,0,bytes.Length); output.Flush(true); }\n    File.Move(temporary,file);\n  }\n  sealed class Pump {\n    public long bytes; public volatile bool exceeded,cleanupFailed; public volatile string error; public string sha256; public bool sealedCapture;\n    readonly object gate=new object(); readonly long limit; readonly Thread thread;\n    PlainLease capture; IntPtr readHandle; bool started,released;\n    public Pump(IntPtr handle,PlainLease sink,long maximum) {\n      readHandle=handle; capture=sink; limit=maximum; thread=new Thread(Work); thread.IsBackground=true;\n    }\n    public void Start() {\n      lock(gate) { if(started||released) throw new Exception(\"capture pump already started or released\"); started=true; }\n      try { thread.Start(); }\n      catch { lock(gate) { started=(thread.ThreadState&System.Threading.ThreadState.Unstarted)==0; } throw; }\n    }\n    public bool Join(int milliseconds) {\n      lock(gate) { if(!started) return true; }\n      return thread.Join(milliseconds);\n    }\n    void Work() {\n      try {\n        IntPtr ownedInput=readHandle; readHandle=IntPtr.Zero;\n        // The handle's outer using also closes it if constructing FileStream\n        // fails, before the worker can acknowledge completion.\n        using(SafeFileHandle pipe=new SafeFileHandle(ownedInput,true))\n        using(FileStream input=new FileStream(pipe,FileAccess.Read,65536,false)) {\n          byte[] buffer=new byte[65536]; int count;\n          while((count=input.Read(buffer,0,buffer.Length))>0) {\n            long remaining=limit-bytes;\n            if(remaining>0) capture.stream.Write(buffer,0,(int)Math.Min(remaining,count));\n            bytes+=count; if(bytes>limit) exceeded=true;\n          }\n          capture.stream.Flush(true);\n          // Sealing stays on this worker: a stuck flush/hash cannot block the\n          // owner loop or become a successful pipe-drained acknowledgement.\n          if(!exceeded) { sha256=capture.Seal(bytes); sealedCapture=true; }\n        }\n      } catch(Exception e) { error=e.Message; sha256=null; sealedCapture=false; }\n      finally {\n        PlainLease release;\n        lock(gate) { release=capture; capture=null; }\n        // Disposal is part of the worker's bounded Join, including success.\n        // A slow flush/close never moves back onto the owner polling thread.\n        if(release!=null) {\n          try { release.Dispose(); }\n          catch(Exception e) { cleanupFailed=true; error=\"capture release: \"+e.Message; sha256=null; sealedCapture=false; }\n        }\n      }\n    }\n    public void Release() {\n      PlainLease release=null; IntPtr pipe=IntPtr.Zero;\n      lock(gate) {\n        // A started worker exclusively owns disposal, even after it finishes.\n        // If it cannot join, its retained leases remain its own responsibility.\n        if(started||released) return;\n        released=true; release=capture; capture=null; pipe=readHandle; readHandle=IntPtr.Zero;\n      }\n      List<Exception> failures=new List<Exception>();\n      try { if(pipe!=IntPtr.Zero) Check(CloseHandle(pipe),\"release unstarted capture pipe\"); }\n      catch(Exception e) { failures.Add(e); }\n      try { if(release!=null) release.Dispose(); }\n      catch(Exception e) { failures.Add(e); }\n      if(failures.Count>0) throw new AggregateException(\"unstarted capture cleanup failed\",failures);\n    }\n  }\n  public static OwnedJobResult Run(string executable,string[] args,string cwd,string[] environment,string stdout,string stderr,int timeout,int cleanup,int grace,long limit,string cancellationFile,string startFile,string expectedProfile,string controlId,string readerProduct,string readerHelper,string readerHash,string readerDirectory) {\n    OwnedJobResult result=new OwnedJobResult(); IntPtr job=IntPtr.Zero, outRead=IntPtr.Zero,outWrite=IntPtr.Zero,errRead=IntPtr.Zero,errWrite=IntPtr.Zero,input=IntPtr.Zero,env=IntPtr.Zero,attrs=IntPtr.Zero,handles=IntPtr.Zero;\n    PI process=new PI(); Pump output=null,error=null; PlainLease stdoutLease=null,stderrLease=null;\n    bool assigned=false,attrReady=false; RuntimeControl control=null;\n    try {\n      if(File.Exists(cancellationFile)) { result.cancelled=true; result.cleanupConfirmed=true; return result; }\n      // JS keeps empty placeholders for not-run batch rows. Open and verify\n      // those exact files without truncation, then retain them through capture.\n      stdoutLease=PlainLease.Capture(stdout,false); stderrLease=PlainLease.Capture(stderr,false);\n      job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero,\"create owned job\");\n      LIMIT limits=new LIMIT(); limits.basic.flags=0x2000; Check(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(LIMIT))),\"set kill-on-close\");\n      SA security=new SA(); security.length=Marshal.SizeOf(typeof(SA)); security.inherit=true;\n      Check(CreatePipe(out outRead,out outWrite,ref security,0),\"stdout pipe\"); Check(SetHandleInformation(outRead,1,0),\"stdout read isolation\");\n      Check(CreatePipe(out errRead,out errWrite,ref security,0),\"stderr pipe\"); Check(SetHandleInformation(errRead,1,0),\"stderr read isolation\");\n      input=CreateFile(\"NUL\",0x80000000,3,ref security,3,0,IntPtr.Zero); Check(input!=new IntPtr(-1),\"stdin NUL\");\n      IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size); attrs=Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(attrs,1,0,ref size),\"initialize handle list\"); attrReady=true;\n      handles=Marshal.AllocHGlobal(IntPtr.Size*3); Marshal.WriteIntPtr(handles,0,input); Marshal.WriteIntPtr(handles,IntPtr.Size,outWrite); Marshal.WriteIntPtr(handles,IntPtr.Size*2,errWrite);\n      Check(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero),\"restrict inherited handles\");\n      SIX startup=new SIX(); startup.start.cb=Marshal.SizeOf(typeof(SIX)); startup.start.flags=0x101; startup.start.show=0; startup.start.input=input; startup.start.output=outWrite; startup.start.error=errWrite; startup.attributes=attrs;\n      StringBuilder command=new StringBuilder(Quote(executable)); foreach(string argument in args) command.Append(' ').Append(Quote(argument));\n      Array.Sort(environment,StringComparer.OrdinalIgnoreCase); env=Marshal.StringToHGlobalUni(string.Join(\"\\0\",environment)+\"\\0\\0\");\n      Check(CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,true,0x08080404,env,cwd,ref startup,out process),\"create suspended owned process\"); result.processCreated=true;\n      Check(AssignProcessToJobObject(job,process.process),\"assign suspended child to job\"); assigned=true;\n      string identity=StartIdentity(process,executable,expectedProfile);\n      output=new Pump(outRead,stdoutLease,limit); outRead=IntPtr.Zero; stdoutLease=null; output.Start();\n      error=new Pump(errRead,stderrLease,limit); errRead=IntPtr.Zero; stderrLease=null; error.Start();\n      if(File.Exists(cancellationFile)) { result.cancelled=true; throw new OperationCanceledException(\"cancelled before owned child resume\"); }\n      Check(ResumeThread(process.thread)!=0xffffffff,\"resume owned child\"); CloseHandle(outWrite); outWrite=IntPtr.Zero; CloseHandle(errWrite); errWrite=IntPtr.Zero;\n      control=String.IsNullOrEmpty(controlId)?null:new RuntimeControl(controlId,readerProduct,readerHelper,readerHash,readerDirectory,cancellationFile,environment);\n      result.startIdentity=identity; PublishStart(startFile,identity);\n      DateTime deadline=DateTime.UtcNow.AddMilliseconds(timeout); bool stop=false;\n      while(WaitForSingleObject(process.process,20)!=0) {\n        if(File.Exists(cancellationFile)) { result.cancelled=true; stop=true; break; }\n        if(output.exceeded||error.exceeded) { result.outputLimitExceeded=true; stop=true; break; }\n        if(output.error!=null||error.error!=null) throw new Exception(\"output pump failed\");\n        if(DateTime.UtcNow>=deadline) { result.timedOut=true; stop=true; break; }\n        if(control!=null) control.Poll(job,process,executable,expectedProfile,identity);\n      }\n      if(!stop) {\n        DateTime end=DateTime.UtcNow.AddMilliseconds(grace);\n        while(Active(job)>0 && DateTime.UtcNow<end) Thread.Sleep(10);\n        if(Active(job)>0) { result.hadRemainingChildren=true; stop=true; }\n      }\n      if(stop) Check(TerminateJobObject(job,0xe001),\"terminate owned job\");\n      DateTime cleanupEnd=DateTime.UtcNow.AddMilliseconds(cleanup);\n      while(Active(job)>0 && DateTime.UtcNow<cleanupEnd) Thread.Sleep(10);\n      result.cleanupConfirmed=Active(job)==0;\n      result.rootExited=WaitForSingleObject(process.process,0)==0;\n      uint code; if(result.rootExited && GetExitCodeProcess(process.process,out code)) result.exitCode=code;\n    } catch(Exception e) {\n      result.error=e.Message;\n      if(assigned) { TerminateJobObject(job,0xe002); DateTime end=DateTime.UtcNow.AddMilliseconds(cleanup); try { while(Active(job)>0 && DateTime.UtcNow<end) Thread.Sleep(10); result.cleanupConfirmed=Active(job)==0; } catch {} }\n      else if(result.processCreated) { TerminateProcess(process.process,0xe003); result.cleanupConfirmed=WaitForSingleObject(process.process,(uint)cleanup)==0; }\n      else result.cleanupConfirmed=true;\n    } finally {\n      if(control!=null&&!control.StopReader(cleanup)) result.cleanupConfirmed=false;\n      if(outWrite!=IntPtr.Zero) CloseHandle(outWrite); if(errWrite!=IntPtr.Zero) CloseHandle(errWrite); if(input!=IntPtr.Zero && input!=new IntPtr(-1)) CloseHandle(input);\n      if(job!=IntPtr.Zero) CloseHandle(job);\n      if(output!=null) { bool joined=output.Join(cleanup); if(!joined||output.cleanupFailed) result.cleanupConfirmed=false; result.stdoutBytes=output.bytes; result.outputLimitExceeded|=output.exceeded; if(output.error!=null) result.error=\"stdout capture: \"+output.error; if(joined&&output.sealedCapture&&output.error==null&&!output.exceeded) result.stdoutSha256=output.sha256; output.Release(); }\n      if(error!=null) { bool joined=error.Join(cleanup); if(!joined||error.cleanupFailed) result.cleanupConfirmed=false; result.stderrBytes=error.bytes; result.outputLimitExceeded|=error.exceeded; if(error.error!=null) result.error=\"stderr capture: \"+error.error; if(joined&&error.sealedCapture&&error.error==null&&!error.exceeded) result.stderrSha256=error.sha256; error.Release(); }\n      if(stdoutLease!=null) stdoutLease.Dispose(); if(stderrLease!=null) stderrLease.Dispose();\n      if(outRead!=IntPtr.Zero) CloseHandle(outRead); if(errRead!=IntPtr.Zero) CloseHandle(errRead);\n      if(process.thread!=IntPtr.Zero) CloseHandle(process.thread); if(process.process!=IntPtr.Zero) CloseHandle(process.process);\n      if(attrReady) DeleteProcThreadAttributeList(attrs); if(attrs!=IntPtr.Zero) Marshal.FreeHGlobal(attrs); if(handles!=IntPtr.Zero) Marshal.FreeHGlobal(handles); if(env!=IntPtr.Zero) Marshal.FreeHGlobal(env);\n    }\n    return result;\n  }\n}\n"}`;

const HELPER = `$ErrorActionPreference = 'Stop'\n$source = @'\n${NATIVE}\n'@\nAdd-Type -TypeDefinition $source\n` +
  `$spec = Get-Content -LiteralPath $args[0] -Raw -Encoding UTF8 | ConvertFrom-Json\n` +
  `$watch = [System.Diagnostics.Stopwatch]::StartNew()\n$attempted = 0\n$clean = $true\n$finished = $false\ntry {\nforeach ($item in $spec.jobs) {\n` +
  `  $remaining = $spec.batchTimeoutMs - $watch.ElapsedMilliseconds\n  if ($remaining -le 0 -or [System.IO.File]::Exists($spec.cancellationFile)) { break }\n` +
  `  $budget = [int][Math]::Min($remaining, $item.timeoutMs)\n` +
  `  $attempted++\n` +
  `  $result = [OwnedJob]::Run($item.command, [string[]]$item.args, $item.cwd, [string[]]$item.environment, $item.stdout, $item.stderr, $budget, $item.cleanupMs, $item.cleanupGraceMs, $item.maxOutputBytes, $spec.cancellationFile, $item.startFile, $item.expectedProfile, $item.controlId, $item.installedStateProduct, $item.installedReaderPath, $item.installedReaderSha256, $item.directory)\n` +
  `  $clean = $clean -and $result.cleanupConfirmed\n` +
  `  [System.IO.File]::WriteAllText($item.result, (($result | ConvertTo-Json -Compress) + "\n"), [System.Text.UTF8Encoding]::new($false))\n` +
  `  if (-not $result.cleanupConfirmed -or -not $result.rootExited -or $result.error -or $result.cancelled -or $result.timedOut -or $result.outputLimitExceeded -or $result.hadRemainingChildren -or $result.exitCode -ne 0) { break }\n}\n$finished = $true\n} finally {\n` +
  `  $batch = @{ attempted = $attempted; cleanupConfirmed = ($finished -and $clean); finished = $finished }\n` +
  `  [System.IO.File]::WriteAllText($spec.batchResult, (($batch | ConvertTo-Json -Compress) + "\n"), [System.Text.UTF8Encoding]::new($false))\n}\n`;

export async function runOwnedJob(options = {}) {
  const { evidenceRoot, signal, onStarted, runtimeObservations, installedStateProduct, ...job } = options;
  return (await runOwnedJobBatch({ jobs: [job], evidenceRoot, signal, onStarted, runtimeObservations, installedStateProduct, batchTimeoutMs: options.timeoutMs || 120000 }))[0];
}

function freezeObservation(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freezeObservation); Object.freeze(value); }
  return value;
}

// Pure packet validation, not attestation. Production origin comes from the
// retained helper's private pipe, never a report path or a caller callback.
export function parseOwnedRuntimeObservation(raw, { controlId, requestId, start } = {}) {
  const fail = () => { throw new Error('invalid, stale or unbound owned runtime observation'); };
  const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',');
  const integer = (value, minimum = 0, maximum = 0xffffffff) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
  const time = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\\x64:\d\\x64:\d\d\.\d{3,7}Z$/.test(value) ? Date.parse(value) : NaN;
  const processKeys = ['pid', 'startedAt', 'imagePath', 'userSid', 'elevated', 'integrityLevel', 'sessionId'];
  if (!Buffer.isBuffer(raw) || !raw.length || raw.length > 512 * 1024 ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(controlId || '') || !integer(requestId, 1, Number.MAX_SAFE_INTEGER)) fail();
  let value, text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); value = JSON.parse(text); } catch { fail(); }
  // Native serialization is compact JSON; duplicate keys and alternate numeric
  // spellings cannot acquire meaning different from the retained raw bytes.
  if (!raw.equals(Buffer.from(JSON.stringify(value), 'utf8')) || !exact(value, ['schema', 'schemaVersion', 'controlId', 'requestId',
    'operation', 'observedAt', 'root', 'processes', 'windows', 'listeners']) ||
    value.schema !== 'toolsenabled.owned-runtime-observation' || value.schemaVersion !== 1 ||
    value.controlId !== controlId || value.requestId !== requestId || value.operation !== 'observe-runtime') fail();
  const observed = time(value.observedAt), root = start?.processIdentity;
  if (!Number.isFinite(observed) || observed > Date.now() || !exact(root, processKeys)) fail();
  const identity = entry => {
    if (!exact(entry, processKeys) || !integer(entry.pid, 1) || !Number.isFinite(time(entry.startedAt)) ||
        time(entry.startedAt) > observed || time(entry.startedAt) < time(root.startedAt) ||
        typeof entry.imagePath !== 'string' || !/^[a-z]:[\\/]/i.test(entry.imagePath) ||
        /[:\x00-\x1f<>"|?*]/.test(entry.imagePath.slice(2)) ||
        entry.imagePath.slice(3).split(/[\\/]/).some(part => !part || part === '.' || part === '..' || /[ .]$/.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) ||
        typeof entry.userSid !== 'string' || !/^S-1-5-21-(\d+-){3}\d+$/.test(entry.userSid) ||
        typeof entry.elevated !== 'boolean' || !integer(entry.integrityLevel, 1) || !integer(entry.sessionId)) fail();
    // Lexical only: never stat an image path named by an untrusted packet.
    fencedPath(entry.imagePath, { system: true });
    for (const key of ['userSid', 'elevated', 'integrityLevel', 'sessionId']) if (entry[key] !== root[key]) fail();
  };
  identity(value.root);
  if (processKeys.some(key => value.root[key] !== root[key]) || observed < time(root.startedAt) ||
      !Array.isArray(value.processes) || !value.processes.length || value.processes.length > 256 ||
      !Array.isArray(value.windows) || value.windows.length > 1024 || !Array.isArray(value.listeners) || value.listeners.length > 2048) fail();
  const processes = new Map();
  for (const entry of value.processes) {
    identity(entry);
    if (processes.has(entry.pid)) fail();
    processes.set(entry.pid, entry);
  }
  if (!processes.has(root.pid) || processKeys.some(key => processes.get(root.pid)[key] !== root[key])) fail();
  const windows = new Set(), listeners = new Set();
  for (const entry of value.windows) {
    if (!exact(entry, ['hwnd', 'pid', 'threadId', 'visible']) || typeof entry.hwnd !== 'string' ||
        !/^0x[0-9a-f]{1,16}$/i.test(entry.hwnd) || BigInt(entry.hwnd) === 0n ||
        !integer(entry.pid, 1) || !processes.has(entry.pid) || !integer(entry.threadId, 1) || typeof entry.visible !== 'boolean') fail();
    const hwnd = BigInt(entry.hwnd).toString();
    if (windows.has(hwnd)) fail();
    windows.add(hwnd);
  }
  for (const entry of value.listeners) {
    if (!exact(entry, ['family', 'address', 'scopeId', 'port', 'pid']) ||
        !['IPv4', 'IPv6'].includes(entry.family) || typeof entry.address !== 'string' || entry.address.includes('%') ||
        isIP(entry.address) !== (entry.family === 'IPv4' ? 4 : 6) || !integer(entry.scopeId) ||
        (entry.family === 'IPv4' && entry.scopeId !== 0) || !integer(entry.port, 1, 65535) ||
        !integer(entry.pid, 1) || !processes.has(entry.pid)) fail();
    const address = entry.family === 'IPv6' ? new URL('http://[' + entry.address + ']/').hostname : entry.address;
    const endpoint = [entry.family, address.toLowerCase(), entry.scopeId, entry.port].join('/');
    if (listeners.has(endpoint)) fail();
    listeners.add(endpoint);
  }
  return freezeObservation(value);
}

// Parse-only descriptor validation. Reusing the process-field validator does
// not create native origin or turn caller bytes into an installed observation.
export function parseOwnedInstalledStateReader(raw, { controlId, requestId, start, product } = {}) {
  const fail = () => { throw new Error('invalid, stale or unbound installed reader observation'); };
  const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',');
  if (!Buffer.isBuffer(raw) || !raw.length || raw.length > 512 * 1024 ||
      !['toolsenabled', 'scribe', 'web-editor', 'presentation-suite'].includes(product)) fail();
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { fail(); }
  if (!raw.equals(Buffer.from(JSON.stringify(value), 'utf8')) ||
      !exact(value, ['schema', 'schemaVersion', 'controlId', 'requestId', 'operation', 'product', 'observedAt', 'rootBefore', 'rootAfter', 'reader', 'stdout', 'stderr']) ||
      value.schema !== 'toolsenabled.owned-installed-state-reader' || value.schemaVersion !== 1 ||
      value.controlId !== controlId || value.requestId !== requestId || value.operation !== 'observe-installed-state' ||
      value.product !== product || !Number.isSafeInteger(requestId) || requestId < 1 || requestId > 128) fail();
  const reader = value.reader;
  if (!exact(reader, ['processCreated', 'rootExited', 'timedOut', 'outputLimitExceeded', 'hadRemainingChildren', 'cleanupConfirmed',
    'cancelled', 'exitCode', 'stdoutBytes', 'stderrBytes', 'error', 'startIdentity', 'activeProcesses', 'stdoutDrained', 'stderrDrained'])) fail();
  if (['processCreated', 'rootExited', 'cleanupConfirmed', 'stdoutDrained', 'stderrDrained'].some(key => reader[key] !== true) ||
      ['timedOut', 'outputLimitExceeded', 'hadRemainingChildren', 'cancelled'].some(key => reader[key] !== false) ||
      reader.exitCode !== 0 || reader.activeProcesses !== 0 || reader.error !== null) fail();
  for (const name of ['stdout', 'stderr']) {
    const record = value[name];
    if (!exact(record, ['sha256', 'bytes']) || typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256) ||
        !Number.isSafeInteger(record.bytes) || record.bytes < 0 || record.bytes > 16 * 1024 * 1024 ||
        reader[name + 'Bytes'] !== record.bytes) fail();
  }
  if (!value.stdout.bytes || value.stderr.bytes || reader.startIdentity?.imagePath?.toLowerCase() !== POWERSHELL.toLowerCase()) fail();
  const processKeys = ['pid', 'startedAt', 'imagePath', 'userSid', 'elevated', 'integrityLevel', 'sessionId'];
  if (!exact(value.rootAfter, processKeys) || processKeys.some(key => value.rootAfter[key] !== value.rootBefore?.[key])) fail();
  parseOwnedRuntimeObservation(Buffer.from(JSON.stringify({
    schema: 'toolsenabled.owned-runtime-observation', schemaVersion: 1, controlId, requestId,
    operation: 'observe-runtime', observedAt: value.observedAt, root: value.rootBefore,
    processes: [value.rootBefore, reader.startIdentity], windows: [], listeners: [],
  })), { controlId, requestId, start });
  return freezeObservation(value);
}

function readOwnedStart(job) {
  const { data: bytes, identity: record, value } = capturedJson(job.startFile, 16384);
  if (!bytes.length ||
    Object.keys(value).sort().join(',') !== 'elevated,imagePath,integrityLevel,pid,sessionId,startedAt,userSid' ||
    !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt)) ||
    typeof value.userSid !== 'string' || !/^S-1-5-21-(\d+-){3}\d+$/.test(value.userSid) || typeof value.elevated !== 'boolean' ||
    !Number.isSafeInteger(value.integrityLevel) || value.integrityLevel <= 0 || !Number.isSafeInteger(value.sessionId) || value.sessionId < 0 ||
    path.relative(unlinkedPath(value.imagePath, { system: true }), job.command) !== '' ||
    fileIdentity(job.command, { system: true }).sha256 !== job.executable.sha256) throw new Error('owned startup identity or executable bytes differ');
  return Object.freeze({ scope: 'owned-process-start-observation', processIdentity: Object.freeze(value),
    executable: Object.freeze({ ...job.executable }), record: Object.freeze(record) });
}

// One helper compilation, a fresh native containment job for every command.
// Stop after the first failed/unclean command; subsequent rows are not-run.
export async function runOwnedJobBatch({ jobs, evidenceRoot, signal, onStarted, runtimeObservations = false, installedStateProduct = '', batchTimeoutMs = 30 * 60 * 1000 } = {}) {
  if (process.platform === 'linux') return runLinuxOwnedJobBatch({ jobs, evidenceRoot, signal, onStarted, runtimeObservations, installedStateProduct, batchTimeoutMs });
  if (process.platform !== 'win32') throw new Error('Windows owned-job qualification transport requires Windows');
  signal?.throwIfAborted();
  if (!Array.isArray(jobs) || !jobs.length || !Number.isSafeInteger(batchTimeoutMs) || batchTimeoutMs <= 0) throw new Error('a nonempty bounded job batch is required');
  if (onStarted !== undefined && (typeof onStarted !== 'function' || jobs.length !== 1)) throw new Error('startup observation requires one owned command and a synchronous observer');
  if (typeof runtimeObservations !== 'boolean' || (runtimeObservations && (jobs.length !== 1 || typeof onStarted !== 'function'))) throw new Error('runtime observations require one owned command and a startup observer');
  if (!['', 'toolsenabled', 'scribe', 'web-editor', 'presentation-suite'].includes(installedStateProduct) ||
      (installedStateProduct && !runtimeObservations)) throw new Error('installed reader requires one runtime session and a fixed product');
  const controlId = runtimeObservations ? randomUUID() : '';
  evidenceRoot = unlinkedPath(evidenceRoot, { directory: true });
  const toolchain = measureRegisteredToolchain();
  const powershell = toolchain.tools.powershell;
  const installedReader = installedStateProduct ? fileIdentity(INSTALLED_READER, { maximum: 1024 * 1024 }) : null;
  if (installedReader && installedReader.sha256 !== APPROVED_INSTALLED_READER_SHA256) throw new Error('fixed installed reader bytes changed; review its implementation');
  const implementation = measuredOwnedImplementation().sha256;
  const executables = new Map();
  const prepared = jobs.map(({ command, args = [], cwd, env = {}, sourceBinding, timeoutMs = 120000,
    maxOutputBytes = 8 * 1024 * 1024, cleanupMs = 5000, cleanupGraceMs = 300, expectedProfile = '' }) => {
    for (const [key, value] of Object.entries({ timeoutMs, maxOutputBytes, cleanupMs, cleanupGraceMs })) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer`);
    }
    if (maxOutputBytes > IDENTITY_LIMIT) throw new Error('owned output exceeds the supported byte budget');
    if (cleanupMs > 5000 || cleanupGraceMs > 5000) throw new Error('cleanup and grace budgets may not exceed five seconds');
    if (!['', 'windows-x64-standard', 'windows-x64-administrator'].includes(expectedProfile)) throw new Error('unknown expected privilege profile');
    if (runtimeObservations && !expectedProfile) throw new Error('runtime observations require an explicit chosen privilege profile');
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('invalid argument vector');
    command = unlinkedPath(command, { system: true }); cwd = unlinkedPath(cwd, { directory: true });
    const rel = path.relative(cwd, evidenceRoot);
    if (!rel || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))) throw new Error('raw job evidence must be outside the source/working payload');
    if (!executables.has(command)) executables.set(command, fileIdentity(command, { system: true }));
    const boundSource = sourceBinding === undefined ? undefined : structuredClone(sourceBinding);
    return { command, args, cwd, executable: executables.get(command), environment: registeredToolEnvironment(env, { cwd, sourceBinding: boundSource }),
      ...(boundSource ? { sourceBinding: boundSource } : {}), timeoutMs, maxOutputBytes, cleanupMs, cleanupGraceMs, expectedProfile, controlId,
      installedStateProduct, installedReaderPath: installedReader?.path || '', installedReaderSha256: installedReader?.sha256 || '' };
  });
  const lease = acquireOwnedExecution({ evidenceRoot, commandsSha256: hash(JSON.stringify(prepared.map(job => [job.command, ...job.args]))) });
  let helperStarted = false, batchCleanupConfirmed = false, admissionReleased = false;
  try {
  const directory = await mkdtemp(path.join(evidenceRoot, 'owned-job-'));
  lease.annotate({ evidenceDirectory: directory });
  for (const [index, job] of prepared.entries()) {
    job.directory = path.join(directory, String(index + 1).padStart(4, '0')); await mkdir(job.directory);
    job.stdout = path.join(job.directory, 'stdout.bin'); job.stderr = path.join(job.directory, 'stderr.bin'); job.result = path.join(job.directory, 'native-result.json');
    job.startFile = path.join(job.directory, 'native-start.json');
    await Promise.all([writeFile(job.stdout, '', { flag: 'wx', mode: 0o600 }), writeFile(job.stderr, '', { flag: 'wx', mode: 0o600 })]);
  }
  const helper = path.join(directory, 'owned-job.ps1'), specFile = path.join(directory, 'launch-spec.json');
  const cancellationFile = path.join(directory, 'cancel-requested');
  const batchResultFile = path.join(directory, 'native-batch-result.json');
  await writeFile(helper, HELPER, { flag: 'wx', mode: 0o600 });
  await writeFile(specFile, JSON.stringify({ batchTimeoutMs, cancellationFile, batchResult: batchResultFile, jobs: prepared.map(job => ({ ...job,
    environment: Object.keys(job.environment).sort().map(key => `${key}=${job.environment[key]}`) })) }), { flag: 'wx', mode: 0o600 });
  const environment = registeredToolEnvironment();
  const timeoutMs = batchTimeoutMs, cleanupMs = Math.max(...prepared.map(job => job.cleanupMs)), cleanupGraceMs = Math.max(...prepared.map(job => job.cleanupGraceMs));
  const startedAt = new Date().toISOString();
  const runtimeRecords = [], installedReaderRecords = [];
  signal?.throwIfAborted();
  const control = await new Promise(resolve => {
    helperStarted = true;
    const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, specFile], {
      cwd: directory, env: environment, windowsHide: true, stdio: [runtimeObservations ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    let output = '', oversized = false, timedOut = false, spawnError = null, done = false, cancelled = null, startupError = null;
    let startDelivered = false, startTimer, nativeExited = false;
    let startObservation, runtimeError = null, runtimeBuffer = Buffer.alloc(0), runtimeBytes = 0, requestId = 0, pendingObservation = null;
    const rejectObservation = error => {
      if (!pendingObservation) return;
      const pending = pendingObservation; pendingObservation = null; clearTimeout(pending.timer); pending.reject(error);
    };
    const stop = () => { try { child.kill('SIGKILL'); } catch {} };
    let abortDeadline, abortLastResort;
    const cancel = reason => {
      if (done || cancelled) return;
      cancelled = reason;
      rejectObservation(new Error('owned runtime observation cancelled before completion'));
      try {
        unlinkedPath(directory, { directory: true });
        const fd = fs.openSync(cancellationFile, 'wx', 0o600);
        try { fs.writeFileSync(fd, reason); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      } catch { stop(); }
      // First let the retained native job terminate its children and report
      // actual cleanup. An unresponsive helper has a separate bounded fallback;
      // killing it is NOT promoted to confirmed cleanup.
      abortDeadline = setTimeout(stop, cleanupMs * 3 + 5000);
      abortLastResort = setTimeout(abandon, cleanupMs * 3 + 10000);
    };
    const interrupt = () => cancel('SIGINT');
    const terminate = () => cancel('SIGTERM');
    const abort = () => cancel('ABORT');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    const detachSignals = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); signal?.removeEventListener('abort', abort); clearTimeout(abortDeadline); clearTimeout(abortLastResort); clearInterval(startTimer); };
    const observeStart = () => {
      if (!onStarted || done || cancelled || startDelivered || (runtimeObservations && nativeExited)) return;
      let observation;
      try {
        observation = readOwnedStart(prepared[0]);
      } catch (error) {
        if (error.code === 'ENOENT') return;
        startupError = error.message; cancel('START_OBSERVER_FAILED'); return;
      }
      try {
        startDelivered = true;
        startObservation = observation;
        const response = onStarted(observation, runtimeObservations ? runtimeChannel : undefined);
        if (response && typeof response.then === 'function') {
          Promise.resolve(response).catch(() => {});
          throw new Error('owned startup observer must be synchronous');
        }
      } catch (error) {
        startupError = error.message;
        cancel('START_OBSERVER_FAILED');
      }
    };
    const poisonRuntime = error => {
      runtimeError ||= error.message || String(error);
      rejectObservation(error);
      cancel('RUNTIME_OBSERVATION_FAILED');
    };
    const requestObservation = (operation, args) => {
        if (args.length || !runtimeObservations || !startObservation || done || nativeExited || cancelled || runtimeError || pendingObservation || requestId >= 128) {
          return Promise.reject(new Error('runtime observation is unavailable, concurrent, exhausted or has caller overrides'));
        }
        if (operation === 'observe-installed-state' && !installedReader) return Promise.reject(new Error('installed-state reader was not fixed at session creation'));
        const id = ++requestId;
        const budget = operation === 'observe-installed-state' ? 65000 : 5000;
        const result = new Promise((resolve, reject) => {
          pendingObservation = { id, operation, resolve, reject, deadlineNs: process.hrtime.bigint() + BigInt(budget) * 1_000_000n,
            timer: setTimeout(() => poisonRuntime(new Error('owned runtime observation deadline expired')), budget) };
          child.stdin.write(operation + ':' + id + '\n', error => { if (error) poisonRuntime(error); });
        });
        result.catch(() => {});
        return result;
    };
    const runtimeChannel = Object.freeze({
      active() { return !done && !nativeExited && !cancelled && !runtimeError; },
      observeRuntime(...args) { return requestObservation('observe-runtime', args); },
      observeInstalledState(...args) { return requestObservation('observe-installed-state', args); },
    });
    const collectRuntime = chunk => {
      if (done || cancelled) return;
      try {
        runtimeBytes += chunk.length;
        if (runtimeBytes > 32 * 1024 * 1024 || runtimeBuffer.length + chunk.length > 512 * 1024 + 1) throw new Error('runtime control output exceeds its bound');
        runtimeBuffer = Buffer.concat([runtimeBuffer, chunk]);
        const end = runtimeBuffer.indexOf(10);
        if (end < 0) return;
        if (end !== runtimeBuffer.length - 1 || !pendingObservation) throw new Error('unsolicited or extra runtime control output');
        const raw = runtimeBuffer.subarray(0, end), pending = pendingObservation;
        const checkDeadline = () => {
          if (process.hrtime.bigint() >= pending.deadlineNs) throw new Error('owned runtime observation deadline expired');
        };
        checkDeadline();
        const installed = pending.operation === 'observe-installed-state';
        const value = installed
          ? parseOwnedInstalledStateReader(raw, { controlId, requestId: pending.id, start: startObservation, product: installedStateProduct })
          : parseOwnedRuntimeObservation(raw, { controlId, requestId: pending.id, start: startObservation });
        if (measuredOwnedImplementation().sha256 !== implementation ||
            fileIdentity(prepared[0].command, { system: true }).sha256 !== prepared[0].executable.sha256) throw new Error('runtime observer or executable changed');
        checkDeadline();
        const parent = unlinkedPath(prepared[0].directory, { directory: true });
        let decoration = {};
        const basename = (installed ? 'installed-state-' : 'runtime-') + String(pending.id).padStart(4, '0');
        if (installed) {
          const currentHelper = fileIdentity(INSTALLED_READER, { maximum: 1024 * 1024 }), currentPowerShell = fileIdentity(POWERSHELL, { system: true });
          if (currentHelper.sha256 !== installedReader.sha256 || currentHelper.bytes !== installedReader.bytes ||
              currentPowerShell.sha256 !== powershell.sha256 || currentPowerShell.bytes !== powershell.bytes) throw new Error('installed reader helper or executable changed');
          const stream = name => {
            const file = unlinkedPath(path.join(parent, basename, name + '.bin'));
            const actual = fileIdentity(file, { maximum: 16 * 1024 * 1024 });
            if (actual.sha256 !== value[name].sha256 || actual.bytes !== value[name].bytes) throw new Error('reader stream differs from native measurement');
            return actual;
          };
          decoration = { helper: { ...installedReader }, executable: { ...powershell }, stdout: stream('stdout'), stderr: stream('stderr') };
          checkDeadline();
        }
        const file = path.join(parent, basename + '.json');
        const fd = fs.openSync(file, 'wx', 0o600);
        try { fs.writeFileSync(fd, raw); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        const record = fileIdentity(file, { maximum: 512 * 1024 });
        if (record.sha256 !== hash(raw) || record.bytes !== raw.length) throw new Error('raw runtime observation changed');
        (installed ? installedReaderRecords : runtimeRecords).push(record);
        const observation = freezeObservation({ scope: installed ? 'owned-installed-state-reader-only' : 'owned-runtime-snapshot-only', ...value, ...decoration, record });
        // Synchronous parsing, hashing and disk I/O can delay the timer callback.
        // Keep any written raw packet as diagnostic evidence, but never resolve
        // an overdue observation or clear its timer into a false success.
        checkDeadline();
        runtimeBuffer = Buffer.alloc(0); pendingObservation = null; clearTimeout(pending.timer);
        pending.resolve(observation);
      } catch (error) { poisonRuntime(error); }
    };
    if (onStarted) startTimer = setInterval(observeStart, 20);
    const collect = chunk => { if (Buffer.byteLength(output) + chunk.length <= 32768) output += chunk.toString(); else { oversized = true; stop(); } };
    child.stdout.on('data', runtimeObservations ? collectRuntime : collect); child.stderr.on('data', collect);
    child.stdin?.on('error', poisonRuntime);
    child.once('error', error => { spawnError = error.code || 'SPAWN_ERROR'; });
    child.once('exit', () => {
      nativeExited = true;
      rejectObservation(new Error('native runtime owner exited before observation completion'));
    });
    const deadline = setTimeout(() => { timedOut = true; stop(); }, timeoutMs + cleanupMs * 3 + cleanupGraceMs + 15000);
    const abandon = () => {
      if (done) return; done = true; clearTimeout(deadline); detachSignals(); stop(); child.unref(); child.stdout.destroy(); child.stderr.destroy();
      rejectObservation(new Error('native runtime owner did not settle'));
      child.stdin?.destroy();
      clearTimeout(lastResort);
      resolve({ code: null, timedOut: true, oversized, cancelled, startupError, runtimeError, error: spawnError, diagnostic: output.slice(-4096), naturalClose: false, created: Number.isInteger(child.pid) });
    };
    const lastResort = setTimeout(abandon, timeoutMs + cleanupMs * 3 + cleanupGraceMs + 20000);
    child.once('close', code => {
      nativeExited = true;
      if (!runtimeObservations) observeStart();
      if (done) return; done = true; clearTimeout(deadline); clearTimeout(lastResort); detachSignals();
      if (runtimeBuffer.length) runtimeError ||= 'truncated native runtime observation';
      rejectObservation(new Error('native runtime owner closed before observation completion'));
      child.stdin?.destroy();
      resolve({ code, timedOut, oversized, cancelled, startupError, runtimeError, error: spawnError, diagnostic: output.slice(-4096), naturalClose: true, created: Number.isInteger(child.pid) });
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
  helperStarted = control.created;
  let nativeBatch = null;
  const nativeResults = [];
  if (control.code === 0 && !control.timedOut && !control.oversized && !control.error) {
    try { nativeBatch = capturedJson(batchResultFile, 16384).value; } catch {}
    for (const job of prepared) {
      try { nativeResults.push(capturedJson(job.result, 512 * 1024).value); }
      catch { nativeResults.push(null); }
    }
  }
  const measuredAttempts = nativeBatch?.finished === true && Number.isSafeInteger(nativeBatch.attempted) && nativeBatch.attempted >= 0 && nativeBatch.attempted <= prepared.length;
  batchCleanupConfirmed = Boolean(measuredAttempts && nativeBatch.cleanupConfirmed === true &&
    nativeResults.slice(0, nativeBatch.attempted).length === nativeBatch.attempted &&
    nativeResults.slice(0, nativeBatch.attempted).every(result => result?.cleanupConfirmed === true) &&
    nativeResults.slice(nativeBatch.attempted).every(result => result === null));
  const results = [];
  const transportStable = measuredOwnedImplementation().sha256 === implementation &&
    JSON.stringify(measureRegisteredToolchain()) === JSON.stringify(toolchain);
  const stableExecutables = new Map([...executables].map(([command, identity]) =>
    [command, fileIdentity(command, { system: true }).sha256 === identity.sha256]));
  const launchSpec = fileIdentity(specFile);
  for (const [jobIndex, job] of prepared.entries()) {
    const { command, args, cwd, executable, environment, stdout, stderr, result: resultFile } = job;
    const native = nativeResults[jobIndex];
    const processStart = native?.startIdentity ? readOwnedStart(job) : null;
    if (processStart && hash(native.startIdentity) !== processStart.record.sha256) throw new Error('native startup identity changed during execution');
    const notRun = batchCleanupConfirmed && jobIndex >= nativeBatch.attempted && !native;
    const identityStable = stableExecutables.get(command) && transportStable;
    const stdoutIdentity = fileIdentity(stdout, { maximum: job.maxOutputBytes });
    const stderrIdentity = fileIdentity(stderr, { maximum: job.maxOutputBytes });
    const streamsStable = Boolean(native && native.stdoutSha256 === stdoutIdentity.sha256 && native.stderrSha256 === stderrIdentity.sha256 &&
      native.stdoutBytes === stdoutIdentity.bytes && native.stderrBytes === stderrIdentity.bytes);
  const result = {
    schema: 'toolsenabled.owned-job-execution', schemaVersion: 1, startedAt, finishedAt: new Date().toISOString(),
    command: [command, ...args], cwd, executable, transport: { sha256: implementation, helperSha256: hash(HELPER), powershell, toolchain },
    launchSpec, jobIndex: results.length,
    environmentSha256: hash(JSON.stringify(environment)), limits: { timeoutMs: job.timeoutMs, maxOutputBytes: job.maxOutputBytes, cleanupMs: job.cleanupMs, cleanupGraceMs: job.cleanupGraceMs },
    exitCode: native?.rootExited ? native.exitCode : null, signal: control.cancelled || (native?.cancelled ? 'ABORT' : null),
    complete: Boolean(identityStable && streamsStable && processStart && native?.rootExited && !control.cancelled && !control.startupError && !control.runtimeError && !native.cancelled && !native.error && !native.timedOut && !native.outputLimitExceeded && !native.hadRemainingChildren),
    cleanupConfirmed: native?.cleanupConfirmed === true || notRun, notRun,
    timedOut: Boolean(control.timedOut || native?.timedOut), outputLimitExceeded: Boolean(control.oversized || native?.outputLimitExceeded),
    hadRemainingChildren: native?.hadRemainingChildren === true,
    error: !identityStable ? 'registered executable/transport changed during execution' : control.startupError || control.runtimeError || native?.error ||
      (native ? streamsStable ? null : 'native stream seal is missing or differs from raw evidence' : notRun ? 'not run after earlier failure or batch budget' : `owned helper failed: ${control.error || control.code}; ${control.diagnostic}`),
    stdout: stdoutIdentity, stderr: stderrIdentity,
    nativeResult: native ? fileIdentity(resultFile, { maximum: 512 * 1024 }) : null,
    nativeBatchResult: nativeBatch ? fileIdentity(batchResultFile, { maximum: 16384 }) : null,
    processStart,
    ...(runtimeObservations ? { runtimeControlId: controlId, runtimeObservations: [...runtimeRecords] } : {}),
    ...(installedReader ? { installedStateProduct, installedStateReaders: [...installedReaderRecords] } : {}),
  };
  const recordFile = path.join(job.directory, 'execution.json');
  await writeFile(recordFile, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    results.push({ ...result, record: fileIdentity(recordFile) });
  }
  if (!batchCleanupConfirmed && helperStarted) {
    const error = cleanupError('native batch did not prove cleanup of every attempted command', lease.path);
    error.records = results;
    throw error;
  }
  lease.confirmedCleanup(); admissionReleased = true;
  return results;
  } catch (error) {
    if (admissionReleased) throw error;
    if (!helperStarted || batchCleanupConfirmed) {
      lease.confirmedCleanup(); admissionReleased = true;
      throw error;
    }
    let refusal;
    try { refusal = lease.quarantine(error); }
    catch (cause) { refusal = cleanupError('owned cleanup and durable admission remain unconfirmed', lease.path, cause); }
    if (error.records) refusal.records = error.records;
    throw refusal;
  }
}
