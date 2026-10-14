import { canonicalRootForTests } from '../canonical-root.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'
const require = createRequire(import.meta.url)
const { createActionPermissionProfileHost } = require('../../shell/action-permission-profile-host.cjs')
const policy = require(resolve(canonicalRootForTests({ requireConfigured: true }), 'src/lib/action-permission-profiles.js'))
const KEY = policy.SETTINGS_KEY
const PREFIX = 'mc.action-permissions.recovery.'
const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
const durable = readFileSync(new URL('../../public/durable-storage.js', import.meta.url), 'utf8')
const registrationStart = main.indexOf("ipcMain.on('mc-prefs:write',")
const registrationEnd = main.indexOf('\n})', registrationStart)
assert.ok(registrationStart >= 0 && registrationEnd > registrationStart, 'actual preference write handler is registered')
const handlerSource = main.slice(registrationStart, registrationEnd + 3)

function fixture(raw = '{damaged', options = {}) {
  const values = { [KEY]: raw }
  const writes = []
  let damaged = false
  const prefs = {
    snapshot: () => ({ ok: true, damaged, values: { ...values } }),
    set(key, value) {
      writes.push({ key, value })
      if (options.fail?.(key)) return { ok: false, error: { code: 'FIXTURE_REFUSAL', message: 'fixture write refused' } }
      if (!options.drop?.(key)) values[key] = value
      return { ok: true }
    },
  }
  const host = createActionPermissionProfileHost({ prefs, policy, sessions: new Map(), getAgentHost: () => null })
  return { host, values, writes, prefs, setDamaged: value => { damaged = value } }
}
function native(f, { trusted = true, erased = false } = {}) {
  let genericWrites = 0
  const context = {
    trustedFleetProfileSender: () => trusted, localDataErased: erased,
    prefsRefusal: () => ({ ok: false, error: { code: 'UNTRUSTED' } }),
    prefsErasedRefusal: () => ({ ok: false, error: { code: 'ERASED' } }),
    getActionPermissionProfileHost: () => f.host,
    WEB_DRIVE_PREF_KEY: 'fixture.web-drive',
    rendererPrefs: { set: (...args) => { genericWrites++; return f.prefs.set(...args) } },
    notePrefsRefusal: (_operation, _key, result) => result,
    mirrorUninstallRetentionIfRelevant: () => {},
  }
  let handle
  vm.runInNewContext(handlerSource, { ...context, ipcMain: { on: (_name, callback) => { handle = callback } } })
  const write = (key, value, ...expected) => {
    const event = {}; handle(event, { key, value, ...(expected.length ? { expectedValue: expected[0] } : {}) }); return event.returnValue
  }
  const window = { localStorage: { length: 0, key: () => null }, mcPrefs: {
    available: true, values: { ...f.values }, write,
    drainRequired: false,
  } }
  vm.runInNewContext(durable, { window })
  return { write, storage: window.localStorage, genericWrites: () => genericWrites }
}
function rejected(action, code) {
  let result
  try { result = action() } catch (error) { assert.equal(error.code, code); return }
  assert.equal(result?.ok, false, 'operation must refuse')
  assert.equal(result.error?.code, code)
}

test('damaged record cannot be replaced without an exact preserved copy and expected bytes', () => {
  for (const backup of [undefined, 'different']) {
    const f = fixture(); if (backup) f.values[PREFIX + 'one'] = backup
    rejected(() => f.host.save(policy.defaults(), { expectedValue: '{damaged' }), 'ACTION_PERMISSION_PROFILE_RECOVERY_REQUIRED')
    assert.equal(f.values[KEY], '{damaged'); assert.equal(f.writes.length, 0)
  }
})
test('native storage preserves original bytes then resets through the authoritative parser', () => {
  const raw = '{\n "v": 2, unreadable\n'; const f = fixture(raw); const n = native(f)
  n.storage.setItem(PREFIX + 'one', raw)
  assert.equal(f.values[KEY], raw)
  assert.equal(f.values[PREFIX + 'one'], raw)
  n.storage.setItem(KEY, JSON.stringify(policy.defaults()))
  assert.deepEqual(JSON.parse(f.values[KEY]), policy.defaults())
  assert.equal(f.values[PREFIX + 'one'], raw)
  assert.equal(n.genericWrites(), 0, 'permission preservation stays in the strict host')
})
test('preservation refuses failed writes, absent readback and conflicting archive bytes', () => {
  for (const options of [{ fail: () => true }, { drop: () => true }]) {
    const f = fixture('{bad', options); const n = native(f)
    assert.throws(() => n.storage.setItem(PREFIX + 'one', '{bad'))
    assert.equal(f.values[KEY], '{bad')
    assert.equal(f.values[PREFIX + 'one'], undefined)
  }
  const f = fixture('{bad'); f.values[PREFIX + 'one'] = 'older'; const n = native(f)
  assert.throws(() => n.storage.setItem(PREFIX + 'one', '{bad'))
  assert.equal(f.values[PREFIX + 'one'], 'older'); assert.equal(f.values[KEY], '{bad')
})
test('stale native cache cannot overwrite a later saved record even with an old backup', () => {
  const f = fixture('{old'); const n = native(f)
  n.storage.setItem(PREFIX + 'one', '{old')
  f.values[KEY] = JSON.stringify(policy.defaults())
  const next = policy.defaults(); next.profiles[0].name = 'Changed'
  assert.throws(() => n.storage.setItem(KEY, JSON.stringify(next)))
  assert.equal(f.values[KEY], JSON.stringify(policy.defaults()))
})
test('damaged preference store refuses preservation and reset without generic writes', () => {
  const f = fixture(); const n = native(f); f.setDamaged(true)
  assert.throws(() => n.storage.setItem(PREFIX + 'one', '{damaged'))
  assert.throws(() => n.storage.setItem(KEY, JSON.stringify(policy.defaults())))
  assert.equal(f.writes.length, 0); assert.equal(n.genericWrites(), 0)
})
test('canonical refusal leaves the original and preserved bytes; retry can succeed', () => {
  let fail = true; const f = fixture('{bad', { fail: key => fail && key === KEY }); const n = native(f)
  n.storage.setItem(PREFIX + 'one', '{bad')
  assert.throws(() => n.storage.setItem(KEY, JSON.stringify(policy.defaults())))
  assert.equal(f.values[KEY], '{bad'); assert.equal(n.storage.getItem(KEY), '{bad')
  assert.equal(f.values[PREFIX + 'one'], '{bad'); fail = false
  n.storage.setItem(KEY, JSON.stringify(policy.defaults()))
  assert.deepEqual(JSON.parse(f.values[KEY]), policy.defaults())
})
test('valid edits keep normalized native cache synchronized for subsequent saves', () => {
  const f = fixture(JSON.stringify(policy.defaults())); const n = native(f)
  const next = policy.defaults(); next.profiles[0].name = '  Trimmed  '
  n.storage.setItem(KEY, JSON.stringify(next))
  assert.equal(n.storage.getItem(KEY), f.values[KEY])
  assert.equal(JSON.parse(n.storage.getItem(KEY)).profiles[0].name, 'Trimmed')
  next.profiles[0].name = 'Again'; n.storage.setItem(KEY, JSON.stringify(next))
  assert.equal(JSON.parse(f.values[KEY]).profiles[0].name, 'Again')
})
test('untrusted and erased senders cannot preserve or replace permission settings', () => {
  for (const options of [{ trusted: false }, { erased: true }]) {
    const f = fixture(); const n = native(f, options)
    assert.throws(() => n.storage.setItem(PREFIX + 'one', '{damaged'))
    assert.throws(() => n.storage.setItem(KEY, JSON.stringify(policy.defaults())))
    assert.equal(f.writes.length, 0)
  }
})
test('engine still refuses tool exposure and actions while permission record is unreadable', () => {
  const f = fixture(); policy.installHost(f.host)
  assert.throws(() => policy.narrowTools([{ name: 'fixture.read', description: 'Read' }]), { code: 'ACTION_PERMISSION_PROFILE_INVALID' })
  assert.throws(() => policy.assertAction({ name: 'agent.resume' }, { sessionId: 'fixture' }), { code: 'ACTION_PERMISSION_PROFILE_INVALID' })
})
