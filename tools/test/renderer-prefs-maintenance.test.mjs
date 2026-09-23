import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createRendererPrefs } = require(process.env.RENDERER_PREFS_UNDER_TEST || '../../shell/renderer-prefs.cjs')
const key = 'mc.fleet.trees.v1:synthetic-computer'
const oldValue = JSON.stringify({ version: 1, trees: [{ id: 'tree-1' }], nodes: [{ id: 'node-1', treeId: 'tree-1', status: 'turn-failed' }] })
const newValue = oldValue.replace('turn-failed', 'finished')
const envelope = value => JSON.stringify({ storageVersion: 1, values: { [key]: value, 'mc.fleet.chat-diffs.v1:synthetic-node': 'retained unrelated bytes' } }) + '\n'

// Entire filesystem is an in-memory Map: no test cleanup or disk writes.
function fixture(t) {
  const directory = path.resolve('synthetic-maintenance-fixture')
  const fleetFile = path.join(directory, 'renderer-fleet-documents.json')
  const files = new Map([[fleetFile, envelope(oldValue)], [path.join(directory, 'renderer-prefs.json'), JSON.stringify({ storageVersion: 1, values: {}, drainedOrigins: [] })]])
  const handles = new Map(), calls = [], state = { fail: null, mutateAtSync: false }
  let serial = 0
  const failure = code => Object.assign(new Error('synthetic failure'), { code })
  const fs = {
    readFileSync(file) { if (state.fail === 'read' && file === fleetFile) throw failure('EIO'); if (!files.has(file)) throw failure('ENOENT'); if (state.fail === 'staged-read' && file.endsWith('.tmp')) return 'corrupt stage'; return files.get(file) },
    mkdirSync() {},
    openSync(file, flags) { calls.push('open'); if (files.has(file)) throw failure('EEXIST'); const fd = ++serial; handles.set(fd, file); files.set(file, ''); return fd },
    writeFileSync(fd, text) { calls.push('write'); if (state.fail === 'write') throw failure('EIO'); files.set(handles.get(fd), text) },
    fsyncSync() { calls.push('sync'); if (state.mutateAtSync) files.set(fleetFile, envelope('concurrent saved bytes')); if (state.fail === 'sync') throw failure('EIO') },
    closeSync(fd) { handles.delete(fd) },
    renameSync(from, to) { calls.push('rename'); if (state.fail === 'rename') throw failure('EIO'); files.set(to, files.get(from)); files.delete(from) },
    unlinkSync() { throw failure('EPERM') },
  }
  const prefs = createRendererPrefs({ directory, fs, path, randomUUID: () => 'synthetic-' + (++serial) })
  prefs.snapshot()
  t.after(() => prefs.sealForErase())
  const commit = () => prefs.commitFleetMaintenance({ expectedText: envelope(oldValue), replacementText: envelope(newValue) })
  return { prefs, commit, files, fleetFile, calls, state }
}

test('repair commits exact bytes and cache together, then refuses a stale renderer write', t => {
  const f = fixture(t)
  assert.equal(f.commit().ok, true)
  assert.equal(f.files.get(f.fleetFile), envelope(newValue))
  assert.equal(f.prefs.snapshot().values[key], newValue)
  assert.equal(f.prefs.snapshot().fleetPending, false)
  assert.ok(f.calls.includes('sync'))
  assert.ok(f.calls.indexOf('sync') < f.calls.indexOf('rename'))
  const stale = f.prefs.set(key, oldValue, { expectedValue: oldValue })
  assert.equal(stale.ok, false)
  assert.equal(stale.error.code, 'MC_TREE_STORAGE_CHANGED')
  assert.equal(f.files.get(f.fleetFile), envelope(newValue))
  assert.equal(f.prefs.set(key, newValue, { expectedValue: newValue }).ok, true)
})

test('pending writes refuse repair without changing cached or durable work', t => {
  const f = fixture(t)
  const unsaved = oldValue + ' '
  assert.equal(f.prefs.set(key, unsaved, { expectedValue: oldValue }).ok, true)
  assert.equal(f.commit().ok, false)
  assert.equal(f.prefs.snapshot().values[key], unsaved)
  assert.equal(f.files.get(f.fleetFile), envelope(oldValue))
  assert.equal(f.calls.length, 0)
})

test('a preview matching disk cannot overwrite a different cached record', t => {
  const f = fixture(t)
  const expectedText = envelope(newValue)
  f.files.set(f.fleetFile, expectedText)
  const result = f.prefs.commitFleetMaintenance({ expectedText, replacementText: envelope(oldValue) })
  assert.equal(result.ok, false)
  assert.equal(f.calls.length, 0)
  assert.equal(f.prefs.snapshot().values[key], oldValue)
  assert.equal(f.files.get(f.fleetFile), expectedText)
})

test('changed, missing and unreadable durable records refuse before staging', t => {
  for (const mode of ['changed', 'missing', 'read']) {
    const f = fixture(t)
    if (mode === 'changed') f.files.set(f.fleetFile, envelope('newer bytes'))
    if (mode === 'missing') f.files.delete(f.fleetFile)
    if (mode === 'read') f.state.fail = 'read'
    assert.equal(f.commit().ok, false, mode)
    assert.equal(f.calls.length, 0, mode)
    assert.equal(f.prefs.snapshot().values[key], oldValue)
  }
})

test('a durable change during staging is retained and never replaced', t => {
  const f = fixture(t)
  f.state.mutateAtSync = true
  assert.equal(f.commit().ok, false)
  assert.equal(f.files.get(f.fleetFile), envelope('concurrent saved bytes'))
  assert.equal(f.prefs.snapshot().values[key], oldValue)
  assert.equal(f.calls.includes('rename'), false)
  assert.ok([...f.files.keys()].some(file => file.endsWith('.tmp')))
})

test('failed write, sync or rename retains the source and leaves cache unchanged', t => {
  for (const mode of ['write', 'sync', 'rename']) {
    const f = fixture(t)
    f.state.fail = mode
    const result = f.commit()
    assert.equal(result.ok, false, mode)
    assert.equal(result.error.code, 'MC_FLEET_MAINTENANCE_WRITE_FAILED')
    assert.equal(f.files.get(f.fleetFile), envelope(oldValue))
    assert.equal(f.prefs.snapshot().values[key], oldValue)
    assert.ok([...f.files.keys()].some(file => file.endsWith('.tmp')))
  }
})

test('empty, malformed, oversized and sealed requests refuse without staging', t => {
  for (const replacementText of ['', '{', JSON.stringify({ storageVersion: 1, values: {} }), JSON.stringify({ storageVersion: 1, values: { [key]: newValue, 'mc.fleet.chat-diffs.v1:huge': 'x'.repeat(64 * 1024 * 1024) } })]) {
    const f = fixture(t)
    assert.equal(f.prefs.commitFleetMaintenance({ expectedText: envelope(oldValue), replacementText }).ok, false)
    assert.equal(f.calls.length, 0)
  }
  const f = fixture(t)
  f.prefs.sealForErase()
  assert.equal(f.commit().ok, false)
  assert.equal(f.calls.length, 0)
})


test('pending revision refuses even when cache and disk already carry identical bytes', t => {
  const f = fixture(t)
  f.prefs.set(key, newValue, { expectedValue: oldValue })
  f.files.set(f.fleetFile, envelope(newValue))
  const result = f.prefs.commitFleetMaintenance({ expectedText: envelope(newValue), replacementText: envelope(oldValue) })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'MC_FLEET_MAINTENANCE_UNAVAILABLE')
  assert.equal(f.files.get(f.fleetFile), envelope(newValue))
  assert.equal(f.calls.length, 0)
})

test('a corrupted staged copy refuses before rename or cache adoption', t => {
  const f = fixture(t)
  f.state.fail = 'staged-read'
  assert.equal(f.commit().ok, false)
  assert.equal(f.calls.includes('rename'), false)
  assert.equal(f.files.get(f.fleetFile), envelope(oldValue))
  assert.equal(f.prefs.snapshot().values[key], oldValue)
})
