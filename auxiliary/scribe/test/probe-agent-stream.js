#!/usr/bin/env node
// Probe: what does `claude` actually emit in stream-json mode, and can we
// inject a second user message while turn 1 is still in flight?
// Read-only probe. Allowed tools are restricted to Glob.

const { spawn } = require('child_process');
const path = require('path');

const CWD = process.argv[2] || process.cwd();
const kinds = new Map();      // event signature -> count
const timeline = [];          // ordered, trimmed record
const t0 = process.hrtime.bigint();
const ms = () => Number((process.hrtime.bigint() - t0) / 1000000n);

const args = [
  '-p',
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--include-partial-messages',
  '--replay-user-messages',
  '--verbose',
  '--permission-mode', 'dontAsk',
  '--allowed-tools', 'Glob',
  '--model', 'claude-haiku-4-5-20251001',
];

const child = spawn('claude', args, {
  cwd: CWD,
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: true,
});

function send(text) {
  const msg = {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
  child.stdin.write(JSON.stringify(msg) + '\n');
  timeline.push({ t: ms(), dir: 'IN', note: text.slice(0, 60) });
}

let buf = '';
child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { timeline.push({ t: ms(), dir: 'RAW', note: line.slice(0, 120) }); continue; }
    record(ev);
  }
});

function record(ev) {
  // Build a signature that captures the discriminator hierarchy.
  const parts = [ev.type];
  if (ev.subtype) parts.push(ev.subtype);
  if (ev.event && ev.event.type) parts.push('event=' + ev.event.type);
  if (ev.event && ev.event.delta && ev.event.delta.type) parts.push('delta=' + ev.event.delta.type);
  if (ev.event && ev.event.content_block && ev.event.content_block.type) parts.push('block=' + ev.event.content_block.type);
  if (ev.message && Array.isArray(ev.message.content)) {
    const cts = [...new Set(ev.message.content.map((c) => c.type))].sort();
    if (cts.length) parts.push('content=[' + cts.join(',') + ']');
  }
  const sig = parts.join(' ');
  kinds.set(sig, (kinds.get(sig) || 0) + 1);

  // Keep the first example of each signature, plus every non-delta event.
  const isDelta = sig.includes('delta=');
  if (!isDelta || kinds.get(sig) === 1) {
    timeline.push({
      t: ms(),
      dir: 'OUT',
      sig,
      keys: Object.keys(ev).join(','),
      sample: trim(ev),
    });
  }
}

function trim(o) {
  const s = JSON.stringify(o, (k, v) => (typeof v === 'string' && v.length > 180 ? v.slice(0, 180) + '…' : v));
  return s.length > 900 ? s.slice(0, 900) + '…' : s;
}

child.stderr.on('data', (d) => timeline.push({ t: ms(), dir: 'ERR', note: d.toString().slice(0, 300) }));

child.on('close', (code) => {
  console.log('\n================ EVENT SIGNATURES (count) ================');
  [...kinds.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(String(v).padStart(5), k));
  console.log('\n================ TIMELINE ================');
  for (const e of timeline) {
    if (e.dir === 'OUT') console.log(`[${String(e.t).padStart(6)}ms] OUT ${e.sig}\n        keys: ${e.keys}\n        ${e.sample}`);
    else console.log(`[${String(e.t).padStart(6)}ms] ${e.dir}  ${e.note}`);
  }
  console.log('\nexit code:', code);
});

// Turn 1: force a tool call so we see tool_use / tool_result shapes.
send('Use the Glob tool to list files matching *.md in this directory, then tell me how many you found. Be brief.');

// Mid-flight injection: a second message ~2.5s in, while turn 1 should still be running.
setTimeout(() => send('ACTUALLY, also tell me the alphabetically first filename you found.'), 2500);

// Close stdin later so the process can finish both turns.
setTimeout(() => { try { child.stdin.end(); } catch {} }, 30000);
setTimeout(() => { try { child.kill(); } catch {} }, 75000);
