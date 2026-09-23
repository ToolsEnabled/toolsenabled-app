#!/usr/bin/env node
'use strict';

// Token-free browser coverage for typing-gated predictive continuations.
// SCRIBE_PREDICT_TEST holds the one-shot job before any CLI process is spawned;
// the fixture endpoint supplies the normalized final model text.

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
const TMP = path.join(__dirname, '_tmp_predict');
const SRC = requiredLiveFile('SCRIBE_TEST_DOCX');

const PASS = [], FAIL = [];
const check = (name, condition, detail) => {
  (condition ? PASS : FAIL).push(name);
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? '  ' + detail : ''}`);
};

function req(method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const request = http.request(BASE + route, {
      method,
      headers: data ? {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
      } : {},
    }, (res) => {
      let out = '';
      res.on('data', (chunk) => out += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(out || '{}') }); }
        catch (_) { resolve({ status: res.statusCode, body: out }); }
      });
    });
    request.on('error', reject);
    if (data) request.write(data);
    request.end();
  });
}

async function waitFor(fn, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(80);
  }
  throw new Error('waitFor timed out');
}

async function typeParagraph(browser, pid, text) {
  return browser.eval(`(() => {
    const el = document.querySelector('[data-pid="${pid}"]');
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    el.focus();
    el.textContent = ${JSON.stringify(text)};
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true, inputType: 'insertText', data: 'x'
    }));
    return {
      timer: !!window.__prediction.timer,
      capture: window.__prediction.capture && window.__prediction.capture.pid
    };
  })()`);
}

async function main() {
  if (!findBrowser()) {
    console.log('No Chrome or Edge found, skipping predictive continuation tests.');
    process.exit(0);
  }
  PORT = await availablePort();
  BASE = `http://127.0.0.1:${PORT}`;

  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'data', 'documents'), { recursive: true });
  const doc = path.join(TMP, 'data', 'documents', 'paper.docx');
  fs.copyFileSync(SRC, doc);

  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SCRIBE_PORT: String(PORT),
      SCRIBE_DATA: path.join(TMP, 'data'),
      SCRIBE_PREDICT_TEST: '1',
      SCRIBE_PREDICT_TIMEOUT_MS: '3000',
      SCRIBE_WATCH_TEST: '1',
      SCRIBE_WATCH_TIMEOUT_MS: '3000',
      SCRIBE_TRANSACTION_TEST: '1',
    },
  });
  const logs = [];
  server.stdout.on('data', (data) => logs.push(data.toString()));
  server.stderr.on('data', (data) => logs.push(data.toString()));

  let browser = null;
  let hardFail = false;
  try {
    await waitForOwnedHealth(() => req('GET', '/api/health'), server, {
      attempts: 120,
      interval: 100,
      requireDocHost: true,
    });
    const opened = await req('POST', '/api/open', { path: doc });
    if (opened.status !== 200) {
      throw new Error(opened.body && opened.body.error || 'could not open prediction fixture');
    }

    browser = await Browser.launch({ headless: true });
    await browser.attachToPage();
    await browser.collectErrors();
    await browser.goto(BASE + '/');
    await browser.waitFor('document.querySelectorAll(".para").length > 300', { timeout: 20000 });
    check('production quiet time is exactly one minute',
      await browser.eval('PREDICT_QUIET_MS') === 60000);
    await browser.goto(`${BASE}/?predictMs=900&watchMs=300`);
    await browser.waitFor('document.querySelectorAll(".para").length > 300', { timeout: 20000 });

    console.log('\n[idle boundary]');
    await sleep(1100);
    const idle = (await req('GET', '/api/predict')).body;
    const idleAgent = (await req('GET', '/api/agent')).body;
    const idleWatch = (await req('GET', '/api/watch')).body;
    check('opening the program alone schedules no prediction',
      idle.active === null && idle.runner.running === false && idle.continuation === null,
      JSON.stringify(idle));
    check('idle prediction changes neither existing model lane',
      idleAgent.running === false && idleWatch.enabled === false &&
      idleWatch.reviewer.running === false);

    console.log('\n[typing gate and quiet reset]');
    const model = (await req('GET', '/api/doc')).body;
    const target = model.paragraphs.find((p) => !p.table && p.text.length > 180);
    const first = target.text + ' [predictive seed]';
    const capture = await typeParagraph(browser, target.pid, first);
    check('a real document keystroke creates only a local quiet timer',
      capture.timer && capture.capture === target.pid &&
      (await req('GET', '/api/predict')).body.active === null,
      JSON.stringify(capture));
    check('Watch remains off while predictive timing is armed',
      (await req('GET', '/api/watch')).body.enabled === false);

    await sleep(560);
    const second = first + ' with a later correction';
    await typeParagraph(browser, target.pid, second);
    await sleep(520);
    check('more typing resets the quiet window instead of double-submitting',
      (await req('GET', '/api/predict')).body.active === null);

    const active = await waitFor(async () => {
      const status = (await req('GET', '/api/predict')).body;
      return status.active || null;
    }, 6000);
    const saved = (await req('GET', '/api/doc')).body.paragraphs
      .find((p) => p.pid === target.pid);
    check('the quiet window starts one prediction from saved prose',
      active.anchor_pid === target.pid && saved.text === second,
      JSON.stringify(active));
    check('the cheaper Claude lane is Sonnet',
      active.model === 'sonnet' && active.provider === 'claude',
      JSON.stringify(active));
    check('test mode proves prediction is separate without launching either existing lane',
      (await req('GET', '/api/predict')).body.runner.running === false &&
      (await req('GET', '/api/agent')).body.running === false &&
      (await req('GET', '/api/watch')).body.reviewer.running === false);
    await browser.waitFor(`document.querySelector('.continuation-pending')`, { timeout: 5000 });
    const pending = await browser.eval(`(() => {
      const anchor = document.querySelector('[data-pid="${target.pid}"]');
      const cue = document.querySelector('.continuation-pending');
      return {
        after: anchor.nextElementSibling === cue,
        label: cue.querySelector('.continuation-label').textContent,
        text: cue.querySelector('.continuation-pending-text').textContent,
        cancel: !!cue.querySelector('.continuation-pending-cancel'),
        editable: cue.getAttribute('contenteditable'),
        rev: document.getElementById('rev').textContent,
      };
    })()`);
    check('a running prediction is acknowledged beside the source paragraph',
      pending.after && /sonnet/i.test(pending.label) &&
      /drafting the next paragraph/i.test(pending.text) &&
      pending.cancel && pending.editable === 'false',
      JSON.stringify(pending));
    const stalePredictionFailure = await browser.eval(`(() => {
      onPredictionEvent({
        kind: 'failed',
        id: 'retired-prediction',
        anchor_pid: '${target.pid}',
        error: 'An older prediction failed.'
      });
      const result = {
        pending: document.querySelector('.continuation-pending') &&
          document.querySelector('.continuation-pending').dataset.prediction,
        status: !!document.querySelector('.sidecar-status[data-lane="continue"]'),
        active: window.__prediction.activeId
      };
      clearSidecarStatus('continue');
      return result;
    })()`);
    check('a late older prediction failure cannot cover newer drafting with an error',
      stalePredictionFailure.pending === active.id &&
      stalePredictionFailure.active === active.id &&
      stalePredictionFailure.status === false,
      JSON.stringify(stalePredictionFailure));
    const staleReady = await browser.eval(`(async () => {
      const nativeFetch = window.fetch;
      window.__errs = [];
      window.fetch = (input, init = {}) => {
        const url = new URL(String(input), location.href);
        if (url.pathname === '/api/predict/dismiss') {
          return Promise.reject(new TypeError('simulated stale-dismiss transport failure'));
        }
        return nativeFetch(input, init);
      };
      const pendingBefore = document.querySelector('.continuation-pending');
      onPredictionEvent({
        kind: 'ready',
        continuation: {
          id: 'retired-ready',
          capture_id: 'retired-capture',
          anchor_pid: '${target.pid}',
          text: 'This stale result must not replace current drafting.',
          status: 'open',
          at: new Date(0).toISOString()
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
      const pendingAfter = document.querySelector('.continuation-pending');
      const result = {
        active: window.__prediction.activeId,
        pending: pendingAfter && pendingAfter.dataset.prediction,
        sameCue: pendingBefore === pendingAfter,
        continuation: !!document.querySelector(
          '.continuation-note[data-continuation="retired-ready"]'),
        errors: [...(window.__errs || [])]
      };
      window.fetch = nativeFetch;
      window.__errs = [];
      return result;
    })()`);
    check('a late stale ready event cannot erase newer drafting or leak a rejection',
      staleReady.active === active.id && staleReady.pending === active.id &&
      staleReady.sameCue && !staleReady.continuation && staleReady.errors.length === 0,
      JSON.stringify(staleReady));
    const switchedDuringPrediction = await req('POST', '/api/model', { model: 'sol' });
    const predictionAfterSwitch = (await req('GET', '/api/predict')).body;
    const cueAfterSwitch = await browser.eval(
      `document.querySelector('.continuation-pending .continuation-label').textContent`);
    check('switching the main picker does not reroute an in-flight continuation',
      switchedDuringPrediction.status === 200 &&
      switchedDuringPrediction.body.model === 'sol' &&
      predictionAfterSwitch.active.id === active.id &&
      predictionAfterSwitch.active.model === 'sonnet' &&
      /sonnet/i.test(cueAfterSwitch),
      JSON.stringify({ switch: switchedDuringPrediction.body,
        active: predictionAfterSwitch.active, cue: cueAfterSwitch }));

    console.log('\n[ghost continuation]');
    const draft = [
      'That distinction also changes what the benchmark can support as evidence.',
      'A determinate task makes disagreement interpretable because the expected action sequence is fixed before a model runs.',
      'The remaining failures can then be separated into specification, platform, and implementation errors instead of being collapsed into one score.',
      'This is the point at which the evaluation becomes diagnostic rather than merely comparative.',
      'The next section applies that separation to the observed backtests.',
    ].join(' ');
    const fixture = await req('POST', '/api/predict/fixture', {
      text: `<continuation>${draft}</continuation>`,
    });
    check('a normalized one-paragraph result is accepted',
      fixture.status === 200 && fixture.body.continuation.text === draft,
      fixture.body.error);
    await browser.waitFor(`document.querySelector('.continuation-note')`, { timeout: 8000 });
    check('the progress cue retires before the ghost paragraph appears',
      !(await browser.eval(`!!document.querySelector('.continuation-pending')`)));
    const card = await browser.eval(`(() => {
      const anchor = document.querySelector('[data-pid="${target.pid}"]');
      const note = document.querySelector('.continuation-note');
      const style = getComputedStyle(note);
      return {
        after: anchor.nextElementSibling === note,
        text: note.querySelector('.continuation-text').textContent,
        editable: note.getAttribute('contenteditable'),
        role: note.getAttribute('role'),
        insert: !!note.querySelector('.continuation-insert'),
        label: note.querySelector('.continuation-label').textContent,
        border: style.borderLeftColor,
        glow: style.boxShadow,
        plays: window.__sound.plays,
        sound: window.__sound.last
      };
    })()`);
    check('the draft is attached after the paragraph as non-document ghost prose',
      card.after && card.text === draft && card.editable === 'false' &&
      card.role === 'note' && card.insert, JSON.stringify(card));
    check('the completed continuation keeps the model it actually used',
      /sonnet/i.test(card.label), card.label);
    check('the continuation uses a restrained soft-neon line and local chime',
      card.glow !== 'none' && !/rgba\\(0, 0, 0, 0\\)/.test(card.border) &&
      card.plays === 1 && card.sound === 'continue',
      `${card.border} / ${card.glow}`);
    const continuationRace = await browser.eval(`(() => {
      const current = ${JSON.stringify(fixture.body.continuation)};
      const newer = {
        ...current,
        id: current.id + '-newer',
        at: new Date(Date.parse(current.at) + 1000).toISOString()
      };
      renderContinuation(newer);
      renderContinuation(current);
      const afterOlderOpen = document.querySelector('.continuation-note');
      const olderOpenVisible = afterOlderOpen && afterOlderOpen.dataset.continuation;
      renderContinuation(newer);
      renderContinuation({ ...current, status: 'dismissed' });
      const visible = document.querySelector('.continuation-note');
      const result = {
        olderOpenVisible,
        visible: visible && visible.dataset.continuation,
        open: openContinuation && openContinuation.id
      };
      renderContinuation(null);
      renderContinuation(current);
      return result;
    })()`);
    check('a late older continuation snapshot or terminal event cannot replace a newer one',
      continuationRace.olderOpenVisible === `${fixture.body.continuation.id}-newer` &&
      continuationRace.visible === `${fixture.body.continuation.id}-newer` &&
      continuationRace.open === `${fixture.body.continuation.id}-newer`,
      JSON.stringify(continuationRace));
    const eventlessAccept = await browser.eval(`(async () => {
      const current = ${JSON.stringify(fixture.body.continuation)};
      const synthetic = {
        ...current,
        id: current.id + '-eventless',
        at: new Date(Date.parse(current.at) + 2000).toISOString()
      };
      const baseModel = JSON.parse(JSON.stringify(window.__scribe.model));
      const insertedModel = JSON.parse(JSON.stringify(baseModel));
      const anchorIndex = insertedModel.paragraphs.findIndex(
        (paragraph) => paragraph.pid === synthetic.anchor_pid);
      const inserted = {
        ...insertedModel.paragraphs[anchorIndex],
        pid: 'VIEWERCONTINUATIONINSERT',
        text: synthetic.text,
        hash: 'viewer-continuation-insert-hash',
        runs: [{ text: synthetic.text }]
      };
      insertedModel.paragraphs.splice(anchorIndex + 1, 0, inserted);
      insertedModel.count = insertedModel.paragraphs.length;
      insertedModel.rev = Number(baseModel.rev || 0) + 1;
      renderContinuation(synthetic);
      const nativeFetch = window.fetch;
      let releaseAccept;
      let releaseDoc;
      let docReads = 0;
      window.fetch = (input, init = {}) => {
        const url = new URL(String(input), location.href);
        if (url.pathname === '/api/predict/accept') {
          return new Promise((resolve) => {
            releaseAccept = () => resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve({
                continuation: { ...synthetic, status: 'accepted' },
                result: {
                  pid: inserted.pid,
                  after_pid: synthetic.anchor_pid,
                  text: synthetic.text
                },
                rev: insertedModel.rev
              })
            });
          });
        }
        if (url.pathname === '/api/doc') {
          docReads++;
          return new Promise((resolve) => {
            releaseDoc = () => resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve(insertedModel)
            });
          });
        }
        return nativeFetch(input, init);
      };
      document.querySelector('.continuation-insert').click();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const card = document.querySelector(
        '.continuation-note[data-continuation="' + synthetic.id + '"]');
      const mutuallyDisabled = !!card &&
        card.querySelector('.continuation-insert').disabled &&
        card.querySelector('.continuation-dismiss').disabled;
      releaseAccept();
      // A terminal event commonly beats the document refresh. It must not
      // retire the locally accepted card while that authoritative read waits.
      renderContinuation({ ...synthetic, status: 'accepted' });
      for (let i = 0; i < 100 && !releaseDoc; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const refreshingCard = document.querySelector(
        '.continuation-note[data-continuation="' + synthetic.id + '"]');
      const refreshingStatus = refreshingCard &&
        refreshingCard.querySelector('.continuation-action-status');
      const visibleWhileRefreshing = {
        card: !!refreshingCard,
        text: refreshingCard &&
          refreshingCard.querySelector('.continuation-text').textContent,
        status: refreshingStatus && refreshingStatus.textContent,
        role: refreshingStatus && refreshingStatus.getAttribute('role'),
        insertDisabled: !!refreshingCard &&
          refreshingCard.querySelector('.continuation-insert').disabled,
        dismissDisabled: !!refreshingCard &&
          refreshingCard.querySelector('.continuation-dismiss').disabled
      };
      await new Promise((resolve) => setTimeout(resolve, 80));
      const stayedVisible = !!document.querySelector(
        '.continuation-note[data-continuation="' + synthetic.id + '"]');
      releaseDoc();
      for (let i = 0; i < 50 && document.querySelector(
        '.continuation-note[data-continuation="' + synthetic.id + '"]'); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const retired = !document.querySelector(
        '.continuation-note[data-continuation="' + synthetic.id + '"]');
      const insertedEl = document.querySelector(
        '[data-pid="' + inserted.pid + '"]');
      const insertedText = insertedEl && insertedEl.textContent;
      window.fetch = nativeFetch;
      applyModel(baseModel);
      window.__scribe.rev = baseModel.rev;
      clearSidecarStatus('continue');
      renderContinuation(current);
      return {
        mutuallyDisabled,
        visibleWhileRefreshing,
        stayedVisible,
        retired,
        docReads,
        insertedText,
        expectedText: synthetic.text
      };
    })()`);
    check('an accepted continuation stays visible while its document refresh is delayed',
      eventlessAccept.mutuallyDisabled &&
      eventlessAccept.visibleWhileRefreshing.card &&
      eventlessAccept.visibleWhileRefreshing.text === eventlessAccept.expectedText &&
      /inserted.*refreshing/i.test(
        eventlessAccept.visibleWhileRefreshing.status || '') &&
      eventlessAccept.visibleWhileRefreshing.role === 'status' &&
      eventlessAccept.visibleWhileRefreshing.insertDisabled &&
      eventlessAccept.visibleWhileRefreshing.dismissDisabled &&
      eventlessAccept.stayedVisible,
      JSON.stringify(eventlessAccept));
    check('the continuation retires only after exact authoritative insertion is painted',
      eventlessAccept.retired &&
      eventlessAccept.docReads === 1 &&
      eventlessAccept.insertedText === eventlessAccept.expectedText,
      JSON.stringify(eventlessAccept));

    const lostAcceptAck = await browser.eval(`(async () => {
      const current = ${JSON.stringify(fixture.body.continuation)};
      const synthetic = {
        ...current,
        id: current.id + '-lost-accept-ack',
        at: new Date(Date.parse(current.at) + 2500).toISOString()
      };
      const baseModel = JSON.parse(JSON.stringify(window.__scribe.model));
      const insertedModel = JSON.parse(JSON.stringify(baseModel));
      const anchorIndex = insertedModel.paragraphs.findIndex(
        (paragraph) => paragraph.pid === synthetic.anchor_pid);
      const oldNextPid = insertedModel.paragraphs[anchorIndex + 1] &&
        insertedModel.paragraphs[anchorIndex + 1].pid;
      const inserted = {
        ...insertedModel.paragraphs[anchorIndex],
        pid: 'VIEWERLOSTACKINSERT',
        text: synthetic.text,
        hash: 'viewer-lost-ack-insert-hash',
        runs: [{ text: synthetic.text }]
      };
      insertedModel.paragraphs.splice(anchorIndex + 1, 0, inserted);
      insertedModel.count = insertedModel.paragraphs.length;
      insertedModel.rev = Number(baseModel.rev || 0) + 1;
      renderContinuation(synthetic);
      const nativeFetch = window.fetch;
      let releaseDoc;
      let releaseSnapshot;
      let acceptBody = null;
      window.fetch = (input, init = {}) => {
        const url = new URL(String(input), location.href);
        if (url.pathname === '/api/predict/accept') {
          acceptBody = JSON.parse(init.body || '{}');
          return Promise.reject(new TypeError('simulated lost accept response'));
        }
        if (url.pathname === '/api/doc') {
          return new Promise((resolve) => {
            releaseDoc = () => resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve(insertedModel)
            });
          });
        }
        if (url.pathname === '/api/predict') {
          // This cheap snapshot intentionally races ahead of the durable write
          // and still reports the old card as open.
          return new Promise((resolve) => {
            releaseSnapshot = () => resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve({
                document_token: baseModel.document_token,
                continuation: synthetic
              })
            });
          });
        }
        return nativeFetch(input, init);
      };
      document.querySelector('.continuation-insert').click();
      for (let i = 0; i < 100 && (!releaseDoc || !releaseSnapshot); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const checkingCard = document.querySelector(
        '.continuation-note[data-continuation="' + synthetic.id + '"]');
      const checkingStatus = checkingCard &&
        checkingCard.querySelector('.continuation-action-status');
      const visibleWhileChecking = {
        visible: !!checkingCard,
        status: checkingStatus && checkingStatus.textContent,
        insertDisabled: !!checkingCard &&
          checkingCard.querySelector('.continuation-insert').disabled,
        dismissDisabled: !!checkingCard &&
          checkingCard.querySelector('.continuation-dismiss').disabled
      };
      releaseSnapshot();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const survivedStaleOpenSnapshot = !!document.querySelector(
        '.continuation-note[data-continuation="' + synthetic.id + '"]');
      releaseDoc();
      for (let i = 0; i < 100 && document.querySelector(
        '.continuation-note[data-continuation="' + synthetic.id + '"]'); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const insertedEl = document.querySelector(
        '[data-pid="' + inserted.pid + '"]');
      const nextAfterAnchor = window.__scribe.model.paragraphs[
        window.__scribe.model.paragraphs.findIndex(
          (paragraph) => paragraph.pid === synthetic.anchor_pid) + 1];
      const result = {
        visibleWhileChecking,
        survivedStaleOpenSnapshot,
        retired: !document.querySelector(
          '.continuation-note[data-continuation="' + synthetic.id + '"]'),
        insertedText: insertedEl && insertedEl.textContent,
        nextPid: nextAfterAnchor && nextAfterAnchor.pid,
        oldNextPid,
        token: acceptBody && acceptBody.expect_document_token,
        expectedToken: baseModel.document_token
      };
      window.fetch = nativeFetch;
      applyModel(baseModel);
      window.__scribe.rev = baseModel.rev;
      clearSidecarStatus('continue');
      renderContinuation(current);
      return result;
    })()`);
    check('a lost Insert acknowledgement keeps the exact suggestion visible and locked while reconciling',
      lostAcceptAck.visibleWhileChecking.visible &&
      /checking/i.test(lostAcceptAck.visibleWhileChecking.status || '') &&
      lostAcceptAck.visibleWhileChecking.insertDisabled &&
      lostAcceptAck.visibleWhileChecking.dismissDisabled &&
      lostAcceptAck.survivedStaleOpenSnapshot,
      JSON.stringify(lostAcceptAck));
    check('an inserted document model outranks a racing pre-commit open-card snapshot',
      lostAcceptAck.retired &&
      lostAcceptAck.insertedText === draft &&
      lostAcceptAck.nextPid === 'VIEWERLOSTACKINSERT' &&
      lostAcceptAck.nextPid !== lostAcceptAck.oldNextPid &&
      lostAcceptAck.token === lostAcceptAck.expectedToken,
      JSON.stringify(lostAcceptAck));

    const identicalExistingNext = await browser.eval(`(async () => {
      const current = ${JSON.stringify(fixture.body.continuation)};
      const baseModel = JSON.parse(JSON.stringify(window.__scribe.model));
      const anchorIndex = baseModel.paragraphs.findIndex(
        (paragraph) => paragraph.pid === current.anchor_pid);
      const successor = baseModel.paragraphs[anchorIndex + 1];
      const synthetic = {
        ...current,
        id: current.id + '-identical-existing-next',
        text: successor.text,
        at: new Date(Date.parse(current.at) + 2750).toISOString()
      };
      renderContinuation(synthetic);
      const nativeFetch = window.fetch;
      window.fetch = (input) => {
        const url = new URL(String(input), location.href);
        if (url.pathname === '/api/predict/accept') {
          return Promise.reject(new TypeError('request never reached Scribe'));
        }
        if (url.pathname === '/api/doc') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(baseModel)
          });
        }
        if (url.pathname === '/api/predict') {
          return Promise.resolve({ ok: false, status: 503 });
        }
        return nativeFetch(input);
      };
      document.querySelector('.continuation-insert').click();
      for (let i = 0; i < 100; i++) {
        const status = document.querySelector(
          '.continuation-note[data-continuation="' + synthetic.id +
          '"] .continuation-action-status');
        if (status && /unknown/i.test(status.textContent)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const card = document.querySelector(
        '.continuation-note[data-continuation="' + synthetic.id + '"]');
      const status = card && card.querySelector('.continuation-action-status');
      const next = window.__scribe.model.paragraphs[
        window.__scribe.model.paragraphs.findIndex(
          (paragraph) => paragraph.pid === synthetic.anchor_pid) + 1];
      const result = {
        visible: !!card,
        status: status && status.textContent,
        insertDisabled: !!card &&
          card.querySelector('.continuation-insert').disabled,
        dismissDisabled: !!card &&
          card.querySelector('.continuation-dismiss').disabled,
        nextPid: next && next.pid,
        expectedNextPid: successor.pid,
        count: window.__scribe.model.paragraphs.length,
        expectedCount: baseModel.paragraphs.length
      };
      window.fetch = nativeFetch;
      continuationAcceptanceRefresh = null;
      renderContinuation(null);
      applyModel(baseModel);
      renderContinuation(current);
      return result;
    })()`);
    check('identical pre-existing next-paragraph text cannot masquerade as an accepted insert',
      identicalExistingNext.visible &&
      /unknown|reconnect/i.test(identicalExistingNext.status || '') &&
      identicalExistingNext.insertDisabled &&
      identicalExistingNext.dismissDisabled &&
      identicalExistingNext.nextPid === identicalExistingNext.expectedNextPid &&
      identicalExistingNext.count === identicalExistingNext.expectedCount,
      JSON.stringify(identicalExistingNext));

    const acceptedRefreshFailure = await browser.eval(`(async () => {
      const current = ${JSON.stringify(fixture.body.continuation)};
      const synthetic = {
        ...current,
        id: current.id + '-refresh-failure',
        at: new Date(Date.parse(current.at) + 3000).toISOString()
      };
      const beforeModel = window.__scribe.model;
      const beforeRev = window.__scribe.rev;
      renderContinuation(synthetic);
      const nativeFetch = window.fetch;
      let docReads = 0;
      window.fetch = (input, init = {}) => {
        const url = new URL(String(input), location.href);
        if (url.pathname === '/api/predict/accept') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({
              continuation: { ...synthetic, status: 'accepted' },
              result: { ok: true },
              rev: beforeRev + 1
            })
          });
        }
        if (url.pathname === '/api/doc') {
          docReads++;
          return Promise.resolve({ ok: false, status: 503 });
        }
        return nativeFetch(input, init);
      };
      document.querySelector('.continuation-insert').click();
      for (let i = 0; i < 100 && (
        document.querySelector(
          '.continuation-note[data-continuation="' + synthetic.id + '"]') ||
        !document.querySelector('.sidecar-status[data-lane="continue"]')
      ); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const card = document.querySelector(
        '.continuation-note[data-continuation="' + synthetic.id + '"]');
      const status = document.querySelector(
        '.sidecar-status[data-lane="continue"]');
      const result = {
        retired: !card,
        status: status && status.textContent,
        role: status && status.getAttribute('role'),
        error: status && status.dataset.error,
        docReads,
        sameModel: window.__scribe.model === beforeModel
      };
      window.fetch = nativeFetch;
      window.__scribe.rev = beforeRev;
      clearSidecarStatus('continue');
      renderContinuation(current);
      return result;
    })()`);
    check('an acknowledged insert with a failed refresh leaves visible refresh-pending status',
      acceptedRefreshFailure.retired &&
      /inserted.*refresh pending/i.test(acceptedRefreshFailure.status || '') &&
      acceptedRefreshFailure.role === 'status' &&
      acceptedRefreshFailure.error === 'false' &&
      acceptedRefreshFailure.docReads === 1 &&
      acceptedRefreshFailure.sameModel,
      JSON.stringify(acceptedRefreshFailure));
    check('generation itself does not advance the document revision',
      (await req('GET', '/api/health')).body.rev === 1);

    const countBefore = (await req('GET', '/api/doc')).body.paragraphs.length;
    const exceptionsBeforeDismiss = browser.exceptions.length;
    await browser.eval(`(() => {
      const nativeFetch = window.fetch.bind(window);
      window.__restoreDismissFetch = () => { window.fetch = nativeFetch; };
      window.fetch = (input, init = {}) => {
        const url = new URL(String(input), location.href);
        if (url.pathname === '/api/predict/dismiss') {
          return Promise.reject(new TypeError('simulated dismiss transport failure'));
        }
        return nativeFetch(input, init);
      };
      document.querySelector('.continuation-dismiss').click();
      return true;
    })()`);
    await sleep(250);
    await browser.eval(`(window.__restoreDismissFetch(), true)`);
    const refusedDismiss = await browser.eval(`(() => {
      const card = document.querySelector('.continuation-note');
      const status = card && card.querySelector('.continuation-action-status');
      const dismiss = card && card.querySelector('.continuation-dismiss');
      return {
        text: status && status.textContent,
        role: status && status.getAttribute('role'),
        error: card && card.dataset.error,
        dismissEnabled: !!dismiss && !dismiss.disabled
      };
    })()`);
    check('a failed dismiss stays visible, explains itself, and can be retried',
      /not dismissed/i.test(refusedDismiss.text || '') &&
      /unavailable/i.test(refusedDismiss.text || '') &&
      refusedDismiss.role === 'status' &&
      refusedDismiss.error === 'true' && refusedDismiss.dismissEnabled,
      JSON.stringify(refusedDismiss));
    check('a failed dismiss produces no unhandled browser error',
      browser.exceptions.length === exceptionsBeforeDismiss,
      browser.exceptions.slice(exceptionsBeforeDismiss).join(' | '));

    await req('POST', '/api/pause');
    await browser.eval(`(document.querySelector('.continuation-insert').click(), true)`);
    await browser.waitFor(
      `document.querySelector('.continuation-insert') &&
       !document.querySelector('.continuation-insert').disabled`,
      { timeout: 5000 });
    const refusedInsert = await browser.eval(`(() => {
      const card = document.querySelector('.continuation-note');
      const status = card.querySelector('.continuation-action-status');
      return {
        text: status && status.textContent,
        role: status && status.getAttribute('role'),
        error: card.dataset.error,
        insertEnabled: !card.querySelector('.continuation-insert').disabled
      };
    })()`);
    check('a refused Insert explains visibly that nothing was inserted',
      /not inserted/i.test(refusedInsert.text || '') &&
      /paused/i.test(refusedInsert.text || '') &&
      refusedInsert.role === 'status' &&
      refusedInsert.error === 'true' && refusedInsert.insertEnabled,
      JSON.stringify(refusedInsert));
    check('the refused Insert leaves the document and suggestion intact',
      (await req('GET', '/api/health')).body.rev === 1 &&
      (await req('GET', '/api/doc')).body.paragraphs.length === countBefore &&
      !!(await browser.eval(`document.querySelector('.continuation-note')`)));
    await req('POST', '/api/resume');
    await browser.eval(`(document.querySelector('.continuation-insert').click(), true)`);
    await waitFor(async () => (await req('GET', '/api/health')).body.rev === 2);
    const insertedModel = (await req('GET', '/api/doc')).body;
    const anchorIndex = insertedModel.paragraphs.findIndex((p) => p.pid === target.pid);
    check('insert is the only action that writes the prediction',
      insertedModel.paragraphs.length === countBefore + 1 &&
      insertedModel.paragraphs[anchorIndex + 1].text === draft);
    check('an accepted body continuation preserves the surrounding paragraph style',
      insertedModel.paragraphs[anchorIndex + 1].style === saved.style,
      `${saved.style} -> ${insertedModel.paragraphs[anchorIndex + 1].style}`);
    await browser.waitFor(`!document.querySelector('.continuation-note')`, { timeout: 5000 });
    const undo = await req('POST', '/api/undo');
    check('the accepted continuation is one ordinary undo step',
      undo.status === 200 &&
      (await req('GET', '/api/doc')).body.paragraphs.length === countBefore);

    console.log('\n[provider mapping and overlap]');
    const switched = await req('POST', '/api/model', { model: 'sol' });
    check('Sol remains selected for ordinary work without starting it',
      switched.status === 200 && switched.body.model === 'sol' &&
      (await req('GET', '/api/agent')).body.running === false);
    await browser.eval(`(document.getElementById('watch-toggle').click(), true)`);
    await waitFor(async () => (await req('GET', '/api/watch')).body.enabled === true);
    const nextModel = (await req('GET', '/api/doc')).body;
    const next = nextModel.paragraphs.find((p) =>
      p.pid !== target.pid && !p.table && p.text.length > 180);
    const nextText = next.text + ' [overlap seed]';
    await typeParagraph(browser, next.pid, nextText);
    const watchReview = await waitFor(async () =>
      (await req('GET', '/api/watch')).body.active || null, 5000);
    const terraPrediction = await waitFor(async () =>
      (await req('GET', '/api/predict')).body.active || null, 6000);
    check('Watch gets its 25-second-equivalent window before continuation drafting',
      !!watchReview.id && !!terraPrediction.id);
    check('Watch captures the same cheaper Codex route for its own future job',
      watchReview.model === 'terra' && watchReview.provider === 'codex',
      JSON.stringify(watchReview));
    check('the cheaper Codex lane maps Sol to Terra',
      terraPrediction.model === 'terra' && terraPrediction.provider === 'codex',
      JSON.stringify(terraPrediction));
    const overlap = {
      agent: (await req('GET', '/api/agent')).body,
      watch: (await req('GET', '/api/watch')).body,
      predict: (await req('GET', '/api/predict')).body,
    };
    check('Watch and prediction overlap without touching the editing agent',
      overlap.agent.running === false && overlap.watch.reviewer.running === false &&
      overlap.predict.runner.running === false &&
      overlap.watch.active.id === watchReview.id &&
      overlap.predict.active.id === terraPrediction.id);

    const resumedText = nextText + ' and resumed';
    await typeParagraph(browser, next.pid, resumedText);
    await waitFor(async () => (await req('GET', '/api/predict')).body.active === null, 3000);
    check('resuming typing cancels the in-flight prediction immediately',
      (await req('GET', '/api/predict')).body.active === null);
    check('resuming typing removes the attached drafting cue',
      !(await browser.eval(`!!document.querySelector('.continuation-pending')`)));
    const staleFixture = await req('POST', '/api/predict/fixture', {
      text: `<continuation>${draft}</continuation>`,
    });
    check('a cancelled prediction cannot attach a late result',
      staleFixture.status === 409 && !documentHasContinuation(await req('GET', '/api/predict')));
    await browser.eval(`(cancelPredictionCapture('test cleanup'), true)`);
    await browser.eval(`(document.getElementById('watch-toggle').click(), true)`);
    await waitFor(async () => (await req('GET', '/api/watch')).body.enabled === false);

    const terraOff = await req('POST', '/api/models', { model: 'terra', enabled: false });
    check('excluding Terra reroutes only future automatic work to Sol',
      terraOff.status === 200 &&
      terraOff.body.automatic.watch === 'sol' &&
      terraOff.body.automatic.continue === 'sol' &&
      (await req('GET', '/api/agent')).body.running === false,
      JSON.stringify(terraOff.body));
    const cancelText = resumedText + ' with a manual cancellation check';
    await typeParagraph(browser, next.pid, cancelText);
    const manualJob = await waitFor(async () =>
      (await req('GET', '/api/predict')).body.active || null, 6000);
    check('the next prediction uses the enabled deep fallback',
      manualJob.model === 'sol' && manualJob.provider === 'codex',
      JSON.stringify(manualJob));
    await browser.waitFor(
      `document.querySelector('.continuation-pending[data-prediction="${manualJob.id}"]')`,
      { timeout: 5000 });
    await browser.eval(`(document.querySelector('.continuation-pending-cancel').click(), true)`);
    await waitFor(async () => (await req('GET', '/api/predict')).body.active === null, 3000);
    const manuallyCancelled = {
      predict: (await req('GET', '/api/predict')).body,
      agent: (await req('GET', '/api/agent')).body,
      watch: (await req('GET', '/api/watch')).body,
      cue: await browser.eval(`!!document.querySelector('.continuation-pending')`),
    };
    check('the attached cancel control retires the predictive job, not just its cue',
      manuallyCancelled.predict.active === null &&
      manuallyCancelled.predict.runner.running === false &&
      manuallyCancelled.cue === false, JSON.stringify(manuallyCancelled));
    check('manual predictive cancellation leaves both existing model lanes untouched',
      manuallyCancelled.agent.running === false &&
      manuallyCancelled.watch.reviewer.running === false);
    await req('POST', '/api/models', { model: 'terra', enabled: true });

    console.log('\n[visible quiet outcomes]');
    const noSuggestionText = cancelText + ' with a no-suggestion check';
    await typeParagraph(browser, next.pid, noSuggestionText);
    const noSuggestionJob = await waitFor(async () =>
      (await req('GET', '/api/predict')).body.active || null, 6000);
    const noSuggestionRev = (await req('GET', '/api/health')).body.rev;
    const noSuggestion = await req('POST', '/api/predict/fixture', {
      text: '<continuation>NO_SUGGESTION</continuation>',
    });
    check('a safe no-suggestion result completes without inventing prose',
      noSuggestion.status === 200 && noSuggestion.body.continuation === null &&
      (await req('GET', '/api/health')).body.rev === noSuggestionRev,
      JSON.stringify(noSuggestion.body));
    await browser.waitFor(
      `document.querySelector(
        '.sidecar-status[data-lane="continue"][data-error="false"]')`,
      { timeout: 5000 });
    const quietStatus = await browser.eval(`(() => {
      const anchor = document.querySelector('[data-pid="${next.pid}"]');
      const status = document.querySelector('.sidecar-status[data-lane="continue"]');
      return {
        adjacent: anchor.nextElementSibling === status,
        text: status.textContent,
        role: status.getAttribute('role'),
        editable: status.getAttribute('contenteditable')
      };
    })()`);
    check('Continue explains its quiet outcome beside the exact paragraph',
      quietStatus.adjacent && /no useful next paragraph/i.test(quietStatus.text) &&
      quietStatus.role === 'status' && quietStatus.editable === 'false',
      JSON.stringify(quietStatus));

    const failureText = noSuggestionText + ' with a failure check';
    await typeParagraph(browser, next.pid, failureText);
    check('new typing clears the prior outcome before arming the next job',
      !(await browser.eval(`!!document.querySelector('.sidecar-status[data-lane="continue"]')`)));
    const failedJob = await waitFor(async () =>
      (await req('GET', '/api/predict')).body.active || null, 6000);
    const refusedDraft = await req('POST', '/api/predict/fixture', {
      text: 'not a tagged continuation',
    });
    check('an unusable model result retires the job',
      refusedDraft.status === 200 && refusedDraft.body.continuation === null &&
      (await req('GET', '/api/predict')).body.active === null,
      JSON.stringify({ failedJob, result: refusedDraft.body }));
    await browser.waitFor(
      `document.querySelector(
        '.sidecar-status[data-lane="continue"][data-error="true"]')`,
      { timeout: 5000 });
    const failedStatus = await browser.eval(`(() => {
      const status = document.querySelector('.sidecar-status[data-lane="continue"]');
      return {
        text: status.textContent,
        error: status.dataset.error,
        dismiss: !!status.querySelector('.sidecar-status-dismiss')
      };
    })()`);
    check('Continue leaves one dismissible local explanation after failure',
      /did not return a safe paragraph/i.test(failedStatus.text) &&
      failedStatus.error === 'true' && failedStatus.dismiss,
      JSON.stringify(failedStatus));
    await browser.eval(`(document.querySelector(
      '.sidecar-status[data-lane="continue"] .sidecar-status-dismiss').click(), true)`);
    check('dismissing the explanation writes nothing and starts nothing',
      !(await browser.eval(`!!document.querySelector('.sidecar-status[data-lane="continue"]')`)) &&
      (await req('GET', '/api/agent')).body.running === false &&
      (await req('GET', '/api/watch')).body.reviewer.running === false &&
      (await req('GET', '/api/predict')).body.runner.running === false);

    console.log('\n[request transport failure]');
    await browser.eval(`(() => {
      const nativeFetch = window.fetch.bind(window);
      window.__restorePredictFetch = () => { window.fetch = nativeFetch; };
      window.fetch = (input, init = {}) => {
        const url = new URL(String(input), location.href);
        const method = String(init.method || 'GET').toUpperCase();
        if (url.pathname === '/api/predict' && method === 'POST') {
          return Promise.reject(new TypeError('simulated prediction transport failure'));
        }
        return nativeFetch(input, init);
      };
      return true;
    })()`);
    const transportText = failureText + ' with a transport failure check';
    await typeParagraph(browser, next.pid, transportText);
    await sleep(1800);
    await browser.eval(`(window.__restorePredictFetch(), true)`);
    const transportStatus = await browser.eval(`(() => {
      const anchor = document.querySelector('[data-pid="${next.pid}"]');
      const status = document.querySelector(
        '.sidecar-status[data-lane="continue"][data-error="true"]');
      return {
        adjacent: !!status && anchor.nextElementSibling === status,
        text: status && status.textContent,
        requesting: window.__prediction.requesting,
        pending: !!document.querySelector('.continuation-pending')
      };
    })()`);
    const transportLanes = {
      predict: (await req('GET', '/api/predict')).body,
      agent: (await req('GET', '/api/agent')).body,
      watch: (await req('GET', '/api/watch')).body,
    };
    check('a failed initial Continue request is explained beside its paragraph',
      transportStatus.adjacent && /unavailable|could not start/i.test(transportStatus.text || '') &&
      transportStatus.requesting === false && transportStatus.pending === false,
      JSON.stringify(transportStatus));
    check('the rejected request leaves every model lane stopped',
      transportLanes.predict.active === null &&
      transportLanes.predict.runner.running === false &&
      transportLanes.agent.running === false &&
      transportLanes.watch.reviewer.running === false,
      JSON.stringify(transportLanes));
    await browser.eval(`(cancelPredictionCapture('test cleanup'), clearSidecarStatus('continue'), true)`);

    console.log('\n[concurrent continuation acceptance]');
    const acceptanceRaceSeed = transportText + ' with an acceptance race check';
    await typeParagraph(browser, next.pid, acceptanceRaceSeed);
    const acceptanceRaceJob = await waitFor(async () =>
      (await req('GET', '/api/predict')).body.active || null, 6000);
    const acceptanceRaceText = [
      'This deterministic continuation tests concurrent acceptance without using an external model.',
      'Only one request may insert it into the document.',
      'The competing request must be refused while the first transaction remains in progress.',
      'A single Undo must then remove the entire accepted paragraph.',
    ].join(' ');
    const acceptanceRaceFixture = await req('POST', '/api/predict/fixture', {
      text: `<continuation>${acceptanceRaceText}</continuation>`,
    });
    const acceptanceRaceContinuation = acceptanceRaceFixture.body.continuation;
    const acceptanceRaceBefore = (await req('GET', '/api/doc')).body;
    const firstContinuationAccept = req('POST', '/api/predict/accept', {
      id: acceptanceRaceContinuation.id,
      __test_delay_after_mutation_ms: 500,
    });
    await sleep(100);
    const secondContinuationAccept = await req('POST', '/api/predict/accept', {
      id: acceptanceRaceContinuation.id,
    });
    const acceptedContinuation = await firstContinuationAccept;
    const acceptanceRaceAfter = (await req('GET', '/api/doc')).body;
    check('two continuation accepts permit one commit and refuse the other',
      acceptanceRaceJob && acceptanceRaceFixture.status === 200 &&
      acceptedContinuation.status === 200 &&
      secondContinuationAccept.status === 409 &&
      /in progress/i.test(secondContinuationAccept.body.error || ''),
      `${acceptedContinuation.status}/${secondContinuationAccept.status}: ` +
        `${secondContinuationAccept.body.error || ''}`);
    check('concurrent continuation acceptance inserts exactly one paragraph',
      acceptanceRaceAfter.count === acceptanceRaceBefore.count + 1 &&
      acceptanceRaceAfter.rev === acceptanceRaceBefore.rev + 1 &&
      acceptanceRaceAfter.paragraphs.filter((paragraph) =>
        paragraph.text === acceptanceRaceText).length === 1,
      `${acceptanceRaceBefore.count}->${acceptanceRaceAfter.count}, ` +
        `rev ${acceptanceRaceBefore.rev}->${acceptanceRaceAfter.rev}`);
    const acceptanceRaceUndo = await req('POST', '/api/undo');
    check('the one continuation commit remains one exact Undo unit',
      acceptanceRaceUndo.status === 200 &&
      !(await req('GET', '/api/doc')).body.paragraphs.some((paragraph) =>
        paragraph.text === acceptanceRaceText),
      acceptanceRaceUndo.body.error);

    const errors = await browser.eval('JSON.stringify(window.__errs || null)');
    check('the predictive flow logs no browser errors', errors === '[]', errors);
    check('the browser throws no uncaught exceptions', browser.exceptions.length === 0,
      browser.exceptions.slice(0, 2).join(' | '));
  } catch (error) {
    console.error('\nTEST ERROR:', error && error.stack || error);
    hardFail = true;
  } finally {
    if (browser) browser.kill();
    server.kill();
    await sleep(800);
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(TMP, { recursive: true, force: true }); break; }
      catch (_) { await sleep(300); }
    }
  }

  console.log(`\n${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length || hardFail) {
    if (FAIL.length) console.log('failed: ' + FAIL.join(', '));
    console.log('\n--- server log ---\n' + logs.join('').slice(-4000));
  }
  process.exit(FAIL.length || hardFail ? 1 : 0);
}

function documentHasContinuation(response) {
  return !!(response && response.body && response.body.continuation);
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
