#!/usr/bin/env node
'use strict';
/*
 * A pagehide beacon has no identity for its SSE stream. With two Studio tabs,
 * one tab leaving must never clear the other tab's shared presence clock.
 * This is a no-agent integration test in a throwaway server sandbox.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const HERE = __dirname;
const PORT = 47593;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(route, opts) {
  const res = await fetch(BASE + route, opts);
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function state() { return (await api('/api/state')).body; }

async function waitFor(description, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await predicate()) return; } catch (_) {}
    await sleep(80);
  }
  throw new Error(`timed out waiting for ${description}`);
}

function openViewer() {
  const controller = new AbortController();
  fetch(BASE + '/api/events?viewer=presence-test', { signal: controller.signal })
    .then((res) => res.body.getReader().read().catch(() => {}))
    .catch(() => {});
  return { close: () => controller.abort() };
}

async function main() {
  const sandbox = path.join(os.tmpdir(), 'presence-beacon-test-' + crypto.randomBytes(4).toString('hex'));
  const suiteDir = path.join(sandbox, 'suite');
  const checks = [];
  const check = (description, condition) => checks.push({ description, ok: !!condition });
  let child = null;
  let viewerA = null;
  let viewerB = null;

  try {
    fs.cpSync(HERE, suiteDir, { recursive: true });
    // The live deck may be paused, which marks model.json read-only on
    // Windows. cpSync preserves that bit. Clear sandbox-only file locks and
    // reset the copied pause flag so startup remains independent of live UI
    // state.
    for (const rel of [
      path.join('data', 'model.json'),
      path.join('data', 'state.json'),
      path.join('data', 'board.json'),
      path.join('data', 'render-state.json'),
    ]) {
      try { fs.chmodSync(path.join(suiteDir, rel), 0o666); } catch (_) {}
    }
    try {
      const statePath = path.join(suiteDir, 'data', 'state.json');
      const copiedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      copiedState.paused = false;
      copiedState.pausedBy = null;
      copiedState.pausedAt = null;
      fs.writeFileSync(statePath, JSON.stringify(copiedState));
    } catch (_) {}
    fs.rmSync(path.join(suiteDir, 'data', 'com_host.pid.json'), { force: true });
    fs.rmSync(path.join(suiteDir, 'data', 'agents.pid.json'), { force: true });
    // This test owns no render/COM assertion. Disable Windows thumbnail work
    // only inside its throwaway server so the presence check is fully isolated.
    const serverPath = path.join(suiteDir, 'server.js');
    const serverSource = fs.readFileSync(serverPath, 'utf8');
    const patched = serverSource.replace("const IS_WIN = process.platform === 'win32';", 'const IS_WIN = false; // presence-beacon test sandbox');
    if (patched === serverSource) throw new Error('could not isolate thumbnail work in sandbox');
    fs.writeFileSync(serverPath, patched);

    child = spawn(process.execPath, ['server.js'], {
      cwd: suiteDir,
      env: Object.assign({}, process.env, { SUITE_PORT: String(PORT), SUITE_VIEWER_IDLE_MS: '6000' }),
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    await waitFor('sandbox health', async () => (await fetch(BASE + '/api/health')).ok, 8000);

    viewerA = openViewer();
    viewerB = openViewer();
    await waitFor('two connected viewers', async () => (await state()).presence.viewers === 2, 4000);
    const before = (await state()).presence;
    check('two viewers begin present', before.viewers === 2 && before.present && before.idleMs != null);

    const leaving = await api('/api/presence', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ leaving: true }),
    });
    const afterBeacon = (await state()).presence;
    check('one anonymous leaving beacon does not reap shared presence',
      leaving.status === 200 && leaving.body && leaving.body.reaped === false
        && afterBeacon.viewers === 2 && afterBeacon.present && afterBeacon.idleMs != null);

    viewerA.close(); viewerA = null;
    await waitFor('only the remaining viewer', async () => (await state()).presence.viewers === 1, 4000);
    const afterClose = (await state()).presence;
    check('remaining viewer stays present after the departing stream closes',
      afterClose.viewers === 1 && afterClose.present && afterClose.idleMs != null);
  } finally {
    if (viewerA) viewerA.close();
    if (viewerB) viewerB.close();
    try { child && child.kill(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}
  }

  const passed = checks.filter((item) => item.ok).length;
  for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.description}`);
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((err) => { console.error(err.stack || err); process.exit(1); });
