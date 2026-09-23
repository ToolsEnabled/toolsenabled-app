/* THE RULE, TESTED WITH VALUES INSTEAD OF PINNED AS SOURCE TEXT.
 *
 * WHAT THIS REPLACES. tools/test/silent-controls.test.mjs required six literal
 * spellings in src/agent-session.js:
 *
 *     typeof bridge.availability === 'function'   (and five more)
 *
 * while, twenty lines earlier, the same file required the OPTIONAL-CHAINED
 * spelling of the identical rule for src/views/guide.js:
 *
 *     typeof bridge?.loginStart === 'function'    (and four more)
 *
 * Two contradictory pins of one invariant. Both implementations are correct --
 * agent-session.js guards with `bridge && …` first, guide.js uses `bridge?.` --
 * and each pin breaks the moment its file is rewritten differently but correctly.
 * A 2026-08-24 sweep found 21 assertions of this shape, and three of them had
 * already collided with correct fixes in a single evening. One of those tests
 * was requiring the very defect it was named after guarding against.
 *
 * THE INVARIANT IS NOT A SPELLING. It is: every verb this surface will call is
 * checked before the control is offered, so a bridge that is missing, partial,
 * or carrying a non-callable property never yields an enabled control. That is a
 * question about VALUES, so it is asked with values here.
 *
 * WHY THIS FILE CAN EXIST AT ALL: src/agent-session.js imports under bare node.
 * It always could. The belief that these modules are unloadable -- which is what
 * justified the source-text pins -- was measured and refuted; the views/ modules
 * needed only a four-line CSS loader hook (tools/test/css-hook.mjs), and this one
 * needed nothing.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { sessionBridgeControl } from '../../src/agent-session.js'

/* The verbs the session surface will actually call. Kept here rather than
   imported so that DELETING one from the product does not silently shrink this
   test with it -- the list is the contract, and it should have to be changed on
   purpose, in a diff somebody reads. */
const VERBS = ['availability', 'start', 'send', 'onEvent', 'close', 'interrupt']

const workingBridge = () => Object.fromEntries(VERBS.map(verb => [verb, () => {}]))

test('a complete bridge enables the control', () => {
  const control = sessionBridgeControl(workingBridge())
  assert.equal(control.enabled, true)
  assert.equal(control.disabled, false)
})

test('every single missing verb disables it, and none is forgotten', () => {
  /* The loop is the point. The old pins asserted six spellings existed; this
     asserts six ABSENCES are each caught, which is the thing a person relies on.
     Delete any one verb from the gate in the product and exactly one case here
     turns red, naming it. */
  for (const missing of VERBS) {
    const bridge = workingBridge()
    delete bridge[missing]
    const control = sessionBridgeControl(bridge)
    assert.equal(control.enabled, false, `a bridge with no ${missing}() must not enable the control`)
    assert.ok(control.why, `a control disabled for want of ${missing}() must carry a reason`)
  }
})

test('a property that is present but not callable is not a verb', () => {
  /* The failure this catches is specific and real: `bridge.start` existing as a
     truthy non-function passes a naive `bridge.start &&` guard and then throws
     `start is not a function` at the moment of the press -- which is the silent
     control this whole class of work exists to remove. */
  for (const notAFunction of [true, 1, 'start', {}, [], null]) {
    for (const verb of VERBS) {
      const bridge = workingBridge()
      bridge[verb] = notAFunction
      assert.equal(sessionBridgeControl(bridge).enabled, false,
        `${verb} = ${JSON.stringify(notAFunction)} is not callable and must not enable the control`)
    }
  }
})

test('no bridge at all is refused, not crashed on', () => {
  for (const absent of [null, undefined, false, 0, '']) {
    const control = sessionBridgeControl(absent)
    assert.equal(control.enabled, false, `${JSON.stringify(absent)} must not enable the control`)
    assert.ok(control.why, 'an absent bridge must still carry a reason')
  }
})

test('a bridge carrying only some verbs never enables the control', () => {
  for (let count = 0; count < VERBS.length; count += 1) {
    const bridge = Object.fromEntries(VERBS.slice(0, count).map(verb => [verb, () => {}]))
    assert.equal(sessionBridgeControl(bridge).enabled, false,
      `${count} of ${VERBS.length} verbs is not a usable bridge`)
  }
})

test('the reason is a sentence a person can act on, not a code', () => {
  const { why } = sessionBridgeControl(null)
  assert.equal(typeof why, 'string')
  assert.ok(why.length > 20, 'a refusal reason this short cannot be telling anybody anything')
  assert.doesNotMatch(why, /^[A-Z][A-Z0-9_]+$/, 'the reason is a machine code, not a sentence')
})
