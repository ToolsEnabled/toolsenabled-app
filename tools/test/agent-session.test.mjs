import test from 'node:test'
import assert from 'node:assert/strict'

import { sessionBridgeControl } from '../../src/agent-session.js'

/* These are the methods exposed by fleet-profile-preload.cjs and consumed by
   mountAgentSessionSurface(). Keep the caller's contract here: importing a list
   from the implementation would let deleting a call and its guard shrink the
   test at the same time. */
const SESSION_METHODS = Object.freeze([
  'availability',
  'start',
  'send',
  'onEvent',
  'close',
  'interrupt',
])

const callerBridge = () => Object.fromEntries(
  SESSION_METHODS.map(method => [method, () => {}]),
)

test('the complete bridge supplied by the agent view enables its session control', () => {
  const control = sessionBridgeControl(callerBridge())

  assert.equal(control.enabled, true, 'a bridge with every session method must enable the control')
  assert.equal(control.disabled, false, 'the enabled control must not also report itself disabled')
})

test('a missing or non-callable session method fails closed', async (t) => {
  for (const method of SESSION_METHODS) {
    await t.test(method, () => {
      const missing = callerBridge()
      delete missing[method]
      const missingControl = sessionBridgeControl(missing)
      assert.equal(missingControl.enabled, false,
        `a bridge that cannot ${method} must not enable the session control`)
      assert.equal(missingControl.disabled, true,
        `a bridge that cannot ${method} must describe the session control as disabled`)

      const notCallable = callerBridge()
      notCallable[method] = { present: true }
      assert.equal(sessionBridgeControl(notCallable).enabled, false,
        `a present but non-callable ${method} field must not enable the session control`)
    })
  }
})

test('a bridge that could not be read is disabled with an actionable reason', () => {
  for (const unreadable of [undefined, null]) {
    const control = sessionBridgeControl(unreadable)

    assert.equal(control.enabled, false, 'an unreadable bridge must not become an enabled answer')
    assert.equal(control.disabled, true, 'an unreadable bridge must explicitly disable the control')
    assert.equal(typeof control.why, 'string', 'a disabled control must carry its reason in the why field')
    assert.match(control.why, /browser/i, 'the reason must identify the surface that cannot start an agent')
    assert.match(control.why, /installed app/i, 'the reason must name where the person can use agent controls')
    assert.doesNotMatch(control.why, /^[A-Z][A-Z0-9_]+$/,
      'the reason must be guidance for a person rather than a machine code')
  }
})
