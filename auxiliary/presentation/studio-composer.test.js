#!/usr/bin/env node
'use strict';
/*
 * Panel composers must turn one human submission into one durable request even
 * while a local write is still pending. Run the real composer source against a
 * small DOM/post harness so Ctrl+Enter and double-click share the same latch.
 */
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, 'public', 'studio.js'), 'utf8');
function take(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`composer markers missing: ${start}`);
  return source.slice(a, b);
}

const composerSource = take('let notePosting = false, taskPosting = false, loopPosting = false;', '\n\n// Delegated onto the live lists');
const elements = {};
for (const id of ['asName', 'noteText', 'pinCheck', 'sendNote', 'composer', 'taskText', 'taskFor', 'sendTask', 'taskComposer', 'loopText', 'loopEvery', 'sendLoop', 'loopComposer']) {
  elements[id] = { value: '', checked: false, disabled: false, addEventListener: () => {} };
}
const calls = [];
const pending = [];
const toasts = [];
const storage = new Map();
function post(pathname, body) {
  calls.push({ pathname, body });
  return new Promise((resolve) => pending.push(resolve));
}
const composers = new Function('$', 'post', 'toast', 'localStorage', 'parseCadence', `
  let loopRunner = null, paused = false;
  ${composerSource}
  return { submitNote, submitTask, submitLoop };
`)(
  (id) => elements[id], post, (...args) => toasts.push(args),
  { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
  () => true
);

const checks = [];
function check(description, condition) { checks.push({ description, ok: !!condition }); }
async function settle() { await Promise.resolve(); await Promise.resolve(); }

async function exercise({ name, submit, path, fill, send, clear, failureDraft }) {
  fill();
  const first = submit();
  const second = submit();
  check(`${name} ignores a duplicate while pending`, calls.filter((call) => call.pathname === path).length === 1 && send.disabled);
  pending.shift()({ ok: true });
  await Promise.all([first, second]);
  await settle();
  check(`${name} clears only after success and re-enables send`, clear() && !send.disabled);

  fill();
  const failed = submit();
  check(`${name} disables send during a later pending request`, send.disabled);
  pending.shift()({ ok: false, error: 'simulated refusal' });
  await failed;
  await settle();
  check(`${name} preserves its draft after failure and re-enables send`, failureDraft() && !send.disabled);
}

async function main() {
  elements.asName.value = 'josh';
  await exercise({
    name: 'note', submit: composers.submitNote, path: '/api/board', send: elements.sendNote,
    fill: () => { elements.noteText.value = 'Keep the title concise'; elements.pinCheck.checked = true; },
    clear: () => elements.noteText.value === '' && elements.pinCheck.checked === false,
    failureDraft: () => elements.noteText.value === 'Keep the title concise' && elements.pinCheck.checked === true,
  });
  await exercise({
    name: 'task', submit: composers.submitTask, path: '/api/tasks', send: elements.sendTask,
    fill: () => { elements.taskText.value = 'Review slide one'; elements.taskFor.value = 'worker-1'; },
    clear: () => elements.taskText.value === '' && elements.taskFor.value === '',
    failureDraft: () => elements.taskText.value === 'Review slide one' && elements.taskFor.value === 'worker-1',
  });
  check('Studio task composer marks every explicit worker assignment for immediate wake',
    calls.filter((call) => call.pathname === '/api/tasks').every((call) =>
      call.body.by === 'josh' && call.body.assignee === 'worker-1' && call.body.wakeWorker === true));
  await exercise({
    name: 'loop', submit: composers.submitLoop, path: '/api/loops', send: elements.sendLoop,
    fill: () => { elements.loopText.value = 'Check contrast'; elements.loopEvery.value = '10m'; },
    clear: () => elements.loopText.value === '' && elements.loopEvery.value === '',
    failureDraft: () => elements.loopText.value === 'Check contrast' && elements.loopEvery.value === '10m',
  });

  const passed = checks.filter((item) => item.ok).length;
  for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.description}`);
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((err) => { console.error(err.stack || err); process.exit(1); });
