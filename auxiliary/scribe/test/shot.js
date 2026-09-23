// One-off: render the real paper and photograph it, light and dark.
const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path'); const http = require('http');
const { Browser, sleep } = require('./cdp');
const { availablePort, waitForOwnedHealth } = require('./isolated_server');
const ROOT = path.join(__dirname, '..'), TMP = path.join(__dirname, '_tmp_shot');
let PORT = null, BASE = null;
const post = (p, b) => new Promise((res, rej) => { const d = JSON.stringify(b || {});
  const r = http.request(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(d) } }, (x) => { let o = ''; x.on('data', c => o += c); x.on('end', () => res(o)); }); r.on('error', rej); r.write(d); r.end(); });
const getJson = (p) => new Promise((res, rej) => {
  const r = http.get(`${BASE}${p}`, (x) => {
    let o = '';
    x.on('data', c => o += c);
    x.on('end', () => {
      let body = o;
      try { body = JSON.parse(o || '{}'); } catch (_) {}
      res({ status: x.statusCode, body });
    });
  });
  r.on('error', rej);
});
(async () => {
  PORT = await availablePort();
  BASE = `http://127.0.0.1:${PORT}`;
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'data', 'documents'), { recursive: true });
  const doc = path.join(TMP, 'data', 'documents', 'paper.docx');
  fs.copyFileSync(path.join(ROOT, 'data', 'documents', 'McnairNextDraft.docx'), doc);
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, shell: false, stdio: 'ignore',
    env: { ...process.env, SCRIBE_PORT: String(PORT), SCRIBE_DATA: path.join(TMP, 'data'),
      SCRIBE_WATCH_TEST: '1', SCRIBE_PREDICT_TEST: '1' } });
  let b = null;
  try {
  await waitForOwnedHealth(
    () => getJson('/api/health'),
    srv,
    { attempts: 150, interval: 100 },
  );
  b = await Browser.launch({ headless: true }); await b.attachToPage(); await b.collectErrors();
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await b.goto(`${BASE}/`);
  await b.waitFor(`document.getElementById('health-dot').classList.contains('ok')`, { timeout: 10000 });
  await b.screenshot(path.join(__dirname, 'shot-empty-light.png'));
  await b.screenshot(path.join(__dirname, 'shot-empty-compact-light.png'), { width: 820, height: 900 });
  await b.screenshot(path.join(__dirname, 'shot-empty-phone-light.png'), { width: 390, height: 844 });
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(250);
  await b.screenshot(path.join(__dirname, 'shot-empty-phone-dark.png'), { width: 390, height: 844 });
  await b.screenshot(path.join(__dirname, 'shot-empty-compact-dark.png'), { width: 820, height: 900 });
  await b.screenshot(path.join(__dirname, 'shot-empty-dark.png'), { width: 1440, height: 900 });
  // Capture the composer only after an explicit focus gesture. Resting chrome
  // stays quiet; focus may reveal the line but must not submit a model prompt.
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await b.eval(`(document.getElementById('say').focus(), true)`);
  await sleep(240);
  await b.screenshot(path.join(__dirname, 'shot-composer-light.png'), { width: 1440, height: 900 });
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(240);
  await b.screenshot(path.join(__dirname, 'shot-composer-dark.png'), { width: 1440, height: 900 });

  // A delivery refusal preserves the draft and uses a small error-colored line;
  // keep a visual fixture so that recovery never becomes either invisible or
  // an oversized alert.
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await b.eval(`(() => {
    const input = document.getElementById('say');
    input.value = 'Help me tighten the opening claim';
    document.getElementById('bar').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }));
  })(), true`);
  await b.waitFor(`document.getElementById('bar').dataset.delivery === 'error'`, { timeout: 5000 });
  await sleep(240);
  await b.screenshot(path.join(__dirname, 'shot-message-error-light.png'), { width: 1440, height: 900 });
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(240);
  await b.screenshot(path.join(__dirname, 'shot-message-error-dark.png'), { width: 1440, height: 900 });
  await b.eval(`(() => {
    const input = document.getElementById('say');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.blur();
  })(), true`);
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await post('/api/open', { path: doc });
  await b.waitFor('document.querySelectorAll(".para").length > 250', { timeout: 20000 });
  const m = (await getJson('/api/doc')).body;
  const t = m.paragraphs.find(p => p.text.length > 400 && !p.table);
  // The automatic-model availability panel is a compact overlay, so keep its
  // resting and expanded treatments under visual review in both color schemes.
  await b.eval(`(document.getElementById('model-pool-btn').click(), true)`);
  await sleep(220);
  await b.screenshot(path.join(__dirname, 'shot-model-pool-light.png'), { width: 1440, height: 900 });
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(220);
  await b.screenshot(path.join(__dirname, 'shot-model-pool-dark.png'), { width: 1440, height: 900 });
  await b.eval(`(setModelPoolOpen(false), true)`);
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await b.eval(`(() => {
    renderSidecarStatus({
      lane: 'watch',
      pid: '${t.pid}',
      text: 'The review timed out. Nothing was changed.',
      error: true,
      duration: 60000
    });
    renderSidecarStatus({
      lane: 'continue',
      pid: '${t.pid}',
      model: 'sonnet',
      text: 'No useful next paragraph was found. Nothing was added.',
      duration: 60000
    });
    document.querySelector('[data-pid="${t.pid}"]').scrollIntoView({block:'center'});
  })(), true`);
  await sleep(220);
  await b.screenshot(path.join(__dirname, 'shot-sidecar-status-light.png'), { width: 1440, height: 900 });
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(220);
  await b.screenshot(path.join(__dirname, 'shot-sidecar-status-dark.png'), { width: 1440, height: 900 });
  await b.eval(`(clearSidecarStatus(), true)`);
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await post('/api/edit', { who: 'josh', op: { type: 'replace', pid: t.pid, find: t.text.slice(60, 96), replace: 'the semantic edge, not model skill', why: 'sharper claim', utterance: 's1', expect_hash: t.hash } });
  await b.waitFor(`document.querySelector('mark.changed')`, { timeout: 8000 });
  // Populate the agent lane so the screenshot shows the rail doing its job.
  const feed = async (d) => { await b.eval(`(window.__feed('agent', ${JSON.stringify(JSON.stringify(d)).slice(1,-1).replace(/\\"/g,'"')}), true)`); await sleep(80); };
  const ev = async (d) => { await b.send('Runtime.evaluate', { expression: `window.__feed('agent', ${JSON.stringify(d)})`, returnByValue: true }); await sleep(70); };
  await ev({ kind: 'agent-start', pid: 1 });
  await ev({ kind: 'session', sessionId: 'x', tools: [], mcp: [{ name: 'doc', status: 'connected' }] });
  await ev({ kind: 'turn-start', ttftMs: 3919 });
  await ev({ kind: 'tool-pending', id: 't1', name: 'mcp__doc__doc_find', parent: null });
  await ev({ kind: 'tool-call', id: 't1', name: 'mcp__doc__doc_find', parent: null, input: { query: 'determinacy count' } });
  await ev({ kind: 'tool-result', id: 't1', parent: null, isError: false, text: '3 matches: pid=51C326DE chars 402-419 ...' });
  await ev({ kind: 'tool-pending', id: 't2', name: 'Agent', parent: null });
  await ev({ kind: 'tool-call', id: 't2', name: 'Agent', parent: null, input: { subagent_type: 'researcher', description: 'confirm 3 of 20 against the audit' } });
  await ev({ kind: 'tool-call', id: 'k1', name: 'mcp__research__corpus_search', parent: 't2', input: { query: 'determinate prompts' } });
  await ev({ kind: 'tool-result', id: 'k1', parent: 't2', isError: false, text: 'qcb_audit/REPORT.md: 3 of 20 tasks determinate (mtime 2026-07-14)' });
  await ev({ kind: 'tool-call', id: 'k2', name: 'mcp__research__db_query', parent: 't2', input: { sql: 'SELECT interpretation_strictness ...' } });
  await ev({ kind: 'tool-pending', id: 't3', name: 'mcp__doc__doc_replace', parent: null });
  await ev({ kind: 'tool-args', id: 't3', partial: '{"pid":"51C326DE","find":"only 3 of 20 prompts","replace":"3 of 20 prompts (1 of 20 by the advisory scre' });
  await ev({ kind: 'thinking', tokens: 412 });
  await b.send('Runtime.evaluate', { expression: `window.__feed('trail', ${JSON.stringify({
    at: '2026-07-20T00:00:00.000Z', op: 'said', who: 'human',
    summary: 'Can you check the determinacy count and make the claim precise?',
  })})` });
  await b.send('Runtime.evaluate', { expression: `window.__feed('trail', ${JSON.stringify({
    at: '2026-07-20T00:00:08.000Z', op: 'turn', who: 'agent',
    summary: 'The audit supports 3 of 20 determinate tasks. I tightened the sentence and kept the supporting distinction.',
  })})` });
  await sleep(120);
  await b.eval(`document.querySelector('[data-pid="${t.pid}"]').scrollIntoView({block:'center'}), true`);
  await sleep(700);
  await b.screenshot(path.join(__dirname, 'shot-light.png'));
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(400);
  await b.screenshot(path.join(__dirname, 'shot-dark.png'));
  // Photograph the direct-edit focus treatment without changing the document.
  const editTarget = m.paragraphs.find(p => p.pid !== t.pid && p.text.length > 180 && !p.table);
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await b.eval(`(() => {
    const el = document.querySelector('[data-pid="${editTarget.pid}"]');
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    el.focus();
    el.scrollIntoView({block:'center'});
  })(), true`);
  await sleep(250);
  await b.screenshot(path.join(__dirname, 'shot-editing-light.png'));
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(250);
  await b.screenshot(path.join(__dirname, 'shot-editing-dark.png'));
  await b.eval(`document.querySelector('[data-pid="${editTarget.pid}"]').dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })), true`);

  // Show one realistic read-only watch note attached to the exact paragraph.
  await b.eval(`(document.getElementById('watch-toggle').click(), true)`);
  await sleep(200);
  const current = (await getJson('/api/doc')).body;
  const currentTarget = current.paragraphs.find(p => p.pid === t.pid);
  const review = JSON.parse(await post('/api/watch/review', {
    quietMs: 25000,
    changes: [{ pid: t.pid, before: t.text, after: currentTarget.text }],
  }));
  await post('/api/assist', {
    review_id: review.id,
    anchor_pid: t.pid,
    kind: 'answer',
    title: 'The likely missing link',
    text: 'This claim turns on the determinacy screen. You may want the exact 3-of-20 count nearby before extending the argument.',
    grounding: [{ claim: 'The audit fixes the determinate-task count.',
      source: 'qcb_audit/REPORT.md', quote: '3 of 20 tasks' }],
  });
  await b.waitFor(`document.querySelector('.assist-note')`, { timeout: 8000 });
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await b.eval(`document.querySelector('.assist-note').scrollIntoView({block:'center'}), true`);
  await sleep(250);
  await b.screenshot(path.join(__dirname, 'shot-watch-note-light.png'));
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(250);
  await b.screenshot(path.join(__dirname, 'shot-watch-note-dark.png'));
  await b.eval(`(() => {
    const nativeFetch = window.fetch.bind(window);
    window.__restoreShotAssistFetch = () => { window.fetch = nativeFetch; };
    window.fetch = (input, init = {}) => {
      const url = new URL(String(input), location.href);
      if (url.pathname === '/api/assist/dismiss') {
        return Promise.resolve(new Response(JSON.stringify({
          error: 'Scribe is temporarily unavailable.'
        }), { status: 503, headers: { 'content-type': 'application/json' } }));
      }
      return nativeFetch(input, init);
    };
    document.querySelector('.assist-dismiss').click();
  })(), true`);
  await b.waitFor(`document.querySelector('.assist-action-status')`, { timeout: 5000 });
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await sleep(250);
  await b.screenshot(path.join(__dirname, 'shot-watch-dismiss-error-light.png'));
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(250);
  await b.screenshot(path.join(__dirname, 'shot-watch-dismiss-error-dark.png'));
  await b.eval(`(window.__restoreShotAssistFetch(), true)`);
  await b.eval(`(document.querySelector('.assist-dismiss').click(), true)`);
  await b.waitFor(`!document.querySelector('.assist-note')`, { timeout: 5000 });

  // The one-minute predictive path is held in test mode and completed with a
  // representative paragraph, so the exact ghost treatment is photographed
  // without spending tokens or changing the document.
  const seedModel = (await getJson('/api/doc')).body;
  const seedBefore = seedModel.paragraphs.find(p => p.pid === t.pid);
  const seeded = JSON.parse(await post('/api/edit', {
    who: 'human',
    op: {
      type: 'set_text',
      pid: t.pid,
      text: seedBefore.text + ' [visual continuation seed]',
      expect_hash: seedBefore.hash,
      why: 'typed directly',
      utterance: 'visual-continuation',
    },
  }));
  await sleep(140);
  const prediction = JSON.parse(await post('/api/predict', {
    capture_id: 'visual-continuation',
    pid: t.pid,
    before: seeded.result.before,
    after: seeded.result.after,
    quietMs: 60000,
    grant: seeded.prediction_grant.token,
  }));
  await b.waitFor(`document.querySelector('.continuation-pending[data-prediction="${prediction.id}"]')`,
    { timeout: 5000 });
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await b.eval(`document.querySelector('.continuation-pending').scrollIntoView({block:'center'}), true`);
  await sleep(250);
  await b.screenshot(path.join(__dirname, 'shot-continuation-pending-light.png'));
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(250);
  await b.screenshot(path.join(__dirname, 'shot-continuation-pending-dark.png'));
  await post('/api/predict/fixture', {
    text: `<continuation>That distinction also changes what the benchmark can support as evidence. A determinate task makes disagreement interpretable because the expected action sequence is fixed before a model runs. The remaining failures can then be separated into specification, platform, and implementation errors instead of being collapsed into one score. This is where the evaluation becomes diagnostic rather than merely comparative. The next section applies that separation to the observed backtests.</continuation>`,
  });
  await b.waitFor(`document.querySelector('.continuation-note[data-continuation="${prediction.id}"]')`,
    { timeout: 5000 });
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await b.eval(`document.querySelector('.continuation-note').scrollIntoView({block:'center'}), true`);
  await sleep(250);
  await b.screenshot(path.join(__dirname, 'shot-continuation-light.png'));
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(250);
  await b.screenshot(path.join(__dirname, 'shot-continuation-dark.png'));
  await b.eval(`(() => {
    const nativeFetch = window.fetch.bind(window);
    window.__restoreShotFetch = () => { window.fetch = nativeFetch; };
    window.fetch = (input, init = {}) => {
      const url = new URL(String(input), location.href);
      if (url.pathname === '/api/predict/accept') {
        return Promise.resolve(new Response(JSON.stringify({
          error: 'The document changed before this paragraph could be inserted.'
        }), { status: 409, headers: { 'content-type': 'application/json' } }));
      }
      return nativeFetch(input, init);
    };
    document.querySelector('.continuation-insert').click();
  })(), true`);
  await b.waitFor(`document.querySelector('.continuation-action-status')`, { timeout: 5000 });
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await sleep(250);
  await b.screenshot(path.join(__dirname, 'shot-continuation-insert-error-light.png'));
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(250);
  await b.screenshot(path.join(__dirname, 'shot-continuation-insert-error-dark.png'));
  await b.eval(`(window.__restoreShotFetch(), true)`);
  await b.eval(`(document.querySelector('.continuation-dismiss').click(), true)`);
  await b.waitFor(`!document.querySelector('.continuation-note')`, { timeout: 5000 });

  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await b.eval(`document.querySelector('[data-pid="${t.pid}"]').scrollIntoView({block:'center'}), true`);
  await sleep(250);
  await b.screenshot(path.join(__dirname, 'shot-compact-light.png'), { width: 820, height: 900 });
  await b.screenshot(path.join(__dirname, 'shot-phone-light.png'), { width: 390, height: 844 });
  await b.eval(`(document.getElementById('rail-toggle').click(), true)`);
  await sleep(250);
  await b.screenshot(path.join(__dirname, 'shot-phone-activity-light.png'), { width: 390, height: 844 });
  await b.screenshot(path.join(__dirname, 'shot-compact-activity-light.png'), { width: 820, height: 900 });
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(250);
  await b.screenshot(path.join(__dirname, 'shot-compact-activity-dark.png'), { width: 820, height: 900 });
  await b.eval(`(document.getElementById('rail-toggle').click(), true)`);
  await sleep(250);
  await b.screenshot(path.join(__dirname, 'shot-compact-dark.png'), { width: 820, height: 900 });
  console.log('errs:', await b.eval('JSON.stringify(window.__errs)'));
  console.log('done');
  } finally {
    if (b) b.kill();
    srv.kill();
    await sleep(600);
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(TMP, { recursive: true, force: true }); break; }
      catch (_) { await sleep(300); }
    }
  }
})();
