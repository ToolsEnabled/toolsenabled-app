import test from 'node:test'
import assert from 'node:assert/strict'
import { createSettingsDraft, draftSettingsBridge } from '../../src/settings-draft.js'

function fixture({ batch = false, firstReply = () => { throw Error('Reply lost after persistence') } } = {}) {
  const stored = { first: false, second: false, untouched: false }
  const writes = []
  const persist = async changes => {
    writes.push(changes)
    for (const { id, value } of changes) stored[id] = value
    const replies = changes.map(change => ({ ...change, ok: true }))
    if (writes.length === 1) return firstReply(replies)
    return batch && changes.length > 1 ? { ok: true, results: replies } : replies[0]
  }
  const draft = createSettingsDraft()
  const bridge = draftSettingsBridge({
    read: async () => ({ ok: true, rows: Object.entries(stored).map(([id, value]) => ({ id, value })) }),
    set: async (id, value) => persist([{ id, value }]),
    ...(batch ? { setMany: async changes => {
      const answer = await persist(changes)
      return answer
    } } : {}),
  }, draft)
  return { stored, writes, draft, bridge }
}

for (const batch of [false, true]) test(`${batch ? 'batch' : 'single'} lost reply cannot discard an explicit correction before any readback`, async () => {
  const f = fixture({ batch })
  await f.bridge.read()
  await f.bridge.set('first', true)
  if (batch) await f.bridge.set('second', true)
  await assert.rejects(f.draft.save(), /Reply lost/)
  assert.equal(f.stored.first, true)
  assert.deepEqual(f.draft.saveResult.savedKeys, [])
  await f.bridge.set('first', false)
  assert.equal(f.draft.has('product:first'), true, 'An unknown stored value cannot compare equal to the former cached value')
  await f.bridge.set('untouched', false)
  assert.equal(f.draft.has('product:untouched'), false, 'Unattempted keys retain their established comparison values')
  await f.draft.save()
  assert.equal(f.stored.first, false)
  assert.equal(f.writes.length, 2)
})

for (const reply of [undefined, null, {}, { ok: 'true' }]) test(`an unacknowledged single write keeps an immediate old-value correction (${JSON.stringify(reply)})`, async () => {
  const f = fixture({ firstReply: () => reply })
  await f.bridge.read()
  await f.bridge.set('first', true)
  await assert.rejects(f.draft.save(), /confirm|saved/i)
  assert.equal(f.stored.first, true)
  await f.bridge.set('first', false)
  assert.equal(f.draft.has('product:first'), true)
  await f.draft.save()
  assert.equal(f.stored.first, false)
})

test('a valid batch success prefix stays acknowledged while the missing suffix loses its stale comparison', async () => {
  const f = fixture({ batch: true, firstReply: replies => ({ ok: false, results: replies.slice(0, 1), reason: 'Remaining reply lost' }) })
  await f.bridge.read()
  await f.bridge.set('first', true)
  await f.bridge.set('second', true)
  await assert.rejects(f.draft.save(), /Remaining reply lost/)
  assert.deepEqual(f.draft.saveResult.savedKeys, ['product:first'])
  assert.equal(f.draft.has('product:first'), false)
  await f.bridge.set('first', true)
  assert.equal(f.draft.has('product:first'), false, 'A confirmed prefix is not unnecessarily staged again')
  await f.bridge.set('second', false)
  assert.equal(f.draft.has('product:second'), true)
  await f.draft.save()
  assert.deepEqual(f.writes[1], [{ id: 'second', value: false }])
  assert.deepEqual(f.stored, { first: true, second: false, untouched: false })
})

for (const corrupt of [
  replies => [...replies].reverse(),
  replies => [replies[0], { ...replies[1], ok: 'true' }],
]) test(`a malformed batch acknowledgement cannot discard corrected values (${corrupt.toString()})`, async () => {
  const f = fixture({ batch: true, firstReply: replies => ({ ok: true, results: corrupt(replies) }) })
  await f.bridge.read()
  await f.bridge.set('first', true)
  await f.bridge.set('second', true)
  await assert.rejects(f.draft.save(), /identify.*saved/)
  assert.deepEqual(f.draft.saveResult.savedKeys, [])
  for (const id of ['first', 'second']) {
    await f.bridge.set(id, false)
    assert.equal(f.draft.has(`product:${id}`), true)
  }
  await f.draft.save()
  assert.deepEqual(f.stored, { first: false, second: false, untouched: false })
})

test('a cancelled confirmation does not invalidate a key that was never attempted', async () => {
  const draft = createSettingsDraft()
  let calls = 0
  const bridge = draftSettingsBridge({ read: async () => ({ ok: true, rows: [{ id: 'first', value: false }] }),
    set: async () => { calls++; return { ok: true } } }, draft,
  { confirmWrite: async () => { throw Error('Confirmation cancelled') } })
  await bridge.read()
  await bridge.set('first', true)
  await assert.rejects(draft.save(), /Confirmation cancelled/)
  await bridge.set('first', false)
  assert.equal(draft.dirty, false)
  assert.equal(calls, 0)
})

test('generic legacy draft writers can still acknowledge by returning void', async () => {
  const draft = createSettingsDraft()
  let stored = false
  draft.stage('legacy:first', true, value => { stored = value })
  assert.equal(await draft.save(), true)
  assert.equal(stored, true)
  assert.equal(draft.dirty, false)
  assert.deepEqual(draft.saveResult.savedKeys, ['legacy:first'])
})
