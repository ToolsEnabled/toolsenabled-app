#!/usr/bin/env node
'use strict';
/*
 * Studio's deck-level shortcuts must leave native text editing alone.  Run the
 * real ordered keyboard handler against a tiny document harness so a future
 * shortcut refactor cannot make Ctrl/Cmd+Z undo the presentation from a draft.
 */
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, 'public', 'studio.js'), 'utf8');
const section = source.indexOf('// --------------------------------------------------------------- keyboard');
const start = source.indexOf("document.addEventListener('keydown', (e) => {", section);
const end = source.indexOf('\n\n// ---------------------------------------------------- undo / redo', start);
if (section < 0 || start < 0 || end < 0) throw new Error('Studio keyboard handler markers missing');
const handlerSource = source.slice(start, end);

let handler = null;
let undoCalls = 0;
let redoCalls = 0;
const documentFake = {
  body: { classList: { contains: () => false, remove: () => {}, toggle: () => {} } },
  activeElement: null,
  documentElement: { requestFullscreen: null },
  fullscreenElement: null,
  exitFullscreen: null,
  addEventListener: (type, fn) => { if (type === 'keydown') handler = fn; }
};
function typing(e) {
  const t = e.target;
  const tag = (t.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || t.isContentEditable;
}
new Function('document', 'typing', 'doUndo', 'doRedo', 'compactMenu', 'setCompactMenu', 'openPanel', 'setPanel', 'chatInput', 'setMode', handlerSource)(
  documentFake,
  typing,
  () => { undoCalls++; },
  () => { redoCalls++; },
  null,
  () => {},
  null,
  () => {},
  null,
  () => {}
);
if (!handler) throw new Error('Studio keyboard handler was not registered');

function keyEvent(target, key, options = {}) {
  let prevented = false;
  return {
    target, key,
    ctrlKey: !!options.ctrlKey,
    metaKey: !!options.metaKey,
    shiftKey: !!options.shiftKey,
    preventDefault: () => { prevented = true; },
    prevented: () => prevented,
  };
}

const checks = [];
function check(description, ok) { checks.push({ description, ok: !!ok }); }
function run(target, key, options) {
  const before = { undo: undoCalls, redo: redoCalls };
  const event = keyEvent(target, key, options);
  handler(event);
  return { event, undo: undoCalls - before.undo, redo: redoCalls - before.redo };
}

let r = run({ tagName: 'TEXTAREA' }, 'z', { ctrlKey: true });
check('Ctrl+Z in a textarea keeps native undo', !r.event.prevented() && r.undo === 0 && r.redo === 0);
r = run({ tagName: 'TEXTAREA' }, 'z', { metaKey: true, shiftKey: true });
check('Cmd+Shift+Z in a textarea keeps native redo', !r.event.prevented() && r.undo === 0 && r.redo === 0);
r = run({ tagName: 'DIV', isContentEditable: true }, 'z', { ctrlKey: true });
check('Ctrl+Z in contenteditable keeps native undo', !r.event.prevented() && r.undo === 0 && r.redo === 0);
r = run({ tagName: 'BODY' }, 'z', { ctrlKey: true });
check('Ctrl+Z outside text entry invokes deck undo', r.event.prevented() && r.undo === 1 && r.redo === 0);
r = run({ tagName: 'BODY' }, 'z', { metaKey: true, shiftKey: true });
check('Cmd+Shift+Z outside text entry invokes deck redo', r.event.prevented() && r.undo === 0 && r.redo === 1);

const passed = checks.filter((item) => item.ok).length;
for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.description}`);
console.log(`\n${passed}/${checks.length} passed`);
process.exit(passed === checks.length ? 0 : 1);
