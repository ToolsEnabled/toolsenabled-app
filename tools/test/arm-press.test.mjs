import test from 'node:test'
import assert from 'node:assert/strict'

import { armOnce } from '../../src/arm-press.js'

function buttonStandIn() {
  return {
    dataset: {},
    isConnected: true,
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value },
  }
}

function withClock(run) {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const pending = new Map()
  let nextId = 1
  globalThis.setTimeout = callback => {
    const id = nextId++
    pending.set(id, callback)
    return id
  }
  globalThis.clearTimeout = id => { pending.delete(id) }
  const clock = {
    pending: () => pending.size,
    runAll() {
      const callbacks = [...pending.values()]
      pending.clear()
      for (const callback of callbacks) callback()
    },
  }
  try {
    return run(clock)
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  }
}

test('an unreadable control never becomes permission to perform the action', () => {
  for (const input of [null, undefined, false, 'button', {}, { dataset: null }]) {
    assert.equal(armOnce(input), false, 'a control whose armed state cannot be read must refuse the action')
  }
})

test('real caller buttons require two presses and the second press cleans up the armed state', () => {
  withClock(clock => {
    const button = buttonStandIn()
    let disarms = 0

    const firstResult = armOnce(button, { onDisarm: () => { disarms += 1 } })
    assert.deepEqual({ result: firstResult, armed: button.dataset.armed, aria: button.attributes['aria-pressed'], timers: clock.pending() },
      { result: false, armed: 'true', aria: 'true', timers: 1 },
      'the first press must arm visibly and accessibly without authorizing the action')

    const secondResult = armOnce(button)
    clock.runAll()
    assert.deepEqual({ result: secondResult, armed: button.dataset.armed, aria: button.attributes['aria-pressed'], timers: clock.pending(), disarms },
      { result: true, armed: undefined, aria: 'false', timers: 0, disarms: 0 },
      'the second press must authorize once, disarm accessibly, and cancel the lone-press callback')
  })
})

test('a lone connected press disarms and notifies its caller, but a detached control is left alone', () => {
  withClock(clock => {
    const connected = buttonStandIn()
    let notifiedWith = null
    armOnce(connected, { onDisarm: button => { notifiedWith = button } })
    clock.runAll()
    assert.deepEqual({ armed: connected.dataset.armed, aria: connected.attributes['aria-pressed'], notifiedWith },
      { armed: undefined, aria: 'false', notifiedWith: connected },
      'a lone press must disarm accessibly and let the caller remove its explanatory hint')

    const detached = buttonStandIn()
    let detachedNotifications = 0
    armOnce(detached, { onDisarm: () => { detachedNotifications += 1 } })
    detached.isConnected = false
    clock.runAll()
    assert.equal(detachedNotifications, 0, 'a replaced control must not call back into its former view')
  })
})
