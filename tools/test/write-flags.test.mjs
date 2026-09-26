import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'

import {
  WRITE_ACTION_FLAGS,
  WRITE_FLAGS_EVENT,
  isWriteEnabled,
  setWriteEnabled,
} from '../../src/write-flags.js'

class MemoryStorage {
  values = new Map()

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null
  }

  setItem(key, value) {
    this.values.set(key, String(value))
  }
}

class TestCustomEvent {
  constructor(type, init = {}) {
    this.type = type
    this.detail = init.detail
  }
}

let events

beforeEach(() => {
  events = []
  globalThis.localStorage = new MemoryStorage()
  globalThis.CustomEvent = TestCustomEvent
  globalThis.window = { dispatchEvent: event => events.push(event) }
})

test('the exported write-action registry is immutable configuration with unique ids', () => {
  assert.equal(Object.isFrozen(WRITE_ACTION_FLAGS), true, 'callers must not be able to add or reorder write actions')
  assert.equal(new Set(WRITE_ACTION_FLAGS.map(({ id }) => id)).size, WRITE_ACTION_FLAGS.length, 'each control must have a unique storage identity')

  for (const flag of WRITE_ACTION_FLAGS) {
    assert.equal(Object.isFrozen(flag), true, `${flag.id} configuration must not be mutable by a caller`)
    assert.equal(typeof flag.label, 'string', `${flag.id} must have a label`)
    assert.notEqual(flag.label.trim(), '', `${flag.id} must have a label`)
    assert.equal(typeof flag.description, 'string', `${flag.id} must explain what its control grants`)
    assert.notEqual(flag.description.trim(), '', `${flag.id} must explain what its control grants`)
  }
})

test('readers distinguish the literal enabled state from disabled and absent states', () => {
  const id = WRITE_ACTION_FLAGS[0].id

  assert.equal(isWriteEnabled(id), true, 'Basic exposes an action when no preference exists')
  localStorage.setItem(`mc.write.${id}`, 'enabled')
  assert.equal(isWriteEnabled(id), true, 'the stored opt-in must read enabled')
  localStorage.setItem(`mc.write.${id}`, 'disabled')
  assert.equal(isWriteEnabled(id), false, 'the stored opt-out must read disabled')
})

test('unknown controls are rejected with the control identity', () => {
  assert.throws(
    () => isWriteEnabled('not-a-write-action'),
    error => error instanceof TypeError && error.message === 'Unknown write-action flag: not-a-write-action',
    'a caller typo must not silently become a disabled control',
  )
  assert.throws(
    () => setWriteEnabled('not-a-write-action', true),
    error => error instanceof TypeError && error.message === 'Unknown write-action flag: not-a-write-action',
    'a caller typo must not write or announce an invented control',
  )
})

test('writers persist and announce both control states using the public event contract', () => {
  const id = WRITE_ACTION_FLAGS[0].id

  assert.equal(setWriteEnabled(id, true), true)
  assert.equal(localStorage.getItem(`mc.write.${id}`), 'enabled', 'the enabled reading must survive the writer')
  assert.equal(events[0].type, WRITE_FLAGS_EVENT, 'listeners must receive the named write-flags event')
  assert.deepEqual(events[0].detail, { action: id, enabled: true }, 'the enabled event must identify its control and state')
  assert.equal(Object.isFrozen(events[0].detail), true, 'one listener must not be able to alter the state seen by another')

  assert.equal(setWriteEnabled(id, false), false)
  assert.equal(localStorage.getItem(`mc.write.${id}`), 'disabled', 'the disabled reading must survive the writer')
  assert.equal(events[1].type, WRITE_FLAGS_EVENT, 'listeners must receive the named write-flags event')
  assert.deepEqual(events[1].detail, { action: id, enabled: false }, 'the disabled event must identify its control and state')
})

test('a refused write preserves the prior choice without announcing success and can be retried', () => {
  const id = WRITE_ACTION_FLAGS[0].id
  const persist = localStorage.setItem.bind(localStorage)
  for (const previous of [false, true]) {
    setWriteEnabled(id, previous)
    events.length = 0
    localStorage.setItem = () => { throw new Error('Settings storage is unavailable') }
    assert.throws(() => setWriteEnabled(id, !previous), /Settings storage is unavailable/)
    assert.equal(isWriteEnabled(id), previous)
    assert.deepEqual(events, [])
    localStorage.setItem = persist
    assert.equal(setWriteEnabled(id, !previous), !previous)
    assert.equal(isWriteEnabled(id), !previous)
    assert.equal(events.length, 1)
  }
})


test('Basic fresh and skipped profiles enable permitted actions while explicit Observe and disabled flags survive', async () => {
  const { SAFE_ANSWERS, RECOMMENDED_ANSWERS, deriveProfile, applyProfile, PROFILE_STORAGE_KEY } = await import('../../src/setup-profile.js')
  const ids = WRITE_ACTION_FLAGS.map(row => row.id)
  assert.equal(SAFE_ANSWERS.autonomy, 'autonomous')
  assert.equal(RECOMMENDED_ANSWERS.autonomy, 'autonomous')
  for (const tier of ['guided', 'standard', 'unrestricted']) {
    const profile = deriveProfile(undefined, { tier, writeFlagIds: ids })
    assert.equal(profile.writeFlags['agent-session'], true)
    assert.equal(profile.writeFlags.dispatch, tier !== 'guided', 'the saved tier ceiling remains applied')
    assert.deepEqual(profile, deriveProfile(SAFE_ANSWERS, { tier, writeFlagIds: ids }))
  }
  const observed = deriveProfile({ autonomy: 'observe' }, { tier: 'unrestricted', writeFlagIds: ids })
  assert.ok(Object.values(observed.writeFlags).every(value => value === false))
  localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, status: 'complete', answers: { autonomy: 'observe' } }))
  assert.ok(ids.every(id => isWriteEnabled(id) === false), 'saved Observe is not treated as an absent preference')
  localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, status: 'skipped', answers: SAFE_ANSWERS }))
  assert.ok(ids.every(id => isWriteEnabled(id)))
  applyProfile(observed, { setWriteFlag: setWriteEnabled })
  assert.ok(ids.every(id => isWriteEnabled(id) === false), 'explicit profile application persists the opt-out')
  localStorage.setItem(PROFILE_STORAGE_KEY, '{malformed')
  assert.ok(ids.every(id => isWriteEnabled(id) === false))
})


test('Basic default lookup preserves saved Observe and Assisted choices without rewriting any setting', async () => {
  const { PROFILE_STORAGE_KEY, readStoredProfile, deriveProfile } = await import('../../src/setup-profile.js')
  for (const status of ['complete', 'skipped']) {
    for (const autonomy of ['observe', 'assisted']) {
      const raw = JSON.stringify({ schemaVersion: 1, status, answers: { autonomy, screens: 'live' } })
      localStorage.setItem(PROFILE_STORAGE_KEY, raw)
      const profile = readStoredProfile()
      assert.equal(profile.answers.autonomy, autonomy)
      for (const { id } of WRITE_ACTION_FLAGS) {
        assert.equal(isWriteEnabled(id), deriveProfile(profile.answers, { tier: 'unrestricted', writeFlagIds: [id] }).writeFlags[id])
      }
      assert.equal(localStorage.getItem(PROFILE_STORAGE_KEY), raw)
      assert.equal(events.length, 0)
    }
  }
  localStorage.setItem('mc.write.agent-session', 'enabled')
  assert.equal(isWriteEnabled('agent-session'), true, 'an explicit individual setting still takes precedence')
})
