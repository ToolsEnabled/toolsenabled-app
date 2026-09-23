#!/usr/bin/env node
'use strict';
/*
 * Durable content-protection integration tests.
 *
 * The real coordinator cannot be required without binding a port, so this
 * builds a minimal suite in an OS temp directory from source files only. It
 * never reads or writes suite/data, presentation.pptx, the live port, or any
 * live process marker. The child is patched only inside that throwaway copy
 * to disable rendering and inject deterministic state-write failures.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const HERE = __dirname;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
function check(description, condition, detail) {
  checks.push({ description, ok: !!condition, detail: condition ? undefined : detail });
}

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
  const response = await fetch(base + route, options);
  return {
    status: response.status,
    body: await response.json().catch(() => null)
  };
}

async function waitFor(description, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await predicate()) return; }
    catch (error) {
      if (error && /^sandbox server exited:/.test(error.message || '')) throw error;
    }
    await sleep(30);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try { child.kill(); } catch (_) {}
  await Promise.race([exited, sleep(1500)]);
}

function copySourceSuite(suiteDir) {
  fs.mkdirSync(suiteDir, { recursive: true });
  for (const name of ['server.js', 'agents.js', 'codex-agent.js', 'ppt.js']) {
    fs.copyFileSync(path.join(HERE, name), path.join(suiteDir, name));
  }
}

function testModel(dataDir) {
  return {
    title: 'Protection Test Deck',
    mode: 'overlay',
    base: path.join(dataDir, 'base.pptx'),
    theme: { accent: '#2563eb' },
    rev: 0,
    updatedAt: null,
    slides: [
      {
        id: 's1',
        src: 0,
        layout: 'content',
        notes: '',
        elements: [
          {
            id: 'e1', type: 'title', text: 'Protected title',
            ref: { s: 0, sid: 1 }, sourcePreset: 'roundRect',
            box: { x: 0.1, y: 0.1, w: 0.8, h: 0.1 }
          },
          {
            id: 'e2', type: 'body', text: 'Editable sibling',
            ref: { s: 0, sid: 2 }, box: { x: 0.1, y: 0.3, w: 0.8, h: 0.2 }
          }
        ],
        decor: [
          {
            id: 'path-guy', kind: 'pic', sid: 3,
            box: { x: 0.05, y: 0.55, w: 0.2, h: 0.3 }
          },
          {
            id: 'kaiju', kind: 'pic', sid: 4,
            box: { x: 0.3, y: 0.55, w: 0.2, h: 0.3 }
          },
          {
            id: 'dshape', kind: 'shape', sid: 5, fill: '#112233',
            sourcePreset: 'roundRect',
            box: { x: 0.55, y: 0.55, w: 0.2, h: 0.3 }
          },
          {
            id: 'media1', kind: 'media', sid: null, generated: true,
            source: 'assets/test.mp4',
            box: { x: 0.78, y: 0.55, w: 0.2, h: 0.3 },
            autoplay: true, loop: true
          }
        ]
      },
      {
        id: 's2',
        layout: 'content',
        notes: '',
        elements: [
          { id: 'e3', type: 'title', text: 'Second slide' },
          { id: 'e4', type: 'body', text: 'Unrelated content' }
        ],
        decor: [{
          id: 'other-generated', kind: 'pic', sid: null, generated: true,
          source: 'assets/other/test.png',
          box: { x: 0.05, y: 0.75, w: 0.1, h: 0.1 }
        }, {
          id: 'other-generated-shape', kind: 'shape', sid: null, generated: true,
          shapeType: 'rect', fill: '#112233',
          box: { x: 0.2, y: 0.75, w: 0.1, h: 0.1 }
        }, {
          id: 'other-imported-picture', kind: 'pic', sid: 77,
          box: { x: 0.35, y: 0.75, w: 0.1, h: 0.1 }
        }]
      },
      {
        id: 's3',
        layout: 'content',
        notes: '',
        elements: [
          { id: 'e5', type: 'title', text: 'Third slide' },
          { id: 'e6', type: 'body', text: 'Delete history target' }
        ],
        decor: []
      }
    ]
  };
}

function writeFixtureData(suiteDir) {
  const dataDir = path.join(suiteDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  // Pause verifies the root PPTX read-only lock. A tiny private placeholder is
  // enough because this suite never renders or opens it.
  fs.writeFileSync(path.join(suiteDir, '..', 'presentation.pptx'), Buffer.from('PK'));
  const microheaderDir = path.join(suiteDir, '..', 'assets', 'microheaders');
  fs.mkdirSync(microheaderDir, { recursive: true });
  fs.writeFileSync(
    path.join(microheaderDir, 'test.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+WjR7WQAAAABJRU5ErkJggg==', 'base64')
  );
  const otherAssetDir = path.join(suiteDir, '..', 'assets', 'other');
  fs.mkdirSync(otherAssetDir, { recursive: true });
  fs.copyFileSync(path.join(microheaderDir, 'test.png'), path.join(otherAssetDir, 'test.png'));
  fs.writeFileSync(path.join(dataDir, 'model.json'), JSON.stringify(testModel(dataDir), null, 2));
  // Deliberately omit protections: this is the supported legacy state shape.
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({
    paused: false, pausedBy: null, pausedAt: null, pdfRev: null,
    log: [], loopRunner: false, usageProfile: 'normal', agentProvider: 'claude'
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'board.json'), JSON.stringify({
    notes: [],
    tasks: [
      {
        id: 't-protection', text: 'Human-authorized protection test', by: 'human-test',
        assignee: 'worker-1', wakeWorker: false, status: 'open', claimedBy: '',
        ts: 1, doneTs: null
      },
      {
        id: 't-expired', text: 'Expired protection grant fixture', by: 'human-test',
        assignee: 'worker-2', wakeWorker: false, status: 'open', claimedBy: '',
        ts: 2, doneTs: null,
        protectionGrant: {
          version: 1, slideIds: ['s2'], editOps: ['add-image'],
          protectionModes: ['direct-generated-decor'],
          grantedTo: 'worker-2', grantedBy: 'human-test',
          grantedAt: 1, expiresAt: 2
        }
      },
      {
        id: 't-reassign', text: 'Reassigned protection grant fixture', by: 'human-test',
        assignee: 'worker-1', wakeWorker: false, status: 'open', claimedBy: '',
        ts: 3, doneTs: null
      },
      {
        id: 't-complete', text: 'Completed protection grant fixture', by: 'human-test',
        assignee: 'worker-5', wakeWorker: false, status: 'open', claimedBy: '',
        ts: 4, doneTs: null
      }
    ],
    loops: []
  }, null, 2));
}

function patchSandboxServer(suiteDir) {
  const serverPath = path.join(suiteDir, 'server.js');
  let source = fs.readFileSync(serverPath, 'utf8');

  const platformNeedle = "const IS_WIN = process.platform === 'win32';";
  if (!source.includes(platformNeedle)) throw new Error('could not isolate Windows work');
  source = source.replace(platformNeedle, 'const IS_WIN = false; // protection test sandbox');
  const historyLimitNeedle = 'const PROTECTION_HISTORY_LIMIT = 200;';
  if (!source.includes(historyLimitNeedle)) throw new Error('could not bound protection history fixture');
  source = source.replace(
    historyLimitNeedle,
    'const PROTECTION_HISTORY_LIMIT = 12; // protection test sandbox'
  );

  const pathNeedle = "const COM_HOST_PID_PATH = path.join(DATA, 'com_host.pid.json');";
  if (!source.includes(pathNeedle)) throw new Error('could not inject state failure hook');
  source = source.replace(pathNeedle, pathNeedle + `
const __protectionModePath = path.join(DATA, '__protection-test-mode');
const __protectionEventsPath = path.join(DATA, '__protection-events.jsonl');
const __protectionWriteFileSync = fs.writeFileSync.bind(fs);
const __protectionRenameSync = fs.renameSync.bind(fs);
function __protectionMode() {
  try { return fs.readFileSync(__protectionModePath, 'utf8').trim(); } catch (_) { return ''; }
}
function __protectionError() {
  const error = new Error('forced protection state persistence failure');
  error.code = 'EPERM';
  return error;
}
fs.writeFileSync = function(file, data, ...args) {
  if (__protectionMode() === 'temp' && String(file).startsWith(STATE_PATH + '.')) {
    throw __protectionError();
  }
  return __protectionWriteFileSync(file, data, ...args);
};
fs.renameSync = function(from, to) {
  if (__protectionMode() === 'final' && String(to) === STATE_PATH) {
    throw __protectionError();
  }
  return __protectionRenameSync(from, to);
};
const __protectionIsAgent = Agents.isAgent.bind(Agents);
Agents.isAgent = (name) => String(name) === 'worker-1' || __protectionIsAgent(name);`);

  const broadcastNeedle = 'function broadcast(event) {';
  if (!source.includes(broadcastNeedle)) throw new Error('could not trace broadcasts');
  source = source.replace(broadcastNeedle, `function broadcast(event) {
  try { fs.appendFileSync(__protectionEventsPath, JSON.stringify(event) + '\\n'); } catch (_) {}`);

  if (!source.includes('  await migrateModel();')) throw new Error('could not skip migration');
  source = source.replace('  await migrateModel();', '  // protection test: fixture model is already canonical');
  if (!source.includes('function scheduleRender() {')) throw new Error('could not isolate rendering');
  source = source.replace(
    'function scheduleRender() {',
    'function scheduleRender() {\n  if (process.env.SUITE_PROTECTION_TEST) return;'
  );
  fs.writeFileSync(serverPath, source);
}

function startServer(suiteDir, port, capture) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: suiteDir,
    windowsHide: true,
    env: Object.assign({}, process.env, {
      SUITE_PORT: String(port),
      SUITE_HOST: '127.0.0.1',
      SUITE_PROTECTION_TEST: '1'
    }),
    stdio: ['ignore', capture ? 'pipe' : 'ignore', capture ? 'pipe' : 'ignore']
  });
  if (capture) {
    child.output = '';
    child.stdout.on('data', (chunk) => { child.output += chunk; });
    child.stderr.on('data', (chunk) => { child.output += chunk; });
  }
  return child;
}

function runCli(suiteDir, port, editor, args) {
  return spawnSync(process.execPath, ['ppt.js', ...args], {
    cwd: suiteDir,
    windowsHide: true,
    env: Object.assign({}, process.env, {
      SUITE_PORT: String(port),
      SUITE_HOST: '127.0.0.1',
      SUITE_EDITOR: editor,
      SUITE_HTTP_TIMEOUT_MS: '3000',
      NO_COLOR: '1'
    }),
    encoding: 'utf8',
    timeout: 6000
  });
}

function readEvents(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (_) {
    return [];
  }
}

function stateSignature(snapshot) {
  return JSON.stringify({
    model: snapshot.model,
    undoCount: snapshot.undoCount,
    redoCount: snapshot.redoCount,
    protections: snapshot.protections,
    protectionExceptions: snapshot.protectionExceptions,
    protectionHistory: snapshot.protectionHistory,
    locks: snapshot.locks
  });
}

async function expectStartupFailure(suiteDir, port, description, expectedText) {
  const before = fs.readFileSync(path.join(suiteDir, 'data', 'state.json'), 'utf8');
  const child = startServer(suiteDir, port, true);
  await waitFor(description, () => child.exitCode !== null, 5000);
  check(description,
    child.exitCode !== 0 && child.output.includes(expectedText) &&
    fs.readFileSync(path.join(suiteDir, 'data', 'state.json'), 'utf8') === before);
}

async function main() {
  const sandbox = path.join(os.tmpdir(), 'suite-protections-' + crypto.randomBytes(4).toString('hex'));
  const suiteDir = path.join(sandbox, 'suite');
  const dataDir = path.join(suiteDir, 'data');
  const statePath = path.join(dataDir, 'state.json');
  const modePath = path.join(dataDir, '__protection-test-mode');
  const eventsPath = path.join(dataDir, '__protection-events.jsonl');
  let child = null;
  let port = null;

  const setMode = (mode) => {
    if (mode) fs.writeFileSync(modePath, mode);
    else fs.rmSync(modePath, { force: true });
  };

  try {
    copySourceSuite(suiteDir);
    writeFixtureData(suiteDir);
    patchSandboxServer(suiteDir);
    port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const getState = async () => {
      try { return (await api(base, '/api/state')).body; }
      catch (error) {
        throw new Error(`${error && (error.stack || error)}\nprotection sandbox output:\n${child && child.output || ''}`);
      }
    };
    const getHistory = async () => (await api(base, '/api/history')).body;
    const post = (route, body, headers) => api(base, route, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
      body: JSON.stringify(body || {})
    });
    const toggle = (body) => post('/api/protections/toggle', Object.assign({ by: 'human-test' }, body));
    const edit = (op) => post('/api/edit', { editor: 'editor-test', op });

    child = startServer(suiteDir, port, true);
    await waitFor('legacy-state sandbox health', async () => {
      if (child.exitCode !== null) {
        throw new Error(`sandbox server exited: ${child.output || child.exitCode}`);
      }
      return (await fetch(base + '/api/health')).ok;
    });

    const legacyState = await getState();
    const legacyList = await api(base, '/api/protections');
    check('legacy state without protections boots with an empty canonical array',
      Array.isArray(legacyState.protections) && legacyState.protections.length === 0 &&
      Array.isArray(legacyState.protectionExceptions) && legacyState.protectionExceptions.length === 0 &&
      Array.isArray(legacyState.protectionHistory) && legacyState.protectionHistory.length === 0 &&
      legacyList.status === 200 && Array.isArray(legacyList.body.protections) &&
      legacyList.body.protections.length === 0 &&
      Array.isArray(legacyList.body.protectionExceptions) &&
      legacyList.body.protectionExceptions.length === 0 &&
      Array.isArray(legacyList.body.protectionHistory) &&
      legacyList.body.protectionHistory.length === 0);
    check('protection list is exposed in the SSE/state snapshot shape',
      Object.prototype.hasOwnProperty.call(legacyState, 'protections') &&
      Object.prototype.hasOwnProperty.call(legacyState, 'protectionExceptions') &&
      Object.prototype.hasOwnProperty.call(legacyState, 'protectionHistory'));

    const initialDisk = fs.readFileSync(statePath, 'utf8');
    const invalidBodies = [
      { kind: 'other', slideId: 's1', protected: true },
      { kind: 'slide', slideId: 's1', protected: 'true' },
      { kind: 'slide', slideId: 'missing', protected: true },
      { kind: 'object', slideId: 's1', objectId: 'e1', objectKind: 'other', protected: true },
      { kind: 'object', slideId: 's1', objectId: 'missing', objectKind: 'element', protected: true },
      { kind: 'object', slideId: 's1', objectId: 'path-guy', objectKind: 'element', protected: true }
    ];
    const invalidResponses = [];
    for (const body of invalidBodies) invalidResponses.push(await toggle(body));
    invalidResponses.push(await post('/api/protections/toggle', {
      kind: 'slide', slideId: 's1', protected: true
    }));
    const textPost = await api(base, '/api/protections/toggle', {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}'
    });
    const foreignPost = await post('/api/protections/toggle', {
      kind: 'slide', slideId: 's1', protected: true, by: 'human-test'
    }, { Origin: 'http://evil.example' });
    check('malformed, missing-identity, non-JSON, and foreign-origin toggles fail before state mutation',
      invalidResponses.every((response) => response.status === 400) &&
      textPost.status === 415 && foreignPost.status === 403 &&
      fs.readFileSync(statePath, 'utf8') === initialDisk &&
      (await getState()).protections.length === 0);

    for (const mode of ['temp', 'final']) {
      fs.writeFileSync(eventsPath, '');
      const before = await getState();
      const diskBefore = fs.readFileSync(statePath, 'utf8');
      setMode(mode);
      const failed = await toggle({ kind: 'slide', slideId: 's1', protected: true });
      setMode('');
      const after = await getState();
      check(`${mode} state-write failure leaves protection memory/disk/history unchanged`,
        failed.status === 500 && stateSignature(after) === stateSignature(before) &&
        fs.readFileSync(statePath, 'utf8') === diskBefore &&
        !readEvents(eventsPath).some((event) => event.type === 'protections'));
    }

    fs.writeFileSync(eventsPath, '');
    const beforeProtect = await getState();
    const protectedSlide = await toggle({ kind: 'slide', slideId: 's1', protected: true });
    const afterProtect = await getState();
    const persistedAfterProtect = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const persistedSlide = persistedAfterProtect.protections[0];
    const persistedLock = persistedAfterProtect.protectionHistory[0];
    check('slide protection is atomic, canonical, outside model history, and broadcast after commit',
      protectedSlide.status === 200 && protectedSlide.body.changed === true &&
      afterProtect.model.rev === beforeProtect.model.rev &&
      afterProtect.undoCount === beforeProtect.undoCount &&
      persistedSlide.kind === 'slide' && persistedSlide.slideId === 's1' &&
      persistedSlide.by === 'human-test' && Number.isSafeInteger(persistedSlide.createdAt) &&
      persistedLock.action === 'lock' && persistedLock.kind === 'slide' &&
      persistedLock.slideId === 's1' && persistedLock.by === 'human-test' &&
      Number.isSafeInteger(persistedLock.ts) &&
      readEvents(eventsPath).some((event) =>
        event.type === 'protections' && event.protections.some((item) => item.slideId === 's1') &&
        event.change && event.change.action === 'lock' &&
        Array.isArray(event.protectionHistory)));

    fs.writeFileSync(eventsPath, '');
    const duplicate = await toggle({ kind: 'slide', slideId: 's1', protected: true });
    const duplicateState = await getState();
    check('protect is idempotent and creates no duplicate or event',
      duplicate.status === 200 && duplicate.body.changed === false &&
      duplicateState.protections.filter((item) => item.kind === 'slide' && item.slideId === 's1').length === 1 &&
      duplicateState.protectionHistory.length === afterProtect.protectionHistory.length &&
      !readEvents(eventsPath).some((event) => event.type === 'protections'));

    const agentProtect = await post('/api/protections/toggle', {
      kind: 'object', slideId: 's1', objectId: 'e1', objectKind: 'element',
      protected: true, by: 'worker-1'
    });
    const agentUnprotect = await post('/api/protections/toggle', {
      kind: 'slide', slideId: 's1', protected: false, by: 'worker-1'
    });
    check('agents cannot create or remove protections',
      agentProtect.status === 403 && agentUnprotect.status === 403 &&
      (await getState()).protections.length === 1);

    // The human keeps the slide lock in place throughout delegated insertion.
    // The capability must pass through this exact lock without removing or
    // rebuilding any part of the protection tree.
    const humanPrelock = await toggle({ kind: 'slide', slideId: 's2', protected: true });
    const agentGrant = await post('/api/tasks/protection-grant', {
      id: 't-protection', slideIds: ['s2'], minutes: 30, by: 'worker-1'
    });
    const offlineAgentGrant = await post('/api/tasks/protection-grant', {
      id: 't-protection', slideIds: ['s2'], minutes: 30, by: 'media-1'
    });
    const humanGrant = await post('/api/tasks/protection-grant', {
      id: 't-protection', slideIds: ['s2'], minutes: 30, by: 'human-test'
    });
    const beforeProtectedNativeBox = await getState();
    const protectedNativeBox = await post('/api/edit', {
      editor: 'worker-1',
      op: {
        type: 'set-box', slideId: 's2', elementId: 'e3',
        x: 0.08, y: 0.06, w: 0.84, h: 0.12
      }
    });
    const afterProtectedNativeBox = await getState();
    check('a hard-protected native text element refuses explicit geometry without mutation',
      protectedNativeBox.status === 423 &&
      JSON.stringify(afterProtectedNativeBox.model) === JSON.stringify(beforeProtectedNativeBox.model) &&
      afterProtectedNativeBox.undoCount === beforeProtectedNativeBox.undoCount &&
      afterProtectedNativeBox.redoCount === beforeProtectedNativeBox.redoCount);
    const overwriteGrant = await post('/api/tasks/protection-grant', {
      id: 't-protection', slideIds: ['s2'], minutes: 30, by: 'human-test'
    });
    const wrongTask = await post('/api/protections/toggle', {
      kind: 'slide', slideId: 's2', protected: true, by: 'worker-1',
      taskId: 'missing-task', delegatedMode: 'direct-generated-decor'
    });
    const wrongSlide = await post('/api/protections/toggle', {
      kind: 'object', slideId: 's3', objectId: 'e5', objectKind: 'element',
      protected: true, by: 'worker-1', taskId: 't-protection',
      delegatedMode: 'direct-generated-decor'
    });
    const delegatedSlideProtect = await post('/api/protections/toggle', {
      kind: 'slide', slideId: 's2', protected: true, by: 'worker-1',
      taskId: 't-protection', delegatedMode: 'direct-generated-decor'
    });
    const removedEnsureSlideMode = await post('/api/protections/toggle', {
      kind: 'slide', slideId: 's2', protected: true, by: 'worker-1',
      taskId: 't-protection', delegatedMode: 'ensure-slide'
    });
    const delegatedState = await getState();
    check('a human can grant task-scoped generated-picture control without transferring whole-slide locking',
      humanPrelock.status === 200 && humanPrelock.body.changed === true &&
      agentGrant.status === 403 && offlineAgentGrant.status === 403 &&
      humanGrant.status === 200 && overwriteGrant.status === 409 &&
      wrongTask.status === 403 && wrongSlide.status === 403 &&
      delegatedSlideProtect.status === 403 && removedEnsureSlideMode.status === 403 &&
      JSON.stringify(humanGrant.body.task.protectionGrant.protectionModes) ===
        JSON.stringify(['direct-generated-decor']) &&
      delegatedState.protections.some((item) =>
        item.kind === 'slide' && item.slideId === 's2' && item.by === 'human-test') &&
      !delegatedState.protections.some((item) => item.by === 'worker-1') &&
      !delegatedState.protectionHistory.some((item) => item.taskId === 't-protection'));

    const beforePausedDelegation = await getState();
    const pausedForDelegation = await post('/api/pause', { by: 'human-test' });
    const pausedDelegatedImage = await post('/api/edit', {
      editor: 'worker-1', taskId: 't-protection',
      op: {
        type: 'add-image', slideId: 's2', source: 'assets/other/test.png',
        x: 0.56, y: 0.006, w: 0.4, h: 0.045
      }
    });
    const pausedDelegatedProtect = await post('/api/protections/toggle', {
      kind: 'object', slideId: 's2', objectId: 'other-generated', objectKind: 'decor',
      protected: true, by: 'worker-1', taskId: 't-protection',
      delegatedMode: 'direct-generated-decor'
    });
    const pausedNativeBox = await post('/api/edit', {
      editor: 'worker-1',
      op: {
        type: 'set-box', slideId: 's3', elementId: 'e5',
        x: 0.08, y: 0.06, w: 0.84, h: 0.12
      }
    });
    const duringPausedDelegation = await getState();
    const resumedAfterDelegation = await post('/api/resume', { by: 'human-test' });
    check('the human pause hard-stop precedes and defeats an otherwise valid delegated edit',
      pausedForDelegation.status === 200 && pausedDelegatedImage.status === 423 &&
      pausedDelegatedImage.body.error === 'paused' && pausedDelegatedProtect.status === 423 &&
      pausedDelegatedProtect.body.error === 'paused' && pausedNativeBox.status === 423 &&
      pausedNativeBox.body.error === 'paused' && resumedAfterDelegation.status === 200 &&
      duringPausedDelegation.model.rev === beforePausedDelegation.model.rev &&
      duringPausedDelegation.undoCount === beforePausedDelegation.undoCount &&
      duringPausedDelegation.redoCount === beforePausedDelegation.redoCount &&
      JSON.stringify(duringPausedDelegation.protections) ===
        JSON.stringify(beforePausedDelegation.protections) &&
      JSON.stringify(duringPausedDelegation.locks) === JSON.stringify(beforePausedDelegation.locks));

    const delegatedUnprotect = await post('/api/protections/toggle', {
      kind: 'object', slideId: 's2', objectId: 'other-generated', objectKind: 'decor',
      protected: false, by: 'worker-1', taskId: 't-protection',
      delegatedMode: 'direct-generated-decor'
    });
    const wrongDelegatedEdit = await post('/api/edit', {
      editor: 'worker-1', taskId: 't-protection',
      op: { type: 'set-text', slideId: 's2', elementId: 'e3', text: 'must not apply' }
    });
    const wrongDelegatedNativeBox = await post('/api/edit', {
      editor: 'worker-1', taskId: 't-protection',
      op: {
        type: 'set-box', slideId: 's2', elementId: 'e3',
        x: 0.08, y: 0.06, w: 0.84, h: 0.12
      }
    });
    const advisoryLock = await post('/api/locks', {
      slideIds: ['s2'], by: 'other-owner', note: 'delegated grant regression'
    });
    const delegatedAssetImage = await post('/api/edit', {
      editor: 'worker-1', taskId: 't-protection',
      op: {
        type: 'add-image', slideId: 's2', source: 'assets/other/test.png',
        x: 0.56, y: 0.006, w: 0.4, h: 0.045
      }
    });
    const delegatedAssetId = delegatedAssetImage.body && delegatedAssetImage.body.affected &&
      delegatedAssetImage.body.affected.decorId;
    const delegatedAssetProtect = await post('/api/protections/toggle', {
      kind: 'object', slideId: 's2', objectId: delegatedAssetId, objectKind: 'decor',
      protected: true, by: 'worker-1', taskId: 't-protection',
      delegatedMode: 'direct-generated-decor'
    });
    const wrongActorImage = await post('/api/edit', {
      editor: 'worker-3', taskId: 't-protection',
      op: {
        type: 'add-image', slideId: 's2', source: 'assets/other/test.png',
        x: 0.56, y: 0.006, w: 0.4, h: 0.045
      }
    });
    const outsideAssetImage = await post('/api/edit', {
      editor: 'worker-1', taskId: 't-protection',
      op: {
        type: 'add-image', slideId: 's2', source: '../outside.png',
        x: 0.56, y: 0.006, w: 0.4, h: 0.045
      }
    });
    const wrongSlideImage = await post('/api/edit', {
      editor: 'worker-1', taskId: 't-protection',
      op: {
        type: 'add-image', slideId: 's3', source: 'assets/microheaders/test.png',
        x: 0.56, y: 0.006, w: 0.4, h: 0.045
      }
    });
    const noTaskProtectedImage = await post('/api/edit', {
      editor: 'worker-1',
      op: {
        type: 'add-image', slideId: 's2', source: 'assets/other/test.png',
        x: 0.56, y: 0.006, w: 0.4, h: 0.045
      }
    });
    const wrongGeneratedShapeProtect = await post('/api/protections/toggle', {
      kind: 'object', slideId: 's2', objectId: 'other-generated-shape', objectKind: 'decor',
      protected: true, by: 'worker-1', taskId: 't-protection',
      delegatedMode: 'direct-generated-decor'
    });
    const wrongImportedPictureProtect = await post('/api/protections/toggle', {
      kind: 'object', slideId: 's2', objectId: 'other-imported-picture', objectKind: 'decor',
      protected: true, by: 'worker-1', taskId: 't-protection',
      delegatedMode: 'direct-generated-decor'
    });
    const wrongElementProtect = await post('/api/protections/toggle', {
      kind: 'object', slideId: 's2', objectId: 'e3', objectKind: 'element',
      protected: true, by: 'worker-1', taskId: 't-protection',
      delegatedMode: 'direct-generated-decor'
    });
    const expiredImage = await post('/api/edit', {
      editor: 'worker-2', taskId: 't-expired',
      op: {
        type: 'add-image', slideId: 's2', source: 'assets/microheaders/test.png',
        x: 0.56, y: 0.006, w: 0.4, h: 0.045
      }
    });

    const afterDelegatedAsset = await getState();
    const advisoryUnlock = await post('/api/locks/release', {
      slideIds: ['s2'], by: 'other-owner'
    });

    const reassignGrant = await post('/api/tasks/protection-grant', {
      id: 't-reassign', slideIds: ['s2'], minutes: 30, by: 'human-test'
    });
    const reassigned = await post('/api/tasks/update', {
      id: 't-reassign', assignee: 'worker-2', wakeWorker: false, by: 'human-test'
    });
    const oldAssigneeImage = await post('/api/edit', {
      editor: 'worker-1', taskId: 't-reassign',
      op: {
        type: 'add-image', slideId: 's2', source: 'assets/microheaders/test.png',
        x: 0.56, y: 0.006, w: 0.4, h: 0.045
      }
    });
    const newAssigneeImage = await post('/api/edit', {
      editor: 'worker-2', taskId: 't-reassign',
      op: {
        type: 'add-image', slideId: 's2', source: 'assets/microheaders/test.png',
        x: 0.56, y: 0.006, w: 0.4, h: 0.045
      }
    });

    const completionGrant = await post('/api/tasks/protection-grant', {
      id: 't-complete', slideIds: ['s2'], minutes: 30, by: 'human-test'
    });
    const completedGrantTask = await post('/api/tasks/done', {
      id: 't-complete', by: 'worker-5'
    });
    const completedTaskImage = await post('/api/edit', {
      editor: 'worker-5', taskId: 't-complete',
      op: {
        type: 'add-image', slideId: 's2', source: 'assets/microheaders/test.png',
        x: 0.56, y: 0.006, w: 0.4, h: 0.045
      }
    });
    check('an explicit grant allows only its named image and generated-picture operations on its named slide',
      advisoryLock.status === 200 && delegatedAssetImage.status === 200 &&
      typeof delegatedAssetId === 'string' && delegatedAssetImage.body.delegation.taskId === 't-protection' &&
      /locked by other-owner/i.test(delegatedAssetImage.body.warning || '') &&
      delegatedAssetProtect.status === 200 && delegatedAssetProtect.body.changed === true &&
      delegatedAssetProtect.body.delegation.taskId === 't-protection' &&
      afterDelegatedAsset.protections.some((item) =>
        item.kind === 'slide' && item.slideId === 's2' && item.by === 'human-test') &&
      afterDelegatedAsset.protections.some((item) =>
        item.kind === 'object' && item.slideId === 's2' && item.objectId === delegatedAssetId) &&
      afterDelegatedAsset.locks.some((item) => item.slideId === 's2' && item.by === 'other-owner') &&
      afterDelegatedAsset.model.slides.find((slide) => slide.id === 's2').decor.filter((item) =>
        item.source === 'assets/other/test.png').length === 2 &&
      advisoryUnlock.status === 200 && advisoryUnlock.body.released === true);

    check('delegated authority fails closed for other actors, paths, operations, targets, expiry, reassignment, and completion',
      delegatedUnprotect.status === 403 && wrongDelegatedEdit.status === 403 &&
      wrongDelegatedNativeBox.status === 403 &&
      wrongActorImage.status === 403 && outsideAssetImage.status === 400 &&
      wrongSlideImage.status === 403 && noTaskProtectedImage.status === 423 &&
      wrongGeneratedShapeProtect.status === 403 && wrongImportedPictureProtect.status === 403 &&
      wrongElementProtect.status === 403 &&
      expiredImage.status === 403 && /expired/i.test(expiredImage.body.error) &&
      reassignGrant.status === 200 && reassigned.status === 200 &&
      oldAssigneeImage.status === 403 && newAssigneeImage.status === 403 &&
      completionGrant.status === 200 && completedGrantTask.status === 200 &&
      completedTaskImage.status === 403 && /done/i.test(completedTaskImage.body.error),
      JSON.stringify({
        delegatedUnprotect, wrongDelegatedEdit, wrongActorImage, outsideAssetImage,
        wrongSlideImage, noTaskProtectedImage, wrongGeneratedShapeProtect,
        wrongImportedPictureProtect, wrongElementProtect, expiredImage, reassignGrant,
        reassigned, oldAssigneeImage, newAssigneeImage, completionGrant,
        completedGrantTask, completedTaskImage
      }, null, 2));

    const beforeDelegatedImage = await getState();
    const delegatedImage = await post('/api/edit', {
      editor: 'worker-1', taskId: 't-protection',
      op: {
        type: 'add-image', slideId: 's2', source: 'assets/microheaders/test.png',
        x: 0.56, y: 0.006, w: 0.4, h: 0.045
      }
    });
    const headerId = delegatedImage.body && delegatedImage.body.affected && delegatedImage.body.affected.decorId;
    const delegatedHeaderProtect = await post('/api/protections/toggle', {
      kind: 'object', slideId: 's2', objectId: headerId, objectKind: 'decor',
      protected: true, by: 'worker-1', taskId: 't-protection',
      delegatedMode: 'direct-generated-decor'
    });
    const cliDelegatedProtect = runCli(
      suiteDir, port, 'worker-1', ['protect', 's2', headerId, '--task', 't-protection']
    );
    const cliDelegatedSlideProtect = runCli(
      suiteDir, port, 'worker-1', ['protect', 's2', '--task', 't-protection']
    );
    const cliDelegatedUnprotect = runCli(
      suiteDir, port, 'worker-1', ['unprotect', 's2', headerId, '--task', 't-protection']
    );
    const afterDelegatedImage = await getState();
    check('delegated image insertion bypasses only the protected add-image and keeps prior locks',
      delegatedImage.status === 200 && typeof headerId === 'string' &&
      delegatedImage.body.delegation.taskId === 't-protection' &&
      delegatedHeaderProtect.status === 200 && delegatedHeaderProtect.body.changed === true &&
      delegatedHeaderProtect.body.delegation.taskId === 't-protection' &&
      delegatedHeaderProtect.body.delegation.authorizedBy === 'human-test' &&
      cliDelegatedProtect.status === 0 && cliDelegatedSlideProtect.status === 1 &&
      cliDelegatedUnprotect.status === 1 &&
      beforeDelegatedImage.protections.every((item) =>
        afterDelegatedImage.protections.some((next) =>
          next.kind === item.kind && next.slideId === item.slideId &&
          next.objectId === item.objectId && next.objectKind === item.objectKind)) &&
      afterDelegatedImage.protections.some((item) =>
        item.kind === 'object' && item.slideId === 's2' && item.objectId === headerId) &&
      afterDelegatedImage.protectionHistory.some((item) =>
        item.kind === 'object' && item.slideId === 's2' && item.objectId === headerId &&
        item.taskId === 't-protection' && item.authorizedBy === 'human-test') &&
      afterDelegatedImage.log.some((item) =>
        item.kind === 'protect' && item.by === 'worker-1' &&
        item.authorizationTaskId === 't-protection' && item.authorizedBy === 'human-test') &&
      afterDelegatedImage.model.slides.find((slide) => slide.id === 's2').decor.some((item) =>
        item.id === headerId && item.source === 'assets/microheaders/test.png'));

    const humanRevoke = await post('/api/tasks/protection-grant', {
      id: 't-protection', revoke: true, by: 'human-test'
    });
    const revokedImage = await post('/api/edit', {
      editor: 'worker-1', taskId: 't-protection',
      op: {
        type: 'add-image', slideId: 's2', source: 'assets/microheaders/test.png',
        x: 0.56, y: 0.006, w: 0.4, h: 0.045
      }
    });
    check('delegated protection stops immediately on revoke',
      humanRevoke.status === 200 && humanRevoke.body.changed === true &&
      revokedImage.status === 403);
    await toggle({ kind: 'slide', slideId: 's2', protected: false });

    const protectedBefore = await getState();
    const deniedSlideOps = [
      { type: 'set-notes', slideId: 's1', text: 'blocked' },
      { type: 'set-text', slideId: 's1', elementId: 'e1', text: 'blocked' },
      { type: 'set-corners', slideId: 's1', targetId: 'e1', corners: 'sharp' },
      { type: 'move-slide', slideId: 's1', index: 1 },
      { type: 'delete-slide', slideId: 's1' }
    ];
    const deniedSlideResponses = [];
    for (const op of deniedSlideOps) deniedSlideResponses.push(await edit(op));
    const protectedCliEdit = runCli(
      suiteDir, port, 'cli-human', ['notes', 's1', 'CLI must report protection']
    );
    const protectedAfter = await getState();
    check('whole-slide protection blocks slide, child, move, and delete edits before model/history mutation',
      deniedSlideResponses.every((response) =>
        response.status === 423 && response.body.error === 'protected') &&
      stateSignature(protectedAfter) === stateSignature(protectedBefore));
    check('CLI distinguishes a protection denial from the global pause',
      protectedCliEdit.status === 4 && /PROTECTED/.test(protectedCliEdit.stderr) &&
      !/PAUSED/.test(protectedCliEdit.stderr));

    const unrelatedWhileSlideProtected = await edit({
      type: 'set-text', slideId: 's2', elementId: 'e3', text: 'Allowed elsewhere'
    });
    check('unrelated edits on another slide remain allowed',
      unrelatedWhileSlideProtected.status === 200 &&
      (await getState()).model.slides.find((slide) => slide.id === 's2')
        .elements.find((element) => element.id === 'e3').text === 'Allowed elsewhere');

    // Reverse-tree workflow: lock the parent, then carve out any number of
    // stable children. These exceptions are durable edit permissions, not just
    // visual state in Studio.
    fs.writeFileSync(eventsPath, '');
    const exceptionTargets = [
      { kind: 'object', slideId: 's1', objectId: 'e1', objectKind: 'element' },
      { kind: 'object', slideId: 's1', objectId: 'e2', objectKind: 'element' },
      { kind: 'object', slideId: 's1', objectId: 'path-guy', objectKind: 'decor' }
    ];
    const exceptionResponses = [];
    for (const target of exceptionTargets) {
      exceptionResponses.push(await toggle(Object.assign({}, target, { protected: false })));
    }
    const exceptionState = await getState();
    check('a locked slide accepts several durable object-level editable exceptions',
      exceptionResponses.every((response) => response.status === 200 &&
        response.body.changed === true && Array.isArray(response.body.protectionExceptions)) &&
      exceptionState.protections.some((item) => item.kind === 'slide' && item.slideId === 's1') &&
      exceptionState.protectionExceptions.length === 3 &&
      exceptionTargets.every((target) => exceptionState.protectionExceptions.some((item) =>
        item.slideId === target.slideId && item.objectId === target.objectId &&
        item.objectKind === target.objectKind)) &&
      readEvents(eventsPath).some((event) =>
        event.type === 'protections' && Array.isArray(event.protectionExceptions) &&
        event.protectionExceptions.length === 3));

    await stopServer(child); child = null;
    child = startServer(suiteDir, port, false);
    await waitFor('editable exception restart', async () => (await fetch(base + '/api/health')).ok);
    const restartedExceptions = await getState();
    check('editable exceptions survive restart beneath their locked parent',
      restartedExceptions.protectionExceptions.length === 3 &&
      JSON.stringify(restartedExceptions.protectionExceptions) ===
        JSON.stringify(exceptionState.protectionExceptions));

    const allowedExceptionEdits = [
      await edit({ type: 'set-text', slideId: 's1', elementId: 'e1', text: 'Editable exception title' }),
      await edit({ type: 'set-style', slideId: 's1', elementId: 'e2', bold: true }),
      await edit({ type: 'set-box', slideId: 's1', decorId: 'path-guy', x: 0.07 }),
      await edit({ type: 'set-animation', slideId: 's1', targetId: 'e1', effect: 'fade' })
    ];
    const exceptionUndo = await post('/api/undo', { editor: 'history-human' });
    const exceptionRedo = await post('/api/redo', { editor: 'history-human' });
    const deniedBesideExceptions = [
      await edit({ type: 'set-box', slideId: 's1', decorId: 'kaiju', x: 0.33 }),
      await edit({ type: 'set-notes', slideId: 's1', text: 'still parent-locked' }),
      await edit({ type: 'move-slide', slideId: 's1', index: 1 }),
      await edit({ type: 'delete-element', slideId: 's1', elementId: 'e1' })
    ];
    check('exceptions allow only existing-child edits and history while siblings and structure stay locked',
      allowedExceptionEdits.every((response) => response.status === 200) &&
      exceptionUndo.status === 200 && exceptionRedo.status === 200 &&
      deniedBesideExceptions.every((response) => response.status === 423 &&
        response.body.protection && response.body.protection.kind === 'slide'),
      JSON.stringify({
        allowed: allowedExceptionEdits.map((response) => [response.status, response.body && response.body.error]),
        undo: exceptionUndo.status,
        redo: exceptionRedo.status,
        denied: deniedBesideExceptions.map((response) => [
          response.status,
          response.body && response.body.error,
          response.body && response.body.protection && response.body.protection.kind
        ])
      }));

    const relockE1 = await toggle(Object.assign({}, exceptionTargets[0], { protected: true }));
    const relockedEdit = await edit({
      type: 'set-text', slideId: 's1', elementId: 'e1', text: 'must remain blocked'
    });
    const relockedUndoBefore = await getState();
    const relockedUndo = await post('/api/undo', { editor: 'history-human' });
    check('locking an excepted object again removes only its exception and restores the parent gate',
      relockE1.status === 200 && relockE1.body.changed === true &&
      !(await getState()).protectionExceptions.some((item) => item.objectId === 'e1') &&
      relockedEdit.status === 423 && relockedUndo.status === 423 &&
      stateSignature(await getState()) === stateSignature(relockedUndoBefore));

    const beforeFailedException = await getState();
    setMode('final');
    const failedException = await toggle(Object.assign({}, exceptionTargets[0], { protected: false }));
    setMode('');
    check('failed exception persistence leaves locks, exceptions, history, and SSE truth unchanged',
      failedException.status === 500 &&
      stateSignature(await getState()) === stateSignature(beforeFailedException));

    // Re-open the exception so the pending history action can complete, then
    // close every exception before exercising the alternate direct-lock path.
    await toggle(Object.assign({}, exceptionTargets[0], { protected: false }));
    const allowedUndoAfterException = await post('/api/undo', { editor: 'history-human' });
    check('reopening the same exception releases the blocked object undo',
      allowedUndoAfterException.status === 200);
    for (const target of exceptionTargets) {
      await toggle(Object.assign({}, target, { protected: true }));
    }

    await toggle({ kind: 'slide', slideId: 's1', protected: false });
    await toggle({
      kind: 'object', slideId: 's1', objectId: 'e1', objectKind: 'element', protected: true
    });
    const recursiveLegacyUnlock = await toggle({
      kind: 'slide', slideId: 's1', protected: false
    });
    const afterLegacyUnlock = await getState();
    const formerlyDirectAllowed = await edit({
      type: 'set-text', slideId: 's1', elementId: 'e1', text: 'recursive unlock cleared child lock'
    });
    check('explicit slide unlock recursively clears legacy direct child locks',
      recursiveLegacyUnlock.status === 200 && recursiveLegacyUnlock.body.changed === true &&
      !afterLegacyUnlock.protections.some((item) => item.slideId === 's1') &&
      !afterLegacyUnlock.protectionExceptions.some((item) => item.slideId === 's1') &&
      formerlyDirectAllowed.status === 200);

    await toggle({ kind: 'slide', slideId: 's1', protected: true });
    await toggle({
      kind: 'object', slideId: 's1', objectId: 'e2', objectKind: 'element', protected: false
    });
    const recursiveRelock = await toggle({ kind: 'slide', slideId: 's1', protected: true });
    const afterRecursiveRelock = await getState();
    const recanonicalizedChildBlocked = await edit({
      type: 'set-text', slideId: 's1', elementId: 'e2', text: 'must remain locked'
    });
    check('explicit slide lock recursively clears child exceptions into one canonical slide row',
      recursiveRelock.status === 200 && recursiveRelock.body.changed === true &&
      afterRecursiveRelock.protections.filter((item) => item.slideId === 's1').length === 1 &&
      afterRecursiveRelock.protections.some((item) => item.kind === 'slide' && item.slideId === 's1') &&
      !afterRecursiveRelock.protectionExceptions.some((item) => item.slideId === 's1') &&
      recanonicalizedChildBlocked.status === 423);

    await toggle({
      kind: 'object', slideId: 's1', objectId: 'e2', objectKind: 'element', protected: false
    });
    const recursiveUnlock = await toggle({ kind: 'slide', slideId: 's1', protected: false });
    const afterRecursiveUnlock = await getState();
    const formerlyExceptedAllowed = await edit({
      type: 'set-text', slideId: 's1', elementId: 'e2', text: 'whole tree now editable'
    });
    check('explicit slide unlock clears its slide row and every child exception',
      recursiveUnlock.status === 200 && recursiveUnlock.body.changed === true &&
      !afterRecursiveUnlock.protections.some((item) => item.slideId === 's1') &&
      !afterRecursiveUnlock.protectionExceptions.some((item) => item.slideId === 's1') &&
      formerlyExceptedAllowed.status === 200);
    await toggle({ kind: 'slide', slideId: 's1', protected: true });

    setMode('final');
    const failedUnlock = await toggle({ kind: 'slide', slideId: 's1', protected: false });
    setMode('');
    const stillBlocked = await edit({ type: 'set-notes', slideId: 's1', text: 'still blocked' });
    check('failed unprotect remains durable and enforced',
      failedUnlock.status === 500 && stillBlocked.status === 423 &&
      (await getState()).protections.some((item) => item.kind === 'slide' && item.slideId === 's1'));

    const cliList = runCli(suiteDir, port, 'cli-human', ['protections', '--json']);
    const cliAgentUnlock = runCli(suiteDir, port, 'worker-1', ['unprotect', 's1']);
    check('CLI lists canonical JSON and cannot let an agent unlock',
      cliList.status === 0 && JSON.parse(cliList.stdout).some((item) => item.slideId === 's1') &&
      cliAgentUnlock.status === 1 &&
      /agents may (?:not create or remove protections|only ensure protections|only protect a generated picture)/i
        .test(cliAgentUnlock.stderr),
      JSON.stringify({ status: cliAgentUnlock.status, stderr: cliAgentUnlock.stderr }, null, 2));
    const cliUnlock = runCli(suiteDir, port, 'cli-human', ['unprotect', 's1']);
    check('human CLI can unlock a whole slide',
      cliUnlock.status === 0 && !(await getState()).protections.some((item) => item.slideId === 's1'));

    await toggle({ kind: 'slide', slideId: 's1', protected: true });
    const importedThemeEdit = await edit({ type: 'set-theme', accent: '#abcdef' });
    check('a theme edit remains allowed when only an unaffected imported slide is protected',
      importedThemeEdit.status === 200);
    await toggle({ kind: 'slide', slideId: 's1', protected: false });

    await toggle({ kind: 'slide', slideId: 's2', protected: true });
    const indirectSlideBefore = await getState();
    const indirectSlideResponses = [
      await edit({ type: 'move-slide', slideId: 's1', index: 1 }),
      await edit({ type: 'add-slide', layout: 'content', index: 1 }),
      await edit({ type: 'delete-slide', slideId: 's1' }),
      await edit({ type: 'set-theme', accent: '#123456' })
    ];
    check('a protected native slide blocks indirect order shifts and global theme edits',
      indirectSlideResponses.every((response) =>
        response.status === 423 && response.body.protection.slideId === 's2') &&
      stateSignature(await getState()) === stateSignature(indirectSlideBefore));
    const appendAfterProtected = await edit({
      type: 'add-slide', layout: 'content', title: 'Unrelated trailing slide'
    });
    const undoTrailingAppend = await post('/api/undo', { editor: 'history-human' });
    check('an insertion after a protected slide remains allowed and undoable',
      appendAfterProtected.status === 200 && undoTrailingAppend.status === 200);
    await toggle({ kind: 'slide', slideId: 's2', protected: false });

    await toggle({
      kind: 'object', slideId: 's2', objectId: 'e3', objectKind: 'element', protected: true
    });
    const indirectObjectBefore = await getState();
    const indirectObjectResponses = [
      await edit({ type: 'move-slide', slideId: 's1', index: 1 }),
      await edit({ type: 'add-slide', layout: 'content', index: 1 }),
      await edit({ type: 'delete-slide', slideId: 's1' }),
      await edit({ type: 'add-element', slideId: 's2', elementType: 'body', index: 0, text: 'shift' }),
      await edit({ type: 'delete-element', slideId: 's2', elementId: 'e3' }),
      await edit({ type: 'set-layout', slideId: 's2', layout: 'title' }),
      await edit({ type: 'set-transition', slideId: 's2', effect: 'fade' }),
      await edit({ type: 'set-theme', accent: '#654321' })
    ];
    check('a protected native object blocks parent order/layout/transition/theme effects',
      indirectObjectResponses.every((response) =>
        response.status === 423 && response.body.protection.objectId === 'e3') &&
      stateSignature(await getState()) === stateSignature(indirectObjectBefore));
    const trailingElement = await edit({
      type: 'add-element', slideId: 's2', elementType: 'body', text: 'unrelated trailing element'
    });
    const undoTrailingElement = await post('/api/undo', { editor: 'history-human' });
    check('a trailing native sibling remains editable and undoable beside a protected element',
      trailingElement.status === 200 && undoTrailingElement.status === 200);
    await toggle({
      kind: 'object', slideId: 's2', objectId: 'e3', objectKind: 'element', protected: false
    });

    const themeEdit = await edit({ type: 'set-theme', accent: '#334455' });
    await toggle({
      kind: 'object', slideId: 's2', objectId: 'e3', objectKind: 'element', protected: true
    });
    const themeUndoBefore = await getState();
    const themeUndo = await post('/api/undo', { editor: 'history-human' });
    check('undo cannot restore an older theme through a protected native element',
      themeEdit.status === 200 && themeUndo.status === 423 &&
      themeUndo.body.protection.objectId === 'e3' &&
      stateSignature(await getState()) === stateSignature(themeUndoBefore));
    await toggle({
      kind: 'object', slideId: 's2', objectId: 'e3', objectKind: 'element', protected: false
    });
    await post('/api/undo', { editor: 'history-human' });
    await post('/api/redo', { editor: 'history-human' });

    const objectProtect = await toggle({
      kind: 'object', slideId: 's1', objectId: 'e1', objectKind: 'element', protected: true
    });
    const objectBefore = await getState();
    const deniedObjectOps = [
      { type: 'set-text', slideId: 's1', elementId: 'e1', text: 'blocked object' },
      { type: 'set-style', slideId: 's1', elementId: 'e1', bold: true },
      { type: 'set-corners', slideId: 's1', targetId: 'e1', corners: 'sharp' },
      { type: 'set-animation', slideId: 's1', targetId: 'e1', effect: 'fade' },
      { type: 'delete-element', slideId: 's1', elementId: 'e1' },
      { type: 'move-slide', slideId: 's1', index: 1 },
      { type: 'delete-slide', slideId: 's1' }
    ];
    const deniedObjectResponses = [];
    for (const op of deniedObjectOps) deniedObjectResponses.push(await edit(op));
    const objectAfter = await getState();
    const objectSibling = await edit({
      type: 'set-text', slideId: 's1', elementId: 'e2', text: 'Sibling remains editable'
    });
    const objectSlideMetadata = await edit({
      type: 'set-notes', slideId: 's1', text: 'Slide metadata remains editable'
    });
    check('element protection blocks direct, animation, ancestor move, and delete mutations only',
      objectProtect.status === 200 &&
      deniedObjectResponses.every((response) => response.status === 423) &&
      stateSignature(objectAfter) === stateSignature(objectBefore) &&
      objectSibling.status === 200 && objectSlideMetadata.status === 200);
    await toggle({
      kind: 'object', slideId: 's1', objectId: 'e1', objectKind: 'element', protected: false
    });

    for (const decorId of ['path-guy', 'kaiju']) {
      const protectDecor = await toggle({
        kind: 'object', slideId: 's1', objectId: decorId, objectKind: 'decor', protected: true
      });
      const deniedBox = await edit({
        type: 'set-box', slideId: 's1', decorId, x: decorId === 'path-guy' ? 0.06 : 0.31
      });
      const deniedTransition = await edit({
        type: 'set-transition', slideId: 's1', effect: 'fade'
      });
      check(`${decorId} picture is protectable as an ordinary decor object`,
        protectDecor.status === 200 && deniedBox.status === 423 &&
        deniedTransition.status === 423 &&
        deniedBox.body.protection.objectKind === 'decor' &&
        deniedBox.body.protection.objectId === decorId);
      await toggle({
        kind: 'object', slideId: 's1', objectId: decorId, objectKind: 'decor', protected: false
      });
    }
    const unlockedPathEdit = await edit({
      type: 'set-box', slideId: 's1', decorId: 'path-guy', x: 0.06
    });
    check('the same picture edit succeeds after explicit human unprotect', unlockedPathEdit.status === 200);

    await toggle({
      kind: 'object', slideId: 's1', objectId: 'media1', objectKind: 'decor', protected: true
    });
    const deniedMediaDelete = await edit({
      type: 'delete-decor', slideId: 's1', decorId: 'media1'
    });
    const deniedMediaUpdate = await edit({
      type: 'set-media', slideId: 's1', decorId: 'media1', autoplay: false
    });
    check('generated media uses the same decor protection path',
      deniedMediaDelete.status === 423 && deniedMediaDelete.body.protection.objectId === 'media1' &&
      deniedMediaUpdate.status === 423 && deniedMediaUpdate.body.protection.objectId === 'media1');
    await toggle({
      kind: 'object', slideId: 's1', objectId: 'media1', objectKind: 'decor', protected: false
    });
    const unlockedMediaUpdate = await edit({
      type: 'set-media', slideId: 's1', decorId: 'media1', autoplay: false
    });
    const unlockedMedia = (await getState()).model.slides[0].decor
      .find((item) => item.id === 'media1');
    check('set-media succeeds with exact affected semantics after human unprotect',
      unlockedMediaUpdate.status === 200 &&
      JSON.stringify(unlockedMediaUpdate.body.affected) === JSON.stringify({
        slideId: 's1', decorId: 'media1', media: true
      }) && unlockedMedia.autoplay === false && unlockedMedia.loop === true);
    const unrelatedDecorEdit = await edit({
      type: 'set-fill', slideId: 's1', decorId: 'dshape', color: '#445566'
    });
    const sharpDecor = await edit({
      type: 'set-corners', slideId: 's1', targetId: 'dshape', corners: 'sharp'
    });
    check('an unrelated imported decor remains editable through fill and corner operations',
      unrelatedDecorEdit.status === 200 && sharpDecor.status === 200 &&
      (await getState()).model.slides[0].decor.find((item) => item.id === 'dshape').corners === 'sharp');

    // Restart clears history while preserving only the durable model/state.
    await stopServer(child); child = null;
    child = startServer(suiteDir, port, false);
    await waitFor('history scenario restart', async () => (await fetch(base + '/api/health')).ok);

    const historyEdit = await edit({
      type: 'set-text', slideId: 's1', elementId: 'e1', text: 'History protected text'
    });
    await toggle({
      kind: 'object', slideId: 's1', objectId: 'e1', objectKind: 'element', protected: true
    });
    const beforeDeniedUndo = await getState();
    const deniedUndo = await post('/api/undo', { editor: 'history-human' });
    const deniedCliUndo = runCli(suiteDir, port, 'cli-human', ['undo']);
    const afterDeniedUndo = await getState();
    await toggle({
      kind: 'object', slideId: 's1', objectId: 'e1', objectKind: 'element', protected: false
    });
    const allowedUndo = await post('/api/undo', { editor: 'history-human' });
    await toggle({
      kind: 'object', slideId: 's1', objectId: 'e1', objectKind: 'element', protected: true
    });
    const beforeDeniedRedo = await getState();
    const deniedRedo = await post('/api/redo', { editor: 'history-human' });
    const afterDeniedRedo = await getState();
    check('protecting an edited object blocks undo before either history stack moves',
      historyEdit.status === 200 && deniedUndo.status === 423 &&
      deniedCliUndo.status === 4 && /PROTECTED/.test(deniedCliUndo.stderr) &&
      stateSignature(afterDeniedUndo) === stateSignature(beforeDeniedUndo));
    check('unprotect allows undo, then protecting the restored target blocks redo without stack mutation',
      allowedUndo.status === 200 && deniedRedo.status === 423 &&
      stateSignature(afterDeniedRedo) === stateSignature(beforeDeniedRedo));
    await toggle({
      kind: 'object', slideId: 's1', objectId: 'e1', objectKind: 'element', protected: false
    });
    await post('/api/redo', { editor: 'history-human' });

    const unrelatedHistoryEdit = await edit({
      type: 'set-text', slideId: 's1', elementId: 'e2', text: 'Undo unrelated sibling'
    });
    await toggle({
      kind: 'object', slideId: 's1', objectId: 'e1', objectKind: 'element', protected: true
    });
    const unrelatedUndo = await post('/api/undo', { editor: 'history-human' });
    check('protection on an unrelated sibling does not block undo',
      unrelatedHistoryEdit.status === 200 && unrelatedUndo.status === 200);
    await toggle({
      kind: 'object', slideId: 's1', objectId: 'e1', objectKind: 'element', protected: false
    });

    const indirectHistoryMove = await edit({ type: 'move-slide', slideId: 's1', index: 1 });
    await toggle({ kind: 'slide', slideId: 's2', protected: true });
    const indirectUndoBefore = await getState();
    const indirectUndo = await post('/api/undo', { editor: 'history-human' });
    check('undo cannot indirectly shift a slide protected after the original move',
      indirectHistoryMove.status === 200 && indirectUndo.status === 423 &&
      indirectUndo.body.protection.slideId === 's2' &&
      stateSignature(await getState()) === stateSignature(indirectUndoBefore));
    await toggle({ kind: 'slide', slideId: 's2', protected: false });
    const restoreIndirectMove = await post('/api/undo', { editor: 'history-human' });
    await toggle({
      kind: 'object', slideId: 's2', objectId: 'e3', objectKind: 'element', protected: true
    });
    const indirectRedoBefore = await getState();
    const indirectRedo = await post('/api/redo', { editor: 'history-human' });
    check('redo cannot indirectly shift the parent of a protected object',
      restoreIndirectMove.status === 200 && indirectRedo.status === 423 &&
      indirectRedo.body.protection.objectId === 'e3' &&
      stateSignature(await getState()) === stateSignature(indirectRedoBefore));
    await toggle({
      kind: 'object', slideId: 's2', objectId: 'e3', objectKind: 'element', protected: false
    });
    await post('/api/redo', { editor: 'history-human' });
    await post('/api/undo', { editor: 'history-human' });

    const moveEdit = await edit({ type: 'move-slide', slideId: 's1', index: 1 });
    await toggle({
      kind: 'object', slideId: 's1', objectId: 'path-guy', objectKind: 'decor', protected: true
    });
    const moveUndoBefore = await getState();
    const moveUndo = await post('/api/undo', { editor: 'history-human' });
    check('a protected child prevents undo from reordering its parent slide',
      moveEdit.status === 200 && moveUndo.status === 423 &&
      stateSignature(await getState()) === stateSignature(moveUndoBefore));
    await toggle({
      kind: 'object', slideId: 's1', objectId: 'path-guy', objectKind: 'decor', protected: false
    });
    await post('/api/undo', { editor: 'history-human' });

    const deleteEdit = await edit({ type: 'delete-slide', slideId: 's3' });
    const restoreDeleted = await post('/api/undo', { editor: 'history-human' });
    await toggle({ kind: 'slide', slideId: 's3', protected: true });
    const deleteRedoBefore = await getState();
    const deleteRedo = await post('/api/redo', { editor: 'history-human' });
    check('redo cannot bypass protection to delete a restored slide',
      deleteEdit.status === 200 && restoreDeleted.status === 200 && deleteRedo.status === 423 &&
      stateSignature(await getState()) === stateSignature(deleteRedoBefore));
    await toggle({ kind: 'slide', slideId: 's3', protected: false });

    const addedSlide = await edit({
      type: 'add-slide', layout: 'content', title: 'New protected slide'
    });
    const addedSlideId = addedSlide.body && addedSlide.body.affected &&
      addedSlide.body.affected.slideId;
    await toggle({ kind: 'slide', slideId: addedSlideId, protected: true });
    const addedSlideUndoBefore = await getState();
    const addedSlideUndo = await post('/api/undo', { editor: 'history-human' });
    check('protecting a newly added stable slide prevents undo from removing it',
      addedSlide.status === 200 && addedSlideUndo.status === 423 &&
      stateSignature(await getState()) === stateSignature(addedSlideUndoBefore));
    await toggle({ kind: 'slide', slideId: addedSlideId, protected: false });
    await post('/api/undo', { editor: 'history-human' });

    const addedElement = await edit({
      type: 'add-element', slideId: 's2', elementType: 'body', text: 'New protected element'
    });
    const addedElementId = addedElement.body && addedElement.body.affected &&
      addedElement.body.affected.elementId;
    await toggle({
      kind: 'object', slideId: 's2', objectId: addedElementId,
      objectKind: 'element', protected: true
    });
    const addedElementUndoBefore = await getState();
    const addedElementUndo = await post('/api/undo', { editor: 'history-human' });
    check('protecting a newly added stable object prevents undo from removing it',
      addedElement.status === 200 && addedElementUndo.status === 423 &&
      stateSignature(await getState()) === stateSignature(addedElementUndoBefore));
    await toggle({
      kind: 'object', slideId: 's2', objectId: addedElementId,
      objectKind: 'element', protected: false
    });
    await post('/api/undo', { editor: 'history-human' });

    // Leave a representative slide, text element, picture, and media protected
    // across a real process restart.
    await toggle({ kind: 'slide', slideId: 's2', protected: true });
    await toggle({
      kind: 'object', slideId: 's1', objectId: 'e1', objectKind: 'element', protected: true
    });
    await toggle({
      kind: 'object', slideId: 's1', objectId: 'kaiju', objectKind: 'decor', protected: true
    });
    await toggle({
      kind: 'object', slideId: 's1', objectId: 'media1', objectKind: 'decor', protected: true
    });
    const beforeRestartProtections = (await getState()).protections;
    await stopServer(child); child = null;
    child = startServer(suiteDir, port, false);
    await waitFor('durable protection restart', async () => (await fetch(base + '/api/health')).ok);
    const afterRestart = await getState();
    const restartDenied = await edit({
      type: 'set-box', slideId: 's1', decorId: 'kaiju', x: 0.32
    });
    check('slide/element/picture/media protections survive restart and remain enforced',
      JSON.stringify(afterRestart.protections) === JSON.stringify(beforeRestartProtections) &&
      restartDenied.status === 423 &&
      JSON.stringify(JSON.parse(fs.readFileSync(statePath, 'utf8')).protections) ===
        JSON.stringify(beforeRestartProtections));

    const cliObjectUnlock = runCli(suiteDir, port, 'cli-human', ['unprotect', 's1', 'kaiju']);
    const cliObjectProtect = runCli(suiteDir, port, 'cli-human', ['protect', 's1', 'kaiju']);
    const cliProtection = (await getState()).protections.find((item) =>
      item.kind === 'object' && item.objectId === 'kaiju' && item.objectKind === 'decor');
    check('CLI infers decor kind and can human-unlock/relock an object',
      cliObjectUnlock.status === 0 && cliObjectProtect.status === 0 &&
      cliProtection && cliProtection.by === 'cli-human');

    const joshUnlock = await toggle({
      kind: 'object', slideId: 's1', objectId: 'kaiju',
      objectKind: 'decor', protected: false, by: 'Josh'
    });
    const afterJoshUnlock = await getState();
    const joshUnlockEvent = afterJoshUnlock.protectionHistory[
      afterJoshUnlock.protectionHistory.length - 1
    ];
    await stopServer(child); child = null;
    child = startServer(suiteDir, port, false);
    await waitFor('Josh unlock audit restart', async () => (await fetch(base + '/api/health')).ok);
    const afterJoshRestart = await getState();
    const protectionAudit = await api(base, '/api/protections');
    const cliProtectionAudit = runCli(
      suiteDir, port, 'root-review', ['protections', '--history', '--json']
    );
    const cliProtectionHistory = cliProtectionAudit.status === 0
      ? JSON.parse(cliProtectionAudit.stdout)
      : [];
    const restartedUnlock = afterJoshRestart.protectionHistory[
      afterJoshRestart.protectionHistory.length - 1
    ];
    check('Josh unlock is a durable bounded rejection event, distinct from initial absence',
      joshUnlock.status === 200 && joshUnlock.body.changed === true &&
      !afterJoshUnlock.protections.some((item) => item.objectId === 'kaiju') &&
      joshUnlockEvent.action === 'unlock' && joshUnlockEvent.kind === 'object' &&
      joshUnlockEvent.slideId === 's1' && joshUnlockEvent.objectId === 'kaiju' &&
      joshUnlockEvent.objectKind === 'decor' && joshUnlockEvent.by === 'Josh' &&
      Number.isSafeInteger(joshUnlockEvent.ts) &&
      afterJoshRestart.protectionHistory.length === 12 &&
      JSON.stringify(restartedUnlock) === JSON.stringify(joshUnlockEvent) &&
      Array.isArray(protectionAudit.body.protectionHistory) &&
      JSON.stringify(protectionAudit.body.protectionHistory) ===
        JSON.stringify(afterJoshRestart.protectionHistory) &&
      cliProtectionAudit.status === 0 &&
      JSON.stringify(cliProtectionHistory) ===
        JSON.stringify(afterJoshRestart.protectionHistory));

    // Persisted corruption is fail-closed: boot must fail and never rewrite the
    // offending state file. Restore the valid bytes between independent cases.
    const validState = fs.readFileSync(statePath, 'utf8');
    await stopServer(child); child = null;
    const invalidSchema = JSON.parse(validState);
    invalidSchema.protections = {};
    fs.writeFileSync(statePath, JSON.stringify(invalidSchema, null, 2));
    await expectStartupFailure(
      suiteDir, port, 'present non-array protections fail closed without rewriting state',
      'protections must be an array'
    );

    const invalidHistory = JSON.parse(validState);
    invalidHistory.protectionHistory = [{
      action: 'unlock', kind: 'object', slideId: 's1', objectId: 'kaiju',
      objectKind: 'picture', by: 'Josh', ts: 1
    }];
    fs.writeFileSync(statePath, JSON.stringify(invalidHistory, null, 2));
    await expectStartupFailure(
      suiteDir, port, 'malformed protection audit fails closed without rewriting state',
      'protectionHistory[0].objectKind must be element or decor'
    );

    const invalidExceptions = JSON.parse(validState);
    invalidExceptions.protectionExceptions = {};
    fs.writeFileSync(statePath, JSON.stringify(invalidExceptions, null, 2));
    await expectStartupFailure(
      suiteDir, port, 'present non-array editable exceptions fail closed without rewriting state',
      'protectionExceptions must be an array'
    );

    const orphanException = JSON.parse(validState);
    orphanException.protections = orphanException.protections.filter((item) =>
      !(item.kind === 'slide' && item.slideId === 's1'));
    orphanException.protectionExceptions = [{
      kind: 'object', slideId: 's1', objectId: 'e2', objectKind: 'element',
      by: 'Josh', createdAt: 1
    }];
    fs.writeFileSync(statePath, JSON.stringify(orphanException, null, 2));
    await expectStartupFailure(
      suiteDir, port, 'an editable exception without its parent slide lock fails closed',
      'protectionExceptions[0] requires a slide protection for s1'
    );

    const staleTarget = JSON.parse(validState);
    staleTarget.protections = [{
      kind: 'object', slideId: 's1', objectId: 'path-guy',
      objectKind: 'element', by: 'human-test', createdAt: 1
    }];
    fs.writeFileSync(statePath, JSON.stringify(staleTarget, null, 2));
    await expectStartupFailure(
      suiteDir, port, 'persisted object-kind mismatch fails closed without rewriting state',
      'names missing element "path-guy"'
    );
    fs.writeFileSync(statePath, validState);
  } finally {
    setMode('');
    await stopServer(child);
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        fs.rmSync(sandbox, { recursive: true, force: true });
        break;
      } catch (_) {
        if (attempt < 5) await sleep(200);
      }
    }
  }

  const passed = checks.filter((item) => item.ok).length;
for (const item of checks) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.description}${item.detail ? `\n      ${item.detail}` : ''}`);
}
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error && (error.stack || error));
  process.exit(1);
});
