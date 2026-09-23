#!/usr/bin/env node
'use strict';
/**
 * Token-free coverage for the Codex app-server adapter.
 *
 * No turn is sent to a model. Protocol notifications are fed directly into
 * the normalizer, and the missing-binary case exercises OS process startup.
 */

const path = require('path');
const {
  Agent,
  ClaudeAgent,
  CodexAgent,
  isCodexModel,
} = require('../agent');
const {
  codexModelId,
  normalizeCodexModel,
  subscriptionEnv,
} = require('../codex-agent');

const PASS = [], FAIL = [];
const check = (name, condition, detail) => {
  (condition ? PASS : FAIL).push(name);
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? '  ' + detail : ''}`);
};

console.log('\n[provider routing]');
const events = [];
const terra = new Agent({
  port: 1,
  model: 'terra',
  documentToken: 'test-document-token-0123456789',
  onEvent: (event) => events.push(event),
});
const sonnet = new Agent({ port: 1, model: 'sonnet' });
check('Terra selects the Codex adapter', terra instanceof CodexAgent);
check('Sonnet keeps the Claude adapter', sonnet instanceof ClaudeAgent);
check('Sol and Terra are recognized as Codex models',
  isCodexModel('sol') && isCodexModel('terra'));
check('full Codex ids normalize to the short UI names',
  normalizeCodexModel('gpt-5.6-sol') === 'sol');
check('short names map to exact CLI model ids',
  codexModelId('terra') === 'gpt-5.6-terra' &&
  codexModelId('sol') === 'gpt-5.6-sol');

console.log('\n[subscription-only child environment]');
const clean = subscriptionEnv({
  ANTHROPIC_API_KEY: 'hidden',
  OPENAI_API_KEY: 'hidden',
  CODEX_API_KEY: 'hidden',
  SAFE_SENTINEL: 'kept',
});
check('provider API keys are omitted from model children',
  !clean.ANTHROPIC_API_KEY && !clean.OPENAI_API_KEY && !clean.CODEX_API_KEY);
check('unrelated environment values are retained', clean.SAFE_SENTINEL === 'kept');

console.log('\n[isolated tool surface]');
const editConfig = terra._mcpConfig();
const watch = new Agent({ port: 1, model: 'sol', role: 'watch' });
const watchConfig = watch._mcpConfig();
const predict = new Agent({ port: 1, model: 'terra', role: 'predict' });
const predictConfig = predict._mcpConfig();
const format = new Agent({ port: 1, model: 'terra', role: 'format' });
const formatConfig = format._mcpConfig();
check('Codex shell and connector tools are disabled',
  editConfig.features.shell_tool === false &&
  editConfig.features.apps === false &&
  editConfig.features.browser_use === false);
check('personal MCP connectors are disabled inside Scribe',
  editConfig.mcp_servers.github.enabled === false &&
  editConfig.mcp_servers.openaiDeveloperDocs.enabled === false);
check('the edit agent receives document write tools',
  editConfig.mcp_servers.doc.enabled_tools.includes('doc_replace'));
check('the Codex document bridge is bound to its active document token',
  editConfig.mcp_servers.doc.env.SCRIBE_DOCUMENT_TOKEN ===
    'test-document-token-0123456789');
check('Scribe-owned MCP tools are pre-approved for the headless client',
  editConfig.mcp_servers.doc.default_tools_approval_mode === 'approve' &&
  editConfig.mcp_servers.research.default_tools_approval_mode === 'approve');
check('Watch remains read only under Codex',
  !watchConfig.mcp_servers.doc.enabled_tools.includes('doc_replace') &&
  watchConfig.mcp_servers.doc.enabled_tools.includes('doc_assist'));
check('Watch cannot dispatch subagents', watchConfig.features.multi_agent === false);
check('predictive drafting can only read and find under Codex',
  predictConfig.mcp_servers.doc.enabled_tools.join(',') === 'doc_read,doc_find' &&
  predictConfig.features.multi_agent === false,
  predictConfig.mcp_servers.doc.enabled_tools.join(','));
check('format planning can only read and find under Codex',
  format.role === 'format' &&
  formatConfig.mcp_servers.doc.enabled_tools.join(',') === 'doc_read,doc_find' &&
  formatConfig.features.multi_agent === false,
  formatConfig.mcp_servers.doc.enabled_tools.join(','));
check('format planning has no research MCP server',
  !Object.prototype.hasOwnProperty.call(formatConfig.mcp_servers, 'research'),
  Object.keys(formatConfig.mcp_servers).join(','));
check('format planning receives the strict tagged-plan prompt',
  /<format_plan>/.test(format.systemPrompt) &&
  /untrusted prose/i.test(format.systemPrompt) &&
  /never edit the document/i.test(format.systemPrompt),
  format.systemPrompt.slice(0, 80));
check('Scribe overrides the personal xhigh default with balanced reasoning',
  editConfig.model_reasoning_effort === 'medium');

console.log('\n[normalized app-server events]');
terra.threadId = 'thread-main';
terra.sessionId = 'thread-main';
terra._normalize({
  method: 'turn/started',
  params: { threadId: 'thread-main', turn: { id: 'turn-1', status: 'inProgress', items: [] } },
});
terra._normalize({
  method: 'item/reasoning/summaryTextDelta',
  params: { threadId: 'thread-main', turnId: 'turn-1', itemId: 'reason-1', delta: 'Checking' },
});
terra._normalize({
  method: 'item/started',
  params: {
    threadId: 'thread-main',
    turnId: 'turn-1',
    item: {
      type: 'mcpToolCall',
      id: 'tool-1',
      server: 'doc',
      tool: 'doc_read',
      arguments: { pid: 'p1' },
      status: 'inProgress',
    },
  },
});
terra._normalize({
  method: 'item/completed',
  params: {
    threadId: 'thread-main',
    turnId: 'turn-1',
    item: {
      type: 'mcpToolCall',
      id: 'tool-1',
      server: 'doc',
      tool: 'doc_read',
      arguments: { pid: 'p1' },
      status: 'completed',
      result: { content: [{ type: 'text', text: 'paragraph text' }] },
    },
  },
});
terra._normalize({
  method: 'item/agentMessage/delta',
  params: { threadId: 'thread-main', turnId: 'turn-1', itemId: 'msg-1', delta: 'Done.' },
});
terra._normalize({
  method: 'item/completed',
  params: {
    threadId: 'thread-main',
    turnId: 'turn-1',
    item: { type: 'agentMessage', id: 'msg-1', text: 'Done.' },
  },
});
terra._normalize({
  method: 'turn/completed',
  params: {
    threadId: 'thread-main',
    turn: {
      id: 'turn-1',
      status: 'completed',
      durationMs: 42,
      items: [{ type: 'agentMessage', id: 'msg-1', text: 'Done.' }],
    },
  },
});

const kind = (name) => events.find((event) => event.kind === name);
check('turn start is normalized', !!kind('turn-start'));
check('reasoning is normalized without exposing private text', !!kind('thinking-start'));
check('MCP calls use the existing Scribe tool name',
  kind('tool-call').name === 'mcp__doc__doc_read');
check('complete MCP arguments are visible immediately',
  kind('tool-args').partial === '{"pid":"p1"}');
check('MCP results retain their readable text',
  kind('tool-result').text === 'paragraph text');
check('the final message uses the existing event shape',
  kind('message').text === 'Done.');
check('turn completion clears busy state',
  kind('turn-end').text === 'Done.' && terra.busy === false);
check('subscription mode does not invent API dollar costs',
  kind('turn-end').costUsd === null && kind('turn-end').totalCostUsd === 0);

console.log('\n[server-initiated requests]');
const serverReplies = [];
const serverRequests = new CodexAgent({ port: 1, model: 'terra' });
serverRequests.proc = {
  stdin: {
    destroyed: false,
    write: (line) => {
      serverReplies.push(JSON.parse(line));
      return true;
    },
  },
};
serverRequests._normalize({
  id: 41,
  method: 'mcpServer/elicitation/request',
  params: {
    threadId: 'thread-main',
    turnId: 'turn-1',
    serverName: 'unexpected-server',
    mode: 'form',
    message: 'Supply private input',
    requestedSchema: { type: 'object', properties: {} },
  },
});
check('unexpected MCP elicitations receive a protocol-valid cancellation',
  serverReplies.length === 1 &&
  serverReplies[0].id === 41 &&
  serverReplies[0].result?.action === 'cancel' &&
  serverReplies[0].result?.content === null);

console.log('\n[turn failure keeps the process reusable]');
const turnFailureEvents = [];
const turnFailure = new CodexAgent({
  port: 1,
  model: 'terra',
  onEvent: (event) => turnFailureEvents.push(event),
});
turnFailure.proc = { pid: 9, stdin: { destroyed: false, write: () => true } };
turnFailure.threadId = 'thread-failure';
turnFailure.activeTurnId = 'turn-failure';
turnFailure.busy = true;
turnFailure._normalize({
  method: 'error',
  params: {
    threadId: 'thread-failure',
    turnId: 'turn-failure',
    willRetry: false,
    error: { message: 'model context rejected' },
  },
});
check('an ordinary turn failure is not mislabeled as a dead agent',
  turnFailureEvents.some((event) => event.kind === 'turn-error') &&
  turnFailureEvents.every((event) => event.kind !== 'agent-error') &&
  turnFailure.running === true);
turnFailure._normalize({
  method: 'turn/completed',
  params: {
    threadId: 'thread-failure',
    turn: { id: 'turn-failure', status: 'failed', items: [] },
  },
});
const failedTurnEnd = turnFailureEvents.find((event) => event.kind === 'turn-end');
check('turn completion preserves the useful failure reason',
  failedTurnEnd.error === 'model context rejected' &&
  failedTurnEnd.subtype === 'failed');
check('a failed turn closes cleanly while its CLI thread stays available',
  turnFailure.busy === false && turnFailure.running === true);

const rejectedStartEvents = [];
const rejectedStart = new CodexAgent({
  port: 1,
  model: 'sol',
  onEvent: (event) => rejectedStartEvents.push(event),
});
rejectedStart.proc = { pid: 10, stdin: { destroyed: false, write: () => true } };
rejectedStart.threadId = 'thread-rejected-start';
rejectedStart._request = (method, params, done, fail) => {
  if (method === 'turn/start') fail(new Error('request refused'));
};
rejectedStart.say('Try this turn.');
check('a rejected turn/start ends locally without retiring Codex',
  rejectedStartEvents.some((event) =>
    event.kind === 'turn-end' && /request refused/.test(event.error || '')) &&
  rejectedStartEvents.every((event) => event.kind !== 'agent-error') &&
  rejectedStart.running === true);

console.log('\n[same-turn steering]');
const steeringEvents = [];
const steering = new CodexAgent({
  port: 1,
  model: 'sol',
  onEvent: (event) => steeringEvents.push(event),
});
steering.proc = { stdin: { destroyed: false, write: () => true } };
steering.threadId = 'thread-steer';
steering.sessionId = 'thread-steer';
steering.activeTurnId = 'turn-active';
steering.busy = true;
let steered = null;
steering._request = (method, params, done) => {
  steered = { method, params };
  done({ turnId: 'turn-active' });
};
const sent = steering.say('Use the newer wording.');
check('a message during work uses turn/steer',
  sent.ok && sent.queued && steered.method === 'turn/steer');
check('steering pins the active turn id',
  steered.params.expectedTurnId === 'turn-active');
check('accepted steering is reported as delivered',
  steeringEvents.some((event) => event.kind === 'delivered'));

console.log('\n[failed Codex process start]');
const oldCodex = process.env.SCRIBE_CODEX;
process.env.SCRIBE_CODEX = path.join(__dirname, 'definitely-missing-codex.exe');
const failedEvents = [];
const failed = new Agent({
  port: 1,
  model: 'terra',
  onEvent: (event) => failedEvents.push(event),
});
failed.start();

setTimeout(() => {
  if (oldCodex === undefined) delete process.env.SCRIBE_CODEX;
  else process.env.SCRIBE_CODEX = oldCodex;
  check('Codex spawn failure emits one normalized error',
    failedEvents.filter((event) => event.kind === 'agent-error').length === 1,
    JSON.stringify(failedEvents));
  check('a Codex process that never spawned is never announced',
    failedEvents.every((event) => event.kind !== 'agent-start'));
  check('Codex spawn failure remains retryable',
    failed.running === false && /failed to start/i.test(failed.status().error || ''));

  console.log(`\n${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) console.log('failed: ' + FAIL.join(', '));
  process.exit(FAIL.length ? 1 : 0);
}, 500);
