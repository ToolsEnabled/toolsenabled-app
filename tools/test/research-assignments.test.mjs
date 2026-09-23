import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import {
  ASSIGNMENTS_READ_UNAVAILABLE,
  ASSIGNMENTS_ROW_KEY,
  createAssignmentStore,
  parseAssignmentsRow,
  serializeAssignmentsRow,
} from '../../src/research-assignments.js'

/* Assignment: the service's table is the truth, this row is the cache and the
   outbox. A write the service did not hear stays pending WITH its sentence. */

function memoryStorage() {
  const map = new Map()
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: key => { map.delete(key) },
  }
}


function heardReceipt(_action, { projectId, assign = [], unassign = [] }) {
  return { ok: true, receipt: { projectId,
    assigned: assign.map(row => ({ ...row, ref: row.kind === 'all' ? '*' : row.ref,
      assignmentId: `ra-${projectId}-${row.kind}` })),
    unassigned: unassign.map(row => ({ ...row, projectId })),
  } }
}

test('the row parses defensively and absence is empty, not damaged', () => {
  assert.deepEqual(parseAssignmentsRow(null), { rows: [], removals: [], damaged: false })
  assert.equal(parseAssignmentsRow('{broken').damaged, true)
  assert.equal(parseAssignmentsRow('{"v":2,"rows":[]}').damaged, true)
  const parsed = parseAssignmentsRow(JSON.stringify({
    v: 1,
    rows: [
      { projectId: 'rp-1', kind: 'launch', ref: 'launch_1', pending: false },
      { projectId: 'rp-1', kind: 'nonsense', ref: 'x' },
      { projectId: 'rp-1', kind: 'all', ref: '*', pending: true },
    ],
  }))
  assert.equal(parsed.rows.length, 2, 'the unknown kind is dropped on read')
  assert.equal(serializeAssignmentsRow([]), null, 'an empty store stores nothing')
})

test('a storage read failure is neither absence nor cached, while real absence is cached', () => {
  let recoveringReads = 0
  const recovering = createAssignmentStore({
    storage: {
      getItem() {
        recoveringReads += 1
        if (recoveringReads === 1) throw Object.assign(new Error('file table busy'), { code: 'EMFILE' })
        return JSON.stringify({ v: 1, rows: [{ projectId: 'rp-kept', kind: 'launch', ref: 'launch_kept' }] })
      },
    },
  })
  assert.deepEqual(recovering.projectsOfSession('launch', 'launch_kept'), ['rp-kept'],
    'the failed constructor read is retried rather than latched as an empty assignment cache')
  assert.equal(recoveringReads, 2)

  const unavailable = createAssignmentStore({ storage: { getItem() { throw 'temporarily busy' } } })
  assert.throws(
    () => unavailable.snapshot(),
    error => error.code === ASSIGNMENTS_READ_UNAVAILABLE
      && /not claiming that no assignments exist/.test(error.message),
    'a non-Error throw with no code gets an explicit could-not-read result, not empty rows',
  )

  let absentReads = 0
  const absent = createAssignmentStore({ storage: { getItem() { absentReads += 1; return null } } })
  assert.deepEqual(absent.snapshot().rows, [])
  assert.deepEqual(absent.snapshot().rows, [])
  assert.equal(absentReads, 1, 'CONTROL: genuine absence remains cached for the life of the store')
})

test('an assignment the service heard settles; one it did not stays pending with the sentence', async () => {
  const storage = memoryStorage()
  let serviceUp = false
  const store = createAssignmentStore({
    storage,
    postAction: async (action, body) => serviceUp ? heardReceipt(action, body) : { ok: false, reason: 'bridge down' },
  })

  const offline = await store.assign('rp-1', 'launch', 'launch_abc')
  assert.equal(offline.ok, true)
  assert.equal(offline.pending, true)
  assert.equal(offline.sentence, 'Saved in this browser; the research service has not heard it yet and will on the next visit.')
  assert.equal(store.snapshot().rows[0].pending, true)

  serviceUp = true
  const flushed = await store.flushPending()
  assert.equal(flushed.accepted, 1)
  assert.equal(flushed.remaining, 0)
  assert.equal(store.snapshot().rows[0].pending, false)

  const online = await store.assign('rp-1', 'all')
  assert.equal(online.ok, true)
  assert.equal(online.pending, undefined)
  assert.equal(store.snapshot().rows.find(row => row.kind === 'all').ref, '*')
})

test('an unheard removal identifies the browser-resident outbox', async () => {
  const store = createAssignmentStore({ storage: memoryStorage(), postAction: async () => ({ ok: false, reason: 'down' }) })
  store.adoptServiceRows([{ projectId: 'rp-1', kind: 'launch', ref: 'launch_abc', assignmentId: 'ra-original' }])

  const offline = await store.unassign('rp-1', 'launch', 'launch_abc')

  assert.equal(offline.sentence, 'Removal saved in this browser; the research service has not confirmed it yet. This browser will retry when the service is available.')
  assert.equal(store.snapshot().removals.length, 1)
})

test('projectsOfSession unions explicit rows with the all rule', async () => {
  const store = createAssignmentStore({ storage: memoryStorage(), postAction: heardReceipt })
  await store.assign('rp-1', 'launch', 'launch_abc')
  await store.assign('rp-2', 'all')
  assert.deepEqual(store.projectsOfSession('launch', 'launch_abc').sort(), ['rp-1', 'rp-2'])
  assert.deepEqual(store.projectsOfSession('observed', 'never-assigned'), ['rp-2'], 'the all rule covers sessions assigned to nothing')
  await store.unassign('rp-2', 'all')
  assert.deepEqual(store.projectsOfSession('observed', 'never-assigned'), [])
})

test('adopting the service rows keeps unheard local writes', async () => {
  const store = createAssignmentStore({ storage: memoryStorage(), postAction: async () => ({ ok: false, reason: 'down' }) })
  await store.assign('rp-9', 'launch', 'launch_local_only')
  store.adoptServiceRows([
    { projectId: 'rp-1', kind: 'launch', ref: 'launch_service', active: true },
    { projectId: 'rp-1', kind: 'presence', ref: 'old:run', active: false },
  ])
  const rows = store.snapshot().rows
  assert.equal(rows.some(row => row.ref === 'launch_service' && !row.pending), true)
  assert.equal(rows.some(row => row.ref === 'old:run'), false, 'inactive service rows are history, not cache')
  assert.equal(rows.some(row => row.ref === 'launch_local_only' && row.pending), true, 'the outbox survives adoption')
})

test('a duplicate assignment says so instead of writing twice', async () => {
  const store = createAssignmentStore({ storage: memoryStorage(), postAction: heardReceipt })
  await store.assign('rp-1', 'launch', 'launch_abc')
  const again = await store.assign('rp-1', 'launch', 'launch_abc')
  assert.equal(again.alreadyAssigned, true)
  assert.equal(store.snapshot().rows.length, 1)
})

function fixture() {
  const local = new Map()
  const storage = { getItem: key => local.get(key) ?? null,
    setItem: (key, value) => local.set(key, String(value)), removeItem: key => local.delete(key) }
  const membership = { assignmentId: 'ra-original', projectId: 'rp-fixture', kind: 'observed', ref: 'session-fixture', active: true }
  const service = new Map([[membership.assignmentId, { ...membership }]])
  const calls = []
  let online = true
  const postAction = async (action, body) => {
    calls.push({ action, body: structuredClone(body), online })
    assert.equal(action, 'research-session-assign')
    assert.deepEqual(body.assign, [])
    if (!online) return { ok: false, code: 'BRIDGE_UNREACHABLE', reason: 'Owned synthetic bridge unavailable' }
    const unassigned = []
    for (const removal of body.unassign) {
      const match = [...service.values()].find(row => row.projectId === body.projectId
        && (removal.assignmentId ? removal.assignmentId === row.assignmentId : removal.kind === row.kind && removal.ref === row.ref))
      if (!match) return { ok: false, code: 'RESEARCH_ASSIGNMENT_NOT_FOUND', reason: 'No active assignment matches.' }
      service.delete(match.assignmentId); unassigned.push({ ...match })
    }
    return { ok: true, receipt: { projectId: body.projectId, assigned: [], unassigned } }
  }
  const open = () => createAssignmentStore({ storage, postAction })
  return { open, local, service, calls, membership, setOnline(value) { online = value }, snapshot: () => [...service.values()].map(row => ({ ...row })) }
}

test('a browser-kept removal reaches the service after store recreation and ordinary adopt-then-flush', async () => {
  const f = fixture(), first = f.open()
  first.adoptServiceRows(f.snapshot())
  f.setOnline(false)
  const reply = await first.unassign(f.membership.projectId, f.membership.kind, f.membership.ref)
  assert.equal(reply.ok, true)
  assert.equal(reply.pending, true)
  const reopened = f.open()
  reopened.adoptServiceRows(f.snapshot())
  f.setOnline(true)
  const flushed = await reopened.flushPending()
  assert.equal(f.service.size, 0, 'the promised removal was lost across the next visit')
  assert.equal(flushed.remaining, 0)
  assert.deepEqual(reopened.projectsOfSession(f.membership.kind, f.membership.ref), [])
})

test('a repeated unavailable refresh cannot resurrect a membership whose removal is still queued', async () => {
  const f = fixture(), first = f.open()
  first.adoptServiceRows(f.snapshot())
  f.setOnline(false)
  await first.unassign(f.membership.projectId, f.membership.kind, f.membership.ref)
  const reopened = f.open()
  reopened.adoptServiceRows(f.snapshot())
  const flushed = await reopened.flushPending()
  assert.equal(flushed.remaining, 1, 'one browser-kept removal still needs delivery')
  assert.deepEqual(reopened.projectsOfSession(f.membership.kind, f.membership.ref), [], 'service adoption must not undo the pending removal intent')
  assert.equal(f.service.size, 1, 'CONTROL: the unavailable service has not applied the removal')
})

test('an ordinary acknowledged removal leaves no pending work', async () => {
  const f = fixture(), first = f.open()
  first.adoptServiceRows(f.snapshot())
  const reply = await first.unassign(f.membership.projectId, f.membership.kind, f.membership.ref)
  assert.equal(reply.ok, true)
  assert.notEqual(reply.pending, true)
  assert.equal(f.service.size, 0)
  const reopened = f.open(); reopened.adoptServiceRows(f.snapshot())
  assert.deepEqual(await reopened.flushPending(), { accepted: 0, remaining: 0 })
  assert.deepEqual(reopened.projectsOfSession(f.membership.kind, f.membership.ref), [])
})


test('the v1 cache retains assignment identity and round-trips a separate removal intent', () => {
  const row = { projectId: 'rp-1', kind: 'observed', ref: ' session:Case ', assignmentId: 'ra-1', pending: false }
  const removal = { projectId: 'rp-2', kind: 'all', ref: '*', assignmentId: 'ra-2', operationId: 'op-2' }
  const parsed = parseAssignmentsRow(serializeAssignmentsRow([row], [removal]))
  assert.deepEqual(parsed.rows, [row])
  assert.deepEqual(parsed.removals, [removal])
  assert.equal(parsed.damaged, false)
  assert.equal(parseAssignmentsRow(serializeAssignmentsRow([], [removal])).removals.length, 1)
})

test('an exact old-generation not-found settles its removal while preserving a successor assignment', async () => {
  const f = fixture(), first = f.open()
  first.adoptServiceRows(f.snapshot()); f.setOnline(false)
  await first.unassign(f.membership.projectId, f.membership.kind, f.membership.ref)
  f.service.clear()
  const successor = { ...f.membership, assignmentId: 'ra-successor' }
  f.service.set(successor.assignmentId, successor)
  const next = f.open(); next.adoptServiceRows(f.snapshot()); f.setOnline(true)
  const result = await next.flushPending()
  assert.equal(result.remaining, 0)
  assert.equal(f.service.has('ra-successor'), true)
  assert.equal(next.snapshot().rows[0].assignmentId, 'ra-successor')
  assert.deepEqual(next.projectsOfSession(successor.kind, successor.ref), [successor.projectId])
  assert.equal(f.calls.at(-1).body.unassign[0].assignmentId, 'ra-original')
  assert.equal(f.calls.at(-1).body.projectId, successor.projectId)
})

test('late old-view confirmation preserves a successor view’s unrelated pending operation', async () => {
  const storage = memoryStorage()
  let release
  const old = createAssignmentStore({ storage, postAction: () => new Promise(resolve => { release = resolve }) })
  const original = { projectId: 'rp-1', kind: 'observed', ref: 'session-1', assignmentId: 'ra-old' }
  old.adoptServiceRows([original])
  const removing = old.unassign(original.projectId, original.kind, original.ref)
  const next = createAssignmentStore({ storage, postAction: async () => ({ ok: false, code: 'BRIDGE_UNREACHABLE' }) })
  await next.assign('rp-next', 'observed', 'session-next')
  release({ ok: true, receipt: { projectId: 'rp-1', assigned: [], unassigned: [original] } })
  assert.equal((await removing).ok, true)
  const reopened = createAssignmentStore({ storage })
  assert.deepEqual(reopened.snapshot().rows.map(row => [row.projectId, row.ref, row.pending]), [['rp-next', 'session-next', true]])
  assert.equal(reopened.snapshot().removals.length, 0)
})

test('a stale confirmation cannot retire a newer removal operation for the same logical reference', async () => {
  const storage = memoryStorage()
  let release
  const old = createAssignmentStore({ storage, postAction: () => new Promise(resolve => { release = resolve }) })
  const original = { projectId: 'rp-1', kind: 'observed', ref: 'session-1', assignmentId: 'ra-old' }
  old.adoptServiceRows([original])
  const removing = old.unassign(original.projectId, original.kind, original.ref)
  const next = createAssignmentStore({ storage, postAction: async () => ({ ok: false, code: 'BRIDGE_UNREACHABLE' }) })
  const successor = { ...original, assignmentId: 'ra-next' }
  next.adoptServiceRows([successor])
  await next.unassign(successor.projectId, successor.kind, successor.ref)
  release({ ok: true, receipt: { projectId: 'rp-1', assigned: [], unassigned: [original] } })
  await removing
  const reopened = createAssignmentStore({ storage })
  assert.deepEqual(reopened.snapshot().removals.map(row => row.assignmentId), ['ra-next'])
})

for (const [name, response] of [
  ['generic missing-resource reply', { ok: false, code: 'RESEARCH_PROJECT_NOT_FOUND' }],
  ['current policy refusal', { ok: false, code: 'BRIDGE_GUARD_REFUSED' }],
  ['unknown transport outcome', { ok: false, code: 'BRIDGE_TIMEOUT' }],
  ['missing removal receipt', { ok: true }],
  ['wrong generation receipt', { ok: true, receipt: { projectId: 'rp-1', assigned: [], unassigned: [{ projectId: 'rp-1', kind: 'observed', ref: 'session-1', assignmentId: 'ra-other' }] } }],
]) test(`${name} keeps the exact removal pending even across an empty adopted snapshot`, async () => {
  const storage = memoryStorage(), calls = []
  const postAction = async (_action, body) => { calls.push(body); return response }
  const store = createAssignmentStore({ storage, postAction })
  store.adoptServiceRows([{ projectId: 'rp-1', kind: 'observed', ref: 'session-1', assignmentId: 'ra-original' }])
  assert.equal((await store.unassign('rp-1', 'observed', 'session-1')).pending, true)
  const reopened = createAssignmentStore({ storage, postAction })
  reopened.adoptServiceRows([])
  assert.equal((await reopened.flushPending()).remaining, 1)
  assert.equal(reopened.snapshot().removals[0].assignmentId, 'ra-original')
  assert.ok(calls.every(body => body.projectId === 'rp-1' && body.assign.length === 0
    && body.unassign.length === 1 && body.unassign[0].assignmentId === 'ra-original'))
})

test('a legacy row with no service identity refuses removal without sending a broad retry', async () => {
  const storage = memoryStorage(); storage.setItem(ASSIGNMENTS_ROW_KEY, JSON.stringify({ v: 1, rows: [{ projectId: 'rp-1', kind: 'observed', ref: 'session-1', pending: true }] }))
  let calls = 0
  const store = createAssignmentStore({ storage, postAction: async () => { calls += 1; return { ok: false } } })
  const result = await store.unassign('rp-1', 'observed', 'session-1')
  assert.equal(result.ok, false)
  assert.match(result.sentence, /Read the service’s current assignments/)
  assert.equal(calls, 0)
  assert.deepEqual(store.projectsOfSession('observed', 'session-1'), ['rp-1'])
  assert.equal(store.snapshot().removals.length, 0)
})

test('reassignment remains refused until the previous removal has a confirmed outcome', async () => {
  const f = fixture(), store = f.open()
  store.adoptServiceRows(f.snapshot()); f.setOnline(false)
  await store.unassign(f.membership.projectId, f.membership.kind, f.membership.ref)
  const before = f.calls.length
  const result = await store.assign(f.membership.projectId, f.membership.kind, f.membership.ref)
  assert.equal(result.ok, false)
  assert.match(result.sentence, /previous removal.*confirmation/)
  assert.equal(f.calls.length, before)
  assert.equal(store.snapshot().removals.length, 1)
})

test('a full service snapshot cannot evict a pending removal', async () => {
  const f = fixture(), store = f.open()
  store.adoptServiceRows(f.snapshot()); f.setOnline(false)
  await store.unassign(f.membership.projectId, f.membership.kind, f.membership.ref)
  store.adoptServiceRows(Array.from({ length: 200 }, (_, index) => ({ projectId: 'rp-other', kind: 'observed', ref: `other-${index}`, assignmentId: `ra-${index}` })))
  assert.equal(store.snapshot().removals.length, 1)
  assert.equal(store.snapshot().rows.length, 199)
  assert.equal((await store.flushPending()).remaining, 1)
})

test('concurrent flushes share one retained removal request', async () => {
  const storage = memoryStorage()
  let online = false, release, calls = 0
  const original = { projectId: 'rp-1', kind: 'observed', ref: 'session-1', assignmentId: 'ra-original' }
  const store = createAssignmentStore({ storage, postAction: async () => {
    calls += 1
    if (!online) return { ok: false, code: 'BRIDGE_UNREACHABLE' }
    return new Promise(resolve => { release = resolve })
  } })
  store.adoptServiceRows([original]); await store.unassign('rp-1', 'observed', 'session-1')
  online = true
  const first = store.flushPending(), second = store.flushPending()
  assert.equal(calls, 2, 'one initial refusal plus one shared retry')
  release({ ok: true, receipt: { projectId: 'rp-1', assigned: [], unassigned: [original] } })
  await Promise.all([first, second])
  assert.equal(store.snapshot().removals.length, 0)
})

test('a read started before confirmed removal cannot restore its old membership', async () => {
  const f = fixture(), store = f.open()
  store.adoptServiceRows(f.snapshot())
  const readVersion = store.readVersion(), delayedSnapshot = f.snapshot()
  assert.equal((await store.unassign(f.membership.projectId, f.membership.kind, f.membership.ref)).ok, true)
  assert.deepEqual(store.adoptServiceRows(delayedSnapshot, { readVersion }), { ok: true, stale: true })
  assert.deepEqual(store.snapshot().rows, [])
  assert.deepEqual(store.snapshot().removals, [])
})

test('an unavailable current outbox refuses adoption and retry without losing saved removal intent', async () => {
  const f = fixture(), first = f.open()
  first.adoptServiceRows(f.snapshot()); f.setOnline(false)
  await first.unassign(f.membership.projectId, f.membership.kind, f.membership.ref)
  let readable = true
  const store = createAssignmentStore({ storage: {
    getItem: key => { if (!readable) throw Error('Synthetic storage read refused'); return f.local.get(key) ?? null },
    setItem: (key, value) => f.local.set(key, value), removeItem: key => f.local.delete(key),
  }, postAction: async () => assert.fail('an unreadable outbox must not send a cached retry') })
  const before = f.local.get(ASSIGNMENTS_ROW_KEY)
  readable = false
  assert.equal(store.adoptServiceRows([]).code, ASSIGNMENTS_READ_UNAVAILABLE)
  const result = await store.flushPending()
  assert.equal(result.ok, false)
  assert.equal(result.remaining, null, 'unreadable state is not an empty pending count')
  assert.equal(result.code, ASSIGNMENTS_READ_UNAVAILABLE)
  assert.equal(f.local.get(ASSIGNMENTS_ROW_KEY), before)
  readable = true
  assert.equal(store.snapshot().removals.length, 1)
})

test('a full pending outbox refuses a new assignment without evicting any intent', async () => {
  const storage = memoryStorage()
  const removals = Array.from({ length: 200 }, (_, index) => ({ projectId: 'rp-1', kind: 'observed',
    ref: `session-${index}`, assignmentId: `ra-${index}`, operationId: `op-${index}` }))
  storage.setItem(ASSIGNMENTS_ROW_KEY, serializeAssignmentsRow([], removals))
  const before = storage.getItem(ASSIGNMENTS_ROW_KEY)
  const store = createAssignmentStore({ storage, postAction: async () => assert.fail('the full outbox must refuse before sending') })
  const result = await store.assign('rp-next', 'observed', 'next')
  assert.equal(result.ok, false)
  assert.match(result.sentence, /too many pending assignment changes/)
  assert.equal(storage.getItem(ASSIGNMENTS_ROW_KEY), before)
  assert.equal(store.snapshot().removals.length, 200)
})

// Exercise the other shipped adopter with its original function bytes. The
// surrounding Computers DOM is outside this small caller/store composition.
function computersResearchRead(store, snapshot) {
  const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
  const start = source.indexOf('  function readResearchOnce() {')
  const end = source.indexOf('  function refreshTreeSwitch()', start)
  assert.ok(start >= 0 && end > start)
  const state = { mock: false, mounted: 0 }
  const create = new Function('state', 'researchAssignments', 'readResearchSnapshot', `
    let researchService = null, destroyed = false
    const mockSource = () => state.mock
    const mountResearchScopeControl = () => { state.mounted += 1 }
    ${source.slice(start, end)}
    return { read: readResearchOnce, destroy() { destroyed = true }, result: () => researchService }
  `)
  return { state, ...create(state, store, snapshot) }
}
const turn = () => new Promise(resolve => setImmediate(resolve))

test('the Computers caller cannot adopt a pre-removal answer over the confirmed latest outbox', async () => {
  const f = fixture(), store = f.open()
  store.adoptServiceRows(f.snapshot())
  let release
  const delayed = f.snapshot()
  const caller = computersResearchRead(store, () => new Promise(resolve => { release = resolve }))
  caller.read()
  await store.unassign(f.membership.projectId, f.membership.kind, f.membership.ref)
  release({ ok: true, assignments: delayed }); await turn()
  assert.deepEqual(store.snapshot().rows, [])
  assert.equal(caller.state.mounted, 1)
})

for (const leave of ['mock', 'destroy']) test(`the Computers caller does not replay queued removal after ${leave}`, async () => {
  const f = fixture(), store = f.open()
  store.adoptServiceRows(f.snapshot()); f.setOnline(false)
  await store.unassign(f.membership.projectId, f.membership.kind, f.membership.ref)
  const before = f.calls.length
  let release
  const caller = computersResearchRead(store, () => new Promise(resolve => { release = resolve }))
  caller.read()
  if (leave === 'mock') caller.state.mock = true
  else caller.destroy()
  f.setOnline(true); release({ ok: true, assignments: f.snapshot() }); await turn()
  assert.equal(f.calls.length, before)
  assert.equal(store.snapshot().removals.length, 1)
  assert.equal(caller.state.mounted, 0)
})

test('the current Computers caller retries a retained removal through the normal store path', async () => {
  const f = fixture(), store = f.open()
  store.adoptServiceRows(f.snapshot()); f.setOnline(false)
  await store.unassign(f.membership.projectId, f.membership.kind, f.membership.ref)
  const caller = computersResearchRead(store, async () => ({ ok: true, assignments: f.snapshot() }))
  f.setOnline(true); caller.read(); await turn()
  assert.equal(f.service.size, 0)
  assert.equal(store.snapshot().removals.length, 0)
  assert.equal(caller.state.mounted, 1)
})

test('a later pending assignment must still exist when its earlier neighbour finishes', async () => {
  const storage = memoryStorage()
  storage.setItem(ASSIGNMENTS_ROW_KEY, serializeAssignmentsRow([
    { projectId: 'rp-1', kind: 'observed', ref: 'session-a', operationId: 'op-a', pending: true },
    { projectId: 'rp-1', kind: 'observed', ref: 'session-b', operationId: 'op-b', pending: true },
  ]))
  const calls = []
  let release
  const old = createAssignmentStore({ storage, postAction: async (action, body) => {
    calls.push(structuredClone(body))
    if (body.assign[0]?.ref === 'session-a') await new Promise(resolve => { release = resolve })
    return heardReceipt(action, body)
  } })
  const flushing = old.flushPending()
  const next = createAssignmentStore({ storage, postAction: heardReceipt })
  next.adoptServiceRows([{ projectId: 'rp-1', kind: 'observed', ref: 'session-b', assignmentId: 'ra-b' }])
  assert.equal((await next.unassign('rp-1', 'observed', 'session-b')).ok, true)
  release(); await flushing
  assert.deepEqual(calls.flatMap(body => body.assign.map(row => row.ref)), ['session-a'],
    'the retired captured assignment must not be dispatched after its confirmed removal')
})

test('an empty-to-empty browser revision cannot admit an old snapshot after another view removed its membership', async () => {
  const storage = memoryStorage()
  const old = createAssignmentStore({ storage, postAction: heardReceipt })
  const readVersion = old.readVersion()
  const delayed = [{ projectId: 'rp-1', kind: 'observed', ref: 'session-1', assignmentId: 'ra-old' }]
  const next = createAssignmentStore({ storage, postAction: heardReceipt })
  next.adoptServiceRows(delayed)
  await next.unassign('rp-1', 'observed', 'session-1')
  assert.deepEqual(next.snapshot().rows, [])
  old.adoptServiceRows(delayed, { readVersion })
  assert.deepEqual(old.snapshot().rows, [], 'returning to empty must still advance the browser revision')
})

for (const [label, expected] of [['empty', ''], ['undefined', undefined], ['null', null], ['non-string', 1]]) {
  test(`an explicitly supplied ${label} displayed assignment ID cannot select the current generation`, async () => {
    const f = fixture(), store = f.open()
    store.adoptServiceRows(f.snapshot())
    const result = await store.unassign(f.membership.projectId, f.membership.kind, f.membership.ref, expected)
    assert.equal(result.ok, false)
    assert.match(result.sentence, /displayed assignment could not be identified/)
    assert.equal(f.calls.length, 0)
    assert.equal(f.service.size, 1)
  })
}


function destinationFixture() {
  const storage = memoryStorage(), calls = []
  let selected = 'account-A/relay-A/device-A', era = 0, available = true
  let respond = (_key, action, body) => action === 'research-snapshot'
    ? { ok: true, receipt: { projects: [], assignments: [] } } : heardReceipt(action, body)
  const postAction = async (action, body) => { calls.push({ key: selected, action, body }); return respond(selected, action, body) }
  const captureDestination = async () => {
    const key = selected, ticket = era
    return { ok: true, key, request: async (action, body) => {
      if (key !== selected || ticket !== era) return { ok: false, code: 'BRIDGE_DESTINATION_CHANGED' }
      if (!available) return { ok: false, code: 'BRIDGE_UNREACHABLE' }
      calls.push({ key, action, body })
      const result = await respond(key, action, body)
      return key === selected && ticket === era ? result : { ok: false, code: 'BRIDGE_DESTINATION_CHANGED', sent: true }
    } }
  }
  const store = () => createAssignmentStore({ storage, postAction, requireDestination: true, captureDestination })
  const read = async ({ snapshot } = {}) => {
    const result = await (snapshot ? snapshot() : postAction('research-snapshot', {}))
    return result.ok ? { ok: true, assignments: result.receipt.assignments } : result
  }
  const mount = async target => {
    // The same adverse cases run against the old store, which had no bound
    // snapshot seam, and the new one. This is only a test compatibility seam.
    const result = target.readServiceSnapshot ? await target.readServiceSnapshot(read) : await read()
    if (result.ok) target.adoptServiceRows(result.assignments, {
      ...(result.assignmentReadVersion === undefined ? {} : { readVersion: result.assignmentReadVersion }),
      assignmentDestination: result.assignmentDestination,
    })
    return result
  }
  return { storage, calls, store, mount, read,
    select(key) { selected = key; era += 1 },
    setAvailable(value) { available = value; respond = value ? (_key, action, body) => action === 'research-snapshot'
      ? { ok: true, receipt: { projects: [], assignments: [] } } : heardReceipt(action, body)
      : () => ({ ok: false, code: 'BRIDGE_UNREACHABLE' }) },
    setRespond(value) { respond = value },
  }
}

test('destination outbox: B cannot replay A pending assignment; returning to A can', async () => {
  const f = destinationFixture(), a = f.store()
  await f.mount(a)
  f.setAvailable(false)
  assert.equal((await a.assign('rp-1', 'observed', 'session-1')).pending, true)
  f.select('account-A/relay-A/device-B'); f.setAvailable(true)
  const b = f.store()
  await f.mount(b)
  const before = f.calls.filter(x => x.action === 'research-session-assign').length
  await b.flushPending()
  assert.equal(f.calls.filter(x => x.action === 'research-session-assign').length, before, 'B must never receive A pending write')
  assert.equal(b.snapshot().rows.length, 0, 'A rows must not appear on B')
  f.select('account-A/relay-A/device-A')
  const again = f.store()
  await f.mount(again)
  assert.equal((await again.flushPending()).accepted, 1, 'fresh A ticket may replay A intent')
})

test('destination outbox: B NOT_FOUND cannot retire an A pending removal', async () => {
  const f = destinationFixture(), a = f.store()
  await f.mount(a)
  await a.assign('rp-1', 'observed', 'session-1')
  const id = a.snapshot().rows[0].assignmentId
  f.setAvailable(false)
  assert.equal((await a.unassign('rp-1', 'observed', 'session-1', id)).pending, true)
  f.select('account-A/relay-A/device-B'); f.setAvailable(true)
  f.setRespond(() => ({ ok: false, code: 'RESEARCH_ASSIGNMENT_NOT_FOUND' }))
  const before = f.calls.length
  await a.flushPending()
  assert.equal(f.calls.length, before, 'old A store must refuse before dispatch to B')
  assert.equal(a.snapshot().removals.length, 1, 'A removal remains unresolved')
  f.select('account-A/relay-A/device-A')
  assert.equal((await a.flushPending()).accepted, 1, 'NOT_FOUND is usable only on original destination')
  assert.equal(a.snapshot().removals.length, 0)
})

test('destination outbox: registration and account changes never migrate intent', async () => {
  const f = destinationFixture(), a = f.store()
  await f.mount(a); f.setAvailable(false)
  await a.assign('rp-1', 'observed', 'session-1')
  for (const key of ['account-A/new-relay/device-A', 'account-B/relay-A/device-A']) {
    f.select(key); f.setAvailable(true)
    const other = f.store(); await f.mount(other)
    const before = f.calls.length
    await other.flushPending()
    assert.equal(f.calls.length, before)
    assert.equal(other.snapshot().rows.length, 0)
  }
})

test('destination outbox: legacy unbound intent is preserved and never adopted or replayed', async () => {
  const f = destinationFixture()
  const legacy = JSON.stringify({ v: 1, rows: [{ projectId: 'rp-legacy', kind: 'observed', ref: 'old', pending: true }] })
  f.storage.setItem(ASSIGNMENTS_ROW_KEY, legacy)
  const a = f.store(); await f.mount(a)
  await a.flushPending()
  assert.equal(f.storage.getItem(ASSIGNMENTS_ROW_KEY), legacy)
  assert.equal(f.calls.filter(x => x.action === 'research-session-assign').length, 0)
  assert.equal(a.snapshot().rows.length, 0)
  assert.equal(a.snapshot().unboundLegacy, true)
})

test('destination outbox: missing host contract refuses rather than using ambient transport', async () => {
  let sends = 0
  const store = createAssignmentStore({ storage: memoryStorage(), requireDestination: true,
    captureDestination: async () => null, postAction: async () => { sends += 1; return { ok: true } } })
  assert.equal((await store.assign('rp-1', 'observed', 'session-1')).ok, false)
  assert.equal(sends, 0)
})


test('destination outbox: an old rendered control cannot create a new A intent after selecting B', async () => {
  const f = destinationFixture(), a = f.store()
  await f.mount(a)
  f.select('account-A/relay-A/device-B')
  assert.equal((await a.assign('rp-1', 'observed', 'session-from-B')).ok, false)
  assert.equal(a.snapshot().rows.length, 0)
  assert.equal(f.calls.filter(x => x.action === 'research-session-assign').length, 0)
})
