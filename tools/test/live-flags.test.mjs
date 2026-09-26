/* Per-view live-source preferences (src/live-flags.js).
 *
 * This module no longer has a production caller: the last callers moved to the
 * unified data-source axis.  The public surface remains as the documented
 * rollback path, however, so these tests exercise the browser-shaped inputs its
 * callers used: a known view id, boolean choices, localStorage strings, and the
 * change event consumed by mounted views.
 *
 * One important case is deliberately not asserted as correct.  If getItem
 * throws, isLiveView currently returns the default (true), turning an unreadable
 * preference into a definite live answer.  The task report records that product
 * defect; a red expectation cannot ship in this test-only wave.
 */

import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'

const originalLocalStorage = globalThis.localStorage
const originalWindow = globalThis.window
const originalCustomEvent = globalThis.CustomEvent

class TestCustomEvent {
  constructor(type, init = {}) {
    this.type = type
    this.detail = init.detail
  }
}

function storageStandIn(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    values,
    getItem(key) { return values.has(key) ? values.get(key) : null },
    setItem(key, value) { values.set(key, String(value)) },
    removeItem(key) { values.delete(key) },
  }
}

let events

globalThis.CustomEvent = TestCustomEvent
globalThis.window = { dispatchEvent(event) { events.push(event); return true } }
globalThis.localStorage = storageStandIn()

const {
  LIVE_FLAGS_EVENT,
  LIVE_VIEW_FLAGS,
  isLiveView,
  liveViewFlag,
  setLiveView,
} = await import('../../src/live-flags.js')

beforeEach(() => {
  events = []
  globalThis.localStorage = storageStandIn()
})

after(() => {
  if (originalLocalStorage === undefined) delete globalThis.localStorage
  else globalThis.localStorage = originalLocalStorage
  if (originalWindow === undefined) delete globalThis.window
  else globalThis.window = originalWindow
  if (originalCustomEvent === undefined) delete globalThis.CustomEvent
  else globalThis.CustomEvent = originalCustomEvent
})

test('the rollback catalog gives every supported view immutable usable metadata', () => {
  assert.ok(Object.isFrozen(LIVE_VIEW_FLAGS),
    'the exported view catalog can be changed by a consumer')
  assert.ok(LIVE_VIEW_FLAGS.length > 0,
    'the exported view catalog has no supported views')

  const ids = LIVE_VIEW_FLAGS.map(flag => flag.id)
  assert.equal(new Set(ids).size, ids.length,
    'two live-view definitions use the same storage identity')
  for (const flag of LIVE_VIEW_FLAGS) {
    assert.ok(Object.isFrozen(flag),
      `the ${flag.id} definition can be changed by a consumer`)
    assert.match(flag.id, /^[a-z][a-z0-9-]*$/,
      'a live-view definition has no usable view id')
    assert.ok(flag.label.trim().length > flag.id.length,
      `the ${flag.id} definition has no user-facing label`)
    assert.ok(flag.domain.trim().length > 0,
      `the ${flag.id} definition has no data domain`)
  }
})

test('real stored choices and their legacy boolean spellings restore the chosen source', () => {
  for (const [stored, expected] of [
    ['live', true],
    ['true', true],
    ['simulated', false],
    ['false', false],
  ]) {
    globalThis.localStorage = storageStandIn({ 'mc.live.metrics': stored })
    assert.equal(isLiveView('metrics'), expected,
      `stored choice ${stored} did not restore the source it represents`)
  }

  globalThis.localStorage = storageStandIn({ 'mc.live.metrics': 'unrecognised' })
  assert.equal(isLiveView('metrics'), true,
    'an unrecognised stored value overrode the supported view default')
})

test('a boolean change persists only a non-default choice and announces that choice', () => {
  globalThis.localStorage = storageStandIn({ 'mc.live.metrics': 'simulated' })

  assert.equal(setLiveView('metrics', true), true,
    'selecting the live source did not return the effective boolean choice')
  assert.equal(globalThis.localStorage.values.has('mc.live.metrics'), false,
    'the default choice stayed pinned in storage instead of following future defaults')
  assert.equal(events.length, 1,
    'a source change did not announce exactly one change event')
  assert.equal(events[0].type, LIVE_FLAGS_EVENT,
    'a source change announced the wrong event type')
  assert.deepEqual(events[0].detail, { view: 'metrics', live: true },
    'the change event did not identify the view and effective source')
  assert.ok(Object.isFrozen(events[0].detail),
    'a listener can rewrite the source choice seen by later listeners')

  assert.equal(setLiveView('metrics', false), false,
    'selecting the simulated source did not return the effective boolean choice')
  assert.equal(globalThis.localStorage.values.get('mc.live.metrics'), 'simulated',
    'the non-default source choice was not persisted for the next visit')
})

test('a flag snapshot combines its definition with current state without exposing mutable state', () => {
  globalThis.localStorage = storageStandIn({ 'mc.live.agent': 'simulated' })
  const snapshot = liveViewFlag('agent')

  assert.equal(snapshot.id, 'agent',
    'the snapshot lost the requested view identity')
  assert.ok(snapshot.label.trim().length > snapshot.id.length,
    'the snapshot lost its user-facing view label')
  assert.ok(snapshot.domain.trim().length > 0,
    'the snapshot lost its data domain')
  assert.equal(snapshot.live, false,
    'the snapshot did not include the currently stored source choice')
  assert.ok(Object.isFrozen(snapshot),
    'a caller can rewrite a live-view snapshot')
})

test('unknown view ids fail closed before reading, writing, or announcing anything', () => {
  let storageCalls = 0
  globalThis.localStorage = {
    getItem() { storageCalls++; return null },
    setItem() { storageCalls++ },
    removeItem() { storageCalls++ },
  }

  assert.throws(() => isLiveView('billing'), TypeError,
    'an unknown view id was accepted by the live-source reader')
  assert.throws(() => setLiveView('billing', true), TypeError,
    'an unknown view id was accepted by the live-source writer')
  assert.throws(() => liveViewFlag('billing'), TypeError,
    'an unknown view id was accepted by the snapshot reader')
  assert.equal(storageCalls, 0,
    'an unknown view id reached browser storage')
  assert.equal(events.length, 0,
    'an unknown view id announced a source change')
})
