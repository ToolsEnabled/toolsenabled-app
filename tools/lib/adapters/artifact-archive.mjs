import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { blocked, plainPath, relativeName, measureFile, digestRecord, FILE_LIMIT, ENTRY_LIMIT } from './artifact-files.mjs';

const BLOCK = 512;
const same = (a, b) => ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
const utf8 = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

// All offsets, metadata and content hashes come from one ordinary file
// generation. Parsing never materializes archive-selected filesystem paths.
function withArchive(file, maximum, action) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > FILE_LIMIT) blocked('invalid archive byte budget');
  file = plainPath(file, { kind: 'file' });
  const selected = fs.lstatSync(file, { bigint: true });
  if (selected.nlink !== 1n || selected.size > BigInt(maximum) || selected.size <= 0n) blocked('archive is linked, empty or oversized');
  const identity = measureFile(file, { maximum, allowEmpty: false });
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const deadline = process.hrtime.bigint() + 120_000_000_000n;
  const check = () => { if (process.hrtime.bigint() >= deadline) blocked('archive parsing deadline exceeded'); };
  const read = (offset, bytes) => {
    check();
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(bytes) || offset < 0 || bytes < 0 || bytes > 1024 * 1024 ||
        offset + bytes > identity.bytes) blocked('archive read escapes its bounded input');
    const buffer = Buffer.alloc(bytes);
    for (let done = 0; done < bytes;) {
      const count = fs.readSync(fd, buffer, done, bytes - done, offset + done);
      if (!count) blocked('archive was truncated while reading');
      done += count; check();
    }
    return buffer;
  };
  const chunks = (offset, bytes, consume) => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || offset + bytes > identity.bytes) blocked('archive member exceeds input');
    for (let done = 0; done < bytes;) {
      const buffer = read(offset + done, Math.min(64 * 1024, bytes - done));
      consume(buffer); done += buffer.length;
    }
  };
  try {
    if (!same(selected, fs.fstatSync(fd, { bigint: true }))) blocked('archive changed before parsing');
    const result = action({ file, identity, read, chunks });
    if (!same(selected, fs.fstatSync(fd, { bigint: true })) ||
        !same(selected, fs.lstatSync(plainPath(file, { kind: 'file' }), { bigint: true })) ||
        digestRecord(measureFile(file, { maximum })) !== digestRecord(identity)) blocked('archive changed during parsing');
    check(); return result;
  } finally { fs.closeSync(fd); }
}

function decimal(bytes) {
  const text = bytes.toString('ascii');
  if (!/^[0-9]+ *$/.test(text)) blocked('invalid ar numeric field');
  const value = Number(text.trim());
  if (!Number.isSafeInteger(value) || value < 0 || value > FILE_LIMIT) blocked('ar numeric field exceeds its bound');
  return value;
}

function debMembers(input) {
  if (!input.read(0, 8).equals(Buffer.from('!<arch>\n'))) blocked('installer is not a Debian ar archive');
  const names = ['debian-binary', 'control.tar.xz', 'data.tar.xz'], members = [];
  let offset = 8;
  for (const expected of names) {
    const header = input.read(offset, 60);
    if (!header.subarray(58).equals(Buffer.from('`\n'))) blocked('invalid ar member header');
    const name = header.subarray(0, 16).toString('ascii').trimEnd();
    if (name !== expected && name !== `${expected}/`) blocked('Debian member selection/order differs from its fixed format');
    decimal(header.subarray(16, 28)); decimal(header.subarray(28, 34)); decimal(header.subarray(34, 40));
    if (!/^[0-7]+ *$/.test(header.subarray(40, 48).toString('ascii'))) blocked('invalid ar mode');
    const bytes = decimal(header.subarray(48, 58));
    if (!bytes) blocked('empty Debian archive member');
    offset += 60;
    const digest = createHash('sha256');
    input.chunks(offset, bytes, chunk => digest.update(chunk));
    if (expected === 'debian-binary' && (bytes !== 4 || !input.read(offset, 4).equals(Buffer.from('2.0\n')))) blocked('unsupported Debian archive version');
    if (expected !== 'debian-binary' && (bytes < 6 || !input.read(offset, 6).equals(Buffer.from([253, 55, 122, 88, 90, 0])))) blocked('Debian member is not XZ');
    members.push({ name: expected, offset, bytes, sha256: digest.digest('hex') });
    offset += bytes;
    if (bytes % 2) { if (input.read(offset, 1)[0] !== 10) blocked('invalid ar member padding'); offset++; }
  }
  if (offset !== input.identity.bytes) blocked('Debian archive has trailing or unaccounted members');
  return { artifact: input.identity, members };
}

export function inspectDebArchive(file) {
  return freeze(withArchive(file, FILE_LIMIT, debMembers));
}

export function captureDebMembers(file, directory) {
  directory = plainPath(directory, { kind: 'directory' });
  const mode = fs.lstatSync(directory);
  if (process.getuid && (mode.uid !== process.getuid() || mode.mode & 0o077)) blocked('Debian scratch is not private to its owner');
  return withArchive(file, FILE_LIMIT, input => {
    const parsed = debMembers(input), members = {};
    for (const member of parsed.members.slice(1)) {
      const output = path.join(directory, member.name);
      const fd = fs.openSync(output, 'wx', 0o600);
      try {
        input.chunks(member.offset, member.bytes, buffer => {
          for (let done = 0; done < buffer.length;) {
            const count = fs.writeSync(fd, buffer, done, buffer.length - done);
            if (!Number.isSafeInteger(count) || count <= 0) blocked('compressed member could not be captured');
            done += count;
          }
        });
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      const actual = measureFile(output, { allowEmpty: false });
      if (actual.bytes !== member.bytes || actual.sha256 !== member.sha256) blocked('captured compressed member differs from installer');
      members[member.name] = { path: output, ...actual };
    }
    return freeze({ artifact: parsed.artifact, members });
  });
}

function field(bytes) {
  const nul = bytes.indexOf(0), end = nul < 0 ? bytes.length : nul;
  if (nul >= 0 && bytes.subarray(nul).some(byte => byte !== 0)) blocked('ambiguous NUL-padded tar field');
  return utf8(bytes.subarray(0, end));
}
function octal(bytes) {
  const text = bytes.toString('ascii');
  if (!/^[ \0]*[0-7]+[ \0]*$/.test(text)) blocked('unsupported tar numeric encoding');
  const value = Number.parseInt(text.replace(/^[ \0]+|[ \0]+$/g, ''), 8);
  if (!Number.isSafeInteger(value) || value < 0 || value > FILE_LIMIT) blocked('tar numeric value exceeds its bound');
  return value;
}
function archiveName(raw, type) {
  if (raw === '.' || raw === './') {
    if (type !== 'directory') blocked('tar root is not a directory');
    return '.';
  }
  let value = raw.startsWith('./') ? raw.slice(2) : raw;
  if (type === 'directory' && value.endsWith('/')) value = value.slice(0, -1);
  if (value.includes('\\')) blocked('tar path has alternate separators');
  return relativeName(value);
}

export function inspectTarArchive(file, { maximumBytes = FILE_LIMIT } = {}) {
  return freeze(withArchive(file, maximumBytes, input => {
    if (input.identity.bytes % BLOCK) blocked('tar length is not block aligned');
    const entries = [], names = new Set();
    let offset = 0, totalBytes = 0, pendingName = null, ended = false;
    while (offset < input.identity.bytes) {
      const header = input.read(offset, BLOCK);
      if (header.every(byte => byte === 0)) {
        if (pendingName || offset + 2 * BLOCK > input.identity.bytes || input.read(offset + BLOCK, BLOCK).some(byte => byte !== 0)) blocked('tar terminator is missing/ambiguous');
        input.chunks(offset, input.identity.bytes - offset, chunk => { if (chunk.some(byte => byte !== 0)) blocked('tar has data after its terminator'); });
        ended = true; break;
      }
      const checksum = octal(header.subarray(148, 156));
      const calculated = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
      if (checksum !== calculated) blocked('tar header checksum differs');
      const signature = header.subarray(257, 265);
      const ustar = signature.equals(Buffer.from('ustar\0' + '00'));
      if (!ustar && !signature.equals(Buffer.from('ustar  \0'))) blocked('unregistered tar header format');
      const mode = octal(header.subarray(100, 108)), uid = octal(header.subarray(108, 116)), gid = octal(header.subarray(116, 124));
      const bytes = octal(header.subarray(124, 136)), mtime = octal(header.subarray(136, 148));
      const uname = field(header.subarray(265, 297)), gname = field(header.subarray(297, 329));
      const deviceNumber = bytes => bytes.every(byte => byte === 0) ? 0 : octal(bytes);
      if (deviceNumber(header.subarray(329, 337)) || deviceNumber(header.subarray(337, 345)) ||
          header.subarray(ustar ? 500 : 345).some(byte => byte !== 0)) blocked('tar has unsupported device or extension metadata');
      const flag = header[156], start = offset + BLOCK;
      const padded = Math.ceil(bytes / BLOCK) * BLOCK;
      if (start + padded > input.identity.bytes) blocked('tar member exceeds the archive');
      if (flag === 76) { // GNU long filename; the next ordinary header owns it.
        if (pendingName || bytes < 2 || bytes > 4096 || field(header.subarray(0, 100)) !== '././@LongLink') blocked('unsupported GNU long-name record');
        const raw = input.read(start, bytes);
        if (raw.at(-1) !== 0 || raw.subarray(0, -1).includes(0)) blocked('ambiguous GNU long name');
        if (padded !== bytes && input.read(start + bytes, padded - bytes).some(byte => byte !== 0)) blocked('nonzero GNU long-name padding');
        pendingName = utf8(raw.subarray(0, -1)); offset = start + padded; continue;
      }
      const type = ({ 0: 'file', 48: 'file', 53: 'directory', 50: 'symlink', 49: 'hardlink' })[flag];
      if (!type) blocked('unsupported tar extension or special-file type');
      const base = field(header.subarray(0, 100)), prefix = ustar ? field(header.subarray(345, 500)) : '';
      const name = archiveName(pendingName || (prefix ? `${prefix}/${base}` : base), type); pendingName = null;
      if (names.has(name.toLowerCase()) || names.size >= ENTRY_LIMIT) blocked('duplicate/case-aliased or excessive tar entries');
      names.add(name.toLowerCase());
      const target = field(header.subarray(157, 257));
      if (type === 'file' || type === 'directory') { if (target) blocked('ordinary tar entry declares a link target'); }
      else if (!target || /[\x00-\x1f\x7f]/.test(target)) blocked('invalid tar link target');
      if (type !== 'file' && bytes !== 0) blocked('non-file tar entry contains bytes');
      const digest = createHash('sha256'), md5 = createHash('md5');
      input.chunks(start, bytes, chunk => { digest.update(chunk); md5.update(chunk); });
      if (padded !== bytes && input.read(start + bytes, padded - bytes).some(byte => byte !== 0)) blocked('nonzero tar member padding');
      totalBytes += bytes;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > maximumBytes) blocked('tar content exceeds its budget');
      entries.push({ name, type, mode, uid, gid, uname, gname, mtime, bytes, offset: start,
        ...(type === 'file' ? { sha256: digest.digest('hex'), md5: md5.digest('hex') } : {}),
        ...(target ? { target } : {}) });
      offset = start + padded;
    }
    if (!ended || !entries.length) blocked('tar has no complete nonempty file table');
    return { identity: input.identity, totalBytes, entries };
  }));
}

export function readVerifiedTarEntry(file, archive, name, maximum = 1024 * 1024) {
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 16 * 1024 * 1024) blocked('invalid tar content-read budget');
  return withArchive(file, FILE_LIMIT, input => {
    if (digestRecord(input.identity) !== digestRecord(archive?.identity)) blocked('tar changed before selected content read');
    const entries = archive.entries.filter(entry => entry.name === name && entry.type === 'file');
    if (entries.length !== 1 || entries[0].bytes > maximum) blocked('tar selected content is absent or excessive');
    const entry = entries[0], chunks = [];
    input.chunks(entry.offset, entry.bytes, chunk => chunks.push(chunk));
    const bytes = Buffer.concat(chunks);
    if (hash(bytes) !== entry.sha256) blocked('tar selected content differs from its parsed record');
    return bytes;
  });
}
