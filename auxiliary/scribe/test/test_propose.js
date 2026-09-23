#!/usr/bin/env node
'use strict';
/**
 * The grounded drafting flow, end to end minus the model.
 *
 * The invariant under test, above everything else: PROPOSING WRITES NOTHING.
 * A proposal must be visible, comparable, and completely inert until the human
 * picks one. Several assertions below exist only to prove the document did not
 * move.
 *
 * Run: node test/test_propose.js
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
const TMP = path.join(__dirname, '_tmp_prop');
const SRC = requiredLiveFile('SCRIBE_TEST_DOCX');

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
  if (!findBrowser()) { console.log('No browser found, skipping.'); process.exit(0); }
  PORT = await availablePort();
  BASE = `http://127.0.0.1:${PORT}`;

  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'data', 'documents'), { recursive: true });
  const doc = path.join(TMP, 'data', 'documents', 'paper.docx');
  fs.copyFileSync(SRC, doc);

  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SCRIBE_PORT: String(PORT),
      SCRIBE_DATA: path.join(TMP, 'data'),
      SCRIBE_TRANSACTION_TEST: '1',
      SCRIBE_RUNTIME_TEST: '1',
    },
  });
  const srvLog = [];
  srv.stdout.on('data', (d) => srvLog.push(d.toString()));
  srv.stderr.on('data', (d) => srvLog.push(d.toString()));

  let browser = null, hardFail = false;
  try {
    await waitForOwnedHealth(() => req('GET', '/api/health'), srv, {
      attempts: 120,
      interval: 100,
      requireDocHost: true,
    });
    const opened = await req('POST', '/api/open', { path: doc });
    if (opened.status !== 200) {
      throw new Error(`could not open proposal fixture: ${
        opened.body && opened.body.error || opened.status}`);
    }

    browser = await Browser.launch({ headless: true });
    await browser.attachToPage();
    await browser.collectErrors();
    await browser.goto(BASE + '/');
    await browser.waitFor('document.querySelectorAll(".para").length > 300', { timeout: 20000 });

    const model = (await req('GET', '/api/doc')).body;
    const target = model.paragraphs.find((p) => p.text.length > 260 && !p.table);
    const phrase = target.text.slice(20, 58);
    const docBefore = fs.readFileSync(doc);

    const proposal = {
      anchor_pid: target.pid, mode: 'replace', find: phrase,
      intent: 'Say what the determinacy screen actually found',
      options: [
        { text: 'Only 3 of 20 tasks were determinate.', note: 'tight' },
        { text: 'The screen found 3 of 20 tasks determinate, and the advisory pass predicted 1.', note: 'names both numbers' },
        { text: 'Few tasks were determinate.', note: 'hedged, no numbers' },
      ],
      grounding: [
        { claim: '3 of 20 is the final empirical metric', source: 'qcb_audit/REPORT.md', quote: '3 of 20 tasks determinate' },
        { claim: '1 of 20 was the advisory screen prediction only', source: 'metric1.json', quote: 'advisory: 1' },
      ],
    };

    console.log('\n[a proposal appears and writes nothing]');
    const made = await req('POST', '/api/propose', { proposal });
    check('proposal accepted by the server', made.status === 200 && made.body.id, JSON.stringify(made.body).slice(0, 80));
    check('proposal stores the authoritative anchor hash',
      made.body.anchor_hash === target.hash, made.body.anchor_hash);
    check('options get stable ids A B C', (made.body.options || []).map((o) => o.id).join('') === 'ABC',
      (made.body.options || []).map((o) => o.id).join(''));

    await browser.waitFor('!document.getElementById("proposal").hidden', { timeout: 8000 });
    check('cards are on screen', (await browser.eval('document.querySelectorAll("#opts .opt").length')) === 3);
    check('the intent is shown',
      /determinacy screen/.test(await browser.eval(`document.getElementById('prop-intent').textContent`)));
    check('each card shows its letter',
      (await browser.eval(`[...document.querySelectorAll('#opts .key')].map(e=>e.textContent).join('')`)) === 'ABC');
    check('each card shows its note',
      /names both numbers/.test(await browser.eval(`document.getElementById('opts').textContent`)));
    check('grounding is shown with its sources',
      /qcb_audit\/REPORT\.md/.test(await browser.eval(`document.getElementById('ground-list').textContent`)));
    check('  and the verbatim quote',
      /3 of 20 tasks determinate/.test(await browser.eval(`document.getElementById('ground-list').textContent`)));
    check('the anchor paragraph is marked in the document',
      (await browser.eval(`document.querySelectorAll('.para.anchored').length`)) === 1);

    // The whole point.
    check('THE DOCUMENT DID NOT CHANGE', Buffer.compare(docBefore, fs.readFileSync(doc)) === 0);
    check('  no edit was broadcast', (await req('GET', '/api/trail')).body.trail.every((t) => t.op !== 'replace'));
    const revAfterPropose = (await req('GET', '/api/health')).body.rev;
    check('  the revision did not move', revAfterPropose === 0, revAfterPropose);

    console.log('\n[an ungrounded proposal says so out loud]');
    await req('POST', '/api/propose', { proposal: { ...proposal, grounding: [] } });
    await sleep(400);
    check('warns when nothing was cited',
      /no sources cited/.test(await browser.eval(`document.getElementById('ground-n').textContent`)),
      await browser.eval(`document.getElementById('ground-n').textContent`));
    check('  and marks it as suspect',
      await browser.eval(`document.getElementById('grounding').classList.contains('empty')`));

    console.log('\n[only one proposal is live at a time]');
    const openNow = (await req('GET', '/api/proposals')).body.proposals;
    check('the earlier one was superseded', openNow.length === 1, openNow.length);

    console.log('\n[proposal reconnect recovery]');
    await browser.eval(`window.__feed('proposal', {
      ...${JSON.stringify(openNow[0])},
      status: 'dismissed'
    }), true`);
    await browser.waitFor('document.getElementById("proposal").hidden', { timeout: 3000 });
    await browser.eval('(connect(), true)');
    await browser.waitFor(`!document.getElementById("proposal").hidden &&
      document.getElementById("prop-intent").textContent ===
        ${JSON.stringify(openNow[0].intent)}`, { timeout: 5000 });
    check('reconnecting restores the authoritative open proposal',
      await browser.eval(`!document.getElementById('proposal').hidden &&
        document.getElementById('prop-intent').textContent ===
          ${JSON.stringify(openNow[0].intent)}`) === true);

    const staleProposalSnapshot = await browser.eval(`(async () => {
      const authoritative = ${JSON.stringify(openNow[0])};
      const newer = JSON.parse(JSON.stringify(authoritative));
      newer.id = 'viewer-newer-live-proposal';
      newer.status = 'open';
      newer.intent = 'A newer live proposal must win';
      const nativeFetch = window.fetch;
      let releaseSnapshot = null;
      let snapshotCalls = 0;
      window.fetch = (input, init = {}) => {
        const url = new URL(String(input), location.href);
        if (url.pathname !== '/api/proposals') return nativeFetch(input, init);
        snapshotCalls++;
        return new Promise((resolve) => {
          releaseSnapshot = () => resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ proposals: [authoritative] })
          });
        });
      };

      connect();
      for (let i = 0; i < 100 && !releaseSnapshot; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      for (let i = 0; i < 100 &&
          document.getElementById('prop-intent').textContent !== authoritative.intent; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      window.__feed('proposal', newer);
      for (let i = 0; i < 100 &&
          document.getElementById('prop-intent').textContent !== newer.intent; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (releaseSnapshot) releaseSnapshot();
      await new Promise((resolve) => setTimeout(resolve, 120));
      const result = {
        snapshotCalls,
        hadDelayedSnapshot: !!releaseSnapshot,
        intent: document.getElementById('prop-intent').textContent,
        visible: !document.getElementById('proposal').hidden
      };
      window.fetch = nativeFetch;
      window.__feed('proposal', authoritative);
      await new Promise((resolve) => requestAnimationFrame(() =>
        requestAnimationFrame(resolve)));
      return result;
    })()`);
    check('an older delayed reconnect snapshot cannot replace a newer live proposal',
      staleProposalSnapshot.snapshotCalls === 1 &&
      staleProposalSnapshot.hadDelayedSnapshot &&
      staleProposalSnapshot.visible &&
      staleProposalSnapshot.intent === 'A newer live proposal must win',
      JSON.stringify(staleProposalSnapshot));

    console.log('\n[saying "the second one" applies it, with no model call]');
    const say = await req('POST', '/api/say', { text: 'the second one' });
    check('resolved as an acceptance', say.body.resolved === 'accept', JSON.stringify(say.body).slice(0, 120));
    check('  picked B', say.body.option === 'B', say.body.option);
    await sleep(600);
    const after = (await req('GET', '/api/doc')).body;
    const anchored = after.paragraphs.find((p) => p.pid === target.pid);
    check('the chosen text is now in the document',
      anchored.text.includes('The screen found 3 of 20 tasks determinate'), anchored.text.slice(0, 70));
    check('the document file changed this time', Buffer.compare(docBefore, fs.readFileSync(doc)) !== 0);
    check('it is in the trail as an edit',
      (await req('GET', '/api/trail')).body.trail.some((t) => /accepted option B/.test(t.why || '')));
    check('a locally resolved acceptance starts no model process',
      (await req('GET', '/api/agent')).body.running === false);

    await browser.waitFor('document.getElementById("proposal").hidden', { timeout: 5000 });
    await browser.waitFor(
      'document.querySelectorAll(".para.anchored").length === 0',
      { timeout: 5000 },
    );
    check('the cards clear once chosen', true);
    check('the anchor marker is cleared',
      (await browser.eval(`document.querySelectorAll('.para.anchored').length`)) === 0);

    console.log('\n[accepting is undoable like any other edit]');
    const u = await req('POST', '/api/undo');
    check('undo works', u.status === 200, u.body.error);
    const back = (await req('GET', '/api/doc')).body.paragraphs.find((p) => p.pid === target.pid);
    check('the accepted text is gone again', !back.text.includes('The screen found 3 of 20'));

    console.log('\n[a modified acceptance is NEVER applied locally]');
    await req('POST', '/api/propose', { proposal });
    await sleep(300);
    const docBefore2 = fs.readFileSync(doc);
    const mod = await req('POST', '/api/say', { text: 'B but drop the second clause' });
    check('routed as a modification', mod.body.resolved === 'modify', JSON.stringify(mod.body).slice(0, 100));
    check('  it names the option', mod.body.option === 'B', mod.body.option);
    await sleep(500);
    check('THE DOCUMENT STILL DID NOT CHANGE (no local rewriting)',
      Buffer.compare(docBefore2, fs.readFileSync(doc)) === 0);
    await req('POST', '/api/agent/stop');
    await sleep(200);

    console.log('\n[dismissal]');
    await req('POST', '/api/propose', { proposal });
    await sleep(300);
    const dis = await req('POST', '/api/say', { text: 'none of those' });
    check('resolved as a dismissal', dis.body.resolved === 'dismiss', JSON.stringify(dis.body).slice(0, 90));
    await sleep(400);
    check('cards clear on dismissal', await browser.eval('document.getElementById("proposal").hidden') === true);
    check('and nothing was written', (await req('GET', '/api/proposals')).body.proposals.length === 0);
    check('a locally resolved dismissal starts no model process',
      (await req('GET', '/api/agent')).body.running === false);

    console.log('\n[an unrelated message passes straight through]');
    await req('POST', '/api/propose', { proposal });
    await sleep(300);
    const pass = await req('POST', '/api/say', { text: 'what did the audit actually find about the judge' });
    check('not treated as a choice', pass.body.resolved === undefined, JSON.stringify(pass.body).slice(0, 90));
    check('the cards stay up', (await req('GET', '/api/proposals')).body.proposals.length === 1);

    console.log('\n[clicking a card works too]');
    await browser.eval(`(() => {
      window.__proposalFetch = window.fetch;
      window.__dismissCalls = 0;
      window.__dismissRejects = [];
      window.fetch = (...args) => {
        const url = new URL(args[0], location.href);
        if (url.pathname === '/api/dismiss') {
          window.__dismissCalls++;
          return new Promise((resolve, reject) => {
            window.__dismissRejects.push(reject);
          });
        }
        return window.__proposalFetch(...args);
      };
      const dismiss = document.getElementById('prop-dismiss');
      dismiss.click();
      dismiss.click();
      return true;
    })()`);
    await sleep(100);
    const pendingDismiss = await browser.eval(`({
      calls: window.__dismissCalls,
      optionsDisabled: [...document.querySelectorAll('#opts .opt')]
        .every((button) => button.disabled),
      dismissDisabled: document.getElementById('prop-dismiss').disabled
    })`);
    check('rapid proposal dismissal submits only one operation',
      pendingDismiss.calls === 1 && pendingDismiss.optionsDisabled &&
      pendingDismiss.dismissDisabled,
      JSON.stringify(pendingDismiss));
    await browser.eval(`(() => {
      for (const reject of window.__dismissRejects) {
        reject(new TypeError('simulated proposal dismissal transport failure'));
      }
      return true;
    })()`);
    await sleep(120);
    const failedDismiss = await browser.eval(`(() => ({
      visible: !document.getElementById('proposal').hidden,
      intent: document.getElementById('prop-intent').textContent,
      error: document.getElementById('proposal').dataset.actionError,
      optionsEnabled: [...document.querySelectorAll('#opts .opt')]
        .every((button) => !button.disabled),
      dismissEnabled: !document.getElementById('prop-dismiss').disabled,
      errors: [...(window.__errs || [])]
    }))()`);
    check('a failed dismissal keeps the proposal visible, explained, and retryable',
      failedDismiss.visible && failedDismiss.error === 'true' &&
      /not dismissed|unavailable|failure/i.test(failedDismiss.intent || '') &&
      failedDismiss.optionsEnabled && failedDismiss.dismissEnabled,
      JSON.stringify(failedDismiss));
    check('a failed dismissal produces no unhandled browser error',
      failedDismiss.errors.length === 0, JSON.stringify(failedDismiss.errors));
    await browser.eval(`(() => {
      window.fetch = window.__proposalFetch;
      delete window.__proposalFetch;
      delete window.__dismissCalls;
      delete window.__dismissRejects;
      window.__errs = [];
      return true;
    })()`);
    await browser.eval(`(() => {
      window.__proposalFetch = window.fetch;
      window.__acceptCalls = 0;
      window.__acceptRejects = [];
      window.fetch = (...args) => {
        const url = new URL(args[0], location.href);
        if (url.pathname === '/api/accept') {
          window.__acceptCalls++;
          return new Promise((resolve, reject) => {
            window.__acceptRejects.push(reject);
          });
        }
        return window.__proposalFetch(...args);
      };
      const option = document.querySelector('#opts .opt[data-opt="C"]');
      option.click();
      option.click();
      return true;
    })()`);
    await sleep(100);
    const pendingAccept = await browser.eval(`({
      calls: window.__acceptCalls,
      optionsDisabled: [...document.querySelectorAll('#opts .opt')]
        .every((button) => button.disabled),
      dismissDisabled: document.getElementById('prop-dismiss').disabled
    })`);
    check('rapid proposal acceptance submits only one document operation',
      pendingAccept.calls === 1 && pendingAccept.optionsDisabled &&
      pendingAccept.dismissDisabled,
      JSON.stringify(pendingAccept));
    await browser.eval(`(() => {
      for (const reject of window.__acceptRejects) {
        reject(new TypeError('simulated proposal acceptance transport failure'));
      }
      return true;
    })()`);
    await sleep(120);
    const failedAccept = await browser.eval(`(() => ({
      visible: !document.getElementById('proposal').hidden,
      intent: document.getElementById('prop-intent').textContent,
      error: document.getElementById('proposal').dataset.actionError,
      optionsEnabled: [...document.querySelectorAll('#opts .opt')]
        .every((button) => !button.disabled),
      dismissEnabled: !document.getElementById('prop-dismiss').disabled,
      errors: [...(window.__errs || [])]
    }))()`);
    check('a failed acceptance keeps the proposal visible, explained, and retryable',
      failedAccept.visible && failedAccept.error === 'true' &&
      /not accepted|unavailable|failure/i.test(failedAccept.intent || '') &&
      failedAccept.optionsEnabled && failedAccept.dismissEnabled,
      JSON.stringify(failedAccept));
    check('a failed acceptance produces no unhandled browser error',
      failedAccept.errors.length === 0, JSON.stringify(failedAccept.errors));
    await browser.eval(`(() => {
      window.fetch = window.__proposalFetch;
      delete window.__proposalFetch;
      delete window.__acceptCalls;
      delete window.__acceptRejects;
      window.__errs = [];
      return true;
    })()`);

    const delayedProposalAccept = await browser.eval(`(async () => {
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const authoritative = clone(openProp);
      const synthetic = {
        ...authoritative,
        id: authoritative.id + '-delayed-model',
        at: new Date(Date.parse(authoritative.at || Date.now()) + 1000)
          .toISOString()
      };
      const selected = synthetic.options.find((option) => option.id === 'C');
      const baseModel = clone(window.__scribe.model);
      const acceptedModel = clone(baseModel);
      const anchor = acceptedModel.paragraphs.find(
        (paragraph) => paragraph.pid === synthetic.anchor_pid);
      const expectedText = anchor.text.replace(synthetic.find, selected.text);
      anchor.text = expectedText;
      anchor.hash = 'viewer-delayed-proposal-hash';
      anchor.runs = [{ text: expectedText }];
      acceptedModel.rev = Number(baseModel.rev || 0) + 1;
      renderProposal(synthetic);

      const nativeFetch = window.fetch;
      let releaseDoc = null;
      let docReads = 0;
      window.fetch = (input, init = {}) => {
        const url = new URL(String(input), location.href);
        if (url.pathname === '/api/accept') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({
              accepted: 'C',
              proposal: synthetic.id,
              result: {
                pid: synthetic.anchor_pid,
                after: expectedText
              }
            })
          });
        }
        if (url.pathname === '/api/doc') {
          docReads++;
          return new Promise((resolve) => {
            releaseDoc = () => resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve(acceptedModel)
            });
          });
        }
        return nativeFetch(input, init);
      };

      document.querySelector('#opts .opt[data-opt="C"]').click();
      for (let i = 0; i < 100 && !releaseDoc; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // The accepted SSE often precedes /api/doc. It must not create a blank
      // gap while the accepted model is still being read.
      renderProposal({ ...synthetic, status: 'accepted', accepted: 'C' });
      const panel = document.getElementById('proposal');
      const during = {
        visible: !panel.hidden,
        intent: document.getElementById('prop-intent').textContent,
        exactOptions: document.getElementById('opts').textContent,
        expectedOptions: synthetic.options
          .map((option) => option.id + option.text + (option.note || '')).join(''),
        taken: document.querySelector('#opts .opt[data-opt="C"]')
          ?.dataset.taken,
        optionsDisabled: [...document.querySelectorAll('#opts .opt')]
          .every((button) => button.disabled),
        dismissDisabled: document.getElementById('prop-dismiss').disabled
      };
      await new Promise((resolve) => setTimeout(resolve, 80));
      const stayedVisible = !panel.hidden;
      releaseDoc();
      for (let i = 0; i < 200 && !panel.hidden; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const shown = document.querySelector(
        '[data-pid="' + synthetic.anchor_pid + '"]');
      const result = {
        during,
        stayedVisible,
        retired: panel.hidden,
        shown: shown && shown.textContent,
        expectedText,
        docReads
      };
      window.fetch = nativeFetch;
      applyModel(baseModel);
      window.__scribe.rev = baseModel.rev;
      clearSidecarStatus('proposal');
      renderProposal(authoritative);
      return result;
    })()`);
    check('an accepted proposal card stays exact and busy through a delayed model read',
      delayedProposalAccept.during.visible &&
      /accepted.*refreshing/i.test(delayedProposalAccept.during.intent || '') &&
      delayedProposalAccept.during.exactOptions ===
        delayedProposalAccept.during.expectedOptions &&
      delayedProposalAccept.during.taken === 'true' &&
      delayedProposalAccept.during.optionsDisabled &&
      delayedProposalAccept.during.dismissDisabled &&
      delayedProposalAccept.stayedVisible,
      JSON.stringify(delayedProposalAccept));
    check('the proposal retires only after its exact authoritative edit is painted',
      delayedProposalAccept.retired &&
      delayedProposalAccept.shown === delayedProposalAccept.expectedText &&
      delayedProposalAccept.docReads === 1,
      JSON.stringify(delayedProposalAccept));

    const lostProposalAcceptAck = await browser.eval(`(async () => {
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const authoritative = clone(openProp);
      const synthetic = {
        ...authoritative,
        id: authoritative.id + '-lost-accept-ack',
        at: new Date(Date.parse(authoritative.at || Date.now()) + 1500)
          .toISOString()
      };
      const selected = synthetic.options.find((option) => option.id === 'C');
      const baseModel = clone(window.__scribe.model);
      const acceptedModel = clone(baseModel);
      const anchor = acceptedModel.paragraphs.find(
        (paragraph) => paragraph.pid === synthetic.anchor_pid);
      const expectedText = anchor.text.replace(synthetic.find, selected.text);
      anchor.text = expectedText;
      anchor.hash = 'viewer-lost-proposal-ack-hash';
      anchor.runs = [{ text: expectedText }];
      acceptedModel.rev = Number(baseModel.rev || 0) + 1;
      renderProposal(synthetic);

      const nativeFetch = window.fetch;
      let releaseDoc = null;
      let docReads = 0;
      let snapshots = 0;
      window.fetch = (input, init = {}) => {
        const url = new URL(String(input), location.href);
        if (url.pathname === '/api/accept') {
          return Promise.reject(new TypeError('simulated lost proposal response'));
        }
        if (url.pathname === '/api/proposals') {
          snapshots++;
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({
              document_token: baseModel.document_token,
              // Intentionally stale: this cheap state read raced ahead of the
              // document commit, while /api/doc below observes the commit.
              proposals: [synthetic]
            })
          });
        }
        if (url.pathname === '/api/doc') {
          docReads++;
          return new Promise((resolve) => {
            releaseDoc = () => resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve(acceptedModel)
            });
          });
        }
        return nativeFetch(input, init);
      };
      document.querySelector('#opts .opt[data-opt="C"]').click();
      for (let i = 0; i < 100 && !releaseDoc; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const panel = document.getElementById('proposal');
      const during = {
        visible: !panel.hidden,
        intent: document.getElementById('prop-intent').textContent,
        optionsDisabled: [...document.querySelectorAll('#opts .opt')]
          .every((button) => button.disabled),
        dismissDisabled: document.getElementById('prop-dismiss').disabled
      };
      await new Promise((resolve) => setTimeout(resolve, 50));
      const stayedVisible = !panel.hidden;
      releaseDoc();
      for (let i = 0; i < 200 && !panel.hidden; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const shown = document.querySelector(
        '[data-pid="' + synthetic.anchor_pid + '"]');
      const result = {
        during,
        stayedVisible,
        retired: panel.hidden,
        shown: shown && shown.textContent,
        expectedText,
        snapshots,
        docReads
      };
      window.fetch = nativeFetch;
      applyModel(baseModel);
      window.__scribe.rev = baseModel.rev;
      clearSidecarStatus('proposal');
      renderProposal(authoritative);
      return result;
    })()`);
    check('a lost proposal acknowledgement keeps the exact card visible and busy through reconciliation',
      lostProposalAcceptAck.during.visible &&
      /checking.*accepted/i.test(lostProposalAcceptAck.during.intent || '') &&
      lostProposalAcceptAck.during.optionsDisabled &&
      lostProposalAcceptAck.during.dismissDisabled &&
      lostProposalAcceptAck.stayedVisible,
      JSON.stringify(lostProposalAcceptAck));
    check('a committed model outranks a racing pre-commit open-proposal snapshot before retiring',
      lostProposalAcceptAck.retired &&
      lostProposalAcceptAck.shown === lostProposalAcceptAck.expectedText &&
      lostProposalAcceptAck.snapshots === 1 &&
      lostProposalAcceptAck.docReads === 1,
      JSON.stringify(lostProposalAcceptAck));

    const failedProposalRefresh = await browser.eval(`(async () => {
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const authoritative = clone(openProp);
      const synthetic = {
        ...authoritative,
        id: authoritative.id + '-refresh-failure',
        at: new Date(Date.parse(authoritative.at || Date.now()) + 2000)
          .toISOString()
      };
      const beforeModel = window.__scribe.model;
      const beforeRev = window.__scribe.rev;
      renderProposal(synthetic);
      const nativeFetch = window.fetch;
      let docReads = 0;
      window.fetch = (input, init = {}) => {
        const url = new URL(String(input), location.href);
        if (url.pathname === '/api/accept') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({
              accepted: 'C',
              proposal: synthetic.id,
              result: { ok: true }
            })
          });
        }
        if (url.pathname === '/api/doc') {
          docReads++;
          return Promise.resolve({ ok: false, status: 503 });
        }
        return nativeFetch(input, init);
      };
      document.querySelector('#opts .opt[data-opt="C"]').click();
      const panel = document.getElementById('proposal');
      for (let i = 0; i < 200 && (
        !panel.hidden ||
        !document.querySelector('.sidecar-status[data-lane="proposal"]')
      ); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const status = document.querySelector(
        '.sidecar-status[data-lane="proposal"]');
      const result = {
        retired: panel.hidden,
        status: status && status.textContent,
        role: status && status.getAttribute('role'),
        error: status && status.dataset.error,
        docReads,
        sameModel: window.__scribe.model === beforeModel,
        retryable: !panel.hidden && [...document.querySelectorAll('#opts .opt')]
          .some((button) => !button.disabled)
      };
      window.fetch = nativeFetch;
      window.__scribe.rev = beforeRev;
      clearSidecarStatus('proposal');
      renderProposal(authoritative);
      return result;
    })()`);
    check('a confirmed proposal with failed refresh retires to pending status, not retry',
      failedProposalRefresh.retired &&
      /accepted.*refresh pending/i.test(failedProposalRefresh.status || '') &&
      failedProposalRefresh.role === 'status' &&
      failedProposalRefresh.error === 'false' &&
      failedProposalRefresh.docReads === 1 &&
      failedProposalRefresh.sameModel &&
      !failedProposalRefresh.retryable,
      JSON.stringify(failedProposalRefresh));

    const droppedStaleProposalEvent = await browser.eval(`(async () => {
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const authoritative = clone(openProp);
      const synthetic = {
        ...authoritative,
        id: authoritative.id + '-stale-without-event',
        at: new Date(Date.parse(authoritative.at || Date.now()) + 3000)
          .toISOString()
      };
      const beforeModel = window.__scribe.model;
      renderProposal(synthetic);
      const nativeFetch = window.fetch;
      let snapshots = 0;
      window.fetch = (input, init = {}) => {
        const url = new URL(String(input), location.href);
        if (url.pathname === '/api/accept') {
          return Promise.resolve({
            ok: false,
            status: 409,
            json: () => Promise.resolve({
              error: 'The proposal anchor changed.'
            })
          });
        }
        if (url.pathname === '/api/proposals') {
          snapshots++;
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ proposals: [] })
          });
        }
        return nativeFetch(input, init);
      };
      document.querySelector('#opts .opt[data-opt="C"]').click();
      for (let i = 0; i < 100 &&
           !document.getElementById('proposal').hidden; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const result = {
        hidden: document.getElementById('proposal').hidden,
        open: openProp && openProp.id,
        snapshots,
        sameModel: window.__scribe.model === beforeModel
      };
      window.fetch = nativeFetch;
      renderProposal(authoritative);
      return result;
    })()`);
    check('a failed stale acceptance resyncs and retires a card despite a dropped SSE',
      droppedStaleProposalEvent.hidden &&
      !droppedStaleProposalEvent.open &&
      droppedStaleProposalEvent.snapshots === 1 &&
      droppedStaleProposalEvent.sameModel,
      JSON.stringify(droppedStaleProposalEvent));

    const newerProposalDuringFailureSync = await browser.eval(`(async () => {
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const authoritative = clone(openProp);
      const stale = {
        ...authoritative,
        id: authoritative.id + '-stale-before-newer',
        at: new Date(Date.parse(authoritative.at || Date.now()) + 4000)
          .toISOString()
      };
      const newer = {
        ...authoritative,
        id: authoritative.id + '-newer-during-sync',
        intent: 'newer proposal must survive stale acceptance sync',
        at: new Date(Date.parse(authoritative.at || Date.now()) + 5000)
          .toISOString()
      };
      renderProposal(stale);
      const nativeFetch = window.fetch;
      let releaseSnapshot = null;
      window.fetch = (input, init = {}) => {
        const url = new URL(String(input), location.href);
        if (url.pathname === '/api/accept') {
          return Promise.resolve({
            ok: false,
            status: 409,
            json: () => Promise.resolve({ error: 'stale proposal' })
          });
        }
        if (url.pathname === '/api/proposals') {
          return new Promise((resolve) => {
            releaseSnapshot = () => resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve({ proposals: [] })
            });
          });
        }
        return nativeFetch(input, init);
      };
      document.querySelector('#opts .opt[data-opt="C"]').click();
      for (let i = 0; i < 100 && !releaseSnapshot; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      window.__feed('proposal', newer);
      releaseSnapshot();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const result = {
        visible: !document.getElementById('proposal').hidden,
        open: openProp && openProp.id,
        intent: document.getElementById('prop-intent').textContent,
        enabled: [...document.querySelectorAll('#opts .opt')]
          .every((button) => !button.disabled)
      };
      window.fetch = nativeFetch;
      renderProposal(authoritative);
      return result;
    })()`);
    check('a stale acceptance snapshot cannot erase a newer live proposal',
      newerProposalDuringFailureSync.visible &&
      /newer proposal must survive/.test(
        newerProposalDuringFailureSync.intent || '') &&
      /-newer-during-sync$/.test(newerProposalDuringFailureSync.open || '') &&
      newerProposalDuringFailureSync.enabled,
      JSON.stringify(newerProposalDuringFailureSync));

    await browser.waitFor('proposalPosting === false', { timeout: 5000 });
    await browser.eval(`(document.querySelector('#opts .opt[data-opt="C"]').click(), true)`);
    await browser.waitFor('proposalPosting === false', { timeout: 5000 });
    const c = (await req('GET', '/api/doc')).body.paragraphs.find((p) => p.pid === target.pid);
    check('clicking applied option C', c.text.includes('Few tasks were determinate'), c.text.slice(0, 60));

    console.log('\n[concurrent server acceptance]');
    const concurrentText = 'Exactly one concurrent proposal insertion fixture.';
    const proposalModelBefore = (await req('GET', '/api/doc')).body;
    const proposalRevBefore = (await req('GET', '/api/health')).body.rev;
    const concurrentProposal = await req('POST', '/api/propose', {
      proposal: {
        anchor_pid: target.pid,
        mode: 'insert',
        intent: 'concurrent acceptance fixture',
        options: [
          { text: concurrentText },
          { text: 'Unused concurrent proposal alternative.' },
        ],
      },
    });
    const firstConcurrentAccept = req('POST', '/api/accept', {
      id: concurrentProposal.body.id,
      option: 'A',
      who: 'human',
      __test_delay_after_mutation_ms: 500,
    });
    await sleep(100);
    const secondConcurrentAccept = await req('POST', '/api/accept', {
      id: concurrentProposal.body.id,
      option: 'A',
      who: 'human',
    });
    const acceptedConcurrent = await firstConcurrentAccept;
    const proposalModelAfter = (await req('GET', '/api/doc')).body;
    check('two concurrent accepts permit one commit and refuse the other',
      concurrentProposal.status === 200 &&
      acceptedConcurrent.status === 200 &&
      secondConcurrentAccept.status === 409 &&
      /in progress/i.test(secondConcurrentAccept.body.error || ''),
      `${acceptedConcurrent.status}/${secondConcurrentAccept.status}: ` +
        `${secondConcurrentAccept.body.error || ''}`);
    check('the concurrent insert appears exactly once and advances one revision',
      proposalModelAfter.count === proposalModelBefore.count + 1 &&
      proposalModelAfter.rev === proposalRevBefore + 1 &&
      proposalModelAfter.paragraphs.filter((paragraph) =>
        paragraph.text === concurrentText).length === 1,
      `${proposalModelBefore.count}->${proposalModelAfter.count}, ` +
        `rev ${proposalRevBefore}->${proposalModelAfter.rev}`);
    const concurrentUndo = await req('POST', '/api/undo');
    const proposalModelUndone = (await req('GET', '/api/doc')).body;
    check('the one concurrent proposal commit is one exact Undo unit',
      concurrentUndo.status === 200 &&
      !proposalModelUndone.paragraphs.some((paragraph) =>
        paragraph.text === concurrentText),
      concurrentUndo.body.error);

    console.log('\n[proposal anchors stay authoritative]');
    let integrityModel = (await req('GET', '/api/doc')).body;
    const integrityCandidates = integrityModel.paragraphs.filter((paragraph) =>
      !paragraph.table && paragraph.pid !== target.pid &&
      typeof paragraph.text === 'string' && paragraph.text.length > 80);
    if (integrityCandidates.length < 6) {
      throw new Error('proposal integrity fixture needs six ordinary paragraphs');
    }
    const guardedAnchor = integrityCandidates[0];
    const unrelatedAnchor = integrityCandidates[1];
    const preservedProposal = await req('POST', '/api/propose', {
      proposal: {
        anchor_pid: guardedAnchor.pid,
        anchor_hash: guardedAnchor.hash,
        mode: 'insert',
        intent: 'unrelated edit proposal guard',
        options: [
          { text: 'Guarded proposal option one.' },
          { text: 'Guarded proposal option two.' },
        ],
      },
    });
    const unrelatedEdit = await req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'set_text',
        pid: unrelatedAnchor.pid,
        text: `${unrelatedAnchor.text} [unrelated edit fixture]`,
        expect_hash: unrelatedAnchor.hash,
        why: 'proposal unrelated edit fixture',
        utterance: 'proposal-unrelated-edit',
      },
    });
    const stillOpen = (await req('GET', '/api/proposals')).body.proposals;
    check('an unrelated edit preserves an exactly anchored proposal',
      preservedProposal.status === 200 &&
      preservedProposal.body.anchor_hash === guardedAnchor.hash &&
      unrelatedEdit.status === 200 &&
      stillOpen.some((item) => item.id === preservedProposal.body.id),
      `${preservedProposal.status}/${unrelatedEdit.status}/${stillOpen.length}`);
    await req('POST', '/api/dismiss', { id: preservedProposal.body.id });
    await req('POST', '/api/undo');

    integrityModel = (await req('GET', '/api/doc')).body;
    const formatAnchor = integrityModel.paragraphs.find((paragraph) =>
      !paragraph.table && paragraph.pid !== target.pid &&
      paragraph.text.length > 40 && paragraph.text.length < 240 &&
      Array.isArray(paragraph.runs) && paragraph.runs.length === 1);
    if (!formatAnchor) {
      throw new Error('proposal integrity fixture needs simple formatted prose');
    }
    const hashPreservedProposal = await req('POST', '/api/propose', {
      proposal: {
        anchor_pid: formatAnchor.pid,
        anchor_hash: formatAnchor.hash,
        mode: 'insert',
        intent: 'text hash survives formatting',
        options: [
          { text: 'Hash-preserved option one.' },
          { text: 'Hash-preserved option two.' },
        ],
      },
    });
    const formattedAnchor = await req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'format',
        pid: formatAnchor.pid,
        find: formatAnchor.text,
        b: !Boolean(formatAnchor.runs[0].b),
        expect_hash: formatAnchor.hash,
        expect_format_hash: formatAnchor.format_hash,
        why: 'proposal hash-preserving format fixture',
        utterance: 'proposal-hash-preserving-format',
      },
    });
    const openAfterFormat = (await req('GET', '/api/proposals')).body.proposals;
    check('a relevant formatting edit preserves a proposal when text hash is unchanged',
      hashPreservedProposal.status === 200 && formattedAnchor.status === 200 &&
      formattedAnchor.body.result.hash === formatAnchor.hash &&
      openAfterFormat.some((item) =>
        item.id === hashPreservedProposal.body.id),
      `${hashPreservedProposal.status}/${formattedAnchor.status}/` +
        `${formattedAnchor.body.result && formattedAnchor.body.result.hash}`);
    await req('POST', '/api/dismiss', { id: hashPreservedProposal.body.id });
    await req('POST', '/api/undo');

    integrityModel = (await req('GET', '/api/doc')).body;
    const rollbackAnchor = integrityModel.paragraphs.find((paragraph) =>
      paragraph.pid === integrityCandidates[1].pid);
    const rollbackProposal = await req('POST', '/api/propose', {
      proposal: {
        anchor_pid: rollbackAnchor.pid,
        anchor_hash: rollbackAnchor.hash,
        mode: 'insert',
        intent: 'failed state commit keeps proposal and document aligned',
        options: [
          { text: 'Rollback option one.' },
          { text: 'Rollback option two.' },
        ],
      },
    });
    const rollbackBytesBefore = fs.readFileSync(doc);
    const rollbackStateFile = path.join(TMP, 'data', 'state.json');
    const rollbackStateBefore = fs.readFileSync(rollbackStateFile);
    const rollbackRevBefore = (await req('GET', '/api/health')).body.rev;
    await req('POST', '/api/__runtime/fail-next-state-persist');
    const failedAnchorEdit = await req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'set_text',
        pid: rollbackAnchor.pid,
        text: `${rollbackAnchor.text} [must roll back]`,
        expect_hash: rollbackAnchor.hash,
        why: 'proposal stale rollback fixture',
        utterance: 'proposal-stale-rollback',
      },
    });
    const rollbackOpen = (await req('GET', '/api/proposals')).body.proposals;
    check('a failed stale-state commit rolls back both document and proposal',
      rollbackProposal.status === 200 && failedAnchorEdit.status === 503 &&
      fs.readFileSync(doc).equals(rollbackBytesBefore) &&
      fs.readFileSync(rollbackStateFile).equals(rollbackStateBefore) &&
      (await req('GET', '/api/health')).body.rev === rollbackRevBefore &&
      rollbackOpen.some((item) => item.id === rollbackProposal.body.id),
      `${rollbackProposal.status}/${failedAnchorEdit.status}/` +
        `${rollbackOpen.length}`);
    await req('POST', '/api/__runtime/retry-state-persist');
    await req('POST', '/api/dismiss', { id: rollbackProposal.body.id });

    integrityModel = (await req('GET', '/api/doc')).body;
    const editedAnchor = integrityModel.paragraphs.find((paragraph) =>
      paragraph.pid === guardedAnchor.pid);
    const editStaleProposal = await req('POST', '/api/propose', {
      proposal: {
        anchor_pid: editedAnchor.pid,
        anchor_hash: editedAnchor.hash,
        mode: 'insert',
        intent: 'edited anchor becomes stale',
        options: [
          { text: 'This must not land after the anchor changes.' },
          { text: 'Nor may this alternative land.' },
        ],
      },
    });
    const anchorEdit = await req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'set_text',
        pid: editedAnchor.pid,
        text: `${editedAnchor.text} [anchor edit fixture]`,
        expect_hash: editedAnchor.hash,
        why: 'proposal anchor edit fixture',
        utterance: 'proposal-anchor-edit',
      },
    });
    const afterAnchorEditBytes = fs.readFileSync(doc);
    const afterAnchorEditRev = (await req('GET', '/api/health')).body.rev;
    const refusedAfterEdit = await req('POST', '/api/accept', {
      id: editStaleProposal.body.id,
      option: 'A',
      who: 'human',
    });
    const afterEditState = JSON.parse(
      fs.readFileSync(path.join(TMP, 'data', 'state.json'), 'utf8'));
    check('editing an anchor retires its proposal before acceptance',
      anchorEdit.status === 200 &&
      refusedAfterEdit.status >= 400 &&
      !(await req('GET', '/api/proposals')).body.proposals.some((item) =>
        item.id === editStaleProposal.body.id) &&
      afterEditState.proposals.some((item) =>
        item.id === editStaleProposal.body.id && item.status === 'stale'),
      `${anchorEdit.status}/${refusedAfterEdit.status}`);
    check('refusing the stale proposal performs no second transaction',
      fs.readFileSync(doc).equals(afterAnchorEditBytes) &&
      (await req('GET', '/api/health')).body.rev === afterAnchorEditRev,
      refusedAfterEdit.body.error);
    await req('POST', '/api/undo');

    integrityModel = (await req('GET', '/api/doc')).body;
    const deleteAnchor = integrityModel.paragraphs.find((paragraph) =>
      paragraph.pid === integrityCandidates[2].pid);
    const deleteStaleProposal = await req('POST', '/api/propose', {
      proposal: {
        anchor_pid: deleteAnchor.pid,
        anchor_hash: deleteAnchor.hash,
        mode: 'insert',
        intent: 'deleted anchor becomes stale',
        options: [
          { text: 'Deleted-anchor option one.' },
          { text: 'Deleted-anchor option two.' },
        ],
      },
    });
    const deletedAnchor = await req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'delete',
        pid: deleteAnchor.pid,
        expect_hash: deleteAnchor.hash,
        why: 'proposal anchor delete fixture',
        utterance: 'proposal-anchor-delete',
      },
    });
    const deleteState = JSON.parse(
      fs.readFileSync(path.join(TMP, 'data', 'state.json'), 'utf8'));
    check('deleting an anchor atomically retires its proposal',
      deleteStaleProposal.status === 200 && deletedAnchor.status === 200 &&
      deleteState.proposals.some((item) =>
        item.id === deleteStaleProposal.body.id && item.status === 'stale') &&
      !(await req('GET', '/api/proposals')).body.proposals.some((item) =>
        item.id === deleteStaleProposal.body.id),
      `${deleteStaleProposal.status}/${deletedAnchor.status}`);
    await req('POST', '/api/undo');

    integrityModel = (await req('GET', '/api/doc')).body;
    let mergePair = null;
    for (let index = 24; index < integrityModel.paragraphs.length - 1; index++) {
      const first = integrityModel.paragraphs[index];
      const second = integrityModel.paragraphs[index + 1];
      if (!first.table && !second.table &&
          first.text.length > 40 && second.text.length > 40 &&
          first.text.length < 500 && second.text.length < 500) {
        mergePair = { first, second };
        break;
      }
    }
    if (!mergePair) throw new Error('proposal merge fixture needs adjacent prose');
    const mergeStaleProposal = await req('POST', '/api/propose', {
      proposal: {
        anchor_pid: mergePair.second.pid,
        anchor_hash: mergePair.second.hash,
        mode: 'insert',
        intent: 'merged-away anchor becomes stale',
        options: [
          { text: 'Merged-anchor option one.' },
          { text: 'Merged-anchor option two.' },
        ],
      },
    });
    const mergedAnchor = await req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'merge',
        pid: mergePair.first.pid,
        first_pid: mergePair.first.pid,
        second_pid: mergePair.second.pid,
        first_text: mergePair.first.text,
        second_text: mergePair.second.text,
        expect_first_hash: mergePair.first.hash,
        expect_second_hash: mergePair.second.hash,
        why: 'proposal anchor merge fixture',
      },
    });
    const mergeState = JSON.parse(
      fs.readFileSync(path.join(TMP, 'data', 'state.json'), 'utf8'));
    check('merging away an anchor atomically retires its proposal',
      mergeStaleProposal.status === 200 && mergedAnchor.status === 200 &&
      mergeState.proposals.some((item) =>
        item.id === mergeStaleProposal.body.id && item.status === 'stale'),
      `${mergeStaleProposal.status}/${mergedAnchor.status}: ` +
        `${mergedAnchor.body.error || ''}`);
    if (mergedAnchor.status === 200) await req('POST', '/api/undo');

    console.log('\n[queued stale acceptance is reconciled]');
    integrityModel = (await req('GET', '/api/doc')).body;
    const racedAnchor = integrityModel.paragraphs.find((paragraph) =>
      paragraph.pid === integrityCandidates[3].pid);
    const racedText = 'This raced proposal must never be inserted.';
    const racedProposal = await req('POST', '/api/propose', {
      proposal: {
        anchor_pid: racedAnchor.pid,
        anchor_hash: racedAnchor.hash,
        mode: 'insert',
        intent: 'queued stale acceptance fixture',
        options: [
          { text: racedText },
          { text: 'Unused raced proposal alternative.' },
        ],
      },
    });
    const revBeforeRace = (await req('GET', '/api/health')).body.rev;
    const winningEditPromise = req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'set_text',
        pid: racedAnchor.pid,
        text: `${racedAnchor.text} [winning queued edit]`,
        expect_hash: racedAnchor.hash,
        why: 'winning proposal race edit',
        utterance: 'winning-proposal-race-edit',
        __test_delay_after_mutation_ms: 450,
      },
    });
    await sleep(80);
    const losingAcceptPromise = req('POST', '/api/accept', {
      id: racedProposal.body.id,
      option: 'A',
      who: 'human',
    });
    const [winningEdit, losingAccept] = await Promise.all([
      winningEditPromise,
      losingAcceptPromise,
    ]);
    const racedModel = (await req('GET', '/api/doc')).body;
    const racedState = JSON.parse(
      fs.readFileSync(path.join(TMP, 'data', 'state.json'), 'utf8'));
    check('a queued acceptance uses its captured hash and loses to the prior edit',
      winningEdit.status === 200 && losingAccept.status >= 400 &&
      racedModel.rev === revBeforeRace + 1 &&
      !racedModel.paragraphs.some((paragraph) => paragraph.text === racedText),
      `${winningEdit.status}/${losingAccept.status}/${racedModel.rev}`);
    check('the refused acceptance reconciles and persists its card as stale',
      racedState.proposals.some((item) =>
        item.id === racedProposal.body.id && item.status === 'stale') &&
      !(await req('GET', '/api/proposals')).body.proposals.some((item) =>
        item.id === racedProposal.body.id),
      losingAccept.body.error);
    await req('POST', '/api/undo');

    console.log('\n[proposal creation is serialized with document writes]');
    integrityModel = (await req('GET', '/api/doc')).body;
    const creationRaceAnchor = integrityModel.paragraphs.find((paragraph) =>
      paragraph.pid === integrityCandidates[4].pid);
    const creationWinningEditPromise = req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'set_text',
        pid: creationRaceAnchor.pid,
        text: `${creationRaceAnchor.text} [proposal creation race]`,
        expect_hash: creationRaceAnchor.hash,
        why: 'proposal creation serialization fixture',
        utterance: 'proposal-creation-race',
        __test_delay_after_mutation_ms: 400,
      },
    });
    await sleep(80);
    const staleCreationPromise = req('POST', '/api/propose', {
      proposal: {
        anchor_pid: creationRaceAnchor.pid,
        anchor_hash: creationRaceAnchor.hash,
        mode: 'insert',
        intent: 'stale queued proposal must be refused',
        options: [
          { text: 'Queued stale proposal option one.' },
          { text: 'Queued stale proposal option two.' },
        ],
      },
    });
    const [creationWinningEdit, staleCreation] = await Promise.all([
      creationWinningEditPromise,
      staleCreationPromise,
    ]);
    check('a queued proposal validates against the post-write authoritative anchor',
      creationWinningEdit.status === 200 && staleCreation.status === 409 &&
      !(await req('GET', '/api/proposals')).body.proposals.some((item) =>
        item.intent === 'stale queued proposal must be refused'),
      `${creationWinningEdit.status}/${staleCreation.status}: ` +
        `${staleCreation.body.error || ''}`);
    await req('POST', '/api/undo');

    console.log('\n[Undo also reconciles proposal anchors]');
    integrityModel = (await req('GET', '/api/doc')).body;
    const undoAnchorBefore = integrityModel.paragraphs.find((paragraph) =>
      paragraph.pid === integrityCandidates[4].pid);
    const changedForUndo = await req('POST', '/api/edit', {
      who: 'human',
      op: {
        type: 'set_text',
        pid: undoAnchorBefore.pid,
        text: `${undoAnchorBefore.text} [proposal undo fixture]`,
        expect_hash: undoAnchorBefore.hash,
        why: 'proposal undo fixture',
        utterance: 'proposal-undo-fixture',
      },
    });
    const undoAnchorAfter = (await req('GET', '/api/doc')).body.paragraphs
      .find((paragraph) => paragraph.pid === undoAnchorBefore.pid);
    const undoStaleProposal = await req('POST', '/api/propose', {
      proposal: {
        anchor_pid: undoAnchorAfter.pid,
        anchor_hash: undoAnchorAfter.hash,
        mode: 'insert',
        intent: 'Undo must stale a newer proposal',
        options: [
          { text: 'Undo-stale option one.' },
          { text: 'Undo-stale option two.' },
        ],
      },
    });
    const proposalUndo = await req('POST', '/api/undo');
    const undoState = JSON.parse(
      fs.readFileSync(path.join(TMP, 'data', 'state.json'), 'utf8'));
    check('Undo retires a proposal anchored to the newer paragraph content',
      changedForUndo.status === 200 && undoStaleProposal.status === 200 &&
      proposalUndo.status === 200 &&
      undoState.proposals.some((item) =>
        item.id === undoStaleProposal.body.id && item.status === 'stale') &&
      !(await req('GET', '/api/proposals')).body.proposals.some((item) =>
        item.id === undoStaleProposal.body.id),
      `${changedForUndo.status}/${proposalUndo.status}`);

    console.log('\n[acceptance keeps later agent edits in a separate Undo unit]');
    integrityModel = (await req('GET', '/api/doc')).body;
    const groupAnchor = integrityModel.paragraphs.find((paragraph) =>
      paragraph.pid === integrityCandidates[5].pid);
    const groupEditTarget = integrityModel.paragraphs.find((paragraph) =>
      paragraph.pid !== groupAnchor.pid && !paragraph.table &&
      paragraph.text.length > 60);
    const groupedInsertText = 'Accepted proposal Undo-boundary fixture.';
    const groupedProposal = await req('POST', '/api/propose', {
      proposal: {
        anchor_pid: groupAnchor.pid,
        anchor_hash: groupAnchor.hash,
        mode: 'insert',
        intent: 'acceptance Undo boundary fixture',
        options: [
          { text: groupedInsertText },
          { text: 'Unused Undo-boundary alternative.' },
        ],
      },
    });
    const groupedAccept = await req('POST', '/api/accept', {
      id: groupedProposal.body.id,
      option: 'A',
      who: 'human',
      __test_seed_current_utterance: 'u-test: prior agent request',
    });
    const afterGroupedAccept = (await req('GET', '/api/doc')).body;
    const currentGroupTarget = afterGroupedAccept.paragraphs.find((paragraph) =>
      paragraph.pid === groupEditTarget.pid);
    const laterAgentText = `${currentGroupTarget.text} [later agent edit]`;
    const laterAgentEdit = await req('POST', '/api/edit', {
      who: 'agent',
      op: {
        type: 'set_text',
        pid: currentGroupTarget.pid,
        text: laterAgentText,
        expect_hash: currentGroupTarget.hash,
        expect_document_token: afterGroupedAccept.document_token,
        why: 'later agent Undo boundary fixture',
      },
    });
    const firstGroupedUndo = await req('POST', '/api/undo');
    const afterFirstGroupedUndo = (await req('GET', '/api/doc')).body;
    const secondGroupedUndo = await req('POST', '/api/undo');
    const afterSecondGroupedUndo = (await req('GET', '/api/doc')).body;
    check('the first Undo removes only the later agent edit',
      groupedAccept.status === 200 && laterAgentEdit.status === 200 &&
      firstGroupedUndo.status === 200 &&
      afterFirstGroupedUndo.paragraphs.some((paragraph) =>
        paragraph.text === groupedInsertText) &&
      afterFirstGroupedUndo.paragraphs.find((paragraph) =>
        paragraph.pid === groupEditTarget.pid).text === groupEditTarget.text,
      `${groupedAccept.status}/${laterAgentEdit.status}/${firstGroupedUndo.status}`);
    check('the second Undo removes the independently accepted proposal',
      secondGroupedUndo.status === 200 &&
      !afterSecondGroupedUndo.paragraphs.some((paragraph) =>
        paragraph.text === groupedInsertText),
      secondGroupedUndo.body.error);

    console.log('\n[refusals]');
    const thin = await req('POST', '/api/propose', { proposal: { ...proposal, options: [{ text: 'only one' }] } });
    check('a single option is refused (that is not a choice)', thin.status === 400, thin.body.error);
    const noAnchor = await req('POST', '/api/propose', { proposal: { ...proposal, anchor_pid: '' } });
    check('a proposal with no anchor is refused', noAnchor.status === 400);
    const noFind = await req('POST', '/api/propose', { proposal: { ...proposal, find: '' } });
    check('mode=replace with no find is refused', noFind.status === 400);
    const invalidMode = await req('POST', '/api/propose', {
      proposal: { ...proposal, mode: 'append' },
    });
    check('an unknown proposal mode is refused instead of becoming replace',
      invalidMode.status === 400, invalidMode.body.error);
    const invalidOption = await req('POST', '/api/propose', {
      proposal: {
        ...proposal,
        mode: 'insert',
        options: [{ text: 'valid' }, { text: 7 }],
      },
    });
    check('proposal option text is validated without lossy coercion',
      invalidOption.status === 400, invalidOption.body.error);
    const latestModel = (await req('GET', '/api/doc')).body;
    const latestTarget = latestModel.paragraphs.find((paragraph) =>
      paragraph.pid === target.pid);
    const staleHash = await req('POST', '/api/propose', {
      proposal: {
        anchor_pid: latestTarget.pid,
        anchor_hash: latestTarget.hash === 'deadbeef1234'
          ? 'feedface1234' : 'deadbeef1234',
        mode: 'insert',
        intent: 'stale supplied proposal hash',
        options: [{ text: 'one' }, { text: 'two' }],
      },
    });
    check('a supplied stale anchor hash is refused from the authoritative model',
      staleHash.status === 409, staleHash.body.error);

    console.log('\n[nothing threw]');
    const errs = await browser.eval('JSON.stringify(window.__errs || null)');
    check('no page errors', errs === '[]', errs);
    check('no uncaught exceptions', browser.exceptions.length === 0, browser.exceptions.slice(0, 2).join(' | '));
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
  if (FAIL.length) console.log('failed: ' + FAIL.join(', '));
  if (FAIL.length || hardFail) {
    console.log('\n--- server log ---\n' + srvLog.join('').slice(-2000));
  }
  process.exit(FAIL.length || hardFail ? 1 : 0);
}

main();
