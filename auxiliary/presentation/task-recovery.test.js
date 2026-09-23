#!/usr/bin/env node
'use strict';
/*
 * Durable task-recovery regression suite.
 *
 * Runs an isolated copy of the coordinator with agent/process and rendering
 * work stubbed. It proves restart recovery requeues stale claims atomically,
 * waits for a real viewer before waking workers, never redelivers completed
 * work, and retains a task whose first wake signal was refused.
 */
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const HERE = __dirname;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
function check(description, condition) { checks.push({ description, ok: !!condition }); }

// Exclude only data owned by live processes or created as short-lived staging.
// In particular, Chromium holds files in codex-viewer-profile open on Windows,
// and cpSync can fail with EPIPE/EBUSY while a viewer is attached. Durable
// recovery inputs and stable render outputs still copy into the sandbox.
const HERE_DATA = path.join(HERE, 'data');
const VOLATILE_DATA_ENTRIES = new Set([
  'codex-viewer-profile',
  'agents.pid.json',
  'com_host.pid.json',
  'thumbs-src.pptx',
  'board-hook.log',
  'guard.log',
]);

function isVolatileRuntimeArtifact(srcPath) {
  const rel = path.relative(HERE_DATA, srcPath);
  if (!rel || path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) return false;
  const parts = rel.split(path.sep);
  const top = parts[0];
  return VOLATILE_DATA_ENTRIES.has(top)
    || /^chrome-[a-z0-9]+-node$/i.test(top)
    || /^preview-[a-z0-9]+$/i.test(top)
    || parts.some((part) => /^\.thumbs-stage-/i.test(part))
    || /^\.pdf-(?:source-.+\.pptx|output-.+\.pdf)$/i.test(top)
    || /\.tmp$/i.test(top);
}

function assertFixtureCopyFilter() {
  const excluded = [
    path.join(HERE_DATA, 'codex-viewer-profile'),
    path.join(HERE_DATA, 'codex-viewer-profile', 'Default', 'Cookies'),
    path.join(HERE_DATA, 'chrome-t123-node'),
    path.join(HERE_DATA, 'preview-t123'),
    path.join(HERE_DATA, 'agents.pid.json'),
    path.join(HERE_DATA, 'com_host.pid.json'),
    path.join(HERE_DATA, 'thumbs-src.pptx'),
    path.join(HERE_DATA, 'board-hook.log'),
    path.join(HERE_DATA, 'guard.log'),
    path.join(HERE_DATA, 'thumbs', '.thumbs-stage-123', 'slide-1.png'),
    path.join(HERE_DATA, '.pdf-source-123-1-a1b2c3.pptx'),
    path.join(HERE_DATA, '.pdf-output-123-1-a1b2c3.pdf'),
    path.join(HERE_DATA, 'board.json.123.a1b2c3.tmp'),
  ];
  const retained = [
    path.join(HERE, 'server.js'),
    path.join(HERE_DATA, 'model.json'),
    path.join(HERE_DATA, 'board.json'),
    path.join(HERE_DATA, 'state.json'),
    path.join(HERE_DATA, 'element-history.json'),
    path.join(HERE_DATA, 'element-history.pending.json'),
    path.join(HERE_DATA, 'base.pptx'),
    path.join(HERE_DATA, 'render-state.json'),
    path.join(HERE_DATA, 'presentation.pdf'),
    path.join(HERE_DATA, 'thumbs', 'slide-1.png'),
    path.join(HERE_DATA, 'worker10-s6-qa'),
  ];
  for (const source of excluded) {
    if (!isVolatileRuntimeArtifact(source)) {
      throw new Error(`fixture copy filter retained volatile path: ${source}`);
    }
  }
  for (const source of retained) {
    if (isVolatileRuntimeArtifact(source)) {
      throw new Error(`fixture copy filter dropped durable path: ${source}`);
    }
  }
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
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function waitFor(description, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await predicate()) return; } catch (_) {}
    await sleep(30);
  }
  throw new Error(`timed out waiting for ${description}`);
}

function makeWritable(file) {
  if (process.platform === 'win32') spawnSync('attrib', ['-R', file], { stdio: 'ignore' });
  else { try { fs.chmodSync(file, 0o644); } catch (_) {} }
}

function readJsonLines(file) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (_) {
    return [];
  }
}

function patchServer(suiteDir) {
  const serverPath = path.join(suiteDir, 'server.js');
  let source = fs.readFileSync(serverPath, 'utf8');

  const platformNeedle = "const IS_WIN = process.platform === 'win32';";
  if (!source.includes(platformNeedle)) throw new Error('could not isolate Windows-only work');
  source = source.replace(platformNeedle, 'const IS_WIN = false; // task-recovery test sandbox');

  const pathNeedle = "const COM_HOST_PID_PATH = path.join(DATA, 'com_host.pid.json');";
  if (!source.includes(pathNeedle)) throw new Error('could not install task-recovery agent stubs');
  source = source.replace(pathNeedle, pathNeedle + `
const __taskRecoveryDispatchPath = path.join(DATA, '__task-recovery-dispatch.jsonl');
const __taskRecoverySweepPath = path.join(DATA, '__task-recovery-sweep.jsonl');
const __taskRecoverySweepReleasePath = path.join(DATA, '__task-recovery-sweep-release');
const __taskRecoveryModePath = path.join(DATA, '__task-recovery-mode');
function __taskRecoveryMode() {
  try { return fs.readFileSync(__taskRecoveryModePath, 'utf8').trim(); } catch (_) { return ''; }
}
Agents.sweepStale = () => new Promise((resolve) => {
  const finishWhenReleased = () => {
    if (!fs.existsSync(__taskRecoverySweepReleasePath)) {
      setTimeout(finishWhenReleased, 10);
      return;
    }
    fs.appendFileSync(__taskRecoverySweepPath, JSON.stringify({ type: 'sweep-complete', ts: Date.now() }) + '\\n');
    resolve([]);
  };
  finishWhenReleased();
});
Agents.spawnOrWrite = (...args) => {
  const mode = __taskRecoveryMode();
  const record = { type: 'dispatch', args, mode, ts: Date.now() };
  fs.appendFileSync(__taskRecoveryDispatchPath, JSON.stringify(record) + '\\n');
  return mode === 'refuse'
    ? { ok: false, reason: 'paused' }
    : { ok: true, action: 'stubbed' };
};
Agents.providerHealth = (name) => ({
  provider: name || Agents.providerName,
  ok: true,
  detail: 'task-recovery test provider',
  auth: 'chatgpt',
});`);

  if (!source.includes('  await migrateModel();')) throw new Error('could not skip model migration');
  source = source.replace('  await migrateModel();', '  // task-recovery test: skip model migration');
  if (!source.includes('function scheduleRender() {')) throw new Error('could not isolate render scheduling');
  source = source.replace(
    'function scheduleRender() {',
    'function scheduleRender() {\n  if (process.env.SUITE_TASK_RECOVERY_TEST) return;'
  );
  const thumbsNeedle = "      void refreshThumbsFromDeck(model.rev, 'boot thumbs pass skipped:');";
  if (!source.includes(thumbsNeedle)) throw new Error('could not isolate boot thumbnail export');
  source = source.replace(thumbsNeedle, '      // task-recovery test: no background thumbnail export');
  fs.writeFileSync(serverPath, source);
}

function seedSandbox(suiteDir) {
  const data = path.join(suiteDir, 'data');
  const statePath = path.join(data, 'state.json');
  const boardPath = path.join(data, 'board.json');
  for (const file of [
    statePath,
    boardPath,
    path.join(data, 'model.json'),
    path.join(suiteDir, '..', 'presentation.pptx'),
  ]) makeWritable(file);

  fs.rmSync(path.join(data, 'agents.pid.json'), { force: true });
  fs.rmSync(path.join(data, 'com_host.pid.json'), { force: true });
  fs.writeFileSync(statePath, JSON.stringify({
    paused: false,
    pausedBy: null,
    pausedAt: null,
    pdfRev: null,
    log: [],
    loopRunner: false,
    usageProfile: 'beast',
    agentProvider: 'codex',
  }, null, 2));

  const tasks = [
    {
      id: 't-recover-open', text: 'recover open assignment', by: 'lead',
      assignee: 'worker-1', wakeWorker: true, status: 'open', claimedBy: '',
      ts: 10, doneTs: null, progress: { slidesChecked: ['s1'], percent: 25 },
    },
    {
      id: 't-recover-claimed', text: 'recover stale claimed assignment', by: 'lead',
      assignee: 'worker-12', wakeWorker: true, status: 'claimed', claimedBy: 'worker-12',
      ts: 20, doneTs: null,
    },
    {
      id: 't-completed', text: 'must never run again', by: 'lead',
      assignee: 'worker-2', wakeWorker: true, status: 'done', claimedBy: 'worker-2',
      ts: 30, doneTs: 300,
    },
    {
      id: 't-human-claim', text: 'polling-only human assignment', by: 'human',
      assignee: 'worker-3', wakeWorker: false, status: 'claimed', claimedBy: 'worker-3',
      ts: 40, doneTs: null,
    },
    {
      id: 't-legacy-lead', text: 'legacy lead assignment', by: 'lead',
      assignee: 'worker-4', status: 'open', claimedBy: '',
      ts: 50, doneTs: null,
    },
  ];
  fs.writeFileSync(boardPath, JSON.stringify({ notes: [], tasks, loops: [] }, null, 2));
}

function startServer(suiteDir, port) {
  const output = { stdout: '', stderr: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: suiteDir,
    env: Object.assign({}, process.env, {
      SUITE_PORT: String(port),
      SUITE_TASK_RECOVERY_TEST: '1',
      SUITE_TASK_RECOVERY_RETRY_MS: '1000',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output.stdout = (output.stdout + chunk).slice(-12000); });
  child.stderr.on('data', (chunk) => { output.stderr = (output.stderr + chunk).slice(-12000); });
  return { child, output };
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try { child.kill(); } catch (_) {}
  await Promise.race([exited, sleep(1500)]);
}

async function main() {
  const sandbox = path.join(os.tmpdir(), 'task-recovery-' + crypto.randomBytes(5).toString('hex'));
  const suiteDir = path.join(sandbox, 'suite');
  const data = path.join(suiteDir, 'data');
  const boardPath = path.join(data, 'board.json');
  const dispatchPath = path.join(data, '__task-recovery-dispatch.jsonl');
  const sweepPath = path.join(data, '__task-recovery-sweep.jsonl');
  const modePath = path.join(data, '__task-recovery-mode');
  let child = null;
  let output = null;
  let viewerController = null;
  try {
    assertFixtureCopyFilter();
    fs.cpSync(HERE, suiteDir, {
      recursive: true,
      filter: (src) => !isVolatileRuntimeArtifact(src),
    });
    // Setup invariants stay outside the scored recovery checks, preserving the
    // suite's 37/37 contract while proving the copy policy itself.
    for (const excluded of [
      'codex-viewer-profile', 'agents.pid.json', 'com_host.pid.json',
      'thumbs-src.pptx', 'board-hook.log', 'guard.log',
    ]) {
      if (fs.existsSync(path.join(data, excluded))) {
        throw new Error(`sandbox copy leaked volatile runtime artifact: data/${excluded}`);
      }
    }
    for (const required of [
      path.join(suiteDir, 'server.js'),
      path.join(data, 'model.json'),
      path.join(data, 'board.json'),
      path.join(data, 'state.json'),
      path.join(data, 'element-history.json'),
      path.join(data, 'base.pptx'),
    ]) {
      if (!fs.existsSync(required)) throw new Error(`sandbox copy dropped a recovery input: ${required}`);
    }
    fs.copyFileSync(
      path.join(HERE, '..', 'presentation.pptx'),
      path.join(sandbox, 'presentation.pptx')
    );
    seedSandbox(suiteDir);
    patchServer(suiteDir);
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const post = (route, body) => api(base, route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    ({ child, output } = startServer(suiteDir, port));
    await waitFor('isolated task-recovery server', async () => (await fetch(base + '/api/health')).ok);

    const lowerProfile = await post('/api/agents/profile', { profile: 'extra', by: 'human' });
    const chooseClaude = await post('/api/agents/provider', { provider: 'claude', by: 'human' });
    const beastClaude = await post('/api/agents/profile', { profile: 'beast', by: 'human' });
    const claudeDiskState = JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8'));
    const beastCodex = await post('/api/agents/provider', { provider: 'codex', by: 'human' });
    const codexDiskState = JSON.parse(fs.readFileSync(path.join(data, 'state.json'), 'utf8'));
    check('beast keeps the two-pool ultra/standard-speed/full-access contract with Claude Opus',
      lowerProfile.status === 200
        && lowerProfile.body.poolCaps.general === 12
        && lowerProfile.body.poolCaps.media === 0
        && chooseClaude.status === 200
        && beastClaude.status === 200
        && beastClaude.body.provider === 'claude'
        && beastClaude.body.configuredProvider === 'claude'
        && beastClaude.body.forcedProvider === null
        && beastClaude.body.poolCaps.general === 30
        && beastClaude.body.poolCaps.media === 10
        && beastClaude.body.nextExecution.models.lead === 'opus'
        && beastClaude.body.nextExecution.models.worker === 'opus'
        && beastClaude.body.nextExecution.reasoningEffort === 'ultra'
        && beastClaude.body.nextExecution.serviceTier === 'standard'
        && beastClaude.body.nextExecution.fastMode === false
        && beastClaude.body.nextExecution.fullAccess === true
        && claudeDiskState.usageProfile === 'beast'
        && claudeDiskState.agentProvider === 'claude');
    check('beast accepts a live Codex switch and resolves the next spawn to Sol without downgrading the contract',
      beastCodex.status === 200
        && beastCodex.body.provider === 'codex'
        && beastCodex.body.configuredProvider === 'codex'
        && beastCodex.body.forcedProvider === null
        && beastCodex.body.nextExecution.models.lead === 'gpt-5.6-sol'
        && beastCodex.body.nextExecution.models.worker === 'gpt-5.6-sol'
        && beastCodex.body.poolCaps.general === 30
        && beastCodex.body.poolCaps.media === 10
        && beastCodex.body.nextExecution.reasoningEffort === 'ultra'
        && beastCodex.body.nextExecution.serviceTier === 'standard'
        && beastCodex.body.nextExecution.fastMode === false
        && beastCodex.body.nextExecution.fullAccess === true
        && codexDiskState.usageProfile === 'beast'
        && codexDiskState.agentProvider === 'codex');

    const heldBeforeRecovery = await post('/api/tasks/update', {
      id: 't-recover-open',
      text: 'redistributed but deliberately held',
      assignee: 'worker-8',
      wakeWorker: false,
      by: 'lead',
    });
    check('an open task can be held and reassigned without deleting it',
      heldBeforeRecovery.status === 200
        && heldBeforeRecovery.body.task.id === 't-recover-open'
        && heldBeforeRecovery.body.task.text === 'redistributed but deliberately held'
        && heldBeforeRecovery.body.task.assignee === 'worker-8'
        && heldBeforeRecovery.body.task.wakeWorker === false
        && heldBeforeRecovery.body.dispatch === null);
    check('task update preserves created timestamp, progress, and prior instruction/assignment',
      heldBeforeRecovery.body.task.ts === 10
        && JSON.stringify(heldBeforeRecovery.body.task.progress) === JSON.stringify({ slidesChecked: ['s1'], percent: 25 })
        && heldBeforeRecovery.body.task.updatedBy === 'lead'
        && Number.isFinite(heldBeforeRecovery.body.task.updatedAt)
        && heldBeforeRecovery.body.task.revisions.length === 1
        && heldBeforeRecovery.body.task.revisions[0].text === 'recover open assignment'
        && heldBeforeRecovery.body.task.revisions[0].assignee === 'worker-1');

    const duringSweep = await post('/api/tasks', {
      text: 'queue during stale child cleanup',
      by: 'lead',
      assignee: 'worker-7',
    });
    const duringSweepId = duringSweep.body.task.id;
    const mediaDuringSweep = await post('/api/tasks', {
      text: 'Generate a PNG image asset for slide 1',
      by: 'lead',
      assignee: 'worker-6',
    });
    const mediaDuringSweepId = mediaDuringSweep.body.task.id;
    const earlyChat = await post('/api/chat', { text: 'do not race the old lead', by: 'human' });
    check('new work is committed but not spawned while stale child cleanup is running',
      duringSweep.status === 200
        && duringSweep.body.dispatch.reason === 'agent restart cleanup in progress'
        && mediaDuringSweep.status === 200
        && mediaDuringSweep.body.task.requestedAssignee === 'worker-6'
        && mediaDuringSweep.body.task.classifiedPool === 'media'
        && mediaDuringSweep.body.task.pool === 'media'
        && mediaDuringSweep.body.task.assignee === 'media-1'
        && mediaDuringSweep.body.task.routeFallback === false
        && mediaDuringSweep.body.dispatch.reason === 'agent restart cleanup in progress'
        && readJsonLines(dispatchPath).length === 0);
    check('media routing is durable before wake and records the exact retry assignee', (() => {
      const task = JSON.parse(fs.readFileSync(boardPath, 'utf8')).tasks
        .find((item) => item.id === mediaDuringSweepId);
      return task
        && task.assignee === 'media-1'
        && task.pool === 'media'
        && task.classifiedPool === 'media'
        && task.requestedAssignee === 'worker-6'
        && task.wakeWorker === true
        && task.status === 'open';
    })());
    check('chat cannot race a possibly-live lead during stale child cleanup',
      earlyChat.status === 503 && /cleanup/i.test(earlyChat.body.error));
    fs.writeFileSync(path.join(data, '__task-recovery-sweep-release'), 'release\n');
    await waitFor('stale child sweep completion', () => readJsonLines(sweepPath).length === 1);

    const afterBoot = await api(base, '/api/tasks');
    const byId = new Map(afterBoot.body.tasks.map((task) => [task.id, task]));
    check('restart atomically requeues an assigned stale claim',
      byId.get('t-recover-claimed').status === 'open'
        && byId.get('t-recover-claimed').claimedBy === '');
    check('restart requeues polling-only stale claims without auto-changing their wake intent',
      byId.get('t-human-claim').status === 'open'
        && byId.get('t-human-claim').claimedBy === ''
        && byId.get('t-human-claim').wakeWorker === false);
    check('completed task state survives recovery unchanged',
      byId.get('t-completed').status === 'done'
        && byId.get('t-completed').doneTs === 300);
    check('restart persists the requeued claim state to board.json', (() => {
      const disk = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
      const task = disk.tasks.find((item) => item.id === 't-recover-claimed');
      return task && task.status === 'open' && task.claimedBy === '';
    })());
    check('recovery does not wake workers while no viewer is present',
      readJsonLines(dispatchPath).length === 0);
    check('held task state and revision history are atomic on disk', (() => {
      const disk = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
      const task = disk.tasks.find((item) => item.id === 't-recover-open');
      return task
        && task.wakeWorker === false
        && task.assignee === 'worker-8'
        && task.ts === 10
        && task.revisions.length === 1
        && task.revisions[0].text === 'recover open assignment';
    })());

    viewerController = new AbortController();
    const viewer = await fetch(base + '/api/events?viewer=task-recovery-test', {
      signal: viewerController.signal,
    });
    check('test viewer established the real SSE presence path', viewer.status === 200);
    await waitFor('recovered worker dispatches', () => readJsonLines(dispatchPath).length === 4);

    const recovered = readJsonLines(dispatchPath);
    const recoveredIds = recovered.map((entry) => {
      const match = /\[task ([^\]]+)\]/.exec(entry.args[2]);
      return match && match[1];
    }).sort();
    check('viewer presence wakes every unfinished durable assignment, including legacy lead records',
      JSON.stringify(recoveredIds) === JSON.stringify([
        duringSweepId, mediaDuringSweepId, 't-legacy-lead', 't-recover-claimed',
      ].sort()));
    check('restart recovery preserves the committed media route instead of reclassifying it',
      recovered.some((entry) =>
        entry.args[0] === 'media-1'
        && entry.args[2].includes(`[task ${mediaDuringSweepId}]`)
        && /Generate a PNG image asset/.test(entry.args[2])));
    check('recovered assignments carry an idempotence guard for already-applied edits',
      recovered.every((entry) => /\[recovered task retry\]/i.test(entry.args[2])
        && /already present/i.test(entry.args[2])
        && /without applying it again/i.test(entry.args[2])));
    check('completed and polling-only tasks are not dispatched',
      !recovered.some((entry) => /t-completed|t-human-claim/.test(entry.args[2])));
    check('held tasks are not included in restart recovery dispatch',
      !recovered.some((entry) => /t-recover-open/.test(entry.args[2])));

    const wakeHeld = await post('/api/tasks/update', {
      id: 't-recover-open',
      wakeWorker: true,
      by: 'lead',
    });
    await waitFor('explicitly woken held task', () =>
      readJsonLines(dispatchPath).some((entry) => entry.args[2].includes('[task t-recover-open]')));
    const heldAttempts = readJsonLines(dispatchPath)
      .filter((entry) => entry.args[2].includes('[task t-recover-open]'));
    check('explicit wake dispatches the held task to its redistributed assignee',
      wakeHeld.status === 200
        && wakeHeld.body.dispatch.ok === true
        && heldAttempts.length === 1
        && heldAttempts[0].args[0] === 'worker-8'
        && /redistributed but deliberately held/.test(heldAttempts[0].args[2])
        && !/\[recovered task retry\]/i.test(heldAttempts[0].args[2]));

    await post('/api/presence', {});
    await post('/api/presence', {});
    await sleep(100);
    check('repeated viewer heartbeats cannot duplicate successful recovered wakes',
      readJsonLines(dispatchPath).length === recovered.length + heldAttempts.length);

    const beforeNonLeadAssignment = readJsonLines(dispatchPath).length;
    const nonLeadAssigned = await post('/api/tasks', {
      text: 'explicit non-lead assignment must start now',
      by: 'codex-root',
      assignee: 'worker-10',
      wakeWorker: true,
    });
    await waitFor('non-lead explicit assignment dispatch', () =>
      readJsonLines(dispatchPath).some((entry) =>
        entry.args[2].includes(`[task ${nonLeadAssigned.body.task.id}]`)));
    const nonLeadAttempts = readJsonLines(dispatchPath).filter((entry) =>
      entry.args[2].includes(`[task ${nonLeadAssigned.body.task.id}]`));
    check('an explicit CLI/UI assignment wakes immediately regardless of author label',
      nonLeadAssigned.status === 200 && nonLeadAssigned.body.task.by === 'codex-root' &&
      nonLeadAssigned.body.task.assignee === 'worker-10' &&
      nonLeadAssigned.body.task.wakeWorker === true &&
      nonLeadAssigned.body.dispatch && nonLeadAssigned.body.dispatch.ok === true &&
      nonLeadAttempts.length === 1 && nonLeadAttempts[0].args[0] === 'worker-10' &&
      !/recovered task retry/i.test(nonLeadAttempts[0].args[2]));

    const passiveTask = await post('/api/tasks', {
      text: 'passive unassigned queue item',
      by: 'codex-root',
      assignee: '',
      wakeWorker: false,
    });
    check('an unassigned task remains passive even from the same author',
      passiveTask.status === 200 && passiveTask.body.task.wakeWorker === false &&
      passiveTask.body.dispatch === null &&
      readJsonLines(dispatchPath).length === beforeNonLeadAssignment + 1);

    const assignedExisting = await post('/api/tasks/update', {
      id: passiveTask.body.task.id,
      assignee: 'worker-11',
      by: 'codex-root',
    });
    await waitFor('existing task default assignment dispatch', () =>
      readJsonLines(dispatchPath).some((entry) =>
        entry.args[2].includes(`[task ${passiveTask.body.task.id}]`)));
    const assignedExistingAttempts = readJsonLines(dispatchPath).filter((entry) =>
      entry.args[2].includes(`[task ${passiveTask.body.task.id}]`));
    check('assigning an existing passive task also sets durable wake intent by default',
      assignedExisting.status === 200 && assignedExisting.body.task.assignee === 'worker-11' &&
      assignedExisting.body.task.wakeWorker === true &&
      assignedExisting.body.dispatch && assignedExisting.body.dispatch.ok === true &&
      assignedExistingAttempts.length === 1 && assignedExistingAttempts[0].args[0] === 'worker-11');

    const wrongMediaDone = await post('/api/tasks/done', {
      id: mediaDuringSweepId,
      by: 'worker-6',
    });
    const mediaDone = await post('/api/tasks/done', {
      id: mediaDuringSweepId,
      by: 'media-1',
    });
    check('media workers use the same durable ownership and completion checks as general workers',
      wrongMediaDone.status === 409
        && /assigned to media-1/.test(wrongMediaDone.body.error)
        && mediaDone.status === 200
        && mediaDone.body.task.status === 'done'
        && mediaDone.body.task.claimedBy === 'media-1');

    const boardBeforeDoneRetry = fs.readFileSync(boardPath, 'utf8');
    const duplicateDone = await post('/api/tasks/done', { id: 't-completed', by: 'worker-2' });
    check('repeated completion is idempotent and reports alreadyDone',
      duplicateDone.status === 200 && duplicateDone.body.alreadyDone === true);
    check('idempotent completion does not rewrite durable task state',
      fs.readFileSync(boardPath, 'utf8') === boardBeforeDoneRetry);

    const heldForPause = await post('/api/tasks', {
      text: 'wake this held assignment only after resume',
      by: 'human',
      assignee: '',
      wakeWorker: false,
    });
    const beforePausedTask = readJsonLines(dispatchPath).length;
    const paused = await post('/api/pause', { by: 'human' });
    const updatedWhilePaused = await post('/api/tasks/update', {
      id: heldForPause.body.task.id,
      assignee: 'worker-9',
      wakeWorker: true,
      by: 'codex-root',
    });
    const queuedWhilePaused = await post('/api/tasks', {
      text: 'hold this wake until resume',
      by: 'codex-root',
      assignee: 'worker-5',
      wakeWorker: true,
    });
    const pausedTaskId = queuedWhilePaused.body.task.id;
    check('non-lead assignments created or activated while paused are durably queued without worker writes',
      paused.status === 200
        && updatedWhilePaused.status === 200
        && updatedWhilePaused.body.dispatch.reason === 'paused'
        && updatedWhilePaused.body.task.wakeWorker === true
        && queuedWhilePaused.status === 200
        && queuedWhilePaused.body.dispatch.reason === 'paused'
        && queuedWhilePaused.body.task.by === 'codex-root'
        && queuedWhilePaused.body.task.wakeWorker === true
        && readJsonLines(dispatchPath).length === beforePausedTask);
    const resumed = await post('/api/resume', { by: 'human' });
    await waitFor('paused task wake after resume', () =>
      readJsonLines(dispatchPath).some((entry) => entry.args[2].includes(`[task ${pausedTaskId}]`)));
    check('successful resume immediately wakes the durable paused assignment once',
      resumed.status === 200
        && readJsonLines(dispatchPath)
          .filter((entry) => entry.args[2].includes(`[task ${pausedTaskId}]`)).length === 1);
    check('task update queued while paused wakes once on resume',
      readJsonLines(dispatchPath)
        .filter((entry) => entry.args[2].includes(`[task ${heldForPause.body.task.id}]`)).length === 1);

    const invalidSeed = await post('/api/tasks', {
      text: 'invalid update fixture',
      by: 'human',
      assignee: '',
    });
    const invalidId = invalidSeed.body.task.id;
    const boardBeforeInvalid = fs.readFileSync(boardPath, 'utf8');
    const invalidWorker = await post('/api/tasks/update', {
      id: invalidId, assignee: 'worker-31', wakeWorker: false, by: 'lead',
    });
    const invalidWake = await post('/api/tasks/update', {
      id: invalidId, wakeWorker: true, by: 'lead',
    });
    const invalidEmpty = await post('/api/tasks/update', {
      id: invalidId, by: 'lead',
    });
    const invalidDone = await post('/api/tasks/update', {
      id: 't-completed', text: 'must not overwrite completed work', by: 'lead',
    });
    const invalidAssignedCreate = await post('/api/tasks', {
      text: 'must not poison the durable queue',
      by: 'codex-root',
      assignee: 'media-11',
      wakeWorker: true,
    });
    const invalidAssignedHold = await post('/api/tasks', {
      text: 'assigned create cannot silently suppress its wake',
      by: 'codex-root',
      assignee: 'worker-1',
      wakeWorker: false,
    });
    const invalidUnassignedWake = await post('/api/tasks', {
      text: 'unassigned create cannot request a wake',
      by: 'codex-root',
      assignee: '',
      wakeWorker: true,
    });
    check('invalid worker, mismatched create intent, empty update, and completed update are rejected',
      invalidWorker.status === 400
        && /worker-1 through worker-30/.test(invalidWorker.body.error)
        && /media-1 through media-10/.test(invalidWorker.body.error)
        && invalidWake.status === 400
        && /requires an assigned worker/.test(invalidWake.body.error)
        && invalidEmpty.status === 400
        && invalidDone.status === 409
        && invalidAssignedCreate.status === 400
        && invalidAssignedHold.status === 400
        && /must wake its worker/i.test(invalidAssignedHold.body.error)
        && invalidUnassignedWake.status === 400
        && /requires an assigned worker/i.test(invalidUnassignedWake.body.error));
    check('invalid task updates do not mutate or lose any task',
      fs.readFileSync(boardPath, 'utf8') === boardBeforeInvalid);

    let revisionTask = (await post('/api/tasks', {
      text: 'revision-0',
      by: 'human',
      assignee: '',
      wakeWorker: false,
    })).body.task;
    for (let i = 1; i <= 55; i++) {
      const changed = await post('/api/tasks/update', {
        id: revisionTask.id,
        text: `revision-${i}`,
        wakeWorker: false,
        by: 'lead',
      });
      revisionTask = changed.body.task;
    }
    check('task revision history is bounded while preserving the immediately prior instruction',
      revisionTask.revisions.length === 50
        && revisionTask.text === 'revision-55'
        && revisionTask.revisions[revisionTask.revisions.length - 1].text === 'revision-54'
        && revisionTask.revisions.every((revision) => revision.by === 'lead' && Number.isFinite(revision.ts)));
    check('successful updates never remove another task from the durable queue', (() => {
      const disk = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
      const ids = new Set(disk.tasks.map((task) => task.id));
      return [
        't-recover-open', 't-recover-claimed', 't-completed', 't-human-claim',
        't-legacy-lead', duringSweepId, mediaDuringSweepId,
        heldForPause.body.task.id, invalidId, revisionTask.id,
        nonLeadAssigned.body.task.id, passiveTask.body.task.id,
      ].every((id) => ids.has(id));
    })());

    fs.writeFileSync(modePath, 'refuse');
    const refused = await post('/api/tasks', {
      text: 'retry a refused wake',
      by: 'codex-root',
      assignee: 'worker-5',
      wakeWorker: true,
    });
    check('a refused first wake leaves its committed task open',
      refused.status === 200
        && refused.body.dispatch
        && refused.body.dispatch.ok === false
        && refused.body.task.status === 'open');
    fs.rmSync(modePath, { force: true });
    await post('/api/presence', {});
    await waitFor('refused wake retry', () => {
      const id = refused.body.task.id;
      return readJsonLines(dispatchPath).filter((entry) => entry.args[2].includes(`[task ${id}]`)).length === 2;
    });
    const refusedAttempts = readJsonLines(dispatchPath)
      .filter((entry) => entry.args[2].includes(`[task ${refused.body.task.id}]`));
    check('a later presence retries the same durable task exactly once',
      refusedAttempts.length === 2
        && !/\[recovered task retry\]/i.test(refusedAttempts[0].args[2])
        && /\[recovered task retry\]/i.test(refusedAttempts[1].args[2]));

    fs.writeFileSync(modePath, 'refuse');
    const finishBeforeRetry = await post('/api/tasks', {
      text: 'finish before retry',
      by: 'lead',
      assignee: 'worker-6',
    });
    const finishId = finishBeforeRetry.body.task.id;
    const finished = await post('/api/tasks/done', { id: finishId, by: 'worker-6' });
    fs.rmSync(modePath, { force: true });
    await post('/api/presence', {});
    await sleep(100);
    const finishAttempts = readJsonLines(dispatchPath)
      .filter((entry) => entry.args[2].includes(`[task ${finishId}]`));
    check('completion removes a refused wake from recovery before it can be duplicated',
      finished.status === 200 && finishAttempts.length === 1);
  } finally {
    if (viewerController) viewerController.abort();
    await stopServer(child);
    for (let attempt = 0; attempt < 6; attempt++) {
      try { fs.rmSync(sandbox, { recursive: true, force: true }); break; }
      catch (_) { if (attempt < 5) await sleep(200); }
    }
  }

  const passed = checks.filter((item) => item.ok).length;
  for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.description}`);
  console.log(`\n${passed}/${checks.length} passed`);
  if (passed !== checks.length && output) {
    if (output.stdout) console.error('\nserver stdout:\n' + output.stdout);
    if (output.stderr) console.error('\nserver stderr:\n' + output.stderr);
  }
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error && (error.stack || error));
  process.exit(1);
});
