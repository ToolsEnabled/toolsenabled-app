import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestRecord, measureFile, plainPath, FILE_LIMIT } from '../adapters/artifact-files.mjs';
import { linuxToolEnvironment } from './linux-toolchain.mjs';
import { inspectLinuxElf, linuxElfClosure, measureLinuxSystemElf, assertLinuxSystemElfIdentity } from './linux-elf-inputs.mjs';

export const LINUX_XZ = '/usr/bin/xz';
export const MAX_XZ_OUTPUT_BYTES = FILE_LIMIT;
const XZ_SHA256 = 'b5b163eb273291934556377ab883b4b2a5d4da50bd0dc0a91774ecc234ccd8d0';
const MODULE = fileURLToPath(import.meta.url);
const POLICY = Object.freeze(measureFile(MODULE));
const refuse = message => { throw new Error(`Linux qualification XZ blocked: ${message}`); };
const ARGS = Object.freeze(['--decompress', '--stdout', '--format=xz', '--memlimit-decompress=256MiB', '--threads=1', '--']);

export function assertLinuxXzInput(role, measured) {
  if (arguments.length === 2 && ['loader', 'lzma', 'libc'].includes(role)) return assertLinuxSystemElfIdentity(role, measured);
  if (arguments.length !== 2 || role !== 'xz' || measured?.path !== LINUX_XZ || measured.sha256 !== XZ_SHA256 ||
      !Number.isSafeInteger(measured.bytes) || measured.bytes <= 0) refuse('unapproved decoder executable or library');
}

export function measureLinuxXzToolchain() {
  if (arguments.length || process.platform !== 'linux' || process.arch !== 'x64' || process.getuid?.() === 0 || process.geteuid?.() === 0)
    refuse('requires the ordinary Linux x64 owner and accepts no overrides');
  if (digestRecord(measureFile(MODULE)) !== digestRecord(POLICY)) refuse('loaded decoder policy changed');
  plainPath(LINUX_XZ, { kind: 'file' });
  for (let file = LINUX_XZ; file !== '/'; file = path.dirname(file)) {
    const stat = fs.lstatSync(file);
    if (stat.uid !== 0 || stat.gid !== 0 || stat.mode & 0o022) refuse('decoder input is writable outside root');
  }
  const xz = Object.freeze({ path: LINUX_XZ, ...measureFile(LINUX_XZ, { systemFile: true, allowEmpty: false }) });
  assertLinuxXzInput('xz', xz);
  const system = measureLinuxSystemElf('xz'), libraries = linuxElfClosure([inspectLinuxElf(LINUX_XZ, xz)], system.images);
  return Object.freeze({ policy: POLICY, systemPolicy: system.policy, libraries: Object.freeze(libraries),
    inputs: Object.freeze({ loader: system.inputs.loader, xz, lzma: system.inputs.lzma, libc: system.inputs.libc }) });
}

export function linuxXzArguments(input) { return [...ARGS, input]; }

export function assertLinuxXzArguments(args, cwd) {
  if (!Array.isArray(args) || args.length !== ARGS.length + 1 || ARGS.some((value, i) => args[i] !== value)) refuse('only fixed bounded XZ decoding is registered');
  cwd = plainPath(cwd, { kind: 'directory' });
  const stat = fs.lstatSync(cwd);
  if (stat.uid !== process.getuid() || stat.mode & 0o077) refuse('compressed input requires private owning-account scratch');
  const file = plainPath(args.at(-1), { kind: 'file' });
  if (path.dirname(file) !== cwd || !['control.tar.xz', 'data.tar.xz'].includes(path.basename(file))) refuse('compressed input is outside the fixed private Debian members');
  return Object.freeze({ path: file, ...measureFile(file, { maximum: FILE_LIMIT, allowEmpty: false }) });
}

export function linuxXzEnvironment(extra = {}) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra) || Object.keys(extra).length) refuse('decoding accepts no environment overrides');
  return { ...linuxToolEnvironment(), PATH: '/nonexistent', HOME: '/nonexistent', LANG: 'C', LC_ALL: 'C' };
}

export function linuxXzDescriptorArguments(args) {
  if (!Array.isArray(args) || args.length !== ARGS.length + 1 || ARGS.some((value, i) => args[i] !== value)) refuse('only fixed bounded XZ decoding is registered');
  // FD5 loader, 6 XZ, 7/8 its complete library closure, 9 the captured input.
  // No archive or environment filename chooses an executable or library.
  return ['--inhibit-cache', '--glibc-hwcaps-mask', '', '--library-path', '/nonexistent',
    '--preload', '/proc/self/fd/7:/proc/self/fd/8', '--argv0', LINUX_XZ, '/proc/self/fd/6',
    ...ARGS, '/proc/self/fd/9'];
}
