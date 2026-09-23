import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
const require = createRequire(import.meta.url)
const { createImageRetentionService } = require('../../shell/image-retention-service.cjs')
const digest = b => createHash('sha256').update(b).digest('hex')
const tick = () => new Promise(r => setTimeout(r, 5))
async function until(check) {
  for (let i = 0; i < 100 && !check(); i++) await tick()
  assert.ok(check(), 'condition did not settle within 500 ms')
}
async function fixture(options = {}) {
  const temp = process.env.T489_TEST_TEMP
  const fixtureManifest = process.env.T489_PNG_MANIFEST
  assert.ok(temp && fixtureManifest, 'explicit test temp and PNG manifest required')
  const root = path.join(fs.realpathSync(temp), 't489-standalone-' + randomUUID())
  fs.mkdirSync(root)
  const paths = JSON.parse(fs.readFileSync(fixtureManifest, 'utf8')).images.map(i => i.path)
  const bytes = paths.map(p => digest(fs.readFileSync(p)))
  assert.notEqual(bytes[0], bytes[1])
  const dom = installDomStandIn(globalThis)
  const storage = new Map([['mc.write.agent-session', 'enabled']])
  globalThis.localStorage = { getItem: k => storage.get(k) ?? null,
    setItem: (k,v) => storage.set(k,String(v)), removeItem: k => storage.delete(k) }
  let context = { version: 1, ownerId: 'standalone-fixture', currentEpoch: randomUUID(), kind: 'local' }
  let ownerChanged = () => {}, event = () => {}, id = null, ownerSubscriptions = 0
  const calls = [], sent = [], legacy = [], session = {}, issued = new Set(paths)
  const authority = () => ({ session, sessionId: id, accountId: 'default', provider: 'codex',
    model: 'fixture-model', effort: null, issued })
  const service = createImageRetentionService({ root: path.join(root,'store'),
    authenticate: c => { assert.deepEqual(c, context); return { authenticated: true,
      productOwnerId: context.ownerId, currentEpoch: context.currentEpoch } },
    sourceAuthority: authority, candidateAuthority: authority, authorizeTransfer: () => true,
    engineImageBytes: 8 * 1024 * 1024 })
  let candidateId = null, sourceId = null, switchReceipt = null, refusedOnce = false, commitRefused = false
  let recovery = null
  const bridge = {
    availability: async () => ({ ok: true }), onEvent: fn => { event = fn; return () => { event = () => {} } },
    start: async arg => {
      calls.push({ operation: 'start', ...arg })
      if (arg.recoveryId) {
        assert.equal(arg.recoveryId, recovery.recoveryId)
        assert.equal(arg.sessionId, recovery.sessionId)
      }
      id = arg.sessionId
      await options.beforeStart?.(arg)
      return { ok: true, sessionId: id, ...(arg.recoveryId ? { recovery } : {}) }
    },
    pasteAttachment: async request => {
      calls.push({ operation: 'pasteAttachment', ...request })
      const match = paths.find(p => fs.readFileSync(p).toString('base64') === request.data)
      return match ? { ok: true, path: match } : { ok: false, code: 'FIXTURE_IMAGE_UNKNOWN' }
    },
    send: async arg => { legacy.push(arg); await options.beforeSend?.(arg); return { ok: true, turnId: 'first-turn' } },
    close: async () => ({ ok: true }),
    interrupt: async arg => { calls.push({ operation: 'interrupt', ...arg }); return { ok: true } },
    ownerContext: async () => context,
    onOwnerContextChanged: fn => { ownerSubscriptions++; ownerChanged = fn; return () => { ownerSubscriptions--; ownerChanged = () => {} } },
    switchSession: async request => {
      calls.push({ ...request, operation: 'switch-' + request.operation })
      if (request.operation === 'prepare') {
        sourceId = id
        candidateId = 'candidate-' + randomUUID()
        return { operationId: request.operationId, phase: 'prepared', sourceSessionId: id,
          sessionId: candidateId, applied: false }
      }
      if (request.operation === 'commit') {
        if (options.commitRefusedOnce && !commitRefused) { commitRefused = true; throw Object.assign(new Error('Commit unavailable'), { code: 'FIXTURE_COMMIT_UNAVAILABLE' }) }
        event({ sessionId: sourceId, event: { type: 'session_ended', reason: 'exited', exit: { code: 0, signal: null } } })
        id = candidateId
        switchReceipt = { operationId: request.operationId, applied: true, sourceSessionId: sourceId,
          sessionId: id, provider: 'codex', tier: 'fixture-model', effort: null, revision: 1,
          threadId: 'replacement-thread', account: 'default', historyLink: { nodeId: 'conversation', computerId: 'fixture' },
          attachmentsTransferred: true, attachmentCount: paths.length }
        return switchReceipt
      }
      if (request.operation === 'status') return { operationId: request.operationId, applied: Boolean(switchReceipt), receipt: switchReceipt }
      return { operationId: request.operationId, phase: 'cancelled', applied: false, sourceDisposition: 'retained' }
    },
    imageQueue: async request => {
      calls.push(request)
      if (request.operation === 'ended-register') {
        assert.equal(request.sourceSessionId, id)
        assert.deepEqual(request.ownerContext, context)
        recovery = { recoveryId: randomUUID(), sourceSessionId: id, sessionId: randomUUID(),
          conversationId: request.conversationId, ownerContext: context }
        return { ok: true, result: recovery }
      }
      if (request.operation === 'read') await options.beforeRead?.()
      if (options.holdReads && request.operation === 'read') return { ok: false, code: 'FIXTURE_READ_HELD' }
      if (request.operation === 'binding' && request.sessionId !== id) return { ok: false, code: 'FIXTURE_RETIRED_SOURCE' }
      if (request.operation === 'binding') return { ok: true, result: {
        conversationId: 'conversation', sessionId: request.sessionId, ownerContext: context } }
      if (request.operation === 'retain') await options.beforeRetain?.()
      if (request.operation === 'admit') await options.beforeAdmit?.()
      if (request.operation === 'dispatch') {
        const reply = await service.dispatch(request, request.ownerContext, async turn => {
          if (options.knownNotSentOnce && !refusedOnce) { refusedOnce = true; return { ok: false, deliveryDisposition: 'not-sent', code: options.notSentCode || 'AGENT_TURN_ACTIVE' } }
          sent.push({ text: turn.text, bytes: turn.images.map(i => digest(fs.readFileSync(i.path))) })
          if (options.unknown) throw new Error('lost receipt')
          if (options.persistenceConflict) {
            const current = service.run({ operation: 'read', conversationId: 'conversation' }, context).result
            assert.equal(service.run({ operation: 'write', conversationId: 'conversation',
              operationId: randomUUID(), expectedGeneration: current.generation, entries: current.entries }, context).ok, true)
          }
          return { ok: true, deliveryDisposition: 'accepted', result: { turnId: 'image-turn' } }
        })
        return { ...reply, operation: 'dispatch', operationId: request.operationId,
          sessionId: request.sessionId, conversationId: request.conversationId,
          envelopeId: request.envelopeId, ownerContext: request.ownerContext }
      }
      const result = service.run(request.operation === 'admit' && !request.selection
        ? { ...request, selection: { model: 'fixture-model', effort: null } } : request, request.ownerContext)
      if (options.wrongDestination && switchReceipt && request.operation === 'read' && result.ok) {
        return { ...result, result: { ...result.result, destinationSessionId: sourceId } }
      }
      return result
    },
  }
  const { mountAgentSessionSurface } = await import('../../src/agent-session.js')
  const host = dom.document.createElement('div')
  dom.document.body.appendChild(host)
  let control
  const dispose = mountAgentSessionSurface(host, { live: true, agentId: 'standalone',
    bridge, chatComposer: true, chatChips: options.chips ? {} : null, onSessionChange: options.onSessionChange,
    onSessionOpen: options.onSessionOpen, onController: c => { if (c) control = c } })
  await until(() => control)
  await tick()
  if (!options.initial) {
    assert.equal((await control.send('open session')).ok, true)
    if (!options.busy) await control.pause()
  }
  const chat = host.querySelector('.chat')
  assert.ok(chat)
  console.log('RETAINED_FIXTURE ' + JSON.stringify({ root, bytes }))
  return { control, chat, calls, sent, legacy, paths, bytes,
    endSession() { event({ sessionId: id, event: { type: 'session_ended', reason: 'exited', exit: { code: 0, signal: null } } }) },
    completeTurn() { event({ sessionId: id, event: { type: 'turn_completed', status: 'completed' } }) },
    changeOwner() { context = { ...context, currentEpoch: randomUUID() }; ownerChanged(context) },
    subscriptions: () => ownerSubscriptions,
    async ready() { await control.imageOutbox.refresh(); await control.pause() },
    dispose() { dispose(); dom.restore() },
  }
}
test('mounted standalone composer dispatches distinct PNG bytes in order and clears accepted draft', async () => {
  const f = await fixture()
  try {
    f.chat.importDraft({ text: '  image question  ', attachments: f.paths.map(path => ({ path })) })
    f.chat.querySelector('.chat-send').click()
    await until(() => f.sent.length === 1 && f.chat.exportDraft().attachments.length === 0)
    assert.deepEqual(f.sent[0], { text: '  image question  ', bytes: f.bytes })
    assert.equal(f.legacy.length, 1, 'image intent bypassed durable dispatch')
    assert.equal(f.calls.filter(c => c.operation === 'dispatch').length, 1)
    assert.ok(f.subscriptions() > 0)
  } finally { f.dispose() }
  assert.equal(f.subscriptions(), 0)
})
test('owner changes during admission preserve the newer composer draft', async () => {
  let release
  const hold = new Promise(r => { release = r })
  const f = await fixture({ beforeAdmit: () => hold })
  try {
    f.chat.importDraft({ text: 'old draft', attachments: f.paths.map(path => ({ path })) })
    f.chat.querySelector('.chat-send').click()
    await until(() => f.calls.some(c => c.operation === 'admit'))
    f.chat.importDraft({ text: 'new owner draft', attachments: [] })
    f.changeOwner(); release()
    await tick(); await tick()
    assert.equal(f.chat.exportDraft().text, 'new owner draft')
    assert.equal(f.sent.length, 0)
  } finally { release(); f.dispose() }
})
for (const variant of ['unknown', 'persistenceConflict']) test('mounted standalone never replays ' + variant, async () => {
  const f = await fixture({ [variant]: true })
  try {
    const states = []
    const admitted = await f.control.submitImageIntent({ operationId: randomUUID(), text: 'one intent',
      images: f.paths.map(path => ({ path })) }, state => states.push(state))
    assert.equal(admitted.ok, true)
    await until(() => states.length > 0)
    assert.equal(states.at(-1).state, variant === 'unknown' ? 'unknown' : 'accepted')
    await f.control.imageOutbox.refresh()
    assert.equal(f.sent.length, 1)
    assert.equal(f.calls.filter(c => c.operation === 'dispatch').length, 1)
  } finally { f.dispose() }
})


test('first standalone image-only paste opens a real session without a text recovery turn', async () => {
  const f = await fixture({ initial: true })
  try {
    const input = f.chat.querySelector('.chat-input input') || f.chat.querySelector('input')
    const buffer = fs.readFileSync(f.paths[0])
    input.dispatch('paste', { clipboardData: { items: [{ kind: 'file', type: 'image/png',
      getAsFile: () => ({ arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) }) }] } })
    await until(() => f.chat.exportDraft().attachments.length === 1)
    f.chat.querySelector('.chat-send').click()
    await until(() => f.sent.length === 1)
    assert.deepEqual(f.sent[0], { text: '', bytes: [f.bytes[0]] })
    assert.equal(f.legacy.length, 0)
    assert.equal(f.calls.filter(c => c.operation === 'pasteAttachment').length, 1)
  } finally { f.dispose() }
})
test('retryable not-sent waits for lifecycle readiness then drains without another click', async () => {
  const f = await fixture({ knownNotSentOnce: true })
  try {
    const states = []
    await f.control.submitImageIntent({ operationId: randomUUID(), text: 'ready later',
      images: f.paths.map(path => ({ path })) }, state => states.push(state))
    await until(() => states.some(s => s.state === 'not-sent'))
    assert.equal(f.sent.length, 0)
    assert.equal(states.at(-1).retryable, true)
    f.completeTurn()
    await until(() => f.sent.length === 1)
    assert.deepEqual(f.sent[0].bytes, f.bytes)
    assert.equal(f.calls.filter(c => c.operation === 'dispatch').length, 2)
  } finally { f.dispose() }
})
test('terminal not-sent remains retained when the session reports idle', async () => {
  const f = await fixture({ knownNotSentOnce: true, notSentCode: 'AGENT_SESSION_NOT_READY' })
  try {
    const states = []
    await f.control.submitImageIntent({ operationId: randomUUID(), text: 'explicit retry required',
      images: f.paths.map(path => ({ path })) }, state => states.push(state))
    await until(() => states.some(s => s.state === 'not-sent'))
    assert.equal(states.at(-1).retryable, false)
    f.completeTurn()
    const view = await f.control.imageOutbox.refresh()
    assert.equal(f.sent.length, 0)
    assert.equal(f.calls.filter(c => c.operation === 'dispatch').length, 1)
    assert.equal(view.entries[0].state, 'not-sent')
    assert.equal(view.entries[0].failure.code, 'AGENT_SESSION_NOT_READY')
  } finally { f.dispose() }
})
test('replacement retains source until committed destination is durably read, then drains successor', async () => {
  const f = await fixture({ busy: true })
  try {
    await f.control.submitImageIntent({ operationId: randomUUID(), text: 'queued source',
      images: f.paths.map(path => ({ path })) })
    assert.equal(f.sent.length, 0)
    const source = f.control.snapshot().sessionId
    const operationId = randomUUID()
    const prepared = await f.control.switchSession({ operation: 'prepare', operationId, tier: 'fixture-model' })
    assert.equal(prepared.ok, true)
    assert.equal(f.control.snapshot().sessionId, source)
    const committed = await f.control.switchSession({ operation: 'commit', operationId })
    assert.equal(committed.ok, true)
    assert.equal(f.control.snapshot().sessionId, prepared.sessionId)
    await until(() => f.sent.length === 1)
    assert.deepEqual(f.sent[0].bytes, f.bytes)
    const commitAt = f.calls.findIndex(c => c.operation === 'switch-commit')
    assert.equal(f.calls.slice(commitAt + 1).some(c => c.operation === 'binding' && c.sessionId === source), false)
  } finally { f.dispose() }
})
test('wrong successor read leaves replacement held and does not dispatch', async () => {
  const f = await fixture({ busy: true, wrongDestination: true })
  try {
    await f.control.submitImageIntent({ operationId: randomUUID(), text: 'held source',
      images: f.paths.map(path => ({ path })) })
    const source = f.control.snapshot().sessionId
    const operationId = randomUUID()
    assert.equal((await f.control.switchSession({ operation: 'prepare', operationId, tier: 'fixture-model' })).ok, true)
    const result = await f.control.switchSession({ operation: 'commit', operationId })
    assert.equal(result.ok, false)
    assert.equal(result.reconcile, true)
    assert.equal(f.control.snapshot().sessionId, source)
    assert.equal(f.sent.length, 0)
  } finally { f.dispose() }
})

for (const edit of [false, true]) test('pending standalone admission preserves draft revision: edit-away-back=' + edit, async () => {
  let release
  const hold = new Promise(resolve => { release = resolve })
  const f = await fixture({ beforeAdmit: () => hold })
  try {
    const draft = { text: 'same image draft', attachments: f.paths.map(path => ({ path })) }
    f.chat.importDraft(draft)
    f.chat.querySelector('.chat-send').click()
    await until(() => f.calls.some(c => c.operation === 'admit'))
    if (edit) {
      f.chat.importDraft({ text: 'different draft', attachments: [] })
      f.chat.importDraft(draft)
    }
    release()
    await until(() => f.sent.length === 1)
    await tick(); await tick()
    assert.equal(f.chat.exportDraft().text, edit ? draft.text : '')
    assert.equal(f.chat.exportDraft().attachments.length, edit ? draft.attachments.length : 0)
    assert.equal(f.calls.filter(c => c.operation === 'dispatch').length, 1)
    assert.deepEqual(f.sent[0].bytes, f.bytes)
  } finally { release(); f.dispose() }
})
test('owner replacement during initial start does not save or dispatch the captured image', async () => {
  let release
  const hold = new Promise(resolve => { release = resolve })
  const f = await fixture({ initial: true, beforeStart: () => hold })
  try {
    const pasted = await f.control.pasteImage(fs.readFileSync(f.paths[0]).toString('base64'), 'image/png')
    const pending = f.control.submitImageIntent({ operationId: randomUUID(), text: '',
      images: [{ path: pasted.path }] })
    await until(() => f.control.snapshot().phase === 'starting')
    f.changeOwner(); release()
    const result = await pending
    assert.equal(result.ok, false)
    assert.equal(result.detached, true)
    assert.equal(f.calls.some(c => c.operation === 'pasteAttachment'), false)
    assert.equal(f.sent.length, 0)
    assert.equal(f.legacy.length, 0)
  } finally { release(); f.dispose() }
})

test('failed precommit refresh and repeated commit never invoke host commit; recovered read can proceed', async () => {
  const options = { busy: true, holdReads: false }
  const f = await fixture(options)
  try {
    await f.control.submitImageIntent({ operationId: randomUUID(), text: 'held before commit',
      images: f.paths.map(path => ({ path })) })
    const source = f.control.snapshot().sessionId
    const operationId = randomUUID()
    assert.equal((await f.control.switchSession({ operation: 'prepare', operationId, tier: 'fixture-model' })).ok, true)
    options.holdReads = true
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await f.control.switchSession({ operation: 'commit', operationId })
      assert.equal(result.ok, false)
      assert.equal(result.code, 'IMAGE_QUEUE_NOT_READY')
      assert.equal(f.calls.filter(c => c.operation === 'switch-commit').length, 0)
      assert.equal(f.control.snapshot().sessionId, source)
    }
    options.holdReads = false
    assert.equal((await f.control.switchSession({ operation: 'commit', operationId })).ok, true)
    assert.equal(f.calls.filter(c => c.operation === 'switch-commit').length, 1)
  } finally { f.dispose() }
})
test('valid retained precommit view still requires a ready read on every retry', async () => {
  const options = { busy: true, commitRefusedOnce: true, holdReads: false }
  const f = await fixture(options)
  try {
    await f.control.submitImageIntent({ operationId: randomUUID(), text: 'retry valid view',
      images: f.paths.map(path => ({ path })) })
    const operationId = randomUUID()
    assert.equal((await f.control.switchSession({ operation: 'prepare', operationId, tier: 'fixture-model' })).ok, true)
    assert.equal((await f.control.switchSession({ operation: 'commit', operationId })).code, 'FIXTURE_COMMIT_UNAVAILABLE')
    options.holdReads = true
    assert.equal((await f.control.switchSession({ operation: 'commit', operationId })).code, 'IMAGE_QUEUE_NOT_READY')
    assert.equal(f.calls.filter(c => c.operation === 'switch-commit').length, 1)
    options.holdReads = false
    assert.equal((await f.control.switchSession({ operation: 'commit', operationId })).ok, true)
    assert.equal(f.calls.filter(c => c.operation === 'switch-commit').length, 2)
  } finally { f.dispose() }
})

test('unsent switch retains ordered images without admission and sends only on successor owner Send', async () => {
  const f = await fixture()
  try {
    const draft = { text: 'unsent replacement', attachments: f.paths.map(path => ({ path })) }
    f.chat.importDraft(draft)
    const before = f.chat.captureDraft()
    const operationId = randomUUID()
    assert.equal((await f.control.switchSession({ operation: 'prepare', operationId, tier: 'fixture-model' })).ok, true)
    assert.equal(f.calls.some(c => c.operation === 'admit' || c.operation === 'dispatch'), false)
    assert.deepEqual(f.chat.exportDraft().attachments, draft.attachments)
    const retained = f.chat.captureDraft()
    assert.equal(retained.draftId, before.draftId)
    assert.equal(retained.revision, before.revision)
    assert.ok(retained.retainedDraft)
    assert.equal((await f.control.switchSession({ operation: 'commit', operationId })).ok, true)
    assert.equal(f.sent.length, 0)
    assert.equal(f.calls.some(c => c.operation === 'admit'), false)
    f.chat.querySelector('.chat-send').click()
    await until(() => f.sent.length === 1)
    assert.deepEqual(f.sent[0], { text: draft.text, bytes: f.bytes })
    assert.equal(f.calls.filter(c => c.operation === 'dispatch').length, 1)
  } finally { f.dispose() }
})
test('editing away and back during switch retention preserves draft and prevents host prepare', async () => {
  let release
  const hold = new Promise(resolve => { release = resolve })
  const f = await fixture({ beforeRetain: () => hold })
  try {
    const draft = { text: 'same draft', attachments: f.paths.map(path => ({ path })) }
    f.chat.importDraft(draft)
    const operationId = randomUUID()
    const pending = f.control.switchSession({ operation: 'prepare', operationId, tier: 'fixture-model' })
    await until(() => f.calls.some(c => c.operation === 'retain'))
    f.chat.importDraft({ text: 'changed', attachments: [] })
    f.chat.importDraft(draft)
    release()
    assert.equal((await pending).code, 'IMAGE_QUEUE_DRAFT_CHANGED')
    assert.equal(f.calls.some(c => c.operation === 'switch-prepare' || c.operation === 'switch-commit'), false)
    assert.deepEqual(f.chat.exportDraft().attachments, draft.attachments)
    assert.equal(f.sent.length, 0)
  } finally { release(); f.dispose() }
})

test('owner change during switch retain preserves draft and prevents host replacement', async () => {
  let release
  const hold = new Promise(resolve => { release = resolve })
  const f = await fixture({ beforeRetain: () => hold })
  try {
    const draft = { text: 'original owner', attachments: f.paths.map(path => ({ path })) }
    f.chat.importDraft(draft)
    const source = f.control.snapshot().sessionId
    const pending = f.control.switchSession({ operation: 'prepare', operationId: randomUUID(), tier: 'fixture-model' })
    await until(() => f.calls.some(c => c.operation === 'retain'))
    f.changeOwner()
    release()
    const result = await pending
    assert.equal(result.ok, false)
    assert.equal(result.code, 'IMAGE_OWNER_CHANGED')
    assert.equal(f.control.snapshot().sessionId, source)
    assert.equal(f.calls.some(c => c.operation === 'switch-prepare' || c.operation === 'switch-commit'), false)
    assert.equal(f.calls.some(c => c.operation === 'admit' || c.operation === 'dispatch'), false)
    assert.equal(f.chat.exportDraft().text, draft.text)
    assert.deepEqual(f.chat.exportDraft().attachments, draft.attachments)
  } finally { release(); f.dispose() }
})
test('draft edit during precommit readiness await prevents host commit', async () => {
  let release
  const hold = new Promise(resolve => { release = resolve })
  let waiting = false, blockRead = false
  const f = await fixture({ beforeRead: () => { if (blockRead) { waiting = true; return hold } } })
  try {
    const draft = { text: 'before readiness', attachments: f.paths.map(path => ({ path })) }
    f.chat.importDraft(draft)
    const operationId = randomUUID()
    assert.equal((await f.control.switchSession({ operation: 'prepare', operationId, tier: 'fixture-model' })).ok, true)
    blockRead = true
    const pending = f.control.switchSession({ operation: 'commit', operationId })
    await until(() => waiting)
    f.chat.importDraft({ ...draft, text: 'edited while reading' })
    release()
    assert.equal((await pending).code, 'IMAGE_QUEUE_DRAFT_CHANGED')
    assert.equal(f.calls.some(c => c.operation === 'switch-commit'), false)
    assert.equal(f.calls.some(c => c.operation === 'admit' || c.operation === 'dispatch'), false)
    assert.equal(f.chat.exportDraft().text, 'edited while reading')
    assert.deepEqual(f.chat.exportDraft().attachments, draft.attachments)
  } finally { release(); f.dispose() }
})
test('two consecutive switches preserve unsent draft identity and reuse retained images until one Send', async () => {
  const f = await fixture()
  try {
    const draft = { text: 'send after two switches', attachments: f.paths.map(path => ({ path })) }
    f.chat.importDraft(draft)
    const original = f.chat.captureDraft()
    let firstToken
    for (let replacement = 0; replacement < 2; replacement++) {
      const operationId = randomUUID()
      assert.equal((await f.control.switchSession({ operation: 'prepare', operationId, tier: 'fixture-model' })).ok, true)
      assert.equal((await f.control.switchSession({ operation: 'commit', operationId })).ok, true)
      const captured = f.chat.captureDraft()
      assert.equal(captured.draftId, original.draftId)
      assert.equal(captured.revision, original.revision)
      assert.equal(captured.text, draft.text)
      assert.deepEqual(captured.attachments, draft.attachments)
      if (!firstToken) firstToken = captured.retainedDraft
      else assert.deepEqual(captured.retainedDraft.imageReceipts, firstToken.imageReceipts)
      assert.equal(f.calls.some(c => c.operation === 'admit' || c.operation === 'dispatch'), false)
    }
    f.chat.querySelector('.chat-send').click()
    await until(() => f.sent.length === 1)
    assert.deepEqual(f.sent[0], { text: draft.text, bytes: f.bytes })
    assert.equal(f.calls.filter(c => c.operation === 'admit').length, 1)
    assert.equal(f.calls.filter(c => c.operation === 'dispatch').length, 1)
  } finally { f.dispose() }
})

for (const refused of [false, true]) test('mounted initial image Send waits for open acknowledgment: refused=' + refused, async () => {
  let release, entered = false, publishedOpen = 0
  const hold = new Promise(resolve => { release = resolve })
  const f = await fixture({ initial: true,
    onSessionOpen: () => { publishedOpen++ },
    onSessionChange: async (_state, event) => {
      if (event.kind !== 'open') return
      entered = true
      await hold
      return refused ? { ok: false, code: 'AGENT_SESSION_BINDING_UNCONFIRMED' } : { ok: true }
    } })
  try {
    const draft = { text: 'await actual open', attachments: f.paths.map(path => ({ path })) }
    f.chat.importDraft(draft)
    f.chat.querySelector('.chat-send').click()
    await until(() => entered)
    assert.equal(publishedOpen, 0)
    assert.equal(f.calls.some(c => c.operation === 'retain' || c.operation === 'admit' || c.operation === 'dispatch'), false)
    assert.equal(f.chat.exportDraft().text, draft.text)
    assert.deepEqual(f.chat.exportDraft().attachments, draft.attachments)
    release()
    if (refused) {
      await until(() => f.control.snapshot().phase !== 'starting')
      await tick(); await tick()
      assert.equal(publishedOpen, 0)
      assert.equal(f.sent.length, 0)
      assert.equal(f.calls.some(c => c.operation === 'retain' || c.operation === 'admit' || c.operation === 'dispatch'), false)
      assert.equal(f.chat.exportDraft().text, draft.text)
      assert.deepEqual(f.chat.exportDraft().attachments, draft.attachments)
    } else {
      await until(() => f.sent.length === 1)
      assert.equal(publishedOpen, 1)
      assert.deepEqual(f.sent[0], { text: draft.text, bytes: f.bytes })
    }
    assert.equal(f.legacy.length, 0)
  } finally { release(); f.dispose() }
})

test('one image-only Send survives a held start and delayed binding without a seed turn', async () => {
  let starts = 0, entered = false, release
  const hold = new Promise(resolve => { release = resolve })
  const f = await fixture({ initial: true,
    beforeStart: () => { if (++starts === 1) throw Object.assign(new Error('held'), { code: 'AGENT_RESOURCE_WARMING' }) },
    onSessionChange: async (_state, event) => { if (event.kind === 'open') { entered = true; await hold; return { ok: true } } } })
  try {
    f.chat.importDraft({ text: '', attachments: f.paths.map(path => ({ path })) })
    f.chat.querySelector('.chat-send').click()
    await until(() => starts === 1)
    await new Promise(resolve => setTimeout(resolve, 4100))
    await until(() => entered)
    assert.equal(starts, 2)
    assert.equal(f.sent.length, 0)
    assert.equal(f.legacy.length, 0)
    release()
    await until(() => f.sent.length === 1)
    assert.deepEqual(f.sent[0], { text: '', bytes: f.bytes })
    assert.equal(f.legacy.length, 0)
    assert.equal(f.calls.filter(c => c.operation === 'dispatch').length, 1)
  } finally { release(); f.dispose() }
})
test('replacement binding refusal holds submitted intent and retry binds without another host commit', async () => {
  let refuse = true, opened = 0
  const f = await fixture({ busy: true,
    onSessionOpen: () => { opened++ },
    onSessionChange: async (_state, event) => event.kind === 'replaced'
      ? { ok: !refuse, ...(refuse ? { code: 'FIXTURE_BINDING_REFUSED' } : {}) } : undefined })
  try {
    await f.control.submitImageIntent({ operationId: randomUUID(), text: 'original authorized intent',
      images: f.paths.map(path => ({ path })) })
    const operationId = randomUUID()
    const prepared = await f.control.switchSession({ operation: 'prepare', operationId, tier: 'fixture-model' })
    assert.equal(prepared.ok, true)
    const result = await f.control.switchSession({ operation: 'commit', operationId })
    assert.equal(result.ok, false)
    assert.equal(result.applied, true)
    assert.equal(result.code, 'FIXTURE_BINDING_REFUSED')
    assert.equal(f.control.snapshot().sessionId, prepared.sessionId)
    assert.equal(opened, 1)
    assert.equal(f.sent.length, 0)
    refuse = false
    assert.equal((await f.control.switchSession({ operation: 'status', operationId })).ok, true)
    await until(() => f.sent.length === 1)
    assert.equal(opened, 2)
    assert.equal(f.calls.filter(c => c.operation === 'switch-commit').length, 1)
    assert.deepEqual(f.sent[0], { text: 'original authorized intent', bytes: f.bytes })
  } finally { f.dispose() }
})
test('one queued text Send during delayed open drains on idle without a turn completion', async () => {
  let entered = false, release
  const hold = new Promise(resolve => { release = resolve })
  const f = await fixture({ initial: true,
    onSessionChange: async (_state, event) => { if (event.kind === 'open') { entered = true; await hold; return { ok: true } } } })
  try {
    const opening = f.control.submitImageIntent({ operationId: randomUUID(), text: 'opening image',
      images: f.paths.map(path => ({ path })) })
    await until(() => entered)
    f.chat.importDraft({ text: 'original queued text', attachments: [] })
    f.chat.querySelector('.chat-send').click()
    const { list } = await import('../../src/session-outbox.js')
    const queued = list(f.control.snapshot().sessionId)
    assert.equal(queued.filter(row => row.text === 'original queued text').length, 1,
      'the original Send must enqueue while start/binding is pending')
    assert.equal(f.legacy.length, 0)
    release()
    await opening
    await until(() => f.legacy.some(turn => turn.text === 'original queued text'))
    assert.equal(f.legacy.filter(turn => turn.text === 'original queued text').length, 1)
    assert.equal(f.legacy.length, 1)
  } finally { release(); f.dispose() }
})

for (const disposition of ['accepted', 'unknown', 'not-sent']) test('queued text readiness respects ' + disposition + ' delivery', async () => {
  const { list } = await import('../../src/session-outbox.js')
  let attempts = 0, deliveries = 0
  const text = 'one immutable queued instruction'
  const f = await fixture({ busy: true, beforeSend: arg => {
    if (arg.text !== text) return
    attempts++
    if (disposition === 'not-sent' && attempts === 1) throw Object.assign(new Error('not sent'), { code: 'AGENT_SESSION_NOT_READY' })
    deliveries++
    if (disposition === 'unknown') throw new Error('receipt lost after invocation')
  } })
  try {
    f.chat.importDraft({ text, attachments: [] })
    f.chat.querySelector('.chat-send').click()
    const id = f.control.snapshot().sessionId
    await until(() => list(id).some(row => row.text === text))
    assert.equal(attempts, 0)
    f.completeTurn()
    await until(() => attempts === 1)
    await tick(); await tick()
    if (disposition === 'unknown') {
      assert.equal(list(id).find(row => row.text === text)?.deliveryUnconfirmed, true)
    }
    if (disposition === 'not-sent') {
      const row = list(id).find(row => row.text === text)
      assert.equal(row.text, text)
      assert.notEqual(row.deliveryUnconfirmed, true)
      f.completeTurn()
      await until(() => deliveries === 1)
      assert.equal(attempts, 2)
    }
    f.completeTurn(); f.completeTurn()
    await f.ready()
    await tick(); await tick()
    assert.equal(deliveries, 1)
    assert.equal(attempts, disposition === 'not-sent' ? 2 : 1)
  } finally { f.dispose() }
})
for (const sendDoor of ['send', 'sendnow']) test('pending binding ' + sendDoor + ' queues without offering Stop or interrupting', async () => {
  const { list } = await import('../../src/session-outbox.js')
  let entered = false, release
  const hold = new Promise(resolve => { release = resolve })
  const f = await fixture({ initial: true, chips: true,
    onSessionChange: async (_state, event) => {
      if (event.kind === 'open') { entered = true; await hold; return { ok: true } }
    } })
  try {
    const opening = f.control.submitImageIntent({ operationId: randomUUID(), text: 'opening image',
      images: f.paths.map(path => ({ path })) })
    await until(() => entered)
    const arrow = f.chat.querySelector('.chat-send')
    const halt = f.chat.querySelector('[data-chat-chip="halt"]')
    assert.ok(halt)
    assert.equal(arrow.classList.contains('is-stop'), false)
    assert.ok(halt.hidden || halt.disabled, 'no active turn means Halt is unavailable')
    arrow.click()
    await tick()
    assert.equal(f.calls.filter(call => call.operation === 'interrupt').length, 0)
    const text = 'pending original ' + sendDoor
    f.chat.importDraft({ text, attachments: [] })
    const button = sendDoor === 'send' ? arrow : f.chat.querySelector('[data-chat-chip="sendnow"]')
    assert.ok(button)
    button.click()
    await until(() => list(f.control.snapshot().sessionId).some(row => row.text === text))
    const id = f.control.snapshot().sessionId
    const rows = list(id)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].text, text)
    const queuedNow = f.chat.querySelector('.chat-queue-now')
    assert.ok(queuedNow)
    assert.equal(queuedNow.disabled, false)
    const admissionsBeforePromotion = f.calls.filter(call => call.operation === 'admit').length
    queuedNow.click()
    await tick()
    assert.deepEqual(list(id).map(row => [row.id, row.text]), rows.map(row => [row.id, row.text]))
    assert.equal(f.calls.filter(call => call.operation === 'admit').length, admissionsBeforePromotion)
    assert.equal(f.calls.filter(call => call.operation === 'interrupt').length, 0)
    assert.equal(f.legacy.length, 0)
    release()
    await opening
    await until(() => f.legacy.some(turn => turn.text === text))
    assert.equal(f.legacy.filter(turn => turn.text === text).length, 1)
    f.completeTurn(); f.completeTurn()
    await f.ready()
    await tick(); await tick()
    assert.equal(f.legacy.filter(turn => turn.text === text).length, 1)
  } finally { release(); f.dispose() }
})

test('active turn still offers Stop and queues text under queue-required status', async () => {
  const { list } = await import('../../src/session-outbox.js')
  const f = await fixture({ busy: true, chips: true })
  try {
    f.chat.importDraft({ text: '', attachments: [] })
    const arrow = f.chat.querySelector('.chat-send')
    const halt = f.chat.querySelector('[data-chat-chip="halt"]')
    assert.equal(arrow.classList.contains('is-stop'), true)
    assert.ok(halt)
    assert.equal(halt.hidden, false)
    assert.equal(halt.disabled, false)
    f.chat.importDraft({ text: 'follow active turn', attachments: [] })
    arrow.click()
    assert.equal(list(f.control.snapshot().sessionId).filter(row => row.text === 'follow active turn').length, 1)
    assert.equal(f.legacy.filter(turn => turn.text === 'follow active turn').length, 0)
    halt.click()
    await until(() => f.calls.some(call => call.operation === 'interrupt'))
    assert.equal(f.calls.filter(call => call.operation === 'interrupt').length, 1)
  } finally { f.dispose() }
})

test('text open callback carries initiating owner and refuses owner change during binding', async () => {
  let context, release
  const hold = new Promise(resolve => { release = resolve })
  const f = await fixture({ initial: true, onSessionChange: async (_state, event) => {
    if (event.kind !== 'open') return
    context = event.bindingContext
    await hold
    return { ok: true }
  } })
  try {
    const pending = f.control.send('original text owner')
    await until(() => context)
    assert.equal(context.isCurrent(), true)
    assert.equal(context.ownerContext.kind, 'local')
    f.changeOwner()
    assert.equal(context.isCurrent(), false)
    release()
    assert.equal((await pending).ok, false)
    assert.equal(f.legacy.length, 0)
  } finally { release(); f.dispose() }
})

test('one plain-text composer Send after ended session waits for successor start and bind then dispatches once', async () => {
  let f, starts = 0, enteredStart = false, enteredBind = false, releaseStart, releaseBind
  const startHold = new Promise(resolve => { releaseStart = resolve })
  const bindHold = new Promise(resolve => { releaseBind = resolve })
  f = await fixture({ initial: true,
    beforeStart: () => {
      starts++
      if (starts === 1) { f.endSession(); return }
      enteredStart = true
      return startHold
    },
    onSessionChange: async (_state, event) => {
      if (event.kind !== 'open') return
      enteredBind = true
      assert.equal(event.bindingContext.isCurrent(), true)
      await bindHold
      return { ok: true }
    } })
  try {
    // Create the ended-session state through the actual start/terminal event
    // path. This attempt ends before any turn, without a seed send or image.
    assert.equal((await f.control.send('prior start ended before delivery')).ok, false)
    assert.equal(f.control.snapshot().sessionId, null)
    assert.equal(f.control.snapshot().phase, 'closed')
    assert.equal(f.legacy.length, 0)
    assert.equal(f.sent.length, 0)
    const text = 'original plain text after ending'
    f.chat.importDraft({ text, attachments: [] })
    f.chat.querySelector('.chat-send').click()
    await until(() => enteredStart)
    assert.equal(f.legacy.length, 0)
    assert.equal(enteredBind, false)
    releaseStart()
    await until(() => enteredBind)
    assert.equal(f.legacy.length, 0)
    releaseBind()
    await until(() => f.legacy.length === 1)
    assert.equal(f.legacy[0].text, text)
    assert.equal(f.legacy[0].images, undefined)
    assert.equal(f.calls.some(c => ['retain', 'admit', 'dispatch', 'pasteAttachment'].includes(c.operation)), false)
    f.completeTurn(); f.completeTurn()
    await f.ready()
    await tick(); await tick()
    assert.equal(f.legacy.length, 1)
    assert.equal(starts, 2)
  } finally { releaseStart(); releaseBind(); f.dispose() }
})
