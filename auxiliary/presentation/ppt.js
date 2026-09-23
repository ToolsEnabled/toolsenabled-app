#!/usr/bin/env node
'use strict';
/*
 * ppt — command-line editor client for the Presentation Suite.
 *
 * EVERY edit goes through the coordinator server, which enforces the global
 * pause. When paused, any command that mutates the deck is refused with a
 * clear message and a non-zero exit code, so multiple Claude Code instances
 * all stop the instant the dashboard Pause button is pressed.
 *
 *   node ppt.js status
 *   node ppt.js show
 *   node ppt.js title "My Deck"
 *   node ppt.js add-slide --layout content --title "Agenda"
 *   node ppt.js set-text s1 e1 "Welcome"
 *   node ppt.js set-bullets s2 e4 "First point" "Second point"
 *   node ppt.js add-element s2 body --text "A paragraph"
 *   node ppt.js notes s1 "say hello"
 *   node ppt.js pause  /  resume  /  render  /  watch  /  open
 *
 * Config: SUITE_PORT (default 4599), SUITE_HOST (127.0.0.1),
 *         SUITE_EDITOR (this editor's display name).
 */
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = parseInt(process.env.SUITE_PORT || '4599', 10);
const HOST = process.env.SUITE_HOST || '127.0.0.1';
// Every `ppt` command is a fresh process, so an unset SUITE_EDITOR used to
// fall back to a bare hostname — identical for every careless session on
// this one machine, so two sessions that both forgot to set it would
// silently collide under the same name (this is what happened to two
// independent "claude-visual-audit" sessions earlier in the board history).
// A random per-invocation suffix keeps forgetful sessions from colliding
// with each other; the stderr nudge is so they notice and fix it, since a
// fresh random name every command still can't be followed as one identity.
let EDITOR = process.env.SUITE_EDITOR;
// `ppt chat` speaks AS the human, so it has to know whether EDITOR is a real
// chosen identity or the random throwaway assigned just below: signing the
// human's words "cc-DESKTOP-a3f1" attributes them to a nameless one-shot
// process, and that name is different on the very next command.
const EDITOR_IS_THROWAWAY = !EDITOR;
if (!EDITOR) {
  EDITOR = `cc-${os.hostname()}-${crypto.randomBytes(2).toString('hex')}`;
  process.stderr.write(`(SUITE_EDITOR not set, using throwaway name "${EDITOR}" for this command only. Export SUITE_EDITOR="your-name" once so you show up consistently instead of a new random name every command.)\n`);
}

// Every spawned lead/worker in this project reads ppt's stdout through a
// Bash tool call, not an interactive terminal, so process.stdout.isTTY is
// false there exactly like any piped/redirected output (`ppt show >
// outline.txt`, `ppt lint | grep ...`). Raw ANSI codes then land verbatim in
// whatever reads that output: a human's redirected file, or an agent's own
// context. NO_COLOR (https://no-color.org) is the standard opt-out for the
// rarer case of a real TTY that still wants plain text.
const NO_ANSI = !process.stdout.isTTY || !!process.env.NO_COLOR;
// A plain object with the same 8 keys, not a Proxy: a get-trap covering
// every property access is exactly the class of "too clever" indirection
// this project has spent a lot of this session's effort finding bugs in
// (PINNED, AGENT_PINNED, lintFonts' counts), even though nothing here reads
// C dynamically today. Explicit costs 3 lines and rules that out entirely.
const C = NO_ANSI ? {
  reset: '', dim: '', bold: '', red: '', green: '', yellow: '', blue: '', cyan: '', gray: ''
} : {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m', gray: '\x1b[90m'
};

function api(method, pathname, body, defaultTimeoutMs) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: HOST, port: PORT, path: pathname, method,
        headers: { 'Content-Type': 'application/json', 'Content-Length': data ? Buffer.byteLength(data) : 0 } },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          let parsed; try { parsed = out ? JSON.parse(out) : {}; } catch (_) { parsed = { raw: out }; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    // A wedged local server must not wedge every terminal that calls it.
    // Keep this longer than the server's 30s lint helper and 60s Office
    // export timeout, while still giving callers a deterministic failure.
    // An explicit environment override is useful for tests and operators. In
    // its absence a slow command can choose a larger legal window (PDF render
    // + Office export can take about 150s), while ordinary calls retain 75s.
    const configured = process.env.SUITE_HTTP_TIMEOUT_MS;
    const timeoutMs = Math.max(
      1000,
      configured != null && configured !== ''
        ? (Number.parseInt(configured, 10) || 75000)
        : (defaultTimeoutMs || 75000)
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)));
    if (data) req.write(data);
    req.end();
  });
}

function die(msg, code) { console.error(msg); process.exit(code == null ? 1 : code); }

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireReadResult(r, action, validate, allowOkFalse = false) {
  if (!r || r.status !== 200 || !isObject(r.body) || (!allowOkFalse && r.body.ok === false)) {
    die(`${C.red}✗ ${(r && r.body && r.body.error) || `${action} failed (HTTP ${(r && r.status) || 0})`}${C.reset}`, 1);
  }
  if (validate && !validate(r.body)) {
    die(`${C.red}✗ ${action} returned a malformed response${C.reset}`, 1);
  }
  return r.body;
}

function requireControlResult(r, action, expectedPaused) {
  if (r.status === 423) {
    die(`${C.yellow}⏸  PAUSED${C.reset} — ${action} was refused.`, 3);
  }
  if (r.status !== 200 || !isObject(r.body) || r.body.ok === false) {
    die(`${C.red}✗ ${(r.body && r.body.error) || `${action} failed (HTTP ${r.status})`}${C.reset}`, 1);
  }
  if (typeof expectedPaused === 'boolean' && r.body.paused !== expectedPaused) {
    die(`${C.red}✗ ${action} returned an invalid state confirmation${C.reset}`, 1);
  }
  return r.body;
}

async function heartbeat() {
  try { await api('POST', '/api/heartbeat', { id: EDITOR, name: EDITOR }); } catch (_) {}
}

async function setStatus(status, task) {
  return api('POST', '/api/status', { id: EDITOR, name: EDITOR, status, task: task || '' });
}

async function ensureUp() {
  try { const r = await api('GET', '/api/health'); if (r.status === 200) return true; } catch (_) {}
  die(`${C.red}✗ suite server not reachable at http://${HOST}:${PORT}${C.reset}\n` +
      `  Start it with:  ${C.bold}npm start${C.reset}  (in the suite folder)  or  node suite/server.js`, 2);
}

// ---- parse "--flag value" pairs and positional args
function parseFlags(args) {
  const flags = {}; const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) { const k = args[i].slice(2); const v = (args[i + 1] && !args[i + 1].startsWith('--')) ? args[++i] : true; flags[k] = v; }
    else pos.push(args[i]);
  }
  return { flags, pos };
}

function strictInteger(value, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!/^[+-]?\d+$/.test(text)) die(`${label} must be an integer`);
  const number = Number(text);
  if (!Number.isSafeInteger(number)) die(`${label} must be a safe integer`);
  return number;
}

function strictNumber(value, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) {
    die(`${label} must be a number`);
  }
  const number = Number(text);
  if (!Number.isFinite(number)) die(`${label} must be finite`);
  return number;
}

function strictHex(value, label) {
  if (typeof value !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(value)) {
    die(`${label} must be exact #RRGGBB hex`);
  }
  return value;
}

function strictUnitNumber(value, label, positive) {
  const number = strictNumber(value, label);
  if (number < 0 || number > 1 || (positive && number === 0)) {
    die(`${label} must be ${positive ? 'greater than 0 and ' : ''}from 0 to 1`);
  }
  return number;
}

function strictBoolean(value, label) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  die(`${label} must be true or false`);
}

async function edit(op, taskId) {
  const body = { op, editor: EDITOR };
  if (taskId !== undefined) body.taskId = taskId;
  const r = await api('POST', '/api/edit', body);
  if (r.status === 423) {
    if (r.body && (r.body.error === 'protected' || r.body.protection)) {
      die(`${C.yellow}🔒 PROTECTED${C.reset} — ${r.body.message || 'this content is protected; a human must unprotect it first'}.`, 4);
    }
    die(`${C.yellow}⏸  PAUSED${C.reset} — edits are locked${r.body.pausedBy ? ` by ${r.body.pausedBy}` : ''}. ` +
        `Press Resume on the dashboard to continue.`, 3);
  }
  if (r.status !== 200 || !r.body.ok) die(`${C.red}✗ ${r.body.error || 'edit failed'}${C.reset}`, 1);
  if (r.body.warning) console.log(`${C.yellow}⚠ ${r.body.warning}${C.reset}`);
  return r.body;
}

function fmtStyle(st) {
  if (!st) return '';
  const parts = [];
  if (st.color) parts.push(`color=${st.color}`);
  if (st.fill) parts.push(`fill=${st.fill}`);
  if (st.outline) parts.push(`outline=${st.outline}`);
  if (st.size) parts.push(`size=${st.size}`);
  if (st.bold) parts.push('bold');
  if (st.align) parts.push(`align=${st.align}`);
  if (st.font) parts.push(`font=${st.font}`);
  return parts.length ? ` ${C.gray}{${parts.join(' ')}}${C.reset}` : '';
}

function fmtBox(box) {
  return box ? ` ${C.gray}(${box.x.toFixed(2)},${box.y.toFixed(2)},${box.w.toFixed(2)},${box.h.toFixed(2)})${C.reset}` : '';
}

function fmtTransition(transition) {
  if (!transition) return '';
  if (transition.effect === 'fade') {
    return ` ${C.gray}[transition=fade ${transition.duration}s]${C.reset}`;
  }
  return ` ${C.gray}[transition=none]${C.reset}`;
}

function fmtElement(e) {
  const body = e.items ? `[${e.items.map((x) => JSON.stringify(x)).join(', ')}]` : JSON.stringify(e.text || '');
  const corners = e.corners ? ` corners=${e.corners}` : (e.sourcePreset ? ` corners-eligible=${e.sourcePreset}` : '');
  return `      ${C.gray}${e.id}${C.reset} ${C.cyan}${e.type}${C.reset} ${body}${fmtStyle(e.style)}${fmtBox(e.box)}${corners}`;
}

function fmtDecor(d) {
  const colorable = d.kind === 'shape' && (d.sid != null || d.generated === true);
  const source = d.source ? `source=${JSON.stringify(d.source)} ` : '';
  const playback = d.kind === 'media'
    ? `autoplay=${d.autoplay ? 'on' : 'off'} loop=${d.loop ? 'on' : 'off'} `
    : '';
  const corners = d.corners ? ` corners=${d.corners}` : (d.sourcePreset ? ` corners-eligible=${d.sourcePreset}` : '');
  return `      ${C.gray}${d.id || '?'}${C.reset} ${C.yellow}decor:${d.kind}${C.reset} ${d.fill ? `fill=${d.fill} ` : ''}${source}${playback}${fmtBox(d.box)}${corners}${colorable ? '' : ` ${C.gray}(not colorable)${C.reset}`}`;
}

async function cmdShow() {
  const r = await api('GET', '/api/state');
  const b = requireReadResult(r, 'state', (x) => isObject(x.model) && Array.isArray(x.model.slides));
  const m = b.model;
  const locksById = new Map((b.locks || []).map((l) => [l.slideId, l]));
  const pausedTag = b.paused ? ` ${C.yellow}${C.bold}[PAUSED by ${b.pausedBy || '?'}]${C.reset}` : '';
  console.log(`\n${C.bold}${m.title}${C.reset}  ${C.gray}rev ${m.rev} · ${m.slides.length} slides${C.reset}${pausedTag}`);
  m.slides.forEach((s, i) => {
    const l = locksById.get(s.id);
    const lockTag = l ? ` ${C.yellow}🔒 ${l.by}${C.reset}` : '';
    console.log(`\n  ${C.bold}${i + 1}.${C.reset} ${C.gray}${s.id}${C.reset} ${C.blue}(${s.layout})${C.reset}${fmtTransition(s.transition)}${lockTag}`);
    s.elements.forEach((e) => console.log(fmtElement(e)));
    if (s.decor && s.decor.length) s.decor.forEach((d) => console.log(fmtDecor(d)));
    if (s.notes) console.log(`      ${C.gray}notes: ${JSON.stringify(s.notes).slice(0, 60)}${C.reset}`);
  });
  console.log('');
}

// Finding "which slide mentions X" previously meant scrolling ppt show's full
// output by eye, the same problem `ppt lint`/`ppt board` already solved for
// their own domains with a purpose-built view. Read-only, off the same
// GET /api/state cmdShow already uses, so no new server endpoint needed.
async function cmdSearch(term, flags) {
  if (!term) die('usage: search "text" [--json]');
  const r = await api('GET', '/api/state');
  const m = requireReadResult(r, 'state', (x) => isObject(x.model) && Array.isArray(x.model.slides)).model;
  const needle = term.toLowerCase();
  const hits = [];
  const check = (s, i, field, text) => {
    if (text != null && String(text).toLowerCase().includes(needle)) {
      hits.push({ slideId: s.id, index: i + 1, layout: s.layout, field, text: String(text) });
    }
  };
  m.slides.forEach((s, i) => {
    s.elements.forEach((e) => {
      if (e.text) check(s, i, `${e.id} (${e.type})`, e.text);
      if (e.items) e.items.forEach((it, idx) => check(s, i, `${e.id} (${e.type}) item ${idx + 1}`, it));
    });
    check(s, i, 'notes', s.notes);
  });
  if (flags && flags.json) { console.log(JSON.stringify(hits, null, 2)); return; }
  if (!hits.length) { console.log(`\n  ${C.gray}no matches for "${term}"${C.reset}\n`); return; }
  console.log(`\n  ${C.bold}${hits.length} match${hits.length === 1 ? '' : 'es'}${C.reset} for ${C.cyan}"${term}"${C.reset}\n`);
  let lastSlide = null;
  for (const h of hits) {
    if (h.slideId !== lastSlide) {
      console.log(`  ${C.bold}${h.index}.${C.reset} ${C.gray}${h.slideId}${C.reset} ${C.blue}(${h.layout})${C.reset}`);
      lastSlide = h.slideId;
    }
    const idx = h.text.toLowerCase().indexOf(needle);
    const before = h.text.slice(0, idx), match = h.text.slice(idx, idx + term.length), after = h.text.slice(idx + term.length);
    console.log(`      ${C.gray}${h.field}${C.reset}  ${before}${C.bold}${C.yellow}${match}${C.reset}${after}`);
  }
  console.log('');
}

async function cmdStatus() {
  const r = await api('GET', '/api/state');
  const b = requireReadResult(r, 'state', (x) =>
    isObject(x.model) && Array.isArray(x.model.slides) && Array.isArray(x.editors));
  console.log('');
  console.log(`  ${C.bold}Presentation Suite${C.reset}  ${C.gray}http://${HOST}:${PORT}${C.reset}`);
  console.log(`  state    : ${b.paused ? C.yellow + C.bold + 'PAUSED' + C.reset + C.gray + ' by ' + (b.pausedBy || '?') + C.reset : C.green + 'live' + C.reset}`);
  // server.js/agents.js only run once at boot (unlike ppt.js, a fresh process
  // per invocation), so editing either has zero effect on the live server
  // until it's restarted. This project has needed that restart dozens of
  // times and nothing ever warned a session that forgot, ppt status just
  // silently showed whatever the stale in-memory code produced. Only
  // meaningful when ppt.js runs on the same machine/filesystem as the
  // server, true for this whole project (SUITE_HOST defaults to 127.0.0.1).
  if (b.bootedAt) {
    const staleFiles = ['server.js', 'agents.js'].filter((f) => {
      try { return fs.statSync(path.join(__dirname, f)).mtimeMs > b.bootedAt; }
      catch (_) { return false; }
    });
    if (staleFiles.length) {
      console.log(`  ${C.red}${C.bold}⚠ stale${C.reset}   : ${staleFiles.join(', ')} changed on disk since this server booted, restart to pick up the fix`);
    }
  }
  console.log(`  deck     : ${b.model.title}  ${C.gray}(rev ${b.model.rev}, ${b.model.slides.length} slides)${C.reset}`);
  console.log(`  editors  : ${b.editors.length ? b.editors.map((e) => e.name).join(', ') : C.gray + 'none' + C.reset}`);
  const activeLocks = b.locks || [];
  if (activeLocks.length) {
    console.log(`  ${C.yellow}locks${C.reset}    : ${activeLocks.map((l) => `${l.slideId} ${C.gray}(${l.by})${C.reset}`).join('  ')}`);
  }
  if (b.undoCount || b.redoCount) {
    console.log(`  history  : ${C.gray}${b.undoCount || 0} undoable, ${b.redoCount || 0} redoable — ppt history / ppt undo${C.reset}`);
  }
  // Only once the team has actually run: a session that never spawned an agent
  // has nothing to report here and a permanent "$0.0000" line would just be
  // noise on the one command every session runs first.
  const sp = b.spend;
  if (sp && sp.turns > 0) {
    console.log(`  spend    : ${C.bold}${fmtUsd(sp.totalUsd)}${C.reset} ${C.gray}over ${plural(sp.turns, 'agent turn')} on profile "${(b.profile && b.profile.profile) || '?'}" (modeled, not a bill) · ppt spend${C.reset}`);
  }
  // Surface the human's pinned house rules right here — every session runs
  // `status`, so this is where they get told the standing rules (e.g. no em dashes).
  const pins = (b.board || []).filter((n) => n.pinned);
  if (pins.length) {
    console.log(`  ${C.yellow}${C.bold}rules${C.reset}    : ${C.gray}house rules from the human — follow these${C.reset}`);
    pins.forEach((n) => console.log(`             ${C.yellow}📌${C.reset} ${n.text}`));
  }
  // Standing loops: recurring checks the human set, surfaced like the house
  // rules so every session sees them and can run them on a /loop worker.
  const loops = (b.loops || []).filter((l) => l.enabled);
  if (loops.length) {
    console.log(`  ${C.green}${C.bold}loops${C.reset}    : ${C.gray}standing checks — run these on a /loop (ppt loops)${C.reset}`);
    loops.forEach((l) => console.log(`             ${C.green}🔁${C.reset} ${l.text}${l.cadence ? `${C.gray} (every ${l.cadence})${C.reset}` : ''}`));
  }
  console.log(`  ${C.gray}board    : ppt board  ·  ppt note "…"  ·  ppt loops${C.reset}`);
  console.log('');
}

async function cmdBoard(flags) {
  const r = await api('GET', '/api/board');
  const notes = requireReadResult(r, 'board', (x) => Array.isArray(x.notes)).notes;
  if (flags && flags.json) { console.log(JSON.stringify(notes, null, 2)); return; }
  const pins = notes.filter((n) => n.pinned);
  const msgs = notes.filter((n) => !n.pinned);
  console.log('');
  console.log(`  ${C.bold}Message Board${C.reset}  ${C.gray}http://${HOST}:${PORT}${C.reset}`);
  if (pins.length) {
    console.log(`\n  ${C.yellow}${C.bold}📌 HOUSE RULES${C.reset} ${C.gray}(from the human — always follow)${C.reset}`);
    pins.forEach((n) => console.log(`     ${C.yellow}•${C.reset} ${C.bold}${n.text}${C.reset}  ${C.gray}— ${n.author} · ${n.id}${C.reset}`));
  } else {
    console.log(`\n  ${C.gray}(no pinned house rules)${C.reset}`);
  }
  console.log(`\n  ${C.cyan}messages${C.reset}`);
  if (!msgs.length) console.log(`     ${C.gray}(none yet — post one with: ppt note "your message")${C.reset}`);
  msgs.slice(0, 30).forEach((n) => {
    const t = new Date(n.ts).toLocaleString();
    console.log(`     ${C.gray}${t}${C.reset}  ${C.bold}${n.author}${C.reset}  ${n.text}  ${C.gray}${n.id}${C.reset}`);
  });
  console.log('');
}

async function cmdWho(flags) {
  const r = await api('GET', '/api/state');
  const eds = requireReadResult(r, 'state', (x) => Array.isArray(x.editors)).editors;
  if (flags && flags.json) { console.log(JSON.stringify(eds, null, 2)); return; }
  console.log('');
  console.log(`  ${C.bold}Sessions${C.reset}  ${C.gray}http://${HOST}:${PORT}${C.reset}`);
  if (!eds.length) { console.log(`     ${C.gray}(none connected)${C.reset}\n`); return; }
  eds.forEach((e) => {
    const dot = e.status === 'busy' ? C.yellow : e.status === 'free' ? C.green : C.gray;
    const label = e.status === 'busy' ? `${C.yellow}busy${C.reset}` : e.status === 'free' ? `${C.green}free${C.reset}` : `${C.gray}idle${C.reset}`;
    const task = e.task ? `  ${C.gray}${e.task}${C.reset}` : '';
    console.log(`     ${dot}●${C.reset} ${C.bold}${e.name}${C.reset}  ${label}${task}`);
  });
  console.log('');
}

async function cmdTasks(flags) {
  const mine = !!(flags && flags.mine);
  const r = await api('GET', '/api/tasks');
  let tasks = requireReadResult(r, 'tasks', (x) => Array.isArray(x.tasks)).tasks;
  if (mine) tasks = tasks.filter((t) => t.assignee === EDITOR || t.claimedBy === EDITOR);
  if (flags && flags.json) { console.log(JSON.stringify(tasks, null, 2)); return; }
  const active = tasks.filter((t) => t.status !== 'done');
  const done = tasks.filter((t) => t.status === 'done');
  console.log('');
  console.log(`  ${C.bold}Tasks${C.reset}  ${C.gray}http://${HOST}:${PORT}${C.reset}`);
  if (!active.length) console.log(`     ${C.gray}(no open tasks${mine ? ' for you' : ''})${C.reset}`);
  active.forEach((t) => {
    const box = t.status === 'claimed' ? `${C.yellow}◐${C.reset}` : `${C.cyan}○${C.reset}`;
    const who = t.assignee ? `${C.cyan}→ ${t.assignee}${C.reset}` : `${C.gray}→ anyone${C.reset}`;
    const claimed = (t.status === 'claimed' && t.claimedBy) ? ` ${C.gray}(by ${t.claimedBy})${C.reset}` : '';
    console.log(`     ${box} ${t.text}  ${who}${claimed}  ${C.gray}${t.id}${C.reset}`);
  });
  if (done.length) {
    console.log(`\n     ${C.gray}recently done:${C.reset}`);
    done.slice(0, 8).forEach((t) => console.log(`     ${C.green}✓${C.reset} ${C.gray}${t.text}  ${t.id}${C.reset}`));
  }
  console.log('');
}

async function cmdLoops(flags) {
  const r = await api('GET', '/api/loops');
  let loops = requireReadResult(r, 'loops', (x) => Array.isArray(x.loops)).loops;
  if (flags && flags.on) loops = loops.filter((l) => l.enabled);
  if (flags && flags.json) { console.log(JSON.stringify(loops, null, 2)); return; }
  console.log('');
  console.log(`  ${C.bold}Standing Loops${C.reset}  ${C.gray}recurring checks — run with a /loop worker · http://${HOST}:${PORT}${C.reset}`);
  if (!loops.length) {
    console.log(`     ${C.gray}(none yet — add one with: ppt loop "continuously check …")${C.reset}\n`);
    return;
  }
  loops.forEach((l) => {
    const dot = l.enabled ? `${C.green}●${C.reset}` : `${C.gray}○${C.reset}`;
    const st = l.enabled ? `${C.green}on ${C.reset}` : `${C.gray}off${C.reset}`;
    const every = l.cadence ? ` ${C.gray}every ${l.cadence}${C.reset}` : '';
    const last = l.lastRun
      ? ` ${C.gray}· last ${new Date(l.lastRun).toLocaleTimeString()}${l.lastBy ? ' by ' + l.lastBy : ''}${C.reset}`
      : ` ${C.gray}· never run${C.reset}`;
    console.log(`     ${dot} ${st}${every}  ${l.text}  ${C.gray}${l.id}${C.reset}${last}`);
  });
  console.log('');
}

// Every OTHER subsystem (board, tasks, locks, loops) has a CLI mirror of what
// the dashboard/studio shows; the lead/worker agents subsystem never got one,
// so checking "is anything running" or stopping the team required opening a
// browser. This closes that parity gap with the two commands those other
// subsystems already established the pattern for.
const AGENT_COLOR = { blue: C.blue, gold: C.yellow, emerald: C.green, violet: C.cyan };

// Claude reports a modeled dollar figure while Codex reports tokens only. Both
// run on subscription logins, so neither number is an API invoice.
const MODELED_NOTE = 'dollar figures shown for Claude turns are modeled from token counts at API list prices, not a bill; both CLIs run on subscription logins, and Codex turns report tokens only';
function fmtUsd(n) {
  const v = typeof n === 'number' && isFinite(n) ? n : 0;
  // 4 decimals below $10: a single cheap turn is worth ~$0.004 and rounding it
  // to $0.00 would make the per-agent column look broken.
  return `$${v >= 10 ? v.toFixed(2) : v.toFixed(4)}`;
}
function fmtNum(n) { return Number(n || 0).toLocaleString('en-US'); }
function plural(n, word) { return `${n} ${word}${Number(n) === 1 ? '' : 's'}`; }

async function cmdAgents(json) {
  const r = await api('GET', '/api/agents');
  const agents = requireReadResult(r, 'agents', (x) => Array.isArray(x.agents)).agents;
  if (json) { console.log(JSON.stringify(agents, null, 2)); return; }
  // Per-agent counters die with the process, so the session rollup has to come
  // from the server's persisted total, not from summing the roster.
  const spendResponse = await api('GET', '/api/spend');
  const spend = requireReadResult(spendResponse, 'spend', (x) => isObject(x.spend)).spend;
  // The provider decides both what the next spawn runs and whether any of the
  // dollars below are a measurement at all.
  const prof = await fetchProfile();
  const noPrice = unmeasuredModels(prof || {});
  const unpricedTurns = Object.keys(spend.byModel || {})
    .filter((m) => noPrice.has(m))
    .reduce((n, m) => n + (spend.byModel[m].turns || 0), 0);
  const footer = () => {
    if (!spend.turns) return;
    const tokenTotal = (spend.tokens && spend.tokens.input || 0) + (spend.tokens && spend.tokens.output || 0);
    const total = unpricedTurns && !(spend.totalUsd > 0)
      ? `${fmtNum(tokenTotal)} tokens (no $ figure)`
      : fmtUsd(spend.totalUsd);
    const caveat = unpricedTurns && spend.totalUsd > 0
      ? `, but ${plural(unpricedTurns, 'turn')} of that ran on a CLI that reports no dollar figure and is not in this number`
      : '';
    console.log(`     ${C.gray}session total ${C.reset}${C.bold}${total}${C.reset} ${C.gray}over ${plural(spend.turns, 'turn')}, including agents already dismissed${spend.totalUsd > 0 ? ' (modeled, not a bill)' : ''}${caveat} · ppt spend${C.reset}`);
  };
  console.log('');
  const provTag = prof && prof.provider ? ` ${C.gray}· provider ${C.reset}${prof.provider}` : '';
  console.log(`  ${C.bold}Agents${C.reset}  ${C.gray}the lead + worker team · ppt dismiss to stop · http://${HOST}:${PORT}${C.reset}${provTag}`);
  if (!agents.length) {
    console.log(`     ${C.gray}(none running — type into the /studio chatbox to start the lead)${C.reset}`);
    footer();
    console.log('');
    return;
  }
  agents.forEach((a) => {
    const col = AGENT_COLOR[a.key] || C.cyan;
    // No automatic timeout kills a slow turn (a genuinely hard task can take
    // a while, guessing a cutoff risks cutting off real work), so this is
    // the only signal a human gets to notice one has been "thinking"
    // suspiciously long and decide themselves whether to ppt dismiss it.
    const forHint = a.status === 'thinking' && a.turnMs != null ? ` ${C.gray}(${fmtMMSS(Math.round(a.turnMs / 1000))})${C.reset}` : '';
    // Once a turn ends, turnMs (above) goes back to null, "idle" used to
    // look the same whether the last turn took 3 seconds or 3 hours, or
    // whether it even succeeded. lastTurnMs/lastTurnError (agents.js) were
    // already recorded in history and never read back out until now.
    const lastHint = a.status !== 'thinking' && a.lastTurnMs != null
      ? ` ${C.gray}(last turn ${fmtMMSS(Math.round(a.lastTurnMs / 1000))}${a.lastTurnError ? `, ${C.red}errored${C.gray}` : ''})${C.reset}`
      : '';
    const status = a.status === 'thinking' ? `${C.yellow}thinking${a.depth > 1 ? ` (${a.depth - 1} queued)` : ''}${C.reset}${forHint}` : `${C.gray}idle${C.reset}${lastHint}`;
    const role = a.role === 'lead' ? `${C.bold}lead${C.reset}` : 'worker';
    // a.model has always been on the wire and was never printed, so the one
    // question the usage profile exists to answer ("what is this thing running
    // on") could not be answered from the CLI at all. Cost rides along with it:
    // the model is only half the answer without what it has spent so far.
    // The provider rides alongside the model because the pair is the real
    // answer: "sonnet" and "gpt-5.6-terra" are not just different models, they
    // bill to different subscription pools and are contained differently.
    // Absent on the claude transport's view, and claude is what that means.
    const prov = a.provider || 'claude';
    // costUsdMeasured is false only on the Codex transport, which pins costUsd
    // to 0 forever. Printing that 0 as "$0.0000" beside a Claude agent's real
    // spend would say "this one is free" about the CLI actually burning the
    // human's ChatGPT quota, so unmeasured rows show their tokens instead.
    const tok = a.tokens || {};
    const money = a.costUsdMeasured === false
      ? `${fmtNum((tok.input || 0) + (tok.output || 0))} tokens (no $ figure)`
      : fmtUsd(a.costUsd);
    const cost = `${C.gray}${prov} ${a.model || '?'} · ${money} · ${plural(a.turns || 0, 'turn')} · pid ${a.pid}${C.reset}`;
    console.log(`     ${col}●${C.reset} ${col}${a.name}${C.reset}  ${role}  ${status}  ${cost}`);
    // Loud on purpose: a mismatch means the --model spawn flag did not take, so
    // this agent is running on something nobody chose and every dollar above is
    // filed under the wrong model, which quietly poisons `ppt spend --json`'s
    // byModel split (the one number used to judge whether a profile helped).
    if (a.modelMismatch) {
      console.log(`       ${C.red}${C.bold}⚠ MODEL MISMATCH${C.reset} ${C.red}spawned as "${a.model}", the child reports "${a.reportedModel}". The --model flag did not take, so this agent's cost is attributed to the wrong model. ppt dismiss ${a.name} and respawn it.${C.reset}`);
    }
    // What it actually said, not just how long it took: both prompts tell
    // agents to keep replies to one short sentence, so this is normally a
    // real one-liner, not a wall of text. A separate indented line, not
    // crammed onto the status line above, since lastTurnSummary can run up
    // to 140 chars.
    if (a.status !== 'thinking' && a.lastTurnSummary) {
      console.log(`       ${C.gray}↳ "${a.lastTurnSummary}"${C.reset}`);
    }
  });
  footer();
  console.log('');
}

// A profile names a TIER ("workhorse", "heavy"), never a model id: each
// provider maps that tier to its own model (agents.js PROVIDER_MODELS). Every
// line a human reads has to be the RESOLVED id. "workhorse" cannot be compared
// against a running agent's model, and the whole point of the provider control
// is seeing that "extra" means opus on one side and gpt-5.6-sol on the other.
// The tier itself is the fallback, so this still prints sensibly against a
// server that predates providers and already sends concrete ids.
function resolveTier(tier, map) {
  if (!tier) return '?';
  return (map && map[tier]) || tier;
}
// Lead/worker models a given profile would spawn, resolved through the current
// provider. For the SELECTED profile the server has already done this work
// (nextModels), and that answer wins: the CLI must never disagree with what the
// next spawn actually uses.
function modelsFor(b, prof) {
  const d = (b.profiles || {})[prof] || {};
  if (prof === b.profile && b.nextModels && b.nextModels.lead) {
    return { lead: b.nextModels.lead, worker: b.nextModels.worker };
  }
  const provider = d.forcedProvider || b.provider;
  const map = (b.providerModels && b.providerModels[provider]) || null;
  return { lead: resolveTier(d.lead, map), worker: resolveTier(d.worker, map) };
}

function fmtProfile(p, models) {
  const m = models || { lead: p.lead, worker: p.worker };
  const media = Number(p.maxMediaWorkers) || 0;
  const execution = `, ${p.reasoningEffort || 'medium'} reasoning, Fast controlled separately`
    + (p.fullAccess ? ', full access' : '');
  const provider = p.forcedProvider ? `, forces ${p.forcedProvider}` : '';
  return `lead ${m.lead}, worker ${m.worker}, ${plural(p.maxWorkers, 'general slot')} + ${plural(media, 'media slot')}${execution}${provider}, ${plural(p.boardNotes, 'board note')}, ~${p.pct}% spend`;
}

// Access is provider + profile dependent. Lower-profile Claude sessions keep
// the hook sandbox; a fullAccess profile launches Claude with the same trusted
// tool class as Codex. State this wherever a provider is named so the CLI never
// repeats the old provider-wide "Claude is always restricted" claim.
const FULL_PROVIDER_ACCESS = 'trusted full access: shell/filesystem, live web, browser/visual tools, image/video generation through tools/code, configured apps/plugins/connectors/MCP, and Task/Agent subagents; validated ppt tools remain preferred for deck edits';
const PROVIDER_CONTAINMENT = {
  claude: 'restricted to the ppt CLI by a PreToolUse hook: node ppt.js and nothing else',
  codex: FULL_PROVIDER_ACCESS,
};
function providerContainment(provider, fullAccess) {
  return fullAccess ? FULL_PROVIDER_ACCESS : (PROVIDER_CONTAINMENT[provider] || 'containment unknown');
}
// Claude's CLI reports a per-turn total_cost_usd. The Codex CLI reports token
// counts and NO dollar figure at all (codex-agent.js pins costUsd to 0 forever
// on a ChatGPT subscription), so rendering "$0.0000" for one of its turns next
// to a real Claude figure reads as "this was free" when it means "this was
// never priced". Every dollar this CLI prints goes through here first.
function unmeasuredModels(b) {
  const out = new Set();
  const pm = (b && b.providerModels) || {};
  Object.keys(pm).forEach((name) => {
    // Authoritative for the provider in force; for the other one, claude is the
    // only transport that prices a turn at all.
    const measured = name === b.provider ? b.costMeasured !== false : name === 'claude';
    if (!measured) Object.keys(pm[name]).forEach((tier) => out.add(pm[name][tier]));
  });
  return out;
}
// Best-effort: a server without provider support answers this with a payload
// that has no providerModels, which yields an empty set and the exact dollar
// rendering this CLI had before providers existed.
async function fetchProfile() {
  try {
    const r = await api('GET', '/api/agents/profile');
    return (r.status === 200 && r.body && r.body.ok) ? r.body : null;
  } catch (_) { return null; }
}

// The usage profile decides what the team costs, and it binds only at the NEXT
// spawn: --model is a spawn flag with no in-band override, so a running agent
// keeps whatever it launched with. A control that looks immediate but isn't is
// worse than no control, so both the read and the set path end by naming the
// divergence between what is running and what would spawn now, plus the single
// command that closes it.
async function cmdProfile(want, flags) {
  let r;
  if (want) {
    r = await api('POST', '/api/agents/profile', { profile: want, by: EDITOR });
    // Enforced server-side, not by prompt: ppt-guard whitelists the ppt.js
    // script without ever reading the subcommand, so every spawned agent can
    // reach this command the moment it exists.
    if (r.status === 403) {
      die(`${C.red}✗ ${(r.body && r.body.error) || 'not allowed'}${C.reset}\n` +
          `  The usage profile is the human's decision, not the team's. Ask for it on the board (ppt note "…") and let the human set it here or from /studio.`, 1);
    }
  } else {
    r = await api('GET', '/api/agents/profile');
  }
  if (r.status !== 200 || !r.body || !r.body.ok) die(`${C.red}✗ ${(r.body && r.body.error) || 'profile request failed'}${C.reset}`, 1);
  const b = r.body;
  if (flags && flags.json) { console.log(JSON.stringify(b, null, 2)); return; }
  const cur = b.profiles[b.profile] || {};
  // Resolved through the provider, never the raw tier: cur.lead is "workhorse",
  // and comparing that against a running agent's "sonnet" would report every
  // agent as diverging.
  const curModels = modelsFor(b, b.profile);
  const running = b.running || [];
  const wrong = running.filter((a) => a.model !== (a.role === 'lead' ? curModels.lead : curModels.worker));
  console.log('');
  if (want) {
    console.log(b.changed
      ? `  ${C.green}✓${C.reset} usage profile set to ${C.bold}${b.profile}${C.reset}`
      : `  ${C.gray}(already ${b.profile}, nothing changed)${C.reset}`);
  }
  console.log(`  ${C.bold}Usage Profile${C.reset}  ${C.gray}the team's spend control · ppt spend for what it has actually cost${C.reset}`);
  console.log(`  now      : ${C.bold}${C.cyan}${b.profile}${C.reset}  ${C.gray}${fmtProfile(cur, curModels)}${C.reset}`);
  const pools = b.poolCaps || {
    general: b.maxWorkers,
    media: cur.maxMediaWorkers || 0,
    total: (b.maxWorkers || 0) + (cur.maxMediaWorkers || 0),
  };
  const execution = b.nextExecution || {};
  const mode = execution.fastMode
    ? `${execution.reasoningEffort || 'ultra'} reasoning, Fast mode, ${execution.fullAccess ? 'full trusted access' : 'standard access'}`
    : `${execution.reasoningEffort || cur.reasoningEffort || 'medium'} reasoning, standard speed${execution.fullAccess ? ', full trusted access' : ''}`;
  console.log(`  next     : ${C.gray}lead and workers on ${C.reset}${curModels.lead === curModels.worker ? curModels.worker : `${curModels.lead}/${curModels.worker}`}${C.gray}; ${plural(pools.general, 'general slot')} + ${plural(pools.media, 'image/video slot')} (${plural(pools.total, 'worker')} total); ${mode}${C.reset}`);
  // A profile is only half an answer now: it names a tier, and the provider
  // decides which model that tier is. Same profile, different bill.
  if (b.provider) {
    console.log(`  provider : ${C.bold}${b.provider}${C.reset}  ${C.gray}the CLI those models come from, so the same profile means different models per provider · ppt provider${C.reset}`);
  }
  // Agents.maxWorkers is min(profile cap, SUITE_MAX_WORKERS), so the two can
  // disagree and the profile then looks like it did less than it claims.
  if (cur.maxWorkers != null && b.maxWorkers < cur.maxWorkers) {
    console.log(`             ${C.yellow}(SUITE_MAX_WORKERS holds the cap at ${b.maxWorkers}, below this profile's ${cur.maxWorkers})${C.reset}`);
  }
  console.log(`  choices  : ${C.gray}cheapest first${C.reset}`);
  (b.known || []).forEach((n) => {
    const on = n === b.profile;
    console.log(`     ${on ? C.green + '●' + C.reset : C.gray + '○' + C.reset} ${on ? C.bold : ''}${n.padEnd(6)}${C.reset} ${C.gray}${fmtProfile(b.profiles[n], modelsFor(b, n))}${C.reset}`);
  });
  if (!running.length) {
    console.log(`  running  : ${C.gray}(no agents running, so the next spawn already uses "${b.profile}")${C.reset}`);
  } else {
    console.log(`  running  : ${C.gray}actual models, not what the profile says${C.reset}`);
    // Padded to the longest name so the verdict column lines up: the whole
    // point of this block is scanning down it for the one row that disagrees.
    const nameW = Math.max(...running.map((a) => a.name.length));
    running.forEach((a) => {
      const should = a.role === 'lead' ? curModels.lead : curModels.worker;
      const tag = a.model === should
        ? `${C.green}matches "${b.profile}"${C.reset}`
        : `${C.yellow}⚠ "${b.profile}" would now spawn ${should}${C.reset}`;
      console.log(`     ${C.cyan}${a.name.padEnd(nameW)}${C.reset}  ${(a.role === 'lead' ? 'lead  ' : 'worker')}  ${C.bold}${a.model.padEnd(6)}${C.reset}  ${tag}`);
    });
  }
  if (wrong.length) {
    console.log('');
    console.log(`  ${C.yellow}${C.bold}⚠ not applied yet${C.reset}${C.yellow}: ${plural(wrong.length, 'running agent')} still on a different model. Changing the profile never re-models a live agent, it binds at the next spawn.${C.reset}`);
    console.log(`     ${C.gray}apply it now: ${C.reset}ppt dismiss${C.gray} (stops the team; the next /studio message respawns it on "${b.profile}"), or ${C.reset}ppt dismiss ${wrong[0].name}${C.gray} for just one${C.reset}`);
  }
  console.log(`  ${C.gray}set it   : ppt profile ${(b.known || []).join(' | ')}${C.reset}`);
  console.log('');
}

// Sibling of cmdProfile, deliberately down to the column widths: the two are
// the same kind of control (a human-only setting that binds at the NEXT spawn,
// with a divergence line and one command that closes it), so they should read
// the same. What differs is what the choice buys: the profile trades quality
// for spend, the provider trades one subscription pool for the other, and each
// provider contains its agents a different way.
async function cmdProvider(want, flags) {
  let r;
  if (want) {
    r = await api('POST', '/api/agents/provider', { provider: want, by: EDITOR });
    if (r.status === 404) {
      die(`${C.red}✗ this server has no provider support${C.reset}\n` +
          `  It booted before /api/agents/provider existed. Restart the suite server to pick it up.`, 1);
    }
    // Same rule as the usage profile: a spend and containment decision belongs
    // to the human, and the server enforces it by rejecting any `by` it knows
    // as an agent (ppt-guard whitelists ppt.js without reading the subcommand).
    if (r.status === 403) {
      die(`${C.red}✗ ${(r.body && r.body.error) || 'not allowed'}${C.reset}\n` +
          `  The provider is the human's decision, not the team's. Ask for it on the board (ppt note "…") and let the human set it here or from /studio.`, 1);
    }
    // 409 is the useful failure: the provider is real but cannot start on this
    // machine. The server refuses rather than accepting a setting whose next
    // spawn would fail minutes later, so print the reason it gave.
    if (r.status === 409) {
      const h = (r.body && r.body.health) || {};
      const err = (r.body && r.body.error) || `cannot switch to "${want}"`;
      // The server's error already quotes health.detail today. Repeat it only if
      // that ever stops being true, rather than printing the same sentence twice.
      const why = h.detail && !err.includes(h.detail) ? `\n  ${C.gray}${h.detail}${C.reset}` : '';
      die(`${C.red}✗ ${err}${C.reset}${why}\n` +
          `  ${C.gray}the provider is unchanged; ppt provider shows what is available${C.reset}`, 1);
    }
    if (r.status === 400) {
      die(`${C.red}✗ ${(r.body && r.body.error) || `unknown provider "${want}"`}${C.reset}`, 1);
    }
  } else {
    r = await api('GET', '/api/agents/profile');
  }
  if (r.status !== 200 || !r.body || !r.body.ok) die(`${C.red}✗ ${(r.body && r.body.error) || 'provider request failed'}${C.reset}`, 1);
  const b = r.body;
  if (flags && flags.json) { console.log(JSON.stringify(b, null, 2)); return; }
  // A server that predates providers answers the GET with a valid profile
  // payload that simply has no provider in it. Say that, rather than printing a
  // page of "undefined".
  if (!b.provider) {
    die(`${C.red}✗ this server has no provider support${C.reset}\n` +
        `  GET /api/agents/profile came back without a provider, so it booted before providers shipped.\n` +
        `  Restart the suite server to pick it up. ${C.gray}(ppt profile still works)${C.reset}`, 1);
  }
  const names = b.providers || [b.provider];
  const health = b.providerHealth || {};
  const next = b.nextModels || modelsFor(b, b.profile);
  const activeProfile = (b.profiles || {})[b.profile] || {};
  const running = b.running || [];
  // A running agent keeps the provider AND the model it spawned with, so both
  // halves of the divergence matter: same model on a different CLI is still a
  // different process against a different quota.
  const wrong = running.filter((a) => a.model !== (a.role === 'lead' ? next.lead : next.worker)
                                   || (a.provider && a.provider !== b.provider));
  console.log('');
  if (want) {
    console.log(b.changed
      ? `  ${C.green}✓${C.reset} agent provider set to ${C.bold}${b.provider}${C.reset}`
      : `  ${C.gray}(already ${b.provider}, nothing changed)${C.reset}`);
  }
  console.log(`  ${C.bold}Agent Provider${C.reset}  ${C.gray}which CLI backs the team, both on a subscription login, never an API key · ppt profile for how hard it spends${C.reset}`);
  console.log(`  now      : ${C.bold}${C.cyan}${b.provider}${C.reset}  ${C.gray}${providerContainment(b.provider, b.provider === 'codex' || !!activeProfile.fullAccess)}${C.reset}`);
  console.log(`  next     : ${C.gray}a new lead spawns on ${C.reset}${next.lead}${C.gray}, a new worker on ${C.reset}${next.worker}${C.gray}, on profile "${b.profile}"${C.reset}`);
  console.log(`  cost     : ${b.costMeasured
    ? `${C.gray}turns report a dollar figure (modeled from tokens, not a bill) · ppt spend${C.reset}`
    : `${C.yellow}tokens only: this CLI reports no dollar figure at all, so ppt spend cannot price these turns${C.reset}`}`);
  console.log(`  choices  : ${C.gray}what each one would run, and whether it can start here${C.reset}`);
  names.forEach((n) => {
    const on = n === b.provider;
    const h = health[n] || {};
    const m = (b.providerModels && b.providerModels[n]) || {};
    // Resolved through THAT provider, not the current one: the point of this
    // list is comparing what each would actually run under today's profile.
    const lead = resolveTier(activeProfile.lead, m), worker = resolveTier(activeProfile.worker, m);
    const mark = on ? `${C.green}●${C.reset}` : (h.ok ? `${C.gray}○${C.reset}` : `${C.red}✗${C.reset}`);
    console.log(`     ${mark} ${on ? C.bold : ''}${n.padEnd(6)}${C.reset} ${C.gray}lead ${lead}, worker ${worker}${C.reset}`);
    console.log(`       ${C.gray}${providerContainment(n, n === 'codex' || !!activeProfile.fullAccess)}${C.reset}`);
    // The resolved executable path, so "why can it not switch" is answerable
    // without going and reading agents.js.
    console.log(`       ${h.ok ? `${C.green}available${C.reset} ${C.gray}${h.detail || ''}` : `${C.red}unavailable${C.reset} ${C.gray}${h.detail || 'not resolvable on this machine'}`}${C.reset}`);
  });
  if (!running.length) {
    console.log(`  running  : ${C.gray}(no agents running, so the next spawn already uses "${b.provider}")${C.reset}`);
  } else {
    console.log(`  running  : ${C.gray}actual provider and model, not what is selected above${C.reset}`);
    const nameW = Math.max(...running.map((a) => a.name.length));
    running.forEach((a) => {
      // Absent on the claude transport's view (it predates providers being a
      // choice), and claude is what it means.
      const prov = a.provider || 'claude';
      const should = a.role === 'lead' ? next.lead : next.worker;
      const tag = (a.model === should && prov === b.provider)
        ? `${C.green}matches "${b.provider}"${C.reset}`
        : `${C.yellow}⚠ "${b.provider}" would now spawn ${should}${C.reset}`;
      console.log(`     ${C.cyan}${a.name.padEnd(nameW)}${C.reset}  ${(a.role === 'lead' ? 'lead  ' : 'worker')}  ${C.bold}${prov.padEnd(6)}${C.reset} ${a.model}  ${tag}`);
    });
  }
  if (wrong.length) {
    console.log('');
    console.log(`  ${C.yellow}${C.bold}⚠ not applied yet${C.reset}${C.yellow}: ${plural(wrong.length, 'running agent')} still on the provider and model ${wrong.length === 1 ? 'it' : 'they'} spawned with. Changing the provider never moves a live agent, it binds at the next spawn.${C.reset}`);
    console.log(`     ${C.gray}apply it now: ${C.reset}ppt dismiss${C.gray} (stops the team; the next /studio message respawns it on "${b.provider}"), or ${C.reset}ppt dismiss ${wrong[0].name}${C.gray} for just one${C.reset}`);
  }
  console.log(`  ${C.gray}set it   : ppt provider ${names.join(' | ')}${C.reset}`);
  console.log('');
}

async function cmdSpend(flags) {
  const reset = !!(flags && flags.reset);
  const r = reset ? await api('POST', '/api/spend/reset', { by: EDITOR }) : await api('GET', '/api/spend');
  if (r.status !== 200 || !r.body || !r.body.ok) die(`${C.red}✗ ${(r.body && r.body.error) || 'spend request failed'}${C.reset}`, 1);
  const s = r.body.spend || {};
  if (flags && flags.json) { console.log(JSON.stringify(s, null, 2)); return; }
  const t = s.tokens || {};
  // Which of the recorded models came from a transport that never priced a
  // turn. Fetched separately because the spend record itself stores only a
  // model id and a dollar figure, with no way to tell a measured $0 from an
  // unmeasurable one.
  const prof = await fetchProfile();
  const noPrice = unmeasuredModels(prof || {});
  const unpriced = Object.keys(s.byModel || {}).filter((m) => noPrice.has(m));
  const unpricedTurns = unpriced.reduce((n, m) => n + (s.byModel[m].turns || 0), 0);
  const tokenTotal = (t.input || 0) + (t.output || 0);
  console.log('');
  if (reset) console.log(`  ${C.green}✓${C.reset} counters zeroed, this session starts over from here`);
  console.log(`  ${C.bold}Session Spend${C.reset}  ${C.gray}since ${new Date(s.sinceTs).toLocaleString()} · ppt spend --reset to zero it${C.reset}`);
  const total = unpricedTurns && !(s.totalUsd > 0)
    ? `${fmtNum(tokenTotal)} tokens (no $ figure)`
    : `${fmtUsd(s.totalUsd)}${unpricedTurns ? ' priced total' : ''}`;
  console.log(`  total    : ${C.bold}${total}${C.reset}  ${C.gray}over ${plural(s.turns || 0, 'agent turn')}${C.reset}`);
  // Stated before any of the numbers below get read: a total that silently
  // omits a third of the session's turns is worse than no total.
  if (unpricedTurns) {
    console.log(`             ${C.yellow}${plural(unpricedTurns, 'turn')} on ${unpriced.join(', ')} carry no dollar figure (the Codex CLI reports tokens only), so they are counted in the token lines and in no dollar on this page.${C.reset}`);
  }
  console.log(`  tokens   : ${C.gray}${fmtNum(t.input)} in · ${fmtNum(t.output)} out · ${fmtNum(t.cacheRead)} cache read · ${fmtNum(t.cacheWrite)} cache write${C.reset}`);
  const roles = Object.keys(s.byRole || {});
  if (roles.length) {
    // byRole keeps no model split, so an unpriced turn is invisible here: the
    // turn count is honest and the dollars beside it are not the whole session.
    if (unpricedTurns && !(s.totalUsd > 0)) {
      console.log(`  by role  : ${C.gray}${roles.map((k) => `${k} ${plural(s.byRole[k].turns, 'turn')} (no $ figure)`).join('  ·  ')}${C.reset}`);
    } else {
      const roleCaveat = unpricedTurns ? `  ${C.gray}(dollars cover priced turns only)${C.reset}` : '';
      console.log(`  by role  : ${roles.map((k) => `${k} ${fmtUsd(s.byRole[k].usd)} ${C.gray}(${plural(s.byRole[k].turns, 'turn')})${C.reset}`).join('  ·  ')}${roleCaveat}`);
    }
  }
  // The only view that can answer "did changing the profile actually cost
  // less": the grand total moves for a dozen unrelated reasons (more turns, a
  // longer deck, a chattier human), the per-model split does not.
  const models = Object.keys(s.byModel || {}).sort((a, b) => (s.byModel[b].usd || 0) - (s.byModel[a].usd || 0));
  console.log(`\n  ${C.cyan}by model${C.reset} ${C.gray}(the split that answers whether a profile change actually changed the bill)${C.reset}`);
  if (!models.length) {
    console.log(`     ${C.gray}(nothing recorded yet: it fills in when an agent's first turn finishes)${C.reset}`);
  }
  models.forEach((m) => {
    const e = s.byModel[m];
    // A "$0.0000" here would sit in the same column as a real Claude figure and
    // read as "this model was free". It was never priced at all, so the column
    // says so instead, and the token counts (which ARE measured) carry the row.
    if (noPrice.has(m)) {
      console.log(`     ${C.bold}${m.padEnd(8)}${C.reset} ${C.yellow}no $ figure${C.reset}  ${C.gray}${plural(e.turns, 'turn')} · ${fmtNum(e.promptTokens)} prompt · ${fmtNum(e.outputTokens)} out${C.reset}`);
      return;
    }
    // "of the priced total" once part of the session was never priced: sonnet
    // at "100% of total" beside four unpriced Codex turns claims a completeness
    // the number does not have.
    const share = s.totalUsd > 0 ? ` ${C.gray}${Math.round((e.usd / s.totalUsd) * 100)}% of ${unpricedTurns ? 'the priced total' : 'total'}${C.reset}` : '';
    console.log(`     ${C.bold}${m.padEnd(8)}${C.reset} ${fmtUsd(e.usd)}${share}  ${C.gray}${plural(e.turns, 'turn')} · ${fmtNum(e.promptTokens)} prompt · ${fmtNum(e.outputTokens)} out${C.reset}`);
  });
  // Account-wide and shared with the human's own sessions, so it is the ceiling
  // the team actually hits, well before any dollar figure means anything.
  const rl = s.rateLimit;
  if (rl) {
    const win = rl.seven_day ? 'seven day' : (rl.window || 'account');
    const inner = rl.seven_day || rl.five_hour || rl;
    const raw = typeof rl.utilization === 'number' ? rl.utilization
      : (typeof inner.utilization === 'number' ? inner.utilization : null);
    if (raw == null) {
      // Unknown shape rather than none: print it verbatim instead of dropping it.
      console.log(`\n  ${C.yellow}rate limit${C.reset}: ${C.gray}${JSON.stringify(rl).slice(0, 160)}${C.reset}`);
    } else {
      const pct = Math.round(raw <= 1 ? raw * 100 : raw);
      const col = pct >= 80 ? C.red : pct >= 50 ? C.yellow : C.green;
      console.log(`\n  ${C.yellow}rate limit${C.reset}: ${col}${pct}% of the ${win} window used${C.reset} ${C.gray}(account-wide, shared with the human's own sessions)${C.reset}`);
    }
  }
  console.log(`\n  ${C.gray}${MODELED_NOTE}${C.reset}`);
  console.log('');
}

// POST /api/chat was the last capability in the suite with no CLI mirror: it
// is what the /studio chatbox calls to wake or spawn the lead, so talking to
// the team meant opening a browser. Deliberately mirrors sendChat() in
// public/studio.js step for step (board note first, then delivery) so a
// message typed here and one typed in the browser leave the identical trace.
async function cmdChat(pos, flags) {
  if (flags.tail !== undefined) {
    const n = typeof flags.tail === 'string' ? Math.max(1, parseInt(flags.tail, 10) || 20) : 20;
    const r = await api('GET', '/api/board');
    const body = requireReadResult(r, 'board', (x) => Array.isArray(x.notes));
    // Pinned notes are the human's house rules, not conversation, so they are
    // dropped here even though cmdBoard shows them. The board hands notes back
    // newest-first; a transcript reads oldest at the top, hence the reverse.
    const msgs = body.notes.filter((x) => !x.pinned).slice(0, n).reverse();
    if (flags.json) { console.log(JSON.stringify(msgs, null, 2)); return; }
    console.log('');
    console.log(`  ${C.bold}Chat${C.reset}  ${C.gray}last ${plural(msgs.length, 'message')}, oldest first · ppt chat "…" to send · ppt agents for the team${C.reset}`);
    if (!msgs.length) { console.log(`     ${C.gray}(nothing said yet)${C.reset}\n`); return; }
    msgs.forEach((m) => {
      const t = new Date(m.ts).toLocaleTimeString();
      console.log(`     ${C.gray}${t}${C.reset}  ${C.bold}${m.author}${C.reset}  ${m.text}`);
    });
    console.log('');
    return;
  }

  // parseFlags takes the next non-"--" word as a flag's value, so the perfectly
  // legal `ppt chat --quiet "hello"` parks the message on flags.quiet and
  // leaves pos empty. Recover it (the eaten word always sat right after the
  // flag, so it belongs in front of whatever spilled into pos) instead of
  // failing with a usage error on a command line that reads fine.
  const eaten = ['quiet', 'json'].filter((k) => typeof flags[k] === 'string').map((k) => flags[k]);
  const text = [...eaten, ...pos].join(' ').trim() || (typeof flags.text === 'string' ? flags.text : '');
  if (!text) die('usage: chat "message" [--as name] [--quiet]  |  chat --tail [N] [--json]');
  const author = typeof flags.as === 'string' ? flags.as : (EDITOR_IS_THROWAWAY ? 'josh' : EDITOR);

  // Step 1, as in sendChat(): post the visible board note BEFORE delivery, so
  // the message is in the log whether or not the lead turns out to be reachable.
  let note = null, boardError = null;
  if (!flags.quiet) {
    const b = await api('POST', '/api/board', { text, author, pinned: false });
    if (b.status === 200 && b.body && b.body.ok) note = b.body.note;
    else boardError = (b.body && b.body.error) || `board post failed (HTTP ${b.status})`;
  }

  // Step 2: wake or spawn the lead. `by` carries this session's real identity
  // and never the --as override: the server refuses agents on this endpoint
  // (a lead calling it would enqueue a message to itself, an unbounded token
  // burn), and that check reads exactly this field.
  const r = await api('POST', '/api/chat', { text, by: EDITOR });
  const delivered = r.status === 200 && !!(r.body && r.body.ok);
  const err = (r.body && r.body.error) || `HTTP ${r.status}`;

  if (flags.json) {
    console.log(JSON.stringify({
      ok: delivered, status: r.status, action: (r.body && r.body.action) || null,
      error: delivered ? null : err, posted: !!note, note, boardError,
      text, author, by: EDITOR,
    }, null, 2));
    process.exit(delivered ? 0 : (r.status === 423 ? 3 : 1));
  }

  if (note) console.log(`${C.green}✓${C.reset} posted to the board as ${C.bold}${author}${C.reset} ${C.gray}${note.id}${C.reset}`);
  else if (boardError) console.log(`  ${C.yellow}⚠ the board note did not post: ${boardError}${C.reset} (delivery to the lead was still attempted)`);

  if (r.status === 423) {
    // The most misread response in this whole CLI, so it gets spelled out. A
    // message to an ALREADY RUNNING lead goes through even while paused (it
    // just sits in that agent's queue). What pause refuses is SPAWNING a new
    // process. So a 423 here means "there is no lead running and I cannot
    // start one", never "your message was rejected".
    console.error(`${C.yellow}⏸  PAUSED${C.reset} no lead is running, and one cannot be started while editing is frozen.`);
    console.error(`  ${C.gray}This is not a rejected message. A message to an already running lead is delivered even while paused (it simply queues until that agent's next turn). What pause refuses is spawning a new lead, and there is none running right now.${C.reset}`);
    console.error(note
      ? `  Your message is on the board (${note.id}), so nothing is lost. Press Resume on the dashboard, then re-run this command to start the lead on it.`
      : `  Nothing was recorded, because --quiet skipped the board note. Press Resume on the dashboard, then re-run this command.`);
    process.exit(3);
  }
  if (r.status === 403) {
    console.error(`${C.red}✗ ${err}${C.reset}`);
    console.error(`  ${C.gray}You are a spawned agent ("${EDITOR}"), and the lead hands out work rather than receiving it from inside the team. Writing to the lead from here loops it back onto itself.${C.reset}`);
    console.error(`  Route it instead: ${C.bold}ppt task "what to do" --for worker-1${C.reset} to hand work to a worker, or ${C.bold}ppt note "…"${C.reset} to say something on the shared board.`);
    process.exit(1);
  }
  if (!delivered) {
    // Partial success is reported as such, not collapsed into a plain failure:
    // the board note is the durable half and it is already up, so the human
    // has not lost anything. Same shape as `ppt task`'s dispatch warning,
    // where the task still queues even when waking its assignee fails.
    if (note) { console.log(`  ${C.yellow}⚠ could not reach the lead: ${err}${C.reset} (your message is on the board, so it is not lost)`); return; }
    die(`${C.red}✗ ${err}${C.reset}`, 1);
  }
  console.log(r.body.action === 'spawn'
    ? `${C.green}✓${C.reset} started the ${C.bold}lead${C.reset} on it  ${C.gray}(follow it with ppt agents, or open /studio)${C.reset}`
    : `${C.green}✓${C.reset} delivered to the running ${C.bold}lead${C.reset}  ${C.gray}(queued behind any turn already in progress · ppt agents)${C.reset}`);
}

// The sandbox's audit trail (every allow/deny decision ppt-guard.js makes for
// a spawned worker) was wired to a file in a prior pass with no way to see it
// short of opening the file by hand; this is the CLI parity for that.
async function cmdGuardLog(tail, json) {
  const r = await api('GET', `/api/guard-log?tail=${tail || 50}`);
  const body = requireReadResult(r, 'guard log', (x) => Array.isArray(x.entries));
  const entries = body.entries;
  if (json) { console.log(JSON.stringify(entries, null, 2)); return; }
  console.log('');
  console.log(`  ${C.bold}Guard Log${C.reset}  ${C.gray}sandbox allow/deny decisions for spawned workers, most recent last${C.reset}`);
  if (!entries.length) { console.log(`     ${C.gray}(nothing logged yet — it only fills once a worker's first tool call is checked)${C.reset}\n`); return; }
  entries.forEach((e) => {
    if (e.raw) { console.log(`     ${C.gray}${e.raw}${C.reset}`); return; }
    const dc = e.decision === 'deny' ? C.red : C.green;
    console.log(`     ${C.gray}${e.ts}${C.reset}  ${e.tool.padEnd(10)}  ${dc}${e.decision}${C.reset}  ${C.gray}${e.detail}${C.reset}`);
  });
  console.log(`\n     ${C.gray}showing last ${entries.length} of ${body.total || entries.length}${C.reset}\n`);
}

function validProtectionRow(row) {
  if (!isObject(row) || !['slide', 'object'].includes(row.kind) ||
      typeof row.slideId !== 'string' || !row.slideId.trim()) return false;
  const allowed = row.kind === 'slide'
    ? new Set(['kind', 'slideId', 'by', 'createdAt'])
    : new Set(['kind', 'slideId', 'objectId', 'objectKind', 'by', 'createdAt']);
  if (Object.keys(row).some((key) => !allowed.has(key))) return false;
  if (row.by !== undefined &&
      (typeof row.by !== 'string' || !row.by.trim() || row.by.length > 60)) return false;
  if (row.createdAt !== undefined &&
      (!Number.isSafeInteger(row.createdAt) || row.createdAt < 0)) return false;
  if (row.kind === 'slide') return row.objectId === undefined && row.objectKind === undefined;
  return typeof row.objectId === 'string' && !!row.objectId.trim() &&
    ['element', 'decor'].includes(row.objectKind);
}

function protectionRowKey(row) {
  return row.kind === 'slide'
    ? `slide:${row.slideId}`
    : `object:${row.slideId}:${row.objectKind}:${row.objectId}`;
}

function validProtectionRows(rows) {
  if (!Array.isArray(rows) || !rows.every(validProtectionRow)) return false;
  return new Set(rows.map(protectionRowKey)).size === rows.length;
}

function validProtectionHistoryRow(row) {
  if (!isObject(row) || !['lock', 'unlock'].includes(row.action) ||
      !['slide', 'object'].includes(row.kind) ||
      typeof row.slideId !== 'string' || !row.slideId.trim() ||
      typeof row.by !== 'string' || !row.by.trim() || row.by.length > 60 ||
      !Number.isSafeInteger(row.ts) || row.ts < 0) return false;
  const allowed = row.kind === 'slide'
    ? new Set(['action', 'kind', 'slideId', 'by', 'ts', 'taskId', 'authorizedBy', 'authorizedAt'])
    : new Set([
        'action', 'kind', 'slideId', 'objectId', 'objectKind', 'by', 'ts',
        'taskId', 'authorizedBy', 'authorizedAt'
      ]);
  if (Object.keys(row).some((key) => !allowed.has(key))) return false;
  const delegated = ['taskId', 'authorizedBy', 'authorizedAt']
    .filter((field) => row[field] !== undefined).length;
  if (delegated !== 0 && delegated !== 3) return false;
  if (delegated &&
      (typeof row.taskId !== 'string' || !row.taskId.trim() || row.taskId.length > 120 ||
       typeof row.authorizedBy !== 'string' || !row.authorizedBy.trim() || row.authorizedBy.length > 60 ||
       !Number.isSafeInteger(row.authorizedAt) || row.authorizedAt < 0 || row.authorizedAt > row.ts)) {
    return false;
  }
  if (row.kind === 'slide') return row.objectId === undefined && row.objectKind === undefined;
  return typeof row.objectId === 'string' && !!row.objectId.trim() &&
    ['element', 'decor'].includes(row.objectKind);
}

function validProtectionHistoryRows(rows) {
  return Array.isArray(rows) && rows.length <= 200 &&
    rows.every(validProtectionHistoryRow);
}

function sameProtectionTarget(a, b) {
  if (!isObject(a) || !isObject(b) || !['slide', 'object'].includes(a.kind) ||
      a.kind !== b.kind || typeof a.slideId !== 'string' || !a.slideId.trim() ||
      a.slideId !== b.slideId) return false;
  if (a.kind === 'slide') return true;
  return typeof a.objectId === 'string' && !!a.objectId.trim() &&
    a.objectId === b.objectId && ['element', 'decor'].includes(a.objectKind) &&
    a.objectKind === b.objectKind;
}

function sameProtectionHistoryRow(a, b) {
  return validProtectionHistoryRow(a) && validProtectionHistoryRow(b) &&
    a.action === b.action && a.kind === b.kind && a.slideId === b.slideId &&
    a.objectId === b.objectId && a.objectKind === b.objectKind &&
    a.by === b.by && a.ts === b.ts && a.taskId === b.taskId &&
    a.authorizedBy === b.authorizedBy && a.authorizedAt === b.authorizedAt;
}

function validProtectionToggleResult(body, requested) {
  if (!isObject(body) || body.ok !== true || typeof body.changed !== 'boolean' ||
      body.protected !== requested.protected || !validProtectionRow(body.protection) ||
      !sameProtectionTarget(body.protection, requested) ||
      !validProtectionRows(body.protections) ||
      !validProtectionHistoryRows(body.protectionHistory)) return false;
  if (!body.changed) return body.change === undefined;
  if (!validProtectionHistoryRow(body.change) ||
      body.change.action !== (requested.protected ? 'lock' : 'unlock') ||
      body.change.by !== requested.by ||
      !sameProtectionTarget(body.change, requested)) return false;
  const last = body.protectionHistory[body.protectionHistory.length - 1];
  return !!last && sameProtectionHistoryRow(last, body.change);
}

async function cmdProtections(flags) {
  const r = await api('GET', '/api/protections');
  const includeHistory = !!(flags && flags.history);
  const body = requireReadResult(
    r,
    'protections',
    (result) => validProtectionRows(result.protections) &&
      (result.protectionHistory === undefined ||
        validProtectionHistoryRows(result.protectionHistory)) &&
      (!includeHistory || Array.isArray(result.protectionHistory))
  );
  if (includeHistory) {
    const history = body.protectionHistory;
    if (flags.json) {
      console.log(JSON.stringify(history, null, 2));
      return;
    }
    console.log('');
    console.log(`  ${C.bold}Protection History${C.reset}  ${C.gray}durable human lock/unlock decisions, most recent last${C.reset}`);
    if (!history.length) {
      console.log(`     ${C.gray}(no decisions recorded — absence is not an approval)${C.reset}\n`);
      return;
    }
    history.forEach((entry) => {
      const target = entry.kind === 'slide'
        ? `${C.bold}${entry.slideId}${C.reset} ${C.gray}(whole slide)${C.reset}`
        : `${C.bold}${entry.slideId}${C.reset} ${C.cyan}${entry.objectId}${C.reset} ${C.gray}(${entry.objectKind})${C.reset}`;
      const action = entry.action === 'lock'
        ? `${C.yellow}LOCK${C.reset}`
        : `${C.red}UNLOCK${C.reset}`;
      const delegated = entry.taskId
        ? ` via ${entry.authorizedBy}, task ${entry.taskId}`
        : '';
      console.log(`     ${action}  ${target}  ${C.gray}by ${entry.by}${delegated} · ${new Date(entry.ts).toLocaleString()}${C.reset}`);
    });
    console.log('');
    return;
  }
  const protections = body.protections;
  if (flags && flags.json) {
    console.log(JSON.stringify(protections, null, 2));
    return;
  }
  console.log('');
  console.log(`  ${C.bold}Content Protections${C.reset}  ${C.gray}durable hard locks · humans must unprotect before editing${C.reset}`);
  if (!protections.length) {
    console.log(`     ${C.gray}(none — protect a slide with: ppt protect s4)${C.reset}\n`);
    return;
  }
  protections.forEach((protection) => {
    const target = protection.kind === 'slide'
      ? `${C.bold}${protection.slideId}${C.reset} ${C.gray}(whole slide)${C.reset}`
      : `${C.bold}${protection.slideId}${C.reset} ${C.cyan}${protection.objectId}${C.reset} ${C.gray}(${protection.objectKind})${C.reset}`;
    const owner = protection.by ? `  ${C.gray}by ${protection.by}${C.reset}` : '';
    const when = Number.isSafeInteger(protection.createdAt)
      ? `  ${C.gray}${new Date(protection.createdAt).toLocaleString()}${C.reset}`
      : '';
    console.log(`     ${C.yellow}🔒${C.reset} ${target}${owner}${when}`);
  });
  console.log('');
}

async function protectionObjectKind(slideId, objectId, requestedKind) {
  if (requestedKind !== undefined) {
    if (!['element', 'decor'].includes(requestedKind)) {
      die('--kind must be element or decor');
    }
    return requestedKind;
  }
  const r = await api('GET', '/api/state');
  const model = requireReadResult(
    r,
    'state',
    (body) => isObject(body.model) && Array.isArray(body.model.slides)
  ).model;
  const slide = model.slides.find((item) => item.id === slideId);
  if (!slide) die(`no such slide: ${slideId}`);
  const isElement = Array.isArray(slide.elements) && slide.elements.some((item) => item.id === objectId);
  const isDecor = Array.isArray(slide.decor) && slide.decor.some((item) => item.id === objectId);
  if (isElement && isDecor) {
    die(`object id ${objectId} is ambiguous; pass --kind element or --kind decor`);
  }
  if (!isElement && !isDecor) {
    die(`no such element or decor id: ${objectId} on slide ${slideId}`);
  }
  return isElement ? 'element' : 'decor';
}

async function cmdToggleProtection(makeProtected, pos, flags) {
  if (pos.length < 1 || pos.length > 2) {
    die(`usage: ${makeProtected ? 'protect' : 'unprotect'} sID [objectID] [--kind element|decor] [--task taskID]`);
  }
  if (pos.length === 1 && flags.kind !== undefined) {
    die('--kind is valid only when an objectID is supplied');
  }
  const body = {
    kind: pos.length === 1 ? 'slide' : 'object',
    slideId: pos[0],
    protected: makeProtected,
    by: EDITOR
  };
  if (flags.task !== undefined) {
    if (typeof flags.task !== 'string' || !flags.task.trim()) die('--task needs a task id');
    if (!makeProtected) die('--task delegated protection control may only add protections');
    if (pos.length !== 2) die('--task may protect only a generated picture decor object, not a whole slide');
    body.taskId = flags.task.trim();
    body.delegatedMode = 'direct-generated-decor';
  }
  if (pos.length === 2) {
    body.objectId = pos[1];
    body.objectKind = await protectionObjectKind(pos[0], pos[1], flags.kind);
  }
  const r = await api('POST', '/api/protections/toggle', body);
  if (r.status !== 200 || !validProtectionToggleResult(r.body, body)) {
    die(`${C.red}✗ ${(r.body && r.body.error) || `protection update failed (HTTP ${r.status})`}${C.reset}`, 1);
  }
  const target = body.kind === 'slide'
    ? `slide ${body.slideId}`
    : `${body.objectKind} ${body.objectId} on ${body.slideId}`;
  if (r.body.changed === false) {
    console.log(`${C.gray}(${target} was already ${makeProtected ? 'protected' : 'unprotected'})${C.reset}`);
    return;
  }
  if (body.kind === 'slide') {
    console.log(makeProtected
      ? `${C.yellow}🔒 protected${C.reset} ${target} ${C.gray}(all child overrides cleared)${C.reset}`
      : `${C.green}✓ unprotected${C.reset} ${target} ${C.gray}(all child locks cleared)${C.reset}`);
    return;
  }
  console.log(makeProtected
    ? `${C.yellow}🔒 protected${C.reset} ${target}`
    : `${C.green}✓ unprotected${C.reset} ${target}`);
}

async function cmdLocks(flags) {
  const r = await api('GET', '/api/locks');
  const locks = requireReadResult(r, 'locks', (x) => Array.isArray(x.locks)).locks;
  if (flags && flags.json) { console.log(JSON.stringify(locks, null, 2)); return; }
  console.log('');
  console.log(`  ${C.bold}Slide Locks${C.reset}  ${C.gray}advisory claims, not enforced — ppt lock/unlock · http://${HOST}:${PORT}${C.reset}`);
  if (!locks.length) { console.log(`     ${C.gray}(none claimed — claim one with: ppt lock s4)${C.reset}\n`); return; }
  locks.forEach((l) => {
    const age = Math.round((Date.now() - l.ts) / 60000);
    const mine = l.by === EDITOR ? ` ${C.green}(you)${C.reset}` : '';
    console.log(`     ${C.yellow}🔒${C.reset} ${C.bold}${l.slideId}${C.reset}  ${C.cyan}${l.by}${C.reset}${mine}  ${C.gray}${age}m ago${l.note ? ` · ${l.note}` : ''}${C.reset}`);
  });
  console.log('');
}

async function cmdHistory(flags) {
  const r = await api('GET', '/api/history');
  const body = requireReadResult(r, 'history', (x) => Array.isArray(x.undo) && Array.isArray(x.redo));
  const undo = body.undo;
  const redo = body.redo;
  if (flags && flags.json) { console.log(JSON.stringify({ undo, redo }, null, 2)); return; }
  console.log('');
  console.log(`  ${C.bold}Edit History${C.reset}  ${C.gray}most recent first · ppt undo/redo · http://${HOST}:${PORT}${C.reset}`);
  console.log(`\n  ${C.cyan}undoable${C.reset} ${C.gray}(ppt undo reverts the top one)${C.reset}`);
  if (!undo.length) console.log(`     ${C.gray}(nothing to undo)${C.reset}`);
  undo.slice(0, 15).forEach((h, i) => {
    const t = new Date(h.ts).toLocaleTimeString();
    console.log(`     ${i === 0 ? C.yellow + '→' + C.reset : ' '} ${C.bold}${h.editor}${C.reset} ${h.detail}  ${C.gray}${t}${C.reset}`);
  });
  if (redo.length) {
    console.log(`\n  ${C.cyan}redoable${C.reset} ${C.gray}(ppt redo re-applies the top one)${C.reset}`);
    redo.slice(0, 15).forEach((h, i) => {
      const t = new Date(h.ts).toLocaleTimeString();
      console.log(`     ${i === 0 ? C.yellow + '→' + C.reset : ' '} ${C.bold}${h.editor}${C.reset} ${h.detail}  ${C.gray}${t}${C.reset}`);
    });
  }
  console.log('');
}

const LINT_LABEL = {
  'dash': 'em/en dash', 'min-size': 'under 20pt', 'header-align': 'header alignment', 'speaker-notes': 'speaker notes',
  'font-family': 'font family'
};

async function cmdLint(flags) {
  const r = await api('GET', '/api/lint');
  const body = requireReadResult(r, 'lint', (x) =>
    Number.isInteger(x.rev) && typeof x.ok === 'boolean' &&
    Number.isInteger(x.count) && Array.isArray(x.issues), true);
  const { rev, ok, count, issues } = body;
  if (flags && flags.json) { console.log(JSON.stringify(body, null, 2)); return; }
  console.log('');
  console.log(`  ${C.bold}House-Rule Lint${C.reset}  ${C.gray}rev ${rev}${C.reset}`);
  if (ok) { console.log(`\n     ${C.green}✓ clean, no violations found${C.reset}\n`); return; }
  console.log(`\n     ${C.yellow}${count} violation${count === 1 ? '' : 's'}${C.reset}`);
  issues.forEach((i) => {
    const where = i.elementId ? `${i.slideId} ${i.elementId}` : i.slideId;
    console.log(`     ${C.red}✗${C.reset} ${C.gray}[${LINT_LABEL[i.type] || i.type}]${C.reset} ${C.bold}${where}${C.reset}  ${i.detail}${i.text ? `  ${C.gray}"${i.text}"${C.reset}` : ''}`);
  });
  console.log('');
}

function fmtMMSS(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function cmdTiming(flags) {
  const r = await api('GET', '/api/timing');
  const t = requireReadResult(r, 'timing', (x) =>
    typeof x.wpm === 'number' && typeof x.totalWords === 'number' &&
    typeof x.totalSeconds === 'number' && Array.isArray(x.perSlide));
  if (flags && flags.json) { console.log(JSON.stringify(t, null, 2)); return; }
  console.log('');
  console.log(`  ${C.bold}Speaking-Time Estimate${C.reset}  ${C.gray}~${t.wpm}wpm, visible slide text only, not a real rehearsal${C.reset}`);
  (t.perSlide || []).forEach((s) => {
    console.log(`     ${C.gray}${s.slideId}${C.reset}  ${String(s.words).padStart(4)} words  ${C.gray}~${fmtMMSS(s.seconds)}${C.reset}`);
  });
  const totalColor = t.overCap ? C.red : (t.overTarget ? C.yellow : C.green);
  console.log('');
  console.log(`     total  ${C.bold}${t.totalWords} words${C.reset}  ${totalColor}${C.bold}~${fmtMMSS(t.totalSeconds)}${C.reset}  ` +
    `${C.gray}(target ${fmtMMSS(t.targetSeconds)}, hard cap ${fmtMMSS(t.capSeconds)})${C.reset}`);
  if (t.overCap) console.log(`     ${C.red}⚠ over the 12:00 hard cap, trim the longest slides first${C.reset}`);
  else if (t.overTarget) console.log(`     ${C.yellow}⚠ over the 11:00 target, some headroom left before the hard cap${C.reset}`);
  console.log('');
}

async function cmdWatch() {
  console.log(`${C.gray}watching http://${HOST}:${PORT} … (Ctrl+C to stop)${C.reset}`);
  const hb = setInterval(heartbeat, 5000); heartbeat();
  // Reconnect with backoff instead of dying on the first drop: CLAUDE.md's
  // own workflow tells a session to keep a spare `ppt watch` terminal open
  // purely to stay visible as "free" on the board, and a live server restart
  // (a routine, expected operational event in this project, not an edge
  // case) used to silently kill that terminal on the very first connection
  // error, which is exactly backwards for a presence heartbeat. Mirrors
  // app.js's own already-proven EventSource reconnect shape (1s initial,
  // x1.6 growth, 8s cap, reset on a successful reconnect) adapted to Node's
  // raw http client, which has no built-in EventSource equivalent.
  let backoff = 1000;
  let stopped = false;
  let wasDown = false;
  let reconnectTimer = null;

  function connect() {
    if (stopped) return;
    let settled = false; // req/res can both fire for the same drop; only act once
    const onLost = () => {
      if (stopped || settled) return;
      settled = true;
      wasDown = true;
      console.log(`${C.yellow}⚠ lost connection to the suite server, retrying in ${Math.round(backoff / 1000)}s…${C.reset}`);
      reconnectTimer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 1.6, 8000);
    };
    let buf = '';
    const req = http.request({ host: HOST, port: PORT, path: '/api/events', method: 'GET' }, (res) => {
      backoff = 1000;
      if (wasDown) { wasDown = false; console.log(`${C.green}✓ reconnected${C.reset}`); }
      res.on('data', (c) => {
        buf += c;
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          let ev; try { ev = JSON.parse(line.slice(6)); } catch (_) { continue; }
          const t = new Date(ev.ts || Date.now()).toLocaleTimeString();
          if (ev.type === 'edit') console.log(`${C.gray}${t}${C.reset} ${C.green}✎${C.reset} ${ev.editor} ${C.dim}${ev.detail}${C.reset}`);
          else if (ev.type === 'pause') console.log(`${C.gray}${t}${C.reset} ${C.yellow}⏸  PAUSED by ${ev.by}${C.reset}`);
          else if (ev.type === 'resume') console.log(`${C.gray}${t}${C.reset} ${C.green}▶  RESUMED by ${ev.by}${C.reset}`);
          else if (ev.type === 'render') console.log(`${C.gray}${t}${C.reset} ${ev.ok ? C.blue + '⤓ rendered pptx' : C.red + 'render failed: ' + ev.error}${C.reset}`);
          else if (ev.type === 'persist') console.log(`${C.gray}${t}${C.reset} ${C.red}✖ SAVE FAILED (${ev.file || 'disk'}): ${ev.error || 'unknown error'}${C.reset}`);
          else if (ev.type === 'board' && ev.note) {
            const n = ev.note;
            if (ev.action === 'delete') console.log(`${C.gray}${t}${C.reset} ${C.gray}board: note removed${C.reset}`);
            else if (n.pinned) console.log(`${C.gray}${t}${C.reset} ${C.yellow}📌 ${n.author} pinned: ${n.text}${C.reset}`);
            else console.log(`${C.gray}${t}${C.reset} ${C.cyan}✉ ${n.author}:${C.reset} ${n.text}`);
          }
          else if (ev.type === 'editors') console.log(`${C.gray}${t} editors: ${ev.editors.map((e) => e.name).join(', ') || 'none'}${C.reset}`);
        }
      });
      res.on('error', onLost);
      res.on('end', onLost);
    });
    req.on('error', onLost);
    req.end();
  }

  connect();
  process.on('SIGINT', () => {
    stopped = true; clearInterval(hb); if (reconnectTimer) clearTimeout(reconnectTimer);
    // /api/leave exists specifically for this: an editor that's actually
    // leaving (not just idling between commands) drops off the dashboard
    // immediately, locks and all, instead of lingering for the 15s presence
    // TTL. Nothing called it anywhere; Ctrl+C here is the one unambiguous
    // "I'm done" moment in the whole CLI. Best-effort, races a short timeout
    // so a dead/unreachable server can never hang the one thing someone
    // pressing Ctrl+C actually wants right now: exiting.
    Promise.race([
      api('POST', '/api/leave', { id: EDITOR }).catch(() => {}),
      new Promise((r) => setTimeout(r, 1000)),
    ]).then(() => process.exit(0));
  });
}

function openBrowser(url) {
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '""', url]);
  else if (process.platform === 'darwin') execFile('open', [url]);
  else execFile('xdg-open', [url]);
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const { flags, pos } = parseFlags(rest);

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(`
${C.bold}ppt${C.reset} — presentation suite editor

  ${C.cyan}status${C.reset}                         show pause state, deck summary, editors
  ${C.cyan}show${C.reset}                           print the deck outline with ids
  ${C.cyan}search${C.reset} "text" [--json]         find which slides mention text (titles, bullets, body, notes)
  ${C.cyan}title${C.reset} "text"                   set the presentation title
  ${C.cyan}add-slide${C.reset} [--layout L] [--title T] [--after sID] [--index n]
  ${C.cyan}delete-slide${C.reset} sID
  ${C.cyan}move-slide${C.reset} sID <index>
  ${C.cyan}set-layout${C.reset} sID <layout>        (title|content|bullets|section|titleonly|blank|two|compare)
  ${C.cyan}set-transition${C.reset} sID fade [--duration 0.35]
  ${C.cyan}set-transition${C.reset} sID none
                                         fade duration is seconds (0.1..10); advance is click-only, with no sound
  ${C.cyan}set-text${C.reset} sID eID "text"
  ${C.cyan}set-bullets${C.reset} sID eID "a" "b" …
  ${C.cyan}add-element${C.reset} sID <type> [--text "…" | --items a b …]  ${C.gray}(overlay mode: only works on a brand-new add-slide slide, warns otherwise)${C.reset}
  ${C.cyan}delete-element${C.reset} sID eID
  ${C.cyan}notes${C.reset} sID "speaker notes"
  ${C.cyan}pause${C.reset} | ${C.cyan}resume${C.reset} | ${C.cyan}render${C.reset} | ${C.cyan}watch${C.reset} | ${C.cyan}open${C.reset}
  ${C.cyan}lint${C.reset} [--json]                  scan for house-rule violations (dashes, sub-20pt, header align, notes, font)
  ${C.cyan}time${C.reset} [--json]                  estimate speaking time from visible slide text (rough proxy, not a rehearsal)
  ${C.cyan}export-pdf${C.reset}                     export presentation.pdf via PowerPoint (download at /api/pdf)
  ${C.cyan}history${C.reset} [--json]               preview what's undoable/redoable, most recent first
  ${C.cyan}undo${C.reset} / ${C.cyan}redo${C.reset}                       step the deck back/forward one edit at a time (any op type; gated by pause)

  ${C.bold}color & style${C.reset} ${C.gray}(ppt show lists each element's current style + decor ids)${C.reset}
  ${C.cyan}set-color${C.reset} sID eID "#RRGGBB"        set a text element's run color
  ${C.cyan}set-bold${C.reset} sID eID true|false        set a text element's bold weight
  ${C.cyan}set-size${C.reset} sID eID <points>          set a text element's font size (>= house-rule floor)
  ${C.cyan}set-align${C.reset} sID eID left|center|right|justify
  ${C.cyan}set-font${C.reset} sID eID "Font Family Name"  set a text element's font (ppt lint flags whichever font is the deck-wide minority)
  ${C.cyan}set-fill${C.reset} sID targetID "#RRGGBB"    fill color; targetID is an element or decor id from ${C.cyan}ppt show${C.reset}
  ${C.cyan}set-outline${C.reset} sID eID "#RRGGBB"      outline color for a text-backed card element
  ${C.cyan}set-corners${C.reset} sID targetID sharp     convert an eligible imported box/card AutoShape to true 90-degree corners
  ${C.cyan}set-box${C.reset} sID targetID [--x N --y N --w N --h N]   reposition/resize imported shapes, generated decor, or native text; native text without a box needs all four values first
  ${C.cyan}add-shape${C.reset} sID "#RRGGBB" --x N --y N --w N --h N   add generated rectangle decor (suite-native or imported slide)
  ${C.cyan}add-image${C.reset} sID "assets/file.png" --x N --y N --w N --h N [--task tID]   add generated picture decor; granted tasks remain limited to their assigned slide and operation
  ${C.cyan}add-video${C.reset} sID "assets/file.mp4" --x N --y N --w N --h N [--autoplay true|false] [--loop true|false]   embed video on suite-native or imported slide
  ${C.cyan}set-image${C.reset} sID decorID "assets/file.png"   update generated picture source in place; id, box, order, and history are preserved
  ${C.cyan}set-media${C.reset} sID decorID [--source "assets/file.mp4"] [--autoplay true|false] [--loop true|false]   update generated video in place; id, box, order, and history are preserved
  ${C.cyan}set-animation${C.reset} sID targetID appear|fade|wipe|rise-up [--trigger click|with-previous|after-previous] [--duration N] [--delay N] [--index N]
  ${C.cyan}set-animation${C.reset} sID targetID none      remove that object's build
  ${C.cyan}delete-decor${C.reset} sID decorID             delete only a generated rectangle/image/video; imported/backed decor is refused
  ${C.cyan}set-theme${C.reset} --accent "#RRGGBB"   theme accent color (native-added slides only)

  ${C.bold}message board${C.reset} ${C.gray}(coordinate with other sessions — works even when paused)${C.reset}
  ${C.cyan}board${C.reset} [--json]                 read pinned house rules + recent messages
  ${C.cyan}note${C.reset} "message" [--as name]     post a message for the other editor sessions
  ${C.cyan}pin${C.reset} "house rule" [--as name]   pin a standing rule (usually done by the human)
  ${C.cyan}unpin${C.reset} <noteId>                 turn a pinned rule back into a normal note
  ${C.cyan}note-rm${C.reset} <noteId>               delete a note from the board

  ${C.bold}team status & tasks${C.reset} ${C.gray}(who is free/busy + a shared to-do queue; work while paused)${C.reset}
  ${C.cyan}free${C.reset}                           mark yourself available for tasks
  ${C.cyan}busy${C.reset} "what you're doing"       mark yourself busy (shows on the dashboard)
  ${C.cyan}who${C.reset} [--json]                   list sessions and their free/busy status
  ${C.cyan}task${C.reset} "do X" [--for name]       add a task, optionally aimed at a session
  ${C.cyan}task-update${C.reset} <id> [--text "do X"] [--for worker-N|media-N|--unassign] [--wake true|false]   assigning wakes by default; --wake false holds
  ${C.cyan}task-protection-grant${C.reset} <id> sID [sID2 ...] [--minutes 60]  human grants the assigned agent scoped protection control
  ${C.cyan}task-protection-revoke${C.reset} <id>                         human revokes that task-scoped grant
  ${C.cyan}task-hold${C.reset} <id> [--text "do X"] [--for worker-N|media-N]   keep it durable but prevent automatic wake/restart
  ${C.cyan}task-wake${C.reset} <id> [--text "do X"] [--for worker-N|media-N]   assign/update and queue an eligible worker wake
  ${C.cyan}tasks${C.reset} [--mine] [--json]        list open/claimed tasks
  ${C.cyan}claim${C.reset} <taskId>                 claim a task as yours
  ${C.cyan}done${C.reset} <taskId>                  mark a task done
  ${C.cyan}next${C.reset} [--claim]                 show (or claim) the next task for you
  ${C.cyan}task-rm${C.reset} <taskId>              delete a task

  ${C.bold}standing loops${C.reset} ${C.gray}(recurring checks the human sets; a /loop worker runs them)${C.reset}
  ${C.cyan}loops${C.reset} [--on] [--json]           list standing loops (--on = enabled only)
  ${C.cyan}loop${C.reset} "continuously check …" [--every 10m] [--as name]   add a standing loop
  ${C.cyan}loop-on${C.reset} / ${C.cyan}loop-off${C.reset} <loopId>      enable / disable a loop
  ${C.cyan}loop-rm${C.reset} <loopId>                delete a loop
  ${C.cyan}loop-ran${C.reset} <loopId> [--note "…"]   record that you just ran it

  ${C.bold}content protections${C.reset} ${C.gray}(durable hard locks controlled by humans; survive restart and block edit/undo/redo)${C.reset}
  ${C.cyan}protect${C.reset} sID [objectID] [--kind element|decor] [--task tID]     protect a whole slide or one element/decor/picture/media; delegated task mode is generated-microheader decor only
  ${C.cyan}unprotect${C.reset} sID [objectID] [--kind element|decor]                human-unlock that exact stable target
  ${C.cyan}protections${C.reset} [--json]                            list durable content protections
  ${C.cyan}protections --history${C.reset} [--json]                  list durable lock/unlock decisions (an unlock is distinct from initial absence)

  ${C.bold}slide locks${C.reset} ${C.gray}(advisory only — never blocks an edit, just warns of collisions; auto-expire in 20m)${C.reset}
  ${C.cyan}lock${C.reset} sID [sID2 …] [--note "…"] [--force]   claim slides you're about to edit (--force takes an unexpired lock from someone else)
  ${C.cyan}unlock${C.reset} sID [sID2 …] | --all       release your claim
  ${C.cyan}locks${C.reset} [--json]                 list who holds what (also shown in ${C.cyan}ppt show${C.reset}/${C.cyan}status${C.reset})

  ${C.bold}Agent Studio team${C.reset} ${C.gray}(the /studio chatbox spawns a lead + workers, cap set by the usage profile; this is their CLI mirror)${C.reset}
  ${C.cyan}chat${C.reset} "message" [--as name] [--quiet]   say it on the board AND wake/spawn the lead (what the /studio chatbox does; --quiet skips the board note)
  ${C.cyan}chat${C.reset} --tail [N] [--json]        print the last N messages, oldest last (default 20; house rules excluded)
  ${C.cyan}agents${C.reset} [--json]                 list the live lead/worker team: color, status, queue depth, pid, model, cost
  ${C.cyan}profile${C.reset} [low|normal|extra|beast] [--json]   NEXT-spawn model, two pool caps, reasoning, speed, and access
  ${C.cyan}provider${C.reset} [claude|codex] [--json]     which CLI backs the team: the models that tier resolves to, and how each one is contained
  ${C.cyan}spend${C.reset} [--reset] [--json]         session cost so far, split by model (modeled from tokens, not a bill)
  ${C.cyan}dismiss${C.reset} [name]                  stop one agent, or the whole team if no name is given
  ${C.cyan}interrupt${C.reset} [name]                cancel a running turn WITHOUT killing the process (context preserved)
  ${C.cyan}guard-log${C.reset} [--tail N] [--json]   the sandbox's allow/deny audit trail for spawned workers

  env: SUITE_EDITOR="${EDITOR}"  SUITE_PORT=${PORT}
`);
    return;
  }

  await ensureUp();
  await heartbeat();

  switch (cmd) {
    case 'status': return cmdStatus();
    case 'show': case 'outline': return cmdShow();
    case 'search': case 'find': return cmdSearch(pos[0], flags);
    // /studio explicitly, not '/': the root redirects there anyway, but naming
    // it keeps the printed URL honest about where you actually land.
    case 'open': { openBrowser(`http://${HOST}:${PORT}/studio`); console.log(`opening http://${HOST}:${PORT}/studio`); return; }
    case 'watch': return cmdWatch();
    case 'lint': return cmdLint(flags);
    case 'time': case 'timing': return cmdTiming(flags);

    // ---- shared message board (works even while the deck is paused)
    case 'board': return cmdBoard(flags);
    case 'note': case 'pin': {
      const text = (pos.join(' ').trim()) || (typeof flags.text === 'string' ? flags.text : '');
      if (!text) die(`usage: ${cmd} "${cmd === 'pin' ? 'house rule' : 'message'}" [--as name]`);
      const author = (typeof flags.as === 'string' ? flags.as : EDITOR);
      const pinned = cmd === 'pin';
      const r = await api('POST', '/api/board', { text, author, pinned });
      if (r.status !== 200 || !r.body.ok) die(`${C.red}✗ ${r.body.error || 'post failed'}${C.reset}`, 1);
      if (pinned) console.log(`${C.yellow}📌 pinned house rule${C.reset} ${C.gray}${r.body.note.id}${C.reset}`);
      else console.log(`${C.green}✓${C.reset} posted note ${C.gray}${r.body.note.id}${C.reset}`);
      return;
    }
    case 'unpin': {
      if (!pos[0]) die('usage: unpin <noteId>');
      const r = await api('POST', '/api/board/pin', { id: pos[0], pinned: false });
      if (r.status !== 200 || !r.body.ok) die(`${C.red}✗ ${r.body.error || 'failed'}${C.reset}`, 1);
      console.log(`${C.green}✓${C.reset} unpinned ${C.gray}${pos[0]}${C.reset}`); return;
    }
    case 'note-rm': case 'board-rm': {
      if (!pos[0]) die('usage: note-rm <noteId>');
      const r = await api('POST', '/api/board/delete', { id: pos[0] });
      if (r.status !== 200 || !r.body.ok) die(`${C.red}✗ ${r.body.error || 'failed'}${C.reset}`, 1);
      console.log(`${C.green}✓${C.reset} removed ${C.gray}${pos[0]}${C.reset}`); return;
    }

    // ---- team status + shared task list (work even while the deck is paused)
    case 'free': { await setStatus('free', ''); console.log(`${C.green}● free${C.reset} ${C.gray}(available for tasks)${C.reset}`); return; }
    case 'busy': {
      const what = (pos.join(' ').trim()) || (typeof flags.text === 'string' ? flags.text : '');
      await setStatus('busy', what);
      console.log(`${C.yellow}● busy${C.reset}${what ? ` ${C.gray}${what}${C.reset}` : ''}`);
      return;
    }
    case 'who': case 'sessions': return cmdWho(flags);
    case 'tasks': return cmdTasks(flags);
    case 'task': {
      const text = (pos.join(' ').trim()) || (typeof flags.text === 'string' ? flags.text : '');
      if (!text) die('usage: task "what to do" [--for name]');
      const assignee = (typeof flags.for === 'string' ? flags.for : '');
      const r = await api('POST', '/api/tasks', {
        text, by: EDITOR, assignee, wakeWorker: !!assignee,
      });
      if (r.status !== 200 || !r.body.ok) die(`${C.red}✗ ${r.body.error || 'failed'}${C.reset}`, 1);
      console.log(`${C.green}✓${C.reset} task ${C.bold}${r.body.task.id}${C.reset}${assignee ? ` ${C.cyan}→ ${assignee}${C.reset}` : ` ${C.gray}(unassigned)${C.reset}`}`);
      // An explicit assignment wakes/spawns that worker right then, regardless
      // of this CLI session's display label. Surface any durable retry here: a
      // wake failure (worker cap reached, or paused) looked identical to a
      // clean dispatch, task created, both printed the same green line with
      // no way to tell the worker never actually got woken. The task itself
      // still queues fine either way (recoverable via `ppt next --claim`
      // once capacity frees up), so this warns rather than dying.
      const d = r.body.dispatch;
      if (d && d.ok === false) {
        console.log(`  ${C.yellow}⚠ could not wake ${assignee}: ${d.reason}${C.reset} (task is still queued, claim it once free)`);
      }
      return;
    }
    case 'task-update': case 'task-hold': case 'task-wake': {
      if (!pos[0]) {
        die('usage: task-update <taskId> [--text "do X"] [--for worker-N|media-N|--unassign] [--wake true|false]');
      }
      const body = { id: pos[0], by: EDITOR };
      const hasText = Object.prototype.hasOwnProperty.call(flags, 'text');
      const hasFor = Object.prototype.hasOwnProperty.call(flags, 'for');
      const hasUnassign = Object.prototype.hasOwnProperty.call(flags, 'unassign');
      const hasWake = Object.prototype.hasOwnProperty.call(flags, 'wake');
      if (hasText) {
        if (typeof flags.text !== 'string') die('--text needs a task instruction');
        body.text = flags.text;
      }
      if (hasFor && hasUnassign) die('use either --for worker-N/media-N or --unassign, not both');
      if (hasFor) {
        if (typeof flags.for !== 'string') die('--for needs a worker name');
        body.assignee = flags.for;
      }
      if (hasUnassign) {
        if (flags.unassign !== true) die('--unassign is a flag and takes no value');
        body.assignee = '';
      }
      if (cmd === 'task-hold') {
        if (hasWake) die('task-hold always uses wakeWorker=false; omit --wake');
        body.wakeWorker = false;
      } else if (cmd === 'task-wake') {
        if (hasWake) die('task-wake always uses wakeWorker=true; omit --wake');
        body.wakeWorker = true;
      } else if (hasWake) {
        body.wakeWorker = strictBoolean(flags.wake, '--wake');
      }
      if (!hasText && !hasFor && !hasUnassign && !Object.prototype.hasOwnProperty.call(body, 'wakeWorker')) {
        die('task-update needs --text, --for, --unassign, or --wake true|false');
      }
      const r = await api('POST', '/api/tasks/update', body);
      if (r.status !== 200 || !r.body.ok) die(`${C.red}[error] ${r.body.error || 'failed'}${C.reset}`, 1);
      const task = r.body.task;
      const assignment = task.assignee || 'unassigned';
      if (task.wakeWorker === false) {
        console.log(`${C.green}[ok]${C.reset} held ${C.gray}${task.id}${C.reset} for ${assignment}; durable, automatic wake disabled`);
      } else {
        console.log(`${C.green}[ok]${C.reset} updated ${C.gray}${task.id}${C.reset} for ${assignment}`);
      }
      const d = r.body.dispatch;
      if (d && d.ok) {
        console.log(`  ${C.cyan}${d.action === 'spawn' ? 'spawned' : 'woke'} ${assignment}${C.reset}`);
      } else if (d && d.ok === false) {
        console.log(`  ${C.yellow}[warning] not delivered: ${d.reason}${C.reset} (task remains queued)`);
      }
      return;
    }
    case 'task-protection-grant': {
      if (pos.length < 2) die('usage: task-protection-grant <taskId> sID [sID2 ...] [--minutes 60]');
      const minutes = flags.minutes === undefined ? 60 : strictInteger(flags.minutes, '--minutes');
      if (minutes < 1 || minutes > 240) die('--minutes must be from 1 to 240');
      const r = await api('POST', '/api/tasks/protection-grant', {
        id: pos[0], slideIds: pos.slice(1), minutes, by: EDITOR
      });
      if (r.status !== 200 || !r.body.ok) die(`${C.red}[error] ${r.body.error || 'failed'}${C.reset}`, 1);
      const grant = r.body.task && r.body.task.protectionGrant;
      console.log(`${C.green}[ok]${C.reset} protection control granted to ${r.body.task.assignee || r.body.task.claimedBy} for ${grant.slideIds.join(', ')} until ${new Date(grant.expiresAt).toLocaleString()}`);
      return;
    }
    case 'task-protection-revoke': {
      if (pos.length !== 1) die('usage: task-protection-revoke <taskId>');
      const r = await api('POST', '/api/tasks/protection-grant', {
        id: pos[0], revoke: true, by: EDITOR
      });
      if (r.status !== 200 || !r.body.ok) die(`${C.red}[error] ${r.body.error || 'failed'}${C.reset}`, 1);
      console.log(r.body.changed
        ? `${C.green}[ok]${C.reset} revoked protection control for ${pos[0]}`
        : `${C.gray}(task ${pos[0]} had no active protection grant)${C.reset}`);
      return;
    }
    case 'claim': {
      if (!pos[0]) die('usage: claim <taskId>');
      const r = await api('POST', '/api/tasks/claim', { id: pos[0], by: EDITOR });
      if (r.status !== 200 || !r.body.ok) die(`${C.red}✗ ${r.body.error || 'failed'}${C.reset}`, 1);
      console.log(`${C.green}✓${C.reset} claimed ${C.gray}${pos[0]}${C.reset}: ${r.body.task.text}`);
      return;
    }
    case 'done': case 'task-done': {
      if (!pos[0]) die('usage: done <taskId>');
      const r = await api('POST', '/api/tasks/done', { id: pos[0], by: EDITOR });
      if (r.status !== 200 || !r.body.ok) die(`${C.red}✗ ${r.body.error || 'failed'}${C.reset}`, 1);
      console.log(`${C.green}✓${C.reset} done ${C.gray}${pos[0]}${C.reset}`);
      return;
    }
    case 'next': {
      const claim = !!flags.claim;
      const r = await api('POST', '/api/tasks/next', { by: EDITOR, claim });
      const t = r.body && r.body.task;
      if (!t) { console.log(`${C.gray}no open task for ${EDITOR}${C.reset}`); return; }
      console.log(`${claim ? C.green + '✓ claimed ' : C.cyan + 'next '}${C.reset}${C.bold}${t.id}${C.reset}: ${t.text}${t.assignee ? ` ${C.gray}(for ${t.assignee})${C.reset}` : ''}`);
      return;
    }
    case 'task-rm': {
      if (!pos[0]) die('usage: task-rm <taskId>');
      const r = await api('POST', '/api/tasks/delete', { id: pos[0] });
      if (r.status !== 200 || !r.body.ok) die(`${C.red}✗ ${r.body.error || 'failed'}${C.reset}`, 1);
      console.log(`${C.green}✓${C.reset} removed ${C.gray}${pos[0]}${C.reset}`);
      return;
    }

    // ---- the lead/worker agent team (Agent Studio)
    case 'chat': return cmdChat(pos, flags);
    case 'agents': return cmdAgents(!!flags.json);
    case 'profile': return cmdProfile(pos[0], flags);
    case 'provider': return cmdProvider(pos[0], flags);
    case 'spend': return cmdSpend(flags);
    case 'dismiss': {
      const name = pos[0]; // omit to stop the whole team
      const r = await api('POST', '/api/agents/stop', name ? { name } : {});
      if (r.body.stopped) {
        console.log(`${C.green}✓${C.reset} dismissed ${name ? C.cyan + name + C.reset : 'all agents'}`);
      } else {
        console.log(`${C.gray}(nothing to dismiss${name ? `: ${name} was not running` : ': no agents were running'})${C.reset}`);
      }
      return;
    }
    case 'interrupt': {
      // Softer than dismiss: cancels a running turn without killing the
      // process, so a worker headed the wrong way can be redirected instead
      // of losing all its context. Existed in agents.js since early in this
      // project (already verified there: "session stays usable after") but
      // had no way to actually reach it until now.
      const name = pos[0]; // omit to interrupt the whole team
      const r = await api('POST', '/api/agents/interrupt', name ? { name } : {});
      if (r.body.interrupted) {
        console.log(`${C.green}✓${C.reset} interrupted ${name ? C.cyan + name + C.reset : 'all agents'} ${C.gray}(process stays alive, context preserved, send it a new task to redirect)${C.reset}`);
      } else {
        console.log(`${C.gray}(nothing to interrupt${name ? `: ${name} is not currently thinking` : ': no agents are currently thinking'})${C.reset}`);
      }
      return;
    }
    case 'guard-log': return cmdGuardLog(parseInt(flags.tail, 10) || 50, !!flags.json);

    // ---- standing loops: recurring check prompts (work even while paused)
    case 'loops': return cmdLoops(flags);
    case 'loop': {
      const text = (pos.join(' ').trim()) || (typeof flags.text === 'string' ? flags.text : '');
      if (!text) die('usage: loop "continuously check …" [--every 10m] [--as name]');
      const author = (typeof flags.as === 'string' ? flags.as : EDITOR);
      const cadence = (typeof flags.every === 'string' ? flags.every : (typeof flags.cadence === 'string' ? flags.cadence : ''));
      const r = await api('POST', '/api/loops', { text, author, cadence });
      if (r.status !== 200 || !r.body.ok) die(`${C.red}✗ ${r.body.error || 'failed'}${C.reset}`, 1);
      console.log(`${C.green}🔁 added loop${C.reset} ${C.bold}${r.body.loop.id}${C.reset}${cadence ? ` ${C.gray}every ${cadence}${C.reset}` : ''}`);
      return;
    }
    case 'loop-on': case 'loop-off': {
      if (!pos[0]) die(`usage: ${cmd} <loopId>`);
      const enabled = cmd === 'loop-on';
      const r = await api('POST', '/api/loops/toggle', { id: pos[0], enabled });
      if (r.status !== 200 || !r.body.ok) die(`${C.red}✗ ${r.body.error || 'failed'}${C.reset}`, 1);
      console.log(`${enabled ? C.green + '● on' : C.gray + '○ off'}${C.reset} ${C.gray}${pos[0]}${C.reset}`);
      return;
    }
    case 'loop-rm': {
      if (!pos[0]) die('usage: loop-rm <loopId>');
      const r = await api('POST', '/api/loops/delete', { id: pos[0] });
      if (r.status !== 200 || !r.body.ok) die(`${C.red}✗ ${r.body.error || 'failed'}${C.reset}`, 1);
      console.log(`${C.green}✓${C.reset} removed ${C.gray}${pos[0]}${C.reset}`);
      return;
    }
    case 'loop-ran': {
      if (!pos[0]) die('usage: loop-ran <loopId> [--note "what you found or fixed"]');
      const result = (typeof flags.note === 'string' ? flags.note : '');
      const r = await api('POST', '/api/loops/ran', { id: pos[0], by: EDITOR, result });
      if (r.status !== 200 || !r.body.ok) die(`${C.red}✗ ${r.body.error || 'failed'}${C.reset}`, 1);
      console.log(`${C.green}✓${C.reset} recorded run of ${C.gray}${pos[0]}${C.reset}`);
      return;
    }

    // ---- durable content protections (hard locks; human-controlled)
    case 'protections': return cmdProtections(flags);
    case 'protect': return cmdToggleProtection(true, pos, flags);
    case 'unprotect': return cmdToggleProtection(false, pos, flags);

    // ---- advisory slide locks (heads-up only; edits are never blocked by these)
    case 'locks': return cmdLocks(flags);
    case 'lock': {
      if (!pos.length) die('usage: lock sID [sID2 …] [--note "what you\'re doing"] [--force]');
      const note = (typeof flags.note === 'string' ? flags.note : '');
      const r = await api('POST', '/api/locks', { slideIds: pos, by: EDITOR, note, force: !!flags.force });
      if (r.status !== 200 || !r.body.ok) die(`${C.red}✗ ${r.body.error || 'failed'}${C.reset}`, 1);
      console.log(`${C.yellow}🔒 locked${C.reset} ${r.body.locked.join(', ') || '(none)'}`);
      // server.js's only conflicts.push() always sets refused:true (a live
      // lock is refused unless --force is passed, never silently
      // reassigned), so this always renders the same message; no live path
      // produces a conflict entry that isn't a refusal.
      (r.body.conflicts || []).forEach((c) => console.log(
        `${C.red}✗ ${c.slideId} is held by ${c.heldBy} (${Math.round(c.heldForMs / 60000)}m ago), not taken: coordinate on the board, or pass --force to take it anyway${C.reset}`));
      (r.body.unknown || []).forEach((id) => console.log(`${C.red}✗ no such slide: ${id}${C.reset}`));
      return;
    }
    case 'unlock': {
      const all = !!flags.all;
      if (!all && !pos.length) die('usage: unlock sID [sID2 …]  |  unlock --all');
      const r = await api('POST', '/api/locks/release', { slideIds: all ? 'all' : pos, by: EDITOR });
      if (r.status !== 200 || !r.body.ok) die(`${C.red}✗ ${r.body.error || 'failed'}${C.reset}`, 1);
      console.log(r.body.released ? `${C.green}✓ unlocked${C.reset}` : `${C.gray}(nothing to unlock)${C.reset}`);
      (r.body.notMine || []).forEach((id) => console.log(`${C.gray}· ${id} is held by someone else, left alone${C.reset}`));
      return;
    }

    case 'pause': {
      const r = await api('POST', '/api/pause', { by: EDITOR });
      requireControlResult(r, 'pause', true);
      console.log(`${C.yellow}⏸  paused${C.reset}`);
      return;
    }
    case 'resume': {
      const r = await api('POST', '/api/resume', { by: EDITOR });
      requireControlResult(r, 'resume', false);
      console.log(`${C.green}▶  resumed${C.reset}`);
      return;
    }
    case 'render': {
      // Forces a re-render of the CURRENT deck. This must NOT mutate anything:
      // the old implementation set the presentation title to its own current
      // value so it could ride the edit() path (for pause handling), but that
      // byte-identical "edit" still bumped model.rev and pushed a phantom
      // "title → …" onto the undo stack, polluting history on every render.
      // /api/render triggers the same debounced render pipeline directly,
      // changing no model state, and still answers 423 while paused so this
      // keeps the documented contract (a 423 means stop, not proceed silently)
      // that a raw api() call used to break by ignoring the refusal.
      const r = await api('POST', '/api/render');
      if (r.status === 423) {
        die(`${C.yellow}⏸  PAUSED${C.reset} — render was refused${r.body && r.body.pausedBy ? ` by ${r.body.pausedBy}` : ''}. ` +
            `Press Resume on the dashboard to continue.`, 3);
      }
      if (r.status === 404) {
        // Fail closed against an older, still-running server. Falling back to
        // the former title edit would recreate the rev and history mutation
        // this command promises never to make.
        die(`${C.red}✗ server restart required: /api/render is not available; no render edit was sent${C.reset}`, 1);
      }
      if (r.status !== 200 || !r.body || r.body.ok === false) {
        die(`${C.red}✗ ${(r.body && r.body.error) || `render failed (HTTP ${r.status})`}${C.reset}`, 1);
      }
      console.log(`${C.green}✓${C.reset} re-render triggered`);
      return;
    }
    case 'export-pdf': case 'pdf': {
      console.log(`${C.gray}exporting PDF via PowerPoint (a few seconds)…${C.reset}`);
      const r = await api('POST', '/api/pdf/export', {}, 180000);
      if (r.status !== 200 || !r.body.ok) die(`${C.red}✗ ${r.body.error || 'pdf export failed'}${C.reset}`, 1);
      console.log(`${C.green}✓ exported${C.reset} ${C.gray}(deck rev ${r.body.rev})${C.reset}  ${C.cyan}http://${HOST}:${PORT}/api/pdf${C.reset}`);
      return;
    }

    case 'history': return cmdHistory(flags);
    case 'undo': {
      const r = await api('POST', '/api/undo', { editor: EDITOR });
      if (r.status === 423) {
        if (r.body && (r.body.error === 'protected' || r.body.protection)) {
          die(`${C.yellow}🔒 PROTECTED${C.reset} — ${r.body.message || 'undo would change protected content; a human must unprotect it first'}.`, 4);
        }
        die(`${C.yellow}⏸  PAUSED${C.reset} — undo is an edit too, it's locked${r.body.pausedBy ? ` by ${r.body.pausedBy}` : ''}.`, 3);
      }
      if (r.status !== 200 || !r.body.ok) die(`${C.red}✗ ${r.body.error || 'undo failed'}${C.reset}`, 1);
      const u = r.body.undone;
      console.log(`${C.green}✓ undid${C.reset} ${C.bold}${u.editor}${C.reset}'s ${u.detail}  ${C.gray}(now rev ${r.body.rev})${C.reset}`);
      return;
    }
    case 'redo': {
      const r = await api('POST', '/api/redo', { editor: EDITOR });
      if (r.status === 423) {
        if (r.body && (r.body.error === 'protected' || r.body.protection)) {
          die(`${C.yellow}🔒 PROTECTED${C.reset} — ${r.body.message || 'redo would change protected content; a human must unprotect it first'}.`, 4);
        }
        die(`${C.yellow}⏸  PAUSED${C.reset} — redo is an edit too, it's locked${r.body.pausedBy ? ` by ${r.body.pausedBy}` : ''}.`, 3);
      }
      if (r.status !== 200 || !r.body.ok) die(`${C.red}✗ ${r.body.error || 'redo failed'}${C.reset}`, 1);
      const u = r.body.redone;
      console.log(`${C.green}✓ redid${C.reset} ${C.bold}${u.editor}${C.reset}'s ${u.detail}  ${C.gray}(now rev ${r.body.rev})${C.reset}`);
      return;
    }

    case 'title': { if (!pos[0]) die('usage: title "New Title"'); await edit({ type: 'set-presentation-title', text: pos[0] }); console.log(`${C.green}✓${C.reset} title set`); return; }

    case 'add-slide': {
      const r = await edit({ type: 'add-slide', layout: flags.layout || 'content', title: flags.title, after: flags.after, index: flags.index != null ? strictInteger(flags.index, 'index') : undefined });
      console.log(`${C.green}✓${C.reset} added slide ${C.bold}${r.affected.slideId}${C.reset} (rev ${r.rev})`);
      return;
    }
    case 'delete-slide': { if (!pos[0]) die('usage: delete-slide sID'); await edit({ type: 'delete-slide', slideId: pos[0] }); console.log(`${C.green}✓${C.reset} slide deleted`); return; }
    case 'move-slide': { if (pos.length < 2) die('usage: move-slide sID <index>'); await edit({ type: 'move-slide', slideId: pos[0], index: strictInteger(pos[1], 'index') }); console.log(`${C.green}✓${C.reset} slide moved`); return; }
    case 'set-layout': { if (pos.length < 2) die('usage: set-layout sID <layout>'); await edit({ type: 'set-layout', slideId: pos[0], layout: pos[1] }); console.log(`${C.green}✓${C.reset} layout set`); return; }
    case 'set-transition': {
      if (pos.length !== 2) die('usage: set-transition sID fade [--duration 0.35] | set-transition sID none');
      const [slideId, effect] = pos;
      if (effect !== 'fade' && effect !== 'none') die('effect must be fade or none');
      if (effect === 'none') {
        if (flags.duration !== undefined) die('duration is only valid for fade');
        const r = await edit({ type: 'set-transition', slideId, effect: 'none' });
        console.log(`${C.green}✓${C.reset} transition set to none (click-only, no sound; rev ${r.rev})`);
        return;
      }
      const duration = flags.duration === undefined ? 0.35 : strictNumber(flags.duration, 'duration');
      if (duration < 0.1 || duration > 10) die('duration must be from 0.1 to 10 seconds');
      const r = await edit({ type: 'set-transition', slideId, effect: 'fade', duration });
      console.log(`${C.green}✓${C.reset} transition set to fade ${duration}s (click-only, no sound; rev ${r.rev})`);
      return;
    }
    case 'notes': { if (pos.length < 2) die('usage: notes sID "text"'); await edit({ type: 'set-notes', slideId: pos[0], text: pos[1] }); console.log(`${C.green}✓${C.reset} notes set`); return; }

    case 'set-text': { if (pos.length < 3) die('usage: set-text sID eID "text"'); const r = await edit({ type: 'set-text', slideId: pos[0], elementId: pos[1], text: pos[2] }); console.log(`${C.green}✓${C.reset} text set (rev ${r.rev})`); return; }
    case 'set-bullets': { if (pos.length < 3) die('usage: set-bullets sID eID "a" "b" …'); const r = await edit({ type: 'set-bullets', slideId: pos[0], elementId: pos[1], items: pos.slice(2) }); console.log(`${C.green}✓${C.reset} bullets set (rev ${r.rev})`); return; }

    case 'add-element': {
      if (pos.length < 2) die('usage: add-element sID <type> [--text ".." | --items a b ..]');
      const op = { type: 'add-element', slideId: pos[0], elementType: pos[1] };
      // --items a b .. is documented as multi-value, but parseFlags only
      // ever consumes ONE following word as a flag's value (it has no
      // concept of a variadic flag): --items apple banana cherry parsed as
      // flags.items='apple', pos=[sID,type,'banana','cherry'], so the old
      // `pos.slice(2)` here silently dropped 'apple' whenever 2+ items were
      // given, exactly the command's own documented usage. Stitch the
      // flag-captured first word back onto the front of whatever spilled
      // into pos, in the order the user typed them.
      if (typeof flags.items === 'string') op.items = [flags.items, ...pos.slice(2)];
      else if (pos.length > 2) op.items = pos.slice(2);
      else op.text = flags.text || '';
      const r = await edit(op); console.log(`${C.green}✓${C.reset} added ${pos[1]} ${C.bold}${r.affected.elementId}${C.reset}`); return;
    }
    case 'delete-element': { if (pos.length < 2) die('usage: delete-element sID eID'); await edit({ type: 'delete-element', slideId: pos[0], elementId: pos[1] }); console.log(`${C.green}✓${C.reset} element deleted`); return; }

    case 'set-color': {
      if (pos.length < 3) die('usage: set-color sID eID "#RRGGBB"');
      const r = await edit({ type: 'set-style', slideId: pos[0], elementId: pos[1], color: pos[2] });
      console.log(`${C.green}✓${C.reset} color set (rev ${r.rev})`); return;
    }
    case 'set-bold': {
      if (pos.length < 3) die('usage: set-bold sID eID true|false');
      const r = await edit({ type: 'set-style', slideId: pos[0], elementId: pos[1], bold: strictBoolean(pos[2], 'bold') });
      console.log(`${C.green}✓${C.reset} bold set (rev ${r.rev})`); return;
    }
    case 'set-size': {
      if (pos.length < 3) die('usage: set-size sID eID <points>');
      const r = await edit({ type: 'set-style', slideId: pos[0], elementId: pos[1], size: strictNumber(pos[2], 'size') });
      console.log(`${C.green}✓${C.reset} size set (rev ${r.rev})`); return;
    }
    case 'set-align': {
      if (pos.length < 3) die('usage: set-align sID eID left|center|right|justify');
      const r = await edit({ type: 'set-style', slideId: pos[0], elementId: pos[1], align: pos[2] });
      console.log(`${C.green}✓${C.reset} align set (rev ${r.rev})`); return;
    }
    case 'set-font': {
      if (pos.length < 3) die('usage: set-font sID eID "Font Family Name"');
      const r = await edit({ type: 'set-style', slideId: pos[0], elementId: pos[1], font: pos[2] });
      console.log(`${C.green}✓${C.reset} font set (rev ${r.rev})`); return;
    }
    case 'set-fill': {
      if (pos.length < 3) die('usage: set-fill sID targetID "#RRGGBB"  (targetID = an element id or decor id from ppt show)');
      const r = await edit({ type: 'set-fill', slideId: pos[0], elementId: pos[1], decorId: pos[1], color: pos[2] });
      console.log(`${C.green}✓${C.reset} fill set (rev ${r.rev})`); return;
    }
    case 'set-outline': {
      if (pos.length < 3) die('usage: set-outline sID eID "#RRGGBB"');
      const r = await edit({ type: 'set-outline', slideId: pos[0], elementId: pos[1], color: pos[2] });
      console.log(`${C.green}OK${C.reset} outline set (rev ${r.rev})`); return;
    }
    case 'set-corners': {
      if (pos.length !== 3 || pos[2] !== 'sharp') {
        die('usage: set-corners sID targetID sharp  (eligible imported box/card AutoShapes only)');
      }
      const r = await edit({
        type: 'set-corners',
        slideId: pos[0],
        targetId: pos[1],
        corners: pos[2],
      });
      console.log(`${C.green}✓${C.reset} corners set to sharp on ${pos[1]} (rev ${r.rev})`); return;
    }
    case 'set-box': {
      if (pos.length < 2) die('usage: set-box sID targetID [--x N] [--y N] [--w N] [--h N]  (targetID = an element id or decor id from ppt show; x/y/w/h are fractions 0..1 of slide width/height)');
      const op = { type: 'set-box', slideId: pos[0], elementId: pos[1], decorId: pos[1] };
      for (const k of ['x', 'y', 'w', 'h']) {
        if (flags[k] !== undefined) op[k] = strictNumber(flags[k], k);
      }
      if (op.x === undefined && op.y === undefined && op.w === undefined && op.h === undefined) {
        die('usage: set-box sID targetID --x N --y N --w N --h N  (at least one of x/y/w/h, fractions 0..1 of slide width/height)');
      }
      const r = await edit(op);
      console.log(`${C.green}✓${C.reset} box set (rev ${r.rev})`); return;
    }
    case 'add-shape': {
      if (pos.length !== 2 || ['x', 'y', 'w', 'h'].some((k) => flags[k] === undefined)) {
        die('usage: add-shape sID "#RRGGBB" --x N --y N --w N --h N  (generated rectangle on a suite-native or imported slide; coordinates are fractions 0..1)');
      }
      const op = {
        type: 'add-shape',
        slideId: pos[0],
        shapeType: 'rect',
        fill: strictHex(pos[1], 'fill'),
        x: strictUnitNumber(flags.x, 'x', false),
        y: strictUnitNumber(flags.y, 'y', false),
        w: strictUnitNumber(flags.w, 'w', true),
        h: strictUnitNumber(flags.h, 'h', true),
      };
      const r = await edit(op);
      console.log(`${C.green}✓${C.reset} added generated rectangle ${C.bold}${r.affected.decorId}${C.reset} (rev ${r.rev})`); return;
    }
    case 'add-image': {
      if (pos.length !== 2 || ['x', 'y', 'w', 'h'].some((k) => flags[k] === undefined)) {
        die('usage: add-image sID "assets/file.png" --x N --y N --w N --h N [--task taskID]  (PNG/JPEG/GIF inside this project assets folder)');
      }
      const taskId = flags.task === undefined
        ? undefined
        : (typeof flags.task === 'string' && flags.task.trim() ? flags.task.trim() : die('--task needs a task id'));
      const r = await edit({
        type: 'add-image',
        slideId: pos[0],
        source: pos[1],
        x: strictUnitNumber(flags.x, 'x', false),
        y: strictUnitNumber(flags.y, 'y', false),
        w: strictUnitNumber(flags.w, 'w', true),
        h: strictUnitNumber(flags.h, 'h', true),
      }, taskId);
      console.log(`${C.green}✓${C.reset} added local image ${C.bold}${r.affected.decorId}${C.reset} (rev ${r.rev})`); return;
    }
    case 'add-video': {
      if (pos.length !== 2 || ['x', 'y', 'w', 'h'].some((k) => flags[k] === undefined)) {
        die('usage: add-video sID "assets/file.mp4" --x N --y N --w N --h N [--autoplay true|false] [--loop true|false]  (H.264 MP4 inside this project assets folder; embedded, not linked)');
      }
      const autoplay = flags.autoplay === undefined ? true : strictBoolean(flags.autoplay, 'autoplay');
      const loop = flags.loop === undefined ? true : strictBoolean(flags.loop, 'loop');
      const r = await edit({
        type: 'add-video',
        slideId: pos[0],
        source: pos[1],
        x: strictUnitNumber(flags.x, 'x', false),
        y: strictUnitNumber(flags.y, 'y', false),
        w: strictUnitNumber(flags.w, 'w', true),
        h: strictUnitNumber(flags.h, 'h', true),
        autoplay,
        loop,
      });
      console.log(`${C.green}✓${C.reset} added embedded video ${C.bold}${r.affected.decorId}${C.reset} autoplay=${autoplay ? 'on' : 'off'} loop=${loop ? 'on' : 'off'} (rev ${r.rev})`); return;
    }
    case 'set-image': {
      if (pos.length !== 3) {
        die('usage: set-image sID decorID "assets/file.png"  (updates an existing generated picture source without changing its id, box, or order)');
      }
      const r = await edit({ type: 'set-image', slideId: pos[0], decorId: pos[1], source: pos[2] });
      console.log(`${C.green}✓${C.reset} updated image ${C.bold}${pos[1]}${C.reset} source=${pos[2]} (rev ${r.rev})`); return;
    }
    case 'set-media': {
      if (pos.length !== 2) {
        die('usage: set-media sID decorID [--source "assets/file.mp4"] [--autoplay true|false] [--loop true|false]  (updates an existing generated video without changing its id, box, or order)');
      }
      const op = { type: 'set-media', slideId: pos[0], decorId: pos[1] };
      const changes = [];
      if (flags.source !== undefined) {
        if (typeof flags.source !== 'string' || !flags.source.trim()) {
          die('source must be a non-empty MP4 path');
        }
        op.source = flags.source;
        changes.push(`source=${flags.source}`);
      }
      if (flags.autoplay !== undefined) {
        op.autoplay = strictBoolean(flags.autoplay, 'autoplay');
        changes.push(`autoplay=${op.autoplay ? 'on' : 'off'}`);
      }
      if (flags.loop !== undefined) {
        op.loop = strictBoolean(flags.loop, 'loop');
        changes.push(`loop=${op.loop ? 'on' : 'off'}`);
      }
      if (!changes.length) {
        die('set-media needs at least one of --source, --autoplay, or --loop');
      }
      const r = await edit(op);
      console.log(`${C.green}✓${C.reset} updated embedded video ${C.bold}${pos[1]}${C.reset} ${changes.join(' ')} (rev ${r.rev})`); return;
    }
    case 'set-animation': {
      if (pos.length !== 3) {
        die('usage: set-animation sID targetID appear|fade|wipe|rise-up [--trigger click|with-previous|after-previous] [--duration N] [--delay N] [--index N] | set-animation sID targetID none');
      }
      const effect = pos[2];
      if (!['appear', 'fade', 'wipe', 'rise-up', 'none'].includes(effect)) {
        die('effect must be appear, fade, wipe, rise-up, or none');
      }
      const op = { type: 'set-animation', slideId: pos[0], targetId: pos[1], effect };
      if (flags.trigger !== undefined) op.trigger = flags.trigger;
      if (flags.duration !== undefined) op.duration = strictNumber(flags.duration, 'duration');
      if (flags.delay !== undefined) op.delay = strictNumber(flags.delay, 'delay');
      if (flags.index !== undefined) op.index = strictInteger(flags.index, 'index');
      const r = await edit(op);
      console.log(`${C.green}✓${C.reset} animation ${effect === 'none' ? 'removed' : 'set'} on ${pos[1]} (rev ${r.rev})`); return;
    }
    case 'delete-decor': {
      if (pos.length !== 2) die('usage: delete-decor sID decorID  (only generated rectangle/image/video overlays can be deleted)');
      const r = await edit({ type: 'delete-decor', slideId: pos[0], decorId: pos[1] });
      console.log(`${C.green}✓${C.reset} deleted generated object ${pos[1]} (rev ${r.rev})`); return;
    }
    case 'set-theme': {
      const accent = typeof flags.accent === 'string' ? flags.accent : undefined;
      if (!accent) die('usage: set-theme --accent "#RRGGBB"');
      const r = await edit({ type: 'set-theme', accent });
      console.log(`${C.green}✓${C.reset} theme set (rev ${r.rev})`); return;
    }

    default: die(`unknown command: ${cmd}  (try: ppt help)`, 1);
  }
}

main().catch((e) => die(`${C.red}error: ${e.message}${C.reset}`, 1));
