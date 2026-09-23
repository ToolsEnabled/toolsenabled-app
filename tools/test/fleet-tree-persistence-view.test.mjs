import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { parseAst } from 'rollup/parseAst'
import { createFleetTreeStore, safeTreeStorage, FLEET_TREE_LIMITS, NODE_STATUSES, NODE_REMOVE_REFUSALS, nodeDisplayName, TREE_BOUNDS, treeSlotUsage } from '../../src/fleet-trees.js'
import { nodeIsBusy } from '../../src/tree-session-liveness.js'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { computersViewAuthorityBindings } from './lib/computers-view-authority-bindings.mjs'

const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const functions = new Map()
function collect(node) {
  if (!node || typeof node !== 'object') return
  if (node.type === 'FunctionDeclaration') functions.set(node.id.name, source.slice(node.start, node.end))
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(collect)
    else if (value && typeof value === 'object') collect(value)
  }
}
collect(parseAst(source))
const actual = name => { assert.ok(functions.has(name), name); return functions.get(name) }

function fixture({ raw = null, unavailable = false, writeError = 'fixture quota reached' } = {}) {
  const dom = installDomStandIn()
  const status = dom.document.createElement('output')
  status.setAttribute('role', 'status')
  dom.document.body.append(status)
  const controlsPage = dom.document.createElement('section')
  const slots = dom.document.createElement('p')
  slots.setAttribute('data-direct-slot-usage', '')
  controlsPage.append(slots)
  dom.document.body.append(controlsPage)
  let saved = raw
  let full = false
  const writes = []
  const announced = []
  const timers = new Map()
  let timerId = 0
  const backing = {
    getItem() { if (unavailable) throw new Error('fixture read unavailable'); return saved },
    setItem(_key, text) { if (full) throw new Error(writeError); saved = text; writes.push(text) },
  }
  const build = new Function('window', 'orgStatusElement', 'createFleetTreeStore', 'safeTreeStorage', 'announced', 'FLEET_TREE_LIMITS', 'NODE_STATUSES', 'timers', 'nextTimer', 'NODE_REMOVE_REFUSALS', 'nodeIsBusy', 'authorityBindings', 'nodeDisplayName', 'treeSlotUsage', 'controlsPage', `
    const { authoritativeTreeSnapshot, authoritativeTreeComputer, createDesktopTreeViewStore } = authorityBindings
    let treeStore = null, treeStoreId = null, treeStoreProblem = '', treeStoreUnsub = null, treeStoreLiveRelease = null
    let transcriptStore = null, diffHistoryStore = null, orgStatusTimer = 0, treePersistenceProblem = '', treePersistenceUnsub = null, orgStatusPrimary = null
    const nodeDiffHistories = new Map(), nodeReplies = new Map()
    const RUN_TREE_RUNTIME_STORES = new Map(), RUN_SESSION_CLEANUPS = new Map(), sessionNodeIds = new Map()
    const RUN_STARTING_TREE_STORES = new Map()
    let currentRailTreeNode = null
    // This in-memory fixture owns exactly the sessions entered through own().
    const nodeBusy = node => nodeIsBusy(node, sessionNodeIds)
    ${source.match(/^const TREE_RUNTIME_NOT_SAVED_TEXT = .+$/m)[0]}
    /* openTreeStore builds its store with the view's OWN seat evidence, which
       withholds the session map until the saved-session sweep has asked the
       host (T407 review). Both lines are injected from the real source for the
       same reason syncRenamedCircles is: a restatement here would stop this
       suite ever noticing that the product's rule had changed underneath it.
       RUN_SESSION_NODES is this fixture's sessionNodeIds, exactly as it is the
       view's own -- the view assigns sessionNodeIds from RUN_SESSION_NODES. */
    const RUN_SESSION_NODES = sessionNodeIds
    ${source.match(/^let runSessionSweepDone = .+$/m)[0]}
    ${source.match(/^const seatSessionEvidence = .+$/m)[0]}
    let sampleRun = null, sampleRunStore = null, sampleRunTimer = 0, sampleChipFrame = 0
    const sampleChips = new Set(), sampleChats = new Map(), sampleSessionText = new Map(), sessionTurnText = new Map()
    let accountRecoveryCoordinator = null
    const currentDataSource = () => 'live'
    const clearTimeout = id => timers.delete(id)
    const clearInterval = id => timers.delete(id)
    const cancelAnimationFrame = id => timers.delete(id)
    const setTimeout = callback => { const id = nextTimer(); timers.set(id, callback); return id }
    const markRefusalCode = (element, refusal) => { element.dataset.refusalCode = refusal?.code || '' }
    const orgReady = () => false
    const roleLabel = role => role
    const roleDisplayFor = role => role
    const drivenComputerCopy = local => local
    const createTranscriptStore = () => null
    const createChatDiffHistoryStore = () => null
    const markTreeStoreLive = () => () => {}
    const syncTreeBranchAddresses = () => {}
    /* T138 (1c8f6d84) gave openTreeStore a watch on the store's own publish:
       syncRenamedCircles() re-registers circles whose CROSS-TREE name is computed
       rather than stored. It reads names and writes nothing this file asserts, but it
       is real product code on the path these tests open, so it is injected here rather
       than faked -- a stand-in would stop this suite ever noticing that the watch had
       begun to throw, which is exactly the failure that brought us here. circleName(),
       namingSignature() and renamedCircles() are exported and pure so they come in as
       themselves, and nodeDisplayName() is bound from src/fleet-trees.js, which this
       file already imports. The two cursors syncRenamedCircles compares across calls
       live in the view, so they are declared here with the view's own initial values. */
    let lastNamingSignature = null, lastComposedNames = new Map()
    ${actual('recoveryCoordinator')}
    ${actual('createTreeRuntimeView')}
    ${actual('setOrgStatus')}
    ${actual('renderOrgStatus')}
    ${actual('reportTreePersistence')}
    ${actual('stopSampleRun')}
    ${actual('releaseTreeStore')}
    ${actual('circleName')}
    ${actual('namingSignature')}
    ${actual('renamedCircles')}
    ${actual('refreshTreeNames')}
    ${actual('treeNodeName')}
    ${actual('syncRenamedCircles')}
    ${actual('slotUsageSentence')}
    ${actual('refreshSlotUsage')}
    ${actual('openTreeStore')}
    return { open: openTreeStore, release: releaseTreeStore, say: setOrgStatus, problem: () => treeStoreProblem,
      showSlots: nodeId => { currentRailTreeNode = treeStore.getNode(nodeId); refreshSlotUsage() },
      own: (sessionId, nodeId) => sessionNodeIds.set(sessionId, nodeId),
      sweptTheHost: () => { runSessionSweepDone = true } }
  `)
  const view = build({ localStorage: backing, mcTreeCommand: { announce: id => { announced.push(id) } } },
    status, createFleetTreeStore, safeTreeStorage, announced, FLEET_TREE_LIMITS, NODE_STATUSES, timers, () => ++timerId, NODE_REMOVE_REFUSALS, nodeIsBusy, computersViewAuthorityBindings(), nodeDisplayName, treeSlotUsage, controlsPage)
  return { ...view, status, slots, writes, announced, backing, timers, saved: () => saved, full: value => { full = value }, restore: () => dom.restore() }
}

test('the actual view treats unreadable trees as unavailable, not an empty usable canvas store', () => {
  for (const config of [{ raw: '{broken' }, { unavailable: true }]) {
    const view = fixture(config)
    try {
      assert.equal(view.open('fixture-computer'), null)
      assert.match(view.problem(), /could not be opened/)
      assert.match(view.problem(), /have not been replaced/)
      assert.match(view.problem(), /Editing and starting agents are unavailable/)
      assert.deepEqual(view.announced, [], 'an unavailable store must not announce a usable tree destination')
      assert.deepEqual(view.writes, [])
      assert.equal(view.saved(), config.raw ?? null)
    } finally { view.restore() }
  }
})

test('an ordinary unsaved draft produces a persistent visible warning without needing to launch an agent', () => {
  const writeError = 'The profile volume is full.'
  const view = fixture({ writeError })
  try {
    const store = view.open('fixture-computer')
    const node = store.addNode({ role: 'worker', message: 'Saved words' }).node
    assert.equal(view.status.textContent, '')
    const savedBefore = view.saved(), writesBefore = view.writes.length
    view.full(true)
    store.updateNode(node.id, { message: 'Still in memory' })
    assert.equal(view.status.hidden, false)
    assert.equal(view.status.dataset.state, 'refuse')
    assert.equal(view.status.textContent, writeError)
    assert.equal(store.snapshot().persistenceFailed, true)
    assert.equal(store.snapshot().persistenceProblem, writeError)
    assert.equal(store.getNode(node.id).message, 'Still in memory')
    assert.equal(view.saved(), savedBefore, 'failed write preserves the last saved bytes')
    assert.equal(view.writes.length, writesBefore)
    const warning = view.status.textContent
    view.say('Saved.', 'ok')
    assert.equal(view.status.textContent, warning, 'a generic success must not conceal the failed save')
    view.say('A separate action was refused.', 'refuse', { sticky: true })
    assert.ok(view.status.textContent.includes('A separate action was refused.'))
    assert.ok(view.status.textContent.includes(warning))
    view.full(false)
    store.renameTree(node.treeId, 'Now saved')
    assert.equal(view.status.hidden, false)
    assert.equal(view.status.textContent, 'A separate action was refused.', 'save recovery removes only the persistence warning, not the independent refusal')
    assert.equal(JSON.parse(view.saved()).nodes[0].message, 'Still in memory')
    assert.equal(store.snapshot().persistenceFailed, false)
  } finally { view.restore() }
})

test('save recovery preserves an independent queued hold and its refusal code', () => {
  const writeError = 'This profile cannot write its saved trees.'
  const view = fixture({ writeError })
  try {
    const store = view.open('fixture-computer')
    const node = store.addNode({ role: 'worker', message: 'Brief.' }).node
    const savedBefore = view.saved(), writesBefore = view.writes.length
    view.full(true)
    store.updateNode(node.id, { message: 'Unsaved brief.' })
    view.say('Waiting for current resource advice.', 'busy', { sticky: true, code: 'AGENT_RESOURCE_CONTROLLER_UNKNOWN' })
    assert.match(view.status.textContent, /Waiting for current resource advice/)
    assert.ok(view.status.textContent.includes(writeError))
    assert.equal(store.snapshot().persistenceFailed, true)
    assert.equal(store.snapshot().persistenceProblem, writeError)
    assert.equal(store.getNode(node.id).message, 'Unsaved brief.')
    assert.equal(view.saved(), savedBefore)
    assert.equal(view.writes.length, writesBefore)
    view.full(false)
    store.renameTree(node.treeId, 'Recovered')
    assert.equal(view.status.textContent, 'Waiting for current resource advice.')
    assert.equal(view.status.dataset.state, 'busy')
    assert.equal(view.status.dataset.refusalCode, 'AGENT_RESOURCE_CONTROLLER_UNKNOWN')
    assert.equal(view.timers.size, 0, 'the original hold was sticky')
    assert.equal(store.snapshot().persistenceFailed, false)
    assert.equal(JSON.parse(view.saved()).nodes[0].message, 'Unsaved brief.')
  } finally { view.restore() }
})

test('a primary-message timer never dismisses an unsaved-tree warning', () => {
  const writeError = 'Storage refused the pending tree update.'
  const view = fixture({ writeError })
  try {
    const store = view.open('fixture-computer')
    const node = store.addNode({ role: 'worker' }).node
    view.say('A short-lived note.', 'info')
    const savedBefore = view.saved(), writesBefore = view.writes.length
    view.full(true)
    store.updateNode(node.id, { message: 'Retained brief.' })
    for (const callback of view.timers.values()) callback()
    assert.equal(view.status.hidden, false)
    assert.equal(view.status.textContent, writeError)
    assert.equal(store.snapshot().persistenceFailed, true)
    assert.equal(store.snapshot().persistenceProblem, writeError)
    assert.equal(store.getNode(node.id).message, 'Retained brief.')
    assert.equal(view.saved(), savedBefore)
    assert.equal(view.writes.length, writesBefore)
    assert.doesNotMatch(view.status.textContent, /short-lived/)
  } finally { view.restore() }
})

test('the actual view keeps the conflict visible and its local tree intact after a refused stale deletion', () => {
  const view = fixture()
  try {
    const older = view.open('fixture-computer')
    const original = older.addNode({ role: 'worker' }).node
    const newer = createFleetTreeStore({ computerId: 'fixture-computer', storage: safeTreeStorage(view.backing) })
    newer.addNode({ role: 'manager' })
    const saved = view.saved()
    assert.equal(older.removeNode(original.id).ok, false)
    assert.equal(view.status.hidden, false)
    assert.match(view.status.textContent, /saved trees changed/i)
    assert.equal(view.saved(), saved)
    assert.ok(older.getNode(original.id))
    view.release()
    assert.equal(view.status.textContent, '')
    assert.equal(view.open('fixture-computer').snapshot().nodes.length, 2)
  } finally { view.restore() }
})

test('the actual runtime view saves the completed native turn identity across reopening', () => {
  const view = fixture()
  try {
    const store = view.open('fixture-computer')
    const node = store.addNode({ role: 'reviewer' }).node
    store.attachSession(node.id, 'native-session')
    view.own('native-session', node.id)
    store.setNodeStatus(node.id, 'running')
    assert.equal(store.setNodeStatus(node.id, 'interrupted', { note: 'Stopped by you.', turnId: 'native-turn-5' }).ok, true)
    assert.equal(store.getNode(node.id).lastTurnId, 'native-turn-5')
    const reopened = createFleetTreeStore({ computerId: 'fixture-computer', storage: safeTreeStorage(view.backing) })
    assert.equal(reopened.getNode(node.id).lastTurnId, 'native-turn-5')
    assert.equal(reopened.getNode(node.id).status, 'interrupted')
  } finally { view.restore() }
})

test('quota recovery retains only valid turn identity and clears it for a replacement session', () => {
  const view = fixture()
  try {
    const store = view.open('fixture-computer')
    const node = store.addNode({ role: 'reviewer' }).node
    store.attachSession(node.id, 'native-session')
    view.own('native-session', node.id)
    store.setNodeStatus(node.id, 'running')
    view.full(true)
    store.setNodeStatus(node.id, 'interrupted', { note: 'Stopped by you.', turnId: 'native-turn-5' })
    assert.equal(store.getNode(node.id).lastTurnId, 'native-turn-5')
    assert.equal(store.snapshot().persistenceFailed, true)
    assert.equal(store.setNodeStatus(node.id, 'cancelled', { turnId: 'bad\nturn' }).ok, false)
    assert.equal(store.getNode(node.id).status, 'interrupted')
    assert.equal(store.getNode(node.id).lastTurnId, 'native-turn-5')
    view.full(false)
    store.setNodeReply(node.id, 'Partial reply retained')
    const reopened = createFleetTreeStore({ computerId: 'fixture-computer', storage: safeTreeStorage(view.backing) })
    assert.equal(reopened.getNode(node.id).lastTurnId, 'native-turn-5')
    view.full(true)
    view.own('replacement-session', node.id)
    store.attachSession(node.id, 'replacement-session')
    assert.equal(store.getNode(node.id).lastTurnId, null)
    view.full(false)
    store.setNodeStatus(node.id, 'running')
    const replaced = createFleetTreeStore({ computerId: 'fixture-computer', storage: safeTreeStorage(view.backing) })
    assert.equal(replaced.getNode(node.id).sessionId, 'replacement-session')
    assert.equal(replaced.getNode(node.id).lastTurnId, undefined)
  } finally { view.restore() }
})

/* T407 protected capacity while host ownership was unknown. T744 keeps every
 * saved child slot after that sweep as well: stopped/disowned children retain
 * their conversations and place. Only an accepted structure change can free a
 * direct slot; this fixture moves a child without deleting any node. */
test('the actual view retains saved child slots through the session sweep and frees capacity only after a structure change', () => {
  const view = fixture()
  try {
    const store = view.open('fixture-computer')
    const top = store.addNode({ role: 'top' }).node
    const children = []
    for (let i = 0; i < TREE_BOUNDS.maxChildren; i += 1) {
      const child = store.addNode({ parentId: top.id, role: `child ${i}` }).node
      children.push(child)
      store.attachSession(child.id, `native-session-${i}`)
      store.setNodeStatus(child.id, 'running')
    }
    const before = store.snapshot().nodes.map(node => node.id)
    assert.equal(store.addNode({ parentId: top.id, role: 'during the reload' }).ok, false,
      'unknown host ownership must not free saved slots')
    view.sweptTheHost()
    assert.equal(store.addNode({ parentId: top.id, role: 'after the sweep' }).ok, false,
      'disowning a still-saved child must not free its reusable slot')
    for (const child of children) store.setNodeStatus(child.id, 'finished')
    assert.equal(store.addNode({ parentId: top.id, role: 'after stopping' }).ok, false,
      'stopping retained children also preserves their slots')
    assert.deepEqual(store.snapshot().nodes.map(node => node.id), before)

    // Supported structure change in this inert, memory-backed fixture only.
    assert.equal(store.moveNode(children[0].id, children[1].id).ok, true)
    assert.equal(store.childrenOf(top.id).length, TREE_BOUNDS.maxChildren - 1)
    assert.deepEqual(store.snapshot().nodes.map(node => node.id), before, 'the moved conversation remains saved')
    assert.equal(store.getNode(children[0].id).sessionId, 'native-session-0')
    assert.equal(store.addNode({ parentId: top.id, role: 'after moving a child' }).ok, true)
    assert.equal(store.childrenOf(top.id).length, TREE_BOUNDS.maxChildren)
  } finally { view.restore() }
})

test('accepted store changes refresh the selected parent direct-slot usage through the actual subscription', () => {
  const view = fixture()
  try {
    const store = view.open('fixture-computer')
    const parent = store.addNode({ role: 'manager' }).node
    view.showSlots(parent.id)
    assert.match(view.slots.textContent, /Direct child slots: 0 /)
    const first = store.addNode({ parentId: parent.id, role: 'worker' }).node
    assert.match(view.slots.textContent, /Direct child slots: 1 /)
    assert.match(view.slots.textContent, /0 stopped · 1 not started/)
    store.addNode({ parentId: first.id, role: 'worker' })
    assert.match(view.slots.textContent, /Direct child slots: 1 /, 'grandchildren do not consume the selected parent’s direct slots')
    store.addNode({ parentId: parent.id, role: 'reviewer' })
    assert.match(view.slots.textContent, /Direct child slots: 2 /)
    assert.match(view.slots.textContent, /0 stopped · 2 not started/)
    store.setNodeStatus(first.id, 'finished')
    assert.match(view.slots.textContent, /1 stopped · 1 not started/, 'runtime status publication refreshes the same selected-parent display')
    assert.equal(view.status.textContent, '')
  } finally { view.restore() }
})
