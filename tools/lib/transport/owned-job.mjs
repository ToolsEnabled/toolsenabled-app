import fs from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { userInfo, tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { registeredToolPaths, registeredToolSearchPath, registeredToolchainPolicyIdentity,
  assertRegisteredToolIdentity } from './registered-toolchain.mjs';
import { measureLinuxToolchain, linuxToolEnvironment } from './linux-toolchain.mjs';
import { runLinuxOwnedJobBatch } from './linux-owned-job.mjs';

const DEV = userInfo().homedir;
const TEMP = process.platform === 'linux' ? tmpdir() : `${DEV}\\AppData\\Local\\Temp`;
const POWERSHELL = registeredToolPaths().powershell;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const moduleFile = fileURLToPath(import.meta.url);
const INSTALLED_READER = fileURLToPath(new URL('../guest/Read-InstalledState.ps1', import.meta.url));
const APPROVED_INSTALLED_READER_SHA256 = '1f7a596876f0d2a7796a89eb047529a9f4cd04b627fdfcc97fac51c4c301f1db';
// Outside TEMP: an interrupted session must not become eligible merely because
// a new caller picks another evidence directory or temporary files are swept.
const EXECUTION_SCOPE = process.platform === 'linux'
  ? path.join(DEV, '.local', 'state', 'ToolsEnabledQualification', 'owned-execution')
  : `${DEV}\\AppData\\Local\\ToolsEnabledQualification\\owned-execution`;
const FIXTURE_NSIS = `${DEV}\\Desktop\\ToolsEnabled-1.0.41-WorkingFolder\\deps\\electron-builder-cache\\nsis-3.0.4.1\\nsis-3.0.4.1-1mx3n`;

export function fencedPath(input, { system = false } = {}) {
  if (typeof input !== 'string' || !input || input.includes('\0') || /^[\\/]{2}/.test(input) ||
      (process.platform === 'win32' && (/^[a-z]:[^\\/]/i.test(input) || /:/.test(input.replace(/^[a-z]:/i, '')) ||
        input.split(/[\\/]/).some(part => /[ .]$/.test(part) && part !== '.' && part !== '..')))) throw new Error('unsafe or alternate path spelling');
  const file = path.resolve(input);
  const lower = file.toLowerCase();
  if (process.platform === 'win32' && !(lower === DEV.toLowerCase() || lower.startsWith(`${DEV.toLowerCase()}\\`))) {
    if (!system || lower.startsWith('c:\\users\\')) throw new Error('path leaves the permitted OS account fence');
  }
  return file;
}

export function unlinkedPath(input, { directory = false, system = false } = {}) {
  const file = fencedPath(input, { system });
  const parts = path.relative(path.parse(file).root, file).split(path.sep);
  let cursor = path.parse(file).root;
  for (const [index, part] of parts.entries()) {
    cursor = path.join(cursor, part);
    const entry = lstat(cursor);
    if (entry.isSymbolicLink() || (index < parts.length - 1 && !entry.isDirectory())) throw new Error('linked or non-directory path component');
    if (index === parts.length - 1 && !(directory ? entry.isDirectory() : entry.isFile())) throw new Error('path has the wrong file type');
  }
  return file;
}

const IDENTITY_LIMIT = 8 * 1024 ** 3;
const MAX_SAFE_BYTES = BigInt(Number.MAX_SAFE_INTEGER);
// Every NTFS file ID on this volume is above Number.MAX_SAFE_INTEGER, so a
// non-bigint Stats.ino is a rounded double: two different files whose IDs differ
// by less than the double spacing compare equal, and a one-unit change rounds
// away unnoticed. Every stat that feeds an identity comparison, including the
// admission ledger's ownership check, is taken with { bigint: true } and its
// dev/ino compared as BigInts.
const lstat = file => fs.lstatSync(file, { bigint: true });
const fstat = handle => fs.fstatSync(handle, { bigint: true });
// Counts and budgets stay in Numbers. A BigInt is converted only inside the safe
// integer range; anything else yields NaN and fails its caller's existing
// Number.isSafeInteger guard rather than bypassing it.
const statNumber = value => (typeof value === 'bigint'
  ? (value >= 0n && value <= MAX_SAFE_BYTES ? Number(value) : Number.NaN)
  : value);
const sameFileStat = (a, b) => ['dev', 'ino', 'mode', 'size', 'mtimeMs', 'ctimeMs', 'nlink'].every(key => a[key] === b[key]);
// A single bounded descriptor supplies both content and identity. This closes
// the measurement/reopen gap, but stock Node does not retain Windows ancestor
// handles through open; that native path boundary is still required separately.
function captureFile(input, options = {}, includeBytes = false) {
  const maximum = options.maximum === undefined ? IDENTITY_LIMIT : options.maximum;
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > IDENTITY_LIMIT) throw new Error('invalid file identity byte budget');
  const deadline = process.hrtime.bigint() + 120_000_000_000n;
  const checkTime = () => { if (process.hrtime.bigint() >= deadline) throw new Error('file identity read deadline expired'); };
  checkTime();
  const file = unlinkedPath(input, options);
  const selected = lstat(file);
  const handle = fs.openSync(file, 'r');
  try {
    const before = fstat(handle);
    const devFile = process.platform === 'win32' && file.toLowerCase().startsWith(DEV.toLowerCase() + '\\');
    const links = statNumber(before.nlink);
    if (!before.isFile() || !sameFileStat(selected, before) || !Number.isSafeInteger(links) || links <= 0 ||
        (devFile && links !== 1)) throw new Error('file identity input changed, is linked or is not ordinary');
    const size = statNumber(before.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > maximum) throw new Error('file identity exceeds its byte budget');
    const digest = createHash('sha256'), chunks = [];
    const buffer = Buffer.alloc(Math.min(1024 * 1024, size || 1));
    let bytes = 0, count;
    for (;;) {
      checkTime();
      const remaining = Math.min(buffer.length, size - bytes + 1);
      count = fs.readSync(handle, buffer, 0, remaining, null);
      checkTime();
      if (!Number.isSafeInteger(count) || count < 0 || count > remaining) throw new Error('invalid file identity read count');
      if (!count) break;
      bytes += count;
      if (bytes > maximum) throw new Error('file identity grew beyond its byte budget');
      if (bytes > size) throw new Error('file changed while measuring identity');
      const chunk = buffer.subarray(0, count);
      digest.update(chunk);
      if (includeBytes) chunks.push(Buffer.from(chunk));
    }
    const after = fstat(handle), current = lstat(unlinkedPath(file, options));
    if (bytes !== size || !after.isFile() || !current.isFile() || !sameFileStat(before, after) || !sameFileStat(before, current)) throw new Error('file changed while measuring identity');
    const result = { identity: { path: file, sha256: digest.digest('hex'), bytes }, ...(includeBytes ? { data: Buffer.concat(chunks, bytes) } : {}) };
    checkTime();
    return result;
  } finally { fs.closeSync(handle); checkTime(); }
}

export function fileIdentity(input, options = {}) { return captureFile(input, options).identity; }
const LOADED_IMPLEMENTATION = fileIdentity(moduleFile, { maximum: 4 * 1024 * 1024 });
export function ownedJobImplementationIdentity() {
  if (arguments.length) throw new Error('owned implementation identity accepts no caller input');
  const current = fileIdentity(moduleFile, { maximum: 4 * 1024 * 1024 });
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

function captureBytes(input, maximum) { return captureFile(input, { maximum }, true); }
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
    SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe',
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
      if (value !== environment[canonical] && !(canonical === 'PATH' && value === 'C:\\Windows\\System32;C:\\Windows')) throw new Error(`reserved environment value cannot change: ${canonical}`);
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

function cleanupError(message, scopePath, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = 'OWNED_EXECUTION_QUARANTINED';
  error.cleanupUnconfirmed = true;
  error.executionScope = scopePath;
  return error;
}

function ensurePrivateDirectory(input) {
  const directory = fencedPath(input);
  const parent = path.dirname(directory);
  if (parent !== directory) {
    try { unlinkedPath(parent, { directory: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; ensurePrivateDirectory(parent); }
  }
  try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  return unlinkedPath(directory, { directory: true });
}

function assertNativeAdmissionDirectory(directory) {
  if (process.platform !== 'linux') return;
  const owner = BigInt(process.getuid()), selected = lstat(unlinkedPath(directory, { directory: true }));
  if (selected.uid !== owner || selected.mode & 0o077n) throw new Error('Linux admission directory must be private to its owning account');
  for (let current = directory; ; current = path.dirname(current)) {
    const info = lstat(unlinkedPath(current, { directory: true }));
    // A root-owned sticky temporary ancestor cannot remove this account's
    // private child directory. Other writable ancestors do not preserve it.
    const stickyRoot = info.uid === 0n && Boolean(info.mode & 0o1000n);
    if (![0n, owner].includes(info.uid) || info.mode & 0o022n && !stickyRoot)
      throw new Error('Linux admission has an untrusted or writable ancestor');
    if (path.dirname(current) === current) break;
  }
}

// The production instance is private and has one fixed account-wide root.
// No PID/reuse, age, stale-session or caller-supplied cleanup claim clears it.
function executionScope(directory) {
  directory = fencedPath(directory);
  const ledger = path.join(directory, 'active-or-uncertain.json');
  return Object.freeze({
    acquire(details) {
      ensurePrivateDirectory(directory);
      assertNativeAdmissionDirectory(directory);
      let fd;
      try { fd = fs.openSync(ledger, 'wx+', 0o600); }
      catch (cause) { throw cleanupError('another owned execution is active or its cleanup remains unconfirmed; no new execution is admitted', ledger, cause); }
      const opened = fstat(fd);
      const record = { schema: 'toolsenabled.owned-execution-admission', schemaVersion: 1, id: randomUUID(),
        state: 'active', startedAt: new Date().toISOString(), ...details };
      let closed = false, quarantined = false;
      const store = () => {
        const bytes = Buffer.from(JSON.stringify(record) + '\n');
        fs.writeSync(fd, bytes, 0, bytes.length, 0); fs.ftruncateSync(fd, bytes.length); fs.fsyncSync(fd);
      };
      try { store(); } catch (cause) { fs.closeSync(fd); throw cleanupError('execution admission could not be durably recorded', ledger, cause); }
      const owns = () => {
        assertNativeAdmissionDirectory(directory);
        const current = lstat(unlinkedPath(ledger));
        if (current.dev !== opened.dev || current.ino !== opened.ino || captureBytes(ledger, 65536).data.toString('utf8') !== JSON.stringify(record) + '\n') throw cleanupError('execution admission ownership changed; refusing to remove it', ledger);
      };
      return Object.freeze({
        path: ledger,
        annotate(values) { if (closed || quarantined) throw cleanupError('execution admission is no longer writable', ledger); owns(); Object.assign(record, values); store(); },
        quarantine(cause) {
          if (!closed) {
            quarantined = true;
            try { owns(); record.state = 'cleanup-unconfirmed'; record.finishedAt = new Date().toISOString(); record.reason = String(cause?.code || 'UNCONFIRMED'); store(); }
            finally { fs.closeSync(fd); closed = true; }
          }
          return cleanupError('owned process cleanup is unconfirmed; evidence and durable admission are retained', ledger, cause);
        },
        confirmedCleanup() {
          if (closed || quarantined) throw cleanupError('quarantined execution requires explicit external cleanup review', ledger);
          try { owns(); fs.unlinkSync(ledger); }
          catch (cause) { throw cleanupError('confirmed processes could not release their exact execution admission', ledger, cause); }
          finally { fs.closeSync(fd); closed = true; }
        },
      });
    },
  });
}
const PRODUCTION_SCOPE = executionScope(EXECUTION_SCOPE);

// Both native transports acquire this one private, durable admission. Export
// acquisition, never the scope path selector or a cleanup override.
export function acquireOwnedExecution(details) { return PRODUCTION_SCOPE.acquire(details); }

// Inert ledger fixture only. It cannot launch processes or replace the private
// production scope, and cannot address the real account-wide admission root.
export function createInertExecutionScopeFixture(directory) {
  directory = unlinkedPath(directory, { directory: true });
  if (!directory.toLowerCase().startsWith(`${TEMP.toLowerCase()}${path.sep}qualification-job-test-`)) throw new Error('execution-scope fixtures require an owned Dev temporary test directory');
  return executionScope(path.join(directory, 'inert-admission'));
}

// The job owns every child before its first instruction runs. Only the three
// redirected standard handles are inherited; the job handle cannot escape.
const NATIVE = String.raw`
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Collections.Generic;
using System.Net;
using System.Diagnostics;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;
public sealed class OwnedJobResult {
  public bool processCreated, rootExited, timedOut, outputLimitExceeded, hadRemainingChildren, cleanupConfirmed, cancelled;
  public long exitCode = -1, stdoutBytes, stderrBytes;
  public string error, startIdentity, stdoutSha256, stderrSha256;
}
public static class OwnedJob {
  [StructLayout(LayoutKind.Sequential)] struct SA { public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct SI { public int cb; public string reserved, desktop, title; public int x,y,xSize,ySize,xChars,yChars,fill,flags; public short show,reserved2; public IntPtr reservedPtr,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] struct SIX { public SI start; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process, thread; public uint pid, tid; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC { public long processTime, jobTime; public uint flags; public UIntPtr minWorking,maxWorking; public uint activeLimit; public UIntPtr affinity; public uint priority,scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct LIMIT { public BASIC basic; public IO io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNT { public long user,kernel,periodUser,periodKernel; public uint faults,total,active,terminated; }
  [StructLayout(LayoutKind.Sequential)] struct FILEINFO { public uint attributes; public System.Runtime.InteropServices.ComTypes.FILETIME created,accessed,written; public uint volume,highSize,lowSize,links,highIndex,lowIndex; }
  [DllImport("kernel32",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr file,out FILEINFO value);
  [DllImport("kernel32",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,ref LIMIT value,int size);
  [DllImport("kernel32",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int info,out ACCOUNT value,int size,IntPtr returned);
  [DllImport("kernel32",EntryPoint="QueryInformationJobObject",SetLastError=true)] static extern bool QueryJobMembers(IntPtr job,int info,IntPtr value,int size,IntPtr returned);
  [DllImport("kernel32",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool member);
  [DllImport("kernel32",SetLastError=true)] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32",SetLastError=true)] static extern bool PeekNamedPipe(IntPtr pipe,IntPtr buffer,uint size,IntPtr read,out uint available,IntPtr remaining);
  [DllImport("kernel32",SetLastError=true)] static extern bool ReadFile(IntPtr file,byte[] buffer,uint size,out uint read,IntPtr overlapped);
  delegate bool WindowEnumerator(IntPtr window,IntPtr context);
  [DllImport("user32",SetLastError=true)] static extern bool EnumWindows(WindowEnumerator callback,IntPtr context);
  [DllImport("user32",SetLastError=true)] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
  [DllImport("user32")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("iphlpapi",SetLastError=true)] static extern uint GetExtendedTcpTable(IntPtr table,ref int size,bool order,int family,int kind,uint reserved);
  [DllImport("kernel32",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user);
  [DllImport("kernel32",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder name,ref uint size);
  [DllImport("advapi32",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("userenv.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool GetUserProfileDirectory(IntPtr token,StringBuilder directory,ref uint size);
  [DllImport("advapi32",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr value,int size,out int needed);
  [DllImport("kernel32",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SA attributes,uint size);
  [DllImport("kernel32",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
  [DllImport("kernel32",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateFile(string name,uint access,uint share,ref SA attributes,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateDirectory(string name,IntPtr security);
  [DllImport("kernel32",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
  [DllImport("kernel32",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr environment,string cwd,ref SIX startup,out PI process);
  static void Check(bool result,string action) { if (!result) throw new Exception(action + " failed (Win32 " + Marshal.GetLastWin32Error() + ")"); }
  static string OwnerProfile() {
    using(WindowsIdentity owner=WindowsIdentity.GetCurrent()) {
      uint size=32768; StringBuilder directory=new StringBuilder((int)size);
      Check(GetUserProfileDirectory(owner.Token,directory,ref size),"observe current OS account profile");
      string profile=directory.ToString();
      if(profile.Length<3||profile[1]!=':'||profile[2]!='\\'||!Path.GetFullPath(profile).Equals(profile,StringComparison.OrdinalIgnoreCase))
        throw new Exception("current OS account profile is not an ordinary absolute path");
      return profile;
    }
  }
  static string Quote(string value) {
    if (value.Length > 0 && value.IndexOfAny(new char[]{' ','\t','"'}) < 0) return value;
    StringBuilder b = new StringBuilder("\""); int slash=0;
    foreach(char c in value) { if(c=='\\') { slash++; continue; } if(c=='"') b.Append('\\',slash*2+1); else b.Append('\\',slash); b.Append(c); slash=0; }
    b.Append('\\',slash*2); return b.Append('"').ToString();
  }
  static uint Active(IntPtr job) { ACCOUNT value; Check(QueryInformationJobObject(job,1,out value,Marshal.SizeOf(typeof(ACCOUNT)),IntPtr.Zero),"query owned job"); return value.active; }
  static string Json(string value) {
    StringBuilder b=new StringBuilder("\"");
    foreach(char c in value) { if(c=='"'||c=='\\') b.Append('\\').Append(c); else if(c<32) b.Append("\\u").Append(((int)c).ToString("x4")); else b.Append(c); }
    return b.Append('"').ToString();
  }
  static IntPtr TokenInfo(IntPtr token,int kind) {
    int size; GetTokenInformation(token,kind,IntPtr.Zero,0,out size);
    if(size<=0||size>65536) throw new Exception("invalid token information size");
    IntPtr value=Marshal.AllocHGlobal(size);
    try { Check(GetTokenInformation(token,kind,value,size,out size),"observe owned token"); return value; }
    catch { Marshal.FreeHGlobal(value); throw; }
  }
  // Query the retained CreateProcess handle, never rediscover a PID. No token
  // duplication/elevation or other-profile lookup is performed.
  static string StartIdentity(PI process,string executable,string expectedProfile) {
    long created,exited,kernel,user; Check(GetProcessTimes(process.process,out created,out exited,out kernel,out user),"observe creation time");
    uint length=32768; StringBuilder image=new StringBuilder((int)length);
    Check(QueryFullProcessImageName(process.process,0,image,ref length),"observe executable image");
    if(executable.Length>0&&!String.Equals(image.ToString(),executable,StringComparison.OrdinalIgnoreCase)) throw new Exception("owned executable image differs");
    IntPtr token=IntPtr.Zero,elevation=IntPtr.Zero,integrity=IntPtr.Zero,session=IntPtr.Zero;
    try {
      Check(OpenProcessToken(process.process,8,out token),"observe child token");
      elevation=TokenInfo(token,20); integrity=TokenInfo(token,25); session=TokenInfo(token,12);
      bool elevated=Marshal.ReadInt32(elevation)!=0;
      string integritySid=new SecurityIdentifier(Marshal.ReadIntPtr(integrity)).Value;
      int level=Int32.Parse(integritySid.Substring(integritySid.LastIndexOf('-')+1));
      string sid;
      using(WindowsIdentity child=new WindowsIdentity(token))
      using(WindowsIdentity owner=WindowsIdentity.GetCurrent()) {
        if(child.User.Value!=owner.User.Value) throw new Exception("owned process account differs from current OS account");
        sid=child.User.Value;
      }
      if(expectedProfile=="windows-x64-standard"&&(elevated||level!=8192)) throw new Exception("chosen standard token was not observed");
      if(expectedProfile=="windows-x64-administrator"&&(!elevated||level!=12288)) throw new Exception("chosen administrator token was not observed");
      return "{\"pid\":"+process.pid+",\"startedAt\":"+Json(DateTime.FromFileTimeUtc(created).ToString("o"))+",\"imagePath\":"+Json(image.ToString())+
        ",\"userSid\":"+Json(sid)+",\"elevated\":"+(elevated?"true":"false")+",\"integrityLevel\":"+level+",\"sessionId\":"+Marshal.ReadInt32(session)+"}";
    } finally { if(elevation!=IntPtr.Zero) Marshal.FreeHGlobal(elevation); if(integrity!=IntPtr.Zero) Marshal.FreeHGlobal(integrity); if(session!=IntPtr.Zero) Marshal.FreeHGlobal(session); if(token!=IntPtr.Zero) CloseHandle(token); }
  }
  static void LiveMember(IntPtr process,IntPtr job) {
    bool member; Check(IsProcessInJob(process,job,out member),"query retained job membership");
    if(!member||WaitForSingleObject(process,0)!=258) throw new Exception("owned member is absent, exited or unreadable");
  }
  static uint[] Members(IntPtr job) {
    const int capacity=256; int size=8+capacity*IntPtr.Size;
    IntPtr buffer=Marshal.AllocHGlobal(size);
    try {
      Check(QueryJobMembers(job,3,buffer,size,IntPtr.Zero),"query complete job membership");
      int assigned=Marshal.ReadInt32(buffer),count=Marshal.ReadInt32(buffer,4);
      if(count<1||count>capacity||assigned!=count) throw new Exception("incomplete or oversized job membership");
      uint[] result=new uint[count]; HashSet<uint> seen=new HashSet<uint>();
      for(int i=0;i<count;i++) {
        long pid=Marshal.ReadIntPtr(buffer,8+i*IntPtr.Size).ToInt64();
        if(pid<=0||pid>UInt32.MaxValue||!seen.Add((uint)pid)) throw new Exception("invalid or duplicate job member");
        result[i]=(uint)pid;
      }
      Array.Sort(result); return result;
    } finally { Marshal.FreeHGlobal(buffer); }
  }
  static string Windows(Dictionary<uint,IntPtr> members) {
    List<string> rows=new List<string>(); string failure=null;
    WindowEnumerator visit=delegate(IntPtr window,IntPtr ignored) {
      try {
        uint pid; uint thread=GetWindowThreadProcessId(window,out pid);
        if(!members.ContainsKey(pid)) return true; // No title/content/other-process lookup.
        if(thread==0||rows.Count>=1024) throw new Exception("owned window disappeared or window budget exceeded");
        bool visible=IsWindowVisible(window); uint after;
        if(GetWindowThreadProcessId(window,out after)!=thread||after!=pid) throw new Exception("owned window identity changed");
        rows.Add("{\"hwnd\":"+Json("0x"+window.ToInt64().ToString("x"))+",\"pid\":"+pid+",\"threadId\":"+thread+",\"visible\":"+(visible?"true":"false")+"}");
        return true;
      } catch(Exception e) { failure=e.Message; return false; }
    };
    bool success=EnumWindows(visit,IntPtr.Zero);
    if(failure!=null) throw new Exception(failure);
    Check(success,"enumerate owned windows");
    rows.Sort(StringComparer.Ordinal); return "["+string.Join(",",rows.ToArray())+"]";
  }
  static string Listeners(Dictionary<uint,IntPtr> members) {
    List<string> rows=new List<string>();
    foreach(int family in new int[]{2,23}) {
      int size=0; uint status=GetExtendedTcpTable(IntPtr.Zero,ref size,true,family,3,0);
      if((status!=0&&status!=122)||size<4||size>1024*1024) throw new Exception("TCP listener census unavailable or oversized");
      int capacity=size; IntPtr buffer=Marshal.AllocHGlobal(capacity);
      try {
        if(GetExtendedTcpTable(buffer,ref size,true,family,3,0)!=0||size>capacity) throw new Exception("TCP listener census changed or is unreadable");
        int count=Marshal.ReadInt32(buffer),width=family==2?24:56;
        if(count<0||4L+(long)count*width>capacity) throw new Exception("TCP listener census is truncated");
        for(int i=0;i<count;i++) {
          IntPtr row=IntPtr.Add(buffer,4+i*width);
          uint pid=(uint)Marshal.ReadInt32(row,family==2?20:52);
          if(!members.ContainsKey(pid)) continue; // Never report unrelated endpoints.
          if(rows.Count>=2048||Marshal.ReadInt32(row,family==2?0:48)!=2) throw new Exception("invalid or oversized owned listener census");
          byte[] address=new byte[family==2?4:16]; Marshal.Copy(IntPtr.Add(row,family==2?4:0),address,0,address.Length);
          uint packed=(uint)Marshal.ReadInt32(row,family==2?8:20);
          uint port=((packed&255)<<8)|((packed>>8)&255),scope=family==2?0:(uint)Marshal.ReadInt32(row,16);
          if(port==0) throw new Exception("owned listener has no measured port");
          rows.Add("{\"family\":"+Json(family==2?"IPv4":"IPv6")+",\"address\":"+Json(new IPAddress(address).ToString())+
            ",\"scopeId\":"+scope+",\"port\":"+port+",\"pid\":"+pid+"}");
        }
      } finally { Marshal.FreeHGlobal(buffer); }
    }
    rows.Sort(StringComparer.Ordinal); return "["+string.Join(",",rows.ToArray())+"]";
  }
  static string RuntimeObservation(IntPtr job,PI root,string executable,string profile,string identity,string controlId,int request) {
    LiveMember(root.process,job);
    uint[] before=Members(job);
    if(Array.IndexOf(before,root.pid)<0) throw new Exception("retained root is missing from its job");
    Dictionary<uint,IntPtr> members=new Dictionary<uint,IntPtr>();
    List<string> identities=new List<string>();
    try {
      foreach(uint pid in before) {
        IntPtr handle=pid==root.pid?root.process:OpenProcess(0x00101000,false,pid);
        Check(handle!=IntPtr.Zero,"retain enumerated job member");
        members.Add(pid,handle); LiveMember(handle,job);
        PI member=new PI(); member.pid=pid; member.process=handle;
        string observed=StartIdentity(member,pid==root.pid?executable:"",profile);
        if(pid==root.pid&&observed!=identity) throw new Exception("retained root creation identity changed");
        identities.Add(observed);
      }
      string windows=Windows(members),listeners=Listeners(members);
      foreach(IntPtr handle in members.Values) LiveMember(handle,job);
      if(string.Join(",",before)!=string.Join(",",Members(job))||windows!=Windows(members)||listeners!=Listeners(members))
        throw new Exception("owned runtime changed during observation");
      foreach(IntPtr handle in members.Values) LiveMember(handle,job);
      if(string.Join(",",before)!=string.Join(",",Members(job))) throw new Exception("owned membership changed before observation completion");
      LiveMember(root.process,job);
      return "{\"schema\":\"toolsenabled.owned-runtime-observation\",\"schemaVersion\":1,\"controlId\":"+Json(controlId)+
        ",\"requestId\":"+request+",\"operation\":\"observe-runtime\",\"observedAt\":"+Json(DateTime.UtcNow.ToString("o"))+
        ",\"root\":"+identity+",\"processes\":["+string.Join(",",identities.ToArray())+"],\"windows\":"+windows+",\"listeners\":"+listeners+"}";
    } finally {
      foreach(KeyValuePair<uint,IntPtr> member in members) if(member.Key!=root.pid) CloseHandle(member.Value);
    }
  }
  static string Boolean(bool value) { return value?"true":"false"; }
  static string FileDigest(Stream input) {
    using(SHA256 algorithm=SHA256.Create()) return BitConverter.ToString(algorithm.ComputeHash(input)).Replace("-","").ToLowerInvariant();
  }
  // A lease owns every fixed path component and the exact final handle. A
  // capture is never closed/reopened between creation, pumping and hashing.
  sealed class PlainLease : IDisposable {
    readonly List<IntPtr> handles=new List<IntPtr>(); IntPtr leaf; FILEINFO original; bool disposed;
    public FileStream stream;
    static PlainLease Open(string file,bool finalDirectory,uint disposition,bool writable) {
      string dev=OwnerProfile();
      if(!file.Equals(dev,StringComparison.OrdinalIgnoreCase)&&!file.StartsWith(dev+@"\",StringComparison.OrdinalIgnoreCase))
        throw new Exception("leased path leaves current OS account fence");
      string[] parts=file.Length==dev.Length?new string[0]:file.Substring(dev.Length+1).Split('\\');
      foreach(string part in parts) {
        if(part.Length==0||part=="."||part==".."||part.EndsWith(".")||part.EndsWith(" ")||
            part.IndexOfAny(new char[]{':','/','<','>','"','|','?','*'})>=0||
            System.Text.RegularExpressions.Regex.IsMatch(part,@"^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)"))
          throw new Exception("ambiguous leased path");
        foreach(char character in part) if(character<32) throw new Exception("invalid leased path byte");
      }
      PlainLease lease=new PlainLease();
      try {
        string current=Path.GetPathRoot(file);
        string[] fullParts=file.Substring(current.Length).Split('\\');
        for(int index=-1;index<fullParts.Length;index++) {
          bool directory=index<fullParts.Length-1||finalDirectory;
          if(index>=0) current=Path.Combine(current,fullParts[index]);
          SA security=new SA(); security.length=Marshal.SizeOf(typeof(SA)); security.inherit=false;
          uint access=directory?0x80u:writable?0xc0000000u:0x80000000u;
          IntPtr handle=CreateFile(current,access,1,ref security,directory?3:disposition,0x02200000,IntPtr.Zero);
          Check(handle!=new IntPtr(-1),"retain plain leased path"); lease.handles.Add(handle);
          FILEINFO info; Check(GetFileInformationByHandle(handle,out info),"observe plain leased path");
          if((info.attributes&0x400)!=0||directory!=((info.attributes&0x10)!=0)||(!directory&&info.links!=1))
            throw new Exception("leased path is linked or not ordinary");
          if(!directory) {
            lease.leaf=handle; lease.original=info;
            lease.stream=new FileStream(new SafeFileHandle(handle,false),writable?FileAccess.ReadWrite:FileAccess.Read,65536,false);
          }
        }
        return lease;
      } catch { lease.Dispose(); throw; }
    }
    public static PlainLease DirectoryLease(string directory) { return Open(directory,true,3,false); }
    public static PlainLease ReadLease(string file) { return Open(file,false,3,false); }
    public static PlainLease Capture(string file,bool create) {
      PlainLease lease=Open(file,false,create?1u:3u,true);
      try { if(lease.stream.Length!=0) throw new Exception("capture placeholder is not empty"); return lease; }
      catch { lease.Dispose(); throw; }
    }
    public string Seal(long expected) {
      if(disposed||stream==null||expected<0||stream.Length!=expected) throw new Exception("capture length differs");
      FILEINFO before,after; Check(GetFileInformationByHandle(leaf,out before),"observe capture before seal");
      stream.Position=0; string digest=FileDigest(stream);
      Check(GetFileInformationByHandle(leaf,out after),"observe capture after seal");
      foreach(FILEINFO info in new FILEINFO[]{before,after}) {
        if(info.volume!=original.volume||info.highIndex!=original.highIndex||info.lowIndex!=original.lowIndex||
            info.links!=1||(info.attributes&0x410)!=0||(((long)info.highSize<<32)+info.lowSize)!=expected)
          throw new Exception("capture identity changed while sealing");
      }
      if(stream.Position!=expected||stream.Length!=expected) throw new Exception("capture read was incomplete");
      return digest;
    }
    public void Dispose() {
      if(disposed) return; disposed=true;
      List<Exception> failures=new List<Exception>();
      try { if(stream!=null) stream.Dispose(); }
      catch(Exception e) { failures.Add(e); }
      finally {
        stream=null;
        // Attempt every release even if flushing or an earlier CloseHandle
        // failed. Never retry an uncertain handle after its value can be reused.
        for(int index=handles.Count-1;index>=0;index--) {
          try { Check(CloseHandle(handles[index]),"release plain leased path"); }
          catch(Exception e) { failures.Add(e); }
          finally { handles[index]=IntPtr.Zero; }
        }
        handles.Clear();
      }
      if(failures.Count>0) throw new AggregateException("plain lease cleanup failed",failures);
    }
  }
  static string CapturedFile(Pump capture,long expected) {
    if(capture==null||!capture.Join(0)||!capture.sealedCapture||capture.error!=null||capture.exceeded||
        expected<0||expected>16*1024*1024||capture.bytes!=expected||capture.sha256==null)
      throw new Exception("reader capture did not finish its same-handle seal");
    return "{\"sha256\":"+Json(capture.sha256)+",\"bytes\":"+expected+"}";
  }
  // A private subgroup inside the SAME retained parent Job. No blocking child
  // runner or second admission: the parent loop ticks this operation while it
  // continues checking root liveness, cancellation and its own output limits.
  sealed class ReaderOperation : IDisposable {
    const string Executable=@"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";
    readonly IntPtr parent; readonly PI root; readonly string helper,expectedHash,product,profile,cancellationFile;
    readonly string[] environment; readonly string directory; readonly Stopwatch watch=new Stopwatch(),phaseWatch=new Stopwatch();
    IntPtr job=IntPtr.Zero,outRead=IntPtr.Zero,outWrite=IntPtr.Zero,errRead=IntPtr.Zero,errWrite=IntPtr.Zero,input=IntPtr.Zero,env=IntPtr.Zero,attrs=IntPtr.Zero,handles=IntPtr.Zero;
    PI process=new PI(); public Pump output,error; PlainLease helperLease,stdoutLease,stderrLease;
    bool assigned,attrReady,disposed; int phase;
    public readonly OwnedJobResult result=new OwnedJobResult();
    public bool finished,stdoutDrained,stderrDrained; public uint activeProcesses;
    public string stdout,stderr;
    public ReaderOperation(IntPtr owner,PI original,string script,string hash,string id,string selectedProfile,string[] variables,string cancel,string target) {
      parent=owner; root=original; helper=script; expectedHash=hash; product=id; profile=selectedProfile; environment=(string[])variables.Clone(); cancellationFile=cancel; directory=target;
    }
    public void Begin() {
      LiveMember(root.process,parent);
      if(File.Exists(cancellationFile)) throw new OperationCanceledException("reader cancelled before creation");
      stdout=Path.Combine(directory,"stdout.bin"); stderr=Path.Combine(directory,"stderr.bin");
      using(PlainLease parentPath=PlainLease.DirectoryLease(Path.GetDirectoryName(directory))) {
        Check(CreateDirectory(directory,IntPtr.Zero),"create exclusive reader evidence directory");
        using(PlainLease targetPath=PlainLease.DirectoryLease(directory)) {
          stdoutLease=PlainLease.Capture(stdout,true); stderrLease=PlainLease.Capture(stderr,true);
        }
      }
      // Retain fixed C:\ and C:\Users directory metadata without enumeration,
      // then the Dev profile, every ancestor and the exact leaf. Keep them plain
      // and immovable while PowerShell opens the script; no reparse is followed.
      helperLease=PlainLease.ReadLease(helper);
      if(helperLease.stream.Length<=0||helperLease.stream.Length>1024*1024||FileDigest(helperLease.stream)!=expectedHash) throw new Exception("fixed installed reader bytes differ");
      helperLease.stream.Position=0;
      job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero,"create reader subgroup");
      LIMIT limits=new LIMIT(); limits.basic.flags=0x2000; Check(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(LIMIT))),"set reader kill-on-close");
      SA security=new SA(); security.length=Marshal.SizeOf(typeof(SA)); security.inherit=true;
      Check(CreatePipe(out outRead,out outWrite,ref security,0),"reader stdout pipe"); Check(SetHandleInformation(outRead,1,0),"reader stdout isolation");
      Check(CreatePipe(out errRead,out errWrite,ref security,0),"reader stderr pipe"); Check(SetHandleInformation(errRead,1,0),"reader stderr isolation");
      input=CreateFile("NUL",0x80000000,3,ref security,3,0,IntPtr.Zero); Check(input!=new IntPtr(-1),"reader stdin NUL");
      IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size); attrs=Marshal.AllocHGlobal(size);
      Check(InitializeProcThreadAttributeList(attrs,1,0,ref size),"reader handle list"); attrReady=true;
      handles=Marshal.AllocHGlobal(IntPtr.Size*3); Marshal.WriteIntPtr(handles,0,input); Marshal.WriteIntPtr(handles,IntPtr.Size,outWrite); Marshal.WriteIntPtr(handles,IntPtr.Size*2,errWrite);
      Check(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero),"reader inherited handles");
      SIX startup=new SIX(); startup.start.cb=Marshal.SizeOf(typeof(SIX)); startup.start.flags=0x101; startup.start.show=0; startup.start.input=input; startup.start.output=outWrite; startup.start.error=errWrite; startup.attributes=attrs;
      string[] args=new string[]{"-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",helper,"-Product",product};
      StringBuilder command=new StringBuilder(Quote(Executable)); foreach(string argument in args) command.Append(' ').Append(Quote(argument));
      Array.Sort(environment,StringComparer.OrdinalIgnoreCase); env=Marshal.StringToHGlobalUni(string.Join("\0",environment)+"\0\0");
      Check(CreateProcess(Executable,command,IntPtr.Zero,IntPtr.Zero,true,0x08080404,env,Path.GetDirectoryName(helper),ref startup,out process),"create suspended reader"); result.processCreated=true;
      Check(AssignProcessToJobObject(parent,process.process),"assign suspended reader to parent");
      Check(AssignProcessToJobObject(job,process.process),"assign suspended reader to subgroup"); assigned=true;
      LiveMember(process.process,parent); LiveMember(process.process,job);
      bool rootMember; Check(IsProcessInJob(root.process,job,out rootMember),"check reader subgroup excludes product");
      if(rootMember) throw new Exception("reader subgroup incorrectly owns product root");
      result.startIdentity=StartIdentity(process,Executable,profile);
      output=new Pump(outRead,stdoutLease,16*1024*1024); outRead=IntPtr.Zero; stdoutLease=null; output.Start();
      error=new Pump(errRead,stderrLease,16*1024*1024); errRead=IntPtr.Zero; stderrLease=null; error.Start();
      LiveMember(root.process,parent);
      if(File.Exists(cancellationFile)) throw new OperationCanceledException("reader cancelled before resume");
      Check(ResumeThread(process.thread)!=0xffffffff,"resume reader");
      CloseHandle(outWrite); outWrite=IntPtr.Zero; CloseHandle(errWrite); errWrite=IntPtr.Zero;
      watch.Start(); phase=1;
    }
    void Stop() {
      if(assigned) Check(TerminateJobObject(job,0xe011),"terminate reader subgroup");
      else if(result.processCreated&&WaitForSingleObject(process.process,0)!=0) Check(TerminateProcess(process.process,0xe012),"terminate retained suspended reader");
      if(outWrite!=IntPtr.Zero) { CloseHandle(outWrite); outWrite=IntPtr.Zero; }
      if(errWrite!=IntPtr.Zero) { CloseHandle(errWrite); errWrite=IntPtr.Zero; }
      phase=3; phaseWatch.Restart();
    }
    public void Tick() {
      if(finished) return;
      if(phase==1) {
        if(File.Exists(cancellationFile)) { result.cancelled=true; Stop(); }
        else if(output.exceeded||error.exceeded) { result.outputLimitExceeded=true; Stop(); }
        else if(output.error!=null||error.error!=null) { result.error="reader output pump failed"; Stop(); }
        else if(watch.ElapsedMilliseconds>=60000) { result.timedOut=true; Stop(); }
        else if(WaitForSingleObject(process.process,0)==0) { phase=2; phaseWatch.Restart(); }
      }
      if(phase==2) {
        if(Active(job)==0) { phase=3; phaseWatch.Restart(); }
        else if(phaseWatch.ElapsedMilliseconds>=300) { result.hadRemainingChildren=true; Stop(); }
      }
      if(phase==3) {
        activeProcesses=assigned?Active(job):0;
        result.rootExited=!result.processCreated||WaitForSingleObject(process.process,0)==0;
        stdoutDrained=output==null||output.Join(0); stderrDrained=error==null||error.Join(0);
        if(activeProcesses==0&&result.rootExited&&stdoutDrained&&stderrDrained) {
          result.cleanupConfirmed=(output==null||!output.cleanupFailed)&&(error==null||!error.cleanupFailed); finished=true;
          uint code; if(result.processCreated&&GetExitCodeProcess(process.process,out code)) result.exitCode=code;
          if(output!=null) { result.stdoutBytes=output.bytes; result.outputLimitExceeded|=output.exceeded; if(output.error!=null) result.error="reader stdout capture: "+output.error; }
          if(error!=null) { result.stderrBytes=error.bytes; result.outputLimitExceeded|=error.exceeded; if(error.error!=null) result.error="reader stderr capture: "+error.error; }
        } else if(phaseWatch.ElapsedMilliseconds>=5000) { result.cleanupConfirmed=false; finished=true; }
      }
    }
    public bool StopAndDrain(int budget) {
      if(finished) return result.cleanupConfirmed;
      try {
        result.cancelled=true; Stop();
        Stopwatch end=Stopwatch.StartNew();
        while(!finished&&end.ElapsedMilliseconds<budget) { Tick(); if(!finished) Thread.Sleep(10); }
        return finished&&result.cleanupConfirmed;
      } catch { return false; }
    }
    public string Descriptor() {
      if(!finished||!result.processCreated||!result.rootExited||!result.cleanupConfirmed||result.exitCode!=0||result.cancelled||result.timedOut||
          result.outputLimitExceeded||result.hadRemainingChildren||result.error!=null||!stdoutDrained||!stderrDrained||activeProcesses!=0)
        throw new Exception("installed reader failed or did not prove subgroup cleanup"+
          (result.error==null?"":": "+result.error));
      return "{\"processCreated\":true,\"rootExited\":true,\"timedOut\":false,\"outputLimitExceeded\":false,\"hadRemainingChildren\":false,\"cleanupConfirmed\":true,\"cancelled\":false,\"exitCode\":0,"+
        "\"stdoutBytes\":"+result.stdoutBytes+",\"stderrBytes\":"+result.stderrBytes+",\"error\":null,\"startIdentity\":"+result.startIdentity+
        ",\"activeProcesses\":0,\"stdoutDrained\":true,\"stderrDrained\":true}";
    }
    public void Dispose() {
      if(disposed) return; disposed=true;
      if(outWrite!=IntPtr.Zero) CloseHandle(outWrite); if(errWrite!=IntPtr.Zero) CloseHandle(errWrite);
      if(input!=IntPtr.Zero&&input!=new IntPtr(-1)) CloseHandle(input);
      if(job!=IntPtr.Zero) CloseHandle(job);
      if(outRead!=IntPtr.Zero) CloseHandle(outRead); if(errRead!=IntPtr.Zero) CloseHandle(errRead);
      if(process.thread!=IntPtr.Zero) CloseHandle(process.thread); if(process.process!=IntPtr.Zero) CloseHandle(process.process);
      if(attrReady) DeleteProcThreadAttributeList(attrs); if(attrs!=IntPtr.Zero) Marshal.FreeHGlobal(attrs);
      if(handles!=IntPtr.Zero) Marshal.FreeHGlobal(handles); if(env!=IntPtr.Zero) Marshal.FreeHGlobal(env);
      if(output!=null) output.Release(); if(error!=null) error.Release();
      if(stdoutLease!=null) stdoutLease.Dispose(); if(stderrLease!=null) stderrLease.Dispose();
      if(helperLease!=null) helperLease.Dispose();
    }
  }
  // The controller owns this private standard-input pipe. Product children
  // inherit only their NUL/stdout/stderr handles, never either control pipe.
  // Polling avoids a blocked reader thread during cancellation and shutdown.
  sealed class RuntimeControl {
    readonly IntPtr input; readonly string id; string pending=""; int sequence;
    readonly string readerProduct,readerHelper,readerHash,readerDirectory,cancellationFile;
    readonly string[] environment; ReaderOperation reader; string readerRoot;
    public RuntimeControl(string controlId,string product,string helper,string helperHash,string directory,string cancel,string[] variables) {
      Guid parsed; if(!Guid.TryParseExact(controlId,"D",out parsed)) throw new Exception("invalid native control identity");
      id=controlId; input=GetStdHandle(-10);
      if(input==IntPtr.Zero||input==new IntPtr(-1)) throw new Exception("private control input is absent");
      if(product!=""&&product!="toolsenabled"&&product!="scribe"&&product!="web-editor"&&product!="presentation-suite") throw new Exception("unknown fixed reader product");
      readerProduct=product; readerHelper=helper; readerHash=helperHash; readerDirectory=directory; cancellationFile=cancel; environment=variables;
      Console.OutputEncoding=new UTF8Encoding(false);
    }
    public bool StopReader(int cleanup) {
      if(reader==null) return true;
      bool clean=reader.StopAndDrain(cleanup); reader.Dispose(); reader=null; return clean;
    }
    public void Poll(IntPtr job,PI root,string executable,string profile,string identity) {
      if(reader!=null) {
        reader.Tick();
        if(reader.finished) {
          string descriptor=reader.Descriptor();
          LiveMember(root.process,job);
          string after=StartIdentity(root,executable,profile);
          if(after!=identity||readerRoot!=identity) throw new Exception("product root changed during reader operation");
          string stdout=CapturedFile(reader.output,reader.result.stdoutBytes),stderr=CapturedFile(reader.error,reader.result.stderrBytes);
          LiveMember(root.process,job);
          string readerReply="{\"schema\":\"toolsenabled.owned-installed-state-reader\",\"schemaVersion\":1,\"controlId\":"+Json(id)+
            ",\"requestId\":"+sequence+",\"operation\":\"observe-installed-state\",\"product\":"+Json(readerProduct)+
            ",\"observedAt\":"+Json(DateTime.UtcNow.ToString("o"))+",\"rootBefore\":"+readerRoot+",\"rootAfter\":"+after+
            ",\"reader\":"+descriptor+",\"stdout\":"+stdout+",\"stderr\":"+stderr+"}";
          if(Encoding.UTF8.GetByteCount(readerReply)>512*1024) throw new Exception("reader descriptor exceeds its bound");
          Console.Out.Write(readerReply+"\n"); Console.Out.Flush();
          reader.Dispose(); reader=null;
        }
      }
      uint available; Check(PeekNamedPipe(input,IntPtr.Zero,0,IntPtr.Zero,out available,IntPtr.Zero),"poll private control input");
      if(available==0) return;
      if(available>64) throw new Exception("control request exceeds its bound");
      byte[] buffer=new byte[(int)available]; uint read;
      Check(ReadFile(input,buffer,available,out read,IntPtr.Zero),"read private control request");
      if(read==0||read>available) throw new Exception("control input is incomplete");
      for(int i=0;i<(int)read;i++) { if(buffer[i]!=10&&(buffer[i]<32||buffer[i]>126)) throw new Exception("invalid control byte"); pending+=(char)buffer[i]; }
      if(pending.Length>64) throw new Exception("control request exceeds its bound");
      if(pending.IndexOf('\n')<0) return;
      bool runtime=pending=="observe-runtime:"+(sequence+1)+"\n";
      bool installed=pending=="observe-installed-state:"+(sequence+1)+"\n";
      if(sequence>=128||reader!=null||(!runtime&&!installed)||(installed&&readerProduct=="")) throw new Exception("unknown, duplicate or out-of-order control request");
      pending=""; sequence++;
      if(installed) {
        LiveMember(root.process,job);
        readerRoot=StartIdentity(root,executable,profile);
        if(readerRoot!=identity) throw new Exception("product root changed before reader operation");
        reader=new ReaderOperation(job,root,readerHelper,readerHash,readerProduct,profile,environment,cancellationFile,
          Path.Combine(readerDirectory,"installed-state-"+sequence.ToString("D4")));
        reader.Begin(); return;
      }
      string reply=RuntimeObservation(job,root,executable,profile,identity,id,sequence);
      if(Encoding.UTF8.GetByteCount(reply)>512*1024) throw new Exception("runtime observation exceeds its bound");
      Console.Out.Write(reply+"\n"); Console.Out.Flush();
    }
  }
  static void PublishStart(string file,string value) {
    string temporary=file+".writing"; byte[] bytes=new UTF8Encoding(false).GetBytes(value);
    using(FileStream output=new FileStream(temporary,FileMode.CreateNew,FileAccess.Write,FileShare.Read)) { output.Write(bytes,0,bytes.Length); output.Flush(true); }
    File.Move(temporary,file);
  }
  sealed class Pump {
    public long bytes; public volatile bool exceeded,cleanupFailed; public volatile string error; public string sha256; public bool sealedCapture;
    readonly object gate=new object(); readonly long limit; readonly Thread thread;
    PlainLease capture; IntPtr readHandle; bool started,released;
    public Pump(IntPtr handle,PlainLease sink,long maximum) {
      readHandle=handle; capture=sink; limit=maximum; thread=new Thread(Work); thread.IsBackground=true;
    }
    public void Start() {
      lock(gate) { if(started||released) throw new Exception("capture pump already started or released"); started=true; }
      try { thread.Start(); }
      catch { lock(gate) { started=(thread.ThreadState&System.Threading.ThreadState.Unstarted)==0; } throw; }
    }
    public bool Join(int milliseconds) {
      lock(gate) { if(!started) return true; }
      return thread.Join(milliseconds);
    }
    void Work() {
      try {
        IntPtr ownedInput=readHandle; readHandle=IntPtr.Zero;
        // The handle's outer using also closes it if constructing FileStream
        // fails, before the worker can acknowledge completion.
        using(SafeFileHandle pipe=new SafeFileHandle(ownedInput,true))
        using(FileStream input=new FileStream(pipe,FileAccess.Read,65536,false)) {
          byte[] buffer=new byte[65536]; int count;
          while((count=input.Read(buffer,0,buffer.Length))>0) {
            long remaining=limit-bytes;
            if(remaining>0) capture.stream.Write(buffer,0,(int)Math.Min(remaining,count));
            bytes+=count; if(bytes>limit) exceeded=true;
          }
          capture.stream.Flush(true);
          // Sealing stays on this worker: a stuck flush/hash cannot block the
          // owner loop or become a successful pipe-drained acknowledgement.
          if(!exceeded) { sha256=capture.Seal(bytes); sealedCapture=true; }
        }
      } catch(Exception e) { error=e.Message; sha256=null; sealedCapture=false; }
      finally {
        PlainLease release;
        lock(gate) { release=capture; capture=null; }
        // Disposal is part of the worker's bounded Join, including success.
        // A slow flush/close never moves back onto the owner polling thread.
        if(release!=null) {
          try { release.Dispose(); }
          catch(Exception e) { cleanupFailed=true; error="capture release: "+e.Message; sha256=null; sealedCapture=false; }
        }
      }
    }
    public void Release() {
      PlainLease release=null; IntPtr pipe=IntPtr.Zero;
      lock(gate) {
        // A started worker exclusively owns disposal, even after it finishes.
        // If it cannot join, its retained leases remain its own responsibility.
        if(started||released) return;
        released=true; release=capture; capture=null; pipe=readHandle; readHandle=IntPtr.Zero;
      }
      List<Exception> failures=new List<Exception>();
      try { if(pipe!=IntPtr.Zero) Check(CloseHandle(pipe),"release unstarted capture pipe"); }
      catch(Exception e) { failures.Add(e); }
      try { if(release!=null) release.Dispose(); }
      catch(Exception e) { failures.Add(e); }
      if(failures.Count>0) throw new AggregateException("unstarted capture cleanup failed",failures);
    }
  }
  public static OwnedJobResult Run(string executable,string[] args,string cwd,string[] environment,string stdout,string stderr,int timeout,int cleanup,int grace,long limit,string cancellationFile,string startFile,string expectedProfile,string controlId,string readerProduct,string readerHelper,string readerHash,string readerDirectory) {
    OwnedJobResult result=new OwnedJobResult(); IntPtr job=IntPtr.Zero, outRead=IntPtr.Zero,outWrite=IntPtr.Zero,errRead=IntPtr.Zero,errWrite=IntPtr.Zero,input=IntPtr.Zero,env=IntPtr.Zero,attrs=IntPtr.Zero,handles=IntPtr.Zero;
    PI process=new PI(); Pump output=null,error=null; PlainLease stdoutLease=null,stderrLease=null;
    bool assigned=false,attrReady=false; RuntimeControl control=null;
    try {
      if(File.Exists(cancellationFile)) { result.cancelled=true; result.cleanupConfirmed=true; return result; }
      // JS keeps empty placeholders for not-run batch rows. Open and verify
      // those exact files without truncation, then retain them through capture.
      stdoutLease=PlainLease.Capture(stdout,false); stderrLease=PlainLease.Capture(stderr,false);
      job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero,"create owned job");
      LIMIT limits=new LIMIT(); limits.basic.flags=0x2000; Check(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(LIMIT))),"set kill-on-close");
      SA security=new SA(); security.length=Marshal.SizeOf(typeof(SA)); security.inherit=true;
      Check(CreatePipe(out outRead,out outWrite,ref security,0),"stdout pipe"); Check(SetHandleInformation(outRead,1,0),"stdout read isolation");
      Check(CreatePipe(out errRead,out errWrite,ref security,0),"stderr pipe"); Check(SetHandleInformation(errRead,1,0),"stderr read isolation");
      input=CreateFile("NUL",0x80000000,3,ref security,3,0,IntPtr.Zero); Check(input!=new IntPtr(-1),"stdin NUL");
      IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size); attrs=Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(attrs,1,0,ref size),"initialize handle list"); attrReady=true;
      handles=Marshal.AllocHGlobal(IntPtr.Size*3); Marshal.WriteIntPtr(handles,0,input); Marshal.WriteIntPtr(handles,IntPtr.Size,outWrite); Marshal.WriteIntPtr(handles,IntPtr.Size*2,errWrite);
      Check(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero),"restrict inherited handles");
      SIX startup=new SIX(); startup.start.cb=Marshal.SizeOf(typeof(SIX)); startup.start.flags=0x101; startup.start.show=0; startup.start.input=input; startup.start.output=outWrite; startup.start.error=errWrite; startup.attributes=attrs;
      StringBuilder command=new StringBuilder(Quote(executable)); foreach(string argument in args) command.Append(' ').Append(Quote(argument));
      Array.Sort(environment,StringComparer.OrdinalIgnoreCase); env=Marshal.StringToHGlobalUni(string.Join("\0",environment)+"\0\0");
      Check(CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,true,0x08080404,env,cwd,ref startup,out process),"create suspended owned process"); result.processCreated=true;
      Check(AssignProcessToJobObject(job,process.process),"assign suspended child to job"); assigned=true;
      string identity=StartIdentity(process,executable,expectedProfile);
      output=new Pump(outRead,stdoutLease,limit); outRead=IntPtr.Zero; stdoutLease=null; output.Start();
      error=new Pump(errRead,stderrLease,limit); errRead=IntPtr.Zero; stderrLease=null; error.Start();
      if(File.Exists(cancellationFile)) { result.cancelled=true; throw new OperationCanceledException("cancelled before owned child resume"); }
      Check(ResumeThread(process.thread)!=0xffffffff,"resume owned child"); CloseHandle(outWrite); outWrite=IntPtr.Zero; CloseHandle(errWrite); errWrite=IntPtr.Zero;
      control=String.IsNullOrEmpty(controlId)?null:new RuntimeControl(controlId,readerProduct,readerHelper,readerHash,readerDirectory,cancellationFile,environment);
      result.startIdentity=identity; PublishStart(startFile,identity);
      DateTime deadline=DateTime.UtcNow.AddMilliseconds(timeout); bool stop=false;
      while(WaitForSingleObject(process.process,20)!=0) {
        if(File.Exists(cancellationFile)) { result.cancelled=true; stop=true; break; }
        if(output.exceeded||error.exceeded) { result.outputLimitExceeded=true; stop=true; break; }
        if(output.error!=null||error.error!=null) throw new Exception("output pump failed");
        if(DateTime.UtcNow>=deadline) { result.timedOut=true; stop=true; break; }
        if(control!=null) control.Poll(job,process,executable,expectedProfile,identity);
      }
      if(!stop) {
        DateTime end=DateTime.UtcNow.AddMilliseconds(grace);
        while(Active(job)>0 && DateTime.UtcNow<end) Thread.Sleep(10);
        if(Active(job)>0) { result.hadRemainingChildren=true; stop=true; }
      }
      if(stop) Check(TerminateJobObject(job,0xe001),"terminate owned job");
      DateTime cleanupEnd=DateTime.UtcNow.AddMilliseconds(cleanup);
      while(Active(job)>0 && DateTime.UtcNow<cleanupEnd) Thread.Sleep(10);
      result.cleanupConfirmed=Active(job)==0;
      result.rootExited=WaitForSingleObject(process.process,0)==0;
      uint code; if(result.rootExited && GetExitCodeProcess(process.process,out code)) result.exitCode=code;
    } catch(Exception e) {
      result.error=e.Message;
      if(assigned) { TerminateJobObject(job,0xe002); DateTime end=DateTime.UtcNow.AddMilliseconds(cleanup); try { while(Active(job)>0 && DateTime.UtcNow<end) Thread.Sleep(10); result.cleanupConfirmed=Active(job)==0; } catch {} }
      else if(result.processCreated) { TerminateProcess(process.process,0xe003); result.cleanupConfirmed=WaitForSingleObject(process.process,(uint)cleanup)==0; }
      else result.cleanupConfirmed=true;
    } finally {
      if(control!=null&&!control.StopReader(cleanup)) result.cleanupConfirmed=false;
      if(outWrite!=IntPtr.Zero) CloseHandle(outWrite); if(errWrite!=IntPtr.Zero) CloseHandle(errWrite); if(input!=IntPtr.Zero && input!=new IntPtr(-1)) CloseHandle(input);
      if(job!=IntPtr.Zero) CloseHandle(job);
      if(output!=null) { bool joined=output.Join(cleanup); if(!joined||output.cleanupFailed) result.cleanupConfirmed=false; result.stdoutBytes=output.bytes; result.outputLimitExceeded|=output.exceeded; if(output.error!=null) result.error="stdout capture: "+output.error; if(joined&&output.sealedCapture&&output.error==null&&!output.exceeded) result.stdoutSha256=output.sha256; output.Release(); }
      if(error!=null) { bool joined=error.Join(cleanup); if(!joined||error.cleanupFailed) result.cleanupConfirmed=false; result.stderrBytes=error.bytes; result.outputLimitExceeded|=error.exceeded; if(error.error!=null) result.error="stderr capture: "+error.error; if(joined&&error.sealedCapture&&error.error==null&&!error.exceeded) result.stderrSha256=error.sha256; error.Release(); }
      if(stdoutLease!=null) stdoutLease.Dispose(); if(stderrLease!=null) stderrLease.Dispose();
      if(outRead!=IntPtr.Zero) CloseHandle(outRead); if(errRead!=IntPtr.Zero) CloseHandle(errRead);
      if(process.thread!=IntPtr.Zero) CloseHandle(process.thread); if(process.process!=IntPtr.Zero) CloseHandle(process.process);
      if(attrReady) DeleteProcThreadAttributeList(attrs); if(attrs!=IntPtr.Zero) Marshal.FreeHGlobal(attrs); if(handles!=IntPtr.Zero) Marshal.FreeHGlobal(handles); if(env!=IntPtr.Zero) Marshal.FreeHGlobal(env);
    }
    return result;
  }
}
`;

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
  const time = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,7}Z$/.test(value) ? Date.parse(value) : NaN;
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
  const implementation = fileIdentity(moduleFile, { maximum: 4 * 1024 * 1024 }).sha256;
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
        if (fileIdentity(moduleFile, { maximum: 4 * 1024 * 1024 }).sha256 !== implementation ||
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
  const transportStable = fileIdentity(moduleFile, { maximum: 4 * 1024 * 1024 }).sha256 === implementation &&
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
