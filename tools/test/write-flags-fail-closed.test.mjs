import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'

import {
  WRITE_ACTION_FLAGS,
  isWriteEnabled,
  setWriteEnabled,
} from '../../src/write-flags.js'

const EXPECTED_IDS = [
  'dispatch',
  'decision',
  'queue',
  'thread-reply',
  'report-read',
  // Starting a real agent session from the agent page. Listed here for the
  // same reason as the rest: this suite is what forces a new write action to
  // be a deliberate decision, and it pins that the shipped default is off.
  'agent-session',
  // Launching a task on Codex Cloud. The most consequential entry in this list:
  // it starts real, billable work on a remote service, and the provider offers
  // no cancel once a task is accepted. Default-off, like the rest.
  'cloud-launch',
]

class MemoryStorage {
  #values = new Map()

  getItem(key) {
    return this.#values.has(key) ? this.#values.get(key) : null
  }

  setItem(key, value) {
    this.#values.set(key, String(value))
  }

  removeItem(key) {
    this.#values.delete(key)
  }
}

class TestCustomEvent {
  constructor(type, init = {}) {
    this.type = type
    this.detail = init.detail
  }
}

beforeEach(() => {
  globalThis.localStorage = new MemoryStorage()
  globalThis.window = { dispatchEvent() {} }
  globalThis.CustomEvent = TestCustomEvent
})

test('fresh Basic installs expose actions without changing host authority', () => {
  assert.deepEqual(WRITE_ACTION_FLAGS.map(flag => flag.id), EXPECTED_IDS)
  for (const id of EXPECTED_IDS) {
    assert.equal(isWriteEnabled(id), true, `${id} should use the Basic default without a stored value`)
  }
})

test('write flags round trip through explicit enabled and disabled values', () => {
  for (const id of EXPECTED_IDS) {
    assert.equal(setWriteEnabled(id, true), true)
    assert.equal(localStorage.getItem(`mc.write.${id}`), 'enabled')
    assert.equal(isWriteEnabled(id), true)

    assert.equal(setWriteEnabled(id, false), false)
    assert.equal(localStorage.getItem(`mc.write.${id}`), 'disabled')
    assert.equal(isWriteEnabled(id), false)
  }
})

test('unrecognised stored values fail closed', () => {
  for (const value of ['yes', 'true', '']) {
    for (const id of EXPECTED_IDS) {
      localStorage.setItem(`mc.write.${id}`, value)
      assert.equal(isWriteEnabled(id), false, `${id} should reject ${JSON.stringify(value)}`)
    }
  }
})

test('legacy simulated and disabled values remain disabled', () => {
  for (const value of ['simulated', 'disabled']) {
    for (const id of EXPECTED_IDS) {
      localStorage.setItem(`mc.write.${id}`, value)
      assert.equal(isWriteEnabled(id), false, `${id} should reject ${value}`)
    }
  }
})
