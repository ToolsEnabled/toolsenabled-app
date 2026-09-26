// Execute selected startup/IPC regions with real stores and fixture values.
// Source boundaries select harness regions; assertions concern behavior.
// This does not launch Electron or prove startup/window ordering.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { createRecoveryHandoffStore } from '../../src/recovery-handoff-store.js'
import { WEB_DRIVE_PREF_KEY } from '../../src/device-claim-flow.js'

const require = createRequire(new URL('../../shell/main.cjs', import.meta.url))
const main = fs.readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
const preload = fs.readFileSync(new URL('../../shell/fleet-profile-preload.cjs', import.meta.url), 'utf8')
const { createRendererPrefs } = require('./renderer-prefs.cjs')
const { createNodeRecoveryStore } = require('./node-recovery-store.cjs')
function section(start, end) {
  const from = main.indexOf(start)
  const to = main.indexOf(end, from + start.length)
  if (from < 0 || to < 0) throw new Error('Shell harness region changed; update its boundaries before testing.')
  return main.slice(from, to)
}
const startup = section('const { createNodeRecoveryStore,', 'const { createNodeTranscriptCapture }') + '\ninitializeNodeRecovery()'
const recoveryIPC = section("for (const operation of ['save', 'get', 'remove', 'list'])", "ipcMain.on('mc-prefs:bootstrap'")
const writeIPC = section("ipcMain.on('mc-prefs:write'", '/* THE ONE READ THAT DOES NOT COME')
const diagnostic = section('function notePrefsRefusal(', 'function prefsErasedRefusal(')
const erasedRefusal = section('function prefsErasedRefusal(', 'let actionPermissionProfileHost')
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'item13-wiring-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return { directory, prefs: createRendererPrefs({ directory, fs, path, randomUUID }),
    store: createNodeRecoveryStore({ directory }) }
}

test('startup moves saved values to node files, preserves unrelated settings and orphan records', async t => {
  const { directory, prefs, store } = fixture(t)
  const key = 'mc.agent-recovery.v1:fixture-computer:orphan-node'
  const record = { v: 1, handoff: 'continue after the saved checkpoint', sessionId: 'fixture-session' }
  assert.equal(prefs.set(key, JSON.stringify(record)).ok, true)
  assert.equal(prefs.set('mc.text', 'large').ok, true)
  await vm.runInNewContext(startup, { require, app: { getPath: () => directory }, rendererPrefs: prefs,
    console: { log() {}, error(message) { throw new Error(message) } } })
  assert.equal(Object.hasOwn(prefs.snapshot().values, key), false)
  assert.equal(prefs.snapshot().values['mc.text'], 'large')
  assert.deepEqual((await store.get({ computerId: 'fixture-computer', nodeId: 'orphan-node' })).record, record)
  const reopened = createRendererPrefs({ directory, fs, path, randomUUID })
  assert.equal(Object.hasOwn(reopened.snapshot().values, key), false, 'removal survives reopening')
})

test('startup reports refused source removal by name and retains the source checkpoint', async t => {
  const { directory, prefs, store } = fixture(t)
  const key = 'mc.agent-recovery.v1:fixture-computer:fixture-node'
  const record = { v: 1, handoff: 'retained checkpoint' }
  assert.equal(prefs.set(key, JSON.stringify(record)).ok, true)
  prefs.removeMany = () => ({ ok: false, error: { code: 'EACCES' } })
  const errors = []
  await vm.runInNewContext(startup, { require, app: { getPath: () => directory }, rendererPrefs: prefs,
    console: { log() {}, error: message => errors.push(message) } })
  assert.equal(prefs.snapshot().values[key], JSON.stringify(record))
  assert.deepEqual((await store.get({ computerId: 'fixture-computer', nodeId: 'fixture-node' })).record, record)
  assert.ok(errors.some(message => message.includes('RECOVERY_MIGRATION_REMOVE_FAILED')))
})

test('startup names a retained invalid legacy record without logging its value', async t => {
  const { directory, prefs } = fixture(t)
  const key = 'mc.agent-recovery.v1:fixture-computer:fixture-node'
  const record = { v: 2, handoff: 'invalid version must be preserved' }
  assert.equal(prefs.set(key, JSON.stringify(record)).ok, true)
  const errors = []
  await vm.runInNewContext(startup, { require, app: { getPath: () => directory }, rendererPrefs: prefs,
    console: { log() {}, error: message => errors.push(message) } })
  assert.equal(prefs.snapshot().values[key], JSON.stringify(record))
  assert.ok(errors.some(message => message.includes(key) && message.includes('RECOVERY_RECORD_INVALID')))
  assert.equal(errors.some(message => message.includes(record.handoff)), false)
})

function installBridge(store) {
  const handlers = new Map()
  let trusted = true
  let erased = false
  vm.runInNewContext(erasedRefusal + recoveryIPC, { ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    get localDataErased() { return erased },
    nodeRecovery: store, trustedFleetProfileSender: () => trusted,
    prefsRefusal: () => ({ ok: false, error: { code: 'FIXTURE_UNTRUSTED' } }) })
  const exposed = {}
  const ipcRenderer = { sendSync: () => ({}), on() {}, invoke: (name, request) => {
    const handler = handlers.get(name)
    if (!handler) throw new Error('No handler for ' + name)
    return handler({}, request)
  } }
  vm.runInNewContext(preload, { require: name => {
    if (name !== 'electron') throw new Error('Unexpected preload dependency')
    return { contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value } }, ipcRenderer }
  }, process: { platform: process.platform }, window: { addEventListener() {} } })
  return { bridge: exposed.mcRecovery, distrust: () => { trusted = false }, erase: () => { erased = true } }
}

for (const operation of ['save', 'get', 'remove', 'list']) {
  test(`erased recovery route refuses ${operation} without accessing node files`, async t => {
    const { store } = fixture(t)
    const request = { computerId: 'fixture-computer', nodeId: 'fixture-node', record: { v: 1, handoff: 'retained fixture checkpoint' } }
    assert.equal((await store.save(request)).ok, true)
    const accesses = []
    const observed = Object.fromEntries(['save', 'get', 'remove', 'list'].map(name => [name, args => {
      accesses.push(name)
      return store[name](args)
    }]))
    const { bridge, erase } = installBridge(observed)
    erase()
    const reply = await bridge[operation]({ ...request, record: { v: 1, handoff: 'post-erase overwrite' } })
    assert.equal(reply.ok, false, `erased ${operation} must be refused`)
    assert.equal(reply.error.code, 'MC_PREFS_DATA_ERASED')
    assert.match(reply.error.message, /local-data removal has started/)
    assert.deepEqual(accesses, [], 'an erased route must not touch the backing store')
    assert.equal((await store.get(request)).record.handoff, request.record.handoff)
  })
}

test('renderer crosses preload and main, persists full handoffs, refuses whole-record overflow and untrusted writes', async t => {
  const { store } = fixture(t)
  const { bridge, distrust } = installBridge(store)
  let settingsWrites = 0
  const client = createRecoveryHandoffStore({ computerId: 'fixture-computer', bridge,
    storage: { read: () => null, write: () => { settingsWrites += 1; return true } } })
  const handoff = 'h'.repeat(48_000)
  assert.equal(await client.saveRecord('node', { handoff, sessionId: 'fixture-session' }), true)
  assert.equal((await client.readRecord('node')).handoff, handoff)
  assert.equal((await store.get({ computerId: 'fixture-computer', nodeId: 'node' })).record.handoff, handoff)
  assert.equal(settingsWrites, 0)
  const record = { v: 1, handoff: 'short', extra: '' }
  record.extra = 'x'.repeat(65_536 - Buffer.byteLength(JSON.stringify(record), 'utf8'))
  assert.equal((await bridge.save({ computerId: 'fixture-computer', nodeId: 'boundary', record })).ok, true)
  record.extra += 'x'
  const refused = await bridge.save({ computerId: 'fixture-computer', nodeId: 'boundary', record })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'RECOVERY_RECORD_TOO_LARGE')
  assert.equal(Buffer.byteLength(JSON.stringify((await bridge.get({ computerId: 'fixture-computer', nodeId: 'boundary' })).record)), 65_536)
  const unicode = await bridge.save({ computerId: 'fixture-computer', nodeId: 'unicode', record: { v: 1, handoff: 'short', extra: '\u754c'.repeat(24_000) } })
  assert.equal(unicode.ok, true, 'valid Unicode remains within the serialized character and UTF-8 byte bounds')
  distrust()
  assert.equal(await client.saveRecord('node', { handoff: 'untrusted overwrite' }), false)
  assert.equal((await store.get({ computerId: 'fixture-computer', nodeId: 'node' })).record.handoff, handoff)
  assert.equal(settingsWrites, 0, 'refusal cannot redirect back to settings')
})

test('settings handler retains enrollment and permission routing and reports ordinary persistence refusal', () => {
  let handler
  let enrolled = false
  let writes = 0
  let permissionWrites = 0
  const logs = []
  const failure = { ok: false, error: { code: 'MC_PREFS_TOO_LARGE', message: 'Fixture settings file is full.' } }
  vm.runInNewContext(diagnostic + writeIPC, {
    ipcMain: { on: (_name, callback) => { handler = callback } },
    trustedFleetProfileSender: () => true, localDataErased: false, WEB_DRIVE_PREF_KEY,
    relayMachineIsEnrolled: () => enrolled,
    rendererPrefs: { set: () => { writes += 1; return failure } },
    getActionPermissionProfileHost: () => ({ save: value => { permissionWrites += 1; return { ok: true, value } } }),
    mirrorUninstallRetentionIfRelevant() {}, console: { error: message => logs.push(message) },
  })
  const event = {}
  handler(event, { key: WEB_DRIVE_PREF_KEY, value: 'on' })
  assert.equal(event.returnValue.error.code, 'MC_PREFS_CONNECTION_CLOSED')
  assert.equal(writes, 0)
  enrolled = true
  handler(event, { key: 'mc.action-permissions.v1', value: { profile: 'fixture' } })
  assert.equal(event.returnValue.ok, true)
  assert.equal(permissionWrites, 1)
  assert.equal(writes, 0)
  handler(event, { key: 'mc.text', value: 'fixture private text' })
  assert.equal(event.returnValue, failure)
  assert.equal(writes, 1)
  assert.ok(logs.some(message => message.includes('MC_PREFS_TOO_LARGE') && message.includes('mc.text')))
  assert.equal(logs.some(message => message.includes('fixture private text')), false)
})
