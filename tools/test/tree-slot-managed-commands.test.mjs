import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
register('./lib/t542-runtime-store-loader.mjs', import.meta.url)
import { FROM_TIER, TO_TIER, runningCircle, busyCircle, sharedBridge, waitFor, startedRequests, pressChosenContinuation, CROSS_ROW } from './lib/t158-switch-model-harness.mjs'
import { continuationRouteFor } from '../../src/switch-and-continue.js'
import { createRequire } from 'node:module'
import path from 'node:path'
import { canonicalRootForTests } from '../canonical-root.mjs'
import { LAUNCH_TIERS } from '../../src/orchestration-controls.js'
import { PERSON_ONLY_SLOT_REASON } from '../../src/managed-slot-choice.js'
import { sharedOrgWindow, liveCase } from './lib/t158-switch-model-harness.mjs'
const require = createRequire(import.meta.url)
const engineRoot = canonicalRootForTests({ warn: () => {} })
const registry = require(path.join(engineRoot, 'src/lib/tool-registry.js'))
const nativeTree = require(path.join(engineRoot, 'src/lib/agent-tree-spawn.js'))
const { createTreeSlotConfigurationAuthority } = require('../../shell/tree-slot-configuration.cjs')

async function choose(ctx, { account, tier } = {}) {
  const chat = ctx.liveChat()
  chat.openActions()
  chat.querySelectorAll('.chat-actions-row').find(row => /Switch and continue/.test(row.textContent)).dispatch('click')
  await waitFor(() => document.body.querySelector('.switch-continue'), 'the mounted switch dialog')
  const dialog = document.body.querySelector('.switch-continue')
  for (const [selector, value] of [['[data-switch-model]', tier], ['[data-switch-account]', account]]) {
    if (!value) continue
    const row = dialog.querySelectorAll(selector).find(input => input.value === value)
    assert.ok(row, 'requested choice is offered')
    assert.equal(row.disabled, false)
    row.checked = true; row.dispatch('change')
  }
  dialog.querySelector('[data-switch-continue]').dispatch('click')
}
function catalog(t) {
  let globalSwitches = 0
  sharedBridge.startableTiers = async () => ({ ok: true, tiers: [FROM_TIER, TO_TIER] })
  const providers = { accounts: async () => ({ ok: true, accounts: [
    { name: 'primary', provider: 'claude', signedIn: true }, { name: 'backup', provider: 'claude', signedIn: true },
  ] }), accountSwitch: async () => { globalSwitches++; return { ok: true, switched: true } } }
  window.mcProviders = globalThis.mcProviders = providers
  t.after(() => { delete sharedBridge.startableTiers; delete globalThis.mcProviders })
  return () => globalSwitches
}
for (const decision of ['apply', 'cancel']) {
  test('mounted account choice ' + decision + ' preserves draft, images and queued identities without a global switch', async t => {
    const outbox = await import('../../src/session-outbox.js')
    const ctx = await busyCircle(t, { replacementStart: async (request, sessionId) => ({ ok: true, sessionId, account: request.treeAccount }) },
      { initialAccount: 'primary' })
    const switches = catalog(t)
    for (const text of ['Queued first.', 'Queued second.']) {
      ctx.liveChat().importDraft({ text, attachments: [] })
      ctx.liveChat().querySelector('.chat-send').dispatch('click')
    }
    await waitFor(() => outbox.list(ctx.OLD_SESSION).length === 2, 'two queued messages')
    const queued = outbox.list(ctx.OLD_SESSION).map(row => ({ id: row.id, text: row.text }))
    const draft = { text: '  Unsaved account-choice draft.  ',
      attachments: [{ path: 'fixture-one.png' }, { path: 'fixture-two.png' }] }
    ctx.liveChat().importDraft(draft)
    await choose(ctx, { account: 'backup' })
    await waitFor(() => /Pending:.*backup/.test(ctx.liveChat().querySelector('.chat-chip-model').textContent), 'visible exact pending account')
    assert.equal(startedRequests(ctx).length, 0)
    assert.equal(switches(), 0)
    assert.equal(ctx.calls.filter(row => row.call === 'close' || row.call === 'interrupt').length, 0)
    if (decision === 'cancel') {
      const chat = ctx.liveChat(); chat.openActions()
      chat.querySelectorAll('.chat-actions-row').find(row => /Switch model/.test(row.textContent)).dispatch('click')
      await waitFor(() => chat.querySelectorAll('.chat-actions-row').some(row => /Keep the model/.test(row.textContent)), 'cancel pending selection')
      chat.querySelectorAll('.chat-actions-row').find(row => /Keep the model/.test(row.textContent)).dispatch('click')
      await waitFor(() => !/Pending:/.test(ctx.liveChat().querySelector('.chat-chip-model').textContent), 'cancelled pending display')
    } else {
      ctx.emit({ sessionId: ctx.OLD_SESSION, event: { type: 'turn_completed', status: 'completed', turnId: 'turn-busy' } })
      await waitFor(() => ctx.readNode().sessionId === ctx.NEW_SESSION, 'selected-account successor')
      await waitFor(() => ctx.calls.filter(row => row.call === 'send').length === 1, 'one context handoff')
      assert.equal(startedRequests(ctx).length, 1)
      assert.equal(startedRequests(ctx)[0].request.treeAccount, 'backup')
    }
    const sessionId = decision === 'apply' ? ctx.NEW_SESSION : ctx.OLD_SESSION
    assert.deepEqual(outbox.list(sessionId).map(row => ({ id: row.id, text: row.text })), queued)
    assert.equal(ctx.liveChat().exportDraft().text, draft.text)
    assert.deepEqual(ctx.liveChat().exportDraft().attachments, draft.attachments)
    assert.equal(ctx.calls.filter(row => row.call === 'interrupt').length, 0)
    assert.equal(switches(), 0)
  })
}
test('mounted default-account conversation can continue on an exact named account', async t => {
  const ctx = await runningCircle(t, { replacementStart: async (request, sessionId) => ({ ok: true, sessionId, account: request.treeAccount }) })
  const switches = catalog(t)
  await choose(ctx, { account: 'backup' })
  await waitFor(() => startedRequests(ctx).length === 1, 'exact account admission')
  assert.equal(startedRequests(ctx)[0].request.treeAccount, 'backup')
  assert.equal(startedRequests(ctx)[0].request.continueFromAccount, undefined)
  assert.equal(switches(), 0)
})
test('provider change carries only an explicit destination account; default-to-named requires handoff', () => {
  const tiers = [{ id: 'one', provider: 'claude' }, { id: 'two', provider: 'codex' }]
  const moved = continuationRouteFor({ savedProvider: 'claude', savedAccount: 'same-name',
    currentTier: 'one', tiers, choice: { tier: 'two' } })
  assert.equal(moved.route, 'handoff')
  assert.equal(moved.account, null)
  const named = continuationRouteFor({ savedProvider: 'claude', savedAccount: null,
    currentTier: 'one', tiers, choice: { tier: 'one', account: 'backup' } })
  assert.equal(named.route, 'handoff')
  assert.equal(named.account, 'backup')
})

function managedCommand(ctx, action, choice) {
  const { store, ownedSessions } = globalThis[Symbol.for('toolsenabled.test.t542.runtime-stores')].get(ctx.COMPUTER_ID)
  const parentId = ctx.NODE_ID + '-manager', parentSessionId = ctx.OLD_SESSION + '-manager'
  let parent = store.getNode(parentId)
  if (!parent) {
    const added = store.addNode({ reservedNodeId: parentId, role: 'manager', message: 'Manage existing slots.' })
    assert.equal(added.ok, true)
    parent = added.node
    assert.equal(store.attachSession(parent.id, parentSessionId).ok, true)
    ownedSessions.set(parentSessionId, parent.id)
    assert.equal(store.moveNode(ctx.NODE_ID, parent.id).ok, true)
  }
  return { computerId: ctx.COMPUTER_ID, treeId: store.getNode(ctx.NODE_ID).treeId,
    nodeId: ctx.NODE_ID, expectedSessionId: store.getNode(ctx.NODE_ID).sessionId,
    parentSessionId, action, choice }
}
/* 1.0.50 REVIEW, ACCOUNTS A. This test used to show a Manager moving its busy
   worker onto the person's 'backup' account at the next turn boundary. That is
   the automatic switching 1.0.50 removed: an agent's account command is now
   refused by the view itself (as well as by the main process, below), and
   nothing moves when the busy turn ends. The person's own Switch and continue
   (the mounted account choice tests above) and the owner's coordinator spool
   (the stopped-slot test below) still choose an account. */
test('an agent account command is refused by the view and nothing moves when the busy turn ends', async t => {
  const ctx = await busyCircle(t, { replacementStart: async (request, sessionId) => ({ ok: true, sessionId, account: request.treeAccount }) },
    { initialAccount: 'primary' })
  const switches = catalog(t)
  const command = managedCommand(ctx, 'set-node-account', 'backup')
  const answer = await ctx.view.runTreeNodeCommand(command)
  assert.equal(answer.ok, false, 'an agent cannot choose another account for its worker')
  assert.equal(answer.status, 'refused')
  assert.equal(answer.code, 'TREE_CONFIGURATION_REFUSED')
  assert.equal(answer.reason, PERSON_ONLY_SLOT_REASON)
  assert.equal(startedRequests(ctx).length, 0)
  ctx.emit({ sessionId: ctx.OLD_SESSION, event: { type: 'turn_completed', status: 'completed', turnId: 'turn-busy' } })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(startedRequests(ctx).length, 0, 'no session was started on another account at the turn boundary')
  assert.equal(ctx.readNode().id, ctx.NODE_ID)
  assert.equal(ctx.readNode().sessionId, ctx.OLD_SESSION)
  assert.notEqual(ctx.readNode().accountChoice?.name, 'backup', 'the refused account was not saved for the next start either')
  assert.equal(switches(), 0)
})
test('an agent provider command is refused; the person can still continue the same slot elsewhere', async t => {
  const ctx = await runningCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId }) },
    { initialAccount: 'primary' })
  catalog(t)
  const answer = await ctx.view.runTreeNodeCommand(managedCommand(ctx, 'set-node-provider', 'codex'))
  assert.equal(answer.ok, false, 'a provider-only command cannot choose an account')
  assert.equal(answer.reason, PERSON_ONLY_SLOT_REASON, 'an agent cannot move its worker to another provider account either')
  assert.equal(startedRequests(ctx).length, 0)
  assert.equal(ctx.readNode().tier, FROM_TIER)
  assert.equal(ctx.readNode().sessionId, ctx.OLD_SESSION)
  const choice = await pressChosenContinuation(ctx, CROSS_ROW)
  await waitFor(() => ctx.readNode().sessionId === ctx.NEW_SESSION, 'explicit account continuation')
  assert.equal(ctx.readNode().id, ctx.NODE_ID)
  assert.equal(ctx.readNode().tier, TO_TIER)
  assert.equal(startedRequests(ctx)[0].request.treeAccount, choice.account)
  assert.notEqual(choice.account, 'primary', 'the source provider account is never borrowed')
})

function actualFunction(ctx, t, field, value, { grants = ['agent.set_' + field], nodeId = ctx.NODE_ID } = {}) {
  const command = managedCommand(ctx, 'set-node-' + field, value)
  const { store } = globalThis[Symbol.for('toolsenabled.test.t542.runtime-stores')].get(ctx.COMPUTER_ID)
  const parent = store.getNode(ctx.NODE_ID + '-manager')
  // The host's real parent shape (agent-host.cjs readTreeParent): anchors from the top circle down, treeId = anchors[0].
  const anchors = []
  for (let node = parent; node; node = node.parentId ? store.getNode(node.parentId) : null) anchors.unshift(node.id)
  const authority = createTreeSlotConfigurationAuthority({
    readParent: id => id === command.parentSessionId ? { nodeId: parent.id, treeId: anchors[0], treeAnchors: anchors,
      owner: 'synthetic-owner', permissionSession: { origin: 'local', tier: 'full' } } : null,
    readForest: () => store.snapshot(),
    readSessionOwner: () => 'synthetic-owner',
  })
  nativeTree.clearTreeSpawnHost()
  nativeTree.installTreeSpawnHost({
    isTreeSession: id => id === command.parentSessionId,
    spawn: async () => { assert.fail('configuration must never create a sibling slot') },
    command: request => {
      const target = authority.admit({ ...request, computerId: ctx.COMPUTER_ID })
      return ctx.view.runTreeNodeCommand({ ...request, ...target, computerId: ctx.COMPUTER_ID })
    },
  })
  t.after(() => nativeTree.clearTreeSpawnHost())
  return registry.executeTool('agent.set_' + field, { nodeId, expectedSessionId: store.getNode(nodeId)?.sessionId || undefined, [field]: value },
    { agentRole: { functions: grants, requiresDirectUserAuthorization: false },
      agentPrincipal: { kind: 'agent-session', sessionId: command.parentSessionId, roleId: 'manager' },
      permissionSession: { origin: 'local', tier: 'full' } })
}
test('actual model role function reaches the mounted same-slot model application', async t => {
  const ctx = await runningCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId }) })
  sharedBridge.startableTiers = async () => ({ ok: true, tiers: [FROM_TIER, 'claude-opus'] })
  t.after(() => { delete sharedBridge.startableTiers })
  const answer = await actualFunction(ctx, t, 'model', 'claude-opus')
  assert.equal(answer.ok, true, answer.reason)
  assert.equal(answer.status, 'applied')
  assert.equal(answer.applied.tier, 'claude-opus')
  assert.equal(ctx.readNode().id, ctx.NODE_ID)
  assert.equal(ctx.readNode().tier, 'claude-opus')
  assert.equal(startedRequests(ctx)[0].request.tier, 'claude-opus')
})
test('actual effort role function uses confirmed model choices and retains account-local selection', async t => {
  const ctx = await runningCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId, effort: 'high', account: 'primary' }) },
    { initialAccount: 'primary' })
  const model = LAUNCH_TIERS.find(row => row.id === FROM_TIER).model
  sharedBridge.models = async () => ({ catalogSupported: true, provider: 'claude',
    models: [{ id: model, efforts: [{ id: 'medium' }, { id: 'high' }] }] })
  t.after(() => { delete sharedBridge.models })
  const answer = await actualFunction(ctx, t, 'effort', 'high')
  assert.equal(answer.ok, true, answer.reason)
  assert.equal(answer.status, 'applied')
  assert.equal(answer.applied.effort, 'high')
  assert.equal(startedRequests(ctx)[0].request.effort, 'high')
  assert.equal(startedRequests(ctx)[0].request.treeAccount, 'primary')
  assert.equal(ctx.readNode().id, ctx.NODE_ID)
})
test('separately enabled role function saves the role and truthfully keeps the running binding pending', async t => {
  const ctx = await runningCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId }) })
  sharedOrgWindow.assignRole = request => liveCase.org.assignRole(request)
  t.after(() => { delete sharedOrgWindow.assignRole })
  const answer = await actualFunction(ctx, t, 'role', 'worker')
  assert.equal(answer.ok, true, answer.reason)
  assert.equal(answer.status, 'pending')
  assert.equal(answer.pending.when, 'next-session')
  assert.equal(answer.applied.role, 'builder')
  assert.equal(ctx.readNode().role, 'worker')
  assert.equal(ctx.org.read().org.agents.find(row => row.id === ctx.NODE_ID).role, 'worker')
  assert.deepEqual(ctx.readNode().roleBindingPending, { sessionId: ctx.OLD_SESSION, role: 'builder' })
  const again = await actualFunction(ctx, t, 'role', 'worker')
  assert.equal(again.status, 'pending', 'a saved choice is not an applied running binding')
  assert.equal(again.applied.role, 'builder')
  assert.equal(ctx.readNode().sessionId, ctx.OLD_SESSION)
  assert.equal(startedRequests(ctx).length, 0)
  assert.equal(ctx.calls.filter(row => row.call === 'close' || row.call === 'interrupt').length, 0)
})
/* 1.0.50 REVIEW, ACCOUNTS A, through the real tool. A Manager that holds the
   agent.set_account grant calls it for its worker: the engine dispatches it, the
   main-process authority refuses it, and the worker keeps its account. */
test('actual account function is refused for an agent holding the grant, and the worker keeps its account', async t => {
  const ctx = await runningCircle(t, { replacementStart: async (request, sessionId) => ({ ok: true, sessionId, account: request.treeAccount }) },
    { initialAccount: 'primary' })
  const switches = catalog(t)
  await assert.rejects(actualFunction(ctx, t, 'account', 'backup'),
    { code: 'TREE_CONFIGURATION_REFUSED', message: /^Only the person can move an agent to another account or provider\./ })
  assert.equal(startedRequests(ctx).length, 0)
  assert.equal(ctx.readNode().sessionId, ctx.OLD_SESSION)
  assert.notEqual(ctx.readNode().accountChoice?.name, 'backup')
  assert.equal(switches(), 0)
})
test('user-disabled functions refuse before changing a mounted slot', async t => {
  const ctx = await runningCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId }) })
  await assert.rejects(actualFunction(ctx, t, 'account', 'backup', { grants: [] }), { code: 'TOOL_NOT_ENABLED' })
  assert.equal(startedRequests(ctx).length, 0)
  assert.equal(ctx.readNode().accountChoice, undefined)
})
test('actual configuration function refuses its own parent and unsupported provider choices', async t => {
  const ctx = await runningCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId }) })
  catalog(t)
  managedCommand(ctx, 'set-node-provider', 'codex')
  await assert.rejects(actualFunction(ctx, t, 'provider', 'codex', { nodeId: ctx.NODE_ID + '-manager' }),
    { code: 'TREE_CONFIGURATION_REFUSED' })
  /* Since 1.0.50 every provider change an agent asks for is refused by the
     main-process authority, before its value is even looked at. */
  await assert.rejects(actualFunction(ctx, t, 'provider', 'not-a-provider'),
    { code: 'TREE_CONFIGURATION_REFUSED', message: /provider/i })
  assert.equal(startedRequests(ctx).length, 0)
})

test('cancelled queued role assignment restores only its own assignment and starts nothing', async t => {
  const ctx = await busyCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId }) })
  let release, reached = false, first = true, restored = false
  const held = new Promise(resolve => { release = resolve })
  sharedOrgWindow.assignRole = async request => {
    if (first) { first = false; reached = true; await held }
    const result = liveCase.org.assignRole(request)
    if (request.role === 'builder') restored = true
    return result
  }
  t.after(() => { release(); delete sharedOrgWindow.assignRole })
  const answer = await actualFunction(ctx, t, 'role', 'worker')
  assert.equal(answer.status, 'pending')
  ctx.emit({ sessionId: ctx.OLD_SESSION, event: { type: 'turn_completed', status: 'completed', turnId: 'turn-busy' } })
  await waitFor(() => reached, 'pending role assignment')
  const chat = ctx.liveChat(); chat.openActions()
  chat.querySelectorAll('.chat-actions-row').find(row => /Switch model/.test(row.textContent)).dispatch('click')
  await waitFor(() => chat.querySelectorAll('.chat-actions-row').some(row => /Keep the model/.test(row.textContent)), 'cancel role choice')
  chat.querySelectorAll('.chat-actions-row').find(row => /Keep the model/.test(row.textContent)).dispatch('click')
  release()
  await waitFor(() => restored, 'assignment and conditional restore')
  assert.equal(ctx.org.read().org.agents.find(row => row.id === ctx.NODE_ID).role, 'builder')
  assert.equal(ctx.readNode().role, 'builder')
  assert.equal(ctx.readNode().sessionId, ctx.OLD_SESSION)
  assert.equal(startedRequests(ctx).length, 0)
  assert.equal(ctx.calls.filter(row => row.call === 'close' || row.call === 'interrupt').length, 0)
})
test('stopped slot account preference persists and Resume uses it without allocating a sibling', async t => {
  const ctx = await runningCircle(t, { replacementStart: async (request, sessionId) => ({ ok: true, sessionId, account: request.treeAccount }) },
    { initialAccount: 'primary' })
  const switches = catalog(t)
  const command = managedCommand(ctx, 'set-node-account', 'backup')
  const stopped = await ctx.view.runTreeNodeCommand({ ...command, action: 'stop-node' })
  assert.equal(stopped.ok, true)
  const { store } = globalThis[Symbol.for('toolsenabled.test.t542.runtime-stores')].get(ctx.COMPUTER_ID)
  const beforeIds = store.snapshot().nodes.map(node => node.id).sort()
  const ownerCommand = { ...command, parentSessionId: null, expectedSessionId: ctx.readNode().sessionId }
  const refused = await ctx.view.runTreeNodeCommand({ ...ownerCommand, choice: 'not-registered' })
  assert.equal(refused.ok, false, 'the owner spool cannot select an unregistered account')
  const stale = await ctx.view.runTreeNodeCommand({ ...ownerCommand, expectedSessionId: 'stale-session' })
  assert.equal(stale.code, 'MC_TREE_COMMAND_SESSION_CHANGED')
  assert.equal(startedRequests(ctx).length, 0)
  assert.equal(ctx.readNode().accountChoice?.name === 'backup', false, 'refusals do not save the requested account')
  const configured = await ctx.view.runTreeNodeCommand(ownerCommand)
  assert.equal(configured.ok, true, configured.reason)
  assert.equal(configured.status, 'pending')
  assert.equal(configured.pending.when, 'next-start')
  assert.equal(configured.applied, null)
  assert.equal(startedRequests(ctx).length, 0)
  assert.deepEqual(ctx.readNode().accountChoice, { provider: 'claude', name: 'backup' })
  const resumed = await ctx.view.runTreeNodeCommand({ ...managedCommand(ctx, 'set-node-account', 'backup'), action: 'resume-node' })
  assert.equal(resumed.ok, true, resumed.reason)
  assert.equal(startedRequests(ctx)[0].request.treeAccount, 'backup')
  assert.equal(ctx.readNode().id, ctx.NODE_ID)
  assert.deepEqual(store.snapshot().nodes.map(node => node.id).sort(), beforeIds)
  assert.equal(switches(), 0)
})

test('actual provider function refuses default account substitution and keeps the current provider', async t => {
  const ctx = await runningCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId, account: 'destination-account' }) },
    { initialAccount: 'primary' })
  catalog(t)
  await assert.rejects(actualFunction(ctx, t, 'provider', 'codex'),
    { code: 'TREE_CONFIGURATION_REFUSED', message: /^Only the person can move an agent to another account or provider\./ },
    'a provider-only function cannot authorize a destination account')
  assert.equal(startedRequests(ctx).length, 0, 'native default selection is never attempted')
  assert.equal(ctx.readNode().sessionId, ctx.OLD_SESSION)
  assert.equal(ctx.readNode().tier, FROM_TIER)
})

test('mounted direct-slot counts retain stopped children and distinguish them from idle sessions', async t => {
  const ctx = await runningCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId }) })
  const { store } = globalThis[Symbol.for('toolsenabled.test.t542.runtime-stores')].get(ctx.COMPUTER_ID)
  const frames = new Set()
  const priorFrame = globalThis.requestAnimationFrame, priorCancel = globalThis.cancelAnimationFrame
  globalThis.requestAnimationFrame = callback => {
    const timer = setTimeout(() => { frames.delete(timer); callback(performance.now()) }, 0)
    frames.add(timer); return timer
  }
  globalThis.cancelAnimationFrame = timer => { clearTimeout(timer); frames.delete(timer) }
  t.after(() => {
    for (const timer of frames) clearTimeout(timer)
    globalThis.requestAnimationFrame = priorFrame; globalThis.cancelAnimationFrame = priorCancel
  })
  const child = store.addNode({ parentId: ctx.NODE_ID, role: 'worker', message: 'Keep this child slot.' }).node
  store.attachSession(child.id, 'ended-child')
  store.setNodeStatus(child.id, 'finished')
  const row = ctx.view.el.querySelector('[data-direct-slot-usage]')
  assert.ok(row)
  assert.match(row.textContent, /Direct child slots: 1 of 4/)
  assert.match(row.textContent, /0 busy · 0 idle · 1 stopped · 0 not started/)
  const draft = store.addNode({ parentId: ctx.NODE_ID, role: 'worker', message: 'Next task.' }).node
  assert.match(row.textContent, /Direct child slots: 2 of 4/)
  assert.match(row.textContent, /1 stopped · 1 not started/)
  assert.equal(store.getNode(child.id).sessionId, 'ended-child')
  assert.ok(store.getNode(draft.id))
})

test('effort function reports the depth actually returned by admission', async t => {
  const ctx = await runningCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId, effort: 'max' }) })
  const model = LAUNCH_TIERS.find(row => row.id === FROM_TIER).model
  sharedBridge.models = async () => ({ catalogSupported: true, provider: 'claude',
    models: [{ id: model, efforts: [{ id: 'medium' }, { id: 'ultra' }] }] })
  t.after(() => { delete sharedBridge.models })
  const answer = await actualFunction(ctx, t, 'effort', 'ultra')
  assert.equal(answer.ok, true, answer.reason)
  assert.equal(answer.status, 'applied')
  assert.equal(answer.requested.effort, 'ultra')
  assert.equal(answer.applied.effort, 'max')
})

test('stopped Claude slot accepts the existing launch effort choices without a live catalog', async t => {
  const ctx = await runningCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId, effort: 'high' }) })
  const command = managedCommand(ctx, 'set-node-effort', 'high')
  assert.equal((await ctx.view.runTreeNodeCommand({ ...command, action: 'stop-node' })).ok, true)
  const answer = await actualFunction(ctx, t, 'effort', 'high')
  assert.equal(answer.ok, true, answer.reason)
  assert.equal(answer.status, 'pending')
  assert.equal(answer.pending.when, 'next-start')
  assert.equal(answer.applied, null)
  assert.equal(ctx.readNode().effort, 'high')
  assert.equal(startedRequests(ctx).length, 0)
  const invalid = await actualFunction(ctx, t, 'effort', 'unsupported-depth')
  assert.equal(invalid.ok, false)
  assert.equal(ctx.readNode().effort, 'high')
})
