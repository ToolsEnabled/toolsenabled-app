/* MEASURED, Controller 2026-09-06: agent.restart refused four different
 * circles with MC_TREE_COMMAND_TRANSCRIPT_RESET_FAILED. Half of that defect
 * was fresh-start-existing-node.js reading an async remove() synchronously
 * (tools/test/tree-node-command-fresh-start-behavior.test.mjs pins that half);
 * the other half is here. This client's own remove() used to roll back only
 * the single cached last line -- "Compatibility for the empty failed-send
 * rollback" -- and even that resolved to a Promise, never the literal `true`
 * fresh-start-existing-node.js checked for. A caller that actually awaited it
 * would still have left every older line on disk, silently, because the
 * cache this client keeps is bounded to the last 60 lines while
 * shell/node-transcript-store.cjs's backing files are not.
 *
 * remove() must now clear the WHOLE node -- every page the backing store
 * holds, not just what this client has cached -- and resolve `true` on
 * success, matching src/session-transcript-store.js's own remove() contract
 * that fresh-start-existing-node.js was written against.
 *
 *   node --test tools/test/node-transcript-client.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { createNodeTranscriptClient } from '../../src/node-transcript-client.js'

/* A minimal stand-in for shell/node-transcript-store.cjs's own read/rollback
   pair: read() serves whatever has not yet been rolled back, newest-page
   first, and rollback() actually deletes -- exactly like the real file-backed
   store unlinking a node's entry files. */
function fakeBridge({ entries = [] } = {}) {
  const store = new Map(entries.map(entry => [entry.id, entry]))
  const rollbackCalls = []
  const readCalls = []
  return {
    calls: { rollback: rollbackCalls, read: readCalls },
    async list() { return { ok: true, records: [] } },
    async read({ limit = 60 }) {
      readCalls.push(limit)
      const remaining = [...store.values()]
      return { ok: true, metadata: {}, entries: remaining.slice(-limit), before: null, count: remaining.length }
    },
    async rollback({ entryId }) {
      rollbackCalls.push(entryId)
      store.delete(entryId)
      return { ok: true }
    },
    async append({ entries: written }) {
      for (const entry of written) store.set(entry.id, entry)
      return { ok: true }
    },
  }
}

test('remove() drains every page the backing store holds, not only the cached tail', async () => {
  const entries = Array.from({ length: 5 }, (_, index) => ({ id: `line-${index}`, who: 'agent', text: `t${index}`, at: index }))
  const bridge = fakeBridge({ entries })
  const client = createNodeTranscriptClient({ computerId: 'c1', bridge })
  await client.ready

  // The backing store is drained two entries at a time, well under its total
  // size, so a single page could never be mistaken for the whole history.
  const originalRead = bridge.read
  bridge.read = request => originalRead({ ...request, limit: 2 })

  const removed = await client.remove('node-1')

  assert.equal(removed, true, 'remove() must resolve the literal true fresh-start-existing-node.js checks for')
  assert.deepEqual(new Set(bridge.calls.rollback), new Set(entries.map(entry => entry.id)),
    'every entry must be rolled back, including the ones outside the first page')
  assert.equal((await bridge.read({ limit: 100 })).entries.length, 0, 'nothing is left in the backing store')
})

test('remove() clears the node from the live cache so get()/has() stop answering with stale lines', async () => {
  const bridge = fakeBridge({ entries: [{ id: 'line-0', who: 'agent', text: 'hi', at: 0 }] })
  const client = createNodeTranscriptClient({ computerId: 'c1', bridge })
  await client.ready
  await client.save('node-1', { lines: [{ who: 'agent', text: 'hi' }] })
  assert.equal(client.has('node-1'), true)

  await client.remove('node-1')

  assert.equal(client.has('node-1'), false)
  assert.equal(client.get('node-1'), null)
})

test('remove() on a node with no history is a no-op success, not a failure', async () => {
  const bridge = fakeBridge({ entries: [] })
  const client = createNodeTranscriptClient({ computerId: 'c1', bridge })
  await client.ready

  assert.equal(await client.remove('never-had-one'), true)
  assert.deepEqual(bridge.calls.rollback, [])
})


for (const change of ['newer-read', 'save', 'remove']) {
  test(`a delayed latest-history read cannot replace ${change} in the cache`, async () => {
    const bridge = fakeBridge()
    const client = createNodeTranscriptClient({ computerId: 'c1', bridge })
    await client.ready
    let resolveOld
    const ordinaryRead = bridge.read
    bridge.read = () => new Promise(resolve => { resolveOld = resolve })
    const pending = client.readLatest('node-1')
    while (!resolveOld) await Promise.resolve()
    bridge.read = ordinaryRead
    if (change === 'newer-read') {
      bridge.read = async () => ({ ok: true, metadata: {}, entries: [{ id: 'new', who: 'agent', text: 'NEW' }] })
      await client.readLatest('node-1')
    } else if (change === 'save') await client.save('node-1', { lines: [{ id: 'new', who: 'agent', text: 'NEW' }] })
    else await client.remove('node-1')
    resolveOld({ ok: true, metadata: {}, entries: [{ id: 'old', who: 'agent', text: 'OLD' }] })
    await pending
    assert.deepEqual(client.get('node-1')?.lines.map(line => line.text) || [], change === 'remove' ? [] : ['NEW'])
    client.dispose()
  })
}
