'use strict';
/**
 * Codex CLI transport for Scribe.
 *
 * This speaks the versioned app-server JSONL protocol rather than calling an
 * API directly. The surrounding server sees the same normalized events as the
 * Claude transport in agent.js, so provider choice never leaks into the UI or
 * document-editing contract.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const MAX_PROTOCOL_FRAME_BYTES = 1024 * 1024;
const CODEX_MODELS = Object.freeze({
  terra: 'gpt-5.6-terra',
  sol: 'gpt-5.6-sol',
  'gpt-5.6-terra': 'gpt-5.6-terra',
  'gpt-5.6-sol': 'gpt-5.6-sol',
});

function isCodexModel(model) {
  return Object.prototype.hasOwnProperty.call(CODEX_MODELS, String(model || '').toLowerCase());
}

function normalizeCodexModel(model) {
  const value = String(model || '').toLowerCase();
  if (value === 'gpt-5.6-terra') return 'terra';
  if (value === 'gpt-5.6-sol') return 'sol';
  return value;
}

function codexModelId(model) {
  return CODEX_MODELS[String(model || '').toLowerCase()] || null;
}

/** Resolve a native executable so Windows never needs shell:true. */
function resolveCodex() {
  if (process.env.SCRIBE_CODEX) return process.env.SCRIBE_CODEX;

  const executable = process.platform === 'win32' ? 'codex.exe' : 'codex';
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir.replace(/^"|"$/g, ''), executable);
    if (fs.existsSync(candidate)) return candidate;
  }

  if (process.platform === 'win32') {
    const extensions = path.join(os.homedir(), '.vscode', 'extensions');
    try {
      const candidates = fs.readdirSync(extensions)
        .filter((name) => /^openai\.chatgpt-/i.test(name))
        .map((name) => path.join(extensions, name, 'bin', 'windows-x86_64', 'codex.exe'))
        .filter((candidate) => fs.existsSync(candidate))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      if (candidates.length) return candidates[0];
    } catch (_) { /* the extension is optional */ }
  }
  return null;
}

/**
 * Keep the provider CLIs on their cached subscription sessions. Environment
 * API keys can silently override an interactive login, so Scribe omits them
 * from model children without mutating the user's shell.
 */
function subscriptionEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY']) {
    delete env[key];
  }
  return env;
}

function toolName(item) {
  const server = String(item.server || '').replace(/^mcp__|__$/g, '');
  const tool = String(item.tool || '');
  if (tool.startsWith('mcp__')) return tool;
  return `mcp__${server}__${tool}`;
}

function resultText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  const content = Array.isArray(value) ? value : value.content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      try { return JSON.stringify(part); } catch (_) { return String(part); }
    }).join('\n');
  }
  if (typeof value.message === 'string') return value.message;
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

class CodexAgent {
  constructor(opts = {}) {
    this.port = opts.port;
    this.documentToken = typeof opts.documentToken === 'string' &&
      opts.documentToken.trim()
      ? opts.documentToken
      : null;
    this.onEvent = opts.onEvent || (() => {});
    this.spawnProcess = typeof opts.spawnProcess === 'function' ? opts.spawnProcess : spawn;
    this.requestTimeoutMs = Number.isSafeInteger(opts.requestTimeoutMs) &&
      opts.requestTimeoutMs > 0
      ? opts.requestTimeoutMs
      : DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxProtocolFrameBytes = Number.isSafeInteger(opts.maxProtocolFrameBytes) &&
      opts.maxProtocolFrameBytes > 0
      ? opts.maxProtocolFrameBytes
      : MAX_PROTOCOL_FRAME_BYTES;
    this.role = ['watch', 'predict', 'format'].includes(opts.role) ? opts.role : 'edit';
    this.provider = 'codex';
    this.model = normalizeCodexModel(opts.model || 'terra');
    this.cliModel = codexModelId(opts.model || 'terra');
    this.systemPrompt = String(opts.systemPrompt || '');
    this.resumeFrom = opts.resumeFrom || null;

    this.proc = null;
    this.sessionId = null;
    this.threadId = null;
    this.activeTurnId = null;
    this.buf = '';
    this.busy = false;
    this.interrupting = false;
    this.processGeneration = 0;
    this.lastError = null;
    this.startedAt = null;
    this.turns = 0;
    // Subscription-backed Codex does not report a dollar amount.
    this.costUsd = 0;

    this.nextRequestId = 1;
    this.pendingRequests = new Map();
    this.pendingInputs = [];
    this.turnStarting = false;
    this.steerPending = false;
    this.pendingTools = new Map();
    this.announcedTurns = new Set();
    this.completedTurns = new Set();
    this.reasoningItems = new Set();
    this.subagentParents = new Map();
    this.responseText = '';
    this.turnStartedAt = null;
    this.turnError = null;
  }

  _resetTransient() {
    this._clearPendingRequests();
    this.buf = '';
    this.busy = false;
    this.interrupting = false;
    this.threadId = null;
    this.activeTurnId = null;
    this.turnStarting = false;
    this.steerPending = false;
    this.pendingInputs.length = 0;
    this.pendingTools.clear();
    this.announcedTurns.clear();
    this.completedTurns.clear();
    this.reasoningItems.clear();
    this.subagentParents.clear();
    this.responseText = '';
    this.turnStartedAt = null;
    this.turnError = null;
  }

  _clearPendingRequests() {
    for (const pending of this.pendingRequests.values()) {
      if (pending.timer) clearTimeout(pending.timer);
    }
    this.pendingRequests.clear();
  }

  _failProcess(child, generation, message) {
    if (generation !== this.processGeneration || this.proc !== child) return false;
    this.proc = null;
    ++this.processGeneration;
    this._resetTransient();
    this.lastError = message;
    try { if (child && child.stdin) child.stdin.end(); } catch (_) {}
    try { if (child) child.kill(); } catch (_) {}
    this.onEvent({ kind: 'agent-error', pid: child && child.pid || null, error: message });
    return true;
  }

  _mcpConfig() {
    const env = {
      SCRIBE_PORT: String(this.port),
      SCRIBE_HOST: '127.0.0.1',
      SCRIBE_MCP_MODE: this.role,
    };
    if (this.documentToken) env.SCRIBE_DOCUMENT_TOKEN = this.documentToken;
    const docTools = this.role === 'watch'
      ? ['doc_read', 'doc_find', 'doc_assist']
      : this.role === 'predict' || this.role === 'format'
        ? ['doc_read', 'doc_find']
        : ['doc_read', 'doc_find', 'doc_replace', 'doc_insert', 'doc_delete',
           'doc_format', 'doc_propose'];
    const researchTools = ['corpus_search', 'read_source', 'db_query', 'list_sources'];
    const mcpServers = {
      doc: {
        command: process.execPath,
        args: [path.join(ROOT, 'mcp-doc.js')],
        env,
        required: true,
        enabled_tools: docTools,
        // Scribe is the policy boundary for these loopback-only tools. Their
        // enabled list is role-scoped above, so the headless app-server
        // client must not open an interactive approval form it cannot show.
        default_tools_approval_mode: 'approve',
      },
      // Do not inherit unrelated personal connectors into the document agent.
      github: {
        url: 'https://api.githubcopilot.com/mcp/',
        bearer_token_env_var: 'GITHUB_PAT_TOKEN',
        enabled: false,
      },
      openaiDeveloperDocs: {
        url: 'https://developers.openai.com/mcp',
        enabled: false,
      },
    };
    if (this.role !== 'format') {
      mcpServers.research = {
        command: process.execPath,
        args: [path.join(ROOT, 'mcp-research.js')],
        env,
        required: true,
        enabled_tools: researchTools,
        default_tools_approval_mode: 'approve',
      };
    }

    return {
      model_reasoning_effort: 'medium',
      web_search: 'disabled',
      features: {
        apps: false,
        browser_use: false,
        computer_use: false,
        image_generation: false,
        remote_plugin: false,
        plugins: false,
        shell_tool: false,
        shell_snapshot: false,
        multi_agent: this.role === 'edit',
      },
      mcp_servers: mcpServers,
    };
  }

  _threadParams() {
    return {
      model: this.cliModel,
      cwd: ROOT,
      developerInstructions: this.systemPrompt,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      personality: 'pragmatic',
      config: this._mcpConfig(),
      ephemeral: false,
    };
  }

  _resumeParams() {
    return {
      threadId: this.resumeFrom,
      model: this.cliModel,
      cwd: ROOT,
      developerInstructions: this.systemPrompt,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      personality: 'pragmatic',
      config: this._mcpConfig(),
    };
  }

  start() {
    if (this.proc) return this;
    const bin = resolveCodex();
    if (!bin) {
      this.lastError = 'codex executable not found. Set SCRIBE_CODEX to its full path.';
      this.onEvent({ kind: 'agent-error', error: this.lastError });
      return this;
    }
    if (!this.cliModel) {
      this.lastError = `unsupported Codex model ${JSON.stringify(this.model)}`;
      this.onEvent({ kind: 'agent-error', error: this.lastError });
      return this;
    }

    this._resetTransient();
    this.lastError = null;
    const generation = ++this.processGeneration;
    let child;
    try {
      child = this.spawnProcess(bin, ['app-server', '--stdio'], {
        cwd: ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        env: subscriptionEnv({
          SCRIBE_PORT: String(this.port),
          SCRIBE_MCP_MODE: this.role,
          ...(this.documentToken
            ? { SCRIBE_DOCUMENT_TOKEN: this.documentToken }
            : {}),
        }),
      });
    } catch (error) {
      ++this.processGeneration;
      this._resetTransient();
      this.lastError = `agent failed to start: ${error.message}`;
      this.onEvent({ kind: 'agent-error', pid: null, error: this.lastError });
      return this;
    }
    this.proc = child;
    this.startedAt = Date.now();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (generation === this.processGeneration) this._onData(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text) => {
      if (generation === this.processGeneration && text.trim()) {
        console.error('[codex-agent]', text.trimEnd());
      }
    });
    if (child.stdin && typeof child.stdin.on === 'function') {
      child.stdin.on('error', (error) => {
        this._failProcess(
          child,
          generation,
          `agent input failed: ${error.message}`,
        );
      });
    }

    child.on('spawn', () => {
      if (generation !== this.processGeneration) return;
      this.onEvent({
        kind: 'agent-start',
        pid: child.pid,
        model: this.model,
        provider: this.provider,
        resumed: !!this.resumeFrom,
      });
      this._request('initialize', {
        clientInfo: { name: 'scribe', title: 'Scribe', version: '0.2.0' },
      }, () => {
        this._notify('initialized', {});
        this._openThread();
      }, (error) => this._fatal(`Codex initialization failed: ${error.message}`));
    });

    child.on('error', (error) => {
      this._failProcess(
        child,
        generation,
        `agent failed to start: ${error.message}`,
      );
    });

    child.on('exit', (code, sig) => {
      if (generation !== this.processGeneration) return;
      this.proc = null;
      ++this.processGeneration;
      this._resetTransient();
      this.onEvent({ kind: 'agent-exit', pid: child.pid, code, sig, expected: false });
    });
    return this;
  }

  _openThread() {
    const ready = (result) => {
      const id = result && result.thread && result.thread.id;
      if (!id) return this._fatal('Codex did not return a thread id.');
      this.threadId = id;
      this.sessionId = id;
      this.onEvent({
        kind: 'session',
        sessionId: id,
        tools: this.role === 'format' ? ['doc'] : ['doc', 'research'],
        mcp: this.role === 'format' ? ['doc'] : ['doc', 'research'],
        model: this.model,
        provider: this.provider,
      });
      this._flushInputs();
    };

    if (this.resumeFrom) {
      this._request('thread/resume', this._resumeParams(), ready, () => {
        // Session ids are provider-specific. A cross-provider handoff or a
        // missing rollout starts clean instead of leaving the agent unusable.
        this.resumeFrom = null;
        this._request('thread/start', this._threadParams(), ready,
          (error) => this._fatal(`Codex thread start failed: ${error.message}`));
      });
      return;
    }
    this._request('thread/start', this._threadParams(), ready,
      (error) => this._fatal(`Codex thread start failed: ${error.message}`));
  }

  stop() {
    if (!this.proc) {
      this._resetTransient();
      return;
    }
    const child = this.proc;
    this.proc = null;
    ++this.processGeneration;
    this._resetTransient();
    try { child.stdin.end(); } catch (_) {}
    try { child.kill(); } catch (_) {}
    this.onEvent({
      kind: 'agent-exit',
      pid: child.pid,
      code: null,
      sig: 'stopped',
      expected: true,
    });
  }

  get pid() { return this.proc ? this.proc.pid : null; }
  get running() { return !!this.proc; }

  say(text) {
    if (!this.proc) return { ok: false, error: 'agent is not running' };
    const value = String(text || '');
    const queued = this.busy || this.turnStarting || !this.threadId;
    this.pendingInputs.push(value);
    this.onEvent({ kind: 'said', text: value, queued });
    this._flushInputs();
    return { ok: true, queued };
  }

  _flushInputs() {
    if (!this.proc || !this.threadId || !this.pendingInputs.length) return;
    if (this.busy || this.turnStarting) {
      if (!this.activeTurnId || this.steerPending) return;
      const text = this.pendingInputs.shift();
      this.steerPending = true;
      this._request('turn/steer', {
        threadId: this.threadId,
        expectedTurnId: this.activeTurnId,
        input: [{ type: 'text', text }],
      }, () => {
        this.steerPending = false;
        this.onEvent({ kind: 'delivered', text });
        this._flushInputs();
      }, () => {
        // The turn can finish in the small gap before a steer arrives. Keep
        // the message and deliver it as the next turn instead of dropping it.
        this.steerPending = false;
        this.pendingInputs.unshift(text);
        if (!this.activeTurnId) {
          this.busy = false;
          this._flushInputs();
        }
      });
      return;
    }

    const text = this.pendingInputs.shift();
    this.turnStarting = true;
    this.busy = true;
    this.responseText = '';
    this.turnStartedAt = Date.now();
    this.turnError = null;
    this.onEvent({ kind: 'status', status: 'requesting' });
    this._request('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text }],
      model: this.cliModel,
      effort: 'medium',
      personality: 'pragmatic',
      approvalPolicy: 'never',
    }, (result) => {
      this.turnStarting = false;
      this.activeTurnId = result && result.turn && result.turn.id || this.activeTurnId;
      this.onEvent({ kind: 'delivered', text });
      this._flushInputs();
    }, (error) => {
      const message = `Codex turn failed to start: ${error.message}`;
      this.turnError = message;
      this.onEvent({ kind: 'turn-error', error: message });
      // A rejected turn/start request has no later turn/completed notification,
      // so close this attempted turn locally while leaving the CLI process and
      // its reusable thread alive.
      this._turnCompleted({
        status: 'failed',
        error: { message },
      });
    });
  }

  interrupt() {
    if (!this.proc) return { ok: false, error: 'agent is not running' };
    if (!this.threadId || !this.activeTurnId) {
      return { ok: false, error: 'agent has no active turn' };
    }
    this.interrupting = true;
    this._request('turn/interrupt', {
      threadId: this.threadId,
      turnId: this.activeTurnId,
    }, () => {}, (error) => {
      this.interrupting = false;
      this.onEvent({ kind: 'turn-error', error: `interrupt failed: ${error.message}` });
    });
    this.onEvent({ kind: 'interrupt-sent' });
    return { ok: true };
  }

  _send(message) {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) return false;
    try {
      this.proc.stdin.write(JSON.stringify(message) + '\n');
      return true;
    } catch (_) {
      return false;
    }
  }

  _request(method, params, onResult, onError) {
    const id = this.nextRequestId++;
    const timer = setTimeout(() => {
      const pending = this.pendingRequests.get(id);
      if (!pending) return;
      this.pendingRequests.delete(id);
      const error = new Error(`${method} timed out after ${this.requestTimeoutMs}ms`);
      if (pending.onError) {
        try { pending.onError(error); }
        catch (callbackError) {
          this._fatal(`${method} timeout handling failed: ${callbackError.message}`);
        }
      }
    }, this.requestTimeoutMs);
    timer.unref();
    this.pendingRequests.set(id, { method, onResult, onError, timer });
    if (!this._send({ method, id, params })) {
      clearTimeout(timer);
      this.pendingRequests.delete(id);
      if (onError) onError(new Error('Codex process is not writable'));
    }
    return id;
  }

  _notify(method, params) {
    return this._send({ method, params });
  }

  _onData(chunk) {
    this.buf += chunk;
    let index;
    while ((index = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, index).trim();
      this.buf = this.buf.slice(index + 1);
      if (!line) continue;
      if (Buffer.byteLength(line) > this.maxProtocolFrameBytes) {
        const message = 'Codex emitted an oversized protocol frame';
        const child = this.proc;
        if (child) this._failProcess(child, this.processGeneration, message);
        else this.lastError = message;
        return;
      }
      let message;
      try { message = JSON.parse(line); } catch (_) {
        console.error('[codex-agent] unparseable:', line.slice(0, 160));
        continue;
      }
      try { this._normalize(message); } catch (error) {
        console.error('[codex-agent] normalize failed:', error.message);
      }
    }
    if (Buffer.byteLength(this.buf) > this.maxProtocolFrameBytes) {
      const message = 'Codex emitted an oversized protocol frame';
      const child = this.proc;
      this.buf = '';
      if (child) this._failProcess(child, this.processGeneration, message);
      else this.lastError = message;
    }
  }

  _normalize(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    if (message.id != null && (message.result !== undefined || message.error)) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) return;
      this.pendingRequests.delete(message.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message || `${pending.method} failed`);
        error.code = message.error.code;
        if (pending.onError) pending.onError(error);
      } else if (pending.onResult) {
        pending.onResult(message.result);
      }
      return;
    }

    // Scribe's enabled MCP tools are pre-approved in _mcpConfig(). Its own MCP
    // servers never request structured user input, so any elicitation that
    // still reaches this headless client is unexpected. Resolve it with the
    // protocol's fail-closed response instead of returning "method not found",
    // which app-server misleadingly reports as a user-rejected tool call.
    if (message.id != null && message.method) {
      if (message.method === 'mcpServer/elicitation/request') {
        this._send({
          id: message.id,
          result: { action: 'cancel', content: null },
        });
        return;
      }
      this._send({
        id: message.id,
        error: { code: -32601, message: `Scribe does not handle ${message.method}` },
      });
      return;
    }

    const method = message.method;
    const params = message.params || {};
    if (!method) return;

    if (method === 'turn/started') {
      const turn = params.turn || {};
      if (turn.id && this.completedTurns.has(turn.id)) return;
      this.activeTurnId = turn.id || this.activeTurnId;
      this.busy = true;
      this.turnStartedAt = this.turnStartedAt || Date.now();
      if (turn.id && !this.announcedTurns.has(turn.id)) {
        this.announcedTurns.add(turn.id);
        this.onEvent({ kind: 'turn-start' });
      }
      return;
    }

    if (method === 'item/reasoning/summaryTextDelta' ||
        method === 'item/reasoning/textDelta') {
      if (!this.reasoningItems.has(params.itemId)) {
        this.reasoningItems.add(params.itemId);
        this.onEvent({ kind: 'thinking-start' });
      }
      return;
    }

    if (method === 'item/agentMessage/delta') {
      this.responseText += params.delta || '';
      this.onEvent({ kind: 'text', text: params.delta || '' });
      return;
    }

    if (method === 'item/started') {
      return this._itemStarted(params.item || {}, params.threadId);
    }

    if (method === 'item/completed') {
      return this._itemCompleted(params.item || {}, params.threadId);
    }

    if (method === 'turn/completed') {
      return this._turnCompleted(params.turn || {});
    }

    if (method === 'error' && params.willRetry === false) {
      // app-server follows this notification with turn/completed. It describes
      // the current turn, not the health of the long-lived CLI process.
      this.turnError = params.error && params.error.message || 'Codex turn failed';
      this.onEvent({ kind: 'turn-error', error: this.turnError });
    }
  }

  _parentFor(threadId) {
    if (!threadId || threadId === this.threadId) return null;
    return this.subagentParents.get(threadId) || threadId;
  }

  _itemStarted(item, threadId) {
    if (!item || typeof item !== 'object') return;
    const parent = this._parentFor(threadId);
    if (item.type === 'reasoning') {
      if (!this.reasoningItems.has(item.id)) {
        this.reasoningItems.add(item.id);
        this.onEvent({ kind: 'thinking-start' });
      }
      return;
    }
    if (item.type === 'mcpToolCall') {
      if (!item.id) return;
      const name = toolName(item);
      this.pendingTools.set(item.id, { name, parent });
      this.onEvent({ kind: 'tool-pending', id: item.id, name, parent });
      const partial = JSON.stringify(item.arguments || {});
      this.onEvent({ kind: 'tool-args', id: item.id, partial });
      this.onEvent({
        kind: 'tool-call',
        id: item.id,
        name,
        input: item.arguments || {},
        parent,
      });
      return;
    }
    if (item.type === 'collabAgentToolCall') {
      if (!item.id) return;
      for (const id of item.receiverThreadIds || []) this.subagentParents.set(id, item.id);
      const input = {
        description: item.prompt || item.tool,
        model: item.model || null,
        operation: item.tool,
      };
      this.pendingTools.set(item.id, { name: 'Agent', parent });
      this.onEvent({ kind: 'tool-pending', id: item.id, name: 'Agent', parent });
      this.onEvent({ kind: 'tool-args', id: item.id, partial: JSON.stringify(input) });
      this.onEvent({ kind: 'tool-call', id: item.id, name: 'Agent', input, parent });
    }
  }

  _itemCompleted(item, threadId) {
    if (!item || typeof item !== 'object') return;
    const parent = this._parentFor(threadId);
    if (item.type === 'agentMessage') {
      this.responseText = item.text || this.responseText;
      if (item.text) this.onEvent({ kind: 'message', text: item.text, parent });
      return;
    }
    if (item.type === 'mcpToolCall') {
      if (!item.id) return;
      if (!this.pendingTools.has(item.id)) this._itemStarted(item, threadId);
      this.pendingTools.delete(item.id);
      const failed = item.status === 'failed' || !!item.error;
      this.onEvent({
        kind: 'tool-result',
        id: item.id,
        parent,
        isError: failed,
        text: resultText(item.error || item.result).slice(0, 4000),
      });
      return;
    }
    if (item.type === 'collabAgentToolCall') {
      if (!item.id) return;
      for (const id of item.receiverThreadIds || []) this.subagentParents.set(id, item.id);
      if (!this.pendingTools.has(item.id)) this._itemStarted(item, threadId);
      this.pendingTools.delete(item.id);
      this.onEvent({
        kind: 'tool-result',
        id: item.id,
        parent,
        isError: item.status === 'failed',
        text: `${item.tool || 'agent'} ${item.status || 'completed'}`,
      });
    }
  }

  _turnCompleted(turn) {
    if (!turn || typeof turn !== 'object') return;
    if (turn.id && this.completedTurns.has(turn.id)) return;
    if (turn.id && this.activeTurnId && turn.id !== this.activeTurnId) return;
    const activeId = turn.id || this.activeTurnId;
    const items = Array.isArray(turn.items) ? turn.items : [];
    const final = [...items].reverse().find((item) => item.type === 'agentMessage');
    const text = final && final.text || this.responseText || null;
    const interrupted = turn.status === 'interrupted';
    const error = turn.error && turn.error.message || this.turnError || null;
    const durationMs = turn.durationMs != null
      ? turn.durationMs
      : (this.turnStartedAt ? Date.now() - this.turnStartedAt : null);

    this.busy = false;
    this.turnStarting = false;
    this.steerPending = false;
    this.activeTurnId = null;
    this.interrupting = false;
    this.turnStartedAt = null;
    this.turnError = null;
    this.turns++;
    if (activeId) {
      this.completedTurns.add(activeId);
      while (this.completedTurns.size > 100) {
        this.completedTurns.delete(this.completedTurns.values().next().value);
      }
    }
    if (activeId) this.announcedTurns.delete(activeId);
    this.pendingTools.clear();
    this.reasoningItems.clear();

    this.onEvent({
      kind: 'turn-end',
      subtype: turn.status || 'completed',
      interrupted,
      text,
      durationMs,
      ttftMs: null,
      costUsd: null,
      totalCostUsd: this.costUsd,
      denials: [],
      error,
    });
    this._flushInputs();
  }

  _fatal(message) {
    const child = this.proc;
    const pid = child && child.pid || null;
    this.proc = null;
    ++this.processGeneration;
    this._resetTransient();
    this.lastError = message;
    try { if (child && child.stdin) child.stdin.end(); } catch (_) {}
    try { if (child) child.kill(); } catch (_) {}
    this.onEvent({ kind: 'agent-error', pid, error: message });
  }

  status() {
    return {
      running: this.running,
      pid: this.pid,
      sessionId: this.sessionId,
      model: this.model,
      provider: this.provider,
      cliModel: this.cliModel,
      busy: this.busy,
      turns: this.turns,
      costUsd: this.costUsd,
      error: this.lastError,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
    };
  }
}

module.exports = {
  CodexAgent,
  CODEX_MODELS,
  isCodexModel,
  normalizeCodexModel,
  codexModelId,
  resolveCodex,
  subscriptionEnv,
  resultText,
};
