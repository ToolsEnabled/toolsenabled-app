#!/usr/bin/env node
'use strict';
/*
 * The fallback dashboard has the same durable note/task/loop writers as
 * Studio.  Exercise the real source against deferred requests so double-click
 * and Ctrl/Cmd+Enter cannot create two records before the first write returns.
 */
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
function take(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`dashboard composer markers missing: ${start}`);
  return source.slice(a, b);
}
const composerSource = take('// ---- message board composer', '\n\n// The sticky .rail');

const elements = {};
for (const id of ['asName', 'noteText', 'pinCheck', 'sendNote', 'composer', 'rules', 'notes', 'taskText', 'taskFor', 'sendTask', 'taskComposer', 'tasklist', 'loopText', 'loopEvery', 'sendLoop', 'loopComposer', 'looplist']) {
  elements[id] = { value: '', checked: false, disabled: false, addEventListener: () => {} };
}
const calls = [];
const pending = [];
const toasts = [];
const storage = new Map();
function post(pathname, body) {
  calls.push({ pathname, body });
  return new Promise((resolve, reject) => pending.push({ resolve, reject }));
}
const composers = new Function('$', 'post', 'toast', 'localStorage', `
  ${composerSource}
  return { submitNote, submitTask, submitLoop };
`)(
  (id) => elements[id], post, (...args) => toasts.push(args),
  { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) }
);

const checks = [];
function check(description, condition) { checks.push({ description, ok: !!condition }); }
async function settle() { await Promise.resolve(); await Promise.resolve(); }

async function exercise({ name, submit, route, fill, send, clear, draft }) {
  fill();
  const first = submit();
  const second = submit();
  check(`${name} ignores a duplicate while pending`, calls.filter((call) => call.pathname === route).length === 1 && send.disabled);
  pending.shift().resolve({ ok: true });
  await Promise.all([first, second]);
  await settle();
  check(`${name} clears only after success and re-enables send`, clear() && !send.disabled);

  fill();
  const failed = submit();
  check(`${name} disables send during a later pending request`, send.disabled);
  pending.shift().reject(new Error('simulated dashboard failure'));
  await failed;
  await settle();
  check(`${name} preserves its draft after failure and re-enables send`, draft() && !send.disabled);
}

async function main() {
  elements.asName.value = 'josh';
  await exercise({
    name: 'note', submit: composers.submitNote, route: '/api/board', send: elements.sendNote,
    fill: () => { elements.noteText.value = 'Keep the title concise'; elements.pinCheck.checked = true; },
    clear: () => elements.noteText.value === '' && elements.pinCheck.checked === false,
    draft: () => elements.noteText.value === 'Keep the title concise' && elements.pinCheck.checked === true,
  });
  await exercise({
    name: 'task', submit: composers.submitTask, route: '/api/tasks', send: elements.sendTask,
    fill: () => { elements.taskText.value = 'Review slide one'; elements.taskFor.value = 'worker-1'; },
    clear: () => elements.taskText.value === '' && elements.taskFor.value === '',
    draft: () => elements.taskText.value === 'Review slide one' && elements.taskFor.value === 'worker-1',
  });
  check('dashboard task composer marks every explicit worker assignment for immediate wake',
    calls.filter((call) => call.pathname === '/api/tasks').every((call) =>
      call.body.by === 'josh' && call.body.assignee === 'worker-1' && call.body.wakeWorker === true));
  await exercise({
    name: 'loop', submit: composers.submitLoop, route: '/api/loops', send: elements.sendLoop,
    fill: () => { elements.loopText.value = 'Check contrast'; elements.loopEvery.value = '10m'; },
    clear: () => elements.loopText.value === '' && elements.loopEvery.value === '',
    draft: () => elements.loopText.value === 'Check contrast' && elements.loopEvery.value === '10m',
  });

  const passed = checks.filter((item) => item.ok).length;
  for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.description}`);
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((err) => { console.error(err.stack || err); process.exit(1); });
