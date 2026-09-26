import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestRecord, measureFile, plainPath } from '../adapters/artifact-files.mjs';
import { readSourceMetadata } from '../adapters/artifact-source-inputs.mjs';
import { linuxToolEnvironment } from './linux-toolchain.mjs';
import { assertLinuxSystemElfIdentity, inspectLinuxElf, linuxElfClosure, measureLinuxSystemElf } from './linux-elf-inputs.mjs';

// Native mechanics, not product/release policy. These reviewed Ubuntu 24.04
// Git/ELF bytes implement only the shared source reader's builtin commands.
// Execute the loader, Git and every DT_NEEDED library through retained FDs;
// neither ldd output, a loader cache nor a caller PATH is an identity proof.
const INPUTS = Object.freeze(Object.fromEntries(Object.entries({
  git: ['/usr/bin/git', '2a8c18fbf43da9f692d75474c72bea9dfd796c260b0f3dfe456376abc3bbd668'],
}).map(([role, [file, sha256]]) => [role, Object.freeze({ path: file, sha256 })])));
const MODULE = fileURLToPath(import.meta.url);
const LOADED_POLICY = Object.freeze(measureFile(MODULE));
const refuse = message => { throw new Error(`Linux qualification Git blocked: ${message}`); };
export const LINUX_GIT = INPUTS.git.path;

export function assertLinuxGitInput(role, measured) {
  if (arguments.length === 2 && ['loader', 'pcre', 'zlib', 'libc'].includes(role)) {
    try { return assertLinuxSystemElfIdentity(role, measured); }
    catch { refuse('unapproved executable or dynamic dependency identity'); }
  }
  if (arguments.length !== 2 || !Object.hasOwn(INPUTS, role) || measured?.path !== INPUTS[role].path ||
      measured.sha256 !== INPUTS[role].sha256 || !Number.isSafeInteger(measured.bytes) || measured.bytes <= 0)
    refuse('unapproved executable or dynamic dependency identity');
}
export function measureLinuxGitToolchain() {
  if (arguments.length || process.platform !== 'linux' || process.arch !== 'x64' || process.getuid?.() === 0 || process.geteuid?.() === 0)
    refuse('requires the ordinary Linux x64 owner and accepts no overrides');
  if (digestRecord(measureFile(MODULE)) !== digestRecord(LOADED_POLICY)) refuse('loaded native Git policy changed');
  // The loader consults this file even with cache/search options disabled.
  // Any entry, including a dangling link or empty file, needs explicit review.
  try { fs.lstatSync('/etc/ld.so.preload'); refuse('system loader preloads are not registered'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const gitInputs = Object.fromEntries(Object.entries(INPUTS).map(([role, input]) => {
    plainPath(input.path, { kind: 'file' });
    for (let file = input.path; file !== '/'; file = path.dirname(file)) {
      const stat = fs.lstatSync(file);
      if (stat.uid !== 0 || stat.gid !== 0 || stat.mode & 0o022) refuse('system Git input is writable outside root');
    }
    const measured = Object.freeze({ path: input.path, ...measureFile(input.path, { systemFile: true, allowEmpty: false }) });
    assertLinuxGitInput(role, measured);
    return [role, measured];
  }));
  const system = measureLinuxSystemElf('git');
  const git = inspectLinuxElf(gitInputs.git.path, gitInputs.git);
  const libraries = linuxElfClosure([git], system.images);
  // Preserve the already reviewed descriptor positions used by Git execution.
  const inputs = { loader: system.inputs.loader, git: gitInputs.git, pcre: system.inputs.pcre,
    zlib: system.inputs.zlib, libc: system.inputs.libc };
  return Object.freeze({ policy: LOADED_POLICY, systemPolicy: system.policy, libraries: Object.freeze(libraries), inputs: Object.freeze(inputs) });
}

export const GIT_SOURCE_OPTIONS = Object.freeze(['--no-replace-objects',
  '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
  '-c', 'core.pager=', '-c', 'diff.external=', '-c', 'core.attributesFile=/dev/null',
  '-c', 'core.excludesFile=/dev/null', '-c', 'core.ignoreStat=false', '-c', 'core.trustctime=true']);

export function assertLinuxGitArguments(args, cwd) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) refuse('invalid source command');
  if (args.length === 1 && args[0] === '--version') return null;
  const metadata = readSourceMetadata(cwd);
  let offset = 0;
  for (const expected of GIT_SOURCE_OPTIONS) if (args[offset++] !== expected) refuse('source command configuration changed');
  for (const expected of metadata.filters) if (args[offset++] !== expected) refuse('source command omits or changes required filter neutralization');
  if (args[offset++] !== `--work-tree=${cwd}` || args[offset++] !== '-C' || args[offset++] !== cwd) refuse('source command leaves its working tree');
  const tail = args.slice(offset);
  if (JSON.stringify(tail) === JSON.stringify(['rev-parse', '--verify', 'HEAD^{commit}']) ||
      JSON.stringify(tail) === JSON.stringify(['ls-files', '-v', '-z']) ||
      JSON.stringify(tail) === JSON.stringify(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=all']) ||
      tail.length === 5 && tail.slice(0, 4).join(' ') === 'ls-tree -r --full-tree -z' && /^[a-f0-9]{40}$/.test(tail[4])) return metadata.sha256;
  refuse('only fixed read-only source builtins are registered');
}
export function linuxGitEnvironment(extra = {}) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra) || Object.keys(extra).length) refuse('source commands accept no environment overrides');
  return { ...linuxToolEnvironment(), HOME: '/nonexistent', PATH: '/nonexistent', LANG: 'C', LC_ALL: 'C',
    GIT_EXEC_PATH: '/nonexistent', GIT_CONFIG_SYSTEM: '/dev/null', GIT_NO_LAZY_FETCH: '1' };
}
export function linuxGitDescriptorArguments(args) {
  // FD 5: ELF loader; 6: Git; 7/8/9: its complete reviewed DT_NEEDED closure.
  // SONAMEs in these pinned bytes satisfy every import before any search.
  return ['--inhibit-cache', '--glibc-hwcaps-mask', '', '--library-path', '/nonexistent',
    '--preload', '/proc/self/fd/7:/proc/self/fd/8:/proc/self/fd/9', '--argv0', LINUX_GIT, '/proc/self/fd/6', ...args];
}
