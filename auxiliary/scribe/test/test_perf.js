#!/usr/bin/env node
'use strict';
/**
 * Performance under a burst of edits.
 *
 * PLAN.md flags this as never measured, even in the deck project next door,
 * where it was raised as a risk and then left alone. An agent working quickly
 * produces edits far faster than a human does, and the failure mode is not a
 * crash: it is the UI quietly falling behind until the glow stops meaning
 * "just now".
 *
 * What is actually being tested:
 *   - does every edit land, or do some get lost under load
 *   - does the client coalesce, or does it do one layout pass per event
 *   - does the DOM stay patched rather than degrading into rebuilds
 *   - does the main thread stay responsive enough to animate
 *
 * Run: node test/test_perf.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Browser, findBrowser, sleep } = require('./cdp');
const { availablePort, waitForOwnedHealth } = require('./isolated_server');
const { requiredLiveFile } = require('./live-input');

const ROOT = path.join(__dirname, '..');
let PORT = null;
let BASE = null;
const TMP = path.join(__dirname, '_tmp_perf');
const SRC = requiredLiveFile('SCRIBE_TEST_DOCX');
const BURST = 40;

const PASS = [], FAIL = [];
const check = (n, c, d) => { (c ? PASS : FAIL).push(n); console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${d !== undefined ? '  ' + d : ''}`); };

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(`${BASE}${p}`, { method, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
      (res) => { let o = ''; res.on('data', (c) => o += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(o || '{}') }); } catch (_) { resolve({ status: res.statusCode, body: o }); } }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

async function main() {
  if (!findBrowser()) { console.log('No browser, skipping.'); process.exit(0); }
  PORT = await availablePort();
  BASE = `http://127.0.0.1:${PORT}`;

  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'data', 'documents'), { recursive: true });
  const doc = path.join(TMP, 'data', 'documents', 'paper.docx');
  fs.copyFileSync(SRC, doc);

  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SCRIBE_PORT: String(PORT), SCRIBE_DATA: path.join(TMP, 'data') },
  });
  const srvLog = [];
  srv.stdout.on('data', (d) => srvLog.push(d.toString()));
  srv.stderr.on('data', (d) => srvLog.push(d.toString()));

  let browser = null, hardFail = false;
  try {
    await waitForOwnedHealth(() => req('GET', '/api/health'), srv, {
      attempts: 80,
      interval: 250,
    });
    const opened = await req('POST', '/api/open', { path: doc });
    if (opened.status !== 200) {
      throw new Error(`fixture open failed (${opened.status}): ${opened.body.error || ''}`);
    }

    // Let the CDP helper reserve a free private port. A fixed port can collide
    // with another local test session and attach this run to the wrong Chrome.
    browser = await Browser.launch({ headless: true });
    await browser.attachToPage();
    await browser.collectErrors();
    await browser.goto(BASE + '/');
    await browser.waitFor('document.querySelectorAll(".para").length > 300', { timeout: 20000 });

    // Instrument the page: count what arrives, and watch for long tasks that
    // would visibly stall an animation.
    await browser.eval(`(() => {
      window.__perf = { edits: 0, renders: [], longTasks: [] };
      const es = new EventSource('/api/events');
      es.addEventListener('edit', () => window.__perf.edits++);
      try {
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) window.__perf.longTasks.push(Math.round(e.duration));
        }).observe({ entryTypes: ['longtask'] });
      } catch (_) {}
      const tick = () => {
        if (window.__lastRender) {
          const r = window.__lastRender;
          const last = window.__perf.renders[window.__perf.renders.length - 1];
          if (!last || last.t !== r.ms) window.__perf.renders.push({ t: r.ms, rebuilt: r.rebuilt, patched: r.patched });
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return true;
    })()`);
    await sleep(400);

    const model = (await req('GET', '/api/doc')).body;
    const targets = model.paragraphs.filter((p) => p.text.length > 120 && !p.table).slice(0, BURST);
    check(`found ${BURST} paragraphs to edit`, targets.length === BURST, targets.length);

    console.log(`\n[bursting ${BURST} edits as fast as the server will take them]`);
    // Discard the initial page build, which is legitimately a rebuild. Only
    // renders caused by the burst are under test here.
    // Clear __lastRender as well as the collected list. Clearing only the list
    // lets the next frame re-capture the stale initial build and count it again.
    await browser.eval('(window.__perf.renders = [], window.__perf.longTasks = [], window.__lastRender = null, true)');
    const t0 = Date.now();
    const results = [];
    for (let i = 0; i < targets.length; i++) {
      const p = targets[i];
      results.push(await req('POST', '/api/edit', {
        who: 'perf',
        op: { type: 'replace', pid: p.pid, find: p.text.slice(10, 26), replace: `BURST${i}`,
              why: `burst ${i}`, utterance: 'perf-burst', expect_hash: p.hash },
      }));
    }
    const serverMs = Date.now() - t0;
    const ok = results.filter((r) => r.status === 200).length;
    check('every edit was accepted', ok === BURST, `${ok}/${BURST}`);
    console.log(`  ${serverMs} ms total, ${(serverMs / BURST).toFixed(0)} ms per edit end to end`);
    check('the server sustains better than 10 edits per second',
      BURST / (serverMs / 1000) > 10, `${(BURST / (serverMs / 1000)).toFixed(1)}/s`);

    // Let the client drain.
    await sleep(2500);
    const perf = JSON.parse(await browser.eval('JSON.stringify(window.__perf)'));

    console.log('\n[what the browser did with them]');
    check('every edit event reached the browser', perf.edits === BURST, `${perf.edits}/${BURST}`);
    const rebuilds = perf.renders.filter((r) => r.rebuilt).length;
    check('no full rebuilds: the DOM stayed patched throughout', rebuilds === 0,
      `${rebuilds} rebuilds in ${perf.renders.length} renders`);
    const times = perf.renders.map((r) => r.t).sort((a, b) => a - b);
    if (times.length) {
      const med = times[Math.floor(times.length / 2)];
      const worst = times[times.length - 1];
      console.log(`  ${perf.renders.length} render passes, median ${med.toFixed(1)} ms, worst ${worst.toFixed(1)} ms`);
      check('the worst render pass still fits in a frame (<16 ms)', worst < 16, `${worst.toFixed(1)} ms`);
      // Coalescing is the point: far fewer render passes than events proves the
      // rAF queue is batching rather than rendering per event.
      check('events were coalesced, not rendered one by one',
        perf.renders.length < BURST, `${perf.renders.length} passes for ${BURST} edits`);
    }
    const bad = perf.longTasks.filter((d) => d > 100);
    console.log(`  long tasks over 50 ms: ${perf.longTasks.length}${perf.longTasks.length ? ' (' + perf.longTasks.slice(0, 6).join(', ') + ' ms)' : ''}`);
    check('nothing blocked the main thread for over 100 ms', bad.length === 0, bad.join(', '));

    console.log('\n[the document survived]');
    const after = (await req('GET', '/api/doc')).body;
    const applied = after.paragraphs.filter((p) => /BURST\d+/.test(p.text)).length;
    check('all edits are in the document', applied === BURST, `${applied}/${BURST}`);
    check('paragraph count unchanged', after.paragraphs.length === model.paragraphs.length,
      `${model.paragraphs.length} -> ${after.paragraphs.length}`);
    const domText = await browser.eval(`document.querySelectorAll('.para').length`);
    check('the DOM still matches the document', domText === after.paragraphs.length, domText);
    const marks = await browser.eval(`document.querySelectorAll('mark.changed').length`);
    console.log(`  ${marks} spans still marked as changed`);

    console.log('\n[undo still works after all that]');
    const u = await req('POST', '/api/undo');
    check('the whole burst undoes as one utterance', u.status === 200, u.body.error);
    await sleep(800);
    const rolled = (await req('GET', '/api/doc')).body.paragraphs.filter((p) => /BURST\d+/.test(p.text)).length;
    check('  and every edit is gone', rolled === 0, `${rolled} left`);

    const errs = await browser.eval('JSON.stringify(window.__errs || null)');
    check('no page errors under load', errs === '[]', errs);
  } catch (e) {
    console.error('\nTEST ERROR:', e && e.stack || e);
    hardFail = true;
  } finally {
    if (browser) browser.kill();
    srv.kill();
    await sleep(900);
    for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch (_) { await sleep(400); } }
  }

  console.log(`\n${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) { console.log('failed: ' + FAIL.join(', ')); console.log('\n--- server log ---\n' + srvLog.join('').slice(-1500)); }
  process.exit(FAIL.length || hardFail ? 1 : 0);
}

main();
