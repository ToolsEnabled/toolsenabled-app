#!/usr/bin/env node
'use strict';
/**
 * Continuous watch tests.
 *
 * The main invariant is separation: the watch reviewer has its own read-only
 * tool surface and never starts or changes the editing agent.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Browser, findBrowser, sleep } = require('./cdp');
const { availablePort, waitForOwnedHealth } = require('./isolated_server');
const { requiredLiveFile } = require('./live-input');

const ROOT = path.join(__dirname, '..');
let PORT = 4690;
let BASE = `http://127.0.0.1:${PORT}`;
const TMP = path.join(__dirname, '_tmp_watch');
const SRC = requiredLiveFile('SCRIBE_TEST_DOCX');
const PASS = [], FAIL = [];
const check = (name, condition, detail) => {
  (condition ? PASS : FAIL).push(name);
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? '  ' + detail : ''}`);
};

function req(method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(`${BASE}${route}`, {
      method,
      headers: data ? {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
      } : {},
    }, (res) => {
      let out = '';
      res.on('data', (c) => out += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(out || '{}') }); }
        catch (_) { resolve({ status: res.statusCode, body: out }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function mcpToolNames(mode) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'mcp-doc.js')], {
      cwd: ROOT,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, SCRIBE_MCP_MODE: mode },
    });
    let out = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('MCP tools/list timed out'));
    }, 5000);
    proc.stdout.on('data', (chunk) => {
      out += chunk;
      const line = out.split('\n').find((x) => x.trim());
      if (!line) return;
      clearTimeout(timer);
      proc.kill();
      try {
        const message = JSON.parse(line);
        resolve(message.result.tools.map((t) => t.name).sort());
      } catch (e) { reject(e); }
    });
    proc.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
    }) + '\n');
  });
}

async function waitFor(fn, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(120);
  }
  throw new Error('waitFor timed out');
}

async function main() {
  console.log('\n[separate tool surface]');
  const watchTools = await mcpToolNames('watch');
  check('watch is offered only read, find, and attach-note',
    watchTools.join(',') === 'doc_assist,doc_find,doc_read', watchTools.join(','));
  const predictTools = await mcpToolNames('predict');
  check('predictive drafting is offered only document reads',
    predictTools.join(',') === 'doc_find,doc_read', predictTools.join(','));
  const editTools = await mcpToolNames('edit');
  check('the editing agent keeps its full independent editing surface',
    editTools.includes('doc_replace') && editTools.includes('doc_propose') &&
    !editTools.includes('doc_assist') && editTools.length === 7,
    editTools.join(','));

  if (!findBrowser()) {
    console.log('No Chrome or Edge found, skipping browser watch tests.');
    console.log(`\n${PASS.length} passed, ${FAIL.length} failed`);
    process.exit(FAIL.length ? 1 : 0);
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
      SCRIBE_WATCH_TEST: '1',
      SCRIBE_WATCH_TIMEOUT_MS: '1200',
    },
  });
  const logs = [];
  server.stdout.on('data', (d) => logs.push(d.toString()));
  server.stderr.on('data', (d) => logs.push(d.toString()));

  let browser = null;
  let freshBrowser = null;
  let hardFail = false;
  try {
    await waitForOwnedHealth(() => req('GET', '/api/health'), server, {
      attempts: 100,
      interval: 120,
      requireDocHost: true,
    });
    const opened = await req('POST', '/api/open', { path: doc });
    if (opened.status !== 200) {
      throw new Error(opened.body && opened.body.error || 'could not open Watch fixture');
    }

    browser = await Browser.launch({ headless: true });
    await browser.attachToPage();
    await browser.collectErrors();
    await browser.goto(`${BASE}/?watchMs=300`);
    await browser.waitFor('document.querySelectorAll(".para").length > 300', { timeout: 20000 });

    console.log('\n[opt-in capture]');
    check('watch begins off',
      await browser.eval(`document.getElementById('watch-toggle').getAttribute('aria-pressed')`) === 'false');
    check('the server begins without screening consent or a model process',
      (await req('GET', '/api/watch')).body.enabled === false &&
      (await req('GET', '/api/watch')).body.reviewer.running === false);
    await browser.eval(`(document.getElementById('watch-toggle').click(), true)`);
    await waitFor(async () =>
      (await req('GET', '/api/watch')).body.enabled === true &&
      await browser.eval(`(() => {
        const button = document.getElementById('watch-toggle');
        return button.getAttribute('aria-pressed') === 'true' && !button.disabled;
      })()`));
    check('the toggle arms a persistent continuous mode',
      await browser.eval(`document.getElementById('watch-toggle').dataset.state`) === 'armed' &&
      await browser.eval(`localStorage.getItem('scribe-watch')`) === 'on');
    check('arming alone does not start either model agent',
      (await req('GET', '/api/watch')).body.reviewer.running === false &&
      (await req('GET', '/api/agent')).body.running === false);

    const reconnectToggle = await browser.eval(`(async () => {
      const nativeFetch = window.fetch;
      let calls = 0;
      let release;
      window.fetch = (input, init = {}) => {
        const url = new URL(String(input), location.href);
        if (url.pathname === '/api/watch/enabled') {
          calls++;
          return new Promise((resolve) => {
            release = () => resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve({ enabled: false })
            });
          });
        }
        return nativeFetch(input, init);
      };
      document.getElementById('watch-toggle').click();
      connect();
      for (let i = 0; i < 50 && (!eventStream || eventStream.readyState !== 1); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const callsAfterReconnect = calls;
      release();
      for (let i = 0; i < 50 && document.getElementById('watch-toggle').disabled; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const pressed = document.getElementById('watch-toggle').getAttribute('aria-pressed');
      window.fetch = nativeFetch;
      document.getElementById('watch-toggle').click();
      for (let i = 0; i < 50 && document.getElementById('watch-toggle').disabled; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return { callsAfterReconnect, calls, pressed };
    })()`);
    await waitFor(async () => (await req('GET', '/api/watch')).body.enabled === true);
    check('a reconnect cannot queue stale consent behind a pending Watch toggle',
      reconnectToggle.callsAfterReconnect === 1 &&
      reconnectToggle.calls === 1 && reconnectToggle.pressed === 'false',
      JSON.stringify(reconnectToggle));

    await req('POST', '/api/watch/enabled', { enabled: false });
    check('a server reset cannot silently change the visible browser choice',
      await browser.eval(`document.getElementById('watch-toggle').getAttribute('aria-pressed')`) === 'true' &&
      (await req('GET', '/api/watch')).body.enabled === false);
    await browser.eval(`(connect(), true)`);
    await waitFor(async () => (await req('GET', '/api/watch')).body.enabled === true);
    check('an event-stream reconnect reasserts consent without starting a model',
      (await req('GET', '/api/watch')).body.reviewer.running === false &&
      (await req('GET', '/api/agent')).body.running === false);

    console.log('\n[fresh-browser consent sync]');
    freshBrowser = await Browser.launch({ headless: true });
    await freshBrowser.attachToPage();
    await freshBrowser.collectErrors();
    await freshBrowser.goto(`${BASE}/?watchMs=300`);
    await freshBrowser.waitFor('document.querySelectorAll(".para").length > 300',
      { timeout: 20000 });
    await waitFor(async () =>
      (await req('GET', '/api/watch')).body.enabled === true &&
      await freshBrowser.eval(`document.getElementById(
        'watch-toggle').getAttribute('aria-pressed')`) === 'true');
    check('a fresh browser adopts armed server consent instead of silently disarming it',
      (await req('GET', '/api/watch')).body.enabled === true &&
      await freshBrowser.eval(`localStorage.getItem('scribe-watch')`) === 'on');
    check('fresh-browser consent hydration starts no model process',
      (await req('GET', '/api/watch')).body.reviewer.running === false &&
      (await req('GET', '/api/agent')).body.running === false);
    freshBrowser.kill();
    freshBrowser = null;

    const model = (await req('GET', '/api/doc')).body;
    const target = model.paragraphs.find((p) => !p.table && p.text.length > 180);
    const deferredNote = await browser.eval(`(async () => {
      const el = document.querySelector('[data-pid="${target.pid}"]');
      el.focus();
      beginDirectEdit(el);
      const note = {
        id: 'focused-unchanged-note',
        status: 'open',
        anchor_pid: '${target.pid}',
        anchor_hash: ${JSON.stringify(target.hash)},
        kind: 'insight',
        title: 'Arrived while focused',
        text: 'This note should appear as soon as the unchanged paragraph loses focus.',
        at: new Date().toISOString()
      };
      renderAssist(note);
      const deferred = !document.querySelector(
        '.assist-note[data-assist="focused-unchanged-note"]') &&
        app.pendingAssist && app.pendingAssist.id === note.id;
      await saveDirectEdit(el);
      el.blur();
      for (let i = 0; i < 40 && !document.querySelector(
        '.assist-note[data-assist="focused-unchanged-note"]'); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const shown = !!document.querySelector(
        '.assist-note[data-assist="focused-unchanged-note"]');
      renderAssist({ ...note, status: 'dismissed' });
      return { deferred: !!deferred, shown, pending: !!app.pendingAssist };
    })()`);
    check('a Watch note deferred by focus appears after an unchanged blur',
      deferredNote.deferred && deferredNote.shown && !deferredNote.pending,
      JSON.stringify(deferredNote));

    await browser.eval(`(() => {
      window.__watchFetch = window.fetch;
      window.fetch = (...args) => {
        const url = new URL(args[0], location.href);
        if (url.pathname === '/api/watch/enabled') {
          return Promise.reject(new TypeError('simulated Watch consent transport failure'));
        }
        return window.__watchFetch(...args);
      };
      const pid = ${JSON.stringify(target.pid)};
      watch.changes.set(pid, {
        pid,
        before: ${JSON.stringify(target.text)},
        after: ${JSON.stringify(target.text + ' [pending watch batch]')}
      });
      document.querySelector('[data-pid="' + pid + '"]').classList.add('watch-captured');
      document.getElementById('watch-toggle').click();
      return true;
    })()`);
    await sleep(250);
    const refusedOff = await browser.eval(`(() => {
      const pid = ${JSON.stringify(target.pid)};
      const button = document.getElementById('watch-toggle');
      return {
        pressed: button.getAttribute('aria-pressed'),
        state: button.dataset.state,
        title: button.title,
        stored: localStorage.getItem('scribe-watch'),
        changes: watch.changes.size,
        captured: document.querySelector('[data-pid="' + pid + '"]')
          .classList.contains('watch-captured'),
        errors: [...(window.__errs || [])]
      };
    })()`);
    const refusedOffServer = (await req('GET', '/api/watch')).body;
    check('a failed Watch-off request keeps consent visible and preserves its captured batch',
      refusedOff.pressed === 'true' && refusedOff.state === 'capturing' &&
      refusedOff.stored === 'on' && refusedOff.changes === 1 &&
      refusedOff.captured && /unavailable|remains on/i.test(refusedOff.title || '') &&
      refusedOffServer.enabled === true,
      JSON.stringify({ browser: refusedOff, server: refusedOffServer }));
    check('a failed Watch-off request produces no unhandled browser error',
      refusedOff.errors.length === 0, JSON.stringify(refusedOff.errors));
    await browser.eval(`(() => {
      window.fetch = window.__watchFetch;
      delete window.__watchFetch;
      window.__errs = [];
      watch.enabled = true;
      storeWatchPreference();
      watch.changes.clear();
      document.querySelector(
        '[data-pid="${target.pid}"]').classList.remove('watch-captured');
      refreshWatchState();
      return true;
    })()`);

    const after = target.text + ' [watch change]';
    const capture = await browser.eval(`(() => {
      const el = document.querySelector('[data-pid="${target.pid}"]');
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      el.focus();
      el.textContent = ${JSON.stringify(after)};
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      return {
        state: document.getElementById('watch-toggle').dataset.state,
        captured: el.classList.contains('watch-captured')
      };
    })()`);
    check('the first keystroke starts one quiet-window change set',
      capture.state === 'capturing' && capture.captured, JSON.stringify(capture));
    check('capturing does not start the editing agent',
      (await req('GET', '/api/agent')).body.running === false);

    const review = await waitFor(async () => {
      const w = (await req('GET', '/api/watch')).body;
      return w.active || null;
    }, 12000);
    const saved = (await req('GET', '/api/doc')).body.paragraphs.find((p) => p.pid === target.pid);
    check('25 seconds of quiet (shortened in test) finalizes the typed paragraph',
      saved.text === after);
    check('the captured paragraph waits with a soft review marker',
      await browser.eval(`document.querySelector('[data-pid="${target.pid}"]').classList.contains('watch-reviewing')`) === true);
    check('the main editing agent is still completely untouched',
      (await req('GET', '/api/agent')).body.running === false);
    check('test mode holds a separate review without a reviewer process',
      review.id && (await req('GET', '/api/watch')).body.reviewer.running === false,
      review.id);
    const staleReviewFailure = await browser.eval(`(() => {
      onWatchEvent({
        kind: 'failed',
        id: 'retired-watch-review',
        pids: ['${target.pid}'],
        error: 'An older review failed.'
      });
      const result = {
        reviewing: document.querySelector('[data-pid="${target.pid}"]')
          .classList.contains('watch-reviewing'),
        status: !!document.querySelector('.sidecar-status[data-lane="watch"]'),
        current: window.__watch.activeReviews.has('${review.id}')
      };
      clearSidecarStatus('watch');
      return result;
    })()`);
    check('a late older Watch failure cannot cover a newer review with an error',
      staleReviewFailure.reviewing && staleReviewFailure.current &&
      staleReviewFailure.status === false,
      JSON.stringify(staleReviewFailure));

    console.log('\n[anchored read-only note]');
    const wrong = await req('POST', '/api/assist', {
      review_id: 'not-this-review',
      anchor_pid: target.pid,
      title: 'Wrong review',
      text: 'This must not attach.',
    });
    check('a note from any other session is refused', wrong.status === 400, wrong.body.error);

    const note = await req('POST', '/api/assist', {
      review_id: review.id,
      anchor_pid: target.pid,
      kind: 'answer',
      title: 'The likely missing link',
      text: 'The new claim appears to depend on the determinacy screen. You may want the exact count nearby before you continue.',
      grounding: [{
        claim: 'The audit reports the determinate-task count.',
        source: 'qcb_audit/REPORT.md',
        quote: '3 of 20 tasks',
      }],
    });
    check('the sidecar can attach one note without editing',
      note.status === 200 && note.body.anchor_pid === target.pid, note.body.error);
    await browser.waitFor(`document.querySelector('.assist-note[data-assist="${note.body.id}"]')`, { timeout: 8000 });

    const attachment = await browser.eval(`(() => {
      const p = document.querySelector('[data-pid="${target.pid}"]');
      const card = document.querySelector('.assist-note');
      const cs = getComputedStyle(card);
      return {
        adjacent: card.nextElementSibling === p,
        assisted: p.classList.contains('assisted'),
        text: card.textContent,
        role: card.getAttribute('role'),
        editable: card.getAttribute('contenteditable'),
        border: cs.borderLeftColor,
        glow: cs.boxShadow
      };
    })()`);
    check('the note is directly attached to the changed paragraph',
      attachment.adjacent && attachment.assisted, JSON.stringify(attachment));
    check('the answer and its source are both legible',
      /likely missing link/i.test(attachment.text) && /1 source/.test(attachment.text));
    check('the note itself can never become document text',
      attachment.role === 'note' && attachment.editable === 'false');
    const soundState = await browser.eval(`({
      plays: window.__sound.plays,
      last: window.__sound.last
    })`);
    check('a new watch note makes one short local chime',
      soundState.plays === 1 && soundState.last === 'watch', JSON.stringify(soundState));
    check('the note has a compact read-aloud control',
      await browser.eval(`!!document.querySelector('.assist-speak[aria-label*="Read"] svg')`) === true);
    await browser.eval(`(document.querySelector('.assist-speak').click(), true)`);
    check('pressing the sound icon reads that suggestion on demand',
      await browser.eval(`window.__speech.speaks === 1 &&
        window.__speech.last === ${JSON.stringify(`watch:${note.body.id}`)} &&
        /exact count nearby/.test(window.__speech.lastText)`) === true);
    check('the attachment uses the requested soft neon line and glow',
      attachment.glow !== 'none' && !/rgba\\(0, 0, 0, 0\\)/.test(attachment.border),
      `${attachment.border} / ${attachment.glow}`);
    const assistRace = await browser.eval(`(() => {
      const current = ${JSON.stringify(note.body)};
      const newer = {
        ...current,
        id: current.id + '-newer',
        at: new Date(Date.parse(current.at) + 1000).toISOString()
      };
      renderAssist(newer);
      renderAssist(current);
      const afterOlderOpen = document.querySelector('.assist-note');
      const olderOpenVisible = afterOlderOpen && afterOlderOpen.dataset.assist;
      renderAssist(newer);
      renderAssist({ ...current, status: 'dismissed' });
      const visible = document.querySelector('.assist-note');
      const result = {
        olderOpenVisible,
        visible: visible && visible.dataset.assist,
        open: openAssist && openAssist.id
      };
      renderAssist(null);
      renderAssist(current);
      return result;
    })()`);
    check('a late older Watch snapshot or terminal event cannot replace a newer one',
      assistRace.olderOpenVisible === `${note.body.id}-newer` &&
      assistRace.visible === `${note.body.id}-newer` &&
      assistRace.open === `${note.body.id}-newer`,
      JSON.stringify(assistRace));
    check('the exact typed addition gets the neon change treatment',
      await browser.eval(`!!document.querySelector('[data-pid="${target.pid}"] mark.watch-change')`) === true);
    check('attaching a note does not advance the document revision',
      (await req('GET', '/api/health')).body.rev === 1);
    check('the editing agent remains stopped after the note arrives',
      (await req('GET', '/api/agent')).body.running === false);

    const exceptionsBeforeDismiss = browser.exceptions.length;
    await browser.eval(`(() => {
      const nativeFetch = window.fetch.bind(window);
      window.__restoreAssistDismissFetch = () => { window.fetch = nativeFetch; };
      window.fetch = (input, init = {}) => {
        const url = new URL(String(input), location.href);
        if (url.pathname === '/api/assist/dismiss') {
          return Promise.reject(new TypeError('simulated watch dismiss transport failure'));
        }
        return nativeFetch(input, init);
      };
      document.querySelector('.assist-dismiss').click();
      return true;
    })()`);
    await sleep(250);
    await browser.eval(`(window.__restoreAssistDismissFetch(), true)`);
    const refusedDismiss = await browser.eval(`(() => {
      const card = document.querySelector('.assist-note');
      const status = card && card.querySelector('.assist-action-status');
      const dismiss = card && card.querySelector('.assist-dismiss');
      return {
        text: status && status.textContent,
        role: status && status.getAttribute('role'),
        error: card && card.dataset.error,
        dismissEnabled: !!dismiss && !dismiss.disabled
      };
    })()`);
    check('a failed Watch-note dismiss stays visible, explains itself, and can be retried',
      /not dismissed/i.test(refusedDismiss.text || '') &&
      /unavailable/i.test(refusedDismiss.text || '') &&
      refusedDismiss.role === 'status' &&
      refusedDismiss.error === 'true' && refusedDismiss.dismissEnabled,
      JSON.stringify(refusedDismiss));
    check('a failed Watch-note dismiss produces no unhandled browser error',
      browser.exceptions.length === exceptionsBeforeDismiss,
      browser.exceptions.slice(exceptionsBeforeDismiss).join(' | '));

    await browser.eval(`(document.querySelector('.assist-dismiss').click(), true)`);
    await browser.waitFor('!document.querySelector(".assist-note")');
    check('dismiss removes both the note and its paragraph treatment',
      await browser.eval(`!document.querySelector('[data-pid="${target.pid}"]').classList.contains('assisted')`) === true);

    console.log('\n[persistence and errors]');
    await browser.goto(`${BASE}/?watchMs=300`);
    await browser.waitFor('document.querySelectorAll(".para").length > 300', { timeout: 15000 });
    check('watch stays armed across a page reload',
      await browser.eval(`document.getElementById('watch-toggle').getAttribute('aria-pressed')`) === 'true');
    await browser.eval(`(document.getElementById('watch-toggle').click(), true)`);
    await waitFor(async () =>
      (await req('GET', '/api/watch')).body.enabled === false &&
      await browser.eval(`(() => {
        const button = document.getElementById('watch-toggle');
        return button.getAttribute('aria-pressed') === 'false' && !button.disabled;
      })()`));
    check('turning watch off persists too',
      await browser.eval(`localStorage.getItem('scribe-watch')`) === 'off');
    const off = (await req('GET', '/api/watch')).body;
    check('turning watch off cancels its work and leaves no screening process',
      off.enabled === false && off.reviewer.running === false &&
      off.active === null && off.pending.length === 0, JSON.stringify(off));

    console.log('\n[Watch now hotkey]');
    const recentModel = (await req('GET', '/api/doc')).body;
    const manualTarget = recentModel.paragraphs.find((p) =>
      p.pid !== target.pid && !p.table && p.text.length > 160);
    const manualAfter = manualTarget.text + ' [manual watch now]';
    const manualRev = (await req('GET', '/api/health')).body.rev;
    await browser.eval(`(() => {
      const el = document.querySelector('[data-pid="${manualTarget.pid}"]');
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      el.focus();
      el.textContent = ${JSON.stringify(manualAfter)};
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    })(), true`);
    await waitFor(async () => (await req('GET', '/api/health')).body.rev > manualRev, 8000);
    await browser.waitFor(`(() => {
      const el = document.querySelector('[data-pid="${manualTarget.pid}"]');
      const edit = directEdits.get(${JSON.stringify(manualTarget.pid)});
      return el.dataset.hash !== ${JSON.stringify(manualTarget.hash)} &&
        !el.classList.contains('saving') && (!edit || !edit.dirty);
    })()`,
      { timeout: 8000 });
    const beforeShortcut = (await req('GET', '/api/watch')).body;
    check('typing with Watch off saves without starting or queueing screening',
      beforeShortcut.enabled === false && beforeShortcut.reviewer.running === false &&
      beforeShortcut.active === null && beforeShortcut.pending.length === 0);
    check('Watch off captures no screening buffer',
      await browser.eval(`(() => {
        const batch = recentWatchBatch();
        return batch.length === 0 &&
          sessionStorage.getItem('scribe-watch-recent') === null;
      })()`) === true);
    await browser.goto(`${BASE}/?watchMs=300`);
    await browser.waitFor('document.querySelectorAll(".para").length > 300', { timeout: 15000 });
    check('a refresh while Watch is off restores no screening buffer',
      await browser.eval(`(() => {
        return recentWatchBatch().length === 0 &&
          sessionStorage.getItem('scribe-watch-recent') === null;
      })()`) === true &&
      (await req('GET', '/api/watch')).body.active === null);

    await browser.eval(`(document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'W', code: 'KeyW', altKey: true, shiftKey: true,
      bubbles: true, cancelable: true
    })), true)`);
    await sleep(120);
    const shortcutOff = (await req('GET', '/api/watch')).body;
    check('Alt+Shift+W does nothing while Watch is off',
      shortcutOff.enabled === false && shortcutOff.reviewer.running === false &&
      shortcutOff.active === null && shortcutOff.pending.length === 0);
    const manualOff = await req('POST', '/api/watch/review', {
      quietMs: 300,
      manual: true,
      changes: [{
        pid: manualTarget.pid,
        before: manualTarget.text,
        after: manualAfter,
      }],
    });
    check('the server rejects a direct manual review while Watch is off',
      manualOff.status === 409 &&
      /turn watch on/i.test(manualOff.body.error || ''), JSON.stringify(manualOff.body));
    check('the editing agent remains off throughout off-state typing and shortcuts',
      (await req('GET', '/api/agent')).body.running === false);

    await browser.eval(`(document.getElementById('watch-toggle').click(), true)`);
    await waitFor(async () =>
      (await req('GET', '/api/watch')).body.enabled === true &&
      await browser.eval(`(() => {
        const button = document.getElementById('watch-toggle');
        return button.getAttribute('aria-pressed') === 'true' && !button.disabled;
      })()`));
    const onModel = (await req('GET', '/api/doc')).body;
    const onTarget = onModel.paragraphs.find((p) =>
      p.pid !== target.pid && p.pid !== manualTarget.pid && !p.table && p.text.length > 160);
    const onAfter = onTarget.text + ' [watch now while armed]';
    await browser.eval(`(() => {
      const el = document.querySelector('[data-pid="${onTarget.pid}"]');
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      el.focus();
      el.textContent = ${JSON.stringify(onAfter)};
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'W', code: 'KeyW', altKey: true, shiftKey: true,
        bubbles: true, cancelable: true
      }));
    })(), true`);
    const armedManual = await waitFor(async () => {
      const w = (await req('GET', '/api/watch')).body;
      return w.active && w.active.manual ? w.active : null;
    }, 8000);
    check('the same shortcut flushes an armed Watch capture immediately',
      armedManual.pids.includes(onTarget.pid) &&
      (await req('GET', '/api/watch')).body.enabled === true);
    await waitFor(async () => (await req('GET', '/api/watch')).body.active === null, 5000);

    const continuedBefore = (await req('GET', '/api/doc')).body.paragraphs
      .find((p) => p.pid === onTarget.pid);
    const continuedAfter = continuedBefore.text + ' [fresh timer]';
    await browser.eval(`(() => {
      const el = document.querySelector('[data-pid="${onTarget.pid}"]');
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      el.focus();
      el.textContent = ${JSON.stringify(continuedAfter)};
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    })(), true`);
    const continued = await waitFor(async () => {
      const w = (await req('GET', '/api/watch')).body;
      return w.active && !w.active.manual ? w.active : null;
    }, 8000);
    check('after Watch now, continuous Watch starts a fresh quiet window',
      continued.pids.includes(onTarget.pid) && (await req('GET', '/api/watch')).body.enabled === true);
    await browser.eval(`(document.getElementById('watch-toggle').click(), true)`);
    await waitFor(async () =>
      (await req('GET', '/api/watch')).body.enabled === false &&
      await browser.eval(`(() => {
        const button = document.getElementById('watch-toggle');
        return button.getAttribute('aria-pressed') === 'false' && !button.disabled;
      })()`));

    console.log('\n[bounded screening lifetime]');
    await browser.eval(`(document.getElementById('watch-toggle').click(), true)`);
    await waitFor(async () =>
      (await req('GET', '/api/watch')).body.enabled === true &&
      await browser.eval(`(() => {
        const button = document.getElementById('watch-toggle');
        return button.getAttribute('aria-pressed') === 'true' && !button.disabled;
      })()`));
    const expiring = await req('POST', '/api/watch/review', {
      quietMs: 25000,
      changes: [{ pid: target.pid, before: target.text, after }],
    });
    check('an isolated review is accepted for the timeout test',
      expiring.status === 200 && !!expiring.body.id, expiring.body.error);
    await waitFor(async () => (await req('GET', '/api/watch')).body.active &&
      (await req('GET', '/api/watch')).body.active.id === expiring.body.id);
    await waitFor(async () => (await req('GET', '/api/watch')).body.active === null, 5000);
    const expired = (await req('GET', '/api/watch')).body;
    check('a slow screening review closes itself and leaves no process or queue',
      expired.enabled === true && expired.reviewer.running === false &&
      expired.active === null && expired.pending.length === 0, JSON.stringify(expired));
    check('the screening timeout never starts or stops the editing agent',
      (await req('GET', '/api/agent')).body.running === false);
    await browser.waitFor(`document.querySelector(
      '.sidecar-status[data-lane="watch"][data-error="true"]')`, { timeout: 5000 });
    const timeoutStatus = await browser.eval(`(() => {
      const anchor = document.querySelector('[data-pid="${target.pid}"]');
      const status = document.querySelector('.sidecar-status[data-lane="watch"]');
      return {
        before: status.nextElementSibling === anchor,
        text: status.textContent,
        editable: status.getAttribute('contenteditable'),
        dismiss: !!status.querySelector('.sidecar-status-dismiss')
      };
    })()`);
    check('a Watch timeout is explained beside the exact paragraph',
      timeoutStatus.before && /timed out/i.test(timeoutStatus.text) &&
      timeoutStatus.editable === 'false' && timeoutStatus.dismiss,
      JSON.stringify(timeoutStatus));
    await browser.eval(`(document.querySelector(
      '.sidecar-status[data-lane="watch"] .sidecar-status-dismiss').click(), true)`);
    check('the Watch explanation dismisses without affecting any model lane',
      !(await browser.eval(`!!document.querySelector('.sidecar-status[data-lane="watch"]')`)) &&
      (await req('GET', '/api/agent')).body.running === false &&
      (await req('GET', '/api/watch')).body.reviewer.running === false);
    await browser.eval(`(document.getElementById('watch-toggle').click(), true)`);
    await waitFor(async () =>
      (await req('GET', '/api/watch')).body.enabled === false &&
      await browser.eval(`(() => {
        const button = document.getElementById('watch-toggle');
        return button.getAttribute('aria-pressed') === 'false' && !button.disabled;
      })()`));

    const errors = await browser.eval('JSON.stringify(window.__errs || null)');
    check('the whole flow logs no page errors', errors === '[]', errors);
    check('the browser throws no uncaught exceptions', browser.exceptions.length === 0,
      browser.exceptions.slice(0, 2).join(' | '));
  } catch (e) {
    console.error('\nTEST ERROR:', e && e.stack || e);
    hardFail = true;
  } finally {
    if (freshBrowser) freshBrowser.kill();
    if (browser) browser.kill();
    server.kill();
    await sleep(800);
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(TMP, { recursive: true, force: true }); break; }
      catch (_) { await sleep(300); }
    }
  }

  console.log(`\n${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) {
    console.log('failed: ' + FAIL.join(', '));
    console.log('\n--- server log ---\n' + logs.join('').slice(-3000));
  }
  process.exit(FAIL.length || hardFail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
