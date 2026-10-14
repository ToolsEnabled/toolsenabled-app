import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { digestRecord, measureFile, plainPath } from '../adapters/artifact-files.mjs';
import { assertLinuxInstalledState } from '../guest/linux-installed-state.mjs';
import { LINUX_MEASUREMENT_ROOT, LINUX_MEASUREMENT_PATHS, LINUX_MEASUREMENT_NODE,
  LINUX_MEASUREMENT_OUTPUT_LIMIT, validateLinuxMeasurementRequest, refuseLinuxMeasurement as refuse } from '../guest/linux-installed-measurement.mjs';

const LIB = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOURCES = Object.freeze({ producer: path.join(LIB, 'guest/linux-installed-measurement.mjs'),
  reader: path.join(LIB, 'guest/linux-installed-state.mjs'), dependency: path.join(LIB, 'adapters/artifact-files.mjs') });
const sourcePins = () => Object.fromEntries(Object.entries(SOURCES).map(([name, file]) => {
  const { sha256, bytes } = measureFile(file); return [name, { sha256, bytes }];
}));
const LOADED_PINS = sourcePins();
const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...names].sort().join(',');
const expectedInputs = () => ({ runtime: { sha256: LINUX_MEASUREMENT_NODE.sha256, bytes: LINUX_MEASUREMENT_NODE.bytes }, ...LOADED_PINS });

function hostClosure(machineRoot, pins) {
  try {
  const root = plainPath(machineRoot, { kind: 'directory' });
  const input = plainPath(path.join(root, 'input'), { kind: 'directory' });
  const admittedDirectory = directory => {
    const stat = fs.lstatSync(plainPath(directory, { kind: 'directory' }));
    if (stat.uid !== process.getuid() || (stat.mode & 0o7022) !== 0) refuse('measurement directory is not exclusively owner-writable');
  };
  admittedDirectory(root); admittedDirectory(input);
  return Object.fromEntries(Object.entries(LINUX_MEASUREMENT_PATHS).map(([name, guestPath]) => {
    const file = plainPath(path.join(input, 'measurement', path.posix.relative(LINUX_MEASUREMENT_ROOT, guestPath)), { kind: 'file' });
    for (let directory = path.dirname(file); directory !== input; directory = path.dirname(directory)) admittedDirectory(directory);
    const stat = fs.lstatSync(file, { bigint: true });
    if (stat.uid !== BigInt(process.getuid()) || stat.size !== BigInt(pins[name].bytes) ||
        (stat.mode & 0o7022n) !== 0n || (name === 'runtime' && (stat.mode & 0o100n) === 0n)) refuse('measurement input ownership/mode/size differs');
    const { sha256, bytes } = measureFile(file, { maximum: pins[name].bytes });
    if (sha256 !== pins[name].sha256 || bytes !== pins[name].bytes) refuse('admitted host measurement input differs');
    return [name, { sha256, bytes, path: file,
      identity: Object.fromEntries(['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(stat[key])])) }];
  }));
  } catch (error) {
    if (error.code === 'LINUX_INSTALLED_MEASUREMENT_REFUSED') throw error;
    refuse('measurement inputs unavailable: ' + (error.code || error.name));
  }
}

const generation = stat => Object.fromEntries(['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs']
  .map(key => [key, String(stat[key])]));
const sameGeneration = (left, right) => digestRecord(generation(left)) === digestRecord(generation(right));

// O_PATH pins an inode without opening a FIFO/device for data. Only after its
// regular-file type is admitted do we obtain a read descriptor for that inode.
// The proc path is our own held descriptor, never a caller-selected process.
function captureStagingSource(file, pin, consume = () => {}) {
  const canonical = plainPath(file, { kind: 'file' });
  if (canonical !== file) refuse('canonical staging source required');
  const ordinary = stat => stat.isFile() && stat.nlink === 1n && stat.size === BigInt(pin.bytes) &&
    [0n, BigInt(process.getuid())].includes(stat.uid);
  const named = fs.lstatSync(file, { bigint: true });
  if (!ordinary(named)) refuse('staging source type, owner, links or length differs');
  const pathFd = fs.openSync(file, 0x200000 | fs.constants.O_NOFOLLOW); // Linux O_PATH
  let readFd;
  try {
    const pinned = fs.fstatSync(pathFd, { bigint: true });
    if (!ordinary(pinned) || !sameGeneration(named, pinned)) refuse('staging source changed before descriptor admission');
    readFd = fs.openSync(`/proc/self/fd/${pathFd}`, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    if (!sameGeneration(pinned, fs.fstatSync(readFd, { bigint: true }))) refuse('staging source read descriptor differs');
    const digest = createHash('sha256'), buffer = Buffer.alloc(65536);
    const deadline = process.hrtime.bigint() + 30_000_000_000n;
    let bytes = 0;
    for (;;) {
      if (process.hrtime.bigint() >= deadline) refuse('staging source capture deadline expired');
      const count = fs.readSync(readFd, buffer, 0, Math.min(buffer.length, pin.bytes + 1 - bytes), null);
      if (!count) break;
      bytes += count;
      if (bytes > pin.bytes) refuse('staging source grew');
      digest.update(buffer.subarray(0, count)); consume(buffer.subarray(0, count));
    }
    const atPath = fs.lstatSync(plainPath(file, { kind: 'file' }), { bigint: true });
    if (bytes !== pin.bytes || digest.digest('hex') !== pin.sha256 ||
        !sameGeneration(pinned, fs.fstatSync(readFd, { bigint: true })) ||
        !sameGeneration(pinned, fs.fstatSync(pathFd, { bigint: true })) || !sameGeneration(pinned, atPath)) refuse('staging source changed during capture');
    return { path: file, ...pin, identity: generation(pinned) };
  } finally { if (readFd !== undefined) fs.closeSync(readFd); fs.closeSync(pathFd); }
}

function stagingBoundary(machineRoot) {
  if (plainPath(machineRoot, { kind: 'directory' }) !== machineRoot) refuse('canonical private machine root required');
  const input = path.join(machineRoot, 'input');
  plainPath(input, { kind: 'directory' });
  const chain = [];
  for (let directory = input;; directory = path.dirname(directory)) {
    const stat = fs.lstatSync(directory, { bigint: true });
    const privatePart = directory === machineRoot || directory === input;
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o7022n) !== 0n ||
        (privatePart ? stat.uid !== BigInt(process.getuid()) : ![0n, BigInt(process.getuid())].includes(stat.uid)) ||
        (directory === machineRoot && (stat.mode & 0o777n) !== 0o700n)) refuse('unsafe staging ancestor ownership or mode');
    chain.push({ path: directory, identity: Object.fromEntries(['dev', 'ino', 'mode', 'uid', 'gid'].map(key => [key, String(stat[key])])) });
    if (directory === path.dirname(directory)) break;
  }
  return chain.reverse();
}

/** Host filesystem preparation only. No guest call, mount or executable runs.
 * Root and the current owner control the admitted directory chain; this does
 * not defend against those same trusted principals concurrently replacing it. */
export function stageLinuxInstalledMeasurementInputs(options) {
  const createdPaths = [];
  try {
    if (process.platform !== 'linux' || process.arch !== 'x64' || process.getuid() === 0 ||
        !keys(options, ['machineRoot', 'nodePath'])) refuse('exact non-root Linux staging inputs required');
    const { machineRoot, nodePath } = options, pins = expectedInputs();
    const boundary = stagingBoundary(machineRoot), input = path.join(machineRoot, 'input');
    const checkBoundary = () => {
      if (digestRecord(stagingBoundary(machineRoot)) !== digestRecord(boundary)) refuse('staging ancestor changed');
    };
    const sources = { runtime: nodePath, ...SOURCES };
    const sourceEvidence = Object.fromEntries(Object.entries(sources).map(([name, file]) => [name, captureStagingSource(file, pins[name])]));
    const folder = path.join(input, 'measurement');
    const files = Object.fromEntries(Object.entries(LINUX_MEASUREMENT_PATHS).map(([name, guestPath]) =>
      [name, path.posix.relative(LINUX_MEASUREMENT_ROOT, guestPath)]));
    const directories = new Set(['']);
    for (const file of Object.values(files)) for (let parent = path.dirname(file); parent !== '.'; parent = path.dirname(parent)) directories.add(parent);
    const directoryNames = [...directories].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    const directoryStat = relative => {
      const file = path.join(folder, relative), stat = fs.lstatSync(plainPath(file, { kind: 'directory' }), { bigint: true });
      if (stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o7777n) !== 0o755n) refuse('staged directory owner or mode differs');
    };
    const inspect = () => {
      checkBoundary();
      for (const directory of directoryNames) {
        directoryStat(directory);
        const expected = [...directoryNames.filter(name => name && path.dirname(name) === (directory || '.')).map(name => path.basename(name)),
          ...Object.values(files).filter(name => path.dirname(name) === (directory || '.')).map(name => path.basename(name))].sort();
        if (JSON.stringify(fs.readdirSync(path.join(folder, directory)).sort()) !== JSON.stringify(expected)) refuse('staged measurement inventory differs');
      }
      for (const [name, relative] of Object.entries(files)) {
        const stat = fs.lstatSync(plainPath(path.join(folder, relative), { kind: 'file' }), { bigint: true });
        if (stat.uid !== BigInt(process.getuid()) || stat.nlink !== 1n ||
            (stat.mode & 0o7777n) !== BigInt(name === 'runtime' ? 0o755 : 0o644)) refuse('staged file owner, links or mode differs');
      }
      const closure = hostClosure(machineRoot, pins); checkBoundary(); return closure;
    };
    let exists;
    try { fs.lstatSync(folder); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; exists = false; }
    if (!exists) {
      for (const directory of directoryNames) {
        checkBoundary();
        if (directory) directoryStat(path.dirname(directory) === '.' ? '' : path.dirname(directory));
        const destination = path.join(folder, directory);
        fs.mkdirSync(destination, { mode: 0o755 }); createdPaths.push({ path: destination, kind: 'directory' });
        // Deliberate output modes also hold under a restrictive caller umask.
        fs.chmodSync(destination, 0o755); directoryStat(directory);
      }
      for (const [name, relative] of Object.entries(files)) {
        checkBoundary(); directoryStat(path.dirname(relative) === '.' ? '' : path.dirname(relative));
        const destination = path.join(folder, relative), mode = name === 'runtime' ? 0o755 : 0o644;
        const fd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        createdPaths.push({ path: destination, kind: 'file' });
        try {
          const captured = captureStagingSource(sources[name], pins[name], chunk => {
            let written = 0;
            while (written < chunk.length) {
              const count = fs.writeSync(fd, chunk, written, chunk.length - written, null);
              if (!Number.isInteger(count) || count <= 0) refuse('staging copy did not progress');
              written += count;
            }
          });
          if (digestRecord(captured) !== digestRecord(sourceEvidence[name])) refuse('staging source generation changed after admission');
          fs.fchmodSync(fd, mode);
          const stat = fs.fstatSync(fd, { bigint: true });
          if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid()) ||
              stat.size !== BigInt(pins[name].bytes) || !sameGeneration(stat, fs.lstatSync(destination, { bigint: true }))) refuse('staged file generation changed');
        } finally { fs.closeSync(fd); }
      }
    }
    const closure = inspect();
    for (const [name, file] of Object.entries(sources)) {
      if (digestRecord(captureStagingSource(file, pins[name])) !== digestRecord(sourceEvidence[name])) refuse('staging source changed after copy');
    }
    checkBoundary();
    return { schema: 'toolsenabled.linux-measurement-input-staging', schemaVersion: 1, proofScope: 'host-staging-only',
      machineRoot, input, created: !exists, reused: exists, createdPaths, sourceInputs: sourceEvidence, stagedInputs: closure, ancestors: boundary,
      guestReadabilityVerified: false, guestExecutionVerified: false, qualified: false, attested: false,
      lifecycleEpoch: { available: false }, cleanupProof: { available: false } };
  } catch (error) {
    // Retain only this call's created-path evidence; never recursively clean up
    // paths which may have been replaced or which belonged to an earlier call.
    error.staging = { complete: false, createdPaths, cleanupAttempted: false, qualified: false, attested: false };
    throw error;
  }
}

export function prepareLinuxInstalledMeasurement(machineRoot, options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some(key => !['subject', 'run', 'phaseId', 'requireVerifiedLifecycleEpoch', 'timeoutSeconds'].includes(key)) ||
      (options.requireVerifiedLifecycleEpoch !== undefined && options.requireVerifiedLifecycleEpoch !== false)) refuse('measurement-only contract required; verified lifecycle epoch unavailable');
  if (!options.subject || typeof options.subject !== 'object' || Array.isArray(options.subject)) refuse('exact expected subject required');
  let subject, run;
  try { subject = structuredClone(options.subject); run = structuredClone(options.run); }
  catch { refuse('serializable subject and run required'); }
  const { phaseId } = options;
  const timeoutSeconds = options.timeoutSeconds ?? 120;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 120) refuse('bounded measurement deadline required');
  const request = { schema: 'toolsenabled.linux-installed-measurement-request', schemaVersion: 1,
    measurementNonce: randomUUID(), requestContext: { subjectSha256: digestRecord(subject), expectedSubject: {
      product: subject?.product, version: subject?.version, target: subject?.target,
      artifact: subject?.artifact && { sha256: subject.artifact.sha256, bytes: subject.artifact.bytes },
      stageSha256: subject?.stageSha256, runtimeSha256: subject?.runtimeSha256,
      sourceSha256: subject?.sourceSha256, sourceRefs: subject?.sourceRefs }, run, phaseId },
    expectedInputs: expectedInputs(), requireVerifiedLifecycleEpoch: false };
  validateLinuxMeasurementRequest(request);
  const started = Date.parse(run.startedAt), now = Date.now();
  if (started > now || now - started > 24 * 60 * 60 * 1000) refuse('future or stale measurement run');
  if (digestRecord(sourcePins()) !== digestRecord(LOADED_PINS)) refuse('selected reader implementation changed after load');
  const hostInputs = hostClosure(machineRoot, request.expectedInputs);
  const argv = [LINUX_MEASUREMENT_PATHS.runtime, LINUX_MEASUREMENT_PATHS.producer, JSON.stringify(request)];
  if (argv.some(value => Buffer.byteLength(value) > 8192) ||
      Buffer.byteLength(JSON.stringify({ argv, method: 'exec', role: 'standard', timeoutSeconds, nonce: randomUUID() })) > 65536) refuse('measurement request exceeds RPC bounds');
  return { request, argv, timeoutSeconds, hostInputs, machineRoot, subject, hostStartedAt: new Date().toISOString() };
}

export function verifyLinuxInstalledMeasurement(response, prepared, identity) {
  const result = response?.result;
  if (!result || result.exitCode !== 0 || result.role !== 'standard' || typeof result.stdout !== 'string' ||
      typeof result.stderr !== 'string' || result.stderr !== '' ||
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > LINUX_MEASUREMENT_OUTPUT_LIMIT) refuse('measurement process failed or output exceeded bounds');
  if (digestRecord(sourcePins()) !== digestRecord(LOADED_PINS) ||
      digestRecord(hostClosure(prepared.machineRoot, prepared.request.expectedInputs)) !== digestRecord(prepared.hostInputs)) refuse('admitted measurement inputs changed around execution');
  let value;
  try { value = JSON.parse(result.stdout); } catch { refuse('measurement output is not complete JSON'); }
  const observed = value?.observed;
  if (!keys(value, ['schema', 'schemaVersion', 'proofScope', 'attested', 'qualified', 'measurementNonce', 'requestDigest', 'requestContext', 'observed', 'lifecycleEpoch']) ||
      value.schema !== 'toolsenabled.linux-installed-measurement' || value.schemaVersion !== 1 ||
      value.proofScope !== 'filesystem-measurement-only' || value.attested !== false || value.qualified !== false ||
      value.measurementNonce !== prepared.request.measurementNonce || value.requestDigest !== digestRecord(prepared.request) ||
      !value.requestContext || !value.lifecycleEpoch ||
      digestRecord(value.requestContext) !== digestRecord(prepared.request.requestContext) ||
      !keys(value.lifecycleEpoch, ['available', 'reason']) || value.lifecycleEpoch.available !== false || typeof value.lifecycleEpoch.reason !== 'string' ||
      !keys(observed, ['root', 'uid', 'processId', 'runtimeVersion', 'startedAt', 'finishedAt', 'inputs', 'installedState']) ||
      observed?.root !== '/' || observed.uid !== identity.native.userUid || !Number.isSafeInteger(observed.processId) || observed.processId < 1 ||
      observed.runtimeVersion !== LINUX_MEASUREMENT_NODE.version) refuse('measurement context, process or unavailable-epoch binding differs');
  const start = Date.parse(observed.startedAt), finish = Date.parse(observed.finishedAt), measured = Date.parse(observed.installedState?.observedAt);
  if (![start, finish, measured].every(Number.isFinite) || finish < start || measured < start || measured > finish) refuse('guest measurement timestamps are internally inconsistent');
  if (!observed.inputs || Object.keys(observed.inputs).sort().join(',') !== Object.keys(LINUX_MEASUREMENT_PATHS).sort().join(',')) refuse('measurement closure is incomplete');
  for (const [name, file] of Object.entries(LINUX_MEASUREMENT_PATHS)) {
    if (observed.inputs[name]?.path !== file || observed.inputs[name].sha256 !== prepared.request.expectedInputs[name].sha256 ||
        observed.inputs[name].bytes !== prepared.request.expectedInputs[name].bytes) refuse('executed measurement closure differs');
  }
  const state = observed.installedState;
  if (state?.root !== '/' || state.attested !== false || state.proofScope !== 'filesystem-measurement-only' ||
      state.package?.version !== prepared.subject.version) refuse('fixed-root package/version observation differs');
  assertLinuxInstalledState(state, prepared.subject);
  return { ...value, transport: { guestId: identity.guestId, nativeIdentitySha256: digestRecord(identity.native),
    responseNonce: response.nonce, role: result.role, exitCode: result.exitCode,
    hostStartedAt: prepared.hostStartedAt, hostFinishedAt: new Date().toISOString(),
    clockAgreement: 'unmeasured; host request times and guest observation times are separate clock domains' },
    expectationScope: 'artifact/source identities remain requested expectations; installed file/layout hashes and package version are measured here',
    cleanupProof: { available: false }, attested: false, qualified: false };
}
