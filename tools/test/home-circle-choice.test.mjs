import test from 'node:test'
import assert from 'node:assert/strict'
import {
  HOME_CIRCLE_STYLE_KEY, HOME_CIRCLE_STYLE_EVENT, HOME_CIRCLE_STYLES,
  currentHomeCircleStyle, normalizeHomeCircleStyle, setHomeCircleStyle,
  HOME_CIRCLE_MOTION_KEY, HOME_CIRCLE_MOTION_EVENT, HOME_CIRCLE_MOTIONS,
  currentHomeCircleMotion, normalizeHomeCircleMotion, setHomeCircleMotion,
} from '../../src/home-circle-choice.js'
import { createSettingsDraft } from '../../src/settings-draft.js'

const fixture = ({ eventName = HOME_CIRCLE_STYLE_EVENT, readChoice = currentHomeCircleStyle } = {}) => {
  const values = new Map(), changes = []
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  }
  const events = { dispatchEvent(event) {
    assert.equal(event.type, eventName)
    changes.push({ selected: event.detail.value, persisted: readChoice(storage) })
  } }
  return { storage, events, values, changes }
}

const motionFixture = () => fixture({ eventName: HOME_CIRCLE_MOTION_EVENT, readChoice: currentHomeCircleMotion })

test('Classic is the default; Blob persists and legacy animated choices remain Blob', () => {
  const f = fixture()
  assert.deepEqual(HOME_CIRCLE_STYLES.map(choice => [choice.id, choice.label]), [['simple', 'Classic'], ['standard', 'Blob']])
  assert.equal(currentHomeCircleStyle(f.storage), 'simple')
  assert.equal(normalizeHomeCircleStyle('custom'), 'simple')
  for (const legacy of ['classic', 'glass']) {
    f.values.set(HOME_CIRCLE_STYLE_KEY, legacy)
    assert.equal(currentHomeCircleStyle(f.storage), 'standard')
    assert.equal(f.values.get(HOME_CIRCLE_STYLE_KEY), legacy, 'a read does not rewrite stored preferences')
  }
  setHomeCircleStyle('standard', f)
  assert.equal(f.values.get(HOME_CIRCLE_STYLE_KEY), 'standard')
  assert.equal(currentHomeCircleStyle(f.storage), 'standard')
  assert.deepEqual(f.changes, [{ selected: 'standard', persisted: 'standard' }])
  setHomeCircleStyle('simple', f)
  assert.equal(f.values.has(HOME_CIRCLE_STYLE_KEY), false, 'selecting the default removes its override')
  assert.equal(currentHomeCircleStyle(f.storage), 'simple')
})

test('invalid choices and unavailable writes cannot announce a false saved appearance', () => {
  const f = fixture()
  assert.throws(() => setHomeCircleStyle('custom', f), /Classic or Blob/)
  assert.throws(() => setHomeCircleStyle('glass', f), /Classic or Blob/)
  assert.equal(f.values.size, 0)
  const unavailable = { getItem() { throw new Error('unreadable') }, setItem() { throw new Error('read-only') }, removeItem() { throw new Error('read-only') } }
  assert.equal(currentHomeCircleStyle(unavailable), 'simple', 'an appearance fallback never writes the unreadable setting')
  assert.throws(() => setHomeCircleStyle('standard', { storage: unavailable, events: f.events }), /read-only/)
  assert.deepEqual(f.changes, [])
})

test('pending circle choices follow Save and Discard, with failed writes kept pending', async () => {
  const f = fixture(), draft = createSettingsDraft()
  draft.stage('row:home_circle_style', 'standard', value => setHomeCircleStyle(value, f))
  assert.equal(currentHomeCircleStyle(f.storage), 'simple')
  assert.deepEqual(f.changes, [])
  draft.discard()
  await draft.save()
  assert.equal(currentHomeCircleStyle(f.storage), 'simple')
  draft.stage('row:home_circle_style', 'standard', value => setHomeCircleStyle(value, f))
  await draft.save()
  assert.equal(currentHomeCircleStyle(f.storage), 'standard')
  assert.equal(draft.dirty, false)
  draft.stage('row:home_circle_style', 'simple', value => setHomeCircleStyle(value, { storage: null, events: f.events }))
  await assert.rejects(draft.save(), /could not be saved/)
  assert.equal(draft.dirty, true)
  assert.equal(currentHomeCircleStyle(f.storage), 'standard')
  assert.equal(f.changes.length, 1)
})

test('circle motion defaults to System and persists an explicit choice independently of style and app motion', () => {
  const f = motionFixture()
  f.values.set(HOME_CIRCLE_STYLE_KEY, 'standard')
  f.values.set('mc.set.reduce_motion', 'true')
  assert.deepEqual(HOME_CIRCLE_MOTIONS.map(choice => [choice.id, choice.label]), [
    ['system', 'System'], ['animate', 'Animate'], ['still', 'Still'],
  ])
  assert.equal(currentHomeCircleMotion(f.storage), 'system')
  assert.equal(normalizeHomeCircleMotion('unsupported'), 'system')
  for (const value of ['animate', 'still', 'system']) {
    setHomeCircleMotion(value, f)
    assert.equal(currentHomeCircleMotion(f.storage), value)
    assert.equal(f.values.get(HOME_CIRCLE_MOTION_KEY), value === 'system' ? undefined : value)
    assert.equal(currentHomeCircleStyle(f.storage), 'standard')
    assert.equal(f.values.get('mc.set.reduce_motion'), 'true')
  }
  assert.deepEqual(f.changes, ['animate', 'still', 'system'].map(value => ({ selected: value, persisted: value })))
})

test('invalid or failed circle motion writes never announce a saved change', async () => {
  const f = motionFixture(), draft = createSettingsDraft()
  assert.throws(() => setHomeCircleMotion('unsupported', f), /System, Animate or Still/)
  const unavailable = { getItem() { throw new Error('unreadable') }, setItem() { throw new Error('read-only') }, removeItem() { throw new Error('read-only') } }
  assert.equal(currentHomeCircleMotion(unavailable), 'system')
  assert.throws(() => setHomeCircleMotion('animate', { storage: unavailable, events: f.events }), /read-only/)
  assert.deepEqual(f.changes, [])
  setHomeCircleMotion('animate', f)
  draft.stage('row:home_circle_motion', 'system', value => setHomeCircleMotion(value, { storage: unavailable, events: f.events }))
  await assert.rejects(draft.save(), /read-only/)
  assert.equal(draft.dirty, true)
  assert.equal(currentHomeCircleMotion(f.storage), 'animate')
  assert.deepEqual(f.changes, [{ selected: 'animate', persisted: 'animate' }])
  assert.throws(() => setHomeCircleMotion('still', { storage: null, events: f.events }), /could not be saved/)
})
