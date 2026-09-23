#!/usr/bin/env node
'use strict';
/*
 * Profile, provider, and spend reset are control-plane choices. A successful
 * HTTP response must mean the choice survived state.json, rather than merely
 * changing this server's in-memory state until the next restart. Exercise
 * both atomic-write failure paths in isolated servers, including the guarded
 * ppt spend --reset path used by agents.
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
function prepareState(suiteDir) {
  const data = path.join(suiteDir, 'data');
  const statePath = path.join(data, 'state.json');
  makeWritable(statePath);
  makeWritable(path.join(data, 'model.json'));
  fs.writeFileSync(statePath, JSON.stringify({
    paused: true, pausedBy: 'state-control-test', pausedAt: 1, pdfRev: null,
    // Deliberately omit agentFastMode to exercise restart-compatible default OFF
    // behavior for state.json files written before the Fast control existed.
    log: [], loopRunner: false, usageProfile: 'normal', agentProvider: 'claude',
    spend: {
      sinceTs: 1, totalUsd: 12.34, turns: 2,
      tokens: { input: 10, output: 20, cacheRead: 3, cacheWrite: 4 },
      byModel: { sonnet: { usd: 12.34, turns: 2, promptTokens: 10, outputTokens: 20 } },
      byRole: { worker: { usd: 12.34, turns: 2 } },
      recent: [{ ts: 1, model: 'sonnet', role: 'worker', usd: 12.34 }]
    }
  }, null, 2));
}

function patchServerForTest(suiteDir) {
  const serverPath = path.join(suiteDir, 'server.js');
  let source = fs.readFileSync(serverPath, 'utf8');
  const platformNeedle = "const IS_WIN = process.platform === 'win32';";
  if (!source.includes(platformNeedle)) throw new Error('could not isolate Windows-only work');
  source = source.replace(platformNeedle, 'const IS_WIN = false; // state-control persistence test sandbox');

  const pathNeedle = "const COM_HOST_PID_PATH = path.join(DATA, 'com_host.pid.json');";
  if (!source.includes(pathNeedle)) throw new Error('could not add state persistence fault hook');
  source = source.replace(pathNeedle, pathNeedle + `
const __stateControlModePath = path.join(DATA, '__state-control-test-mode');
const __stateControlWriteFileSync = fs.writeFileSync.bind(fs);
const __stateControlRenameSync = fs.renameSync.bind(fs);
function __stateControlMode() { try { return fs.readFileSync(__stateControlModePath, 'utf8').trim(); } catch (_) { return ''; } }
function __stateControlError() { const err = new Error('forced state-control persistence failure'); err.code = 'EPERM'; return err; }
fs.writeFileSync = function(file, data, ...args) {
  const mode = __stateControlMode();
  const target = String(file);
  if (mode === 'temp' && target.startsWith(STATE_PATH + '.')) throw __stateControlError();
  if (mode === 'final' && target === STATE_PATH) throw __stateControlError();
  return __stateControlWriteFileSync(file, data, ...args);
};
fs.renameSync = function(from, to) {
  if (__stateControlMode() === 'final' && String(to) === STATE_PATH) throw __stateControlError();
  return __stateControlRenameSync(from, to);
};
const __stateControlIsAgent = Agents.isAgent.bind(Agents);
Agents.isAgent = (name) => String(name) === 'worker-1' || __stateControlIsAgent(name);`);

  const broadcastNeedle = 'function broadcast(event) {';
  if (!source.includes(broadcastNeedle)) throw new Error('could not trace broadcasts');
  source = source.replace(broadcastNeedle, `const __stateControlEventsPath = path.join(DATA, '__state-control-events.jsonl');
function broadcast(event) {
  if (process.env.SUITE_STATE_CONTROL_TEST) {
    try { fs.appendFileSync(__stateControlEventsPath, JSON.stringify(event) + '\\n'); } catch (_) {}
  }`);

  const routeNeedle = /  const p = url\.pathname;\r?\n/;
  if (!routeNeedle.test(source)) throw new Error('could not add state-control test route');
  source = source.replace(routeNeedle, (match) => match + `
  if (req.method === 'GET' && p === '/__state-control-test/raw') {
    return json(res, 200, { ok: true, state });
  }
`);
  const healthNeedle = 'const health = Agents.providerHealth(want, { refresh: true });';
  if (!source.includes(healthNeedle)) throw new Error('could not make provider health deterministic');
  source = source.replace(healthNeedle, `const health = { ok: true, detail: 'state-control test provider stub' };`);
  if (!source.includes('  await migrateModel();')) throw new Error('could not skip migration');
  source = source.replace('  await migrateModel();', '  // state-control persistence test: skip migration');
  if (!source.includes('function scheduleRender() {')) throw new Error('could not isolate render');
  source = source.replace('function scheduleRender() {', 'function scheduleRender() {\n  if (process.env.SUITE_STATE_CONTROL_TEST) return;');
  const thumbsNeedle = "    void refreshThumbsFromDeck(model.rev, 'boot thumbs pass skipped:');";
  if (!source.includes(thumbsNeedle)) throw new Error('could not skip thumbnail boot');
  source = source.replace(thumbsNeedle, '    // state-control persistence test: no background thumbnail export');
  fs.writeFileSync(serverPath, source);
}

function startServer(suiteDir, port) {
  return spawn(process.execPath, ['server.js'], {
    cwd: suiteDir,
    env: Object.assign({}, process.env, { SUITE_PORT: String(port), SUITE_STATE_CONTROL_TEST: '1' }),
    stdio: ['ignore', 'ignore', 'ignore']
  });
}
async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try { child.kill(); } catch (_) {}
  await Promise.race([exited, sleep(1500)]);
}
function readEvents(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
  catch (_) { return []; }
}
const checks = [];
function check(description, condition) { checks.push({ description, ok: !!condition }); }

async function main() {
  const sandbox = path.join(os.tmpdir(), 'state-control-persistence-' + crypto.randomBytes(4).toString('hex'));
  const suiteDir = path.join(sandbox, 'suite');
  const data = path.join(suiteDir, 'data');
  const statePath = path.join(data, 'state.json');
  const modePath = path.join(data, '__state-control-test-mode');
  const eventsPath = path.join(data, '__state-control-events.jsonl');
  let child = null;
  let port = null;
  const setMode = (mode) => { if (mode) fs.writeFileSync(modePath, mode); else fs.rmSync(modePath, { force: true }); };
  try {
    fs.cpSync(HERE, suiteDir, {
      recursive: true,
      // Live Chromium profiles hold files open on Windows and are unrelated to
      // this isolated state contract.
      filter(source) {
        const relative = path.relative(HERE, source);
        return !/^data[\\/](?:codex-viewer-profile|chrome-[^\\/]+)/i.test(relative);
      }
    });
    fs.rmSync(path.join(data, 'com_host.pid.json'), { force: true });
    fs.rmSync(path.join(data, 'agents.pid.json'), { force: true });
    prepareState(suiteDir);
    patchServerForTest(suiteDir);
    port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const raw = async () => (await api(base, '/__state-control-test/raw')).body.state;
    const post = (route, body) => api(base, route, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    child = startServer(suiteDir, port);
    await waitFor('state-control persistence sandbox health', async () => (await fetch(base + '/api/health')).ok, 8000);

    const initial = await raw();
    const initialDisk = fs.readFileSync(statePath, 'utf8');
    const initialDiskState = JSON.parse(initialDisk);
    const initialFast = await api(base, '/api/agents/fast-mode');
    check('legacy state without Fast defaults OFF and GET is an honest non-mutating Claude view',
      initial.agentFastMode === false
        && !Object.prototype.hasOwnProperty.call(initialDiskState, 'agentFastMode')
        && initialFast.status === 200 && initialFast.body.enabled === false
        && initialFast.body.available === false
        && initialFast.body.appliedToNextSpawn === false
        && initialFast.body.appliesTo === 'next spawn'
        && /unavailable|not applied/i.test(initialFast.body.reason)
        && JSON.stringify(await raw()) === JSON.stringify(initial)
        && fs.readFileSync(statePath, 'utf8') === initialDisk);
    const agentFast = await post('/api/agents/fast-mode', { enabled: true, by: 'worker-1' });
    const rootFast = await post('/api/agents/fast-mode', { enabled: true, by: 'codex-root' });
    const mixedCaseAgentFast = await post('/api/agents/fast-mode', { enabled: true, by: 'Worker-1' });
    check('worker and root agent identities cannot change Fast mode, regardless of case',
      agentFast.status === 403 && rootFast.status === 403 && mixedCaseAgentFast.status === 403
        && JSON.stringify(await raw()) === JSON.stringify(initial)
        && fs.readFileSync(statePath, 'utf8') === initialDisk);
    const badFastType = await post('/api/agents/fast-mode', { enabled: 'true', by: 'human' });
    const missingFastAuthor = await post('/api/agents/fast-mode', { enabled: true });
    const extraFastField = await post('/api/agents/fast-mode', { enabled: true, by: 'human', profile: 'beast' });
    check('Fast mode accepts only an exact boolean and named human author',
      badFastType.status === 400 && missingFastAuthor.status === 400 && extraFastField.status === 400
        && JSON.stringify(await raw()) === JSON.stringify(initial));
    const agentClient = spawnSync(process.execPath, ['ppt.js', 'spend', '--reset'], {
      cwd: suiteDir,
      env: Object.assign({}, process.env, { SUITE_PORT: String(port), SUITE_HOST: '127.0.0.1', SUITE_EDITOR: 'worker-1', NO_COLOR: '1' }),
      encoding: 'utf8', timeout: 5000
    });
    const afterAgent = await raw();
    check('ppt spend --reset identifies an agent and is refused', agentClient.status === 1 && JSON.stringify(afterAgent) === JSON.stringify(initial));
    check('refused agent spend reset leaves state.json untouched', fs.readFileSync(statePath, 'utf8') === initialDisk);
    const formReset = await api(base, '/api/spend/reset', {
      method: 'POST', headers: { 'Content-Type': 'text/plain', Origin: 'http://evil.example' }, body: ''
    });
    check('a CORS-safelisted form-style spend reset is refused before mutation',
      formReset.status === 415 && JSON.stringify(await raw()) === JSON.stringify(initial));
    const foreignFast = await api(base, '/api/agents/fast-mode', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
      body: JSON.stringify({ enabled: true, by: 'human' })
    });
    check('a foreign-origin Fast control request is refused before mutation',
      foreignFast.status === 403 && JSON.stringify(await raw()) === JSON.stringify(initial));

    const controls = [
      {
        name: 'usage profile', route: '/api/agents/profile',
        body: { profile: 'low', by: 'human' }, event: 'agents',
        applied: (s) => s.usageProfile === 'low'
      },
      {
        name: 'agent provider', route: '/api/agents/provider',
        body: { provider: 'codex', by: 'human' }, event: 'agents',
        applied: (s) => s.agentProvider === 'codex'
      },
      {
        name: 'Fast mode', route: '/api/agents/fast-mode',
        body: { enabled: true, by: 'human' }, event: 'agents',
        applied: (s) => s.agentFastMode === true
      },
      {
        name: 'spend reset', route: '/api/spend/reset',
        body: { by: 'human' }, event: 'spend',
        applied: (s) => s.spend && s.spend.turns === 0 && s.spend.totalUsd === 0
      }
    ];
    for (const control of controls) {
      for (const mode of ['temp', 'final']) {
        const before = await raw();
        const diskBefore = fs.readFileSync(statePath, 'utf8');
        fs.writeFileSync(eventsPath, '');
        setMode(mode);
        const response = await within(`${mode} failed ${control.name} response`, post(control.route, control.body), 2500);
        setMode('');
        const after = await raw();
        const diskAfter = fs.readFileSync(statePath, 'utf8');
        const leaked = readEvents(eventsPath).some((event) => event.type === control.event);
        check(`${mode}: failed ${control.name} returns a timely 500`, response.status === 500 && response.body && response.body.ok === false);
        check(`${mode}: failed ${control.name} leaves memory and state.json unchanged`,
          JSON.stringify(after) === JSON.stringify(before) && diskAfter === diskBefore);
        check(`${mode}: failed ${control.name} emits no ${control.event} success event`, !leaked);
      }
      fs.writeFileSync(eventsPath, '');
      const success = await post(control.route, control.body);
      const afterSuccess = await raw();
      check(`${control.name} succeeds after storage recovers`,
        success.status === 200 && success.body && success.body.ok === true && control.applied(afterSuccess));
      check(`${control.name} publishes its success only after the durable write`,
        readEvents(eventsPath).some((event) => event.type === control.event));
    }

    const beastProfile = await post('/api/agents/profile', { profile: 'beast', by: 'human' });
    const beastClaude = await post('/api/agents/provider', { provider: 'claude', by: 'human' });
    check('beast accepts Claude Opus while saved Fast stays honestly unavailable and unapplied',
      beastProfile.status === 200
        && beastClaude.status === 200
        && beastClaude.body.provider === 'claude'
        && beastClaude.body.configuredProvider === 'claude'
        && beastClaude.body.forcedProvider === null
        && beastClaude.body.nextModels.lead === 'opus'
        && beastClaude.body.nextModels.worker === 'opus'
        && beastClaude.body.poolCaps.general === 30
        && beastClaude.body.poolCaps.media === 10
        && beastClaude.body.nextExecution.reasoningEffort === 'ultra'
        && beastClaude.body.nextExecution.serviceTier === 'standard'
        && beastClaude.body.nextExecution.fastMode === false
        && beastClaude.body.nextExecution.fullAccess === true
        && beastClaude.body.fastMode.enabled === true
        && beastClaude.body.fastMode.available === false
        && beastClaude.body.fastMode.appliedToNextSpawn === false
        && /not applied on Claude/i.test(beastClaude.body.fastMode.reason));

    await stopServer(child); child = null;
    child = startServer(suiteDir, port);
    await waitFor('restarted state-control persistence sandbox health', async () => (await fetch(base + '/api/health')).ok, 8000);
    const afterRestart = await raw();
    const profileAfterRestart = (await api(base, '/api/agents/profile')).body;
    const fastAfterRestart = (await api(base, '/api/agents/fast-mode')).body;
    const diskAfterRestart = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    check('persisted Beast Claude provider and spend reset survive restart with Opus still selected for next spawns',
      afterRestart.usageProfile === 'beast'
        && afterRestart.agentProvider === 'claude'
        && afterRestart.spend.turns === 0
        && diskAfterRestart.usageProfile === 'beast'
        && diskAfterRestart.agentProvider === 'claude'
        && diskAfterRestart.agentFastMode === true
        && diskAfterRestart.spend.turns === 0
        && profileAfterRestart.profile === 'beast'
        && profileAfterRestart.provider === 'claude'
        && profileAfterRestart.configuredProvider === 'claude'
        && profileAfterRestart.forcedProvider === null
        && profileAfterRestart.nextModels.lead === 'opus'
        && profileAfterRestart.nextModels.worker === 'opus'
        && profileAfterRestart.nextExecution.reasoningEffort === 'ultra'
        && profileAfterRestart.nextExecution.fullAccess === true
        && fastAfterRestart.enabled === true
        && fastAfterRestart.available === false
        && fastAfterRestart.appliedToNextSpawn === false);

    const rosterBeforeFastProvider = (await api(base, '/api/agents')).body.agents;
    const codexFast = await post('/api/agents/provider', { provider: 'codex', by: 'human' });
    const rosterAfterFastProvider = (await api(base, '/api/agents')).body.agents;
    check('saved Fast applies to the next Codex spawn without changing the selected Beast contract or roster',
      codexFast.status === 200
        && codexFast.body.profile === 'beast'
        && codexFast.body.provider === 'codex'
        && codexFast.body.nextModels.lead === 'gpt-5.6-sol'
        && codexFast.body.nextModels.worker === 'gpt-5.6-sol'
        && codexFast.body.poolCaps.general === 30
        && codexFast.body.poolCaps.media === 10
        && codexFast.body.nextExecution.reasoningEffort === 'ultra'
        && codexFast.body.nextExecution.serviceTier === 'fast'
        && codexFast.body.nextExecution.fastMode === true
        && codexFast.body.nextExecution.fullAccess === true
        && JSON.stringify(rosterAfterFastProvider) === JSON.stringify(rosterBeforeFastProvider));

    const serverSource = fs.readFileSync(path.join(HERE, 'server.js'), 'utf8');
    const fastRoute = serverSource.slice(
      serverSource.indexOf("if (req.method === 'GET' && p === '/api/agents/fast-mode')"),
      serverSource.indexOf("if (req.method === 'POST' && p === '/api/agents/profile')")
    );
    check('Fast route has no spawn, recovery, stop, interrupt, task, protection, or deck mutation path',
      fastRoute.length > 0
        && !/dispatchTaskRecovery\s*\(|Agents\.(?:spawn|spawnOrWrite|stop|stopAll|interrupt|interruptAll)\s*\(|\b(?:model|board|state\.protections)\s*=/i.test(fastRoute));
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
