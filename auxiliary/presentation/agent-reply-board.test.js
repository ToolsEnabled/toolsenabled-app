#!/usr/bin/env node
'use strict';
/*
 * Lead replies must arrive through the same complete board event that human
 * posts use. The handler is deliberately extracted and exercised with the
 * real source so a future refactor cannot persist a reply while silently
 * dropping its live SSE payload.
 */
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
function take(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`agent reply handler markers missing: ${start}`);
  return source.slice(a, b);
}

const handlerSource = take("Agents.on('agent-reply', (r) => {", "\nAgents.on('agent-failed'");
const handlers = {};
const stored = [];
const broadcasts = [];
const Agents = { on(name, fn) { handlers[name] = fn; } };
function addNote(input) {
  const note = Object.assign({ id: `n${stored.length + 1}`, ts: 1 }, input);
  stored.push(note);
  return { ok: true, note };
}
function boardView() { return stored.slice().reverse(); }
function broadcast(payload) { broadcasts.push(payload); }

new Function('Agents', 'addNote', 'boardView', 'broadcast', 'console', handlerSource)(
  Agents, addNote, boardView, broadcast, { error: () => {} }
);

const checks = [];
function check(description, condition) { checks.push({ description, ok: !!condition }); }
const reply = handlers['agent-reply'];
check('agent-reply handler is registered', typeof reply === 'function');

reply({ role: 'lead', name: 'lead', text: '  Deck\nstatus   is ready  ' });
const sent = broadcasts[0];
check('lead reply is persisted once', stored.length === 1 && stored[0].text === 'Deck status is ready');
check('lead reply broadcasts its note', sent && sent.note === stored[0]);
check('lead reply broadcasts a complete notes array', sent && Array.isArray(sent.notes) && sent.notes[0] === stored[0]);
check('lead reply carries the normal board add action', sent && sent.type === 'board' && sent.action === 'add');

reply({ role: 'worker', name: 'worker-1', text: 'quiet worker update' });
reply({ role: 'lead', name: 'lead', text: '   \n\t ' });
check('worker and empty lead replies do not flood the board', stored.length === 1 && broadcasts.length === 1);

// A persistence failure is diagnostic-only: it must never make an undurable
// agent reply look like a normal board message to other viewers.
const failedHandlers = {};
const failedBroadcasts = [];
const FailedAgents = { on(name, fn) { failedHandlers[name] = fn; } };
new Function('Agents', 'addNote', 'boardView', 'broadcast', 'console', handlerSource)(
  FailedAgents,
  () => ({ ok: false, error: 'simulated board write failure' }),
  () => [],
  (payload) => failedBroadcasts.push(payload),
  { error: () => {} }
);
failedHandlers['agent-reply']({ role: 'lead', name: 'lead', text: 'this must not leak' });
check('an undurable lead reply is not broadcast as a board message', failedBroadcasts.length === 0);

const passed = checks.filter((item) => item.ok).length;
for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.description}`);
console.log(`\n${passed}/${checks.length} passed`);
process.exit(passed === checks.length ? 0 : 1);
