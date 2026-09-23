// Synthetic recovery fixtures exercise capacity, preservation and migration.
// They are not current live-corpus measurements. Migration follows NO PRUNE.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const { createNodeRecoveryStore, migrateRecoveryRecords, RECOVERY_KEY_PREFIX } =
  require_(path.join(ROOT, 'shell/node-recovery-store.cjs'))

/* Not under node_modules: in a worktree whose node_modules is a junction to the
   shared dependency store, rmSync answers EPERM in teardown and fails the case
   after the assertions have already run, as recorded by the held branch. */
const SCRATCH = path.join(os.tmpdir(), 'toolsenabled-node-recovery-test')
fs.mkdirSync(SCRATCH, { recursive: true })
const workdir = prefix => fs.mkdtempSync(path.join(SCRATCH, prefix))
const discard = dir => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) } catch { /* best effort */ } }

const RECORD = { v: 1, handoff: 'the agent was part way through the audit', sessionId: 's-1', recoveryId: 'r-1' }

function storeIn(prefix) {
  const dir = workdir(prefix)
  return { dir, store: createNodeRecoveryStore({ directory: dir }) }
}

/* ---------- the store ---------- */

test('a saved record reads back, and lives in its own file', async () => {
  const { dir, store } = storeIn('rt-')
  try {
    assert.equal((await store.save({ computerId: 'this-computer', nodeId: 'node-1', record: RECORD })).ok, true)
    const got = await store.get({ computerId: 'this-computer', nodeId: 'node-1' })
    assert.equal(got.ok, true)
    assert.equal(got.record.handoff, RECORD.handoff, 'the handoff text is the whole point of the record')

    const second = await store.save({ computerId: 'this-computer', nodeId: 'node-2', record: { ...RECORD, handoff: 'another' } })
    assert.equal(second.ok, true)
    const listed = await store.list({ computerId: 'this-computer' })
    assert.equal(listed.nodeIds.length, 2, 'each node must have its own record, not a shared one')
  } finally { discard(dir) }
})

test('a node that was never saved reads as absent, not as an error', async () => {
  const { dir, store } = storeIn('absent-')
  try {
    const got = await store.get({ computerId: 'this-computer', nodeId: 'never' })
    assert.equal(got.ok, true)
    assert.equal(got.record, null, 'absent must be distinguishable from unreadable')
  } finally { discard(dir) }
})

test('one node\'s record is not disturbed by another node\'s write', async () => {
  /* The property the shared record could not offer: writing node-2 rewrote the
     bytes of every other node's record too. */
  const { dir, store } = storeIn('isolate-')
  try {
    await store.save({ computerId: 'c', nodeId: 'a', record: { ...RECORD, handoff: 'A' } })
    await store.save({ computerId: 'c', nodeId: 'b', record: { ...RECORD, handoff: 'B' } })
    await store.save({ computerId: 'c', nodeId: 'b', record: { ...RECORD, handoff: 'B2' } })
    assert.equal((await store.get({ computerId: 'c', nodeId: 'a' })).record.handoff, 'A')
    assert.equal((await store.get({ computerId: 'c', nodeId: 'b' })).record.handoff, 'B2')
  } finally { discard(dir) }
})

test('removing a node deletes its record and leaves the others', async () => {
  const { dir, store } = storeIn('prune-')
  try {
    await store.save({ computerId: 'c', nodeId: 'a', record: RECORD })
    await store.save({ computerId: 'c', nodeId: 'b', record: RECORD })
    assert.equal((await store.remove({ computerId: 'c', nodeId: 'a' })).ok, true)
    assert.equal((await store.get({ computerId: 'c', nodeId: 'a' })).record, null)
    assert.ok((await store.get({ computerId: 'c', nodeId: 'b' })).record, 'pruning one node must not prune another')
  } finally { discard(dir) }
})

test('removing a node that has no record is not an error', async () => {
  const { dir, store } = storeIn('prune-absent-')
  try { assert.equal((await store.remove({ computerId: 'c', nodeId: 'ghost' })).ok, true) } finally { discard(dir) }
})

test('an oversized handoff is refused rather than written', async () => {
  /* The old store bounded this at 48,000 characters and the bound travels with
     the data, not with the storage it happened to live in. */
  const { dir, store } = storeIn('bound-')
  try {
    const answer = await store.save({ computerId: 'c', nodeId: 'a', record: { ...RECORD, handoff: 'x'.repeat(48001) } })
    assert.equal(answer.ok, false, 'an unbounded record would put the disk problem where the settings problem was')
  } finally { discard(dir) }
})

/* ---------- the migration ---------- */

/* A stand-in for the settings record, with the two operations the migration is
   allowed to use. `removed` records the order so the suite can prove a key is
   never dropped before its file exists. */
function fakePrefs(values) {
  const store = new Map(Object.entries(values))
  const removed = []
  let snapshots = 0
  return {
    removed,
    /* `onSecondSnapshot` simulates a handoff landing mid-run: the migration reads
       the record once at the start and re-reads it before removing, so a change
       injected between the two is exactly the race a real save() causes. */
    onSecondSnapshot: null,
    snapshot() {
      snapshots += 1
      if (snapshots === 2 && typeof this.onSecondSnapshot === 'function') this.onSecondSnapshot(store)
      return { values: Object.fromEntries(store) }
    },
    removeMany(keys) {
      for (const key of keys) { store.delete(key); removed.push(key) }
      return { ok: true }
    },
    has: key => store.has(key),
    size: () => store.size,
  }
}

const recoveryKey = (computerId, nodeId) => `${RECOVERY_KEY_PREFIX}${encodeURIComponent(computerId)}:${encodeURIComponent(nodeId)}`

test('the migration moves every recovery record out and leaves nothing else touched', async () => {
  const { dir, store } = storeIn('migrate-')
  try {
    const prefs = fakePrefs({
      'mc.theme': 'black',
      [recoveryKey('this-computer', 'node-1')]: JSON.stringify(RECORD),
      [recoveryKey('this-computer', 'node-2')]: JSON.stringify({ ...RECORD, handoff: 'two' }),
    })

    const result = await migrateRecoveryRecords({ prefs, store })

    assert.equal(result.moved, 2)
    assert.equal(prefs.has('mc.theme'), true, 'a migration must not touch anything it did not come for')
    assert.equal(prefs.has(recoveryKey('this-computer', 'node-1')), false, 'a moved record must leave the settings file')
    assert.equal((await store.get({ computerId: 'this-computer', nodeId: 'node-2' })).record.handoff, 'two')
  } finally { discard(dir) }
})

test('THE KEY IS NEVER DROPPED BEFORE THE FILE EXISTS', async () => {
  /* The ordering property that makes this safe to run on a person's machine. If
     the disk write fails, the record must still be in the settings file. */
  const { dir } = storeIn('order-')
  try {
    const failing = {
      save: async () => ({ ok: false, error: { code: 'DISK_FULL' } }),
      get: async () => ({ ok: true, record: null }),
    }
    const prefs = fakePrefs({ [recoveryKey('c', 'node-1')]: JSON.stringify(RECORD) })

    const result = await migrateRecoveryRecords({ prefs, store: failing })

    assert.equal(result.moved, 0)
    assert.equal(result.kept, 1)
    assert.equal(prefs.has(recoveryKey('c', 'node-1')), true,
      'a record whose file could not be written MUST stay in the settings file')
    assert.deepEqual(prefs.removed, [], 'nothing may be removed when nothing was saved')
  } finally { discard(dir) }
})

test('a record that cannot be parsed is kept, never deleted', async () => {
  /* The damaged/partial case the settings store already defends elsewhere. An
     unreadable record is exactly the one whose bytes we must not throw away. */
  const { dir, store } = storeIn('damaged-')
  try {
    const prefs = fakePrefs({
      [recoveryKey('c', 'good')]: JSON.stringify(RECORD),
      [recoveryKey('c', 'broken')]: '{ this is not json',
    })

    const result = await migrateRecoveryRecords({ prefs, store })

    assert.equal(result.moved, 1)
    assert.equal(result.kept, 1)
    assert.equal(prefs.has(recoveryKey('c', 'broken')), true, 'unparseable bytes are still the person\'s data')
    assert.equal(prefs.has(recoveryKey('c', 'good')), false)
  } finally { discard(dir) }
})

test('running the migration twice changes nothing the second time', async () => {
  const { dir, store } = storeIn('idempotent-')
  try {
    const prefs = fakePrefs({ [recoveryKey('c', 'node-1')]: JSON.stringify(RECORD) })
    assert.equal((await migrateRecoveryRecords({ prefs, store })).moved, 1)
    const second = await migrateRecoveryRecords({ prefs, store })
    assert.equal(second.moved, 0)
    assert.equal(second.kept, 0)
    assert.equal((await store.get({ computerId: 'c', nodeId: 'node-1' })).record.handoff, RECORD.handoff,
      'a second run must not damage what the first run moved')
  } finally { discard(dir) }
})

test('a settings record with no recovery keys is left completely alone', async () => {
  const { dir, store } = storeIn('nothing-')
  try {
    const prefs = fakePrefs({ 'mc.theme': 'black', 'mc.text': 'large' })
    const result = await migrateRecoveryRecords({ prefs, store })
    assert.equal(result.moved, 0)
    assert.deepEqual(prefs.removed, [])
    assert.equal(prefs.size(), 2)
  } finally { discard(dir) }
})

/* ---------- the whole record is bounded, not just its handoff ---------- */

test('A RECORD WHOSE OTHER FIELDS ARE HUGE IS REFUSED — the bound is on the record, not the handoff', async () => {
  /* FOUND BY REVIEWING MY OWN CHANGE, and it is a regression this store
     introduced. The old route went through renderer-prefs, whose MAX_VALUE_LENGTH
     bounded the ENTIRE serialised value at 64 KB. Moving these records to disk
     bounded `handoff` (48,000 chars) and nothing else — so
     { v:1, handoff:'ok', junk:<10 MB> } was accepted and written.
     The IPC handler passes the renderer's request straight to save(), and
     trustedFleetProfileSender gates the SENDER, not the payload size, so a forged
     payload from the app's own frame could write unbounded data to disk. Disk is
     not the constrained resource and this is main-frame-only, but a bound that
     existed before must not quietly disappear because the storage moved. */
  const { dir, store } = storeIn('wholebound-')
  try {
    const answer = await store.save({
      computerId: 'c',
      nodeId: 'a',
      record: { v: 1, handoff: 'well within the handoff cap', junk: 'x'.repeat(2_000_000) },
    })
    assert.equal(answer.ok, false, 'an unbounded record must not reach the disk')
    assert.equal((await store.get({ computerId: 'c', nodeId: 'a' })).record, null,
      'and nothing may have been written before the refusal')
  } finally { discard(dir) }
})

test('a legitimate record at the full handoff cap still fits', async () => {
  /* The bound must not be so tight that it refuses the largest REAL record. The
     handoff cap is 48,000; a record at the cap plus its small
     companion fields has to pass, or this "fix" becomes the outage. */
  const { dir, store } = storeIn('atcap-')
  try {
    const answer = await store.save({
      computerId: 'c',
      nodeId: 'a',
      record: { v: 1, handoff: 'h'.repeat(48_000), sessionId: 's-1', recoveryId: 'r-1', kind: 'manual' },
    })
    assert.equal(answer.ok, true, 'the largest legitimate record must still be storable')
    assert.equal((await store.get({ computerId: 'c', nodeId: 'a' })).record.handoff.length, 48_000)
  } finally { discard(dir) }
})

/* ---------- the Controller's specified proof ---------- */

test('THE SPECIFIED PROOF: 23 records including 7 orphans -> 0 in ordinary, 23 in the store, second run a no-op', async () => {
  /* THE RULING: the migration moves ALL 23 out, ORPHANS INCLUDED, and deletes
     nothing. A first run that destroys nothing cannot be the thing that loses a
     person's data — which is the brief's own hard rule applied to itself.
     The 7 orphans are written under their own node ids like any other record.

     Records are near the 48,000-character cap so the fixture exercises storage
     volume as well as record count. */
  const { dir, store } = storeIn('specified-')
  try {
    const values = { 'mc.theme': 'black' }
    for (let index = 0; index < 23; index += 1) {
      const nodeId = `node-${index}-1f0e3dad-9999-4444-8888-abcdefabcdef`
      /* The last 7 are orphans: no circle anywhere names them. Under this ruling
         that changes nothing about how they are treated. */
      values[recoveryKey('this-computer', nodeId)] =
        JSON.stringify({ v: 1, handoff: 'h'.repeat(43_600), sessionId: `s-${index}` })
    }
    const prefs = fakePrefs(values)
    const recoveryKeysLeft = () => Object.keys(prefs.snapshot().values).filter(key => key.startsWith(RECOVERY_KEY_PREFIX)).length

    assert.equal(recoveryKeysLeft(), 23, 'the fixture must start with all 23 in ordinary')

    const first = await migrateRecoveryRecords({ prefs, store })

    assert.equal(first.moved, 23, 'all 23 move, orphans included')
    assert.equal(recoveryKeysLeft(), 0, '0 recovery records may remain in ordinary')
    assert.equal((await store.list({ computerId: 'this-computer' })).nodeIds.length, 23,
      'all 23 must be in the store — nothing is destroyed by a first run')
    assert.equal(prefs.has('mc.theme'), true, 'the migration takes only what it came for')

    /* THE PART MOST LIKELY TO BE GOT WRONG. A second run must not duplicate, must
       not re-migrate, and must not touch the store. */
    const before = prefs.removed.length
    const second = await migrateRecoveryRecords({ prefs, store })

    assert.equal(second.moved, 0, 'a second run must move nothing')
    assert.equal(second.kept, 0, 'a second run must find nothing to keep either')
    assert.equal(prefs.removed.length, before, 'a second run must not write to the settings record at all')
    assert.equal((await store.list({ computerId: 'this-computer' })).nodeIds.length, 23,
      'a second run must leave exactly the 23 already there, not 46')
  } finally { discard(dir) }
})

/* ---------- a first handoff arriving mid-run ---------- */

test('A RECORD REWRITTEN DURING THE MIGRATION IS NOT DROPPED — the newer value wins', async () => {
  /* A legacy save can land while migration is awaiting IO. The race: the migration reads V1, writes V1 to disk, a handoff
     writes V2 into settings, and a naive removal then deletes the key — losing V2,
     the newer continuation checkpoint.
     RESOLVED AS COMPARE-AND-DELETE, SOURCE WINS: a key is removed only if its
     value is still byte-identical to the one migrated. Anything rewritten is left
     in settings and picked up by the next run, so the newer value always survives
     and the two stores converge. Never the reverse: a stale disk copy must not be
     allowed to bury a newer handoff. */
  const { dir, store } = storeIn('race-')
  try {
    const stableKey = recoveryKey('c', 'stable-node')
    const racedKey = recoveryKey('c', 'raced-node')
    const prefs = fakePrefs({
      [stableKey]: JSON.stringify({ v: 1, handoff: 'h'.repeat(43_600) }),
      [racedKey]: JSON.stringify({ v: 1, handoff: 'OLD'.repeat(1_000) }),
    })

    /* The handoff lands after the migration has read and written, before it removes. */
    prefs.onSecondSnapshot = store_ => { store_.set(racedKey, JSON.stringify({ v: 1, handoff: 'NEW'.repeat(1_000) })) }

    const result = await migrateRecoveryRecords({ prefs, store })

    assert.equal(prefs.has(racedKey), true,
      'a record rewritten mid-run MUST stay in settings — removing it would lose the newer handoff')
    assert.equal(prefs.has(stableKey), false, 'the untouched record still migrates normally')
    assert.equal(result.moved, 1)
    assert.equal(result.deferred, 1, 'the raced record is reported as deferred, not silently skipped')

    /* And the newer value is still the one in settings, so the next run carries it. */
    assert.match(prefs.snapshot().values[racedKey], /NEW/, 'the newer handoff must be what survives')
  } finally { discard(dir) }
})

/* ---------- the headline the brief asks for ---------- */

test('AFTER MIGRATION THE ORDINARY RECORD IS BELOW HALF ITS LIMIT', async () => {
  /* Synthetic near-capacity record. Before/after bytes are asserted. */
  const { dir, store } = storeIn('headline-')
  try {
    const MAX_RECORD_BYTES = 1024 * 1024
    const values = { 'mc.theme': 'black', 'mc.fleet.transcripts.v1:this-computer': 'x'.repeat(23_000) }
    for (let index = 0; index < 23; index += 1) {
      values[recoveryKey('this-computer', `node-${index}`)] =
        JSON.stringify({ ...RECORD, handoff: 'h'.repeat(43_500) })
    }
    const prefs = fakePrefs(values)
    const ordinaryBytes = () => Buffer.byteLength(JSON.stringify({ values: prefs.snapshot().values }), 'utf8')

    const before = ordinaryBytes()
    assert.ok(before > MAX_RECORD_BYTES * 0.9,
      `the fixture must reproduce the real problem, saw ${before} bytes`)

    const result = await migrateRecoveryRecords({ prefs, store })
    const after = ordinaryBytes()

    assert.equal(result.moved, 23)
    assert.ok(after < MAX_RECORD_BYTES / 2,
      `the ordinary record must end below half the limit: before ${before}, after ${after}`)
    /* And the records still exist — the point is to move them, not to lose them. */
    assert.equal((await store.list({ computerId: 'this-computer' })).nodeIds.length, 23)
  } finally { discard(dir) }
})

// Reviewed successor regressions: the previous value must survive every refusal.
for (const [label, handoff] of [['ASCII', 'h'.repeat(48_000)], ['Unicode', '界'.repeat(48_000)]]) {
  test(`whole serialized record accepts its exact boundary (${label}) and refuses one extra code unit`, async () => {
    const { MAX_RECORD_CHARS, MAX_RECORD_BYTES } = require_('../../shell/node-recovery-store.cjs')
    const { dir, store } = storeIn('exact-bound-')
    try {
      const record = { v: 1, handoff, extra: '' }
      record.extra = 'x'.repeat(MAX_RECORD_CHARS - JSON.stringify(record).length)
      assert.equal(JSON.stringify(record).length, MAX_RECORD_CHARS)
      assert.ok(Buffer.byteLength(JSON.stringify(record)) <= MAX_RECORD_BYTES)
      assert.equal((await store.save({ computerId: 'c', nodeId: 'n', record })).ok, true)
      const file = fs.readdirSync(store.directory).find(name => name.endsWith('.json'))
      const before = fs.readFileSync(path.join(store.directory, file))
      const refused = await store.save({ computerId: 'c', nodeId: 'n', record: { ...record, extra: record.extra + 'x' } })
      assert.equal(refused.ok, false)
      assert.equal(refused.error.code, 'RECOVERY_RECORD_TOO_LARGE')
      assert.deepEqual(fs.readFileSync(path.join(store.directory, file)), before)
      const reopened = createNodeRecoveryStore({ directory: dir })
      assert.deepEqual((await reopened.get({ computerId: 'c', nodeId: 'n' })).record, record)
      assert.equal(fs.readdirSync(store.directory).length, 1, 'no temporary file is created on refusal')
    } finally { discard(dir) }
  })
}

test('a failed rename preserves the previous checkpoint and removes its temporary file', async () => {
  const { dir, store } = storeIn('rename-refusal-')
  try {
    await store.save({ computerId: 'c', nodeId: 'n', record: RECORD })
    const io = { ...fs.promises, rename: async () => { throw Object.assign(new Error('full'), { code: 'ENOSPC' }) } }
    const failing = createNodeRecoveryStore({ directory: dir, io })
    const answer = await failing.save({ computerId: 'c', nodeId: 'n', record: { ...RECORD, handoff: 'replacement' } })
    assert.equal(answer.error.code, 'RECOVERY_WRITE_FAILED')
    assert.deepEqual((await store.get({ computerId: 'c', nodeId: 'n' })).record, RECORD)
    assert.equal(fs.readdirSync(store.directory).length, 1)
  } finally { discard(dir) }
})

test('the bytes checked before asynchronous IO are the bytes written', async () => {
  const { dir } = storeIn('snapshot-')
  try {
    let release
    const gate = new Promise(resolve => { release = resolve })
    const io = { ...fs.promises, mkdir: async (...args) => { await gate; return fs.promises.mkdir(...args) } }
    const store = createNodeRecoveryStore({ directory: dir, io })
    const record = { ...RECORD }
    const saving = store.save({ computerId: 'c', nodeId: 'n', record })
    record.junk = 'x'.repeat(2_000_000)
    release()
    assert.equal((await saving).ok, true)
    assert.deepEqual((await store.get({ computerId: 'c', nodeId: 'n' })).record, RECORD)
  } finally { discard(dir) }
})

test('a cyclic payload refuses before changing the prior checkpoint', async () => {
  const { dir, store } = storeIn('cyclic-')
  try {
    await store.save({ computerId: 'c', nodeId: 'n', record: RECORD })
    const cycle = { ...RECORD }; cycle.self = cycle
    const answer = await store.save({ computerId: 'c', nodeId: 'n', record: cycle })
    assert.equal(answer.error.code, 'RECOVERY_RECORD_INVALID')
    assert.deepEqual((await store.get({ computerId: 'c', nodeId: 'n' })).record, RECORD)
  } finally { discard(dir) }
})

test('refused source removal reports zero moved and keeps the original settings', async () => {
  const { dir, store } = storeIn('remove-refusal-')
  try {
    const key = recoveryKey('c', 'n')
    const prefs = fakePrefs({ [key]: JSON.stringify(RECORD), 'mc.theme': 'black' })
    prefs.removeMany = () => ({ ok: false, error: { code: 'MC_PREFS_WRITE_FAILED' } })
    const before = prefs.snapshot()
    const answer = await migrateRecoveryRecords({ prefs, store })
    assert.equal(answer.moved, 0)
    assert.equal(answer.kept, 1)
    assert.equal(answer.error.code, 'RECOVERY_MIGRATION_REMOVE_FAILED')
    assert.equal(answer.error.cause, 'MC_PREFS_WRITE_FAILED')
    assert.deepEqual(prefs.snapshot(), before)
    assert.deepEqual((await store.get({ computerId: 'c', nodeId: 'n' })).record, RECORD)
  } finally { discard(dir) }
})

test('retained legacy data stays readable; refused cleanup cannot accept a replacement that would regress on restart', async () => {
  const { createRecoveryPersistence } = require_('../../shell/node-recovery-store.cjs')
  const { dir, store } = storeIn('service-refusal-')
  try {
    const key = recoveryKey('c', 'n')
    const prefs = fakePrefs({ [key]: JSON.stringify(RECORD) })
    const remove = prefs.removeMany
    prefs.removeMany = () => ({ ok: false, error: { code: 'MC_PREFS_WRITE_FAILED' } })
    const service = createRecoveryPersistence({ prefs, store })
    assert.equal((await service.initialize()).moved, 0)
    assert.deepEqual((await service.get({ computerId: 'c', nodeId: 'n' })).record, RECORD)
    const request = { computerId: 'c', nodeId: 'n', record: { ...RECORD, handoff: 'newest checkpoint' } }
    assert.equal((await service.save(request)).error.code, 'RECOVERY_MIGRATION_INCOMPLETE')
    assert.equal(prefs.snapshot().values[key], JSON.stringify(RECORD))
    prefs.removeMany = remove
    assert.equal((await service.save(request)).ok, true)
    assert.equal(prefs.has(key), false)
    const restarted = createRecoveryPersistence({ prefs, store: createNodeRecoveryStore({ directory: dir }) })
    await restarted.initialize()
    assert.deepEqual((await restarted.get(request)).record, request.record)
  } finally { discard(dir) }
})

test('recovery queued during startup cannot be overwritten by the old migration', async () => {
  const { createRecoveryPersistence } = require_('../../shell/node-recovery-store.cjs')
  const { dir, store } = storeIn('service-order-')
  try {
    const prefs = fakePrefs({ [recoveryKey('c', 'n')]: JSON.stringify(RECORD) })
    let release
    const gate = new Promise(resolve => { release = resolve })
    const service = createRecoveryPersistence({ prefs, store: { ...store, importLegacy: async request => { await gate; return store.importLegacy(request) } } })
    const startup = service.initialize()
    const request = { computerId: 'c', nodeId: 'n', record: { ...RECORD, handoff: 'latest' } }
    const saving = service.save(request)
    release()
    assert.equal((await startup).moved, 1)
    assert.equal((await saving).ok, true)
    assert.deepEqual((await service.get(request)).record, request.record)
  } finally { discard(dir) }
})

test('stop waits for the active write and refuses queued and later writes before reset or quit', async () => {
  const { createRecoveryPersistence } = require_('../../shell/node-recovery-store.cjs')
  const { dir, store } = storeIn('stop-queue-')
  try {
    let release, entered
    const gate = new Promise(resolve => { release = resolve })
    const active = new Promise(resolve => { entered = resolve })
    const service = createRecoveryPersistence({ prefs: fakePrefs({}), store: {
      ...store, save: async request => { entered(); await gate; return store.save(request) },
    } })
    const request = { computerId: 'c', nodeId: 'n', record: RECORD }
    const first = service.save(request)
    await active
    const queued = service.save({ ...request, nodeId: 'queued' })
    let drained = false
    const stopping = service.stop().then(() => { drained = true })
    await Promise.resolve()
    assert.equal(drained, false, 'filesystem IO must settle before the eraser or process exit')
    release()
    assert.equal((await first).ok, true)
    assert.equal((await queued).error.code, 'RECOVERY_STORAGE_STOPPED')
    await stopping
    assert.equal(drained, true)
    assert.equal((await service.save({ ...request, nodeId: 'late' })).error.code, 'RECOVERY_STORAGE_STOPPED')
    assert.deepEqual((await store.get(request)).record, RECORD)
    assert.equal(fs.readdirSync(store.directory).length, 1)
  } finally { discard(dir) }
})

test('existing node-privacy cleanup preserves checkpoints before and after externalization (NO PRUNE)', async () => {
  const { randomUUID } = require_('node:crypto')
  const { createRendererPrefs } = require_('../../shell/renderer-prefs.cjs')
  const { createNodePrivacyCleanup } = require_('../../shell/node-privacy-cleanup.cjs')
  const { dir, store } = storeIn('privacy-preservation-')
  try {
    const prefs = createRendererPrefs({ directory: dir, fs, path, randomUUID })
    const key = recoveryKey('c', 'orphan')
    const raw = JSON.stringify(RECORD)
    assert.equal(prefs.set(key, raw).ok, true)
    assert.equal(prefs.set('mc.theme', 'black').ok, true)
    const cleanup = createNodePrivacyCleanup({ prefs, org: { resetOrg: () => ({ ok: true }) },
      transcripts: { clearForPrivacy: async () => {} } })
    // This is the baseline policy: node cleanup removes the forest/history,
    // while a recovery checkpoint survives. Externalization must not add pruning.
    cleanup.prepare()
    await cleanup.recover()
    assert.equal(prefs.snapshot().values[key], raw)
    assert.equal((await migrateRecoveryRecords({ prefs, store })).moved, 1)
    assert.equal(prefs.snapshot().values[key], undefined)
    cleanup.prepare()
    await cleanup.recover()
    const reopened = createNodeRecoveryStore({ directory: dir })
    assert.deepEqual((await reopened.get({ computerId: 'c', nodeId: 'orphan' })).record, RECORD)
    assert.equal(prefs.snapshot().values['mc.theme'], 'black')
  } finally { discard(dir) }
})

test('full local-data erase removes legacy and external checkpoints; a refused root preserves them and a stopped writer cannot recreate them', async () => {
  const { createRecoveryPersistence } = require_('../../shell/node-recovery-store.cjs')
  const { eraseLocalData, REFUSED_WELL_KNOWN } = require_('../../shell/local-data-reset.cjs')
  const { dir, store } = storeIn('erase-recovery-')
  try {
    const request = { computerId: 'c', nodeId: 'orphan', record: RECORD }
    const service = createRecoveryPersistence({ prefs: fakePrefs({}), store })
    assert.equal((await service.save(request)).ok, true)
    fs.writeFileSync(path.join(dir, 'renderer-prefs.json'), JSON.stringify({
      storageVersion: 1, values: { [recoveryKey('c', 'legacy')]: JSON.stringify(RECORD) }, drainedOrigins: [],
    }))
    const refused = eraseLocalData({ roots: [dir], env: { APPDATA: dir }, homedir: () => os.homedir() })
    assert.equal(refused.complete, false)
    assert.equal(refused.results[0].code, REFUSED_WELL_KNOWN)
    assert.deepEqual((await store.get(request)).record, RECORD)
    assert.equal(fs.existsSync(path.join(dir, 'renderer-prefs.json')), true)
    await service.stop()
    const erased = eraseLocalData({ roots: [{ kind: 'user-data', directory: dir }], env: {}, homedir: () => os.homedir() })
    assert.equal(erased.complete, true)
    for (const name of ['node-recovery', 'renderer-prefs.json']) {
      assert.equal(erased.results[0].entries.find(entry => entry.name === name)?.removed, true)
    }
    assert.equal(fs.existsSync(dir), false)
    assert.equal((await service.save(request)).error.code, 'RECOVERY_STORAGE_STOPPED')
    assert.equal(fs.existsSync(dir), false, 'late recovery cannot recreate erased data')
  } finally { discard(dir) }
})

for (const [label, record] of [
  ['extra fields', { ...RECORD, extra: 'x'.repeat(65_536) }],
  ['handoff length', { ...RECORD, handoff: 'h'.repeat(48_001) }],
]) {
  test(`persisted read refuses oversized ${label} without altering the stored file`, async () => {
    const { dir, store } = storeIn('read-bound-')
    try {
      await store.save({ computerId: 'c', nodeId: 'n', record: RECORD })
      const file = path.join(store.directory, fs.readdirSync(store.directory)[0])
      const bytes = JSON.stringify({ computerId: 'c', nodeId: 'n', savedAt: 1, record })
      fs.writeFileSync(file, bytes)
      const answer = await store.get({ computerId: 'c', nodeId: 'n' })
      assert.equal(answer.ok, false)
      assert.equal(answer.error.code, 'RECOVERY_RECORD_TOO_LARGE')
      assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'read refusal must not delete, truncate or rewrite the checkpoint')
    } finally { discard(dir) }
  })
}

test('persisted malformed checkpoints refuse as unreadable and retain their original bytes', async () => {
  const { dir, store } = storeIn('read-malformed-')
  try {
    await store.save({ computerId: 'c', nodeId: 'n', record: RECORD })
    const file = path.join(store.directory, fs.readdirSync(store.directory)[0])
    for (const bytes of ['{', JSON.stringify({ computerId: 'c', nodeId: 'n', record: { handoff: 'missing version' } })]) {
      fs.writeFileSync(file, bytes)
      const answer = await store.get({ computerId: 'c', nodeId: 'n' })
      assert.equal(answer.error.code, 'RECOVERY_RECORD_UNREADABLE')
      assert.equal(fs.readFileSync(file, 'utf8'), bytes)
    }
  } finally { discard(dir) }
})

test('persisted file envelope is bounded before a large file is read or parsed', async () => {
  const { dir, store } = storeIn('read-envelope-')
  try {
    await store.save({ computerId: 'c', nodeId: 'n', record: RECORD })
    const file = path.join(store.directory, fs.readdirSync(store.directory)[0])
    const bytes = JSON.stringify({ computerId: 'c', nodeId: 'n', record: RECORD, junk: 'x'.repeat(2_000_000) })
    fs.writeFileSync(file, bytes)
    let reads = 0
    const io = { ...fs.promises, open: async (...args) => {
      const handle = await fs.promises.open(...args)
      return { stat: () => handle.stat(), close: () => handle.close(),
        read: (...readArgs) => { reads += 1; return handle.read(...readArgs) } }
    } }
    const reader = createNodeRecoveryStore({ directory: dir, io })
    const answer = await reader.get({ computerId: 'c', nodeId: 'n' })
    assert.equal(answer.error?.code, 'RECOVERY_RECORD_TOO_LARGE')
    assert.equal(reads, 0, 'an already oversized file must refuse on stat without reading its contents')
    assert.equal(fs.readFileSync(file, 'utf8'), bytes)
  } finally { discard(dir) }
})

test('retained legacy reads enforce the whole-record limit without deleting source data', async () => {
  const { createRecoveryPersistence } = require_('../../shell/node-recovery-store.cjs')
  const key = recoveryKey('c', 'n')
  const raw = JSON.stringify({ ...RECORD, extra: 'x'.repeat(65_536) })
  const prefs = fakePrefs({ [key]: raw })
  const service = createRecoveryPersistence({ prefs, store: { get: () => assert.fail('retained source must remain authoritative') } })
  const answer = await service.get({ computerId: 'c', nodeId: 'n' })
  assert.equal(answer.error?.code, 'RECOVERY_RECORD_TOO_LARGE')
  assert.equal(prefs.snapshot().values[key], raw)
})

test('bounded reads tolerate short reads and reject growth beyond the stat observation, closing the handle', async () => {
  const { MAX_FILE_BYTES } = require_('../../shell/node-recovery-store.cjs')
  let closed = 0, totalRead = 0
  const payload = Buffer.from(JSON.stringify({ computerId: 'c', nodeId: 'n', record: RECORD }))
  const grown = Buffer.concat([payload, Buffer.alloc(MAX_FILE_BYTES, 32)])
  const io = { open: async () => ({
    stat: async () => ({ isFile: () => true, size: payload.length }),
    read: async (buffer, offset, length, position) => {
      const bytesRead = Math.min(1024, length, grown.length - position)
      grown.copy(buffer, offset, position, position + bytesRead)
      totalRead += bytesRead
      return { bytesRead }
    },
    close: async () => { closed += 1 },
  }) }
  const reader = createNodeRecoveryStore({ directory: SCRATCH, io })
  const answer = await reader.get({ computerId: 'c', nodeId: 'n' })
  assert.equal(answer.error.code, 'RECOVERY_RECORD_TOO_LARGE')
  assert.equal(totalRead, MAX_FILE_BYTES + 1, 'a growing file cannot cause an unbounded allocation/read')
  assert.equal(closed, 1)
})

test('invalid UTF-8 is unreadable rather than silently repaired in a persisted checkpoint', async () => {
  const { dir, store } = storeIn('read-encoding-')
  try {
    await store.save({ computerId: 'c', nodeId: 'n', record: RECORD })
    const file = path.join(store.directory, fs.readdirSync(store.directory)[0])
    const bytes = Buffer.concat([Buffer.from('{"computerId":"c","nodeId":"n","record":{"v":1,"handoff":"'), Buffer.from([0xff]), Buffer.from('"}}')])
    fs.writeFileSync(file, bytes)
    assert.equal((await store.get({ computerId: 'c', nodeId: 'n' })).error.code, 'RECOVERY_RECORD_UNREADABLE')
    assert.deepEqual(fs.readFileSync(file), bytes)
  } finally { discard(dir) }
})

test('corrupt retained legacy values refuse without replacing, migrating or deleting their source', async () => {
  const { createRecoveryPersistence } = require_('../../shell/node-recovery-store.cjs')
  const key = recoveryKey('c', 'n')
  for (const raw of ['{', JSON.stringify({ v: 1, handoff: 42 }), JSON.stringify({ v: 2, handoff: 'unsupported version' })]) {
    const prefs = fakePrefs({ [key]: raw, 'mc.theme': 'black' })
    const before = prefs.snapshot()
    const service = createRecoveryPersistence({ prefs, store: {
      get: () => assert.fail('a corrupt retained source must not fall back to another checkpoint'),
      save: () => assert.fail('reading corrupt data must not migrate or replace it'),
    } })
    const answer = await service.get({ computerId: 'c', nodeId: 'n' })
    assert.equal(answer.ok, false)
    assert.equal(answer.error.code, 'RECOVERY_RECORD_UNREADABLE')
    assert.deepEqual(prefs.snapshot(), before)
    assert.deepEqual(prefs.removed, [])
  }
})
