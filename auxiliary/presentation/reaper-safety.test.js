#!/usr/bin/env node
'use strict';
/*
 * Deterministic viewer-idle reaper safety regression.
 *
 * Runs a disposable coordinator with fake agent processes. It proves cleanup
 * can reap genuinely idle processes without killing in-flight/queued work, and
 * that open wake assignments are restored to recovery before their idle worker
 * is stopped.
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

function makeWritable(file) {
  if (process.platform === 'win32') spawnSync('attrib', ['-R', file], { stdio: 'ignore' });
  else { try { fs.chmodSync(file, 0o644); } catch (_) {} }
}

function patchServer(suiteDir) {
  const serverPath = path.join(suiteDir, 'server.js');
  let source = fs.readFileSync(serverPath, 'utf8');

  const platformNeedle = "const IS_WIN = process.platform === 'win32';";
  if (!source.includes(platformNeedle)) throw new Error('could not isolate Windows-only work');
  source = source.replace(platformNeedle, 'const IS_WIN = false; // reaper-safety test sandbox');

  const pathNeedle = "const COM_HOST_PID_PATH = path.join(DATA, 'com_host.pid.json');";
  if (!source.includes(pathNeedle)) throw new Error('could not install reaper safety stubs');
  source = source.replace(pathNeedle, pathNeedle + `
const __reaperSafetyKillPath = path.join(DATA, '__reaper-safety-kills.jsonl');
const __reaperSafetyDispatchPath = path.join(DATA, '__reaper-safety-dispatch.jsonl');
Agents.sweepStale = () => Promise.resolve([]);
Agents.providerHealth = () => ({ ok: true, detail: 'reaper-safety stub' });
Agents.spawnOrWrite = (...args) => {
  fs.appendFileSync(__reaperSafetyDispatchPath, JSON.stringify({ args, ts: Date.now() }) + '\\n');
  return { ok: true, action: 'stubbed' };
};`);

  const routeNeedle = /  const p = url\.pathname;\r?\n/;
  if (!routeNeedle.test(source)) throw new Error('could not add reaper safety controls');
  source = source.replace(routeNeedle, (match) => match + `
  if (req.method === 'POST' && p === '/__reaper-safety/setup') {
    const b = await readBody(req);
    Agents.procs.clear();
    fs.writeFileSync(__reaperSafetyKillPath, '');
    for (const spec of (b.agents || [])) {
      const mode = spec.mode || 'idle';
      const proc = {
        name: spec.name,
        role: spec.name === 'lead' ? 'lead' : 'worker',
        provider: 'claude',
        model: 'sonnet',
        dead: false,
        inflight: mode === 'active' ? { id: 'active-turn', startedAt: Date.now() } : null,
        queue: mode === 'queued' ? [{ id: 'queued-turn' }] : [],
        kill() {
          this.dead = true;
          fs.appendFileSync(__reaperSafetyKillPath, JSON.stringify({ name: this.name, ts: Date.now() }) + '\\n');
          if (Agents.procs.get(this.name) === this) Agents.procs.delete(this.name);
        },
        view() {
          return {
            name: this.name, role: this.role, provider: this.provider, model: this.model,
            status: this.status, depth: this.depth, pid: null, startedAt: Date.now(),
          };
        },
      };
      Object.defineProperty(proc, 'status', { get() { return this.inflight ? 'thinking' : 'idle'; } });
      Object.defineProperty(proc, 'depth', { get() { return this.queue.length + (this.inflight ? 1 : 0); } });
      Agents.procs.set(proc.name, proc);
    }
    if (b.clearRecovery) {
      for (const task of board.tasks) clearTaskRecovery(task.id);
    }
    return json(res, 200, {
      ok: true,
      agents: [...Agents.procs.keys()],
      recovery: [...taskRecoveryIds],
      recoveryReady: taskRecoveryReady,
    });
  }
  if (req.method === 'POST' && p === '/__reaper-safety/reap') {
    const reaped = reapIdleAgents('viewer idle test');
    return json(res, 200, {
      ok: true,
      reaped,
      agents: [...Agents.procs.keys()],
      recovery: [...taskRecoveryIds],
    });
  }
  if (req.method === 'POST' && p === '/__reaper-safety/drain') {
    for (const proc of Agents.procs.values()) {
      proc.inflight = null;
      proc.queue.length = 0;
    }
    return json(res, 200, { ok: true, agents: [...Agents.procs.keys()] });
  }
`);

  if (!source.includes('  await migrateModel();')) throw new Error('could not skip model migration');
  source = source.replace('  await migrateModel();', '  // reaper-safety test: skip model migration');
  if (!source.includes('function scheduleRender() {')) throw new Error('could not isolate rendering');
  source = source.replace('function scheduleRender() {', 'function scheduleRender() {\n  if (process.env.SUITE_REAPER_SAFETY_TEST) return;');
  const thumbsNeedle = "      void refreshThumbsFromDeck(model.rev, 'boot thumbs pass skipped:');";
  if (!source.includes(thumbsNeedle)) throw new Error('could not isolate boot thumbnails');
  source = source.replace(thumbsNeedle, '      // reaper-safety test: no boot thumbnail export');
  fs.writeFileSync(serverPath, source);
}

function seedSandbox(suiteDir) {
  const data = path.join(suiteDir, 'data');
  const statePath = path.join(data, 'state.json');
  const boardPath = path.join(data, 'board.json');
  for (const file of [statePath, boardPath, path.join(data, 'model.json')]) makeWritable(file);
  fs.rmSync(path.join(data, 'agents.pid.json'), { force: true });
  fs.rmSync(path.join(data, 'com_host.pid.json'), { force: true });
  fs.writeFileSync(statePath, JSON.stringify({
    paused: false,
    pausedBy: null,
    pausedAt: null,
    pdfRev: null,
    log: [],
    loopRunner: false,
    usageProfile: 'extra',
    agentProvider: 'claude',
  }, null, 2));
  const task = (id, assignee, status = 'open', wakeWorker = true) => ({
    id,
    text: id,
    by: 'lead',
    assignee,
    wakeWorker,
    status,
    claimedBy: status === 'done' ? assignee : '',
    ts: Date.now(),
    doneTs: status === 'done' ? Date.now() : null,
  });
  fs.writeFileSync(boardPath, JSON.stringify({
    notes: [],
    loops: [],
    tasks: [
      task('t-idle-retry', 'worker-4'),
      task('t-active-retry', 'worker-8'),
      task('t-queued-retry', 'worker-10'),
      task('t-completed', 'worker-3', 'done'),
      task('t-held', 'worker-3', 'open', false),
    ],
  }, null, 2));
}

function startServer(suiteDir, port) {
  const output = { stdout: '', stderr: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: suiteDir,
    env: Object.assign({}, process.env, {
      SUITE_PORT: String(port),
      SUITE_REAPER_SAFETY_TEST: '1',
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
  const sandbox = path.join(os.tmpdir(), 'reaper-safety-' + crypto.randomBytes(5).toString('hex'));
  const suiteDir = path.join(sandbox, 'suite');
  const data = path.join(suiteDir, 'data');
  const killPath = path.join(data, '__reaper-safety-kills.jsonl');
  const dispatchPath = path.join(data, '__reaper-safety-dispatch.jsonl');
  let child = null;
  let output = null;
  let viewerController = null;
  try {
    fs.cpSync(HERE, suiteDir, { recursive: true });
    fs.copyFileSync(path.join(HERE, '..', 'presentation.pptx'), path.join(sandbox, 'presentation.pptx'));
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
    await waitFor('reaper safety server', async () => (await fetch(base + '/api/health')).ok);

    let setup;
    await waitFor('task recovery initialization', async () => {
      setup = await post('/__reaper-safety/setup', {
        agents: [
          { name: 'lead', mode: 'idle' },
          { name: 'worker-3', mode: 'idle' },
          { name: 'worker-4', mode: 'idle' },
          { name: 'worker-8', mode: 'active' },
          { name: 'worker-10', mode: 'queued' },
        ],
        clearRecovery: true,
      });
      return setup.body && setup.body.recoveryReady;
    });
    check('fixture starts with no volatile recovery entries', setup.body.recovery.length === 0);

    const first = await post('/__reaper-safety/reap');
    const firstKills = readJsonLines(killPath).map((entry) => entry.name).sort();
    check('viewer-idle cleanup reaps only genuinely idle agents',
      first.body.reaped === true
        && JSON.stringify(firstKills) === JSON.stringify(['lead', 'worker-3', 'worker-4'])
        && JSON.stringify(first.body.agents.sort()) === JSON.stringify(['worker-10', 'worker-8']));
    check('in-flight and queued agents survive viewer-idle cleanup',
      first.body.agents.includes('worker-8')
        && first.body.agents.includes('worker-10')
        && !firstKills.includes('worker-8')
        && !firstKills.includes('worker-10'));
    check('reaping an idle worker restores only its open wake task to recovery',
      JSON.stringify(first.body.recovery.sort()) === JSON.stringify(['t-idle-retry']));

    const repeated = await post('/__reaper-safety/reap');
    check('cleanup with only active or queued agents is a no-op',
      repeated.body.reaped === false
        && repeated.body.agents.length === 2
        && readJsonLines(killPath).length === 3);

    const stateAfterFirst = await api(base, '/api/state');
    const reapLog = stateAfterFirst.body.log.filter((entry) => entry.kind === 'agents-reaped').pop();
    check('reaper log exposes protected agents and restored task ids',
      reapLog
        && /worker-8/.test(reapLog.protected)
        && /worker-10/.test(reapLog.protected)
        && reapLog.tasksRequeued === 't-idle-retry');

    viewerController = new AbortController();
    const viewer = await fetch(base + '/api/events?viewer=reaper-safety', {
      signal: viewerController.signal,
    });
    check('a real viewer reconnect succeeds', viewer.status === 200);
    await waitFor('restored task dispatch', () =>
      readJsonLines(dispatchPath).some((entry) => entry.args[2].includes('[task t-idle-retry]')));
    const restored = readJsonLines(dispatchPath)
      .filter((entry) => entry.args[2].includes('[task t-idle-retry]'));
    check('the restored durable task retries once with the recovery guard',
      restored.length === 1
        && restored[0].args[0] === 'worker-4'
        && /\[recovered task retry\]/i.test(restored[0].args[2]));
    viewerController.abort();
    viewerController = null;

    await post('/__reaper-safety/drain');
    const drained = await post('/__reaper-safety/reap');
    const allKills = readJsonLines(killPath).map((entry) => entry.name).sort();
    check('ordinary cleanup resumes after protected work drains',
      drained.body.reaped === true
        && drained.body.agents.length === 0
        && JSON.stringify(allKills) === JSON.stringify([
          'lead', 'worker-10', 'worker-3', 'worker-4', 'worker-8',
        ]));
    check('drained workers with open wake tasks are queued before cleanup',
      JSON.stringify(drained.body.recovery.sort()) === JSON.stringify([
        't-active-retry', 't-queued-retry',
      ]));
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
