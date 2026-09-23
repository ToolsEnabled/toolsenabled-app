#!/usr/bin/env node
'use strict';

/**
 * Token-free regression coverage for process/event boundaries shared by the
 * Claude and Codex transports, the hook sandbox, and the PID registry.
 */

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  ClaudeAgent,
  CodexAgent,
} = require('../agent');
const {
  read,
  recordPid,
  sweepStalePids,
} = require('../pid-registry');

const ROOT = path.join(__dirname, '..');
const TMP = path.resolve(__dirname, '_tmp_orchestration_robustness');
const GUARD = path.join(ROOT, 'guard.js');
if (!TMP.startsWith(path.resolve(ROOT) + path.sep)) {
  throw new Error(`refusing temp path outside workspace: ${TMP}`);
}

const PASS = [];
const FAIL = [];
const check = (name, condition, detail) => {
  (condition ? PASS : FAIL).push(name);
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? `  ${detail}` : ''}`);
};

class FakeReadable extends EventEmitter {
  setEncoding() {}
}

class FakeWritable extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writableEnded = false;
    this.lines = [];
    this.writeError = null;
  }

  write(value) {
    if (this.writeError) throw this.writeError;
    this.lines.push(String(value));
    return true;
  }

  end() {
    this.writableEnded = true;
  }
}

class FakeChild extends EventEmitter {
  constructor(pid = 3210) {
    super();
    this.pid = pid;
    this.stdin = new FakeWritable();
    this.stdout = new FakeReadable();
    this.stderr = new FakeReadable();
    this.killed = false;
  }

  kill() {
    this.killed = true;
    return true;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runGuard(payload, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [GUARD], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => stdout += chunk);
    child.stderr.on('data', (chunk) => stderr += chunk);
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      let body = null;
      try { body = JSON.parse(stdout); } catch (_) {}
      resolve({ code, body, stdout, stderr });
    });
    child.stdin.end(payload);
  });
}

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  const oldClaude = process.env.SCRIBE_CLAUDE;
  process.env.SCRIBE_CLAUDE = process.execPath;

  try {
    console.log('\n[Claude process races]');
    const events = [];
    const child = new FakeChild(4101);
    const claude = new ClaudeAgent({
      port: 1,
      documentToken: 'test-document-token-0123456789',
      configRoot: TMP,
      spawnProcess: () => child,
      onEvent: (event) => events.push(event),
    });
    claude.start();
    const claudeMcp = JSON.parse(
      fs.readFileSync(path.join(claude.configDir, 'mcp.json'), 'utf8'),
    );
    check('the Claude document bridge is bound to its active document token',
      claudeMcp.mcpServers.doc.env.SCRIBE_DOCUMENT_TOKEN ===
        'test-document-token-0123456789');
    const secondConfigChild = new FakeChild(4100);
    const secondConfigAgent = new ClaudeAgent({
      port: 1,
      documentToken: 'new-document-token-9876543210',
      configRoot: TMP,
      spawnProcess: () => secondConfigChild,
    });
    secondConfigAgent.start();
    check('Claude agent instances never overwrite an older document-token config',
      secondConfigAgent.configDir !== claude.configDir &&
      JSON.parse(fs.readFileSync(path.join(claude.configDir, 'mcp.json'), 'utf8'))
        .mcpServers.doc.env.SCRIBE_DOCUMENT_TOKEN ===
          'test-document-token-0123456789');
    secondConfigAgent.stop();

    const formatChild = new FakeChild(4103);
    let formatSpawn = null;
    const formatter = new ClaudeAgent({
      port: 1,
      role: 'format',
      documentToken: 'format-document-token-0123456789',
      configRoot: TMP,
      spawnProcess: (bin, args, options) => {
        formatSpawn = { bin, args, options };
        return formatChild;
      },
    });
    formatter.start();
    const formatMcp = JSON.parse(
      fs.readFileSync(path.join(formatter.configDir, 'mcp.json'), 'utf8'),
    );
    const formatAllowedStart = formatSpawn.args.indexOf('--allowed-tools') + 1;
    const formatAllowedEnd = formatSpawn.args.indexOf('--model');
    const formatAllowed = formatSpawn.args.slice(formatAllowedStart, formatAllowedEnd);
    check('Claude format planning is routed as its own role',
      formatter.role === 'format' &&
      formatSpawn.options.env.SCRIBE_GUARD_MODE === 'format');
    check('Claude format planning exposes exactly document read and find',
      formatAllowed.join(',') ===
        'mcp__doc__doc_read,mcp__doc__doc_find',
      formatAllowed.join(','));
    check('Claude format planning has no research MCP server',
      !Object.prototype.hasOwnProperty.call(formatMcp.mcpServers, 'research'),
      Object.keys(formatMcp.mcpServers).join(','));
    check('Claude format planning is bound to the active document token',
      formatMcp.mcpServers.doc.env.SCRIBE_DOCUMENT_TOKEN ===
        'format-document-token-0123456789');
    check('Claude format planning receives the strict tagged-plan prompt',
      /<format_plan>/.test(formatter.systemPrompt) &&
      /untrusted prose/i.test(formatter.systemPrompt));
    formatter.stop();

    child.emit('spawn');
    const generation = claude.processGeneration;
    child.emit('exit', 7, null);
    child.stdout.emit('data',
      `${JSON.stringify({ type: 'stream_event', event: { type: 'message_start' } })}\n`);
    check('natural exit invalidates late stdout',
      claude.processGeneration === generation + 1 &&
      claude.busy === false &&
      events.filter((event) => event.kind === 'turn-start').length === 0);

    const racedEvents = [];
    const racedChild = new FakeChild(4102);
    const raced = new ClaudeAgent({
      port: 1,
      configRoot: TMP,
      spawnProcess: () => racedChild,
      onEvent: (event) => racedEvents.push(event),
    });
    raced.start();
    racedChild.emit('spawn');
    racedChild.stdin.emit('error', new Error('EPIPE'));
    racedChild.emit('error', new Error('duplicate process error'));
    racedChild.emit('exit', 1, null);
    check('stdin/process/exit race emits one terminal event',
      racedEvents.filter((event) =>
        event.kind === 'agent-error' || event.kind === 'agent-exit').length === 1,
      JSON.stringify(racedEvents));
    check('input failure retires and kills the broken child',
      raced.proc === null && racedChild.killed && /input failed/.test(raced.lastError || ''));

    const syncEvents = [];
    const synchronous = new ClaudeAgent({
      port: 1,
      configRoot: TMP,
      spawnProcess: () => { throw new Error('synchronous spawn failure'); },
      onEvent: (event) => syncEvents.push(event),
    });
    let syncThrew = false;
    try { synchronous.start(); } catch (_) { syncThrew = true; }
    check('synchronous spawn failure is normalized, not thrown',
      !syncThrew && synchronous.running === false &&
      syncEvents.filter((event) => event.kind === 'agent-error').length === 1);

    console.log('\n[Claude malformed completion]');
    const malformedEvents = [];
    const malformed = new ClaudeAgent({
      port: 1,
      onEvent: (event) => malformedEvents.push(event),
    });
    malformed.busy = true;
    malformed.interrupting = true;
    malformed.pendingTools.set('orphan', {});
    malformed.pendingBlocks.set(1, 'orphan');
    malformed._normalize({
      type: 'result',
      subtype: 'success',
      total_cost_usd: Infinity,
      permission_denials: { malformed: true },
    });
    check('malformed result still closes the turn exactly once',
      malformedEvents.filter((event) => event.kind === 'turn-end').length === 1 &&
      malformed.turns === 1);
    check('every completed result clears turn-local state',
      !malformed.busy && !malformed.interrupting &&
      malformed.pendingTools.size === 0 && malformed.pendingBlocks.size === 0 &&
      malformed.costUsd === 0);

    console.log('\n[Codex request and event invariants]');
    const timeoutEvents = [];
    const timeout = new CodexAgent({
      port: 1,
      model: 'terra',
      requestTimeoutMs: 25,
      onEvent: (event) => timeoutEvents.push(event),
    });
    timeout.proc = new FakeChild(4201);
    timeout.threadId = 'thread-live';
    let timeoutError = null;
    timeout._request('test/never-replies', {}, () => {}, (error) => {
      timeoutError = error;
    });
    await sleep(75);
    check('Codex requests time out and retire their pending record',
      /timed out/.test(timeoutError && timeoutError.message || '') &&
      timeout.pendingRequests.size === 0,
      timeoutError && timeoutError.message);

    timeout.threadId = 'dead-thread';
    timeout._resetTransient();
    check('process reset discards the dead app-server thread id',
      timeout.threadId === null);

    const completionEvents = [];
    const completion = new CodexAgent({
      port: 1,
      model: 'terra',
      onEvent: (event) => completionEvents.push(event),
    });
    completion.threadId = 'thread-main';
    completion.activeTurnId = 'turn-1';
    completion.busy = true;
    const completed = {
      method: 'turn/completed',
      params: { turn: { id: 'turn-1', status: 'completed', items: [] } },
    };
    completion._normalize(completed);
    completion._normalize(completed);
    check('duplicate Codex completion is idempotent',
      completion.turns === 1 &&
      completionEvents.filter((event) => event.kind === 'turn-end').length === 1);

    completion.activeTurnId = 'turn-2';
    completion.busy = true;
    completion._normalize(completed);
    check('stale completion cannot clear a newer active turn',
      completion.activeTurnId === 'turn-2' && completion.busy === true);

    const oversizedEvents = [];
    const oversizedChild = new FakeChild(4202);
    const oversized = new CodexAgent({
      port: 1,
      model: 'terra',
      maxProtocolFrameBytes: 32,
      onEvent: (event) => oversizedEvents.push(event),
    });
    oversized.proc = oversizedChild;
    oversized._onData('x'.repeat(33));
    check('oversized unterminated output is bounded and fatal',
      oversized.proc === null && oversizedChild.killed &&
      oversizedEvents.filter((event) => event.kind === 'agent-error').length === 1);

    console.log('\n[guard fail-closed boundaries]');
    const wrongMode = await runGuard(
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read' }),
      { SCRIBE_GUARD_MODE: 'unexpected-mode' },
    );
    check('an invalid guard mode cannot inherit the edit allowlist',
      wrongMode.code === 0 &&
      wrongMode.body?.hookSpecificOutput?.permissionDecision === 'deny');
    check('guard output remains one complete JSON frame',
      wrongMode.stderr === '' && (() => {
        try { JSON.parse(wrongMode.stdout); return true; } catch (_) { return false; }
      })());

    const tooLarge = await runGuard('x'.repeat(1024 * 1024 + 1));
    check('oversized hook input is denied without hanging',
      tooLarge.code === 0 &&
      tooLarge.body?.hookSpecificOutput?.permissionDecision === 'deny' &&
      /too large/.test(tooLarge.body?.hookSpecificOutput?.permissionDecisionReason || ''));

    console.log('\n[PID registry malformed state]');
    const pidFile = path.join(TMP, 'pids.json');
    fs.writeFileSync(pidFile, 'null');
    check('valid non-object registry JSON is treated as empty',
      Object.keys(read(pidFile)).length === 0 &&
      recordPid(pidFile, 'agent', 501, {
        ownerPid: 77,
        commandIncludes: path.join(ROOT, 'agent.js'),
      }) === true);
    check('invalid owner identity is refused instead of becoming legacy',
      recordPid(pidFile, 'bad', 502, {
        ownerPid: Number.NaN,
        commandIncludes: path.join(ROOT, 'agent.js'),
      }) === false);

    fs.writeFileSync(pidFile, JSON.stringify({
      agent: {
        pid: 503,
        ownerPid: 77,
        commandIncludes: path.join(ROOT, 'agent.js'),
      },
    }));
    const killed = [];
    const swept = sweepStalePids(pidFile, {
      inspectPid: () => ({
        pid: 999,
        parentPid: 77,
        executablePath: process.execPath,
        commandLine: `node ${path.join(ROOT, 'agent.js')}`,
      }),
      terminatePid: (pid) => killed.push(pid),
    });
    check('PID inspection must describe the requested PID before cleanup',
      killed.length === 0 && swept.skipped === 1);
  } finally {
    if (oldClaude === undefined) delete process.env.SCRIBE_CLAUDE;
    else process.env.SCRIBE_CLAUDE = oldClaude;
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  console.log(`\n${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) console.log(`failed: ${FAIL.join(', ')}`);
  process.exitCode = FAIL.length ? 1 : 0;
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
