#!/usr/bin/env node
'use strict';
/*
 * Advisory claims must vanish as soon as their agent exits.  Execute the real
 * server helper and event wiring with a tiny emitter harness: manual stops,
 * crashes, and natural exits all use this one signal.
 */
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
function take(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`server markers missing: ${start}`);
  return source.slice(a, b);
}

const releaseSource = take('function releaseLocksFor(by, slideIds) {', '\n\n// ------------------------------------------------------------ COM host');
const listenerStart = source.indexOf("Agents.on('agent-exit', ({ name }) => {");
const listenerEnd = source.indexOf("\nAgents.on('turn-cost'", listenerStart);
if (listenerStart < 0 || listenerEnd < 0) throw new Error('agent-exit listener markers missing');
const listenerSource = source.slice(listenerStart, listenerEnd);

const locks = new Map([
  ['s1', { slideId: 's1', by: 'worker-1', ts: 1, note: 'active' }],
  ['s2', { slideId: 's2', by: 'human', ts: 2, note: 'reviewing' }],
]);
const releaseLocksFor = new Function('locks', `${releaseSource}; return releaseLocksFor;`)(locks);
const handlers = {};
const broadcasts = [];
const Agents = { on: (event, listener) => { handlers[event] = listener; } };
const lockView = () => [...locks.values()].sort((a, b) => a.ts - b.ts);
const broadcast = (event) => broadcasts.push(event);
new Function('Agents', 'releaseLocksFor', 'broadcast', 'lockView', listenerSource)(Agents, releaseLocksFor, broadcast, lockView);
if (typeof handlers['agent-exit'] !== 'function') throw new Error('agent-exit listener was not registered');

const checks = [];
function check(description, ok) { checks.push({ description, ok: !!ok }); }

handlers['agent-exit']({ name: 'worker-1', role: 'worker' });
check('agent exit releases only that agent\'s slide claims', !locks.has('s1') && locks.get('s2').by === 'human');
check('agent exit broadcasts the remaining lock snapshot', broadcasts.length === 1 && broadcasts[0].type === 'locks' && broadcasts[0].locks.length === 1 && broadcasts[0].locks[0].slideId === 's2');
handlers['agent-exit']({ name: 'worker-2', role: 'worker' });
check('an exit with no claims does not broadcast a spurious lock update', broadcasts.length === 1);

const passed = checks.filter((item) => item.ok).length;
for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.description}`);
console.log(`\n${passed}/${checks.length} passed`);
process.exit(passed === checks.length ? 0 : 1);
