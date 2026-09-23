/* PRESSING START TWICE AFTER A START THAT FAILED.
 *
 * THE QUESTION, from a real incident on 2026-09-11. Every Grok tree start was
 * refused by the session authority. The compose panel does not close on a
 * refusal -- only a success closes it -- so the person's brief stayed on screen
 * with the refusal beside it, and they pressed Start again. Three presses left
 * three single-node trees in the saved state.
 *
 * THE THING WORTH KNOWING is not that the saved state looked tidy afterwards.
 * It is what the CODE does, because a store that happens to be consistent today
 * proves nothing about the press that lands tomorrow. So this file drives the
 * real submitCompose() and startDraftNode() out of src/views/computers.js and
 * asks three questions of them directly:
 *
 *   does a second press reuse the failed tree and node, or mint new ones?
 *   can a node end up pointing at a tree that is not there, or the reverse?
 *   can ONE press ever produce two starts for one node?
 *
 * THE ANSWERS THIS PINS. A failed form keeps its original tree and node: the
 * retry-aware compose submission owns that identity until the form closes, so
 * pressing Start again retries the same saved draft rather than creating a
 * second agent. A newly opened form gets a new tree and node. And one press
 * cannot start twice: startDraftNode() runs inside a single flight keyed on
 * the node id.
 *
 * THAT IS A DESIGN, NOT AN ACCIDENT, and it is the honest one for this surface:
 * a person who presses Start twice while the same form remains open is retrying
 * the saved task, while closing the form and opening a new one is the explicit
 * action that asks for a second agent.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

import { createFleetTreeStore } from '../../src/fleet-trees.js'
import { createSingleFlight } from '../../src/single-flight.js'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { computersViewAuthorityBindings } from './lib/computers-view-authority-bindings.mjs'

const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const submitComposeSource = declaredFunctionSource(source, 'submitCompose')
const startDraftNodeSource = declaredFunctionSource(source, 'startDraftNode')

const DRAFT = Object.freeze({ mode: 'start', role: 'worker', tier: 'grok', effort: '', message: 'Read the log and report.', profileId: null })

/* The view's own submitCompose, with the real store under it and one stub where
   a test cannot supply the thing itself: the start. It refuses the way the
   incident's start refused, and marks the node failed exactly as
   startDraftNodeUnguarded does on that path, so the second press meets the
   state the person's second press actually met. */
function composeFixture({ startOutcome = () => ({ ok: false, message: 'This agent could not start.' }) } = {}) {
  const cells = new Map()
  const storage = {
    read: key => cells.has(key) ? JSON.parse(cells.get(key)) : null,
    write: (key, value) => { cells.set(key, JSON.stringify(value)); return true },
  }
  let minted = 0
  const store = createFleetTreeStore({ computerId: 'computer-a', storage, makeId: kind => `${kind}-${++minted}` })
  const starts = []
  const added = []
  const context = vm.createContext({
    ...computersViewAuthorityBindings(),
    mockSource: () => false,
    treeStore: store,
    treeStoreProblem: '',
    START_NEEDS_APP_TEXT: () => 'This app cannot start agents.',
    composeParentFor: () => null,
    isWriteEnabled: () => true,
    START_CONTROL_FLAG: 'start',
    startControlOffReason: () => 'Starting is switched off.',
    START_REFUSAL: { noReasonGiven: 'It did not start and said no more than that.' },
    rememberComposeFolder: () => {},
    refreshTree: () => {},
    setOrgStatus: () => {},
    closeComposePanel: () => { context.composePanelClosed = (context.composePanelClosed || 0) + 1 },
    composePanelClosed: 0,
    destroyed: false,
    unstartedTreeNodeRetryState: () => ({ hasSavedConversation: false, cleanupPending: false, busy: false }),
    retryUnstartedTreeNode: async (node, { start }) => {
      store.setNodeStatus(node.id, 'draft')
      return start(store.getNode(node.id))
    },
    rootSeatFor: () => null,
    roleRecordFor: () => null,
    identityRoleForTreeNode: role => role,
    orgAvailability: { org: null },
    LAUNCH_TIERS: [],
    startDraftNode: async (node, options) => {
      starts.push({ nodeId: node.id, treeId: node.treeId, options })
      const outcome = startOutcome(node)
      if (!outcome.ok) store.setNodeStatus(node.id, 'failed', { note: outcome.message })
      return outcome
    },
  })
  vm.runInContext(submitComposeSource, context)
  const submission = { active: () => true }
  return {
    store,
    starts,
    added,
    press: (draft = DRAFT) => context.submitCompose(draft, null, false, submission),
    closes: () => context.composePanelClosed,
  }
}

test('a second Start press after a failed start retries the same tree and node', async () => {
  const fixture = composeFixture()

  const first = await fixture.press()
  assert.equal(first.ok, false, 'the first press must refuse, or this is not the situation being measured')
  const afterFirst = fixture.store.snapshot()
  assert.equal(afterFirst.trees.length, 1)
  assert.equal(afterFirst.nodes.length, 1)
  const failed = afterFirst.nodes[0]
  assert.equal(failed.status, 'failed')

  const second = await fixture.press()
  assert.equal(second.ok, false)

  const after = fixture.store.snapshot()
  assert.equal(after.trees.length, 1, 'a retry keeps the original tree')
  assert.equal(after.nodes.length, 1, 'a retry keeps the original node')
  assert.equal(new Set(after.nodes.map(node => node.id)).size, 1, 'a retry must not mint a replacement node')
  assert.equal(new Set(after.nodes.map(node => node.treeId)).size, 1, 'a retry must remain in the original tree')

  /* THE FAILED CIRCLE IS UNTOUCHED. Its brief is what the person typed and its
     status is what the refusal left, so the tree still shows them what went
     wrong beside what they asked for. */
  const stillFailed = fixture.store.getNode(failed.id)
  assert.equal(stillFailed.status, 'failed')
  assert.equal(stillFailed.message, DRAFT.message)
  assert.equal(stillFailed.treeId, failed.treeId)

  /* ONE START PER PRESS, BOTH AGAINST THE SAME NODE. */
  assert.equal(fixture.starts.length, 2)
  assert.deepEqual(fixture.starts.map(call => call.nodeId), [failed.id, failed.id])
  assert.equal(new Set(fixture.starts.map(call => call.treeId)).size, 1)

  /* AND THE PANEL STAYS OPEN THROUGHOUT. Only a success closes it, which is why
     a second press is reachable at all. */
  assert.equal(fixture.closes(), 0, 'a refused start must leave the brief on screen')
})

test('repeated failed presses leave one node with one tree', async () => {
  const fixture = composeFixture()
  for (let press = 0; press < 3; press += 1) await fixture.press()

  const { trees, nodes } = fixture.store.snapshot()
  assert.equal(trees.length, 1)
  assert.equal(nodes.length, 1)
  const treeIds = new Set(trees.map(tree => tree.id))
  for (const node of nodes) {
    assert.ok(treeIds.has(node.treeId), `${node.id} points at tree ${node.treeId}, which is not in the saved state`)
    assert.equal(node.parentId, null, 'the root retry remains unparented')
  }
  for (const tree of trees) {
    assert.equal(nodes.filter(node => node.treeId === tree.id).length, 1, `${tree.id} does not hold exactly one node`)
  }
})

test('the compose path reserves no node id, so a repeated press cannot mismatch one', () => {
  /* reservedNodeId is how src/create-and-start-node.js keeps an agent-requested
     circle and the id its parent was promised in step, and fleet-trees.js
     refuses a reserved id that is already taken. The person's compose path
     supplies none: it is the store that mints, once per press. A test that only
     watched ids could not tell those two apart, so this reads the call. */
  assert.doesNotMatch(submitComposeSource, /reservedNodeId/,
    'submitCompose now reserves a node id; a second press could then collide with the first')
  assert.match(submitComposeSource, /addDraft\(\{/, 'submitCompose no longer creates its node through addNode')
})

/* THE OTHER DIRECTION OF THE SAME QUESTION. Two presses making two circles is
   the design. ONE press making two starts on ONE circle would be the defect:
   the later call wins the node and the earlier keeps running, and spending,
   with nothing on screen able to reach it. Both guards against it are real and
   both are measured here. */
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

test('startDraftNode refuses a second start for a node that is already starting', async () => {
  const gate = deferred()
  const runs = []
  const context = vm.createContext({
    startDraftFlight: createSingleFlight(),
    destroyed: false,
    refreshTreeStartControls: () => {},
    startDraftNodeQueued: async () => { throw new Error('this test drives the unguarded route directly') },
    startDraftNodeUnguarded: async node => { runs.push(node.id); await gate.promise; return { ok: true, sessionId: 'session-1' } },
  })
  vm.runInContext(startDraftNodeSource, context)

  const node = { id: 'node-7', treeId: 'tree-6' }
  const first = context.startDraftNode(node, { queueManaged: true })
  const second = await context.startDraftNode(node, { queueManaged: true })

  assert.equal(second.ok, false)
  assert.equal(second.code, 'MC_TREE_COMMAND_ALREADY_RUNNING',
    'a second start for a node already starting must be refused, not queued behind it')
  assert.equal(runs.length, 1, 'one node was started twice; the later start would win it and the earlier would keep running')

  gate.resolve()
  assert.equal((await first).ok, true, 'the refusal of the second press must not disturb the first')

  /* And once it has settled the guard is released, so the node is startable
     again by whatever route is allowed to start it. */
  const third = await context.startDraftNode(node, { queueManaged: true })
  assert.equal(third.ok, true)
  assert.equal(runs.length, 2)
})

test('the compose panel cannot be pressed again while its own start is in flight', async () => {
  const { createDocument } = await import('./lib/dom-stand-in.mjs')
  const { mountAgentComposePanel } = await import('../../src/agent-compose-panel.js')
  const doc = createDocument()
  const container = doc.createElement('div')
  const gate = deferred()
  const submitted = []
  const panel = mountAgentComposePanel({
    doc,
    container,
    parent: null,
    tiers: [{ id: 'grok', label: 'Grok', enabled: true }],
    onSubmit: draft => { submitted.push(draft.mode); return gate.promise },
  })
  assert.ok(panel, 'the panel must mount, or this measures nothing')

  const start = container.querySelector('[data-compose-start]') || findStartButton(container)
  assert.ok(start, 'the panel must draw a Start control')
  const message = findMessageField(container)
  assert.ok(message, 'the panel must draw a brief field')
  message.value = 'Read the log and report.'
  message.dispatchEvent({ type: 'input' })

  start.dispatchEvent({ type: 'click' })
  start.dispatchEvent({ type: 'click' })
  assert.deepEqual(submitted, ['start'], 'a press while the first press is in flight must be swallowed, not sent again')

  gate.resolve({ ok: false, message: 'This agent could not start.' })
  await gate.promise
  await new Promise(done => setImmediate(done))

  start.dispatchEvent({ type: 'click' })
  assert.deepEqual(submitted, ['start', 'start'], 'once the start has settled the button must work again')
  panel.destroy()
})

function walk(element, seen = []) {
  seen.push(element)
  for (const child of element.children || []) walk(child, seen)
  return seen
}
function findStartButton(container) {
  return walk(container).find(node => node.tagName === 'BUTTON' && /start/i.test(node.textContent || ''))
}
function findMessageField(container) {
  return walk(container).find(node => node.tagName === 'TEXTAREA')
}
