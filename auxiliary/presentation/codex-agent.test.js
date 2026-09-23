#!/usr/bin/env node
'use strict';
/*
 * Contract test for the Codex app-server adapter. No model turn is created:
 * child_process is stubbed before codex-agent.js loads, then this test feeds
 * the same JSONL protocol notifications the real CLI emits.
 */
const cp = require('child_process');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');

process.env.SUITE_CODEX_EXE = process.execPath;
process.env.OPENAI_API_KEY = 'must-not-reach-child';
process.env.Anthropic_Api_Key = 'must-not-reach-child-either';

const sent = [];
let fake = null;
let spawnCall = null;
cp.spawnSync = () => ({ status: 0, stdout: 'Logged in using ChatGPT\n', stderr: '' });
cp.spawn = (exe, args, options) => {
  spawnCall = { exe, args, options };
  fake = new EventEmitter();
  fake.pid = 4242;
  fake.stdout = new PassThrough();
  fake.stderr = new PassThrough();
  fake.stdin = new Writable({
    write(chunk, _encoding, done) {
      sent.push(JSON.parse(chunk.toString()));
      done();
    },
  });
  fake.kill = () => setImmediate(() => fake.emit('exit', 0, null));
  return fake;
};

const Codex = require('./codex-agent');
const checks = [];
function check(description, condition, detail = '') {
  checks.push({ description, ok: !!condition, detail });
}
function delay(ms = 10) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function feed(message) { fake.stdout.write(JSON.stringify(message) + '\n'); }
function request(method) { return sent.find((m) => m.method === method && m.id != null); }

async function main() {
  check('sonnet maps to Terra', Codex.codexModelId('sonnet') === 'gpt-5.6-terra');
  check('opus maps to Sol', Codex.codexModelId('opus') === 'gpt-5.6-sol');
  check('API-key variables are removed case-insensitively',
    !Object.keys(Codex.subscriptionEnv()).some((k) => /api_?key/i.test(k)));
  check('ChatGPT login is accepted', Codex.codexLoginStatus().ok === true);

  const agent = new Codex.CodexAgentProc({
    name: 'worker-1',
    role: 'worker',
    livePort: 4599,
    model: 'sonnet',
    maxWorkers: 2,
    maxMediaWorkers: 10,
    systemPrompt: 'test prompt',
    firstMessage: 'first task',
  });
  const events = [];
  for (const name of ['turn-start', 'turn-end', 'turn-cost', 'drained', 'exit']) {
    agent.on(name, (value) => events.push([name, value]));
  }

  check('spawns the native app-server over stdio',
    spawnCall && spawnCall.args.join(' ') === 'app-server --stdio' && spawnCall.options.shell === false);
  check('spawned child receives no API key',
    spawnCall && !Object.keys(spawnCall.options.env).some((k) => /api_?key/i.test(k)));
  check('spawned child receives the profile-specific worker cap',
    spawnCall && spawnCall.options.env.SUITE_AGENT_WORKER_CAP === '2');
  check('spawned child receives the independent media-worker cap',
    spawnCall && spawnCall.options.env.SUITE_AGENT_MEDIA_WORKER_CAP === '10');
  check('initialize is the first protocol request', sent[0] && sent[0].method === 'initialize');
  check('first task waits for thread startup', !sent.some((m) => m.method === 'turn/start'));

  feed({ id: request('initialize').id, result: {} });
  await delay();
  const threadStart = request('thread/start');
  const config = threadStart && threadStart.params && threadStart.params.config;
  check('thread uses Terra', threadStart && threadStart.params.model === 'gpt-5.6-terra');
  check('thread uses live web search',
    config && config.web_search === 'live');
  check('thread enables the full Codex tool feature set',
    config && config.features
      && [
        'shell_tool',
        'shell_snapshot',
        'browser_use',
        'browser_use_external',
        'browser_use_full_cdp_access',
        'in_app_browser',
        'computer_use',
        'image_generation',
        'apps',
        'plugins',
        'remote_plugin',
        'multi_agent',
      ].every((feature) => config.features[feature] === true));
  check('ppt MCP is required and role-scoped',
    config && config.mcp_servers.ppt.required === true
      && config.mcp_servers.ppt.env.SUITE_MCP_ROLE === 'worker'
      && config.mcp_servers.ppt.env.SUITE_AGENT_WORKER_CAP === '2'
      && config.mcp_servers.ppt.env.SUITE_AGENT_MEDIA_WORKER_CAP === '10');
  check('thread is noninteractive with full filesystem access',
    threadStart && threadStart.params.approvalPolicy === 'never'
      && threadStart.params.sandbox === 'danger-full-access');

  feed({ id: threadStart.id, result: { thread: { id: 'thread-1' } } });
  await delay();
  check('queued task starts after the thread is ready',
    sent.filter((m) => m.method === 'turn/start').length === 1);
  const firstTurnStart = sent.find((m) => m.method === 'turn/start');

  agent.enqueue('second task');
  await delay();
  check('FIFO queue never steers or overlaps a running turn',
    sent.filter((m) => m.method === 'turn/start').length === 1
      && !sent.some((m) => m.method === 'turn/steer'));

  feed({ method: 'turn/started', params: { turn: { id: 'turn-1' } } });
  feed({ method: 'thread/tokenUsage/updated', params: { tokenUsage: {
    total: { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 120 },
  } } });
  feed({ method: 'turn/completed', params: { turn: {
    id: 'turn-1',
    status: 'completed',
    items: [{ type: 'agentMessage', text: 'done' }],
  } } });
  await delay();
  const firstEnd = events.find((e) => e[0] === 'turn-end');
  check('cached input is not double-counted',
    firstEnd && firstEnd[1].usage.input === 200 && firstEnd[1].usage.cacheRead === 800);
  check('second task starts only after first completion',
    sent.filter((m) => m.method === 'turn/start').length === 2);

  // JSON-RPC responses can arrive after the corresponding turn/completed
  // notification. The late response for turn 1 must not bind its id to the
  // already-started second queued message.
  feed({ id: firstTurnStart.id, result: { turn: { id: 'turn-1' } } });
  await delay();
  check('a late turn/start response cannot corrupt the next queued turn',
    agent.inflight && agent.inflight.text === 'second task'
      && !agent.inflight.turnId && agent.activeTurnId === null);

  feed({ method: 'turn/started', params: { turn: { id: 'turn-2' } } });
  feed({ method: 'thread/tokenUsage/updated', params: { tokenUsage: {
    total: { inputTokens: 2500, cachedInputTokens: 2000, outputTokens: 200 },
  } } });
  feed({ method: 'turn/completed', params: { turn: { id: 'turn-2', status: 'completed', items: [] } } });
  await delay();
  const ends = events.filter((e) => e[0] === 'turn-end');
  check('later turn usage is a cumulative-total delta',
    ends[1] && ends[1][1].usage.input === 300
      && ends[1][1].usage.cacheRead === 1200
      && ends[1][1].usage.output === 80);
  check('Codex dollars are explicitly unmeasured',
    agent.view().costUsd === 0 && agent.view().costUsdMeasured === false);

  agent.enqueue('third task');
  await delay();
  agent.interrupt();
  check('interrupt waits until Codex supplies a turn id',
    !sent.some((m) => m.method === 'turn/interrupt'));
  feed({ method: 'turn/started', params: { turn: { id: 'turn-3' } } });
  await delay();
  check('deferred interrupt fires with the active turn id',
    sent.some((m) => m.method === 'turn/interrupt' && m.params.turnId === 'turn-3'));
  feed({ method: 'turn/completed', params: { turn: { id: 'turn-3', status: 'interrupted', items: [] } } });
  await delay();

  agent.kill();
  await delay();
  check('kill emits one exit and leaves no live adapter',
    events.filter((e) => e[0] === 'exit').length === 1 && agent.dead === true);

  sent.length = 0;
  const { ProfiledCodexAgentProc } = require('./agents.js');
  const fastProfile = new ProfiledCodexAgentProc({
    name: 'media-1',
    role: 'worker',
    livePort: 4599,
    model: 'gpt-5.6-sol',
    maxWorkers: 30,
    maxMediaWorkers: 10,
    reasoningEffort: 'ultra',
    serviceTier: 'fast',
    fastMode: true,
    fullAccess: true,
    systemPrompt: 'explicit fast-mode transport test prompt',
    firstMessage: 'fast-mode transport test task',
  });
  check('profiled Codex child receives both independent pool caps',
    spawnCall.options.env.SUITE_AGENT_WORKER_CAP === '30'
      && spawnCall.options.env.SUITE_AGENT_MEDIA_WORKER_CAP === '10');
  feed({ id: request('initialize').id, result: {} });
  await delay();
  const fastThread = request('thread/start');
  const fastConfig = fastThread && fastThread.params.config;
  check('explicit fast-mode transport uses Sol with literal ultra reasoning and Fast service',
    fastThread
      && fastThread.params.model === 'gpt-5.6-sol'
      && fastThread.params.serviceTier === 'fast'
      && fastConfig.model_reasoning_effort === 'ultra'
      && fastConfig.service_tier === 'fast'
      && fastConfig.features.fast_mode === true);
  check('explicit fast-mode transport keeps trusted filesystem, live web, and the full tool surface',
    fastThread.params.approvalPolicy === 'never'
      && fastThread.params.sandbox === 'danger-full-access'
      && fastConfig.web_search === 'live'
      && fastConfig.features.shell_tool === true
      && fastConfig.features.browser_use === true
      && fastConfig.features.computer_use === true
      && fastConfig.features.image_generation === true
      && fastConfig.features.plugins === true
      && fastConfig.features.multi_agent === true);
  check('explicit fast-mode PPT MCP receives both independent pool caps',
    fastConfig.mcp_servers.ppt.env.SUITE_AGENT_WORKER_CAP === '30'
      && fastConfig.mcp_servers.ppt.env.SUITE_AGENT_MEDIA_WORKER_CAP === '10');
  feed({ id: fastThread.id, result: { thread: { id: 'thread-fast-profile' } } });
  await delay();
  const fastTurn = request('turn/start');
  check('every explicit fast-mode turn keeps literal ultra reasoning and Fast service',
    fastTurn
      && fastTurn.params.effort === 'ultra'
      && fastTurn.params.serviceTier === 'fast'
      && fastTurn.params.approvalPolicy === 'never');
  fastProfile.kill();
  await delay();

  let passed = 0;
  for (const item of checks) {
    if (item.ok) passed++;
    console.log(`${item.ok ? '✓' : '✗ FAIL'}  ${item.description}${item.detail ? ` (${item.detail})` : ''}`);
  }
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
