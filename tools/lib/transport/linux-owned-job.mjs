import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { compileFunction } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { digestRecord, measureFile, plainPath, contains, readBounded } from '../adapters/artifact-files.mjs';
import { measureLinuxToolchain } from './linux-toolchain.mjs';
import { LINUX_GIT, measureLinuxGitToolchain, assertLinuxGitArguments, linuxGitEnvironment, linuxGitDescriptorArguments } from './linux-git-toolchain.mjs';
import { LINUX_XZ, MAX_XZ_OUTPUT_BYTES, measureLinuxXzToolchain, assertLinuxXzArguments, linuxXzEnvironment, linuxXzDescriptorArguments } from './linux-xz-toolchain.mjs';
import { acquireOwnedExecution, ownedJobImplementationIdentity, registeredToolEnvironment } from './owned-job.mjs';

const MODULE = fileURLToPath(import.meta.url);
const identity = file => ({ path: file, ...measureFile(file) });
const LOADED_IMPLEMENTATION = identity(MODULE);
const MAX_OUTPUT = 64 * 1024 * 1024;
const sameGeneration = (a, b) => ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
const positive = (value, maximum, name) => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error(`invalid Linux owned ${name} budget`);
  return value;
};
function privateDirectory(directory) {
  directory = plainPath(directory, { kind: 'directory' });
  const stat = fs.lstatSync(directory);
  if (stat.uid !== process.getuid() || stat.mode & 0o077) throw new Error('Linux execution evidence requires a private owning-account directory');
  return directory;
}
function writeRecord(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return identity(file);
}
function capturedOwner(toolchain) {
  const capture = identity => {
    const bytes = readBounded(identity.path, 1024 * 1024);
    if (bytes.length !== identity.bytes || createHash('sha256').update(bytes).digest('hex') !== identity.sha256)
      throw new Error('Linux owner changed while capturing its executing source');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  };
  const source = capture(toolchain.nativeOwner.owner), helper = capture(toolchain.nativeOwner.helper);
  // Compile the exact captured shared CommonJS bytes. Requiring its pathname
  // later could execute a replacement generation and then see restored bytes
  // in the final measurement. This also avoids an older require-cache entry.
  const file = toolchain.nativeOwner.owner.path, module = { exports: {} };
  compileFunction(source, ['exports', 'require', 'module', '__filename', '__dirname'], { filename: file })(
    module.exports, createRequire(file), module, file, path.dirname(file));
  return { owner: module.exports, helper };
}

// The source of cleanup truth is the existing native subreaper's private pipe.
// No caller runner, replacement helper, success record or process-list guess is
// accepted. Runtime/installer observation is a separate, still absent adapter.
export async function runLinuxOwnedJobBatch({ jobs, evidenceRoot, signal, onStarted,
  runtimeObservations = false, installedStateProduct = '', batchTimeoutMs = 30 * 60 * 1000 } = {}) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Linux owned qualification requires native Linux x64');
  signal?.throwIfAborted();
  if (onStarted !== undefined || runtimeObservations !== false || installedStateProduct !== '')
    throw new Error('Linux installed/runtime observation is not registered');
  if (!Array.isArray(jobs) || !jobs.length || jobs.length > 100000) throw new Error('a nonempty bounded Linux job batch is required');
  positive(batchTimeoutMs, 24 * 60 * 60 * 1000, 'batch');
  evidenceRoot = privateDirectory(evidenceRoot);
  const gitRequired = jobs.some(job => job?.command === LINUX_GIT);
  const xzRequired = jobs.some(job => job?.command === LINUX_XZ);
  const measureTools = () => ({ ...measureLinuxToolchain(), ...(gitRequired ? { git: measureLinuxGitToolchain() } : {}),
    ...(xzRequired ? { xz: measureLinuxXzToolchain() } : {}) });
  const toolchain = measureTools();
  const nativeOwner = capturedOwner(toolchain);
  const implementation = identity(MODULE);
  if (digestRecord(implementation) !== digestRecord(LOADED_IMPLEMENTATION)) throw new Error('loaded Linux owned-job implementation changed');
  const sharedImplementation = ownedJobImplementationIdentity();
  const prepared = jobs.map(({ command, args = [], cwd, env = {}, sourceBinding, timeoutMs = 120000,
    maxOutputBytes = 8 * 1024 * 1024, cleanupMs = 5000, cleanupGraceMs = 250, expectedProfile = '' }) => {
    positive(timeoutMs, 24 * 60 * 60 * 1000, 'execution');
    positive(cleanupMs, 5000, 'cleanup'); positive(cleanupGraceMs, 5000, 'cleanup grace');
    if (cleanupGraceMs !== 250) throw new Error('Linux native cleanup grace is fixed at 250 ms');
    if (expectedProfile !== '') throw new Error('Linux privilege observations are not registered');
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('invalid Linux command argument vector');
    command = plainPath(command, { kind: 'file' }); cwd = plainPath(cwd, { kind: 'directory' });
    const git = command === LINUX_GIT;
    const xz = command === LINUX_XZ;
    // Only the fixed decoder may stream a large archive into its private file
    // sink. Ordinary checkers retain the existing output budget.
    positive(maxOutputBytes, xz ? MAX_XZ_OUTPUT_BYTES : MAX_OUTPUT, 'output');
    const sourceMetadata = git ? assertLinuxGitArguments(args, cwd) : null;
    const compressedInput = xz ? assertLinuxXzArguments(args, cwd) : null;
    if (!git && !xz && command !== toolchain.tools.node.path) throw new Error('Linux command is not a registered qualification checker');
    if (contains(cwd, evidenceRoot) || contains(evidenceRoot, cwd)) throw new Error('raw job evidence must be separate from the working payload');
    const boundSource = sourceBinding === undefined ? undefined : structuredClone(sourceBinding);
    if ((git || xz) && boundSource) throw new Error('Native Git/decoder jobs cannot nominate App source-test inputs');
    return { command, args: Object.freeze([...args]), cwd, git, xz, sourceMetadata, compressedInput,
      executable: git ? toolchain.git.inputs.git : xz ? toolchain.xz.inputs.xz : toolchain.tools.node,
      environment: git ? linuxGitEnvironment(env) : xz ? linuxXzEnvironment(env) : registeredToolEnvironment(env, { cwd, sourceBinding: boundSource }),
      ...(boundSource ? { sourceBinding: boundSource } : {}),
      timeoutMs, maxOutputBytes, cleanupMs, cleanupGraceMs, expectedProfile };
  });
  const bound = [];
  function bind(input) {
    const selected = fs.lstatSync(input.path, { bigint: true });
    if (digestRecord({ path: input.path, ...measureFile(input.path, { systemFile: true }) }) !== digestRecord(input))
      throw new Error('Linux native input changed before descriptor binding');
    const fd = fs.openSync(input.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    bound.push({ input, selected, fd });
    if (!sameGeneration(selected, fs.fstatSync(fd, { bigint: true }))) throw new Error('Linux native input changed during descriptor binding');
    return fd;
  }
  let executableFd, pythonFd, gitFds, xzFds, lease;
  const compressedFds = new Map();
  try {
    executableFd = bind(toolchain.tools.node);
    pythonFd = bind(toolchain.tools.python);
    for (const input of Object.values(toolchain.elf.inputs)) bind(input);
    for (const input of Object.values(toolchain.elf.runtimeData)) bind(input);
    for (const role of ['ctypes', 'json']) {
      const image = toolchain.elf.roots[role];
      bind({ path: image.path, bytes: image.bytes, sha256: image.sha256 });
    }
    bind(toolchain.elf.resolver.cache);
    gitFds = gitRequired ? Object.values(toolchain.git.inputs).map(bind) : null;
    xzFds = xzRequired ? Object.values(toolchain.xz.inputs).map(bind) : null;
    for (const job of prepared) if (job.xz) compressedFds.set(job, bind(job.compressedInput));
    lease = acquireOwnedExecution({ evidenceRoot, commandsSha256: digestRecord(prepared.map(job => [job.command, ...job.args])) });
  } catch (error) { for (const input of bound) fs.closeSync(input.fd); throw error; }
  let launched = false, cleanupConfirmed = true, released = false;
  const records = [];
  try {
    const directory = fs.mkdtempSync(path.join(evidenceRoot, 'owned-job-'));
    fs.chmodSync(directory, 0o700); lease.annotate({ evidenceDirectory: directory });
    const launchSpec = writeRecord(path.join(directory, 'launch-spec.json'), { batchTimeoutMs, jobs: prepared });
    const deadline = process.hrtime.bigint() + BigInt(batchTimeoutMs) * 1000000n;
    let stopped = false;
    for (const [jobIndex, job] of prepared.entries()) {
      const jobDirectory = path.join(directory, String(jobIndex + 1).padStart(4, '0'));
      fs.mkdirSync(jobDirectory, { mode: 0o700 });
      const stdout = path.join(jobDirectory, 'stdout.bin'), stderr = path.join(jobDirectory, 'stderr.bin');
      const handles = [stdout, stderr].map(file => fs.openSync(file, 'wx', 0o600));
      let result;
      try {
        const remaining = Number((deadline - process.hrtime.bigint()) / 1000000n);
        if (stopped || remaining <= 0 || signal?.aborted) {
          stopped = true;
          result = { receipt: null, complete: false, cleanupConfirmed: true, notRun: true,
            timedOut: remaining <= 0, outputLimitExceeded: false, cancelled: signal?.aborted === true, error: 'not run after earlier failure or batch budget' };
        } else {
          signal?.throwIfAborted();
          if (job.git && assertLinuxGitArguments(job.args, job.cwd) !== job.sourceMetadata) throw new Error('Git metadata changed before execution');
          if (job.xz && digestRecord(assertLinuxXzArguments(job.args, job.cwd)) !== digestRecord(job.compressedInput)) throw new Error('compressed input changed before execution');
          launched = true; cleanupConfirmed = false;
          result = await execute(job, handles, toolchain, signal, Math.min(remaining, job.timeoutMs),
            job.git ? gitFds : job.xz ? [...xzFds, compressedFds.get(job)] : [executableFd], pythonFd, nativeOwner);
          cleanupConfirmed = result.cleanupConfirmed;
          if (job.git && result.cleanupConfirmed) {
            try {
              if (assertLinuxGitArguments(job.args, job.cwd) !== job.sourceMetadata) throw new Error('changed');
            } catch {
              // Preserve the actual native cleanup and raw stream receipts,
              // but a changed/reparsed repository can never make this green.
              result.complete = false;
              result.error = 'Git metadata changed during execution';
            }
          }
          if (job.xz && result.cleanupConfirmed) {
            try {
              if (digestRecord(assertLinuxXzArguments(job.args, job.cwd)) !== digestRecord(job.compressedInput)) throw new Error('changed');
            } catch { result.complete = false; result.error = 'compressed input changed during decoding'; }
          }
        }
      } finally { for (const handle of handles) fs.closeSync(handle); }
      const receipt = result.receipt;
      const nativeResult = receipt ? writeRecord(path.join(jobDirectory, 'native-result.json'), receipt) : null;
      const streams = [stdout, stderr].map(identity);
      const streamsStable = result.notRun === true || streams.every((stream, index) =>
        stream.bytes === result.streams[index].bytes && stream.sha256 === result.streams[index].sha256);
      const record = { schema: 'toolsenabled.owned-job-execution', schemaVersion: 1,
        startedAt: result.startedAt || new Date().toISOString(), finishedAt: new Date().toISOString(),
        command: [job.command, ...job.args], cwd: job.cwd, executable: job.executable,
        ...(job.git ? { nativeLaunch: { executable: toolchain.git.inputs.loader, args: linuxGitDescriptorArguments(job.args),
          descriptorInputs: Object.values(toolchain.git.inputs) } } : {}),
        ...(job.xz ? { nativeLaunch: { executable: toolchain.xz.inputs.loader, args: linuxXzDescriptorArguments(job.args),
          descriptorInputs: [...Object.values(toolchain.xz.inputs), job.compressedInput], output: 'bounded-private-file' } } : {}),
        transport: { sha256: implementation.sha256, sharedSha256: sharedImplementation.sha256,
          helperSha256: toolchain.nativeOwner.helper.sha256, toolchain },
        nativeOwnerLaunch: { executable: toolchain.tools.python, descriptor: 10, mechanism: 'retained-executable-with-protected-kernel-resolution',
          systemLibraries: toolchain.elf.ownerLibraries, sourceSha256: toolchain.nativeOwner.helper.sha256 },
        launchSpec, jobIndex, environmentSha256: digestRecord(job.environment),
        limits: { timeoutMs: job.timeoutMs, maxOutputBytes: job.maxOutputBytes, cleanupMs: job.cleanupMs, cleanupGraceMs: job.cleanupGraceMs },
        exitCode: receipt?.exitCode ?? null, signal: result.cancelled ? 'ABORT' : null,
        complete: result.complete && streamsStable, cleanupConfirmed: result.cleanupConfirmed, notRun: result.notRun === true,
        timedOut: result.timedOut, outputLimitExceeded: result.outputLimitExceeded,
        hadRemainingChildren: receipt?.hadRemainingChildren ?? null, error: streamsStable ? result.error : 'raw stream bytes changed after native capture',
        stdout: streams[0], stderr: streams[1], nativeResult };
      const stored = writeRecord(path.join(jobDirectory, 'execution.json'), record);
      records.push({ ...record, record: stored });
      if (!result.cleanupConfirmed) {
        const error = new Error('Linux native owner did not prove an empty descendant tree');
        error.records = records; throw error;
      }
      if (!record.complete || record.exitCode !== 0) stopped = true;
    }
    // Before releasing admission, bind the actual loaded transport/tool bytes
    // again. Stable content never turns an unsuccessful native run green.
    if (digestRecord(identity(MODULE)) !== digestRecord(implementation) ||
        digestRecord(ownedJobImplementationIdentity()) !== digestRecord(sharedImplementation) ||
        digestRecord(measureTools()) !== digestRecord(toolchain) ||
        bound.some(({ input, selected, fd }) => !sameGeneration(selected, fs.fstatSync(fd, { bigint: true })) ||
          !sameGeneration(selected, fs.lstatSync(input.path, { bigint: true })))) throw new Error('Linux registered executable or transport changed during execution');
    lease.confirmedCleanup(); released = true;
    return records;
  } catch (error) {
    if (released) throw error;
    if (!launched || cleanupConfirmed) { lease.confirmedCleanup(); released = true; throw error; }
    const refusal = lease.quarantine(error); refusal.records = records;
    throw refusal;
  } finally { for (const input of bound) fs.closeSync(input.fd); }
}

async function execute(job, handles, toolchain, signal, timeoutMs, executableFds, pythonFd, nativeOwner) {
  const startedAt = new Date().toISOString();
  return new Promise(resolve => {
    let owner, timer, cleanupTimer, finished = false, reason = null;
    let timedOut = false, outputLimitExceeded = false, cancelled = false, bytes = 0;
    const streams = [0, 1].map(() => ({ bytes: 0, digest: createHash('sha256') }));
    const finish = receipt => {
      if (finished) return;
      finished = true; clearTimeout(timer); clearTimeout(cleanupTimer);
      signal?.removeEventListener('abort', abort);
      process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
      const quiescent = receipt?.quiescent === true;
      if (!quiescent) {
        reason ||= 'Linux descendant cleanup is unconfirmed';
        // Never signal a numeric PID or kill the supervisor. Closing its
        // retained control pipe requests continued native cleanup.
        owner?.child.unref?.();
        for (const stream of owner?.child.stdio || []) stream?.destroy?.();
      }
      const complete = Boolean(quiescent && receipt.started === true && receipt.exitedNormally === true &&
        Number.isInteger(receipt.exitCode) && receipt.hadRemainingChildren === false && !reason);
      resolve({ startedAt, receipt, complete, cleanupConfirmed: quiescent,
        streams: streams.map(stream => ({ bytes: stream.bytes, sha256: stream.digest.digest('hex') })),
        timedOut, outputLimitExceeded, cancelled,
        error: reason || (complete ? null : receipt?.hadRemainingChildren === true
          ? 'command left descendants after root exit' : 'native command did not prove a complete naturally empty execution') });
    };
    const stop = message => {
      if (finished || reason) return;
      reason = message;
      cleanupTimer = setTimeout(() => finish(null), job.cleanupMs);
      try { Promise.resolve(owner.cancel()).catch(() => finish(null)); } catch { finish(null); }
    };
    const abort = () => { cancelled = true; stop('Linux command cancelled'); };
    const interrupt = () => { cancelled = true; stop('Linux command cancelled by SIGINT'); };
    const terminate = () => { cancelled = true; stop('Linux command cancelled by SIGTERM'); };
    try {
      owner = nativeOwner.owner.spawnOwnedClaim({ command: job.command, args: job.args, payloadRoot: job.cwd, stateRoot: job.cwd,
        environment: job.environment, cleanupTimeoutMs: job.cleanupMs,
        readHelper: () => nativeOwner.helper,
        spawn(command, args, options) {
          if (command !== '/usr/bin/python3' || args[0] !== '-I' || args[1] !== '-u' || args[2] !== '-c')
            throw new Error('unexpected shared owner launch');
          // Avoid a mutable python3 symlink, site startup and bytecode writes.
          if (args[4] !== job.command || options.stdio.length !== 4) throw new Error('unexpected checker descriptor launch');
          // FD 3 stays private to the supervisor. Node executes from FD 5;
          // Git uses the loader/Git/library descriptor closure recorded above.
          const bound = [...args.slice(1, 4), '/proc/self/fd/5', ...(job.git ? linuxGitDescriptorArguments(job.args) : job.xz ? linuxXzDescriptorArguments(job.args) : job.args)];
          // Keep normal kernel interpreter resolution: entering ld-linux as
          // Node's executable changes process.execPath and breaks child/fork.
          // The resolver/cache/libraries are protected, measured and held by
          // generation-bound descriptors for the entire batch. Python itself
          // now executes from a retained FD, just like the checker.
          const stdio = [...options.stdio, 'ignore', ...executableFds];
          while (stdio.length < 10) stdio.push('ignore');
          stdio.push(pythonFd);
          return spawn('/proc/self/fd/10', ['-I', '-S', '-B', ...bound], { ...options, stdio });
        } });
    } catch (error) { reason = `Linux owner could not be established: ${error.code || error.name || 'ERROR'}`; finish(null); return; }
    const collect = (index, chunk) => {
      if (finished || reason) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > job.maxOutputBytes) { outputLimitExceeded = true; stop('Linux command exceeded its output budget'); return; }
      try {
        let offset = 0;
        while (offset < buffer.length) {
          const count = fs.writeSync(handles[index], buffer, offset, buffer.length - offset);
          if (!Number.isSafeInteger(count) || count <= 0) throw new Error('invalid raw stream write');
          offset += count;
        }
        streams[index].bytes += buffer.length; streams[index].digest.update(buffer);
      }
      catch { stop('Linux raw output could not be recorded'); }
    };
    owner.child.stdout.on('data', chunk => collect(0, chunk));
    owner.child.stderr.on('data', chunk => collect(1, chunk));
    timer = setTimeout(() => { timedOut = true; stop('Linux command timed out'); }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    if (signal?.aborted) abort();
    owner.completion.then(finish, () => finish(null));
  });
}
