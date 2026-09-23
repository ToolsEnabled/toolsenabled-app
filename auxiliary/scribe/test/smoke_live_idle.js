#!/usr/bin/env node
'use strict';

// Free, non-mutating release smoke for the already-running local Scribe.
// It never starts an agent, changes Watch consent, arms prediction with saved
// typing, saves text, or spends model tokens.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { Browser, sleep } = require('./cdp');

const ROOT = path.join(__dirname, '..');
const BASE = process.env.SCRIBE_LIVE_URL || 'http://127.0.0.1:4610';

function request(method, route, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request(BASE + route, {
      method,
      headers: payload ? {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let parsed = null;
        try { parsed = JSON.parse(raw.toString('utf8')); } catch (_) {}
        resolve({ status: res.statusCode, raw, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const get = (route) => request('GET', route);
const post = (route, body) => request('POST', route, body);
const digest = (data) => crypto.createHash('sha256').update(data).digest('hex');

function assert(ok, message, detail) {
  if (ok) return;
  throw new Error(message + (detail ? `: ${detail}` : ''));
}

(async () => {
  const healthBefore = (await get('/api/health')).body;
  assert(healthBefore && healthBefore.ok, 'live Scribe is not healthy');
  const agentBefore = (await get('/api/agent')).body;
  const watchBefore = (await get('/api/watch')).body;
  const predictBefore = (await get('/api/predict')).body;
  assert(agentBefore && agentBefore.running === false, 'editing agent is already running');
  assert(watchBefore && watchBefore.reviewer.running === false &&
    watchBefore.active === null && watchBefore.pending.length === 0,
  'Watch is not completely idle', JSON.stringify(watchBefore));
  assert(predictBefore && predictBefore.active === null &&
    predictBefore.runner.running === false &&
    (!predictBefore.continuation || predictBefore.continuation.status === 'open'),
  'predictive runner is not idle', JSON.stringify(predictBefore));
  const continuationBefore = predictBefore.continuation
    ? JSON.stringify(predictBefore.continuation) : null;

  const docBefore = (await get('/api/doc')).body;
  const fileBefore = fs.readFileSync(healthBefore.docPath);
  const target = docBefore.paragraphs.find((p) => !p.table && p.text.length > 80);
  assert(target, 'no editable paragraph found');

  for (const asset of ['index.html', 'app.js', 'app.css']) {
    const served = (await get('/' + asset)).raw;
    const disk = fs.readFileSync(path.join(ROOT, 'public', asset));
    assert(digest(served) === digest(disk), `${asset} served bytes differ from disk`);
  }

  let browser;
  try {
    browser = await Browser.launch({ headless: true });
    await browser.attachToPage();
    await browser.collectErrors();
    // A second browser must not overwrite the human's visible Watch choice
    // when its event stream connects. Seed this isolated profile before any
    // application script runs, then verify that the exact state is preserved.
    await browser.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `localStorage.setItem('scribe-watch', ${
        JSON.stringify(watchBefore.enabled ? 'on' : 'off')});`,
    });
    await browser.goto(BASE + '/');
    await browser.waitFor('document.querySelectorAll(".para").length > 0', { timeout: 15000 });

    const initial = await browser.eval(`(() => {
      const first = document.querySelector('.para');
      const bar = document.querySelector('.bar');
      return {
        editable: first.getAttribute('contenteditable'),
        watch: document.getElementById('watch-toggle').getAttribute('aria-pressed'),
        composerBlur: getComputedStyle(bar).backdropFilter,
        composerLine: Number(getComputedStyle(bar, '::after').opacity)
      };
    })()`);
    assert(initial.editable === 'plaintext-only', 'document is not directly editable');
    assert(initial.watch === String(watchBefore.enabled),
      'visible Watch toggle changed the live consent state', JSON.stringify(initial));
    assert(/blur\(18px\)/.test(initial.composerBlur) && initial.composerLine === 0,
      'resting composer treatment is missing', JSON.stringify(initial));
    if (predictBefore.continuation) {
      await browser.waitFor(`document.querySelector(
        '.continuation-note[data-continuation="${predictBefore.continuation.id}"]')`,
      { timeout: 5000 });
      const continuationCard = await browser.eval(`(() => {
        const note = document.querySelector(
          '.continuation-note[data-continuation="${predictBefore.continuation.id}"]');
        return {
          text: note && note.querySelector('.continuation-text').textContent,
          label: note && note.querySelector('.continuation-label').textContent,
          editable: note && note.getAttribute('contenteditable')
        };
      })()`);
      assert(continuationCard.text === predictBefore.continuation.text &&
        continuationCard.editable === 'false' &&
        continuationCard.label.toLowerCase().includes(predictBefore.continuation.model),
      'saved continuation did not attach in the live UI', JSON.stringify(continuationCard));
    }

    await browser.eval(`(document.getElementById('model-pool-btn').click(), true)`);
    await sleep(120);
    const modelPool = await browser.eval(`(() => {
      const pool = document.getElementById('model-pool');
      const rect = pool.getBoundingClientRect();
      return {
        open: !pool.hidden,
        count: document.querySelectorAll('.model-pool-toggle').length,
        inside: rect.left >= 0 && rect.right <= innerWidth &&
          rect.top >= 0 && rect.bottom <= innerHeight
      };
    })()`);
    assert(modelPool.open && modelPool.count === 4 && modelPool.inside,
      'automatic model pool is not safely visible', JSON.stringify(modelPool));
    await browser.eval(`(setModelPoolOpen(false), true)`);

    await browser.eval(`(document.getElementById('say').focus(), true)`);
    await sleep(240);
    const focusedLine = await browser.eval(
      `Number(getComputedStyle(document.querySelector('.bar'), '::after').opacity)`);
    assert(focusedLine > 0.6, 'focused composer line did not appear', String(focusedLine));
    const agentFocused = (await get('/api/agent')).body;
    const watchFocused = (await get('/api/watch')).body;
    assert(agentFocused.running === false &&
      watchFocused.enabled === watchBefore.enabled &&
      watchFocused.reviewer.running === false && watchFocused.active === null,
    'focusing the composer started model work');

    if (!watchBefore.enabled) {
      await browser.eval(`(document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'W', code: 'KeyW', altKey: true, shiftKey: true,
        bubbles: true, cancelable: true
      })), true)`);
      await sleep(160);
      const watchShortcut = (await get('/api/watch')).body;
      assert(watchShortcut.enabled === false && watchShortcut.reviewer.running === false &&
        watchShortcut.active === null && watchShortcut.pending.length === 0,
      'off-state Watch shortcut started work', JSON.stringify(watchShortcut));

      const directReview = await post('/api/watch/review', {
        quietMs: 300,
        manual: true,
        changes: [{
          pid: target.pid,
          before: `[prior] ${target.text}`,
          after: target.text,
        }],
      });
      assert(directReview.status === 409 &&
        /turn watch on/i.test((directReview.body && directReview.body.error) || ''),
      'server accepted an off-state Watch review', JSON.stringify(directReview.body));
    }

    const manualStart = await post('/api/agent/start');
    assert(manualStart.status === 409,
      'server accepted a manual editing-agent start', JSON.stringify(manualStart.body));
    assert((await get('/api/agent')).body.running === false,
      'refused manual start launched an editing model');

    if (!predictBefore.continuation) {
      await browser.eval(`(() => {
        const el = document.querySelector('[data-pid="${target.pid}"]');
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        el.focus();
        el.textContent = ${JSON.stringify(target.text + ' LIVE_SMOKE_UNSAVED')};
        el.dispatchEvent(new InputEvent('input', {
          bubbles: true, inputType: 'insertText', data: ' LIVE_SMOKE_UNSAVED'
        }));
        el.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape', bubbles: true, cancelable: true
        }));
      })()`);
      await sleep(900);
      const predictionCancelled = await browser.eval(`({
        timer: !!window.__prediction.timer,
        capture: !!window.__prediction.capture,
        active: window.__prediction.activeId,
        pending: !!document.querySelector('.continuation-pending')
      })`);
      const predictAfterCancel = (await get('/api/predict')).body;
      assert(predictionCancelled.timer === false &&
        predictionCancelled.capture === false &&
        predictionCancelled.active === null &&
        predictionCancelled.pending === false &&
        predictAfterCancel.active === null && predictAfterCancel.runner.running === false,
      'cancelled direct typing left prediction armed',
      JSON.stringify({ browser: predictionCancelled, server: predictAfterCancel }));
    }

    // Exercise the compact rendering locally with synthetic UI events. This
    // never reaches the server or starts a process; it only proves the exact
    // served assets can show one wrapped current call at phone width.
    await browser.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(180);
    for (const event of [
      { kind: 'agent-start', pid: 1 },
      { kind: 'session', sessionId: 'smoke', tools: [], mcp: [] },
      { kind: 'turn-start', ttftMs: 400 },
      { kind: 'tool-pending', id: 'smoke-phone', name: 'mcp__doc__doc_replace', parent: null },
      { kind: 'tool-args', id: 'smoke-phone',
        partial: '{"pid":"51C326DE","find":"only 3 of 20 prompts","replace":"3 of 20 prompts (1 of 20 by the advisory screen)","why":"state the distinction precisely"}' },
    ]) {
      await browser.eval(`(window.__feed('agent', ${JSON.stringify(event)}), true)`);
    }
    await browser.eval(`(document.getElementById('rail-toggle').click(), true)`);
    await sleep(240);
    const phoneWork = await browser.eval(`(() => {
      const panel = document.querySelector('.work-panel').getBoundingClientRect();
      const lane = document.getElementById('lane').getBoundingClientRect();
      const call = document.querySelector('[data-id="smoke-phone"]').getBoundingClientRect();
      return {
        panelHeight: panel.height,
        laneHeight: lane.height,
        callHeight: call.height,
        callTop: call.top,
        laneTop: lane.top,
        callBottom: call.bottom,
        laneBottom: lane.bottom
      };
    })()`);
    assert(phoneWork.panelHeight > 190 &&
      phoneWork.callHeight <= phoneWork.laneHeight + 1 &&
      phoneWork.callTop >= phoneWork.laneTop - 1 &&
      phoneWork.callBottom <= phoneWork.laneBottom + 1,
    'phone-width work view clips the newest wrapped call', JSON.stringify(phoneWork));
    await browser.eval(`(window.__feed('agent', {
      kind: 'agent-exit', code: null, sig: 'smoke', expected: true
    }), true)`);

    const pageErrors = await browser.eval('JSON.stringify(window.__errs || [])');
    assert(pageErrors === '[]' && browser.exceptions.length === 0,
      'live page logged errors', `${pageErrors} ${browser.exceptions.join(' | ')}`);
  } finally {
    if (browser) browser.kill();
  }

  const healthAfter = (await get('/api/health')).body;
  const agentAfter = (await get('/api/agent')).body;
  const watchAfter = (await get('/api/watch')).body;
  const predictAfter = (await get('/api/predict')).body;
  const fileAfter = fs.readFileSync(healthAfter.docPath);
  assert(healthAfter.rev === healthBefore.rev, 'live revision changed');
  assert(digest(fileAfter) === digest(fileBefore), 'live document bytes changed');
  assert(agentAfter.running === false &&
    watchAfter.enabled === watchBefore.enabled &&
    watchAfter.reviewer.running === false && watchAfter.active === null &&
    watchAfter.pending.length === 0 && predictAfter.active === null &&
    predictAfter.runner.running === false &&
    (predictAfter.continuation ? JSON.stringify(predictAfter.continuation) : null) ===
      continuationBefore,
  'a model lane was left active');

  console.log(JSON.stringify({
    ok: true,
    rev: healthAfter.rev,
    paragraphs: docBefore.paragraphs.length,
    documentSha256: digest(fileAfter),
    servedAssetsExact: true,
    watchConsentPreserved: true,
    watchEnabled: watchAfter.enabled,
    basicEditCancel: true,
    predictiveLaneIdle: true,
    continuationPreserved: !!continuationBefore,
    modelPoolVisible: true,
    phoneWorkVisible: true,
    modelLanesIdle: true,
  }));
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
