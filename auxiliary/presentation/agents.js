'use strict';
/*
 * agents.js — in-process manager for the Agent Studio lead + worker children.
 *
 * Node built-ins only (no npm). Bolts onto the EXISTING task queue: the
 * chatbox posts human text to the lead (POST /api/chat); the lead's one job is
 * `node ppt.js task "..." --for worker-N`, which lands on the ALREADY-EXISTING
 * POST /api/tasks; and that handler calls spawnOrWrite(assignee) to wake the
 * worker. The durable record stays board.json; a child's stdin is purely the
 * wake mechanism.
 *
 * Three things enforced HERE in code, never just in a prompt:
 *   1. Every child is spawned with --permission-mode dontAsk + the ppt-guard
 *      sandbox (agent-settings.json). NEVER bypassPermissions (may skip hooks).
 *   2. The stdin queue (verified in a Phase 3 spike) withholds message N+1
 *      until message N's 'result' lands, so a mid-flight "type more" message
 *      queues cleanly instead of STEERING the running turn (the failure the
 *      original plan assumed away).
 *   3. Orphan safety mirrors com_host.ps1 exactly: a pid file plus a boot-time
 *      sweep of ONLY our recorded pids (never a blanket claude.exe kill, which
 *      would murder the human's VS Code sessions).
 */
const { spawn, execFile } = require('child_process');
const { randomUUID } = require('crypto');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
// The Codex transport. Required lazily-safe (it must not spawn anything at
// require time) so the suite still boots on a machine with no Codex installed.
const Codex = require('./codex-agent');

const HERE = __dirname;                         // .../suite
const PROJECT_ROOT = path.resolve(HERE, '..');  // .../Presentation
const PROJECT_SCOPE = PROJECT_ROOT.replace(/\\/g, '/');
const GUARD_SETTINGS = path.join(HERE, 'agent-settings.json');
const AGENTS_PID_PATH = path.join(HERE, 'data', 'agents.pid.json');
// ppt-guard.js only writes an audit trail when GUARD_LOG is set in ITS OWN
// process env; nothing here ever set it on a spawned child, so every allow/
// deny decision the sandbox makes was previously unrecorded anywhere. This is
// the only durable record that the sandbox described in the README actually
// did anything: without it, a denied tool call is visible for one turn inside
// the worker's own reasoning and then gone.
const GUARD_LOG_PATH = path.join(HERE, 'data', 'guard.log');

// Usage profiles. The human picks one of four routes when their limits get
// close; each moves several real levers at once rather than exposing raw model
// names. Percentages are calibrated ESTIMATES of spend against `normal`, and
// state.spend.byModel (below) is what lets them be re-tuned from real data.
//
// No profile puts the lead on opus: the lead routes and dispatches, it never
// authors (AGENT_STUDIO_PLAN.md: "Lead (Sonnet, not Opus: it routes, it does
// not author)"), so paying opus rates there buys nothing. Workers are where
// authoring quality lives and where turn volume concentrates.
// Profiles name a TIER, never a concrete model id. The provider maps the tier
// to its own model (see PROVIDER_MODELS), so switching provider does not
// require rewriting every profile, and a profile means the same thing
// ("the workhorse" vs "the expensive one") on both.
const PROFILES = {
  low: {
    lead: 'workhorse', worker: 'workhorse',
    maxWorkers: 1, maxMediaWorkers: 0, boardNotes: 0, pct: 60,
    reasoningEffort: 'medium', serviceTier: 'standard', fastMode: false,
    fullAccess: false, forcedProvider: null,
  },
  normal: {
    lead: 'workhorse', worker: 'workhorse',
    maxWorkers: 2, maxMediaWorkers: 0, boardNotes: 5, pct: 100,
    reasoningEffort: 'medium', serviceTier: 'standard', fastMode: false,
    fullAccess: false, forcedProvider: null,
  },
  extra: {
    lead: 'workhorse', worker: 'heavy',
    maxWorkers: 12, maxMediaWorkers: 0, boardNotes: 5, pct: 150,
    reasoningEffort: 'medium', serviceTier: 'standard', fastMode: false,
    fullAccess: false, forcedProvider: null,
  },
  // Highest-tier trusted workstation mode. The general and media capacities
  // are independent: a full media lane must never consume or silently lower
  // the 30-slot general lane, and vice versa. The selected provider resolves
  // the heavy tier to Opus or Sol for the next spawn. Beast deliberately stays
  // on standard service speed; it maximizes capability and concurrency without
  // enabling the separate Fast usage multiplier.
  beast: {
    lead: 'heavy', worker: 'heavy',
    maxWorkers: 30, maxMediaWorkers: 10, boardNotes: 5, pct: 250,
    reasoningEffort: 'ultra', serviceTier: 'standard', fastMode: false,
    fullAccess: true, forcedProvider: null,
  },
};

// The two providers, both on a subscription login, never an API key. Access is
// a PROFILE decision, not a provider identity: lower-profile Claude children
// use the ppt-guard allowlist, while a trusted fullAccess profile launches
// Claude with its complete built-in/configured tool surface just as Codex does.
// Deck mutations still prefer the validated ppt CLI/MCP path in either mode.
const PROVIDER_MODELS = {
  claude: { workhorse: 'sonnet',        heavy: 'opus' },
  codex:  { workhorse: 'gpt-5.6-terra', heavy: 'gpt-5.6-sol' },
};
const PROVIDER_NAMES = Object.keys(PROVIDER_MODELS);
const DEFAULT_PROVIDER = PROVIDER_MODELS[process.env.SUITE_AGENT_PROVIDER] ? process.env.SUITE_AGENT_PROVIDER : 'claude';
const PROFILE_NAMES = Object.keys(PROFILES);   // cheapest-first; the toggle cycles in this order
const DEFAULT_PROFILE = PROFILES[process.env.SUITE_USAGE_PROFILE] ? process.env.SUITE_USAGE_PROFILE : 'normal';
// Fast is a persisted execution override, not a fifth usage profile. It changes
// only Codex's request lane; model, reasoning, access, and pool caps continue to
// come from the selected low/normal/extra/beast profile.
const FAST_SERVICE_TIER = 'fast';

// Seed for a fresh state.json, NOT the law. Persisted state wins at boot,
// otherwise a restart would silently revert the human's toggle with no signal.
const DEFAULT_MODEL = process.env.SUITE_AGENT_MODEL || 'sonnet';   // Sonnet routes fine; not an Opus task
// parseInt on a truthy-but-non-numeric override (for example "abc") yields
// NaN, and every NaN comparison is false. Keep separate, fail-closed ceilings
// for the two independent pools instead of one combined scalar that could
// accidentally let one pool borrow the other's capacity.
const HARD_MAX_WORKERS = 30;
const HARD_MAX_MEDIA_WORKERS = 10;
function boundedPoolCap(value, fallback, hardMax) {
  const parsed = parseInt(value == null || value === '' ? String(fallback) : String(value), 10);
  return Math.min(hardMax, Number.isFinite(parsed) && parsed > 0 ? parsed : fallback);
}
// Ceilings, not live values: the active profile can lower either one.
const MAX_WORKERS = boundedPoolCap(process.env.SUITE_MAX_WORKERS, HARD_MAX_WORKERS, HARD_MAX_WORKERS);
const MAX_MEDIA_WORKERS = boundedPoolCap(
  process.env.SUITE_MAX_MEDIA_WORKERS,
  HARD_MAX_MEDIA_WORKERS,
  HARD_MAX_MEDIA_WORKERS
); // + 1 lead = at most 41 processes
const HISTORY_LIMIT = 50;   // AgentProc.history caps here; spawn() reuses a named proc indefinitely, so an uncapped history grows for as long as that name stays alive across a session
const STDERR_LIMIT = 16 * 1024;
const STDOUT_FRAME_LIMIT = 2 * 1024 * 1024;

// Resolve the claude executable. Spawn the .exe DIRECTLY (never the npm shim,
// never shell:true: with shell:true on Windows an argv positional is silently
// eaten and you get a plausible wrong answer, not a crash).
function resolveClaudeExe() {
  const envp = process.env.SUITE_CLAUDE_EXE;
  if (envp && fs.existsSync(envp)) return envp;
  const npmPath = path.join(process.env.APPDATA || '',
    'npm/node_modules/@anthropic-ai/claude-code/node_modules/@anthropic-ai/claude-code-win32-x64/claude.exe');
  return npmPath;
}
const CLAUDE = resolveClaudeExe();

// Mirrors server.js's saveJSONAtomic (write-to-temp, then rename), not shared
// across the two files to avoid a cross-require. A plain writeFileSync here
// left a real crash window: _persistPids() is this file's half of the
// orphan-safety mechanism (see sweepStale() below), so a process death mid-
// write (OS crash, power loss, someone hard-killing node at the wrong instant)
// could leave agents.pid.json truncated or empty. sweepStale()'s JSON.parse
// already swallows that (try/catch, silent skip), but silently skipping is
// exactly the failure mode this mechanism exists to prevent: stale claude.exe
// workers from a crashed run would then never get cleaned up on next boot.
// Rename is atomic, so a reader never observes a partial file either way.
function writeJSONAtomic(file, obj) {
  try {
    const data = JSON.stringify(obj);
    const tmp = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(tmp, data);
    try { fs.renameSync(tmp, file); return true; }
    catch (_) {
      try { fs.writeFileSync(file, data); return true; }
      catch (_) { return false; }
      finally { try { fs.unlinkSync(tmp); } catch (_) {} }
    }
  } catch (_) { return false; }
}

// agent-settings.json is generated, ignored runtime state. It is the --settings
// file every restricted child gets and the ONLY thing that wires ppt-guard.js
// in as its PreToolUse hook. Never commit an absolute hook path: the project can
// move, and a stale settings file can otherwise redirect a child outside the
// current account. Resolve the guard beside this module immediately before the
// restricted spawn instead.
//
// Requiring agents.js is read-only. Test discovery, linting, and scripts that
// only need agentColor() must not rewrite a security configuration file as a
// side effect. Generate it immediately before a Claude spawn, or when a caller
// explicitly asks configure() to prepare the Claude guard during boot. The
// content comparison also avoids needless mtime churn on every real spawn.
function ensureGuardSettings(settingsFile = GUARD_SETTINGS, guardFile = path.join(HERE, 'ppt-guard.js')) {
  const resolvedGuard = path.resolve(guardFile);
  if (!fs.existsSync(resolvedGuard)) throw new Error(`Claude guard script not found: ${resolvedGuard}`);
  const guardJs = resolvedGuard.replace(/\\/g, '/');
  const desired = {
    hooks: {
      PreToolUse: [
        { matcher: '*', hooks: [{ type: 'command', command: 'node "' + guardJs.replace(/"/g, '\\"') + '"', timeout: 10 }] }
      ]
    }
  };
  const serialized = JSON.stringify(desired);
  try {
    if (fs.readFileSync(settingsFile, 'utf8') === serialized) return settingsFile;
  } catch (_) {}
  if (!writeJSONAtomic(settingsFile, desired)) {
    throw new Error(`could not write Claude guard settings: ${settingsFile}`);
  }
  return settingsFile;
}

function guardSettingsForSpawn({ fullAccess = false, settingsFile = GUARD_SETTINGS,
                                 guardFile = path.join(HERE, 'ppt-guard.js') } = {}) {
  if (fullAccess) return null;
  return ensureGuardSettings(settingsFile, guardFile);
}

function appendTail(current, chunk, limit = STDERR_LIMIT) {
  const tail = String(chunk == null ? '' : chunk).slice(-limit);
  if (tail.length >= limit) return tail;
  return (String(current || '').slice(-(limit - tail.length)) + tail).slice(-limit);
}

// ------------------------------------------------------------------ palette
// Color is a PURE FUNCTION of the agent name, so the server (editorList) and
// the /studio client agree by construction, with no shared state to drift.
// Each entry carries a CHIP (translucent fills, solid dots) and a darker INK
// (outlines, rails, text, glow rings). Verified vs WHITE (the raster the glow
// sits on): blue chip 4.42, gold chip 1.81 (FILL ONLY), gold ink 3.25,
// emerald chip 2.54 (FILL ONLY), emerald ink 5.48, violet chip 4.23, violet
// ink 7.10. Rule: INK for anything that must read as a shape or text.
const COLORS = [
  { key: 'blue',    chip: '#2A78D6', ink: '#14417F' },
  { key: 'gold',    chip: '#F1B82D', ink: '#B8860B' },
  { key: 'emerald', chip: '#10B981', ink: '#047857' },
  { key: 'violet',  chip: '#8B5CF6', ink: '#6D28D9' },
];
// A Map, not a plain object: a plain {} inherits Object.prototype's own
// properties, so PINNED['constructor'] would resolve to the real Object
// constructor function instead of undefined, silently skipping the
// undefined check below and crashing COLORS[idx] on .chip (verified: this
// really does throw for the name "constructor", case-insensitively, from
// any caller, e.g. a session literally named that). Map.get() only ever
// returns what was explicitly .set(), immune to the whole prototype-chain
// class of this bug (toString, valueOf, hasOwnProperty, __proto__, ...).
const PINNED = new Map([['lead', 0], ['worker-1', 1], ['worker-2', 2], ['worker-3', 3]]);
const NON_AGENT = new Set(['josh', 'human', 'studio', 'dashboard', '']);

function agentColor(name) {
  if (name == null) return null;
  const k = String(name).toLowerCase();
  if (NON_AGENT.has(k)) return null;                 // humans/pseudo-editors get no chip
  let idx = PINNED.get(k);
  if (idx === undefined) {
    let h = 0;
    for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0;
    idx = h % COLORS.length;
  }
  const c = COLORS[idx];
  return { color: c.chip, ink: c.ink, key: c.key };
}

// ----------------------------------------------------------------- AgentProc
// One queued claude child. INVARIANT: message N+1 is never written to stdin
// until the 'result' for N lands (_pump is the only writer).
function claudeEffortForProfile(reasoningEffort) {
  // Claude Code currently calls its highest CLI effort "max". The suite calls
  // its highest cross-provider profile "ultra", so map the tier explicitly
  // instead of passing an invalid provider-specific value.
  return reasoningEffort === 'ultra' ? 'max' : (reasoningEffort || 'medium');
}

function claudeSpawnArgs({ model, systemPrompt, fullAccess = false, reasoningEffort = 'medium',
                           guardSettings = GUARD_SETTINGS } = {}) {
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--session-id', randomUUID(),
    '--model', model || DEFAULT_MODEL,
    '--effort', claudeEffortForProfile(reasoningEffort),
  ];
  if (fullAccess) {
    // No --settings means the suite's restrictive agent-settings.json is not
    // loaded. User/project settings, configured plugins/connectors/MCP, and
    // Claude's default built-in tools still load normally. `--tools default`
    // pins Bash, filesystem edits, web, browser/visual helpers when available,
    // and Task/Agent subagents instead of inheriting the guarded Bash allowlist.
    args.push('--permission-mode', 'bypassPermissions', '--tools', 'default');
  } else {
    args.push(
      '--permission-mode', 'dontAsk',           // NEVER bypassPermissions (may skip the guard hook)
      '--settings', guardSettings,               // the freshly prepared ppt-guard sandbox
      '--allowed-tools', 'Bash',                // auto-approve Bash (dontAsk auto-denies it otherwise);
                                                  //   the guard still vets every Bash command
      '--disallowed-tools', 'Task', 'Agent', 'Write', 'Edit', 'NotebookEdit', 'PowerShell'
    );
  }
  args.push('--append-system-prompt', systemPrompt || '');
  return args;
}

class AgentProc extends EventEmitter {
  constructor({ name, role, firstMessage, livePort, model, maxWorkers, systemPrompt,
                fullAccess = false, reasoningEffort = 'medium' }) {
    super();
    this.name = name;
    this.role = role;                 // 'lead' | 'worker'
    this.provider = 'claude';
    // Resolved by the caller at construction and frozen here for this process's
    // whole life. That is the entire "next spawn only" rule: --model is a spawn
    // flag with no in-band way to change it, so a running agent keeps the model
    // it started with and write() never reconsiders.
    this.model = model || DEFAULT_MODEL;
    this.reportedModel = null;        // what the child says it is actually running (see _onEvent)
    // running cost totals for this process; they die with it, which is why
    // server.js also keeps a persisted per-session rollup
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
    this._exited = false;
    this.ctrlId = 0;
    this.msgSeq = 0;   // monotonic, independent of history length (which gets capped below)
    this._stderr = '';
    this._stdoutBuf = '';

    this.fullAccess = !!fullAccess;
    this.reasoningEffort = reasoningEffort || 'medium';
    // Resolve and write the guard before constructing argv or spawning. A
    // missing guard throws here, so a restricted child cannot start unguarded.
    const guardSettings = guardSettingsForSpawn({ fullAccess: this.fullAccess });
    const common = claudeSpawnArgs({
      model: this.model,
      fullAccess: this.fullAccess,
      reasoningEffort: this.reasoningEffort,
      guardSettings,
      systemPrompt: systemPrompt || claudeRolePrompt({
        role, name, maxWorkers, fullAccess: this.fullAccess,
      }),
    });

    this.proc = spawn(CLAUDE, common, {
      cwd: PROJECT_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      // The fallback must stay on the Claude subscription too. Reuse the same
      // scrubber as Codex so an inherited API key cannot silently change how
      // either provider is billed.
      env: Codex.subscriptionEnv({
        SUITE_EDITOR: name,
        SUITE_PORT: String(livePort),
        GUARD_LOG: GUARD_LOG_PATH,
      }),
    });
    this.pid = this.proc.pid;

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (text) => this._consumeStdout(text));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (text) => this._appendStderr(text));
    // spawn(2) failures are documented to emit 'error' and then 'close'; they
    // are not guaranteed to emit 'exit'. Treat every process/pipe error as a
    // terminal transition now so the in-flight message and its queue cannot
    // remain installed forever while waiting for an event that never comes.
    this.proc.on('error', (e) => this._failProcess('spawn-error', e));
    this.proc.stdin.on('error', (e) => this._failProcess('stdin-error', e));
    this.proc.on('exit', (code, sig) => this._onExit(code, sig));
    this.proc.on('close', (code, sig) => this._onExit(code, sig));

    if (firstMessage != null) this.enqueue(firstMessage);
  }

  _appendStderr(text) {
    this._stderr = appendTail(this._stderr, text, STDERR_LIMIT);
  }

  _consumeStdout(text) {
    if (this.dead) return;
    this._stdoutBuf += String(text);
    let i;
    while ((i = this._stdoutBuf.indexOf('\n')) >= 0) {
      const raw = this._stdoutBuf.slice(0, i);
      this._stdoutBuf = this._stdoutBuf.slice(i + 1);
      const line = raw.trim();
      if (!line) continue;
      if (line.length > STDOUT_FRAME_LIMIT) {
        this._protocolFailure(`stdout frame exceeds ${STDOUT_FRAME_LIMIT} characters`, line);
        return;
      }
      try { this._onEvent(JSON.parse(line)); }
      catch (e) {
        // Once framing is corrupt, a later valid result cannot safely be
        // matched to this.inflight versus the next queued message. Continuing
        // would risk attributing one task's answer to another. Fail the whole
        // child and every pending message through the normal exit path.
        this._protocolFailure(e.message, line);
        return;
      }
      if (this.dead) return;
    }
    // A child that emits indefinitely without a delimiter used to grow this
    // string without bound and eventually stop draining its stdout pipe.
    if (this._stdoutBuf.length > STDOUT_FRAME_LIMIT) {
      this._protocolFailure(`unterminated stdout frame exceeds ${STDOUT_FRAME_LIMIT} characters`, this._stdoutBuf);
    }
  }

  _protocolFailure(error, line) {
    const preview = String(line || '').slice(0, 200);
    this._appendStderr('\nstream-parse-error: ' + error + ' :: ' + preview);
    this.emit('stream-error', { line: preview, error: String(error) });
    this._failProcess('protocol-error');
  }

  _failProcess(reason, error) {
    if (error) this._appendStderr('\n' + String(error));
    this._onExit(null, reason);
    try { if (this.proc && !this.proc.killed) this.proc.kill(); } catch (_) {}
  }

  _onEvent(ev) {
    // The child reports the model it actually resolved. Capturing it turns
    // this.model from a value we merely asserted into one we can check: if the
    // two ever disagree, the --model flag did not take and every cost number
    // downstream is attributed to the wrong model.
    if (!this.reportedModel) {
      const rm = ev.model || (ev.message && ev.message.model)
        || (ev.system && ev.system.model) || (ev.subtype === 'init' && ev.model);
      if (rm) this.reportedModel = String(rm);
    }
    // Account-wide, not per-process: agents share the human's OAuth pool, so
    // this is the number that reflects the constraint they actually hit.
    if (ev.type === 'rate_limit_event' || ev.rate_limit_event) {
      this.emit('rate-limit', ev.rate_limit_event || ev);
    }
    if (ev.type === 'assistant') {
      for (const b of (ev.message && ev.message.content) || []) {
        if (b.type === 'tool_use') { this.currentTool = b.name; this.emit('tool', b.name); }
      }
    }
    if (ev.type === 'result') {
      const m = this.inflight;
      this.inflight = null;
      this.currentTool = null;
      if (m) {
        m.result = ev.result;
        m.ranMs = Date.now() - m.startedAt;   // wall clock, includes queue wait
        m.apiMs = ev.duration_api_ms != null ? ev.duration_api_ms : null;
        m.isError = !!ev.is_error;
        m.subtype = ev.subtype || null;       // e.g. error_during_execution on an interrupt
        m.numTurns = ev.num_turns != null ? ev.num_turns : null;

        // input_tokens is the UNCACHED REMAINDER only. Reporting it as "the
        // prompt" under-reports a cached agent by roughly 10x and points at the
        // wrong lever entirely, so keep the components and the true sum.
        const u = ev.usage || {};
        const usage = {
          input: u.input_tokens || 0,
          output: u.output_tokens || 0,
          cacheWrite: u.cache_creation_input_tokens || 0,
          cacheRead: u.cache_read_input_tokens || 0,
        };
        usage.promptTokens = usage.input + usage.cacheWrite + usage.cacheRead;
        m.usage = usage;
        m.costUsd = typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : 0;

        this.costUsd += m.costUsd;
        this.turns += 1;
        this.tokens.input += usage.input;
        this.tokens.output += usage.output;
        this.tokens.cacheRead += usage.cacheRead;
        this.tokens.cacheWrite += usage.cacheWrite;

        this.history.push(m);
        if (this.history.length > HISTORY_LIMIT) this.history.shift();
        this.emit('turn-end', m);
        // Separate from turn-end so the persisted rollup survives this process:
        // stop() deletes the proc and every counter on it with it.
        this.emit('turn-cost', {
          name: this.name, role: this.role, model: this.model,
          costUsd: m.costUsd, usage, isError: m.isError, subtype: m.subtype, ts: Date.now(),
        });
      }
      this._pump();
    }
  }

  _onExit(code, sig) {
    if (this._exited) return;
    this._exited = true;
    this.dead = true;
    const orphaned = [];
    if (this.inflight) { orphaned.push(this.inflight); this.inflight = null; }
    while (this.queue.length) orphaned.push(this.queue.shift());
    for (const m of orphaned) { m.result = null; m.failed = `child exited (code=${code} sig=${sig})`; this.emit('turn-failed', m); }
    this.emit('exit', { code, sig, orphaned, stderr: this._stderr });
  }

  enqueue(text, meta = {}) {
    if (this.dead) return null;
    const m = { id: 'm' + (++this.msgSeq),
                text: String(text), meta, enqueuedAt: Date.now() - this.t0 };
    this.queue.push(m);
    this.emit('enqueued', m, this.depth);
    this._pump();
    return m;
  }

  _pump() {
    if (this.dead || this.inflight) return;
    const m = this.queue.shift();
    if (!m) { this.emit('drained'); return; }
    this.inflight = m;
    m.startedAt = Date.now();
    m.waitedMs = (Date.now() - this.t0) - m.enqueuedAt;
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed || this.proc.stdin.writable === false) {
      this._failProcess('stdin-not-writable');
      return;
    }
    try {
      this.proc.stdin.write(JSON.stringify({
        type: 'user', message: { role: 'user', content: [{ type: 'text', text: m.text }] },
      }) + '\n', (error) => {
        if (error) this._failProcess('stdin-write-error', error);
      });
    } catch (error) {
      this._failProcess('stdin-write-error', error);
      return;
    }
    if (this.dead) return;
    this.emit('turn-start', m);
  }

  // Clean cancel of the running turn (verified: session stays usable after).
  // Does NOT kill the process, so context is preserved.
  interrupt() {
    if (this.dead || !this.inflight) return;
    try {
      this.proc.stdin.write(JSON.stringify({
        type: 'control_request', request_id: 'c' + (++this.ctrlId), request: { subtype: 'interrupt' },
      }) + '\n', (error) => {
        if (error) this._failProcess('stdin-write-error', error);
      });
    } catch (error) { this._failProcess('stdin-write-error', error); }
  }

  get status() { return this.inflight ? 'thinking' : 'idle'; }
  get depth() { return this.queue.length + (this.inflight ? 1 : 0); }

  view() {
    // No mechanism anywhere times out a stuck turn (deliberately: an LLM
    // turn on a genuinely hard task can legitimately run long, so guessing
    // a cutoff risks killing real work). What was missing was any way to
    // even SEE how long the current turn has been running, "thinking"
    // looked identical whether it started 5 seconds or 5 hours ago. This
    // makes that visible so a human can decide, rather than the system
    // silently guessing.
    const turnMs = this.inflight ? Date.now() - this.inflight.startedAt : null;
    // _onEvent already records ranMs/isError on every completed turn into
    // history, but nothing ever read it back out: the instant a turn
    // finished, ALL trace of how long it took or whether it errored went
    // invisible again, same blind spot turnMs fixed for the in-flight case,
    // just for the one that just ended.
    const last = this.history.length ? this.history[this.history.length - 1] : null;
    // Same blind spot again, one layer deeper: _onEvent also records the
    // turn's own final text (m.result = ev.result) onto history, but
    // nothing ever read THAT back out either, so even once a human notices
    // an agent went idle, there was no way to see what it actually SAID or
    // DID without digging through the board or guard log. Both prompts
    // explicitly tell agents to "keep replies to one short sentence", so
    // this is deliberately just a short, single-line preview, not a raw
    // dump: collapse whitespace/newlines and cap the length, matching this
    // codebase's own trunc() convention elsewhere (server.js) for exactly
    // this kind of one-line-preview need.
    const lastTurnSummary = last && last.result
      ? String(last.result).replace(/\s+/g, ' ').trim().slice(0, 140)
      : null;
    return { name: this.name, role: this.role, model: this.model,
             provider: 'claude', cliModel: this.model,
             // If the child resolved a different model than we asked for, the
             // spawn flag did not take. Surfaced rather than hidden so the UI
             // can say so instead of quietly mis-attributing the cost.
             reportedModel: this.reportedModel,
             modelMismatch: !!(this.reportedModel && !String(this.reportedModel).includes(this.model)),
             color: this.color ? this.color.color : null, ink: this.color ? this.color.ink : null,
             key: this.color ? this.color.key : null,
             status: this.status, depth: this.depth, pid: this.pid, startedAt: this.startedAt,
             turnMs, lastTurnMs: last ? last.ranMs : null, lastTurnError: last ? !!last.isError : null,
             lastTurnSummary,
             currentTool: this.currentTool,
             costUsd: this.costUsd, costUsdMeasured: true,
             turns: this.turns, tokens: this.tokens };
  }

  kill() {
    if (this._exited) return;
    try { if (this.proc) this.proc.kill(); } catch (error) { this._appendStderr('\n' + String(error)); }
    // Do not wait on a platform-specific close/exit promise to drain queued
    // work. _onExit is idempotent, so the child's eventual event is harmless.
    this._onExit(null, 'killed');
  }
}

// ------------------------------------------------------------------ routing
const GENERAL_POOL = 'general';
const MEDIA_POOL = 'media';
const GENERAL_WORKER_RE = /^worker-([1-9]\d*)$/;
const MEDIA_WORKER_RE = /^media-([1-9]\d*)$/;

function agentPoolForName(name) {
  const id = String(name == null ? '' : name);
  if (GENERAL_WORKER_RE.test(id)) return GENERAL_POOL;
  if (MEDIA_WORKER_RE.test(id)) return MEDIA_POOL;
  return null;
}

function isWorkerAgentName(name) {
  return agentPoolForName(name) !== null;
}

// Route only concrete media production, editing, insertion, conversion, or
// inspection work. Bare nouns are intentionally insufficient: "update the
// social media KPI copy" and "keep the current images unchanged" are ordinary
// slide tasks, while "generate a hero image" and "inspect hero.png" need the
// media lane. PowerPoint animation/transition vocabulary remains general.
const MEDIA_NOUN_SOURCE =
  '(?:media\\s+assets?|images?|photos?|photographs?|illustrations?|graphics?|icons?'
  + '|rasters?|bitmaps?|sprites?|textures?|cutouts?|stock\\s+photos?|videos?'
  + '|video\\s+clips?|footage|b-roll|motion\\s+graphics?|gifs?|pngs?|jpe?gs?'
  + '|webps?|svgs?|tiffs?)';
const MEDIA_FILE_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp|tiff?|mp4|mov|m4v|webm|avi|mkv)\b/ig;
const MEDIA_ACTION_RE = new RegExp(
  '\\b(?:add|insert|embed|replace|prepare|create|generate|make|produce|edit|retouch'
  + '|crop|mask|composite|upscale|convert|encode|transcode|trim|extract|use)\\b'
  + '(?:\\s+(?!(?:on|with|containing|that|which|while|but|only)\\b)[\\w-]+){0,8}'
  + '\\s+\\b' + MEDIA_NOUN_SOURCE + '\\b',
  'ig'
);
const MEDIA_SPECIALIST_RE =
  /\b(?:imagegen|image\s+(?:generation|editing)|video\s+(?:generation|editing|production|encoding)|remove(?:\s+the)?\s+background|background\s+removal|ffmpeg|ffprobe|h\.?264|video\s+codec|extract\s+frames?|poster\s+frame)\b/ig;
const NEGATING_PREFIX_RE = /\b(?:do\s+not|don't|never|avoid(?:ing)?|without|no|not)\b/i;
const CLAUSE_RESET_RE = /[.;,\n]|\b(?:but|instead|however|then)\b/ig;

function mediaMatchIsNegated(text, index) {
  const prefix = text.slice(Math.max(0, index - 120), index);
  let resetAt = 0;
  CLAUSE_RESET_RE.lastIndex = 0;
  let boundary;
  while ((boundary = CLAUSE_RESET_RE.exec(prefix))) resetAt = boundary.index + boundary[0].length;
  return NEGATING_PREFIX_RE.test(prefix.slice(resetAt));
}

function hasPositiveMediaMatch(text, regex) {
  regex.lastIndex = 0;
  let match;
  while ((match = regex.exec(text))) {
    if (!mediaMatchIsNegated(text, match.index)) return true;
  }
  return false;
}

function classifyTaskPool(text) {
  const normalized = String(text == null ? '' : text);
  return hasPositiveMediaMatch(normalized, MEDIA_FILE_RE)
    || hasPositiveMediaMatch(normalized, MEDIA_ACTION_RE)
    || hasPositiveMediaMatch(normalized, MEDIA_SPECIALIST_RE)
    ? MEDIA_POOL
    : GENERAL_POOL;
}

function codexRequestForProfile(method, params, settings = {}) {
  let next = params;
  const reasoningEffort = settings.reasoningEffort || 'medium';
  const serviceTier = settings.serviceTier || 'standard';
  const fastMode = !!settings.fastMode;
  const fullAccess = !!settings.fullAccess;
  if (method === 'thread/start') {
      const config = Object.assign({}, params && params.config);
      const features = Object.assign({}, config.features);
      config.model_reasoning_effort = reasoningEffort;
      if (fastMode) {
        config.service_tier = serviceTier;
        features.fast_mode = true;
      }
      if (fullAccess) {
        config.web_search = 'live';
        Object.assign(features, {
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
        });
      }
      if (config.mcp_servers && config.mcp_servers.ppt) {
        config.mcp_servers = Object.assign({}, config.mcp_servers, {
          ppt: Object.assign({}, config.mcp_servers.ppt, {
            env: Object.assign({}, config.mcp_servers.ppt.env, {
              SUITE_AGENT_MEDIA_WORKER_CAP: String(settings.maxMediaWorkers || 0),
            }),
          }),
        });
      }
      config.features = features;
      next = Object.assign({}, params, {
        config,
        serviceTier: fastMode ? serviceTier : params.serviceTier,
        approvalPolicy: fullAccess ? 'never' : params.approvalPolicy,
        sandbox: fullAccess ? 'danger-full-access' : params.sandbox,
      });
  } else if (method === 'turn/start') {
      next = Object.assign({}, params, {
        effort: reasoningEffort || params.effort || 'medium',
        serviceTier: fastMode ? serviceTier : params.serviceTier,
        approvalPolicy: fullAccess ? 'never' : params.approvalPolicy,
      });
  }
  return next;
}

// CodexAgentProc intentionally owns the transport, but its baseline defaults
// are medium/standard. Intercept only the two request boundaries so a profile
// can freeze its execution settings without duplicating that transport or
// changing its lower profiles. `initialize` passes through untouched.
class ProfiledCodexAgentProc extends Codex.CodexAgentProc {
  constructor(options = {}) {
    super(options);
    this.reasoningEffort = options.reasoningEffort || 'medium';
    this.serviceTier = options.serviceTier || 'standard';
    this.fastMode = !!options.fastMode;
    this.fullAccess = options.fullAccess !== false;
    this.maxMediaWorkers = options.maxMediaWorkers || 0;
  }

  _request(method, params, onResult, onError) {
    const next = codexRequestForProfile(method, params, this);
    return super._request(method, next, onResult, onError);
  }
}

// ------------------------------------------------------------------ manager
function agentIdentityError(name, role, maxWorkers = Infinity, maxMediaWorkers = Infinity) {
  const id = String(name == null ? '' : name);
  if (role === 'lead') {
    return id === 'lead' ? null : 'the lead role must use the name "lead"';
  }
  if (role !== 'worker') return `invalid agent role "${String(role)}"`;
  const general = GENERAL_WORKER_RE.exec(id);
  const media = MEDIA_WORKER_RE.exec(id);
  if (!general && !media) return 'worker names must use the form "worker-N" or "media-N"';
  const ordinal = Number((general || media)[1]);
  if (!Number.isSafeInteger(ordinal)) return `invalid worker identity "${id}"`;
  if (general && Number.isFinite(maxWorkers) && ordinal > maxWorkers) {
    return `worker "${id}" is outside the configured worker set (worker-1 through worker-${maxWorkers})`;
  }
  if (media && Number.isFinite(maxMediaWorkers) && (ordinal > maxMediaWorkers || maxMediaWorkers < 1)) {
    return maxMediaWorkers < 1
      ? `worker "${id}" is outside the configured media worker set (media pool is disabled)`
      : `worker "${id}" is outside the configured media worker set (media-1 through media-${maxMediaWorkers})`;
  }
  return null;
}

class AgentsManager extends EventEmitter {
  constructor() {
    super();
    this.procs = new Map();        // name -> AgentProc
    this.livePort = 4599;
    this._pausedGetter = () => false;
    // A live getter, injected the same way isPaused already is, so the profile
    // can change at runtime without agents.js requiring server.js (that would
    // be a cycle: server.js requires this module).
    this._profileGetter = () => DEFAULT_PROFILE;
    this._providerGetter = () => DEFAULT_PROVIDER;
    this._fastModeGetter = () => false;
    this.rateLimit = null;         // newest {seven_day, utilization, ...} seen from any child
    this._providerHealthCache = new Map();
  }

  configure({ livePort, isPaused, usageProfile, agentProvider, fastMode, prepareClaudeGuard, guardSettingsPath, guardScriptPath } = {}) {
    if (livePort) this.livePort = livePort;
    if (typeof isPaused === 'function') this._pausedGetter = isPaused;
    if (typeof usageProfile === 'function') this._profileGetter = usageProfile;
    if (typeof agentProvider === 'function') this._providerGetter = agentProvider;
    if (typeof fastMode === 'function') this._fastModeGetter = fastMode;
    // Optional for launchers that want guard readiness checked during their
    // explicit boot phase. Ordinary configure() calls remain read-only; every
    // actual Claude constructor independently performs the same check.
    if (prepareClaudeGuard === true) {
      ensureGuardSettings(guardSettingsPath || GUARD_SETTINGS, guardScriptPath || path.join(HERE, 'ppt-guard.js'));
    }
  }

  get paused() { return !!this._pausedGetter(); }

  get profileName() {
    const p = this._profileGetter();
    return PROFILES[p] ? p : DEFAULT_PROFILE;
  }
  get profile() { return PROFILES[this.profileName]; }

  get providerName() {
    const forced = this.profile.forcedProvider;
    if (forced && PROVIDER_MODELS[forced]) return forced;
    const p = this._providerGetter();
    return PROVIDER_MODELS[p] ? p : DEFAULT_PROVIDER;
  }

  // The profile lowers each pool independently; explicit environment ceilings
  // can lower either one without letting unused capacity leak across lanes.
  get maxWorkers() { return Math.min(this.profile.maxWorkers, MAX_WORKERS); }
  get maxMediaWorkers() {
    return Math.min(this.profile.maxMediaWorkers || 0, MAX_MEDIA_WORKERS);
  }
  get poolCaps() {
    return {
      general: this.maxWorkers,
      media: this.maxMediaWorkers,
      total: this.maxWorkers + this.maxMediaWorkers,
    };
  }
  get reasoningEffort() { return this.profile.reasoningEffort || 'medium'; }
  get fastModeRequested() { return !!this._fastModeGetter(); }
  // Claude has no matching Fast request path. Keep the saved preference visible
  // to the server/UI, but never claim or pass acceleration to a Claude child.
  get fastMode() { return this.providerName === 'codex' && this.fastModeRequested; }
  get serviceTier() { return this.fastMode ? FAST_SERVICE_TIER : (this.profile.serviceTier || 'standard'); }
  get fullAccess() { return !!this.profile.fullAccess || this.providerName === 'codex'; }

  tierFor(role) { return role === 'lead' ? this.profile.lead : this.profile.worker; }
  modelFor(role, provider) {
    const p = PROVIDER_MODELS[provider || this.providerName] || PROVIDER_MODELS[DEFAULT_PROVIDER];
    return p[this.tierFor(role)];
  }

  // Whether the requested provider can actually start right now. Reported rather
  // than thrown so the UI and CLI can explain the reason instead of a dead button.
  providerHealth(name, { refresh = false } = {}) {
    const provider = PROVIDER_MODELS[name] ? name : this.providerName;
    const cached = this._providerHealthCache.get(provider);
    const ttl = Math.max(
      1000,
      Number.parseInt(process.env.SUITE_PROVIDER_HEALTH_TTL_MS || '30000', 10) || 30000
    );
    if (!refresh && cached && Date.now() - cached.ts < ttl) return cached.value;
    let value;
    if (provider === 'codex') {
      const bin = Codex.resolveCodex();
      const login = Codex.codexLoginStatus(bin);
      value = bin && login.ok
        ? { provider, ok: true, detail: bin, auth: login.method }
        : { provider, ok: false, detail: login.detail, executable: bin || null, auth: login.method };
    } else {
      value = fs.existsSync(CLAUDE)
        ? { provider, ok: true, detail: CLAUDE }
        : { provider, ok: false, detail: 'claude executable not found. Set SUITE_CLAUDE_EXE.' };
    }
    this._providerHealthCache.set(provider, { ts: Date.now(), value });
    return value;
  }

  invalidateProviderHealth(name) {
    if (name && PROVIDER_MODELS[name]) this._providerHealthCache.delete(name);
    else this._providerHealthCache.clear();
  }

  workerCount(pool) {
    let n = 0;
    for (const p of this.procs.values()) {
      if (p.role !== 'worker') continue;
      const procPool = p.pool || agentPoolForName(p.name) || GENERAL_POOL;
      if (!pool || procPool === pool) n++;
    }
    return n;
  }

  _poolNames(pool) {
    const cap = pool === MEDIA_POOL ? this.maxMediaWorkers : this.maxWorkers;
    const prefix = pool === MEDIA_POOL ? 'media-' : 'worker-';
    return Array.from({ length: cap }, (_, i) => prefix + (i + 1));
  }

  _poolChoice(pool) {
    const names = this._poolNames(pool);
    const running = names
      .filter((name) => this.procs.has(name))
      .map((name) => {
        const proc = this.procs.get(name);
        const depth = Number.isFinite(Number(proc && proc.depth)) ? Number(proc.depth) : 1;
        return { name, proc, depth };
      })
      .sort((a, b) => a.depth - b.depth || names.indexOf(a.name) - names.indexOf(b.name));
    const idle = running.find((entry) => entry.depth === 0);
    if (idle) return { assignee: idle.name, state: 'idle' };
    const unused = names.find((name) => !this.procs.has(name));
    if (unused) return { assignee: unused, state: 'unused' };
    return running.length ? { assignee: running[0].name, state: 'busy' } : null;
  }

  // Purely deterministic for a fixed roster snapshot. The returned assignee
  // is committed to board.json before spawnOrWrite is called, so a crash,
  // pause, refusal, or restart retries the exact same route rather than
  // reclassifying and oscillating between pools.
  routeTask(text, preferredAssignee, { allowGeneralFallback = true } = {}) {
    const classifiedPool = classifyTaskPool(text);
    const preferred = String(preferredAssignee == null ? '' : preferredAssignee);
    const preferredPool = agentPoolForName(preferred);
    const preferredValid = !agentIdentityError(
      preferred,
      'worker',
      this.maxWorkers,
      this.maxMediaWorkers
    );

    if (classifiedPool === GENERAL_POOL) {
      if (preferredValid && preferredPool === MEDIA_POOL) {
        return {
          classifiedPool,
          pool: MEDIA_POOL,
          assignee: preferred,
          fallback: false,
          reason: 'explicit media assignee',
        };
      }
      const choice = preferredValid && preferredPool === GENERAL_POOL
        ? { assignee: preferred, state: this.procs.has(preferred) ? 'existing' : 'preferred' }
        : this._poolChoice(GENERAL_POOL);
      return {
        classifiedPool,
        pool: GENERAL_POOL,
        assignee: choice ? choice.assignee : '',
        fallback: false,
        reason: choice ? choice.state : 'general pool unavailable',
      };
    }

    if (preferredValid && preferredPool === MEDIA_POOL) {
      return {
        classifiedPool,
        pool: MEDIA_POOL,
        assignee: preferred,
        fallback: false,
        reason: this.procs.has(preferred) ? 'existing' : 'preferred',
      };
    }

    const mediaChoice = this._poolChoice(MEDIA_POOL);
    if (mediaChoice && mediaChoice.state !== 'busy') {
      return {
        classifiedPool,
        pool: MEDIA_POOL,
        assignee: mediaChoice.assignee,
        fallback: false,
        reason: mediaChoice.state,
      };
    }

    // General fallback is only a capacity/unavailability fallback. Pause,
    // presence, cleanup, provider, and process failures occur after the route
    // is durable and must retry this exact assignee instead of silently moving.
    if (allowGeneralFallback) {
      const generalChoice = preferredValid && preferredPool === GENERAL_POOL
        ? { assignee: preferred, state: 'preferred' }
        : this._poolChoice(GENERAL_POOL);
      if (generalChoice) {
        return {
          classifiedPool,
          pool: GENERAL_POOL,
          assignee: generalChoice.assignee,
          fallback: true,
          reason: mediaChoice ? 'media pool busy' : 'media pool unavailable',
        };
      }
    }

    return {
      classifiedPool,
      pool: MEDIA_POOL,
      assignee: mediaChoice ? mediaChoice.assignee : '',
      fallback: false,
      reason: mediaChoice ? 'media pool busy' : 'media pool unavailable',
    };
  }

  isAgent(name) {
    if (name == null) return false;
    const k = String(name);
    return this.procs.has(k);
  }

  _wire(proc) {
    const roster = () => this._persistPids() || this.emit('roster', this.agentsView());
    proc.on('turn-start', roster);
    proc.on('turn-end', roster);
    proc.on('enqueued', roster);
    proc.on('exit', () => {
      // An old child can deliver a late OS close after kill() synchronously
      // removed it and a replacement with the same name was started. Never let
      // that stale event delete the replacement.
      if (this.procs.get(proc.name) !== proc) return;
      this.procs.delete(proc.name);
      this._persistPids();
      this.emit('roster', this.agentsView());
      this.emit('agent-exit', { name: proc.name, role: proc.role });
    });
    proc.on('turn-failed', (m) => this.emit('agent-failed', { name: proc.name, message: m }));
    proc.on('stream-error', (e) => this.emit('agent-stream-error', { name: proc.name, ...e }));
    // 'tool' was already being emitted on every tool_use block and had no
    // listener, so "what is it doing right now" was computed and dropped one
    // line short of the wire. Rides the existing roster broadcast.
    proc.on('tool', roster);
    proc.on('turn-cost', (c) => this.emit('turn-cost', c));
    proc.on('rate-limit', (r) => { this.rateLimit = Object.assign({ ts: Date.now() }, r); this.emit('rate-limit', this.rateLimit); });
    // The lead's reply reached only a chip tooltip. Re-emitted so the server can
    // put it somewhere the human actually looks.
    proc.on('turn-end', (m) => this.emit('agent-reply', {
      name: proc.name, role: proc.role, text: m.result, isError: !!m.isError,
    }));
  }

  spawn(name, { role, firstMessage }) {
    const identityError = agentIdentityError(name, role);
    if (identityError) throw new Error(identityError);
    if (this.procs.has(name)) {
      const existing = this.procs.get(name);
      if (existing.role !== role) throw new Error(`agent "${name}" is already running as ${existing.role}, not ${role}`);
      return existing;
    }
    const availabilityError = agentIdentityError(
      name,
      role,
      this.maxWorkers,
      this.maxMediaWorkers
    );
    if (availabilityError) throw new Error(availabilityError);
    // Resolved ONCE, here, and frozen on the instance. This single line is the
    // whole next-spawn-only semantic: spawnOrWrite() and ensureLead() both
    // funnel through spawn(), and write() never revisits the model.
    const provider = this.providerName;
    const model = this.modelFor(role, provider);
    // Prompts describe the access contract the child ACTUALLY receives. Claude
    // has both a guarded CLI-only path and a trusted full-access path; Codex is
    // always trusted and teaches its role-gated ppt_* MCP workflow.
    const cap = this.maxWorkers;
    const mediaCap = this.maxMediaWorkers;
    const pool = role === 'worker' ? agentPoolForName(name) : 'lead';
    const systemPrompt = provider === 'codex'
      ? (role === 'lead'
        ? CODEX_LEAD_PROMPT(name, cap, mediaCap)
        : CODEX_WORKER_PROMPT(name, cap, mediaCap, pool))
      : claudeRolePrompt({
        role, name, maxWorkers: cap, maxMediaWorkers: mediaCap,
        assignedPool: pool, fullAccess: this.fullAccess,
      });
    const Ctor = provider === 'codex' ? ProfiledCodexAgentProc : AgentProc;
    // Wire lifecycle listeners before the first enqueue. Otherwise a
    // dead-on-arrival child or a synchronous stdin failure can emit its only
    // failure/exit events while the manager is still constructing it.
    const procOptions = {
      name,
      role,
      firstMessage: null,
      livePort: this.livePort,
      model,
      maxWorkers: cap,
      systemPrompt,
      reasoningEffort: this.reasoningEffort,
      serviceTier: this.serviceTier,
      fastMode: this.fastMode,
      fullAccess: this.fullAccess,
      maxMediaWorkers: mediaCap,
    };
    const proc = new Ctor(procOptions);
    proc.provider = provider;
    proc.pool = pool;
    proc.reasoningEffort = this.reasoningEffort;
    proc.serviceTier = this.serviceTier;
    proc.fastMode = this.fastMode;
    proc.fullAccess = this.fullAccess;
    this.procs.set(name, proc);
    this._wire(proc);
    this._persistPids();
    this.emit('roster', this.agentsView());
    if (firstMessage != null) proc.enqueue(firstMessage);
    return proc;
  }

  write(name, text) {
    const p = this.procs.get(name);
    if (!p || p.dead) return false;
    return p.enqueue(text) !== null;
  }

  // The whole dispatch surface. Returns {ok, reason?}.
  spawnOrWrite(name, role, text) {
    const identityError = agentIdentityError(name, role);
    if (identityError) return { ok: false, reason: identityError };
    if (this.procs.has(name)) {
      const existing = this.procs.get(name);
      if (existing.role !== role) {
        return { ok: false, reason: `agent "${name}" is already running as ${existing.role}, not ${role}` };
      }
      return this.write(name, text)
        ? { ok: true, action: 'write' }
        : { ok: false, reason: `agent "${name}" is not writable` };
    }
    const availabilityError = agentIdentityError(
      name,
      role,
      this.maxWorkers,
      this.maxMediaWorkers
    );
    if (availabilityError) return { ok: false, reason: availabilityError };
    if (this.paused) return { ok: false, reason: 'paused' };
    if (role === 'worker') {
      const pool = agentPoolForName(name);
      const cap = pool === MEDIA_POOL ? this.maxMediaWorkers : this.maxWorkers;
      if (this.workerCount(pool) >= cap) {
        return {
          ok: false,
          reason: `${pool} worker cap reached (${cap}, usage profile "${this.profileName}")`,
        };
      }
    }
    try {
      const proc = this.spawn(name, { role, firstMessage: text });
      return proc.dead
        ? { ok: false, reason: proc._stderr || `agent "${name}" failed to start` }
        : { ok: true, action: 'spawn' };
    } catch (error) {
      return { ok: false, reason: error && error.message ? error.message : 'agent spawn failed' };
    }
  }

  ensureLead(text) {
    if (this.procs.has('lead')) {
      const existing = this.procs.get('lead');
      if (existing.role !== 'lead') return { ok: false, reason: 'agent "lead" has an invalid worker identity' };
      return this.write('lead', text)
        ? { ok: true, action: 'write' }
        : { ok: false, reason: 'lead is not writable' };
    }
    if (this.paused) return { ok: false, reason: 'paused' };
    try {
      const proc = this.spawn('lead', { role: 'lead', firstMessage: text });
      return proc.dead
        ? { ok: false, reason: proc._stderr || 'lead failed to start' }
        : { ok: true, action: 'spawn' };
    } catch (error) {
      return { ok: false, reason: error && error.message ? error.message : 'lead spawn failed' };
    }
  }

  // Return whether anything was actually stopped: /api/agents/stop used to
  // report {ok:true} unconditionally regardless of whether `name` matched a
  // running agent (a typo, or dismissing one that already exited, looked
  // identical to a real dismissal), and ppt.js's dismiss command never even
  // captured the response to check. Both silently no-op'd together.
  stop(name) { const p = this.procs.get(name); if (p) { p.kill(); return true; } return false; }
  // AgentProc.interrupt() cancels a running turn WITHOUT killing the process
  // (context preserved, "verified: session stays usable after" per its own
  // comment), a genuinely different, softer lever than stop()/dismiss: built
  // and working since early in this project, but never wired to anything a
  // caller could actually reach, no CLI command, no endpoint, no dashboard
  // button. Only interruptAll() existed at the manager level, and nothing
  // ever called that either. Return whether anything was actually mid-turn,
  // same reporting convention as stop()/stopAll() above.
  interrupt(name) {
    const p = this.procs.get(name);
    if (!p || !p.inflight) return false;
    p.interrupt();
    return true;
  }
  interruptAll() {
    let did = false;
    for (const p of this.procs.values()) { if (p.inflight) { p.interrupt(); did = true; } }
    return did;
  }
  stopAll() { const had = this.procs.size > 0; for (const p of this.procs.values()) p.kill(); return had; }

  agentsView() {
    return [...this.procs.values()].map((p) => Object.assign({}, p.view(), {
      pool: p.pool || (p.role === 'worker' ? agentPoolForName(p.name) : 'lead'),
      reasoningEffort: p.reasoningEffort || 'medium',
      serviceTier: p.serviceTier || 'standard',
      fastMode: !!p.fastMode,
      fullAccess: p.fullAccess !== undefined ? !!p.fullAccess : p.provider === 'codex',
    }));
  }

  // ---- orphan safety: mirror com_host.ps1's pid-file + boot-sweep pattern.
  _persistPids() {
    const pids = [...this.procs.values()].map((p) => ({
      name: p.name,
      pool: p.pool || (p.role === 'worker' ? agentPoolForName(p.name) : 'lead'),
      pid: p.pid,
      startedAt: p.startedAt,
    }));
    writeJSONAtomic(AGENTS_PID_PATH, { pids });
    return false; // so `|| this.emit(...)` chains
  }

  // Called only after the new server has successfully bound its port. Kills
  // ONLY the pids we recorded last run (a hard server kill skips our SIGINT
  // handler and orphans the children). NEVER a blanket claude.exe kill.
  //
  // Return a promise and retain the pid file until every kill attempt finishes.
  // Restart recovery awaits this boundary before waking durable tasks, otherwise
  // a new worker can race an old orphan with the same identity and apply the
  // same assignment twice.
  sweepStale() {
    let raw;
    try { raw = fs.readFileSync(AGENTS_PID_PATH, 'utf8'); }
    catch (error) {
      if (error && error.code === 'ENOENT') return Promise.resolve([]);
      return Promise.reject(new Error(`could not read stale agent pid file: ${error && (error.code || error.message)}`));
    }
    let stale;
    try { stale = JSON.parse(raw); }
    catch (error) {
      return Promise.reject(new Error(`stale agent pid file is malformed: ${error.message}`));
    }
    if (!stale || !Array.isArray(stale.pids)) {
      return Promise.reject(new Error('stale agent pid file does not contain a pids array'));
    }
    const records = stale.pids.filter((rec) =>
      rec && Number.isSafeInteger(Number(rec.pid)) && Number(rec.pid) > 0);
    const attempts = [];
    for (const rec of records) {
      attempts.push(new Promise((resolve, reject) => {
        try {
          execFile('taskkill', ['/PID', String(rec.pid), '/F', '/T'], { timeout: 10000 }, (error) => {
            if (!error) return resolve();
            let alive = false;
            try { process.kill(Number(rec.pid), 0); alive = true; }
            catch (probeError) { alive = !!(probeError && probeError.code === 'EPERM'); }
            if (alive) return reject(new Error(`could not stop stale agent ${rec.name || ''} (pid ${rec.pid})`));
            resolve(); // taskkill commonly reports an already-exited pid; that is safe
          });
        } catch (error) { reject(error); }
      }));
    }
    return Promise.all(attempts).then(() => {
      try { fs.unlinkSync(AGENTS_PID_PATH); } catch (_) {}
      return records;
    });
  }
}

// --------------------------------------------------------------- the prompts
// House rules apply: no em dashes anywhere, min 20pt, one font, UCR blue
// (#2A78D6) + gold (#F1B82D). The ppt CLI is the ONLY tool; no undo.
const ABS_PPT = 'node ' + path.join(HERE, 'ppt.js').replace(/\\/g, '/');

function normalizedWorkerCap(maxWorkers) {
  return Number.isFinite(maxWorkers) && maxWorkers > 0
    ? Math.min(HARD_MAX_WORKERS, Math.floor(maxWorkers))
    : MAX_WORKERS;
}

function normalizedMediaWorkerCap(maxMediaWorkers) {
  return Number.isFinite(maxMediaWorkers) && maxMediaWorkers > 0
    ? Math.min(HARD_MAX_MEDIA_WORKERS, Math.floor(maxMediaWorkers))
    : 0;
}

function workerPool(maxWorkers) {
  const cap = normalizedWorkerCap(maxWorkers);
  const names = Array.from({ length: cap }, (_, i) => 'worker-' + (i + 1));
  return {
    cap,
    names,
    list: names.join(', '),
    range: cap === 1 ? 'worker-1' : `worker-1 through worker-${cap}`,
  };
}

function mediaWorkerPool(maxMediaWorkers) {
  const cap = normalizedMediaWorkerCap(maxMediaWorkers);
  const names = Array.from({ length: cap }, (_, i) => 'media-' + (i + 1));
  return {
    cap,
    names,
    list: names.join(', '),
    range: cap <= 1 ? 'media-1' : `media-1 through media-${cap}`,
  };
}

function LEAD_PROMPT(name, maxWorkers, maxMediaWorkers = 0) {
  // Interpolated, never hardcoded: the usage profile lowers the real cap to 1,
  // and a prompt that still promises 2 makes the lead confidently dispatch to a
  // worker-2 that is silently refused.
  const pool = workerPool(maxWorkers);
  const mediaPool = mediaWorkerPool(maxMediaWorkers);
  const cap = pool.cap;
  return [
    'You are the LEAD of a small team editing a live PowerPoint deck. You never edit the deck yourself.',
    'Your ONLY job is to receive a request, break it into independent per-slide subtasks, and dispatch',
    'each one to a worker with:',
    '  ' + ABS_PPT + ' task "<one concrete instruction>" --for worker-1',
    cap === 1
      ? 'You have exactly ONE worker, worker-1. Dispatch every subtask to it, one at a time. Do NOT invent worker-2, it will be refused.'
      : `You have ${cap} worker slots (${pool.range}). For up to ${cap} independent subtasks, use distinct`
        + ' idle worker names so they can run in parallel. Check `'
        + ABS_PPT + ' agents` before a large batch, fill idle names from the lowest number upward, and'
        + ' reuse an existing worker for follow-up work on the same area. If every slot is busy, queue'
        + ' remaining work to the relevant existing worker instead of inventing another identity.',
    'The available workers are exactly: ' + pool.list + '. If a request is one unit of work, dispatch ONE task.',
    mediaPool.cap
      ? `The server also has ${mediaPool.cap} dedicated media slots (${mediaPool.range}). Assign tasks through`
        + ' worker-N as usual; explicit image, photo, illustration, GIF, or video wording routes them'
        + ' deterministically to that media pool and records the actual assignee before wake.'
      : '',
    'Read the current deck ONCE at the start with `' + ABS_PPT + ' show` to learn slide and element ids;',
    'ids are stable, do not re-read every message. To find which slide already mentions something (instead',
    'of scanning the whole outline by eye), use `' + ABS_PPT + ' search "text"`, it matches titles, bullets,',
    'body text, and notes, and prints the exact slide/element id. Check `' + ABS_PPT + ' board` if you need the house rules.',
    'Make each task instruction self-contained and concrete: name the slide id, the element or decor id,',
    'and the exact change (for a color, give the hex; UCR blue is #2A78D6 and UCR gold is #F1B82D).',
    'You may run ppt commands via Bash only. You cannot edit files or spawn subagents.',
    '',
    'THE HUMAN\'S PANELS ARE STATE, NOT CHAT.',
    'The human watches one page: the deck, a chat bar, and overlay panels for house rules, tasks,',
    'standing loops and lint. Those panels are fed ONLY by ppt commands. Anything you answer in prose',
    'is gone the moment the message scrolls. If you are about to reply "noted", "I will keep an eye on',
    'that", or "I will check that each time", STOP and run the command that makes it real:',
    '  a recurring check ("every 5 minutes", "keep checking", "continuously", "each pass")',
    '      -> ' + ABS_PPT + ' loop "<the check>" --every 5m',
    '         You have no timer of your own. The loop panel is the durable record.',
    '  a standing rule, AND they clearly asked for it to stick ("pin that", "make it a rule",',
    '  "from now on, remember")',
    '      -> ' + ABS_PPT + ' pin "<the rule>"',
    '         If they did NOT clearly ask, do not pin. A pinned rule silently constrains every future',
    '         edit and is easy to set but hard to notice. When unsure, ask in one sentence instead.',
    '  "is that done?" / "drop that"  -> ' + ABS_PPT + ' tasks | done <id> | task-rm <id>',
    '  "check the rules" / "is it clean?"  -> ' + ABS_PPT + ' lint',
    '  "how long is it?"              -> ' + ABS_PPT + ' time',
    '  "who is doing what?"           -> ' + ABS_PPT + ' agents | who | locks',
    '  "what changed?"                -> ' + ABS_PPT + ' history      (read only, always safe)',
    '  "export the pdf"               -> ' + ABS_PPT + ' export-pdf',
    '',
    'YOU CANNOT UNDO. `' + ABS_PPT + ' undo` and `redo` are refused for agents by the server with',
    'HTTP 403, deliberately: the undo stack is not scoped per editor, so your undo would rewind the',
    'human\'s own work. If asked, reply exactly: "Undo is yours, press the undo button or Ctrl+Z."',
    '',
    'NEVER run: ' + ABS_PPT + ' pause | resume | dismiss | chat | profile.',
    'Pause is the human\'s hard stop, dismiss would kill your own team, chat would send a message to',
    'yourself (an endless loop, and the server refuses it), and the usage profile is the human\'s',
    'spend decision. All five are refused in code, so calling them only wastes a turn.',
    '',
    'A message tagged [loop <id>] is a scheduled recurring check, not a new request from the human.',
    'Do the check, dispatch a task only if it actually found something, then record the pass with:',
    '  ' + ABS_PPT + ' loop-ran <id> --note "<one short line on what you found>"',
    '',
    'After dispatching, reply with one short sentence naming what you handed to whom. No em dashes.',
  ].filter(Boolean).join('\n');
}

// ---- Codex prompts. Deliberately separate from the Claude ones above: Codex
// runs as a trusted full-access coding agent, but ordinary deck mutations still
// belong on the role-gated ppt_* MCP path so they keep suite validation,
// revisions, rendering, pause state, and locks.
function CODEX_LEAD_PROMPT(name, maxWorkers, maxMediaWorkers = 0) {
  const pool = workerPool(maxWorkers);
  const mediaPool = mediaWorkerPool(maxMediaWorkers);
  const cap = pool.cap;
  return [
    'You are the LEAD of a small team editing a live PowerPoint deck. You never edit the deck yourself.',
    'You are a fully enabled Codex agent with shell/filesystem access, live web search, image generation,',
    'plugins/apps, and subagents, plus any browser/computer host tools exposed in this thread. Use them for research, feasibility checks,',
    'rendered-slide inspection, and asset preparation, while dispatching actual deck edits to workers.',
    `STRICT FILE SCOPE: work only in the Presentation PDF project rooted at ${PROJECT_SCOPE}.`,
    'Never access or modify LLMBenchmarking. Scribe is read-only: it may be read but never modified.',
    'Prefer the validated ppt_* tools for supported presentation mutations because they preserve pause,',
    'history, rendering, and lint.',
    'Your job: take a request, break it into independent per-slide subtasks, and dispatch each with',
    'ppt_task (text = one concrete instruction, assignee = a worker name).',
    'Available workers: ' + pool.list + '. If a request is one unit of work, dispatch ONE task.',
    mediaPool.cap
      ? `A separate ${mediaPool.cap}-slot media pool (${mediaPool.range}) handles image and video work.`
        + ' Continue assigning through worker-N; the server classifies explicit image/photo/illustration/GIF/video'
        + ' tasks, commits the routed media assignee durably, and falls back to general only when media is busy.'
      : '',
    cap === 1
      ? 'You have exactly ONE worker. Do not invent worker-2, it will be refused.'
      : `You have ${cap} worker slots (${pool.range}). For up to ${cap} independent subtasks, use distinct`
        + ' idle worker names so they can run in parallel. Check ppt_agents before a large batch, fill'
        + ' idle names from the lowest number upward, and reuse an existing worker for follow-up work'
        + ' on the same area. If every slot is busy, queue remaining work to the relevant existing worker.',
    'Call ppt_show ONCE at the start to learn slide and element ids; they are stable, do not re-read',
    'every message. Use ppt_search to find which slide already mentions something instead of scanning.',
    'Read the binding house rules with ppt_board.',
    'Make each task self-contained and concrete: name the slide id, the element or decor id, and the',
    'exact change. For a color give the hex. UCR blue is #2A78D6 and UCR gold is #F1B82D.',
    '',
    'THE HUMAN\'S PANELS ARE STATE, NOT CHAT. Anything you only say in prose is gone when it scrolls.',
    'If you are about to reply "noted" or "I will keep checking", call the tool that makes it real:',
    '  a recurring check ("every 5 minutes", "keep checking")  -> ppt_loop (text, cadence)',
    '  a standing rule they explicitly asked to stick          -> ppt_pin',
    '     If they did not clearly ask, do NOT pin. A pinned rule silently constrains every future',
    '     edit and is easy to set but hard to notice. Ask in one sentence instead.',
    '  "is that done?" / "drop that"  -> ppt_tasks, ppt_task_done',
    '  "is it clean?"                 -> ppt_lint        "how long is it?" -> ppt_time',
    '  "who is doing what?"           -> ppt_agents, ppt_locks',
    '',
    'You cannot undo, pause, resume, or change the usage profile. Those are the human\'s, and no tool',
    'for them exists. If asked to undo, reply exactly: "Undo is yours, press the undo button or Ctrl+Z."',
    'A message tagged [loop <id>] is a scheduled check, not a new request. Do the check, dispatch a task',
    'only if it actually found something, then call ppt_loop_ran with a one line note.',
    'If a tool reports PAUSED, stop and wait. Do not retry in a loop.',
    'After dispatching, reply with one short sentence naming what you handed to whom. No em dashes.',
  ].filter(Boolean).join('\n');
}

function CODEX_WORKER_PROMPT(name, maxWorkers, maxMediaWorkers = 0, assignedPool = GENERAL_POOL) {
  const pool = workerPool(maxWorkers);
  const mediaPool = mediaWorkerPool(maxMediaWorkers);
  return [
    assignedPool === MEDIA_POOL
      ? 'You are ' + name + `, one of ${mediaPool.cap} dedicated media slots (${mediaPool.range}), editing a live PowerPoint deck.`
      : 'You are ' + name + `, one of ${pool.cap} configured worker slots in the general pool (${pool.range}), editing a live PowerPoint deck.`,
    'You are a fully enabled Codex agent with shell/filesystem access, live web search, image generation,',
    'plugins/apps, and subagents, plus any browser/computer host tools exposed in this thread. Use the real tool needed for the task: inspect',
    'rendered slide PNGs, research current facts, create local visual assets, and run code/tests as needed.',
    `STRICT FILE SCOPE: work only in the Presentation PDF project rooted at ${PROJECT_SCOPE}.`,
    'Never access or modify LLMBenchmarking. Scribe is read-only: it may be read but never modified.',
    'Prefer the validated ppt_* tools for supported presentation mutations because they preserve pause, undo, revisions,',
    'rendering, and lint. Do not raw-overwrite data/model.json or presentation.pptx. If the suite lacks a',
    'needed operation, use your coding tools to implement and test the missing suite capability, then post',
    'a concise handoff if activation requires the coordinator to restart.',
    'Every task message starts with a tag like [task tXXXXXXXX] naming that task\'s id. When you get one:',
    'A task may also be marked [recovered task retry] after a restart or delivery interruption. Inspect current state before changing anything.',
    'If the requested result is already present, verify it and mark the task done without applying it again.',
    '  1. ppt_show (and ppt_search if you need to locate the text) to get the exact slide and element ids.',
    '  2. ppt_lock the slides you will touch, with a short note, so the team sees where you are working.',
    '  3. Make the change with the matching tool, for example ppt_set_text, ppt_set_bullets,',
    '     ppt_set_style (color, size, bold, align, font), ppt_set_fill, ppt_set_corners, ppt_set_box, ppt_set_transition,',
    '     ppt_add_shape (a generated rectangle overlay), ppt_add_image (a local assets image),',
    '     ppt_add_video (an embedded assets MP4), ppt_set_animation (a real object entrance build),',
    '     and ppt_delete_shape (generated rectangles, images, or videos only).',
    '  4. Verify every requested change with ppt_show. Do not treat a successful tool call as verification.',
    '  5. ppt_unlock every slide you locked.',
    '  6. Only after all requested work was actually applied and verified, call ppt_task_done with the task id.',
    'If any requested work is blocked, unsupported, refused, or failed, call ppt_note with the blocker, release',
    'every lock you hold with ppt_unlock, and leave the task open for retry. Do NOT call ppt_task_done.',
    'Check ppt_board for the binding house rules before you write any text. They include: no em dashes',
    'anywhere, a 20pt minimum on every element, and one single font family across the deck.',
    'ppt_set_box takes fractions 0..1 of slide width and height, the same units ppt_show prints.',
    'ppt_set_corners converts only eligible imported box/card AutoShapes to true sharp corners and refuses every other object class.',
    'ppt_add_shape/ppt_add_image/ppt_add_video work on imported and suite-native slides. Generated native decor',
    'stays behind native text, and imported backing content is never replaced. ppt_add_image accepts PNG, JPEG,',
    'or GIF files inside Presentation/assets.',
    'ppt_add_video embeds an H.264 MP4 from Presentation/assets and can autoplay or loop without an external link.',
    'ppt_set_animation authors appear, fade, wipe, or rise-up entrance builds with click, with-previous,',
    'or after-previous timing. It cannot target video. The first build on a slide must start on click.',
    'ppt_delete_shape refuses imported/backed decor and removes only generated rectangles, images, or videos.',
    'ppt_set_transition supports fade (duration in seconds) and none; both are click-only and have no sound.',
    'If a tool reports PAUSED, note the blocker, unlock, leave the task open, stop, and do not retry in a loop.',
    'Do exactly the task you were given, nothing more. Reply with one short sentence. No em dashes.',
  ].join('\n');
}

function WORKER_PROMPT(name, maxWorkers, maxMediaWorkers = 0, assignedPool = GENERAL_POOL) {
  const pool = workerPool(maxWorkers);
  const mediaPool = mediaWorkerPool(maxMediaWorkers);
  return [
    assignedPool === MEDIA_POOL
      ? 'You are ' + name + `, one of ${mediaPool.cap} dedicated media slots (${mediaPool.range}), editing a live PowerPoint deck through the ppt CLI ONLY.`
      : 'You are ' + name + `, one of ${pool.cap} configured worker slots in the general pool (${pool.range}), editing a live PowerPoint deck through the ppt CLI ONLY.`,
    'Your SUITE_EDITOR is already set to ' + name + '; never change it.',
    'Every task message starts with a tag like [task tXXXXXXXX] naming that task\'s id. When you get one:',
    'A task may also be marked [recovered task retry] after a restart or delivery interruption. Inspect current state before changing anything.',
    'If the requested result is already present, verify it and mark the task done without applying it again.',
    '  1. Run ' + ABS_PPT + ' show to get the exact slide and element ids and current values.',
    '  2. Claim the slides you will touch so the team can see where you are working:',
    '     ' + ABS_PPT + ' lock <slideId> --note "<what you are doing>"',
    '  3. Make the change with the matching ppt command, for example:',
    '     ' + ABS_PPT + ' set-fill <slideId> <decorId> "#2A78D6"',
    '     ' + ABS_PPT + ' set-text <slideId> <elementId> "New text"',
    '     ' + ABS_PPT + ' set-box <slideId> <decorId> --h 0.02',
    '     ' + ABS_PPT + ' set-corners <slideId> <targetId> sharp',
    '     ' + ABS_PPT + ' add-shape <slideId> "#2A78D6" --x 0.10 --y 0.10 --w 0.80 --h 0.08',
    '     ' + ABS_PPT + ' add-image <slideId> "assets/file.png" --x 0.10 --y 0.10 --w 0.40 --h 0.40',
    '     ' + ABS_PPT + ' add-video <slideId> "assets/file.mp4" --x 0.10 --y 0.10 --w 0.40 --h 0.40 --autoplay true --loop true',
    '     ' + ABS_PPT + ' set-animation <slideId> <targetId> rise-up --trigger click --duration 0.35',
    '     ' + ABS_PPT + ' delete-decor <slideId> <decorId>   (generated rectangle/image/video only)',
    '     ' + ABS_PPT + ' set-transition <slideId> fade --duration 0.35',
    '  4. Verify every requested change by running ' + ABS_PPT + ' show again.',
    '  5. Release your claim: ' + ABS_PPT + ' unlock <slideId>',
    '  6. Only after all requested work was actually applied and verified, mark it done:',
    '     ' + ABS_PPT + ' done <taskId>',
    'If any requested work is blocked, unsupported, refused, or failed, run ' + ABS_PPT + ' note with the',
    'blocker, release every lock you hold, and leave the task open for retry. Do NOT run ppt done.',
    'add-shape/add-image/add-video work on imported slides and suite-native add-slide slides. Generated native',
    'decor is placed behind native text; imported backing content is never replaced. add-image accepts PNG, JPEG,',
    'or GIF files inside Presentation/assets. add-video embeds',
    'an H.264 MP4 from Presentation/assets with optional autoplay and looping, never an external link.',
    'set-animation authors appear, fade, wipe, or rise-up object builds with click, with-previous, or',
    'after-previous timing; it cannot target video, and the first build must start on click.',
    'set-corners converts only eligible imported box/card AutoShapes to true sharp corners and refuses all other object classes.',
    'delete-decor refuses imported/backed decor and deletes only generated rectangles, images, or videos.',
    'set-transition supports fade (duration in seconds) and none; both are click-only and have no sound.',
    'You may run ppt commands via Bash and read files. You cannot edit files directly, spawn subagents,',
    'or run undo; every change MUST go through ppt so pause, undo, lint, and rev are honored.',
    'If any ppt command prints PAUSED or returns HTTP 423, note the blocker, unlock, leave the task open,',
    'STOP, and do not retry. Baseline house rules, always true: no em dashes anywhere, minimum 20pt font, UCR',
    'blue (#2A78D6) and gold (#F1B82D) are the deck colors unless a task says otherwise. The human can pin',
    'MORE rules at any time (for example: do not add new content, keep it polish-only) and this baseline',
    'will not include them, so if a task seems to conflict with something, run `' + ABS_PPT + ' board`',
    'and check the pinned rules before acting. Keep replies to one short sentence.',
  ].join('\n');
}

// Trusted Claude keeps the suite's role and deck-safety workflow while gaining
// the complete Claude Code tool surface. Keep these as explicit prompt variants
// rather than weakening the guarded prompts used by low/normal/extra.
function CLAUDE_FULL_ACCESS_LEAD_PROMPT(name, maxWorkers, maxMediaWorkers = 0) {
  const guardedSentence = 'You may run ppt commands via Bash only. You cannot edit files or spawn subagents.';
  const trusted = [
    'You are a fully enabled Claude Code agent with shell/filesystem access, live web search, browser/visual tools,',
    'image and video asset generation through available tools/code, configured apps/plugins/connectors/MCP, and Task/Agent subagents.',
    `STRICT FILE SCOPE: work only in the Presentation PDF project rooted at ${PROJECT_SCOPE}.`,
    'Never access or modify LLMBenchmarking. Scribe is read-only: it may be read but never modified.',
    'Use those tools for design, research, rendered-slide inspection, asset preparation, and tested suite fixes.',
    'Continue routing every actual deck mutation through the validated ppt CLI so pause, history, rendering, lint, and locks are preserved.',
  ].join('\n');
  return LEAD_PROMPT(name, maxWorkers, maxMediaWorkers).replace(guardedSentence, trusted);
}

function CLAUDE_FULL_ACCESS_WORKER_PROMPT(name, maxWorkers, maxMediaWorkers = 0, assignedPool = GENERAL_POOL) {
  const guardedParagraph = [
    'You may run ppt commands via Bash and read files. You cannot edit files directly, spawn subagents,',
    'or run undo; every change MUST go through ppt so pause, undo, lint, and rev are honored.',
  ].join('\n');
  const trusted = [
    'You are a fully enabled Claude Code agent with shell/filesystem access, live web search, browser/visual tools,',
    'image and video asset generation through available tools/code, configured apps/plugins/connectors/MCP, and Task/Agent subagents.',
    `STRICT FILE SCOPE: work only in the Presentation PDF project rooted at ${PROJECT_SCOPE}.`,
    'Never access or modify LLMBenchmarking. Scribe is read-only: it may be read but never modified.',
    'Use the real tool needed for research, design, rendered-slide inspection, asset creation, and tested suite fixes.',
    'Every deck mutation MUST still go through ppt so pause, undo, lint, revisions, rendering, and locks are honored; do not raw-overwrite data/model.json or presentation.pptx.',
  ].join('\n');
  return WORKER_PROMPT(name, maxWorkers, maxMediaWorkers, assignedPool)
    .replace(/editing a live PowerPoint deck through the ppt CLI ONLY\./g,
      'editing a live PowerPoint deck with the full Claude Code tool surface.')
    .replace(guardedParagraph, trusted);
}

function claudeRolePrompt({ role, name, maxWorkers, maxMediaWorkers = 0,
                            assignedPool = GENERAL_POOL, fullAccess = false } = {}) {
  if (role === 'lead') {
    return fullAccess
      ? CLAUDE_FULL_ACCESS_LEAD_PROMPT(name, maxWorkers, maxMediaWorkers)
      : LEAD_PROMPT(name, maxWorkers, maxMediaWorkers);
  }
  return fullAccess
    ? CLAUDE_FULL_ACCESS_WORKER_PROMPT(name, maxWorkers, maxMediaWorkers, assignedPool)
    : WORKER_PROMPT(name, maxWorkers, maxMediaWorkers, assignedPool);
}

const Agents = new AgentsManager();

module.exports = { Agents, AgentsManager, AgentProc, ProfiledCodexAgentProc,
                   agentColor, agentIdentityError, agentPoolForName, isWorkerAgentName,
                   classifyTaskPool, codexRequestForProfile, claudeSpawnArgs, claudeEffortForProfile,
                   claudeRolePrompt,
                   ensureGuardSettings, guardSettingsForSpawn,
                   GENERAL_POOL, MEDIA_POOL, GENERAL_WORKER_RE, MEDIA_WORKER_RE,
                   COLORS, HARD_MAX_WORKERS, HARD_MAX_MEDIA_WORKERS,
                   MAX_WORKERS, MAX_MEDIA_WORKERS, HISTORY_LIMIT, STDERR_LIMIT, STDOUT_FRAME_LIMIT,
                   AGENTS_PID_PATH, GUARD_LOG_PATH, GUARD_SETTINGS, PROJECT_SCOPE, CLAUDE, LEAD_PROMPT, WORKER_PROMPT,
                   CLAUDE_FULL_ACCESS_LEAD_PROMPT, CLAUDE_FULL_ACCESS_WORKER_PROMPT,
                   CODEX_LEAD_PROMPT, CODEX_WORKER_PROMPT,
                   PROFILES, PROFILE_NAMES, DEFAULT_PROFILE,
                   PROVIDER_MODELS, PROVIDER_NAMES, DEFAULT_PROVIDER };
