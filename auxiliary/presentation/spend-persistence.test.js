#!/usr/bin/env node
'use strict';
/*
 * Turn accounting is intentionally delayed off the hot path, but a failed
 * delayed state.json write must remain dirty and retry. Otherwise Studio shows
 * a real turn, then a restart silently forgets it.
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
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${description}`);
}
function makeWritable(file) {
  if (process.platform === 'win32') spawnSync('attrib', ['-R', file], { stdio: 'ignore' });
  else { try { fs.chmodSync(file, 0o644); } catch (_) {} }
}
function initialSpend() {
  return {
    sinceTs: 1, totalUsd: 0, turns: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    byModel: {}, byRole: {}, recent: []
  };
}
function prepareState(suiteDir) {
  const data = path.join(suiteDir, 'data');
  const statePath = path.join(data, 'state.json');
  makeWritable(statePath);
  makeWritable(path.join(data, 'model.json'));
  fs.writeFileSync(statePath, JSON.stringify({
    paused: true, pausedBy: 'spend-persist-test', pausedAt: 1, pdfRev: null,
    log: [], loopRunner: false, usageProfile: 'normal', agentProvider: 'claude',
    spend: initialSpend()
  }, null, 2));
}

function patchServerForTest(suiteDir) {
  const serverPath = path.join(suiteDir, 'server.js');
  let source = fs.readFileSync(serverPath, 'utf8');
  const platformNeedle = "const IS_WIN = process.platform === 'win32';";
  if (!source.includes(platformNeedle)) throw new Error('could not isolate Windows-only work');
  source = source.replace(platformNeedle, 'const IS_WIN = false; // spend-persistence test sandbox');

  const pathNeedle = "const COM_HOST_PID_PATH = path.join(DATA, 'com_host.pid.json');";
  if (!source.includes(pathNeedle)) throw new Error('could not add spend persistence fault hook');
  source = source.replace(pathNeedle, pathNeedle + `
const __spendPersistModePath = path.join(DATA, '__spend-persist-test-mode');
const __spendPersistFailuresPath = path.join(DATA, '__spend-persist-failures.log');
const __spendPersistWriteFileSync = fs.writeFileSync.bind(fs);
const __spendPersistRenameSync = fs.renameSync.bind(fs);
function __spendPersistMode() { try { return fs.readFileSync(__spendPersistModePath, 'utf8').trim(); } catch (_) { return ''; } }
function __spendPersistError(op) {
  try { fs.appendFileSync(__spendPersistFailuresPath, __spendPersistMode() + ':' + op + '\\n'); } catch (_) {}
  const err = new Error('forced spend persistence failure'); err.code = 'EPERM'; return err;
}
fs.writeFileSync = function(file, data, ...args) {
  const mode = __spendPersistMode();
  const target = String(file);
  if (mode === 'temp' && target.startsWith(STATE_PATH + '.')) throw __spendPersistError('temp');
  if (mode === 'final' && target === STATE_PATH) throw __spendPersistError('final-write');
  return __spendPersistWriteFileSync(file, data, ...args);
};
fs.renameSync = function(from, to) {
  if (__spendPersistMode() === 'final' && String(to) === STATE_PATH) throw __spendPersistError('rename');
  return __spendPersistRenameSync(from, to);
};`);

  const broadcastNeedle = 'function broadcast(event) {';
  if (!source.includes(broadcastNeedle)) throw new Error('could not trace broadcasts');
  source = source.replace(broadcastNeedle, `const __spendPersistEventsPath = path.join(DATA, '__spend-persist-events.jsonl');
function broadcast(event) {
  if (process.env.SUITE_SPEND_PERSIST_TEST) {
    try { fs.appendFileSync(__spendPersistEventsPath, JSON.stringify(event) + '\\n'); } catch (_) {}
  }`);

  const routeNeedle = /  const p = url\.pathname;\r?\n/;
  if (!routeNeedle.test(source)) throw new Error('could not add spend test route');
  source = source.replace(routeNeedle, (match) => match + `
  if (req.method === 'POST' && p === '/__spend-persist-test/turn') {
    Agents.emit('turn-cost', {
      ts: Date.now(), name: 'worker-1', role: 'worker', model: 'sonnet',
      costUsd: 1.25, usage: { input: 10, output: 20, cacheRead: 3, cacheWrite: 4, promptTokens: 10 }
    });
    return json(res, 200, { ok: true });
  }
`);
  // Pre-fix source has a fixed 10s delay. Keep the regression test quick
  // while still letting the production implementation select a test delay.
  const legacyDelay = '}, 10000);';
  if (source.includes(legacyDelay)) source = source.replace(legacyDelay, '}, 40);');
  if (!source.includes('  await migrateModel();')) throw new Error('could not skip migration');
  source = source.replace('  await migrateModel();', '  // spend-persistence test: skip migration');
  if (!source.includes('function scheduleRender() {')) throw new Error('could not isolate render');
  source = source.replace('function scheduleRender() {', 'function scheduleRender() {\n  if (process.env.SUITE_SPEND_PERSIST_TEST) return;');
  const thumbsNeedle = "    void refreshThumbsFromDeck(model.rev, 'boot thumbs pass skipped:');";
  if (!source.includes(thumbsNeedle)) throw new Error('could not skip thumbnail boot');
  source = source.replace(thumbsNeedle, '    // spend-persistence test: no background thumbnail export');
  fs.writeFileSync(serverPath, source);
}

function startServer(suiteDir, port) {
  return spawn(process.execPath, ['server.js'], {
    cwd: suiteDir,
    env: Object.assign({}, process.env, {
      SUITE_PORT: String(port), SUITE_SPEND_PERSIST_TEST: '1',
      SUITE_SPEND_FLUSH_MS: '40', SUITE_SPEND_RETRY_MS: '40'
    }),
    stdio: ['ignore', 'ignore', 'ignore']
  });
}
async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try { child.kill(); } catch (_) {}
  await Promise.race([exited, sleep(1500)]);
}
function readLines(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean); }
  catch (_) { return []; }
}
const checks = [];
function check(description, condition) { checks.push({ description, ok: !!condition }); }

async function main() {
  const sandbox = path.join(os.tmpdir(), 'spend-persistence-' + crypto.randomBytes(4).toString('hex'));
  const suiteDir = path.join(sandbox, 'suite');
  const data = path.join(suiteDir, 'data');
  const statePath = path.join(data, 'state.json');
  const modePath = path.join(data, '__spend-persist-test-mode');
  const failuresPath = path.join(data, '__spend-persist-failures.log');
  const eventsPath = path.join(data, '__spend-persist-events.jsonl');
  let child = null;
  let port = null;
  const setMode = (mode) => { if (mode) fs.writeFileSync(modePath, mode); else fs.rmSync(modePath, { force: true }); };
  try {
    fs.cpSync(HERE, suiteDir, { recursive: true });
    fs.rmSync(path.join(data, 'com_host.pid.json'), { force: true });
    fs.rmSync(path.join(data, 'agents.pid.json'), { force: true });
    prepareState(suiteDir);
    patchServerForTest(suiteDir);
    port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const spend = async () => (await api(base, '/api/state')).body.spend;
    const record = () => api(base, '/__spend-persist-test/turn', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    child = startServer(suiteDir, port);
    await waitFor('spend persistence sandbox health', async () => (await fetch(base + '/api/health')).ok, 8000);

    for (const mode of ['temp', 'final']) {
      const before = await spend();
      const diskBefore = JSON.parse(fs.readFileSync(statePath, 'utf8')).spend;
      fs.writeFileSync(failuresPath, ''); fs.writeFileSync(eventsPath, '');
      setMode(mode);
      const accepted = await record();
      await waitFor(`${mode} forced spend write failure`, () => readLines(failuresPath).length > 0, 2500);
      const during = await spend();
      const diskDuring = JSON.parse(fs.readFileSync(statePath, 'utf8')).spend;
      const spendEvents = readLines(eventsPath).map((line) => JSON.parse(line)).filter((event) => event.type === 'spend');
      check(`${mode}: turn is accepted and visible immediately`,
        accepted.status === 200 && accepted.body && accepted.body.ok === true && during.turns === before.turns + 1);
      check(`${mode}: failed delayed write leaves the previous disk spend intact`,
        JSON.stringify(diskDuring) === JSON.stringify(diskBefore));
      check(`${mode}: a turn produces one live spend event, not a retry storm`, spendEvents.length === 1);
      setMode('');
      await waitFor(`${mode} recovered delayed spend write`,
        () => JSON.parse(fs.readFileSync(statePath, 'utf8')).spend.turns === before.turns + 1, 3000);
      check(`${mode}: retained dirty spend retries after storage recovers`,
        (await spend()).turns === before.turns + 1);
    }

    const expectedTurns = (await spend()).turns;
    await stopServer(child); child = null;
    child = startServer(suiteDir, port);
    await waitFor('restarted spend persistence sandbox health', async () => (await fetch(base + '/api/health')).ok, 8000);
    const afterRestart = await spend();
    const diskAfterRestart = JSON.parse(fs.readFileSync(statePath, 'utf8')).spend;
    check('retried spend accounting survives restart',
      afterRestart.turns === expectedTurns && diskAfterRestart.turns === expectedTurns);
  } finally {
    setMode('');
    await stopServer(child);
    for (let attempt = 0; attempt < 5; attempt++) {
      try { fs.rmSync(sandbox, { recursive: true, force: true }); break; }
      catch (_) { if (attempt < 4) await sleep(200); }
    }
  }

  const passed = checks.filter((item) => item.ok).length;
  for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.description}`);
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((err) => { console.error(err.stack || err); process.exit(1); });
