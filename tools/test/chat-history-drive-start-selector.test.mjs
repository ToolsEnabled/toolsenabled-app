/* THE LIVE CHECKPOINT'S START LOOKUP WAS TEXT-SHAPED, NOT SEMANTIC.
 *
 * B3's Set/Start split (src/agent-compose-panel.js, owner: "ITS SUPPOSED TO
 * HAVE SET OR START AS OPTIONS") made the compose panel legitimately show
 * BOTH a "Set" and a "Start" button on a fresh tree, where this driver's old
 * lookup -- `[...document.querySelectorAll('button')].filter(visible).find(n
 * => /^start/i.test(n.textContent.trim()))` -- had only ever needed to find
 * one submit button by its word. A live checkpoint run (scenarios A, D, F)
 * started failing on that same shared helper, always on the panel's "set"
 * face of a fresh tree: a two-button panel is not the shape a single
 * text-regex scan was ever proven against.
 *
 * The fix replaces the text scan with the semantic attribute the panel
 * itself sets (src/agent-compose-panel.js:719,
 * startBtn.setAttribute('data-compose-action', 'start')) -- stable across
 * both the "Set" and "Start" faces, and across whatever the button's word
 * ever says.
 *
 * This file cannot mount a real DOM (getBoundingClientRect/getComputedStyle
 * need a browser), so it extracts the EXACT lookup from the driver's own
 * source between stable anchors -- never a reimplementation that could
 * silently drift from it again -- and runs it against mock document/button
 * objects shaped like the real compose panel.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const DRIVER = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'chat-history-drive.mjs'), 'utf8')

/** The exact Start-control lookup body, extracted from the driver's own
 *  source between its stable anchors, turned into a real function of
 *  (document, getComputedStyle) -- so this test runs the SAME code the
 *  driver runs inside window.evaluate(), never a copy of it. */
function extractStartTargetFn() {
  const startAnchor = "const visible = n => { const b = n.getBoundingClientRect(); const s = getComputedStyle(n)"
  const start = DRIVER.indexOf(startAnchor)
  const endAnchor = "})()`), 'the Start control')"
  const end = DRIVER.indexOf(endAnchor, start)
  assert.ok(start !== -1 && end !== -1, 'the Start-control lookup moved or was renamed -- re-anchor this extraction')
  const body = DRIVER.slice(start, end)
  // Anchored to the CODE line specifically (not just "the phrase appears
  // somewhere", which a surviving comment could satisfy on its own even
  // after the logic regressed) -- this must fail if the lookup reverts to
  // scanning querySelectorAll('button') by text.
  assert.match(body, /const btn = document\.querySelector\(\s*'\[data-compose-action="start"\]'\s*\)/,
    'the Start-control lookup no longer queries by data-compose-action="start" as its own code line -- did the selector regress back to a text scan?')
  // eslint-disable-next-line no-new-func
  return new Function('document', 'getComputedStyle', body)
}

const findStartTarget = extractStartTargetFn()

function mockButton({ visible = true, id = '', disabled = false, textContent = 'Start' } = {}) {
  // No `action`/data-compose-action field: document.querySelector is mocked
  // at the document level below (real attribute-selector matching is not
  // reimplemented here), so a returned button always stands for whatever the
  // mock document decided to hand back for that selector string.
  return {
    getBoundingClientRect: () => (visible ? { width: 80, height: 30 } : { width: 0, height: 0 }),
    id,
    disabled,
    textContent,
  }
}
function mockGetComputedStyle(hidden = false) {
  return () => ({ visibility: hidden ? 'hidden' : 'visible', display: hidden ? 'none' : 'block' })
}
function mockDocument(button) {
  return { querySelector: sel => (sel === '[data-compose-action="start"]' ? button : null) }
}

test('no Start control on the panel (querySelector finds nothing) reads as absent, not an error', () => {
  const result = findStartTarget(mockDocument(null), mockGetComputedStyle())
  assert.equal(result, null, 'a missing Start control must resolve to null so the caller reports "there is no Start control"')
})

test('a visible Start button is found by its attribute and gets an id assigned', () => {
  const btn = mockButton({ id: '', textContent: 'Start' })
  const result = findStartTarget(mockDocument(btn), mockGetComputedStyle())
  assert.deepEqual(result, { selector: '#chat-history-drive-start', label: 'Start', disabled: false })
  assert.equal(btn.id, 'chat-history-drive-start', 'the button must receive the fallback id so the selector it returns actually resolves')
})

test('an already-id\'d Start button keeps its own id rather than being overwritten', () => {
  const btn = mockButton({ id: 'real-start-button' })
  const result = findStartTarget(mockDocument(btn), mockGetComputedStyle())
  assert.equal(result.selector, '#real-start-button')
})

test('a disabled Start button (tier not runnable yet) is still found, and disabled is reported truthfully', () => {
  const btn = mockButton({ disabled: true })
  const result = findStartTarget(mockDocument(btn), mockGetComputedStyle())
  assert.equal(result.disabled, true, 'a genuinely disabled Start control must be reported as disabled, not hidden as absent')
})

test('a Start button present but not visible (0x0, or hidden) reads as absent, same as the old text-scan required', () => {
  const zeroSize = mockButton({ visible: false })
  assert.equal(findStartTarget(mockDocument(zeroSize), mockGetComputedStyle()), null,
    'a zero-size Start control must not be reported as pressable')
  const cssHidden = mockButton({ visible: true })
  assert.equal(findStartTarget(mockDocument(cssHidden), mockGetComputedStyle(true)), null,
    'a Start control hidden via visibility/display must not be reported as pressable')
})

test('the panel\'s "Set" face alone -- no Start attribute anywhere -- is exactly the checkpoint\'s original failure, and now resolves cleanly', () => {
  // The regression this whole fix closes: a fresh tree's compose panel shows
  // BOTH Set and Start (B3's split), but this mock stands for the moment the
  // old text-regex scan was proven wrong against -- a document whose ONLY
  // submit-shaped button is Set. The semantic selector correctly finds
  // nothing rather than mis-picking Set, exactly like a real absent Start.
  const setOnly = { querySelector: sel => (sel === '[data-compose-action="start"]' ? null : mockButton({ textContent: 'Set' })) }
  assert.equal(findStartTarget(setOnly, mockGetComputedStyle()), null,
    'with no [data-compose-action="start"] in the document, the lookup must resolve to null -- never fall through to some other button')
})
