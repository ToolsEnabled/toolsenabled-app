import assert from 'node:assert/strict'
import test from 'node:test'

import { introCardSpot } from '../../src/first-use-guidance.js'
import { FEATURE_GUIDES } from '../../src/feature-guides.js'

// THE INTRO CARD MUST NOT COVER THE PAGE'S OWN CONTROLS (ledger T143).
//
// Measured by the acceptance judge on 2026-09-16 (run #310, app 85dc71a8): on a
// fresh profile at #/computers the first-use card opened by itself at 12,76
// (352x326) and completely covered the workspace header plus at 325,174
// (32x32), the only way owner request T62 left to create a tree, so a person's
// first click landed on the card. The card now takes the first corner clear of
// the controls the guide names in `keepClear`, and this suite pins that choice
// with the judge's own numbers.

// The judge's measurement: a 1440x900 window, layer at 0,0, card 352x326.
const frame = { minX: 12, maxX: 1440 - 352 - 12, minY: 12, maxY: 900 - 326 - 12, homeY: 76, w: 352, h: 326, gap: 12 }
const headerPlus = { left: 325, top: 174, right: 357, bottom: 206 }

test('with nothing to keep clear, the intro card keeps its home at the top-left', () => {
  assert.deepEqual(introCardSpot(frame, []), { x: 12, y: 76 })
})

test("the judge's measured header plus moves the card off the top-left corner", () => {
  const spot = introCardSpot(frame, [headerPlus])
  assert.deepEqual(spot, { x: frame.maxX, y: 76 }, 'the top-right is the first clear corner')
  const overlaps = spot.x < headerPlus.right && spot.x + frame.w > headerPlus.left && spot.y < headerPlus.bottom && spot.y + frame.h > headerPlus.top
  assert.equal(overlaps, false, 'the chosen spot does not cover the plus')
})

test('a control that spans the whole top band pushes the card to the bottom-left', () => {
  const topBand = { left: 0, top: 60, right: 1440, bottom: 220 }
  assert.deepEqual(introCardSpot(frame, [topBand]), { x: 12, y: frame.maxY })
})

test('the gap counts: a control just outside the card by less than a finger still moves it', () => {
  const nearlyTouching = { left: 12 + 352 + 4, top: 76, right: 12 + 352 + 40, bottom: 120 }
  assert.notDeepEqual(introCardSpot(frame, [nearlyTouching]), { x: 12, y: 76 })
})

test('when every corner is covered the card takes the bottom-right rather than nothing', () => {
  const everything = { left: 0, top: 0, right: 1440, bottom: 900 }
  assert.deepEqual(introCardSpot(frame, [everything]), { x: frame.maxX, y: frame.maxY })
})

test('the home row is clamped inside the frame', () => {
  assert.deepEqual(introCardSpot({ ...frame, homeY: 5 }, []), { x: 12, y: 12 })
  assert.deepEqual(introCardSpot({ ...frame, homeY: 5000 }, []), { x: 12, y: frame.maxY })
})

test('the Computers guide names the header plus, its chooser and the machine tabs as controls to keep clear', () => {
  const guide = FEATURE_GUIDES.computers
  assert.ok(Array.isArray(guide.keepClear) && guide.keepClear.length > 0)
  assert.ok(guide.keepClear.includes('.tree-chat-add'), 'the T62 header plus stays reachable')
  for (const name of Object.keys(FEATURE_GUIDES)) {
    const keep = FEATURE_GUIDES[name].keepClear
    if (keep !== undefined) assert.ok(Array.isArray(keep) && keep.every(s => typeof s === 'string' && s.trim()), `${name}: keepClear is a list of selectors`)
  }
})

/* THE LEDGER'S OWN TOOLBAR STAYS CLEAR (T1261): the hunter measured the card
   at 12,76 (352x353) over the kind tabs at 286,169, so a first click landed on
   the card. The toolbar is the Ledger guide's keep-clear control, and a band
   the width of the page at that height moves the card off it. */
test('the Ledger guide keeps its kind tabs, reach filter and Show removed clear of the intro card', () => {
  assert.ok(FEATURE_GUIDES.ledger.keepClear?.includes('.ledger-toolbar'), 'the Ledger toolbar is not kept clear')
  const toolbar = { left: 252, top: 150, right: 1428, bottom: 196 }
  const spot = introCardSpot(frame, [toolbar])
  const overlaps = spot.x < toolbar.right && spot.x + frame.w > toolbar.left && spot.y < toolbar.bottom && spot.y + frame.h > toolbar.top
  assert.equal(overlaps, false, 'the card still covers the Ledger toolbar')
})
