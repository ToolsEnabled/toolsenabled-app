#!/usr/bin/env node
'use strict';
/*
 * Escape has one ordered stack.  The older slide-navigation listener must not
 * run a second Escape action before the panel/menu/presentation stack decides
 * what the key means.
 */
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, 'public', 'studio.js'), 'utf8');
function take(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`Studio handler markers missing: ${start}`);
  return source.slice(a, b);
}

const navigationSource = take(
  "document.addEventListener('keydown', (e) => {",
  '\n\n// ------------------------------------------------------------------- pause'
);
const keyboardSection = source.indexOf('// --------------------------------------------------------------- keyboard');
const keyboardStart = source.indexOf("document.addEventListener('keydown', (e) => {", keyboardSection);
const keyboardEnd = source.indexOf('\n\n// ---------------------------------------------------- undo / redo', keyboardStart);
if (keyboardSection < 0 || keyboardStart < 0 || keyboardEnd < 0) throw new Error('ordered keyboard handler markers missing');
const keyboardSource = source.slice(keyboardStart, keyboardEnd);

function makeHarness(openPanel, chatFocused = false) {
  const handlers = [];
  const documentFake = {
    addEventListener: (type, fn) => { if (type === 'keydown') handlers.push(fn); },
    body: { classList: { contains: () => false, remove: () => {}, toggle: () => {} } },
    activeElement: null,
    documentElement: { requestFullscreen: null },
    fullscreenElement: null,
    exitFullscreen: null,
  };
  const typing = (e) => {
    const t = e.target, tag = (t.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || t.isContentEditable;
  };
  const fireHandlers = (event) => handlers.forEach((fn) => fn(event));
  const handlerCount = () => handlers.length;
  return new Function('document', 'typing', '$', 'fireHandlers', 'handlerCount', `
    let mode = 'single';
    let currentId = 's1';
    let openPanel = ${JSON.stringify(openPanel)};
    let compactMenu = null;
    let chatInput = { tagName: 'TEXTAREA', blur: () => { calls.push('chat:blur'); document.activeElement = null; } };
    const model = { slides: [{ id: 's1' }] };
    const calls = [];
    const currentPos = () => 0;
    const applyMode = () => {};
    const setMode = (next) => { mode = next; calls.push('mode:' + next); };
    const setPanel = (next) => { openPanel = next; calls.push('panel:' + next); };
    const setCompactMenu = () => {};
    const doUndo = () => {};
    const doRedo = () => {};
    if (${JSON.stringify(chatFocused)}) document.activeElement = chatInput;
    ${navigationSource}
    ${keyboardSource}
    return {
      fire: () => {
        let prevented = false;
        const e = { key: 'Escape', target: ${JSON.stringify(chatFocused)} ? chatInput : { tagName: 'BODY' },
          ctrlKey: false, metaKey: false, shiftKey: false, preventDefault: () => { prevented = true; } };
        fireHandlers(e);
        return prevented;
      },
      mode: () => mode,
      panel: () => openPanel,
      calls: () => calls.slice(),
      listeners: () => handlerCount()
    };
  `)(documentFake, typing, () => null, fireHandlers, handlerCount);
}

const checks = [];
function check(description, ok) { checks.push({ description, ok: !!ok }); }

let app = makeHarness('board');
app.fire();
check('both keyboard listeners are present in the real registration order', app.listeners() === 2);
check('Escape closes an open panel without leaving single-slide mode', app.panel() === null && app.mode() === 'single' && JSON.stringify(app.calls()) === JSON.stringify(['panel:null']));
app = makeHarness(null);
app.fire();
check('Escape still returns from single-slide mode when no higher layer is open', app.panel() === null && app.mode() === 'grid' && JSON.stringify(app.calls()) === JSON.stringify(['mode:grid']));
app = makeHarness(null, true);
const chatPrevented = app.fire();
check('Escape in the chat textarea blurs chat before the typing guard', chatPrevented && app.mode() === 'single' && JSON.stringify(app.calls()) === JSON.stringify(['chat:blur']));

const passed = checks.filter((item) => item.ok).length;
for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.description}`);
console.log(`\n${passed}/${checks.length} passed`);
process.exit(passed === checks.length ? 0 : 1);
