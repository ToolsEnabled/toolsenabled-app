#!/usr/bin/env node
'use strict';
/**
 * Agent-lane rendering tests.
 *
 * Driven with synthetic events rather than a live agent, on purpose and with a
 * clear division of labour: test_agent_live.js proves the event SHAPES are what
 * a real claude.exe emits, and this proves the DRAWING is right. Doing the
 * second with real tokens would cost dollars per assertion and still be flakier.
 *
 * Every event below was copied from the shapes observed in the live run.
 *
 * Run: node test/test_lane.js
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
const TMP = path.join(__dirname, '_tmp_lane');
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
  if (!findBrowser()) { console.log('No browser found, skipping lane tests.'); process.exit(0); }
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
  const feed = async (b, data) => { await b.eval(`(window.__feed('agent', ${JSON.stringify(data)}), true)`); await sleep(60); };

  try {
    await waitForOwnedHealth(() => req('GET', '/api/health'), srv, {
      attempts: 60,
      interval: 250,
    });
    const opened = await req('POST', '/api/open', { path: doc });
    if (opened.status !== 200) {
      throw new Error(`fixture open failed (${opened.status}): ${opened.body.error || ''}`);
    }

    browser = await Browser.launch({ headless: true });
    await browser.attachToPage();
    await browser.collectErrors();
    await browser.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await browser.goto(BASE + '/');
    await browser.waitFor('document.querySelectorAll(".para").length > 300', { timeout: 20000 });

    console.log('\n[agent state is honest]');
    check('starts off', await browser.eval(`document.getElementById('agent-state').dataset.state`) === 'off');
    const restingPanel = await browser.eval(`(() => {
      const panel = document.querySelector('.work-panel');
      return {
        height: panel.getBoundingClientRect().height,
        lane: getComputedStyle(document.getElementById('lane')).display,
        head: getComputedStyle(document.querySelector('.work-panel .rail-head')).display,
        model: getComputedStyle(document.getElementById('model-btn')).display,
        stop: getComputedStyle(document.getElementById('agent-btn')).display
      };
    })()`);
    check('the empty off-state work surface rests as one compact control row',
      restingPanel.height <= 46 && restingPanel.lane === 'none' &&
      restingPanel.head === 'none' && restingPanel.model !== 'none' &&
      restingPanel.stop === 'none',
      JSON.stringify(restingPanel));
    await feed(browser, { kind: 'agent-error', error: 'agent failed to start: invalid binary' });
    check('a failed process start is visibly retryable',
      await browser.eval(`document.getElementById('agent-state').dataset.state === 'error' &&
        document.getElementById('agent-btn').hidden === true &&
        /failed to start/.test(document.getElementById('lane-hint').textContent)`) === true);
    await feed(browser, { kind: 'agent-start', pid: 123 });
    const st1 = await browser.eval(`document.getElementById('agent-state').dataset.state`);
    // "started" is not "ready": system/init only arrives with the first message.
    check('after spawn it says STARTING, not ready', st1 === 'starting', st1);
    check('the stop control appears only once a process exists',
      await browser.eval(`document.getElementById('agent-btn').hidden === false &&
        document.getElementById('agent-btn').textContent === 'stop'`) === true);
    await browser.eval(`(() => {
      window.__laneFetch = window.fetch;
      window.__stopCalls = 0;
      window.__stopResolvers = [];
      window.fetch = (...args) => {
        const url = new URL(args[0], location.href);
        if (url.pathname === '/api/agent/stop') {
          window.__stopCalls++;
          return new Promise((resolve) => {
            window.__stopResolvers.push(() => resolve({
              json: () => Promise.resolve({ stopped: true })
            }));
          });
        }
        return window.__laneFetch(...args);
      };
      const stop = document.getElementById('agent-btn');
      stop.click();
      stop.click();
      return true;
    })()`);
    await sleep(100);
    const pendingStop = await browser.eval(`({
      calls: window.__stopCalls,
      disabled: document.getElementById('agent-btn').disabled
    })`);
    check('rapid Stop actions submit only one operation while it is pending',
      pendingStop.calls === 1 && pendingStop.disabled,
      JSON.stringify(pendingStop));
    await browser.eval(`(() => {
      for (const resolve of window.__stopResolvers) resolve();
      return true;
    })()`);
    await sleep(100);
    const eventlessStop = await browser.eval(`({
      state: document.getElementById('agent-state').dataset.state,
      hidden: document.getElementById('agent-btn').hidden,
      laneEmpty: document.getElementById('lane').childElementCount === 0
    })`);
    check('an acknowledged Stop response retires the lane even without its live event',
      eventlessStop.state === 'off' && eventlessStop.hidden &&
      eventlessStop.laneEmpty, JSON.stringify(eventlessStop));
    await feed(browser, { kind: 'agent-start', pid: 124 });
    await browser.eval(`(() => {
      window.fetch = (...args) => {
        const url = new URL(args[0], location.href);
        if (url.pathname === '/api/agent/stop') {
          return Promise.reject(new TypeError('simulated Stop transport failure'));
        }
        return window.__laneFetch(...args);
      };
      document.getElementById('agent-btn').click();
      return true;
    })()`);
    await sleep(120);
    const failedStop = await browser.eval(`(() => ({
      state: document.getElementById('agent-state').dataset.state,
      visible: !document.getElementById('agent-btn').hidden,
      enabled: !document.getElementById('agent-btn').disabled,
      hint: document.getElementById('lane-hint').textContent,
      errors: [...(window.__errs || [])]
    }))()`);
    check('a failed Stop keeps the live process visibly controllable',
      failedStop.state === 'starting' && failedStop.visible &&
      failedStop.enabled && /stop failed|unavailable|failure/i.test(failedStop.hint || ''),
      JSON.stringify(failedStop));
    check('a failed Stop produces no unhandled browser error',
      failedStop.errors.length === 0, JSON.stringify(failedStop.errors));
    await browser.eval(`(() => {
      window.fetch = window.__laneFetch;
      delete window.__laneFetch;
      delete window.__stopCalls;
      delete window.__stopResolvers;
      window.__errs = [];
      document.getElementById('lane-hint').textContent = 'waiting for your first message';
      return true;
    })()`);
    const activePanel = await browser.eval(`(() => {
      const panel = document.querySelector('.work-panel');
      return {
        height: panel.getBoundingClientRect().height,
        lane: getComputedStyle(document.getElementById('lane')).display
      };
    })()`);
    check('real agent activity immediately expands the work surface',
      activePanel.height > restingPanel.height && activePanel.lane !== 'none',
      JSON.stringify(activePanel));
    const hint = await browser.eval(`document.getElementById('lane-hint').textContent`);
    check('  and says what it is waiting for', /first message/.test(hint), JSON.stringify(hint));
    check('a late bootstrap snapshot cannot overwrite a newer live event',
      await browser.eval(`(() => {
        const before = window.__lane.liveEvents - 1;
        const applied = window.__hydrateAgent({
          running: false, model: 'terra', models: ['sonnet', 'opus', 'terra', 'sol']
        }, before);
        return applied === false &&
          document.getElementById('agent-state').dataset.state === 'starting' &&
          document.getElementById('model-btn').value === 'sonnet';
      })()`) === true);
    await feed(browser, { kind: 'session', sessionId: 'abc-123', tools: ['mcp__doc__doc_read'], mcp: [{ name: 'doc', status: 'connected' }] });
    check('ready only once the session exists',
      await browser.eval(`document.getElementById('agent-state').dataset.state`) === 'ready');

    console.log('\n[a tool call is shown BEFORE it runs]');
    await feed(browser, { kind: 'turn-start', ttftMs: 3919 });
    await feed(browser, { kind: 'tool-pending', id: 'toolu_1', name: 'mcp__doc__doc_replace', parent: null });
    check('the call appears immediately', await browser.eval(`document.querySelectorAll('#lane .call').length`) === 1);
    check('marked pending, not running',
      await browser.eval(`document.querySelector('#lane .call').dataset.state`) === 'pending');
    check('named without the mcp prefix',
      (await browser.eval(`document.querySelector('#lane .call .t').textContent`)) === 'doc_replace');
    check('ttft is shown', /3\.9s/.test(await browser.eval(`document.getElementById('agent-meta').textContent`)),
      await browser.eval(`document.getElementById('agent-meta').textContent`));

    console.log('\n[arguments stream in as it types them]');
    // Exactly the truncation pattern input_json_delta produces.
    await feed(browser, { kind: 'tool-args', id: 'toolu_1', partial: '{"pid":"A1B2' });
    const a1 = await browser.eval(`document.querySelector('#lane .call .args').textContent`);
    await feed(browser, { kind: 'tool-args', id: 'toolu_1', partial: '{"pid":"A1B2C3D4","find":"the semantic ed' });
    const a2 = await browser.eval(`document.querySelector('#lane .call .args').textContent`);
    check('half-written JSON still renders something readable', a2.includes('the semantic ed'), JSON.stringify(a2));
    check('  it grew as more arrived', a2.length > a1.length, `${a1.length} -> ${a2.length}`);
    await feed(browser, { kind: 'tool-args', id: 'toolu_1', partial: '{"pid":"A1B2C3D4","find":"the semantic edge","replace":"the measurement gap","why":"sharper"}' });
    const a3 = await browser.eval(`document.querySelector('#lane .call .args').textContent`);
    check('a complete replace shows old and new', /the semantic edge/.test(a3) && /the measurement gap/.test(a3), JSON.stringify(a3));
    check('  with an arrow between them',
      await browser.eval(`!!document.querySelector('#lane .call .args .arrow')`));

    console.log('\n[then running, then done]');
    await feed(browser, { kind: 'tool-call', id: 'toolu_1', name: 'mcp__doc__doc_replace', parent: null,
      input: { pid: 'A1B2C3D4', find: 'the semantic edge', replace: 'the measurement gap', why: 'sharper' } });
    check('goes to running', await browser.eval(`document.querySelector('#lane .call').dataset.state`) === 'running');
    await feed(browser, { kind: 'tool-result', id: 'toolu_1', parent: null, isError: false, text: 'Replaced. Paragraph A1B2C3D4 now reads: ...' });
    check('goes to done', await browser.eval(`document.querySelector('#lane .call').dataset.state`) === 'done');
    check('shows how long it took', /\d\.\ds/.test(await browser.eval(`document.querySelector('#lane .call .tick').textContent`)),
      await browser.eval(`document.querySelector('#lane .call .tick').textContent`));
    check('shows the result', /Replaced/.test(await browser.eval(`document.querySelector('#lane .call .out').textContent`)));

    console.log('\n[a refusal is visibly different from a success]');
    await feed(browser, { kind: 'tool-pending', id: 'toolu_2', name: 'mcp__doc__doc_replace', parent: null });
    await feed(browser, { kind: 'tool-result', id: 'toolu_2', parent: null, isError: true,
      text: "Refused: Ambiguous: ' the ' occurs 15 times in paragraph 51C326DE." });
    const errState = await browser.eval(`document.querySelector('#lane .call[data-id="toolu_2"]').dataset.state`);
    check('errors are marked as errors', errState === 'error', errState);
    check('and the reason is legible',
      /Ambiguous/.test(await browser.eval(`document.querySelector('#lane .call[data-id="toolu_2"] .out').textContent`)));

    console.log('\n[subagents nest under the call that spawned them]');
    await feed(browser, { kind: 'tool-pending', id: 'toolu_sub', name: 'Agent', parent: null });
    await feed(browser, { kind: 'tool-call', id: 'toolu_sub', name: 'Agent', parent: null,
      input: { subagent_type: 'researcher', description: 'check the determinacy count' } });
    check('the Agent call is styled as a subagent launch',
      await browser.eval(`document.querySelector('#lane .call[data-id="toolu_sub"]').classList.contains('agent-call')`));
    check('  and names the subagent type',
      /researcher/.test(await browser.eval(`document.querySelector('#lane .call[data-id="toolu_sub"] .args').textContent`)));

    // A subagent's own calls arrive tagged with parent_tool_use_id.
    await feed(browser, { kind: 'tool-call', id: 'toolu_kid1', name: 'mcp__doc__doc_read', parent: 'toolu_sub', input: { from: 0, to: 50 } });
    await feed(browser, { kind: 'tool-result', id: 'toolu_kid1', parent: 'toolu_sub', isError: false, text: '51 paragraphs' });
    const nested = await browser.eval(`document.querySelectorAll('#lane .call[data-id="toolu_sub"] .sub .call').length`);
    check('the subagent call renders INSIDE its parent', nested === 1, nested);
    const topLevel = await browser.eval(`document.querySelectorAll('#lane > .call').length`);
    check('  and not as another top-level call', topLevel === 3, topLevel);
    check('  the nest is labelled',
      /subagent/.test(await browser.eval(`document.querySelector('#lane .call[data-id="toolu_sub"] .subhead').textContent`)));

    await feed(browser, { kind: 'tool-call', id: 'toolu_kid2', name: 'mcp__doc__doc_find', parent: 'toolu_sub', input: { query: 'determinacy' } });
    check('a second subagent call joins the same nest',
      await browser.eval(`document.querySelectorAll('#lane .call[data-id="toolu_sub"] .sub .call').length`) === 2);
    check('top level is still unchanged',
      await browser.eval(`document.querySelectorAll('#lane > .call').length`) === 3);

    console.log('\n[thinking]');
    await feed(browser, { kind: 'thinking', tokens: 412 });
    check('thinking meter appears', await browser.eval(`!document.getElementById('think').hidden`));
    check('  without exposing token-by-token thinking detail',
      await browser.eval(`document.getElementById('think-n').textContent`) === 'thinking');
    await feed(browser, { kind: 'tool-pending', id: 'toolu_3', name: 'mcp__doc__doc_read', parent: null });
    check('thinking meter hides once it acts', await browser.eval(`document.getElementById('think').hidden`) === true);

    console.log('\n[queued vs delivered is honest]');
    await feed(browser, { kind: 'said', text: 'actually make it shorter', queued: true });
    check('a mid-turn message says it is queued',
      /queued/.test(await browser.eval(`document.getElementById('lane-hint').textContent`)),
      await browser.eval(`document.getElementById('lane-hint').textContent`));
    await feed(browser, { kind: 'delivered', text: 'actually make it shorter' });
    check('  and clears once actually delivered',
      (await browser.eval(`document.getElementById('lane-hint').textContent`)) === '');

    console.log('\n[turn end]');
    await feed(browser, { kind: 'message', parent: null,
      text: 'I made the requested change and kept the surrounding formatting intact.' });
    await feed(browser, { kind: 'turn-end', subtype: 'success', interrupted: false, durationMs: 8100,
      ttftMs: 3919, costUsd: 0.065, totalCostUsd: 0.1251, denials: [],
      text: 'I made the requested change and kept the surrounding formatting intact.' });
    check('cost is reported', /0\.125/.test(await browser.eval(`document.getElementById('agent-meta').textContent`)),
      await browser.eval(`document.getElementById('agent-meta').textContent`));
    check('the completed direct response is handed to browser speech once',
      await browser.eval(`window.__speech.speaks === 1 &&
        window.__speech.last === 'editing-agent' &&
        /surrounding formatting/.test(window.__speech.lastText)`) === true);
    check('returns to ready', await browser.eval(`document.getElementById('agent-state').dataset.state`) === 'ready');
    await feed(browser, { kind: 'turn-end', subtype: 'error_during_execution', interrupted: true, totalCostUsd: 0.13 });
    check('an interrupted turn says so',
      /interrupted/.test(await browser.eval(`document.getElementById('lane-hint').textContent`)),
      await browser.eval(`document.getElementById('lane-hint').textContent`));
    check('an interrupted turn is never read aloud',
      await browser.eval(`window.__speech.speaks`) === 1);

    console.log('\n[conversation is separate from execution detail]');
    await browser.eval(`(window.__feed('trail', {
      at: '2026-07-20T00:00:00.000Z', op: 'said', who: 'human',
      summary: 'Can you tighten this claim without changing its meaning?'
    }), true)`);
    await browser.eval(`(window.__feed('trail', {
      at: '2026-07-20T00:00:08.000Z', op: 'turn', who: 'agent',
      summary: 'I tightened the claim and preserved the surrounding formatting.'
    }), true)`);
    await sleep(100);
    check('human and final agent turns render in a dedicated conversation card',
      await browser.eval(`document.querySelectorAll('#conversation-turns .conversation-turn').length`) === 2);
    check('the prompt and response form one clearly ordered exchange',
      await browser.eval(`(() => {
        const x = document.querySelector('.conversation-exchange');
        const turns = [...x.querySelectorAll('.conversation-turn')];
        return x.dataset.complete === 'true' && turns.length === 2 &&
          turns[0].dataset.who === 'human' && turns[1].dataset.who === 'agent';
      })()`) === true);
    check('the final answer is visually separate from tool activity',
      await browser.eval(`document.querySelector(
        '#conversation-turns .conversation-turn[data-who="agent"]'
      ).textContent.includes('preserved the surrounding formatting')`) === true);
    check('the polished answer card has a replay-audio control',
      await browser.eval(`!!document.querySelector('.conversation-speak[data-speech-source] svg')`) === true);
    await browser.eval(`(document.querySelector('.conversation-speak').click(), true)`);
    check('the answer replay control uses the browser speech path',
      await browser.eval(`window.__speech.speaks === 2 &&
        window.__speech.last.startsWith('conversation:')`) === true);
    await browser.eval(`(window.__feed('trail', {
      at: '2026-07-20T00:00:30.000Z', op: 'turn', who: 'agent',
      summary: 'Second answer, delivered after both queued prompts.'
    }), true)`);
    await browser.eval(`(window.__feed('trail', {
      at: '2026-07-20T00:00:20.000Z', op: 'said', who: 'human',
      summary: 'A queued follow-up that arrived before the first answer.'
    }), true)`);
    await sleep(100);
    check('out-of-order delivery is sorted and paired into readable exchanges',
      await browser.eval(`(() => {
        const x = [...document.querySelectorAll('.conversation-exchange')];
        return x.length === 2 &&
          x[1].querySelector('[data-who="human"] p').textContent.startsWith('A queued follow-up') &&
          x[1].querySelector('[data-who="agent"] p').textContent.startsWith('Second answer');
      })()`) === true);
    const longAnswer = [
      '### Complete result',
      '',
      'The response keeps its **full explanation** and formats the evidence:',
      '',
      '- first supported point',
      '- second point with `source.json`',
      '',
      'x'.repeat(1400),
    ].join('\n');
    await browser.eval(`(window.__feed('trail', {
      at: '2026-07-20T00:00:40.000Z', op: 'said', who: 'human',
      summary: 'Give me the complete result.'
    }), true)`);
    await browser.eval(`(window.__feed('trail', {
      at: '2026-07-20T00:00:50.000Z', op: 'turn', who: 'agent',
      summary: ${JSON.stringify(longAnswer)}
    }), true)`);
    await browser.eval(`(window.__feed('trail', {
      at: '2026-07-20T00:00:51.000Z', op: 'turn', who: 'agent',
      summary: ${JSON.stringify(longAnswer)}
    }), true)`);
    await browser.eval(`(window.__feed('trail', {
      at: '2026-07-20T00:00:50.000Z', op: 'turn', who: 'agent',
      summary: ${JSON.stringify(longAnswer)}
    }), true)`);
    await sleep(100);
    check('long responses are complete, structured, and not duplicated',
      await browser.eval(`(() => {
        const x = [...document.querySelectorAll('.conversation-exchange')];
        const last = x[x.length - 1], answer = last.querySelector('[data-who="agent"]');
        return x.length === 3 &&
          answer.textContent.includes('${'x'.repeat(40)}') &&
          answer.querySelectorAll('h4').length === 1 &&
          answer.querySelectorAll('li').length === 2 &&
          answer.querySelectorAll('strong').length === 1 &&
          answer.querySelectorAll('code').length === 1;
      })()`) === true);
    await browser.eval(`(window.__feed('hello', { trail: [
      { at: '2026-07-20T00:00:40.000Z', op: 'said', who: 'human',
        summary: 'Give me the complete result.' },
      { at: '2026-07-20T00:00:50.000Z', op: 'turn', who: 'agent',
        summary: ${JSON.stringify(longAnswer)} }
    ] }), true)`);
    await sleep(100);
    check('reconnects and newly stamped near-simultaneous replays do not repeat cards',
      await browser.eval(`document.querySelectorAll('.conversation-exchange').length`) === 3);
    check('the old changes list is removed from the visible panel',
      await browser.eval(`getComputedStyle(document.getElementById('trail')).display`) === 'none');
    check('conversation and work float over the document instead of reserving a sidebar',
      await browser.eval(`(() => {
        const r = document.getElementById('rail');
        const p = document.getElementById('paper-wrap');
        const rb = r.getBoundingClientRect(), pb = p.getBoundingClientRect();
        const rs = getComputedStyle(r);
        return rs.position === 'absolute' && rs.backgroundColor === 'rgba(0, 0, 0, 0)' &&
          rb.left >= pb.left && rb.right <= pb.right + 1 &&
          Math.abs(pb.right - innerWidth) < 2;
      })()`) === true);
    check('the work ribbon sits directly above the larger conversation surface',
      await browser.eval(`(() => {
        const c = document.getElementById('conversation').getBoundingClientRect();
        const w = document.querySelector('.work-panel').getBoundingClientRect();
        return getComputedStyle(document.getElementById('conversation')).flexGrow === '1' &&
          w.bottom < c.top && c.height > w.height;
      })()`) === true);
    check('only the individual floating cards intercept input over the editable document',
      await browser.eval(`getComputedStyle(document.getElementById('rail')).pointerEvents === 'none' &&
        getComputedStyle(document.querySelector('.work-panel')).pointerEvents === 'auto' &&
        getComputedStyle(document.getElementById('conversation')).pointerEvents === 'none' &&
        getComputedStyle(document.querySelector('.conversation-turn')).pointerEvents === 'auto'`) === true);
    check('the conversation has no enclosing panel rectangle',
      await browser.eval(`(() => {
        const s = getComputedStyle(document.getElementById('conversation'));
        return s.backgroundColor === 'rgba(0, 0, 0, 0)' &&
          s.borderTopWidth === '0px' && s.boxShadow === 'none';
      })()`) === true);
    check('conversation scroll mechanics stay visually hidden',
      await browser.eval(`getComputedStyle(document.getElementById('conversation-turns')).scrollbarWidth`) === 'none');
    check('the compact work viewport follows its newest activity',
      await browser.eval(`(() => {
        const w = document.getElementById('lane');
        return w.scrollTop + w.clientHeight >= w.scrollHeight - 2;
      })()`) === true);
    check('overflowing earlier work fades cleanly instead of leaving clipped glyphs',
      await browser.eval(`(() => {
        const w = document.getElementById('lane');
        return w.dataset.overflow === 'true' &&
          getComputedStyle(w).maskImage !== 'none';
      })()`) === true);

    console.log('\n[turn failure does not retire the process]');
    const speechBeforeFailure = await browser.eval(`window.__speech.speaks`);
    await feed(browser, { kind: 'turn-start' });
    await feed(browser, { kind: 'turn-error', error: 'model context rejected' });
    check('a turn failure keeps the live process control available',
      await browser.eval(`document.getElementById('agent-state').dataset.state === 'working' &&
        document.getElementById('agent-btn').textContent === 'stop' &&
        /context rejected/.test(document.getElementById('lane-hint').textContent)`) === true);
    await feed(browser, { kind: 'turn-end', subtype: 'failed', interrupted: false,
      error: 'model context rejected', text: 'partial response that must not be spoken' });
    check('the reusable agent returns to ready with the failure explained',
      await browser.eval(`document.getElementById('agent-state').dataset.state === 'ready' &&
        document.getElementById('agent-btn').textContent === 'stop' &&
        /context rejected/.test(document.getElementById('lane-hint').textContent)`) === true);
    check('a failed response is never read aloud',
      await browser.eval(`window.__speech.speaks`) === speechBeforeFailure);

    console.log('\n[a new turn clears the old one]');
    await feed(browser, { kind: 'turn-start', ttftMs: 800 });
    check('the lane shows the CURRENT turn only',
      await browser.eval(`document.querySelectorAll('#lane .call').length`) === 0);

    console.log('\n[compact activity drawer]');
    await browser.send('Emulation.setDeviceMetricsOverride', {
      width: 820, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(250);
    const toggleDisplay = await browser.eval(`getComputedStyle(document.getElementById('rail-toggle')).display`);
    check('compact screens expose the activity control', toggleDisplay !== 'none', toggleDisplay);
    check('the control signals live work without opening the drawer',
      await browser.eval(`document.getElementById('rail-toggle').dataset.live`) === 'true');
    check('the closed drawer is out of pointer and accessibility navigation',
      await browser.eval(`(() => {
        const r=document.getElementById('rail');
        return r.dataset.open==='false' && r.inert && r.getAttribute('aria-hidden')==='true' &&
          getComputedStyle(r).pointerEvents==='none';
      })()`) === true);

    await browser.eval(`(document.getElementById('rail-toggle').click(), true)`);
    await sleep(250);
    const drawer = await browser.eval(`(() => {
      const r=document.getElementById('rail'), b=r.getBoundingClientRect();
      return {open:r.dataset.open, inert:r.inert, hidden:r.getAttribute('aria-hidden'),
        expanded:document.getElementById('rail-toggle').getAttribute('aria-expanded'),
        right:b.right, width:b.width, viewport:innerWidth};
    })()`);
    check('the control opens the activity drawer accessibly',
      drawer.open === 'true' && drawer.inert === false && drawer.hidden === 'false' &&
      drawer.expanded === 'true', JSON.stringify(drawer));
    check('the drawer overlays within the compact viewport',
      drawer.right <= drawer.viewport - 11 && drawer.width <= 380 && drawer.width > 340,
      `${drawer.width}px at ${drawer.right}/${drawer.viewport}`);

    await browser.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(180);
    await feed(browser, { kind: 'tool-pending', id: 'toolu_phone',
      name: 'mcp__doc__doc_replace', parent: null });
    await feed(browser, { kind: 'tool-args', id: 'toolu_phone',
      partial: '{"pid":"51C326DE","find":"only 3 of 20 prompts","replace":"3 of 20 prompts (1 of 20 by the advisory screen)","why":"state the distinction precisely"}' });
    const phoneWork = await browser.eval(`(() => {
      const panel = document.querySelector('.work-panel').getBoundingClientRect();
      const lane = document.getElementById('lane').getBoundingClientRect();
      const call = document.querySelector('[data-id="toolu_phone"]').getBoundingClientRect();
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
    check('phone-width work view keeps the newest wrapped call fully legible',
      phoneWork.panelHeight > 190 &&
      phoneWork.callHeight <= phoneWork.laneHeight + 1 &&
      phoneWork.callTop >= phoneWork.laneTop - 1 &&
      phoneWork.callBottom <= phoneWork.laneBottom + 1,
      JSON.stringify(phoneWork));

    await browser.eval(`(document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})), true)`);
    await sleep(80);
    check('Escape closes the drawer and returns focus to its control',
      await browser.eval(`document.getElementById('rail').inert &&
        document.activeElement===document.getElementById('rail-toggle')`) === true);

    await browser.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(200);
    check('desktop keeps the permanent rail and hides the compact control',
      await browser.eval(`!document.getElementById('rail').inert &&
        !document.getElementById('rail').hasAttribute('aria-hidden') &&
        getComputedStyle(document.getElementById('rail-toggle')).display==='none'`) === true);

    console.log('\n[nothing threw]');
    const errs = await browser.eval('JSON.stringify(window.__errs || null)');
    check('no page errors across the whole sequence', errs === '[]', errs);
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
  if (FAIL.length || hardFail) {
    if (FAIL.length) console.log('failed: ' + FAIL.join(', '));
    console.log('\n--- server log ---\n' + srvLog.join('').slice(-1500));
  }
  process.exit(FAIL.length || hardFail ? 1 : 0);
}

main();
