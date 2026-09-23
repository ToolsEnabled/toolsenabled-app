#!/usr/bin/env node
'use strict';
/*
 * board-hook.js — Claude Code SessionStart hook for the Presentation Suite.
 *
 * Every new session runs this and gets, injected straight into its context:
 *   1. the human's pinned house rules (binding),
 *   2. the sessions currently connected to the suite (so you can see who else
 *      is live before you touch a slide), and
 *   3. recent board notes, where sessions declare which slides they are taking.
 *
 * Together (2)+(3) are the overlap-avoidance signal: who is here, and what they
 * claimed. This removes the "forgot to run `ppt board`" failure mode: the rules
 * and the current ownership picture are in context before the model acts, not
 * only if it remembers to ask.
 *
 * It reads a single snapshot (GET /api/state), which carries both `board` and
 * `editors`. It is deliberately FAIL-SILENT: if the server is not running, is
 * slow, or has nothing to say, it prints nothing and exits 0, so a session can
 * always start. Never exit non-zero: that would surface noise at startup.
 *
 * Config (matches ppt.js): SUITE_PORT (4599), SUITE_HOST (127.0.0.1).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.SUITE_PORT || '4599', 10);
const HOST = process.env.SUITE_HOST || '127.0.0.1';
const TIMEOUT_MS = 2000;   // keep session start snappy even if the server hangs

// How many unpinned notes to inject. This used to be a hardcoded 20, chosen
// when notes were short "taking s4-s7" claim lines. They are not: the chatbox
// writes full conversation turns to the board, averaging ~1.9K chars each, so
// 20 notes measured 38K chars (~9.5K tokens) injected into EVERY session and
// every spawned agent, about 5x the size of CLAUDE.md. The server's usage
// profile now owns this number (low=0, normal=5, extra=5); this constant is
// only the fallback for an older server or a degraded fetch.
const DEFAULT_MAX_MESSAGES = 5;

// Per-note cap, so one runaway 4K-char transcript note cannot eat the budget
// the profile just bought back. Matches trunc() in server.js and the 140-char
// preview in agents.js; the whitespace collapse also keeps a multi-line note
// from breaking out of its single markdown list item.
const MAX_NOTE_CHARS = 300;
function trunc(s) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > MAX_NOTE_CHARS ? s.slice(0, MAX_NOTE_CHARS) + '…' : s;
}

// Instrumentation probe. It is UNVERIFIED whether this hook fires for the
// agent children the suite spawns (they get `--settings <guard file>`, and
// whether that merges with or replaces project settings is unconfirmed). One
// line per invocation answers it: if lines appear as agents spawn, the trim
// above is paid back on every spawn. Fail-silent and size-capped, same shape
// as log() in ppt-guard.js, because a probe must never break session start.
const PROBE_LOG = path.join(__dirname, 'data', 'board-hook.log');
const PROBE_MAX_BYTES = 256 * 1024;
const PROBE_KEEP_LINES = 500;
function probe(bytes) {
  try {
    const line = [
      new Date().toISOString(),
      'pid=' + process.pid,
      'bytes=' + bytes,
      'cwd=' + process.cwd()
    ].join(' ');
    fs.appendFileSync(PROBE_LOG, line + '\n');
    if (fs.statSync(PROBE_LOG).size > PROBE_MAX_BYTES) {
      const lines = fs.readFileSync(PROBE_LOG, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(PROBE_LOG, lines.slice(-PROBE_KEEP_LINES).join('\n') + '\n');
    }
  } catch (_) {}
}

function fetchState() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: HOST, port: PORT, path: '/api/state', timeout: TIMEOUT_MS },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (_) { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));            // server down / unreachable
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function fmtTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n)) return '';
  try { return new Date(n).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'; }
  catch (_) { return ''; }
}

(async function main() {
  const state = await fetchState();
  if (!state) { probe(0); process.exit(0); }         // nothing reachable

  // The active usage profile decides how many unpinned notes we inject
  // (low=0, normal=5, extra=5). Absent on an older server, so fall back
  // rather than fail. Note boardNotes:0 is a legitimate value and falsy, so
  // this tests for a finite number instead of using ||.
  let maxMessages = DEFAULT_MAX_MESSAGES;
  try {
    const p = state.profile;
    const cfg = p && p.profiles && p.profiles[p.profile];
    const n = cfg ? Number(cfg.boardNotes) : NaN;
    if (Number.isFinite(n) && n >= 0) maxMessages = Math.floor(n);
  } catch (_) {}

  // `board` is boardView() on a current server (pinned oldest-first, then
  // messages newest-first); absent on an older build, so default to [].
  const notes = Array.isArray(state.board) ? state.board : [];
  const editors = Array.isArray(state.editors) ? state.editors : [];
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const loops = Array.isArray(state.loops) ? state.loops : [];
  const locks = Array.isArray(state.locks) ? state.locks : [];
  const pins = notes.filter((n) => n && n.pinned);
  const msgs = notes.filter((n) => n && !n.pinned);
  const openTasks = tasks.filter((t) => t && t.status !== 'done');
  const activeLoops = loops.filter((l) => l && l.enabled);

  // Nothing worth injecting → start clean.
  if (!pins.length && !msgs.length && !editors.length && !openTasks.length && !activeLoops.length && !locks.length) { probe(0); process.exit(0); }

  const lines = [];
  lines.push('# Presentation suite: shared message board (auto-loaded at session start)');
  lines.push('');
  lines.push('This is the live coordination board for the PowerPoint deck in this repo.');
  lines.push('Pinned house rules below are the human\'s standing directives and are BINDING.');
  lines.push('Before you edit, check who else is connected and what they claimed, so two');
  lines.push('sessions do not touch the same slides. Announce your own chunk with');
  lines.push('`ppt note "taking s4-s7"` when you start and `ppt note "done with s4-s7"` when you');
  lines.push('finish. The board changes mid-session, so re-check it with `ppt board`.');
  lines.push('');

  // DO NOT TRIM OR TRUNCATE THIS BLOCK, in any profile. The pinned notes are
  // the human's binding house rules, and both the lead and worker system
  // prompts are written assuming they are present and complete. They are also
  // cheap (all 9 pins together are ~1.2K chars), so they are never what needs
  // cutting. `low` drops unpinned notes to zero and still keeps every pin.
  if (pins.length) {
    lines.push('## Pinned house rules (binding)');
    pins.forEach((n) => lines.push(`- ${String(n.text || '').trim()}  (pinned by ${n.author || 'human'})`));
    lines.push('');
  }

  if (editors.length) {
    lines.push(`## Sessions connected right now (${editors.length}), you may not be listed yet`);
    editors.forEach((e) => {
      const since = fmtTime(e.joinedAt);
      lines.push(`- ${e.name || e.id || 'editor'}${since ? '  (connected since ' + since + ')' : ''}`);
    });
    lines.push('');
  } else {
    lines.push('## Sessions connected right now');
    lines.push('- none currently registered (you may be the only session, or others are idle)');
    lines.push('');
  }

  if (locks.length) {
    lines.push(`## Slides currently locked (${locks.length}), claiming a locked slide is refused unless you --force`);
    locks.forEach((l) => {
      const note = l.note ? `: ${String(l.note).trim()}` : '';
      lines.push(`- ${l.slideId} by ${l.by}${note}`);
    });
    lines.push('Claim your own slides with `ppt lock sID [sID2 …] --note "…"`; locks auto-expire after 20m idle.');
    lines.push('');
  }

  if (openTasks.length) {
    lines.push(`## Open tasks in the shared queue (${openTasks.length}), a free session can grab one`);
    openTasks.forEach((t) => {
      const who = t.assignee ? `for ${t.assignee}` : 'for anyone';
      const claim = t.status === 'claimed' && t.claimedBy ? `, claimed by ${t.claimedBy}` : '';
      lines.push(`- [${t.id}] (${who}${claim}) ${String(t.text || '').trim()}`);
    });
    lines.push('Claim one with `ppt claim <id>`, or add one with `ppt task "…" --for name`.');
    lines.push('');
  }

  if (activeLoops.length) {
    lines.push(`## Standing loops enabled (${activeLoops.length}), recurring checks the sessions keep running`);
    activeLoops.forEach((l) => {
      const every = l.cadence ? ` every ${l.cadence}` : '';
      const last = l.lastRun
        ? `, last run ${fmtTime(l.lastRun)}${l.lastBy ? ' by ' + l.lastBy : ''}`
        : ', never run';
      lines.push(`- [${l.id}]${every} ${String(l.text || '').trim()}${last}`);
    });
    lines.push('See the full list with `ppt loops`; record a pass with `ppt loop-ran <id> --note "…"`.');
    lines.push('Storing a loop does not run it: only a session pointed at it with Claude Code\'s');
    lines.push('`/loop` skill actually executes the checks on a cadence.');
    lines.push('');
  }

  // Nothing here is lost, only made retrievable on demand instead of always
  // resident: whatever we do not inject is still one `ppt board` away, so the
  // pointer below has to survive even when the profile injects zero notes.
  if (msgs.length) {
    const shown = msgs.slice(0, maxMessages);
    lines.push(shown.length
      ? '## Recent notes: who is working on what (newest first)'
      : '## Recent notes');
    shown.forEach((n) => {
      const when = fmtTime(n.ts);
      lines.push(`- ${when ? '[' + when + '] ' : ''}${n.author || 'anonymous'}: ${trunc(n.text)}`);
    });
    const hidden = msgs.length - shown.length;
    if (hidden > 0) {
      lines.push(`- (plus ${hidden} older notes: run \`ppt board\` for the full list)`);
    }
    lines.push('');
  }

  const context = lines.join('\n');
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context
    }
  };
  process.stdout.write(JSON.stringify(payload));
  probe(Buffer.byteLength(context, 'utf8'));
  process.exit(0);
})();
