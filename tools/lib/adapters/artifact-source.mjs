import fs from 'node:fs';
import { readSourceMetadata } from './artifact-source-inputs.mjs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runOwnedJob } from '../transport/owned-job.mjs';
import { LINUX_GIT, GIT_SOURCE_OPTIONS, measureLinuxGitToolchain } from '../transport/linux-git-toolchain.mjs';
import { blocked, DEV_PROFILE, DEV_TEMP, NATIVE_PATH_ROOT, plainPath, contains, relativeName, readBounded, measureFile, digestRecord, ENTRY_LIMIT } from './artifact-files.mjs';

const GIT = 'C:\\Program Files\\Git\\cmd\\git.exe';
const GIT_SHA256 = 'fec691d80fccc35fcc309fbc9f720536c1d795b8a562ec169f28c9923da9600f';
const REF = /^[a-f0-9]{40}$/;

export function sourceGitToolPath() {
  if (arguments.length) blocked('fixed source Git path accepts no caller inputs');
  return GIT;
}

// Comparison only: execution admission below still measures the actual fixed
// file. The prerequisite diagnostic reuses this policy without copying hashes.
export function assertSourceGitToolIdentity(measured) {
  if (arguments.length !== 1 || measured?.path !== GIT || !Number.isSafeInteger(measured.bytes)
      || measured.bytes <= 0 || measured.sha256 !== GIT_SHA256) blocked('fixed read-only Git executable changed');
}

export function verifyGitToolIdentity() {
  const identity = measureFile(GIT, { systemFile: true });
  assertSourceGitToolIdentity({ path: GIT, ...identity });
  return identity;
}

export function measurementEnvironment() {
  // Do not inherit HOME/config/provider destinations or Git command overrides.
  return { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    PATH: 'C:\\Windows\\System32;C:\\Windows', TEMP: DEV_TEMP, TMP: DEV_TEMP,
    USERPROFILE: DEV_PROFILE, APPDATA: `${DEV_PROFILE}\\AppData\\Roaming`, LOCALAPPDATA: `${DEV_PROFILE}\\AppData\\Local`,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0', GIT_PAGER: '', PAGER: '' };
}

const repositoryMetadata = root => readSourceMetadata(root).filters;

function windowsGit(root, filterOptions, args) {
    try {
      return execFileSync(GIT, ['--no-replace-objects', '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false',
        '-c', 'core.untrackedCache=false', '-c', 'core.pager=', '-c', 'diff.external=', '-c', 'core.attributesFile=NUL',
        '-c', 'core.excludesFile=NUL', '-c', 'core.ignoreStat=false', '-c', 'core.trustctime=true',
        ...filterOptions, `--work-tree=${root}`, '-C', root, ...args], {
        env: measurementEnvironment(), windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024,
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      if (error.signal || error.status === null || ['ETIMEDOUT', 'ENOBUFS'].includes(error.code)) error.terminationConfirmed = false;
      throw error;
    }
  }

function* sourceSnapshotSteps(root, expectedRef) {
  if (!REF.test(expectedRef || '')) blocked('source must name an exact lowercase commit');
  if ((yield ['rev-parse', '--verify', 'HEAD^{commit}']).trim() !== expectedRef) blocked('source checkout is not at the exact candidate commit');
  const indexText = (yield ['ls-files', '-v', '-z']);
  const index = indexText.split('\0').filter(Boolean);
  if (!index.length || index.length > ENTRY_LIMIT) blocked('source tracked-file selection is empty/excessive');
  const files = {}, names = new Set();
  const committed = new Map((yield ['ls-tree', '-r', '--full-tree', '-z', expectedRef]).split('\0').filter(Boolean).map(line => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)$/.exec(line);
    if (!match) blocked('source commit includes a link/submodule or unsupported object');
    return [relativeName(match[3]), match[2]];
  }));
  if (committed.size !== index.length) blocked('source index selection differs from its exact commit');
  for (const line of index.sort()) {
    if (!line.startsWith('H ')) blocked('source index hides or excludes tracked input changes');
    const name = relativeName(line.slice(2));
    if (names.has(name.toLowerCase())) blocked('duplicate/case-aliased tracked source entry');
    names.add(name.toLowerCase());
    const file = path.join(root, name), measured = measureFile(file, { gitBlob: true });
    if (measured.gitBlobSha1 !== committed.get(name)) {
      // Ordinary CRLF checkouts may differ from LF Git blobs. Verify that exact
      // reversible text transformation, not the mutable index stat cache.
      const content = readBounded(file, 64 * 1024 * 1024);
      if (content.includes(0)) blocked('source bytes differ from the exact commit');
      const normalized = Buffer.from(content.toString('latin1').replaceAll('\r\n', '\n'), 'latin1');
      const blob = createHash('sha1').update(`blob ${normalized.length}\0`).update(normalized).digest('hex');
      if (blob !== committed.get(name)) blocked('source bytes differ from the exact commit (dirty source)');
    }
    files[name] = { sha256: measured.sha256, bytes: measured.bytes };
  }
  // Status now runs only after every tracked path has been fenced and matched
  // against commit content. Git does not follow working-tree .gitignore links:
  // https://git-scm.com/docs/gitignore#_notes . External ignore/attribute files
  // and submodule traversal are explicitly disabled above/below.
  if ((yield ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=all']).trim()) blocked('source/harness checkout is dirty');
  if ((yield ['rev-parse', '--verify', 'HEAD^{commit}']).trim() !== expectedRef || (yield ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=all']).trim() ||
      (yield ['ls-files', '-v', '-z']) !== indexText) blocked('source checkout changed during measurement');
  // Native queries await process/cleanup/tool measurements. Recheck actual
  // input bytes after the last query; a clean Git/index result cannot witness
  // a later write while that execution's receipt is being finalized.
  for (const [name, measured] of Object.entries(files)) {
    if (digestRecord(measureFile(path.join(root, name))) !== digestRecord(measured))
      blocked('source file bytes changed during measurement');
  }
  return { ref: expectedRef, clean: true, sha256: digestRecord(files), files };
}

export function cleanSourceSnapshot(root, expectedRef) {
  if (!REF.test(expectedRef || '')) blocked('source must name an exact lowercase commit');
  verifyGitToolIdentity();
  const filters = repositoryMetadata(root), steps = sourceSnapshotSteps(root, expectedRef);
  let step = steps.next();
  while (!step.done) step = steps.next(windowsGit(root, filters, step.value));
  verifyGitToolIdentity();
  return step.value;
}

function nativeSourceOptions(options) {
  if (!options || Object.keys(options).some(key => !['target', 'evidenceRoot', 'signal'].includes(key)) ||
      Object.keys(options.target || {}).sort().join(',') !== 'arch,platform' ||
      options.target.platform !== 'linux' || options.target.arch !== 'x64')
    blocked('native source measurement requires the explicit registered Linux x64 target');
  return options;
}
async function nativeGit(root, filters, args, options, records) {
  const record = await runOwnedJob({ command: LINUX_GIT,
    args: [...GIT_SOURCE_OPTIONS, ...filters, `--work-tree=${root}`, '-C', root, ...args],
    cwd: root, evidenceRoot: options.evidenceRoot, signal: options.signal,
    timeoutMs: 30000, maxOutputBytes: 16 * 1024 * 1024 });
  records.push(record);
  if (!record.complete || record.exitCode !== 0 || !record.cleanupConfirmed || record.hadRemainingChildren !== false) {
    const error = new Error('Artifact qualification blocked: native Git source query did not complete cleanly');
    error.code = 'ARTIFACT_QUALIFICATION_BLOCKED'; error.terminationConfirmed = record.cleanupConfirmed;
    error.records = records; throw error;
  }
  const bytes = readBounded(record.stdout.path, 16 * 1024 * 1024);
  if (bytes.length !== record.stdout.bytes || createHash('sha256').update(bytes).digest('hex') !== record.stdout.sha256)
    blocked('native Git output changed after execution');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
export async function nativeCleanSourceSnapshot(root, expectedRef, input) {
  const options = nativeSourceOptions(input);
  if (!REF.test(expectedRef || '')) blocked('source must name an exact lowercase commit');
  root = plainPath(root, { kind: 'directory' });
  const toolchain = measureLinuxGitToolchain(), filters = repositoryMetadata(root), records = [];
  const steps = sourceSnapshotSteps(root, expectedRef);
  let step = steps.next();
  while (!step.done) step = steps.next(await nativeGit(root, filters, step.value, options, records));
  if (digestRecord(measureLinuxGitToolchain()) !== digestRecord(toolchain)) blocked('native source tools changed');
  return { ...step.value, nativeExecution: { toolchain, records } };
}
export async function nativeSourceHead(root, input) {
  const options = nativeSourceOptions(input);
  root = plainPath(root, { kind: 'directory' });
  const toolchain = measureLinuxGitToolchain(), filters = repositoryMetadata(root), records = [];
  const ref = (await nativeGit(root, filters, ['rev-parse', '--verify', 'HEAD^{commit}'], options, records)).trim();
  if (!REF.test(ref)) blocked('harness/source HEAD is unresolved');
  if (digestRecord(measureLinuxGitToolchain()) !== digestRecord(toolchain)) blocked('native source tools changed');
  return { ref, nativeExecution: { toolchain, records } };
}

export function sourceHead(root) {
  verifyGitToolIdentity();
  const filters = repositoryMetadata(root);
  let ref;
  try {
    ref = execFileSync(GIT, ['--no-replace-objects', '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'core.pager=',
      '-c', 'core.attributesFile=NUL', '-c', 'core.excludesFile=NUL', ...filters, `--work-tree=${root}`, '-C', root, 'rev-parse', '--verify', 'HEAD^{commit}'], {
      env: measurementEnvironment(), windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    if (error.signal || error.status === null || ['ETIMEDOUT', 'ENOBUFS'].includes(error.code)) error.terminationConfirmed = false;
    throw error;
  }
  if (!REF.test(ref)) blocked('harness/source HEAD is unresolved');
  verifyGitToolIdentity();
  return ref;
}

// Discover from the actual executing file, never a receipt's claimed verifier
// path. The nearest marker owns the lookup: malformed/foreign metadata refuses
// instead of falling back to some enclosing repository or inherited Git state.
export function sourceRepositoryRoot(file) {
  file = plainPath(file, { kind: 'file' });
  let directory = path.dirname(file);
  for (let depth = 0; depth < 64 && contains(NATIVE_PATH_ROOT, directory); depth++) {
    directory = plainPath(directory, { kind: 'directory' });
    const marker = plainPath(path.join(directory, '.git'), { missingLeaf: true });
    if (fs.existsSync(marker)) {
      repositoryMetadata(directory);
      return directory;
    }
    if (directory.toLowerCase() === NATIVE_PATH_ROOT.toLowerCase()) break;
    directory = path.dirname(directory);
  }
  blocked('executing artifact implementation has no fenced Git repository');
}
