import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installDomStandIn } from './lib/dom-stand-in.mjs';

// THE DEFECT THIS PINS. shell/screen-control-indicator.cjs arms
// Control+Alt+Shift+Escape on win32 and Control+Alt+Escape elsewhere, while
// src/screen-access-controls.js hard-coded the key caps "Ctrl + Alt + Esc" in
// its hint on EVERY platform, and nothing told the renderer which chord was
// armed. On Windows the grant screen therefore taught a chord this build does
// not arm and which Windows reserves anyway — the indicator's own measured
// comment records RegisterHotKey refusing it with 1409 — so the documented way
// to stop an agent holding the mouse, keyboard and screen did nothing. On Linux
// the text happened to be right, which is why it survived review.
//
// EXPECTATIONS HERE ARE LITERALS, ON PURPOSE. The armed value is an
// ACCELERATOR and the paragraph shows KEY CAPS, so something must map between
// them — and that mapping is the second place this defect can hide. Building
// the expected caps by running the accelerator through the SAME mapper the
// renderer uses would apply a dropped modifier to both sides and pass while the
// person reads a chord that does nothing. So the caps below are written out by
// hand and compared against what the renderer actually produced.
//
// This DUPLICATES the rule deliberately. If someone changes the armed chord,
// this file fails. That is the point: it forces a decision instead of letting a
// silent edit carry the UI along with it.
//
// MEASUREMENT AND ITS WIDTH. Executed on win32/x64 only — the one platform this
// lane could run. The linux rows are DERIVED: the renderer is driven with the
// payload a Linux host would send, not observed on a Linux host. Every message
// says which, so a derived row cannot be mistaken for an observed one.
const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const visuals = require_(path.join(ROOT, 'shell', 'screen-control-visuals.cjs'));
const RENDERER = path.join(ROOT, 'src', 'screen-access-controls.js');

// LITERAL. Not computed from the product's tables, not from shortcutLabel.
const WINDOWS_ACCELERATOR = 'Control+Alt+Shift+Escape';
const WINDOWS_CAPS = ['Ctrl', 'Alt', 'Shift', 'Esc'];
const OTHER_ACCELERATOR = 'Control+Alt+Escape';
const OTHER_CAPS = ['Ctrl', 'Alt', 'Esc'];
// What may be derived is WHICH host this is. What may not be derived is what
// that host should answer — that is selected from the literals above.
const expectedFor = platform => (platform === 'win32'
  ? { accelerator: WINDOWS_ACCELERATOR, caps: WINDOWS_CAPS }
  : { accelerator: OTHER_ACCELERATOR, caps: OTHER_CAPS });
const provenance = platform => (platform === process.platform ? 'observed on this host' : 'DERIVED, not a run on that platform');

async function mount(payload) {
  installDomStandIn();
  globalThis.window.mcScreenControl = { status: async () => payload, onEvent: () => () => {} };
  const { createScreenAccessControls } = await import(pathToFileURL(RENDERER).href);
  const controls = createScreenAccessControls({ sample: false });
  await controls.refresh();
  return controls;
}
const chordSlot = controls => controls.el.querySelector('[data-control-stopchord]');
const renderedCaps = controls => [...chordSlot(controls).querySelectorAll('kbd')].map(node => node.textContent);
const squash = text => String(text).replace(/\s+/g, ' ').trim();

test('the shell owns the chord, and the indicator no longer keeps a second copy', () => {
  const indicator = readFileSync(path.join(ROOT, 'shell', 'screen-control-indicator.cjs'), 'utf8');
  assert.equal(visuals.STOP_SHORTCUT, expectedFor(process.platform).accelerator,
    `the exported chord is not the one this platform arms (${provenance(process.platform)})`);
  assert.doesNotMatch(indicator, /process\.platform === 'win32' \? 'Control/,
    'mutation `keep a second per-platform copy of the chord in the indicator` survived: one copy of the rule only');
});

test('the mapper turns each armed accelerator into exactly the literal caps', () => {
  // Literal on the left, product on the right. A mapper that drops a modifier
  // fails here instead of being applied to both sides and cancelling out.
  assert.deepEqual(visuals.shortcutLabel(WINDOWS_ACCELERATOR).split('+'), WINDOWS_CAPS);
  assert.deepEqual(visuals.shortcutLabel(OTHER_ACCELERATOR).split('+'), OTHER_CAPS);
});

test('the grant screen renders the literal caps for each platform, through a real status payload', async () => {
  for (const platform of ['win32', 'linux']) {
    const { caps, accelerator } = expectedFor(platform);
    // The payload is what the host sends: the armed value mapped in the shell.
    const controls = await mount({ agents: [], grants: [], stopShortcutKeys: visuals.shortcutLabel(accelerator).split('+') });
    assert.deepEqual(renderedCaps(controls), caps,
      `${platform} (${provenance(platform)}): the screen shows ${renderedCaps(controls).join(' + ')}, not the ${caps.join(' + ')} this platform arms`);
    assert.match(squash(chordSlot(controls).textContent), /stops all access/);
    controls.destroy();
  }
});

test('nothing armed points at the Stop all button, never at a chord', async () => {
  // THE THIRD STATE. The indicator only records a chord after
  // globalShortcut.register succeeds, and stopShortcut() is null until then, so
  // "no chord is held" is a real state and not a theoretical one. Naming any
  // chord here would replace a wrong chord with a confidently wrong chord —
  // the same defect wearing this fix. The Stop all button is real and always
  // present, so that is what the panel points at.
  const controls = await mount({ agents: [], grants: [], stopShortcutKeys: null });
  assert.equal(renderedCaps(controls).length, 0,
    'mutation `name a chord when none is armed` survived: a chord that does nothing is the failure being fixed');
  const strong = chordSlot(controls).querySelectorAll('strong');
  assert.equal(strong.length, 1, 'the unarmed hint must name the Stop all button as an element');
  assert.equal(strong[0].textContent, 'Stop all');
  assert.match(squash(chordSlot(controls).textContent), /stops all access/);
  controls.destroy();
  assert.equal(visuals.shortcutLabel(null), 'the Stop all button');
});

test('a chord shown once is cleared when it is disarmed, not left stale', async () => {
  installDomStandIn();
  let payload = { agents: [], grants: [], stopShortcutKeys: [...WINDOWS_CAPS] };
  globalThis.window.mcScreenControl = { status: async () => payload, onEvent: () => () => {} };
  const { createScreenAccessControls } = await import(pathToFileURL(RENDERER).href);
  const controls = createScreenAccessControls({ sample: false });
  await controls.refresh();
  assert.deepEqual(renderedCaps(controls), WINDOWS_CAPS, 'setup: the armed caps should be showing');
  payload = { agents: [], grants: [], stopShortcutKeys: null };
  await controls.refresh();
  assert.equal(renderedCaps(controls).length, 0,
    'mutation `keep the last chord after it is disarmed` survived: a stale chord is as wrong as a hard-coded one');
  controls.destroy();
});

test('a mapper that drops a modifier is caught, which is what the literals are for', () => {
  // Positive control on the literals themselves. A lossy mapper must disagree
  // with the written-out caps; if it ever agrees, the assertions above have
  // stopped testing the mapping.
  const lossy = accelerator => accelerator.split('+').filter(part => part !== 'Shift')
    .map(part => ({ Control: 'Ctrl', Escape: 'Esc' })[part] || part).join('+');
  assert.notDeepEqual(lossy(WINDOWS_ACCELERATOR).split('+'), WINDOWS_CAPS,
    'the lossy control mapper agreed with the literal caps, so this check proves nothing');
  assert.deepEqual(visuals.shortcutLabel(WINDOWS_ACCELERATOR).split('+'), WINDOWS_CAPS,
    'the real mapper drops a key: the grant screen would teach a chord that does nothing');
});
