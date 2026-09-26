import assert from 'node:assert/strict'
import test from 'node:test'
import { bindTouchRange } from '../../src/settings-numeric.js'

function range() {
  const listeners = new Map(), events = []
  const input = { value: '40', min: '0', max: '200', step: '1', disabled: false,
    style: { setProperty() {} }, getBoundingClientRect: () => ({ left: 10, width: 200 }),
    addEventListener(type, listener) { assert.equal(listeners.has(type), false); listeners.set(type, listener) },
    dispatchEvent(event) {
      let stopped = false
      event.stopImmediatePropagation = () => { stopped = true }
      listeners.get(event.type)?.(event)
      if (!stopped) events.push([event.type, this.value])
    },
  }
  bindTouchRange(input)
  const fire = (type, x, y, extra = {}) => {
    let prevented = false
    listeners.get(type)({ type, pointerType: 'touch', pointerId: 1, clientX: x, clientY: y,
      preventDefault() { prevented = true }, ...extra })
    return prevented
  }
  return { input, events, fire }
}

test('vertical touch scroll does not stage or save a slider change', () => {
  const { input, events, fire } = range()
  assert.equal(fire('pointerdown', 110, 100), true)
  input.value = '100'
  let stopped = false
  fire('input', 110, 100, { stopImmediatePropagation() { stopped = true } })
  assert.equal(stopped, true)
  assert.equal(input.value, '40', 'native touch-down must not escape to the draft writer')
  fire('pointermove', 111, 75)
  fire('pointercancel', 111, 50)
  assert.equal(input.value, '40')
  assert.deepEqual(events, [])
})

test('horizontal drag emits readback and one committed change; tap remains usable', () => {
  const { input, events, fire } = range()
  fire('pointerdown', 50, 100)
  fire('pointermove', 90, 101)
  assert.equal(input.value, '80')
  fire('pointerup', 110, 101)
  assert.equal(input.value, '100')
  assert.deepEqual(events, [['input', '80'], ['input', '100'], ['change', '100']])
  fire('pointerdown', 210, 100)
  fire('pointerup', 210, 100)
  assert.equal(input.value, '200')
  assert.deepEqual(events.slice(-2), [['input', '200'], ['change', '200']])
})

test('disabled controls, secondary touches and mouse retain their native boundaries', () => {
  const { input, events, fire } = range()
  bindTouchRange(input) // repeated repaint cannot register duplicate handlers
  input.disabled = true
  assert.equal(fire('pointerdown', 210, 100), false)
  fire('pointerup', 210, 100)
  input.disabled = false
  assert.equal(fire('pointerdown', 210, 100, { pointerType: 'mouse' }), false)
  assert.equal(fire('pointerdown', 210, 100, { isPrimary: false }), false)
  assert.equal(input.value, '40')
  assert.deepEqual(events, [])
})
