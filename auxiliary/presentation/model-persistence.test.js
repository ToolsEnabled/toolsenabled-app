#!/usr/bin/env node
'use strict';
/*
 * A persisted deck change is the transaction boundary. Force both the temp
 * write and exhausted rename/fallback paths to fail in an isolated server, and
 * prove edit/undo/redo leave memory, history, locks, and model.json unchanged.
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
    await sleep(40);
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

function prepareState(suiteDir) {
  const data = path.join(suiteDir, 'data');
  const statePath = path.join(data, 'state.json');
  makeWritable(statePath);
  makeWritable(path.join(data, 'model.json'));
  fs.writeFileSync(statePath, JSON.stringify({ paused: false, pausedBy: null, pausedAt: null, pdfRev: null, log: [], loopRunner: false }, null, 2));
}

function patchServerForTest(suiteDir) {
  const serverPath = path.join(suiteDir, 'server.js');
  let source = fs.readFileSync(serverPath, 'utf8');
  const platformNeedle = "const IS_WIN = process.platform === 'win32';";
  if (!source.includes(platformNeedle)) throw new Error('could not isolate Windows-only work');
  source = source.replace(platformNeedle, 'const IS_WIN = false; // model-persistence test sandbox');

  const pathNeedle = "const COM_HOST_PID_PATH = path.join(DATA, 'com_host.pid.json');";
  if (!source.includes(pathNeedle)) throw new Error('could not add persistence fault hook');
  source = source.replace(pathNeedle, pathNeedle + `
const __persistTestModePath = path.join(DATA, '__model-persist-test-mode');
const __persistWriteFileSync = fs.writeFileSync.bind(fs);
const __persistRenameSync = fs.renameSync.bind(fs);
function __persistTestMode() { try { return fs.readFileSync(__persistTestModePath, 'utf8').trim(); } catch (_) { return ''; } }
function __persistTestError() { const err = new Error('forced model persistence failure'); err.code = 'EPERM'; return err; }
fs.writeFileSync = function(file, data, ...args) {
  const mode = __persistTestMode();
  const target = String(file);
  if (mode === 'temp' && target.startsWith(MODEL_PATH + '.')) throw __persistTestError();
  if (mode === 'final' && target === MODEL_PATH) throw __persistTestError();
  return __persistWriteFileSync(file, data, ...args);
};
fs.renameSync = function(from, to) {
  if (__persistTestMode() === 'final' && String(to) === MODEL_PATH) throw __persistTestError();
  return __persistRenameSync(from, to);
};`);

  if (!source.includes('  await migrateModel();')) throw new Error('could not skip migration');
  source = source.replace('  await migrateModel();', '  // model-persistence test: skip migration');
  if (!source.includes('function scheduleRender() {')) throw new Error('could not isolate render');
  source = source.replace('function scheduleRender() {', 'function scheduleRender() {\n  if (process.env.SUITE_MODEL_PERSIST_TEST) return;');
  const thumbsNeedle = "    void refreshThumbsFromDeck(model.rev, 'boot thumbs pass skipped:');";
  if (!source.includes(thumbsNeedle)) throw new Error('could not skip thumbnail boot');
  source = source.replace(thumbsNeedle, '    // model-persistence test: no background thumbnail export');
  fs.writeFileSync(serverPath, source);
}

function startServer(suiteDir, port) {
  return spawn(process.execPath, ['server.js'], {
    cwd: suiteDir,
    env: Object.assign({}, process.env, { SUITE_PORT: String(port), SUITE_MODEL_PERSIST_TEST: '1' }),
    stdio: ['ignore', 'ignore', 'ignore']
  });
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try { child.kill(); } catch (_) {}
  await Promise.race([exited, sleep(1500)]);
}

function modelSignature(snapshot) {
  return JSON.stringify({ model: snapshot.model, undoCount: snapshot.undoCount, redoCount: snapshot.redoCount, locks: snapshot.locks });
}

const checks = [];
function check(description, condition) { checks.push({ description, ok: !!condition }); }

async function main() {
  const sandbox = path.join(os.tmpdir(), 'model-persistence-test-' + crypto.randomBytes(4).toString('hex'));
  const suiteDir = path.join(sandbox, 'suite');
  const data = path.join(suiteDir, 'data');
  const modelPath = path.join(data, 'model.json');
  const modePath = path.join(data, '__model-persist-test-mode');
  let child = null;
  let port = null;

  const setMode = (mode) => {
    if (mode) fs.writeFileSync(modePath, mode);
    else fs.rmSync(modePath, { force: true });
  };
  try {
    fs.cpSync(HERE, suiteDir, { recursive: true });
    fs.rmSync(path.join(data, 'com_host.pid.json'), { force: true });
    fs.rmSync(path.join(data, 'agents.pid.json'), { force: true });
    prepareState(suiteDir);
    patchServerForTest(suiteDir);
    port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const state = async () => (await api(base, '/api/state')).body;
    const history = async () => (await api(base, '/api/history')).body;
    const post = (route, body) => api(base, route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const editTitle = (text) => post('/api/edit', { editor: 'persist-test', op: { type: 'set-presentation-title', text } });

    child = startServer(suiteDir, port);
    await waitFor('persistence sandbox health', async () => (await fetch(base + '/api/health')).ok, 8000);

    for (const mode of ['temp', 'final']) {
      const before = await state();
      const diskBefore = fs.readFileSync(modelPath, 'utf8');
      setMode(mode);
      const response = await within(`${mode} failed edit response`, editTitle(`__${mode}_failure__`), 2500);
      setMode('');
      const after = await state();
      const diskAfter = fs.readFileSync(modelPath, 'utf8');
      check(`${mode}: failed edit returns a timely 500`, response.status === 500 && response.body && response.body.ok === false);
      check(`${mode}: failed edit leaves memory/history unchanged`, modelSignature(after) === modelSignature(before));
      check(`${mode}: failed edit leaves model.json byte-for-byte unchanged`, diskAfter === diskBefore);
    }

    // Deleting a slide used to mutate the global lock before persistence. A
    // failed delete must leave its old slide and its advisory claim together.
    const deleteTarget = (await state()).model.slides[0];
    const lock = await post('/api/locks', { by: 'persist-test', slideId: deleteTarget.id });
    const beforeDelete = await state();
    setMode('final');
    const deleteFailure = await within('failed delete response', post('/api/edit', { editor: 'persist-test', op: { type: 'delete-slide', slideId: deleteTarget.id } }), 2500);
    setMode('');
    const afterDelete = await state();
    check('failed delete returns 500', lock.status === 200 && deleteFailure.status === 500 && deleteFailure.body && deleteFailure.body.ok === false);
    check('failed delete preserves both slide and claim',
      afterDelete.model.slides.some((slide) => slide.id === deleteTarget.id)
        && afterDelete.locks.some((item) => item.slideId === deleteTarget.id)
        && modelSignature(afterDelete) === modelSignature(beforeDelete));

    const successTitle = '__persist_success__';
    const successEdit = await editTitle(successTitle);
    const afterSuccess = await state();
    const historyAfterSuccess = await history();
    check('normal edit still succeeds and creates undo history',
      successEdit.status === 200 && successEdit.body && successEdit.body.ok === true
        && afterSuccess.model.title === successTitle && afterSuccess.undoCount === 1 && afterSuccess.redoCount === 0
        && historyAfterSuccess.undo.length === 1 && historyAfterSuccess.redo.length === 0);

    setMode('final');
    const undoFailure = await within('failed undo response', post('/api/undo', { editor: 'persist-test' }), 2500);
    setMode('');
    const afterUndoFailure = await state();
    check('failed undo returns 500 without moving history or model',
      undoFailure.status === 500 && modelSignature(afterUndoFailure) === modelSignature(afterSuccess));

    const undoSuccess = await post('/api/undo', { editor: 'persist-test' });
    const afterUndo = await state();
    check('undo retries successfully after storage recovers',
      undoSuccess.status === 200 && afterUndo.model.title !== successTitle && afterUndo.undoCount === 0 && afterUndo.redoCount === 1);

    setMode('temp');
    const redoFailure = await within('failed redo response', post('/api/redo', { editor: 'persist-test' }), 2500);
    setMode('');
    const afterRedoFailure = await state();
    check('failed redo returns 500 without moving history or model',
      redoFailure.status === 500 && modelSignature(afterRedoFailure) === modelSignature(afterUndo));

    const redoSuccess = await post('/api/redo', { editor: 'persist-test' });
    const beforeRestart = await state();
    check('redo retries successfully after storage recovers',
      redoSuccess.status === 200 && beforeRestart.model.title === successTitle && beforeRestart.undoCount === 1 && beforeRestart.redoCount === 0);

    await stopServer(child); child = null;
    child = startServer(suiteDir, port);
    await waitFor('restarted persistence sandbox health', async () => (await fetch(base + '/api/health')).ok, 8000);
    const afterRestart = await state();
    const diskAfterRestart = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
    check('restart retains only the committed model',
      afterRestart.model.title === successTitle && afterRestart.model.rev === beforeRestart.model.rev
        && diskAfterRestart.title === successTitle && diskAfterRestart.rev === beforeRestart.model.rev);
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
