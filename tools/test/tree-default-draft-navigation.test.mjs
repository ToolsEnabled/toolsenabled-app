import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { fleetTreesStorageKey } from '../../src/fleet-trees.js'
import { createTranscriptStore } from '../../src/session-transcript-store.js'
import { enqueue, list as queued, clearSession } from '../../src/session-outbox.js'

register('./helpers/css-stub-loader.mjs', import.meta.url)
const { installWorld, fleetFetch, seedTreeNode, mountView, settle, COMPUTER_ID } = await import('./lib/tree-command-real-mount.mjs')

let sequence = 0
const textOf = chat => chat.querySelector('.chat-input input')

// The actual computersView and StaticTreeGraph, opened through their default
// node click. Only DOM, storage and provider IPC are substitutes. This is a
// route-remount regression, not native/browser acceptance.
async function fixture(t, { extraComputerId = null } = {}) {
  const ordinal = ++sequence, primaryComputerId = `${COMPUTER_ID}-draft-${ordinal}`
  let computerId = primaryComputerId
  const world = await installWorld({ fetch: async url => {
    const response = await fleetFetch({ computerId }).fetch(url)
    if (url !== '/data/fleet.json' || !extraComputerId) return response
    const projection = await response.json()
    projection.data.computers.push({ ...projection.data.computers[0], id: extraComputerId, label: 'Other draft computer' })
    return { ...response, json: async () => projection }
  } })
  const elementPrototype = Object.getPrototypeOf(document.body)
  const missingPopover = typeof elementPrototype.showPopover !== 'function'
  if (missingPopover) elementPrototype.showPopover = function() { this.hidden = false }
  const missingSelection = typeof elementPrototype.setSelectionRange !== 'function'
  if (missingSelection) elementPrototype.setSelectionRange = function(start, end) { this.selectionStart = start; this.selectionEnd = end }
  const computedStyle = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle')
  globalThis.getComputedStyle = element => window.getComputedStyle(element)
  const nodeId = `default-draft-${ordinal}`, sessionId = `default-session-${ordinal}`
  const views = new Set(), sessions = new Set([sessionId]), calls = []
  let send = async () => ({ turnId: `accepted-${sequence}` })
  world.storage.setItem('mc.set.tree_style', 'boxes')
  world.bridge.send = async request => { calls.push(['send', request]); return send(request) }
  world.bridge.start = async request => { calls.push(['start', request]); throw new Error('This draft test must not start an agent.') }
  world.bridge.pickAttachment = async request => { calls.push(['attachment', request]); return { ok: true, path: '/fixture/default-draft.png' } }
  seedTreeNode(world.storage, { nodeId, sessionId, status: 'finished', computerId: primaryComputerId })
  const dispose = view => { view.destroy(); view.el.remove(); views.delete(view) }
  const mount = async (selected = primaryComputerId) => {
    computerId = selected
    const view = await mountView(world, { computerId }); views.add(view)
    return view
  }
  const open = async (view, id = nodeId) => {
    const node = [...view.el.querySelectorAll('.static-tree-node')].find(item => item.dataset.agentId === id)
    assert.ok(node, `actual graph must display ${id}`)
    node.dispatch('dblclick'); await settle(6)
    const panel = [...view.el.querySelectorAll('.tree-conversation')].find(item => item.dataset.agentId === id)
    assert.ok(panel, 'actual node double-click must open the default conversation')
    const chat = panel.querySelector('.chat'), input = textOf(chat)
    assert.equal(Boolean(input.disabled), false, 'the default input must be enabled')
    return { node, panel, chat, input }
  }
  const seed = (id, session, selected = primaryComputerId) => {
    sessions.add(session)
    const key = fleetTreesStorageKey(selected), before = world.storage.getItem(key)
    const older = before ? JSON.parse(before) : null
    const treeId = older?.nodes.find(node => node.id === id)?.treeId || `tree-${id}`
    seedTreeNode(world.storage, { nodeId: id, treeId, sessionId: session, status: 'finished', computerId: selected })
    if (before) {
      const newer = JSON.parse(world.storage.getItem(key))
      newer.nodes.push(...older.nodes.filter(node => node.id !== id))
      newer.trees.push(...older.trees.filter(tree => tree.id !== treeId))
      world.storage.setItem(key, JSON.stringify(newer))
    }
  }
  t.after(() => {
    for (const view of views) dispose(view)
    for (const session of sessions) clearSession(session)
    world.restore()
    if (missingPopover) delete elementPrototype.showPopover
    if (missingSelection) delete elementPrototype.setSelectionRange
    if (computedStyle) Object.defineProperty(globalThis, 'getComputedStyle', computedStyle)
    else delete globalThis.getComputedStyle
  })
  return { world, computerId: primaryComputerId, nodeId, sessionId, calls, dispose, mount, open, seed, setSend: next => { send = next } }
}

test('actual default node chat retains whitespace, attachments and selection across computersView destroy/remount', async t => {
  const f = await fixture(t), first = await f.mount(), opened = await f.open(first)
  opened.input.value = '  Keep this local unsent Page 2 draft.  '
  opened.input.setSelectionRange(3, 14); opened.input.dispatch('input')
  opened.chat.querySelector('[data-chat-attach]').click(); await settle(4)
  const draft = opened.chat.exportDraft()
  assert.equal(draft.attachments.length, 1)
  f.dispose(first)
  const restored = await f.open(await f.mount())
  assert.deepEqual(restored.chat.exportDraft(), draft)
  assert.equal(restored.chat.querySelectorAll('.chat-attachment-chip').length, 1)
  assert.equal(f.calls.some(([kind]) => kind === 'send' || kind === 'start'), false)
})

test('clearing a restored default draft consumes its earlier handoff', async t => {
  const f = await fixture(t), first = await f.mount()
  ;(await f.open(first)).input.value = 'Erase these words'
  f.dispose(first)
  const second = await f.mount(), restored = await f.open(second)
  assert.equal(restored.input.value, 'Erase these words')
  restored.input.value = ''; restored.input.dispatch('input')
  f.dispose(second)
  assert.equal((await f.open(await f.mount())).input.value, '')
  assert.equal(f.calls.length, 0)
})

test('sending the restored default draft consumes text and attachments exactly once', async t => {
  const f = await fixture(t), first = await f.mount(), opened = await f.open(first)
  opened.input.value = 'Send this restored draft once'
  opened.chat.querySelector('[data-chat-attach]').click(); await settle(4)
  f.dispose(first)
  const second = await f.mount(), restored = await f.open(second)
  assert.equal(restored.input.value, 'Send this restored draft once')
  restored.chat.querySelector('.chat-send').click(); await settle(15)
  const sent = f.calls.filter(([kind]) => kind === 'send')
  assert.equal(sent.length, 1)
  assert.equal(sent[0][1].sessionId, f.sessionId)
  assert.equal(sent[0][1].text, 'Send this restored draft once')
  assert.deepEqual(sent[0][1].images, [{ path: '/fixture/default-draft.png' }])
  assert.equal(restored.input.value, '')
  f.dispose(second)
  const final = await f.open(await f.mount())
  assert.equal(final.input.value, ''); assert.deepEqual(final.chat.exportDraft().attachments, [])
  assert.equal(f.calls.filter(([kind]) => kind === 'send').length, 1)
})

test('default drafts remain separate for two nodes and for the same node ID on another computer', async t => {
  const f = await fixture(t), secondId = `${f.nodeId}-second`, otherComputer = 'other-draft-computer'
  f.seed(secondId, `${f.sessionId}-second`)
  f.seed(f.nodeId, `${f.sessionId}-other`, otherComputer)
  const first = await f.mount()
  ;(await f.open(first)).input.value = 'First node draft'
  const second = await f.open(first, secondId); assert.equal(second.input.value, '')
  second.input.value = 'Second node draft'
  f.dispose(first)
  const other = await f.mount(otherComputer), otherNode = await f.open(other)
  assert.equal(otherNode.input.value, '')
  otherNode.input.value = 'Other computer draft'; f.dispose(other)
  const returned = await f.mount()
  assert.equal((await f.open(returned)).input.value, 'First node draft')
  assert.equal((await f.open(returned, secondId)).input.value, 'Second node draft')
  f.dispose(returned)
  assert.equal((await f.open(await f.mount(otherComputer))).input.value, 'Other computer draft')
  assert.equal(f.calls.length, 0)
})

test('the same node keeps its unsent intent across session replacement and sends only to the replacement', async t => {
  const f = await fixture(t), first = await f.mount()
  ;(await f.open(first)).input.value = 'For this agent after restart'
  f.dispose(first)
  const replacement = `${f.sessionId}-replacement`
  f.seed(f.nodeId, replacement)
  const restored = await f.open(await f.mount())
  assert.equal(restored.input.value, 'For this agent after restart')
  restored.chat.querySelector('.chat-send').click(); await settle(15)
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'send').map(([, request]) => request.sessionId), [replacement])
  assert.equal(f.calls.some(([kind]) => kind === 'start'), false)
})

test('an account refusal preserves the restored draft without starting or selecting a fallback account', async t => {
  const f = await fixture(t)
  const transcripts = createTranscriptStore({ computerId: f.computerId, storage: {
    read: key => JSON.parse(f.world.storage.getItem(key) || 'null'), write: (key, value) => { f.world.storage.setItem(key, JSON.stringify(value)); return true },
  } })
  transcripts.save(f.nodeId, { lines: [{ who: 'you', text: 'Saved history', at: 1 }], threadId: 'original-account-thread', account: 'original-fixture-account' })
  const first = await f.mount(), opened = await f.open(first)
  opened.input.value = 'Keep after account refusal'
  opened.chat.querySelector('[data-chat-attach]').click(); await settle(4)
  f.dispose(first)
  f.setSend(async () => { throw Object.assign(new Error('AGENT_RESUME_ACCOUNT_SIGNED_OUT'), { code: 'AGENT_RESUME_ACCOUNT_SIGNED_OUT' }) })
  const second = await f.mount(), restored = await f.open(second)
  restored.chat.querySelector('.chat-send').click(); await settle(15)
  assert.equal(restored.input.value, 'Keep after account refusal')
  assert.equal(restored.chat.exportDraft().attachments.length, 1)
  f.dispose(second)
  const final = await f.open(await f.mount())
  assert.equal(final.input.value, 'Keep after account refusal')
  assert.equal(final.chat.exportDraft().attachments.length, 1)
  assert.equal(transcripts.get(f.nodeId).account, 'original-fixture-account')
  assert.equal(transcripts.get(f.nodeId).threadId, 'original-account-thread')
  assert.equal(f.calls.filter(([kind]) => kind === 'send').length, 1)
  assert.equal(f.calls.some(([kind]) => kind === 'start'), false)
})

test('a recalled queued message does not become a new default draft after route remount', async t => {
  const f = await fixture(t), first = await f.mount(), opened = await f.open(first)
  assert.equal(enqueue(f.sessionId, 'Already in the session queue').ok, true)
  opened.input.dispatch('keydown', { key: 'ArrowUp' })
  assert.equal(opened.input.value, 'Already in the session queue')
  assert.equal(opened.chat.exportDraft(), null)
  f.dispose(first)
  assert.equal((await f.open(await f.mount())).input.value, '')
  assert.deepEqual(queued(f.sessionId).map(row => row.text), ['Already in the session queue'])
  assert.equal(f.calls.length, 0)
})

test('opening an empty Details rail cannot steal an unsent default conversation draft', async t => {
  const f = await fixture(t), first = await f.mount(), opened = await f.open(first)
  opened.input.value = 'Keep the default conversation draft'
  // Side controls open from a card press or Shift+Enter; a double click opens the conversation.
  opened.node.dispatch('keydown', { key: 'Enter', shiftKey: true }); await settle(8)
  const rail = first.el.querySelector('[data-rail-chat-host] .chat')
  assert.ok(rail, 'the actual Details rail chat is mounted concurrently')
  f.dispose(first)
  assert.equal((await f.open(await f.mount())).input.value, 'Keep the default conversation draft')
  assert.equal(f.calls.length, 0)
})

for (const pending of [false, true]) test(`an adopted standalone chat retains its node-owned draft when page teardown ${pending ? 'precedes' : 'follows'} the adoption acknowledgment`, async t => {
  const f = await fixture(t), listeners = new Set()
  let finishAdoption
  f.world.storage.setItem('mc.write.agent-session', 'enabled')
  f.world.storage.setItem('mc.tree.standalone-notice.v1', 'true')
  f.world.bridge.availability = async () => ({ ok: true })
  f.world.bridge.confinement = async () => ({ ok: true, tier: 'standard' })
  f.world.bridge.interrupt = async request => { f.calls.push(['interrupt', request]); return { ok: true } }
  f.world.bridge.onEvent = listener => { listeners.add(listener); return () => listeners.delete(listener) }
  f.world.bridge.start = async request => {
    f.calls.push(['start', request])
    return { sessionId: request.sessionId, threadId: 'adopted-thread', account: 'adopted-fixture-account' }
  }
  f.world.bridge.close = async request => { f.calls.push(['close', request]); return { closed: true } }
  f.world.bridge.adoptTreeAddress = async request => {
    f.calls.push(['adopt', request])
    if (pending) await new Promise(resolve => { finishAdoption = resolve })
    return { ok: true, sessionId: request.sessionId, nodeId: request.requestKeys.threadId,
      treeKey: request.treeKey, threadId: 'adopted-thread', account: 'adopted-fixture-account' }
  }
  const first = await f.mount()
  assert.ok([...first.el.querySelectorAll('.static-tree-node')].some(node => node.dataset.agentId === f.nodeId), first.el.textContent)
  first.el.querySelector('.tree-chat-add').click()
  first.el.querySelector('.tree-new-agent').click()
  first.el.querySelector('.tree-agent-continue').click(); await settle(8)
  const standalone = first.el.querySelector('.tree-standalone-agent .chat')
  assert.ok(standalone, 'the actual New agent control opens its standalone composer')
  textOf(standalone).value = 'An existing standalone task'
  standalone.querySelector('.chat-send').click(); await settle(12)
  const sessionId = f.calls.find(([kind]) => kind === 'start')?.[1].sessionId
  assert.ok(sessionId)
  for (const listener of listeners) listener({ sessionId, event: { type: 'turn_completed', status: 'completed', turnId: `accepted-${sequence}` } })
  const draft = { text: '  Follow up after this agent joins the tree  ', attachments: [{ path: '/fixture/adopted-draft.png', name: 'adopted-draft.png' }], start: 4, end: 13 }
  standalone.importDraft(draft)
  const expected = standalone.exportDraft()
  first.el.querySelector('.tree-standalone-place').click()
  first.el.querySelector('.tree-standalone-place-confirm').click(); await settle(10)
  const adoption = f.calls.find(([kind]) => kind === 'adopt')?.[1]
  assert.ok(adoption, `the actual Place control must acknowledge the running session’s new tree address: ${first.el.querySelector('.tree-standalone-placement-status')?.textContent}; ${standalone.textContent}`)
  const nodeId = adoption.requestKeys.threadId
  assert.notEqual(nodeId, f.nodeId)
  assert.deepEqual(standalone.exportDraft(), expected)
  f.dispose(first)
  if (pending) { finishAdoption(); await settle(30) }
  assert.equal(f.calls.some(([kind]) => kind === 'close'), false, 'teardown cannot close the adopted tree session')
  const returned = await f.open(await f.mount(), nodeId)
  assert.deepEqual(returned.chat.exportDraft(), expected)
  assert.equal(f.calls.filter(([kind]) => kind === 'start').length, 1)
  assert.equal(f.calls.filter(([kind]) => kind === 'send').length, 1)
})

function standaloneBridge(f, { holdAdoption = false } = {}) {
  const listeners = new Set()
  let finishAdoption
  f.world.storage.setItem('mc.write.agent-session', 'enabled')
  f.world.storage.setItem('mc.tree.standalone-notice.v1', 'true')
  f.world.bridge.availability = async () => ({ ok: true })
  f.world.bridge.confinement = async () => ({ ok: true, tier: 'standard' })
  f.world.bridge.onEvent = listener => { listeners.add(listener); return () => listeners.delete(listener) }
  f.world.bridge.start = async request => {
    f.calls.push(['start', request])
    return { sessionId: request.sessionId, threadId: 'rail-rebind-thread', account: 'rail-rebind-account' }
  }
  f.world.bridge.close = async request => { f.calls.push(['close', request]); return { closed: true } }
  f.world.bridge.interrupt = async request => { f.calls.push(['interrupt', request]); return { ok: true } }
  f.world.bridge.adoptTreeAddress = async request => {
    f.calls.push(['adopt', request])
    if (holdAdoption) await new Promise(resolve => { finishAdoption = resolve })
    return { ok: true, sessionId: request.sessionId, nodeId: request.requestKeys.threadId,
      treeKey: request.treeKey, threadId: 'rail-rebind-thread', account: 'rail-rebind-account' }
  }
  return {
    emit(sessionId, event) { for (const listener of listeners) listener({ sessionId, event }) },
    finish() { assert.equal(typeof finishAdoption, 'function', 'an actual adoption ACK must be pending'); finishAdoption() },
  }
}

async function openStandalone(view) {
  view.el.querySelector('.tree-chat-add').click()
  view.el.querySelector('.tree-new-agent').click()
  /* + now opens the spawn chooser first (T286, the owner: "Give it a pop up
     menu to select what to spawn"), so the real path is press, choose, open.
     The default program is already selected; this presses Open agent tab. */
  view.el.querySelector('.tree-agent-continue').click(); await settle(8)
  const chat = view.el.querySelector('.tree-standalone-agent .chat')
  assert.ok(chat, 'the actual New agent control must mount its composer')
  return chat
}

async function openRail(view, nodeId) {
  const node = [...view.el.querySelectorAll('.static-tree-node')].find(item => item.dataset.agentId === nodeId)
  assert.ok(node, 'the actual graph must expose the saved node')
  node.dispatch('keydown', { key: 'Enter', shiftKey: true }); await settle(8)
  const chat = view.el.querySelector('[data-rail-chat-host] .chat')
  assert.ok(chat, 'the saved node must open its actual Details rail chat')
  return chat
}

test('first send from a placed never-started tab rebinds its open rail and preserves the rail draft', async t => {
  const f = await fixture(t), bridge = standaloneBridge(f), view = await f.mount()
  const standalone = await openStandalone(view)
  view.el.querySelector('.tree-standalone-place').click()
  view.el.querySelector('.tree-standalone-place-confirm').click(); await settle(12)
  const node = JSON.parse(f.world.storage.getItem(fleetTreesStorageKey(f.computerId))).nodes.find(node => node.id !== f.nodeId)
  assert.ok(node, 'placement must save the never-started node without launching it')
  assert.equal(node.sessionId, null)
  assert.equal(f.calls.length, 0)
  const before = await openRail(view, node.id)
  assert.equal(Boolean(textOf(before).disabled), true, 'the pre-session rail cannot send')
  // Restore a locally held draft through the real composer API while this
  // node has no sendable session; no disabled control is used as a send path.
  before.importDraft({ text: '  Keep the rail follow-up  ', attachments: [{ path: '/fixture/rail-only.png' }], start: 3, end: 11 })
  const draft = before.exportDraft()
  textOf(standalone).value = 'Start from the placed tab'
  standalone.querySelector('.chat-send').click(); await settle(20)
  const start = f.calls.find(([kind]) => kind === 'start')?.[1]
  assert.equal(start?.surface, 'fleet-tree')
  assert.equal(start.requestKeys.threadId, node.id)
  assert.deepEqual(start.requestKeys.treeAnchors, [node.id])
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'send').map(([, request]) => request.sessionId), [start.sessionId])
  const after = view.el.querySelector('[data-rail-chat-host] .chat')
  assert.notEqual(after, before, 'the rail must replace its sessionless controls')
  assert.equal(Boolean(textOf(after).disabled), false)
  assert.deepEqual(after.exportDraft(), draft)
  assert.equal(after.querySelectorAll('.chat-attachment-chip').length, 1)
  bridge.emit(start.sessionId, { type: 'assistant_text_delta', text: 'The new session reaches the open rail', turnId: 'rail-first-turn' })
  await settle(8)
  assert.match(after.textContent, /The new session reaches the open rail/)
  const halt = after.querySelector('[data-chat-chip="halt"]')
  assert.equal(halt.hidden, false); assert.equal(halt.disabled, false)
  halt.click(); await settle(12)
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'interrupt').map(([, request]) => request.sessionId), [start.sessionId])
  assert.deepEqual(after.exportDraft(), draft, 'rebound Halt controls must not consume the separate rail draft')
  assert.equal(f.calls.filter(([kind]) => kind === 'start').length, 1)
})

for (const boundary of ['teardown', 'computer switch']) test(`late standalone adoption after ${boundary} cannot replace another computer’s open rail`, async t => {
  const otherComputerId = `rail-other-${sequence + 1}`
  const f = await fixture(t, { extraComputerId: otherComputerId }), bridge = standaloneBridge(f, { holdAdoption: true })
  const first = await f.mount(), standalone = await openStandalone(first)
  textOf(standalone).value = 'Work being adopted while navigation happens'
  standalone.querySelector('.chat-send').click(); await settle(12)
  first.el.querySelector('.tree-standalone-place').click()
  first.el.querySelector('.tree-standalone-place-confirm').click(); await settle(10)
  const adoption = f.calls.find(([kind]) => kind === 'adopt')?.[1]
  assert.ok(adoption)
  const nodeId = adoption.requestKeys.threadId, otherSession = `${f.sessionId}-other-rail`
  // Reusing the node ID across computers makes accidental cross-source
  // rebinding observable while preserving each real store's own record.
  f.seed(nodeId, otherSession, otherComputerId)
  let current = first
  if (boundary === 'teardown') {
    f.dispose(first)
    current = await f.mount(otherComputerId)
  } else {
    const tab = [...first.el.querySelectorAll('.tabs .tab')].find(item => item.textContent.startsWith('Other draft computer'))
    assert.ok(tab, 'the fixture must expose the actual second-computer tab')
    tab.click(); await settle(20)
  }
  const rail = await openRail(current, nodeId)
  assert.equal(Boolean(textOf(rail).disabled), false)
  rail.importDraft({ text: 'Only for the other computer', attachments: [{ path: '/fixture/other-computer.png' }], start: 2, end: 9 })
  const draft = rail.exportDraft()
  bridge.finish(); await settle(30)
  assert.equal(current.el.querySelector('[data-rail-chat-host] .chat'), rail, 'a stale bind cannot rebuild the visible rail')
  assert.deepEqual(rail.exportDraft(), draft)
  assert.equal(JSON.parse(f.world.storage.getItem(fleetTreesStorageKey(otherComputerId))).nodes.find(node => node.id === nodeId).sessionId, otherSession)
  rail.querySelector('.chat-send').click(); await settle(15)
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'send').map(([, request]) => request.sessionId), [adoption.sessionId, otherSession])
  assert.equal(f.calls.filter(([kind]) => kind === 'start').length, 1)
  assert.equal(f.calls.some(([kind]) => kind === 'close'), false)
})
