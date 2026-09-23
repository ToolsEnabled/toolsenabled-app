#!/usr/bin/env node
'use strict';
/**
 * Four-model, dual-provider picker tests.
 *
 * The toggle exists to control spend, so the assertions that matter are: the
 * cheaper model is the default, the choice survives a restart, and switching
 * cannot silently destroy a turn that is in flight.
 *
 * Run: node test/test_model.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Browser, findBrowser, sleep } = require('./cdp');
const { availablePort, waitForOwnedHealth } = require('./isolated_server');
const { requiredLiveFile } = require('./live-input');

const ROOT = path.join(__dirname, '..');
let PORT = 4691;
let BASE = `http://127.0.0.1:${PORT}`;
const TMP = path.join(__dirname, '_tmp_model');
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

function boot(dataDir) {
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SCRIBE_PORT: String(PORT),
      SCRIBE_DATA: dataDir,
      SCRIBE_MODEL: '',
      SCRIBE_AGENT_LIFECYCLE_TEST: '1',
    },
  });
  srv.stdout.on('data', () => {}); srv.stderr.on('data', () => {});
  return srv;
}

async function waitUp(child) {
  await waitForOwnedHealth(() => req('GET', '/api/health'), child, {
    attempts: 80,
    interval: 250,
    requireDocHost: true,
  });
  return true;
}

async function main() {
  PORT = await availablePort();
  BASE = `http://127.0.0.1:${PORT}`;
  fs.rmSync(TMP, { recursive: true, force: true });
  const dataDir = path.join(TMP, 'data');
  fs.mkdirSync(path.join(dataDir, 'documents'), { recursive: true });
  const doc = path.join(dataDir, 'documents', 'paper.docx');
  fs.copyFileSync(SRC, doc);

  let srv = boot(dataDir);
  let browser = null, eventRequest = null, hardFail = false;
  try {
    await waitUp(srv);

    console.log('\n[the default is the cheaper model]');
    const a0 = (await req('GET', '/api/agent')).body;
    check('defaults to sonnet', a0.model === 'sonnet', a0.model);
    check('offers all four CLI-backed models',
      JSON.stringify(a0.models) === JSON.stringify(['sonnet', 'opus', 'terra', 'sol']),
      (a0.models || []).join(','));
    const pool0 = (await req('GET', '/api/models')).body;
    check('all four models begin available to automatic work',
      JSON.stringify(pool0.enabled) === JSON.stringify(['sonnet', 'opus', 'terra', 'sol']),
      JSON.stringify(pool0));
    check('automatic work starts on the cheaper model in the editing provider',
      pool0.selected === 'sonnet' &&
      pool0.automatic.watch === 'sonnet' &&
      pool0.automatic.continue === 'sonnet',
      JSON.stringify(pool0.automatic));
    check('reading model availability starts no process', a0.running === false);

    console.log('\n[switching]');
    const up = await req('POST', '/api/model', { model: 'opus' });
    check('switches to opus', up.status === 200 && up.body.model === 'opus', JSON.stringify(up.body));
    check('  no restart needed when the agent is not running', up.body.restarted === false);
    check('health reports the current model', (await req('GET', '/api/health')).body.model === 'opus');
    const selectedOff = await req('POST', '/api/models', { model: 'opus', enabled: false });
    check('the selected editing model cannot be excluded',
      selectedOff.status === 409 &&
      selectedOff.body.enabled.includes('opus'),
      JSON.stringify(selectedOff.body));
    const sonnetOff = await req('POST', '/api/models', { model: 'sonnet', enabled: false });
    check('a non-selected model can be excluded from future automatic work',
      sonnetOff.status === 200 &&
      !sonnetOff.body.enabled.includes('sonnet') &&
      sonnetOff.body.automatic.watch === 'opus' &&
      sonnetOff.body.automatic.continue === 'opus',
      JSON.stringify(sonnetOff.body));
    const excludedChoice = await req('POST', '/api/model', { model: 'sonnet' });
    check('an excluded model cannot become the editing model',
      excludedChoice.status === 409 &&
      (await req('GET', '/api/health')).body.model === 'opus',
      excludedChoice.body.error);
    const sonnetOn = await req('POST', '/api/models', { model: 'sonnet', enabled: true });
    check('reenabling the cheaper peer restores the preferred automatic route',
      sonnetOn.status === 200 &&
      sonnetOn.body.automatic.watch === 'sonnet' &&
      sonnetOn.body.automatic.continue === 'sonnet',
      JSON.stringify(sonnetOn.body));
    const badAvailability = await req('POST', '/api/models', { model: 'haiku', enabled: true });
    check('a fifth availability switch is refused',
      badAvailability.status === 400 && badAvailability.body.enabled.length === 4,
      JSON.stringify(badAvailability.body));
    const same = await req('POST', '/api/model', { model: 'opus' });
    check('switching to the same model is a no-op', same.body.restarted === false);
    const bad = await req('POST', '/api/model', { model: 'gpt-5' });
    check('an unknown model is refused', bad.status === 400, bad.body.error);
    check('  and the setting is unchanged', (await req('GET', '/api/health')).body.model === 'opus');
    const legacy = await req('POST', '/api/model', { model: 'haiku' });
    check('the retired hidden Haiku path is refused like every fifth model',
      legacy.status === 400 &&
      (await req('GET', '/api/health')).body.model === 'opus',
      legacy.body.error);
    const codexChoice = await req('POST', '/api/model', { model: 'sol' });
    check('Sol selects the Codex provider without starting a model turn',
      codexChoice.status === 200 && codexChoice.body.model === 'sol' &&
      codexChoice.body.provider === 'codex' && codexChoice.body.restarted === false,
      JSON.stringify(codexChoice.body));
    const terraOff = await req('POST', '/api/models', { model: 'terra', enabled: false });
    check('the automatic Codex route falls back to Sol when Terra is excluded',
      terraOff.status === 200 &&
      terraOff.body.automatic.watch === 'sol' &&
      terraOff.body.automatic.continue === 'sol',
      JSON.stringify(terraOff.body));
    check('changing availability still starts no model process',
      (await req('GET', '/api/agent')).body.running === false);
    await req('POST', '/api/model', { model: 'opus' });

    const firstOpen = await req('POST', '/api/open', { path: doc });
    if (firstOpen.status !== 200) {
      throw new Error(firstOpen.body && firstOpen.body.error || 'could not open model fixture');
    }
    const restartModel = (await req('GET', '/api/doc')).body;
    const restartTarget = restartModel.paragraphs.find((p) => p.text.length > 80);
    const restartEdit = await req('POST', '/api/edit', {
      who: 'restart-test',
      op: {
        type: 'set_text',
        pid: restartTarget.pid,
        text: restartTarget.text + ' [restart-safe]',
        expect_hash: restartTarget.hash,
        why: 'revision persistence test',
        utterance: 'restart-safe',
      },
    });

    console.log('\n[the choice and revision survive a restart]');
    srv.kill();
    await sleep(1000);
    srv = boot(dataDir);
    await waitUp(srv);
    check('opus is still selected after a server restart',
      (await req('GET', '/api/health')).body.model === 'opus');
    const restoredPool = (await req('GET', '/api/models')).body;
    check('model availability survives a server restart',
      !restoredPool.enabled.includes('terra') &&
      restoredPool.automatic.watch === 'sonnet',
      JSON.stringify(restoredPool));
    const restoredHealth = (await req('GET', '/api/health')).body;
    const restoredDocument = (await req('GET', '/api/doc')).body;
    check('the document revision survives a server restart',
      restoredHealth.rev === restartEdit.body.rev,
      restoredHealth.rev);
    check('the reopened document model reports that persisted revision too',
      restoredDocument.rev === restartEdit.body.rev,
      `${restoredDocument.rev} vs ${restartEdit.body.rev}`);
    check('the edited document is reopened after a server restart',
      restoredDocument.paragraphs
        .find((p) => p.pid === restartTarget.pid).text.endsWith('[restart-safe]'));
    await req('POST', '/api/models', { model: 'terra', enabled: true });
    await req('POST', '/api/model', { model: 'sonnet' });

    console.log('\n[switching while the agent is mid-turn is refused]');
    const secondOpen = await req('POST', '/api/open', { path: doc });
    if (secondOpen.status !== 200) {
      throw new Error(secondOpen.body && secondOpen.body.error || 'could not reopen model fixture');
    }
    const agentEvents = [];
    eventRequest = http.get(`${BASE}/api/events`, (res) => {
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const match = /^event: (\w+)\ndata: (.*)$/s.exec(frame);
          if (match && match[1] === 'agent') agentEvents.push(JSON.parse(match[2]));
        }
      });
    });
    await sleep(200);

    // Starting and switching an idle process exercises lifecycle handoff but
    // never sends a prompt, so it spends no model tokens.
    await req('POST', '/api/agent/start');
    await sleep(500);
    const ag = (await req('GET', '/api/agent')).body;
    check('the agent inherits the selected model', ag.model === 'sonnet', ag.model);
    // WEAK ASSERTION, deliberately labelled as such: this greps the source for
    // the guard rather than exercising it, because driving the agent genuinely
    // busy costs tokens. It can fail if the guard is deleted, but it does NOT
    // prove the 409 fires. Real coverage belongs in the live suite.
    check('[weak, source-grep only] the mid-turn guard exists in server.js',
      /mid-turn/.test(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')));

    const liveSwitch = await req('POST', '/api/model', { model: 'opus' });
    await sleep(900);
    check('an idle live switch restarts on the requested model',
      liveSwitch.status === 200 && liveSwitch.body.restarted === true &&
      (await req('GET', '/api/agent')).body.model === 'opus',
      JSON.stringify(liveSwitch.body));
    const replacement = (await req('GET', '/api/agent')).body;
    const registeredReplacement = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'pids.json'), 'utf8')).agent;
    check('the replacement remains the current running process',
      replacement.running === true &&
      registeredReplacement.pid === replacement.pid &&
      registeredReplacement.ownerPid === srv.pid &&
      /claude\.exe$/i.test(registeredReplacement.commandIncludes || ''),
      JSON.stringify(registeredReplacement));
    check('the retired process cannot announce a stale exit during handoff',
      agentEvents.filter((event) => event.kind === 'agent-start').length >= 2 &&
      agentEvents.every((event) => event.kind !== 'agent-exit'),
      agentEvents.map((event) => event.kind).join(','));

    await req('POST', '/api/model', { model: 'sonnet' });
    await sleep(900);
    await req('POST', '/api/agent/stop');
    await sleep(200);
    const registryAfterStop = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'pids.json'), 'utf8'));
    check('an explicit stop still announces one intentional exit',
      agentEvents.filter((event) => event.kind === 'agent-exit' && event.expected).length === 1 &&
      !registryAfterStop.agent,
      agentEvents.filter((event) => event.kind === 'agent-exit').map((event) => JSON.stringify(event)).join(','));
    eventRequest.destroy();
    eventRequest = null;

    if (findBrowser()) {
      console.log('\n[the picker in the UI]');
      browser = await Browser.launch({ headless: true });
      await browser.attachToPage();
      await browser.collectErrors();
      await browser.goto(BASE + '/');
      await browser.waitFor('document.querySelectorAll(".para").length > 300', { timeout: 20000 });
      await sleep(500);
      check('startup hydrates model and lifecycle from one agent snapshot',
        await browser.eval(`performance.getEntriesByType('resource').filter((entry) =>
          new URL(entry.name).pathname === '/api/agent').length`) === 1);
      check('the picker shows the current model',
        (await browser.eval(`document.getElementById('model-btn').value`)) === 'sonnet',
        await browser.eval(`document.getElementById('model-btn').value`));
      check('the picker exposes four choices in two provider groups',
        (await browser.eval(`document.querySelectorAll('#model-btn option').length`)) === 4 &&
        (await browser.eval(`document.querySelectorAll('#model-btn optgroup').length`)) === 2);
      check('the compact pool control reports four available models',
        (await browser.eval(`document.getElementById('model-pool-btn').textContent`)) === 'auto 4');
      await browser.eval(`(document.getElementById('model-pool-btn').click(), true)`);
      await sleep(150);
      check('the pool opens with four independent switches',
        (await browser.eval(`!document.getElementById('model-pool').hidden &&
          document.querySelectorAll('.model-pool-toggle').length === 4`)) === true);
      check('the selected editing model remains visibly locked on',
        (await browser.eval(`document.querySelector(
          '.model-pool-toggle[data-model="sonnet"]').disabled`)) === true &&
        (await browser.eval(`document.querySelector(
          '.model-pool-toggle[data-model="sonnet"]').dataset.selected`)) === 'true');
      check('the floating pool stays fully inside the viewport',
        await browser.eval(`(() => {
          const r = document.getElementById('model-pool').getBoundingClientRect();
          return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
        })()`));
      await browser.eval(`(() => {
        window.__modelFetch = window.fetch;
        window.fetch = (...args) => {
          const url = new URL(args[0], location.href);
          if (url.pathname === '/api/models') {
            return Promise.reject(new TypeError('simulated model-pool transport failure'));
          }
          return window.__modelFetch(...args);
        };
        document.querySelector('.model-pool-toggle[data-model="opus"]').click();
        return true;
      })()`);
      await sleep(250);
      const refusedPool = await browser.eval(`(() => {
        const toggle = document.querySelector('.model-pool-toggle[data-model="opus"]');
        return {
          enabled: !toggle.disabled,
          pressed: toggle.getAttribute('aria-pressed'),
          hint: document.getElementById('lane-hint').textContent,
          errors: [...(window.__errs || [])]
        };
      })()`);
      check('a failed pool switch restores the control and explains that nothing changed',
        refusedPool.enabled && refusedPool.pressed === 'true' &&
        /unavailable|not changed/i.test(refusedPool.hint || ''),
        JSON.stringify(refusedPool));
      check('a failed pool switch produces no unhandled browser error',
        refusedPool.errors.length === 0, JSON.stringify(refusedPool.errors));
      await browser.eval(`(() => {
        window.fetch = window.__modelFetch;
        delete window.__modelFetch;
        window.__errs = [];
        document.getElementById('lane-hint').textContent = '';
        renderModelPool();
        return true;
      })()`);
      const invertedPool = await browser.eval(`(async () => {
        const nativeFetch = window.fetch;
        const requests = [];
        window.fetch = (input, init = {}) => {
          const url = new URL(String(input), location.href);
          if (url.pathname !== '/api/models') return nativeFetch(input, init);
          const body = JSON.parse(init.body);
          return new Promise((resolve) => requests.push({
            model: body.model,
            resolve: (value) => resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve(value)
            })
          }));
        };
        document.querySelector('.model-pool-toggle[data-model="opus"]').click();
        document.querySelector('.model-pool-toggle[data-model="terra"]').click();
        await new Promise((resolve) => setTimeout(resolve, 30));
        const bothPending = document.querySelector(
          '.model-pool-toggle[data-model="opus"]').disabled &&
          document.querySelector(
            '.model-pool-toggle[data-model="terra"]').disabled;
        requests.find((request) => request.model === 'terra').resolve({
          enabled: ['sonnet', 'sol'],
          selected: 'sonnet',
          automatic: { watch: 'sonnet', continue: 'sonnet' }
        });
        await new Promise((resolve) => setTimeout(resolve, 30));
        requests.find((request) => request.model === 'opus').resolve({
          enabled: ['sonnet', 'terra', 'sol'],
          selected: 'sonnet',
          automatic: { watch: 'sonnet', continue: 'sonnet' }
        });
        await new Promise((resolve) => setTimeout(resolve, 80));
        const result = {
          bothPending,
          opus: document.querySelector(
            '.model-pool-toggle[data-model="opus"]').getAttribute('aria-pressed'),
          terra: document.querySelector(
            '.model-pool-toggle[data-model="terra"]').getAttribute('aria-pressed'),
          pending: window.__modelPool.pending.size
        };
        window.fetch = nativeFetch;
        applyModelPool({
          enabled: ['sonnet', 'opus', 'terra', 'sol'],
          selected: 'sonnet',
          automatic: { watch: 'sonnet', continue: 'sonnet' }
        });
        return result;
      })()`);
      check('an older model-pool response cannot overwrite a newer full snapshot',
        invertedPool.bothPending && invertedPool.opus === 'false' &&
        invertedPool.terra === 'false' && invertedPool.pending === 0,
        JSON.stringify(invertedPool));
      await browser.eval(`(document.querySelector(
        '.model-pool-toggle[data-model="opus"]').click(), true)`);
      await sleep(500);
      check('a pool switch changes future availability without starting an agent',
        (await browser.eval(`document.querySelector(
          '.model-pool-toggle[data-model="opus"]').getAttribute('aria-pressed')`)) === 'false' &&
        (await req('GET', '/api/agent')).body.running === false);
      check('excluded models are unavailable in the editing picker',
        (await browser.eval(`document.querySelector('#model-btn option[value="opus"]').disabled`)) === true);
      await browser.eval(`(document.querySelector(
        '.model-pool-toggle[data-model="opus"]').click(), true)`);
      await sleep(500);
      await browser.eval(`(() => {
        const toggle = document.querySelector('.model-pool-toggle[data-model="opus"]');
        toggle.focus();
        toggle.dispatchEvent(new KeyboardEvent(
          'keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        return true;
      })()`);
      await sleep(80);
      const escapeState = await browser.eval(`({
        hidden: document.getElementById('model-pool').hidden,
        expanded: document.getElementById('model-pool-btn').getAttribute('aria-expanded'),
        active: document.activeElement && document.activeElement.id,
        activeModel: document.activeElement && document.activeElement.dataset.model
      })`);
      check('Escape closes the pool',
        escapeState.hidden && escapeState.expanded === 'false',
        JSON.stringify(escapeState));
      await browser.eval(`(() => {
        window.__modelFetch = window.fetch;
        window.fetch = (...args) => {
          const url = new URL(args[0], location.href);
          if (url.pathname === '/api/model') {
            return Promise.reject(new TypeError('simulated model-choice transport failure'));
          }
          return window.__modelFetch(...args);
        };
        const el = document.getElementById('model-btn');
        el.value = 'terra';
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      await sleep(250);
      const refusedModel = await browser.eval(`(() => {
        const picker = document.getElementById('model-btn');
        return {
          enabled: !picker.disabled,
          value: picker.value,
          model: picker.dataset.model,
          hint: document.getElementById('lane-hint').textContent,
          errors: [...(window.__errs || [])]
        };
      })()`);
      check('a failed editing-model choice restores the prior model and control',
        refusedModel.enabled && refusedModel.value === 'sonnet' &&
        refusedModel.model === 'sonnet' &&
        /unavailable|not changed/i.test(refusedModel.hint || ''),
        JSON.stringify(refusedModel));
      check('a failed editing-model choice produces no unhandled browser error',
        refusedModel.errors.length === 0, JSON.stringify(refusedModel.errors));
      await browser.eval(`(() => {
        window.fetch = window.__modelFetch;
        delete window.__modelFetch;
        window.__errs = [];
        document.getElementById('lane-hint').textContent = '';
        setModel('sonnet', false);
        return true;
      })()`);
      await browser.eval(`(() => {
        const el = document.getElementById('model-btn');
        el.value = 'terra';
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      await sleep(1500);
      check('choosing Terra switches provider',
        (await browser.eval(`document.getElementById('model-btn').value`)) === 'terra',
        await browser.eval(`document.getElementById('model-btn').value`));
      check('  and the server agrees', (await req('GET', '/api/health')).body.model === 'terra');
      check('  provider metadata is exposed for the quiet visual cue',
        (await browser.eval(`document.getElementById('model-btn').dataset.provider`)) === 'codex');
      await browser.eval(`(() => {
        const el = document.getElementById('model-btn');
        el.value = 'sol';
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      await sleep(1500);
      check('Sol is available as the deeper Codex choice',
        (await browser.eval(`document.getElementById('model-btn').value`)) === 'sol' &&
        (await browser.eval(`document.getElementById('model-btn').dataset.model`)) === 'sol');
      const errs = await browser.eval('JSON.stringify(window.__errs || null)');
      check('no page errors', errs === '[]', errs);
    }
  } catch (e) {
    console.error('\nTEST ERROR:', e && e.stack || e);
    hardFail = true;
  } finally {
    if (eventRequest) eventRequest.destroy();
    if (browser) browser.kill();
    try { srv.kill(); } catch (_) {}
    await sleep(900);
    for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch (_) { await sleep(300); } }
  }

  console.log(`\n${PASS.length} passed, ${FAIL.length} failed`);
  if (FAIL.length) console.log('failed: ' + FAIL.join(', '));
  process.exit(FAIL.length || hardFail ? 1 : 0);
}

main();
