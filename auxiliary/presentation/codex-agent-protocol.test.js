#!/usr/bin/env node
'use strict';
/*
 * Failure-path and turn-isolation tests for codex-agent.js.
 *
 * The real Codex CLI is never launched. Each scenario reloads the adapter
 * after installing a deterministic child_process stub so require-time timeout
 * and frame-limit configuration can be exercised without leaking state into
 * another test.
 */
const cp = require('child_process');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');

const MODULE = require.resolve('./codex-agent');
const original = {
  spawn: cp.spawn,
  spawnSync: cp.spawnSync,
  exe: process.env.SUITE_CODEX_EXE,
  timeout: process.env.SUITE_CODEX_RPC_TIMEOUT_MS,
  frameLimit: process.env.SUITE_CODEX_STDOUT_FRAME_LIMIT,
  openaiKey: process.env.OPENAI_API_KEY,
};

const checks = [];
function check(description, condition, detail = '') {
  checks.push({ description, ok: !!condition, detail });
}
function delay(ms = 10) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 4242;
    this.sent = [];
    this.killCalls = 0;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new Writable({
      write: (chunk, _encoding, done) => {
        try {
          this.sent.push(JSON.parse(chunk.toString()));
          done();
        } catch (error) {
          done(error);
        }
      },
    });
  }

  kill() {
    this.killCalls += 1;
    setImmediate(() => this.emit('exit', 0, null));
    return true;
  }
}

function setOrDelete(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function loadHarness({ timeoutMs, frameLimit } = {}) {
  process.env.SUITE_CODEX_EXE = process.execPath;
  process.env.OPENAI_API_KEY = 'must-not-reach-child';
  setOrDelete('SUITE_CODEX_RPC_TIMEOUT_MS',
    timeoutMs == null ? undefined : String(timeoutMs));
  setOrDelete('SUITE_CODEX_STDOUT_FRAME_LIMIT',
    frameLimit == null ? undefined : String(frameLimit));

  const children = [];
  cp.spawnSync = () => ({
    status: 0,
    stdout: 'Logged in using ChatGPT\n',
    stderr: '',
  });
  cp.spawn = () => {
    const child = new FakeChild();
    children.push(child);
    return child;
  };

  delete require.cache[MODULE];
  const Codex = require('./codex-agent');
  return {
    Codex,
    children,
    create(options = {}) {
      const agent = new Codex.CodexAgentProc({
        name: options.name || `worker-${children.length + 1}`,
        role: 'worker',
        livePort: 4599,
        model: 'sonnet',
        maxWorkers: 2,
        systemPrompt: 'protocol regression test',
        firstMessage: options.firstMessage,
      });
      return { agent, child: children[children.length - 1] };
    },
  };
}

function feed(child, message) {
  child.stdout.write(JSON.stringify(message) + '\n');
}

function request(child, method, occurrence = 0) {
  return child.sent.filter((message) =>
    message.method === method && message.id != null)[occurrence];
}

async function openThread(agent, child) {
  const initialize = request(child, 'initialize');
  if (!initialize) throw new Error('initialize request was not sent');
  feed(child, { id: initialize.id, result: {} });
  await delay();
  const threadStart = request(child, 'thread/start');
  if (!threadStart) throw new Error('thread/start request was not sent');
  feed(child, {
    id: threadStart.id,
    result: { thread: { id: `thread-${child.pid}` } },
  });
  await delay();
  return agent;
}

async function testLateTurnNotifications() {
  const harness = loadHarness();
  const { agent, child } = harness.create({ firstMessage: 'first task' });
  const ends = [];
  agent.on('turn-end', (turn) => ends.push(turn));
  await openThread(agent, child);

  agent.enqueue('second task');
  feed(child, {
    method: 'turn/started',
    params: { turn: { id: 'turn-one' } },
  });
  feed(child, {
    method: 'item/agentMessage/delta',
    params: { turnId: 'turn-one', delta: 'first response' },
  });
  feed(child, {
    method: 'turn/completed',
    params: {
      turn: {
        id: 'turn-one',
        status: 'completed',
        items: [{ type: 'agentMessage', text: 'first response' }],
      },
    },
  });
  await delay();

  feed(child, {
    method: 'turn/started',
    params: { turn: { id: 'turn-two' } },
  });
  check('the second turn starts with a clean response buffer',
    agent.inflight && agent.inflight.text === 'second task'
      && agent.responseText === '');

  // Every one of these frames belongs to the now-closed first turn. None may
  // change the live second turn's response, tool, or error state.
  feed(child, {
    method: 'item/agentMessage/delta',
    params: { turnId: 'turn-one', delta: 'LATE DELTA' },
  });
  feed(child, {
    method: 'item/started',
    params: {
      turnId: 'turn-one',
      item: {
        id: 'late-tool',
        type: 'mcpToolCall',
        server: 'ppt',
        tool: 'ppt_status',
      },
    },
  });
  feed(child, {
    method: 'item/completed',
    params: {
      turnId: 'turn-one',
      item: { id: 'late-message', type: 'agentMessage', text: 'LATE ITEM' },
    },
  });
  feed(child, {
    method: 'error',
    params: {
      turnId: 'turn-one',
      message: 'LATE ERROR',
      willRetry: false,
    },
  });
  await delay();

  check('late turn-scoped deltas cannot contaminate the next response',
    agent.responseText === '');
  check('late turn-scoped items cannot change the next tool or response',
    agent.pendingTools.size === 0
      && agent.currentTool === null
      && agent.responseText === '');
  check('late turn-scoped errors cannot fail the next turn',
    agent._turnError === null && !agent._stderr.includes('LATE ERROR'));

  feed(child, {
    method: 'item/agentMessage/delta',
    params: { turnId: 'turn-two', delta: 'second response' },
  });
  feed(child, {
    method: 'turn/completed',
    params: { turn: { id: 'turn-two', status: 'completed', items: [] } },
  });
  await delay();
  check('the current turn still completes with only its own content',
    ends.length === 2
      && ends[1].result === 'second response'
      && ends[1].isError === false);

  agent.kill();
  await delay();
}

async function testMcpApprovalAndElicitation() {
  const harness = loadHarness();
  const { agent, child } = harness.create();
  await openThread(agent, child);

  const threadStart = request(child, 'thread/start');
  const pptConfig = threadStart
    && threadStart.params
    && threadStart.params.config
    && threadStart.params.config.mcp_servers
    && threadStart.params.config.mcp_servers.ppt;
  check('suite-owned MCP tools are pre-approved for the headless client',
    pptConfig && pptConfig.default_tools_approval_mode === 'approve');

  feed(child, {
    id: 91,
    method: 'mcpServer/elicitation/request',
    params: {
      threadId: agent.threadId,
      serverName: 'unexpected-server',
      mode: 'form',
      message: 'Supply private input',
      requestedSchema: { type: 'object', properties: {} },
    },
  });
  await delay();

  const response = child.sent.find((message) =>
    message.id === 91 && message.method == null);
  check('unexpected MCP elicitations receive a protocol-valid cancellation',
    response
      && response.error == null
      && response.result
      && response.result.action === 'cancel'
      && response.result.content === null);

  agent.kill();
  await delay();
}

async function testCurrentToolTracksOnlyLiveMcpCalls() {
  const harness = loadHarness();
  const { agent, child } = harness.create({ firstMessage: 'inspect the deck, then do long non-MCP work' });
  const toolEvents = [];
  agent.on('tool', (name) => toolEvents.push(name));
  await openThread(agent, child);

  feed(child, {
    method: 'turn/started',
    params: { turn: { id: 'turn-live-tools' } },
  });
  feed(child, {
    method: 'item/started',
    params: {
      turnId: 'turn-live-tools',
      item: { id: 'ppt-read', type: 'mcpToolCall', server: 'ppt', tool: 'ppt_show' },
    },
  });
  feed(child, {
    method: 'item/started',
    params: {
      turnId: 'turn-live-tools',
      item: { id: 'ppt-locks', type: 'mcpToolCall', server: 'ppt', tool: 'ppt_locks' },
    },
  });
  await delay();
  check('the newest concurrently live MCP call is shown as current',
    agent.currentTool === 'mcp__ppt__ppt_locks' && agent.pendingTools.size === 2);

  feed(child, {
    method: 'item/completed',
    params: {
      turnId: 'turn-live-tools',
      item: { id: 'ppt-locks', type: 'mcpToolCall', server: 'ppt', tool: 'ppt_locks', status: 'completed' },
    },
  });
  await delay();
  check('completing one parallel call falls back to the still-live call',
    agent.currentTool === 'mcp__ppt__ppt_show' && agent.pendingTools.size === 1);

  feed(child, {
    method: 'item/completed',
    params: {
      turnId: 'turn-live-tools',
      item: { id: 'ppt-read', type: 'mcpToolCall', server: 'ppt', tool: 'ppt_show', status: 'completed' },
    },
  });
  await delay();
  check('a completed MCP read clears the current-tool indicator before the turn ends',
    agent.inflight
      && agent.currentTool === null
      && agent.pendingTools.size === 0
      && toolEvents.at(-1) === null);

  feed(child, {
    method: 'turn/completed',
    params: { turn: { id: 'turn-live-tools', status: 'completed', items: [] } },
  });
  await delay();
  agent.kill();
  await delay();
}

async function testMalformedJson() {
  const harness = loadHarness();
  const { agent, child } = harness.create({ firstMessage: 'orphan me' });
  const exits = [];
  const streamErrors = [];
  const failed = [];
  agent.on('exit', (event) => exits.push(event));
  agent.on('stream-error', (event) => streamErrors.push(event));
  agent.on('turn-failed', (message) => failed.push(message));

  child.stdout.write('this is not JSON\n');
  await delay();
  // The fake child also reports its eventual native exit. The adapter must
  // suppress this second terminal signal.
  child.emit('exit', 9, null);
  await delay();

  check('malformed JSONL is a fatal protocol error',
    agent.dead
      && streamErrors.length === 1
      && /stream-parse-error/.test(streamErrors[0].error));
  check('malformed JSONL drains queued work and pending requests',
    failed.length === 1
      && agent.queue.length === 0
      && agent.pendingRequests.size === 0);
  check('malformed JSONL emits exactly one adapter exit',
    exits.length === 1 && child.killCalls === 1);
}

async function testOversizedFrames() {
  const harness = loadHarness({ frameLimit: 1024 });

  const incomplete = harness.create();
  const incompleteExits = [];
  incomplete.agent.on('exit', (event) => incompleteExits.push(event));
  incomplete.child.stdout.write('x'.repeat(1025));
  await delay();
  check('an oversized unterminated JSONL frame is fatal',
    incomplete.agent.dead
      && incompleteExits.length === 1
      && incomplete.child.killCalls === 1);

  const complete = harness.create();
  const completeExits = [];
  const completeErrors = [];
  complete.agent.on('exit', (event) => completeExits.push(event));
  complete.agent.on('stream-error', (event) => completeErrors.push(event));
  complete.child.stdout.write(JSON.stringify({
    method: 'ignored',
    params: { padding: 'x'.repeat(1100) },
  }) + '\n');
  await delay();
  check('an oversized complete JSONL frame is fatal before parsing',
    complete.agent.dead
      && completeExits.length === 1
      && completeErrors.length === 1
      && /exceeded 1024 bytes/.test(completeErrors[0].error));
}

async function testRequestTimeout() {
  const harness = loadHarness({ timeoutMs: 25 });
  const { agent, child } = harness.create({ firstMessage: 'queued at boot' });
  const exits = [];
  const failed = [];
  agent.on('exit', (event) => exits.push(event));
  agent.on('turn-failed', (message) => failed.push(message));

  await delay(100);

  check('a JSON-RPC request timeout kills the wedged protocol lane',
    agent.dead
      && child.killCalls === 1
      && child.stdin.writableEnded
      && /request timed out: initialize/.test(agent._stderr));
  check('request timeout deterministically clears protocol and work queues',
    agent.pendingRequests.size === 0
      && agent.queue.length === 0
      && failed.length === 1);
  check('request timeout emits exactly one terminal event',
    exits.length === 1 && exits[0].orphaned.length === 1);
}

async function testProcessAndStdinErrors() {
  const harness = loadHarness();

  const stdinCase = harness.create({ firstMessage: 'stdin orphan' });
  const stdinExits = [];
  stdinCase.agent.on('exit', (event) => stdinExits.push(event));
  stdinCase.child.stdin.emit('error', new Error('simulated EPIPE'));
  stdinCase.child.emit('exit', 1, null);
  await delay();
  check('stdin error kills and exits the adapter exactly once',
    stdinCase.agent.dead
      && stdinCase.child.killCalls === 1
      && stdinExits.length === 1
      && stdinExits[0].sig === 'stdin-error');

  const spawnCase = harness.create({ firstMessage: 'spawn orphan' });
  const spawnExits = [];
  spawnCase.agent.on('exit', (event) => spawnExits.push(event));
  spawnCase.child.emit('error', new Error('simulated spawn failure'));
  spawnCase.child.emit('exit', 1, null);
  await delay();
  check('spawn error and later child exit produce one adapter exit',
    spawnCase.agent.dead
      && spawnExits.length === 1
      && spawnExits[0].sig === 'spawn-error'
      && spawnCase.agent.pendingRequests.size === 0);
}

function restore() {
  cp.spawn = original.spawn;
  cp.spawnSync = original.spawnSync;
  setOrDelete('SUITE_CODEX_EXE', original.exe);
  setOrDelete('SUITE_CODEX_RPC_TIMEOUT_MS', original.timeout);
  setOrDelete('SUITE_CODEX_STDOUT_FRAME_LIMIT', original.frameLimit);
  setOrDelete('OPENAI_API_KEY', original.openaiKey);
  delete require.cache[MODULE];
}

async function main() {
  try {
    await testLateTurnNotifications();
    await testMcpApprovalAndElicitation();
    await testCurrentToolTracksOnlyLiveMcpCalls();
    await testMalformedJson();
    await testOversizedFrames();
    await testRequestTimeout();
    await testProcessAndStdinErrors();
  } finally {
    restore();
  }

  let passed = 0;
  for (const item of checks) {
    if (item.ok) passed += 1;
    console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.description}`
      + `${item.detail ? ` (${item.detail})` : ''}`);
  }
  console.log(`\n${passed}/${checks.length} passed`);
  process.exitCode = passed === checks.length ? 0 : 1;
}

main().catch((error) => {
  restore();
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
