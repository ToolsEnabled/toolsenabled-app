import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { mountStandaloneAgent } from '../../src/tree-standalone-agent.js'
import { mountAgentSessionSurface } from '../../src/agent-session.js'
import { TreeWorkspace } from '../../src/tree-workspace.js'
import { StaticTreeGraph } from '../../src/tree-graph.js'
import { buildChat } from '../../src/components.js'
import { publishLiveSession, readLiveSession, resetLiveSessionForTest } from '../../src/agent-session-registry.js'
import { setWriteEnabled } from '../../src/write-flags.js'
import { holdForSend, list as outboxList } from '../../src/session-outbox.js'
import { QUEUE_PANEL, roleLabel, tierChoicesFor } from '../../src/fleet-tree-copy.js'
import { createFleetTreeStore, nodeDisplayName } from '../../src/fleet-trees.js'
import { adoptStandaloneIntoTree } from '../../src/tree-standalone-adoption.js'

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')
const { createImageRetentionService } = createRequire(import.meta.url)('../../shell/image-retention-service.cjs')

function environment(t, { enabled = true, start = null, paste = null, send: sendBridge = null, images = false } = {}) {
  const { document, restore } = installDomStandIn()
  const observers = new Set()
  globalThis.MutationObserver = class {
    constructor(callback) { this.callback = callback }
    observe() { observers.add(this) }
    disconnect() { observers.delete(this) }
  }
  // Deliver the browser's post-detachment notification. The default DOM
  // stand-in has no observer delivery and previously hid this native failure.
  const flushMutations = () => { for (const observer of [...observers]) observer.callback([]) }
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map([['mc.write.agent-session', enabled ? 'enabled' : 'disabled']])
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) }
  const calls = [], listeners = new Set(), mounts = [], started = new Set()
  const owner = { version: 1, ownerId: 'standalone-fixture-owner', currentEpoch: 'fixture-epoch', kind: 'local' }
  const bindings = []
  const sessions = new Map()
  const root = images ? mkdtempSync(path.join(tmpdir(), 'standalone-gesture-images-')) : null
  const authority = request => {
    const session = sessions.get(request.sessionId)
    assert.ok(session, 'images belong to a session that actually started')
    return { session, sessionId: request.sessionId, accountId: 'default', provider: 'codex',
      model: 'fixture-model', effort: null, issued: session.issued }
  }
  const imageService = images ? createImageRetentionService({ root: path.join(root, 'retained'),
    authenticate: context => {
      assert.deepEqual(context, owner)
      return { authenticated: true, productOwnerId: owner.ownerId, currentEpoch: owner.currentEpoch }
    },
    sourceAuthority: authority, candidateAuthority: authority,
    authorizeTransfer: () => true, engineImageBytes: 8 * 1024 * 1024,
  }) : null
  const transcript = {
    async bind(sessionId, seatId) {
      assert.ok(started.has(sessionId), 'binding requires a completed native start')
      bindings.push({ sessionId, seatId })
      return { ok: true }
    },
    async release() { return { ok: true, released: true } },
  }
  const bridge = {
    availability: async () => ({ ok: true }),
    confinement: async () => ({ ok: true, tier: 'standard' }),
    onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    ownerContext: async () => owner,
    onOwnerContextChanged: () => () => {},
    start: async value => {
      calls.push(['start', value])
      const result = start ? await start(value) : { sessionId: value.sessionId }
      if (result?.ok !== false) {
        started.add(value.sessionId)
        sessions.set(value.sessionId, { issued: new Set() })
      }
      return result
    },
    send: async value => { calls.push(['send', value]); return sendBridge ? sendBridge(value) : { turnId: `turn-${calls.filter(([kind]) => kind === 'send').length}` } },
    interrupt: async value => { calls.push(['interrupt', value]); return { ok: true } },
    close: async value => { calls.push(['close', value]); return { closed: true } },
    pasteAttachment: async value => {
      calls.push(['paste', value])
      const answer = paste ? await paste(value) : { ok: true }
      if (answer?.ok !== true) return answer
      assert.ok(root, 'an image test must install the actual retention service')
      const file = path.join(root, `pasted-${calls.filter(([kind]) => kind === 'paste').length}.png`)
      writeFileSync(file, Buffer.from(value.data, 'base64'))
      authority(value).issued.add(file)
      return { ok: true, path: file }
    },
    ...(imageService ? { async imageQueue(request) {
      if (request.operation === 'binding') {
        const binding = bindings.find(row => row.sessionId === request.sessionId)
        assert.ok(binding, 'image dispatch cannot precede the transcript binding acknowledgment')
        return { ok: true, result: { sessionId: request.sessionId, conversationId: binding.seatId, ownerContext: owner } }
      }
      if (request.operation === 'dispatch') {
        const result = await imageService.dispatch(request, request.ownerContext, async turn => {
          calls.push(['image-send', { sessionId: request.sessionId, text: turn.text,
            images: turn.images.map(image => ({ bytes: readFileSync(image.path).toString('base64') })) }])
          return { ok: true, deliveryDisposition: 'accepted', result: { turnId: 'turn-1' } }
        })
        return { ...result, operation: request.operation, operationId: request.operationId,
          sessionId: request.sessionId, conversationId: request.conversationId,
          envelopeId: request.envelopeId, ownerContext: request.ownerContext }
      }
      return imageService.run(request.operation === 'admit' && !request.selection
        ? { ...request, selection: { model: 'fixture-model', effort: null } } : request, request.ownerContext)
    } } : {}),
  }
  const mount = (id, options = {}) => {
    const host = document.createElement('div'); document.body.appendChild(host)
    const adapter = mountStandaloneAgent(host, { id, name: id, live: true, bridge, transcript, ...options })
    mounts.push(adapter)
    return { host, adapter, chat: () => host.querySelector('[data-chat-panel]'), input: () => host.querySelector('.chat-input input') }
  }
  const emit = (sessionId, event) => { for (const listener of listeners) listener({ sessionId, event }) }
  t.after(async () => {
    for (const adapter of mounts) adapter.dispose()
    await settle()
    resetLiveSessionForTest()
    if (root) rmSync(root, { recursive: true, force: true })
    if (storage) Object.defineProperty(globalThis, 'localStorage', storage); else delete globalThis.localStorage
    restore()
  })
  return { document, bridge, transcript, bindings, calls, listeners, mount, emit, flushMutations, track: dispose => mounts.push({ dispose }) }
}

async function send(panel, text) {
  panel.input().value = text
  panel.input().dispatch('input')
  panel.chat().querySelector('.chat-send').click()
  await settle()
}

function workspace(env, computerId = 'owned-computer') {
  const zoomHost = env.document.createElement('div'); env.document.body.appendChild(zoomHost)
  const graph = { computer: { id: computerId }, zoomHost, nodes: new Map(), chatDrafts: new Map(),
    standaloneAgent: { live: true, bridge: env.bridge, transcript: env.transcript, persistenceKey: computerId },
    _bindStandaloneDrop: StaticTreeGraph.prototype._bindStandaloneDrop,
    setWide() {}, _renderChatChoices() {}, resize() {}, _applyZoom() {}, _agentFor() {} }
  graph.workspace = new TreeWorkspace(graph)
  env.track(() => {
    for (const record of [...graph.workspace.standalone.values()]) graph.workspace.close(record, { focus: false })
    graph.workspace.destroy()
  })
  return graph.workspace
}

test('header keyboard creation reaches the same graph callback in normal and Edit mode', t => {
  const owner = workspace(environment(t)), presses = [], events = []
  owner.graph._pressEmptySlot = StaticTreeGraph.prototype._pressEmptySlot
  owner.graph.onEmptyPress = detail => presses.push(detail)
  owner.graph.container = { dispatchEvent: event => events.push(event) }
  const header = owner.root.querySelector('.tree-chat-add')
  header.dispatch('click', { detail: 0 })
  const choice = owner.root.querySelector('.tree-new-tree')
  assert.equal(owner.graph.chatChooser.hidden, false)
  assert.equal(owner.root.ownerDocument.activeElement, choice)
  choice.dispatch('click', { detail: 0 })
  owner.graph.editMode = true
  owner.syncEditing()
  assert.equal(owner.graph.chatTabs.inert, true, 'switching chats remains unavailable while editing')
  assert.ok(!header.parentElement.inert, 'the moved creation and drop control remains reachable')
  header.dispatch('click', { detail: 0 })
  header.dispatch('click', { detail: 1 })
  assert.deepEqual(presses.map(detail => [detail.kind, detail.parentId, detail.via]), [
    ['new-tree', null, 'keyboard'], ['new-tree', null, 'keyboard'], ['new-tree', null, 'pointer'],
  ])
  assert.deepEqual(events.map(event => event.detail), presses)
})

for (const outcome of ['acknowledged', 'refused']) {
  test(`standalone creation ignores a late ${outcome} seat after leaving the page`, async t => {
    const env = environment(t), owner = workspace(env)
    let finishSeat, pending
    owner.graph.standaloneAgent.declareSeat = () => new Promise((resolve, reject) => {
      finishSeat = outcome === 'acknowledged' ? () => resolve({ ok: true }) : () => reject(new Error('Seat unavailable'))
    })
    t.mock.method(owner, 'openStandalone', (...args) => {
      pending = TreeWorkspace.prototype.openStandalone.apply(owner, args)
      return pending
    })
    owner.root.querySelector('.tree-chat-add').click()
    owner.root.querySelector('.tree-new-agent').click()
    owner.root.querySelector('.tree-agent-continue').click()
    assert.equal(typeof finishSeat, 'function', 'the real chooser must request the seat')
    const pendingPanel = owner.graph.chatTrack.querySelector('.tree-standalone-conversation')
    owner.destroy()
    const returned = workspace(env)
    finishSeat()
    await pending
    await settle()
    assert.equal(owner.standalone.size, 0, 'a departed workspace cannot acquire a late chat')
    assert.equal(owner.retainedStandalone.size, 0, 'a late result cannot leave an invisible retained chat')
    assert.equal(returned.standalone.size, 0, 'returning before the acknowledgment must not inherit a ghost')
    assert.equal(pendingPanel.querySelector('.tree-standalone-agent'), null)
    assert.equal(pendingPanel.parentNode, null)
    assert.equal(env.listeners.size, 0, 'no detached agent event subscription may survive')
    assert.deepEqual(env.calls, [], 'a stale tab cannot start or close a provider')
  })
}

test('standalone creation waits for a current seat before mounting the chosen chat', async t => {
  const env = environment(t), owner = workspace(env)
  let finishSeat
  owner.graph.standaloneAgent.declareSeat = () => new Promise(resolve => { finishSeat = resolve })
  const pending = owner.openStandalone({ tier: 'luna', effort: 'high' })
  assert.equal(owner.standalone.size, 0)
  finishSeat({ ok: true })
  await pending
  await settle()
  const record = [...owner.standalone.values()][0]
  assert.ok(record?.chatPanel.querySelector('.tree-standalone-agent'))
  assert.equal(owner.retainedStandalone.get(record.id), record)
  assert.equal(owner.graph.activeChatId, record.id)
  assert.deepEqual(record.session.chosenStart(), { tier: 'luna', effort: 'high' })
  assert.deepEqual(env.calls, [], 'mounting a current draft still performs no paid start')
})

test('standalone creation does not register a seat from an already departed workspace', async t => {
  const env = environment(t), owner = workspace(env)
  let registrations = 0
  owner.graph.standaloneAgent.declareSeat = async () => { registrations++; return { ok: true } }
  owner.destroy()
  await owner.openStandalone({ tier: 'luna' })
  assert.equal(registrations, 0)
  assert.equal(owner.standalone.size, 0)
  assert.equal(owner.retainedStandalone.size, 0)
  assert.deepEqual(env.calls, [])
})

for (const changed of ['graph', 'edit']) {
  test(`standalone creation rechecks ${changed} eligibility after seat registration`, async t => {
    const env = environment(t), owner = workspace(env)
    let finishSeat
    owner.graph.standaloneAgent.declareSeat = () => new Promise(resolve => { finishSeat = resolve })
    const pending = owner.openStandalone({ tier: 'luna' })
    const pendingPanel = owner.graph.chatTrack.querySelector('.tree-standalone-conversation')
    if (changed === 'graph') owner.graph._destroyed = true
    else owner.graph.editMode = true
    finishSeat({ ok: true })
    await pending
    await settle()
    assert.equal(owner.standalone.size, 0)
    assert.equal(owner.retainedStandalone.size, 0)
    assert.equal(pendingPanel.parentNode, null)
    assert.equal(env.listeners.size, 0)
    assert.deepEqual(env.calls, [])
  })
}

test('the header + places an owned standalone chat on a new tree while preserving its draft and session', async t => {
  const env = environment(t), owner = workspace(env), placements = []
  owner.graph.onPlaceStandalone = async request => {
    placements.push(request)
    return { ok: true, nodeId: 'placed-from-header', sentence: 'Added to a new tree.' }
  }
  owner.openStandalone()
  await settle()
  const record = [...owner.standalone.values()][0]
  const session = record.session, panel = record.chatPanel
  const input = panel.querySelector('.chat-input input')
  input.value = 'Keep this draft while placing'; input.dispatch('input')
  const header = owner.root.querySelector('.tree-chat-add')
  const event = computerId => ({ dataTransfer: {
    types: ['application/x-toolsenabled-standalone-agent'],
    getData: () => JSON.stringify({ id: record.id, computerId }),
  } })
  header.dispatch('drop', event('different-computer'))
  assert.equal(placements.length, 0, 'a foreign tab cannot be adopted through the header')
  owner.graph.editMode = true
  header.dispatch('drop', event(owner.graph.computer.id))
  assert.equal(placements.length, 0, 'editing still prevents standalone adoption')
  owner.graph.editMode = false
  header.dispatch('dragover', event(owner.graph.computer.id))
  assert.equal(header.classList.contains('standalone-drop-target'), true)
  header.dispatch('drop', event(owner.graph.computer.id))
  await settle()
  assert.deepEqual(placements, [{ record, parentId: null, computerId: owner.graph.computer.id }])
  assert.equal(record.treeNodeId, 'placed-from-header')
  assert.equal(record.session, session)
  assert.equal(record.chatPanel, panel)
  assert.equal(input.value, 'Keep this draft while placing')
  assert.equal(header.classList.contains('standalone-drop-target'), false)
  assert.deepEqual(env.calls, [], 'placing a draft does not start or close a provider session')
})

test('unplaced drafts and running standalone chats survive page remount without restarting or resending', async t => {
  const env = environment(t), first = workspace(env)
  first.openStandalone(); await settle()
  const record = [...first.standalone.values()][0], panel = {
    input: () => record.chatPanel.querySelector('.chat-input input'),
    chat: () => record.chatPanel.querySelector('[data-chat-panel]'),
  }
  panel.input().value = 'Draft before start'; panel.input().dispatch('input')
  first.destroy()
  env.flushMutations(); await settle()
  const other = workspace(env, 'different-computer'); assert.equal(other.standalone.size, 0)
  const second = workspace(env)
  assert.ok(second.standalone.get(record.id) === record, 'returning to the computer must restore the same standalone chat')
  assert.equal(panel.input().value, 'Draft before start')
  await send(panel, 'One actual turn')
  assert.equal(env.calls.filter(([kind]) => kind === 'send').length, 1, 'Send must remain wired after navigation')
  const id = record.session.snapshot().sessionId
  env.emit(id, { type: 'assistant_text_delta', text: 'Before navigation', turnId: 'turn-1' }); await settle()
  panel.input().value = 'Next unsent message'; panel.input().dispatch('input')
  second.destroy()
  env.flushMutations(); await settle()
  env.emit(id, { type: 'assistant_text_delta', text: ' and after navigation', turnId: 'turn-1' })
  env.emit(id, { type: 'turn_completed', status: 'completed', turnId: 'turn-1' }); await settle()
  const third = workspace(env)
  assert.ok(third.standalone.get(record.id) === record, 'a running chat must survive the next page remount')
  assert.equal(panel.input().value, 'Next unsent message')
  assert.match(record.session.snapshot().transcript.find(row => row.who === 'agent').text, /Before navigation and after navigation/)
  assert.match(panel.chat().textContent, /Before navigation and after navigation/, 'detached replies must also reach the retained visible chat')
  assert.equal(env.calls.filter(([kind]) => kind === 'start').length, 1)
  assert.equal(env.calls.filter(([kind]) => kind === 'send').length, 1)
  assert.equal(env.calls.filter(([kind]) => kind === 'close').length, 0)
  await send(panel, panel.input().value)
  assert.equal(env.calls.filter(([kind]) => kind === 'start').length, 1, 'returning must reuse the native session')
  assert.equal(env.calls.filter(([kind]) => kind === 'send').length, 2)
  third.close(record, { focus: false }); await settle()
  assert.equal(env.calls.filter(([kind]) => kind === 'close').length, 1)
  third.destroy()
  assert.equal(workspace(env).standalone.size, 0, 'explicitly closed tabs must not resurrect')
});

test('ordinary removed chats still release their composer and subscriptions', async t => {
  const env = environment(t), sent = []
  let released = 0
  const chat = buildChat({ title: 'Page chat', seed: 0, onSend: text => sent.push(text),
    status: { busy: () => false, subscribe: () => () => released++ } })
  env.track(() => chat.dispose())
  env.document.body.appendChild(chat); await settle()
  chat.remove(); env.flushMutations(); await settle()
  env.document.body.appendChild(chat)
  await send({ input: () => chat.querySelector('.chat-input input'), chat: () => chat }, 'Closed page')
  assert.deepEqual(sent, [])
  assert.equal(released, 1)
})

for (const returnBeforeAck of [false, true]) {
  test(`placement acknowledgment after navigation keeps tree custody and the draft (returned=${returnBeforeAck})`, async t => {
    const env = environment(t), first = workspace(env), drafts = []
    const handoff = (nodeId, session) => () => drafts.push({ nodeId, draft: session.exportDraft() })
    first.graph.onMountChatDraft = handoff
    first.openStandalone(); await settle()
    const record = [...first.standalone.values()][0], panel = {
      input: () => record.chatPanel.querySelector('.chat-input input'),
      chat: () => record.chatPanel.querySelector('[data-chat-panel]'),
    }
    await send(panel, 'Keep the running session')
    panel.input().value = 'Keep this draft on the placed node'; panel.input().dispatch('input')
    record.placementPending = true
    assert.equal(record.session.beginPlacement().ok, true)
    first.destroy()
    const returned = returnBeforeAck ? workspace(env) : null
    if (returned) returned.graph.onMountChatDraft = handoff
    record.session.commitPlacement({ nodeId: 'acknowledged-node', getStartOptions() {}, onSessionChange() {} })
    record.placementPending = false
    await settle()
    assert.equal(env.calls.filter(([kind]) => kind === 'close').length, 0, 'the tree, not the departed page, now owns the native session')
    assert.deepEqual(drafts.map(value => [value.nodeId, value.draft.text]), [['acknowledged-node', 'Keep this draft on the placed node']])
    assert.equal((returned || workspace(env)).standalone.size, 0, 'an acknowledged placement must not resurrect as an independent chat')
  })
}

test('standalone tabs start only on send, retain complete chats, isolate sessions, and leave tree control ownership alone', async t => {
  const env = environment(t)
  const control = { pause() {}, respawn() {}, terminate() {} }
  publishLiveSession({ agentId: 'declared-tree-agent', sessionId: 'tree-session', phase: 'open', control })
  const treeOwner = readLiveSession()
  const first = env.mount('First'), second = env.mount('Second')
  await settle()
  assert.equal(env.calls.length, 0, 'mounting must perform no paid start or turn')
  assert.equal(first.host.querySelector('[data-session-form]').hidden, true)
  assert.equal(first.input().disabled, false)
  first.adapter.focus()
  assert.equal(env.document.activeElement, first.input())
  second.input().value = 'unsent second draft'

  await send(first, 'First question')
  const firstId = env.calls.find(([kind]) => kind === 'start')[1].sessionId
  const firstStart = env.calls.filter(([kind]) => kind === 'start')[0][1]
  assert.equal(firstStart.sessionId, firstId)
  assert.equal(firstStart.treeIdentity, undefined, 'standalone start carries no tree identity')
  assert.equal(firstStart.requestKeys, undefined, 'standalone start carries no tree insertion')
  /* It DOES carry the program the surface is showing. The old form asserted
     the whole payload equalled { sessionId }, which read as a statement about
     tree identity but also pinned the defect T286 fixed: a solo agent that
     told the host nothing and was planned on a default nobody could see. */
  assert.equal(firstStart.tier, first.adapter.chosenStart().tier)
  assert.equal(first.chat().querySelectorAll('.me').length, 1, 'first-send start must retain the owner message')
  env.emit(firstId, { type: 'assistant_text_delta', text: 'First answer', turnId: 'turn-1' })
  env.emit(firstId, { type: 'turn_completed', status: 'completed', turnId: 'turn-1' })
  await settle()
  assert.match(first.chat().textContent, /First answer/)
  assert.doesNotMatch(second.chat().textContent, /First answer/)
  assert.equal(second.input().value, 'unsent second draft')

  await send(first, 'Follow-up question')
  env.emit(firstId, { type: 'assistant_text_delta', text: 'Separate second answer', turnId: 'turn-2' })
  env.emit(firstId, { type: 'turn_completed', status: 'completed', turnId: 'turn-2' })
  await settle()
  assert.equal(first.chat().querySelectorAll('.me').length, 2)
  const replies = first.chat().querySelectorAll('.them').map(node => node.textContent)
  assert.equal(replies.length, 2)
  assert.match(replies[0], /First answer/)
  assert.match(replies[1], /Separate second answer/)
  assert.doesNotMatch(replies[1], /First answer/, 'stream accumulation starts fresh for each reply')

  await send(second, 'Second agent question')
  const secondId = env.calls.filter(([kind]) => kind === 'start')[1][1].sessionId
  assert.notEqual(firstId, secondId)
  assert.equal(readLiveSession(), treeOwner)
  first.adapter.dispose(); first.adapter.dispose()
  await settle()
  assert.deepEqual(env.calls.filter(([kind]) => kind === 'close').map(([, value]) => value.sessionId), [firstId])
  assert.equal(env.listeners.size, 1)
  env.emit(secondId, { type: 'assistant_text_delta', text: 'Still working in second tab', turnId: 'turn-3' })
  await settle()
  assert.match(second.chat().textContent, /Still working in second tab/)
  assert.equal(readLiveSession(), treeOwner)
  second.adapter.dispose()
  await settle()
  assert.equal(env.listeners.size, 0)
  assert.deepEqual(env.calls.filter(([kind]) => kind === 'interrupt').map(([, value]) => value.sessionId), [secondId])
  assert.equal(readLiveSession(), treeOwner)
})

test('a pasted image waits for send, attaches to the owned session, and is not replayed on a later turn', async t => {
  const env = environment(t, { images: true }), panel = env.mount('Picture agent')
  await settle()
  const paste = panel.input().dispatch('paste', { clipboardData: { items: [{ kind: 'file', type: 'image/png',
    getAsFile: () => ({ arrayBuffer: async () => Uint8Array.from(png).buffer }) }] } })
  await settle()
  assert.equal(paste.defaultPrevented, true)
  assert.equal(env.calls.length, 0)
  assert.equal(panel.chat().exportDraft().attachments.length, 1)
  await send(panel, 'Describe this')
  assert.deepEqual(env.calls.slice(0, 3).map(([kind]) => kind), ['start', 'paste', 'image-send'])
  const sent = env.calls.find(([kind]) => kind === 'image-send')[1]
  assert.deepEqual(sent.images, [{ bytes: png.toString('base64') }])
  assert.equal(env.calls.find(([kind]) => kind === 'paste')[1].data, png.toString('base64'))
  assert.equal(env.calls.some(([kind]) => kind === 'send'), false, 'image sends use durable dispatch')
  env.emit(sent.sessionId, { type: 'turn_completed', status: 'completed', turnId: 'turn-1' })
  await settle()
  await send(panel, 'Words only')
  assert.equal(Object.hasOwn(env.calls.find(([kind]) => kind === 'send')[1], 'images'), false)
  assert.equal(env.calls.filter(([kind]) => kind === 'image-send').length, 1)
})

test('the chat Halt control DISCARDS its streaming bubble and the next message continues the same session', async t => {
  const env = environment(t), panel = env.mount('Interruptible agent')
  await settle()
  await send(panel, 'Work on this')
  const sessionId = env.calls.find(([kind]) => kind === 'start')[1].sessionId
  env.emit(sessionId, { type: 'assistant_text_delta', text: 'A partial answer', turnId: 'turn-1' })
  await settle()
  panel.chat().querySelector('.chat-send').click()
  await settle()
  assert.equal(env.calls.filter(([kind]) => kind === 'interrupt').length, 1)
  assert.equal(panel.adapter.snapshot().lastTurnStatus, 'interrupted')
  /* THE RECORD SURVIVES THE DISCARD. The abandoned words leave the screen; the
     transcript still holds the turn that produced them. */
  assert.equal(panel.adapter.snapshot().transcript.find(row => row.who === 'agent').turnStamp, 'turn-1')
  /* RE-POINTED (T335): this used to assert the abandoned bubble SURVIVED the
     halt and merely stopped being busy. The owner rejected that in those words
     -- his input goes in first and the agent's partial work is DISCARDED, no
     grace period -- so the behaviour it pinned is the behaviour he asked us to
     remove. MEASURED on the packaged fix build, one agent row in a fresh chat,
     the partial's own text as the fingerprint: gone 120ms after the press, still
     gone at 400ms and 900ms, and still gone after leaving the tab and coming
     back. What is pinned here is that DISCARD, and that nothing is left claiming
     to be live. */
  assert.equal(panel.chat().querySelectorAll('.them').length, 0,
    'the abandoned streaming bubble must leave the log, not settle in place')
  assert.doesNotMatch(panel.chat().textContent, /partial answer/,
    'the abandoned words must not be left on screen anywhere')
  assert.equal(panel.chat().querySelectorAll('[aria-busy]').length, 0,
    'nothing may still claim to be live once the halt has been taken')
  await send(panel, 'Continue with this instead')
  assert.equal(env.calls.filter(([kind]) => kind === 'start').length, 1)
  assert.equal(env.calls.filter(([kind]) => kind === 'send').length, 2)
  env.emit(sessionId, { type: 'assistant_text_delta', text: 'The new answer', turnId: 'turn-2' })
  env.emit(sessionId, { type: 'turn_completed', status: 'completed', turnId: 'turn-2' })
  await settle()
  /* [0], not [1]: the discarded bubble is no longer sitting in front of the new
     answer, so the next reply is the FIRST agent row in the log. */
  assert.doesNotMatch(panel.chat().querySelectorAll('.them')[0].textContent, /partial answer/)
})

test('a refused image retains the message and attachment for retry instead of sending incomplete work', async t => {
  let refuse = true
  const env = environment(t, { images: true, paste: async () => refuse ? { ok: false, code: 'MC_AGENT_PASTE_IMAGE_TOO_LARGE' } : { ok: true } })
  const panel = env.mount('Retry agent')
  await settle()
  panel.input().dispatch('paste', { clipboardData: { items: [{ kind: 'file', type: 'image/png',
    getAsFile: () => ({ arrayBuffer: async () => Uint8Array.from(png).buffer }) }] } })
  await settle()
  await send(panel, 'Keep this question')
  assert.equal(env.calls.some(([kind]) => ['send', 'image-send'].includes(kind)), false)
  assert.equal(panel.input().value, 'Keep this question')
  assert.equal(panel.chat().exportDraft().attachments.length, 1)
  refuse = false
  await send(panel, panel.input().value)
  assert.equal(env.calls.filter(([kind]) => kind === 'image-send').length, 1)
  assert.equal(env.calls.some(([kind]) => kind === 'send'), false)
  assert.equal(panel.chat().exportDraft().attachments.length, 0)
})

test('closing a tab during native start closes the eventual session without sending', async t => {
  let finishStart
  const env = environment(t, { start: () => new Promise(resolve => { finishStart = resolve }) })
  const panel = env.mount('Slow agent')
  await settle()
  await send(panel, 'Start slowly')
  panel.adapter.dispose()
  finishStart({ ok: true })
  await settle()
  assert.equal(env.calls.filter(([kind]) => kind === 'send').length, 0)
  assert.equal(env.calls.filter(([kind]) => kind === 'close').length, 1)
  assert.equal(env.listeners.size, 0)
})

test('example and switched-off tabs stay inert, and original session surfaces keep their read-only transcript', async t => {
  const env = environment(t)
  const example = env.mount('Example', { live: false })
  assert.equal(example.chat(), null)
  const host = env.document.createElement('div'); env.document.body.appendChild(host)
  const release = mountAgentSessionSurface(host, { live: true, bridge: env.bridge, agentId: 'original' })
  env.track(release)
  await settle()
  assert.equal(host.querySelector('[data-session-form]').hidden, false)
  assert.equal(host.querySelector('.chat-input input').disabled, true)
  assert.equal(env.calls.length, 0)
})

test('a disabled session setting exposes its existing enable control without creating an agent', async t => {
  const env = environment(t, { enabled: false }), panel = env.mount('Disabled')
  await settle()
  assert.equal(panel.chat(), null)
  assert.ok(panel.host.querySelector('[data-session-enable]'))
  assert.equal(env.calls.length, 0)
})

test('placement snapshot separates completed history from the unflushed active reply and preserves draft attachment state', async t => {
  const env = environment(t, { start: async ({ sessionId }) => ({ sessionId, threadId: 'actual-thread', account: 'fixture-account' }) })
  const panel = env.mount('Snapshot agent'); await settle()
  await send(panel, 'First task')
  const id = panel.adapter.snapshot().sessionId
  env.emit(id, { type: 'assistant_text_delta', text: 'Completed answer', turnId: 'turn-1' })
  env.emit(id, { type: 'turn_completed', status: 'completed', turnId: 'turn-1' }); await settle()
  await send(panel, 'Second task')
  env.emit(id, { type: 'tool_call', toolCallId: 'call-1', tool: 'Bash', payload: { command: 'pwd' }, turnId: 'turn-2' })
  env.emit(id, { type: 'assistant_text_delta', text: 'Unflushed partial', turnId: 'turn-2' })
  const before = panel.adapter.snapshot()
  assert.equal(before.currentText, 'Unflushed partial')
  assert.deepEqual(before.transcript.filter(row => row.who !== 'action').map(row => [row.who, row.text]),
    [['you', 'First task'], ['agent', 'Completed answer'], ['you', 'Second task']])
  assert.equal(before.transcript.filter(row => row.who === 'action').length, 1)
  assert.equal(before.threadId, 'actual-thread'); assert.equal(before.account, 'fixture-account')
  assert.equal(before.phase, 'working'); assert.equal(before.turnId, 'turn-2')
  assert.equal(before.lastTurnStatus, null)
  assert.deepEqual(before.transcript.filter(row => row.who !== 'action').map(row => row.turnStamp), ['turn-1', 'turn-1', 'turn-2'])
  const chat = panel.chat(), input = panel.input()
  chat.importDraft({ text: 'Keep my draft', attachments: [{ path: '/fixture/image.png', name: 'image.png' }], start: 3, end: 8 })
  const draft = chat.exportDraft(), calls = env.calls.length
  const held = panel.adapter.beginPlacement()
  assert.equal(held.ok, true)
  assert.equal(panel.host.querySelector('.tree-standalone-agent').inert, true)
  assert.equal(panel.adapter.beginPlacement().ok, false)
  before.transcript[0].text = 'external mutation'
  assert.equal(panel.adapter.snapshot().transcript[0].text, 'First task')
  panel.adapter.cancelPlacement()
  assert.equal(panel.host.querySelector('.tree-standalone-agent').inert, false)
  assert.equal(panel.chat(), chat); assert.equal(panel.input(), input)
  assert.deepEqual(chat.exportDraft(), draft)
  assert.equal(env.calls.length, calls, 'begin/cancel do not start, send, interrupt or close')
})

test('a placed draft waits for full binding, uses the actual tree identity, and maps its start and owner before synchronous reply events', async t => {
  const order = [], changes = []
  let env
  env = environment(t, { send: async value => {
    order.push('wire')
    env.emit(value.sessionId, { type: 'assistant_text_delta', text: 'Immediate answer', turnId: 'instant' })
    env.emit(value.sessionId, { type: 'turn_completed', status: 'completed', turnId: 'instant' })
    return { turnId: 'instant' }
  } })
  const panel = env.mount('Placed draft'); await settle()
  panel.input().value = 'Draft stays here'
  const chat = panel.chat()
  assert.equal(panel.adapter.beginPlacement().snapshot.prompt, 'Draft stays here')
  const first = panel.adapter.commitPlacement({ nodeId: 'real-node' })
  assert.equal(first.phase, 'draft')
  assert.equal(panel.host.querySelector('.tree-standalone-agent').inert, true)
  const startOptions = { surface: 'fleet-tree', treeIdentity: { computerId: 'computer', treeId: 'tree', nodeId: 'real-node' }, requestKeys: { nodeId: 'real-node' } }
  panel.adapter.commitPlacement({ nodeId: 'real-node', getStartOptions: () => startOptions,
    onSessionChange: (state, event) => { changes.push({ state, event }); if (event.kind === 'open' || event.kind === 'send') order.push(event.kind) } })
  assert.equal(panel.host.querySelector('.tree-standalone-agent').inert, false)
  assert.equal(panel.chat(), chat)
  assert.equal(env.calls.length, 0)
  assert.equal(panel.adapter.commitPlacement({ nodeId: 'another-node' }), null)
  await send(panel, panel.input().value)
  assert.deepEqual(order, ['open', 'send', 'wire'])
  assert.deepEqual(env.calls.find(([kind]) => kind === 'start')[1], { ...startOptions, sessionId: panel.adapter.snapshot().sessionId })
  assert.deepEqual(panel.adapter.snapshot().transcript.map(row => [row.who, row.text]), [['you', 'Draft stays here'], ['agent', 'Immediate answer']])
  assert.equal(panel.adapter.snapshot().currentText, '')
  panel.adapter.dispose(); await settle()
  assert.equal(env.calls.some(([kind]) => kind === 'close'), false, 'the tree now owns the native session')
  assert.equal(env.listeners.size, 0, 'the closed tab still releases its subscription')
})

test('placement blocks every session control and refuses a handoff during a pending send', async t => {
  let acknowledge
  const env = environment(t, { send: () => new Promise(resolve => { acknowledge = resolve }) })
  const host = env.document.createElement('div'); env.document.body.appendChild(host)
  let control
  env.track(mountAgentSessionSurface(host, { agentId: 'controlled', live: true, bridge: env.bridge, chatComposer: true,
    publishSession: false, onController: value => { control = value } }))
  await settle()
  const sending = control.send('Pending task'); await settle()
  assert.equal(control.beginPlacement().ok, false)
  acknowledge({ turnId: 'pending-turn' }); await sending
  const before = env.calls.length
  assert.equal(control.beginPlacement().ok, true)
  for (const result of [await control.pause(), await control.terminate(), await control.respawn(), await control.send('Cannot send')]) assert.equal(result.ok, false)
  assert.equal(env.calls.length, before)
  control.cancelPlacement()
  assert.equal((await control.pause()).ok, true)
})

test('disposing during placement waits for success before relinquishing the existing session', async t => {
  const env = environment(t), placements = []
  const panel = env.mount('Adopting agent', { onPlaced: nodeId => placements.push({ nodeId, draft: panel.adapter.exportDraft() }) }); await settle()
  await send(panel, 'Keep this native job')
  const sessionId = panel.adapter.snapshot().sessionId
  panel.chat().importDraft({ text: 'Unsent after adoption', attachments: [{ path: '/fixture/keep.png' }], start: 2, end: 8 })
  const draft = panel.adapter.exportDraft()
  assert.equal(panel.adapter.beginPlacement().ok, true)
  panel.adapter.dispose(); await settle()
  assert.equal(env.calls.some(([kind]) => kind === 'close'), false)
  assert.equal(env.listeners.size, 1)
  env.emit(sessionId, { type: 'assistant_text_delta', text: 'Arrived during adoption', turnId: 'turn-1' })
  const adopted = panel.adapter.commitPlacement({ nodeId: 'adopted-node' })
  assert.equal(adopted.sessionId, sessionId); assert.equal(adopted.currentText, 'Arrived during adoption')
  assert.equal(env.listeners.size, 0)
  assert.equal(env.calls.some(([kind]) => kind === 'close'), false)
  assert.equal(panel.adapter.commitPlacement({ nodeId: 'adopted-node', getStartOptions: () => ({}), onSessionChange() {} }).sessionId, sessionId)
  assert.deepEqual(placements, [{ nodeId: 'adopted-node', draft }], 'the node draft lease can attach before deferred teardown, once per placement')
  assert.deepEqual(panel.adapter.exportDraft(), draft)
  const exported = panel.adapter.exportDraft(); exported.text = 'external'; exported.attachments.push({ path: '/fixture/other.png' })
  assert.deepEqual(panel.adapter.exportDraft(), draft, 'the post-disposal snapshot retains the composer’s copy semantics')
})

test('disposing during refused placement closes only after custody remains with the standalone tab', async t => {
  const env = environment(t), panel = env.mount('Refused adoption'); await settle()
  await send(panel, 'Standalone job')
  panel.adapter.beginPlacement(); panel.adapter.dispose(); await settle()
  assert.equal(env.calls.some(([kind]) => kind === 'close'), false)
  panel.adapter.cancelPlacement(); await settle()
  assert.equal(env.calls.filter(([kind]) => kind === 'close').length, 1)
  assert.equal(env.listeners.size, 0)
})

test('an adopted session exports the actual unsent text, attachment and selection without changing its chat or session', async t => {
  const env = environment(t), panel = env.mount('Draft export'); await settle()
  await send(panel, 'Keep this live session')
  const chat = panel.chat(), input = panel.input()
  input.setSelectionRange = (start, end) => { input.selectionStart = start; input.selectionEnd = end }
  chat.importDraft({ text: 'An unsent follow-up', attachments: [{ path: '/fixture/held.png', name: 'held.png' }], start: 3, end: 9 })
  const expected = chat.exportDraft(), before = env.calls.length
  panel.adapter.beginPlacement()
  panel.adapter.commitPlacement({ nodeId: 'draft-node', getStartOptions: () => ({}), onSessionChange() {} })
  env.emit(panel.adapter.snapshot().sessionId, { type: 'assistant_text_delta', text: 'Still speaking', turnId: 'turn-1' })
  const snapshot = panel.adapter.snapshot()
  panel.adapter.setTitle('Default')
  assert.equal(chat.querySelector('.chat-head .t').textContent, 'Default')
  assert.equal(input.getAttribute('placeholder'), 'Message Default…')
  assert.equal(input.getAttribute('aria-label'), 'Message Default')
  assert.deepEqual(panel.adapter.snapshot(), snapshot, 'renaming cannot replace the stream or session model')
  const exported = panel.adapter.exportDraft()
  assert.deepEqual(exported, expected)
  assert.equal(exported.text, 'An unsent follow-up')
  assert.equal(exported.start, 3); assert.equal(exported.end, 9)
  assert.equal(exported.attachments[0].path, '/fixture/held.png')
  assert.notEqual(exported.attachments, expected.attachments)
  exported.text = 'changed outside'; exported.attachments.push({ path: '/extra' })
  assert.deepEqual(panel.adapter.exportDraft(), expected, 'each export retains the chat model’s copy semantics')
  assert.equal(panel.chat(), chat); assert.equal(panel.input(), input)
  assert.equal(env.calls.length, before, 'reading the draft never starts, sends, interrupts or closes a session')
  panel.adapter.dispose(); await settle()
  assert.equal(env.calls.some(([kind]) => kind === 'close'), false)
})

test('adoption snapshots distinguish a failed or interrupted turn from a completed one in the same open session', async t => {
  let refuse = false
  const env = environment(t, { send: async () => {
    if (refuse) throw Object.assign(new Error('AGENT_SESSION_FAILED'), { code: 'AGENT_SESSION_FAILED' })
    return { turnId: 'observed-turn' }
  } })
  const panel = env.mount('Outcome agent'); await settle()
  await send(panel, 'A failed turn')
  const sessionId = panel.adapter.snapshot().sessionId
  env.emit(sessionId, { type: 'turn_completed', status: 'failed', turnId: 'observed-turn' }); await settle()
  assert.equal(panel.adapter.snapshot().phase, 'open')
  assert.equal(panel.adapter.beginPlacement().snapshot.lastTurnStatus, 'failed')
  panel.adapter.cancelPlacement()
  await send(panel, 'A completed turn')
  env.emit(sessionId, { type: 'turn_completed', status: 'completed', turnId: 'observed-turn' }); await settle()
  assert.equal(panel.adapter.beginPlacement().snapshot.lastTurnStatus, 'completed')
  panel.adapter.cancelPlacement()
  refuse = true
  await send(panel, 'A refused send')
  assert.equal(panel.adapter.snapshot().phase, 'open')
  assert.equal(panel.adapter.beginPlacement().snapshot.lastTurnStatus, 'failed')
  panel.adapter.cancelPlacement()
})

test('a placed agent explicitly respawns with its current tree identity and awaits mapping before sending', async t => {
  let finishMapping, mappedSession = null, treeId = 'first-tree', control
  const order = []
  const env = environment(t, { send: async value => {
    assert.equal(mappedSession, value.sessionId, 'the tree must own incoming events before any new wire send')
    order.push(['wire', value.sessionId])
    return { turnId: 'restart-turn' }
  } })
  const host = env.document.createElement('div'); env.document.body.appendChild(host)
  const release = mountAgentSessionSurface(host, { agentId: 'placed-restart', live: true, bridge: env.bridge,
    chatComposer: true, publishSession: false, retainSessionOnDispose: () => true,
    onController: value => { control = value },
    getStartOptions: () => ({ surface: 'fleet-tree', treeIdentity: { treeId, nodeId: 'placed-node' } }),
    async onSessionChange(state, event) {
      if (event.kind === 'open') {
        order.push(['open', state.sessionId])
        if (treeId === 'moved-tree') await new Promise(resolve => { finishMapping = resolve })
        mappedSession = state.sessionId
      }
      if (event.kind === 'send') {
        assert.equal(state.phase, 'working')
        assert.equal(state.transcript.at(-1).text, event.text)
        order.push(['send', state.sessionId])
      }
      if (event.kind === 'closed') order.push(['closed', event.sessionId])
    },
  })
  env.track(release); await settle()
  assert.equal((await control.send('Keep the brief on restart')).ok, true)
  const firstId = control.snapshot().sessionId
  env.emit(firstId, { type: 'turn_completed', status: 'completed', turnId: 'restart-turn' })
  treeId = 'moved-tree'
  const restart = control.respawn(); await settle()
  assert.equal(control.beginPlacement().ok, false, 'a deferred restart remains one indivisible operation')
  assert.equal(env.calls.filter(([kind]) => kind === 'send').length, 1)
  assert.deepEqual(env.calls.filter(([kind]) => kind === 'start').map(([, value]) => value.treeIdentity.treeId), ['first-tree', 'moved-tree'])
  finishMapping(); assert.equal((await restart).ok, true)
  const nextId = control.snapshot().sessionId
  assert.notEqual(nextId, firstId)
  assert.deepEqual(order, [['open', firstId], ['send', firstId], ['wire', firstId], ['closed', firstId], ['open', nextId], ['send', nextId], ['wire', nextId]])
  assert.deepEqual(control.snapshot().transcript.map(row => [row.who, row.text]), [['you', 'Keep the brief on restart']])
  assert.equal((await control.terminate()).ok, true)
  assert.deepEqual(order.at(-1), ['closed', nextId])
  assert.equal(control.snapshot().lastTurnStatus, 'interrupted')
  assert.equal(control.snapshot().sessionId, null)
  release(); await settle()
  assert.deepEqual(env.calls.filter(([kind]) => kind === 'close').map(([, value]) => value.sessionId), [firstId, nextId])
})

/* T286/T88, the owner twice: "solo agents from the + must select a provider and
   a model", and on 2026-09-17 "your agent cant even pick a model or effort
   level". A standalone agent used to call bridge.start({ sessionId }) and
   nothing else, so the host planned it on its own default -- Codex -- and no
   choice the person made could reach it.

   THE PROGRAM RIDES ON THE TIER. START_TIERS in shell/agent-host.cjs and
   LAUNCH_TIERS in src/orchestration-controls.js both key provider off the tier
   row, and agent-host.cjs resolves `const sessionProvider = (startTier &&
   startTier.provider) || …`. So a tier IS the program-and-model choice and a
   separate provider control would be a second answer to one question. These
   cases prove that by starting a solo agent on Claude. */

test('a solo agent starts on the program and effort the person picked, not on a default', async t => {
  const env = environment(t)
  const panel = env.mount('solo-claude')
  panel.adapter.chooseStart({ tier: 'claude-sonnet', effort: 'high' })
  await send(panel, 'who are you?')
  const started = env.calls.find(([kind]) => kind === 'start')[1]
  assert.equal(started.tier, 'claude-sonnet', 'the chosen tier must reach the host')
  assert.equal(started.effort, 'high', 'the chosen effort must reach the host')
  assert.equal(started.surface, 'standalone-agent')
  assert.equal(started.treeIdentity, undefined, 'a solo agent still carries no tree identity')
  assert.equal(started.requestKeys, undefined, 'a solo agent still carries no tree insertion')
})

test('the solo picker offers the same programs and models as a tree agent, Claude among them', async t => {
  const env = environment(t)
  const panel = env.mount('solo-catalog')
  const offered = panel.adapter.startChoices()
  assert.ok(offered.tiers.length > 1, 'a picker with one row is not a choice')
  const byId = new Map(offered.tiers.map(choice => [choice.id, choice]))
  for (const id of ['astra', 'claude-sonnet', 'claude-opus']) {
    assert.ok(byId.has(id), `${id} must be offered on the solo surface`)
  }
  assert.equal(byId.get('claude-sonnet').provider, 'claude', 'the tier row is what names the program')
  assert.equal(byId.get('astra').provider, 'codex')
  assert.ok(offered.efforts.length > 1, 'effort must be choosable, not fixed')
})

test('the program a solo agent will start on is visible before the first send, and an unknown one is refused by name', async t => {
  const env = environment(t)
  const panel = env.mount('solo-visible')
  /* NOT 'no default' -- a VISIBLE one. The surface opens on the same row the
     compose panel opens on and says which it is, so nothing starts on a
     program the person never saw. That was the owner's complaint: not that a
     default existed, but that it was unreachable and unnamed. */
  const opening = panel.adapter.chosenStart()
  assert.ok(opening && opening.tier, 'the surface must name the program it will start on, before any send')
  const offered = panel.adapter.startChoices().tiers.map(choice => choice.id)
  assert.ok(offered.includes(opening.tier), 'the opening program must be one of the rows on offer')
  const refused = panel.adapter.chooseStart({ tier: 'no-such-program' })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'AGENT_STANDALONE_TIER_UNKNOWN')
  assert.deepEqual(panel.adapter.chosenStart(), opening, 'a refused choice must not become the choice')
  await send(panel, 'start on what is shown')
  assert.equal(env.calls.find(([kind]) => kind === 'start')[1].tier, opening.tier, 'it starts on what it showed')
})

/* T286 ITEM 3, STEP 1: THE COMPOSER CONTROLS. The owner, after the tools
   confusion was cleared up: "its not the agents tools that were missing. Its
   the users tools / chat surface". Attach and mention are the two a person
   reaches for first, and mountAgentSessionSurface passed neither -- so the +
   surface, the agent page and the home chat takeover all lacked them while the
   tree conversation had them.

   THE CONTROL IS ABSENT WHEN THE CAPABILITY IS, NEVER PRESENT AND DEAD. That
   is the rule the tree already follows (`...(pickAttachment ? { onAttach } : {})`
   in views/computers.js) and the second case below is what holds this seam to
   it: a bridge with no pickAttachment must draw no attach button, because a
   button that cannot do anything is worse than no button. */

test('the shared session surface offers attach and mention, wired to this session', async t => {
  const picked = []
  const env = environment(t)
  env.bridge.pickAttachment = async value => { picked.push(['attach', value]); return { ok: true, path: '/owned-session/report.pdf', name: 'report.pdf' } }
  env.bridge.pickMention = async value => { picked.push(['mention', value]); return { ok: true, text: '@Worker 3' } }
  const panel = env.mount('solo-composer')

  const attach = panel.chat().querySelector('[data-chat-attach]')
  const mention = panel.chat().querySelector('[data-chat-mention]')
  assert.ok(attach, 'the attach control must be on the shared surface, as it is on a tree conversation')
  assert.ok(mention, 'the mention control must be on the shared surface')

  await send(panel, 'first, so the session exists')
  const sessionId = env.calls.find(([kind]) => kind === 'start')[1].sessionId

  attach.click(); await settle()
  mention.click(); await settle()
  assert.deepEqual(picked.map(([kind]) => kind), ['attach', 'mention'], 'both controls must reach the bridge')
  for (const [kind, value] of picked) {
    assert.equal(value.sessionId, sessionId, `${kind} must be scoped to this session, not to a tree`)
  }
})

test('a surface whose bridge cannot attach or mention shows no control for it, rather than a dead one', t => {
  const env = environment(t)
  delete env.bridge.pickAttachment
  delete env.bridge.pickMention
  const panel = env.mount('solo-composer-unable')
  assert.equal(panel.chat().querySelector('[data-chat-attach]'), null,
    'a bridge with no pickAttachment must draw no attach control')
  assert.equal(panel.chat().querySelector('[data-chat-mention]'), null,
    'a bridge with no pickMention must draw no mention control')
})

/* THE OWNER, 2026-09-17, looking at the + agent page: "Give it a pop up menu
   to select what to spawn, and then give it the standard fucking chat
   interface. You are currently missing buttons and functionality, adding
   bullshit fuckass buttons where they dont belong" -- and "THE CHAT SURFACE
   FUCKING REUSE IT".

   The two selects I put in the chat header were the bullshit buttons. The
   choice belongs in a pop-up on +, before the chat exists; the chat is then the
   same surface a tree agent gets, with nothing added to it. */

test('pressing + opens a pop-up that chooses what to spawn, and the chat itself gains no controls of its own', t => {
  const env = environment(t)
  const panel = env.mount('solo-no-inline')
  assert.equal(panel.host.querySelector('[data-standalone-field=tier]'), null,
    'the program control does not belong in the conversation')
  assert.equal(panel.host.querySelector('[data-standalone-field=effort]'), null,
    'the effort control does not belong in the conversation')
  assert.equal(panel.host.querySelector('.tree-standalone-start'), null,
    'no standalone-only strip may sit on the chat')

  /* The chat is still the shared surface, so what it does have is what
     buildChat gave it -- the composer and its controls, not something this
     file drew. */
  assert.ok(panel.chat(), 'the standard chat surface must still be mounted')
  assert.ok(panel.input(), 'with its ordinary composer')
})

test('the spawn choice made in the pop-up is what starts, with no control left on the chat to change it', async t => {
  const env = environment(t)
  const panel = env.mount('solo-from-popup', { start: { tier: 'claude-opus', effort: 'high' } })
  await send(panel, 'who are you?')
  const started = env.calls.find(([kind]) => kind === 'start')[1]
  assert.equal(started.tier, 'claude-opus', 'the pop-up\'s program is what starts')
  assert.equal(started.effort, 'high', 'the pop-up\'s effort is what starts')
})

/* THE POP-UP, which is where the choice lives now. These three carry the
   intent of the cases that used to assert the inline selects: the catalog is
   offered, the effort re-defaults per program as the compose panel does, and
   what was chosen is what starts. The surface they act on moved from the
   conversation to the + dialog; the guarantees did not change. */

test('the + pop-up offers the same programs a tree agent can be given, Claude among them', t => {
  const owner = workspace(environment(t))
  owner.root.querySelector('.tree-new-agent').click()
  const notice = owner.root.querySelector('.tree-agent-notice')
  assert.equal(notice.hidden, false, 'pressing + must open the chooser')
  const tier = notice.querySelector('[data-spawn-field=tier]')
  const effort = notice.querySelector('[data-spawn-field=effort]')
  assert.ok(tier && effort, 'the chooser must offer a program and an effort')
  const offered = [...tier.querySelectorAll('option')].map(option => option.value)
  for (const id of ['astra', 'claude-sonnet', 'claude-opus']) {
    assert.ok(offered.includes(id), `${id} must be offered when spawning`)
  }
  assert.ok([...effort.querySelectorAll('option')].length > 1, 'effort must be choosable')
})

test('the pop-up re-defaults effort per program, so a previous row effort is never carried', t => {
  const owner = workspace(environment(t))
  owner.root.querySelector('.tree-new-agent').click()
  const notice = owner.root.querySelector('.tree-agent-notice')
  const tier = notice.querySelector('[data-spawn-field=tier]')
  const effort = notice.querySelector('[data-spawn-field=effort]')
  tier.value = 'sol'; tier.dispatch('change')
  effort.value = 'max'; effort.dispatch('change')
  tier.value = 'claude-sonnet'; tier.dispatch('change')
  assert.equal(effort.value, 'medium', 'a program with no effort of its own takes the same default a tree agent gets')
})

test('what the pop-up chose is what the agent starts on', async t => {
  const env = environment(t)
  const owner = workspace(env)
  owner.root.querySelector('.tree-new-agent').click()
  const notice = owner.root.querySelector('.tree-agent-notice')
  notice.querySelector('[data-spawn-field=tier]').value = 'claude-opus'
  notice.querySelector('[data-spawn-field=tier]').dispatch('change')
  notice.querySelector('.tree-agent-continue').click()
  await settle()
  assert.equal(notice.hidden, true, 'the chooser closes once the agent is opened')
  const record = [...owner.standalone.values()].at(-1)
  assert.ok(record, 'an agent tab must have opened')
  assert.equal(record.session.chosenStart().tier, 'claude-opus', 'the chosen program is what the agent will start on')
})

/* T286 ITEM 4 + THE CHAT HALF. The owner: "THE CHAT SURFACE FUCKING REUSE IT",
   and the controls ruling: the chat that opens from the pop-up is the TREE
   CONVERSATION's chat, served by the tree's own builder rather than by options
   copied one at a time into the shared mount.

   The seam is a closure handed down from computersView, which already injects
   live/bridge/persistenceKey for standalone agents. It hands down two more: a
   seat declaration, so the agent has an enabled role and a name the App
   permissions roster can show, and the chat builder itself, called with that
   seat. treeChatConfigFor() reads only id, message, reply, role, sessionId and
   statusNote from a node and every one of its fourteen treeStore.getNode calls
   falls back to the node it was handed, so a seat is served by construction. */

test('the standalone mount serves the chat its host built for the seat, not a chat of its own', async t => {
  const env = environment(t)
  const built = []
  delete env.bridge.pickAttachment
  delete env.bridge.pickMention
  const panel = env.mount('solo-tree-chat', {
    seat: { id: 'seat-1', name: 'Agent 1', tier: 'claude-sonnet', role: 'worker' },
    chatConfigFor: seat => {
      built.push(seat)
      return { onAttach: async () => null, queue: { list: () => [], hold: () => ({ ok: true }) }, actions: () => [{ id: 'copy', label: 'Copy' }] }
    },
  })
  assert.deepEqual(built.map(seat => seat.id), ['seat-1'], 'the host builder must be called with the seat, once')
  assert.equal(built[0].tier, 'claude-sonnet', 'the seat carries what the pop-up chose')
  /* AND ITS OUTPUT MUST REACH THE CHAT, which calling the builder does not by
     itself prove. The bridge here has no pickAttachment, so this surface adds
     no attach control of its own; an attach button can only be the host
     config's. Without this the case stays green when the built config is
     dropped on the way to buildChat -- measured. */
  assert.ok(panel.chat().querySelector('[data-chat-attach]'),
    'the control the host built must be on the chat, not merely built')
})

test('a standalone mount with no host builder still opens its chat, so the tab is never empty', t => {
  const env = environment(t)
  const panel = env.mount('solo-no-builder')
  assert.ok(panel.chat(), 'a caller that supplies no builder must still get a conversation')
  assert.ok(panel.input(), 'with its composer')
})

/* WORKER 82 ON SCREEN AT 0e50eabb: attach and mention were enabled, their
   bridge methods were functions, and pressing either did nothing -- no picker,
   no sentence, no change. Two of my own lines did that. `.catch(() => null)`
   turned every refusal into silence, and an early `if (!sessionId) return null`
   did the same before a session existed, which is how mention LOST the refusal
   it used to give. A control that answers nothing is worse than one that
   refuses: a person cannot tell a broken button from a busy one. */

test('a refused pick leaves the person a sentence instead of silence', async t => {
  const env = environment(t)
  env.bridge.pickAttachment = async () => { throw Object.assign(new Error('no'), { code: 'MC_AGENT_ATTACH_REFUSED' }) }
  env.bridge.pickMention = async () => { throw Object.assign(new Error('no'), { code: 'MC_AGENT_MENTION_REFUSED' }) }
  const panel = env.mount('solo-refusals')
  await send(panel, 'first, so a session exists')
  /* COMPARED BEFORE AND AFTER, not asserted against a non-empty chat. A first
     version checked textContent matched /\w/, which is true of any chat and
     stayed green while attach still swallowed its refusal -- the same shape of
     weak assertion that let 0e50eabb pass review and fail on screen. */
  const before = panel.chat().textContent
  panel.chat().querySelector('[data-chat-attach]').click(); await settle()
  const afterAttach = panel.chat().textContent
  assert.notEqual(afterAttach, before, 'a refused attach must say something, not nothing')
  panel.chat().querySelector('[data-chat-mention]').click(); await settle()
  assert.notEqual(panel.chat().textContent, afterAttach, 'a refused mention must say something too')
})

test('a picker is asked even before the first send, so the control is never inert', async t => {
  const env = environment(t)
  const asked = []
  env.bridge.pickAttachment = async value => { asked.push(value); return { ok: true, path: '/owned/a.png', name: 'a.png' } }
  env.bridge.pickMention = async value => { asked.push(value); return { ok: true, text: '@someone' } }
  const panel = env.mount('solo-before-send')
  panel.chat().querySelector('[data-chat-attach]').click(); await settle()
  panel.chat().querySelector('[data-chat-mention]').click(); await settle()
  assert.equal(asked.length, 2, 'both pickers must be asked with no session yet; an early return is how they went inert')
})

/* T286 ITEM 4, THE LAST PIECE: THE SESSION HAS TO CARRY THE SEAT'S IDENTITY.
 *
 * Declaring the seat (already landed) is what puts the agent in the org
 * record. It is NOT what tells the host which agent a session belongs to.
 * `treeIdentity` carries selfName and managerName only; measured at 88bc31ae,
 * the single route by which an agentId reaches shell/main.cjs is the
 * `roleBinding` field of the start, and shell/screen-control-host.cjs refuses
 * SCREEN_ROLE_UNAVAILABLE when readBinding(agentId) finds nothing. So a solo
 * session with a declared seat and no roleBinding is still anonymous on the
 * wire: the App permissions list shows a raw session id and computer control
 * cannot be granted to it. These cases close that.
 *
 * THE BINDING IS BUILT AT START, NOT AT MOUNT, and that is the point of
 * passing a function rather than a value. A tab can sit open for hours; the
 * org and role revisions in the binding are checked by the host against the
 * record as it is AT START, and a binding minted when the tab opened would be
 * refused AGENT_ROLE_BINDING_INVALID the moment anything edited a role. */

const SEAT = { id: 'standalone-seat-1', name: 'Agent 1', role: 'worker', tier: 'claude-opus' }
const bindingFor = seat => ({ ok: true, binding: { agentId: seat.id, id: 'worker', expectedOrgRevision: 4, expectedRoleRevision: 2 } })

test('a solo agent with a declared seat carries that seat identity to the host, so the roster can name it', async t => {
  const env = environment(t)
  const panel = env.mount('solo-bound', { seat: SEAT, roleBindingFor: bindingFor })
  await send(panel, 'who am I to this computer?')
  const started = env.calls.find(([kind]) => kind === 'start')[1]
  assert.deepEqual(started.roleBinding, bindingFor(SEAT).binding,
    'THE DEFECT: the declared seat identity never reached the host, so the session is anonymous on the wire')
  assert.equal(started.roleBinding.agentId, SEAT.id, 'the binding must name the seat that was declared, not some other agent')
  /* Still a solo agent in every other respect. */
  assert.equal(started.surface, 'standalone-agent')
  assert.equal(started.treeIdentity, undefined, 'binding an identity must not make this a tree agent')
  assert.equal(started.requestKeys, undefined)
})

test('the binding is minted at the send, not when the tab opened', async t => {
  const env = environment(t)
  let revision = 4
  const panel = env.mount('solo-fresh-binding', {
    seat: SEAT,
    roleBindingFor: seat => ({ ok: true, binding: { agentId: seat.id, id: 'worker', expectedOrgRevision: revision, expectedRoleRevision: 2 } }),
  })
  /* Somebody edits a role while this tab sits open. */
  revision = 9
  await send(panel, 'start now')
  assert.equal(env.calls.find(([kind]) => kind === 'start')[1].roleBinding.expectedOrgRevision, 9,
    'a binding minted at mount would be stale, and the host refuses a stale one')
})

test('a solo agent whose seat could not be bound still opens and still starts, and never invents an identity', async t => {
  const env = environment(t)
  /* No Role library on this page: ensureSeatForNode and roleBindingForStart
     both refuse. Refusing to start here would take the whole solo chat away
     over a permission the chat does not need. */
  const refused = env.mount('solo-unbound', { seat: SEAT, roleBindingFor: () => ({ ok: false, code: 'MC_TREE_IDENTITY_UNAVAILABLE', message: 'no role library' }) })
  await send(refused, 'still work please')
  const refusedStart = env.calls.find(([kind]) => kind === 'start')[1]
  assert.equal(refusedStart.roleBinding, undefined, 'a refused binding must not be sent, and must not be faked')
  assert.equal(refusedStart.tier, 'astra', 'the start must still carry the chosen program')

  /* And a binder that throws is the same answer: a broken org read must not
     brick the conversation. */
  env.calls.length = 0
  const thrown = env.mount('solo-throwing', { seat: SEAT, roleBindingFor: () => { throw new Error('org read exploded') } })
  await send(thrown, 'still work please')
  const thrownStart = env.calls.find(([kind]) => kind === 'start')[1]
  assert.ok(thrownStart, 'a throwing binder stopped the start entirely')
  assert.equal(thrownStart.roleBinding, undefined)

  /* AND THE VERDICT IS WHAT DECIDES, NOT THE PRESENCE OF A BINDING. A refusal
     that still carries one is the dangerous shape: roleBindingForStart pins
     the org and role revisions inside the binding, so a refused-but-populated
     answer is exactly a stale binding, and sending it asks the host to
     authorise a session against revisions this page already knows are wrong.
     Reading `ok` rather than `binding?.agentId` is what makes that impossible,
     and without this case that distinction is untested. */
  env.calls.length = 0
  const stale = env.mount('solo-stale-binding', {
    seat: SEAT,
    roleBindingFor: seat => ({ ok: false, code: 'MC_TREE_IDENTITY_UNAVAILABLE', message: 'the role moved under us',
      binding: { agentId: seat.id, id: 'worker', expectedOrgRevision: 1, expectedRoleRevision: 1 } }),
  })
  await send(stale, 'do not send that')
  assert.equal(env.calls.find(([kind]) => kind === 'start')[1].roleBinding, undefined,
    'a refused binding was sent because the code trusted the binding instead of the verdict')
})

test('with no seat there is nothing to bind, and the start is exactly what it was', async t => {
  const env = environment(t)
  const panel = env.mount('solo-seatless', { roleBindingFor: bindingFor })
  await send(panel, 'unseated')
  const started = env.calls.find(([kind]) => kind === 'start')[1]
  assert.equal(started.roleBinding, undefined,
    'a binder called with no seat would bind an agent that was never declared')
})

test('the workspace hands the page its seat and its binder, so the whole chain runs, not just the end of it', async t => {
  const env = environment(t)
  const owner = workspace(env)
  const declared = []
  const bound = []
  /* Exactly the shape src/views/computers.js injects: a declareSeat that
     answers with the seat object, and a roleBindingFor closure over this
     page's own org read. Testing mountStandaloneAgent alone would leave the
     two hops in between unmeasured, and a value that is wired but never
     forwarded is the failure this case exists to catch. */
  owner.graph.standaloneAgent.declareSeat = async ({ id, name, tier }) => {
    const seat = { id, name, role: 'worker', tier, parentId: null, sessionId: null, message: '', reply: '', statusNote: '' }
    declared.push(seat)
    return seat
  }
  owner.graph.standaloneAgent.roleBindingFor = seat => {
    bound.push(seat.id)
    return { ok: true, binding: { agentId: seat.id, id: seat.role, expectedOrgRevision: 7, expectedRoleRevision: 3 } }
  }
  await owner.openStandalone({ tier: 'claude-opus', effort: 'high' })
  await settle()
  const record = [...owner.standalone.values()][0]
  assert.ok(record, 'no standalone tab was opened, so this case measures nothing')
  assert.equal(declared.length, 1, 'the workspace did not declare a seat')

  const panel = record.chatPanel
  const input = panel.querySelector('.chat-input input')
  input.value = 'who am I?'
  input.dispatch('input')
  panel.querySelector('.chat-send').click()
  await settle()

  const started = env.calls.find(([kind]) => kind === 'start')
  assert.ok(started, 'nothing was started')
  assert.deepEqual(started[1].roleBinding, { agentId: declared[0].id, id: 'worker', expectedOrgRevision: 7, expectedRoleRevision: 3 },
    'the binder reached the mount but its answer never reached the host')
  assert.deepEqual(bound, [declared[0].id], 'the binder must be asked about the seat that was declared, exactly once per start')
  assert.equal(started[1].tier, 'claude-opus', 'the program the pop-up chose must still ride')
})

/* THE SEAT WAS NEVER ACTUALLY DECLARED, AND NOTHING SAID SO.
 *
 * Found on a built candidate at 3d93d991 by calling the page's own
 * declareSeat: `standalone:<uuid>` came back
 * MC_FLEET_PROFILE_ACTION_FAILED / "A seat id must be a lowercase declared
 * agent id.", while `standalone-<uuid>` was declared. The colon is the whole
 * difference. shell/agent-command-surface.cjs 'org:ensure-seat' bounds the id
 * exactly as every declared agent id is bounded, and a colon is not in that
 * set.
 *
 * So every + agent ever opened asked for a seat, was refused, and opened its
 * chat anyway -- which is correct behaviour for a refusal and also why the App
 * permissions roster kept showing a raw session id. The seat work looked
 * landed because the refusal is deliberately not fatal.
 *
 * THE RULE IS LIFTED FROM THE SHELL, NOT RETYPED HERE. A copy of the pattern
 * in this file would let the two drift, and then this case would go on passing
 * against a rule the product no longer has. */
const seatIdRule = (() => {
  const source = readFileSync(new URL('../../shell/agent-command-surface.cjs', import.meta.url), 'utf8')
  const guard = /'org:ensure-seat'[\s\S]*?if \(!(\/[^/]+\/)\.test\(id\)\)/.exec(source)
  assert.ok(guard, 'the seat id guard could not be found in the shell, so this case cannot measure anything')
  return new RegExp(guard[1].slice(1, -1))
})()

test('the id a new solo agent is given is one the seat store will actually accept', async t => {
  const env = environment(t)
  const owner = workspace(env)
  const asked = []
  /* The real refusal, applied here: the shell's own rule, on the id the
     workspace mints. A stand-in that accepts anything would have kept this
     green for as long as the product was broken. */
  owner.graph.standaloneAgent.declareSeat = async ({ id, name, tier }) => {
    asked.push(id)
    if (!seatIdRule.test(id)) return { ok: false, error: { code: 'MC_AGENT_SEAT_ID_INVALID', message: 'A seat id must be a lowercase declared agent id.' } }
    return { id, name, role: 'worker', tier, parentId: null, sessionId: null, message: '', reply: '', statusNote: '' }
  }
  let boundSeat = null
  owner.graph.standaloneAgent.roleBindingFor = seat => {
    boundSeat = seat.id
    return { ok: true, binding: { agentId: seat.id, id: seat.role, expectedOrgRevision: 2, expectedRoleRevision: 1 } }
  }
  await owner.openStandalone({ tier: 'claude-opus' })
  await settle()

  assert.equal(asked.length, 1, 'no seat was asked for at all')
  assert.match(asked[0], seatIdRule,
    'THE DEFECT: the solo agent asks for a seat under an id the store refuses, so it never gets one')

  /* And because it now gets one, the identity reaches the host. Without this
     half the case above could pass on an id nobody uses. */
  const record = [...owner.standalone.values()][0]
  const input = record.chatPanel.querySelector('.chat-input input')
  input.value = 'who am I?'
  input.dispatch('input')
  record.chatPanel.querySelector('.chat-send').click()
  await settle()
  assert.equal(boundSeat, asked[0], 'the declared seat is not the one the binder was asked about')
  assert.equal(env.calls.find(([kind]) => kind === 'start')[1].roleBinding.agentId, asked[0],
    'the seat was declared and then a different identity, or none, was sent')
})

/* SERVING THE TREE'S CHAT MUST NOT BORROW THE TREE'S REASON FOR NOT SENDING.
 *
 * Found on a built candidate at 9c090ce9, on screen: with a real seat the +
 * chat finally gets the tree conversation's own configuration -- Actions,
 * attach, mention, /goal, /loop, the subtitle -- and its composer went dead.
 * Measured in the running window: input.disabled true, send.disabled true, and
 * a .chat-nosend note reading "This agent is not running, so there is nothing
 * here to send a message to."
 *
 * That sentence is true of a TREE node, which is started from the canvas and
 * whose conversation is a place to read what it said. It is false of a solo
 * agent, which has no Start control anywhere and whose whole design is that
 * the first send is what starts it. treeChatConfigFor supplies
 * `composerReason` for a node that is not running, mountAgentSessionSurface
 * spreads the host configuration first, and it only sets `composerReason`
 * itself on the branch where there is no composer -- so nothing overrode it.
 *
 * The rule this pins: a surface that owns a composer owns whether it can be
 * used. Anything else and reusing the tree's chat costs the solo agent the one
 * control it cannot do without. */

test('a solo agent served the tree chat can still send, even while the tree would say it is not running', async t => {
  const env = environment(t)
  const seat = { id: 'standalone-live-composer', name: 'Agent 1', role: 'worker', tier: 'astra' }
  const panel = env.mount('solo-live-composer', {
    seat,
    /* Exactly what treeChatConfigFor answers for a seat with no session: the
       full tree configuration, composerReason and all. */
    chatConfigFor: () => ({
      subtitle: 'your agent · not running',
      actionsNote: 'Not possible yet, so not listed: attaching a text file.',
      composerReason: 'This agent is not running, so there is nothing here to send a message to.',
    }),
  })

  const input = panel.input()
  assert.ok(input, 'the solo surface drew no composer at all')
  assert.equal(input.disabled, false,
    'THE DEFECT: serving the tree chat disabled the solo composer, and a solo agent has no other way to start')
  const sendButton = panel.chat().querySelector('.chat-send')
  assert.equal(sendButton.disabled, false, 'the Send control was disabled by the tree reason')

  await send(panel, 'start me')
  const started = env.calls.find(([kind]) => kind === 'start')
  assert.ok(started, 'the send never reached the host, so the solo agent could never be started at all')

  /* And the rest of the tree configuration is still served -- the fix must be
     to ignore one field, not to stop reusing the chat. */
  assert.ok(panel.chat().textContent.includes('your agent'), 'the tree subtitle must still be served')
})

/* EACH CONTROL IN THE POP-UP OWNS ITS OWN NAME.
 *
 * On screen at 4ad57e6b the panel had no layout rules at all, so its two
 * labelled selects and its two buttons flowed as inline content and wrapped
 * wherever the panel ran out of room: "Program and model [select] Effort"
 * ended one line and "[select] [Open agent tab] [Cancel]" began the next. A
 * person reads a label as belonging to the control beside it, so that put the
 * word Effort next to the program control and the effort control next to the
 * buttons -- wrong twice, about the one choice this pop-up exists to make.
 *
 * A stand-in cannot lay anything out, so what is pinned here is the STRUCTURE
 * the layout rests on: every select is inside the label that names it, and the
 * buttons are in a row container of their own rather than loose among the
 * fields. That is what makes the wrap impossible; a rule on its own could be
 * deleted and only a screenshot would notice. The screen is checked by hand as
 * well -- see the commit. */
test('the spawn pop-up keeps every control inside the label that names it, and its buttons out of the fields', async t => {
  const env = environment(t)
  const owner = workspace(env)
  owner.showPicker(true)
  const notice = owner.root.querySelector('.tree-agent-notice')
  assert.ok(notice, 'the pop-up is not in the panel at all')

  for (const field of ['tier', 'effort']) {
    const select = notice.querySelector(`[data-spawn-field=${field}]`)
    assert.ok(select, `the ${field} control is missing`)
    const label = select.closest('.tree-agent-spawn-field')
    assert.ok(label, `the ${field} control is not inside a field that names it, so nothing ties the two together`)
    const name = label.querySelector('span')
    assert.ok(name && name.textContent.trim().length > 0, `the ${field} control has no visible name`)
  }

  const actions = notice.querySelector('.tree-agent-notice-actions')
  assert.ok(actions, 'the buttons are loose among the fields, which is what let a label wrap next to one')
  assert.ok(actions.querySelector('.tree-agent-continue'), 'the confirm button is not in the actions row')
  assert.ok(actions.querySelector('.tree-agent-cancel'), 'Cancel is not in the actions row')
  /* And no field slipped into the button row. */
  assert.equal(actions.querySelector('[data-spawn-field]'), null,
    'a choice control is sitting in the button row, where its name is not')
})

/* WHAT THIS AGENT RUNS ON, WHERE THE PERSON IS LOOKING.
 *
 * Worker 82's page-2 sweep: nothing on the + chat says which program or
 * effort the agent runs on -- the only way to find out was to ask the agent.
 * The choice is made once in the pop-up and then becomes invisible, which is
 * the same complaint the pop-up itself was built for, one step later.
 *
 * It is also the last of (a). Measured in the running window at d2c5c2fc with
 * both surfaces holding a real transcript, the + chat was missing exactly
 * data-chat-chip and data-chat-header-status against the tree conversation.
 * The chips do not come from treeChatConfigFor for a solo agent and cannot:
 * that function early-returns a no-session configuration for any node with
 * sessionId null, which a seat always is, and that branch carries no chips at
 * all. A solo agent's program is its own fact anyway -- chosen in its pop-up,
 * not held by a tree -- so the surface that owns the choice supplies the chip.
 *
 * THE CHIP MUST NEVER DESCRIBE A SESSION THAT IS NOT RUNNING. Once a session
 * has started it is on the row it started with, and picking a different one
 * changes what the NEXT start uses. A chip that flipped to the new name would
 * be telling the person their running agent had changed model when it had
 * not, which is worse than not showing it at all. */

const chipText = panel => {
  const chip = panel.chat().querySelector('[data-chat-chip="tier"]')
  return chip ? { hidden: chip.hidden, label: chip.textContent } : null
}

test('the + chat says which program and effort it will run on, before anything is sent', async t => {
  const env = environment(t)
  const panel = env.mount('solo-chip', { start: { tier: 'claude-opus', effort: 'high' } })
  const chip = chipText(panel)
  assert.ok(chip, 'THE DEFECT: the + chat carries no chip naming what it runs on')
  assert.equal(chip.hidden, false, 'the chip is present but hidden, so the person still cannot see it')
  assert.match(chip.label, /Opus/, 'the chip must name the program and model that was chosen')
  assert.match(chip.label, /high/, 'the chip must name the effort that was chosen')
})

test('the chip follows the choice while nothing is running, and stops following once something is', async t => {
  const env = environment(t)
  const panel = env.mount('solo-chip-follows', { start: { tier: 'claude-opus', effort: 'high' } })
  panel.adapter.chooseStart({ tier: 'claude-sonnet', effort: 'low' })
  await settle()
  assert.match(chipText(panel).label, /Sonnet/, 'the chip did not follow a change made before the first send')
  assert.match(chipText(panel).label, /low/)

  await send(panel, 'start now')
  const started = env.calls.find(([kind]) => kind === 'start')[1]
  assert.equal(started.tier, 'claude-sonnet', 'what the chip showed is not what started')

  /* Now something IS running. */
  panel.adapter.chooseStart({ tier: 'claude-opus', effort: 'max' })
  await settle()
  assert.match(chipText(panel).label, /Sonnet/,
    'the chip renamed a RUNNING session, telling the person their agent had changed model when it had not')
  assert.match(chipText(panel).label, /low/)
})

test('the chip is the door to changing it, and the host is asked rather than a second menu invented', async t => {
  const env = environment(t)
  const asked = []
  const panel = env.mount('solo-chip-door', {
    start: { tier: 'claude-opus', effort: 'high' },
    /* The host owns the chooser: the pop-up already exists, is already the
       one the person used to open this tab, and a second menu here would be
       exactly the "bullshit fuckass buttons where they dont belong" the
       inline selects were removed for. */
    onChangeStart: (current, apply) => { asked.push(current); apply({ tier: 'claude-sonnet', effort: 'low' }) },
  })
  panel.chat().querySelector('[data-chat-chip="tier"]').click()
  await settle()
  assert.equal(asked.length, 1, 'THE DEFECT: the chip is not a door to anything')
  assert.equal(asked[0].tier, 'claude-opus', 'the host must be told what the agent is on now, or it cannot show it')
  assert.match(chipText(panel).label, /Sonnet/, 'what the host chose did not become the choice')
  await send(panel, 'go')
  assert.equal(env.calls.find(([kind]) => kind === 'start')[1].tier, 'claude-sonnet',
    'the changed choice did not reach the host')
})

test('changing it while a session runs says so in the conversation instead of pretending', async t => {
  const env = environment(t)
  const panel = env.mount('solo-chip-running', {
    start: { tier: 'claude-opus', effort: 'high' },
    onChangeStart: (current, apply) => apply({ tier: 'claude-sonnet', effort: 'low' }),
  })
  await send(panel, 'start now')
  const before = panel.chat().textContent
  panel.chat().querySelector('[data-chat-chip="tier"]').click()
  await settle()
  const said = panel.chat().textContent
  assert.notEqual(said, before, 'nothing was said at all, so the person is left to guess')
  assert.match(said, /next|new agent|already running|this one/i,
    'the sentence must say when the change takes effect, not merely that something happened')
  /* And it must not have silently renamed the running session. */
  assert.match(chipText(panel).label, /Opus/, 'the running session was renamed after all')
})

test('the chip opens the workspace own pop-up, and what is picked there changes that agent alone', async t => {
  const env = environment(t)
  const owner = workspace(env)
  await owner.openStandalone({ tier: 'claude-opus', effort: 'high' })
  await settle()
  const record = [...owner.standalone.values()][0]
  const chip = record.chatPanel.querySelector('[data-chat-chip="tier"]')
  assert.ok(chip, 'the mounted agent has no chip, so nothing below is measured')
  assert.match(chip.textContent, /Opus/, 'the chip does not name what this agent was opened on')

  const notice = owner.root.querySelector('.tree-agent-notice')
  assert.equal(notice.hidden, true, 'the pop-up is already open, so this case cannot tell what opened it')
  chip.click()
  await settle()
  assert.equal(notice.hidden, false, 'THE DEFECT: the chip opened nothing the person can use')
  assert.equal(notice.querySelector('[data-spawn-field=tier]').value, 'claude-opus',
    'the pop-up must open on what this agent is on, not on the default')

  notice.querySelector('[data-spawn-field=tier]').value = 'claude-sonnet'
  notice.querySelector('[data-spawn-field=effort]').value = 'low'
  owner.root.querySelector('.tree-agent-continue').click()
  await settle()
  assert.equal(notice.hidden, true, 'the pop-up stayed open after being answered')
  assert.match(record.chatPanel.querySelector('[data-chat-chip="tier"]').textContent, /Sonnet/,
    'the pick did not reach the agent whose chip opened the pop-up')

  /* AND IT DID NOT OPEN A SECOND AGENT. The same button normally spawns one;
     reusing the panel must not also reuse that meaning, or a person changing
     a model would silently get two agents and pay for both. */
  assert.equal(owner.standalone.size, 1, 'changing the program opened a second agent as well')
})

test('cancelling the chip pop-up changes nothing, and the next + still opens a new agent', async t => {
  const env = environment(t)
  const owner = workspace(env)
  await owner.openStandalone({ tier: 'claude-opus', effort: 'high' })
  await settle()
  const record = [...owner.standalone.values()][0]
  record.chatPanel.querySelector('[data-chat-chip="tier"]').click()
  await settle()
  owner.root.querySelector('.tree-agent-cancel').click()
  await settle()
  assert.match(record.chatPanel.querySelector('[data-chat-chip="tier"]').textContent, /Opus/,
    'cancelling changed the agent anyway')

  /* The door must have closed behind it: the next press of + is a spawn
     again, not another change to that first agent. */
  owner.root.querySelector('.tree-new-agent').click()
  await settle()
  owner.root.querySelector('.tree-agent-continue').click()
  await settle()
  assert.equal(owner.standalone.size, 2, 'the + button stopped opening agents after a chip change was cancelled')
})

/* T300. A + agent's turns were written NOWHERE: Worker 82 measured three
   replies from + agents landing in zero files under the state root while
   tree-agent replies resolved to node.json and .text files. The shell's
   capture already records both halves of every turn, and both halves begin
   "if there is no binding for this session, return" -- a tree node gets its
   binding from the start's requestKeys.threadId, and a seat has neither. The
   seat id is the key T300 asks to read the conversation back by. */
test('a solo agent binds its session to its own seat so its turns are written down', async t => {
  const env = environment(t)
  const bound = [], released = []
  const panel = env.mount('Seat-A', {
    transcript: {
      bind: (sessionId, seatId) => { bound.push([sessionId, seatId]); return Promise.resolve({ ok: true }) },
      release: sessionId => { released.push(sessionId); return Promise.resolve({ ok: true, released: true }) },
    },
  })
  await settle()
  assert.deepEqual(bound, [], 'mounting a tab binds nothing; there is no session yet')

  await send(panel, 'First question')
  const sessionId = env.calls.find(([kind]) => kind === 'start')[1].sessionId
  assert.deepEqual(bound, [[sessionId, 'Seat-A']], 'the session is bound to the seat id, once')

  env.emit(sessionId, { type: 'assistant_text_delta', text: 'An answer', turnId: 'turn-1' })
  env.emit(sessionId, { type: 'turn_completed', status: 'completed', turnId: 'turn-1' })
  await settle()
  await send(panel, 'Second question')
  assert.equal(bound.length, 1, 'a second turn on the same session does not re-bind')
  assert.deepEqual(released, [], 'nothing is released while the seat still owns the session')
})

/* The other half, and it is why bind() in the capture may stay strict: placing
   a + agent hands the SAME session to a tree node, which the capture refuses
   outright rather than silently repointing a live binding. The seat lets go
   first, so the tree's own binding is accepted instead of thrown away. */
test('placing a solo agent releases its seat binding before the tree claims the session', async t => {
  const env = environment(t)
  const released = []
  const panel = env.mount('Seat-B', {
    transcript: {
      bind: () => Promise.resolve({ ok: true }),
      release: sessionId => { released.push(sessionId); return Promise.resolve({ ok: true, released: true }) },
    },
  })
  await settle()
  await send(panel, 'A question before being placed')
  const sessionId = env.calls.find(([kind]) => kind === 'start')[1].sessionId
  assert.deepEqual(released, [], 'an unplaced seat holds its binding')

  const answer = await panel.adapter.releaseTranscript(sessionId)
  assert.deepEqual(released, [sessionId], 'the handover releases exactly this session')
  assert.equal(answer.released, true, 'the release says it happened')

  const again = await panel.adapter.releaseTranscript(sessionId)
  assert.equal(released.length, 1, 'releasing twice releases once')
  assert.equal(again.released, false, 'and says plainly that there was nothing left to release')
})

test('a solo agent with no transcript bridge keeps the draft and closes its unbound session without sending', async t => {
  const env = environment(t)
  const panel = env.mount('Seat-C', { transcript: null })
  await settle()
  await send(panel, 'Keep until a record can be bound')
  const sessionId = env.calls.find(([kind]) => kind === 'start')[1].sessionId
  assert.equal(env.calls.some(([kind]) => kind === 'send'), false)
  assert.deepEqual(env.calls.filter(([kind]) => kind === 'close').map(([, value]) => value.sessionId), [sessionId])
  assert.equal(panel.input().value, 'Keep until a record can be bound')
  assert.equal((await panel.adapter.releaseTranscript(sessionId)).released, false)
})

/* T292. Worker 85, on screen: open a + / New agent tab while the "running
   agents" master switch is OFF, turn it ON, and the tab stays header-only --
   no chat, no composer -- until it is closed and a new one opened. The switch
   being thrown in SETTINGS is the part that makes it stick: the tab's own
   enable button already worked, and nothing else told this surface the world
   had changed. setWriteEnabled announces every durable change on
   WRITE_FLAGS_EVENT; the surface now listens. */
test('a + tab opened while running agents is off becomes usable when the switch is turned on elsewhere', async t => {
  const env = environment(t, { enabled: false })
  const panel = env.mount('Switched-off tab')
  await settle()
  /* Identity compared through a boolean. assert.equal on a DOM node that is
     NOT null builds a diff of the whole element graph, which on this stand-in
     exhausts the heap and kills the runner -- the failure stops being readable
     exactly when the guard is doing its job. */
  assert.ok(panel.chat() === null, 'the tab opens with no conversation while the switch is off')
  assert.ok(panel.host.querySelector('[data-session-enable]'))

  setWriteEnabled('agent-session', true)
  await settle()

  assert.ok(panel.host.querySelector('[data-session-enable]') === null, 'the off surface is gone')
  assert.ok(panel.chat(), 'the conversation is built in place')
  assert.ok(panel.input(), 'and so is the composer, without closing and reopening the tab')
  assert.equal(env.calls.length, 0, 'revealing the controls starts nothing')

  await send(panel, 'A question on the recovered tab')
  assert.equal(env.calls.filter(([kind]) => kind === 'start').length, 1, 'the recovered tab can actually start an agent')
})

/* The other direction is deliberately NOT rebuilt: a switch thrown on another
   page must not take away a conversation that is open, or an agent that is
   running, from under the person using it. */
test('turning running agents off elsewhere does not tear down an open conversation', async t => {
  const env = environment(t)
  const panel = env.mount('Open tab')
  await settle()
  await send(panel, 'A question before the switch moved')
  const sessionId = env.calls.find(([kind]) => kind === 'start')[1].sessionId
  assert.ok(panel.chat())

  setWriteEnabled('agent-session', false)
  await settle()

  assert.ok(panel.chat(), 'the open conversation stays on the screen')
  assert.ok(panel.host.querySelector('[data-session-enable]') === null, 'it is not replaced by the off surface')
  env.emit(sessionId, { type: 'assistant_text_delta', text: 'Still answering', turnId: 'turn-1' })
  env.emit(sessionId, { type: 'turn_completed', status: 'completed', turnId: 'turn-1' })
  await settle()
  assert.match(panel.chat().textContent, /Still answering/, 'and the running agent still reaches it')
})

/* A released surface must not be rebuilt by an announcement that arrives after
   it is gone: the listener is removed with everything else it owns. */
test('a released session surface does not rebuild itself when the switch moves afterwards', async t => {
  const env = environment(t, { enabled: false })
  const host = env.document.createElement('div'); env.document.body.appendChild(host)
  const release = mountAgentSessionSurface(host, { live: true, bridge: env.bridge, agentId: 'gone', chatComposer: true })
  await settle()
  assert.ok(host.querySelector('[data-session-enable]'))
  release()
  setWriteEnabled('agent-session', true)
  await settle()
  assert.ok(host.querySelector('[data-chat-panel]') === null, 'nothing is built into a host whose surface was released')
  assert.ok(host.querySelector('[data-session-enable]') === null)
})

const queueStrip = panel => panel.host.querySelector('.chat-queue-strip')
const queueRows = panel => [...(queueStrip(panel)?.querySelectorAll('.chat-queue-row') || [])]
const queueTexts = panel => queueRows(panel).map(row => row.querySelector('.chat-queue-text')?.textContent)
const sentTexts = env => env.calls.filter(([kind]) => kind === 'send').map(([, value]) => value.text)

/* T294. Worker 85, on screen: Halt and Send now DO render on the + chat while
   it is busy, but Send next, Unqueue and the queue strip never appear, and a
   second message sent while the first was running was not queued at all -- it
   was lost. `queue` is a buildChat option and the + surface supplied none,
   because treeChatConfigFor early-returns a no-session configuration for any
   node whose sessionId is null, which a seat always is. The owner's standard
   for this surface was "its the same agent system". */
test('a message sent to a busy + agent waits in the strip instead of vanishing', async t => {
  const env = environment(t)
  const panel = env.mount('Queue-A')
  await settle()
  await send(panel, 'First question')
  assert.deepEqual(sentTexts(env), ['First question'], 'the first send starts the agent and goes')
  assert.equal(queueStrip(panel)?.hidden, true, 'nothing waits yet, so the strip is not drawn')

  await send(panel, 'Second while busy')
  await send(panel, 'Third while busy')

  assert.equal(queueStrip(panel)?.hidden, false, 'the strip appears when something is waiting')
  assert.deepEqual(queueTexts(panel), ['Second while busy', 'Third while busy'], 'in the order they were typed')
  assert.deepEqual(sentTexts(env), ['First question'], 'and neither was put on the wire while a turn was running')
  assert.ok(queueStrip(panel).querySelector('.chat-queue-next'), 'Send next renders')
  assert.ok(queueStrip(panel).querySelector('.chat-queue-cancel'), 'Unqueue renders')
})

/* One per completed turn, in order, exactly once each: the engine's "I am
   free" signal is the only thing that releases a waiting message. */
test('each finished turn on a + agent sends exactly one waiting message, in order', async t => {
  const env = environment(t)
  const panel = env.mount('Queue-B')
  await settle()
  await send(panel, 'One')
  const sessionId = env.calls.find(([kind]) => kind === 'start')[1].sessionId
  await send(panel, 'Two')
  await send(panel, 'Three')
  assert.deepEqual(sentTexts(env), ['One'])

  env.emit(sessionId, { type: 'turn_completed', status: 'completed', turnId: 'turn-1' })
  await settle()
  assert.deepEqual(sentTexts(env), ['One', 'Two'], 'one message, not the whole queue')
  assert.deepEqual(queueTexts(panel), ['Three'], 'and the rest keeps waiting')

  env.emit(sessionId, { type: 'turn_completed', status: 'completed', turnId: 'turn-2' })
  await settle()
  assert.deepEqual(sentTexts(env), ['One', 'Two', 'Three'])
  assert.equal(queueStrip(panel)?.hidden, true, 'the strip goes away when nothing is waiting')

  env.emit(sessionId, { type: 'turn_completed', status: 'completed', turnId: 'turn-3' })
  await settle()
  assert.deepEqual(sentTexts(env), ['One', 'Two', 'Three'], 'an empty queue sends nothing on a later turn')
})

/* Unqueue takes the words back rather than dropping them. */
test('Unqueue on a + agent takes exactly its own waiting message back', async t => {
  const env = environment(t)
  const panel = env.mount('Queue-C')
  await settle()
  await send(panel, 'Running')
  await send(panel, 'Keep me')
  await send(panel, 'Take me back')
  assert.deepEqual(queueTexts(panel), ['Keep me', 'Take me back'])

  queueRows(panel)[1].querySelector('.chat-queue-cancel').click()
  await settle()
  assert.deepEqual(queueTexts(panel), ['Keep me'], 'only the row that was pressed left the queue')
  assert.deepEqual(sentTexts(env), ['Running'], 'and unqueueing sends nothing')
})

/* Send next moves a waiting row to the head, because while a turn is running
   there is no "into it" to send into. */
test('Send next on a + agent moves its row to the head of the queue', async t => {
  const env = environment(t)
  const panel = env.mount('Queue-D')
  await settle()
  await send(panel, 'Running')
  const sessionId = env.calls.find(([kind]) => kind === 'start')[1].sessionId
  await send(panel, 'Ordinary')
  await send(panel, 'Urgent')
  assert.deepEqual(queueTexts(panel), ['Ordinary', 'Urgent'])

  queueRows(panel)[1].querySelector('.chat-queue-next').click()
  await settle()
  assert.deepEqual(queueTexts(panel), ['Urgent', 'Ordinary'], 'the pressed row is now first')

  env.emit(sessionId, { type: 'turn_completed', status: 'completed', turnId: 'turn-1' })
  await settle()
  assert.deepEqual(sentTexts(env), ['Running', 'Urgent'], 'and it is what the finished turn released')
})

/* A HOST THAT ALREADY OWNS A QUEUE KEEPS IT. The tree's queue carries tree
   behaviour this surface has no business reimplementing -- /goal, /loop, the
   node's status, the account-limit fence -- and its drain lives with the node.
   This one is offered only where there is none. */
test('a host that supplies its own queue keeps it', async t => {
  const env = environment(t)
  const held = []
  const hostQueue = {
    list: () => held.map((text, index) => ({ id: 'host-' + index, text })),
    add: text => { held.push(text); return { ok: true } },
    cancel: () => true,
    subscribe: () => () => {},
  }
  const panel = env.mount('Queue-E', { chatConfigFor: () => ({ queue: hostQueue }), seat: { id: 'seat-e', role: 'worker' } })
  await settle()
  await send(panel, 'Running')
  await send(panel, 'Goes to the host queue')
  assert.deepEqual(held, ['Goes to the host queue'], "the host's own queue took the words")
  assert.deepEqual(sentTexts(env), ['Running'])
})

/* A NAMED HOLD MUST BE VISIBLE ON THE + CHAT TOO, NOT ONLY IN THE STORE.
 *
 * The store parks a Send now whose stop never reported idle inside the
 * release budget under a named reason (session-outbox.js restore({
 * heldReason }), painted by components.js paintQueueStrip from
 * `entry.heldReason`). views/computers.js carries that field out of the store
 * in its own `queue.list`; this surface's `ownQueue.list` rebuilds each row by
 * hand too, and a field it does not copy cannot reach the strip however
 * faithfully the strip paints it.
 *
 * MEASURED 2026-09-19 at the lane tip before the fix: with the store holding
 * SEND_NOW_RELEASE_BUDGET on the row, the + chat drew no `.chat-queue-state`
 * at all and its send door still read "Send now" -- the row went quietly back
 * to looking like an ordinary waiting message. That is the same silent hold
 * f5463e67 was written to remove, surviving on the surface whose stop does not
 * wait for idle in the first place.
 *
 * Asserted through what a person sees: the sentence on the row and the label
 * on its door, and that Unqueue is still there and still works. */
test('a named hold on a + agent row says so on the row and keeps its doors', async t => {
  const env = environment(t)
  const panel = env.mount('Queue-Held')
  await settle()
  await send(panel, 'Running')
  const sessionId = env.calls.find(([kind]) => kind === 'start')[1].sessionId
  await send(panel, 'Held by name')
  assert.deepEqual(queueTexts(panel).map(text => text.replace(/ —.*$/, '')), ['Held by name'], 'setup: the row is waiting')

  /* The store's own door, the one parkSendNow calls. */
  const held = holdForSend(sessionId, { entryId: outboxList(sessionId)[0].id })
  assert.equal(held.ok, true, held.sentence)
  assert.equal(held.restore({ unconfirmed: false, heldReason: 'SEND_NOW_RELEASE_BUDGET' }), true)
  assert.equal(outboxList(sessionId)[0].heldReason, 'SEND_NOW_RELEASE_BUDGET', 'setup: the store recorded the hold')
  await settle()

  const row = queueRows(panel)[0]
  const state = row.querySelector('.chat-queue-state')
  assert.ok(state, 'the held row says nothing at all: the reason never reached the strip')
  assert.equal(state.dataset.heldReason, 'SEND_NOW_RELEASE_BUDGET', 'the row must name the hold the store recorded')
  assert.equal(state.textContent, ` — ${QUEUE_PANEL.heldReasons.SEND_NOW_RELEASE_BUDGET}`,
    'the row must carry the copy table\'s sentence for that reason')
  assert.equal(row.querySelector('.chat-queue-now').textContent, QUEUE_PANEL.retryUnconfirmed,
    'a row the person already pressed Send now on reads Retry send, not Send now')
  assert.equal(row.querySelector('.chat-queue-now').disabled, false, 'Retry send must be pressable')

  const unqueue = row.querySelector('.chat-queue-cancel')
  assert.ok(unqueue, 'a held row keeps Unqueue')
  assert.equal(unqueue.disabled, false, 'and it is pressable')
  unqueue.click()
  await settle()
  assert.deepEqual(queueTexts(panel), [], 'Unqueue on a held row really takes the words back')
  assert.deepEqual(sentTexts(env), ['Running'], 'and nothing was delivered by any of it')
})

/* T1397 and T1491, through the real tab: what a placed New agent carries into
   the tree is its declared Worker identity (not the internal 'default' role's
   label "Default") and only what the person actually sent. Words typed but
   never sent stay in the composer and do not become the circle's brief, which
   Start tree would otherwise send as its task. Nothing is started or sent. */
test('placing an unsent tab names the circle after its Worker role and leaves typed words in the composer, not in the brief', async t => {
  const env = environment(t)
  let saved = null
  const store = createFleetTreeStore({ computerId: 'placement-names', roleLabel,
    storage: { read: () => saved, write: (_key, value) => { saved = value; return true } } })
  const parent = store.addNode({ role: 'manager', message: 'Look after this branch.' }).node
  const place = async (name, words) => {
    const panel = env.mount(name); await settle()
    panel.input().value = words
    panel.input().dispatch('input')
    const result = await adoptStandaloneIntoTree({ store, session: panel.adapter, parentId: parent.id, bridge: {},
      identityFor: () => { throw new Error('an unsent tab needs no tree address') },
      bindSession: () => ({ getStartOptions: () => ({}) }) })
    assert.equal(result.ok, true, JSON.stringify(result))
    return { panel, node: store.getNode(result.nodeId) }
  }
  const first = await place('Agent 1', 'unsent draft - please do not act on this')
  const second = await place('Agent 2', 'another unsent draft')
  const names = [first.node, second.node].map(node => nodeDisplayName(node, store.snapshot().nodes, { roleLabel }))
  assert.deepEqual(names, ['Worker', 'Worker 2'], 'a placed tab takes its Worker identity name, never "Default"')
  assert.deepEqual([first.node.role, second.node.role], ['worker', 'worker'])
  assert.equal(first.node.message, '', 'unsent composer words must not become the brief Start tree sends')
  assert.equal(second.node.message, '')
  assert.equal(first.panel.input().value, 'unsent draft - please do not act on this', 'the unsent words stay in the composer')
  assert.equal(env.calls.length, 0, 'placing starts and sends nothing')
})

/* T1413: "Agent added to the tree." stayed under the tab bar until the person
   left Computers, even after that agent was removed. The confirmation now
   fades like the canvas status line's; a refusal stays until the next try. */
test('the placement confirmation fades while a placement refusal stays until the next attempt', async t => {
  const env = environment(t), owner = workspace(env)
  owner.confirmationFadeMs = 20
  let answer = { ok: false, sentence: 'This agent could not be added here.' }
  owner.graph.onPlaceStandalone = async () => answer
  owner.openStandalone()
  await settle()
  const record = [...owner.standalone.values()][0]
  const status = owner.root.querySelector('.tree-standalone-placement-status')
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  await owner.placeStandalone(record, null)
  assert.equal(status.textContent, 'This agent could not be added here.')
  await wait(60)
  assert.equal(status.hidden, false, 'a refusal is not faded away')
  answer = { ok: true, nodeId: 'placed-node', sentence: 'Agent added as its own tree.' }
  await owner.placeStandalone(record, null)
  assert.equal(status.textContent, 'Agent added as its own tree.')
  assert.equal(status.hidden, false)
  await wait(60)
  assert.equal(status.hidden, true, 'the confirmation fades instead of outliving the agent it reports on')
  assert.equal(status.textContent, '')
  assert.deepEqual(env.calls, [], 'placing starts and sends nothing')
})

/* T1365: every New agent tab declares an organisation seat, and closing the
   tab never released it, so dead "Agent 1" worker seats piled up toward the
   organisation's 64-seat bound. A tab closed before anything was sent or
   placed now releases its seat; a sent tab keeps it (its conversation is
   written under it) and a placed one has handed it to the tree. */
test('closing a never-sent New agent tab releases its declared seat; a sent or placed tab keeps it', async t => {
  const env = environment(t), owner = workspace(env)
  const declared = [], released = []
  owner.graph.standaloneAgent.declareSeat = async ({ id, name }) => { declared.push(id); return { id, name, role: 'worker' } }
  owner.graph.standaloneAgent.releaseSeat = async ({ id }) => { released.push(id); return true }
  const open = async () => {
    await owner.openStandalone()
    await settle()
    return [...owner.standalone.values()].at(-1)
  }
  const untouched = await open()
  owner.close(untouched, { focus: false })
  await settle()
  assert.deepEqual(released, [untouched.id], 'a closed, never-sent tab gives its seat back')

  const typed = await open()
  typed.chatPanel.querySelector('.chat-input input').value = 'typed but never sent'
  owner.close(typed, { focus: false })
  await settle()
  assert.deepEqual(released, [untouched.id, typed.id], 'unsent words are not a conversation the seat must keep')

  const sent = await open()
  const input = sent.chatPanel.querySelector('.chat-input input')
  input.value = 'Please start'
  input.dispatch('input')
  sent.chatPanel.querySelector('.chat-send').click()
  await settle()
  assert.ok(sent.session.snapshot().sessionId, 'fixture premise: this tab really sent')
  owner.close(sent, { focus: false })
  await settle()
  assert.equal(released.includes(sent.id), false, 'a sent tab keeps the seat its conversation is written under')

  owner.graph.onPlaceStandalone = async () => ({ ok: true, nodeId: 'placed-node', sentence: 'Agent added as its own tree.' })
  const placed = await open()
  await owner.placeStandalone(placed, null)
  owner.close(placed, { focus: false })
  await settle()
  assert.equal(released.includes(placed.id), false, 'a placed tab handed its seat to the tree')
  assert.equal(declared.length, 4)
})

/* T1370: the New agent chooser listed every program with no install state and
   preselected GPT-6-Astra, so a fresh computer without Codex opened a tab that
   was "unavailable · Codex is not installed". It now shows the start panel's
   rows: not-installed or unstartable programs are marked and cannot be picked,
   and the preselected row is one that can start. */
test('the New agent chooser marks programs that are not installed and preselects one that can start', async t => {
  const env = environment(t), owner = workspace(env)
  let rows = tierChoicesFor(['astra', 'claude-sonnet', 'local'], [], ['codex', 'claude'])
  owner.graph.standaloneAgent.tierChoices = () => rows
  owner.graph.standaloneAgent.refreshTierChoices = async () => rows
  owner.openSpawnChooser()
  await settle()
  const select = owner.root.querySelector('.tree-agent-notice [data-spawn-field=tier]')
  const option = id => select.querySelectorAll('option').find(item => item.value === id)
  assert.equal(option('astra').disabled, true, 'Codex is not installed, so GPT-6-Astra cannot be picked')
  assert.match(option('astra').textContent, /Codex is not installed/)
  assert.equal(option('claude-sonnet').disabled, true)
  assert.equal(option('local').disabled, false)
  assert.equal(select.value, 'local', 'the preselected row is one that can start')

  rows = tierChoicesFor(['astra', 'claude-sonnet', 'local'], [], ['codex'])
  owner.closeSpawnChooser()
  owner.openSpawnChooser({ start: { tier: 'claude-sonnet', effort: 'medium' } })
  await settle()
  assert.equal(select.value, 'claude-sonnet', 'a start that can run keeps its program')
  assert.equal(option('claude-sonnet').disabled, false)
  assert.deepEqual(env.calls, [], 'choosing starts nothing')
})
