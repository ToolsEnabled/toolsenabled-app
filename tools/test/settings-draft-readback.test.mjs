import assert from 'node:assert/strict'
import test from 'node:test'
import { createSettingsDraft, draftSettingsBridge } from '../../src/settings-draft.js'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture({ batch = false } = {}) {
  let values = { first: false, second: false }
  let heldRead = null, heldWrite = null, failAfterWrite = false
  const writes = []
  const snapshot = () => ({ ok: true, rows: Object.entries(values).map(([id, value]) => ({ id, value })) })
  const write = async changes => {
    if (heldWrite) { const wait = heldWrite; heldWrite = null; await wait.promise }
    values = { ...values, ...Object.fromEntries(changes.map(({ id, value }) => [id, value])) }
    writes.push(changes)
    if (failAfterWrite) { failAfterWrite = false; throw new Error('Reply lost after the write') }
    return changes.map(change => ({ ...change, ok: true }))
  }
  const shell = {
    read: async () => {
      if (heldRead) { const wait = heldRead; heldRead = null; return wait.promise }
      return snapshot()
    },
    set: async (id, value) => (await write([{ id, value }]))[0],
    ...(batch ? { setMany: async changes => ({ ok: true, results: await write(changes) }) } : {}),
  }
  const draft = createSettingsDraft()
  const bridge = draftSettingsBridge(shell, draft)
  return {
    draft, bridge, writes,
    holdRead() { heldRead = deferred(); return { ...heldRead, snapshot: snapshot() } },
    holdWrite() { heldWrite = deferred(); return heldWrite },
    failAfterWrite() { failAfterWrite = true },
    externalChange(next) { values = { ...values, ...next } },
    get values() { return { ...values } },
  }
}

for (const batch of [false, true]) test(`a stale pre-save read cannot discard a later correction after ${batch ? 'batch' : 'single'} Save`, async () => {
  const f = fixture({ batch })
  await f.bridge.read()
  const stale = f.holdRead(), reading = f.bridge.read()
  await f.bridge.set('first', true)
  if (batch) await f.bridge.set('second', true)
  await f.draft.save()
  assert.equal(f.values.first, true)
  stale.resolve(stale.snapshot)
  await reading
  await f.bridge.set('first', false)
  assert.equal(f.draft.dirty, true, 'the correction differs from the acknowledged stored value')
  await f.draft.save()
  assert.equal(f.values.first, false, 'the correction reaches persistence instead of being silently unstaged')
  assert.equal(f.writes.length, 2, 'each explicit Save writes once')
})

test('a read that overlaps a write returns the acknowledged value and preserves a successor draft', async () => {
  const f = fixture()
  await f.bridge.read()
  const write = f.holdWrite()
  await f.bridge.set('first', true)
  const saving = f.draft.save()
  const stale = f.holdRead(), reading = f.bridge.read()
  write.resolve()
  await saving
  await f.bridge.set('first', false)
  stale.resolve(stale.snapshot)
  const answer = await reading
  const row = answer.rows.find(row => row.id === 'first')
  assert.equal(row.savedValue, true, 'readback cannot publish the pre-write snapshot as the saved value')
  assert.equal(row.value, false, 'the current unsaved correction remains visible')
  assert.equal(row.pending, true)
  await f.draft.save()
  assert.equal(f.values.first, false)
})

test('an older read cannot replace a newer accepted snapshot from another settings controller', async () => {
  const f = fixture()
  await f.bridge.read()
  const stale = f.holdRead(), earlier = f.bridge.read()
  f.externalChange({ first: true })
  const newer = await f.bridge.read()
  assert.equal(newer.rows[0].savedValue, true)
  stale.resolve(stale.snapshot)
  const older = await earlier
  assert.equal(older.rows[0].savedValue, true)
  await f.bridge.set('first', false)
  assert.equal(f.draft.dirty, true)
  await f.draft.save()
  assert.equal(f.values.first, false)
})

test('a write with an unknown outcome invalidates pre-write reads without claiming save success', async () => {
  const f = fixture()
  await f.bridge.read()
  const stale = f.holdRead(), reading = f.bridge.read()
  await f.bridge.set('first', true)
  f.failAfterWrite()
  await assert.rejects(f.draft.save(), /Reply lost/)
  assert.equal(f.draft.dirty, true)
  assert.deepEqual(f.draft.saveResult.savedKeys, [])
  stale.resolve(stale.snapshot)
  await reading
  await f.bridge.set('first', false)
  assert.equal(f.draft.dirty, true, 'the old snapshot cannot erase the correction after an unknown write outcome')
  await f.draft.save()
  assert.equal(f.values.first, false)
})

test('an obsolete read rejection after Save cannot replace a fresh saved readback with an error', async () => {
  const f = fixture()
  await f.bridge.read()
  const stale = f.holdRead(), reading = f.bridge.read()
  await f.bridge.set('first', true)
  await f.draft.save()
  stale.reject(new Error('The old read disconnected'))
  const answer = await reading
  assert.equal(answer.ok, true)
  assert.equal(answer.rows[0].savedValue, true)
})

for (const reply of [undefined, null, {}, { ok: 'true' }]) test(`a missing or malformed single-write acknowledgement keeps the change pending (${JSON.stringify(reply)})`, async () => {
  const draft = createSettingsDraft()
  const bridge = draftSettingsBridge({ set: async () => reply }, draft)
  await bridge.set('first', true)
  await assert.rejects(draft.save(), /confirm|saved|acknowledge/i)
  assert.equal(draft.dirty, true)
  assert.deepEqual(draft.saveResult.savedKeys, [])
})

test('an ordinary current read failure stays a failure and confirmed refusals retain their reason', async () => {
  const draft = createSettingsDraft()
  const bridge = draftSettingsBridge({
    read: async () => { throw new Error('Current read unavailable') },
    set: async () => ({ ok: false, reason: 'The proposed value was refused' }),
  }, draft)
  await assert.rejects(bridge.read(), /Current read unavailable/)
  await bridge.set('first', true)
  await assert.rejects(draft.save(), /proposed value was refused/)
  assert.equal(draft.dirty, true)
})
