#!/usr/bin/env node
'use strict';
/*
 * History is global deck state. One human gesture must create one request, and
 * an SSE count update received before the POST response must remain authoritative
 * after the request's finally block runs.
 */
const fs = require('fs');
const path = require('path');

function take(source, start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`history markers missing: ${start}`);
  return source.slice(a, b);
}
function button() {
  return { disabled: false, title: '', addEventListener: () => {} };
}
function deferredPost() {
  const calls = [];
  const pending = [];
  return {
    calls,
    post: (route, body) => {
      calls.push({ route, body });
      return new Promise((resolve) => pending.push(resolve));
    },
    resolve: (value) => {
      const fn = pending.shift();
      if (!fn) throw new Error('no pending history request');
      fn(value);
    },
  };
}

const checks = [];
function check(description, condition) { checks.push({ description, ok: !!condition }); }

async function studioChecks() {
  const source = fs.readFileSync(path.join(__dirname, 'public', 'studio.js'), 'utf8');
  const history = take(source, 'let undoCount = 0, redoCount = 0, historyPosting = false;', '\n// --------------------------------------------------------------- PDF export');
  const elements = {
    undoBtn: button(), compactUndoBtn: button(),
    redoBtn: button(), compactRedoBtn: button(),
  };
  const io = deferredPost();
  const client = new Function('$', 'post', 'toast', `
    ${history}
    return {
      doUndo, doRedo,
      setCounts: (undo, redo) => { undoCount = undo; redoCount = redo; paintUndo(); },
      posting: () => historyPosting,
    };
  `)((id) => elements[id], io.post, () => {});

  client.setCounts(2, 1);
  const first = client.doUndo();
  const duplicate = client.doUndo();
  check('Studio sends only one undo while history is pending',
    io.calls.length === 1 && io.calls[0].route === '/api/undo' && client.posting());
  check('Studio disables both desktop and compact history controls while pending',
    Object.values(elements).every((el) => el.disabled));

  // This is the real ordering: the server broadcasts counts before it ends the
  // POST response.
  client.setCounts(0, 2);
  io.resolve({ ok: true, undone: { editor: 'human', detail: 'edit' } });
  await Promise.all([first, duplicate]);
  check('Studio keeps the SSE final history counts after the POST settles',
    elements.undoBtn.disabled && elements.compactUndoBtn.disabled
      && !elements.redoBtn.disabled && !elements.compactRedoBtn.disabled);

  client.setCounts(1, 2);
  const redo = client.doRedo();
  const crossAction = client.doUndo();
  check('Studio shares one latch across undo and redo', io.calls.length === 2 && io.calls[1].route === '/api/redo');
  client.setCounts(2, 1);
  io.resolve({ ok: true, redone: { editor: 'human', detail: 'edit' } });
  await Promise.all([redo, crossAction]);
}

async function dashboardChecks() {
  const source = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
  const declarations = take(source, 'let undoCount = 0, redoCount = 0, historyPosting = false;', '\n// PDF export');
  const actions = take(source, 'async function doUndo() {', '\n\n// keyboard:');
  const elements = { undoBtn: button(), redoBtn: button() };
  const io = deferredPost();
  const client = new Function('$', 'post', 'toast', `
    ${declarations}
    ${actions}
    return {
      doUndo, doRedo,
      setCounts: (undo, redo) => { undoCount = undo; redoCount = redo; updateUndoRedoButtons(); },
      posting: () => historyPosting,
    };
  `)((id) => elements[id], io.post, () => {});

  client.setCounts(1, 0);
  const first = client.doUndo();
  const duplicate = client.doUndo();
  check('Dashboard sends only one undo while history is pending',
    io.calls.length === 1 && elements.undoBtn.disabled && elements.redoBtn.disabled);
  client.setCounts(0, 1);
  io.resolve({ ok: true, undone: { editor: 'human', detail: 'edit' } });
  await Promise.all([first, duplicate]);
  check('Dashboard does not re-enable an exhausted undo after its response',
    elements.undoBtn.disabled && !elements.redoBtn.disabled && !client.posting());
}

async function main() {
  await studioChecks();
  await dashboardChecks();
  const passed = checks.filter((item) => item.ok).length;
  for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.description}`);
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}
main().catch((err) => { console.error(err.stack || err); process.exit(1); });
