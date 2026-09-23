#!/usr/bin/env node
'use strict';
/*
 * Pause and resume each await two OS lock flips. Exercise the real HTTP routes
 * in isolated server copies while a test-only lock is deliberately held:
 *
 *   pause -> resume: cannot end unpaused with model.json still locked
 *   resume -> pause: the later human pause cannot be silently dropped
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
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
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
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${description}`);
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
    pausedAt: paused ? Date.now() : null,
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
  source = source.replace(platformNeedle, 'const IS_WIN = false; // pause-transition test sandbox');

  const lockStart = source.indexOf('function setReadOnly(file, on) {');
  const afterLock = source.indexOf('// THUMBS_SRC', lockStart);
  if (lockStart < 0 || afterLock < 0) throw new Error('could not replace lock helper');
  const lockStub = `const __pauseTestTrace = path.join(DATA, 'pause-lock-trace.log');
let __pauseTestHeld = null;
function __pauseTestRecord(value) { fs.appendFileSync(__pauseTestTrace, value + '\\n'); }
function setReadOnly(file, on) {
  const key = path.basename(file) + ':' + (on ? 'on' : 'off');
  const apply = () => { __pauseTestRecord(key); return true; };
  if (!__pauseTestHeld && process.env.SUITE_PAUSE_TEST_HOLD === key) {
    return new Promise((resolve) => {
      __pauseTestHeld = {
        key,
        release: () => { __pauseTestHeld = null; apply(); resolve(true); }
      };
      __pauseTestRecord('waiting:' + key);
    });
  }
  apply();
  return Promise.resolve(true);
}

`;
  source = source.slice(0, lockStart) + lockStub + source.slice(afterLock);

  const routeNeedle = /  const p = url\.pathname;\r?\n/;
  if (!routeNeedle.test(source)) throw new Error('could not add test control routes');
  source = source.replace(routeNeedle, (match) => match + `
  if (req.method === 'GET' && p === '/__pause-test-status') {
    return json(res, 200, { held: __pauseTestHeld && __pauseTestHeld.key });
  }
  if (req.method === 'POST' && p === '/__pause-test-release') {
    const held = __pauseTestHeld;
    if (!held) return json(res, 409, { ok: false, error: 'no held lock' });
    held.release();
    return json(res, 200, { ok: true, released: held.key });
  }
`);

  const resumeStart = source.indexOf('async function doResume(by) {');
  const resumeSchedule = source.indexOf('  scheduleRender();', resumeStart);
  if (resumeStart < 0 || resumeSchedule < 0) throw new Error('could not isolate resume render');
  source = source.slice(0, resumeSchedule) + '  if (!process.env.SUITE_PAUSE_TEST) scheduleRender();' + source.slice(resumeSchedule + '  scheduleRender();'.length);

  const thumbsNeedle = "    void refreshThumbsFromDeck(model.rev, 'boot thumbs pass skipped:');";
  if (!source.includes(thumbsNeedle)) throw new Error('could not skip test thumbnail boot');
  source = source.replace(thumbsNeedle, '    // pause-transition test: no background thumbnail export');
  fs.writeFileSync(serverPath, source);
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try { child.kill(); } catch (_) {}
  await Promise.race([exited, sleep(1500)]);
}

const checks = [];
function check(description, condition) { checks.push({ description, ok: !!condition }); }

async function runScenario({ name, initialPaused, hold, firstPath, secondPath, expected }) {
  const sandbox = path.join(os.tmpdir(), 'pause-transition-test-' + crypto.randomBytes(4).toString('hex'));
  const suiteDir = path.join(sandbox, 'suite');
  let child = null;
  try {
    fs.cpSync(HERE, suiteDir, { recursive: true });
    const data = path.join(suiteDir, 'data');
    fs.rmSync(path.join(data, 'com_host.pid.json'), { force: true });
    fs.rmSync(path.join(data, 'agents.pid.json'), { force: true });
    prepareState(suiteDir, initialPaused);
    patchServerForTest(suiteDir);

    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['server.js'], {
      cwd: suiteDir,
      env: Object.assign({}, process.env, {
        SUITE_PORT: String(port),
        SUITE_PAUSE_TEST: '1',
        SUITE_PAUSE_TEST_HOLD: hold
      }),
      stdio: ['ignore', 'ignore', 'ignore']
    });
    await waitFor(`${name} sandbox health`, async () => (await fetch(base + '/api/health')).ok, 8000);
    const tracePath = path.join(data, 'pause-lock-trace.log');
    fs.writeFileSync(tracePath, ''); // discard boot-time reconciliation locks

    const post = (route, by) => api(base, route, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ by })
    });
    const first = post(firstPath, 'first-test');
    await waitFor(`${name} held ${hold}`, async () => {
      const status = await api(base, '/__pause-test-status');
      return status.body && status.body.held === hold;
    }, 4000);

    let laterSettled = false;
    const second = post(secondPath, 'second-test').then((result) => { laterSettled = true; return result; });
    await sleep(60);
    check(`${name}: later transition waits behind the held earlier transition`, !laterSettled);

    const released = await api(base, '/__pause-test-release', { method: 'POST' });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    const finalState = await api(base, '/api/state');
    const trace = fs.readFileSync(tracePath, 'utf8').split(/\r?\n/).filter(Boolean);
    const logKinds = (finalState.body.log || []).map((entry) => entry.kind).filter((kind) => kind === 'pause' || kind === 'resume');

    check(`${name}: held lock releases once`, released.status === 200 && released.body && released.body.released === hold);
    check(`${name}: both route responses succeed`, firstResult.status === 200 && secondResult.status === 200);
    check(`${name}: each response describes its own queued transition`,
      firstResult.body && firstResult.body.paused === expected.firstPaused
        && secondResult.body && secondResult.body.paused === expected.secondPaused);
    check(`${name}: final dashboard state matches the later human intent`, finalState.body && finalState.body.paused === expected.finalPaused);
    check(`${name}: lock flips do not interleave`, JSON.stringify(trace) === JSON.stringify(expected.trace));
    check(`${name}: pause/resume events remain ordered`, JSON.stringify(logKinds) === JSON.stringify(expected.logKinds));
  } finally {
    await stopServer(child);
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}
  }
}

async function main() {
  await runScenario({
    name: 'pause then resume',
    initialPaused: false,
    hold: 'model.json:on',
    firstPath: '/api/pause',
    secondPath: '/api/resume',
    expected: {
      firstPaused: true,
      secondPaused: false,
      finalPaused: false,
      trace: ['presentation.pptx:on', 'waiting:model.json:on', 'model.json:on', 'model.json:off', 'presentation.pptx:off'],
      logKinds: ['pause', 'resume']
    }
  });
  await runScenario({
    name: 'resume then pause',
    initialPaused: true,
    hold: 'model.json:off',
    firstPath: '/api/resume',
    secondPath: '/api/pause',
    expected: {
      firstPaused: false,
      secondPaused: true,
      finalPaused: true,
      trace: ['waiting:model.json:off', 'model.json:off', 'presentation.pptx:off', 'presentation.pptx:on', 'model.json:on'],
      logKinds: ['resume', 'pause']
    }
  });

  const passed = checks.filter((item) => item.ok).length;
  for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.description}`);
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((err) => { console.error(err.stack || err); process.exit(1); });
