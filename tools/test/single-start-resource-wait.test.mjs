import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { createTreeLaunchQueue, isResourceHold } from '../../src/tree-launch-queue.js'
import { createSingleFlight } from '../../src/single-flight.js'
import { createDocument } from './lib/dom-stand-in.mjs'

// Execute the actual closure-private view functions, not copies of their
// behavior. Only the expensive session handoff is a stand-in in the queue
// tests. The separate preflight test executes the real handoff's early gates.
const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
function between(start, end) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  assert.ok(from >= 0 && to > from, `${start} must retain a reviewable boundary`)
  return source.slice(from, to)
}
const wrappers = between('  async function startDraftNode(node,', '  async function startDraftNodeUnguarded(node,')
const controls = between('  function launchQueuesForTree(', '  /* The second view-only pane')
const handoff = between('  async function startDraftNodeUnguarded(node,', '\n  /* The note the tree keeps beside a node')
const launchStatus = between('  function nodeStartReason(node)', '  /* ONE chat config for a tree node')
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done }), resolve: value => resolve(value) } }
function fixture(start) {
  let clock = 1000
  let sequence = 0
  const scheduled = new Map()
  const node = { id: 'one-draft', treeId: 'one-tree', status: 'draft', message: 'Keep this exact useful brief.', role: 'worker', tier: 'luna' }
  const document = createDocument()
  const root = document.createElement('main')
  root.innerHTML = '<div data-tree-start-controls="one-tree"></div>'
  const notes = []
  const closed = []
  const initialPanel = { id: 'original-compose' }
  const context = vm.createContext({ document, root, statsPage: root, node, destroyed: false,
    treeStore: { getNode: () => node, listNodes: () => [node], listTrees: () => [{ id: node.treeId }], treeLabel: () => 'This tree' },
    treeLaunchQueues: new Map(), nodeLaunchQueues: new Map(), startingTreeIds: new Set(),
    startingNodeIds: new Set(), currentRailTreeNode: null, notifyNodeStatusListeners() {},
    startDraftFlight: createSingleFlight(), composePanel: initialPanel,
    composeUnavailableReason: () => null, composeStartUnavailableReason: () => null,
    setOrgStatus: (...args) => notes.push(args),
    closeComposePanel: panel => { closed.push(panel); if (context.composePanel === panel) context.composePanel = null },
    startSetTree() { throw new Error('The test must press the queue control, not start another batch.') },
    startDraftNodeUnguarded: (pending, options) => start(pending, options),
    createTreeLaunchQueue: options => createTreeLaunchQueue({ ...options, now: () => clock,
      schedule(fn, delay) { const id = ++sequence; scheduled.set(id, { fn, at: clock + delay }); return id },
      unschedule: id => scheduled.delete(id),
    }),
  })
  vm.runInContext(launchStatus + controls + wrappers, context)
  const button = text => [...root.querySelectorAll('button')].find(entry => entry.textContent === text)
  async function next() {
    const entry = [...scheduled.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    assert.ok(entry, 'there should be scheduled work')
    scheduled.delete(entry[0]); clock = entry[1].at; entry[1].fn(); await tick()
  }
  return { context, node, notes, closed, initialPanel, scheduled, button, next }
}
const hold = () => ({ ok: false, retryable: true, code: 'AGENT_RESOURCE_WARMING', message: 'Measuring a stable resource window.', retryAfterMs: 1000 })

test('single Start waits visibly through a cold hold, then returns one actual receipt without a second press', async () => {
  let attempts = 0
  const f = fixture(async pending => { assert.equal(pending, f.node); return ++attempts === 1 ? hold() : { ok: true, sessionId: 'fixture-receipt' } })
  const completion = f.context.startDraftNode(f.node, { closePanel: true })
  const duplicate = await f.context.startDraftNode(f.node)
  assert.equal(duplicate.code, 'MC_TREE_COMMAND_ALREADY_RUNNING')
  await f.next()
  assert.equal(attempts, 1); assert.equal(f.context.startDraftFlight.busy(f.node.id), true)
  assert.match(f.notes.at(-1)[0], /stable resource window.*queued.*Cancel queued/)
  assert.match(f.context.nodeStartReason(f.node), /stable resource window.*queued.*retry automatically/)
  assert.equal(f.context.nodeStartReason({ id: 'unrelated-draft', treeId: f.node.treeId }), '', 'another draft must not borrow this request’s hold')
  assert.ok(f.button('Cancel queued')); assert.equal(f.context.composePanel, null)
  assert.equal(f.node.status, 'draft'); assert.equal(f.node.message, 'Keep this exact useful brief.')
  await f.next()
  assert.equal((await completion).sessionId, 'fixture-receipt'); assert.equal(attempts, 2)
  assert.equal(f.context.nodeLaunchQueues.size, 0); assert.equal(f.context.startDraftFlight.busy(f.node.id), false)
  assert.equal(f.context.nodeStartReason(f.node), '', 'completed queue state is not kept as a live hold')
})
test('visible Pause/Resume preserve the single queued request, and Cancel keeps its in-page brief without starting', async () => {
  let attempts = 0
  const f = fixture(async () => { attempts++; return hold() })
  const completion = f.context.startDraftNode(f.node)
  await f.next()
  f.button('Pause queue').click()
  assert.equal(f.scheduled.size, 0); assert.match(f.notes.at(-1)[0], /paused/)
  assert.match(f.context.nodeStartReason(f.node), /paused.*brief is kept on this page/)
  assert.doesNotMatch(f.context.nodeStartReason(f.node), /brief is saved/)
  assert.equal(f.node.message, 'Keep this exact useful brief.')
  f.button('Resume queue').click(); await f.next()
  // Resume first respects the existing backoff before attempting admission.
  if (attempts === 1) await f.next()
  assert.equal(attempts, 2)
  f.button('Cancel queued').click()
  const result = await completion
  assert.equal(result.notStarted, true); assert.equal(attempts, 2); assert.equal(f.scheduled.size, 0)
  assert.equal(f.node.message, 'Keep this exact useful brief.'); assert.equal(f.node.status, 'draft')
  assert.equal(f.button('Start tree').disabled, false, 'single-flight release must repaint the Start control')
})
test('Cancel never calls an already in-flight actual receipt a cancelled start', async () => {
  const pending = deferred()
  const f = fixture(() => pending.promise)
  const completion = f.context.startDraftNode(f.node)
  await f.next(); f.button('Cancel queued').click()
  pending.resolve({ ok: true, sessionId: 'already-started' })
  assert.equal((await completion).sessionId, 'already-started')
})
test('a retry keeps its original panel identity and cannot close a newly selected compose panel', async () => {
  const first = deferred()
  const panels = []
  let attempts = 0
  const f = fixture((_node, options) => { panels.push(options.startPanel); return ++attempts === 1 ? first.promise : { ok: true } })
  const completion = f.context.startDraftNode(f.node, { closePanel: true })
  await f.next()
  const otherPanel = { id: 'other-compose' }; f.context.composePanel = otherPanel
  first.resolve(hold()); await tick(); await f.next(); await completion
  assert.equal(f.context.composePanel, otherPanel)
  assert.deepEqual(panels, [f.initialPanel, f.initialPanel]); assert.equal(f.closed.every(panel => panel === f.initialPanel), true)
})
test('session-bearing failures and unknown outcomes are never automatically retried', async () => {
  for (const answer of [{ ...hold(), sessionId: 'existing' }, new Error('transport outcome unknown')]) {
    let attempts = 0
    const f = fixture(() => { attempts++; if (answer instanceof Error) throw answer; return answer })
    const completion = f.context.startDraftNode(f.node)
    await f.next(); assert.equal((await completion).ok, false)
    assert.equal(attempts, 1); assert.equal(f.scheduled.size, 0)
  }
})
test('disposing the view cancels a held single Start without replay or late UI writes', async () => {
  let attempts = 0
  const f = fixture(() => { attempts++; return hold() })
  const completion = f.context.startDraftNode(f.node)
  await f.next(); f.context.destroyed = true
  const count = f.notes.length
  for (const { queue } of f.context.nodeLaunchQueues.values()) queue.cancel()
  assert.equal((await completion).notStarted, true); assert.equal(attempts, 1)
  assert.equal(f.scheduled.size, 0); assert.equal(f.notes.length, count)
  assert.match(source, /for \(const \{ queue \} of nodeLaunchQueues.values\(\)\) queue.cancel\(\)/)
})
test('the real preflight speaks its resource hold and observes cancellation before any session handoff', async () => {
  const node = { id: 'held-draft', status: 'draft', tier: 'luna', role: 'worker', message: 'Keep it.' }
  const notes = []
  let cancelled = false
  let response = { admission: hold() }
  const context = vm.createContext({ composePanel: null, mockSource: () => false, treeStore: { getNode: () => node },
    isWriteEnabled: () => true, START_CONTROL_FLAG: 'start', draftStartEffort: () => 'medium', tierEffortOf: () => 'medium',
    identityRoleForTreeNode: role => role, ensureSeatForNode: async () => ({ ok: true }),
    roleBindingForStart: () => ({ ok: true, binding: { agentId: node.id } }), setOrgStatus: (...args) => notes.push(args),
    destroyed: false, currentDataSource: () => 'local', LAUNCH_TIERS: [{ id: 'luna', provider: 'codex' }],
    window: { mcResources: { status: async () => { const value = await response; return value } } }, isResourceHold,
  })
  vm.runInContext(handoff, context)
  const held = await context.startDraftNodeUnguarded(node)
  assert.equal(held.code, 'AGENT_RESOURCE_WARMING'); assert.equal(held.retryable, true)
  assert.equal(notes.at(-1)[2].code, 'AGENT_RESOURCE_WARMING')
  const pending = deferred(); response = pending.promise
  const start = context.startDraftNodeUnguarded(node, { isCancelled: () => cancelled })
  await tick(); cancelled = true; pending.resolve({ admission: { ok: true } })
  assert.equal((await start).notStarted, true, 'no later session-start dependency may be reached')
})
