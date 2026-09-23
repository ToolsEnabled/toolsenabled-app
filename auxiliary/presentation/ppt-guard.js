#!/usr/bin/env node
'use strict';
/*
 * ppt-guard.js — PreToolUse hook that sandboxes a spawned suite agent to the
 * ppt CLI, so a worker can only reach the deck through the gated /api/edit
 * path (pause, undo, lint, rev all honored). Loaded into a spawned child via
 * `--settings suite/agent-settings.json`.
 *
 * Verified end to end in a Phase 3 spike (17/17 guard matrix; live decoy
 * model.json stayed intact under Bash redirection, PowerShell Set-Content,
 * and a direct Write-tool attack). Two hard facts that shaped this:
 *   1. On native Windows there is no OS filesystem sandbox ("sandboxing is
 *      not available on native Windows"), so THIS hook is the only lever.
 *   2. --settings does NOT reduce the child's toolset (31 tools stay exposed
 *      even with the hook present). The hook, not the flag, is the whole
 *      enforcement, so it MUST be DEFAULT-DENY (an allowlist), never a
 *      blocklist a future new tool could slip past.
 *
 * stdin:  {tool_name, tool_input:{command}, cwd}
 * stdout: {"hookSpecificOutput":{"hookEventName":"PreToolUse",
 *          "permissionDecision":"deny"|"allow","permissionDecisionReason":"..."}}
 *
 * Only takes effect under --permission-mode dontAsk. NEVER spawn a sandboxed
 * worker with bypassPermissions / --dangerously-skip-permissions: that mode
 * may skip PreToolUse hooks entirely, silently disabling this sandbox.
 */
const fs = require('fs');
const path = require('path');

const LOG = process.env.GUARD_LOG || '';
// One line per PreToolUse decision, for the life of the server (spans many
// spawned agents over many sessions). Nothing ever capped this, so a
// long-running suite would grow guard.log without bound. Rotate in place
// once it crosses a size threshold, keeping the most recent lines: well
// above the 500-line max tail /api/guard-log and `ppt guard-log` support,
// so neither loses data it could otherwise have shown.
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_KEEP_LINES = 2000;
function log(s) {
  if (!LOG) return;
  try {
    fs.appendFileSync(LOG, s + '\n');
    const size = fs.statSync(LOG).size;
    if (size > LOG_MAX_BYTES) {
      const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(LOG, lines.slice(-LOG_KEEP_LINES).join('\n') + '\n');
    }
  } catch (_) {}
}

// The one blessed script. Defaults to the ppt.js sitting next to this guard,
// so the pair relocates together; overridable via env for tests.
const PPT_JS = process.env.PPT_JS_PATH || path.join(__dirname, 'ppt.js');
let CANON = null;
try { CANON = fs.realpathSync.native(PPT_JS).toLowerCase(); } catch (_) {}

const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'BashOutput', 'KillShell']);
const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'TodoWrite', 'ToolSearch']);
const NODE_FLAG = /^-/;

// Quote-aware lexer: splits a shell command into &&/||/;/newline segments and
// rejects the smuggling primitives (redirection, command substitution,
// unterminated quotes) outright before any segment is allowed.
function lex(cmd) {
  const segments = [];
  let seg = [];
  let tok = '';
  let quote = null;
  let had = false;

  const pushTok = () => { if (tok !== '' || had) { seg.push(tok); tok = ''; had = false; } };
  const pushSeg = () => { pushTok(); if (seg.length) segments.push(seg); seg = []; };

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    const next = cmd[i + 1];

    if (quote) {
      if (c === quote) { quote = null; had = true; continue; }
      if (quote === '"' && (c === '`' || (c === '$' && next === '('))) {
        return { bad: 'command substitution inside double quotes' };
      }
      tok += c;
      continue;
    }

    if (c === "'" || c === '"') { quote = c; had = true; continue; }

    if (c === '`' || (c === '$' && next === '(')) return { bad: 'command substitution' };
    if (c === '>' || c === '<') return { bad: 'redirection' };
    if (c === ';' || c === '\n') { pushSeg(); continue; }
    if (c === '&' || c === '|') {
      if (next === c) i++;
      pushSeg();
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { pushTok(); continue; }
    tok += c;
  }
  if (quote) return { bad: 'unterminated quote' };
  pushSeg();
  return { segments, bad: null };
}

function isBlessedPpt(toks, cwd) {
  if (!toks || toks.length < 2) return false;
  const bin = path.basename(toks[0]).toLowerCase();
  if (bin !== 'node' && bin !== 'node.exe') return false;
  if (NODE_FLAG.test(toks[1])) return false;         // reject node -e / --eval / any flag
  let real;
  try { real = fs.realpathSync.native(path.resolve(cwd || process.cwd(), toks[1])).toLowerCase(); }
  catch (_) { return false; }
  return CANON !== null && real === CANON;
}

const DENY_TAIL =
  'Agents may only read files and drive the ppt CLI:\n' +
  '  node ' + PPT_JS + ' <args>\n' +
  'Every deck mutation must go through ppt so pause/undo/lint/rev are honored. ' +
  'Never write presentation.pptx or model.json directly.';

function decide(payload) {
  const tool = String(payload.tool_name || '');
  if (READ_ONLY.has(tool)) return ['allow', ''];
  if (!SHELL_TOOLS.has(tool)) {
    // default-deny: Write, Edit, Task, Agent, Workflow, WebFetch, SendMessage,
    // and anything added in a future release all land here.
    return ['deny', 'BLOCKED by suite policy: the ' + tool + ' tool is not available to suite agents.\n' + DENY_TAIL];
  }
  if (CANON === null) return ['deny', 'Guard could not resolve the blessed ppt.js; failing closed.'];

  const cmd = String((payload.tool_input && payload.tool_input.command) || '');
  if (!cmd.trim()) return ['deny', 'Empty command.'];

  const { segments, bad } = lex(cmd);
  if (bad) return ['deny', 'BLOCKED: ' + bad + ' is not permitted.\n' + DENY_TAIL];
  if (!segments.length) return ['deny', 'Empty command.'];

  for (const toks of segments) {
    if (!isBlessedPpt(toks, payload.cwd)) {
      return ['deny',
        'BLOCKED by suite policy. Rejected segment: ' + toks.join(' ').slice(0, 120) + '\n' + DENY_TAIL];
    }
  }
  return ['allow', 'ppt CLI invocation permitted.'];
}

// Exposed for the unit matrix (a test harness requires this file, calls
// decide(), and never touches stdin).
module.exports = { decide, lex, isBlessedPpt };

// Run as an actual PreToolUse hook only when executed directly (node
// ppt-guard.js), not when required for tests.
if (require.main === module) {
  let raw = '';
  process.stdin.on('data', function (c) { raw += c; });
  process.stdin.on('end', function () {
    let decision = 'deny';
    let reason = 'Guard could not parse the PreToolUse payload; failing closed.';
    try {
      const payload = JSON.parse(raw);
      const d = decide(payload);
      decision = d[0]; reason = d[1];
      log(new Date().toISOString() + ' ' + payload.tool_name + ' -> ' + decision +
          ' :: ' + String((payload.tool_input || {}).command || '').slice(0, 100));
    } catch (e) {
      log('parse-error: ' + e.message);
    }
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason
      }
    }));
    process.exit(0);
  });
}
