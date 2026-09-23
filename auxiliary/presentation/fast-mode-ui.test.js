#!/usr/bin/env node
'use strict';
/* Focused DOM-light contract for the dashboard and Studio Fast controls. */
const fs = require('fs');
const path = require('path');

const appSource = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
const studioSource = fs.readFileSync(path.join(__dirname, 'public', 'studio.js'), 'utf8');
const dashboardHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const dashboardCss = fs.readFileSync(path.join(__dirname, 'public', 'styles.css'), 'utf8');
const studioCss = fs.readFileSync(path.join(__dirname, 'public', 'studio.css'), 'utf8');

function take(source, start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`Fast UI marker missing: ${start}`);
  return source.slice(a, b);
}
function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

const checks = [];
function check(description, condition) { checks.push({ description, ok: !!condition }); }

const initialProfile = {
  profile: 'beast',
  profiles: { beast: { serviceTier: 'standard' } },
  nextExecution: { serviceTier: 'standard', fastMode: false },
  fastMode: {
    enabled: false, available: true, appliedToNextSpawn: false, pending: false,
    provider: 'codex', appliesTo: 'next spawn',
    reason: 'Fast is OFF for the next Codex spawn. Running agents keep the service they started with.',
  },
};

const appBlock = take(
  appSource,
  'function fastModeHtml(info, busy) {',
  "\nif ($('fastModeControl'))"
);
function makeDashboardClient(postImpl) {
  const mount = { innerHTML: '' };
  const toasts = [];
  const profile = JSON.parse(JSON.stringify(initialProfile));
  const client = new Function('initial', '$', 'post', 'toast', 'esc', `
    let profileInfo = initial;
    let fastModePosting = false;
    ${appBlock}
    renderFastMode();
    return {
      mount: () => $('fastModeControl'),
      setFastMode,
      state: () => profileInfo,
      busy: () => fastModePosting,
    };
  `)(profile, (id) => id === 'fastModeControl' ? mount : null, postImpl, (...args) => toasts.push(args), esc);
  client.toasts = () => toasts;
  return client;
}

async function main() {
  check('dashboard has one simple Fast mount and no new settings panel',
    (dashboardHtml.match(/id="fastModeControl"/g) || []).length === 1
      && !/fast[^\n]{0,30}settings-panel/i.test(dashboardHtml));
  check('dashboard and Studio CSS expose explicit pending and unavailable states',
    dashboardCss.includes('.fast-mode-ctl.pending')
      && dashboardCss.includes('.fast-mode-ctl.unavailable')
      && studioCss.includes('.fast-ctl.unavailable'));

  const calls = [];
  let release;
  const pendingResponse = new Promise((resolve) => { release = resolve; });
  const dashboard = makeDashboardClient(async (route, body) => {
    calls.push({ route, body });
    return pendingResponse;
  });
  check('dashboard starts with visible OFF and next-spawn text',
    dashboard.mount().innerHTML.includes('Fast OFF')
      && dashboard.mount().innerHTML.includes('next spawn'));
  const first = dashboard.setFastMode(true);
  const duplicate = dashboard.setFastMode(true);
  await Promise.resolve();
  check('dashboard blocks a duplicate click while one exact human POST is pending',
    calls.length === 1
      && calls[0].route === '/api/agents/fast-mode'
      && JSON.stringify(calls[0].body) === JSON.stringify({ enabled: true, by: 'dashboard' })
      && dashboard.busy() === true
      && dashboard.mount().innerHTML.includes('saving...')
      && dashboard.mount().innerHTML.includes('aria-busy="true"'));
  release({
    ok: true, changed: true, enabled: true, available: true,
    appliedToNextSpawn: true, pending: true, provider: 'codex', appliesTo: 'next spawn',
    reason: 'Fast is ON for the next Codex spawn. Running agents keep the service they started with.',
  });
  await Promise.all([first, duplicate]);
  check('authoritative success repaints dashboard ON with pending next-spawn state',
    dashboard.state().fastMode.enabled === true
      && dashboard.state().nextExecution.fastMode === true
      && dashboard.state().nextExecution.serviceTier === 'fast'
      && dashboard.mount().innerHTML.includes('Fast ON')
      && dashboard.mount().innerHTML.includes('pending · next spawn')
      && dashboard.busy() === false);

  const failing = makeDashboardClient(async () => { throw new Error('forced Fast failure'); });
  await failing.setFastMode(true);
  check('failed dashboard POST leaves the prior OFF preference rendered',
    failing.state().fastMode.enabled === false
      && failing.mount().innerHTML.includes('Fast OFF')
      && failing.busy() === false
      && failing.toasts().some((args) => /forced Fast failure/.test(String(args[0])) && args[1] === true));

  const claudeFast = {
    enabled: true, available: false, appliedToNextSpawn: false, pending: false,
    provider: 'claude',
    reason: 'Fast is saved ON but is unavailable and not applied on Claude.',
  };
  const claudeRender = new Function('info', 'esc', `
    ${take(appSource, 'function fastModeHtml(info, busy) {', '\nfunction mergeFastModeResult')}
    return fastModeHtml(info, false);
  `);
  const claudeDashboardHtml = claudeRender({ fastMode: claudeFast }, esc);
  check('dashboard keeps saved ON visible on Claude without claiming acceleration',
    claudeDashboardHtml.includes('Fast ON')
      && claudeDashboardHtml.includes('not applied on Claude')
      && claudeDashboardHtml.includes('next Codex spawn')
      && claudeDashboardHtml.includes('unavailable')
      && !claudeDashboardHtml.includes('active'));

  const studioFastBlock = take(studioSource, 'function fastModeHtml() {', '\n// Access is resolved');
  const studioProfile = JSON.parse(JSON.stringify(initialProfile));
  studioProfile.fastMode = {
    enabled: true, available: false, appliedToNextSpawn: false, pending: false,
    provider: 'claude', appliesTo: 'next spawn',
    reason: 'Fast is saved ON but is unavailable and not applied on Claude.',
  };
  const studioHtml = new Function('profileInfo', 'fastModePosting', 'esc', `
    ${studioFastBlock}
    return fastModeHtml();
  `)(studioProfile, false, esc);
  check('Studio reuses the saved ON state but says Claude is not accelerated',
    studioHtml.includes('>ON</button>')
      && studioHtml.includes('not applied on Claude · next Codex spawn')
      && studioHtml.includes('fast-ctl unavailable')
      && !studioHtml.includes('class="active"'));
  check('both Studio surfaces render the same control and delegate its click',
    studioSource.includes('providerHtml() + fastModeHtml()')
      && studioSource.includes("closest('[data-fast-mode]')")
      && studioSource.includes("post('/api/agents/fast-mode', { enabled, by: 'josh' })"));
  check('dashboard refreshes Fast state from bootstrap, snapshot, and agents events',
    (appSource.match(/profileInfo = (?:s|ev)\.profile \|\| profileInfo; renderFastMode\(\);/g) || []).length === 3);

  const passed = checks.filter((item) => item.ok).length;
  for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.description}`);
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => { console.error(error.stack || error); process.exit(1); });
