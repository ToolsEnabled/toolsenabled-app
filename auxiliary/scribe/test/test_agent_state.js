#!/usr/bin/env node
'use strict';
/**
 * Token-free tests for the agent event normalizer and process lifecycle.
 *
 * Run: node test/test_agent_state.js
 */

const { Agent } = require('../agent');
const path = require('path');

const PASS = [], FAIL = [];
const check = (name, condition, detail) => {
  (condition ? PASS : FAIL).push(name);
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? '  ' + detail : ''}`);
};

const events = [];
const agent = new Agent({ port: 1, onEvent: (event) => events.push(event) });

console.log('\n[initial state]');
check('interrupt state is initialized explicitly', agent.interrupting === false);
check('no streamed tool block is retained', agent.pendingBlocks.size === 0);

console.log('\n[multiple streamed tool calls]');
agent._normalize({
  type: 'stream_event',
  event: {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'tool-a', name: 'mcp__doc__doc_read' },
  },
});
agent._normalize({
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"pid":"A' },
  },
});
agent._normalize({
  type: 'stream_event',
  event: {
    type: 'content_block_start',
    index: 2,
    content_block: { type: 'tool_use', id: 'tool-b', name: 'Agent' },
  },
});
agent._normalize({
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    index: 2,
    delta: { type: 'input_json_delta', partial_json: '{"description":"B' },
  },
});
agent._normalize({
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '1"}' },
  },
});
agent._normalize({
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    index: 2,
    delta: { type: 'input_json_delta', partial_json: '2"}' },
  },
});

const args = events.filter((event) => event.kind === 'tool-args');
const lastArgs = (id) => args.filter((event) => event.id === id).at(-1);
check('first tool receives only its own argument deltas',
  lastArgs('tool-a').partial === '{"pid":"A1"}', lastArgs('tool-a').partial);
check('second tool receives only its own argument deltas',
  lastArgs('tool-b').partial === '{"description":"B2"}', lastArgs('tool-b').partial);
check('parallel tool deltas stay attributed to two ids',
  new Set(args.map((event) => event.id)).size === 2);

agent._normalize({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } });
agent._normalize({ type: 'stream_event', event: { type: 'content_block_stop', index: 2 } });
check('finished stream blocks are retired', agent.pendingBlocks.size === 0);

agent._normalize({
  type: 'assistant',
  message: {
    content: [
      { type: 'tool_use', id: 'tool-a', name: 'mcp__doc__doc_read', input: { pid: 'A1' } },
      { type: 'tool_use', id: 'tool-b', name: 'Agent', input: { description: 'B2' } },
    ],
  },
});
check('both complete calls are emitted',
  events.filter((event) => event.kind === 'tool-call').length === 2);

agent._normalize({
  type: 'user',
  message: {
    content: [
      { type: 'tool_result', tool_use_id: 'tool-a', content: 'read complete' },
      { type: 'tool_result', tool_use_id: 'tool-b', content: 'subagent complete' },
    ],
  },
});
check('completed tools leave no pending records', agent.pendingTools.size === 0);

console.log('\n[transient lifecycle state]');
agent.sessionId = 'resume-me';
agent.buf = '{"partial":';
agent.busy = true;
agent.interrupting = true;
agent.pendingTools.set('orphan', { name: 'Agent', partial: '{}', parent: null });
agent.pendingBlocks.set(3, 'orphan');
agent._resetTransient();
check('partial output is cleared', agent.buf === '');
check('busy and interrupt flags are cleared', !agent.busy && !agent.interrupting);
check('orphaned tool state is cleared',
  agent.pendingTools.size === 0 && agent.pendingBlocks.size === 0);
check('resumable conversation identity is retained', agent.sessionId === 'resume-me');

let ended = false, killed = false;
agent.proc = {
  pid: 12345,
  stdin: { end: () => { ended = true; } },
  kill: () => { killed = true; },
};
agent.busy = true;
agent.pendingTools.set('stopping', {});
const beforeGeneration = agent.processGeneration;
agent.stop();
const stopped = events.at(-1);
check('stop retires the child immediately', ended && killed && agent.proc === null);
check('stop invalidates late output from that child',
  agent.processGeneration === beforeGeneration + 1);
check('stop reports one intentional exit immediately',
  stopped.kind === 'agent-exit' && stopped.pid === 12345 &&
  stopped.expected === true && stopped.sig === 'stopped');
check('stop leaves no in-flight state behind',
  !agent.busy && agent.pendingTools.size === 0 && agent.pendingBlocks.size === 0);

console.log('\n[failed process start]');
const oldClaude = process.env.SCRIBE_CLAUDE;
process.env.SCRIBE_CLAUDE = path.join(__dirname, 'definitely-missing-claude.exe');
const failedEvents = [];
const failedAgent = new Agent({ port: 1, onEvent: (event) => failedEvents.push(event) });
failedAgent.start();

setTimeout(() => {
  if (oldClaude === undefined) delete process.env.SCRIBE_CLAUDE;
  else process.env.SCRIBE_CLAUDE = oldClaude;
  const errors = failedEvents.filter((event) => event.kind === 'agent-error');
  check('spawn failure emits one normalized error', errors.length === 1,
    JSON.stringify(failedEvents));
  check('a process that never spawned is never announced as started',
    failedEvents.every((event) => event.kind !== 'agent-start'));
  check('spawn failure leaves the agent stopped and not busy',
    failedAgent.running === false && failedAgent.busy === false);
  check('status retains the actionable start error',
    /failed to start/i.test(failedAgent.status().error || ''),
    failedAgent.status().error);

  console.log(`\n${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) console.log('failed: ' + FAIL.join(', '));
  process.exit(FAIL.length ? 1 : 0);
}, 500);
