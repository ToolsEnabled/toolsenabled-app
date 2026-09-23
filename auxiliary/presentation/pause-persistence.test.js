#!/usr/bin/env node
'use strict';
/*
 * A pause acknowledgement is a safety boundary: after a storage failure, a
 * restart must never reverse what the UI just claimed.  Exercise real HTTP
 * pause/resume routes in isolated server copies while both atomic-write failure
 * paths are injected for state.json, recording every simulated OS lock flip.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const HERE = __dirname;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function api(base, route, options) {
  const res = await fetch(base + route, options);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function waitFor(description, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await predicate()) return; } catch (_) {}
    await sleep(30);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function within(description, promise, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out: ${description}`)), timeoutMs); })
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

function makeWritable(file) {
  if (process.platform === 'win32') spawnSync('attrib', ['-R', file], { stdio: 'ignore' });
  else { try { fs.chmodSync(file, 0o644); } catch (_) {} }
}

function prepareState(suiteDir, paused) {
  const data = path.join(suiteDir, 'data');
  const statePath = path.join(data, 'state.json');
  makeWritable(statePath);
  makeWritable(path.join(data, 'model.json'));
  fs.writeFileSync(statePath, JSON.stringify({
    paused,
    pausedBy: paused ? 'initial-test' : null,
    pausedAt: paused ? 123456789 : null,
    pdfRev: null,
    log: [],
    loopRunner: false
  }, null, 2));
}

function patchServerForTest(suiteDir) {
  const serverPath = path.join(suiteDir, 'server.js');
  let source = fs.readFileSync(serverPath, 'utf8');
  const platformNeedle = "const IS_WIN = process.platform === 'win32';";
  if (!source.includes(platformNeedle)) throw new Error('could not isolate Windows-only work');
  source = source.replace(platformNeedle, 'const IS_WIN = false; // pause-persistence test sandbox');

  const pathNeedle = "const COM_HOST_PID_PATH = path.join(DATA, 'com_host.pid.json');";
  if (!source.includes(pathNeedle)) throw new Error('could not add state persistence fault hook');
  source = source.replace(pathNeedle, pathNeedle + `
const __pausePersistModePath = path.join(DATA, '__pause-persist-test-mode');
const __pausePersistWriteFileSync = fs.writeFileSync.bind(fs);
const __pausePersistRenameSync = fs.renameSync.bind(fs);
function __pausePersistMode() { try { return fs.readFileSync(__pausePersistModePath, 'utf8').trim(); } catch (_) { return ''; } }
function __pausePersistError() { const err = new Error('forced state persistence failure'); err.code = 'EPERM'; return err; }
fs.writeFileSync = function(file, data, ...args) {
  const mode = __pausePersistMode();
  const target = String(file);
  if (mode === 'temp' && target.startsWith(STATE_PATH + '.')) throw __pausePersistError();
  if (mode === 'final' && target === STATE_PATH) throw __pausePersistError();
  return __pausePersistWriteFileSync(file, data, ...args);
};
fs.renameSync = function(from, to) {
  if (__pausePersistMode() === 'final' && String(to) === STATE_PATH) throw __pausePersistError();
  return __pausePersistRenameSync(from, to);
};`);

  const lockStart = source.indexOf('function setReadOnly(file, on) {');
  const afterLock = source.indexOf('// THUMBS_SRC', lockStart);
  if (lockStart < 0 || afterLock < 0) throw new Error('could not replace lock helper');
  const lockStub = `const __pausePersistTrace = path.join(DATA, 'pause-persist-lock-trace.log');
function setReadOnly(file, on) {
  fs.appendFileSync(__pausePersistTrace, path.basename(file) + ':' + (on ? 'on' : 'off') + '\\n');
  return Promise.resolve(true);
}

`;
  source = source.slice(0, lockStart) + lockStub + source.slice(afterLock);

  if (!source.includes('  await migrateModel();')) throw new Error('could not skip migration');
  source = source.replace('  await migrateModel();', '  // pause-persistence test: skip migration');
  if (!source.includes('function scheduleRender() {')) throw new Error('could not isolate render');
  source = source.replace('function scheduleRender() {', 'function scheduleRender() {\n  if (process.env.SUITE_PAUSE_PERSIST_TEST) return;');
  const thumbsNeedle = "    void refreshThumbsFromDeck(model.rev, 'boot thumbs pass skipped:');";
  if (!source.includes(thumbsNeedle)) throw new Error('could not skip thumbnail boot');
  source = source.replace(thumbsNeedle, '    // pause-persistence test: no background thumbnail export');
  fs.writeFileSync(serverPath, source);
}

function startServer(suiteDir, port) {
  return spawn(process.execPath, ['server.js'], {
    cwd: suiteDir,
    env: Object.assign({}, process.env, { SUITE_PORT: String(port), SUITE_PAUSE_PERSIST_TEST: '1' }),
    stdio: ['ignore', 'ignore', 'ignore']
  });
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try { child.kill(); } catch (_) {}
  await Promise.race([exited, sleep(1500)]);
}

function pauseSignature(snapshot) {
  return JSON.stringify({
    paused: snapshot.paused,
    pausedBy: snapshot.pausedBy,
    pausedAt: snapshot.pausedAt,
    pdfRev: snapshot.pdfRev,
    loopRunner: snapshot.loopRunner,
    log: snapshot.log
  });
}

const checks = [];
function check(description, condition) { checks.push({ description, ok: !!condition }); }

async function runPauseFailures() {
  const sandbox = path.join(os.tmpdir(), 'pause-persist-pause-' + crypto.randomBytes(4).toString('hex'));
  const suiteDir = path.join(sandbox, 'suite');
  const data = path.join(suiteDir, 'data');
  const statePath = path.join(data, 'state.json');
  const modePath = path.join(data, '__pause-persist-test-mode');
  const tracePath = path.join(data, 'pause-persist-lock-trace.log');
  let child = null;
  const setMode = (mode) => { if (mode) fs.writeFileSync(modePath, mode); else fs.rmSync(modePath, { force: true }); };
  try {
    fs.cpSync(HERE, suiteDir, { recursive: true });
    fs.rmSync(path.join(data, 'com_host.pid.json'), { force: true });
    fs.rmSync(path.join(data, 'agents.pid.json'), { force: true });
    prepareState(suiteDir, false);
    patchServerForTest(suiteDir);
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const state = async () => (await api(base, '/api/state')).body;
    const post = (route) => api(base, route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ by: 'pause-persist-test' }) });
    child = startServer(suiteDir, port);
    await waitFor('pause persistence sandbox health', async () => (await fetch(base + '/api/health')).ok, 8000);
    fs.writeFileSync(tracePath, ''); // discard boot reconciliation calls

    for (const mode of ['temp', 'final']) {
      const before = await state();
      const diskBefore = fs.readFileSync(statePath, 'utf8');
      fs.writeFileSync(tracePath, '');
      setMode(mode);
      const response = await within(`${mode} failed pause response`, post('/api/pause'), 2500);
      setMode('');
      const after = await state();
      const diskAfter = fs.readFileSync(statePath, 'utf8');
      const trace = fs.readFileSync(tracePath, 'utf8').split(/\r?\n/).filter(Boolean);
      check(`${mode}: failed pause returns a timely 500`, response.status === 500 && response.body && response.body.ok === false);
      check(`${mode}: failed pause leaves memory and state.json unchanged`, pauseSignature(after) === pauseSignature(before) && diskAfter === diskBefore);
      check(`${mode}: failed pause does not touch presentation locks`, trace.length === 0);
    }

    const success = await post('/api/pause');
    const afterSuccess = await state();
    check('pause succeeds after storage recovers and the queue remains usable', success.status === 200 && afterSuccess.paused === true);
  } finally {
    setMode('');
    await stopServer(child);
    for (let attempt = 0; attempt < 5; attempt++) {
      try { fs.rmSync(sandbox, { recursive: true, force: true }); break; }
      catch (_) { if (attempt < 4) await sleep(200); }
    }
  }
}

async function runResumeFailures() {
  const sandbox = path.join(os.tmpdir(), 'pause-persist-resume-' + crypto.randomBytes(4).toString('hex'));
  const suiteDir = path.join(sandbox, 'suite');
  const data = path.join(suiteDir, 'data');
  const statePath = path.join(data, 'state.json');
  const modePath = path.join(data, '__pause-persist-test-mode');
  const tracePath = path.join(data, 'pause-persist-lock-trace.log');
  let child = null;
  const setMode = (mode) => { if (mode) fs.writeFileSync(modePath, mode); else fs.rmSync(modePath, { force: true }); };
  try {
    fs.cpSync(HERE, suiteDir, { recursive: true });
    fs.rmSync(path.join(data, 'com_host.pid.json'), { force: true });
    fs.rmSync(path.join(data, 'agents.pid.json'), { force: true });
    prepareState(suiteDir, true);
    patchServerForTest(suiteDir);
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const state = async () => (await api(base, '/api/state')).body;
    const post = (route) => api(base, route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ by: 'resume-persist-test' }) });
    child = startServer(suiteDir, port);
    await waitFor('resume persistence sandbox health', async () => (await fetch(base + '/api/health')).ok, 8000);
    fs.writeFileSync(tracePath, ''); // discard boot reconciliation calls

    for (const mode of ['temp', 'final']) {
      const before = await state();
      const diskBefore = fs.readFileSync(statePath, 'utf8');
      fs.writeFileSync(tracePath, '');
      setMode(mode);
      const response = await within(`${mode} failed resume response`, post('/api/resume'), 2500);
      setMode('');
      const after = await state();
      const diskAfter = fs.readFileSync(statePath, 'utf8');
      const trace = fs.readFileSync(tracePath, 'utf8').split(/\r?\n/).filter(Boolean);
      check(`${mode}: failed resume returns a timely 500`, response.status === 500 && response.body && response.body.ok === false);
      check(`${mode}: failed resume keeps the paused state durable`, pauseSignature(after) === pauseSignature(before) && diskAfter === diskBefore);
      check(`${mode}: failed resume relocks both files in fail-closed order`, JSON.stringify(trace) === JSON.stringify(['model.json:off', 'presentation.pptx:off', 'presentation.pptx:on', 'model.json:on']));
    }

    const success = await post('/api/resume');
    const afterSuccess = await state();
    check('resume succeeds after storage recovers and the queue remains usable', success.status === 200 && afterSuccess.paused === false);
  } finally {
    setMode('');
    await stopServer(child);
    for (let attempt = 0; attempt < 5; attempt++) {
      try { fs.rmSync(sandbox, { recursive: true, force: true }); break; }
      catch (_) { if (attempt < 4) await sleep(200); }
    }
  }
}

async function runLoopRunnerFailures() {
  const sandbox = path.join(os.tmpdir(), 'pause-persist-runner-' + crypto.randomBytes(4).toString('hex'));
  const suiteDir = path.join(sandbox, 'suite');
  const data = path.join(suiteDir, 'data');
  const statePath = path.join(data, 'state.json');
  const modePath = path.join(data, '__pause-persist-test-mode');
  let child = null;
  let port = null;
  const setMode = (mode) => { if (mode) fs.writeFileSync(modePath, mode); else fs.rmSync(modePath, { force: true }); };
  try {
    fs.cpSync(HERE, suiteDir, { recursive: true });
    fs.rmSync(path.join(data, 'com_host.pid.json'), { force: true });
    fs.rmSync(path.join(data, 'agents.pid.json'), { force: true });
    // Keep the server paused: a runner setting test must never spawn a real
    // worker while proving that its state transition is durable.
    prepareState(suiteDir, true);
    patchServerForTest(suiteDir);
    port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const state = async () => (await api(base, '/api/state')).body;
    const setRunner = () => api(base, '/api/loops/runner', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ by: 'runner-persist-test', enabled: true })
    });
    child = startServer(suiteDir, port);
    await waitFor('loop runner persistence sandbox health', async () => (await fetch(base + '/api/health')).ok, 8000);

    for (const mode of ['temp', 'final']) {
      const before = await state();
      const diskBefore = fs.readFileSync(statePath, 'utf8');
      setMode(mode);
      const response = await within(`${mode} failed loop runner response`, setRunner(), 2500);
      setMode('');
      const after = await state();
      const diskAfter = fs.readFileSync(statePath, 'utf8');
      check(`${mode}: failed loop-runner update returns a timely 500`, response.status === 500 && response.body && response.body.ok === false);
      check(`${mode}: failed loop-runner update leaves state and disk unchanged`, pauseSignature(after) === pauseSignature(before) && diskAfter === diskBefore);
    }

    const success = await setRunner();
    const beforeRestart = await state();
    check('loop runner update succeeds after storage recovers', success.status === 200 && beforeRestart.loopRunner && beforeRestart.loopRunner.enabled === true);

    await stopServer(child); child = null;
    child = startServer(suiteDir, port);
    await waitFor('restarted loop runner persistence sandbox health', async () => (await fetch(base + '/api/health')).ok, 8000);
    const afterRestart = await state();
    const diskAfterRestart = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    check('loop runner choice survives restart', afterRestart.loopRunner && afterRestart.loopRunner.enabled === true && diskAfterRestart.loopRunner === true);
  } finally {
    setMode('');
    await stopServer(child);
    for (let attempt = 0; attempt < 5; attempt++) {
      try { fs.rmSync(sandbox, { recursive: true, force: true }); break; }
      catch (_) { if (attempt < 4) await sleep(200); }
    }
  }
}

async function main() {
  await runPauseFailures();
  await runResumeFailures();
  await runLoopRunnerFailures();
  const passed = checks.filter((item) => item.ok).length;
  for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.description}`);
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((err) => { console.error(err.stack || err); process.exit(1); });
