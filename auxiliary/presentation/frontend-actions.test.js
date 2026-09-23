#!/usr/bin/env node
'use strict';
/*
 * Failure-path checks for actions whose happy path is driven by SSE: pause must
 * report a refused write, read-only badges must ignore non-2xx bodies, and a
 * successful chat retry must clear the prior delivery warning.
 */
const fs = require('fs');
const path = require('path');

function take(source, start, end, from = 0) {
  const a = source.indexOf(start, from);
  const b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`frontend action markers missing: ${start}`);
  return source.slice(a, b);
}
const studio = fs.readFileSync(path.join(__dirname, 'public', 'studio.js'), 'utf8');
const dashboard = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
const checks = [];
function check(description, condition) { checks.push({ description, ok: !!condition }); }

async function pauseChecks() {
  const handlerSource = take(
    studio,
    "$('pauseBtn').addEventListener('click', async () => {",
    '\n\n// -------------------------------------------------------------------- SSE'
  );
  const button = { disabled: false, addEventListener: (type, fn) => { if (type === 'click') button.click = fn; } };
  const toasts = [];
  let response = Promise.resolve({ ok: false, error: 'state could not persist' });
  new Function('$', 'post', 'toast', `
    let paused = false;
    ${handlerSource}
  `)((id) => id === 'pauseBtn' ? button : null, () => response, (...args) => toasts.push(args));

  await button.click();
  check('Studio visibly reports a rejected pause response',
    toasts.length === 1 && toasts[0][0] === 'state could not persist' && toasts[0][1] === true && !button.disabled);
  toasts.length = 0;
  response = Promise.reject(new Error('offline'));
  await button.click();
  check('Studio visibly reports a pause connection failure',
    toasts.length === 1 && /connection error/.test(toasts[0][0]) && toasts[0][1] === true && !button.disabled);
}

async function fetchChecks(label, source, jsonEnd) {
  const fetchJsonSource = take(source, 'function fetchJson(path) {', jsonEnd);
  const lintSource = take(source, 'function fetchLint() {', '\n}', source.indexOf('function fetchLint() {')) + '\n}';
  const timingSource = take(source, 'function fetchTiming() {', '\n}', source.indexOf('function fetchTiming() {')) + '\n}';
  const rendered = [];
  let ok = false;
  const client = new Function('fetch', 'renderLint', 'renderTiming', `
    ${fetchJsonSource}
    ${lintSource}
    ${timingSource}
    return { fetchLint, fetchTiming };
  `)(
    (route) => Promise.resolve({
      ok,
      status: ok ? 200 : 503,
      json: () => Promise.resolve(route.includes('lint') ? { ok: true } : { totalSeconds: 99 }),
    }),
    (value) => rendered.push(['lint', value]),
    (value) => rendered.push(['timing', value])
  );
  await Promise.all([client.fetchLint(), client.fetchTiming()]);
  check(`${label} does not render non-2xx lint/timing payloads`, rendered.length === 0);
  ok = true;
  await Promise.all([client.fetchLint(), client.fetchTiming()]);
  check(`${label} still renders successful lint/timing payloads`,
    rendered.length === 2 && rendered[0][0] === 'lint' && rendered[1][0] === 'timing');
}

async function chatChecks() {
  const chatSource = take(
    studio,
    'let chatPosting = false;',
    '\n\n// ------------------------------------------------------------- find a slide'
  );
  const elements = {
    chatform: {
      dataset: { delivery: 'error' },
      setAttribute(name, value) { this[name] = value; },
      removeAttribute(name) { delete this[name]; },
    },
    chatDelivery: {
      hidden: false, textContent: 'old failure', title: 'old detail',
      removeAttribute(name) { delete this[name]; },
    },
    chatSend: { disabled: false, textContent: 'Send' },
    chatinput: {
      value: 'retry this message', style: {}, scrollHeight: 32,
      focus() {}, setSelectionRange() {},
    },
  };
  const calls = [];
  const client = new Function(
    '$', 'post', 'parseSlash', 'runSlash', 'publishChromeSizes',
    'setPinArmed', 'sysEcho', 'toast',
    `
      let pinArmed = false;
      ${chatSource}
      return { sendChat, setChatDelivery };
    `
  )(
    (id) => elements[id] || null,
    (route, body) => {
      calls.push({ route, body });
      return Promise.resolve(route === '/api/board' ? { ok: true } : { ok: true, action: 'queued' });
    },
    () => null,
    async () => {},
    () => {},
    (on) => { pinArmed = !!on; },
    () => {},
    () => {}
  );
  client.setChatDelivery('old failure', 'old detail');
  await client.sendChat();
  check('a successful chat retry clears the previous delivery warning',
    calls.length === 2 && elements.chatDelivery.hidden
      && elements.chatDelivery.textContent === ''
      && !Object.prototype.hasOwnProperty.call(elements.chatform.dataset, 'delivery'));
}

async function main() {
  await pauseChecks();
  await fetchChecks('Studio', studio, '\n\nlet model =');
  await fetchChecks('Dashboard', dashboard, '\n\nfunction elHtml');
  await chatChecks();
  const passed = checks.filter((item) => item.ok).length;
  for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.description}`);
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}
main().catch((err) => { console.error(err.stack || err); process.exit(1); });
