/* THE LIVE CHECKPOINT'S "PAINTED" CHECK WAS STALE, NOT src/styles.css.
 *
 * A live checkpoint run (chat-history-drive.mjs scenario C) reported 4
 * messages as unpainted -- bg=rgba(0,0,0,0), img=none, border=0px -- which
 * read, on first sight, like the exact defect this driver's own comment
 * documents fixing once (a role with no matching style rule). It was not.
 * src/styles.css's gutter redesign ("owner-approved mockup, applied
 * 2026-08-24") deliberately moved identity OFF the message box: .msg.me's
 * mark is a LEFT border (never border-top, the property the OLD check
 * read), and .msg.them carries no border or background on the box at all
 * BY DESIGN -- its whole mark is a coloured dot on its own ::before
 * pseudo-element, invisible to a getComputedStyle() call on the message
 * itself. tools/test/chat-message-identity.test.mjs was already updated
 * for this redesign (it asserts .msg.them::before exists); this driver's
 * OWN independent copy of "how to tell a message is painted" was not --
 * a two-sources-of-truth drift, not a missing CSS rule.
 *
 * This file cannot mount a real DOM (getComputedStyle needs a browser), so
 * it extracts the EXACT `painted:` expression from the driver's own source
 * -- never a reimplementation that could silently drift from it again --
 * and evaluates it against mock CSSStyleDeclaration-shaped objects for
 * every message kind the gutter redesign actually produces.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const DRIVER = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'chat-history-drive.mjs'), 'utf8')

/** The exact `painted:` boolean expression, extracted from the driver's own
 *  source between its stable anchors, turned into a real function of
 *  (style, beforeStyle) -- so this test evaluates the SAME code the driver
 *  runs, never a copy of it. */
function extractPaintedFn() {
  const start = DRIVER.indexOf('painted: style.backgroundColor')
  const end = DRIVER.indexOf('alignSelf: style.alignSelf', start)
  assert.ok(start !== -1 && end !== -1, 'the painted: computation moved or was renamed -- re-anchor this extraction')
  const expr = DRIVER.slice(start + 'painted: '.length, end).replace(/,\s*$/, '').trim()
  // eslint-disable-next-line no-new-func
  return new Function('style', 'beforeStyle', `return (${expr})`)
}

const painted = extractPaintedFn()

function style({ backgroundColor = 'rgba(0, 0, 0, 0)', backgroundImage = 'none', borderTopWidth = '0px', borderLeftWidth = '0px', boxShadow = 'none' } = {}) {
  return { backgroundColor, backgroundImage, borderTopWidth, borderLeftWidth, boxShadow }
}
function before({ content = 'none', backgroundColor = 'rgba(0, 0, 0, 0)' } = {}) {
  return { content, backgroundColor }
}

test('a truly bare message (no rule at all, the original defect) still reads as unpainted', () => {
  assert.equal(painted(style(), before()), false,
    'a message with zero styling on itself and zero ::before mark must still be caught as unpainted -- this is the original defect class and the six-way check must not have widened past it')
})

test('the old bubble-era signals still count -- backgroundImage, backgroundColor, borderTopWidth, boxShadow', () => {
  assert.equal(painted(style({ backgroundImage: 'linear-gradient(180deg, #000, #111)' }), before()), true, 'a gradient background must still read as painted')
  assert.equal(painted(style({ backgroundColor: 'rgb(20, 20, 20)' }), before()), true, 'a solid background must still read as painted')
  assert.equal(painted(style({ borderTopWidth: '1px' }), before()), true, 'a top border must still read as painted')
  assert.equal(painted(style({ boxShadow: '0 1px 2px rgba(0,0,0,0.2)' }), before()), true, 'a box shadow must still read as painted')
})

test('.msg.me\'s real mark -- a LEFT border, never a top one -- now reads as painted', () => {
  assert.equal(painted(style({ borderLeftWidth: '2px' }), before()), true,
    'a left border (the .msg.me gutter-redesign mark) is not recognised as painted -- this is the exact gap the live checkpoint found')
  /* And the ORIGINAL four-way check alone, with no left-border awareness,
     would have missed exactly this case -- proving the fix actually closes
     the gap rather than coincidentally overlapping it. */
  const oldFourWay = (s) => s.backgroundColor !== 'rgba(0, 0, 0, 0)' || s.backgroundImage !== 'none' || s.borderTopWidth !== '0px' || s.boxShadow !== 'none'
  assert.equal(oldFourWay(style({ borderLeftWidth: '2px' })), false, 'sanity check: the pre-fix four-way logic really did miss a left-border-only message')
})

test('.msg.them\'s real mark -- a coloured dot on ::before, never on the message itself -- now reads as painted', () => {
  assert.equal(painted(style(), before({ content: '""', backgroundColor: 'rgb(0, 141, 171)' })), true,
    'a ::before gutter dot with a real background is not recognised as painted -- this is the exact gap the live checkpoint found')
  /* A ::before that exists (content set) but never got a background painted
     onto it (a genuine defect, not a design choice) must still fail --
     the fix must not treat "has a pseudo-element at all" as proof of paint. */
  assert.equal(painted(style(), before({ content: '""', backgroundColor: 'rgba(0, 0, 0, 0)' })), false,
    'an empty, uncoloured ::before must not count as painted -- that would hide a real missing-mark defect')
})

test('.msg.note\'s existing dashed-card treatment is untouched by the widened check', () => {
  assert.equal(painted(style({ backgroundColor: 'rgba(255, 255, 255, 0.34)', borderTopWidth: '1px' }), before()), true,
    'the product-voice aside\'s own background+border treatment must still read as painted, unchanged')
})
