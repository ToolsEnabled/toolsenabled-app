#!/usr/bin/env node
'use strict';
/**
 * The deck toolset, as an MCP server over stdio.
 *
 * This is the validated deck-editing path for Codex agents. Trusted Codex
 * workers also have their normal coding, filesystem, web, and visual tools,
 * while these role-gated operations keep normal presentation mutations inside
 * the suite's validation and coordination workflow. Claude workers get the
 * same toolset so both providers share one presentation vocabulary.
 *
 * Every tool calls back into the suite server on loopback rather than touching
 * presentation.pptx or data/model.json, so an agent edit travels the exact same
 * path as a human one and picks up the same validation, pause gate, undo entry,
 * house-rule lint, and SSE broadcast to the dashboard.
 *
 * Tool descriptions here are load bearing even though Codex can inspect the
 * project: they teach both providers that ids come from ppt_show, that a worker
 * locks before editing, and that pinned house rules bind.
 *
 * NEVER add tools for pause, resume, dismiss, chat, usage profile, undo, or
 * redo. The server already refuses agents on those with HTTP 403 by design:
 * pause is the human's hard stop, and undo is not scoped per editor, so
 * undoStack.pop() from an agent is a blind global rewind of the human's own
 * work. Exposing them here would only turn a clean 403 into a confusing one.
 */

const http = require('http');

const PORT = Number(process.env.SUITE_PORT || 4599);
const HOST = process.env.SUITE_HOST || '127.0.0.1';
// The agent's own name, stamped on every mutation as editor/by/author so the
// dashboard, the board, and the undo trail all attribute the change correctly.
const EDITOR = process.env.SUITE_EDITOR || 'mcp-agent';
// Unset means worker, mirroring scribe/mcp-doc.js defaulting to its working
// mode: the spawner always sets this explicitly, and a worker that silently
// came up with no editing tools would be a baffling failure to debug.
const ROLE = process.env.SUITE_MCP_ROLE === 'lead' ? 'lead' : 'worker';
const WORKER_CAP_RAW = Number.parseInt(process.env.SUITE_AGENT_WORKER_CAP || '12', 10);
const WORKER_CAP = Number.isFinite(WORKER_CAP_RAW) && WORKER_CAP_RAW > 0
  ? Math.min(30, WORKER_CAP_RAW)
  : 12;
const MEDIA_WORKER_CAP_RAW = Number.parseInt(process.env.SUITE_AGENT_MEDIA_WORKER_CAP || '0', 10);
const MEDIA_WORKER_CAP = Number.isFinite(MEDIA_WORKER_CAP_RAW) && MEDIA_WORKER_CAP_RAW > 0
  ? Math.min(10, MEDIA_WORKER_CAP_RAW)
  : 0;
const WORKER_RANGE = WORKER_CAP === 1 ? 'worker-1' : `worker-1 through worker-${WORKER_CAP}`;
const MEDIA_WORKER_RANGE = MEDIA_WORKER_CAP === 0
  ? ''
  : (MEDIA_WORKER_CAP === 1 ? 'media-1' : `media-1 through media-${MEDIA_WORKER_CAP}`);
const ASSIGNEE_RANGE = MEDIA_WORKER_RANGE
  ? `${WORKER_RANGE} for general work, or ${MEDIA_WORKER_RANGE} for image/video generation`
  : WORKER_RANGE;

// -------------------------------------------------------------- loopback

// Resolves on transport failure instead of rejecting: a dead suite server has
// to surface as a readable tool error, never as an unhandled rejection that
// takes the MCP process down and strands the agent mid-task.
function api(method, pathname, body, defaultTimeoutMs = 15000) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: HOST, port: PORT, path: pathname, method,
        headers: { 'Content-Type': 'application/json', 'Content-Length': data ? Buffer.byteLength(data) : 0 } },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          let parsed;
          try { parsed = out ? JSON.parse(out) : {}; } catch (_) { parsed = { error: out }; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', (e) => resolve({ status: 0, body: { error: `suite server unreachable at http://${HOST}:${PORT} (${e.message})` } }));
    const configured = process.env.SUITE_MCP_HTTP_TIMEOUT_MS;
    const timeoutMs = Math.max(
      1000,
      configured != null && configured !== ''
        ? (Number.parseInt(configured, 10) || 15000)
        : defaultTimeoutMs
    );
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`timed out after ${timeoutMs}ms`)); });
    if (data) req.write(data);
    req.end();
  });
}

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fail = (s) => ({ isError: true, content: [{ type: 'text', text: s }] });
const isHexColor = (value) => typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value);
const isUnitNumber = (value, positive) =>
  typeof value === 'number' && Number.isFinite(value) &&
  (positive ? value > 0 : value >= 0) && value <= 1;

// One place that turns any non-200 into agent-readable prose. The 423 wording
// is deliberately blunt and tells the agent to stop rather than retry: a
// polling loop against the human's pause button burns tokens and defeats the
// point of a hard stop.
function refusal(r, what) {
  if (r.status === 423) {
    return 'PAUSED. The human has paused all editing' +
      (r.body && r.body.pausedBy ? ` (paused by ${r.body.pausedBy})` : '') + '. ' +
      'Your edit was NOT applied. STOP editing now. Do not retry, and do not poll in a loop. ' +
      'Reading tools (ppt_show, ppt_board, ppt_lint) still work while paused, and you may post to ' +
      'the board with ppt_note. Wait for the human to press Resume.';
  }
  if (r.status === 0) return `Could not reach the suite: ${(r.body && r.body.error) || 'unknown transport error'}. The deck was not changed.`;
  if (r.status === 403) return `Refused (403): ${(r.body && r.body.error) || 'agents are not allowed to do that'}. This is intentional, do not work around it.`;
  return `Refused${what ? ` (${what})` : ''}: ${(r.body && r.body.error) || `HTTP ${r.status}`}`;
}

// Every deck mutation is this one endpoint, so the pause gate cannot be routed around.
async function edit(op, taskId) {
  const body = { op, editor: EDITOR };
  if (taskId !== undefined) body.taskId = taskId;
  const r = await api('POST', '/api/edit', body);
  if (r.status === 200 && r.body && r.body.ok) return { ok: true, body: r.body };
  return { ok: false, text: refusal(r, op.type) };
}

async function state() {
  const r = await api('GET', '/api/state');
  if (r.status !== 200 || !r.body || !r.body.model) return { ok: false, text: refusal(r, 'read state') };
  return { ok: true, body: r.body };
}

// -------------------------------------------------------------- rendering
// Everything below optimizes for tokens. These strings land in the agent's
// context on every single call, so a raw model dump would crowd out the work.

function clip(s, n) {
  const one = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

function fmtStyle(st) {
  if (!st) return '';
  const p = [];
  if (st.color) p.push(`color=${st.color}`);
  if (st.fill) p.push(`fill=${st.fill}`);
  if (st.outline) p.push(`outline=${st.outline}`);
  if (st.size) p.push(`size=${st.size}`);
  if (st.bold) p.push('bold');
  if (st.align) p.push(`align=${st.align}`);
  if (st.font) p.push(`font=${st.font}`);
  return p.length ? ` {${p.join(' ')}}` : '';
}

function fmtBox(b) {
  return b ? ` (${b.x.toFixed(2)},${b.y.toFixed(2)},${b.w.toFixed(2)},${b.h.toFixed(2)})` : '';
}

function fmtTransition(transition) {
  if (!transition) return '';
  return transition.effect === 'fade' ? ` transition=fade ${transition.duration}s` : ' transition=none';
}

function fmtAnimation(animation) {
  return `    animation ${animation.targetId}: ${animation.effect} ${animation.trigger}` +
    ` ${animation.duration}s${animation.delay ? ` delay=${animation.delay}s` : ''}`;
}

function fmtElement(e, full) {
  const cap = full ? 400 : 110;
  const body = e.items
    ? '[' + e.items.map((x) => JSON.stringify(clip(x, full ? 200 : 60))).join(', ') + ']'
    : JSON.stringify(clip(e.text, cap));
  const corners = e.corners ? ` corners=${e.corners}` : (e.sourcePreset ? ` corners-eligible=${e.sourcePreset}` : '');
  return `    ${e.id} ${e.type} ${body}${fmtStyle(e.style)}${fmtBox(e.box)}${corners}`;
}

function fmtDecor(d) {
  // sid is the shape id in the real pptx. Without it the renderer has nothing
  // to recolor, so the agent needs to know before it wastes a call on one.
  const colorable = d.kind === 'shape' && (d.sid != null || d.generated === true);
  const source = d.source ? ` source=${JSON.stringify(d.source)}` : '';
  const playback = d.kind === 'media'
    ? ` autoplay=${d.autoplay ? 'on' : 'off'} loop=${d.loop ? 'on' : 'off'}`
    : '';
  const corners = d.corners ? ` corners=${d.corners}` : (d.sourcePreset ? ` corners-eligible=${d.sourcePreset}` : '');
  return `    ${d.id} decor:${d.kind}${d.fill ? ` fill=${d.fill}` : ''}${source}${playback}${fmtBox(d.box)}${corners}${colorable ? '' : ' (not colorable)'}`;
}

function renderOutline(s, a) {
  const m = s.model;
  const locks = new Map((s.locks || []).map((l) => [l.slideId, l]));
  const want = a.slide != null ? String(a.slide) : null;
  const full = !!want;
  const lines = [];
  lines.push(`${m.title}  rev ${m.rev} - ${m.slides.length} slides` + (s.paused ? `  [PAUSED by ${s.pausedBy || '?'}]` : ''));

  let shown = 0;
  m.slides.forEach((sl, i) => {
    if (want && sl.id !== want && String(i + 1) !== want) return;
    shown++;
    const l = locks.get(sl.id);
    lines.push('');
    lines.push(`${i + 1}. ${sl.id} (${sl.layout})${fmtTransition(sl.transition)}` +
      (l ? `  LOCKED by ${l.by}${l.note ? `: ${l.note}` : ''}` : ''));
    (sl.elements || []).forEach((e) => lines.push(fmtElement(e, full)));
    const decor = sl.decor || [];
    if (decor.length) {
      if (a.decor || full) decor.forEach((d) => lines.push(fmtDecor(d)));
      else lines.push(`    + ${decor.length} decor shapes (call ppt_show with slide="${sl.id}" to see their ids)`);
    }
    (sl.animations || []).forEach((animation) => lines.push(fmtAnimation(animation)));
    if (sl.notes) {
      lines.push(a.notes || full ? `    notes: ${sl.notes}` : `    notes: ${clip(sl.notes, 70)}`);
    }
  });
  if (want && !shown) return `No slide matches ${JSON.stringify(want)}. Call ppt_show with no arguments to list every slide id.`;
  return lines.join('\n');
}

// -------------------------------------------------------------- tools
// roles: which of lead/worker sees the tool. tools/list filters on this, and
// so does call(), so a role can never invoke a tool it was not offered.

const TOOLS = [
  // ---------- both roles: reading and coordination
  {
    name: 'ppt_show',
    roles: ['lead', 'worker'],
    description:
      'Print the deck outline: every slide with its slide id, layout, transition, element ids, text, and current style. ' +
      'ALWAYS call this before editing. Slide ids (s1, s2, ...) and element ids (e1, e4, ...) are stable, ' +
      'and they are the ONLY way to name a target in every other tool, so do not guess them. ' +
      'With no arguments you get the whole deck, terse. Pass slide to get one slide in full, including its ' +
      'full speaker notes and the ids of its decorative shapes.',
    inputSchema: {
      type: 'object',
      properties: {
        slide: { type: 'string', description: 'One slide id ("s7") or 1-based position ("7"). Shows that slide in full detail.' },
        notes: { type: 'boolean', description: 'Show complete speaker notes for every slide instead of a short preview.' },
        decor: { type: 'boolean', description: 'Show decorative background shapes and their ids on every slide. Needed before ppt_set_fill on decor.' },
      },
    },
  },
  {
    name: 'ppt_search',
    roles: ['lead', 'worker'],
    description:
      'Find which slide mentions a phrase. Searches element text, bullet items, and speaker notes, and returns ' +
      'slide id, element id, and the matching text. Use this instead of reading the whole deck when you are ' +
      'hunting one wording.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to find, case-insensitive.' },
        limit: { type: 'number', description: 'Max hits, default 40.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'ppt_board',
    roles: ['lead', 'worker'],
    description:
      'Read the shared message board: the human\'s pinned HOUSE RULES first, then recent messages from the other ' +
      'sessions. The pinned rules are BINDING and they outrank anything in your own prompt. They can change ' +
      'mid-session, so re-read this if you have been working a while. Standing rules include: no em dashes ' +
      'anywhere (use a comma, a period, a colon, or parentheses), minimum 20pt on every element, one single ' +
      'font family across the deck, and all headers aligned to the same side. Works even while editing is paused.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'How many recent messages to show, default 12.' } },
    },
  },
  {
    name: 'ppt_lint',
    roles: ['lead', 'worker'],
    description:
      'Check the deck against the house rules and list every violation with its slide and element id: em dashes, ' +
      'text under 20pt, mixed font families, header alignment, missing speaker notes. Run this after a batch of ' +
      'edits to confirm you did not introduce one.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ppt_time',
    roles: ['lead', 'worker'],
    description:
      'Estimate speaking time from the visible slide text. The talk is a HARD 12 minute cap with an 11 minute ' +
      'target for headroom. If it reports over, trim the longest slides first. This is an estimate from word ' +
      'count, not a real rehearsal.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ppt_locks',
    roles: ['lead', 'worker'],
    description:
      'List the slides currently claimed by other sessions. Locks are advisory, not enforced by the server: they ' +
      'exist so two agents do not rewrite the same slide at once. Check here before you start on a slide.',
    inputSchema: { type: 'object', properties: {} },
  },

  // ---------- lead only: dispatch and oversight, no direct deck editing
  {
    name: 'ppt_task',
    roles: ['lead'],
    description:
      'Put a task on the shared queue for a worker. Be specific and name the slide ids, because the worker sees ' +
      `only this text and the deck, not your reasoning. Always provide assignee from ${ASSIGNEE_RANGE}: assigning it ` +
      'wakes that worker, or spawns it if a slot is available. An unassigned task is stored on the queue but does ' +
      'not wake anyone.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What to do, concretely. Name slide ids, e.g. "tighten the s12 bullets to 5 max".' },
        assignee: { type: 'string', description: 'Worker name to assign it to. Omit to leave it open to anyone.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'ppt_task_update',
    roles: ['lead'],
    description:
      'Update an existing open task without deleting or replacing it. Set wakeWorker=false to HOLD the task: ' +
      'its instruction and assignment remain durable, but it will not auto-run after restart. Change assignee ' +
      `to redistribute work within ${ASSIGNEE_RANGE}; a worker assignment wakes by default unless wakeWorker=false ` +
      'explicitly holds it. Set wakeWorker=true to wake the current/new assignee when the suite is unpaused and a viewer is present. Prior text and assignee values are retained ' +
      'in the task revision history.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Open task id.' },
        text: { type: 'string', description: 'Replacement instruction. The prior instruction is retained in revisions.' },
        assignee: { type: 'string', description: 'New worker name, or an empty string to unassign a held task.' },
        wakeWorker: { type: 'boolean', description: 'false holds the task; true queues/wakes its assigned worker.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'ppt_tasks',
    roles: ['lead'],
    description: 'List the task queue: what is open, what a worker has claimed, and what was recently finished.',
    inputSchema: {
      type: 'object',
      properties: { mine: { type: 'boolean', description: 'Only tasks assigned to or claimed by you.' } },
    },
  },
  {
    name: 'ppt_task_done',
    roles: ['lead', 'worker'],
    description:
      'Mark a task finished only after all requested work was actually applied and verified with ppt_show. ' +
      'If any requested work is blocked, unsupported, refused, or failed, post the blocker with ppt_note, ' +
      'unlock the slides, and leave the task open for retry. Do not call this tool for blocked work.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Task id.' } },
      required: ['id'],
    },
  },
  {
    name: 'ppt_loop',
    roles: ['lead'],
    description:
      'Add a standing loop: a recurring check that is never finished, e.g. "continuously check that every box\'s ' +
      'text is formatted neatly". A pinned house rule is a passive constraint, a loop is an active check that ' +
      'gets re-run on a cadence. Storing a loop does not run it, some session has to.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The recurring check, phrased as an instruction.' },
        cadence: { type: 'string', description: 'How often, e.g. "10m" or "1h".' },
      },
      required: ['text'],
    },
  },
  {
    name: 'ppt_loop_ran',
    roles: ['lead'],
    description: 'Record that you just ran a standing loop, with a one line result. Use the loop id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Loop id.' },
        result: { type: 'string', description: 'One line: what you found or fixed this pass.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'ppt_pin',
    roles: ['lead'],
    description:
      'Pin a house rule to the board so every session sees it as binding. Use sparingly, and only for a rule the ' +
      'human actually stated. Pinning your own preference silently rewrites the rules for everyone else.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The rule, one sentence, phrased as a constraint.' } },
      required: ['text'],
    },
  },
  {
    name: 'ppt_note',
    roles: ['lead', 'worker'],
    description:
      'Post a message to the shared board that every session and the human can see. This is how you claim work ' +
      '("taking slides 4 to 7") and hand off ("done, s1 to s3 are final"). Works even while editing is paused, ' +
      'so it is how you report a problem you cannot fix.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Your message. One or two sentences.' } },
      required: ['text'],
    },
  },
  {
    name: 'ppt_agents',
    roles: ['lead'],
    description: 'List the running lead and worker agents with their status, so you know who can actually pick up a task.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ppt_history',
    roles: ['lead'],
    description:
      'Show the recent edit trail: who changed what, most recent first. Read only. You cannot undo, and neither ' +
      'can any agent: undo is not scoped per editor, so it would rewind the human\'s work too. If something needs ' +
      'reverting, describe it with ppt_note and let the human do it.',
    inputSchema: { type: 'object', properties: {} },
  },

  // ---------- worker only: the actual deck editing
  {
    name: 'ppt_lock',
    roles: ['worker'],
    description:
      'Claim slides before you edit them, so another worker does not rewrite the same slide underneath you. ' +
      'Lock, edit, then ppt_unlock as soon as you are done. Locks are advisory: they warn, they do not block.',
    inputSchema: {
      type: 'object',
      properties: {
        slide_ids: { type: 'array', items: { type: 'string' }, description: 'Slide ids from ppt_show, e.g. ["s4","s5"].' },
        note: { type: 'string', description: 'Short reason, shown to the others, e.g. "rewriting methodology bullets".' },
      },
      required: ['slide_ids'],
    },
  },
  {
    name: 'ppt_unlock',
    roles: ['worker'],
    description: 'Release slides you locked. Do this as soon as you finish, do not hold a lock while you think.',
    inputSchema: {
      type: 'object',
      properties: {
        slide_ids: { type: 'array', items: { type: 'string' }, description: 'Slide ids to release. Omit and pass all=true to drop every lock you hold.' },
        all: { type: 'boolean', description: 'Release every lock you hold.' },
      },
    },
  },
  {
    name: 'ppt_set_text',
    roles: ['worker'],
    description:
      'Replace the entire text of one element. This is the main editing tool. Get slide_id and element_id from ' +
      'ppt_show first. Replaces the whole value, so include the full new text, not just your change. ' +
      'No em dashes: use a comma, a period, a colon, or parentheses.',
    inputSchema: {
      type: 'object',
      properties: {
        slide_id: { type: 'string', description: 'Slide id from ppt_show, e.g. "s7".' },
        element_id: { type: 'string', description: 'Element id from ppt_show, e.g. "e2".' },
        text: { type: 'string', description: 'The complete new text for that element.' },
      },
      required: ['slide_id', 'element_id', 'text'],
    },
  },
  {
    name: 'ppt_set_bullets',
    roles: ['worker'],
    description:
      'Replace all bullet items of one element. Pass the complete list, it is not appended to. Keep bullets short ' +
      'enough to read from the back of a room, and remember the audience is non-STEM PhDs: define each finance or ' +
      'AI term before its first use, and skip any term that needs more than one sentence to define.',
    inputSchema: {
      type: 'object',
      properties: {
        slide_id: { type: 'string' },
        element_id: { type: 'string' },
        items: { type: 'array', items: { type: 'string' }, description: 'The complete new list of bullets, in order.' },
      },
      required: ['slide_id', 'element_id', 'items'],
    },
  },
  {
    name: 'ppt_set_notes',
    roles: ['worker'],
    description:
      'Replace a slide\'s speaker notes. Notes carry timing tags like [~40s] and the sum across the deck must stay ' +
      'near 11:00 against a hard 12:00 cap, so keep the tag when you rewrite and adjust it if you changed the length.',
    inputSchema: {
      type: 'object',
      properties: {
        slide_id: { type: 'string' },
        text: { type: 'string', description: 'The complete new speaker notes, including the [~Ns] timing tag.' },
      },
      required: ['slide_id', 'text'],
    },
  },
  {
    name: 'ppt_set_style',
    roles: ['worker'],
    description:
      'Set color, size, bold, align, or font on one element. Pass only the properties you want to change, the rest ' +
      'are left alone. Colors are hex with the hash, e.g. "#2A78D6" (UCR blue) and "#F1B82D" (UCR gold). ' +
      'HOUSE RULES: size must never go below 20, the whole deck uses one single font family so do not introduce a ' +
      'second one, and all headers align to the same side.',
    inputSchema: {
      type: 'object',
      properties: {
        slide_id: { type: 'string' },
        element_id: { type: 'string' },
        color: { type: 'string', description: 'Text color as hex with hash, e.g. "#2A78D6".' },
        size: { type: 'number', description: 'Font size in points. Minimum 20, this is a hard house rule.' },
        bold: { type: 'boolean' },
        align: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
        font: { type: 'string', description: 'Font family. Only use the family already in the deck, one family throughout.' },
      },
      required: ['slide_id', 'element_id'],
    },
  },
  {
    name: 'ppt_set_fill',
    roles: ['worker'],
    description:
      'Set the background fill color of an element or a decorative shape. target_id is an element id or a decor id ' +
      '(the decor ids come from ppt_show with decor=true). Colors are hex with the hash: UCR blue "#2A78D6", ' +
      'UCR gold "#F1B82D". Some decor shapes are marked "not colorable" and will refuse.',
    inputSchema: {
      type: 'object',
      properties: {
        slide_id: { type: 'string' },
        target_id: { type: 'string', description: 'An element id or a decor id from ppt_show.' },
        color: { type: 'string', description: 'Hex with hash, e.g. "#14315A".' },
      },
      required: ['slide_id', 'target_id', 'color'],
    },
  },
  {
    name: 'ppt_set_outline',
    roles: ['worker'],
    description:
      'Set the outline color of one text-backed card element without changing its fill, text, geometry, or corners. ' +
      'Use an element id from ppt_show and an exact #RRGGBB color, usually the peer card fill color.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slide_id: { type: 'string', minLength: 1 },
        element_id: { type: 'string', minLength: 1, description: 'A text-backed card element id from ppt_show.' },
        color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$', description: 'Outline color as exact #RRGGBB hex.' },
      },
      required: ['slide_id', 'element_id', 'color'],
    },
  },
  {
    name: 'ppt_set_corners',
    roles: ['worker'],
    description:
      'Convert one eligible imported box/card AutoShape to true sharp 90-degree rectangle corners while preserving ' +
      'its text, style, box, z-order, shape identity, and animation target. This refuses placeholders, text boxes, ' +
      'pictures, media, lines/connectors, groups, circles/icons, and generated objects. Use target_id from ppt_show.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slide_id: { type: 'string', minLength: 1 },
        target_id: { type: 'string', minLength: 1, description: 'Eligible imported element or decor id from ppt_show.' },
        corners: { type: 'string', enum: ['sharp'], description: 'Only sharp is supported.' },
      },
      required: ['slide_id', 'target_id', 'corners'],
    },
  },
  {
    name: 'ppt_set_box',
    roles: ['worker'],
    description:
      'Move or resize an imported backing shape, generated decor item, or native text element. Native text with no ' +
      'current box needs x, y, w, and h together for its first explicit placement. x, y, w, h are FRACTIONS of the slide from 0 to 1, not inches and ' +
      'not points: x=0.5 is the horizontal middle, w=0.9 is 90 percent of the slide width. Pass only the ones you ' +
      'want to change. Read the current box from ppt_show first and adjust from there, do not guess.',
    inputSchema: {
      type: 'object',
      properties: {
        slide_id: { type: 'string' },
        target_id: { type: 'string', description: 'An element id or a decor id from ppt_show.' },
        x: { type: 'number', description: 'Left edge, fraction of slide width, 0 to 1.' },
        y: { type: 'number', description: 'Top edge, fraction of slide height, 0 to 1.' },
        w: { type: 'number', description: 'Width, fraction of slide width, 0 to 1.' },
        h: { type: 'number', description: 'Height, fraction of slide height, 0 to 1.' },
      },
      required: ['slide_id', 'target_id'],
    },
  },
  {
    name: 'ppt_add_shape',
    roles: ['worker'],
    description:
      'Add a generated solid-color rectangle to an imported slide or a suite-native add-slide slide. On imported ' +
      'slides it sits above backing content without replacing it; on native slides generated decor follows model order behind native text. It does not alter a backing ' +
      'PowerPoint shape. x, y, w, h are fractions of slide width and height from 0 to 1, and width/height must ' +
      'be greater than zero. Returns the new decor id for ppt_show, ppt_set_fill, ppt_set_box, and ppt_delete_shape.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slide_id: { type: 'string', minLength: 1, description: 'Slide id from ppt_show, e.g. "s1".' },
        fill: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$', description: 'Rectangle fill as exact #RRGGBB hex.' },
        x: { type: 'number', minimum: 0, maximum: 1, description: 'Left edge, fraction of slide width.' },
        y: { type: 'number', minimum: 0, maximum: 1, description: 'Top edge, fraction of slide height.' },
        w: { type: 'number', exclusiveMinimum: 0, maximum: 1, description: 'Width, fraction of slide width.' },
        h: { type: 'number', exclusiveMinimum: 0, maximum: 1, description: 'Height, fraction of slide height.' },
      },
      required: ['slide_id', 'fill', 'x', 'y', 'w', 'h'],
    },
  },
  {
    name: 'ppt_add_image',
    roles: ['worker'],
    description:
      'Insert a local PNG, JPEG, or animated GIF from this project\'s assets folder as a generated picture on ' +
      'an imported or suite-native slide. The source may be an absolute path inside Presentation/assets or a project-relative ' +
      'path such as "assets/nested-prompt-kaiju-v1.png"; paths outside assets are refused. x, y, w, h are ' +
      'fractions from 0 to 1. A human-granted task_id may authorize this operation only on a protected slide named by that task. ' +
      'Returns a decor id that can be moved, animated, or deleted.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slide_id: { type: 'string', minLength: 1, description: 'Slide id from ppt_show.' },
        source: { type: 'string', minLength: 1, description: 'Existing PNG/JPEG/GIF path inside Presentation/assets.' },
        x: { type: 'number', minimum: 0, maximum: 1, description: 'Left edge, fraction of slide width.' },
        y: { type: 'number', minimum: 0, maximum: 1, description: 'Top edge, fraction of slide height.' },
        w: { type: 'number', exclusiveMinimum: 0, maximum: 1, description: 'Width, fraction of slide width.' },
        h: { type: 'number', exclusiveMinimum: 0, maximum: 1, description: 'Height, fraction of slide height.' },
        task_id: {
          type: 'string', minLength: 1,
          description: 'Optional human-granted task id for this image operation on a protected slide.'
        },
      },
      required: ['slide_id', 'source', 'x', 'y', 'w', 'h'],
    },
  },
  {
    name: 'ppt_add_video',
    roles: ['worker'],
    description:
      'Embed a local H.264 MP4 from this project\'s assets folder as generated media on an imported or suite-native slide. ' +
      'The source may be an absolute path inside Presentation/assets or a normalized project-relative path ' +
      'such as "assets/demo.mp4"; non-MP4 files and paths outside assets are refused. The MP4 is stored inside ' +
      'the PowerPoint package, never linked. x, y, w, h are fractions from 0 to 1. Autoplay and loop both ' +
      'default to true. Returns a media decor id that can be moved or deleted but not object-animated.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slide_id: { type: 'string', minLength: 1, description: 'Slide id from ppt_show.' },
        source: { type: 'string', minLength: 1, description: 'Existing MP4 path inside Presentation/assets.' },
        x: { type: 'number', minimum: 0, maximum: 1, description: 'Left edge, fraction of slide width.' },
        y: { type: 'number', minimum: 0, maximum: 1, description: 'Top edge, fraction of slide height.' },
        w: { type: 'number', exclusiveMinimum: 0, maximum: 1, description: 'Width, fraction of slide width.' },
        h: { type: 'number', exclusiveMinimum: 0, maximum: 1, description: 'Height, fraction of slide height.' },
        autoplay: { type: 'boolean', description: 'Play on slide entry; defaults to true.' },
        loop: { type: 'boolean', description: 'Loop until the slide advances; defaults to true.' },
      },
      required: ['slide_id', 'source', 'x', 'y', 'w', 'h'],
    },
  },
  {
    name: 'ppt_set_image',
    roles: ['worker'],
    description:
      'Update an existing generated picture in place. Pass the picture decor id from ppt_show and a replacement ' +
      'image path inside Presentation/assets. This preserves the decor id, box, z-order, and object-history ' +
      'identity instead of deleting and re-adding the picture.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slide_id: { type: 'string', minLength: 1, description: 'Slide id from ppt_show.' },
        decor_id: { type: 'string', minLength: 1, description: 'Generated picture decor id from ppt_show.' },
        source: { type: 'string', minLength: 1, description: 'Replacement image path inside Presentation/assets.' },
      },
      required: ['slide_id', 'decor_id', 'source'],
    },
  },
  {
    name: 'ppt_set_media',
    roles: ['worker'],
    description:
      'Update an existing generated video in place. Pass the media decor id from ppt_show and at least one of source, ' +
      'autoplay, or loop. A replacement source must be an existing MP4 inside Presentation/assets. This preserves the ' +
      'decor id, box, z-order, and object-history identity instead of deleting and re-adding the video.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slide_id: { type: 'string', minLength: 1, description: 'Slide id from ppt_show.' },
        decor_id: { type: 'string', minLength: 1, description: 'Generated media decor id from ppt_show.' },
        source: { type: 'string', minLength: 1, description: 'Optional replacement MP4 path inside Presentation/assets.' },
        autoplay: { type: 'boolean', description: 'Optional play-on-entry setting.' },
        loop: { type: 'boolean', description: 'Optional loop-until-advance setting.' },
      },
      required: ['slide_id', 'decor_id'],
      anyOf: [
        { required: ['source'] },
        { required: ['autoplay'] },
        { required: ['loop'] },
      ],
    },
  },
  {
    name: 'ppt_set_animation',
    roles: ['worker'],
    description:
      'Add, replace, or remove a real PowerPoint entrance build for an element or non-media decor item. Effects are appear, ' +
      'fade, wipe, and rise-up. Use click for a presenter-controlled reveal, with-previous for simultaneous ' +
      'items, or after-previous for an automatic sequence. The slide animation list is the playback order; call ' +
      'the tool in that order or pass index. Set effect=none to remove the target\'s build. PowerPoint authors ' +
      'the native timing XML during render, so these builds work in the downloaded PPTX.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slide_id: { type: 'string', minLength: 1, description: 'Slide id from ppt_show.' },
        target_id: { type: 'string', minLength: 1, description: 'Element or decor id from ppt_show.' },
        effect: { type: 'string', enum: ['appear', 'fade', 'wipe', 'rise-up', 'none'] },
        trigger: { type: 'string', enum: ['click', 'with-previous', 'after-previous'], description: 'Defaults to click.' },
        duration: { type: 'number', minimum: 0.1, maximum: 10, description: 'Seconds; defaults to 0.1 for appear and 0.5 otherwise.' },
        delay: { type: 'number', minimum: 0, maximum: 30, description: 'Seconds after the trigger; defaults to 0.' },
        index: { type: 'integer', minimum: 0, description: 'Optional 0-based position in the slide build sequence.' },
      },
      required: ['slide_id', 'target_id', 'effect'],
    },
  },
  {
    name: 'ppt_delete_shape',
    roles: ['worker'],
    description:
      'Delete a generated rectangle, image, or video created by ppt_add_shape, ppt_add_image, or ppt_add_video. This intentionally ' +
      'refuses imported or backed decorative shapes, because deleting those would modify source slide content. ' +
      'Get decor_id from ppt_show after creating the object.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slide_id: { type: 'string', minLength: 1, description: 'Slide id from ppt_show.' },
        decor_id: { type: 'string', minLength: 1, description: 'Generated rectangle/image/media decor id from ppt_show.' },
      },
      required: ['slide_id', 'decor_id'],
    },
  },
  {
    name: 'ppt_add_slide',
    roles: ['worker'],
    description:
      'Add a slide. The deck is a roughly 16 slide, 12 minute talk on a hard cap, so adding one costs time ' +
      'somewhere else: check ppt_time after. Returns the new slide id.',
    inputSchema: {
      type: 'object',
      properties: {
        layout: { type: 'string', description: 'Layout name, default "content". Copy one from an existing slide in ppt_show.' },
        title: { type: 'string', description: 'Title text for the new slide.' },
        after: { type: 'string', description: 'Insert after this slide id.' },
        index: { type: 'number', description: 'Insert at this 0-based position instead.' },
      },
    },
  },
  {
    name: 'ppt_delete_slide',
    roles: ['worker'],
    description:
      'Delete a slide and everything on it. You cannot undo this, and neither can any agent. Only do it when the ' +
      'human or your task explicitly asked for it.',
    inputSchema: {
      type: 'object',
      properties: { slide_id: { type: 'string' } },
      required: ['slide_id'],
    },
  },
  {
    name: 'ppt_move_slide',
    roles: ['worker'],
    description: 'Move a slide to a new position. index is 0-based, so index 0 makes it the first slide.',
    inputSchema: {
      type: 'object',
      properties: {
        slide_id: { type: 'string' },
        index: { type: 'number', description: '0-based target position.' },
      },
      required: ['slide_id', 'index'],
    },
  },
  {
    name: 'ppt_set_layout',
    roles: ['worker'],
    description: 'Change a slide\'s layout. Use a layout name you have already seen in ppt_show, not an invented one.',
    inputSchema: {
      type: 'object',
      properties: {
        slide_id: { type: 'string' },
        layout: { type: 'string' },
      },
      required: ['slide_id', 'layout'],
    },
  },
  {
    name: 'ppt_set_transition',
    roles: ['worker'],
    description:
      'Set a slide transition. Supported effects are fade and none. Fade duration is measured in seconds, ' +
      'defaults to 0.35, and must be from 0.1 through 10. Transitions always advance on click only and never ' +
      'include a sound.',
    inputSchema: {
      type: 'object',
      properties: {
        slide_id: { type: 'string' },
        effect: { type: 'string', enum: ['fade', 'none'] },
        duration: {
          type: 'number',
          minimum: 0.1,
          maximum: 10,
          default: 0.35,
          description: 'Fade duration in seconds. Optional for fade (default 0.35); omit for none.',
        },
      },
      required: ['slide_id', 'effect'],
    },
  },
  {
    name: 'ppt_add_element',
    roles: ['worker'],
    description:
      'Add a new text element to a slide. Pass text for a single block, or items for a bullet list, not both. ' +
      'Returns the new element id. New elements inherit deck defaults, so check ppt_lint after to confirm the ' +
      '20pt minimum and the single font family still hold.',
    inputSchema: {
      type: 'object',
      properties: {
        slide_id: { type: 'string' },
        element_type: { type: 'string', description: 'Element type, e.g. "title" or "body". Copy one from ppt_show. Defaults to "body".' },
        text: { type: 'string', description: 'Text for a single block element.' },
        items: { type: 'array', items: { type: 'string' }, description: 'Bullet items, if this is a list.' },
        index: { type: 'number', description: '0-based position among the slide\'s elements. Appends if omitted.' },
      },
      required: ['slide_id'],
    },
  },
  {
    name: 'ppt_delete_element',
    roles: ['worker'],
    description: 'Remove one element from a slide. Prefer ppt_set_text to change wording, this throws the element away.',
    inputSchema: {
      type: 'object',
      properties: {
        slide_id: { type: 'string' },
        element_id: { type: 'string' },
      },
      required: ['slide_id', 'element_id'],
    },
  },
  {
    name: 'ppt_set_presentation_title',
    roles: ['worker'],
    description: 'Set the title of the whole presentation (the deck\'s name, not the text on slide 1).',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
];

const VISIBLE = TOOLS.filter((t) => t.roles.includes(ROLE));
const VISIBLE_BY_NAME = new Map(VISIBLE.map((t) => [t.name, t]));

// -------------------------------------------------------------- dispatch

async function call(name, a = {}) {
  if (!VISIBLE_BY_NAME.has(name)) {
    // Naming the role matters: a lead that tries to edit should learn to
    // dispatch the work instead of retrying a tool it will never have.
    const known = TOOLS.some((t) => t.name === name);
    return fail(known
      ? `Tool ${name} is not available to a ${ROLE}. ${ROLE === 'lead'
          ? 'Leads do not edit the deck directly: dispatch it to a worker with ppt_task.'
          : 'Workers do not dispatch or pin: post to the board with ppt_note instead.'}`
      : `Unknown tool: ${name}. Available: ${VISIBLE.map((t) => t.name).join(', ')}`);
  }

  // ---- reading
  if (name === 'ppt_show') {
    const s = await state();
    if (!s.ok) return fail(s.text);
    return text(renderOutline(s.body, a));
  }

  if (name === 'ppt_search') {
    const s = await state();
    if (!s.ok) return fail(s.text);
    const needle = String(a.query || '').toLowerCase();
    if (!needle) return fail('ppt_search needs a query.');
    const limit = Number(a.limit) > 0 ? Number(a.limit) : 40;
    const hits = [];
    s.body.model.slides.forEach((sl, i) => {
      const add = (where, body) => {
        if (body != null && String(body).toLowerCase().includes(needle)) {
          hits.push(`${sl.id} (slide ${i + 1}) ${where}: ${clip(body, 140)}`);
        }
      };
      (sl.elements || []).forEach((e) => {
        if (e.items) e.items.forEach((it, n) => add(`${e.id} item ${n}`, it));
        else add(e.id, e.text);
      });
      add('notes', sl.notes);
    });
    if (!hits.length) return text(`No match for ${JSON.stringify(a.query)}.`);
    const shown = hits.slice(0, limit);
    return text(`${hits.length} match(es):\n` + shown.join('\n') +
      (hits.length > shown.length ? `\n(${hits.length - shown.length} more, narrow the query)` : ''));
  }

  if (name === 'ppt_board') {
    const r = await api('GET', '/api/board');
    if (r.status !== 200) return fail(refusal(r, 'read board'));
    if (!r.body || !Array.isArray(r.body.notes)) return fail('The suite returned a malformed board response.');
    const notes = r.body.notes;
    const pins = notes.filter((n) => n.pinned);
    const msgs = notes.filter((n) => !n.pinned).slice(0, Number(a.limit) > 0 ? Number(a.limit) : 12);
    const out = ['HOUSE RULES (from the human, binding):'];
    if (!pins.length) out.push('  (none pinned)');
    pins.forEach((n) => out.push(`  - ${n.text}  [${n.id}]`));
    out.push('', 'recent messages:');
    if (!msgs.length) out.push('  (none)');
    msgs.forEach((n) => out.push(`  ${new Date(n.ts).toLocaleString()}  ${n.author}: ${clip(n.text, 220)}`));
    return text(out.join('\n'));
  }

  if (name === 'ppt_lint') {
    // lint_fonts.py has its own 30s legal window, so the transport must not
    // declare the suite dead at the ordinary 15s MCP deadline.
    const r = await api('GET', '/api/lint', undefined, 45000);
    if (r.status !== 200) return fail(refusal(r, 'lint'));
    const { rev, ok, count, issues } = r.body || {};
    if (!Number.isInteger(rev) || typeof ok !== 'boolean' ||
        !Number.isInteger(count) || !Array.isArray(issues)) {
      return fail('The suite returned a malformed lint response.');
    }
    if (ok) return text(`Lint clean at rev ${rev}: no house-rule violations.`);
    return text(`${count} house-rule violation(s) at rev ${rev}:\n` +
      (issues || []).map((i) => `  [${i.type}] ${i.slideId}${i.elementId ? ' ' + i.elementId : ''}  ${i.detail}${i.text ? `  "${clip(i.text, 90)}"` : ''}`).join('\n'));
  }

  if (name === 'ppt_time') {
    const r = await api('GET', '/api/timing');
    if (r.status !== 200) return fail(refusal(r, 'timing'));
    const t = r.body || {};
    if (typeof t.totalSeconds !== 'number' || typeof t.totalWords !== 'number' ||
        typeof t.wpm !== 'number' || !Array.isArray(t.perSlide)) {
      return fail('The suite returned a malformed timing response.');
    }
    const mmss = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    const per = (t.perSlide || []).map((s) => `${s.slideId} ${s.words}w ~${mmss(s.seconds)}`).join(', ');
    const verdict = t.overCap
      ? 'OVER the 12:00 hard cap, trim the longest slides first.'
      : t.overTarget ? 'over the 11:00 target but under the hard cap, some headroom left.'
      : 'within the 11:00 target.';
    return text(
      `Estimated ~${mmss(t.totalSeconds)} for ${t.totalWords} words at ${t.wpm}wpm (target ${mmss(t.targetSeconds)}, hard cap ${mmss(t.capSeconds)}).\n` +
      `${verdict}\nper slide: ${per}\n(estimate from visible slide text, not a real rehearsal)`);
  }

  if (name === 'ppt_locks') {
    const r = await api('GET', '/api/locks');
    if (r.status !== 200) return fail(refusal(r, 'locks'));
    const locks = (r.body && r.body.locks) || [];
    if (!locks.length) return text('No slides are locked.');
    return text('Locked slides (advisory):\n' + locks.map((l) =>
      `  ${l.slideId} by ${l.by}${l.by === EDITOR ? ' (you)' : ''}  ${Math.round((Date.now() - l.ts) / 60000)}m ago${l.note ? ` - ${l.note}` : ''}`).join('\n'));
  }

  // ---- lead: dispatch and oversight
  if (name === 'ppt_task') {
    if (!a.text) return fail('ppt_task needs text.');
    const assignee = a.assignee || '';
    const r = await api('POST', '/api/tasks', {
      text: a.text, by: EDITOR, assignee, wakeWorker: !!assignee,
    });
    if (r.status !== 200) return fail(refusal(r, 'add task'));
    const id = (r.body && r.body.task && r.body.task.id) || (r.body && r.body.id) || '?';
    const dispatch = r.body && r.body.dispatch;
    if (!a.assignee) {
      return text(`Task ${id} was stored unassigned. No worker was woken; assign future work to ${ASSIGNEE_RANGE} to dispatch it immediately.`);
    }
    if (dispatch && dispatch.ok) {
      return text(`Task ${id} was assigned to ${a.assignee} and ${dispatch.action === 'spawn' ? 'spawned' : 'woke'} that worker.`);
    }
    const reason = dispatch && dispatch.reason ? `: ${dispatch.reason}` : '';
    return text(`Task ${id} was stored for ${a.assignee}, but it could not be delivered${reason}. It remains on the shared queue.`);
  }

  if (name === 'ppt_task_update') {
    if (!a.id) return fail('ppt_task_update needs the task id.');
    const hasText = Object.prototype.hasOwnProperty.call(a, 'text');
    const hasAssignee = Object.prototype.hasOwnProperty.call(a, 'assignee');
    const hasWake = Object.prototype.hasOwnProperty.call(a, 'wakeWorker');
    if (!hasText && !hasAssignee && !hasWake) {
      return fail('ppt_task_update needs text, assignee, or wakeWorker.');
    }
    const body = { id: a.id, by: EDITOR };
    if (hasText) body.text = a.text;
    if (hasAssignee) body.assignee = a.assignee;
    if (hasWake) body.wakeWorker = a.wakeWorker;
    const r = await api('POST', '/api/tasks/update', body);
    if (r.status !== 200 || !r.body || r.body.ok === false) return fail(refusal(r, 'update task'));
    const task = r.body.task || {};
    const assigned = task.assignee || 'unassigned';
    if (task.wakeWorker === false) {
      return text(`Task ${task.id || a.id} is held for ${assigned}. It remains durable and will not auto-run after restart.`);
    }
    const dispatch = r.body.dispatch;
    if (dispatch && dispatch.ok) {
      return text(`Task ${task.id || a.id} was updated for ${assigned} and ${dispatch.action === 'spawn' ? 'spawned' : 'woke'} that worker.`);
    }
    if (dispatch && dispatch.ok === false) {
      return text(`Task ${task.id || a.id} was updated for ${assigned} and remains queued; it was not delivered: ${dispatch.reason || 'worker wake failed'}.`);
    }
    return text(`Task ${task.id || a.id} was updated for ${assigned}.`);
  }

  if (name === 'ppt_tasks') {
    const r = await api('GET', '/api/tasks');
    if (r.status !== 200) return fail(refusal(r, 'read tasks'));
    let tasks = (r.body && r.body.tasks) || [];
    if (a.mine) tasks = tasks.filter((t) => t.assignee === EDITOR || t.claimedBy === EDITOR);
    const active = tasks.filter((t) => t.status !== 'done');
    const done = tasks.filter((t) => t.status === 'done').slice(0, 6);
    const out = [];
    out.push(active.length ? 'open tasks:' : 'No open tasks.');
    active.forEach((t) => out.push(`  ${t.status === 'claimed' ? '[claimed]' : '[open]   '} ${t.text}  -> ${t.assignee || 'anyone'}${t.claimedBy ? ` (by ${t.claimedBy})` : ''}  [${t.id}]`));
    if (done.length) {
      out.push('recently done:');
      done.forEach((t) => out.push(`  done ${clip(t.text, 90)}  [${t.id}]`));
    }
    return text(out.join('\n'));
  }

  if (name === 'ppt_task_done') {
    if (!a.id) return fail('ppt_task_done needs the task id.');
    const r = await api('POST', '/api/tasks/done', { id: a.id, by: EDITOR });
    if (r.status !== 200) return fail(refusal(r, 'finish task'));
    return text(`Task ${a.id} marked done.`);
  }

  if (name === 'ppt_loop') {
    if (!a.text) return fail('ppt_loop needs text.');
    const r = await api('POST', '/api/loops', { text: a.text, author: EDITOR, cadence: a.cadence || '' });
    if (r.status !== 200) return fail(refusal(r, 'add loop'));
    const id = (r.body && r.body.loop && r.body.loop.id) || (r.body && r.body.id) || '?';
    return text(`Standing loop ${id} added${a.cadence ? ` (every ${a.cadence})` : ''}. Storing it does not run it: a session has to re-read the loop list each pass.`);
  }

  if (name === 'ppt_loop_ran') {
    if (!a.id) return fail('ppt_loop_ran needs the loop id.');
    const r = await api('POST', '/api/loops/ran', { id: a.id, by: EDITOR, result: a.result || '' });
    if (r.status !== 200) return fail(refusal(r, 'record loop pass'));
    return text(`Recorded a pass on loop ${a.id}.`);
  }

  if (name === 'ppt_pin' || name === 'ppt_note') {
    if (!a.text) return fail(`${name} needs text.`);
    const pinned = name === 'ppt_pin';
    const r = await api('POST', '/api/board', { text: a.text, author: EDITOR, pinned });
    if (r.status !== 200) return fail(refusal(r, 'post to board'));
    return text(pinned
      ? `Pinned as a house rule. Every session now sees it as binding.`
      : `Posted to the board as ${EDITOR}.`);
  }

  if (name === 'ppt_agents') {
    const r = await api('GET', '/api/agents');
    if (r.status !== 200) return fail(refusal(r, 'read agents'));
    const agents = (r.body && r.body.agents) || [];
    if (!agents.length) return text('No agents are running.');
    return text('agents:\n' + agents.map((g) =>
      `  ${g.name} (${g.role || '?'}) ${g.status || '?'}${g.task ? ` - ${clip(g.task, 70)}` : ''}`).join('\n'));
  }

  if (name === 'ppt_history') {
    const r = await api('GET', '/api/history');
    if (r.status !== 200) return fail(refusal(r, 'read history'));
    const undo = (r.body && r.body.undo) || [];
    if (!undo.length) return text('No edits in the trail yet.');
    return text('recent edits (newest first, read only, agents cannot undo):\n' + undo.slice(0, 12).map((h) =>
      `  ${new Date(h.ts).toLocaleTimeString()}  ${h.editor}  ${h.detail}`).join('\n'));
  }

  // ---- worker: locks
  if (name === 'ppt_lock') {
    const ids = Array.isArray(a.slide_ids) ? a.slide_ids : [];
    if (!ids.length) return fail('ppt_lock needs slide_ids, e.g. ["s4","s5"].');
    const r = await api('POST', '/api/locks', { slideIds: ids, by: EDITOR, note: a.note || '' });
    if (r.status !== 200) return fail(refusal(r, 'lock'));
    const locked = Array.isArray(r.body && r.body.locked) ? r.body.locked : [];
    const conflicts = Array.isArray(r.body && r.body.conflicts) ? r.body.conflicts : [];
    const unknown = Array.isArray(r.body && r.body.unknown) ? r.body.unknown : [];
    if (locked.length !== ids.length) {
      const detail = [
        locked.length ? `acquired: ${locked.join(', ')}` : 'acquired: none',
        conflicts.length ? `held by others: ${conflicts.map((c) => `${c.slideId} (${c.heldBy})`).join(', ')}` : '',
        unknown.length ? `unknown: ${unknown.join(', ')}` : '',
      ].filter(Boolean).join('; ');
      const cleanup = locked.length
        ? ` Release the acquired lock${locked.length === 1 ? '' : 's'} before changing course.`
        : '';
      return fail(`Lock incomplete (${detail}). Do not edit slides you did not lock.${cleanup}`);
    }
    return text(`Locked ${locked.join(', ')}. Call ppt_unlock as soon as you are done.`);
  }

  if (name === 'ppt_unlock') {
    if (a.all !== undefined && typeof a.all !== 'boolean') {
      return fail('ppt_unlock all must be a boolean.');
    }
    const all = a.all === true;
    const ids = Array.isArray(a.slide_ids) ? a.slide_ids : [];
    if (!all && !ids.length) return fail('ppt_unlock needs slide_ids, or all=true.');
    const r = await api('POST', '/api/locks/release', { slideIds: all ? 'all' : ids, by: EDITOR });
    if (r.status !== 200) return fail(refusal(r, 'unlock'));
    const notMine = Array.isArray(r.body && r.body.notMine) ? r.body.notMine : [];
    if (notMine.length) {
      return fail(`Did not release ${notMine.join(', ')} because ${notMine.length === 1 ? 'it is' : 'they are'} held by another editor.`);
    }
    if (!r.body || r.body.released !== true) {
      return fail(all ? 'You held no locks to release.' : `You held no requested lock on ${ids.join(', ')}.`);
    }
    return text(all ? 'Released every lock you held.' : `Released the locks you held among ${ids.join(', ')}.`);
  }

  // ---- worker: deck edits. Each one builds the op shape the server validates.
  if (name === 'ppt_set_text') {
    const r = await edit({ type: 'set-text', slideId: a.slide_id, elementId: a.element_id, text: a.text });
    if (!r.ok) return fail(r.text);
    return text(`Set ${a.slide_id} ${a.element_id} (rev ${r.body.rev}).`);
  }

  if (name === 'ppt_set_bullets') {
    if (!Array.isArray(a.items)) return fail('ppt_set_bullets needs items, an array of strings.');
    const r = await edit({ type: 'set-bullets', slideId: a.slide_id, elementId: a.element_id, items: a.items });
    if (!r.ok) return fail(r.text);
    return text(`Set ${a.items.length} bullet(s) on ${a.slide_id} ${a.element_id} (rev ${r.body.rev}).`);
  }

  if (name === 'ppt_set_notes') {
    const r = await edit({ type: 'set-notes', slideId: a.slide_id, text: a.text });
    if (!r.ok) return fail(r.text);
    return text(`Speaker notes set on ${a.slide_id} (rev ${r.body.rev}). Check ppt_time if you changed the length.`);
  }

  if (name === 'ppt_set_style') {
    const op = { type: 'set-style', slideId: a.slide_id, elementId: a.element_id };
    // Only forward what was actually passed: an undefined here would blank a
    // property the agent never mentioned.
    for (const k of ['color', 'size', 'bold', 'align', 'font']) if (a[k] !== undefined) op[k] = a[k];
    if (Object.keys(op).length === 3) return fail('ppt_set_style needs at least one of color, size, bold, align, font.');
    const r = await edit(op);
    if (!r.ok) return fail(r.text);
    return text(`Style set on ${a.slide_id} ${a.element_id} (rev ${r.body.rev}).`);
  }

  if (name === 'ppt_set_fill') {
    // The server resolves an element id or a decor id off the same field pair,
    // exactly as the ppt CLI does, so send the target as both.
    const r = await edit({ type: 'set-fill', slideId: a.slide_id, elementId: a.target_id, decorId: a.target_id, color: a.color });
    if (!r.ok) return fail(r.text);
    return text(`Fill ${a.color} set on ${a.slide_id} ${a.target_id} (rev ${r.body.rev}).`);
  }

  if (name === 'ppt_set_outline') {
    const r = await edit({
      type: 'set-outline',
      slideId: a.slide_id,
      elementId: a.element_id,
      color: a.color,
    });
    if (!r.ok) return fail(r.text);
    return text(`Outline ${a.color} set on ${a.slide_id} ${a.element_id} (rev ${r.body.rev}).`);
  }

  if (name === 'ppt_set_corners') {
    if (typeof a.slide_id !== 'string' || !a.slide_id ||
        typeof a.target_id !== 'string' || !a.target_id) {
      return fail('ppt_set_corners needs slide_id and target_id from ppt_show.');
    }
    if (a.corners !== 'sharp') {
      return fail('ppt_set_corners corners must be sharp.');
    }
    const r = await edit({
      type: 'set-corners',
      slideId: a.slide_id,
      targetId: a.target_id,
      corners: 'sharp',
    });
    if (!r.ok) return fail(r.text);
    return text(`Sharp 90-degree corners set on ${a.slide_id} ${a.target_id} (rev ${r.body.rev}).`);
  }

  if (name === 'ppt_set_box') {
    const op = { type: 'set-box', slideId: a.slide_id, elementId: a.target_id, decorId: a.target_id };
    // Preserve the protocol value exactly. Number(null) is 0, so coercing here
    // used to turn a malformed/null coordinate into a valid far-left/top edit
    // and bypass the server's strict number check.
    for (const k of ['x', 'y', 'w', 'h']) if (a[k] !== undefined) op[k] = a[k];
    if (op.x === undefined && op.y === undefined && op.w === undefined && op.h === undefined) {
      return fail('ppt_set_box needs at least one of x, y, w, h, as fractions 0 to 1 of the slide.');
    }
    const r = await edit(op);
    if (!r.ok) return fail(r.text);
    return text(`Box set on ${a.slide_id} ${a.target_id} (rev ${r.body.rev}).`);
  }

  if (name === 'ppt_add_shape') {
    if (typeof a.slide_id !== 'string' || !a.slide_id) {
      return fail('ppt_add_shape needs slide_id from ppt_show.');
    }
    if (!isHexColor(a.fill)) {
      return fail('ppt_add_shape fill must be exact #RRGGBB hex.');
    }
    for (const k of ['x', 'y', 'w', 'h']) {
      if (!isUnitNumber(a[k], k === 'w' || k === 'h')) {
        return fail(`ppt_add_shape ${k} must be a finite number ${k === 'w' || k === 'h' ? 'greater than 0 and ' : ''}from 0 to 1.`);
      }
    }
    const op = {
      type: 'add-shape',
      slideId: a.slide_id,
      shapeType: 'rect',
      fill: a.fill,
      x: a.x,
      y: a.y,
      w: a.w,
      h: a.h,
    };
    const r = await edit(op);
    if (!r.ok) return fail(r.text);
    const decorId = r.body.affected && r.body.affected.decorId;
    return text(`Added generated rectangle ${decorId || '?'} to ${a.slide_id} (rev ${r.body.rev}). Call ppt_show to verify its overlay position.`);
  }

  if (name === 'ppt_add_image') {
    if (typeof a.slide_id !== 'string' || !a.slide_id) {
      return fail('ppt_add_image needs slide_id from ppt_show.');
    }
    if (typeof a.source !== 'string' || !a.source.trim()) {
      return fail('ppt_add_image needs an existing PNG, JPEG, or GIF source inside Presentation/assets.');
    }
    for (const k of ['x', 'y', 'w', 'h']) {
      if (!isUnitNumber(a[k], k === 'w' || k === 'h')) {
        return fail(`ppt_add_image ${k} must be a finite number ${k === 'w' || k === 'h' ? 'greater than 0 and ' : ''}from 0 to 1.`);
      }
    }
    if (a.task_id !== undefined && (typeof a.task_id !== 'string' || !a.task_id.trim())) {
      return fail('ppt_add_image task_id must be a non-empty string when supplied.');
    }
    const r = await edit({
      type: 'add-image',
      slideId: a.slide_id,
      source: a.source,
      x: a.x,
      y: a.y,
      w: a.w,
      h: a.h,
    }, a.task_id === undefined ? undefined : a.task_id.trim());
    if (!r.ok) return fail(r.text);
    const decorId = r.body.affected && r.body.affected.decorId;
    return text(`Added local image ${decorId || '?'} to ${a.slide_id} (rev ${r.body.rev}). Call ppt_show to verify its position before animating it.`);
  }

  if (name === 'ppt_add_video') {
    if (typeof a.slide_id !== 'string' || !a.slide_id) {
      return fail('ppt_add_video needs slide_id from ppt_show.');
    }
    if (typeof a.source !== 'string' || !a.source.trim()) {
      return fail('ppt_add_video needs an existing H.264 MP4 source inside Presentation/assets.');
    }
    for (const k of ['x', 'y', 'w', 'h']) {
      if (!isUnitNumber(a[k], k === 'w' || k === 'h')) {
        return fail(`ppt_add_video ${k} must be a finite number ${k === 'w' || k === 'h' ? 'greater than 0 and ' : ''}from 0 to 1.`);
      }
    }
    if (a.autoplay !== undefined && typeof a.autoplay !== 'boolean') {
      return fail('ppt_add_video autoplay must be true or false.');
    }
    if (a.loop !== undefined && typeof a.loop !== 'boolean') {
      return fail('ppt_add_video loop must be true or false.');
    }
    const r = await edit({
      type: 'add-video',
      slideId: a.slide_id,
      source: a.source,
      x: a.x,
      y: a.y,
      w: a.w,
      h: a.h,
      autoplay: a.autoplay === undefined ? true : a.autoplay,
      loop: a.loop === undefined ? true : a.loop,
    });
    if (!r.ok) return fail(r.text);
    const decorId = r.body.affected && r.body.affected.decorId;
    return text(`Added embedded video ${decorId || '?'} to ${a.slide_id} (rev ${r.body.rev}); autoplay=${a.autoplay === false ? 'off' : 'on'} loop=${a.loop === false ? 'off' : 'on'}. Call ppt_show to verify its box.`);
  }

  if (name === 'ppt_set_image') {
    if (typeof a.slide_id !== 'string' || !a.slide_id ||
        typeof a.decor_id !== 'string' || !a.decor_id) {
      return fail('ppt_set_image needs slide_id and a generated picture decor_id from ppt_show.');
    }
    if (typeof a.source !== 'string' || !a.source.trim()) {
      return fail('ppt_set_image source must be an existing image inside Presentation/assets.');
    }
    const r = await edit({ type: 'set-image', slideId: a.slide_id, decorId: a.decor_id, source: a.source });
    if (!r.ok) return fail(r.text);
    return text(`Updated image ${a.decor_id} on ${a.slide_id} to ${a.source} (rev ${r.body.rev}); id, box, and order preserved. Call ppt_show to verify.`);
  }

  if (name === 'ppt_set_media') {
    if (typeof a.slide_id !== 'string' || !a.slide_id ||
        typeof a.decor_id !== 'string' || !a.decor_id) {
      return fail('ppt_set_media needs slide_id and a generated media decor_id from ppt_show.');
    }
    const hasSource = a.source !== undefined;
    const hasAutoplay = a.autoplay !== undefined;
    const hasLoop = a.loop !== undefined;
    if (!hasSource && !hasAutoplay && !hasLoop) {
      return fail('ppt_set_media needs at least one of source, autoplay, or loop.');
    }
    if (hasSource && (typeof a.source !== 'string' || !a.source.trim())) {
      return fail('ppt_set_media source must be an existing MP4 inside Presentation/assets.');
    }
    if (hasAutoplay && typeof a.autoplay !== 'boolean') {
      return fail('ppt_set_media autoplay must be true or false.');
    }
    if (hasLoop && typeof a.loop !== 'boolean') {
      return fail('ppt_set_media loop must be true or false.');
    }
    const op = { type: 'set-media', slideId: a.slide_id, decorId: a.decor_id };
    if (hasSource) op.source = a.source;
    if (hasAutoplay) op.autoplay = a.autoplay;
    if (hasLoop) op.loop = a.loop;
    const r = await edit(op);
    if (!r.ok) return fail(r.text);
    const changes = [];
    if (hasSource) changes.push(`source=${a.source}`);
    if (hasAutoplay) changes.push(`autoplay=${a.autoplay ? 'on' : 'off'}`);
    if (hasLoop) changes.push(`loop=${a.loop ? 'on' : 'off'}`);
    return text(`Updated embedded video ${a.decor_id} on ${a.slide_id} (rev ${r.body.rev}); ${changes.join(' ')}. Its id, box, order, and history were preserved.`);
  }

  if (name === 'ppt_set_animation') {
    if (typeof a.slide_id !== 'string' || !a.slide_id ||
        typeof a.target_id !== 'string' || !a.target_id) {
      return fail('ppt_set_animation needs slide_id and target_id from ppt_show.');
    }
    if (!['appear', 'fade', 'wipe', 'rise-up', 'none'].includes(a.effect)) {
      return fail('ppt_set_animation effect must be appear, fade, wipe, rise-up, or none.');
    }
    const op = {
      type: 'set-animation',
      slideId: a.slide_id,
      targetId: a.target_id,
      effect: a.effect,
    };
    for (const key of ['trigger', 'duration', 'delay', 'index']) {
      if (a[key] !== undefined) op[key] = a[key];
    }
    const r = await edit(op);
    if (!r.ok) return fail(r.text);
    const setting = a.effect === 'none'
      ? 'removed'
      : `${a.effect}, ${a.trigger || 'click'} trigger`;
    return text(`Animation ${setting} on ${a.slide_id} ${a.target_id} (rev ${r.body.rev}). Render and open the PPTX in slide-show mode to verify playback.`);
  }

  if (name === 'ppt_delete_shape') {
    if (typeof a.slide_id !== 'string' || !a.slide_id || typeof a.decor_id !== 'string' || !a.decor_id) {
      return fail('ppt_delete_shape needs slide_id and a generated rectangle/image/media decor_id from ppt_show.');
    }
    const r = await edit({ type: 'delete-decor', slideId: a.slide_id, decorId: a.decor_id });
    if (!r.ok) return fail(r.text);
    return text(`Deleted generated object ${a.decor_id} from ${a.slide_id} (rev ${r.body.rev}).`);
  }

  if (name === 'ppt_add_slide') {
    const op = { type: 'add-slide', layout: a.layout || 'content' };
    if (a.title !== undefined) op.title = a.title;
    if (a.after !== undefined) op.after = a.after;
    if (a.index !== undefined) op.index = a.index;
    const r = await edit(op);
    if (!r.ok) return fail(r.text);
    return text(`Added slide ${r.body.affected && r.body.affected.slideId} (rev ${r.body.rev}). Call ppt_show to see its element ids, and ppt_time to check the budget.`);
  }

  if (name === 'ppt_delete_slide') {
    const r = await edit({ type: 'delete-slide', slideId: a.slide_id });
    if (!r.ok) return fail(r.text);
    return text(`Deleted slide ${a.slide_id} (rev ${r.body.rev}).`);
  }

  if (name === 'ppt_move_slide') {
    const r = await edit({ type: 'move-slide', slideId: a.slide_id, index: a.index });
    if (!r.ok) return fail(r.text);
    return text(`Moved ${a.slide_id} to position ${a.index} (rev ${r.body.rev}).`);
  }

  if (name === 'ppt_set_layout') {
    const r = await edit({ type: 'set-layout', slideId: a.slide_id, layout: a.layout });
    if (!r.ok) return fail(r.text);
    return text(`Layout of ${a.slide_id} set to ${a.layout} (rev ${r.body.rev}).`);
  }

  if (name === 'ppt_set_transition') {
    if (a.effect !== 'fade' && a.effect !== 'none') {
      return fail('ppt_set_transition effect must be fade or none.');
    }
    if (a.effect === 'none' && a.duration !== undefined) {
      return fail('ppt_set_transition duration is only valid for fade.');
    }
    const op = { type: 'set-transition', slideId: a.slide_id, effect: a.effect };
    if (a.effect === 'fade') {
      // Preserve explicitly supplied values so the coordinator remains the
      // single validator. Only an omitted duration gets the documented default.
      op.duration = a.duration === undefined ? 0.35 : a.duration;
    }
    const r = await edit(op);
    if (!r.ok) return fail(r.text);
    const setting = a.effect === 'fade' ? `fade ${op.duration}s` : 'none';
    return text(`Transition on ${a.slide_id} set to ${setting}, click-only with no sound (rev ${r.body.rev}).`);
  }

  if (name === 'ppt_add_element') {
    const op = { type: 'add-element', slideId: a.slide_id, elementType: a.element_type || 'body' };
    if (Array.isArray(a.items)) op.items = a.items;
    else op.text = a.text || '';
    if (a.index !== undefined) op.index = a.index;
    const r = await edit(op);
    if (!r.ok) return fail(r.text);
    return text(`Added ${op.elementType} ${r.body.affected && r.body.affected.elementId} to ${a.slide_id} (rev ${r.body.rev}). Run ppt_lint to confirm it meets the 20pt and single-font rules.`);
  }

  if (name === 'ppt_delete_element') {
    const r = await edit({ type: 'delete-element', slideId: a.slide_id, elementId: a.element_id });
    if (!r.ok) return fail(r.text);
    return text(`Deleted ${a.element_id} from ${a.slide_id} (rev ${r.body.rev}).`);
  }

  if (name === 'ppt_set_presentation_title') {
    const r = await edit({ type: 'set-presentation-title', text: a.text });
    if (!r.ok) return fail(r.text);
    return text(`Presentation title set (rev ${r.body.rev}).`);
  }

  return fail(`Unhandled tool: ${name}`);
}

// -------------------------------------------------------------- JSON-RPC

function send(o) { process.stdout.write(JSON.stringify(o) + '\n'); }

let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(line);
  }
});

async function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch (_) { return; }
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: {
      // Echo the client's protocol version: safest across versions.
      protocolVersion: (params && params.protocolVersion) || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: `suite-ppt-${ROLE}`, version: '0.1.0' },
    } });
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') {
    return send({ jsonrpc: '2.0', id, result: {
      tools: VISIBLE.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    } });
  }
  if (method === 'tools/call') {
    try {
      const result = await call(params && params.name, (params && params.arguments) || {});
      return send({ jsonrpc: '2.0', id, result });
    } catch (e) {
      // A thrown tool must not kill the transport: the agent has no other way
      // to act, so a crashed stdio server ends its turn with no explanation.
      return send({ jsonrpc: '2.0', id, result: fail(`Tool crashed: ${e.message}`) });
    }
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } });
}

// Same reasoning as the try/catch above, one level up: stay alive and keep
// serving rather than exiting and stranding the agent.
process.on('uncaughtException', (e) => { try { process.stderr.write(`mcp-ppt uncaught: ${e.message}\n`); } catch (_) {} });
process.on('unhandledRejection', (e) => { try { process.stderr.write(`mcp-ppt rejection: ${e && e.message}\n`); } catch (_) {} });
