import fs from 'node:fs';
import path from 'node:path';
import { userInfo, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

export const DEV = userInfo().homedir;
export const TEMP = process.platform === 'linux' ? tmpdir() : `${DEV}\\AppData\\Local\\Temp`;

export function fencedPath(input, { system = false } = {}) {
  if (typeof input !== 'string' || !input || input.includes('\0') || /^[\\/]{2}/.test(input) ||
      (process.platform === 'win32' && (/^[a-z]:[^\\/]/i.test(input) || /:/.test(input.replace(/^[a-z]:/i, '')) ||
        input.split(/[\\/]/).some(part => /[ .]$/.test(part) && part !== '.' && part !== '..')))) throw new Error('unsafe or alternate path spelling');
  const file = path.resolve(input);
  const lower = file.toLowerCase();
  if (process.platform === 'win32' && !(lower === DEV.toLowerCase() || lower.startsWith(`${DEV.toLowerCase()}\\`))) {
    if (!system || lower.startsWith('\x63:\\users\\')) throw new Error('path leaves the permitted OS account fence');
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

export const IDENTITY_LIMIT = 8 * 1024 ** 3;
const MAX_SAFE_BYTES = BigInt(Number.MAX_SAFE_INTEGER);
// Every NTFS file ID on this volume is above Number.MAX_SAFE_INTEGER, so a
// non-bigint Stats.ino is a rounded double: two different files whose IDs differ
// by less than the double spacing compare equal, and a one-unit change rounds
// away unnoticed. Every stat that feeds an identity comparison, including the
// admission ledger's ownership check, is taken with { bigint: true } and its
// dev/ino compared as BigInts.
export const lstat = file => fs.lstatSync(file, { bigint: true });
export const fstat = handle => fs.fstatSync(handle, { bigint: true });
// Counts and budgets stay in Numbers. A BigInt is converted only inside the safe
// integer range; anything else yields NaN and fails its caller's existing
// Number.isSafeInteger guard rather than bypassing it.
const statNumber = value => (typeof value === 'bigint'
  ? (value >= 0n && value <= MAX_SAFE_BYTES ? Number(value) : Number.NaN)
  : value);
const sameFileStat = (a, b) => ['dev', 'ino', 'mode', 'size', 'mtimeMs', 'ctimeMs', 'nlink'].every(key => a[key] === b[key]);
// Node does not expose O_PATH on every platform. Use its fixed Linux ABI value
// only in the Linux branch; it acquires metadata without opening for data I/O.
const LINUX_O_PATH = 0x200000;
const PROC_SUPER_MAGIC = 0x9fa0n;
const sameProcDirectory = (a, b) => ['dev', 'ino', 'mode', 'uid', 'gid'].every(key => a[key] === b[key]);
function ownProcDescriptorView(checkTime) {
  const observe = operation => { checkTime(); const value = operation(); checkTime(); return value; };
  try {
    const pid = process.pid, uid = process.geteuid();
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(uid) || uid < 0) throw new Error('invalid current process identity');
    const directories = ['/proc', `/proc/${pid}`, `/proc/${pid}/fd`];
    const identities = directories.map((directory, index) => {
      const info = observe(() => lstat(directory));
      if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o022n ||
          (index === 0 ? info.uid !== 0n : ![0n, BigInt(uid)].includes(info.uid)) ||
          observe(() => fs.statfsSync(directory, { bigint: true })).type !== PROC_SUPER_MAGIC)
        throw new Error('untrusted procfs directory');
      return info;
    });
    if (!observe(() => lstat('/proc/self')).isSymbolicLink() ||
        observe(() => fs.readlinkSync('/proc/self')) !== String(pid)) throw new Error('procfs does not describe this process');
    return { directory: directories[2], identities };
  } catch (cause) {
    throw new Error('Linux file identity requires its own trusted procfs descriptor view', { cause });
  }
}

function admittedFileSize(before, selected, file, maximum) {
  const devFile = process.platform === 'win32' && file.toLowerCase().startsWith(DEV.toLowerCase() + '\\');
  const links = statNumber(before.nlink);
  if (!before.isFile() || !sameFileStat(selected, before) || !Number.isSafeInteger(links) || links <= 0 ||
      (devFile && links !== 1)) throw new Error('file identity input changed, is linked or is not ordinary');
  const size = statNumber(before.size);
  if (!Number.isSafeInteger(size) || size < 0 || size > maximum) throw new Error('file identity exceeds its byte budget');
  return size;
}

function captureDescriptor(file, selected, handle, maximum, includeBytes, checkTime, options, linuxBinding = null) {
  const before = fstat(handle);
  if (linuxBinding) checkTime();
  const size = admittedFileSize(before, selected, file, maximum);
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
  if (linuxBinding) {
    checkTime();
    const held = fstat(linuxBinding.metadataFd);
    checkTime();
    const view = ownProcDescriptorView(checkTime);
    if (!held.isFile() || !sameFileStat(before, held) || view.directory !== linuxBinding.view.directory ||
        view.identities.some((entry, index) => !sameProcDirectory(entry, linuxBinding.view.identities[index])))
      throw new Error('file identity held object or procfs view changed');
  }
  const result = { identity: { path: file, sha256: digest.digest('hex'), bytes }, ...(includeBytes ? { data: Buffer.concat(chunks, bytes) } : {}) };
  checkTime();
  return result;
}

// The Linux metadata descriptor prevents a substituted FIFO/device from being
// opened for data. Synchronous regular-file/procfs operations can still block;
// the existing deadline checks are cooperative, not a hard syscall timeout.
// The non-Linux opening sequence and its ancestor-handle limitation are unchanged.
function captureFile(input, options = {}, includeBytes = false) {
  const maximum = options.maximum === undefined ? IDENTITY_LIMIT : options.maximum;
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > IDENTITY_LIMIT) throw new Error('invalid file identity byte budget');
  const deadline = process.hrtime.bigint() + 120_000_000_000n;
  const checkTime = () => { if (process.hrtime.bigint() >= deadline) throw new Error('file identity read deadline expired'); };
  checkTime();
  const file = unlinkedPath(input, options);
  const selected = lstat(file);
  if (process.platform !== 'linux') {
    const handle = fs.openSync(file, 'r');
    try { return captureDescriptor(file, selected, handle, maximum, includeBytes, checkTime, options); }
    finally { fs.closeSync(handle); checkTime(); }
  }
  let metadataFd = null, handle = null;
  try {
    checkTime();
    metadataFd = fs.openSync(file, LINUX_O_PATH | fs.constants.O_NOFOLLOW);
    checkTime();
    const held = fstat(metadataFd);
    checkTime();
    admittedFileSize(held, selected, file, maximum);
    const view = ownProcDescriptorView(checkTime);
    handle = fs.openSync(`${view.directory}/${metadataFd}`, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    checkTime();
    return captureDescriptor(file, selected, handle, maximum, includeBytes, checkTime, options, { metadataFd, view });
  } finally {
    try { if (handle !== null) fs.closeSync(handle); }
    finally {
      try { if (metadataFd !== null) fs.closeSync(metadataFd); }
      finally { checkTime(); }
    }
  }
}

export function fileIdentity(input, options = {}) { return captureFile(input, options).identity; }

export function captureBytes(input, maximum) { return captureFile(input, { maximum }, true); }
