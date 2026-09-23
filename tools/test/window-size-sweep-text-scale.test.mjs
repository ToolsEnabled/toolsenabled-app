import assert from 'node:assert/strict'
import test from 'node:test'

import { scaleMatrix, APP_TEXT_SIZES } from '../window-size-sweep-qa.mjs'

/* These assert BEHAVIOUR by calling with values. The point of the axis is that
 * a raised scale is actually APPLIED and actually MEASURED -- not that any
 * particular field is spelled a particular way. */

const sizes = [{ width: 1366, height: 800 }, { width: 1920, height: 1080 }]

test('a raised display scale is reported as the CSS width the layout really gets', () => {
  const [small] = scaleMatrix({ sizes: [{ width: 1366, height: 800 }], osScale: 1.5 })
  assert.equal(small.cssWidth, 911,
    'a 1366 panel at 150% hands the layout 911 CSS px, and that is the width the run must claim')
  assert.notEqual(small.cssWidth, 1366,
    'reporting the panel width would hide the whole defect: the layout never saw 1366')

  const [tiny] = scaleMatrix({ sizes: [{ width: 1366, height: 800 }], osScale: 2 })
  assert.equal(tiny.cssWidth, 683, 'a 1366 panel at 200% hands the layout 683 CSS px')
})

test('the app text size shrinks the room a box has, on top of the display scale', () => {
  const [c] = scaleMatrix({ sizes: [{ width: 1366, height: 800 }], osScale: 1.5, textSizes: [1.12] })
  assert.equal(c.cssWidth, 911, 'the viewport is still 911 CSS px: text size does not shrink the window')
  assert.equal(c.effectiveWidth, 813,
    'but every box is enlarged, so the room left is 911/1.12 -- the two mechanisms compound')
  assert.ok(c.effectiveWidth < c.cssWidth, 'raising text size must never report MORE room than the viewport')
})

test('the two mechanisms are carried separately, not collapsed into one number', () => {
  const [c] = scaleMatrix({ sizes: [{ width: 1920, height: 1080 }], osScale: 2, textSizes: [1.12] })
  assert.equal(c.osScale, 2, 'the display scale must survive as its own value')
  assert.equal(c.textSize, 1.12, 'the app text size must survive as its own value')
  assert.notEqual(c.osScale, c.textSize, 'a run must be able to tell which mechanism produced a finding')
})

/* THE GATE THAT MATTERS MOST. main.js applies the stored text size only when
   it is exactly 0.9 or 1.12. Any other number is written to storage and
   ignored, so a sweep asked for it would measure DEFAULT text and pass. */
test('a text size the product does not offer refuses instead of quietly measuring default text', () => {
  assert.throws(
    () => scaleMatrix({ sizes, textSizes: [1.5] }),
    (error) => error.code === 'TEXT_SIZE_NOT_OFFERED' && /silently ignored/.test(error.message),
    'asking for a scale the control cannot apply must refuse, not run at default and report a pass',
  )
  assert.throws(() => scaleMatrix({ sizes, textSizes: [1, 2] }),
    (error) => error.code === 'TEXT_SIZE_NOT_OFFERED',
    'one unsupported value among supported ones must still refuse the whole run')

  for (const offered of APP_TEXT_SIZES) {
    assert.doesNotThrow(() => scaleMatrix({ sizes, textSizes: [offered] }),
      `${offered} is a size the control offers and must be accepted`)
  }
})

test('an impossible display scale refuses rather than dividing by it', () => {
  for (const bad of [0, -1, Number.NaN]) {
    assert.throws(() => scaleMatrix({ sizes, osScale: bad }),
      (error) => error.code === 'OS_SCALE_INVALID', `${bad} is not a display scale`)
  }
})

test('the default matrix is exactly the sweep that ran before the axis existed', () => {
  const cases = scaleMatrix({ sizes })
  assert.equal(cases.length, sizes.length, 'with no scale asked for, one case per width and no more')
  for (const c of cases) {
    assert.equal(c.osScale, 1)
    assert.equal(c.textSize, 1)
    assert.equal(c.cssWidth, c.width, 'at default scale the CSS width is the panel width')
    assert.equal(c.effectiveWidth, c.width)
  }
})

test('every width is crossed with every text size', () => {
  const cases = scaleMatrix({ sizes, osScale: 1.25, textSizes: [0.9, 1, 1.12] })
  assert.equal(cases.length, 6, 'two widths and three text sizes is six measured cases')
  assert.equal(new Set(cases.map(c => c.tag)).size, 6, 'each case must be distinguishable in a report')
})
