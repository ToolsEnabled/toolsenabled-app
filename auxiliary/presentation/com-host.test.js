#!/usr/bin/env node
'use strict';
/*
 * Deterministic lifecycle coverage for server.js's persistent COM host.
 * The exact source block is evaluated with fake child processes and short
 * timers; this file never starts the coordinator or PowerPoint and never
 * reads or writes the live data directory.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const checks = [];
function check(description, condition, detail = '') {
  checks.push({ description, ok: !!condition, detail });
}
const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeout = 500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(2);
  }
  throw new Error('timed out waiting for fake COM-host state');
}
async function rejection(promise) {
  try { await promise; return null; } catch (error) { return error; }
}

const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const blockStart = serverSource.indexOf('// ------------------------------------------------------------ COM host');
const blockEnd = serverSource.indexOf('// ------------------------------------------------------------------- render', blockStart);
if (blockStart < 0 || blockEnd < 0) throw new Error('could not locate COM-host source block');
let comHostSource = serverSource.slice(blockStart, blockEnd);
const shortConstants = new Map([
  ['const COM_HOST_READY_TIMEOUT_MS = 10000;', 'const COM_HOST_READY_TIMEOUT_MS = 35;'],
  ['const COM_HOST_JOB_TIMEOUT_MS = 15000;', 'const COM_HOST_JOB_TIMEOUT_MS = 35;'],
  ['const COM_HOST_STOP_TIMEOUT_MS = 4000;', 'const COM_HOST_STOP_TIMEOUT_MS = 30;'],
  ['const COM_HOST_KILL_SETTLE_MS = 5000;', 'const COM_HOST_KILL_SETTLE_MS = 35;'],
  ['const COM_HOST_STDOUT_FRAME_LIMIT = 256 * 1024;', 'const COM_HOST_STDOUT_FRAME_LIMIT = 256;'],
  ['const COM_HOST_STDERR_LIMIT = 64 * 1024;', 'const COM_HOST_STDERR_LIMIT = 128;'],
]);
for (const [normal, shortened] of shortConstants) {
  if (!comHostSource.includes(normal)) throw new Error(`COM-host constant changed: ${normal}`);
  comHostSource = comHostSource.replace(normal, shortened);
}

class FakeStream extends EventEmitter {}

class FakeStdin extends EventEmitter {
  constructor(proc, behavior) {
    super();
    this.proc = proc;
    this.behavior = behavior;
    this.writable = true;
    this.writes = [];
  }

  write(chunk, callback) {
    const text = String(chunk);
    this.writes.push(text);
    if (this.behavior.throwOnWrite) throw new Error('fake synchronous stdin failure');
    const asyncError = this.behavior.writeError ? new Error('fake asynchronous stdin failure') : null;
    if (callback) setImmediate(() => callback(asyncError));
    if (text === 'quit\n' && this.behavior.exitOnQuit !== false) {
      setImmediate(() => this.proc.exitNow(0));
    }
    return !asyncError;
  }
}

class FakeProc extends EventEmitter {
  constructor(pid, behavior) {
    super();
    this.pid = pid;
    this.behavior = behavior;
    this.stdout = new FakeStream();
    this.stderr = new FakeStream();
    this.stdin = new FakeStdin(this, behavior);
    this.kills = [];
    this.exited = false;
  }

  kill(signal) {
    this.kills.push(signal);
    if (this.behavior.exitOnKill !== false) setImmediate(() => this.exitNow(null, signal));
    return true;
  }

  exitNow(code = 0, signal = null) {
    if (this.exited) return;
    this.exited = true;
    this.stdin.writable = false;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }

  send(message) {
    this.stdout.emit('data', Buffer.from(JSON.stringify(message) + '\n'));
  }
}

function createHarness(options = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-com-host-'));
  const pidPath = path.join(temp, 'com_host.pid.json');
  const procs = [];
  const spawnCalls = [];
  const execCalls = [];
  const errors = [];
  const behaviors = [...(options.behaviors || [])];
  const processTable = new Map();
  let nextPid = options.firstPid || 4100;

  function fakeSpawn(exe, args, spawnOptions) {
    const behavior = behaviors.shift() || {};
    const proc = new FakeProc(nextPid++, behavior);
    processTable.set(proc.pid, {
      exists: true,
      name: 'powershell.exe',
      commandLine: [exe, ...args].join(' '),
      startedAt: Date.now(),
    });
    proc.once('exit', () => {
      const identity = processTable.get(proc.pid);
      if (identity) identity.exists = false;
    });
    procs.push(proc);
    spawnCalls.push({ exe, args, options: spawnOptions, proc });
    return proc;
  }

  function fakeExecFile(exe, args, execOptions, callback) {
    if (typeof execOptions === 'function') {
      callback = execOptions;
      execOptions = {};
    }
    execCalls.push({ exe, args, options: execOptions });
    if (exe === 'powershell' && args.includes('-Command')) {
      const command = args[args.indexOf('-Command') + 1];
      const match = /ProcessId = (\d+)/.exec(command);
      const queriedPid = match && Number(match[1]);
      if ((options.queryErrors || new Set()).has(queriedPid)) {
        setImmediate(() => callback(new Error('fake CIM query failure'), '', ''));
        return { pid: 8001 };
      }
      const identity = match && processTable.get(queriedPid);
      const result = !identity || !identity.exists
        ? { exists: false }
        : {
            exists: true,
            name: identity.name,
            commandLine: identity.commandLine,
            startedAt: new Date(identity.startedAt).toISOString(),
          };
      setImmediate(() => callback(null, JSON.stringify(result), ''));
      return { pid: 8001 };
    }
    if (exe === 'taskkill') {
      const pidIndex = args.indexOf('/PID');
      const pid = pidIndex >= 0 ? Number(args[pidIndex + 1]) : null;
      const proc = procs.find((candidate) => candidate.pid === pid);
      const identity = processTable.get(pid);
      if (identity && !(options.keepAliveOnTaskkill || new Set()).has(pid)) {
        identity.exists = false;
      }
      if (proc && proc.behavior.exitOnTaskkill !== false) {
        setTimeout(() => proc.exitNow(null, 'SIGKILL'), proc.behavior.taskkillExitDelay || 0);
      }
      setImmediate(() => callback(null, '', ''));
      return { pid: 8002 };
    }
    setImmediate(() => callback(null, '', ''));
    return { pid: 8003 };
  }

  function saveJSONAtomic(file, value) {
    if (options.failMarkerWrite) return false;
    fs.writeFileSync(file, JSON.stringify(value));
    return true;
  }

  const quietConsole = {
    error: (...args) => errors.push(args.map(String).join(' ')),
    log() {},
  };
  const factory = new Function(
    'fs', 'spawn', 'execFile', 'crypto', 'IS_WIN', 'COM_HOST_PID_PATH',
    'COM_HOST_PS1', 'HERE', 'saveJSONAtomic', 'console',
    `${comHostSource}
return {
  startComHost,
  comHostJob,
  stopComHost,
  sweepStaleComHost,
  snapshot: () => {
    const session = comHostSession;
    return {
      blocked: comHostBlockedError && comHostBlockedError.message,
      shuttingDown: comHostShuttingDown,
      generation: comHostGeneration,
      session: session && {
        generation: session.generation,
        token: session.token,
        psPid: session.psPid,
        powerpointPid: session.powerpointPid,
        active: session.active,
        retiring: session.retiring,
        ready: session.wasReady,
        pending: session.pending.size,
        stdoutLength: session.stdout.length,
        stderrLength: session.stderr.length,
      },
    };
  },
};`
  );
  const api = factory(
    fs, fakeSpawn, fakeExecFile, crypto, true, pidPath,
    path.join(temp, 'com_host.ps1'), temp, saveJSONAtomic, quietConsole
  );
  return {
    ...api,
    temp,
    pidPath,
    procs,
    spawnCalls,
    execCalls,
    errors,
    registerProcess(pid, identity) {
      processTable.set(pid, {
        exists: identity.exists !== false,
        name: identity.name,
        commandLine: identity.commandLine || '',
        startedAt: identity.startedAt,
      });
    },
    registerPowerPoint(pid, startedAt = Date.now()) {
      processTable.set(pid, {
        exists: true,
        name: 'POWERPNT.EXE',
        commandLine: '',
        startedAt,
      });
    },
    cleanup() { fs.rmSync(temp, { recursive: true, force: true }); },
  };
}

async function ready(harness, index, powerpointPid = 9000 + index) {
  await waitFor(() => harness.procs[index]);
  const proc = harness.procs[index];
  harness.registerPowerPoint(powerpointPid);
  proc.send({
    id: 0,
    ok: true,
    ready: true,
    psPid: proc.pid,
    powerpointPid,
  });
  await waitFor(() => harness.snapshot().session && harness.snapshot().session.ready);
  return proc;
}

async function happyPath() {
  const h = createHarness({ behaviors: [{ exitOnQuit: true }] });
  try {
    const first = h.startComHost();
    const second = h.startComHost();
    check('concurrent starts share one readiness promise', first === second);
    const proc = await ready(h, 0);
    const [sessionA, sessionB] = await Promise.all([first, second]);
    check('one process serves concurrent starts',
      h.procs.length === 1 && sessionA === sessionB && sessionA.psPid === proc.pid);
    check('spawn carries a random identity token',
      h.spawnCalls[0].args.includes('--suite-com-host-token') &&
      /^[a-f0-9]{32}$/.test(h.spawnCalls[0].args.at(-1)));

    const job = h.comHostJob('source.pptx', 'thumbs', 1100, [1, 3]);
    await waitFor(() => proc.stdin.writes.some((line) => line.startsWith('{')));
    const request = JSON.parse(proc.stdin.writes.find((line) => line.startsWith('{')));
    check('job request is framed with a unique positive id',
      request.cmd === 'thumbs' && request.id > 0 && request.slides.join(',') === '1,3');
    proc.send({ id: request.id, ok: true, count: 2 });
    const reply = await job;
    check('matching job reply resolves', reply.ok === true && reply.count === 2);

    await h.stopComHost();
    check('graceful stop writes quit and removes only its marker',
      proc.stdin.writes.includes('quit\n') && !fs.existsSync(h.pidPath));
  } finally {
    h.cleanup();
  }
}

async function readyTimeoutAndStaleCallbacks() {
  const h = createHarness({
    behaviors: [
      { exitOnTaskkill: true, taskkillExitDelay: 8 },
      { exitOnQuit: true },
    ],
  });
  try {
    const timedOutStart = h.startComHost();
    await waitFor(() => h.procs[0]);
    const oldProc = h.procs[0];
    const timeoutError = await rejection(timedOutStart);
    check('ready timeout rejects only after retiring the timed-out process',
      /ready timeout/.test(timeoutError && timeoutError.message) && oldProc.exited);
    check('ready timeout targets the exact PowerShell process tree',
      h.execCalls.some((call) => call.exe === 'taskkill' &&
        call.args.join(' ') === `/PID ${oldProc.pid} /T /F`));

    const replacementStart = h.startComHost();
    const newProc = await ready(h, 1, 9201);
    await replacementStart;
    const markerBefore = JSON.parse(fs.readFileSync(h.pidPath, 'utf8'));

    // EventEmitters permit this adversarial late data even after fake exit.
    oldProc.send({ id: 0, ok: true, psPid: oldProc.pid, powerpointPid: 9999 });
    oldProc.stdout.emit('error', new Error('late old stdout error'));
    oldProc.emit('exit', 1, null);
    await delay();
    const state = h.snapshot();
    const markerAfter = JSON.parse(fs.readFileSync(h.pidPath, 'utf8'));
    check('late callbacks from the old generation cannot replace current PIDs',
      state.session && state.session.psPid === newProc.pid &&
      state.session.powerpointPid === 9201);
    check('late callbacks cannot delete or rewrite the new generation marker',
      markerAfter.token === markerBefore.token && markerAfter.psPid === newProc.pid);
    await h.stopComHost();
  } finally {
    h.cleanup();
  }
}

async function wedgedJobRecyclesHost() {
  const h = createHarness({
    behaviors: [
      { exitOnTaskkill: true, taskkillExitDelay: 5 },
      { exitOnQuit: true },
    ],
  });
  try {
    const firstStart = h.startComHost();
    const firstProc = await ready(h, 0, 9300);
    await firstStart;
    const hungJob = h.comHostJob('source.pptx', 'thumbs', 1100, [2]);
    const timeoutError = await rejection(hungJob);
    check('a wedged thumbnail job retires its host before rejecting',
      /job timeout/.test(timeoutError && timeoutError.message) && firstProc.exited);

    const retryJob = h.comHostJob('source.pptx', 'thumbs', 1100, [4]);
    await waitFor(() => h.procs.length === 2);
    const secondProc = await ready(h, 1, 9301);
    await waitFor(() => secondProc.stdin.writes.some((line) => line.startsWith('{')));
    const retryRequest = JSON.parse(secondProc.stdin.writes.find((line) => line.startsWith('{')));
    secondProc.send({ id: retryRequest.id, ok: true, count: 1 });
    const retryReply = await retryJob;
    check('the next job waits for retirement and uses a fresh host',
      firstProc.exited && secondProc !== firstProc && retryReply.count === 1);
    await h.stopComHost();
  } finally {
    h.cleanup();
  }
}

async function protocolAndStreamFailures() {
  const oversized = createHarness({ behaviors: [{ exitOnTaskkill: true }] });
  try {
    const starting = oversized.startComHost();
    await waitFor(() => oversized.procs[0]);
    oversized.procs[0].stdout.emit('data', Buffer.from('x'.repeat(300)));
    const error = await rejection(starting);
    check('oversized unterminated stdout is bounded and retires the host',
      /stdout frame exceeded/.test(error && error.message) && oversized.procs[0].exited);
  } finally {
    oversized.cleanup();
  }

  for (const streamName of ['process', 'stdout', 'stdin']) {
    const h = createHarness({ behaviors: [{ exitOnTaskkill: true }] });
    try {
      const starting = h.startComHost();
      await waitFor(() => h.procs[0]);
      const proc = h.procs[0];
      proc.stderr.emit('data', Buffer.from('e'.repeat(5000)));
      check(`${streamName} failure keeps stderr storage bounded`,
        h.snapshot().session.stderrLength <= 128);
      const target = streamName === 'process' ? proc : proc[streamName];
      target.emit('error', new Error(`fake ${streamName} fault`));
      const error = await rejection(starting);
      check(`${streamName} error is handled and retires its generation`,
        new RegExp(`${streamName} error`).test(error && error.message) && proc.exited);
    } finally {
      h.cleanup();
    }
  }
}

async function unconfirmedTerminationBlocksOverlap() {
  const h = createHarness({ behaviors: [{ exitOnTaskkill: false }] });
  try {
    const first = h.startComHost();
    await waitFor(() => h.procs[0]);
    const firstError = await rejection(first);
    const retryError = await rejection(h.startComHost());
    check('an unconfirmed kill fails closed instead of overlapping another host',
      /ready timeout/.test(firstError && firstError.message) &&
      /termination was not confirmed/.test(retryError && retryError.message) &&
      h.procs.length === 1 && !!h.snapshot().blocked);
    check('unconfirmed termination preserves its PID marker for boot recovery',
      fs.existsSync(h.pidPath));
  } finally {
    h.cleanup();
  }
}

async function stalePidSafety() {
  const token = 'a'.repeat(32);
  const guarded = createHarness({ behaviors: [{ exitOnQuit: true }] });
  try {
    const recordedStart = Date.now() - 10 * 60 * 1000;
    fs.writeFileSync(guarded.pidPath, JSON.stringify({
      psPid: 7001,
      powerpointPid: 7002,
      powerpointStartedAt: recordedStart,
      startedAt: recordedStart,
      token,
    }));
    guarded.registerProcess(7001, {
      name: 'powershell.exe',
      commandLine: 'powershell -File unrelated.ps1 ' + token,
      startedAt: Date.now(),
    });
    // The original recorded PowerPoint is gone and this PID has been reused.
    guarded.registerPowerPoint(7002, Date.now());
    const starting = guarded.startComHost();
    const proc = await ready(guarded, 0, 9400);
    await starting;
    check('tokenized stale PID is verified before any kill',
      guarded.execCalls.some((call) => call.exe === 'powershell' &&
        call.args.join(' ').includes('ProcessId = 7001')));
    check('identity mismatch never taskkills a reused stale PID',
      !guarded.execCalls.some((call) => call.exe === 'taskkill' &&
        (call.args.includes('7001') || call.args.includes('7002'))));
    check('verified PID reuse does not prevent a new isolated host',
      guarded.snapshot().session.psPid === proc.pid);
    await guarded.stopComHost();
  } finally {
    guarded.cleanup();
  }

  const legacy = createHarness({ behaviors: [{ exitOnQuit: true }] });
  try {
    const legacyStart = Date.now() - 1000;
    fs.writeFileSync(legacy.pidPath, JSON.stringify({
      psPid: 7101,
      powerpointPid: 7102,
      startedAt: legacyStart,
    }));
    legacy.registerProcess(7101, {
      name: 'powershell.exe',
      commandLine: `powershell -File ${path.join(legacy.temp, 'com_host.ps1')}`,
      startedAt: legacyStart,
    });
    legacy.registerPowerPoint(7102, legacyStart + 20);
    const starting = legacy.startComHost();
    await ready(legacy, 0, 9500);
    await starting;
    check('legacy cleanup remains exact-PID and process-tree scoped',
      legacy.execCalls.some((call) => call.exe === 'taskkill' &&
        call.args.join(' ') === '/PID 7101 /T /F') &&
      legacy.execCalls.some((call) => call.exe === 'taskkill' &&
        call.args.join(' ') === '/PID 7102 /F'));
    await legacy.stopComHost();
  } finally {
    legacy.cleanup();
  }

  const alreadyGone = createHarness({ behaviors: [{ exitOnQuit: true }] });
  try {
    fs.writeFileSync(alreadyGone.pidPath, JSON.stringify({
      psPid: 7201,
      powerpointPid: 7202,
      startedAt: Date.now() - 60 * 60 * 1000,
    }));
    const starting = alreadyGone.startComHost();
    await ready(alreadyGone, 0, 9550);
    await starting;
    check('a harmless legacy marker with absent processes does not block boot',
      !alreadyGone.execCalls.some((call) => call.exe === 'taskkill' &&
        (call.args.includes('7201') || call.args.includes('7202'))));
    await alreadyGone.stopComHost();
  } finally {
    alreadyGone.cleanup();
  }

  const queryFailure = createHarness({ queryErrors: new Set([7301]) });
  try {
    fs.writeFileSync(queryFailure.pidPath, JSON.stringify({
      psPid: 7301,
      powerpointPid: null,
      startedAt: Date.now(),
      token: 'b'.repeat(32),
    }));
    queryFailure.registerProcess(7301, {
      name: 'powershell.exe',
      commandLine: `powershell -File ${path.join(queryFailure.temp, 'com_host.ps1')} ${'b'.repeat(32)}`,
      startedAt: Date.now(),
    });
    const error = await rejection(queryFailure.startComHost());
    check('a stale-process identity query failure aborts startup safely',
      /fake CIM query failure/.test(error && error.message) &&
      queryFailure.procs.length === 0 && fs.existsSync(queryFailure.pidPath));
  } finally {
    queryFailure.cleanup();
  }
}

async function forcedStop() {
  const h = createHarness({
    behaviors: [{ exitOnQuit: false, exitOnTaskkill: true }],
  });
  try {
    const starting = h.startComHost();
    const proc = await ready(h, 0, 9600);
    await starting;
    await h.stopComHost();
    check('stop timeout force-kills only the current host process tree',
      proc.exited && h.execCalls.some((call) => call.exe === 'taskkill' &&
        call.args.join(' ') === `/PID ${proc.pid} /T /F`));
  } finally {
    h.cleanup();
  }
}

async function secondaryPidIdentityAndSettlement() {
  const reused = createHarness({ behaviors: [{ exitOnQuit: true }] });
  try {
    const starting = reused.startComHost();
    await ready(reused, 0, 9700);
    await starting;
    // Replace the recorded process with a different PowerPoint creation at
    // the same numeric PID before the host exits.
    reused.registerPowerPoint(9700, Date.now() + 10 * 60 * 1000);
    await reused.stopComHost();
    check('runtime cleanup never kills a reused PowerPoint PID',
      !reused.execCalls.some((call) => call.exe === 'taskkill' &&
        call.args.join(' ') === '/PID 9700 /F'));
    check('a proven-reused secondary PID is considered safely retired',
      !fs.existsSync(reused.pidPath) && !reused.snapshot().blocked);
  } finally {
    reused.cleanup();
  }

  const stuckPid = 9800;
  const stuck = createHarness({
    behaviors: [{ exitOnQuit: true }],
    keepAliveOnTaskkill: new Set([stuckPid]),
  });
  try {
    const starting = stuck.startComHost();
    await ready(stuck, 0, stuckPid);
    await starting;
    await stuck.stopComHost();
    check('secondary cleanup is attempted with the exact recorded PID',
      stuck.execCalls.some((call) => call.exe === 'taskkill' &&
        call.args.join(' ') === `/PID ${stuckPid} /F`));
    check('failed secondary cleanup preserves marker and fails closed',
      fs.existsSync(stuck.pidPath) &&
      /termination was not confirmed/.test(stuck.snapshot().blocked || ''));
  } finally {
    stuck.cleanup();
  }
}

async function tentativeMarkerCrashSafety() {
  const ppPid = 9900;
  const interrupted = createHarness({
    behaviors: [{ exitOnTaskkill: true }],
    queryErrors: new Set([ppPid]),
  });
  try {
    const starting = interrupted.startComHost();
    await waitFor(() => interrupted.procs[0]);
    const proc = interrupted.procs[0];
    interrupted.registerPowerPoint(ppPid);
    proc.send({
      id: 0,
      ok: true,
      ready: true,
      psPid: proc.pid,
      powerpointPid: ppPid,
    });
    // The fake CIM callback runs on setImmediate, so this read observes the
    // crash window between the ready frame and identity-query completion.
    const tentative = JSON.parse(fs.readFileSync(interrupted.pidPath, 'utf8'));
    check('ready persists a tentative PowerPoint PID before async identity lookup',
      tentative.powerpointPid === ppPid &&
      tentative.powerpointStartedAt === null &&
      Number.isFinite(tentative.startedAt));
    await rejection(starting);
    check('identity-query failure retains the tentative marker for recovery',
      fs.existsSync(interrupted.pidPath));
  } finally {
    interrupted.cleanup();
  }

  const recoveredPid = 9910;
  const recoveredStart = Date.now() - 1000;
  const recovery = createHarness({ behaviors: [{ exitOnQuit: true }] });
  try {
    fs.writeFileSync(recovery.pidPath, JSON.stringify({
      psPid: 9911,
      powerpointPid: recoveredPid,
      powerpointStartedAt: null,
      startedAt: recoveredStart,
      token: 'c'.repeat(32),
    }));
    recovery.registerPowerPoint(recoveredPid, recoveredStart + 25);
    const starting = recovery.startComHost();
    await ready(recovery, 0, 9920);
    await starting;
    check('boot validates and cleans a tentative tokenized PowerPoint marker',
      recovery.execCalls.some((call) => call.exe === 'taskkill' &&
        call.args.join(' ') === `/PID ${recoveredPid} /F`));
    await recovery.stopComHost();
  } finally {
    recovery.cleanup();
  }
}

async function main() {
  await happyPath();
  await readyTimeoutAndStaleCallbacks();
  await wedgedJobRecyclesHost();
  await protocolAndStreamFailures();
  await unconfirmedTerminationBlocksOverlap();
  await stalePidSafety();
  await forcedStop();
  await secondaryPidIdentityAndSettlement();
  await tentativeMarkerCrashSafety();

  for (const result of checks) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.description}${result.detail ? `: ${result.detail}` : ''}`);
  }
  const failed = checks.filter((result) => !result.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
