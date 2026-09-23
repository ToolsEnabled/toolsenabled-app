'use strict';
/*
 * codex-agent.js — Codex CLI transport for the Agent Studio team.
 *
 * The suite spawns one child per agent to edit the live deck. agents.js does
 * that with the Claude CLI; this file does the same job with the Codex CLI so
 * the human can keep working when one provider's limits run out. Everything
 * downstream (server.js spend rollups, /studio chips, ppt.js agents/spend)
 * consumes AgentProc's shape, so CodexAgentProc emits the SAME events with the
 * SAME payloads. Provider choice never leaks past this file.
 *
 * Ported from scribe/codex-agent.js (the sibling app's working transport),
 * which already solved: resolving codex.exe without shell:true, stripping API
 * keys so the ChatGPT subscription login is used, the app-server JSON-RPC
 * framing, and normalizing Codex items into one event vocabulary. Three things
 * were rewritten rather than copied, each marked DIVERGENCE below:
 *   1. The queue. Scribe STEERS a running turn with a mid-flight message.
 *      agents.js's AgentProc holds message N+1 until N's result lands, and the
 *      whole task-dispatch design depends on that, so this file keeps
 *      AgentProc's _pump discipline and never calls turn/steer.
 *   2. Token usage. Codex reports it on a separate thread/tokenUsage/updated
 *      notification, not on turn completion, and its inputTokens INCLUDES the
 *      cached part (Anthropic's excludes it). Both are handled in _usageFor().
 *   3. Model self-report. A Codex thread never echoes its model back, so
 *      reportedModel comes from the model/rerouted notification instead.
 *
 * Codex agents intentionally run with the same full local capabilities as an
 * explicitly trusted Codex session: shell/filesystem access, live web search,
 * browser/computer tools, image generation, plugins/apps, and subagents. The
 * suite PPT MCP remains required so ordinary deck edits still use the validated
 * pause/history/render path. This is a trusted-workstation mode, not a sandbox.
 */
const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HERE = __dirname;                         // .../suite
const PROJECT_ROOT = path.resolve(HERE, '..');  // .../Presentation
const PROJECT_SCOPE = PROJECT_ROOT.replace(/\\/g, '/');
const MCP_PPT = path.join(HERE, 'mcp-ppt.js');  // required validated deck-edit capability
const HISTORY_LIMIT = 50;                       // matches AgentProc: a long-lived name would otherwise grow history forever
const RPC_TIMEOUT_MS = Math.max(
  25,
  Number.parseInt(process.env.SUITE_CODEX_RPC_TIMEOUT_MS || '30000', 10) || 30000
);
const STDOUT_FRAME_LIMIT = Math.max(
  1024,
  Number.parseInt(process.env.SUITE_CODEX_STDOUT_FRAME_LIMIT || String(4 * 1024 * 1024), 10)
    || 4 * 1024 * 1024
);

// ------------------------------------------------------------------- models
// Two separate maps on purpose.
//
// CODEX_MODELS holds names that ONLY mean something to Codex. isCodexModel()
// answers "does this string name a Codex model", and it is deliberately false
// for "sonnet" and "opus": those tier names belong to both providers, so if
// isCodexModel('sonnet') were true the mere presence of this file would
// silently reroute every spawn. Which transport to use is the manager's
// explicit decision, never an inference from a shared word.
//
// TIER_MODELS is the mapping applied AFTER that decision is made: the usage
// profiles in agents.js speak in tiers (lead: 'sonnet', worker: 'opus'), and
// this is where a tier becomes a real Codex model id.
const CODEX_MODELS = Object.freeze({
  terra: 'gpt-5.6-terra',
  sol: 'gpt-5.6-sol',
  'gpt-5.6-terra': 'gpt-5.6-terra',
  'gpt-5.6-sol': 'gpt-5.6-sol',
});
const TIER_MODELS = Object.freeze({
  sonnet: 'gpt-5.6-terra',   // the routing/dispatch tier
  opus: 'gpt-5.6-sol',       // the authoring tier
  haiku: 'gpt-5.6-terra',    // no cheaper Codex tier exists; do not fail the spawn over it
});
const DEFAULT_CODEX_MODEL = 'gpt-5.6-terra';

function isCodexModel(model) {
  return Object.prototype.hasOwnProperty.call(CODEX_MODELS, String(model || '').toLowerCase());
}

/** Tier name or Codex name in, real Codex model id out (null if unknown). */
function codexModelId(model) {
  const k = String(model || '').toLowerCase();
  return CODEX_MODELS[k] || TIER_MODELS[k] || null;
}

/**
 * Resolve a native executable so Windows never needs shell:true (with
 * shell:true an argv positional is silently eaten and you get a plausible
 * wrong answer, not a crash: the same rule agents.js follows for claude.exe).
 * Never the npm shim.
 *
 * Order matters. The env override wins so the human can point at a specific
 * build; PATH is next; then the two places Codex actually installs itself on
 * this machine. .sandbox-bin is checked because that is where the working
 * 0.145.0-alpha.18 binary lives here and it is NOT on PATH, so PATH-only
 * lookup (what scribe shipped) finds nothing.
 */
function resolveCodex() {
  const envp = process.env.SUITE_CODEX_EXE;
  if (envp && fs.existsSync(envp)) return envp;

  const executable = process.platform === 'win32' ? 'codex.exe' : 'codex';
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir.replace(/^"|"$/g, ''), executable);
    try { if (fs.existsSync(candidate)) return candidate; } catch (_) {}
  }

  const home = os.homedir();
  const sandboxBin = path.join(home, '.codex', '.sandbox-bin', executable);
  try { if (fs.existsSync(sandboxBin)) return sandboxBin; } catch (_) {}

  if (process.platform === 'win32') {
    // The ChatGPT VS Code extension ships its own codex.exe. Newest wins.
    const extensions = path.join(home, '.vscode', 'extensions');
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
const CODEX = resolveCodex();

/**
 * Keep the CLI on its cached subscription session. This whole migration exists
 * because the human's Claude limits ran out and they are paying for ChatGPT,
 * NOT for API tokens: an OPENAI_API_KEY sitting in the environment would
 * silently override the interactive login and bill them a second time. Stripped
 * from the child only, never from the human's own shell.
 */
function subscriptionEnv(extra = {}) {
  const env = Object.assign({}, process.env, extra);
  // Windows environment names are case-insensitive, but object keys are not.
  // Remove every API-key spelling rather than only the usual uppercase form.
  for (const key of Object.keys(env)) {
    if (/(^|_)API_?KEY$/i.test(key) || /^CODEX_API_KEY$/i.test(key)) delete env[key];
  }
  return env;
}

/**
 * Refuse API-key auth, including a key cached by `codex login`. Removing keys
 * from the child environment is not enough because the CLI also reuses its
 * cached login. The user explicitly chose ChatGPT subscription usage here, so
 * an API-key login is an unavailable provider, not a quiet billing fallback.
 */
function codexLoginStatus(executable = resolveCodex()) {
  if (!executable) {
    return { ok: false, method: null, detail: 'codex executable not found. Set SUITE_CODEX_EXE, or install the Codex CLI.' };
  }
  let result;
  try {
    result = spawnSync(executable, ['login', 'status'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      timeout: 5000,
      env: subscriptionEnv(),
    });
  } catch (error) {
    return { ok: false, method: null, detail: `could not check Codex login: ${error.message}` };
  }
  const output = String((result && result.stdout) || '') + '\n' + String((result && result.stderr) || '');
  if (result && result.status === 0 && /logged in using chatgpt/i.test(output)) {
    return { ok: true, method: 'chatgpt', detail: 'Logged in using ChatGPT.' };
  }
  if (/api key/i.test(output)) {
    return {
      ok: false,
      method: 'api-key',
      detail: 'Codex is logged in with an API key. Run "codex logout", then "codex login" and choose ChatGPT.',
    };
  }
  const why = output.trim().replace(/\s+/g, ' ').slice(0, 300);
  return {
    ok: false,
    method: null,
    detail: why || (result && result.error && result.error.message) || 'Codex is not logged in. Run "codex login" and choose ChatGPT.',
  };
}

/** Color is a pure function of the name in agents.js; borrow it rather than
 *  duplicating the palette (the server and /studio must agree by construction).
 *  Required lazily: agents.js requires THIS file, so a top-level require would
 *  be a cycle. By the time an agent is constructed both modules are loaded. */
function agentColor(name) {
  try { return require('./agents.js').agentColor(name); } catch (_) { return null; }
}

/** mcp__<server>__<tool>, the same tool-name shape the Claude children report,
 *  so `currentTool` reads identically in the UI whichever provider is running. */
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

// Only used when the caller passes no systemPrompt. agents.js owns the real
// role prompts; this fallback still has to describe the same trusted Codex
// capability and file-scope contract so a direct transport user does not get
// stale or dangerously incomplete instructions.
function FALLBACK_PROMPT(name, role) {
  return [
    'You are ' + name + ', a ' + role + ' on a team editing a live PowerPoint deck.',
    'You are a fully enabled Codex agent with shell/filesystem access, live web search, image generation,',
    'plugins/apps, subagents, and any browser/computer host tools exposed in this thread.',
    `STRICT FILE SCOPE: work only in the Presentation PDF project rooted at ${PROJECT_SCOPE}.`,
    'Never access or modify LLMBenchmarking. Scribe is read-only: it may be read but never modified.',
    'Prefer the validated ppt_* tools for supported presentation mutations. If a tool reports that',
    'editing is paused, stop and do not retry.',
    'House rules: no em dashes anywhere, minimum 20pt font, one font family. Keep replies to one short sentence.',
  ].join('\n');
}

// ------------------------------------------------------------ CodexAgentProc
// One queued Codex child. INVARIANT (inherited from AgentProc, deliberately
// NOT relaxed): message N+1 is never sent until the result for N lands. _pump
// is the only place a turn is ever started.
class CodexAgentProc extends EventEmitter {
  constructor({
    name,
    role,
    firstMessage,
    livePort,
    model,
    maxWorkers,
    maxMediaWorkers,
    systemPrompt,
  } = {}) {
    super();
    this.name = name;
    this.role = role;                        // 'lead' | 'worker'
    this.provider = 'codex';
    // The manager speaks in tiers ("sonnet" for the lead, "opus" for a worker
    // under the extra profile). Both are recorded, and `model` is deliberately
    // the RESOLVED Codex id rather than the tier, because `model` is what gets
    // rendered in the /studio chip and what keys server.js's spend.byModel
    // rollup. Reporting "sonnet" there would put this agent's turns in the same
    // bucket as a real Claude sonnet agent, mixing measured dollars with this
    // transport's unmeasured 0 in one number, and would tell the human "sonnet"
    // while Codex is what is actually running. Frozen for this process's life,
    // same as AgentProc: the model is a thread-open parameter with no in-band
    // way to change it.
    this.tier = model || 'sonnet';
    this.model = codexModelId(this.tier) || DEFAULT_CODEX_MODEL;
    this.cliModel = this.model;               // alias: what is sent on the wire
    this.reportedModel = null;               // see model/rerouted in _normalize
    this.maxWorkers = maxWorkers;
    this.maxMediaWorkers = Number.isFinite(Number(maxMediaWorkers))
      ? Math.max(0, Math.floor(Number(maxMediaWorkers)))
      : 0;
    this.systemPrompt = String(systemPrompt || FALLBACK_PROMPT(name, role));
    this.livePort = livePort || 4599;

    // Codex on a ChatGPT subscription reports no dollar amount at all: the
    // usage that matters is drawn from the plan's rolling windows, not billed
    // per token. costUsd therefore stays 0 FOREVER for this transport. That is
    // a "not measured" 0, not a "free" 0, and the UI should say so rather than
    // rendering $0.00 next to a Claude agent's real spend. The honest numbers
    // for these agents are this.tokens and the rate-limit percentage.
    this.costUsd = 0;
    this.turns = 0;
    this.tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    this.currentTool = null;
    this.color = agentColor(name);
    this.t0 = Date.now();
    this.startedAt = this.t0;
    this.queue = [];
    this.inflight = null;
    this.history = [];
    this.dead = false;
    this.msgSeq = 0;
    this._stderr = '';
    this._exited = false;   // _onExit must fire exactly once, from any of three paths

    // JSON-RPC / protocol state
    this.threadId = null;
    this.activeTurnId = null;
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
    this.pendingTools = new Map();
    this.responseText = '';
    this._buf = '';
    // Cumulative thread totals at the start of the in-flight turn. Codex
    // reports thread-cumulative usage, so a per-turn number is a delta.
    this._usageBase = null;
    this._usageLatest = null;
    this._turnError = null;
    this._interruptPending = false;
    // App-server replies and notifications are independent JSON-RPC messages.
    // A turn can complete before its original turn/start response arrives, so
    // keep a small tombstone set that prevents late ids from being adopted by
    // the next queued message.
    this._closedTurnIds = new Set();

    const executable = resolveCodex();
    const login = codexLoginStatus(executable);
    if (!executable || !login.ok) {
      // Fail the same way a missing claude.exe does: dead on arrival with the
      // reason recorded, rather than a live-looking agent that never answers.
      this.pid = null;
      this.dead = true;
      this._stderr = login.detail;
      // Defer so the caller can attach listeners to the object it is still
      // constructing (the manager wires events after `new` returns).
      setImmediate(() => this._onExit(null, 'no-executable'));
      return;
    }

    this.proc = spawn(executable, ['app-server', '--stdio'], {
      cwd: PROJECT_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,                            // never shell:true, never the npm shim
      env: subscriptionEnv({
        SUITE_EDITOR: name,
        SUITE_PORT: String(this.livePort),
        SUITE_HOST: '127.0.0.1',
        SUITE_MCP_ROLE: role === 'lead' ? 'lead' : 'worker',
        SUITE_AGENT_WORKER_CAP: String(this.maxWorkers || 1),
        SUITE_AGENT_MEDIA_WORKER_CAP: String(this.maxMediaWorkers),
      }),
    });
    this.pid = this.proc.pid || null;

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.stdout.on('error', (e) => {
      this._stderr = (this._stderr + '\nstdout: ' + String(e)).slice(-2000);
      try { this.proc.kill(); } catch (_) {}
      this._onExit(null, 'stdout-error');
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (text) => { this._stderr = (this._stderr + text).slice(-2000); });
    this.proc.stderr.on('error', (e) => {
      this._stderr = (this._stderr + '\nstderr: ' + String(e)).slice(-2000);
      try { this.proc.kill(); } catch (_) {}
      this._onExit(null, 'stderr-error');
    });
    this.proc.on('error', (e) => {
      this._stderr = (this._stderr + '\n' + String(e)).slice(-2000);
      this._onExit(null, 'spawn-error');
    });
    this.proc.stdin.on('error', (e) => {
      this._stderr = (this._stderr + '\n' + String(e)).slice(-2000);
      try { this.proc.kill(); } catch (_) {}
      this._onExit(null, 'stdin-error');
    });
    this.proc.on('exit', (code, sig) => this._onExit(code, sig));

    this._request('initialize', {
      clientInfo: { name: 'suite', title: 'Agent Studio', version: '1.0.0' },
    }, () => {
      this._notify('initialized', {});
      this._openThread();
    }, (error) => this._fatal('Codex initialization failed: ' + error.message));

    if (firstMessage != null) this.enqueue(firstMessage);
  }

  // ------------------------------------------------------- Codex capabilities
  /*
   * The human explicitly chose trusted full-access Codex workers. The app
   * server's documented full-access pairing is sandbox=danger-full-access with
   * approvalPolicy=never. Live web plus the feature switches below expose the
   * normal coding/visual toolchain instead of limiting an agent to ppt_* calls.
   *
   * The role-gated ppt MCP stays required and pre-approved. It remains the
   * preferred path for deck mutations because it preserves pause, revision,
   * undo, rendering, and lint behavior. GitHub and Developer Docs MCP entries
   * remain disabled here: they are unrelated private/global connectors, not
   * local Codex capabilities, and are unnecessary for presentation work.
   */
  _mcpConfig() {
    return {
      model_reasoning_effort: 'medium',
      web_search: 'live',
      features: {
        shell_tool: true,
        shell_snapshot: true,
        apps: true,
        browser_use: true,
        browser_use_external: true,
        browser_use_full_cdp_access: true,
        in_app_browser: true,
        computer_use: true,
        image_generation: true,
        remote_plugin: true,
        plugins: true,
        multi_agent: true,
      },
      mcp_servers: {
        ppt: {
          command: process.execPath,          // this node, not whatever is on PATH
          args: [MCP_PPT],
          env: {
            SUITE_PORT: String(this.livePort),
            SUITE_HOST: '127.0.0.1',
            SUITE_EDITOR: this.name,
            SUITE_MCP_ROLE: this.role === 'lead' ? 'lead' : 'worker',
            SUITE_AGENT_WORKER_CAP: String(this.maxWorkers || 1),
            SUITE_AGENT_MEDIA_WORKER_CAP: String(this.maxMediaWorkers),
          },
          required: true,                     // no ppt server means no capability at all: fail loudly
          // enabled_tools is deliberately OMITTED. mcp-ppt.js already gates its
          // surface by SUITE_MCP_ROLE, so listing names here would duplicate
          // that decision in a second place and, worse, silently drop any tool
          // added later that this file did not know to name.
          // The suite is the policy boundary for these loopback-only tools.
          // "auto" opens an approval form that this headless client cannot
          // display, so trusted role-gated tools must be pre-approved here.
          default_tools_approval_mode: 'approve',
        },
        // The url/token fields are NOT optional decoration around enabled:false.
        // Codex validates the transport of every declared server before it
        // looks at whether it is enabled, so a bare {enabled:false} is rejected
        // with "invalid transport" and takes the ENTIRE thread down with it
        // (verified: thread/start failed outright until these were restored).
        // Keep them matching the human's own config entries.
        github: {
          url: 'https://api.githubcopilot.com/mcp/',
          bearer_token_env_var: 'GITHUB_PAT_TOKEN',
          enabled: false,
        },
        openaiDeveloperDocs: { url: 'https://developers.openai.com/mcp', enabled: false },
      },
    };
  }

  _threadParams() {
    return {
      model: this.cliModel,
      cwd: PROJECT_ROOT,
      developerInstructions: this.systemPrompt,
      approvalPolicy: 'never',                // trusted headless worker: never wedge waiting for an invisible approval UI
      sandbox: 'danger-full-access',           // explicit human choice; see the capability note above
      personality: 'pragmatic',
      config: this._mcpConfig(),
      ephemeral: false,
    };
  }

  _openThread() {
    this._request('thread/start', this._threadParams(), (result) => {
      const id = result && result.thread && result.thread.id;
      if (!id) return this._fatal('Codex did not return a thread id.');
      this.threadId = id;
      // A Codex thread never echoes its model back (the Thread object has no
      // model field), so unlike the Claude path there is nothing to compare
      // against at startup. Seed it with what we asked for; the only real
      // signal that the request did not take is a model/rerouted notification,
      // which overwrites this below.
      this.reportedModel = this.cliModel;
      this._pump();                            // anything queued during boot goes now
    }, (error) => this._fatal('Codex thread start failed: ' + error.message));
  }

  // --------------------------------------------------------- JSON-RPC plumbing
  _send(message) {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) return false;
    try { this.proc.stdin.write(JSON.stringify(message) + '\n'); return true; }
    catch (_) { return false; }
  }

  _request(method, params, onResult, onError) {
    const id = this.nextRequestId++;
    const timer = setTimeout(() => {
      const pending = this.pendingRequests.get(id);
      if (!pending) return;
      this.pendingRequests.delete(id);
      const error = new Error(`${method} timed out after ${RPC_TIMEOUT_MS}ms`);
      error.code = 'ETIMEDOUT';
      // A timed-out request means the single stdio protocol lane is wedged.
      // Continuing would only queue later turns behind an app-server whose
      // reply boundary is no longer known.
      this._fatal(`Codex protocol request timed out: ${method}`);
      if (pending.onError) pending.onError(error);
    }, RPC_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    this.pendingRequests.set(id, { method, onResult, onError, timer });
    if (!this._send({ method, id, params })) {
      const pending = this.pendingRequests.get(id);
      this.pendingRequests.delete(id);
      if (pending && pending.timer) clearTimeout(pending.timer);
      if (onError) onError(new Error('Codex process is not writable'));
    }
    return id;
  }

  _notify(method, params) { return this._send({ method, params }); }

  _onData(chunk) {
    if (this._exited) return;
    this._buf += chunk;
    let i;
    while ((i = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, i).trim();
      this._buf = this._buf.slice(i + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, 'utf8') > STDOUT_FRAME_LIMIT) {
        this._protocolFailure(`Codex stdout frame exceeded ${STDOUT_FRAME_LIMIT} bytes`, line);
        return;
      }
      let message;
      try { message = JSON.parse(line); }
      catch (e) {
        this._protocolFailure('stream-parse-error: ' + e.message, line);
        return;
      }
      try { this._normalize(message); }
      catch (e) {
        this._protocolFailure('stream-normalize-error: ' + e.message, line);
        return;
      }
    }
    if (Buffer.byteLength(this._buf, 'utf8') > STDOUT_FRAME_LIMIT) {
      this._protocolFailure(`Codex stdout frame exceeded ${STDOUT_FRAME_LIMIT} bytes`, this._buf);
    }
  }

  _protocolFailure(error, line) {
    const sample = String(line || '').slice(0, 200);
    this._stderr = (this._stderr + '\n' + error + (sample ? ' :: ' + sample : '')).slice(-2000);
    this.emit('stream-error', { line: sample, error });
    this._fatal('Codex protocol stream is unusable');
  }

  _normalize(message) {
    // 1. A response to one of our requests.
    if (message.id != null && (message.result !== undefined || message.error)) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) return;
      this.pendingRequests.delete(message.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message || pending.method + ' failed');
        error.code = message.error.code;
        if (pending.onError) pending.onError(error);
      } else if (pending.onResult) {
        pending.onResult(message.result);
      }
      return;
    }

    // 2. A request FROM the server. Suite-owned MCP tools are pre-approved in
    //    _mcpConfig(), and mcp-ppt.js never requests structured user input. If
    //    an elicitation nevertheless arrives, resolve it with the protocol's
    //    fail-closed response. A generic method-not-found error is surfaced by
    //    app-server as a misleading user-rejected tool call.
    if (message.id != null && message.method) {
      if (message.method === 'mcpServer/elicitation/request') {
        this._send({
          id: message.id,
          result: { action: 'cancel', content: null },
        });
        return;
      }
      this._send({ id: message.id, error: { code: -32601, message: 'the suite does not handle ' + message.method } });
      return;
    }

    const method = message.method;
    const params = message.params || {};
    if (!method) return;

    if (method === 'turn/started') {
      // Can arrive before the turn/start response does, so both places stamp
      // the id onto the in-flight message (see _turnCompleted).
      this._adoptTurnId(params.turn && params.turn.id);
      return;
    }

    if (method === 'item/agentMessage/delta') {
      if (!this._turnNotificationIsCurrent(params)) return;
      this.responseText += params.delta || '';
      return;
    }

    if (method === 'item/started') {
      if (!this._turnNotificationIsCurrent(params)) return;
      return this._itemStarted(params.item || {});
    }
    if (method === 'item/completed') {
      if (!this._turnNotificationIsCurrent(params)) return;
      return this._itemCompleted(params.item || {});
    }
    if (method === 'turn/completed') return this._turnCompleted(params.turn || {});

    if (method === 'thread/tokenUsage/updated') {
      // Cumulative thread totals, pushed during the turn rather than at its
      // end. Keep the newest; _usageFor() turns it into a per-turn delta.
      const tu = params.tokenUsage || {};
      if (tu.total) this._usageLatest = tu.total;
      return;
    }

    if (method === 'account/rateLimits/updated') {
      return this._rateLimits(params.rateLimits || {});
    }

    if (method === 'model/rerouted') {
      // The Codex equivalent of "the --model flag did not take": the request
      // was accepted but something else actually ran, so every token below is
      // attributed to the wrong model unless this is surfaced.
      if (params.toModel) this.reportedModel = String(params.toModel);
      return;
    }

    if (method === 'error') {
      if (params.turnId && !this._turnNotificationIsCurrent(params)) return;
      const text = (params.error && params.error.message) || params.message || 'Codex reported an error';
      this._stderr = (this._stderr + '\n' + text).slice(-2000);
      if (params.willRetry === false) this._turnError = text;
    }
  }

  _turnNotificationIsCurrent(params) {
    const m = this.inflight;
    if (!m) return false;
    const id = params && params.turnId;
    // Older app-server builds omitted turnId on item notifications. They are
    // safe only while a turn is actually in flight; current builds are matched
    // exactly so late item/delta/error frames from a closed turn cannot bleed
    // into the next queued response.
    if (!id) return true;
    if (this._closedTurnIds.has(id)) return false;
    if (m.turnId && m.turnId !== id) return false;
    if (!m.turnId && !this._adoptTurnId(id, m)) return false;
    return m.turnId === id;
  }

  _itemStarted(item) {
    if (item.type !== 'mcpToolCall') return;
    const name = toolName(item);
    this.pendingTools.set(item.id, name);
    this.currentTool = name;
    this.emit('tool', name);
  }

  _itemCompleted(item) {
    if (item.type === 'agentMessage') {
      this.responseText = item.text || this.responseText;
      return;
    }
    if (item.type === 'mcpToolCall') {
      this.pendingTools.delete(item.id);
      // `currentTool` is a live activity indicator, not a record of the last
      // tool used. Leaving it untouched here made a 50 ms ppt_show continue to
      // read as the agent's current operation for the rest of a multi-minute
      // turn (image generation, browser QA, subagents, and shell work). That
      // looked exactly like a wedged MCP transport in Studio even though the
      // app-server had already emitted mcp_tool_call_end. Preserve another
      // concurrently running MCP call when one exists; otherwise clear the
      // indicator immediately and refresh the roster.
      const remaining = Array.from(this.pendingTools.values());
      const nextCurrentTool = remaining.length ? remaining[remaining.length - 1] : null;
      if (this.currentTool !== nextCurrentTool) {
        this.currentTool = nextCurrentTool;
        this.emit('tool', nextCurrentTool);
      }
      if (item.status === 'failed' || item.error) {
        // A denied or broken ppt call is the single most useful thing in the
        // stderr tail when an agent quietly achieves nothing.
        this._stderr = (this._stderr + '\ntool ' + toolName(item) + ' failed: '
          + resultText(item.error || item.result).slice(0, 400)).slice(-2000);
      }
    }
  }

  // ------------------------------------------------------------------ usage
  /*
   * Codex's TokenUsageBreakdown is camelCase and its inputTokens INCLUDES the
   * cached portion, the opposite of Anthropic's input_tokens (the uncached
   * remainder only). Mapping inputTokens straight onto `input` while also
   * reporting cachedInputTokens as cacheRead would count the cached prompt
   * twice and roughly double this agent's apparent prompt size. So `input` is
   * the remainder here too, which keeps the field meaning the same thing for
   * both providers, which is the only way spend.byModel comparisons mean
   * anything. Both key spellings are read because the shipped schema
   * (camelCase) and the older wire docs (snake_case) disagree.
   */
  _usageFor(breakdown, base) {
    const g = (obj, camel, snake) => {
      if (!obj) return 0;
      const v = obj[camel] != null ? obj[camel] : obj[snake];
      return typeof v === 'number' ? v : 0;
    };
    const at = (obj) => ({
      inputTotal: g(obj, 'inputTokens', 'input_tokens'),
      cacheRead: g(obj, 'cachedInputTokens', 'cached_input_tokens'),
      cacheWrite: g(obj, 'cacheWriteInputTokens', 'cache_write_input_tokens'),
      output: g(obj, 'outputTokens', 'output_tokens'),
      reasoning: g(obj, 'reasoningOutputTokens', 'reasoning_output_tokens'),
    });
    const now = at(breakdown);
    const was = at(base);
    // Clamped at 0: thread/compacted can reset the cumulative counters, and a
    // negative delta would corrupt the session rollup permanently.
    const d = (k) => Math.max(0, now[k] - was[k]);
    const cacheRead = d('cacheRead');
    const cacheWrite = d('cacheWrite');
    const usage = {
      input: Math.max(0, d('inputTotal') - cacheRead),   // uncached remainder, as above
      output: d('output'),                               // reasoning tokens are a subset of output
      cacheRead,
      cacheWrite,
      reasoning: d('reasoning'),                         // extra key: unused downstream, but not worth discarding
    };
    // cacheWrite is assumed disjoint from inputTokens. OpenAI does not bill or
    // report cache writes on this path (the field defaults to 0), so the worst
    // case is a small overcount that cannot happen today.
    usage.promptTokens = usage.input + usage.cacheWrite + usage.cacheRead;
    return usage;
  }

  _rateLimits(snapshot) {
    const win = (w) => (w && typeof w.usedPercent === 'number') ? w : null;
    const primary = win(snapshot.primary);
    const secondary = win(snapshot.secondary);
    // The binding constraint is whichever window is furthest along, which is
    // what the human needs to see before it stops their own terminal too.
    const worst = (primary && secondary)
      ? (primary.usedPercent >= secondary.usedPercent ? primary : secondary)
      : (primary || secondary);
    if (!worst) return;
    const label = worst === secondary ? 'weekly' : 'rolling';
    this.emit('rate-limit', {
      // Both readers (ppt.js spend, studio.js chip) treat utilization as a
      // 0..1 fraction and only tolerate 0..100 as a fallback, so normalize
      // here: a raw usedPercent of 1 would otherwise render as 100%.
      utilization: worst.usedPercent / 100,
      window: label,
      resetsAt: worst.resetsAt || null,
      windowDurationMins: worst.windowDurationMins || null,
      planType: snapshot.planType || null,
      provider: 'codex',
    });
  }

  // ------------------------------------------------------------ turn lifecycle
  enqueue(text, meta = {}) {
    if (this.dead) return null;
    const m = {
      id: 'm' + (++this.msgSeq),
      text: String(text),
      meta,
      enqueuedAt: Date.now() - this.t0,
    };
    this.queue.push(m);
    this.emit('enqueued', m, this.depth);
    this._pump();
    return m;
  }

  // The ONLY place a turn is started. Holding on !threadId is what makes the
  // boot handshake invisible to callers: a message enqueued a millisecond after
  // construction waits in the queue and goes out when the thread opens.
  _pump() {
    if (this.dead || this.inflight) return;
    if (!this.threadId) return;                 // _openThread pumps once ready
    const m = this.queue.shift();
    if (!m) { this.emit('drained'); return; }
    this.inflight = m;
    m.startedAt = Date.now();
    m.waitedMs = (Date.now() - this.t0) - m.enqueuedAt;
    this.responseText = '';
    this._turnError = null;
    // Never inherited across a turn boundary: a cancel aimed at the turn that
    // just ended must not silently kill the one starting now.
    this._interruptPending = false;
    this._usageBase = this._usageLatest;         // per-turn usage is a delta from here

    this._request('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: m.text }],
      model: this.cliModel,
      effort: 'medium',
      personality: 'pragmatic',
      approvalPolicy: 'never',
    }, (result) => {
      // Scope the response to the message that issued it. Completion can pump
      // the next queued message before this response arrives.
      this._adoptTurnId(result && result.turn && result.turn.id, m);
    }, (error) => {
      // DIVERGENCE from the Claude path: there, a failed turn still produces a
      // 'result' event, so the queue always advances. Here turn/start can be
      // rejected outright, and without finishing the message explicitly this
      // agent would sit at 'thinking' with a growing queue forever.
      if (this.inflight === m) {
        this._finishTurn({ status: 'failed', error: { message: error.message } });
      }
    });
    this.emit('turn-start', m);
  }

  // Bind a turn id to the message that is waiting on it, from whichever of the
  // two signals arrives first.
  _adoptTurnId(id, expectedMessage) {
    if (!id || this._closedTurnIds.has(id)) return false;
    if (!this.inflight) return false;
    if (expectedMessage && this.inflight !== expectedMessage) return false;
    // The other start signal already associated this message with a different
    // id. This signal is stale; changing activeTurnId would make interrupt()
    // target the wrong turn and completion would wedge the real one.
    if (this.inflight.turnId && this.inflight.turnId !== id) return false;
    this.activeTurnId = id;
    this.inflight.turnId = id;
    // A cancel that arrived before the id did has been waiting for exactly
    // this moment (see interrupt()).
    if (this._interruptPending) { this._interruptPending = false; this._sendInterrupt(); }
    return true;
  }

  _rememberClosedTurn(id) {
    if (!id) return;
    this._closedTurnIds.add(id);
    if (this._closedTurnIds.size > 100) {
      this._closedTurnIds.delete(this._closedTurnIds.values().next().value);
    }
  }

  _turnCompleted(turn) {
    // A completion for a turn that is not the one in flight would otherwise
    // close out the WRONG message: it would end a turn that is still running
    // and credit it with another turn's tokens.
    const m = this.inflight;
    if (turn.id && this._closedTurnIds.has(turn.id)) return;
    if (!m) { this._rememberClosedTurn(turn.id); return; }
    if (turn.id && m.turnId && turn.id !== m.turnId) {
      this._rememberClosedTurn(turn.id);
      return;
    }
    if (turn.id && !m.turnId) this._adoptTurnId(turn.id, m);
    this._finishTurn(turn);
  }

  _finishTurn(turn) {
    const m = this.inflight;
    this._rememberClosedTurn((turn && turn.id) || (m && m.turnId));
    this.inflight = null;
    this.activeTurnId = null;
    this.currentTool = null;
    this._interruptPending = false;
    this.pendingTools.clear();
    if (!m) { this._pump(); return; }

    const items = Array.isArray(turn.items) ? turn.items : [];
    const last = [...items].reverse().find((it) => it.type === 'agentMessage');
    const status = turn.status || 'completed';
    const errText = (turn.error && turn.error.message) || this._turnError || null;

    m.result = (last && last.text) || this.responseText || errText || null;
    m.ranMs = Date.now() - m.startedAt;          // wall clock, includes queue wait
    m.apiMs = typeof turn.durationMs === 'number' ? turn.durationMs : null;
    m.isError = status !== 'completed';
    m.subtype = status;                          // 'interrupted' | 'failed' | 'completed'
    m.numTurns = null;                           // Codex has no inner-turn count to report
    m.error = errText;

    const usage = this._usageFor(this._usageLatest, this._usageBase);
    m.usage = usage;
    m.costUsd = 0;                               // never measured on a subscription: see the constructor
    // The baseline for the NEXT turn is deliberately not set here: _pump takes
    // it at dispatch time, which correctly absorbs any late usage notification
    // that lands for this turn after it has already been closed out.

    this.turns += 1;
    this.tokens.input += usage.input;
    this.tokens.output += usage.output;
    this.tokens.cacheRead += usage.cacheRead;
    this.tokens.cacheWrite += usage.cacheWrite;

    this.history.push(m);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.emit('turn-end', m);
    // Separate from turn-end so the persisted rollup survives this process.
    this.emit('turn-cost', {
      name: this.name, role: this.role, model: this.model,
      costUsd: 0, usage, isError: m.isError, subtype: m.subtype, ts: Date.now(),
    });
    this._pump();
  }

  // Cancel the running turn WITHOUT killing the process, so thread context
  // survives. The interrupted turn still arrives as turn/completed with status
  // 'interrupted', which is what advances the queue.
  interrupt() {
    if (this.dead || !this.inflight || !this.threadId) return;
    // Codex needs a turn id to cancel, and that id only arrives a moment after
    // the turn is dispatched. Dropping the request in that window would make
    // the human's cancel button silently do nothing while the manager still
    // reported success (it only checks that a message is in flight), so remember
    // the intent and fire it the instant the id lands.
    if (!this.activeTurnId) { this._interruptPending = true; return; }
    this._sendInterrupt();
  }

  _sendInterrupt() {
    if (this.dead || !this.threadId || !this.activeTurnId) return;
    this._request('turn/interrupt', {
      threadId: this.threadId,
      turnId: this.activeTurnId,
    }, () => {}, (error) => {
      this._stderr = (this._stderr + '\ninterrupt failed: ' + error.message).slice(-2000);
    });
  }

  _fatal(message) {
    this._stderr = (this._stderr + '\n' + message).slice(-2000);
    this.kill();
  }

  _onExit(code, sig) {
    if (this._exited) return;   // kill() and the child's own exit both land here
    this._exited = true;
    this.dead = true;
    for (const pending of this.pendingRequests.values()) {
      if (pending.timer) clearTimeout(pending.timer);
    }
    this.pendingRequests.clear();
    const orphaned = [];
    if (this.inflight) { orphaned.push(this.inflight); this.inflight = null; }
    while (this.queue.length) orphaned.push(this.queue.shift());
    for (const m of orphaned) {
      m.result = null;
      m.failed = `child exited (code=${code} sig=${sig})`;
      this.emit('turn-failed', m);
    }
    this.emit('exit', { code, sig, orphaned, stderr: this._stderr });
  }

  get status() { return this.inflight ? 'thinking' : 'idle'; }
  get depth() { return this.queue.length + (this.inflight ? 1 : 0); }

  view() {
    const turnMs = this.inflight ? Date.now() - this.inflight.startedAt : null;
    const last = this.history.length ? this.history[this.history.length - 1] : null;
    const lastTurnSummary = last && last.result
      ? String(last.result).replace(/\s+/g, ' ').trim().slice(0, 140)
      : null;
    return {
      name: this.name, role: this.role, model: this.model,
      provider: 'codex', cliModel: this.cliModel, tier: this.tier,
      reportedModel: this.reportedModel,
      // Exact comparison, not AgentProc's substring test: here both sides are
      // real model ids, and only a model/rerouted notification can ever make
      // them differ.
      modelMismatch: !!(this.reportedModel && this.reportedModel !== this.model),
      color: this.color ? this.color.color : null,
      ink: this.color ? this.color.ink : null,
      key: this.color ? this.color.key : null,
      status: this.status, depth: this.depth, pid: this.pid, startedAt: this.startedAt,
      turnMs, lastTurnMs: last ? last.ranMs : null, lastTurnError: last ? !!last.isError : null,
      lastTurnSummary,
      currentTool: this.currentTool,
      // Always 0 and never measured on a ChatGPT subscription. costUsdMeasured
      // lets the UI distinguish that from a genuine zero instead of showing
      // $0.00 beside a Claude agent's real spend as though they compare.
      costUsd: 0, costUsdMeasured: false,
      turns: this.turns, tokens: this.tokens,
    };
  }

  // Drain synchronously after the targeted kill. The operating-system exit
  // event is not guaranteed to arrive promptly for a broken stdio child; the
  // idempotent _onExit guard makes its eventual late event harmless.
  kill() {
    if (this._exited) return;
    this.dead = true;
    try { if (this.proc && this.proc.stdin) this.proc.stdin.end(); } catch (_) {}
    try { if (this.proc) this.proc.kill(); } catch (_) {}
    this._onExit(null, 'killed');
  }
}

module.exports = {
  CodexAgentProc,
  CODEX_MODELS,
  TIER_MODELS,
  CODEX,
  isCodexModel,
  codexModelId,
  resolveCodex,
  subscriptionEnv,
  codexLoginStatus,
  resultText,
  FALLBACK_PROMPT,
  PROJECT_SCOPE,
};
