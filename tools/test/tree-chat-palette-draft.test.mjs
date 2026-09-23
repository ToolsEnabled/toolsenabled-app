import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { createHash } from 'node:crypto'

register('./helpers/css-stub-loader.mjs', import.meta.url)
const { installWorld, fleetFetch, seedTreeNode, mountView, settle } = await import('./lib/tree-command-real-mount.mjs')

let sequence = 0
const DRAFT = 'Keep these unsent words'

let nativeObservation
const nativeComposer = () => nativeObservation ||= import('./helpers/computers-composer-native.mjs').then(module => module.observeComputersComposer())

test('native whole Computers composers keep slash, goal and filtered actions usable during a busy stream', async () => {
  const observed = await nativeComposer()
  for (const surface of observed.surfaces) {
    const stage = name => surface.stages.find(item => item.name === name).state
    assert.equal(stage('slash-mid-draft').value, 'unfinished draft/')
    assert.equal(stage('slash-mid-draft').popup, null)
    assert.equal(stage('slash-first-character').popup.visible, true)
    assert.equal(stage('slash-first-character').active.cls, 'chat-actions-filter')
    assert.equal(stage('goal-pointer').value, '/goal ')
    assert.equal(stage('options-pointer').popup.visible, true)
    assert.equal(stage('option-mention-pointer').value, 'partial draft src/synthetic.js')
    assert.deepEqual(stage('option-mention-pointer').calls, ['mention'])
    assert.equal(stage('dialog-slash').popup.visible, true)
    assert.equal(stage('dialog-slash').popup.inert, false)
  }
  assert.deepEqual(observed.pageErrors, [])
  assert.deepEqual(observed.deniedRequests, [])
  assert.equal(observed.visible, false)
  assert.equal(observed.destroyed, true)
})

test('native loop controls are visible and focused from both the rail and full conversation, preserving its draft and stream', async () => {
  const observed = await nativeComposer()
  for (const surface of observed.surfaces) {
    const stage = name => surface.stages.find(item => item.name === name).state
    const opened = stage('loop-pointer')
    assert.equal(opened.interval.visible, true, surface.mode)
    assert.ok(opened.interval.rect.width > 0 && opened.interval.rect.height > 0, surface.mode)
    assert.equal(opened.interval.hit.inside, true, surface.mode)
    assert.equal(opened.active.tag, 'SELECT', surface.mode)
    assert.equal(opened.controlsInOwner, true, 'shared refreshers must still reach the controls')
    if (surface.mode === 'conversation') {
      assert.equal(opened.overlayPosition, 'fixed')
      assert.equal(opened.overlay.visible, true)
      assert.ok(opened.overlay.rect.x >= 0 && opened.overlay.rect.y >= 0)
      assert.ok(opened.overlay.rect.x + opened.overlay.rect.width <= opened.viewport.width + 1)
      assert.ok(opened.overlay.rect.y + opened.overlay.rect.height <= opened.viewport.height + 1)
    }
    for (const state of [opened, stage('loop-streaming'), stage('loop-closed')]) {
      assert.equal(state.sameChat, true, surface.mode)
      assert.equal(state.sameInput, true, surface.mode)
      assert.equal(state.chatConnected, true, surface.mode)
      assert.equal(state.value, 'partial draft src/synthetic.js', surface.mode)
      assert.equal(state.streamedSummary, true, surface.mode)
      assert.deepEqual(state.calls, ['mention'], 'opening setup must not send, start or interrupt')
    }
    assert.equal(stage('loop-closed').openDialogs, 0, surface.mode)
    assert.equal(opened.pulseCount, 1)
    assert.equal(stage('loop-streaming').pulseCount, 2)
    const nested = stage('dialog-loop')
    assert.equal(nested.interval.visible, true, surface.mode)
    assert.equal(nested.interval.inert, false, surface.mode)
    assert.equal(nested.interval.hit.inside, true, surface.mode)
    assert.equal(nested.active.tag, 'SELECT', surface.mode)
  }
})

// Mount the actual Page 2 view and its actual tree/shelf/chat components.
// Only the DOM and engine bridge are substitutes; this starts no provider.
async function mount(t) {
  const world = await installWorld(fleetFetch())
  const nodeId = `palette-draft-${++sequence}`
  const sent = []
  let attachment = 0
  let mention = { ok: true, path: '/fixture/selected-file.txt' }
  world.bridge.pickMention = async () => mention
  world.bridge.pickAttachment = async () => ({ ok: true, path: `/fixture/image-${++attachment}.png` })
  world.bridge.setEffort = async () => ({ effort: 'high' })
  world.bridge.send = async request => { sent.push(request); return { turnId: 'fixture-turn' } }
  seedTreeNode(world.storage, { nodeId, sessionId: `session-${sequence}`, status: 'finished' })
  const view = await mountView(world)
  t.after(() => { view.destroy(); world.restore() })
  const circle = view.el.querySelectorAll('.static-tree-node').find(node => node.dataset.agentId === nodeId)
  assert.ok(circle)
  circle.dispatch('keydown', { key: 'Enter' })
  await settle(5)
  const currentChat = () => view.el.querySelectorAll('.tree-conversation')
    .find(panel => panel.dataset.agentId === nodeId)?.querySelector('.chat')
  const chat = currentChat()
  assert.ok(chat, 'activating the node must mount its conversation in the shelf')
  const input = chat.querySelector('.chat-input input')
  input.value = DRAFT
  input.dispatch('input')
  return { world, view, chat, input, currentChat, sent, setMention: value => { mention = value } }
}

async function action(chat, label) {
  chat.openActions()
  const row = chat.querySelectorAll('.chat-actions-list button').find(button => button.textContent.startsWith(label))
  assert.ok(row, `missing palette action: ${label}`)
  row.dispatch('click')
  await settle(8)
}

test('Actions Mention keeps the originating composer and appends to its draft', async t => {
  const f = await mount(t)
  await action(f.chat, 'Mention a file')
  assert.ok(f.currentChat() === f.chat, 'mention must not replace the chat')
  assert.equal(f.input.value, `${DRAFT} /fixture/selected-file.txt`)
  assert.ok(document.activeElement === f.input, 'focus belongs in the composer')
})

test('actual Page 2 goal shortcut inserts into the mounted conversation draft without sending', async t => {
  const f = await mount(t)
  f.chat.querySelector('[data-common-command="goal"]').dispatch('click')
  await settle(8)
  assert.equal(f.input.value, '/goal ' + DRAFT)
  assert.equal(f.currentChat(), f.chat)
  assert.equal(document.activeElement, f.input)
  assert.deepEqual(f.sent, [])
})

test('actual Page 2 loop shortcut opens its visible setup from the conversation', async t => {
  const f = await mount(t)
  f.chat.querySelector('[data-common-command="loop"]').dispatch('click')
  await settle(8)
  assert.equal(f.currentChat(), f.chat)
  assert.equal(f.input.value, DRAFT)
  const interval = f.view.el.querySelector('.board-loop-box [data-loop="every"]')
  assert.ok(interval)
  assert.equal(document.activeElement, interval)
  assert.equal(f.view.el.querySelector('[data-rail-body="details"]').hidden, false)
  assert.equal(f.view.el.querySelector('.ctl-page').classList.contains('is-active'), true)
  assert.deepEqual(f.sent, [])
})

test('cancelling Actions Mention preserves the draft and attachments', async t => {
  const f = await mount(t)
  f.chat.querySelector('[data-chat-attach]').dispatch('click')
  await settle(3)
  f.setMention(null)
  await action(f.chat, 'Mention a file')
  assert.equal(f.input.value, DRAFT)
  assert.ok(f.currentChat() === f.chat, 'navigation must retain the same chat')
  assert.equal(f.chat.querySelectorAll('.chat-attachment-chip').length, 1)
})

test('Actions Queue focuses the existing draft and retains its attachment', async t => {
  const f = await mount(t)
  f.chat.querySelector('[data-chat-attach]').dispatch('click')
  await settle(3)
  await action(f.chat, 'Queue a message')
  assert.ok(f.currentChat() === f.chat, 'navigation must retain the same chat')
  assert.equal(f.input.value, DRAFT)
  assert.equal(f.chat.querySelectorAll('.chat-attachment-chip').length, 1)
  assert.ok(document.activeElement === f.input, 'focus belongs in the composer')
})

test('Actions Reports-to opens Details without replacing the current chat draft', async t => {
  const f = await mount(t)
  await action(f.chat, 'Change who it reports to')
  assert.ok(f.currentChat() === f.chat, 'navigation must retain the same chat')
  assert.equal(f.input.value, DRAFT)
  assert.equal(f.view.el.querySelector('[data-rail-body="details"]').hidden, false)
  assert.equal(f.view.el.querySelector('.ctl-page').classList.contains('is-active'), true)
})

test('the effort chip opens its picker without replacing the current draft', async t => {
  const f = await mount(t)
  f.chat.querySelector('[data-chat-chip="effort"]').dispatch('click')
  await settle(8)
  assert.ok(f.currentChat() === f.chat, 'navigation must retain the same chat')
  assert.equal(f.input.value, DRAFT)
  assert.ok(f.chat.querySelector('.chat-actions-pop'))
})

test('Actions Attach appears in the removable attachment strip', async t => {
  const f = await mount(t)
  await action(f.chat, 'Attach an image')
  assert.equal(f.chat.querySelectorAll('.chat-attachment-chip').length, 1)
  assert.equal(f.input.value, DRAFT)
  f.chat.querySelector('.chat-attachment-remove').dispatch('click')
  f.chat.querySelector('.chat-send').dispatch('click')
  await settle(8)
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].images, undefined)
})

// Inert imageQueue receipt boundary (binding/read/retain/admit/transfer/dispatch) + inert start,
// so a finished-session image recovery drives one real durable dispatch/accepted through the
// mounted consumer -- the actual image delivery channel, not bridge.send. The retain receipt is
// DERIVED FROM THE ACTUAL IMAGE PAYLOAD (count + a sha256 manifest of the paths), so a same-count
// wrong path cannot pass; it reuses the transfer/dispatch receipt contract from
// computers-image-recovery-one-send.test.mjs.
function wireImageQueue(bridge) {
  const admits = [], dispatches = [], retains = []
  let reads = 0, lastReceipt = null, admittedEnvelopeId = null
  const ownerContext = { version: 1, ownerId: 'owner', currentEpoch: 'epoch-1', kind: 'local' }
  let snapshot = { version: 1, generation: null, entries: [], destinationSessionId: null, automaticSend: false }
  const manifestFor = images => createHash('sha256').update(images.map(i => i.path).join('\u0000')).digest('hex')
  bridge.ownerContext = async () => ownerContext
  bridge.onOwnerContextChanged = () => () => {}
  bridge.interrupt = async () => ({ ok: true })
  bridge.startableTiers = async () => ({ ok: true, tiers: [] })
  bridge.start = async () => ({ ok: true, sessionId: 'successor', threadId: 'thread-1' })
  bridge.imageQueue = async r => {
    const answer = result => ({ ok: true, operation: r.operation, operationId: r.operationId || null, result })
    if (r.operation === 'binding') return { ok: true, result: { sessionId: r.sessionId, conversationId: 'conversation', ownerContext } }
    if (r.operation === 'read') { reads++; return answer(structuredClone(snapshot)) }
    if (r.operation === 'retain') { retains.push(r); const images = r.images || []; lastReceipt = { version: 1, id: 'ref', slot: 0, manifestHash: manifestFor(images), imageCount: images.length, state: 'retained' }; return answer({ ...lastReceipt }) }
    if (r.operation === 'admit') { admits.push(r); admittedEnvelopeId = 'env-' + admits.length; snapshot = { ...snapshot, generation: 'g1', entries: [{ envelopeId: admittedEnvelopeId, text: r.text, imageReceipts: r.imageReceipts, state: 'not-sent', selection: { model: 'chosen', effort: 'high' } }] }; return answer(structuredClone(snapshot)) }
    if (r.operation === 'transfer') { snapshot = { ...snapshot, generation: 'g2', destinationSessionId: r.destinationSessionId }; return answer(structuredClone(snapshot)) }
    if (r.operation === 'dispatch') { dispatches.push(r); snapshot = { ...snapshot, generation: 'g3', entries: snapshot.entries.map(e => ({ ...e, state: 'accepted' })) }; return { ...answer(structuredClone(snapshot)), conversationId: r.conversationId, sessionId: r.sessionId, envelopeId: r.envelopeId, ownerContext, deliveryDisposition: 'accepted', attemptId: 'att', reconcile: false } }
    return answer(structuredClone(snapshot))
  }
  return { admits, dispatches, retains, reads: () => reads, lastReceipt: () => lastReceipt, admittedEnvelopeId: () => admittedEnvelopeId }
}

test('palette and toolbar attachments both ride the next message exactly once', async t => {
  const f = await mount(t)
  // Retained images ride the durable imageQueue delivery channel, not the legacy text sender.
  // Wired only here, so the shared mount() and the other cases stay unaffected.
  const ops = wireImageQueue(f.world.bridge)
  await action(f.chat, 'Attach an image')
  f.chat.querySelector('[data-chat-attach]').dispatch('click')
  await settle(3)
  assert.equal(f.chat.querySelectorAll('.chat-attachment-chip').length, 2, 'both attachments resolved before send')
  f.chat.querySelector('.chat-send').dispatch('click')
  await settle(30)
  // Delivery identity: the two ACTUAL selected images (not the on-screen summary text) reach the
  // durable retain, and that receipt flows through admit into the dispatched envelope, exactly once.
  assert.equal(ops.retains.length, 1, 'exactly one durable retain')
  assert.deepEqual(ops.retains[0].images, [{ path: '/fixture/image-1.png' }, { path: '/fixture/image-2.png' }], 'both actual selected images reach the durable retain, in order')
  assert.equal(ops.admits.length, 1, 'exactly one durable admit')
  assert.equal(ops.dispatches.length, 1, 'exactly one durable dispatch: the next message rides once')
  assert.equal(ops.admits[0].text, DRAFT, 'the durable admit carries the actual composed text')
  const admittedReceipt = ops.admits[0].imageReceipts[0]
  assert.equal(admittedReceipt.id, ops.lastReceipt().id, 'the admitted entry carries the retained receipt id (continuity)')
  assert.equal(admittedReceipt.manifestHash, ops.lastReceipt().manifestHash, 'the admitted receipt manifest is derived from the actual image paths (continuity)')
  assert.equal(admittedReceipt.imageCount, 2, 'the admitted receipt reflects the two actual images, not a default count')
  assert.equal(ops.dispatches[0].envelopeId, ops.admittedEnvelopeId(), 'the dispatch delivers the admitted envelope (continuity)')
  assert.equal(f.chat.querySelector('.me').dataset.deliveryState, 'accepted', 'the durable dispatch reaches an accepted receipt')
  assert.equal(f.sent.length, 0, 'legacy bridge.send is not the image delivery channel')
  assert.ok(ops.reads() >= 2, 'the recovery issued repeated reads (binding/read/drain during recovery) -- NOT a distinct post-accept redrain, and no no-replay is claimed from it')
  // A second send on the now-cleared composer (no draft, no attachments) only exercises the empty-send
  // guard. It is a plain no-op and is NOT offered as a no-replay proof.
  f.chat.querySelector('.chat-send').dispatch('click')
  await settle(20)
  assert.equal(ops.dispatches.length, 1, 'a second send on the cleared composer is an empty-send no-op (not a no-replay claim)')
  assert.equal(ops.admits.length, 1, 'no second admit from the empty-send no-op')
})
