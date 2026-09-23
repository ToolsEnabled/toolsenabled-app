#!/usr/bin/env node
'use strict';
/**
 * Idle-agent reaper: agents must not stay alive just because the server is up.
 *
 * Runs against a THROWAWAY sandbox copy of the suite on its own port with its
 * own data dir (same pattern as applyop.test.js), so it never touches the live
 * deck, the live board, or the live COM host. It does spawn one real claude
 * child, because the whole point is to prove a live agent actually dies; that
 * is one short turn on the cheapest model.
 *
 * The reaper's two independent presence signals are tested separately:
 *   1. no viewer connected at all        -> reap after the grace window
 *   2. viewer connected but not touched  -> reap after the idle window
 * Plus the negative: a viewer that keeps touching keeps its agent alive.
 * In-flight and queued work is covered without a real provider by
 * reaper-safety.test.js; this suite checks eventual cleanup after a short turn.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const HERE = __dirname;
const PORT = 47592;                 // distinct from applyop.test.js's 47591 and the live 4599
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;

const IDLE_MS = 6000;               // "viewer went quiet" window (server floors this at 5s)
const GRACE_MS = 2000;              // "no viewer at all" window
const TICK_MS = 500;                // how often the server re-checks

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, opts) {
  const r = await fetch(BASE + p, opts);
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function state() { return (await api('/api/state')).body; }
async function agentCount() { return ((await state()).agents || []).length; }

async function waitForHealth(child, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error('sandbox server exited early, code ' + child.exitCode);
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch (_) {}
    await sleep(200);
  }
  throw new Error('sandbox server never became healthy');
}

// A browser viewer is an SSE connection carrying ?viewer=. Node's fetch keeps
// the stream open, which is exactly what the server counts.
function openViewer() {
  const ctl = new AbortController();
  const done = fetch(BASE + '/api/events?viewer=test', { signal: ctl.signal })
    .then((r) => r.body.getReader().read().catch(() => {}))
    .catch(() => {});
  return { close: () => ctl.abort(), done };
}

const cases = [];
function record(desc, fn) { cases.push({ desc, fn }); }

async function main() {
  const sandbox = path.join(os.tmpdir(), 'reaper-test-' + crypto.randomBytes(4).toString('hex'));
  const suiteDir = path.join(sandbox, 'suite');
  fs.cpSync(HERE, suiteDir, { recursive: true });
  fs.rmSync(path.join(suiteDir, 'data', 'com_host.pid.json'), { force: true });
  fs.rmSync(path.join(suiteDir, 'data', 'agents.pid.json'), { force: true });
  const comHostPs1 = path.join(suiteDir, 'com_host.ps1');
  if (fs.existsSync(comHostPs1)) fs.renameSync(comHostPs1, comHostPs1 + '.disabled');
  // Inherited pause would make /api/chat 423 and every spawn case vacuously pass.
  try {
    const sp = path.join(suiteDir, 'data', 'state.json');
    const st = JSON.parse(fs.readFileSync(sp, 'utf8'));
    st.paused = false; st.pausedBy = null; st.pausedAt = null;
    st.usageProfile = 'low';           // cheapest lead for a test that spawns one
    fs.writeFileSync(sp, JSON.stringify(st));
  } catch (_) {}

  const child = spawn(process.execPath, ['server.js'], {
    cwd: suiteDir,
    env: Object.assign({}, process.env, {
      SUITE_PORT: String(PORT),
      SUITE_VIEWER_IDLE_MS: String(IDLE_MS),
      SUITE_VIEWER_GRACE_MS: String(GRACE_MS),
      SUITE_PRESENCE_TICK_MS: String(TICK_MS),
    }),
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  let viewer = null;
  try {
    await waitForHealth(child, 10000);

    // ---- presence accounting, no agents involved
    record('a plain SSE client (ppt watch) does NOT count as a viewer', async () => {
      const ctl = new AbortController();
      fetch(BASE + '/api/events', { signal: ctl.signal }).then((r) => r.body.getReader().read().catch(() => {})).catch(() => {});
      await sleep(400);
      const p = (await state()).presence;
      ctl.abort();
      if (p.viewers !== 0) throw new Error(`expected 0 viewers, got ${p.viewers}`);
    });

    record('a ?viewer= SSE client counts as a viewer', async () => {
      viewer = openViewer();
      await sleep(500);
      const p = (await state()).presence;
      if (p.viewers !== 1) throw new Error(`expected 1 viewer, got ${p.viewers}`);
      if (!p.present) throw new Error('expected present=true right after connecting');
    });

    record('POST /api/presence refreshes the idle clock', async () => {
      await sleep(1200);
      const before = (await state()).presence.idleMs;
      await api('/api/presence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const after = (await state()).presence.idleMs;
      if (!(after < before)) throw new Error(`idleMs did not reset (before ${before}, after ${after})`);
    });

    record('presence goes stale once the viewer stops touching', async () => {
      await sleep(IDLE_MS + 600);
      const p = (await state()).presence;
      if (p.present) throw new Error(`expected present=false after ${IDLE_MS}ms idle, idleMs=${p.idleMs}`);
    });

    // ---- the real thing: a live agent
    record('a drained live agent is eventually reaped when the viewer goes idle', async () => {
      await api('/api/presence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const r = await api('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Reply with the single word ok. Dispatch nothing.' }),
      });
      if (r.status !== 200) throw new Error(`/api/chat failed: ${r.status} ${JSON.stringify(r.body)}`);
      // wait for the process to actually appear on the roster
      let n = 0;
      for (let i = 0; i < 40 && n === 0; i++) { await sleep(250); n = await agentCount(); }
      if (n === 0) throw new Error('lead never appeared on the roster');

      // stop touching; the reaper should notice within idle + a tick or two
      const deadline = Date.now() + IDLE_MS + TICK_MS * 6 + 4000;
      while (Date.now() < deadline) {
        if ((await agentCount()) === 0) return;
        await sleep(300);
      }
      throw new Error(`agent still alive ${Math.round((Date.now() - (deadline - IDLE_MS - TICK_MS * 6 - 4000)) / 1000)}s after going idle`);
    });

    record('the reap is recorded in the activity log', async () => {
      const s = await state();
      const hit = (s.log || []).filter((e) => e.kind === 'agents-reaped');
      if (!hit.length) throw new Error('no agents-reaped entry in state.log');
      if (!hit[hit.length - 1].why) throw new Error('reap entry has no reason');
    });

    record('closing the last viewer reaps after the grace window', async () => {
      await api('/api/presence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const r = await api('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Reply with the single word ok. Dispatch nothing.' }),
      });
      if (r.status !== 200) throw new Error(`/api/chat failed: ${r.status}`);
      let n = 0;
      for (let i = 0; i < 40 && n === 0; i++) { await sleep(250); n = await agentCount(); }
      if (n === 0) throw new Error('lead never appeared on the roster');

      if (viewer) { viewer.close(); viewer = null; }        // the tab is gone
      const deadline = Date.now() + GRACE_MS + TICK_MS * 6 + 4000;
      while (Date.now() < deadline) {
        if ((await agentCount()) === 0) return;
        await sleep(300);
      }
      throw new Error('agent survived the viewer closing');
    });

    record('the pagehide beacon reaps immediately', async () => {
      const r = await api('/api/presence', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leaving: true }),
      });
      if (r.status !== 200) throw new Error(`beacon failed: ${r.status}`);
      if ((await state()).presence.present !== false) throw new Error('beacon did not clear presence');
    });

    let passed = 0;
    for (const c of cases) {
      try { await c.fn(); console.log('✓ ', c.desc); passed++; }
      catch (e) { console.log('✗ FAIL ', c.desc, '\n         ', e.message); }
    }
    console.log(`\n${passed}/${cases.length} passed${passed === cases.length ? '' : ', ' + (cases.length - passed) + ' FAILED'}`);
    process.exitCode = passed === cases.length ? 0 : 1;
  } finally {
    if (viewer) viewer.close();
    try { child.kill(); } catch (_) {}
    await sleep(300);
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((e) => { console.error('reaper.test.js crashed:', e); process.exit(1); });
