import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestRecord, measureFile, plainPath, readBounded } from '../adapters/artifact-files.mjs';

// Reviewed native mechanics. This is a closed system-library set, not permission
// for a caller to declare a new executable, addon, loader path or search policy.
const ROOT = '/usr/lib/x86_64-linux-gnu';
const SYSTEM = Object.freeze(Object.fromEntries(Object.entries({
  loader: ['ld-linux-x86-64.so.2', 'c20a2dc8917c755f02b94049356320fe1f62ac7d9f8994731f807d9df39302da'],
  libc: ['libc.so.6', '3a15d66867d83762c7f2f1e37359cb8f6c5743edb369c65285cb0b1c4f7498bf'],
  libm: ['libm.so.6', 'fce00b6f25f459cf4ae0b7fae4257909a1a8a86f9149e7c029a5d617baf1ccd0'],
  zlib: ['libz.so.1.3', '86200da370f20476a2507e9097a789b5ef97269b4ca8d5e164ad82dab9d99892'],
  // Ubuntu libexpat1 2.6.1-2ubuntu0.5; installed ELF matches the archive package.
  expat: ['libexpat.so.1.9.1', 'ec6c12d33bb8f9d0e90804121adf19930f36b1b2a4aeb6e1a454b89c7a50c801'],
  ffi: ['libffi.so.8.1.4', '00f593fe192f2851b8ce23b25cec2488d769beb5a8f63e8c9e563071e1075153'],
  stdcpp: ['libstdc++.so.6.0.33', '1fd75fe70354a416d75aef22bcae68c47bd25d20e2d0568c30b1a9838cf62f11'],
  gcc: ['libgcc_s.so.1', 'd93224d2b0dab4247598be683adca02f5cf00586f99c187579cd7e92058fb7cb'],
  dl: ['libdl.so.2', 'c2994527172cc23b7fb0f7d611b71e00a37da27af12c2e5e9e0dc1a742886c96'],
  pthread: ['libpthread.so.0', '90491a21ce44efcf3bd4b65ec82501c091d7ebe7f8d9b341dd01d721001d9ecd'],
  rt: ['librt.so.1', '6d072187d88e092e81561a44c03a4a41397319022c6d43519757cc051c576d82'],
  pcre: ['libpcre2-8.so.0.11.2', 'e00576d71d81d3ba0cfa4903c835a44a8723aac96f72f79ff75200b4cff9071b'],
  lzma: ['liblzma.so.5.4.5', '696e868dd0700a19a6d65fc01608ec2d70d3cb91f65710e89180cd2e688f30cb'],
}).map(([role, [name, sha256]]) => [role, Object.freeze({ path: path.join(ROOT, name), sha256 })])));
const PROFILES = Object.freeze({ owner: Object.freeze(['loader', 'libc', 'libm', 'zlib', 'expat', 'ffi', 'stdcpp', 'gcc', 'dl', 'pthread', 'rt']),
  git: Object.freeze(['loader', 'pcre', 'zlib', 'libc']), xz: Object.freeze(['loader', 'lzma', 'libc']) });
const LINKS = Object.freeze({
  '/lib': 'usr/lib', '/lib64': 'usr/lib64',
  '/usr/lib64/ld-linux-x86-64.so.2': '../lib/x86_64-linux-gnu/ld-linux-x86-64.so.2',
  [`${ROOT}/libstdc++.so.6`]: 'libstdc++.so.6.0.33', [`${ROOT}/libz.so.1`]: 'libz.so.1.3',
  [`${ROOT}/libexpat.so.1`]: 'libexpat.so.1.9.1', [`${ROOT}/libffi.so.8`]: 'libffi.so.8.1.4',
});
const CACHE = '/etc/ld.so.cache';
const CACHE_SHA256 = '56a9b2fd2f1de4bf9888094f80ee0930cbe84408bd471a6969d4b99528d9485e';
// These non-executable data maps are actual inputs to the fixed C.UTF-8
// environment. Keep them separate from the ELF graph and do not silently
// discard them when checking the native owner's observed mappings.
const RUNTIME_DATA = Object.freeze({
  gconv: Object.freeze({ path: `${ROOT}/gconv/gconv-modules.cache`, sha256: '52c227df9d53248238602c1ddaccd2c8ddc4cc6a61aa45d7c425af590b8806a5' }),
  ctype: Object.freeze({ path: '/usr/lib/locale/C.utf8/LC_CTYPE', sha256: '59015993b1b671273461ef1167d7a9ad76dc090d521c91102e962217ed6b6dba' }),
  locale: Object.freeze({ path: '/usr/lib/locale/locale-archive', sha256: 'f26d61a395e4800cfc165f120af1de6341512b2a3e31c616001b19bc3902bb29' }),
});
const MODULE = fileURLToPath(import.meta.url);
const POLICY = Object.freeze(measureFile(MODULE));
const FIELDS = ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
const same = (left, right) => FIELDS.every(key => left[key] === right[key]);
const generation = stat => Object.fromEntries(FIELDS.map(key => [key, String(stat[key])]));
const fail = message => { throw new Error(`Linux ELF qualification blocked: ${message}`); };
const frozen = value => { if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); } return value; };
function nativeOwner() {
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.getuid?.() === 0 || process.geteuid?.() === 0)
    fail('requires the ordinary Linux x64 owner');
}
function protectedInput(file, link = false) {
  const stat = fs.lstatSync(file, { bigint: true });
  if (stat.uid !== 0n || stat.gid !== 0n || (!link && stat.mode & 0o022n)) fail('system resolver input is writable outside root');
  return stat;
}
function absent(file) {
  try { fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  fail(`unregistered loader input exists: ${file}`);
}

// Read only bounded ELF headers/dynamic strings from one generation-bound FD.
// The Node image is large: parsing must not copy the entire executable into RAM.
// No readelf/ldd process, caller metadata or loader output supplies this result.
export function inspectLinuxElf(file, expected) {
  nativeOwner();
  file = plainPath(file, { kind: 'file', systemFile: true });
  const before = fs.lstatSync(file, { bigint: true });
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const safe = value => { const number = Number(value); if (!Number.isSafeInteger(number) || number < 0) fail('invalid ELF offset'); return number; };
  const size = safe(before.size);
  let readBytes = 0;
  const read = (offset, count) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(count) || offset < 0 || count < 0 || offset + count > size
        || (readBytes += count) > 9 * 1024 * 1024) fail('ELF parsing exceeds its byte bounds');
    const value = Buffer.alloc(count);
    let done = 0;
    while (done < count) { const n = fs.readSync(fd, value, done, count - done, offset + done); if (!n) fail('ELF input was truncated'); done += n; }
    return value;
  };
  try {
    if (!same(before, fs.fstatSync(fd, { bigint: true }))) fail('ELF descriptor generation changed');
    const identity = { path: file, ...measureFile(file, { systemFile: true, allowEmpty: false }) };
    if (expected && digestRecord(identity) !== digestRecord(expected)) fail('ELF bytes differ from measured input');
    const header = read(0, 64);
    if (!header.subarray(0, 7).equals(Buffer.from([127, 69, 76, 70, 2, 1, 1])) ||
        ![2, 3].includes(header.readUInt16LE(16)) || header.readUInt16LE(18) !== 62 ||
        header.readUInt32LE(20) !== 1 || header.readUInt16LE(52) !== 64 || header.readUInt16LE(54) !== 56)
      fail('requires a supported Linux x64 ELF64 image');
    const count = header.readUInt16LE(56), offset = safe(header.readBigUInt64LE(32));
    if (count < 1 || count > 128) fail('unsupported ELF program-header count');
    const headers = read(offset, count * 56), loads = [], dynamics = [], interpreters = [];
    for (let n = 0; n < count; n++) {
      const at = n * 56, type = headers.readUInt32LE(at);
      const segment = { offset: safe(headers.readBigUInt64LE(at + 8)), address: safe(headers.readBigUInt64LE(at + 16)),
        bytes: safe(headers.readBigUInt64LE(at + 32)) };
      if (segment.offset + segment.bytes > size) fail('ELF segment leaves its file');
      if (type === 1) loads.push(segment);
      if (type === 2) dynamics.push(segment);
      if (type === 3) interpreters.push(segment);
    }
    if (dynamics.length !== 1 || interpreters.length > 1) fail('unsupported ELF dynamic/interpreter layout');
    let interpreter = null;
    if (interpreters.length) {
      const part = interpreters[0];
      if (part.bytes < 2 || part.bytes > 256) fail('invalid ELF interpreter');
      const bytes = read(part.offset, part.bytes);
      if (bytes.at(-1) !== 0 || bytes.subarray(0, -1).includes(0)) fail('invalid ELF interpreter string');
      interpreter = bytes.subarray(0, -1).toString('utf8');
      if (interpreter !== '/lib64/ld-linux-x86-64.so.2') fail('unregistered kernel ELF interpreter');
    }
    const part = dynamics[0];
    if (!part.bytes || part.bytes > 65536 || part.bytes % 16) fail('invalid ELF dynamic table');
    const dynamic = read(part.offset, part.bytes), values = new Map(), needed = [];
    let terminated = false;
    for (let at = 0; at < dynamic.length; at += 16) {
      const tag = safe(dynamic.readBigUInt64LE(at)), value = safe(dynamic.readBigUInt64LE(at + 8));
      if (tag === 0) { terminated = true; break; }
      if ([15, 29, 0x6ffffefb, 0x6ffffefc, 0x7ffffffd, 0x7fffffff].includes(tag)) fail('ELF search paths, filters and audit modules are unsupported');
      if (tag === 1) { if (needed.length >= 128) fail('too many ELF dependencies'); needed.push(value); }
      if ([5, 10, 14].includes(tag)) { if (values.has(tag)) fail('duplicate ELF dynamic declaration'); values.set(tag, value); }
    }
    if (!terminated || !values.has(5) || !values.has(10) || values.get(10) < 1 || values.get(10) > 8 * 1024 * 1024)
      fail('ELF string table is missing or unbounded');
    const address = values.get(5), length = values.get(10);
    const mapped = loads.filter(segment => address >= segment.address && address + length <= segment.address + segment.bytes);
    if (mapped.length !== 1) fail('ELF string table has ambiguous file mapping');
    const strings = read(mapped[0].offset + address - mapped[0].address, length);
    const name = index => {
      const end = strings.indexOf(0, index);
      if (index < 0 || index >= strings.length || end < index || end - index > 256) fail('invalid ELF library string');
      const value = strings.subarray(index, end).toString('utf8');
      if (!/^[A-Za-z0-9_.+-]+$/.test(value)) fail('ELF library names must be closed SONAMEs');
      return value;
    };
    const dependencies = needed.map(name);
    if (new Set(dependencies).size !== dependencies.length) fail('duplicate ELF dependency');
    if (!same(before, fs.fstatSync(fd, { bigint: true })) || !same(before, fs.lstatSync(file, { bigint: true }))) fail('ELF changed while parsing');
    return frozen({ ...identity, interpreter, needed: dependencies, soname: values.has(14) ? name(values.get(14)) : null });
  } finally { fs.closeSync(fd); }
}

export function assertLinuxSystemElfIdentity(role, measured) {
  if (arguments.length !== 2 || !Object.hasOwn(SYSTEM, role) || measured?.path !== SYSTEM[role].path ||
      measured.sha256 !== SYSTEM[role].sha256 || !Number.isSafeInteger(measured.bytes) || measured.bytes <= 0)
    fail('unapproved system library identity');
}

export function linuxElfClosure(roots, libraries) {
  const byName = new Map();
  for (const [role, library] of Object.entries(libraries)) {
    if (!library.soname || byName.has(library.soname)) fail('system library SONAMEs are missing or ambiguous');
    byName.set(library.soname, [role, library]);
  }
  const selected = new Set();
  const visit = image => {
    if (!Array.isArray(image?.needed)) fail('ELF dependency declaration is missing');
    for (const name of image.needed) {
      const input = byName.get(name);
      if (!input) fail(`unresolved ELF dependency: ${name}`);
      if (!selected.has(input[0])) { selected.add(input[0]); visit(input[1]); }
    }
    if (image.interpreter !== null && image.interpreter !== '/lib64/ld-linux-x86-64.so.2') fail('unsupported ELF interpreter');
    if (image.interpreter) {
      const loader = byName.get('ld-linux-x86-64.so.2');
      if (!loader) fail('ELF interpreter is unresolved');
      selected.add(loader[0]);
    }
  };
  roots.forEach(visit);
  return [...selected].sort();
}

function resolver(inputs) {
  const nodes = {};
  for (const file of ['/etc', '/usr', '/usr/lib', '/usr/lib64', ROOT, `${ROOT}/gconv`, '/usr/lib/locale', '/usr/lib/locale/C.utf8']) {
    plainPath(file, { kind: 'directory' });
    nodes[file] = { kind: 'directory', generation: generation(protectedInput(file)) };
  }
  for (const [file, target] of Object.entries(LINKS)) {
    const stat = protectedInput(file, true);
    if (!stat.isSymbolicLink() || fs.readlinkSync(file) !== target) fail('kernel/library resolver link changed');
    nodes[file] = { kind: 'link', target, generation: generation(stat) };
  }
  const absentInputs = ['/etc/ld.so.preload', `${ROOT}/glibc-hwcaps`, '/usr/lib/glibc-hwcaps', '/usr/lib64/glibc-hwcaps'];
  absentInputs.forEach(absent);
  protectedInput(CACHE);
  const cache = { path: CACHE, ...measureFile(CACHE, { allowEmpty: false }) };
  if (cache.sha256 !== CACHE_SHA256) fail('reviewed system loader cache changed');
  const bytes = readBounded(CACHE, 1024 * 1024);
  if (bytes.length !== cache.bytes || bytes.subarray(0, 20).toString('ascii') !== 'glibc-ld.so.cache1.1') fail('unsupported system loader cache');
  const count = bytes.readUInt32LE(20);
  if (count > 16384 || 48 + count * 24 > bytes.length) fail('unbounded system loader cache');
  const string = offset => {
    const end = bytes.indexOf(0, offset);
    if (offset < 48 + count * 24 || end < offset || end - offset > 4096) fail('invalid loader cache string');
    return bytes.subarray(offset, end).toString('utf8');
  };
  const candidates = new Map();
  for (let n = 0; n < count; n++) {
    const at = 48 + n * 24;
    if (bytes.readUInt32LE(at) !== 0x303) continue; // The reviewed native x86-64 ABI.
    const name = string(bytes.readUInt32LE(at + 4));
    if (!Object.values(inputs).some(input => input.soname === name)) continue;
    if (candidates.has(name) || bytes.readUInt32LE(at + 12) !== 0 || bytes.readBigUInt64LE(at + 16) !== 0n)
      fail('conditional or ambiguous native loader cache resolution');
    candidates.set(name, string(bytes.readUInt32LE(at + 8)));
  }
  const resolutions = {};
  for (const input of Object.values(inputs)) {
    const selected = candidates.get(input.soname);
    if (!selected || selected !== `/lib/x86_64-linux-gnu/${input.soname}` || fs.realpathSync(selected) !== input.path)
      fail('loader cache does not resolve the exact reviewed library');
    resolutions[input.soname] = selected;
  }
  return { cache, nodes, absentInputs, resolutions };
}

export function measureLinuxSystemElf(profile) {
  nativeOwner();
  if (arguments.length !== 1 || !Object.hasOwn(PROFILES, profile)) fail('unregistered ELF profile');
  if (digestRecord(measureFile(MODULE)) !== digestRecord(POLICY)) fail('loaded ELF policy changed');
  absent('/etc/ld.so.preload');
  const inputs = {}, images = {};
  for (const role of PROFILES[profile]) {
    const file = SYSTEM[role].path;
    for (let ancestor = file; ancestor !== '/'; ancestor = path.dirname(ancestor)) protectedInput(ancestor);
    const image = inspectLinuxElf(file);
    const input = { path: file, bytes: image.bytes, sha256: image.sha256 };
    assertLinuxSystemElfIdentity(role, input);
    inputs[role] = input; images[role] = image;
  }
  linuxElfClosure(Object.values(images), images);
  const runtimeData = profile === 'owner' ? Object.fromEntries(Object.entries(RUNTIME_DATA).map(([role, expected]) => {
    const input = { path: expected.path, ...measureFile(expected.path, { systemFile: true, allowEmpty: false }) };
    protectedInput(expected.path);
    if (input.sha256 !== expected.sha256) fail('reviewed locale/conversion input changed');
    return [role, input];
  })) : null;
  return frozen({ policy: POLICY, inputs, images, ...(profile === 'owner' ? { resolver: resolver(images), runtimeData } : {}) });
}
