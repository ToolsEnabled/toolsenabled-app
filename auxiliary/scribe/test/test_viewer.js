#!/usr/bin/env node
'use strict';
/**
 * Viewer tests, driven against a real headless browser.
 *
 * The load-bearing assertion is "patched, not rebuilt". Everything else about
 * the glow is cosmetic if the DOM is thrown away and recreated on every edit,
 * because the animation would restart on all 333 paragraphs and the one that
 * actually changed would be indistinguishable.
 *
 * Run: node test/test_viewer.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Browser, findBrowser, sleep } = require('./cdp');
const { requiredLiveFile } = require('./live-input');

const ROOT = path.join(__dirname, '..');
let PORT = null;
let BASE = null;
// The port is already per-run; the document workspace must be too. A fixed
// directory lets two otherwise isolated viewer runs delete or replace each
// other's active DOCX, which correctly triggers Scribe's ownership retirement
// and makes unrelated browser assertions appear flaky.
const TMP = path.join(__dirname, `_tmp_view_${process.pid}`);
const PAPER = requiredLiveFile('SCRIBE_TEST_DOCX');
const TABLED = requiredLiveFile('SCRIBE_TEST_LEGACY_DOCX');

const PASS = [], FAIL = [];
const check = (n, c, d) => { (c ? PASS : FAIL).push(n); console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${d !== undefined ? '  ' + d : ''}`); };

function reserveFreeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = address && address.port;
      probe.close((error) => {
        if (error) reject(error);
        else if (!Number.isInteger(port) || port < 1) {
          reject(new Error('Could not reserve an isolated viewer-test port.'));
        } else {
          resolve(port);
        }
      });
    });
  });
}

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(`${BASE}${p}`, { method, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
      (res) => { let o = ''; res.on('data', (c) => o += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(o || '{}') }); } catch (_) { resolve({ status: res.statusCode, body: o }); } }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

async function main() {
  if (!findBrowser()) { console.log('No Chrome or Edge found, skipping viewer tests.'); process.exit(0); }

  PORT = await reserveFreeLoopbackPort();
  BASE = `http://127.0.0.1:${PORT}`;
  const resolvedTmp = path.resolve(TMP);
  if (path.dirname(resolvedTmp) !== path.resolve(__dirname) ||
      !path.basename(resolvedTmp).startsWith('_tmp_view')) {
    throw new Error(`Refusing to clear unsafe viewer-test directory: ${resolvedTmp}`);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'data'), { recursive: true });
  const doc = path.join(TMP, 'paper.docx');
  const tdoc = path.join(TMP, 'tabled.docx');
  fs.copyFileSync(PAPER, doc);
  fs.copyFileSync(TABLED, tdoc);

  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SCRIBE_PORT: String(PORT), SCRIBE_DATA: path.join(TMP, 'data') },
  });
  const srvLog = [];
  srv.stdout.on('data', (d) => srvLog.push(d.toString()));
  srv.stderr.on('data', (d) => srvLog.push(d.toString()));

  let browser = null, hardFail = false;
  try {
    let ownedHealth = null;
    for (let i = 0; i < 60; i++) {
      try {
        const health = await req('GET', '/api/health');
        if (health.status === 200) {
          if (health.body.serverPid !== srv.pid) {
            const ownershipError = new Error(
              `Viewer test port ${PORT} is owned by pid ${health.body.serverPid}; ` +
              `spawned server pid is ${srv.pid}.`,
            );
            ownershipError.viewerOwnership = true;
            throw ownershipError;
          }
          if (health.body.ok === true) {
            ownedHealth = health.body;
            break;
          }
        }
      } catch (error) {
        if (error && error.viewerOwnership) throw error;
      }
      await sleep(250);
    }
    if (!ownedHealth) {
      throw new Error(
        `The isolated viewer server (pid ${srv.pid}, port ${PORT}) did not become healthy.`,
      );
    }
    check('viewer harness is connected only to its spawned server',
      ownedHealth.serverPid === srv.pid,
      JSON.stringify({ port: PORT, expected: srv.pid, actual: ownedHealth.serverPid }));

    browser = await Browser.launch({ headless: true });
    await browser.attachToPage();
    await browser.collectErrors();

    console.log('\n[render]');
    const t0 = Date.now();
    await browser.goto(BASE + '/');
    await browser.waitFor(`document.getElementById('health-dot').classList.contains('ok')`, { timeout: 10000 });
    check('the empty paper offers the document picker',
      await browser.eval(`document.getElementById('paper').classList.contains('is-empty') &&
        !!document.getElementById('empty-open')`) === true);
    check('the empty state explains that the original stays untouched',
      /original stays untouched/.test(await browser.eval(`document.querySelector('.empty-state p').textContent`)));
    check('there is no revision label before a document exists',
      await browser.eval(`document.getElementById('rev').hidden`) === true);

    console.log('\n[message delivery]');
    await browser.eval(`(() => {
      const input = document.getElementById('say');
      const form = document.getElementById('bar');
      input.value = 'Keep this message';
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    })()`);
    await browser.waitFor(`document.getElementById('say').value === 'Keep this message' &&
      document.getElementById('bar').dataset.delivery === 'error'`, { timeout: 5000 });
    const rejectedMessage = await browser.eval(`({
      draft: document.getElementById('say').value,
      hint: document.getElementById('lane-hint').textContent,
      busy: document.getElementById('bar').hasAttribute('aria-busy'),
      sendDisabled: document.getElementById('send').disabled
    })`);
    check('an undelivered message returns to the composer with a clear reason',
      rejectedMessage.draft === 'Keep this message' &&
      rejectedMessage.hint === 'Open a document first.', JSON.stringify(rejectedMessage));
    check('the composer is ready to retry after delivery settles',
      rejectedMessage.busy === false && rejectedMessage.sendDisabled === false,
      JSON.stringify(rejectedMessage));
    const rejectedTrail = (await req('GET', '/api/trail')).body.trail || [];
    check('rapid submission records the message only once',
      rejectedTrail.filter((entry) => entry.op === 'said' &&
        entry.summary === 'Keep this message').length === 1);
    const rejectedAgent = (await req('GET', '/api/agent')).body;
    check('a rejected message does not start a model process',
      rejectedAgent.running === false,
      JSON.stringify({ running: rejectedAgent.running }));
    await browser.eval(`(() => {
      const input = document.getElementById('say');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.blur();
    })()`);
    await browser.eval(`(() => {
      window.__httpAwareFetch = window.fetch;
      window.fetch = (...args) => {
        const url = new URL(args[0], location.href);
        if (url.pathname === '/api/say') {
          return Promise.resolve({
            ok: false,
            status: 503,
            json: () => Promise.reject(new SyntaxError('empty response'))
          });
        }
        return window.__httpAwareFetch(...args);
      };
      const input = document.getElementById('say');
      input.value = 'Survive an empty 503';
      document.getElementById('bar').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }));
      return true;
    })()`);
    await browser.waitFor(`document.getElementById('say').value === 'Survive an empty 503' &&
      document.getElementById('bar').dataset.delivery === 'error'`, { timeout: 5000 });
    const emptyHttpMessage = await browser.eval(`({
      draft: document.getElementById('say').value,
      hint: document.getElementById('lane-hint').textContent,
      errors: [...(window.__errs || [])]
    })`);
    check('an empty HTTP 503 cannot silently consume a message',
      emptyHttpMessage.draft === 'Survive an empty 503' &&
      /503|unavailable|still here/i.test(emptyHttpMessage.hint || '') &&
      emptyHttpMessage.errors.length === 0,
      JSON.stringify(emptyHttpMessage));
    await browser.eval(`(() => {
      window.fetch = window.__httpAwareFetch;
      delete window.__httpAwareFetch;
      const input = document.getElementById('say');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.blur();
      window.__errs = [];
      return true;
    })()`);

    const firstDom = await browser.send('DOM.getDocument');
    const firstInput = await browser.send('DOM.querySelector', {
      nodeId: firstDom.root.nodeId, selector: '#doc-file',
    });
    await browser.send('DOM.setFileInputFiles', { files: [doc], nodeId: firstInput.nodeId });
    await browser.waitFor('document.querySelectorAll(".para").length > 300', { timeout: 20000 });
    const firstPaint = Date.now() - t0;

    const n = await browser.eval('document.querySelectorAll(".para").length');
    check('renders all 333 paragraphs', n === 333, n);
    const withPid = await browser.eval('[...document.querySelectorAll(".para")].filter(e=>e.dataset.pid).length');
    check('every paragraph carries data-pid', withPid === 333, withPid);
    const uniq = await browser.eval('new Set([...document.querySelectorAll(".para")].map(e=>e.dataset.pid)).size');
    check('paragraph ids are unique in the DOM', uniq === 333, uniq);
    const runs = await browser.eval('document.querySelectorAll(".para [data-run]").length');
    check('runs are individually addressable', runs > 300, runs);
    const docButton = await browser.eval('document.getElementById("doc-name").textContent');
    check('the document name is the open-document control', docButton === 'paper.docx', docButton);
    const acceptsDocx = await browser.eval('document.getElementById("doc-file").accept.includes(".docx")');
    check('the native picker is restricted to Word documents', acceptsDocx === true);
    check('the empty treatment clears once the document opens',
      await browser.eval(`!document.getElementById('paper').classList.contains('is-empty') &&
        !document.querySelector('.empty-state')`) === true);
    const revision = await browser.eval(`({
      text:document.getElementById('rev').textContent,
      hidden:document.getElementById('rev').hidden
    })`);
    check('the open document gets a legible revision label',
      revision.hidden === false && revision.text === 'revision 0', JSON.stringify(revision));
    console.log(`  first paint: ${firstPaint} ms`);

    console.log('\n[format-only repaint]');
    const formatOnlyRepaint = await browser.eval(`(() => {
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const canonical = clone(app.model);
      const target = canonical.paragraphs.find((paragraph) =>
        !paragraph.table && paragraph.style === 'Normal' &&
        paragraph.text.length > 30);
      const el = document.querySelector('[data-pid="' + target.pid + '"]');
      const originalElement = el;
      const originalHash = target.hash;

      const boldModel = clone(canonical);
      const boldParagraph = boldModel.paragraphs.find(
        (paragraph) => paragraph.pid === target.pid);
      boldParagraph.runs = [{ text: boldParagraph.text, b: true }];
      boldParagraph.format_hash = 'viewer-format-only-bold';
      const boldRender = applyModel(boldModel);
      const afterBold = document.querySelector(
        '[data-pid="' + target.pid + '"]');
      const boldState = {
        sameElement: originalElement === afterBold,
        textHash: afterBold.dataset.hash,
        formatHash: afterBold.dataset.formatHash,
        weight: afterBold.querySelector('span').style.fontWeight
      };

      // Models produced before format_hash existed remain repaintable: their
      // text hash is also the formatting fallback fingerprint.
      const legacyModel = clone(boldModel);
      const legacyParagraph = legacyModel.paragraphs.find(
        (paragraph) => paragraph.pid === target.pid);
      delete legacyParagraph.format_hash;
      legacyParagraph.runs = [{ text: legacyParagraph.text, i: true }];
      const legacyRender = applyModel(legacyModel);
      const afterLegacy = document.querySelector(
        '[data-pid="' + target.pid + '"]');
      const legacyState = {
        formatHash: afterLegacy.dataset.formatHash,
        italic: afterLegacy.querySelector('span').style.fontStyle
      };

      // A formatting refresh must never replace unsaved plaintext or move its
      // caret. Cancelling that draft should then reveal the newest formatting
      // already retained in app.model.
      afterLegacy.focus();
      beginDirectEdit(afterLegacy);
      const localDraft = target.text + ' [local format-hash draft]';
      afterLegacy.textContent = localDraft;
      const edit = directEdits.get(target.pid);
      edit.dirty = true;
      restoreCaret(afterLegacy, 7);
      const dirtyModel = clone(legacyModel);
      const dirtyParagraph = dirtyModel.paragraphs.find(
        (paragraph) => paragraph.pid === target.pid);
      dirtyParagraph.format_hash = 'viewer-format-while-dirty';
      dirtyParagraph.runs = [{ text: dirtyParagraph.text, b: true }];
      const dirtyRender = applyModel(dirtyModel);
      const dirtyProtected = {
        text: afterLegacy.textContent,
        focused: document.activeElement === afterLegacy,
        caret: caretOffset(afterLegacy),
        formatHash: afterLegacy.dataset.formatHash
      };
      cancelDirectEdit(afterLegacy);
      const revealed = document.querySelector(
        '[data-pid="' + target.pid + '"]');
      const revealedBold = revealed.querySelector('span').style.fontWeight;

      applyModel(canonical);
      return {
        originalHash,
        boldRender,
        boldState,
        legacyRender,
        legacyState,
        dirtyRender,
        dirtyProtected,
        localDraft,
        revealedBold
      };
    })()`);
    check('a changed format_hash repaints same-text runs without rebuilding the paragraph',
      formatOnlyRepaint.boldRender.rebuilt === false &&
      formatOnlyRepaint.boldRender.patched === 1 &&
      formatOnlyRepaint.boldState.sameElement &&
      formatOnlyRepaint.boldState.textHash === formatOnlyRepaint.originalHash &&
      formatOnlyRepaint.boldState.formatHash === 'viewer-format-only-bold' &&
      formatOnlyRepaint.boldState.weight === '700',
      JSON.stringify(formatOnlyRepaint));
    check('models without format_hash keep the text-hash fallback behavior',
      formatOnlyRepaint.legacyRender.rebuilt === false &&
      formatOnlyRepaint.legacyRender.patched === 1 &&
      formatOnlyRepaint.legacyState.formatHash === formatOnlyRepaint.originalHash &&
      formatOnlyRepaint.legacyState.italic === 'italic',
      JSON.stringify(formatOnlyRepaint));
    check('a format-only refresh preserves an unsaved draft and caret, then appears when editing ends',
      formatOnlyRepaint.dirtyRender.rebuilt === false &&
      formatOnlyRepaint.dirtyRender.patched === 0 &&
      formatOnlyRepaint.dirtyProtected.text === formatOnlyRepaint.localDraft &&
      formatOnlyRepaint.dirtyProtected.focused &&
      formatOnlyRepaint.dirtyProtected.caret === 7 &&
      formatOnlyRepaint.dirtyProtected.formatHash === formatOnlyRepaint.originalHash &&
      formatOnlyRepaint.revealedBold === '700',
      JSON.stringify(formatOnlyRepaint));

    const formattingStatus = await browser.eval(`(() => {
      clearTimeout(formattingAppliedTimer);
      const prior = { ...formatting };
      const priorActive = formatting.active;
      const priorRunner = formatting.runner;
      const priorAutomatic = { ...modelPool.automatic };
      const priorDocumentToken = app.documentToken;
      const currentToken = capturedDocumentToken(app.model) ||
        'viewer-format-current-owner';
      if (!capturedDocumentToken(app.model)) app.documentToken = currentToken;

      const snapshotApplied = applyFormattingSnapshot({
        enabled: true,
        status: 'collecting',
        pending_words: 418,
        pending_paragraphs: 4,
        threshold_words: 600,
        quiet_ms: 90000,
        cooldown_ms: 1800000,
        active: null,
        runner: { running: false, busy: false },
        document_token: currentToken
      });
      const collecting = {
        state: document.getElementById('format-toggle').dataset.state,
        pressed: document.getElementById('format-toggle')
          .getAttribute('aria-pressed'),
        title: document.getElementById('format-toggle').title,
        describedBy: document.getElementById('format-toggle')
          .getAttribute('aria-describedby'),
        statusRole: document.getElementById('format-status')
          .getAttribute('role'),
        statusLive: document.getElementById('format-status')
          .getAttribute('aria-live'),
        statusText: document.getElementById('format-status').textContent,
        manualControls: document.querySelectorAll(
          '[data-format-command], #bold, #italic, #underline, #font-size'
        ).length
      };
      onFormattingEvent({
        kind: 'queued',
        id: 'viewer-format-job',
        pending_words: 641,
        pending_paragraphs: 5,
        document_token: currentToken
      });
      const queued = document.getElementById('format-toggle').dataset.state;
      onFormattingEvent({
        kind: 'reviewing',
        id: 'viewer-format-job',
        model: 'sonnet',
        provider: 'claude',
        document_token: currentToken
      });
      const reviewing = document.getElementById('format-toggle').dataset.state;
      const staleAccepted = onFormattingEvent({
        kind: 'failed',
        id: 'viewer-format-job',
        error: 'must stay invisible',
        document_token: 'viewer-format-stale-owner'
      });
      const afterStale = document.getElementById('format-toggle').dataset.state;
      onFormattingEvent({
        kind: 'applied',
        id: 'viewer-format-job',
        count: 3,
        document_token: currentToken
      });
      const applied = {
        state: document.getElementById('format-toggle').dataset.state,
        title: document.getElementById('format-toggle').title
      };

      applyModelPool({
        enabled: [...modelPool.enabled],
        selected: modelPool.selected,
        automatic: {
          watch: modelPool.automatic.watch,
          continue: modelPool.automatic.continue,
          format: 'terra'
        }
      });
      const route = document.getElementById('model-pool-route').textContent;

      clearTimeout(formattingAppliedTimer);
      formattingAppliedTimer = null;
      Object.assign(formatting, prior);
      formatting.active = priorActive;
      formatting.runner = priorRunner;
      app.documentToken = priorDocumentToken;
      modelPool.automatic = priorAutomatic;
      refreshFormattingState();
      renderModelPool();
      return {
        snapshotApplied,
        collecting,
        queued,
        reviewing,
        staleAccepted,
        afterStale,
        applied,
        route,
        validEvent: !!parseSsePayload('format', JSON.stringify({
          kind: 'collecting',
          pending_words: 10,
          pending_paragraphs: 1
        })),
        invalidEvent: parseSsePayload('format', JSON.stringify({
          kind: 'rewriting',
          pending_words: 'many'
        })) === null
      };
    })()`);
    check('the compact format control explains its sparse formatting-only threshold',
      formattingStatus.snapshotApplied &&
      formattingStatus.collecting.state === 'collecting' &&
      formattingStatus.collecting.pressed === 'true' &&
      /600/.test(formattingStatus.collecting.title) &&
      /90/.test(formattingStatus.collecting.title) &&
      /never your words/i.test(formattingStatus.collecting.title) &&
      formattingStatus.collecting.describedBy === 'format-status' &&
      formattingStatus.collecting.statusRole === 'status' &&
      formattingStatus.collecting.statusLive === 'polite' &&
      /collecting/i.test(formattingStatus.collecting.statusText),
      JSON.stringify(formattingStatus));
    check('automatic formatting adds no manual bold, italic, underline, or font-size controls',
      formattingStatus.collecting.manualControls === 0,
      JSON.stringify(formattingStatus.collecting));
    check('format SSE states are visible and stale document ownership cannot replace them',
      formattingStatus.queued === 'queued' &&
      formattingStatus.reviewing === 'reviewing' &&
      formattingStatus.staleAccepted === false &&
      formattingStatus.afterStale === 'reviewing' &&
      formattingStatus.applied.state === 'applied' &&
      /3 paragraphs/.test(formattingStatus.applied.title) &&
      formattingStatus.validEvent &&
      formattingStatus.invalidEvent,
      JSON.stringify(formattingStatus));
    check('the automatic model route names Format when the server supplies it',
      /next Format: Terra/.test(formattingStatus.route),
      JSON.stringify(formattingStatus));

    const formattingToggleRaces = await browser.eval(`(async () => {
      const nativeFetch = window.fetch;
      const prior = { ...formatting };
      const priorActive = formatting.active;
      const priorRunner = formatting.runner;
      const priorDocumentToken = app.documentToken;
      const currentToken = capturedDocumentToken(app.model) ||
        'viewer-format-toggle-owner';
      if (!capturedDocumentToken(app.model)) app.documentToken = currentToken;
      const snapshot = (enabled) => ({
        enabled,
        status: enabled ? 'collecting' : 'off',
        pending_words: enabled ? 18 : 0,
        pending_paragraphs: enabled ? 2 : 0,
        threshold_words: 600,
        quiet_ms: 90000,
        cooldown_ms: 1800000,
        active: null,
        runner: { running: false, busy: false, pid: null, model: null, provider: null },
        document_token: currentToken
      });

      // The server broadcasts before replying. Simulate a committed toggle
      // whose HTTP acknowledgement alone is lost.
      applyFormattingSnapshot(snapshot(true));
      window.fetch = (input, init = {}) => {
        const url = new URL(String(input), location.href);
        if (url.pathname === '/api/format' &&
            String(init.method || 'GET').toUpperCase() === 'POST') {
          queueMicrotask(() => onFormattingEvent({
            ...snapshot(false),
            kind: 'disabled'
          }));
          return Promise.reject(new TypeError(
            'simulated lost formatting acknowledgement'));
        }
        return nativeFetch(input, init);
      };
      await setFormattingEnabled(false);
      const lostAck = {
        enabled: formatting.enabled,
        state: document.getElementById('format-toggle').dataset.state,
        pressed: document.getElementById('format-toggle')
          .getAttribute('aria-pressed'),
        disabled: document.getElementById('format-toggle').disabled,
        error: formatting.lastError
      };

      // A GET that began before a human choice must not overwrite the later
      // POST even when its response arrives last.
      applyFormattingSnapshot(snapshot(true));
      let resolveGet = null;
      window.fetch = (input, init = {}) => {
        const url = new URL(String(input), location.href);
        const method = String(init.method || 'GET').toUpperCase();
        if (url.pathname === '/api/format' && method === 'GET') {
          return new Promise((resolve) => { resolveGet = resolve; });
        }
        if (url.pathname === '/api/format' && method === 'POST') {
          return Promise.resolve(new Response(JSON.stringify(snapshot(false)), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }));
        }
        return nativeFetch(input, init);
      };
      const staleRead = hydrateFormattingState();
      for (let i = 0; i < 20 && !resolveGet; i++) await Promise.resolve();
      await setFormattingEnabled(false);
      resolveGet(new Response(JSON.stringify(snapshot(true)), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }));
      const staleReadResult = await staleRead;
      const afterStaleRead = {
        result: staleReadResult,
        enabled: formatting.enabled,
        state: document.getElementById('format-toggle').dataset.state,
        pressed: document.getElementById('format-toggle')
          .getAttribute('aria-pressed')
      };

      // A genuine failed attempt to turn the feature on remains visible while
      // aria-pressed accurately reports that it is still off.
      applyFormattingSnapshot(snapshot(false));
      window.fetch = (input, init = {}) => {
        const url = new URL(String(input), location.href);
        if (url.pathname === '/api/format' &&
            String(init.method || 'GET').toUpperCase() === 'POST') {
          return Promise.reject(new TypeError(
            'simulated formatting toggle refusal'));
        }
        return nativeFetch(input, init);
      };
      await setFormattingEnabled(true);
      const failedOn = {
        enabled: formatting.enabled,
        state: document.getElementById('format-toggle').dataset.state,
        pressed: document.getElementById('format-toggle')
          .getAttribute('aria-pressed'),
        title: document.getElementById('format-toggle').title
      };

      // Token-bearing work is document-bound. Before identity is established,
      // an event cannot make an old document's formatter appear active.
      const savedModel = app.model;
      const savedToken = app.documentToken;
      app.model = null;
      app.documentToken = null;
      const unownedAccepted = onFormattingEvent({
        ...snapshot(true),
        kind: 'reviewing',
        id: 'viewer-unowned-format-job'
      });
      app.model = savedModel;
      app.documentToken = savedToken;

      window.fetch = nativeFetch;
      clearTimeout(formattingAppliedTimer);
      formattingAppliedTimer = null;
      const mutationSeq = formatting.mutationSeq;
      Object.assign(formatting, prior);
      formatting.active = priorActive;
      formatting.runner = priorRunner;
      formatting.mutationSeq = mutationSeq;
      formattingToggleOwner = null;
      app.documentToken = priorDocumentToken;
      refreshFormattingState();
      return {
        lostAck,
        afterStaleRead,
        failedOn,
        unownedAccepted
      };
    })()`);
    check('a matching format SSE acknowledgement wins over a lost toggle response',
      formattingToggleRaces.lostAck.enabled === false &&
      formattingToggleRaces.lostAck.state === 'off' &&
      formattingToggleRaces.lostAck.pressed === 'false' &&
      formattingToggleRaces.lostAck.disabled === false &&
      !formattingToggleRaces.lostAck.error,
      JSON.stringify(formattingToggleRaces));
    check('an older format GET cannot overwrite a later human toggle',
      formattingToggleRaces.afterStaleRead.result === null &&
      formattingToggleRaces.afterStaleRead.enabled === false &&
      formattingToggleRaces.afterStaleRead.state === 'off' &&
      formattingToggleRaces.afterStaleRead.pressed === 'false',
      JSON.stringify(formattingToggleRaces));
    check('a failed format-on request is visibly failed but remains unpressed',
      formattingToggleRaces.failedOn.enabled === false &&
      formattingToggleRaces.failedOn.state === 'failed' &&
      formattingToggleRaces.failedOn.pressed === 'false' &&
      /simulated formatting toggle refusal/i.test(
        formattingToggleRaces.failedOn.title),
      JSON.stringify(formattingToggleRaces));
    check('a token-bearing format event stays quarantined until document identity exists',
      formattingToggleRaces.unownedAccepted === false,
      JSON.stringify(formattingToggleRaces));

    console.log('\n[client boundary guards]');
    const boundaryGuards = await browser.eval(`(async () => {
      const before = {
        count: document.querySelectorAll('.para').length,
        first: document.querySelector('.para').textContent,
        rev: window.__scribe.rev
      };
      const invalidModel = applyModel({ paragraphs: {} });
      eventStream.dispatchEvent(new MessageEvent('opened', { data: '{not-json' }));
      eventStream.dispatchEvent(new MessageEvent('document', {
        data: JSON.stringify({ reason: 'missing-revision' })
      }));
      eventStream.dispatchEvent(new MessageEvent('hello', {
        data: JSON.stringify([])
      }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const afterMalformed = {
        count: document.querySelectorAll('.para').length,
        first: document.querySelector('.para').textContent,
        rev: window.__scribe.rev
      };

      const timer = eventHealthTimer;
      connect();
      const oneTimer = timer !== null && eventHealthTimer === timer;

      window.__SCRIBE_MAX_EVENT_QUEUE = 4;
      window.__scribe.flushing = true;
      for (let i = 0; i < 30; i++) window.__feed('health', { ok: true, marker: i });
      const boundedQueue = window.__scribe.queue.length <= 4;
      window.__scribe.queue.length = 0;
      window.__scribe.flushing = false;
      delete window.__SCRIBE_MAX_EVENT_QUEUE;
      return { before, afterMalformed, invalidModel, oneTimer, boundedQueue };
    })()`);
    check('malformed SSE frames and invalid paragraph arrays are ignored without changing the document',
      boundaryGuards.invalidModel && boundaryGuards.invalidModel.invalid === true &&
      JSON.stringify(boundaryGuards.afterMalformed) === JSON.stringify(boundaryGuards.before),
      JSON.stringify(boundaryGuards));
    check('reconnecting retains exactly one health interval',
      boundaryGuards.oneTimer === true, JSON.stringify(boundaryGuards));
    check('a stalled event flush cannot grow its queued state without bound',
      boundaryGuards.boundedQueue === true, JSON.stringify(boundaryGuards));

    console.log('\n[authoritative document reconnect]');
    const noDocumentHello = await browser.eval(`(async () => {
      // The preceding timer-boundary assertion deliberately reconnects its
      // EventSource. Close that isolated stream and let any already-delivered
      // frame drain so it cannot race this synthetic authoritative hello.
      eventStream.close();
      for (let i = 0; i < 100 &&
           (app.frame !== null || app.flushing || app.queue.length); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const canonical = clone(app.model);
      const anchor = canonical.paragraphs.find((paragraph) => paragraph.text);
      const marker = 'VIEWER OLD DOCUMENT STATE MUST CLEAR';

      renderProposal({
        id: 'viewer-no-document-proposal',
        status: 'open',
        anchor_pid: anchor.pid,
        anchor_hash: anchor.hash,
        intent: marker,
        options: [
          { id: 'A', text: 'Keep the old document.' },
          { id: 'B', text: 'Clear the old document.' }
        ],
        grounding: []
      });
      renderAssist({
        id: 'viewer-no-document-assist',
        status: 'open',
        anchor_pid: anchor.pid,
        anchor_hash: anchor.hash,
        kind: 'answer',
        title: 'Old document note',
        text: marker,
        grounding: []
      });
      renderContinuation({
        id: 'viewer-no-document-continuation',
        status: 'open',
        anchor_pid: anchor.pid,
        anchor_hash: anchor.hash,
        text: marker,
        model: 'sonnet'
      });
      addTrail({
        op: 'replace',
        who: 'agent',
        summary: marker,
        at: new Date().toISOString()
      });
      lane.ready = true;
      lane.responseText = marker;
      setAgentState('working', marker);
      upsertCall('viewer-no-document-call', {
        name: 'doc_read',
        state: 'running',
        args: { from: 0, to: 1 }
      });

      const seeded = {
        document: document.querySelectorAll('.para').length > 0,
        proposal: !document.getElementById('proposal').hidden,
        assist: !!document.querySelector('.assist-note'),
        continuation: !!document.querySelector('.continuation-note'),
        trail: trailEl.textContent.includes(marker),
        lane: laneEl.children.length > 0 && lane.state === 'working'
      };
      enqueue('hello', {
        health: {
          ok: true,
          docPath: null,
          document_token: null,
          rev: 0,
          paused: false,
          bootedAt: app.serverBootedAt,
          capabilities: { paragraphMerge: true }
        },
        trail: [],
        proposals: [],
        assist: null,
        continuation: null
      });
      for (let i = 0; i < 100 &&
           (app.frame !== null || app.flushing || app.queue.length); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));

      const cleared = {
        modelIsNull: app.model === null,
        nodes: app.nodes.size,
        order: app.order.length,
        hasDocument: app.hasDocument,
        documentPath: app.documentPath,
        paperEmpty: document.getElementById('paper').classList.contains('is-empty'),
        emptyState: !!document.querySelector('.empty-state'),
        name: document.getElementById('doc-name').textContent,
        revisionHidden: document.getElementById('rev').hidden,
        rev: app.rev,
        proposal: !document.getElementById('proposal').hidden,
        assist: !!document.querySelector('.assist-note'),
        continuation: !!document.querySelector('.continuation-note'),
        openProposal: !!openProp,
        openAssist: !!openAssist,
        openContinuation: !!openContinuation,
        pendingAssist: !!app.pendingAssist,
        pendingContinuation: !!app.pendingContinuation,
        trail: trailEl.textContent,
        trailSeen: trailSeen.size,
        conversation: conversationEl.textContent,
        laneChildren: laneEl.children.length,
        laneState: lane.state,
        laneReady: lane.ready,
        laneResponse: lane.responseText,
        agentState: document.getElementById('agent-state').dataset.state
      };

      app.model = null;
      app.documentPath = null;
      app.documentToken = null;
      applyModel(canonical);
      setDocName(canonical.path);
      app.rev = canonical.rev;
      updateRevision();
      return { seeded, cleared };
    })()`);
    check('an authoritative no-document hello clears every rendered document surface',
      Object.values(noDocumentHello.seeded).every(Boolean) &&
      noDocumentHello.cleared.modelIsNull &&
      noDocumentHello.cleared.nodes === 0 &&
      noDocumentHello.cleared.order === 0 &&
      noDocumentHello.cleared.hasDocument === false &&
      noDocumentHello.cleared.documentPath === null &&
      noDocumentHello.cleared.paperEmpty &&
      noDocumentHello.cleared.emptyState &&
      noDocumentHello.cleared.name === 'open document' &&
      noDocumentHello.cleared.revisionHidden &&
      noDocumentHello.cleared.rev === 0 &&
      !noDocumentHello.cleared.proposal &&
      !noDocumentHello.cleared.assist &&
      !noDocumentHello.cleared.continuation &&
      !noDocumentHello.cleared.openProposal &&
      !noDocumentHello.cleared.openAssist &&
      !noDocumentHello.cleared.openContinuation &&
      !noDocumentHello.cleared.pendingAssist &&
      !noDocumentHello.cleared.pendingContinuation &&
      noDocumentHello.cleared.trail === '' &&
      noDocumentHello.cleared.trailSeen === 0 &&
      noDocumentHello.cleared.conversation === '' &&
      noDocumentHello.cleared.laneChildren === 0 &&
      noDocumentHello.cleared.laneState === 'off' &&
      noDocumentHello.cleared.laneReady === false &&
      noDocumentHello.cleared.laneResponse === '' &&
      noDocumentHello.cleared.agentState === 'off',
      JSON.stringify(noDocumentHello));

    const reconnectOwnershipRace = await browser.eval(`(async () => {
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const canonical = clone(app.model);
      const anchor = canonical.paragraphs.find((paragraph) => paragraph.text);
      const modelA = clone(canonical);
      const modelC = clone(canonical);
      modelA.document_token = 'viewer-reconnect-owner-A';
      modelC.document_token = 'viewer-reconnect-owner-C';
      const tokenB = 'viewer-reconnect-owner-B';
      const marker = 'VIEWER OWNER B SNAPSHOT MUST NOT REACH C';

      app.model = null;
      app.documentPath = null;
      app.documentToken = null;
      applyModel(modelA);
      setDocName(modelA.path);
      app.rev = modelA.rev;
      updateRevision();

      const nativeFetch = window.fetch;
      const nativeConnect = connect;
      let documentReads = 0;
      let reconnects = 0;
      window.fetch = (input, init = {}) => {
        const url = new URL(String(input), location.href);
        if (url.pathname === '/api/doc') {
          documentReads++;
          return Promise.resolve(new Response(JSON.stringify(modelC), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }));
        }
        return nativeFetch(input, init);
      };
      connect = () => {
        reconnects++;
        return { close() {} };
      };

      enqueue('hello', {
        health: {
          ok: true,
          docPath: modelA.path,
          document_token: tokenB,
          rev: modelA.rev,
          paused: false,
          bootedAt: app.serverBootedAt,
          capabilities: { paragraphMerge: true }
        },
        trail: [{
          op: 'replace',
          who: 'agent',
          summary: marker,
          at: new Date().toISOString()
        }],
        proposals: [],
        assist: {
          id: 'viewer-owner-B-assist',
          status: 'open',
          anchor_pid: anchor.pid,
          anchor_hash: anchor.hash,
          kind: 'answer',
          title: 'Owner B note',
          text: marker,
          grounding: []
        },
        continuation: {
          id: 'viewer-owner-B-continuation',
          status: 'open',
          anchor_pid: anchor.pid,
          anchor_hash: anchor.hash,
          text: marker,
          model: 'sonnet'
        }
      });
      for (let i = 0; i < 100 &&
           (app.frame !== null || app.flushing || app.queue.length); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      const observedReconnects = reconnects;
      await new Promise((resolve) => setTimeout(resolve, 25));

      const result = {
        token: app.model && app.model.document_token,
        path: app.model && app.model.path,
        documentReads,
        reconnects,
        observedReconnects,
        stableReconnectCount: reconnects === observedReconnects,
        reconnectTimer: authoritativeReconnectTimer,
        queued: app.queue.length,
        flushing: app.flushing,
        markerVisible: document.body.textContent.includes(marker),
        trail: trailEl.textContent,
        trailSeen: trailSeen.size,
        assist: !!document.querySelector(
          '[data-assist="viewer-owner-B-assist"]'),
        continuation: !!document.querySelector(
          '[data-continuation="viewer-owner-B-continuation"]'),
        openAssist: openAssist && openAssist.id,
        openContinuation: openContinuation && openContinuation.id,
        pendingAssist: app.pendingAssist && app.pendingAssist.id,
        pendingContinuation:
          app.pendingContinuation && app.pendingContinuation.id
      };

      window.fetch = nativeFetch;
      connect = nativeConnect;
      if (authoritativeReconnectTimer !== null) {
        clearTimeout(authoritativeReconnectTimer);
        authoritativeReconnectTimer = null;
      }
      app.model = null;
      app.documentPath = null;
      app.documentToken = null;
      clearDocumentBoundClientState();
      applyModel(canonical);
      setDocName(canonical.path);
      app.rev = canonical.rev;
      updateRevision();
      const reconnectFetchSeq = modelFetchSeq;
      nativeConnect();
      // Do not let the restored real EventSource's initial hello drift into a
      // later editor test. Its document fetch proves that hello was received;
      // an idle queue then proves it was fully painted.
      for (let i = 0; i < 400 &&
           (modelFetchSeq <= reconnectFetchSeq ||
            app.frame !== null || app.flushing || app.queue.length); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      return result;
    })()`);
    check('a B hello cannot attach its snapshots to a concurrently fetched C document',
      reconnectOwnershipRace.token === 'viewer-reconnect-owner-C' &&
      reconnectOwnershipRace.documentReads === 1 &&
      reconnectOwnershipRace.reconnects === 1 &&
      reconnectOwnershipRace.observedReconnects === 1 &&
      reconnectOwnershipRace.stableReconnectCount &&
      reconnectOwnershipRace.reconnectTimer === null &&
      reconnectOwnershipRace.queued === 0 &&
      reconnectOwnershipRace.flushing === false &&
      reconnectOwnershipRace.markerVisible === false &&
      reconnectOwnershipRace.trail === '' &&
      reconnectOwnershipRace.trailSeen === 0 &&
      !reconnectOwnershipRace.assist &&
      !reconnectOwnershipRace.continuation &&
      !reconnectOwnershipRace.openAssist &&
      !reconnectOwnershipRace.openContinuation &&
      !reconnectOwnershipRace.pendingAssist &&
      !reconnectOwnershipRace.pendingContinuation,
      JSON.stringify(reconnectOwnershipRace));

    const failedAuthoritativeRefresh = await browser.eval(`(async () => {
      if (eventStream) eventStream.close();
      for (let i = 0; i < 100 &&
           (app.frame !== null || app.flushing || app.queue.length); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const canonical = clone(app.model);
      const modelA = clone(canonical);
      const modelB = clone(canonical);
      modelA.document_token = 'viewer-failed-refresh-owner-A';
      modelB.document_token = 'viewer-failed-refresh-owner-B';
      modelB.path = canonical.path + '.viewer-failed-refresh-B.docx';
      const targetA = modelA.paragraphs.find(
        (paragraph) => paragraph.text.length > 30);
      const targetB = modelB.paragraphs.find(
        (paragraph) => paragraph.pid === targetA.pid);
      const oldMarker = 'OLD DOCUMENT A MUST DISAPPEAR BEFORE B REFRESHES';
      const newMarker = 'NEW DOCUMENT B ARRIVED ON THE LATER REFRESH';
      targetA.text = oldMarker;
      targetA.hash = 'viewer-failed-refresh-A-hash';
      targetA.runs = [{ text: oldMarker }];
      targetB.text = newMarker;
      targetB.hash = 'viewer-failed-refresh-B-hash';
      targetB.runs = [{ text: newMarker }];

      app.model = null;
      app.documentPath = null;
      app.documentToken = null;
      clearDocumentBoundClientState();
      applyModel(modelA);
      setDocName(modelA.path);
      app.rev = modelA.rev;
      updateRevision();

      const nativeFetch = window.fetch;
      const nativeConnect = connect;
      let documentReads = 0;
      let reconnects = 0;
      window.fetch = (request, init = {}) => {
        const url = new URL(String(request), location.href);
        if (url.pathname === '/api/doc') {
          documentReads++;
          if (documentReads === 1) {
            return Promise.resolve(new Response(JSON.stringify({
              error: 'simulated authoritative document refresh failure'
            }), {
              status: 503,
              headers: { 'content-type': 'application/json' }
            }));
          }
          return Promise.resolve(new Response(JSON.stringify(modelB), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }));
        }
        return nativeFetch(request, init);
      };
      connect = () => {
        reconnects++;
        setTimeout(() => enqueue('hello', {
          health: {
            ok: true,
            docPath: modelB.path,
            document_token: modelB.document_token,
            rev: modelB.rev,
            paused: false,
            bootedAt: app.serverBootedAt,
            capabilities: { paragraphMerge: true }
          },
          trail: [],
          proposals: [],
          assist: null,
          continuation: null
        }), 0);
        return { close() {} };
      };

      enqueue('opened', {
        path: modelB.path,
        rev: modelB.rev,
        document_token: modelB.document_token
      });
      for (let i = 0; i < 100 &&
           (app.frame !== null || app.flushing || app.queue.length); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const afterFailure = {
        documentReads,
        modelIsNull: app.model === null,
        token: app.documentToken,
        paragraphCount: document.querySelectorAll('.para').length,
        editableCount: document.querySelectorAll(
          '.para[contenteditable="plaintext-only"]').length,
        nodes: app.nodes.size,
        order: app.order.length,
        oldVisible: document.body.textContent.includes(oldMarker),
        newVisible: document.body.textContent.includes(newMarker)
      };

      // No second event is injected by the test. The failed required refresh
      // must schedule its own reconnect; the fake connection then supplies the
      // same authoritative hello a real reconnect would receive.
      for (let i = 0; i < 500 &&
           (!app.model ||
            app.model.document_token !== modelB.document_token ||
            app.frame !== null || app.flushing || app.queue.length); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const afterRecovery = {
        documentReads,
        reconnects,
        token: app.model && app.model.document_token,
        path: app.model && app.model.path,
        text: document.querySelector(
          '[data-pid="' + targetB.pid + '"]')?.textContent,
        paragraphCount: document.querySelectorAll('.para').length,
        editableCount: document.querySelectorAll(
          '.para[contenteditable="plaintext-only"]').length,
        oldVisible: document.body.textContent.includes(oldMarker),
        newVisible: document.body.textContent.includes(newMarker)
      };

      window.fetch = nativeFetch;
      connect = nativeConnect;
      if (authoritativeReconnectTimer !== null) {
        clearTimeout(authoritativeReconnectTimer);
        authoritativeReconnectTimer = null;
      }
      app.model = null;
      app.documentPath = null;
      app.documentToken = null;
      clearDocumentBoundClientState();
      applyModel(canonical);
      setDocName(canonical.path);
      app.rev = canonical.rev;
      updateRevision();
      const reconnectFetchSeq = modelFetchSeq;
      nativeConnect();
      for (let i = 0; i < 400 &&
           (modelFetchSeq <= reconnectFetchSeq ||
            app.frame !== null || app.flushing || app.queue.length); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { afterFailure, afterRecovery, expectedCount: modelB.paragraphs.length };
    })()`);
    check('a failed authoritative Open refresh exposes no old or editable document content',
      failedAuthoritativeRefresh.afterFailure.documentReads === 1 &&
      failedAuthoritativeRefresh.afterFailure.modelIsNull &&
      failedAuthoritativeRefresh.afterFailure.token ===
        'viewer-failed-refresh-owner-B' &&
      failedAuthoritativeRefresh.afterFailure.paragraphCount === 0 &&
      failedAuthoritativeRefresh.afterFailure.editableCount === 0 &&
      failedAuthoritativeRefresh.afterFailure.nodes === 0 &&
      failedAuthoritativeRefresh.afterFailure.order === 0 &&
      !failedAuthoritativeRefresh.afterFailure.oldVisible &&
      !failedAuthoritativeRefresh.afterFailure.newVisible,
      JSON.stringify(failedAuthoritativeRefresh.afterFailure));
    check('a later authoritative refresh paints the newly opened document after failure',
      failedAuthoritativeRefresh.afterRecovery.documentReads === 2 &&
      failedAuthoritativeRefresh.afterRecovery.reconnects === 1 &&
      failedAuthoritativeRefresh.afterRecovery.token ===
        'viewer-failed-refresh-owner-B' &&
      failedAuthoritativeRefresh.afterRecovery.path.endsWith(
        '.viewer-failed-refresh-B.docx') &&
      failedAuthoritativeRefresh.afterRecovery.text ===
        'NEW DOCUMENT B ARRIVED ON THE LATER REFRESH' &&
      failedAuthoritativeRefresh.afterRecovery.paragraphCount ===
        failedAuthoritativeRefresh.expectedCount &&
      failedAuthoritativeRefresh.afterRecovery.editableCount ===
        failedAuthoritativeRefresh.expectedCount &&
      !failedAuthoritativeRefresh.afterRecovery.oldVisible &&
      failedAuthoritativeRefresh.afterRecovery.newVisible,
      JSON.stringify(failedAuthoritativeRefresh.afterRecovery));

    const preIdentitySnapshots = await browser.eval(`(async () => {
      if (eventStream) eventStream.close();
      for (let i = 0; i < 100 &&
           (app.frame !== null || app.flushing || app.queue.length); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const canonical = clone(app.model);
      const modelB = clone(canonical);
      modelB.document_token = 'viewer-startup-identity-owner-B';
      modelB.path = canonical.path + '.viewer-startup-identity-B.docx';
      const anchor = modelB.paragraphs.find(
        (paragraph) => paragraph.text.length > 30);
      const proposalB = {
        id: 'viewer-startup-identity-proposal-B',
        status: 'open',
        anchor_pid: anchor.pid,
        anchor_hash: anchor.hash,
        intent: 'Identity-matched proposal B',
        options: [
          { id: 'A', text: 'Identity option A' },
          { id: 'B', text: 'Identity option B' }
        ],
        grounding: []
      };
      const assistB = {
        id: 'viewer-startup-identity-assist-B',
        status: 'open',
        anchor_pid: anchor.pid,
        anchor_hash: anchor.hash,
        kind: 'answer',
        title: 'Identity-matched assist B',
        text: 'This assist may render only after document B is identified.',
        grounding: []
      };
      const continuationB = {
        id: 'viewer-startup-identity-continuation-B',
        status: 'open',
        anchor_pid: anchor.pid,
        anchor_hash: anchor.hash,
        text: 'This continuation belongs to identified document B.',
        model: 'sonnet'
      };

      app.model = null;
      app.documentPath = null;
      app.documentToken = null;
      clearDocumentBoundClientState();
      renderNoActiveDocument();
      const nativeFetch = window.fetch;
      const counters = { proposals: 0, assists: 0, predict: 0 };
      window.fetch = (request, init = {}) => {
        const url = new URL(String(request), location.href);
        let payload;
        if (url.pathname === '/api/proposals') {
          counters.proposals++;
          payload = {
            document_token: modelB.document_token,
            proposals: [proposalB]
          };
        } else if (url.pathname === '/api/assists') {
          counters.assists++;
          payload = {
            document_token: modelB.document_token,
            assists: [assistB]
          };
        } else if (url.pathname === '/api/predict') {
          counters.predict++;
          payload = {
            document_token: modelB.document_token,
            continuation: continuationB,
            active: null
          };
        } else {
          return nativeFetch(request, init);
        }
        return Promise.resolve(new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }));
      };

      const beforeIdentityResults = await Promise.all([
        syncProposalSnapshot(),
        syncAssistSnapshot(),
        syncContinuationSnapshot()
      ]);
      const beforeIdentity = {
        proposalStale: !!beforeIdentityResults[0]?.stale,
        assistApplied: beforeIdentityResults[1],
        continuationApplied: beforeIdentityResults[2],
        proposal: openProp && openProp.id,
        assist: openAssist && openAssist.id,
        continuation: openContinuation && openContinuation.id,
        pendingAssist: app.pendingAssist && app.pendingAssist.id,
        pendingContinuation:
          app.pendingContinuation && app.pendingContinuation.id,
        proposalVisible:
          openProp && openProp.id === proposalB.id &&
          !document.getElementById('proposal').hidden,
        assistVisible: !!document.querySelector(
          '[data-assist="' + assistB.id + '"]'),
        continuationVisible: !!document.querySelector(
          '[data-continuation="' + continuationB.id + '"]')
      };

      applyModel(modelB);
      setDocName(modelB.path);
      app.rev = modelB.rev;
      updateRevision();
      const afterIdentityResults = await Promise.all([
        syncProposalSnapshot(),
        syncAssistSnapshot(),
        syncContinuationSnapshot()
      ]);
      const afterIdentity = {
        proposalStale: !!afterIdentityResults[0]?.stale,
        assistApplied: afterIdentityResults[1],
        continuationApplied: afterIdentityResults[2],
        token: app.model && app.model.document_token,
        proposal: openProp && openProp.id,
        assist: openAssist && openAssist.id,
        continuation: openContinuation && openContinuation.id,
        proposalVisible:
          openProp && openProp.id === proposalB.id &&
          !document.getElementById('proposal').hidden,
        assistVisible: !!document.querySelector(
          '[data-assist="' + assistB.id + '"]'),
        continuationVisible: !!document.querySelector(
          '[data-continuation="' + continuationB.id + '"]')
      };

      window.fetch = nativeFetch;
      app.model = null;
      app.documentPath = null;
      app.documentToken = null;
      clearDocumentBoundClientState();
      applyModel(canonical);
      setDocName(canonical.path);
      app.rev = canonical.rev;
      updateRevision();
      const reconnectFetchSeq = modelFetchSeq;
      connect();
      for (let i = 0; i < 400 &&
           (modelFetchSeq <= reconnectFetchSeq ||
            app.frame !== null || app.flushing || app.queue.length); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { counters, beforeIdentity, afterIdentity };
    })()`);
    check('token-bearing startup snapshots stay quarantined before document identity is known',
      preIdentitySnapshots.counters.proposals === 2 &&
      preIdentitySnapshots.counters.assists === 2 &&
      preIdentitySnapshots.counters.predict === 2 &&
      preIdentitySnapshots.beforeIdentity.proposalStale &&
      preIdentitySnapshots.beforeIdentity.assistApplied === false &&
      preIdentitySnapshots.beforeIdentity.continuationApplied === false &&
      !preIdentitySnapshots.beforeIdentity.proposal &&
      !preIdentitySnapshots.beforeIdentity.assist &&
      !preIdentitySnapshots.beforeIdentity.continuation &&
      !preIdentitySnapshots.beforeIdentity.pendingAssist &&
      !preIdentitySnapshots.beforeIdentity.pendingContinuation &&
      !preIdentitySnapshots.beforeIdentity.proposalVisible &&
      !preIdentitySnapshots.beforeIdentity.assistVisible &&
      !preIdentitySnapshots.beforeIdentity.continuationVisible,
      JSON.stringify(preIdentitySnapshots.beforeIdentity));
    check('identity-matched snapshot resync renders the current document sidecars',
      !preIdentitySnapshots.afterIdentity.proposalStale &&
      preIdentitySnapshots.afterIdentity.assistApplied === true &&
      preIdentitySnapshots.afterIdentity.continuationApplied === true &&
      preIdentitySnapshots.afterIdentity.token ===
        'viewer-startup-identity-owner-B' &&
      preIdentitySnapshots.afterIdentity.proposal ===
        'viewer-startup-identity-proposal-B' &&
      preIdentitySnapshots.afterIdentity.assist ===
        'viewer-startup-identity-assist-B' &&
      preIdentitySnapshots.afterIdentity.continuation ===
        'viewer-startup-identity-continuation-B' &&
      preIdentitySnapshots.afterIdentity.proposalVisible &&
      preIdentitySnapshots.afterIdentity.assistVisible &&
      preIdentitySnapshots.afterIdentity.continuationVisible,
      JSON.stringify(preIdentitySnapshots.afterIdentity));

    const delayedEmptySidecarSnapshots = await browser.eval(`(async () => {
      if (eventStream) eventStream.close();
      for (let i = 0; i < 100 &&
           (app.frame !== null || app.flushing || app.queue.length); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      clearDocumentBoundClientState();
      const model = app.model;
      const token = model && model.document_token;
      const anchor = model && model.paragraphs.find(
        (paragraph) => paragraph.text.length > 30);
      const assist = {
        id: 'viewer-newer-live-assist',
        status: 'open',
        anchor_pid: anchor.pid,
        anchor_hash: anchor.hash,
        kind: 'answer',
        title: 'Newer live assist',
        text: 'A delayed empty snapshot must not erase this live assist.',
        grounding: [],
        at: '9999-12-31T23:59:59.999Z'
      };
      const continuation = {
        id: 'viewer-newer-live-continuation',
        status: 'open',
        anchor_pid: anchor.pid,
        anchor_hash: anchor.hash,
        text: 'A delayed empty snapshot must not erase this continuation.',
        model: 'sonnet',
        at: '9999-12-31T23:59:59.999Z'
      };

      let releaseAssist;
      let releaseContinuation;
      const delayedAssist = new Promise((resolve) => {
        releaseAssist = () => resolve(new Response(JSON.stringify({
          document_token: token,
          assists: []
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }));
      });
      const delayedContinuation = new Promise((resolve) => {
        releaseContinuation = () => resolve(new Response(JSON.stringify({
          document_token: token,
          continuation: null,
          active: null
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }));
      });
      const nativeFetch = window.fetch;
      const counters = { assists: 0, predict: 0 };
      window.fetch = (request, init = {}) => {
        const url = new URL(String(request), location.href);
        if (url.pathname === '/api/assists') {
          counters.assists++;
          return delayedAssist;
        }
        if (url.pathname === '/api/predict') {
          counters.predict++;
          return delayedContinuation;
        }
        return nativeFetch(request, init);
      };

      const assistRequest = syncAssistSnapshot();
      const continuationRequest = syncContinuationSnapshot();
      for (let i = 0; i < 100 &&
           (counters.assists < 1 || counters.predict < 1); i++) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      enqueue('assist', assist);
      enqueue('predict', {
        kind: 'ready',
        id: continuation.id,
        continuation
      });
      for (let i = 0; i < 100 &&
           (app.frame !== null || app.flushing || app.queue.length); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const beforeEmptySnapshots = {
        assist: openAssist && openAssist.id,
        continuation: openContinuation && openContinuation.id,
        assistVisible: !!document.querySelector(
          '[data-assist="' + assist.id + '"]'),
        continuationVisible: !!document.querySelector(
          '[data-continuation="' + continuation.id + '"]')
      };

      releaseAssist();
      releaseContinuation();
      const [assistApplied, continuationApplied] = await Promise.all([
        assistRequest,
        continuationRequest
      ]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const afterEmptySnapshots = {
        assistApplied,
        continuationApplied,
        assist: openAssist && openAssist.id,
        continuation: openContinuation && openContinuation.id,
        assistVisible: !!document.querySelector(
          '[data-assist="' + assist.id + '"]'),
        continuationVisible: !!document.querySelector(
          '[data-continuation="' + continuation.id + '"]')
      };

      window.fetch = nativeFetch;
      renderAssist(null);
      renderContinuation(null);
      const reconnectFetchSeq = modelFetchSeq;
      connect();
      for (let i = 0; i < 400 &&
           (modelFetchSeq <= reconnectFetchSeq ||
            app.frame !== null || app.flushing || app.queue.length); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        counters,
        beforeEmptySnapshots,
        afterEmptySnapshots
      };
    })()`);
    check('older empty assist and continuation snapshots cannot erase newer live cards',
      delayedEmptySidecarSnapshots.counters.assists === 1 &&
      delayedEmptySidecarSnapshots.counters.predict === 1 &&
      delayedEmptySidecarSnapshots.beforeEmptySnapshots.assist ===
        'viewer-newer-live-assist' &&
      delayedEmptySidecarSnapshots.beforeEmptySnapshots.continuation ===
        'viewer-newer-live-continuation' &&
      delayedEmptySidecarSnapshots.beforeEmptySnapshots.assistVisible &&
      delayedEmptySidecarSnapshots.beforeEmptySnapshots.continuationVisible &&
      delayedEmptySidecarSnapshots.afterEmptySnapshots.assistApplied === false &&
      delayedEmptySidecarSnapshots.afterEmptySnapshots.continuationApplied ===
        false &&
      delayedEmptySidecarSnapshots.afterEmptySnapshots.assist ===
        'viewer-newer-live-assist' &&
      delayedEmptySidecarSnapshots.afterEmptySnapshots.continuation ===
        'viewer-newer-live-continuation' &&
      delayedEmptySidecarSnapshots.afterEmptySnapshots.assistVisible &&
      delayedEmptySidecarSnapshots.afterEmptySnapshots.continuationVisible,
      JSON.stringify(delayedEmptySidecarSnapshots));

    const proposalBeforeModel = await browser.eval(`(async () => {
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const canonical = clone(app.model);
      const anchor = canonical.paragraphs.find((paragraph) => paragraph.text);
      const proposal = {
        id: 'viewer-proposal-before-model',
        status: 'open',
        anchor_pid: anchor.pid,
        anchor_hash: anchor.hash,
        intent: 'Proposal arrived before its document model',
        options: [
          { id: 'A', text: 'First safe option' },
          { id: 'B', text: 'Second safe option' }
        ],
        grounding: []
      };

      clearDocumentBoundClientState();
      app.model = null;
      app.documentPath = null;
      app.documentToken = null;
      app.nodes.clear();
      app.order = [];
      paperEl.textContent = '';
      paperEl.classList.add('is-empty');
      setDocName(canonical.path);
      let thrown = null;
      try {
        renderProposal(proposal);
      } catch (error) {
        thrown = error && (error.message || String(error));
      }
      const before = {
        visible: !document.getElementById('proposal').hidden,
        options: document.querySelectorAll('#opts .opt').length,
        actionsDisabled:
          [...document.querySelectorAll('#opts .opt')].every(
            (button) => button.disabled) &&
          document.getElementById('prop-dismiss').disabled,
        anchored: !!document.querySelector('.para.anchored'),
        model: !!app.model
      };

      const nativeFetch = window.fetch;
      let reads = 0;
      window.fetch = (input, init = {}) => {
        const url = new URL(String(input), location.href);
        if (url.pathname === '/api/doc') {
          reads++;
          return Promise.resolve(new Response(JSON.stringify(canonical), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }));
        }
        return nativeFetch(input, init);
      };
      enqueue('document', {
        rev: canonical.rev,
        reason: 'viewer proposal-before-model fixture'
      });
      for (let i = 0; i < 100 &&
           (app.frame !== null || app.flushing || app.queue.length); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const after = {
        model: !!app.model,
        anchored: !!document.querySelector(
          '.para.anchored[data-pid="' + anchor.pid + '"]'),
        actionsEnabled:
          [...document.querySelectorAll('#opts .opt')].every(
            (button) => !button.disabled) &&
          !document.getElementById('prop-dismiss').disabled,
        open: openProp && openProp.id
      };
      window.fetch = nativeFetch;
      renderProposal(null);
      return { thrown, reads, before, after };
    })()`);
    check('a proposal arriving before its model stays inert until its anchor is painted',
      proposalBeforeModel.thrown === null &&
      proposalBeforeModel.reads === 1 &&
      proposalBeforeModel.before.visible &&
      proposalBeforeModel.before.options === 2 &&
      proposalBeforeModel.before.actionsDisabled &&
      !proposalBeforeModel.before.anchored &&
      !proposalBeforeModel.before.model &&
      proposalBeforeModel.after.model &&
      proposalBeforeModel.after.anchored &&
      proposalBeforeModel.after.actionsEnabled &&
      proposalBeforeModel.after.open === 'viewer-proposal-before-model',
      JSON.stringify(proposalBeforeModel));

    const proposalActionOwnership = await browser.eval(`(async () => {
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const canonical = clone(app.model);
      const nextModel = clone(canonical);
      nextModel.path = canonical.path + '.viewer-opened.docx';
      nextModel.document_token = 'viewer-new-proposal-document-token';
      const anchor = canonical.paragraphs.find((paragraph) => paragraph.text);
      const proposal = (id, intent) => ({
        id,
        status: 'open',
        anchor_pid: anchor.pid,
        anchor_hash: anchor.hash,
        intent,
        options: [
          { id: 'A', text: intent + ' A' },
          { id: 'B', text: intent + ' B' }
        ],
        grounding: []
      });
      const oldProposal = proposal(
        'viewer-old-posting-proposal',
        'Old document proposal action');
      const newProposal = proposal(
        'viewer-new-posting-proposal',
        'New document proposal action');

      let dismissCalls = 0;
      let releaseOld;
      let releaseNew;
      const oldResponse = new Promise((resolve) => {
        releaseOld = () => resolve(new Response(JSON.stringify({
          dismissed: oldProposal.id
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }));
      });
      const newResponse = new Promise((resolve) => {
        releaseNew = () => resolve(new Response(JSON.stringify({
          dismissed: newProposal.id
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }));
      });
      const nativeFetch = window.fetch;
      window.fetch = (input, init = {}) => {
        const url = new URL(String(input), location.href);
        if (url.pathname === '/api/dismiss') {
          dismissCalls++;
          return dismissCalls === 1 ? oldResponse : newResponse;
        }
        if (url.pathname === '/api/doc') {
          return Promise.resolve(new Response(JSON.stringify(nextModel), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }));
        }
        return nativeFetch(input, init);
      };

      renderProposal(oldProposal);
      const oldAction = dismissProposal();
      for (let i = 0; i < 50 && dismissCalls < 1; i++) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      enqueue('opened', { path: nextModel.path, rev: nextModel.rev });
      for (let i = 0; i < 100 &&
           (app.frame !== null || app.flushing || app.queue.length); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      renderProposal(newProposal);
      const newAction = dismissProposal();
      for (let i = 0; i < 50 && dismissCalls < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      const beforeOldSettles = {
        posting: proposalPosting,
        owner: proposalPostingOwner && proposalPostingOwner.id,
        open: openProp && openProp.id,
        optionsDisabled:
          [...document.querySelectorAll('#opts .opt')].every(
            (button) => button.disabled),
        dismissDisabled: document.getElementById('prop-dismiss').disabled
      };

      releaseOld();
      await oldAction;
      const afterOldSettles = {
        posting: proposalPosting,
        owner: proposalPostingOwner && proposalPostingOwner.id,
        open: openProp && openProp.id,
        optionsDisabled:
          [...document.querySelectorAll('#opts .opt')].every(
            (button) => button.disabled),
        dismissDisabled: document.getElementById('prop-dismiss').disabled
      };

      releaseNew();
      await newAction;
      const afterNewSettles = {
        posting: proposalPosting,
        owner: proposalPostingOwner,
        open: openProp,
        hidden: document.getElementById('proposal').hidden
      };
      window.fetch = nativeFetch;
      app.model = null;
      app.documentPath = null;
      app.documentToken = null;
      clearDocumentBoundClientState();
      applyModel(canonical);
      setDocName(canonical.path);
      app.rev = canonical.rev;
      updateRevision();
      return {
        dismissCalls,
        beforeOldSettles,
        afterOldSettles,
        afterNewSettles
      };
    })()`);
    check('a retired proposal action cannot clear the newer document action lock',
      proposalActionOwnership.dismissCalls === 2 &&
      proposalActionOwnership.beforeOldSettles.posting &&
      proposalActionOwnership.beforeOldSettles.owner ===
        'viewer-new-posting-proposal' &&
      proposalActionOwnership.beforeOldSettles.open ===
        'viewer-new-posting-proposal' &&
      proposalActionOwnership.beforeOldSettles.optionsDisabled &&
      proposalActionOwnership.beforeOldSettles.dismissDisabled &&
      proposalActionOwnership.afterOldSettles.posting &&
      proposalActionOwnership.afterOldSettles.owner ===
        'viewer-new-posting-proposal' &&
      proposalActionOwnership.afterOldSettles.open ===
        'viewer-new-posting-proposal' &&
      proposalActionOwnership.afterOldSettles.optionsDisabled &&
      proposalActionOwnership.afterOldSettles.dismissDisabled &&
      proposalActionOwnership.afterNewSettles.posting === false &&
      proposalActionOwnership.afterNewSettles.owner === null &&
      proposalActionOwnership.afterNewSettles.open === null &&
      proposalActionOwnership.afterNewSettles.hidden,
      JSON.stringify(proposalActionOwnership));

    const delayedStartupSnapshots = await browser.eval(`(async () => {
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const canonical = clone(app.model);
      const modelA = clone(canonical);
      const modelB = clone(canonical);
      modelA.document_token = 'viewer-startup-snapshot-owner-A';
      modelB.document_token = 'viewer-startup-snapshot-owner-B';
      modelB.path = canonical.path + '.viewer-startup-B.docx';
      const anchor = canonical.paragraphs.find(
        (paragraph) => paragraph.text);
      const markerA = 'VIEWER STARTUP SNAPSHOT A MUST STAY RETIRED';
      const markerB = 'Viewer startup snapshot B remains authoritative';
      const proposalA = {
        id: 'viewer-startup-A-proposal',
        status: 'open',
        anchor_pid: anchor.pid,
        anchor_hash: anchor.hash,
        intent: markerA,
        options: [
          { id: 'A', text: 'Old proposal A' },
          { id: 'B', text: 'Old proposal B' }
        ],
        grounding: []
      };
      const proposalB = {
        id: 'viewer-startup-B-proposal',
        status: 'open',
        anchor_pid: anchor.pid,
        anchor_hash: anchor.hash,
        intent: markerB,
        options: [
          { id: 'A', text: 'Current proposal A' },
          { id: 'B', text: 'Current proposal B' }
        ],
        grounding: []
      };
      const assistA = {
        id: 'viewer-startup-A-assist',
        status: 'open',
        anchor_pid: anchor.pid,
        anchor_hash: anchor.hash,
        kind: 'answer',
        title: 'Old startup note',
        text: markerA,
        grounding: []
      };
      const assistB = {
        id: 'viewer-startup-B-assist',
        status: 'open',
        anchor_pid: anchor.pid,
        anchor_hash: anchor.hash,
        kind: 'answer',
        title: 'Current startup note',
        text: markerB,
        grounding: []
      };
      const continuationA = {
        id: 'viewer-startup-A-continuation',
        status: 'open',
        anchor_pid: anchor.pid,
        anchor_hash: anchor.hash,
        text: markerA,
        model: 'sonnet'
      };
      const continuationB = {
        id: 'viewer-startup-B-continuation',
        status: 'open',
        anchor_pid: anchor.pid,
        anchor_hash: anchor.hash,
        text: markerB,
        model: 'sonnet'
      };

      app.model = null;
      app.documentPath = null;
      app.documentToken = null;
      clearDocumentBoundClientState();
      applyModel(modelA);
      setDocName(modelA.path);
      app.rev = modelA.rev;
      updateRevision();

      const counters = { proposals: 0, assists: 0, predict: 0, doc: 0 };
      let releaseProposals;
      let releaseAssists;
      let releasePredict;
      const deferredProposals = new Promise((resolve) => {
        releaseProposals = () => resolve(new Response(JSON.stringify({
          proposals: [proposalA],
          document_token: modelA.document_token
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }));
      });
      const deferredAssists = new Promise((resolve) => {
        releaseAssists = () => resolve(new Response(JSON.stringify({
          assists: [assistA],
          document_token: modelA.document_token
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }));
      });
      const deferredPredict = new Promise((resolve) => {
        releasePredict = () => resolve(new Response(JSON.stringify({
          continuation: continuationA,
          active: {
            id: 'viewer-startup-A-active-prediction',
            anchor_pid: anchor.pid
          },
          document_token: modelA.document_token
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }));
      });
      const nativeFetch = window.fetch;
      window.fetch = (input, init = {}) => {
        const url = new URL(String(input), location.href);
        if (url.pathname === '/api/proposals') {
          counters.proposals++;
          return deferredProposals;
        }
        if (url.pathname === '/api/assists') {
          counters.assists++;
          return deferredAssists;
        }
        if (url.pathname === '/api/predict') {
          counters.predict++;
          return deferredPredict;
        }
        if (url.pathname === '/api/doc') {
          counters.doc++;
          return Promise.resolve(new Response(JSON.stringify(modelB), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }));
        }
        return nativeFetch(input, init);
      };

      const proposalRequest = syncProposalSnapshot();
      const assistRequest = syncAssistSnapshot();
      const continuationRequest = syncContinuationSnapshot();
      for (let i = 0; i < 100 &&
           (counters.proposals < 1 ||
            counters.assists < 1 || counters.predict < 1); i++) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }

      enqueue('opened', { path: modelB.path, rev: modelB.rev });
      for (let i = 0; i < 100 &&
           (app.frame !== null || app.flushing || app.queue.length); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      renderProposal(proposalB);
      renderAssist(assistB);
      renderContinuation(continuationB);

      releaseProposals();
      releaseAssists();
      releasePredict();
      const [proposalResult, assistResult, continuationResult] =
        await Promise.all([
          proposalRequest,
          assistRequest,
          continuationRequest
        ]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const result = {
        counters,
        token: app.model && app.model.document_token,
        path: app.model && app.model.path,
        proposalStale: !!(proposalResult && proposalResult.stale),
        assistStale: assistResult === false,
        continuationStale: continuationResult === false,
        proposal: openProp && openProp.id,
        assist: openAssist && openAssist.id,
        continuation: openContinuation && openContinuation.id,
        oldProposal: !!document.querySelector(
          '[data-proposal="viewer-startup-A-proposal"]'),
        oldAssist: !!document.querySelector(
          '[data-assist="viewer-startup-A-assist"]'),
        oldContinuation: !!document.querySelector(
          '[data-continuation="viewer-startup-A-continuation"]'),
        oldPrediction:
          prediction.activeId === 'viewer-startup-A-active-prediction',
        oldMarkerVisible: document.body.textContent.includes(markerA),
        currentMarkerVisible: document.body.textContent.includes(markerB)
      };

      window.fetch = nativeFetch;
      app.model = null;
      app.documentPath = null;
      app.documentToken = null;
      clearDocumentBoundClientState();
      applyModel(canonical);
      setDocName(canonical.path);
      app.rev = canonical.rev;
      updateRevision();
      return result;
    })()`);
    check('delayed startup snapshots from A cannot render after document B opens',
      delayedStartupSnapshots.counters.proposals === 1 &&
      delayedStartupSnapshots.counters.assists === 1 &&
      delayedStartupSnapshots.counters.predict === 1 &&
      delayedStartupSnapshots.counters.doc === 1 &&
      delayedStartupSnapshots.token ===
        'viewer-startup-snapshot-owner-B' &&
      delayedStartupSnapshots.path.endsWith('.viewer-startup-B.docx') &&
      delayedStartupSnapshots.proposalStale &&
      delayedStartupSnapshots.assistStale &&
      delayedStartupSnapshots.continuationStale &&
      delayedStartupSnapshots.proposal ===
        'viewer-startup-B-proposal' &&
      delayedStartupSnapshots.assist ===
        'viewer-startup-B-assist' &&
      delayedStartupSnapshots.continuation ===
        'viewer-startup-B-continuation' &&
      !delayedStartupSnapshots.oldProposal &&
      !delayedStartupSnapshots.oldAssist &&
      !delayedStartupSnapshots.oldContinuation &&
      !delayedStartupSnapshots.oldPrediction &&
      !delayedStartupSnapshots.oldMarkerVisible &&
      delayedStartupSnapshots.currentMarkerVisible,
      JSON.stringify(delayedStartupSnapshots));

    const uploadWithoutOpenedEvent = await browser.eval(`(async () => {
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const canonical = clone(app.model);
      const modelA = clone(canonical);
      const modelB = clone(canonical);
      modelA.document_token = 'viewer-upload-owner-A';
      modelB.document_token = 'viewer-upload-owner-B';
      modelB.path = canonical.path + '.viewer-upload-B.docx';
      const targetB = modelB.paragraphs.find(
        (paragraph) => paragraph.text.length > 30);
      targetB.text = 'VIEWER UPLOAD RESPONSE PAINTED DOCUMENT B';
      targetB.hash = 'viewer-upload-B-authoritative-hash';
      targetB.runs = [{ text: targetB.text }];

      app.model = null;
      app.documentPath = null;
      app.documentToken = null;
      clearDocumentBoundClientState();
      applyModel(modelA);
      setDocName(modelA.path);
      app.rev = modelA.rev;
      updateRevision();

      let uploads = 0;
      let documentReads = 0;
      const nativeFetch = window.fetch;
      window.fetch = (input, init = {}) => {
        const url = new URL(String(input), location.href);
        if (url.pathname === '/api/upload') {
          uploads++;
          return Promise.resolve(new Response(JSON.stringify({
            ...modelB,
            model: modelB,
            uploaded: true,
            count: modelB.paragraphs.length,
            stamped: 0,
            stamps_persisted: false
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }));
        }
        if (url.pathname === '/api/doc') {
          documentReads++;
          return Promise.resolve(new Response(JSON.stringify(modelB), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }));
        }
        return nativeFetch(input, init);
      };

      await uploadDocument(new File(
        [new Uint8Array([0x50, 0x4b, 0x03, 0x04])],
        'viewer-upload-B.docx',
        {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        }
      ));
      const documentReadsAfterUpload = documentReads;
      const paintedFromResponse = {
        token: app.model && app.model.document_token,
        path: app.model && app.model.path,
        text: document.querySelector(
          '[data-pid="' + targetB.pid + '"]')?.textContent,
        name: document.getElementById('doc-name').textContent
      };

      // Preserve the second half as an independent assertion even on an
      // implementation that has not learned to paint the upload response yet.
      if (!app.model ||
          app.model.document_token !== modelB.document_token) {
        app.model = null;
        app.documentPath = null;
        app.documentToken = null;
        clearDocumentBoundClientState();
        applyModel(modelB);
        setDocName(modelB.path);
        app.rev = modelB.rev;
        updateRevision();
      }
      const proposalB = {
        id: 'viewer-upload-B-proposal',
        status: 'open',
        anchor_pid: targetB.pid,
        anchor_hash: targetB.hash,
        intent: 'Upload B proposal remains attached',
        options: [
          { id: 'A', text: 'Keep upload B state A' },
          { id: 'B', text: 'Keep upload B state B' }
        ],
        grounding: []
      };
      const assistB = {
        id: 'viewer-upload-B-assist',
        status: 'open',
        anchor_pid: targetB.pid,
        anchor_hash: targetB.hash,
        kind: 'answer',
        title: 'Upload B note',
        text: 'This note belongs to the freshly uploaded document.',
        grounding: []
      };
      renderProposal(proposalB);
      renderAssist(assistB);
      addTrail({
        op: 'replace',
        who: 'agent',
        summary: 'Upload B local state',
        at: new Date().toISOString()
      });

      const targetEl = document.querySelector(
        '[data-pid="' + targetB.pid + '"]');
      beginDirectEdit(targetEl);
      const exactDraft =
        targetB.text + ' [typed after upload response, before opened SSE]';
      targetEl.textContent = exactDraft;
      targetEl.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText'
      }));
      const edit = directEdits.get(targetB.pid);
      if (edit) clearTimeout(edit.saveTimer);
      const generationBeforeDuplicate = app.documentGeneration;
      const recoveryKeysBefore = new Set(app.recoveryDrafts.keys());

      enqueue('opened', {
        ...modelB,
        path: modelB.path,
        rev: modelB.rev,
        document_token: modelB.document_token
      });
      for (let i = 0; i < 100 &&
           (app.frame !== null || app.flushing || app.queue.length); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const duplicateOpened = {
        generation: app.documentGeneration,
        generationBefore: generationBeforeDuplicate,
        token: app.model && app.model.document_token,
        text: document.querySelector(
          '[data-pid="' + targetB.pid + '"]')?.textContent,
        draftRetained: directEdits.has(targetB.pid),
        draftDirty: !!directEdits.get(targetB.pid)?.dirty,
        newRecoveryDrafts: [...app.recoveryDrafts.keys()].filter(
          (key) => !recoveryKeysBefore.has(key)).length,
        proposal: openProp && openProp.id,
        assist: openAssist && openAssist.id,
        trail: trailEl.textContent
      };

      window.fetch = nativeFetch;
      for (const editState of directEdits.values()) {
        clearTimeout(editState.saveTimer);
      }
      directEdits.clear();
      for (const key of [...app.recoveryDrafts.keys()]) {
        if (!recoveryKeysBefore.has(key)) app.recoveryDrafts.delete(key);
      }
      renderRecoveryDrafts();
      app.model = null;
      app.documentPath = null;
      app.documentToken = null;
      clearDocumentBoundClientState();
      applyModel(canonical);
      setDocName(canonical.path);
      app.rev = canonical.rev;
      updateRevision();
      return {
        uploads,
        documentReads,
        documentReadsAfterUpload,
        paintedFromResponse,
        exactDraft,
        duplicateOpened
      };
    })()`);
    check('a successful upload paints document B even when its opened SSE is absent',
      uploadWithoutOpenedEvent.uploads === 1 &&
      uploadWithoutOpenedEvent.documentReadsAfterUpload === 1 &&
      uploadWithoutOpenedEvent.paintedFromResponse.token ===
        'viewer-upload-owner-B' &&
      uploadWithoutOpenedEvent.paintedFromResponse.path.endsWith(
        '.viewer-upload-B.docx') &&
      uploadWithoutOpenedEvent.paintedFromResponse.text ===
        'VIEWER UPLOAD RESPONSE PAINTED DOCUMENT B' &&
      uploadWithoutOpenedEvent.paintedFromResponse.name ===
        'paper.docx.viewer-upload-B.docx',
      JSON.stringify({
        uploads: uploadWithoutOpenedEvent.uploads,
        documentReads: uploadWithoutOpenedEvent.documentReads,
        documentReadsAfterUpload:
          uploadWithoutOpenedEvent.documentReadsAfterUpload,
        painted: uploadWithoutOpenedEvent.paintedFromResponse
      }));
    check('a later identical opened SSE preserves new-document typing and state',
      uploadWithoutOpenedEvent.duplicateOpened.generation ===
        uploadWithoutOpenedEvent.duplicateOpened.generationBefore &&
      uploadWithoutOpenedEvent.duplicateOpened.token ===
        'viewer-upload-owner-B' &&
      uploadWithoutOpenedEvent.duplicateOpened.text ===
        uploadWithoutOpenedEvent.exactDraft &&
      uploadWithoutOpenedEvent.duplicateOpened.draftRetained &&
      uploadWithoutOpenedEvent.duplicateOpened.draftDirty &&
      uploadWithoutOpenedEvent.duplicateOpened.newRecoveryDrafts === 0 &&
      uploadWithoutOpenedEvent.duplicateOpened.proposal ===
        'viewer-upload-B-proposal' &&
      uploadWithoutOpenedEvent.duplicateOpened.assist ===
        'viewer-upload-B-assist' &&
      /Upload B local state/.test(
        uploadWithoutOpenedEvent.duplicateOpened.trail),
      JSON.stringify(uploadWithoutOpenedEvent.duplicateOpened));

    const staleStopAcrossOpen = await browser.eval(`(async () => {
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const canonical = clone(app.model);
      const modelA = clone(canonical);
      const modelB = clone(canonical);
      modelA.document_token = 'viewer-stop-owner-A';
      modelB.document_token = 'viewer-stop-owner-B';
      modelB.path = canonical.path + '.viewer-stop-B.docx';
      app.model = null;
      app.documentPath = null;
      app.documentToken = null;
      clearDocumentBoundClientState();
      applyModel(modelA);
      setDocName(modelA.path);
      app.rev = modelA.rev;
      updateRevision();

      let stopCalls = 0;
      const stopBodies = [];
      let releaseStopA;
      const delayedStopA = new Promise((resolve) => {
        releaseStopA = () => resolve(new Response(JSON.stringify({
          stopped: true
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }));
      });
      const nativeFetch = window.fetch;
      window.fetch = (input, init = {}) => {
        const url = new URL(String(input), location.href);
        if (url.pathname === '/api/agent/stop') {
          stopCalls++;
          stopBodies.push(JSON.parse(init.body || '{}'));
          return delayedStopA;
        }
        if (url.pathname === '/api/doc') {
          return Promise.resolve(new Response(JSON.stringify(modelB), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }));
        }
        return nativeFetch(input, init);
      };

      clearLane();
      lane.ready = true;
      setAgentState('working', 'agent A is working');
      upsertCall('viewer-stop-A-call', {
        name: 'doc_read',
        state: 'running',
        args: { from: 0, to: 1 }
      });
      const stopA = stopAgent();
      for (let i = 0; i < 50 && stopCalls < 1; i++) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }

      enqueue('opened', {
        path: modelB.path,
        rev: modelB.rev,
        document_token: modelB.document_token
      });
      for (let i = 0; i < 100 &&
           (app.frame !== null || app.flushing || app.queue.length); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      clearLane();
      lane.ready = true;
      setAgentState('working', 'agent B is working');
      upsertCall('viewer-stop-B-call', {
        name: 'doc_find',
        state: 'running',
        args: { query: 'belongs to document B' }
      });
      const beforeStopASettles = {
        token: app.model && app.model.document_token,
        state: lane.state,
        ready: lane.ready,
        stopHidden: document.getElementById('agent-btn').hidden,
        stopDisabled: document.getElementById('agent-btn').disabled,
        bCall: !!document.querySelector(
          '#lane [data-id="viewer-stop-B-call"]')
      };

      releaseStopA();
      await stopA;
      await new Promise((resolve) => setTimeout(resolve, 20));
      const afterStopASettles = {
        token: app.model && app.model.document_token,
        state: lane.state,
        ready: lane.ready,
        hint: document.getElementById('lane-hint').textContent,
        stopHidden: document.getElementById('agent-btn').hidden,
        stopDisabled: document.getElementById('agent-btn').disabled,
        bCall: !!document.querySelector(
          '#lane [data-id="viewer-stop-B-call"]')
      };

      window.fetch = nativeFetch;
      clearLane();
      lane.ready = false;
      setAgentState('off', '');
      app.model = null;
      app.documentPath = null;
      app.documentToken = null;
      clearDocumentBoundClientState();
      applyModel(canonical);
      setDocName(canonical.path);
      app.rev = canonical.rev;
      updateRevision();
      return {
        stopCalls,
        stopBodies,
        beforeStopASettles,
        afterStopASettles
      };
    })()`);
    check('a delayed Stop for document A cannot stop or clear document B agent state',
      staleStopAcrossOpen.stopCalls === 1 &&
      staleStopAcrossOpen.stopBodies[0]?.expect_document_token ===
        'viewer-stop-owner-A' &&
      staleStopAcrossOpen.beforeStopASettles.token ===
        'viewer-stop-owner-B' &&
      staleStopAcrossOpen.beforeStopASettles.state === 'working' &&
      staleStopAcrossOpen.beforeStopASettles.ready &&
      !staleStopAcrossOpen.beforeStopASettles.stopHidden &&
      !staleStopAcrossOpen.beforeStopASettles.stopDisabled &&
      staleStopAcrossOpen.beforeStopASettles.bCall &&
      staleStopAcrossOpen.afterStopASettles.token ===
        'viewer-stop-owner-B' &&
      staleStopAcrossOpen.afterStopASettles.state === 'working' &&
      staleStopAcrossOpen.afterStopASettles.ready &&
      staleStopAcrossOpen.afterStopASettles.hint ===
        'agent B is working' &&
      !staleStopAcrossOpen.afterStopASettles.stopHidden &&
      !staleStopAcrossOpen.afterStopASettles.stopDisabled &&
      staleStopAcrossOpen.afterStopASettles.bCall,
      JSON.stringify(staleStopAcrossOpen));

    const staleSayAcrossOpen = await browser.eval(`(async () => {
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const canonical = clone(app.model);
      const modelA = clone(canonical);
      const modelB = clone(canonical);
      modelA.document_token = 'viewer-say-owner-A';
      modelB.document_token = 'viewer-say-owner-B';
      modelB.path = canonical.path + '.viewer-say-B.docx';
      app.model = null;
      app.documentPath = null;
      app.documentToken = null;
      clearDocumentBoundClientState();
      const recoveryKeysBefore = new Set(app.recoveryDrafts.keys());
      applyModel(modelA);
      setDocName(modelA.path);
      app.rev = modelA.rev;
      updateRevision();

      const messageA = 'MESSAGE A MUST NEVER ENTER DOCUMENT B';
      const messageB = 'Message B owns the current posting lane';
      let sayCalls = 0;
      const sayBodies = [];
      let rejectSayA;
      let releaseSayB;
      const delayedSayA = new Promise((_resolve, reject) => {
        rejectSayA = () => reject(new TypeError(
          'simulated lost acknowledgement for document A'));
      });
      const delayedSayB = new Promise((resolve) => {
        releaseSayB = () => resolve(new Response(JSON.stringify({
          recorded: true,
          delivered: true,
          queued: false
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }));
      });
      const nativeFetch = window.fetch;
      window.fetch = (input, init = {}) => {
        const url = new URL(String(input), location.href);
        if (url.pathname === '/api/say') {
          sayCalls++;
          sayBodies.push(JSON.parse(init.body || '{}'));
          return sayCalls === 1 ? delayedSayA : delayedSayB;
        }
        if (url.pathname === '/api/doc') {
          return Promise.resolve(new Response(JSON.stringify(modelB), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }));
        }
        return nativeFetch(input, init);
      };

      const input = document.getElementById('say');
      const form = document.getElementById('bar');
      const send = document.getElementById('send');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.value = messageA;
      form.dispatchEvent(new Event('submit', {
        bubbles: true,
        cancelable: true
      }));
      for (let i = 0; i < 50 && sayCalls < 1; i++) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }

      enqueue('opened', {
        path: modelB.path,
        rev: modelB.rev,
        document_token: modelB.document_token
      });
      for (let i = 0; i < 100 &&
           (app.frame !== null || app.flushing || app.queue.length); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      input.value = messageB;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      form.dispatchEvent(new Event('submit', {
        bubbles: true,
        cancelable: true
      }));
      for (let i = 0; i < 100 && sayCalls < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      const bStarted = sayCalls === 2;

      rejectSayA();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const afterASettles = {
        bStarted,
        token: app.model && app.model.document_token,
        value: input.value,
        posting: !!messagePosting,
        busy: form.hasAttribute('aria-busy'),
        sendDisabled: send.disabled,
        delivery: form.dataset.delivery || '',
        pendingText:
          pendingMessageAcknowledgement &&
          pendingMessageAcknowledgement.text
      };

      if (bStarted) {
        releaseSayB();
        for (let i = 0; i < 100 &&
             (messagePosting || form.hasAttribute('aria-busy')); i++) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      } else {
        for (let i = 0; i < 100 && messagePosting; i++) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      const final = {
        value: input.value,
        posting: !!messagePosting,
        busy: form.hasAttribute('aria-busy'),
        sendDisabled: send.disabled,
        pending: !!pendingMessageAcknowledgement
      };

      window.fetch = nativeFetch;
      pendingMessageAcknowledgement = null;
      messagePosting = false;
      input.value = '';
      delete form.dataset.delivery;
      form.removeAttribute('aria-busy');
      form.removeAttribute('title');
      send.disabled = false;
      messageDeliveryHint = '';
      app.model = null;
      app.documentPath = null;
      app.documentToken = null;
      clearDocumentBoundClientState();
      for (const key of [...app.recoveryDrafts.keys()]) {
        if (!recoveryKeysBefore.has(key)) app.recoveryDrafts.delete(key);
      }
      renderRecoveryDrafts();
      applyModel(canonical);
      setDocName(canonical.path);
      app.rev = canonical.rev;
      updateRevision();
      return {
        sayCalls,
        sayBodies,
        messageA,
        messageB,
        afterASettles,
        final
      };
    })()`);
    check('a rejected Say from document A cannot restore text or release document B posting',
      staleSayAcrossOpen.sayCalls === 2 &&
      staleSayAcrossOpen.sayBodies[0]?.expect_document_token ===
        'viewer-say-owner-A' &&
      staleSayAcrossOpen.sayBodies[1]?.expect_document_token ===
        'viewer-say-owner-B' &&
      staleSayAcrossOpen.afterASettles.bStarted &&
      staleSayAcrossOpen.afterASettles.token ===
        'viewer-say-owner-B' &&
      !staleSayAcrossOpen.afterASettles.value.includes(
        staleSayAcrossOpen.messageA) &&
      staleSayAcrossOpen.afterASettles.posting &&
      staleSayAcrossOpen.afterASettles.busy &&
      staleSayAcrossOpen.afterASettles.sendDisabled &&
      staleSayAcrossOpen.afterASettles.delivery === 'sending' &&
      staleSayAcrossOpen.afterASettles.pendingText ===
        staleSayAcrossOpen.messageB &&
      staleSayAcrossOpen.final.value === '' &&
      !staleSayAcrossOpen.final.posting &&
      !staleSayAcrossOpen.final.busy &&
      !staleSayAcrossOpen.final.sendDisabled &&
      !staleSayAcrossOpen.final.pending,
      JSON.stringify(staleSayAcrossOpen));

    const staleVoiceAcrossOpen = await browser.eval(`(async () => {
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const canonical = clone(app.model);
      const modelA = clone(canonical);
      const modelB = clone(canonical);
      modelA.document_token = 'viewer-voice-owner-A';
      modelB.document_token = 'viewer-voice-owner-B';
      modelB.path = canonical.path + '.viewer-voice-B.docx';
      app.model = null;
      app.documentPath = null;
      app.documentToken = null;
      clearDocumentBoundClientState();
      const recoveryKeysBefore = new Set(app.recoveryDrafts.keys());
      applyModel(modelA);
      setDocName(modelA.path);
      app.rev = modelA.rev;
      updateRevision();

      const transcriptA =
        'VOICE TRANSCRIPT A MUST NEVER BE SENT TO DOCUMENT B';
      const input = document.getElementById('say');
      const form = document.getElementById('bar');
      const voice = window.mic;
      const callbacksAvailable = !!(
        voice &&
        typeof voice.onState === 'function' &&
        typeof voice.onText === 'function'
      );
      let sayCalls = 0;
      const sayBodies = [];
      const nativeFetch = window.fetch;
      window.fetch = (request, init = {}) => {
        const url = new URL(String(request), location.href);
        if (url.pathname === '/api/doc') {
          return Promise.resolve(new Response(JSON.stringify(modelB), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }));
        }
        if (url.pathname === '/api/say') {
          sayCalls++;
          sayBodies.push(JSON.parse(init.body || '{}'));
          return Promise.resolve(new Response(JSON.stringify({
            recorded: true,
            delivered: true,
            queued: false
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }));
        }
        return nativeFetch(request, init);
      };

      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (callbacksAvailable) {
        // Mirror the observable state transitions around a real utterance. The
        // transcript itself is deliberately withheld until after Open B.
        voice.listening = true;
        voice.speaking = false;
        voice.onState('listening');
        voice.speaking = true;
        voice.onState('speaking');
        voice.speaking = false;
        voice.onState('thinking');
      }

      enqueue('opened', {
        path: modelB.path,
        rev: modelB.rev,
        document_token: modelB.document_token
      });
      for (let i = 0; i < 100 &&
           (app.frame !== null || app.flushing || app.queue.length); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (callbacksAvailable) {
        voice.onText(transcriptA, { text: transcriptA });
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
      const result = {
        callbacksAvailable,
        token: app.model && app.model.document_token,
        sayCalls,
        sayBodies,
        value: input.value,
        posting: !!messagePosting,
        pending: !!pendingMessageAcknowledgement,
        busy: form.hasAttribute('aria-busy'),
        transcriptA
      };

      window.fetch = nativeFetch;
      try {
        voice.listening = false;
        voice.speaking = false;
        if (callbacksAvailable) voice.onState('off');
      } catch (_) {}
      pendingMessageAcknowledgement = null;
      messagePosting = false;
      input.value = '';
      delete form.dataset.delivery;
      form.removeAttribute('aria-busy');
      form.removeAttribute('title');
      document.getElementById('send').disabled = false;
      messageDeliveryHint = '';
      app.model = null;
      app.documentPath = null;
      app.documentToken = null;
      clearDocumentBoundClientState();
      for (const key of [...app.recoveryDrafts.keys()]) {
        if (!recoveryKeysBefore.has(key)) app.recoveryDrafts.delete(key);
      }
      renderRecoveryDrafts();
      applyModel(canonical);
      setDocName(canonical.path);
      app.rev = canonical.rev;
      updateRevision();
      return result;
    })()`);
    check('a delayed document A voice transcript cannot auto-submit into document B',
      staleVoiceAcrossOpen.callbacksAvailable &&
      staleVoiceAcrossOpen.token === 'viewer-voice-owner-B' &&
      staleVoiceAcrossOpen.sayCalls === 0 &&
      staleVoiceAcrossOpen.sayBodies.length === 0 &&
      !staleVoiceAcrossOpen.value.includes(
        staleVoiceAcrossOpen.transcriptA) &&
      !staleVoiceAcrossOpen.posting &&
      !staleVoiceAcrossOpen.pending &&
      !staleVoiceAcrossOpen.busy,
      JSON.stringify(staleVoiceAcrossOpen));

    const retiredEventSource = await browser.eval(`(async () => {
      for (let i = 0; i < 100 &&
           (app.frame !== null || app.flushing || app.queue.length); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const canonical = clone(app.model);
      const newerModel = clone(canonical);
      newerModel.document_token = 'viewer-active-event-source-owner';
      const anchor = newerModel.paragraphs.find(
        (paragraph) => paragraph.text);
      app.model = null;
      app.documentPath = null;
      app.documentToken = null;
      applyModel(newerModel);
      setDocName(newerModel.path);
      const newNote = {
        id: 'viewer-active-source-assist',
        status: 'open',
        anchor_pid: anchor.pid,
        anchor_hash: anchor.hash,
        kind: 'answer',
        title: 'Current ownership note',
        text: 'Only the active EventSource may change this note.',
        grounding: []
      };
      renderAssist(newNote);

      const NativeEventSource = window.EventSource;
      const nativeConnect = connect;
      const streams = [];
      class FakeEventSource extends EventTarget {
        constructor(url) {
          super();
          this.url = url;
          this.closed = false;
          this.onopen = null;
          this.onerror = null;
          streams.push(this);
        }
        close() {
          this.closed = true;
        }
      }
      window.EventSource = FakeEventSource;
      const retired = connect();
      const active = connect();
      const healthDot = document.getElementById('health-dot');
      healthDot.className = 'dot ok';
      healthDot.title = 'new ownership is healthy';
      app.pendingHighlight.set(anchor.pid, {
        start: 0,
        end: Math.min(1, anchor.text.length)
      });

      app.flushing = true;
      retired.dispatchEvent(new MessageEvent('assist', {
        data: JSON.stringify({
          id: 'viewer-retired-source-assist',
          status: 'open',
          anchor_pid: anchor.pid,
          anchor_hash: anchor.hash,
          kind: 'answer',
          title: 'Retired source note',
          text: 'THIS RETIRED STREAM MUST BE IGNORED',
          grounding: [],
          at: '9999-12-31T23:59:59.999Z'
        })
      }));
      const afterLateAssistQueue = app.queue.length;
      app.queue.push({
        type: 'health',
        data: { ok: true, marker: 'active-source-queue' }
      });
      retired.onerror(new Event('error'));
      const beforeCleanup = {
        streams: streams.length,
        retiredClosed: retired.closed,
        activeCurrent: eventStream === active,
        token: app.model && app.model.document_token,
        afterLateAssistQueue,
        queueAfterLateError: app.queue.length,
        queueMarker: app.queue[0] && app.queue[0].data.marker,
        highlightRetained: app.pendingHighlight.has(anchor.pid),
        healthClass: healthDot.className,
        healthTitle: healthDot.title,
        newAssist: !!document.querySelector(
          '[data-assist="viewer-active-source-assist"]'),
        oldAssist: !!document.querySelector(
          '[data-assist="viewer-retired-source-assist"]'),
        openAssist: openAssist && openAssist.id
      };

      app.queue.length = 0;
      app.flushing = false;
      app.pendingHighlight.clear();
      renderAssist(null);
      active.close();
      window.EventSource = NativeEventSource;
      app.model = null;
      clearDocumentBoundClientState();
      applyModel(canonical);
      setDocName(canonical.path);
      app.rev = canonical.rev;
      updateRevision();
      const reconnectFetchSeq = modelFetchSeq;
      nativeConnect();
      for (let i = 0; i < 400 &&
           (modelFetchSeq <= reconnectFetchSeq ||
            app.frame !== null || app.flushing || app.queue.length); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      return beforeCleanup;
    })()`);
    check('a retired EventSource cannot enqueue, mutate, or clear newer ownership',
      retiredEventSource.streams === 2 &&
      retiredEventSource.retiredClosed &&
      retiredEventSource.activeCurrent &&
      retiredEventSource.token === 'viewer-active-event-source-owner' &&
      retiredEventSource.afterLateAssistQueue === 0 &&
      retiredEventSource.queueAfterLateError === 1 &&
      retiredEventSource.queueMarker === 'active-source-queue' &&
      retiredEventSource.highlightRetained &&
      retiredEventSource.healthClass === 'dot ok' &&
      retiredEventSource.healthTitle === 'new ownership is healthy' &&
      retiredEventSource.newAssist &&
      !retiredEventSource.oldAssist &&
      retiredEventSource.openAssist === 'viewer-active-source-assist',
      JSON.stringify(retiredEventSource));

    const invertedAgentSnapshots = await browser.eval(`(async () => {
      const nativeFetch = window.fetch;
      const documentToken = app.model && app.model.document_token;
      const pool = {
        enabledModels: ['sonnet', 'opus', 'terra', 'sol'],
        automaticModels: { watch: 'sonnet', continue: 'sonnet' }
      };
      const olderWorking = {
        running: true,
        busy: true,
        pid: 42421,
        sessionId: 'viewer-older-working-session',
        model: 'sonnet',
        provider: 'claude',
        costUsd: 0.25,
        document_token: documentToken,
        ...pool
      };
      const newerOff = {
        running: false,
        busy: false,
        pid: null,
        sessionId: null,
        model: 'sonnet',
        provider: 'claude',
        costUsd: 0,
        document_token: documentToken,
        ...pool
      };

      let calls = 0;
      let releaseOlder;
      const delayedOlder = new Promise((resolve) => {
        releaseOlder = () => resolve(new Response(
          JSON.stringify(olderWorking),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        ));
      });
      window.fetch = (input, init = {}) => {
        const url = new URL(String(input), location.href);
        if (url.pathname !== '/api/agent') return nativeFetch(input, init);
        calls++;
        if (calls === 1) return delayedOlder;
        return Promise.resolve(new Response(JSON.stringify(newerOff), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }));
      };

      lane.ready = true;
      setAgentState('working', 'older snapshot is still in flight');
      const olderRequest = syncAgentSnapshot();
      for (let i = 0; i < 50 && calls < 1; i++) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      const newerRequest = syncAgentSnapshot();
      const newerApplied = await newerRequest;
      const afterNewer = {
        state: lane.state,
        ready: lane.ready,
        stopHidden: document.getElementById('agent-btn').hidden,
        stopDisabled: document.getElementById('agent-btn').disabled
      };

      releaseOlder();
      const olderApplied = await olderRequest;
      await new Promise((resolve) => setTimeout(resolve, 20));
      const final = {
        state: lane.state,
        ready: lane.ready,
        stopHidden: document.getElementById('agent-btn').hidden,
        stopDisabled: document.getElementById('agent-btn').disabled,
        hint: document.getElementById('lane-hint').textContent
      };
      window.fetch = nativeFetch;
      return {
        calls,
        olderWasWorking: olderWorking.running && olderWorking.busy,
        newerApplied,
        olderApplied,
        afterNewer,
        final
      };
    })()`);
    check('an older delayed working snapshot cannot revive a newer off agent lane',
      invertedAgentSnapshots.calls === 2 &&
      invertedAgentSnapshots.olderWasWorking &&
      invertedAgentSnapshots.newerApplied === true &&
      invertedAgentSnapshots.olderApplied === false &&
      invertedAgentSnapshots.afterNewer.state === 'off' &&
      invertedAgentSnapshots.afterNewer.ready === false &&
      invertedAgentSnapshots.afterNewer.stopHidden &&
      invertedAgentSnapshots.afterNewer.stopDisabled &&
      invertedAgentSnapshots.final.state === 'off' &&
      invertedAgentSnapshots.final.ready === false &&
      invertedAgentSnapshots.final.stopHidden &&
      invertedAgentSnapshots.final.stopDisabled &&
      invertedAgentSnapshots.final.hint === '',
      JSON.stringify(invertedAgentSnapshots));

    console.log('\n[bounded delivery and live acknowledgements]');
    const timedOutMessage = await browser.eval(`(async () => {
      const nativeFetch = window.fetch;
      window.__SCRIBE_HTTP_TIMEOUT_MS = 35;
      window.fetch = (input, init = {}) => {
        const url = new URL(String(input), location.href);
        if (url.pathname !== '/api/say') return nativeFetch(input, init);
        return new Promise((_resolve, reject) => {
          const abort = () => reject(new DOMException('aborted', 'AbortError'));
          if (init.signal && init.signal.aborted) abort();
          else if (init.signal) init.signal.addEventListener('abort', abort, { once: true });
        });
      };
      const started = performance.now();
      const input = document.getElementById('say');
      input.value = 'A request that never settles';
      document.getElementById('bar').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }));
      for (let i = 0; i < 80 && document.getElementById('bar').hasAttribute('aria-busy'); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const result = {
        elapsed: performance.now() - started,
        draft: input.value,
        busy: document.getElementById('bar').hasAttribute('aria-busy'),
        disabled: document.getElementById('send').disabled,
        hint: document.getElementById('lane-hint').textContent
      };
      window.fetch = nativeFetch;
      delete window.__SCRIBE_HTTP_TIMEOUT_MS;
      return result;
    })()`);
    check('a never-settling message request is bounded and leaves a retryable draft',
      timedOutMessage.elapsed < 800 &&
      timedOutMessage.draft === 'A request that never settles' &&
      !timedOutMessage.busy && !timedOutMessage.disabled &&
      /timed out|still here|unavailable/i.test(timedOutMessage.hint || ''),
      JSON.stringify(timedOutMessage));

    const timedOutBody = await browser.eval(`(async () => {
      const nativeFetch = window.fetch;
      window.__SCRIBE_HTTP_TIMEOUT_MS = 35;
      window.fetch = (input, init = {}) => {
        const url = new URL(String(input), location.href);
        if (url.pathname !== '/api/say') return nativeFetch(input, init);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => new Promise(() => {})
        });
      };
      const started = performance.now();
      const input = document.getElementById('say');
      input.value = 'Headers arrived but the body stalled';
      document.getElementById('bar').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }));
      for (let i = 0; i < 80 && document.getElementById('bar').hasAttribute('aria-busy'); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const result = {
        elapsed: performance.now() - started,
        draft: input.value,
        busy: document.getElementById('bar').hasAttribute('aria-busy'),
        disabled: document.getElementById('send').disabled
      };
      window.fetch = nativeFetch;
      delete window.__SCRIBE_HTTP_TIMEOUT_MS;
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.blur();
      return result;
    })()`);
    check('a never-settling response body is bounded too',
      timedOutBody.elapsed < 800 &&
      timedOutBody.draft === 'Headers arrived but the body stalled' &&
      !timedOutBody.busy && !timedOutBody.disabled,
      JSON.stringify(timedOutBody));

    const acknowledgedMessage = await browser.eval(`(async () => {
      const nativeFetch = window.fetch;
      window.__SCRIBE_HTTP_TIMEOUT_MS = 45;
      window.fetch = (input, init = {}) => {
        const url = new URL(String(input), location.href);
        if (url.pathname !== '/api/say') return nativeFetch(input, init);
        return new Promise((_resolve, reject) => {
          const abort = () => reject(new DOMException('aborted', 'AbortError'));
          if (init.signal && init.signal.aborted) abort();
          else if (init.signal) init.signal.addEventListener('abort', abort, { once: true });
        });
      };
      const text = 'The live trail confirms this message';
      const input = document.getElementById('say');
      input.value = text;
      document.getElementById('bar').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 8));
      window.__feed('trail', {
        id: 'viewer-lost-say-ack',
        at: new Date().toISOString(),
        op: 'said',
        who: 'human',
        summary: text
      });
      for (let i = 0; i < 80 && document.getElementById('bar').hasAttribute('aria-busy'); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const result = {
        draft: input.value,
        busy: document.getElementById('bar').hasAttribute('aria-busy'),
        disabled: document.getElementById('send').disabled,
        delivery: document.getElementById('bar').dataset.delivery || '',
        conversation: document.getElementById('conversation-turns').textContent
      };
      window.fetch = nativeFetch;
      delete window.__SCRIBE_HTTP_TIMEOUT_MS;
      return result;
    })()`);
    check('a matching live trail acknowledgement prevents a lost Say response from restoring the draft',
      acknowledgedMessage.draft === '' && !acknowledgedMessage.busy &&
      !acknowledgedMessage.disabled && acknowledgedMessage.delivery !== 'error' &&
      /live trail confirms this message/i.test(acknowledgedMessage.conversation || ''),
      JSON.stringify(acknowledgedMessage));

    const manualVoiceDraft = await browser.eval(`(async () => {
      const input = document.getElementById('say');
      input.value = 'Carefully typed manual draft';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const voice = window.mic;
      const recoveryKeysBefore = new Set(app.recoveryDrafts.keys());
      if (voice && typeof voice.onText === 'function') {
        if (typeof voice.onState === 'function') voice.onState('listening');
        voice.onText('new spoken transcript', { text: 'new spoken transcript' });
        if (typeof voice.onState === 'function') voice.onState('off');
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
      const value = input.value;
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.blur();
      if (document.getElementById('lane-hint').textContent ===
          'voice transcript added to your draft') {
        document.getElementById('lane-hint').textContent = '';
      }
      for (const key of [...app.recoveryDrafts.keys()]) {
        if (!recoveryKeysBefore.has(key)) app.recoveryDrafts.delete(key);
      }
      renderRecoveryDrafts();
      return value;
    })()`);
    check('a voice transcript never overwrites a nonempty manually typed composer draft',
      manualVoiceDraft.includes('Carefully typed manual draft') &&
      manualVoiceDraft !== 'new spoken transcript',
      JSON.stringify(manualVoiceDraft));

    console.log('\n[ordered document refresh]');
    const orderedRefresh = await browser.eval(`(async () => {
      const nativeFetch = window.fetch;
      const base = JSON.parse(JSON.stringify(window.__scribe.model));
      const older = JSON.parse(JSON.stringify(base));
      const target = older.paragraphs.find((p) => !p.table && p.text);
      const authoritative = base.paragraphs.find((p) => p.pid === target.pid);
      target.text += ' [stale delayed model]';
      target.hash = 'stale-delayed-hash';
      target.runs = [{ text: target.text }];
      const resolvers = [];
      let calls = 0;
      window.fetch = (input, init) => {
        const url = new URL(String(input), location.href);
        if (url.pathname !== '/api/doc') return nativeFetch(input, init);
        calls++;
        return new Promise((resolve) => resolvers.push((model) => resolve({
          ok: true, status: 200, json: () => Promise.resolve(model)
        })));
      };
      window.__feed('document', { rev: window.__scribe.rev + 1 });
      await new Promise((resolve) => setTimeout(resolve, 80));
      window.__feed('document', { rev: window.__scribe.rev + 2 });
      await new Promise((resolve) => setTimeout(resolve, 80));
      const coalesced = calls === 1;
      resolvers.shift()(older);
      for (let i = 0; i < 30 && calls < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (resolvers.length) resolvers.shift()(base);
      for (let i = 0; i < 30; i++) {
        const shown = document.querySelector('[data-pid="' + target.pid + '"]');
        if (shown && shown.textContent === authoritative.text &&
            !window.__scribe.flushing) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const shown = document.querySelector('[data-pid="' + target.pid + '"]');
      window.fetch = nativeFetch;
      return {
        calls,
        coalesced,
        finalText: shown && shown.textContent,
        expected: authoritative.text,
        flushing: window.__scribe.flushing
      };
    })()`);
    check('document refreshes are serialized and a delayed model cannot win',
      orderedRefresh.coalesced && orderedRefresh.calls === 2 &&
      orderedRefresh.finalText === orderedRefresh.expected &&
      orderedRefresh.flushing === false,
      JSON.stringify(orderedRefresh));

    const refreshRetryInversion = await browser.eval(`(async () => {
      for (let i = 0; i < 100 &&
           (app.frame !== null || app.flushing || app.queue.length); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const canonical = clone(app.model);
      const oldModel = clone(canonical);
      const newModel = clone(canonical);
      const target = canonical.paragraphs.find(
        (paragraph) => !paragraph.table && paragraph.text);
      const oldTarget = oldModel.paragraphs.find(
        (paragraph) => paragraph.pid === target.pid);
      const newTarget = newModel.paragraphs.find(
        (paragraph) => paragraph.pid === target.pid);
      const oldMarker = 'LATE REVISION N MUST REMAIN STALE';
      const newMarker = 'AUTOMATIC F3 PAINTED REVISION N PLUS ONE';
      oldModel.rev = canonical.rev;
      oldTarget.text = oldMarker;
      oldTarget.hash = 'viewer-refresh-inversion-old-hash';
      oldTarget.runs = [{ text: oldMarker }];
      newModel.rev = canonical.rev + 1;
      newTarget.text = newMarker;
      newTarget.hash = 'viewer-refresh-inversion-new-hash';
      newTarget.runs = [{ text: newMarker }];

      const nativeFetch = window.fetch;
      const nativeConnect = connect;
      const activeEventStream = eventStream;
      const fetchSeqBefore = modelFetchSeq;
      const barrierAtStart = requiredModelFetchSeq;
      const reconnectTimerAtStart = authoritativeReconnectTimer;
      let documentReads = 0;
      let reconnects = 0;
      let automaticHellos = 0;
      let manualRequiredEvents = 0;
      let releaseFirst = null;
      let result = null;

      if (authoritativeReconnectTimer !== null) {
        clearTimeout(authoritativeReconnectTimer);
        authoritativeReconnectTimer = null;
      }
      authoritativeReconnectAttempt = 0;
      requiredModelFetchSeq = 0;
      window.fetch = (request, init = {}) => {
        const url = new URL(String(request), location.href);
        if (url.pathname !== '/api/doc') return nativeFetch(request, init);
        documentReads++;
        if (documentReads === 1) {
          return new Promise((resolve) => {
            releaseFirst = () => resolve(new Response(
              JSON.stringify(oldModel), {
                status: 200,
                headers: { 'content-type': 'application/json' }
              }));
          });
        }
        if (documentReads === 2) {
          return Promise.resolve(new Response(JSON.stringify({
            error: 'simulated newer required refresh failure'
          }), {
            status: 503,
            headers: { 'content-type': 'application/json' }
          }));
        }
        return Promise.resolve(new Response(JSON.stringify(newModel), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }));
      };
      connect = () => {
        reconnects++;
        setTimeout(() => {
          automaticHellos++;
          enqueue('hello', {
            health: {
              ok: true,
              docPath: newModel.path,
              document_token: newModel.document_token,
              rev: newModel.rev,
              paused: false,
              bootedAt: app.serverBootedAt,
              capabilities: { paragraphMerge: true }
            }
          });
        }, 0);
        return { close() {} };
      };

      try {
        // F1 begins first and remains held at revision N.
        const firstRequest = fetchModel();
        for (let i = 0; i < 50 &&
             (documentReads < 1 || !releaseFirst); i++) {
          await new Promise((resolve) => setTimeout(resolve, 2));
        }

        // This is the test's only required event. Its newer F2 read fails and
        // must leave an authoritative reconnect retry armed.
        manualRequiredEvents++;
        enqueue('document', {
          rev: newModel.rev,
          reason: 'viewer refresh inversion required F2'
        });
        for (let i = 0; i < 80 &&
             (documentReads < 2 ||
              authoritativeReconnectTimer === null ||
              app.flushing); i++) {
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        const retryBeforeLateF1 = authoritativeReconnectTimer;
        const barrierBeforeLateF1 = requiredModelFetchSeq;
        const appliedBeforeLateF1 = modelAppliedSeq;

        releaseFirst();
        const lateModel = await firstRequest;
        const lateApply = applyModel(lateModel);
        const shownAfterLateF1 = document.querySelector(
          '[data-pid="' + target.pid + '"]')?.textContent;
        const afterLateF1 = {
          apply: lateApply,
          barrier: requiredModelFetchSeq,
          barrierUnchanged: requiredModelFetchSeq === barrierBeforeLateF1,
          appliedSequenceUnchanged: modelAppliedSeq === appliedBeforeLateF1,
          retryStillArmed:
            authoritativeReconnectTimer !== null &&
            authoritativeReconnectTimer === retryBeforeLateF1,
          shown: shownAfterLateF1,
          oldVisible: document.body.textContent.includes(oldMarker)
        };

        // No second document/edit event is injected. The retry calls connect,
        // whose authoritative hello starts F3 and paints revision N + 1.
        for (let i = 0; i < 600 &&
             (documentReads < 3 ||
              reconnects < 1 ||
              automaticHellos < 1 ||
              !app.model ||
              app.model.rev !== newModel.rev ||
              app.frame !== null ||
              app.flushing ||
              app.queue.length); i++) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        const readsAfterRecovery = documentReads;
        const reconnectsAfterRecovery = reconnects;
        await new Promise((resolve) => setTimeout(resolve, 60));
        result = {
          initialRev: canonical.rev,
          expectedRev: newModel.rev,
          documentReads,
          readsAfterRecovery,
          reconnects,
          reconnectsAfterRecovery,
          automaticHellos,
          manualRequiredEvents,
          afterLateF1,
          finalRev: app.model && app.model.rev,
          finalText: document.querySelector(
            '[data-pid="' + target.pid + '"]')?.textContent,
          oldVisible: document.body.textContent.includes(oldMarker),
          newVisible: document.body.textContent.includes(newMarker),
          barrier: requiredModelFetchSeq,
          reconnectTimer: authoritativeReconnectTimer,
          queued: app.queue.length,
          flushing: app.flushing
        };
      } finally {
        if (releaseFirst) releaseFirst();
        window.fetch = nativeFetch;
        connect = nativeConnect;
        if (authoritativeReconnectTimer !== null) {
          clearTimeout(authoritativeReconnectTimer);
          authoritativeReconnectTimer = null;
        }
        authoritativeReconnectAttempt = 0;
        requiredModelFetchSeq = 0;
        applyModel(canonical);
        setDocName(canonical.path);
        app.rev = canonical.rev;
        updateRevision();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        if (result) {
          result.isolation = {
            barrierAtStart,
            reconnectTimerAtStart,
            sameEventStream: eventStream === activeEventStream,
            modelFetches: modelFetchSeq - fetchSeqBefore,
            barrier: requiredModelFetchSeq,
            reconnectTimer: authoritativeReconnectTimer,
            queued: app.queue.length,
            flushing: app.flushing,
            restoredRev: app.model && app.model.rev,
            restoredText: document.querySelector(
              '[data-pid="' + target.pid + '"]')?.textContent
          };
        }
      }
      return result;
    })()`);
    check('a late F1 cannot cancel a failed newer refresh retry, whose automatic F3 paints N + 1',
      refreshRetryInversion.initialRev + 1 === refreshRetryInversion.expectedRev &&
      refreshRetryInversion.documentReads === 3 &&
      refreshRetryInversion.readsAfterRecovery === 3 &&
      refreshRetryInversion.reconnects === 1 &&
      refreshRetryInversion.reconnectsAfterRecovery === 1 &&
      refreshRetryInversion.automaticHellos === 1 &&
      refreshRetryInversion.manualRequiredEvents === 1 &&
      refreshRetryInversion.afterLateF1.apply.stale === true &&
      refreshRetryInversion.afterLateF1.barrier > 0 &&
      refreshRetryInversion.afterLateF1.barrierUnchanged &&
      refreshRetryInversion.afterLateF1.appliedSequenceUnchanged &&
      refreshRetryInversion.afterLateF1.retryStillArmed &&
      refreshRetryInversion.afterLateF1.shown !==
        'LATE REVISION N MUST REMAIN STALE' &&
      !refreshRetryInversion.afterLateF1.oldVisible &&
      refreshRetryInversion.finalRev === refreshRetryInversion.expectedRev &&
      refreshRetryInversion.finalText ===
        'AUTOMATIC F3 PAINTED REVISION N PLUS ONE' &&
      !refreshRetryInversion.oldVisible &&
      refreshRetryInversion.newVisible &&
      refreshRetryInversion.barrier === 0 &&
      refreshRetryInversion.reconnectTimer === null &&
      refreshRetryInversion.queued === 0 &&
      refreshRetryInversion.flushing === false &&
      refreshRetryInversion.isolation.barrierAtStart === 0 &&
      refreshRetryInversion.isolation.reconnectTimerAtStart === null &&
      refreshRetryInversion.isolation.sameEventStream &&
      refreshRetryInversion.isolation.modelFetches === 3 &&
      refreshRetryInversion.isolation.barrier === 0 &&
      refreshRetryInversion.isolation.reconnectTimer === null &&
      refreshRetryInversion.isolation.queued === 0 &&
      refreshRetryInversion.isolation.flushing === false &&
      refreshRetryInversion.isolation.restoredRev ===
        refreshRetryInversion.initialRev &&
      refreshRetryInversion.isolation.restoredText ===
        orderedRefresh.expected,
      JSON.stringify(refreshRetryInversion));

    console.log('\n[phone-width chrome]');
    await browser.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(180);
    const phoneChrome = await browser.eval(`(() => {
      const doc = document.querySelector('.doc-id').getBoundingClientRect();
      const actions = document.querySelector('.topbar-right').getBoundingClientRect();
      const buttons = [...document.querySelectorAll('.topbar-right button')].map((button) => ({
        id: button.id,
        left: button.getBoundingClientRect().left,
        right: button.getBoundingClientRect().right,
        clientWidth: button.clientWidth,
        scrollWidth: button.scrollWidth
      }));
      return {
        viewport: innerWidth,
        docRight: doc.right,
        actionsLeft: actions.left,
        actionsRight: actions.right,
        buttons
      };
    })()`);
    check('phone-width topbar controls remain legible, separate, and on screen',
      phoneChrome.docRight <= phoneChrome.actionsLeft + 0.5 &&
      phoneChrome.actionsRight <= phoneChrome.viewport &&
      phoneChrome.buttons.every((button) =>
        button.left >= phoneChrome.actionsLeft - 0.5 &&
        button.right <= phoneChrome.viewport &&
        button.clientWidth + 1 >= button.scrollWidth),
      JSON.stringify(phoneChrome));
    const compactRecovery = await browser.eval(`(() => {
      const base = JSON.parse(JSON.stringify(app.model));
      const target = base.paragraphs.find((p) => !p.table && p.text.length > 20);
      const local = target.text + ' [compact recovery must stay visible]';
      const el = document.querySelector('[data-pid="' + target.pid + '"]');
      el.focus();
      el.textContent = local;
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertText'
      }));
      const structural = JSON.parse(JSON.stringify(base));
      structural.paragraphs = structural.paragraphs.filter(
        (paragraph) => paragraph.pid !== target.pid);
      structural.count = structural.paragraphs.length;
      applyModel(structural);
      const rail = document.getElementById('rail');
      const toggle = document.getElementById('rail-toggle');
      const panel = document.getElementById('draft-recovery');
      const recovered = panel.querySelector('.draft-recovery-text');
      const rect = panel.getBoundingClientRect();
      const result = {
        text: recovered && recovered.value,
        expected: local,
        open: rail.dataset.open,
        hidden: panel.hidden,
        railHidden: rail.getAttribute('aria-hidden'),
        inert: rail.inert,
        expanded: toggle.getAttribute('aria-expanded'),
        badge: toggle.dataset.recovery,
        role: panel.getAttribute('role'),
        live: panel.getAttribute('aria-live'),
        visible: getComputedStyle(panel).display !== 'none' &&
          getComputedStyle(panel).visibility !== 'hidden' &&
          rect.left < innerWidth && rect.right > 0
      };
      applyModel(base);
      const dismiss = panel.querySelector(
        '.draft-recovery-actions button:last-child');
      if (dismiss) dismiss.click();
      setRailOpen(false);
      result.dismissed = panel.hidden && toggle.dataset.recovery === 'false';
      return result;
    })()`);
    check('compact recovery opens an accessible visible rail and retains the exact draft',
      compactRecovery.text === compactRecovery.expected &&
      compactRecovery.open === 'true' && !compactRecovery.hidden &&
      compactRecovery.railHidden === 'false' && !compactRecovery.inert &&
      compactRecovery.expanded === 'true' && compactRecovery.badge === 'true' &&
      compactRecovery.role === 'status' && compactRecovery.live === 'polite' &&
      compactRecovery.visible && compactRecovery.dismissed,
      JSON.stringify(compactRecovery));
    await browser.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(180);

    console.log('\n[formatting fidelity]');
    const colored = await browser.eval(`[...document.querySelectorAll('.para span[style*="color"]')].length`);
    check('colored runs render with color', colored >= 4, colored);
    const blue = await browser.eval(`[...document.querySelectorAll('.para span')].filter(s=>getComputedStyle(s).color==='rgb(0, 51, 204)').length`);
    check('the 0033CC audit-markup blue survives to the screen', blue >= 3, blue);
    const bold = await browser.eval(`[...document.querySelectorAll('.para span')].filter(s=>getComputedStyle(s).fontWeight==='700').length`);
    check('bold runs render bold', bold >= 1, bold);
    const italic = await browser.eval(`[...document.querySelectorAll('.para span')].filter(s=>getComputedStyle(s).fontStyle==='italic').length`);
    check('italic runs render italic', italic >= 1, italic);
    const hl = await browser.eval(`[...document.querySelectorAll('.para span')].filter(s=>{const b=getComputedStyle(s).backgroundColor;return b&&b!=='rgba(0, 0, 0, 0)';}).length`);
    check('highlighted runs render a background', hl >= 1, hl);

    console.log('\n[dark mode must not recolor the document]');
    const lightColors = await browser.eval(`JSON.stringify([...document.querySelectorAll('.para span[style*="color"]')].slice(0,12).map(s=>getComputedStyle(s).color))`);
    await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await sleep(250);
    const paperBg = await browser.eval(`getComputedStyle(document.getElementById('paper')).backgroundColor`);
    check('the sheet stays white in dark mode', paperBg === 'rgb(255, 255, 255)', paperBg);
    const chromeBg = await browser.eval(`getComputedStyle(document.body).backgroundColor`);
    check('but the chrome does go dark', chromeBg !== 'rgb(255, 255, 255)', chromeBg);
    const darkColors = await browser.eval(`JSON.stringify([...document.querySelectorAll('.para span[style*="color"]')].slice(0,12).map(s=>getComputedStyle(s).color))`);
    // The run colors are semantic (green add, pink delete, purple note). If the
    // theme could shift them, the markup would start meaning something else.
    check('authored run colors are byte-identical across themes', darkColors === lightColors);
    const bodyInk = await browser.eval(`getComputedStyle(document.querySelector('.para')).color`);
    check('default document ink stays dark on the white sheet',
      /rgb\(2[0-9], 2[0-9], 2[0-9]\)|rgb\(26, 26, 25\)/.test(bodyInk), bodyInk);
    await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await sleep(200);

    console.log('\n[quiet message composer]');
    const composerRest = await browser.eval(`(() => {
      const bar = document.querySelector('.bar');
      const style = getComputedStyle(bar);
      return {
        backdrop: style.backdropFilter || style.webkitBackdropFilter,
        border: style.borderTopColor,
        line: Number(getComputedStyle(bar, '::after').opacity)
      };
    })()`);
    check('the resting composer is translucent glass without an active line',
      /blur\(18px\)/.test(composerRest.backdrop) && composerRest.line === 0,
      JSON.stringify(composerRest));
    await browser.eval(`(document.getElementById('say').focus(), true)`);
    await sleep(240);
    const composerFocus = await browser.eval(`(() => {
      const bar = document.querySelector('.bar');
      return {
        border: getComputedStyle(bar).borderTopColor,
        line: Number(getComputedStyle(bar, '::after').opacity)
      };
    })()`);
    check('focus reveals one restrained soft-neon composer line',
      composerFocus.line > 0.6 && composerFocus.border !== composerRest.border,
      JSON.stringify({ rest: composerRest, focus: composerFocus }));
    const composerAgent = (await req('GET', '/api/agent')).body;
    const composerWatch = (await req('GET', '/api/watch')).body;
    check('focusing the composer starts neither model lane',
      composerAgent.running === false && composerWatch.enabled === false &&
      composerWatch.reviewer.running === false && composerWatch.active === null &&
      composerWatch.pending.length === 0,
      JSON.stringify({ agent: composerAgent, watch: composerWatch }));
    await browser.eval(`(document.getElementById('say').blur(), true)`);
    await sleep(220);

    console.log('\n[patched, not rebuilt]');
    // Tag every node so we can tell whether the SAME objects survive an edit.
    await browser.eval('[...document.querySelectorAll(".para")].forEach((e,i)=>e.__tag=i), true');
    const model = (await req('GET', '/api/doc')).body;
    const target = model.paragraphs.find((p) => p.text.length > 220 && !p.table);
    const phrase = target.text.slice(30, 52);

    const ed = await req('POST', '/api/edit', {
      who: 'viewer-test',
      op: { type: 'replace', pid: target.pid, find: phrase, replace: 'GLOWING_EDIT', why: 'render test', utterance: 'v1', expect_hash: target.hash },
    });
    check('edit accepted', ed.status === 200, ed.body.error);

    await browser.waitFor(`document.querySelector('[data-pid="${target.pid}"]').textContent.includes('GLOWING_EDIT')`, { timeout: 10000 });

    const render = await browser.eval('window.__lastRender');
    check('the DOM was PATCHED, not rebuilt', render && render.rebuilt === false, JSON.stringify(render));
    check('exactly one paragraph was patched', render && render.patched === 1, render && render.patched);
    check('patch was fast', render && render.ms < 100, render && Math.round(render.ms) + ' ms');

    const survived = await browser.eval('[...document.querySelectorAll(".para")].filter(e=>e.__tag!==undefined).length');
    check('all 333 nodes are the same objects as before', survived === 333, survived);
    const tagKept = await browser.eval(`document.querySelector('[data-pid="${target.pid}"]').__tag !== undefined`);
    check('even the edited node was reused, not replaced', tagKept === true);

    console.log('\n[the glow lands on exactly the changed span]');
    const markText = await browser.eval(`(document.querySelector('[data-pid="${target.pid}"] mark.changed')||{}).textContent`);
    check('a mark wraps the change', !!markText, JSON.stringify(markText));
    check('the mark covers exactly the new text, no more', markText === 'GLOWING_EDIT', JSON.stringify(markText));
    const marks = await browser.eval('document.querySelectorAll("mark.changed").length');
    check('only one span in the whole document is marked', marks === 1, marks);
    const touched = await browser.eval('document.querySelectorAll(".para.touched").length');
    check('only the edited paragraph gets the rail marker', touched === 1, touched);
    const trail = await browser.eval('document.querySelectorAll("#trail li").length');
    check('activity rail recorded it', trail >= 1, trail);
    // The server emits both `trail` and `edit` for one edit. Rendering both
    // produced two identical cards, which looked like the agent acted twice.
    check('one edit produces exactly one trail card, not two', trail === 1, trail);
    const trailTxt = await browser.eval('document.querySelector("#trail li").textContent');
    check('rail shows the why', /render test/.test(trailTxt || ''), JSON.stringify((trailTxt || '').slice(0, 70)));

    console.log('\n[direct typing]');
    await browser.eval(`(() => {
      window.__viewerFetch = window.fetch;
      window.__undoCalls = 0;
      window.__undoBodies = [];
      window.__undoResolvers = [];
      window.fetch = (...args) => {
        const url = new URL(args[0], location.href);
        if (url.pathname === '/api/undo') {
          window.__undoCalls++;
          try {
            window.__undoBodies.push(JSON.parse((args[1] || {}).body || '{}'));
          } catch (_) {
            window.__undoBodies.push(null);
          }
          return new Promise((resolve) => {
            window.__undoResolvers.push(() => resolve({
              json: () => Promise.resolve({ undone: false })
            }));
          });
        }
        return window.__viewerFetch(...args);
      };
      const button = document.getElementById('undo');
      button.click();
      button.click();
      return true;
    })()`);
    await sleep(80);
    const pendingUndo = await browser.eval(`({
      calls: window.__undoCalls,
      disabled: document.getElementById('undo').disabled,
      token: window.__undoBodies[0] &&
        window.__undoBodies[0].expect_document_token,
      modelToken: window.__scribe.model &&
        window.__scribe.model.document_token
    })`);
    check('rapid Undo clicks submit only one operation while it is pending',
      pendingUndo.calls === 1 && pendingUndo.disabled,
      JSON.stringify(pendingUndo));
    check('Undo binds the request to the visible document token',
      typeof pendingUndo.token === 'string' &&
      pendingUndo.token === pendingUndo.modelToken,
      JSON.stringify(pendingUndo));
    await browser.eval(`(() => {
      for (const resolve of window.__undoResolvers) resolve();
      return true;
    })()`);
    await sleep(80);
    await browser.eval(`(() => {
      window.fetch = (...args) => {
        const url = new URL(args[0], location.href);
        if (url.pathname === '/api/undo') {
          return Promise.reject(new TypeError('simulated Undo transport failure'));
        }
        return window.__viewerFetch(...args);
      };
      document.getElementById('undo').click();
      return true;
    })()`);
    await sleep(120);
    const failedUndo = await browser.eval(`(() => {
      const revision = document.getElementById('rev');
      return {
        enabled: !document.getElementById('undo').disabled,
        text: revision.textContent,
        title: revision.title,
        error: revision.classList.contains('edit-error'),
        errors: [...(window.__errs || [])]
      };
    })()`);
    check('a failed Undo is explained and the control becomes retryable',
      failedUndo.enabled && failedUndo.error &&
      /undo failed/i.test(failedUndo.text || '') &&
      /unavailable|failure/i.test(failedUndo.title || ''),
      JSON.stringify(failedUndo));
    check('a failed Undo produces no unhandled browser error',
      failedUndo.errors.length === 0, JSON.stringify(failedUndo.errors));

    const acknowledgedUndo = await browser.eval(`(async () => {
      setEditStatus(null);
      window.__SCRIBE_HTTP_TIMEOUT_MS = 45;
      window.fetch = (...args) => {
        const url = new URL(String(args[0]), location.href);
        if (url.pathname !== '/api/undo') return window.__viewerFetch(...args);
        const init = args[1] || {};
        return new Promise((_resolve, reject) => {
          const abort = () => reject(new DOMException('aborted', 'AbortError'));
          if (init.signal && init.signal.aborted) abort();
          else if (init.signal) init.signal.addEventListener('abort', abort, { once: true });
        });
      };
      document.getElementById('undo').click();
      await new Promise((resolve) => setTimeout(resolve, 8));
      window.__feed('trail', {
        id: 'viewer-lost-undo-ack',
        at: new Date().toISOString(),
        op: 'undo',
        who: 'human',
        summary: 'undid the most recent document operation'
      });
      for (let i = 0; i < 80 && document.getElementById('undo').disabled; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const revision = document.getElementById('rev');
      const result = {
        enabled: !document.getElementById('undo').disabled,
        error: revision.classList.contains('edit-error'),
        status: revision.textContent,
        errors: [...(window.__errs || [])]
      };
      delete window.__SCRIBE_HTTP_TIMEOUT_MS;
      return result;
    })()`);
    check('a matching live trail acknowledgement reconciles a lost Undo response',
      acknowledgedUndo.enabled && !acknowledgedUndo.error &&
      !/undo failed/i.test(acknowledgedUndo.status || '') &&
      acknowledgedUndo.errors.length === 0,
      JSON.stringify(acknowledgedUndo));

    await browser.eval(`(() => {
      window.__pauseCalls = 0;
      window.__pauseResolvers = [];
      window.fetch = (...args) => {
        const url = new URL(args[0], location.href);
        if (url.pathname === '/api/pause') {
          window.__pauseCalls++;
          return new Promise((resolve) => {
            window.__pauseResolvers.push(() => resolve({
              json: () => Promise.resolve({ paused: true })
            }));
          });
        }
        return window.__viewerFetch(...args);
      };
      const button = document.getElementById('pause');
      button.click();
      button.click();
      return true;
    })()`);
    await sleep(80);
    const pendingPause = await browser.eval(`({
      calls: window.__pauseCalls,
      disabled: document.getElementById('pause').disabled
    })`);
    check('rapid Pause actions submit only one operation while it is pending',
      pendingPause.calls === 1 && pendingPause.disabled,
      JSON.stringify(pendingPause));
    await browser.eval(`(() => {
      for (const resolve of window.__pauseResolvers) resolve();
      return true;
    })()`);
    await sleep(80);
    const eventlessPause = await browser.eval(`({
      paused: window.__scribe.paused,
      scrim: !document.getElementById('scrim').hidden,
      label: document.getElementById('pause').textContent,
      enabled: !document.getElementById('pause').disabled
    })`);
    check('an acknowledged Pause response reconciles the UI even without its live event',
      eventlessPause.paused && eventlessPause.scrim &&
      eventlessPause.label === 'resume' && eventlessPause.enabled,
      JSON.stringify(eventlessPause));
    await browser.eval(`(() => {
      setPaused(false);
      window.fetch = (...args) => {
        const url = new URL(args[0], location.href);
        if (url.pathname === '/api/pause') {
          return Promise.reject(new TypeError('simulated Pause transport failure'));
        }
        return window.__viewerFetch(...args);
      };
      document.getElementById('pause').click();
      return true;
    })()`);
    await sleep(120);
    const failedPause = await browser.eval(`(() => {
      const revision = document.getElementById('rev');
      return {
        enabled: !document.getElementById('pause').disabled,
        paused: window.__scribe.paused,
        text: revision.textContent,
        title: revision.title,
        error: revision.classList.contains('edit-error'),
        errors: [...(window.__errs || [])]
      };
    })()`);
    check('a failed Pause is explained without changing the editor state',
      failedPause.enabled && !failedPause.paused && failedPause.error &&
      /pause failed/i.test(failedPause.text || '') &&
      /unavailable|failure/i.test(failedPause.title || ''),
      JSON.stringify(failedPause));
    check('a failed Pause produces no unhandled browser error',
      failedPause.errors.length === 0, JSON.stringify(failedPause.errors));
    await browser.eval(`(() => {
      window.fetch = window.__viewerFetch;
      delete window.__viewerFetch;
      delete window.__undoCalls;
      delete window.__undoResolvers;
      delete window.__pauseCalls;
      delete window.__pauseResolvers;
      window.__errs = [];
      setEditStatus(null);
      return true;
    })()`);

    const beforeTyped = (await req('GET', '/api/doc')).body;
    const typedTarget = beforeTyped.paragraphs.find((p) =>
      !p.table && p.text.length > 60 && p.runs.length > 2 && p.runs.some((r) => r.color));
    const typedBefore = typedTarget.text;
    const typedAfter = typedBefore + ' [typed in place]';
    const typedStyles = JSON.stringify(typedTarget.runs.map((r) => {
      const x = { ...r }; delete x.text; return x;
    }));
    const revBeforeTyped = (await req('GET', '/api/health')).body.rev;

    console.log('\n[structural refresh while typing]');
    const rebuiltDraft = await browser.eval(`(() => {
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const base = clone(window.__scribe.model);
      const paragraph = base.paragraphs.find((p) =>
        p.pid === ${JSON.stringify(typedTarget.pid)});
      const local = paragraph.text + ' LOCAL DRAFT SURVIVES REBUILD';
      const el = document.querySelector('[data-pid="' + paragraph.pid + '"]');
      el.focus();
      el.textContent = local;
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertText', data: ' LOCAL DRAFT SURVIVES REBUILD'
      }));

      const structural = clone(base);
      const at = structural.paragraphs.findIndex((p) => p.pid === paragraph.pid);
      const inserted = clone(structural.paragraphs.find((p) => !p.table));
      inserted.pid = 'viewer-structural-refresh-safe';
      inserted.text = 'A structurally inserted paragraph.';
      inserted.hash = 'viewer-structural-refresh-safe-hash';
      inserted.runs = [{ text: inserted.text }];
      structural.paragraphs.splice(at + 1, 0, inserted);
      structural.count = structural.paragraphs.length;
      applyModel(structural);

      const shown = document.querySelector('[data-pid="' + paragraph.pid + '"]');
      const edit = directEdits.get(paragraph.pid);
      if (edit && edit.saveTimer) clearTimeout(edit.saveTimer);
      const result = {
        text: shown && shown.textContent,
        editable: shown && shown.getAttribute('contenteditable'),
        editing: shown && shown.classList.contains('editing'),
        dirty: shown && shown.classList.contains('dirty'),
        focused: document.activeElement === shown,
        staged: !!edit
      };
      if (shown) {
        shown.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape', bubbles: true, cancelable: true
        }));
      }
      applyModel(base);
      return { ...result, expected: local };
    })()`);
    check('a structural model rebuild preserves and restages the in-progress direct edit',
      rebuiltDraft.text === rebuiltDraft.expected &&
      rebuiltDraft.editable === 'plaintext-only' &&
      rebuiltDraft.editing && rebuiltDraft.dirty &&
      rebuiltDraft.focused && rebuiltDraft.staged,
      JSON.stringify(rebuiltDraft));

    const cleanRebuiltDraft = await browser.eval(`(() => {
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const base = clone(window.__scribe.model);
      const paragraph = base.paragraphs.find((p) =>
        p.pid === ${JSON.stringify(typedTarget.pid)});
      const el = document.querySelector('[data-pid="' + paragraph.pid + '"]');
      el.focus();
      beginDirectEdit(el);
      const activeBefore = document.activeElement === el;
      const stagedBefore = directEdits.has(paragraph.pid);
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);

      const structural = clone(base);
      const at = structural.paragraphs.findIndex((p) => p.pid === paragraph.pid);
      const authoritative = structural.paragraphs[at];
      authoritative.text += ' EXTERNAL STRUCTURAL CHANGE';
      authoritative.hash = 'viewer-clean-authoritative-hash';
      authoritative.runs = [{ text: authoritative.text }];
      const inserted = clone(structural.paragraphs.find((p) => !p.table));
      inserted.pid = 'viewer-clean-structural-refresh';
      inserted.text = 'Clean-focus structural sentinel.';
      inserted.hash = 'viewer-clean-structural-hash';
      inserted.runs = [{ text: inserted.text }];
      structural.paragraphs.splice(at + 1, 0, inserted);
      structural.count = structural.paragraphs.length;
      applyModel(structural);

      const shown = document.querySelector('[data-pid="' + paragraph.pid + '"]');
      const edit = directEdits.get(paragraph.pid);
      const result = {
        text: shown && shown.textContent,
        expected: authoritative.text,
        dirty: !!(edit && edit.dirty),
        conflict: !!(edit && edit.stagedConflict),
        hash: edit && edit.hash,
        expectedHash: authoritative.hash,
        focused: document.activeElement === shown,
        activeBefore,
        stagedBefore
      };
      if (shown) {
        shown.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape', bubbles: true, cancelable: true
        }));
      }
      applyModel(base);
      return result;
    })()`);
    check('a clean focused paragraph adopts an external structural refresh without a false conflict',
      cleanRebuiltDraft.text === cleanRebuiltDraft.expected &&
      !cleanRebuiltDraft.dirty && !cleanRebuiltDraft.conflict &&
      cleanRebuiltDraft.hash === cleanRebuiltDraft.expectedHash &&
      cleanRebuiltDraft.activeBefore && cleanRebuiltDraft.stagedBefore &&
      cleanRebuiltDraft.focused,
      JSON.stringify(cleanRebuiltDraft));

    const orphanedDraft = await browser.eval(`(() => {
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const base = clone(window.__scribe.model);
      const paragraph = base.paragraphs.find((p) =>
        p.pid === ${JSON.stringify(typedTarget.pid)});
      const local = paragraph.text + ' RECOVER THIS REMOVED PARAGRAPH DRAFT';
      const el = document.querySelector('[data-pid="' + paragraph.pid + '"]');
      el.focus();
      el.textContent = local;
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertText'
      }));

      const structural = clone(base);
      structural.paragraphs = structural.paragraphs.filter(
        (p) => p.pid !== paragraph.pid);
      structural.count = structural.paragraphs.length;
      applyModel(structural);
      const panel = document.getElementById('draft-recovery');
      const recovered = panel.querySelector('.draft-recovery-text');
      const result = {
        hidden: panel.hidden,
        text: recovered && recovered.value,
        expected: local,
        stored: app.recoveryDrafts.get(paragraph.pid) &&
          app.recoveryDrafts.get(paragraph.pid).text,
        status: document.getElementById('rev').textContent
      };
      applyModel(base);
      panel.querySelector('.draft-recovery-actions button:last-child').click();
      result.dismissed = panel.hidden && !app.recoveryDrafts.has(paragraph.pid);
      setEditStatus(null);
      return result;
    })()`);
    check('typing from a concurrently removed paragraph is visibly recoverable and dismissible',
      !orphanedDraft.hidden && orphanedDraft.text === orphanedDraft.expected &&
      orphanedDraft.stored === orphanedDraft.expected &&
      /typing preserved/i.test(orphanedDraft.status) &&
      orphanedDraft.dismissed,
      JSON.stringify(orphanedDraft));

    const staleRebuiltDraft = await browser.eval(`(async () => {
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const base = clone(window.__scribe.model);
      const paragraph = base.paragraphs.find((p) =>
        p.pid === ${JSON.stringify(typedTarget.pid)});
      const local = paragraph.text + ' LOCAL STALE DRAFT IS PRESERVED';
      const nativeFetch = window.fetch;
      let editCalls = 0;
      window.fetch = (input, init) => {
        const url = new URL(String(input), location.href);
        if (url.pathname === '/api/edit') {
          editCalls++;
          return Promise.reject(new TypeError('a stale structural draft must not be posted'));
        }
        return nativeFetch(input, init);
      };

      const el = document.querySelector('[data-pid="' + paragraph.pid + '"]');
      el.focus();
      el.textContent = local;
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertText', data: ' LOCAL STALE DRAFT IS PRESERVED'
      }));

      const structural = clone(base);
      const at = structural.paragraphs.findIndex((p) => p.pid === paragraph.pid);
      const authoritative = structural.paragraphs[at];
      authoritative.text += ' AUTHORITATIVE CONCURRENT CHANGE';
      authoritative.hash = 'viewer-authoritative-concurrent-hash';
      authoritative.runs = [{ text: authoritative.text }];
      const inserted = clone(structural.paragraphs.find((p) => !p.table));
      inserted.pid = 'viewer-structural-refresh-conflict';
      inserted.text = 'Another structurally inserted paragraph.';
      inserted.hash = 'viewer-structural-refresh-conflict-hash';
      inserted.runs = [{ text: inserted.text }];
      structural.paragraphs.splice(at + 1, 0, inserted);
      structural.count = structural.paragraphs.length;
      applyModel(structural);

      const shown = document.querySelector('[data-pid="' + paragraph.pid + '"]');
      if (shown) {
        shown.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', bubbles: true, cancelable: true
        }));
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      const revision = document.getElementById('rev');
      const result = {
        text: shown && shown.textContent,
        staged: directEdits.has(paragraph.pid),
        editCalls,
        status: revision.textContent,
        title: revision.title,
        expected: local
      };
      if (shown && directEdits.has(paragraph.pid)) {
        shown.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape', bubbles: true, cancelable: true
        }));
      }
      window.fetch = nativeFetch;
      applyModel(base);
      setEditStatus(null);
      return result;
    })()`);
    check('a stale-hash structural refresh preserves the draft without posting it as a blind overwrite',
      staleRebuiltDraft.text === staleRebuiltDraft.expected &&
      staleRebuiltDraft.staged && staleRebuiltDraft.editCalls === 0 &&
      /changed|conflict|preserv|copy/i.test(
        (staleRebuiltDraft.status || '') + ' ' + (staleRebuiltDraft.title || '')),
      JSON.stringify(staleRebuiltDraft));

    await browser.eval(`(() => {
      window.__emptyEditFetch = window.fetch;
      window.fetch = (...args) => {
        const url = new URL(args[0], location.href);
        if (url.pathname === '/api/edit') {
          return Promise.resolve({
            ok: false,
            status: 503,
            json: () => Promise.reject(new SyntaxError('empty response'))
          });
        }
        return window.__emptyEditFetch(...args);
      };
      const el = document.querySelector('[data-pid="${typedTarget.pid}"]');
      el.focus();
      el.textContent = ${JSON.stringify(typedBefore + ' MUST NOT DISAPPEAR')};
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertText', data: ' MUST NOT DISAPPEAR'
      }));
      el.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', bubbles: true, cancelable: true
      }));
      return true;
    })()`);
    await browser.waitFor(`/typing preserved/.test(document.getElementById('rev').textContent) &&
      document.querySelector('[data-pid="${typedTarget.pid}"]').textContent ===
        ${JSON.stringify(typedBefore + ' MUST NOT DISAPPEAR')} &&
      directEdits.has(${JSON.stringify(typedTarget.pid)})`, { timeout: 8000 });
    const emptyHttpEdit = await browser.eval(`({
      text: document.querySelector('[data-pid="${typedTarget.pid}"]').textContent,
      title: document.getElementById('rev').title,
      staged: directEdits.has(${JSON.stringify(typedTarget.pid)}),
      errors: [...(window.__errs || [])]
    })`);
    check('an empty HTTP 503 preserves the exact retryable paragraph draft',
      emptyHttpEdit.text === typedBefore + ' MUST NOT DISAPPEAR' &&
      emptyHttpEdit.staged &&
      /503|not confirm|failed/i.test(emptyHttpEdit.title || '') &&
      emptyHttpEdit.errors.length === 0,
      JSON.stringify(emptyHttpEdit));
    await browser.eval(`(() => {
      window.fetch = window.__emptyEditFetch;
      delete window.__emptyEditFetch;
      window.__errs = [];
      const el = document.querySelector('[data-pid="${typedTarget.pid}"]');
      if (el && directEdits.has(${JSON.stringify(typedTarget.pid)})) {
        el.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape', bubbles: true, cancelable: true
        }));
      } else {
        setEditStatus(null);
      }
      return true;
    })()`);
    const focusOwnership = await browser.eval(`(() => {
      directEdits.set('__older-save__', { dirty: true });
      directEdits.set('__current-paragraph__', { dirty: true });
      directEdits.delete('__older-save__');
      setWritingFocus(false);
      const held = document.body.dataset.writing;
      directEdits.delete('__current-paragraph__');
      setWritingFocus(false);
      return { held, released: document.body.dataset.writing };
    })()`);
    check('an older save cannot clear a newer paragraph’s writing focus',
      focusOwnership.held === 'true' && focusOwnership.released === 'false',
      JSON.stringify(focusOwnership));

    const editableMode = await browser.eval(
      `document.querySelector('[data-pid="${typedTarget.pid}"]').getAttribute('contenteditable')`);
    check('every existing paragraph exposes basic plaintext editing',
      editableMode === 'plaintext-only', editableMode);

    const editState = await browser.eval(`(() => {
      const el = document.querySelector('[data-pid="${typedTarget.pid}"]');
      el.focus();
      el.textContent = ${JSON.stringify(typedAfter)};
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertText', data: ' [typed in place]'
      }));
      return {
        editing: el.classList.contains('editing'),
        dirty: el.classList.contains('dirty'),
        status: document.getElementById('rev').textContent
      };
    })()`);
    check('focus and typing gives a restrained local edit state',
      editState.editing && editState.dirty && editState.status === 'editing',
      JSON.stringify(editState));
    await sleep(260);
    const quietSurfaces = await browser.eval(`(() => {
      const rail = getComputedStyle(document.getElementById('rail'));
      const bar = getComputedStyle(document.getElementById('bar'));
      return {
        rail: { opacity: Number(rail.opacity), filter: rail.filter },
        bar: { opacity: Number(bar.opacity), filter: bar.filter }
      };
    })()`);
    check('floating agent surfaces softly recede while the caret is in the paper',
      quietSurfaces.rail.opacity < 0.4 &&
      quietSurfaces.bar.opacity < 0.45 &&
      /saturate\(0\.58\)/.test(quietSurfaces.rail.filter) &&
      /saturate\(0\.58\)/.test(quietSurfaces.bar.filter),
      JSON.stringify(quietSurfaces));

    await browser.eval(`document.querySelector('[data-pid="${typedTarget.pid}"]')
      .dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', bubbles: true, cancelable: true
      })), true`);
    await browser.waitFor(`document.querySelector('[data-pid="${typedTarget.pid}"]').dataset.hash !==
      ${JSON.stringify(typedTarget.hash)} &&
      !document.querySelector('[data-pid="${typedTarget.pid}"]').classList.contains('saving')`, { timeout: 12000 });
    await sleep(260);
    check('floating agent surfaces return fully when paragraph editing ends',
      await browser.eval(`Number(getComputedStyle(document.getElementById('rail')).opacity) === 1 &&
        Number(getComputedStyle(document.getElementById('bar')).opacity) === 1`));

    const afterTyped = (await req('GET', '/api/doc')).body.paragraphs.find((p) => p.pid === typedTarget.pid);
    check('Enter saves exactly what was typed', afterTyped.text === typedAfter,
      JSON.stringify(afterTyped.text.slice(-36)));
    check('direct typing advances the ordinary revision',
      (await req('GET', '/api/health')).body.rev === revBeforeTyped + 1);
    check('the paragraph run structure survives browser editing',
      afterTyped.runs.length === typedTarget.runs.length,
      `${typedTarget.runs.length} -> ${afterTyped.runs.length}`);
    const afterTypedStyles = JSON.stringify(afterTyped.runs.map((r) => {
      const x = { ...r }; delete x.text; return x;
    }));
    check('the paragraph formatting survives browser editing',
      afterTypedStyles === typedStyles);
    const typedTrail = await browser.eval(`document.querySelector('#trail li').textContent`);
    check('direct typing is visible in activity',
      /typed in paragraph/.test(typedTrail || '') && /typed directly/.test(typedTrail || ''),
      JSON.stringify((typedTrail || '').slice(0, 90)));

    const undoTyped = await req('POST', '/api/undo');
    check('direct typing is one normal undo step', undoTyped.status === 200, undoTyped.body.error);
    await browser.waitFor(`document.querySelector('[data-pid="${typedTarget.pid}"]').textContent ===
      ${JSON.stringify(typedBefore)}`, { timeout: 10000 });

    const autoText = typedBefore + ' [autosaved while typing]';
    await browser.eval(`(() => {
      const el = document.querySelector('[data-pid="${typedTarget.pid}"]');
      el.focus();
      el.textContent = ${JSON.stringify(autoText)};
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    })(), true`);
    await browser.waitFor(`window.__scribe.model.paragraphs.find(
      p => p.pid === ${JSON.stringify(typedTarget.pid)}).text === ${JSON.stringify(autoText)}`, { timeout: 12000 });
    check('a short typing pause saves to the document without Enter or click-away',
      (await req('GET', '/api/doc')).body.paragraphs.find((p) => p.pid === typedTarget.pid).text === autoText);
    check('autosave restores the caret so typing can continue',
      await browser.eval(`(() => {
        const el = document.querySelector('[data-pid="${typedTarget.pid}"]');
        return document.activeElement === el && el.isContentEditable &&
          el.classList.contains('editing');
      })()`) === true);
    await browser.eval(`document.querySelector('[data-pid="${typedTarget.pid}"]')
      .dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', bubbles: true, cancelable: true
      })), true`);
    const undoAuto = await req('POST', '/api/undo');
    check('the aggressive autosave remains one ordinary undo step',
      undoAuto.status === 200, undoAuto.body.error);
    await browser.waitFor(`document.querySelector('[data-pid="${typedTarget.pid}"]').textContent ===
      ${JSON.stringify(typedBefore)}`, { timeout: 10000 });

    const revBeforeCancel = (await req('GET', '/api/health')).body.rev;
    const cancelled = await browser.eval(`(() => {
      const el = document.querySelector('[data-pid="${typedTarget.pid}"]');
      el.focus();
      el.textContent = ${JSON.stringify(typedBefore + ' SHOULD NOT SAVE')};
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      el.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', bubbles: true, cancelable: true
      }));
      return { text: el.textContent, editing: el.classList.contains('editing') };
    })()`);
    await sleep(150);
    check('Escape restores the paragraph without saving',
      cancelled.text === typedBefore && cancelled.editing === false,
      JSON.stringify(cancelled));
    check('cancelling does not advance the revision',
      (await req('GET', '/api/health')).body.rev === revBeforeCancel);

    await browser.eval(`(() => {
      const el = document.querySelector('[data-pid="${typedTarget.pid}"]');
      el.focus();
      el.dispatchEvent(new KeyboardEvent('keydown', {
        key: ' ', bubbles: true, cancelable: true
      }));
      el.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', bubbles: true, cancelable: true
      }));
    })(), true`);
    await sleep(120);
    check('space at the caret does not trigger the global pause shortcut',
      (await req('GET', '/api/health')).body.paused === false);

    console.log('\n[paragraph boundary merge]');
    const boundaryModel = (await req('GET', '/api/doc')).body;
    const boundaryIndex = boundaryModel.paragraphs.findIndex((p, index, all) => {
      const next = all[index + 1];
      return next && !p.table && !next.table &&
        p.pid !== typedTarget.pid && next.pid !== typedTarget.pid &&
        p.text.length > 30 && p.text.length < 700 &&
        next.text.length > 30 && next.text.length < 700;
    });
    const boundaryFirst = boundaryModel.paragraphs[boundaryIndex];
    const boundarySecond = boundaryModel.paragraphs[boundaryIndex + 1];
    const boundaryCount = boundaryModel.paragraphs.length;

    console.log('\n[document ownership tokens]');
    const ownershipTokens = await browser.eval(`(async () => {
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const canonical = clone(app.model);
      const nativeFetch = window.fetch;
      const setToken = (model, token) => {
        if (token == null) delete model.document_token;
        else model.document_token = token;
        return model;
      };
      const validation = {
        omitted: validDocumentModel(setToken(clone(canonical), null)),
        present: validDocumentModel(
          setToken(clone(canonical), 'viewer-valid-document-token')),
        emptyRefused: !validDocumentModel(setToken(clone(canonical), '')),
        scalarRefused: !validDocumentModel(
          setToken(clone(canonical), 17))
      };

      async function directRun(capturedToken, laterToken, suffix) {
        const capturedModel = setToken(clone(canonical), capturedToken);
        app.model = capturedModel;
        app.documentToken = capturedToken;
        const paragraph = capturedModel.paragraphs.find(
          (p) => p.pid === ${JSON.stringify(typedTarget.pid)});
        const el = document.querySelector('[data-pid="' + paragraph.pid + '"]');
        if (directEdits.has(paragraph.pid)) cancelDirectEdit(el);
        fillPara(el, paragraph);
        beginDirectEdit(el);
        const edit = directEdits.get(paragraph.pid);
        const text = paragraph.text + suffix;
        el.textContent = text;
        edit.dirty = true;
        clearTimeout(edit.saveTimer);

        const laterModel = setToken(clone(capturedModel), laterToken);
        app.model = laterModel;
        app.documentToken = laterToken;
        let sent = null;
        window.fetch = (input, init = {}) => {
          const url = new URL(String(input), location.href);
          if (url.pathname === '/api/edit') {
            const body = JSON.parse(init.body || '{}');
            sent = body.op;
            return Promise.resolve(new Response(JSON.stringify({
              ok: true,
              rev: app.rev,
              result: {
                pid: paragraph.pid,
                after: text,
                hash: 'viewer-token-save-hash',
                start: paragraph.text.length,
                end: text.length
              }
            }), {
              status: 200,
              headers: { 'content-type': 'application/json' }
            }));
          }
          return nativeFetch(input, init);
        };
        const result = await saveDirectEdit(el);
        window.fetch = nativeFetch;
        fillPara(el, laterModel.paragraphs.find(
          (p) => p.pid === paragraph.pid));
        return {
          saved: result.saved,
          sent,
          captured: edit.documentToken,
          later: app.model && app.model.document_token
        };
      }

      async function mergeRun(capturedToken, laterToken) {
        const capturedModel = setToken(clone(canonical), capturedToken);
        app.model = capturedModel;
        app.documentToken = capturedToken;
        const first = capturedModel.paragraphs.find(
          (p) => p.pid === ${JSON.stringify(boundaryFirst.pid)});
        const second = capturedModel.paragraphs.find(
          (p) => p.pid === ${JSON.stringify(boundarySecond.pid)});
        const firstEl = document.querySelector('[data-pid="' + first.pid + '"]');
        const secondEl = document.querySelector('[data-pid="' + second.pid + '"]');
        for (const el of [firstEl, secondEl]) {
          if (directEdits.has(el.dataset.pid)) cancelDirectEdit(el);
        }
        fillPara(firstEl, first);
        fillPara(secondEl, second);
        secondEl.focus();
        beginDirectEdit(secondEl);
        const localDraft = second.text +
          ' [ownership-token merge draft]';
        secondEl.textContent = localDraft;
        secondEl.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText'
        }));
        const stagedEdit = directEdits.get(second.pid);
        if (stagedEdit) clearTimeout(stagedEdit.saveTimer);
        const range = document.createRange();
        range.selectNodeContents(secondEl);
        range.collapse(true);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);

        const laterModel = setToken(clone(capturedModel), laterToken);
        let sent = null;
        window.fetch = (input, init = {}) => {
          const url = new URL(String(input), location.href);
          if (url.pathname === '/api/edit') {
            const body = JSON.parse(init.body || '{}');
            if (body.op && body.op.type === 'merge') {
              sent = body.op;
              // The request body has already been serialized. Change the
              // current model now to prove the op retained captured ownership.
              app.model = laterModel;
              app.documentToken = laterToken;
              return Promise.resolve(new Response(JSON.stringify({
                error: 'ownership-token interceptor refusal'
              }), {
                status: 409,
                headers: { 'content-type': 'application/json' }
              }));
            }
          }
          if (url.pathname === '/api/doc') {
            return Promise.resolve(new Response(JSON.stringify(laterModel), {
              status: 200,
              headers: { 'content-type': 'application/json' }
            }));
          }
          return nativeFetch(input, init);
        };
        await mergeParagraphsAtBoundary({
          firstPid: first.pid,
          secondPid: second.pid,
          firstEl,
          secondEl
        }, secondEl);
        window.fetch = nativeFetch;
        const recovery = [...app.recoveryDrafts.entries()].find(([, draft]) =>
          draft.detached && draft.pid === second.pid &&
          draft.text === localDraft);
        for (const el of [firstEl, secondEl]) {
          if (directEdits.has(el.dataset.pid)) cancelDirectEdit(el);
        }
        setEditStatus(null);
        const result = {
          sent,
          later: app.model && app.model.document_token,
          merging: !!paragraphMerge,
          expectedDraft: localDraft,
          recoveredText: recovery && recovery[1].text,
          recoverySource: recovery && recovery[1].sourcePath
        };
        if (recovery) app.recoveryDrafts.delete(recovery[0]);
        renderRecoveryDrafts();
        return result;
      }

      const directCaptured = await directRun(
        'viewer-direct-original-token',
        'viewer-direct-later-token',
        ' [token capture]');
      const directOmitted = await directRun(
        null,
        'viewer-direct-added-later',
        ' [token omission]');
      const mergeCaptured = await mergeRun(
        'viewer-merge-original-token',
        'viewer-merge-later-token');
      const mergeOmitted = await mergeRun(
        null,
        'viewer-merge-added-later');

      window.fetch = nativeFetch;
      app.model = canonical;
      app.documentToken = canonical.document_token || null;
      for (const pid of [
        ${JSON.stringify(typedTarget.pid)},
        ${JSON.stringify(boundaryFirst.pid)},
        ${JSON.stringify(boundarySecond.pid)}
      ]) {
        const paragraph = canonical.paragraphs.find((p) => p.pid === pid);
        const el = document.querySelector('[data-pid="' + pid + '"]');
        if (el && paragraph) fillPara(el, paragraph);
      }
      setEditStatus(null);
      return {
        validation,
        directCaptured,
        directOmitted,
        mergeCaptured,
        mergeOmitted
      };
    })()`);
    check('document models accept an omitted or nonempty ownership token only',
      ownershipTokens.validation.omitted &&
      ownershipTokens.validation.present &&
      ownershipTokens.validation.emptyRefused &&
      ownershipTokens.validation.scalarRefused,
      JSON.stringify(ownershipTokens.validation));
    check('set_text sends the token captured when editing began, not a later model token',
      ownershipTokens.directCaptured.saved &&
      ownershipTokens.directCaptured.captured ===
        'viewer-direct-original-token' &&
      ownershipTokens.directCaptured.later ===
        'viewer-direct-later-token' &&
      ownershipTokens.directCaptured.sent.expect_document_token ===
        'viewer-direct-original-token',
      JSON.stringify(ownershipTokens.directCaptured));
    check('set_text remains compatible with models that omit document_token',
      ownershipTokens.directOmitted.saved &&
      !Object.prototype.hasOwnProperty.call(
        ownershipTokens.directOmitted.sent, 'expect_document_token'),
      JSON.stringify(ownershipTokens.directOmitted));
    check('merge sends its captured token even if app.model changes during dispatch',
      !ownershipTokens.mergeCaptured.merging &&
      ownershipTokens.mergeCaptured.later === 'viewer-merge-later-token' &&
      ownershipTokens.mergeCaptured.sent.expect_document_token ===
        'viewer-merge-original-token' &&
      ownershipTokens.mergeCaptured.recoveredText ===
        ownershipTokens.mergeCaptured.expectedDraft &&
      !!ownershipTokens.mergeCaptured.recoverySource,
      JSON.stringify(ownershipTokens.mergeCaptured));
    check('merge remains compatible with models that omit document_token',
      !ownershipTokens.mergeOmitted.merging &&
      !Object.prototype.hasOwnProperty.call(
        ownershipTokens.mergeOmitted.sent, 'expect_document_token'),
      JSON.stringify(ownershipTokens.mergeOmitted));

    const rotatedTokenDraft = await browser.eval(`(() => {
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const canonical = clone(app.model);
      const oldModel = clone(canonical);
      oldModel.document_token = 'viewer-draft-owner-old';
      app.model = oldModel;
      const paragraph = oldModel.paragraphs.find(
        (p) => p.pid === ${JSON.stringify(typedTarget.pid)});
      const el = document.querySelector('[data-pid="' + paragraph.pid + '"]');
      fillPara(el, paragraph);
      beginDirectEdit(el);
      const exact = '  ' + paragraph.text +
        '  [rotated ownership draft]  ';
      el.textContent = exact;
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertText'
      }));
      const staged = stageDirectEditsForRebuild();
      const newer = clone(oldModel);
      newer.document_token = 'viewer-draft-owner-new';
      buildAll(newer);
      app.model = newer;
      const restored = restoreDirectEditsAfterRebuild(staged, newer);
      const shown = document.querySelector('[data-pid="' + paragraph.pid + '"]');
      const edit = directEdits.get(paragraph.pid);
      const result = {
        exact,
        text: shown && shown.textContent,
        conflict: !!(edit && edit.stagedConflict),
        dirty: !!(edit && edit.dirty),
        token: edit && edit.documentToken,
        restored: restored.restored,
        conflicts: restored.conflicts,
        status: document.getElementById('rev').textContent,
        title: document.getElementById('rev').title
      };
      if (shown && edit) cancelDirectEdit(shown);
      buildAll(canonical);
      app.model = canonical;
      setEditStatus(null);
      return result;
    })()`);
    check('a dirty draft captured under an older nonempty token is preserved as a visible conflict',
      rotatedTokenDraft.text === rotatedTokenDraft.exact &&
      rotatedTokenDraft.conflict && rotatedTokenDraft.dirty &&
      rotatedTokenDraft.token === 'viewer-draft-owner-old' &&
      rotatedTokenDraft.restored === 1 &&
      rotatedTokenDraft.conflicts === 1 &&
      /ownership|preserv|not saved/i.test(
        rotatedTokenDraft.status + ' ' + rotatedTokenDraft.title),
      JSON.stringify(rotatedTokenDraft));

    const rotatedTokenSidecars = await browser.eval(`(() => {
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const canonical = clone(app.model);
      const oldModel = clone(canonical);
      oldModel.document_token = 'viewer-sidecar-owner-old';
      app.model = oldModel;
      const anchor = oldModel.paragraphs.find(
        (p) => p.pid === ${JSON.stringify(typedTarget.pid)});

      renderProposal({
        id: 'viewer-old-proposal',
        status: 'open',
        anchor_pid: anchor.pid,
        anchor_hash: anchor.hash,
        intent: 'Old document proposal',
        options: [
          { id: 'A', text: 'Old option A' },
          { id: 'B', text: 'Old option B' }
        ],
        grounding: []
      });
      renderAssist({
        id: 'viewer-old-assist',
        status: 'open',
        anchor_pid: anchor.pid,
        anchor_hash: anchor.hash,
        kind: 'caution',
        title: 'Old note',
        text: 'This belongs only to the old document.',
        grounding: []
      });
      renderContinuation({
        id: 'viewer-old-continuation',
        status: 'open',
        anchor_pid: anchor.pid,
        anchor_hash: anchor.hash,
        text: 'This suggested paragraph belongs only to the old document.',
        model: 'sonnet'
      });
      app.pendingAssist = { id: 'viewer-pending-old-assist' };
      app.pendingContinuation = { id: 'viewer-pending-old-continuation' };
      watch.changes.set(anchor.pid, {
        pid: anchor.pid,
        before: anchor.text,
        after: anchor.text + ' old'
      });
      watch.recentChanges = [{
        pid: anchor.pid,
        before: anchor.text,
        after: anchor.text + ' old',
        at: Date.now()
      }];
      watch.activeReviews.set('viewer-old-review', new Set([anchor.pid]));
      const formatEnabledBefore = formatting.enabled;
      formatting.enabled = true;
      formatting.status = 'reviewing';
      formatting.pendingWords = 640;
      formatting.pendingParagraphs = 5;
      formatting.active = {
        id: 'viewer-old-format-job',
        model: 'sonnet',
        provider: 'claude'
      };
      formatting.documentToken = oldModel.document_token;
      formattingToggleOwner = {
        desired: false,
        acknowledged: false,
        mutationSeq: formatting.mutationSeq,
        documentGeneration: app.documentGeneration,
        documentToken: oldModel.document_token
      };
      document.getElementById('format-toggle').disabled = true;
      refreshFormattingState();
      const formatMutationBefore = formatting.mutationSeq;
      trailEl.textContent = 'old document trail';
      trailSeen.add('viewer-old-trail');

      const newer = clone(oldModel);
      newer.document_token = 'viewer-sidecar-owner-new';
      const applied = applyModel(newer);
      const staleFormatAccepted = onFormattingEvent({
        kind: 'reviewing',
        id: 'viewer-old-format-job',
        enabled: true,
        pending_words: 640,
        pending_paragraphs: 5,
        document_token: oldModel.document_token
      });
      const result = {
        applied,
        token: app.model && app.model.document_token,
        proposal: !document.getElementById('proposal').hidden,
        assist: !!document.querySelector('.assist-note'),
        continuation: !!document.querySelector('.continuation-note'),
        openAssist: !!openAssist,
        openContinuation: !!openContinuation,
        pendingAssist: !!app.pendingAssist,
        pendingContinuation: !!app.pendingContinuation,
        watchChanges: watch.changes.size,
        recentChanges: watch.recentChanges.length,
        activeReviews: watch.activeReviews.size,
        formatActive: formatting.active,
        formatPendingWords: formatting.pendingWords,
        formatPendingParagraphs: formatting.pendingParagraphs,
        formatState: document.getElementById('format-toggle').dataset.state,
        formatDisabled: document.getElementById('format-toggle').disabled,
        formatToggleOwner: formattingToggleOwner,
        formatMutationAdvanced:
          formatting.mutationSeq > formatMutationBefore,
        staleFormatAccepted,
        trail: trailEl.textContent,
        trailSeen: trailSeen.size
      };
      applyModel(canonical);
      // Both token rotations above deliberately look like real ownership
      // changes and therefore arm a reconnect. This synthetic test has already
      // supplied its authoritative models; do not let that timer's real hello
      // retire the next synthetic scenario between its await and assertion.
      if (authoritativeReconnectTimer !== null) {
        clearTimeout(authoritativeReconnectTimer);
        authoritativeReconnectTimer = null;
      }
      formatting.enabled = formatEnabledBefore;
      formatting.status = formatEnabledBefore ? 'collecting' : 'off';
      refreshFormattingState();
      setEditStatus(null);
      return result;
    })()`);
    check('a token-only reconnect retires every old document note, suggestion, review, and trail',
      rotatedTokenSidecars.token === 'viewer-sidecar-owner-new' &&
      !rotatedTokenSidecars.proposal &&
      !rotatedTokenSidecars.assist &&
      !rotatedTokenSidecars.continuation &&
      !rotatedTokenSidecars.openAssist &&
      !rotatedTokenSidecars.openContinuation &&
      !rotatedTokenSidecars.pendingAssist &&
      !rotatedTokenSidecars.pendingContinuation &&
      rotatedTokenSidecars.watchChanges === 0 &&
      rotatedTokenSidecars.recentChanges === 0 &&
      rotatedTokenSidecars.activeReviews === 0 &&
      rotatedTokenSidecars.formatActive === null &&
      rotatedTokenSidecars.formatPendingWords === 0 &&
      rotatedTokenSidecars.formatPendingParagraphs === 0 &&
      rotatedTokenSidecars.formatState === 'collecting' &&
      rotatedTokenSidecars.formatDisabled === false &&
      rotatedTokenSidecars.formatToggleOwner === null &&
      rotatedTokenSidecars.formatMutationAdvanced &&
      rotatedTokenSidecars.staleFormatAccepted === false &&
      rotatedTokenSidecars.trail === '' &&
      rotatedTokenSidecars.trailSeen === 0,
      JSON.stringify(rotatedTokenSidecars));

    const rejectedTokenSave = await browser.eval(`(async () => {
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const canonical = clone(app.model);
      const oldModel = clone(canonical);
      oldModel.document_token = 'viewer-save-owner-old';
      const newer = clone(oldModel);
      newer.document_token = 'viewer-save-owner-new';
      if (authoritativeReconnectTimer !== null) {
        clearTimeout(authoritativeReconnectTimer);
        authoritativeReconnectTimer = null;
      }
      app.model = oldModel;
      const paragraph = oldModel.paragraphs.find(
        (p) => p.pid === ${JSON.stringify(typedTarget.pid)});
      const el = document.querySelector('[data-pid="' + paragraph.pid + '"]');
      fillPara(el, paragraph);
      beginDirectEdit(el);
      const exact = paragraph.text + ' [copy-only after token refusal]';
      el.textContent = exact;
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertText'
      }));
      const edit = directEdits.get(paragraph.pid);
      if (edit) clearTimeout(edit.saveTimer);

      const nativeFetch = window.fetch;
      window.fetch = (input, init = {}) => {
        const url = new URL(String(input), location.href);
        if (url.pathname === '/api/edit') {
          return Promise.resolve(new Response(JSON.stringify({
            error: 'document token changed'
          }), {
            status: 409,
            headers: { 'content-type': 'application/json' }
          }));
        }
        if (url.pathname === '/api/doc') {
          return Promise.resolve(new Response(JSON.stringify(newer), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }));
        }
        return nativeFetch(input, init);
      };
      const saved = await saveDirectEdit(el);
      window.fetch = nativeFetch;
      if (authoritativeReconnectTimer !== null) {
        clearTimeout(authoritativeReconnectTimer);
        authoritativeReconnectTimer = null;
      }
      const recovery = [...app.recoveryDrafts.entries()].find(([, draft]) =>
        draft.detached && draft.pid === paragraph.pid &&
        draft.text === exact);
      const shown = document.querySelector('[data-pid="' + paragraph.pid + '"]');
      const result = {
        saved,
        exact,
        recoveredText: recovery && recovery[1].text,
        recoverySource: recovery && recovery[1].sourcePath,
        staged: directEdits.has(paragraph.pid),
        shown: shown && shown.textContent,
        authoritative: newer.paragraphs.find(
          (p) => p.pid === paragraph.pid).text
      };
      if (recovery) app.recoveryDrafts.delete(recovery[0]);
      renderRecoveryDrafts();
      buildAll(canonical);
      app.model = canonical;
      setEditStatus(null);
      return result;
    })()`);
    check('a token-refused save becomes detached copy-only recovery, never a copied-pid edit',
      rejectedTokenSave.saved.saved === false &&
      rejectedTokenSave.saved.ownershipChanged === true &&
      rejectedTokenSave.recoveredText === rejectedTokenSave.exact &&
      !!rejectedTokenSave.recoverySource &&
      !rejectedTokenSave.staged &&
      rejectedTokenSave.shown === rejectedTokenSave.authoritative,
      JSON.stringify(rejectedTokenSave));

    const openedDuringFailedSave = await browser.eval(`(async () => {
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const canonical = clone(app.model);
      const oldModel = clone(canonical);
      oldModel.document_token = 'viewer-inflight-save-owner';
      app.model = oldModel;
      const paragraph = oldModel.paragraphs.find(
        (p) => p.pid === ${JSON.stringify(typedTarget.pid)});
      const el = document.querySelector('[data-pid="' + paragraph.pid + '"]');
      fillPara(el, paragraph);
      beginDirectEdit(el);
      const exact = '  ' + paragraph.text +
        '  [in-flight save from previous document]  ';
      el.textContent = exact;
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertText'
      }));
      const edit = directEdits.get(paragraph.pid);
      if (edit) clearTimeout(edit.saveTimer);

      const nativeFetch = window.fetch;
      const nativeConnect = connect;
      let releaseEdit = null;
      let editCalls = 0;
      let docCalls = 0;
      connect = () => ({ close() {} });
      window.fetch = (input, init = {}) => {
        const url = new URL(String(input), location.href);
        if (url.pathname === '/api/edit') {
          editCalls++;
          return new Promise((resolve) => {
            releaseEdit = () => resolve(new Response(JSON.stringify({
              error: 'save failed after document opened'
            }), {
              status: 409,
              headers: { 'content-type': 'application/json' }
            }));
          });
        }
        if (url.pathname === '/api/doc') {
          docCalls++;
          return Promise.resolve(new Response('', { status: 503 }));
        }
        return nativeFetch(input, init);
      };

      const pendingSave = saveDirectEdit(el);
      for (let i = 0; i < 100 && !releaseEdit; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const switchedPath = oldModel.path + '.inflight-copy.docx';
      enqueue('opened', {
        path: switchedPath,
        rev: Number(oldModel.rev || 0) + 1
      });
      for (let i = 0; i < 100 &&
           (app.model !== null || app.flushing); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const retiredBeforeFailure =
        app.model === null && app.documentPath === switchedPath;
      releaseEdit();
      let saved = null;
      let thrown = null;
      try {
        saved = await pendingSave;
      } catch (error) {
        thrown = error && (error.message || String(error));
      }
      window.fetch = nativeFetch;
      connect = nativeConnect;
      if (authoritativeReconnectTimer !== null) {
        clearTimeout(authoritativeReconnectTimer);
        authoritativeReconnectTimer = null;
      }

      const recovery = [...app.recoveryDrafts.entries()].find(([, draft]) =>
        draft.detached && draft.pid === paragraph.pid &&
        draft.text === exact);
      const recoveryItem = recovery && [...document.querySelectorAll(
        '.draft-recovery-item[data-detached="true"]')].find((item) =>
          item.querySelector('.draft-recovery-text') &&
          item.querySelector('.draft-recovery-text').value === exact);
      const result = {
        saved,
        thrown,
        exact,
        retiredBeforeFailure,
        editCalls,
        docCalls,
        recoveredText: recovery && recovery[1].text,
        recoverySource: recovery && recovery[1].sourcePath,
        expectedSource: oldModel.path,
        copyOnly: recoveryItem &&
          recoveryItem.querySelector('.draft-recovery-text').readOnly,
        staged: directEdits.has(paragraph.pid),
        activeModel: app.model,
        status: document.getElementById('rev').textContent
      };
      if (recovery) app.recoveryDrafts.delete(recovery[0]);
      renderRecoveryDrafts();
      buildAll(canonical);
      app.model = canonical;
      app.documentToken = canonical.document_token || null;
      app.rev = canonical.rev;
      setDocName(canonical.path);
      setEditStatus(null);
      return result;
    })()`);
    check('a failed in-flight save after opened keeps exact copy-only recovery without a model',
      openedDuringFailedSave.retiredBeforeFailure &&
      openedDuringFailedSave.editCalls === 1 &&
      openedDuringFailedSave.docCalls >= 2 &&
      !openedDuringFailedSave.thrown &&
      openedDuringFailedSave.saved.saved === false &&
      openedDuringFailedSave.saved.detached === true &&
      openedDuringFailedSave.saved.noAuthoritativeModel === true &&
      openedDuringFailedSave.recoveredText === openedDuringFailedSave.exact &&
      openedDuringFailedSave.recoverySource ===
        openedDuringFailedSave.expectedSource &&
      openedDuringFailedSave.copyOnly &&
      !openedDuringFailedSave.staged &&
      openedDuringFailedSave.activeModel === null &&
      /preserved|not saved/i.test(openedDuringFailedSave.status),
      JSON.stringify(openedDuringFailedSave));

    const emojiMergeOffsets = await browser.eval(`(() => {
      const text = '\u{1f600}tail';
      const range = resultHighlightRange({
        after: text,
        start: 1,
        end: 5
      });
      const paragraph = document.createElement('p');
      fillPara(paragraph, {
        pid: 'EMOJIMERGE',
        style: 'Normal',
        text,
        hash: 'emoji-merge-hash',
        runs: [{ text }]
      }, range);
      const mark = paragraph.querySelector('mark.changed');
      const before = mark && mark.previousElementSibling;
      return {
        start: range.start,
        end: range.end,
        before: before && before.textContent,
        marked: mark && mark.textContent,
        whole: paragraph.textContent
      };
    })()`);
    check('a real browser translates merge offsets without splitting an emoji surrogate pair',
      emojiMergeOffsets.start === 2 && emojiMergeOffsets.end === 6 &&
      emojiMergeOffsets.before === '\u{1f600}' &&
      emojiMergeOffsets.marked === 'tail' &&
      emojiMergeOffsets.whole === '\u{1f600}tail',
      JSON.stringify(emojiMergeOffsets));

    const selectedBoundary = await browser.eval(`(() => {
      const el = document.querySelector('[data-pid="${boundarySecond.pid}"]');
      el.focus();
      const node = el.firstChild;
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, Math.min(1, node.textContent.length));
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const allowed = el.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Backspace', bubbles: true, cancelable: true
      }));
      el.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', bubbles: true, cancelable: true
      }));
      return { allowed, merging: !!paragraphMerge };
    })()`);
    await sleep(100);
    check('Backspace over a text selection remains an ordinary in-paragraph edit',
      selectedBoundary.allowed === true && selectedBoundary.merging === false &&
      (await req('GET', '/api/health')).body.rev === boundaryModel.rev,
      JSON.stringify(selectedBoundary));

    const currentHealth = (await req('GET', '/api/health')).body;
    const legacyCapability = await browser.eval(`(() => {
      setHealth({
        ok: true, bootedAt: 'merge-capable-generation',
        capabilities: { paragraphMerge: true }, rev: app.rev
      });
      const capable = app.paragraphMergeSupported;
      setHealth({ ok: true, bootedAt: 'legacy-generation', rev: app.rev });
      const cleared = !app.paragraphMergeSupported;
      const el = document.querySelector('[data-pid="${boundarySecond.pid}"]');
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(true);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const cancelled = !el.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Backspace', bubbles: true, cancelable: true
      }));
      const result = {
        capable,
        cleared,
        cancelled,
        merging: !!paragraphMerge,
        status: document.getElementById('rev').textContent,
        title: document.getElementById('rev').title
      };
      setHealth(${JSON.stringify(currentHealth)});
      el.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', bubbles: true, cancelable: true
      }));
      return result;
    })()`);
    check('a reconnect to an older server disables merge with visible restart guidance',
      legacyCapability.capable && legacyCapability.cleared &&
      legacyCapability.cancelled && !legacyCapability.merging &&
      /restart Scribe/i.test(legacyCapability.status) &&
      /current session was left untouched/i.test(legacyCapability.title) &&
      (await req('GET', '/api/health')).body.rev === boundaryModel.rev,
      JSON.stringify(legacyCapability));

    const modifiedBoundary = await browser.eval(`(() => {
      const el = document.querySelector('[data-pid="${boundarySecond.pid}"]');
      const cases = [
        { name: 'alt', altKey: true },
        { name: 'control', ctrlKey: true },
        { name: 'meta', metaKey: true },
        { name: 'shift', shiftKey: true },
        { name: 'composition', isComposing: true }
      ];
      const outcomes = [];
      for (const options of cases) {
        el.focus();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(true);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        const keydownAllowed = el.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Backspace', bubbles: true, cancelable: true, ...options
        }));
        const beforeInputAllowed = el.dispatchEvent(new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: 'deleteContentBackward'
        }));
        el.dispatchEvent(new KeyboardEvent('keyup', {
          key: 'Backspace', bubbles: true, ...options
        }));
        outcomes.push({
          name: options.name,
          keydownAllowed,
          beforeInputAllowed,
          merging: !!paragraphMerge
        });
      }
      el.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', bubbles: true, cancelable: true
      }));
      return outcomes;
    })()`);
    check('modifier and IME delete sequences never fall through beforeinput into a merge',
      modifiedBoundary.every((outcome) =>
        outcome.keydownAllowed && outcome.beforeInputAllowed && !outcome.merging) &&
      (await req('GET', '/api/health')).body.rev === boundaryModel.rev,
      JSON.stringify(modifiedBoundary));

    const mergeLockStart = await browser.eval(`(() => {
      window.__paragraphMergeFetch = window.fetch;
      window.__releaseParagraphMerge = null;
      window.fetch = (...args) => {
        const url = new URL(args[0], location.href);
        let body = {};
        try { body = JSON.parse(args[1] && args[1].body || '{}'); } catch (_) {}
        if (url.pathname === '/api/edit' && body.op && body.op.type === 'merge') {
          return new Promise((resolve) => {
            window.__releaseParagraphMerge = () => resolve(new Response(
              JSON.stringify({ error: 'delayed merge refusal' }),
              { status: 409, headers: { 'content-type': 'application/json' } }
            ));
          });
        }
        return window.__paragraphMergeFetch(...args);
      };
      const el = document.querySelector('[data-pid="${boundarySecond.pid}"]');
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(true);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const cancelled = !el.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Backspace', bubbles: true, cancelable: true
      }));
      return { cancelled, merging: !!paragraphMerge };
    })()`);
    await browser.waitFor('typeof window.__releaseParagraphMerge === "function"');
    const mergeLock = await browser.eval(`(() => {
      const rebuilt = JSON.parse(JSON.stringify(app.model));
      rebuilt.paragraphs.push({
        pid: 'MERGELOCK', style: 'Normal', text: 'synthetic rebuild sentinel',
        hash: 'merge-lock-hash', runs: [{ text: 'synthetic rebuild sentinel' }]
      });
      applyModel(rebuilt);
      setPaused(false);
      const first = document.querySelector('[data-pid="${boundaryFirst.pid}"]');
      const second = document.querySelector('[data-pid="${boundarySecond.pid}"]');
      first.focus();
      beginDirectEdit(first);
      return {
        firstEditable: first.getAttribute('contenteditable'),
        secondEditable: second.getAttribute('contenteditable'),
        firstStaged: directEdits.has(${JSON.stringify(boundaryFirst.pid)}),
        undoDisabled: document.getElementById('undo').disabled,
        openDisabled: document.getElementById('doc-name').disabled,
        merging: !!paragraphMerge
      };
    })()`);
    await browser.eval('window.__releaseParagraphMerge()');
    await browser.waitFor(`!paragraphMerge &&
      document.querySelector('[data-pid="${boundarySecond.pid}"]') &&
      /not merged/.test(document.getElementById('rev').textContent)`, {
      timeout: 12000
    });
    const mergeLockReleased = await browser.eval(`(() => {
      const result = {
        undoDisabled: document.getElementById('undo').disabled,
        openDisabled: document.getElementById('doc-name').disabled,
        sentinel: !!document.querySelector('[data-pid="MERGELOCK"]')
      };
      window.fetch = window.__paragraphMergeFetch;
      delete window.__paragraphMergeFetch;
      delete window.__releaseParagraphMerge;
      for (const pid of [
        ${JSON.stringify(boundaryFirst.pid)},
        ${JSON.stringify(boundarySecond.pid)}
      ]) {
        const el = document.querySelector('[data-pid="' + pid + '"]');
        if (el && directEdits.has(pid)) cancelDirectEdit(el);
      }
      return result;
    })()`);
    check('an in-flight merge stays locked through structural rebuild and resume',
      mergeLockStart.cancelled && mergeLockStart.merging &&
      mergeLock.firstEditable === 'false' &&
      mergeLock.secondEditable === 'false' &&
      !mergeLock.firstStaged && mergeLock.undoDisabled &&
      mergeLock.openDisabled && mergeLock.merging &&
      !mergeLockReleased.undoDisabled && !mergeLockReleased.openDisabled &&
      !mergeLockReleased.sentinel &&
      (await req('GET', '/api/health')).body.rev === boundaryModel.rev,
      JSON.stringify({ start: mergeLockStart, lock: mergeLock,
        released: mergeLockReleased }));

    const documentSwitchRev = (await req('GET', '/api/health')).body.rev;
    const documentSwitchMerge = await browser.eval(`(async () => {
      const nativeFetch = window.fetch;
      const base = JSON.parse(JSON.stringify(app.model));
      const copied = JSON.parse(JSON.stringify(base));
      copied.path = String(base.path || 'paper.docx') + '.copied.docx';
      copied.rev = 0;
      const first = copied.paragraphs.find(
        p => p.pid === ${JSON.stringify(boundaryFirst.pid)});
      const second = copied.paragraphs.find(
        p => p.pid === ${JSON.stringify(boundarySecond.pid)});
      const oldDraft = second.text + ' [belongs only to the old document]';
      let releaseEdit = null;
      window.fetch = (input, init = {}) => {
        const url = new URL(String(input), location.href);
        let body = {};
        try { body = JSON.parse(init.body || '{}'); } catch (_) {}
        if (url.pathname === '/api/edit' &&
            body.op && body.op.type === 'merge') {
          return new Promise((resolve) => {
            releaseEdit = () => resolve(new Response(
              JSON.stringify({ error: 'old document merge retired' }),
              { status: 409, headers: { 'content-type': 'application/json' } }
            ));
          });
        }
        if (url.pathname === '/api/doc') {
          return Promise.resolve(new Response(JSON.stringify(copied), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }));
        }
        return nativeFetch(input, init);
      };

      const el = document.querySelector('[data-pid="' + second.pid + '"]');
      el.focus();
      el.textContent = oldDraft;
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertText'
      }));
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(true);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      el.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Backspace', bubbles: true, cancelable: true
      }));
      for (let i = 0; i < 100 && !releaseEdit; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const beforeGeneration = app.documentGeneration;
      enqueue('opened', { path: copied.path, rev: copied.rev });
      for (let i = 0; i < 200 &&
           (!app.model || app.model.path !== copied.path); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      releaseEdit();
      await new Promise((resolve) => setTimeout(resolve, 80));

      const copiedSecond = document.querySelector(
        '[data-pid="' + second.pid + '"]');
      const recovery = [...app.recoveryDrafts.entries()].find(([, draft]) =>
        draft.detached && draft.pid === second.pid &&
        draft.text === oldDraft);
      const recoveryItem = recovery && [...document.querySelectorAll(
        '.draft-recovery-item[data-detached="true"]')].find((item) =>
          item.querySelector('.draft-recovery-text') &&
          item.querySelector('.draft-recovery-text').value === oldDraft);
      const result = {
        generationAdvanced: app.documentGeneration > beforeGeneration,
        modelPath: app.model && app.model.path,
        expectedPath: copied.path,
        text: copiedSecond && copiedSecond.textContent,
        expectedText: second.text,
        dirty: copiedSecond && copiedSecond.classList.contains('dirty'),
        staged: directEdits.has(second.pid),
        recovered: !!recovery,
        recoveredText: recovery && recovery[1].text,
        recoverySource: recovery && recovery[1].sourcePath,
        recoveryLabel: recoveryItem &&
          recoveryItem.querySelector('.draft-recovery-label').textContent,
        copyOnly: recoveryItem &&
          recoveryItem.querySelector('.draft-recovery-text').readOnly,
        merging: !!paragraphMerge,
        undoDisabled: document.getElementById('undo').disabled,
        openDisabled: document.getElementById('doc-name').disabled,
        status: document.getElementById('rev').textContent,
        statusTitle: document.getElementById('rev').title,
        statusError: document.getElementById('rev')
          .classList.contains('edit-error')
      };

      if (recovery) app.recoveryDrafts.delete(recovery[0]);
      renderRecoveryDrafts();
      window.fetch = nativeFetch;
      applyModel(base);
      app.rev = base.rev;
      setDocName(base.path);
      setEditStatus(null);
      return result;
    })()`);
    check('an opened copied document retires its merge and keeps old typing copy-only',
      documentSwitchMerge.generationAdvanced &&
      documentSwitchMerge.modelPath === documentSwitchMerge.expectedPath &&
      documentSwitchMerge.text === documentSwitchMerge.expectedText &&
      !documentSwitchMerge.dirty && !documentSwitchMerge.staged &&
      documentSwitchMerge.recovered &&
      documentSwitchMerge.recoveredText.endsWith(
        '[belongs only to the old document]') &&
      documentSwitchMerge.recoveryLabel.includes(
        documentSwitchMerge.recoverySource) &&
      documentSwitchMerge.copyOnly &&
      !documentSwitchMerge.merging &&
      !documentSwitchMerge.undoDisabled && !documentSwitchMerge.openDisabled &&
      documentSwitchMerge.statusError &&
      /not merged.*typing preserved/i.test(documentSwitchMerge.status) &&
      /copy-only recovery/i.test(documentSwitchMerge.statusTitle) &&
      (await req('GET', '/api/health')).body.rev === documentSwitchRev,
      JSON.stringify(documentSwitchMerge));

    const samePathSwitchMerge = await browser.eval(`(async () => {
      const nativeFetch = window.fetch;
      const base = JSON.parse(JSON.stringify(app.model));
      const reopened = JSON.parse(JSON.stringify(base));
      reopened.rev = Number(base.rev || 0) + 1;
      const first = reopened.paragraphs.find(
        p => p.pid === ${JSON.stringify(boundaryFirst.pid)});
      const second = reopened.paragraphs.find(
        p => p.pid === ${JSON.stringify(boundarySecond.pid)});
      const oldDraft =
        '  ' + second.text + '  [same-path old draft]  ';
      let releaseEdit = null;
      window.fetch = (input, init = {}) => {
        const url = new URL(String(input), location.href);
        let body = {};
        try { body = JSON.parse(init.body || '{}'); } catch (_) {}
        if (url.pathname === '/api/edit' &&
            body.op && body.op.type === 'merge') {
          return new Promise((resolve) => {
            releaseEdit = () => resolve(new Response(
              JSON.stringify({ error: 'same-path merge retired' }),
              { status: 409, headers: { 'content-type': 'application/json' } }
            ));
          });
        }
        if (url.pathname === '/api/doc') {
          return Promise.resolve(new Response(JSON.stringify(reopened), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }));
        }
        return nativeFetch(input, init);
      };

      const el = document.querySelector('[data-pid="' + second.pid + '"]');
      el.focus();
      el.textContent = oldDraft;
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertText'
      }));
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(true);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      el.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Backspace', bubbles: true, cancelable: true
      }));
      for (let i = 0; i < 100 && !releaseEdit; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const directParagraph = reopened.paragraphs.find(
        p => p.pid === ${JSON.stringify(typedTarget.pid)});
      const directEl = document.querySelector(
        '[data-pid="' + directParagraph.pid + '"]');
      beginDirectEdit(directEl);
      const directOldDraft =
        directParagraph.text + ' [same-path direct old draft]';
      directEl.textContent = directOldDraft;
      directEl.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertText'
      }));
      const directEdit = directEdits.get(directParagraph.pid);
      if (directEdit) clearTimeout(directEdit.saveTimer);
      const beforeGeneration = app.documentGeneration;
      enqueue('opened', { path: base.path, rev: reopened.rev });
      for (let i = 0; i < 200 &&
           (!app.model || app.model.rev !== reopened.rev); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      releaseEdit();
      await new Promise((resolve) => setTimeout(resolve, 80));

      const shown = document.querySelector('[data-pid="' + second.pid + '"]');
      const recovery = [...app.recoveryDrafts.entries()].find(([, draft]) =>
        draft.detached && draft.pid === second.pid &&
        draft.text === oldDraft);
      const directRecovery = [...app.recoveryDrafts.entries()].find(([, draft]) =>
        draft.detached && draft.pid === directParagraph.pid &&
        draft.text === directOldDraft);
      const result = {
        generationAdvanced: app.documentGeneration > beforeGeneration,
        modelPath: app.model && app.model.path,
        expectedPath: base.path,
        text: shown && shown.textContent,
        expectedText: second.text,
        dirty: shown && shown.classList.contains('dirty'),
        staged: directEdits.has(second.pid),
        recovered: !!recovery,
        recoveredText: recovery && recovery[1].text,
        recoverySource: recovery && recovery[1].sourcePath,
        directRecoveredText: directRecovery && directRecovery[1].text,
        directExpected: directOldDraft,
        directStaged: directEdits.has(directParagraph.pid),
        merging: !!paragraphMerge
      };
      if (recovery) app.recoveryDrafts.delete(recovery[0]);
      if (directRecovery) app.recoveryDrafts.delete(directRecovery[0]);
      renderRecoveryDrafts();
      window.fetch = nativeFetch;
      app.model = base;
      applyModel(base);
      app.rev = base.rev;
      setDocName(base.path);
      setEditStatus(null);
      return result;
    })()`);
    check('same-path reopen retires its merge but preserves the exact old draft for copying',
      samePathSwitchMerge.generationAdvanced &&
      samePathSwitchMerge.modelPath === samePathSwitchMerge.expectedPath &&
      samePathSwitchMerge.text === samePathSwitchMerge.expectedText &&
      !samePathSwitchMerge.dirty && !samePathSwitchMerge.staged &&
      samePathSwitchMerge.recovered &&
      samePathSwitchMerge.recoveredText.startsWith('  ') &&
      samePathSwitchMerge.recoveredText.endsWith('  ') &&
      samePathSwitchMerge.recoverySource ===
        samePathSwitchMerge.expectedPath &&
      samePathSwitchMerge.directRecoveredText ===
        samePathSwitchMerge.directExpected &&
      !samePathSwitchMerge.directStaged &&
      !samePathSwitchMerge.merging,
      JSON.stringify(samePathSwitchMerge));

    const staleConfirmationRev = (await req('GET', '/api/health')).body.rev;
    const staleMergeConfirmation = await browser.eval(`(async () => {
      const nativeFetch = window.fetch;
      const base = JSON.parse(JSON.stringify(app.model));
      const first = base.paragraphs.find(
        p => p.pid === ${JSON.stringify(boundaryFirst.pid)});
      const second = base.paragraphs.find(
        p => p.pid === ${JSON.stringify(boundarySecond.pid)});
      const merged = JSON.parse(JSON.stringify(base));
      const mergedFirst = merged.paragraphs.find(p => p.pid === first.pid);
      mergedFirst.text = first.text + second.text;
      mergedFirst.hash = 'synthetic-stale-merged-hash';
      mergedFirst.runs = [{ text: mergedFirst.text }];
      merged.paragraphs = merged.paragraphs.filter(p => p.pid !== second.pid);
      merged.count = merged.paragraphs.length;
      merged.rev = Number(base.rev || 0) + 1;
      const newerUndo = JSON.parse(JSON.stringify(base));
      newerUndo.rev = Number(base.rev || 0) + 2;
      let releaseMergeRefresh = null;
      let docCalls = 0;
      window.fetch = (input, init = {}) => {
        const url = new URL(String(input), location.href);
        let body = {};
        try { body = JSON.parse(init.body || '{}'); } catch (_) {}
        if (url.pathname === '/api/edit' &&
            body.op && body.op.type === 'merge') {
          return Promise.resolve(new Response(JSON.stringify({
            ok: true,
            rev: merged.rev,
            result: {
              pid: first.pid,
              removed_pid: second.pid,
              after: mergedFirst.text,
              hash: mergedFirst.hash,
              start: first.text.length,
              end: mergedFirst.text.length
            }
          }), { status: 200, headers: { 'content-type': 'application/json' } }));
        }
        if (url.pathname === '/api/doc') {
          docCalls++;
          if (docCalls === 1) {
            return new Promise((resolve) => {
              releaseMergeRefresh = () => resolve(new Response(
                JSON.stringify(merged),
                { status: 200, headers: { 'content-type': 'application/json' } }
              ));
            });
          }
          return Promise.resolve(new Response(
            JSON.stringify(newerUndo),
            { status: 200, headers: { 'content-type': 'application/json' } }
          ));
        }
        return nativeFetch(input, init);
      };

      const el = document.querySelector('[data-pid="' + second.pid + '"]');
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(true);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      el.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Backspace', bubbles: true, cancelable: true
      }));
      for (let i = 0; i < 100 && !releaseMergeRefresh; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const later = await fetchModel();
      const laterRender = later && applyModel(later);
      releaseMergeRefresh();
      for (let i = 0; i < 200 && paragraphMerge; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const secondEl = document.querySelector('[data-pid="' + second.pid + '"]');
      const result = {
        docCalls,
        laterStale: !!(laterRender && laterRender.stale),
        secondPresent: !!secondEl,
        secondText: secondEl && secondEl.textContent,
        secondExpected: second.text,
        staged: directEdits.has(second.pid),
        merging: !!paragraphMerge,
        status: document.getElementById('rev').textContent,
        currentRev: app.model && app.model.rev
      };
      window.fetch = nativeFetch;
      if (secondEl && directEdits.has(second.pid)) cancelDirectEdit(secondEl);
      applyModel(base);
      app.rev = base.rev;
      setEditStatus(null);
      return result;
    })()`);
    check('a delayed stale merge snapshot cannot override a newer applied undo model',
      staleMergeConfirmation.docCalls === 2 &&
      staleMergeConfirmation.laterStale === false &&
      staleMergeConfirmation.secondPresent &&
      staleMergeConfirmation.secondText === staleMergeConfirmation.secondExpected &&
      staleMergeConfirmation.staged && !staleMergeConfirmation.merging &&
      /not merged/.test(staleMergeConfirmation.status) &&
      staleMergeConfirmation.currentRev === boundaryModel.rev + 2 &&
      (await req('GET', '/api/health')).body.rev === staleConfirmationRev,
      JSON.stringify(staleMergeConfirmation));

    const refreshFailureRev = (await req('GET', '/api/health')).body.rev;
    await browser.eval(`(() => {
      window.__paragraphMergeFetch = window.fetch;
      window.fetch = (...args) => {
        const url = new URL(args[0], location.href);
        if (url.pathname === '/api/doc') {
          return Promise.resolve(new Response(
            JSON.stringify({ error: 'simulated document refresh failure' }),
            { status: 503, headers: { 'content-type': 'application/json' } }
          ));
        }
        return window.__paragraphMergeFetch(...args);
      };
      const el = document.querySelector('[data-pid="${boundarySecond.pid}"]');
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(true);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      el.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Backspace', bubbles: true, cancelable: true
      }));
      return true;
    })()`);
    await browser.waitFor(`!paragraphMerge &&
      /not merged/.test(document.getElementById('rev').textContent)`, {
      timeout: 12000
    });
    const refreshFailureUi = await browser.eval(`(() => ({
      status: document.getElementById('rev').textContent,
      error: document.getElementById('rev').classList.contains('edit-error'),
      firstPresent: !!document.querySelector('[data-pid="${boundaryFirst.pid}"]'),
      secondPresent: !!document.querySelector('[data-pid="${boundarySecond.pid}"]'),
      undoDisabled: document.getElementById('undo').disabled,
      openDisabled: document.getElementById('doc-name').disabled
    }))()`);
    const unconfirmedExtra = ' [typed after confirmation failed]';
    const unconfirmedDraft = await browser.eval(`(async () => {
      const el = document.querySelector('[data-pid="${boundarySecond.pid}"]');
      const exact = el.textContent + ${JSON.stringify(' [typed after confirmation failed]')};
      el.textContent = exact;
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertText'
      }));
      await new Promise((resolve) => setTimeout(resolve, 900));
      const edit = directEdits.get(${JSON.stringify(boundarySecond.pid)});
      return {
        text: el.textContent,
        exact,
        staged: !!edit,
        conflict: !!(edit && edit.stagedConflict),
        saving: el.classList.contains('saving'),
        editable: el.getAttribute('contenteditable'),
        status: document.getElementById('rev').textContent,
        title: document.getElementById('rev').title
      };
    })()`);
    const refreshFailureServer = (await req('GET', '/api/doc')).body;
    await browser.eval(`(() => {
      window.fetch = window.__paragraphMergeFetch;
      delete window.__paragraphMergeFetch;
      for (const pid of [
        ${JSON.stringify(boundaryFirst.pid)},
        ${JSON.stringify(boundarySecond.pid)}
      ]) {
        const el = document.querySelector('[data-pid="' + pid + '"]');
        if (el && directEdits.has(pid)) cancelDirectEdit(el);
      }
    })()`);
    const undoUnconfirmedMerge = await req('POST', '/api/undo');
    await browser.waitFor(`document.querySelector('[data-pid="${boundarySecond.pid}"]') &&
      app.model.paragraphs.length === ${boundaryCount}`, { timeout: 12000 });
    check('an acknowledged merge is not announced until a document refresh confirms it',
      /not merged/.test(refreshFailureUi.status) && refreshFailureUi.error &&
      refreshFailureUi.firstPresent && refreshFailureUi.secondPresent &&
      !refreshFailureUi.undoDisabled && !refreshFailureUi.openDisabled &&
      refreshFailureServer.paragraphs.length === boundaryCount - 1 &&
      (await req('GET', '/api/health')).body.rev === refreshFailureRev + 2 &&
      undoUnconfirmedMerge.status === 200,
      JSON.stringify(refreshFailureUi));
    check('typing after an unconfirmed committed merge remains exact and cannot auto-save into a stale pid',
      unconfirmedDraft.text === unconfirmedDraft.exact &&
      unconfirmedDraft.text.endsWith(unconfirmedExtra) &&
      unconfirmedDraft.staged && unconfirmedDraft.conflict &&
      !unconfirmedDraft.saving &&
      unconfirmedDraft.editable === 'plaintext-only' &&
      /typing preserved/.test(unconfirmedDraft.status) &&
      /could not confirm|preserved/i.test(unconfirmedDraft.title) &&
      refreshFailureServer.paragraphs.length === boundaryCount - 1,
      JSON.stringify(unconfirmedDraft));

    const backspaceLocalFirst =
      '  ' + boundaryFirst.text + '  [unsaved first before Backspace]  ';
    const backspaceLocalSecond =
      '  ' + boundarySecond.text + '  [unsaved second before Backspace]  ';
    const backspaceExpected = backspaceLocalFirst + backspaceLocalSecond;
    const backspaceRev = (await req('GET', '/api/health')).body.rev;
    const backspaceStart = await browser.eval(`(() => {
      const el = document.querySelector('[data-pid="${boundarySecond.pid}"]');
      el.focus();
      el.textContent = ${JSON.stringify(backspaceLocalSecond)};
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertText'
      }));
      const first = document.querySelector('[data-pid="${boundaryFirst.pid}"]');
      beginDirectEdit(first);
      first.textContent = ${JSON.stringify(backspaceLocalFirst)};
      first.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertText'
      }));
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(true);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const firstCancelled = !el.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Backspace', bubbles: true, cancelable: true
      }));
      const repeatCancelled = !el.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Backspace', bubbles: true, cancelable: true
      }));
      return { firstCancelled, repeatCancelled };
    })()`);
    await browser.waitFor(`(() => {
      const first = window.__scribe.model.paragraphs.find(
        p => p.pid === ${JSON.stringify(boundaryFirst.pid)});
      return first && first.text === ${JSON.stringify(backspaceExpected)} &&
        !window.__scribe.model.paragraphs.some(
          p => p.pid === ${JSON.stringify(boundarySecond.pid)});
    })()`, { timeout: 12000 });
    const backspaceServer = (await req('GET', '/api/doc')).body;
    const backspaceUi = await browser.eval(`(() => {
      const survivor = document.querySelector('[data-pid="${boundaryFirst.pid}"]');
      return {
        secondGone: !document.querySelector('[data-pid="${boundarySecond.pid}"]'),
        text: survivor && survivor.textContent,
        focused: document.activeElement === survivor,
        caret: survivor ? caretOffset(survivor) : null,
        status: document.getElementById('rev').textContent
      };
    })()`);
    check('Backspace atomically merges exact unsaved drafts from both adjacent paragraphs',
      backspaceStart.firstCancelled && backspaceStart.repeatCancelled &&
      backspaceServer.paragraphs.length === boundaryCount - 1 &&
      backspaceServer.paragraphs.find((p) => p.pid === boundaryFirst.pid).text ===
        backspaceExpected &&
      (await req('GET', '/api/health')).body.rev === backspaceRev + 1,
      JSON.stringify(backspaceStart));
    check('the merged caret lands at the former paragraph boundary with visible feedback',
      backspaceUi.secondGone && backspaceUi.text === backspaceExpected &&
      backspaceUi.focused && backspaceUi.caret === backspaceLocalFirst.length &&
      /merged/.test(backspaceUi.status),
      JSON.stringify(backspaceUi));

    await browser.eval(`(() => {
      document.getElementById('undo').dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true
      }));
      return !directEdits.has(${JSON.stringify(boundaryFirst.pid)});
    })()`, true);
    const undoBackspaceMerge = await req('POST', '/api/undo');
    const undoBackspaceServer = (await req('GET', '/api/doc')).body;
    check('the Backspace merge checkpoint restores both paragraphs on the server',
      undoBackspaceMerge.status === 200 &&
      undoBackspaceServer.paragraphs.find((p) => p.pid === boundaryFirst.pid).text ===
        boundaryFirst.text &&
      undoBackspaceServer.paragraphs.find((p) => p.pid === boundarySecond.pid).text ===
        boundarySecond.text,
      undoBackspaceMerge.body.error || JSON.stringify({
        count: undoBackspaceServer.paragraphs.length,
        first: undoBackspaceServer.paragraphs.find((p) => p.pid === boundaryFirst.pid),
        second: undoBackspaceServer.paragraphs.find((p) => p.pid === boundarySecond.pid),
      }));
    const undoBackspacePainted = await browser.waitFor(
      `document.querySelector('[data-pid="${boundarySecond.pid}"]') &&
        document.querySelector('[data-pid="${boundaryFirst.pid}"]').textContent ===
          ${JSON.stringify(boundaryFirst.text)} &&
        document.querySelector('[data-pid="${boundarySecond.pid}"]').textContent ===
          ${JSON.stringify(boundarySecond.text)}`,
      { timeout: 12000 },
    ).catch(async () => {
      const detail = await browser.eval(`(() => ({
        orderHasSecond: app.order.includes(${JSON.stringify(boundarySecond.pid)}),
        modelHasSecond: app.model.paragraphs.some(
          p => p.pid === ${JSON.stringify(boundarySecond.pid)}),
        domHasSecond: !!document.querySelector('[data-pid="${boundarySecond.pid}"]'),
        firstText: document.querySelector('[data-pid="${boundaryFirst.pid}"]') &&
          document.querySelector('[data-pid="${boundaryFirst.pid}"]').textContent,
        direct: [...directEdits.entries()].map(([pid, edit]) => ({
          pid, dirty: edit.dirty, conflict: edit.stagedConflict, text: edit.text
        })),
        active: document.activeElement && document.activeElement.dataset.pid,
        rev: app.rev,
        queue: app.queue.map(x => x.type),
        flushing: app.flushing,
        render: window.__lastRender,
        errors: window.__errs || []
      }))()`);
      console.log('  undo repaint diagnostic  ' + JSON.stringify(detail));
      return false;
    });
    if (!undoBackspacePainted) throw new Error('Backspace merge undo did not repaint');
    check('one Undo restores both paragraphs after a Backspace merge',
      undoBackspaceMerge.status === 200 &&
      (await req('GET', '/api/doc')).body.paragraphs.length === boundaryCount,
      undoBackspaceMerge.body.error);

    const refusedLocalSecond = boundarySecond.text + ' [must survive refused merge]';
    await browser.eval(`(() => {
      window.__paragraphMergeFetch = window.fetch;
      window.fetch = (...args) => {
        const url = new URL(args[0], location.href);
        let body = {};
        try { body = JSON.parse(args[1] && args[1].body || '{}'); } catch (_) {}
        if (url.pathname === '/api/edit' && body.op && body.op.type === 'merge') {
          return Promise.resolve(new Response(
            JSON.stringify({ error: 'simulated merge refusal' }),
            { status: 409, headers: { 'content-type': 'application/json' } }
          ));
        }
        return window.__paragraphMergeFetch(...args);
      };
      const el = document.querySelector('[data-pid="${boundarySecond.pid}"]');
      el.focus();
      el.textContent = ${JSON.stringify(refusedLocalSecond)};
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertText'
      }));
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(true);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      el.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Backspace', bubbles: true, cancelable: true
      }));
      return true;
    })()`);
    await browser.waitFor(`(() => {
      const el = document.querySelector('[data-pid="${boundarySecond.pid}"]');
      return el && el.textContent === ${JSON.stringify(refusedLocalSecond)} &&
        el.classList.contains('editing') &&
        /not merged/.test(document.getElementById('rev').textContent);
    })()`, { timeout: 8000 });
    const refusedMerge = await browser.eval(`(() => {
      const el = document.querySelector('[data-pid="${boundarySecond.pid}"]');
      const result = {
        text: el.textContent,
        dirty: el.classList.contains('dirty'),
        editable: el.getAttribute('contenteditable'),
        staged: directEdits.has(${JSON.stringify(boundarySecond.pid)}),
        merging: !!paragraphMerge,
        status: document.getElementById('rev').textContent,
        detail: document.getElementById('edit-detail').textContent,
        detailHidden: document.getElementById('edit-detail').hidden,
        detailRole: document.getElementById('edit-detail').getAttribute('role'),
        detailLive: document.getElementById('edit-detail').getAttribute('aria-live'),
        detailVisible: getComputedStyle(
          document.getElementById('edit-detail')).display !== 'none'
      };
      window.fetch = window.__paragraphMergeFetch;
      delete window.__paragraphMergeFetch;
      el.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', bubbles: true, cancelable: true
      }));
      return result;
    })()`);
    const refusedServer = (await req('GET', '/api/doc')).body;
    check('a refused merge preserves the exact local draft and stays retryable',
      refusedMerge.text === refusedLocalSecond && refusedMerge.dirty &&
      refusedMerge.editable === 'plaintext-only' && refusedMerge.staged &&
      refusedMerge.merging === false && /not merged/.test(refusedMerge.status) &&
      refusedServer.paragraphs.length === boundaryCount &&
      refusedServer.paragraphs.find((p) => p.pid === boundarySecond.pid).text ===
        boundarySecond.text,
      JSON.stringify(refusedMerge));
    check('a merge refusal exposes its full reason in a visible live status',
      refusedMerge.detail === 'simulated merge refusal' &&
      !refusedMerge.detailHidden && refusedMerge.detailVisible &&
      refusedMerge.detailRole === 'status' &&
      refusedMerge.detailLive === 'polite',
      JSON.stringify(refusedMerge));

    const deleteLocalFirst =
      '  ' + boundaryFirst.text +
      '  \u{1f600}  [unsaved first before Delete]  ';
    const deleteLocalSecond =
      '  ' + boundarySecond.text + '  [unsaved second before Delete]  ';
    const deleteExpected = deleteLocalFirst + deleteLocalSecond;
    const deleteRev = (await req('GET', '/api/health')).body.rev;
    const deleteStart = await browser.eval(`(() => {
      window.__paragraphMergeFetch = window.fetch;
      let dropped = false;
      window.fetch = (...args) => {
        const url = new URL(args[0], location.href);
        let body = {};
        try { body = JSON.parse(args[1] && args[1].body || '{}'); } catch (_) {}
        if (!dropped && url.pathname === '/api/edit' &&
            body.op && body.op.type === 'merge') {
          dropped = true;
          return window.__paragraphMergeFetch(...args).then(async (response) => {
            await response.clone().text();
            throw new TypeError('simulated lost merge acknowledgement');
          });
        }
        return window.__paragraphMergeFetch(...args);
      };
      const el = document.querySelector('[data-pid="${boundaryFirst.pid}"]');
      el.focus();
      el.textContent = ${JSON.stringify(deleteLocalFirst)};
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertText'
      }));
      const second = document.querySelector('[data-pid="${boundarySecond.pid}"]');
      beginDirectEdit(second);
      second.textContent = ${JSON.stringify(deleteLocalSecond)};
      second.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertText'
      }));
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const beforeInputCancelled = !el.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'deleteContentForward'
      }));
      return { beforeInputCancelled };
    })()`);
    await browser.waitFor(`(() => {
      const first = window.__scribe.model.paragraphs.find(
        p => p.pid === ${JSON.stringify(boundaryFirst.pid)});
      return first && first.text === ${JSON.stringify(deleteExpected)} &&
        !window.__scribe.model.paragraphs.some(
          p => p.pid === ${JSON.stringify(boundarySecond.pid)}) &&
        !paragraphMerge;
    })()`, { timeout: 12000 });
    const lostAckMerge = await browser.eval(`(() => {
      const survivor = document.querySelector('[data-pid="${boundaryFirst.pid}"]');
      const result = {
        text: survivor && survivor.textContent,
        focused: document.activeElement === survivor,
        caret: survivor && caretOffset(survivor),
        status: document.getElementById('rev').textContent,
        error: document.getElementById('rev').classList.contains('edit-error')
      };
      window.fetch = window.__paragraphMergeFetch;
      delete window.__paragraphMergeFetch;
      document.getElementById('undo').dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true
      }));
      return result;
    })()`);
    check('beforeinput-only Delete merges both drafts and reconciles a lost response',
      lostAckMerge.text === deleteExpected && lostAckMerge.focused &&
      lostAckMerge.caret === deleteLocalFirst.length &&
      deleteStart.beforeInputCancelled &&
      /merged/.test(lostAckMerge.status) && !lostAckMerge.error &&
      (await req('GET', '/api/health')).body.rev === deleteRev + 1,
      JSON.stringify(lostAckMerge));
    const undoDeleteMerge = await req('POST', '/api/undo');
    await browser.waitFor(`document.querySelector('[data-pid="${boundarySecond.pid}"]') &&
      document.querySelector('[data-pid="${boundaryFirst.pid}"]').textContent ===
        ${JSON.stringify(boundaryFirst.text)}`, { timeout: 12000 });
    check('the lost-ack Delete merge is still exactly one undo step',
      undoDeleteMerge.status === 200 &&
      (await req('GET', '/api/doc')).body.paragraphs.length === boundaryCount,
      undoDeleteMerge.body.error);

    console.log('\n[simultaneous edit safety]');
    const conflictBefore = (await req('GET', '/api/doc')).body.paragraphs.find((p) => p.pid === typedTarget.pid);
    const conflictFind = conflictBefore.text.slice(0, 12);
    await browser.eval(`(() => {
      const el = document.querySelector('[data-pid="${typedTarget.pid}"]');
      el.focus();
      el.textContent = ${JSON.stringify(conflictBefore.text + ' LOCAL UNSAVED')};
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    })(), true`);
    const concurrent = await req('POST', '/api/edit', {
      who: 'viewer-test',
      op: {
        type: 'replace', pid: typedTarget.pid, find: conflictFind,
        replace: 'SERVER WON', why: 'conflict test',
        utterance: 'conflict-server', expect_hash: conflictBefore.hash,
      },
    });
    check('a concurrent server edit lands first', concurrent.status === 200, concurrent.body.error);
    await browser.waitFor(`window.__scribe.rev === ${concurrent.body.rev}`, { timeout: 10000 });
    const localHeld = await browser.eval(
      `document.querySelector('[data-pid="${typedTarget.pid}"]').textContent.endsWith('LOCAL UNSAVED')`);
    check('an in-flight local sentence is not overwritten mid-keystroke', localHeld === true);
    await browser.eval(`document.querySelector('.topbar').dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true
    })), true`);
    await browser.waitFor(`/typing preserved/.test(document.getElementById('rev').textContent) &&
      document.querySelector('[data-pid="${typedTarget.pid}"]').textContent.endsWith('LOCAL UNSAVED') &&
      directEdits.get(${JSON.stringify(typedTarget.pid)}) &&
      directEdits.get(${JSON.stringify(typedTarget.pid)}).stagedConflict`, { timeout: 12000 });
    const conflictShown = await browser.eval(`({
      text: document.querySelector('[data-pid="${typedTarget.pid}"]').textContent,
      error: document.querySelector('[data-pid="${typedTarget.pid}"]').classList.contains('save-error'),
      title: document.getElementById('rev').title,
      staged: !!(directEdits.get(${JSON.stringify(typedTarget.pid)}) &&
        directEdits.get(${JSON.stringify(typedTarget.pid)}).stagedConflict)
    })`);
    check('a stale direct save preserves the exact local text as an explicit conflict',
      conflictShown.text === conflictBefore.text + ' LOCAL UNSAVED' &&
      conflictShown.staged);
    check('the refused save is plainly reported',
      conflictShown.error && /changed since you read it/.test(conflictShown.title),
      JSON.stringify(conflictShown.title));
    await browser.eval(`(() => {
      const el = document.querySelector('[data-pid="${typedTarget.pid}"]');
      el.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', bubbles: true, cancelable: true
      }));
    })(), true`);
    await browser.waitFor(
      `document.querySelector('[data-pid="${typedTarget.pid}"]').textContent.includes('SERVER WON')`,
      { timeout: 5000 });
    await req('POST', '/api/undo');
    await browser.waitFor(`document.querySelector('[data-pid="${typedTarget.pid}"]').textContent ===
      ${JSON.stringify(conflictBefore.text)}`, { timeout: 10000 });

    console.log('\n[pause]');
    // The overlay must be genuinely gone when not paused. A `display` rule in
    // the stylesheet silently beat the [hidden] attribute, leaving the scrim
    // permanently on with its backdrop-filter washing out the whole document.
    // Every DOM assertion still passed; only a screenshot showed it.
    const scrimDisp = await browser.eval(`getComputedStyle(document.getElementById('scrim')).display`);
    check('scrim is display:none when NOT paused', scrimDisp === 'none', scrimDisp);
    const washed = await browser.eval(`getComputedStyle(document.getElementById('scrim')).backdropFilter`);
    check('  (its backdrop-filter is therefore not applied)', scrimDisp === 'none', washed);

    await req('POST', '/api/pause');
    await browser.waitFor('!document.getElementById("scrim").hidden');
    check('scrim shows when paused', true);
    const pausedEditable = await browser.eval(
      `[...document.querySelectorAll('.para')].every((p) => p.getAttribute('contenteditable') === 'false')`);
    check('pause also removes every document caret', pausedEditable === true);
    const clickable = await browser.eval(`getComputedStyle(document.getElementById('scrim')).pointerEvents === 'none'`);
    check('scrim does not eat clicks on the controls beneath it', clickable === true);
    await req('POST', '/api/resume');
    await browser.waitFor(`document.querySelector('.para').getAttribute('contenteditable') === 'plaintext-only'`);

    console.log('\n[tables]');
    const dom = await browser.send('DOM.getDocument');
    const input = await browser.send('DOM.querySelector', {
      nodeId: dom.root.nodeId, selector: '#doc-file',
    });
    await browser.send('DOM.setFileInputFiles', { files: [tdoc], nodeId: input.nodeId });
    await browser.waitFor('document.getElementById("doc-name").textContent === "tabled.docx"', { timeout: 15000 });
    await browser.waitFor('document.querySelectorAll(".doc-table").length > 0', { timeout: 15000 });
    check('choosing a file uploads and opens it through the visible control',
      fs.existsSync(path.join(TMP, 'data', 'documents', 'tabled.docx')));
    const tables = await browser.eval('document.querySelectorAll(".doc-table").length');
    check('tables render as real tables', tables === 3, tables);
    const rows0 = await browser.eval('document.querySelectorAll(".doc-table")[0].querySelectorAll("tr").length');
    check('the verdict table has its 21 rows', rows0 === 21, rows0);
    const cells0 = await browser.eval('document.querySelectorAll(".doc-table")[0].querySelectorAll("tr")[0].querySelectorAll("td").length');
    check('and 5 columns', cells0 === 5, cells0);
    const cellParas = await browser.eval('document.querySelectorAll(".doc-table .para").length');
    check('all 213 table paragraphs are inside cells', cellParas === 213, cellParas);
    const stray = await browser.eval('[...document.querySelectorAll(".paper > .para")].length');
    check('no table paragraph leaked out as a stray line', stray === 150, stray);

    const tableBoundaryRev = (await req('GET', '/api/health')).body.rev;
    const tableBoundary = await browser.eval(`(() => {
      let current = null;
      for (let i = 1; i < app.order.length; i++) {
        const before = app.nodes.get(app.order[i - 1]);
        const after = app.nodes.get(app.order[i]);
        const beforeModel = paragraphModel(app.order[i - 1]);
        const afterModel = paragraphModel(app.order[i]);
        if (before && after && beforeModel && afterModel &&
            beforeModel.table && afterModel.table &&
            before.parentElement !== after.parentElement) {
          current = after;
          break;
        }
      }
      if (!current) return null;
      current.focus();
      const range = document.createRange();
      range.selectNodeContents(current);
      range.collapse(true);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const cancelled = !current.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Backspace', bubbles: true, cancelable: true
      }));
      const result = {
        pid: current.dataset.pid,
        cancelled,
        merging: !!paragraphMerge,
        status: document.getElementById('rev').textContent,
        title: document.getElementById('rev').title
      };
      current.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', bubbles: true, cancelable: true
      }));
      return result;
    })()`);
    check('a boundary key cannot merge paragraphs across table cells',
      tableBoundary && tableBoundary.cancelled && !tableBoundary.merging &&
      /not merged/.test(tableBoundary.status) &&
      /different table cells|document regions/i.test(tableBoundary.title) &&
      (await req('GET', '/api/health')).body.rev === tableBoundaryRev,
      JSON.stringify(tableBoundary));

    const tableModel = (await req('GET', '/api/doc')).body;
    const sameCellAnchor = tableModel.paragraphs.find(
      (p) => p.table && p.text.length > 10);
    const sameCellTail = 'Same-cell paragraph merge fixture.';
    const sameCellInsert = await req('POST', '/api/edit', {
      who: 'viewer-test',
      op: {
        type: 'insert',
        after_pid: sameCellAnchor.pid,
        text: sameCellTail,
        style: 'Normal',
        expect_hash: sameCellAnchor.hash,
        why: 'same table cell merge fixture',
        utterance: 'viewer-same-cell-fixture',
      },
    });
    const sameCellSecondPid = sameCellInsert.body.result &&
      sameCellInsert.body.result.pid;
    await browser.waitFor(`(() => {
      const first = document.querySelector(
        '[data-pid="${sameCellAnchor.pid}"]');
      const second = document.querySelector(
        '[data-pid="${sameCellSecondPid}"]');
      return first && second && first.parentElement === second.parentElement &&
        !!first.closest('td');
    })()`, { timeout: 12000 });
    const sameCellMergeRev = (await req('GET', '/api/health')).body.rev;
    const sameCellStarted = await browser.eval(`(() => {
      const first = document.querySelector(
        '[data-pid="${sameCellAnchor.pid}"]');
      const second = document.querySelector(
        '[data-pid="${sameCellSecondPid}"]');
      second.focus();
      const range = document.createRange();
      range.selectNodeContents(second);
      range.collapse(true);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return {
        sameParent: first.parentElement === second.parentElement,
        inCell: !!first.closest('td'),
        cancelled: !second.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Backspace', bubbles: true, cancelable: true
        }))
      };
    })()`);
    const sameCellExpected = sameCellAnchor.text + sameCellTail;
    await browser.waitFor(`(() => {
      const first = document.querySelector(
        '[data-pid="${sameCellAnchor.pid}"]');
      return first && first.textContent === ${JSON.stringify(sameCellExpected)} &&
        !document.querySelector('[data-pid="${sameCellSecondPid}"]') &&
        !paragraphMerge;
    })()`, { timeout: 12000 });
    const sameCellServer = (await req('GET', '/api/doc')).body;
    const sameCellUi = await browser.eval(`(() => {
      const survivor = document.querySelector(
        '[data-pid="${sameCellAnchor.pid}"]');
      document.getElementById('undo').dispatchEvent(new PointerEvent(
        'pointerdown', { bubbles: true, cancelable: true }));
      return {
        text: survivor && survivor.textContent,
        inCell: !!(survivor && survivor.closest('td')),
        secondGone: !document.querySelector(
          '[data-pid="${sameCellSecondPid}"]')
      };
    })()`);
    check('Backspace successfully merges adjacent paragraphs inside one table cell',
      sameCellInsert.status === 200 &&
      sameCellStarted.sameParent && sameCellStarted.inCell &&
      sameCellStarted.cancelled &&
      sameCellUi.inCell && sameCellUi.secondGone &&
      sameCellUi.text === sameCellExpected &&
      sameCellServer.paragraphs.find(
        (p) => p.pid === sameCellAnchor.pid).text === sameCellExpected &&
      (await req('GET', '/api/health')).body.rev === sameCellMergeRev + 1,
      JSON.stringify({ start: sameCellStarted, ui: sameCellUi }));
    const undoSameCellMerge = await req('POST', '/api/undo');
    await browser.waitFor(`(() => {
      const first = document.querySelector(
        '[data-pid="${sameCellAnchor.pid}"]');
      const second = document.querySelector(
        '[data-pid="${sameCellSecondPid}"]');
      return first && second && first.textContent ===
        ${JSON.stringify(sameCellAnchor.text)} &&
        second.textContent === ${JSON.stringify(sameCellTail)};
    })()`, { timeout: 12000 });
    check('one Undo restores both same-cell paragraphs after their merge',
      undoSameCellMerge.status === 200);
    const removeSameCellFixture = await req('POST', '/api/undo');
    await browser.waitFor(
      `!document.querySelector('[data-pid="${sameCellSecondPid}"]')`,
      { timeout: 12000 });
    check('the isolated same-cell fixture cleans up with its preceding Undo step',
      removeSameCellFixture.status === 200);

    const tableTarget = tableModel.paragraphs.find((p) => p.table && p.text.length > 10);
    const tableTyped = tableTarget.text + ' [cell edit]';
    await browser.eval(`(() => {
      const el = document.querySelector('[data-pid="${tableTarget.pid}"]');
      el.focus();
      el.textContent = ${JSON.stringify(tableTyped)};
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      document.querySelector('.topbar').dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true
      }));
    })(), true`);
    await browser.waitFor(`document.querySelector('[data-pid="${tableTarget.pid}"]').dataset.hash !==
      ${JSON.stringify(tableTarget.hash)} &&
      !document.querySelector('[data-pid="${tableTarget.pid}"]').classList.contains('saving')`, { timeout: 12000 });
    const tableAfter = (await req('GET', '/api/doc')).body.paragraphs.find((p) => p.pid === tableTarget.pid);
    check('click-away saves direct typing inside a table cell', tableAfter.text === tableTyped);

    console.log('\n[no console errors]');
    // Prove the collector is actually installed before trusting its silence.
    const armed = await browser.eval('Array.isArray(window.__errs)');
    check('error collector is armed (so this check can fail)', armed === true);
    const errs = await browser.eval('JSON.stringify(window.__errs || null)');
    check('page logged no errors', errs === '[]', errs);
    check('page threw no uncaught exceptions', browser.exceptions.length === 0,
      browser.exceptions.slice(0, 2).join(' | '));
  } catch (e) {
    console.error('\nTEST ERROR:', e && e.stack || e);
    hardFail = true;
  } finally {
    if (browser) browser.kill();
    srv.kill();
    await sleep(700);
    for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch (_) { await sleep(300); } }
  }

  console.log(`\n${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) { console.log('failed: ' + FAIL.join(', ')); console.log('\n--- server log ---\n' + srvLog.join('').slice(-2500)); }
  process.exit(FAIL.length || hardFail ? 1 : 0);
}

main();
