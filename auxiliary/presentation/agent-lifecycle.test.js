#!/usr/bin/env node
'use strict';
/*
 * Deterministic regressions for AgentProc's failure paths. No real provider is
 * contacted: process and stream behavior is driven through small in-memory
 * fakes, and guard generation is exercised only in a throwaway directory.
 */
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HERE = __dirname;
const SETTINGS = path.join(HERE, 'agent-settings.json');
const checks = [];
function check(description, condition) {
  checks.push({ description, ok: !!condition });
}

// The account-specific hook command is generated runtime state, not committed
// source. Merely loading the library must neither create nor mutate it.
const beforeExists = fs.existsSync(SETTINGS);
const beforeStat = beforeExists ? fs.statSync(SETTINGS) : null;
const beforeContent = beforeExists ? fs.readFileSync(SETTINGS, 'utf8') : null;
const requireOnly = spawnSync(process.execPath, ['-e', "require('./agents.js')"], {
  cwd: HERE,
  encoding: 'utf8',
});
const afterExists = fs.existsSync(SETTINGS);
const afterStat = afterExists ? fs.statSync(SETTINGS) : null;
check('require("./agents.js") exits cleanly', requireOnly.status === 0);
check('require("./agents.js") neither creates nor rewrites generated guard settings',
  afterExists === beforeExists
  && (!beforeExists || (fs.readFileSync(SETTINGS, 'utf8') === beforeContent
    && afterStat.mtimeMs === beforeStat.mtimeMs)));

const {
  AgentProc,
  AgentsManager,
  guardSettingsForSpawn,
  STDERR_LIMIT,
  STDOUT_FRAME_LIMIT,
} = require('./agents.js');

const temp = path.join(os.tmpdir(), 'agent-lifecycle-' + crypto.randomBytes(5).toString('hex'));
fs.mkdirSync(temp, { recursive: true });
try {
  const guard = path.join(temp, 'guard script.js');
  const settings = path.join(temp, 'settings.json');
  fs.writeFileSync(guard, "'use strict';\n");
  check('generated guard settings start absent', !fs.existsSync(settings));
  let missingGuardRefused = false;
  try {
    guardSettingsForSpawn({
      settingsFile: settings,
      guardFile: path.join(temp, 'missing guard.js'),
    });
  } catch (_) {
    missingGuardRefused = true;
  }
  check('a restricted spawn refuses before writing settings when its guard is missing',
    missingGuardRefused && !fs.existsSync(settings));
  const trustedSettings = path.join(temp, 'trusted-settings.json');
  check('a trusted spawn neither generates nor loads restrictive guard settings',
    guardSettingsForSpawn({
      fullAccess: true,
      settingsFile: trustedSettings,
      guardFile: path.join(temp, 'missing guard.js'),
    }) === null && !fs.existsSync(trustedSettings));
  const prepared = guardSettingsForSpawn({ settingsFile: settings, guardFile: guard });
  check('restricted spawn preparation creates only its requested settings file',
    prepared === settings && fs.existsSync(settings));
  const configured = new AgentsManager();
  configured.configure({
    prepareClaudeGuard: true,
    guardSettingsPath: settings,
    guardScriptPath: guard,
  });
  const generated = JSON.parse(fs.readFileSync(settings, 'utf8'));
  const command = generated.hooks.PreToolUse[0].hooks[0].command;
  check('an explicit configured boot generates the Claude guard settings',
    command === `node "${guard.replace(/\\/g, '/')}"`);
  const firstMtime = fs.statSync(settings).mtimeMs;
  configured.configure({
    prepareClaudeGuard: true,
    guardSettingsPath: settings,
    guardScriptPath: guard,
  });
  check('an unchanged guard configuration is not rewritten on repeated preparation',
    fs.statSync(settings).mtimeMs === firstMtime);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

function message(id) {
  return { id, text: id, enqueuedAt: 0, startedAt: Date.now() };
}

function fakeProc({ inflight = message('active'), queue = [message('queued')] } = {}) {
  const agent = Object.create(AgentProc.prototype);
  EventEmitter.call(agent);
  const killed = { count: 0 };
  Object.assign(agent, {
    name: 'worker-1',
    role: 'worker',
    provider: 'claude',
    model: 'sonnet',
    reportedModel: null,
    costUsd: 0,
    turns: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    currentTool: null,
    t0: Date.now(),
    startedAt: Date.now(),
    queue: queue.slice(),
    inflight,
    history: [],
    dead: false,
    _exited: false,
    _stderr: '',
    _stdoutBuf: '',
    msgSeq: 2,
    proc: {
      killed: false,
      kill() { killed.count++; this.killed = true; },
      stdin: {
        destroyed: false,
        writable: true,
        write(_payload, callback) { if (callback) callback(); return true; },
      },
    },
  });
  return { agent, killed };
}

{
  const { agent, killed } = fakeProc();
  const failed = [];
  let exits = 0;
  agent.on('turn-failed', (m) => failed.push(m.id));
  agent.on('exit', () => { exits++; });
  agent._failProcess('spawn-error', new Error('ENOENT'));
  agent._onExit(1, null);
  check('a child spawn error fails both active and queued work',
    agent.dead && failed.join(',') === 'active,queued');
  check('a child spawn error emits exactly one exit and kills the child',
    exits === 1 && killed.count === 1);
}

{
  const { agent } = fakeProc();
  const failed = [];
  let streamErrors = 0;
  agent.on('turn-failed', (m) => failed.push(m.id));
  agent.on('stream-error', () => { streamErrors++; });
  agent._consumeStdout('not-json\n');
  check('a malformed protocol frame terminates instead of wedging the queue',
    agent.dead && agent.inflight === null && agent.queue.length === 0
    && failed.join(',') === 'active,queued' && streamErrors === 1);
}

{
  const { agent } = fakeProc({ inflight: null, queue: [message('first'), message('second')] });
  const failed = [];
  agent.proc.stdin.destroyed = true;
  agent.on('turn-failed', (m) => failed.push(m.id));
  agent._pump();
  check('a dead stdin drains and fails the full queue',
    agent.dead && failed.join(',') === 'first,second' && agent.depth === 0);
}

{
  const { agent } = fakeProc();
  agent._appendStderr('a'.repeat(STDERR_LIMIT * 3));
  agent._appendStderr('TAIL');
  check('stderr diagnostics retain a bounded tail',
    agent._stderr.length === STDERR_LIMIT && agent._stderr.endsWith('TAIL'));
}

{
  const { agent } = fakeProc();
  const failed = [];
  agent.on('turn-failed', (m) => failed.push(m.id));
  agent._consumeStdout('x'.repeat(STDOUT_FRAME_LIMIT + 1));
  check('an unterminated oversized stdout frame is bounded and fails closed',
    agent.dead && failed.join(',') === 'active,queued'
    && agent._stdoutBuf.length <= STDOUT_FRAME_LIMIT + 1);
}

{
  const next = message('next');
  const { agent } = fakeProc({ inflight: message('done'), queue: [next] });
  const writes = [];
  agent.proc.stdin.write = (payload, callback) => {
    writes.push(JSON.parse(payload));
    if (callback) callback();
    return true;
  };
  agent._consumeStdout(JSON.stringify({
    type: 'result',
    result: 'ok',
    usage: {},
  }) + '\n');
  check('a valid result advances exactly one queued message',
    !agent.dead && agent.inflight === next && agent.queue.length === 0
    && writes.length === 1 && writes[0].message.content[0].text === 'next');
}

{
  const manager = new AgentsManager();
  manager.configure({ usageProfile: () => 'normal' });
  check('a worker cannot claim the reserved lead identity',
    manager.spawnOrWrite('lead', 'worker', 'x').ok === false);
  check('a lead cannot claim a worker identity',
    manager.spawnOrWrite('worker-1', 'lead', 'x').ok === false);
  check('worker names outside the configured set are rejected before spawn',
    manager.spawnOrWrite('worker-3', 'worker', 'x').ok === false);
  let threw = false;
  try { manager.spawn('lead', { role: 'worker', firstMessage: 'x' }); } catch (_) { threw = true; }
  check('the lower-level spawn API enforces the same identity rule', threw);
  const existingWorker = {
    role: 'worker',
    dead: false,
    enqueue: () => ({ id: 'accepted' }),
  };
  manager.procs.set('worker-2', existingWorker);
  manager.configure({ usageProfile: () => 'low' });
  const followup = manager.spawnOrWrite('worker-2', 'worker', 'follow up');
  check('a profile reduction does not strand an already-running worker',
    followup.ok === true && followup.action === 'write');

  const existingMedia = {
    name: 'media-10',
    role: 'worker',
    pool: 'media',
    dead: false,
    enqueue: () => ({ id: 'accepted-media' }),
  };
  manager.procs.set('media-10', existingMedia);
  const mediaFollowup = manager.spawnOrWrite('media-10', 'worker', 'finish durable media work');
  check('a profile reduction does not strand an already-running media worker',
    mediaFollowup.ok === true && mediaFollowup.action === 'write');
  check('a lowered profile still refuses to spawn a new media identity',
    manager.spawnOrWrite('media-1', 'worker', 'new media work').ok === false);
}

{
  const manager = new AgentsManager();
  manager._persistPids = () => false;
  const oldProc = new EventEmitter();
  Object.assign(oldProc, {
    name: 'worker-1',
    role: 'worker',
    pid: 1,
    startedAt: 1,
    view: () => ({ name: 'worker-1' }),
  });
  const replacement = { name: 'worker-1', role: 'worker' };
  manager.procs.set('worker-1', oldProc);
  manager._wire(oldProc);
  manager.procs.set('worker-1', replacement);
  oldProc.emit('exit', { code: 0, sig: null });
  check('a stale child exit cannot delete a same-name replacement',
    manager.procs.get('worker-1') === replacement);
}

const passed = checks.filter((item) => item.ok).length;
for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.description}`);
console.log(`\n${passed}/${checks.length} passed`);
process.exit(passed === checks.length ? 0 : 1);
