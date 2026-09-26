import assert from 'node:assert/strict'
import fs from 'node:fs'
import io from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { createRecoveryHandoffStore } from '../../src/recovery-handoff-store.js'
const require = createRequire(import.meta.url)
const { createNodeRecoveryStore, createRecoveryPersistence, migrateRecoveryRecords } = require('../../shell/node-recovery-store.cjs')
const { createRendererPrefs } = require('../../shell/renderer-prefs.cjs')
const key = 'mc.agent-recovery.v1:fixture-computer:fixture-node'
const owner = { computerId: 'fixture-computer', nodeId: 'fixture-node' }
const old = { v: 1, handoff: 'OLD checkpoint' }
const newer = { v: 1, handoff: 'NEW acknowledged checkpoint' }
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
function fixture(t, { disk = io, prefsIO = fs } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'item13-safety-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const prefs = createRendererPrefs({ directory, fs: prefsIO, path, randomUUID })
  const store = createNodeRecoveryStore({ directory, io: disk })
  const client = createRecoveryHandoffStore({ computerId: owner.computerId, bridge: store,
    storage: { read: name => prefs.snapshot().values[name], write: () => { throw new Error('No legacy writes allowed') } } })
  assert.equal(prefs.set(key, JSON.stringify(old)).ok, true)
  return { directory, prefs, store, client }
}
function pausedDisk() {
  const entered = deferred()
  const release = deferred()
  let first = true
  return { entered, release, disk: { ...io, async rename(...args) {
    if (first) { first = false; entered.resolve(); await release.promise }
    return io.rename(...args)
  } } }
}

test('a redirected checkpoint survives a restart with an older retained source', async t => {
  const { prefs, store } = fixture(t)
  assert.equal((await store.save({ ...owner, record: newer })).ok, true)
  assert.equal((await migrateRecoveryRecords({ prefs, store })).moved, 1)
  assert.deepEqual((await store.get(owner)).record, newer)
  assert.equal(Object.hasOwn(prefs.snapshot().values, key), false)
})

test('a new write overlapping a paused migration is never overwritten after acknowledgment', async t => {
  const pause = pausedDisk()
  const { prefs, store } = fixture(t, pause)
  const migrating = migrateRecoveryRecords({ prefs, store })
  await pause.entered.promise
  const writing = store.save({ ...owner, record: newer })
  // Allow an unqueued writer to finish, without requiring an unsafe ordering.
  // A correct implementation may delay acknowledgment until migration finishes.
  await Promise.race([writing, new Promise(resolve => setTimeout(resolve, 30))])
  pause.release.resolve()
  assert.equal((await writing).ok, true)
  await migrating
  assert.deepEqual((await store.get(owner)).record, newer)
})

test('redirected reads retain the legacy checkpoint while migration has not published its file', async t => {
  const pause = pausedDisk()
  const { prefs, store, client } = fixture(t, pause)
  const migrating = migrateRecoveryRecords({ prefs, store })
  await pause.entered.promise
  let during
  try { during = await client.readRecord(owner.nodeId) } finally { pause.release.resolve() }
  await migrating
  assert.deepEqual(during, old)
  assert.deepEqual(await client.readRecord(owner.nodeId), old)
})

test('source-removal refusal reports no move, retains both copies, and names its reason', async t => {
  let refuse = false
  const prefsIO = Object.assign(Object.create(fs), { renameSync(...args) {
    if (refuse) { const error = new Error('fixture removal refusal'); error.code = 'EACCES'; throw error }
    return fs.renameSync(...args)
  } })
  const { directory, prefs, store } = fixture(t, { prefsIO })
  refuse = true
  const result = await migrateRecoveryRecords({ prefs, store })
  assert.equal(result.moved, 0)
  assert.equal(result.kept, 1)
  assert.equal(result.error.code, 'RECOVERY_MIGRATION_REMOVE_FAILED')
  assert.ok(result.error.message.length > 0)
  assert.equal(prefs.snapshot().values[key], JSON.stringify(old))
  assert.deepEqual((await store.get(owner)).record, old)
  const reopened = createRendererPrefs({ directory, fs, path, randomUUID })
  assert.equal(reopened.snapshot().values[key], JSON.stringify(old))
})

test('legacy Unicode accepted by prefs migrates intact within the preserved character and byte bounds', async t => {
  const { prefs, store, client } = fixture(t)
  const record = { v: 1, handoff: '\u754c'.repeat(48_000) }
  assert.equal(prefs.set(key, JSON.stringify(record)).ok, true)
  assert.equal((await store.save({ ...owner, record })).ok, true, 'preserve the accepted whole-record character and byte bounds')
  const result = await migrateRecoveryRecords({ prefs, store })
  assert.equal(result.moved, 1)
  assert.equal(result.kept, 0)
  assert.deepEqual(await client.readRecord(owner.nodeId), record)
  assert.deepEqual((await createNodeRecoveryStore({ directory: path.dirname(store.directory) }).get(owner)).record, record)
})

test('a source rewritten during migration stays visible and can be migrated on the next run', async t => {
  const { prefs, store, client } = fixture(t)
  const snapshot = prefs.snapshot.bind(prefs)
  let reads = 0
  prefs.snapshot = () => {
    if (++reads === 2) assert.equal(prefs.set(key, JSON.stringify(newer)).ok, true)
    return snapshot()
  }
  assert.equal((await migrateRecoveryRecords({ prefs, store })).deferred, 1)
  assert.deepEqual(await client.readRecord(owner.nodeId), newer)
  assert.equal((await migrateRecoveryRecords({ prefs, store })).moved, 1)
  assert.deepEqual((await store.get(owner)).record, newer)
})

test('an explicit bridge refusal cannot expose a cached pre-erase checkpoint', async () => {
  let legacyReads = 0
  const client = createRecoveryHandoffStore({ computerId: owner.computerId,
    bridge: { save() {}, get: async () => ({ ok: false, error: { code: 'MC_PREFS_DATA_ERASED' } }) },
    storage: { read: () => { legacyReads += 1; return old } } })
  await assert.rejects(client.readRecord(owner.nodeId), { code: 'MC_PREFS_DATA_ERASED' })
  assert.equal(legacyReads, 0)
})

for (const writesNew of [false, true]) {
  test(`source-removal refusal then reopen/retry preserves ${writesNew ? 'NEW redirected' : 'OLD unchanged'} checkpoint`, async t => {
    let refuse = false
    const prefsIO = Object.assign(Object.create(fs), { renameSync(...args) {
      if (refuse) { const error = new Error('fixture removal refusal'); error.code = 'EACCES'; throw error }
      return fs.renameSync(...args)
    } })
    const { directory, prefs, store } = fixture(t, { prefsIO })
    refuse = true
    const first = await migrateRecoveryRecords({ prefs, store })
    assert.equal(first.moved, 0)
    assert.equal(first.error.code, 'RECOVERY_MIGRATION_REMOVE_FAILED')
    if (writesNew) assert.equal((await store.save({ ...owner, record: newer })).ok, true)
    refuse = false
    const reopenedPrefs = createRendererPrefs({ directory, fs, path, randomUUID })
    const reopenedStore = createNodeRecoveryStore({ directory })
    assert.equal(Object.hasOwn(reopenedPrefs.snapshot().values, key), true)
    assert.equal((await migrateRecoveryRecords({ prefs: reopenedPrefs, store: reopenedStore })).moved, 1)
    assert.deepEqual((await reopenedStore.get(owner)).record, writesNew ? newer : old)
    assert.equal(Object.hasOwn(reopenedPrefs.snapshot().values, key), false)
    assert.equal((await migrateRecoveryRecords({ prefs: reopenedPrefs, store: reopenedStore })).moved, 0)
  })
}

test('unmarked destination with unknown freshness preserves both versions and refuses silent selection', async t => {
  const { prefs, store, client } = fixture(t)
  assert.equal((await store.save({ ...owner, record: newer })).ok, true)
  const file = path.join(store.directory, fs.readdirSync(store.directory).find(name => name.endsWith('.json')))
  // Reproduce the held store's on-disk envelope, which had no provenance marker.
  fs.writeFileSync(file, JSON.stringify({ ...owner, savedAt: 1, record: newer }))
  const result = await migrateRecoveryRecords({ prefs, store })
  assert.equal(result.moved, 0)
  assert.equal(result.kept, 1)
  assert.equal(result.refusals[0].code, 'RECOVERY_MIGRATION_CONFLICT')
  assert.equal(prefs.snapshot().values[key], JSON.stringify(old))
  assert.deepEqual((await store.get(owner)).record, newer)
  await assert.rejects(client.readRecord(owner.nodeId), { code: 'RECOVERY_MIGRATION_CONFLICT' })
})

test('lifecycle coordinator preserves acknowledged Windows checkpoint over retained source after reopen', async t => {
  const { directory, prefs, store } = fixture(t)
  assert.equal((await store.save({ ...owner, record: newer })).ok, true)
  const coordinator = createRecoveryPersistence({ prefs, store: createNodeRecoveryStore({ directory }) })
  t.after(() => coordinator.stop())
  assert.deepEqual((await coordinator.get(owner)).record, newer)
  assert.equal((await coordinator.initialize()).moved, 1)
  assert.deepEqual((await coordinator.get(owner)).record, newer)
  assert.equal(prefs.snapshot().values[key], undefined)
})

test('queued coordinator saves persist the admitted snapshot and stop joins both writes', async t => {
  const pause = pausedDisk()
  const { prefs, store } = fixture(t, pause)
  assert.equal(prefs.removeMany([key]).ok, true)
  const coordinator = createRecoveryPersistence({ prefs, store })
  const first = coordinator.save({ ...owner, record: old })
  await pause.entered.promise
  const request = { ...owner, record: { ...newer } }
  const second = coordinator.save(request)
  request.record.handoff = 'mutated after admission'
  pause.release.resolve()
  assert.equal((await first).ok, true)
  assert.equal((await second).ok, true)
  await coordinator.stop()
  assert.deepEqual((await createNodeRecoveryStore({ directory: path.dirname(store.directory) }).get(owner)).record, newer)
})

test('authoritative empty coordinator read cannot resurrect a stale renderer checkpoint', async () => {
  let legacyReads = 0
  const client = createRecoveryHandoffStore({ computerId: owner.computerId,
    bridge: { save() {}, get: async () => ({ ok: true, record: null, authoritative: true }) },
    storage: { read: () => { legacyReads += 1; return old } } })
  assert.equal(await client.readRecord(owner.nodeId), null)
  assert.equal(legacyReads, 0)
})

test('legacy browser drain preserves a differing unmarked destination and its source', async t => {
  const { prefs, store } = fixture(t)
  assert.equal(prefs.removeMany([key]).ok, true)
  assert.equal((await store.save({ ...owner, record: newer })).ok, true)
  const file = path.join(store.directory, fs.readdirSync(store.directory).find(name => name.endsWith('.json')))
  const before = JSON.stringify({ ...owner, savedAt: 1, record: newer })
  fs.writeFileSync(file, before)
  const coordinator = createRecoveryPersistence({ prefs, store })
  t.after(() => coordinator.stop())
  const origin = 'http://127.0.0.1:4601'
  const source = [[key, JSON.stringify(old)]]
  const answer = await coordinator.drainLegacyOrigin(origin, source)
  assert.equal(answer.error.code, 'RECOVERY_MIGRATION_CONFLICT')
  assert.equal(prefs.isDrained(origin), false)
  assert.equal(fs.readFileSync(file, 'utf8'), before)
  assert.deepEqual(source, [[key, JSON.stringify(old)]])
  assert.equal((await coordinator.get(owner)).error.code, 'RECOVERY_MIGRATION_INCOMPLETE')
})
