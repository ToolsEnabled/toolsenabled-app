import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { readFileSync } from 'node:fs'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { createTreeWorkController } from '../../src/tree-bounded-work.js'
import { sessionEndedEvent } from '../../src/agent-session-events.js'
import { LAUNCH_TIERS, launchTier, clampCapMs, capMinutes, CAP_BOUNDS } from '../../src/orchestration-controls.js'
/* The lifted panel's paint() reads this to decide whether the thinking-depth
   select is live (views/computers.js, the [data-work-effort] line). It is the
   REAL Set from the module that owns it, not a fixture stand-in: a stub here
   could disagree with the product about which providers have a depth and the
   suite would still pass. Without it the lifted function throws
   ReferenceError on its first paint, which is how all four tests in this file
   were failing. */
import { PROVIDERS_WITH_A_THINKING_DEPTH } from '../../src/create-and-start-node.js'
import { PALETTE_PANEL, turnCompletionWords } from '../../src/fleet-tree-copy.js'
import { stopStillOwnsNode } from '../../src/stop-node-session.js'
import { stopNativePersonSession } from '../../src/native-person-stop.js'

const world = installDomStandIn()
after(() => world.restore())
const { el } = await import('../../src/components.js')
const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const names = ['nativeBoundedWorkBox', 'runPaletteAction', 'closePersonNode', 'settleStoppedSession', 'cancelPendingModelChoice']
if (source.includes('function subscribeBoundedSessionEnded(')) names.push('subscribeBoundedSessionEnded')
const declarations = names.map(name => declaredFunctionSource(source, name)).join('\n')
const flush = async () => { for (let count = 0; count < 20; count++) await Promise.resolve() }

// Execute the complete maintained panel, Stop action and shared settlement.
// DOM and the host endpoint are fixtures; no provider or native proof is claimed.
async function fixture(t, { closeError = false, unsigned = false, wrongSession = false } = {}) {
  const root = { id: 'parent', treeId: 'tree', sessionId: 'parent-session', status: 'finished', name: 'Parent' }
  const nodes = new Map([[root.id, root]]), routes = new Map([[root.sessionId, root.id]])
  const statuses = new Map(), packets = new Set(), closes = []
  const controllers = new Map(), closeListeners = new Set(), unsubscribers = []
  const closing = Promise.withResolvers()
  let starts = 0
  const store = { snapshot: () => ({ computerId: 'computer' }), getNode: id => nodes.get(id),
    setNodeStatus: (id, status) => { nodes.get(id).status = status } }
  const closedStatus = sessionId => ({ ...statuses.get(sessionId), state: 'closed', endRecord: { sequence: 20, eventHash: 'b'.repeat(64) } })
  const bridge = {
    onEvent: listener => { packets.add(listener); return () => packets.delete(listener) },
    workStatus: async ({ sessionId }) => statuses.get(sessionId),
    close: async ({ sessionId }) => {
      closes.push(sessionId)
      await closing.promise
      if (closeError) throw new Error('Owned cleanup did not complete.')
      statuses.set(sessionId, { ...closedStatus(sessionId), ...(unsigned ? { endRecord: null } : {}) })
      return { ok: true, closed: true, sessionId: wrongSession ? 'other-session' : sessionId }
    },
  }
  const scope = {
    chatWorkspace: false, pendingModelChoices: new Map(), notifyNodeStatusListeners() {},
    el, LAUNCH_TIERS, launchTier, clampCapMs, capMinutes, CAP_BOUNDS, PALETTE_PANEL, turnCompletionWords,
    PROVIDERS_WITH_A_THINKING_DEPTH,
    createTreeWorkController, sessionEndedEvent, stopStillOwnsNode, stopNativePersonSession,
    window: { mcAgent: bridge }, treeStore: store, sessionNodeIds: routes,
    RUN_NATIVE_WORK_CONTROLLERS: controllers, RUN_NATIVE_WORK_CLOSE_LISTENERS: closeListeners,
    RUN_SESSION_CLEANUPS: new Map(), RUN_NODE_REMOVAL_CLOSE_RECEIPTS: new Map(),
    destroyed: false, unsubs: unsubscribers, loopIntervals: new Map(), FLEET_TREE_LIMITS: { maxMessageChars: 4000 },
    mockSource: () => false, isWriteEnabled: () => true, START_CONTROL_FLAG: 'agent-session',
    readLaunchSettings: () => ({ tier: 'astra', capMs: 60000 }),
    escapeMarkup: value => String(value), nodeBusy: () => false, refreshTree: () => {},
    sessionPendingApprovals: new Map(), clearInlineApproval: () => {},
    retireTreeSessionRuntime: sessionId => routes.delete(sessionId),
    outboxClearSession: () => 0, resetSessionMetrics: () => {},
    // Stop consults the account recovery coordinator (d839fa41); this fixture runs with none.
    recoveryCoordinator: () => null,
    startBoundedChild: async request => {
      const index = ++starts, id = `node-${index}`, sessionId = `session-${index}`
      nodes.set(id, { id, sessionId, treeId: 'tree', parentId: request.parentNodeId, status: 'finished' })
      routes.set(sessionId, id)
      const record = { sequence: index, eventHash: 'a'.repeat(64) }
      const boundedWork = { action: 'tree.dispatch', computerId: 'computer', treeId: 'tree',
        nodeId: id, agentId: id, sessionId, parentNodeId: request.parentNodeId, parentSessionId: request.parentSessionId,
        capMs: 60000, startedAt: 1000, deadlineAt: 61000 }
      statuses.set(sessionId, { ok: true, ...boundedWork, state: 'ready', record })
      return { ok: true, nodeId: id, sessionId, boundedWork, record }
    },
  }
  const api = new Function(...Object.keys(scope), `${declarations}; return { panel: nativeBoundedWorkBox, stop: runPaletteAction }`)(...Object.values(scope))
  const box = api.panel(root, 'team')
  document.body.appendChild(box)
  const controller = controllers.get('computer:parent:team')
  const plan = { computerId: 'computer', treeId: 'tree', parentNodeId: root.id, parentSessionId: root.sessionId,
    tier: 'astra', members: ['astra'], capMs: 60000, brief: 'Fixture work' }
  await controller.run(plan)
  await flush()
  const stop = box.querySelector('[data-team="stop"]')
  assert.equal(stop.disabled, false)
  // The real host sends parent-stopped for the member, but no session_ended
  // packet for a lead closed through the owner's ordinary agent:close call.
  statuses.set('session-2', closedStatus('session-2'))
  for (const listener of packets) listener({ sessionId: 'session-2', event: { type: 'session_ended', reason: 'parent-stopped', exit: { code: null, signal: null } } })
  await flush()
  assert.equal(controller.getState().rows[1].phase, 'closed')
  assert.equal(controller.getState().rows[0].phase, 'started')
  const out = { textContent: '' }
  const result = api.stop('stop', nodes.get('node-1'), out)
  await flush()
  assert.equal(stop.disabled, false, 'An unresolved close must retain the team Stop control')
  t.after(() => { closing.resolve(); for (const unsubscribe of unsubscribers) unsubscribe(); box.remove() })
  return { controller, stop, out, result, closing, closes, closeListeners, packets, starts: () => starts }
}

test('confirmed manual lead Stop refreshes the real retained team panel without another Stop press', async t => {
  const f = await fixture(t)
  f.closing.resolve()
  await f.result
  await flush()
  assert.equal(f.controller.getState().phase, 'completed')
  assert.equal(f.stop.disabled, true)
  assert.ok(f.controller.getState().rows.every(row => row.phase === 'closed'))
  assert.equal(f.out.textContent, PALETTE_PANEL.stopped)
  assert.deepEqual(f.closes, ['session-1'])
  assert.equal(f.starts(), 2)
  assert.equal(f.closeListeners.size, 0)
  assert.equal(f.packets.size, 0)
})

for (const [name, options] of [['failed cleanup', { closeError: true }], ['unsigned end', { unsigned: true }], ['wrong close session', { wrongSession: true }]]) {
  test(`${name} cannot disable the retained team Stop control`, async t => {
    const f = await fixture(t, options)
    f.closing.resolve()
    await f.result
    await flush()
    assert.equal(f.stop.disabled, false)
    assert.equal(f.controller.getState().rows[0].phase, 'started')
    assert.equal(f.controller.getState().stoppable, true)
    assert.deepEqual(f.closes, ['session-1'])
    assert.equal(f.starts(), 2)
  })
}
