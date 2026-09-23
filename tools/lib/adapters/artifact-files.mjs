import fs from 'node:fs';
import path from 'node:path';
import { userInfo } from 'node:os';
import { createHash } from 'node:crypto';

// The build account comes from the OS, never a retired machine's profile or
// inherited USERPROFILE. Keep the existing lexical/no-link/hard-link gates.
// Export names are retained for source/receipt-reader compatibility.
export const DEV_PROFILE = userInfo().homedir;
export const DEV_TEMP = `${DEV_PROFILE}\\AppData\\Local\\Temp`;
// Ordinary inputs share the native boundary: the actual Windows account or
// the POSIX filesystem root. Repository discovery must use this same fence.
export const NATIVE_PATH_ROOT = process.platform === 'win32' ? DEV_PROFILE : path.parse(path.sep).root;
export const FILE_LIMIT = 8 * 1024 ** 3;
export const ENTRY_LIMIT = 100000;
export const JSON_LIMIT = 16 * 1024 ** 2;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const digestRecord = value => hash(canonical(value));

export function blocked(message) {
  const error = new Error(`Artifact qualification blocked: ${message}`);
  error.code = 'ARTIFACT_QUALIFICATION_BLOCKED';
  throw error;
}

export function relativeName(value) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f:]/.test(value) || /^[\\/]/.test(value)) blocked('unsafe archive/source file name');
  const parts = value.replaceAll('\\', '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) blocked('unsafe archive/source path component');
  return parts.join('/');
}

export function contains(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function plainPath(value, { kind, missingLeaf = false, systemFile = false } = {}) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value) || /^[\\/]{2}/.test(value) ||
      (process.platform === 'win32' && /:/.test(value.replace(/^[a-z]:/i, '')))) blocked('an explicit ordinary absolute path is required');
  const resolved = path.resolve(value);
  const systemRoots = ['C:\\Program Files\\7-Zip', 'C:\\agent-apps\\node-v22.19.0', 'C:\\Program Files\\Git\\cmd'];
  const fence = process.platform === 'win32' && systemFile ? systemRoots.find(root => contains(root, resolved)) : NATIVE_PATH_ROOT;
  if (!fence) blocked('system tool is outside its fixed approved roots');
  if (!contains(fence, resolved) || resolved === fence && kind === 'file') blocked('path leaves its approved profile/tool root');
  let current = fence;
  const parts = path.relative(fence, resolved).split(path.sep).filter(Boolean);
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) { relativeName(parts[index]); current = path.join(current, parts[index]); }
    let stat;
    try { stat = lstat(current); }
    catch (error) { if (missingLeaf && index === parts.length - 1 && error.code === 'ENOENT') return resolved; throw error; }
    if (stat.isSymbolicLink()) blocked('linked/reparse-point input refused before traversal');
    if (index < parts.length - 1 && !stat.isDirectory()) blocked('input ancestor is not a directory');
    if (index === parts.length - 1 && ((kind === 'file' && !stat.isFile()) || (kind === 'directory' && !stat.isDirectory()))) blocked(`input is not a ${kind}`);
  }
  return resolved;
}

const MAX_SAFE_BYTES = BigInt(Number.MAX_SAFE_INTEGER);
// Every NTFS file ID on this volume is above Number.MAX_SAFE_INTEGER, so a
// non-bigint Stats.ino is a rounded double and cannot establish that two reads
// saw the same file. Every stat in this module is taken with { bigint: true },
// together and never staggered: a half-converted file would compare a BigInt
// dev/ino against a Number one and refuse every input permanently.
const lstat = file => fs.lstatSync(file, { bigint: true });
const fstat = fd => fs.fstatSync(fd, { bigint: true });
// Counts and budgets stay in Numbers. A BigInt converts only inside the safe
// integer range, so an out-of-range value still fails its caller's existing
// Number.isSafeInteger guard rather than bypassing it.
const statNumber = value => (typeof value === 'bigint'
  ? (value >= 0n && value <= MAX_SAFE_BYTES ? Number(value) : Number.NaN)
  : value);

function sameStat(a, b) {
  return ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]);
}

function ordinaryFile(stat, systemFile) {
  // A Dev-side hard link can alias an input outside the declared tree. Fixed
  // approved system-tool roots may contain legitimate hard-linked binaries;
  // their positive link count must still remain stable throughout the read.
  const links = statNumber(stat.nlink);
  if (!stat.isFile() || stat.isSymbolicLink() || !Number.isSafeInteger(links) || links < 1 ||
      (!systemFile && links !== 1)) blocked('input is not an ordinary permitted-link file');
}

function captureFile(file, { maximum, systemFile = false, allowEmpty = true, gitBlob = false }, collect = false) {
  if (!Number.isSafeInteger(maximum) || maximum < 0) blocked('file byte budget must be a nonnegative safe integer');
  // A synchronous operation can prevent an outer timer from firing. Refuse a
  // late result using one fixed monotonic budget, including final hashing and
  // descriptor closure; this does not claim to interrupt a blocked syscall.
  const deadline = process.hrtime.bigint() + 120_000_000_000n;
  const checkTime = () => { if (process.hrtime.bigint() >= deadline) blocked('file capture deadline expired'); };
  checkTime();
  file = plainPath(file, { kind: 'file', systemFile });
  checkTime();
  const namedBefore = lstat(file);
  ordinaryFile(namedBefore, systemFile);
  checkTime();
  const fd = fs.openSync(file, 'r');
  let result;
  try {
    checkTime();
    const before = fstat(fd);
    checkTime();
    ordinaryFile(before, systemFile);
    if (!sameStat(namedBefore, before)) blocked('file changed before measurement');
    // The opened length in Numbers, for the budgets and the read arithmetic.
    // sameStat keeps comparing the BigInt sizes; this is the same value.
    const size = statNumber(before.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > maximum ||
        (!allowEmpty && !size)) blocked('file is empty or exceeds its byte budget');
    const digest = createHash('sha256'), buffer = Buffer.alloc(Math.min(1024 * 1024, size || 1));
    const content = collect ? Buffer.alloc(size) : null;
    const blob = gitBlob ? createHash('sha1').update(`blob ${size}\0`) : null;
    checkTime();
    let bytes = 0;
    for (;;) {
      checkTime();
      // Read only the opened length plus one overflow sentinel. Growth cannot
      // extend the loop to EOF indefinitely, even when the caller's cap is large.
      const remaining = size - bytes;
      const requested = remaining > 0 ? Math.min(buffer.length, remaining) : 1;
      const count = fs.readSync(fd, buffer, 0, requested, null);
      checkTime();
      if (!Number.isSafeInteger(count) || count < 0 || count > requested) blocked('invalid file read count');
      if (!count) break;
      bytes += count;
      if (bytes > maximum) blocked('file grew beyond its byte budget');
      if (bytes > size) blocked('file changed during measurement');
      digest.update(buffer.subarray(0, count));
      blob?.update(buffer.subarray(0, count));
      checkTime();
      content?.set(buffer.subarray(0, count), bytes - count);
      checkTime();
    }
    const after = fstat(fd);
    checkTime();
    ordinaryFile(after, systemFile);
    if (bytes !== size || !sameStat(before, after)) blocked('file changed during measurement');
    const current = lstat(plainPath(file, { kind: 'file', systemFile }));
    checkTime();
    ordinaryFile(current, systemFile);
    if (!sameStat(before, current)) blocked('file changed during measurement');
    result = { identity: { sha256: digest.digest('hex'), bytes, ...(blob ? { gitBlobSha1: blob.digest('hex') } : {}) }, content };
    checkTime();
  } finally { fs.closeSync(fd); }
  checkTime();
  return result;
}

export function measureFile(file, { maximum = FILE_LIMIT, systemFile = false, allowEmpty = true, gitBlob = false } = {}) {
  return captureFile(file, { maximum, systemFile, allowEmpty, gitBlob }).identity;
}

export function readBounded(file, maximum = JSON_LIMIT) {
  // Bytes and their identity are captured through the same descriptor. This
  // eliminates a second pathname open, but the initial Windows ancestor walk
  // still needs a retained native no-follow boundary; these checks do not claim
  // to prevent an ancestor substitution before openSync.
  return captureFile(file, { maximum }, true).content;
}

export function readJson(file) { return JSON.parse(readBounded(file).toString('utf8')); }

export function measureTree(root, { include = () => true } = {}) {
  root = plainPath(root, { kind: 'directory' });
  const files = {}, names = new Set();
  let totalBytes = 0;
  function visit(directory, prefix = '') {
    const before = fs.readdirSync(directory).sort();
    for (const name of before) {
      const relative = relativeName(prefix ? `${prefix}/${name}` : name);
      if (!include(relative)) continue;
      const lower = relative.toLowerCase();
      if (names.has(lower)) blocked('case-aliased tree entries');
      names.add(lower);
      if (names.size > ENTRY_LIMIT) blocked('tree entry budget exceeded');
      const full = plainPath(path.join(root, relative));
      const stat = lstat(full);
      if (stat.isDirectory()) visit(full, relative);
      else if (stat.isFile()) {
        files[relative] = measureFile(full);
        totalBytes += files[relative].bytes;
        if (totalBytes > FILE_LIMIT) blocked('tree byte budget exceeded');
      } else blocked('tree contains a non-regular file');
    }
    if (JSON.stringify(fs.readdirSync(directory).sort()) !== JSON.stringify(before)) blocked('tree changed during enumeration');
  }
  visit(root);
  if (!Object.keys(files).length) blocked('empty tree is not an artifact');
  return { sha256: digestRecord(files), bytes: totalBytes, files };
}

export function assertSameTree(expected, observed) {
  if (expected.sha256 !== observed.sha256 || expected.bytes !== observed.bytes ||
      JSON.stringify(expected.files) !== JSON.stringify(observed.files)) blocked('installer payload differs from the exact staged tree');
}

// 7-Zip's structured listing, never human column output. This parser makes no
// extraction decisions until the complete listing has been reconciled.
export function parseArchiveListing(text, { type, requireSizes = true } = {}) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > JSON_LIMIT) blocked('archive listing exceeds its budget');
  const split = text.replaceAll('\r', '').split('\n----------\n');
  if (split.length !== 2) blocked('archive listing is incomplete/ambiguous');
  const actualType = /^Type = (.+)$/m.exec(split[0])?.[1];
  if (type && actualType?.toLowerCase() !== type.toLowerCase()) blocked('archive format differs from the required decoder');
  const entries = [], seen = new Set();
  let bytes = 0;
  for (const block of split[1].trim().split(/\n\s*\n/)) {
    const fields = {};
    for (const line of block.split('\n')) {
      const match = /^([^=\n]+) = (.*)$/.exec(line);
      if (!match || Object.hasOwn(fields, match[1])) blocked('archive listing has malformed/duplicate fields');
      fields[match[1]] = match[2];
    }
    const name = relativeName(fields.Path);
    if (seen.has(name.toLowerCase())) blocked('duplicate/case-aliased archive path');
    seen.add(name.toLowerCase());
    if (Object.keys(fields).some(key => /link|alternate stream|reparse/i.test(key)) || /(?:^|\s)l[rwx-]{3}|\bREPARSE\b/i.test(fields.Attributes || '') || fields.Encrypted === '+') blocked('linked/encrypted archive entry is not permitted');
    const directory = /^D/.test(fields.Attributes || '') || fields.Folder === '+';
    const size = /^\d+$/.test(fields.Size || '') ? Number(fields.Size) : null;
    if ((!directory && requireSizes && size === null) || (size !== null && (!Number.isSafeInteger(size) || size > FILE_LIMIT))) blocked('archive entry size is unknown or excessive');
    bytes += size || 0;
    if (entries.length >= ENTRY_LIMIT || bytes > FILE_LIMIT) blocked('archive expansion budget exceeded');
    entries.push({ name, directory, bytes: size });
  }
  if (!entries.some(entry => !entry.directory)) blocked('empty archive is not an installer payload');
  const byName = new Map(entries.map(entry => [entry.name.toLowerCase(), entry]));
  for (const entry of entries) {
    const pieces = entry.name.split('/');
    for (let index = 1; index < pieces.length; index++) {
      const parent = byName.get(pieces.slice(0, index).join('/').toLowerCase());
      if (parent && !parent.directory) blocked('archive file is also used as a parent directory');
    }
  }
  return { type: actualType, entries, bytes };
}

// Read ASAR directly without evaluating any packaged JavaScript or extracting
// paths. Enforce lengths, paths, offsets, complete byte coverage and no links.
export function readAsar(archivePath, { allowedUnpacked = [] } = {}) {
  archivePath = plainPath(archivePath, { kind: 'file' });
  if (!Array.isArray(allowedUnpacked) || allowedUnpacked.some(name => typeof name !== 'string')) blocked('invalid declared ASAR sidecar selection');
  const declared = allowedUnpacked.map(relativeName).sort();
  if (new Set(declared.map(name => name.toLowerCase())).size !== declared.length) blocked('duplicate declared ASAR sidecar selection');
  // The only sidecar root is Electron's adjacent fixed directory. A caller
  // cannot make an archive read bytes from a convenient unrelated source tree.
  const sidecarRoot = `${archivePath}.unpacked`;
  const sidecar = declared.length ? measureTree(sidecarRoot) : null;
  if (sidecar && JSON.stringify(Object.keys(sidecar.files).sort()) !== JSON.stringify(declared)) blocked('ASAR sidecar files differ from the exact declared selection');
  const generation = lstat(archivePath);
  ordinaryFile(generation, false);
  const sameGeneration = stat => sameStat(generation, stat) &&
    generation.mtimeNs === stat.mtimeNs && generation.ctimeNs === stat.ctimeNs;
  const identity = measureFile(archivePath, { allowEmpty: false });
  const fd = fs.openSync(archivePath, 'r');
  try {
    // Hashing and parsing must name the same file generation. Otherwise an
    // archive swapped only for this second open can return hashes from B with
    // identity A, even when the original pathname is restored before teardown.
    const opened = fstat(fd);
    if (!sameGeneration(opened)) blocked('ASAR parsing descriptor differs from its measured identity');
    ordinaryFile(opened, false);
    const head = Buffer.alloc(16);
    if (fs.readSync(fd, head, 0, 16, 0) !== 16 || head.readUInt32LE(0) !== 4) blocked('invalid/truncated ASAR size pickle');
    const headerSize = head.readUInt32LE(4), jsonLength = head.readUInt32LE(12);
    if (headerSize < 8 || headerSize > JSON_LIMIT || headerSize % 4 || jsonLength > headerSize - 8 ||
        head.readUInt32LE(8) !== headerSize - 4 || 8 + headerSize > identity.bytes) blocked('invalid/excessive ASAR header length');
    const json = Buffer.alloc(jsonLength);
    if (fs.readSync(fd, json, 0, jsonLength, 16) !== jsonLength) blocked('truncated ASAR header');
    const header = JSON.parse(json.toString('utf8')), entries = {}, lower = new Set(), ranges = [], unpackedNames = [];
    const base = 8 + headerSize;
    function visit(node, prefix = '', depth = 0) {
      if (depth > 100 || !node || typeof node !== 'object' || !node.files || Array.isArray(node.files)) blocked('invalid/deep ASAR directory');
      for (const [name, child] of Object.entries(node.files)) {
        const relative = relativeName(prefix ? `${prefix}/${name}` : name);
        if (name.includes('/') || name.includes('\\') || lower.has(relative.toLowerCase()) || lower.size >= ENTRY_LIMIT) blocked('invalid/duplicate ASAR entry');
        lower.add(relative.toLowerCase());
        if (!child || typeof child !== 'object' || child.link !== undefined) blocked('linked/invalid ASAR entry');
        if (child.files) { if (child.size !== undefined || child.offset !== undefined) blocked('ambiguous ASAR node'); visit(child, relative, depth + 1); continue; }
        if (!Number.isSafeInteger(child.size) || child.size < 0 || child.size > FILE_LIMIT) blocked('oversized ASAR entry');
        if (child.unpacked !== undefined && typeof child.unpacked !== 'boolean') blocked('invalid ASAR unpacked flag');
        if (child.unpacked) {
          if (child.offset !== undefined || !declared.includes(relative) || sidecar?.files[relative]?.bytes !== child.size) blocked('undeclared or differently sized ASAR sidecar entry');
          unpackedNames.push(relative);
          entries[relative] = { unpacked: true, bytes: child.size };
          continue;
        }
        if (typeof child.offset !== 'string' || !/^\d+$/.test(child.offset)) blocked('invalid ASAR offset');
        const offset = Number(child.offset);
        if (!Number.isSafeInteger(offset) || offset + child.size > identity.bytes - base) blocked('ASAR file exceeds the archive');
        entries[relative] = { offset: base + offset, bytes: child.size };
        if (child.size) ranges.push([offset, offset + child.size]);
      }
    }
    visit(header);
    if (JSON.stringify(unpackedNames.sort()) !== JSON.stringify(declared)) blocked('ASAR sidecar header differs from the exact declared selection');
    if (!Object.keys(entries).length) blocked('empty ASAR');
    ranges.sort((a, b) => a[0] - b[0]);
    let end = 0;
    for (const range of ranges) { if (range[0] !== end) blocked('ASAR bytes overlap or are not accounted for'); end = range[1]; }
    if (end !== identity.bytes - base) blocked('ASAR has unaccounted trailing bytes');
    function read(name, maximum = JSON_LIMIT) {
      const entry = entries[relativeName(name)];
      if (!entry || entry.unpacked || entry.bytes > maximum) blocked('required packed ASAR entry missing/excessive');
      const bytes = Buffer.alloc(entry.bytes);
      if (fs.readSync(fd, bytes, 0, bytes.length, entry.offset) !== bytes.length) blocked('ASAR changed during entry read');
      return bytes;
    }
    const files = {};
    for (const name of Object.keys(entries).sort()) {
      if (entries[name].unpacked) { files[name] = sidecar.files[name]; continue; }
      const entry = entries[name], digest = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
      let remaining = entry.bytes, cursor = entry.offset;
      while (remaining) {
        const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, remaining), cursor);
        if (!count) blocked('ASAR changed during hashing');
        digest.update(buffer.subarray(0, count)); remaining -= count; cursor += count;
      }
      files[name] = { sha256: digest.digest('hex'), bytes: entry.bytes };
    }
    const packageJson = JSON.parse(read('package.json').toString('utf8'));
    if (typeof packageJson.main !== 'string' || !entries[relativeName(packageJson.main)] || entries[relativeName(packageJson.main)].unpacked) blocked('ASAR declared main is absent or unpacked');
    const provenance = entries['dist/build-info.json'] ? JSON.parse(read('dist/build-info.json').toString('utf8')) : null;
    const after = measureFile(archivePath);
    if (after.sha256 !== identity.sha256 || after.bytes !== identity.bytes) blocked('ASAR changed during measurement');
    if (sidecar) assertSameTree(sidecar, measureTree(sidecarRoot));
    const closedGeneration = fstat(fd), currentGeneration = lstat(plainPath(archivePath, { kind: 'file' }));
    ordinaryFile(closedGeneration, false); ordinaryFile(currentGeneration, false);
    if (!sameGeneration(closedGeneration) || !sameGeneration(currentGeneration)) blocked('ASAR changed during parsing or sidecar measurement');
    return { identity, files, packageJson, provenance, sha256: digestRecord(files), ...(sidecar ? { unpacked: sidecar } : {}) };
  } finally { fs.closeSync(fd); }
}

export function assertWindowsX64Pe(file) {
  file = plainPath(file, { kind: 'file' });
  const generation = lstat(file);
  ordinaryFile(generation, false);
  const sameGeneration = stat => sameStat(generation, stat) &&
    generation.mtimeNs === stat.mtimeNs && generation.ctimeNs === stat.ctimeNs;
  const fd = fs.openSync(file, 'r');
  try {
    if (!sameGeneration(fstat(fd))) blocked('PE parsing descriptor differs from its file identity');
    const dos = Buffer.alloc(64);
    if (fs.readSync(fd, dos, 0, dos.length, 0) !== dos.length || dos.toString('ascii', 0, 2) !== 'MZ') blocked('runtime/installer is not a PE image');
    const offset = dos.readUInt32LE(60), pe = Buffer.alloc(26);
    if (offset < 64 || offset > 16 * 1024 * 1024 || fs.readSync(fd, pe, 0, pe.length, offset) !== pe.length ||
        pe.readUInt32LE(0) !== 0x4550 || pe.readUInt16LE(4) !== 0x8664 || pe.readUInt16LE(24) !== 0x20b) blocked('runtime is not a Windows x64 PE32+ image');
    if (!sameGeneration(fstat(fd)) || !sameGeneration(lstat(plainPath(file, { kind: 'file' })))) blocked('PE changed during native header measurement');
    return { platform: 'win32', arch: 'x64' };
  } finally { fs.closeSync(fd); }
}
