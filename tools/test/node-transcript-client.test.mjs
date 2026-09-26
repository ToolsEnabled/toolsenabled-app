/* MEASURED: agent.restart refused four different
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

import { createNodeTranscriptClient, IMPORT_OLDER_LEFT_TEXT } from '../../src/node-transcript-client.js'

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

/* B4 step 10 (1.0.48): a New agent tab placed on a tree before it ever sent carries the
   conversation it was reopened with into the new circle's record. save() cannot do that: with a
   capture bridge it writes only action lines, because the capture writes speech. importEntries
   writes every spoken and action line with its own id, in order, and shows them at once. It never
   copies the seat's file locators, which name the seat's folder, not the circle's. */
test('importEntries writes the restored speech and actions durably, in order, and shows them at once (B4)', async () => {
  const bridge = fakeBridge()
  bridge.bind = async () => ({ ok: true })
  const appended = []
  const append = bridge.append
  bridge.append = async request => { appended.push(structuredClone(request)); return append(request) }
  const client = createNodeTranscriptClient({ computerId: 'c1', bridge })
  await client.ready
  const lines = [
    { id: 'you:1', who: 'you', text: 'remember KIWI', at: 1, recoveryFiles: ['/seat/0001.json'] },
    { id: 'note:1', who: 'note', text: 'Reopened after ToolsEnabled restarted.', at: 2 },
    { who: 'agent', text: 'no id, so it cannot be written idempotently', at: 3 },
    { id: 'agent:1', who: 'agent', text: 'I will remember KIWI.', at: 4 },
    { id: 'action:1', who: 'action', text: 'ls', kind: 'command', at: 5 },
  ]
  assert.equal(typeof client.importEntries, 'function', 'THE DEFECT: there is no way to give a new circle the restored conversation')
  await client.importEntries('node-1', lines)
  const written = appended.flatMap(request => request.nodeId === 'node-1' ? request.entries : [])
  assert.deepEqual(written.map(entry => entry.id), ['you:1', 'agent:1', 'action:1'])
  assert.equal(written.some(entry => 'recoveryFiles' in entry), false, 'the seat folder\'s file locators were copied into the circle')
  assert.deepEqual(client.get('node-1')?.lines.map(line => line.id), ['you:1', 'agent:1', 'action:1'])
  assert.equal(client.has('node-1'), true)
  client.dispose()
})

/* B4 review (1.0.48), D1: the context ToolsEnabled added to a tab's first turn (standing rules,
   tools, role, an earlier handoff) is saved from the person's side with promptSource
   'toolsenabled'. A circle with no session draws its saved lines as they are, so copying those
   rows into the circle made them the person's words there. The circle's own sessions add their
   own context when they start, so the import leaves them behind. */
test('importEntries leaves out the context ToolsEnabled added to the tab (B4 review D1)', async () => {
  const bridge = fakeBridge()
  const appended = []
  const append = bridge.append
  bridge.append = async request => { appended.push(structuredClone(request)); return append(request) }
  const client = createNodeTranscriptClient({ computerId: 'c1', bridge })
  await client.ready
  await client.importEntries('node-1', [
    { id: 'you:1', who: 'you', text: 'remember KIWI', at: 1 },
    { id: 'context:1', who: 'you', text: 'Standing rules for this computer.', promptSource: 'toolsenabled', promptKind: 'requests', at: 1 },
    { id: 'context:2', who: 'you', text: 'You are a worker.', promptSource: 'toolsenabled', promptKind: 'role', at: 1 },
    { id: 'agent:1', who: 'agent', text: 'I will remember KIWI.', at: 2 },
  ])
  const written = appended.flatMap(request => request.nodeId === 'node-1' ? request.entries : [])
  assert.deepEqual(written.map(entry => entry.id), ['you:1', 'agent:1'], 'context ToolsEnabled added was written as the person\'s words')
  assert.deepEqual(client.get('node-1')?.lines.map(line => line.id), ['you:1', 'agent:1'])
  client.dispose()
})

/* A stand-in with the real store's paging: entries in write order per node, a page is the newest
   `limit` before the cursor, and `before` names the first entry of the page when older ones exist.
   strictBefore refuses a cursor the node does not hold, as shell/node-transcript-store.cjs does. */
function pagedBridge(nodes = {}) {
  const store = new Map(Object.entries(nodes).map(([nodeId, entries]) => [nodeId, entries.map(entry => ({ ...entry }))]))
  const reads = []
  return {
    reads,
    store,
    async list() { return { ok: true, records: [] } },
    async read({ nodeId, before = null, limit = 60, strictBefore = false }) {
      reads.push({ nodeId, before, limit, strictBefore })
      const entries = store.get(nodeId) || []
      const cursor = before ? entries.findIndex(entry => entry.id === before) : -1
      if (strictBefore && before && cursor < 0) return { ok: false, error: { code: 'MC_AGENT_TRANSCRIPT_CURSOR_INVALID', message: 'cursor' } }
      const files = cursor >= 0 ? entries.slice(0, cursor) : entries
      const page = files.slice(-Math.min(100, limit))
      return { ok: true, metadata: store.has(nodeId) ? { nodeId } : null, entries: page,
        before: files.length > page.length ? page[0].id : null, recoveryDirectory: `/saved/${nodeId}` }
    },
    async append({ nodeId, entries }) {
      const held = store.get(nodeId) || []
      for (const entry of entries) held.push({ ...entry })
      store.set(nodeId, held)
      return { ok: true }
    },
  }
}
const line = n => ({ id: `e${String(n).padStart(4, '0')}`, who: n % 2 ? 'agent' : 'you', text: `line ${n}`, at: n })

/* D4: the tab showed only the newest page of its conversation (readLatest reads 60 lines). Adding it
   to a tree copied only that page and dropped the cursor to the older ones, so a longer
   conversation reached the circle cut short, with nothing saying older messages exist and nothing
   for its Resume to point at. The rest is read from the seat before the import writes. */
test('importEntries carries the tab\'s older pages too, in order, and the circle keeps its own cursor (B4 review D4)', async () => {
  const seat = Array.from({ length: 150 }, (_, n) => line(n))
  const bridge = pagedBridge({ 'seat-1': seat })
  const client = createNodeTranscriptClient({ computerId: 'c1', bridge })
  await client.ready
  const newest = seat.slice(-60)
  const answer = await client.importEntries('node-1', newest, { from: 'seat-1', before: newest[0].id })
  assert.deepEqual((bridge.store.get('node-1') || []).map(entry => entry.id), seat.map(entry => entry.id),
    'THE DEFECT: the circle holds only the page the tab showed')
  assert.equal(answer.ok, true)
  assert.equal(bridge.reads.filter(read => read.nodeId === 'seat-1').every(read => read.strictBefore === true), true,
    'a stale cursor could read the newest page twice')
  const record = client.get('node-1')
  assert.equal(typeof record?.before === 'string' && record.before.length > 0, true,
    'the circle\'s record does not say older messages exist')
  assert.deepEqual(record.lines.map(entry => entry.id), seat.slice(-60).map(entry => entry.id))
  client.dispose()
})

test('importEntries stops at its bound and says older lines were left under the tab (B4 review D4)', async () => {
  const { IMPORT_LIMIT } = await import('../../src/node-transcript-client.js')
  const seat = Array.from({ length: IMPORT_LIMIT + 150 }, (_, n) => line(n))
  const bridge = pagedBridge({ 'seat-1': seat })
  const client = createNodeTranscriptClient({ computerId: 'c1', bridge })
  await client.ready
  const newest = seat.slice(-60)
  const answer = await client.importEntries('node-1', newest, { from: 'seat-1', before: newest[0].id })
  const written = (bridge.store.get('node-1') || []).map(entry => entry.id)
  assert.equal(written.length, IMPORT_LIMIT + 1)
  assert.deepEqual(written.slice(1), seat.slice(-IMPORT_LIMIT).map(entry => entry.id), 'the bound kept the wrong lines, or out of order')
  assert.equal(answer.olderLeft, true)
  // What was left behind is said once, at the top of what came over (B4 verify).
  const marker = bridge.store.get('node-1')[0]
  assert.equal(marker.who, 'action')
  assert.equal(marker.text, IMPORT_OLDER_LEFT_TEXT)
  client.dispose()
})

/* B4 verify: the bound counted every line, so a conversation of one request, 2400 actions and one
   reply reached the circle as 2000 actions and the reply: the person's request was gone and nothing
   said so. Actions have their own bound now and never push speech out. */
test('importEntries never lets actions push the person\'s words out, and says when anything was left (B4 verify)', async () => {
  const { IMPORT_ACTION_LIMIT } = await import('../../src/node-transcript-client.js')
  const request = { id: 'r0000', who: 'you', text: 'drive the robot to the dock', at: 0 }
  const actions = Array.from({ length: 2400 }, (_, n) => ({ id: `a${String(n).padStart(5, '0')}`, who: 'action', text: `step ${n}`, at: n + 1 }))
  const reply = { id: 'z9999', who: 'agent', text: 'Docked.', at: 99999 }
  const seat = [request, ...actions, reply]
  const bridge = pagedBridge({ 'seat-1': seat })
  const client = createNodeTranscriptClient({ computerId: 'c1', bridge })
  await client.ready
  const newest = seat.slice(-60)
  const answer = await client.importEntries('node-1', newest, { from: 'seat-1', before: newest[0].id })
  const written = (bridge.store.get('node-1') || []).map(entry => entry.id)
  assert.equal(written.includes('r0000'), true, 'THE DEFECT: the person\'s request did not reach the circle')
  assert.deepEqual(written, seat.map(entry => entry.id), 'nothing was over a bound, so everything comes over, in order')
  assert.equal(answer.olderLeft, undefined)
  // Past the action bound, the oldest actions are left, the request still comes, and it is said.
  const many = [request, ...Array.from({ length: IMPORT_ACTION_LIMIT + 500 }, (_, n) => ({ id: `b${String(n).padStart(5, '0')}`, who: 'action', text: `step ${n}`, at: n + 1 })), reply]
  const bridge2 = pagedBridge({ 'seat-2': many })
  const client2 = createNodeTranscriptClient({ computerId: 'c1', bridge: bridge2 })
  await client2.ready
  const newest2 = many.slice(-60)
  const answer2 = await client2.importEntries('node-2', newest2, { from: 'seat-2', before: newest2[0].id })
  const written2 = bridge2.store.get('node-2') || []
  assert.equal(written2[0].text, IMPORT_OLDER_LEFT_TEXT, 'what was left behind is not said')
  assert.equal(written2[1].id, 'r0000', 'the request is kept ahead of the actions')
  assert.equal(written2.filter(entry => entry.who === 'action').length, IMPORT_ACTION_LIMIT + 1)
  assert.equal(answer2.olderLeft, true)
  client.dispose(); client2.dispose()
})
