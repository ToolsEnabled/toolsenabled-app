import test from 'node:test'
import assert from 'node:assert/strict'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { mountStandaloneAgent } from '../../src/tree-standalone-agent.js'
import * as standalone from '../../src/tree-standalone-agent.js'
import { mountAgentSessionSurface } from '../../src/agent-session.js'
import { readFileSync, realpathSync, mkdtempSync } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { parseAst } from 'rollup/parseAst'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
// Bounded scheduling only: failure after 100 event-loop turns names the wait.
async function until(check, reason) {
  for (let turn = 0; turn < 100 && !check(); turn++) await tick()
  assert.ok(check(), reason)
}
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function mount(t, { startWait = null, bindWait = null, transcriptAvailable = true } = {}) {
  const dom = installDomStandIn()
  const priorStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const storage = new Map([['mc.write.agent-session', 'enabled']])
  globalThis.localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  }
  const events = new Set(), calls = [], native = new Set()
  let owner = { version: 1, ownerId: 'test-owner', currentEpoch: 'first-epoch', kind: 'local' }
  const ownerListeners = new Set()
  let recovery = null
  const bridge = {
    availability: async () => ({ ok: true }),
    confinement: async () => ({ ok: true, tier: 'standard' }),
    onEvent: listener => { events.add(listener); return () => events.delete(listener) },
    ownerContext: async () => owner,
    onOwnerContextChanged: listener => { ownerListeners.add(listener); return () => ownerListeners.delete(listener) },
    async start(request) {
      calls.push(['start', request])
      await startWait?.promise
      native.add(request.sessionId)
      if (request.recoveryId) {
        assert.equal(request.recoveryId, recovery.recoveryId)
        assert.equal(request.sessionId, recovery.sessionId)
      }
      return { ok: true, sessionId: request.sessionId, ...(request.recoveryId ? { recovery } : {}) }
    },
    async imageQueue(request) {
      if (request.operation === 'binding') {
        assert.ok(native.has(request.sessionId))
        return { ok: true, result: { sessionId: request.sessionId, conversationId: 'test-seat', ownerContext: owner } }
      }
      if (request.operation === 'read') return { ok: true, result: {
        version: 1, entries: [], automaticSend: false, generation: 'empty-queue', destinationSessionId: null,
      } }
      if (request.operation !== 'ended-register') return { ok: false, code: 'TEST_IMAGE_QUEUE_UNAVAILABLE' }
      assert.ok(native.has(request.sourceSessionId))
      assert.deepEqual(request.ownerContext, owner)
      recovery = { recoveryId: randomUUID(), sourceSessionId: request.sourceSessionId,
        sessionId: randomUUID(), conversationId: 'test-seat', ownerContext: owner }
      calls.push(['ended-register', request])
      return { ok: true, result: recovery }
    },
    async send(request) {
      calls.push(['send', request])
      return { ok: true, turnId: 'test-turn' }
    },
    close: async request => { native.delete(request.sessionId); calls.push(['close', request]); return { closed: true } },
    interrupt: async () => ({ ok: true }),
  }
  const transcript = transcriptAvailable ? {
    async bind(sessionId, seatId) {
      calls.push(['bind', { sessionId, seatId, nativeStarted: native.has(sessionId) }])
      if (!native.has(sessionId)) return { ok: false, code: 'TEST_BIND_BEFORE_START' }
      return bindWait ? bindWait.promise : { ok: true }
    },
    async release(sessionId) {
      calls.push(['release', { sessionId }])
      return { ok: true, released: true }
    },
  } : null
  const host = dom.document.createElement('div')
  dom.document.body.appendChild(host)
  const adapter = mountStandaloneAgent(host, { id: 'test-seat', live: true, bridge, transcript })
  const chat = () => host.querySelector('[data-chat-panel]')
  const emit = (sessionId, event) => { for (const listener of events) listener({ sessionId, event }) }
  t.after(async () => {
    startWait?.resolve({ ok: true }); bindWait?.resolve({ ok: true })
    adapter.dispose()
    await tick()
    if (priorStorage) Object.defineProperty(globalThis, 'localStorage', priorStorage)
    else delete globalThis.localStorage
    dom.restore()
  })
  await until(() => chat()?.querySelector('.chat-send'), 'mounted composer did not become available')
  await tick()
  return {
    adapter, calls, chat, emit,
    setBindWait(value) { bindWait = value },
    click(text) {
      const input = chat().querySelector('.chat-input input')
      input.value = text
      input.dispatch('input')
      chat().querySelector('.chat-send').click()
    },
    changeOwner() {
      owner = { ...owner, currentEpoch: 'successor-epoch' }
      for (const listener of ownerListeners) listener(owner)
    },
  }
}

test('one Send waits for actual native start then binding ACK and dispatches exactly once', async t => {
  const startWait = deferred(), bindWait = deferred()
  const f = await mount(t, { startWait, bindWait })
  f.click('preserve this intent')
  await until(() => f.calls.some(([kind]) => kind === 'start'), 'Send did not request start')
  assert.equal(f.calls.filter(([kind]) => kind === 'bind').length, 0, 'attempted session ID is not a started session')
  assert.equal(f.calls.filter(([kind]) => kind === 'send').length, 0)
  assert.equal(f.adapter.exportDraft().text, 'preserve this intent')
  startWait.resolve()
  await until(() => f.calls.some(([kind]) => kind === 'bind'), 'post-start callback did not request binding')
  assert.equal(f.calls.find(([kind]) => kind === 'bind')[1].nativeStarted, true)
  assert.equal(f.calls.filter(([kind]) => kind === 'send').length, 0, 'pending ACK cannot authorize dispatch')
  assert.equal(f.adapter.exportDraft().text, 'preserve this intent')
  bindWait.resolve({ ok: true })
  await until(() => f.calls.some(([kind]) => kind === 'send'), 'original Send did not continue after binding')
  await tick()
  assert.equal(f.calls.filter(([kind]) => kind === 'send').length, 1)
  assert.equal(f.calls.find(([kind]) => kind === 'send')[1].text, 'preserve this intent')
  assert.equal(f.adapter.exportDraft().text, '', 'a dispatched message is not a retryable draft')
})

for (const kind of ['refused', 'missing-ack', 'rejected', 'missing-client']) {
  test(kind + ' binding retains the submitted draft and makes no send attempt', async t => {
    const bindWait = deferred()
    const f = await mount(t, { bindWait, transcriptAvailable: kind !== 'missing-client' })
    f.click('keep my question')
    if (kind !== 'missing-client') {
      await until(() => f.calls.some(([name]) => name === 'bind'), 'binding was not requested')
      if (kind === 'rejected') bindWait.reject(Object.assign(new Error('test refusal'), { code: 'TEST_BIND_REFUSED' }))
      else bindWait.resolve(kind === 'refused' ? { ok: false, code: 'TEST_BIND_REFUSED' } : undefined)
    }
    await until(() => f.calls.some(([name]) => name === 'close'), 'binding refusal did not clean up the started session')
    assert.equal(f.calls.filter(([name]) => name === 'send').length, 0)
    assert.equal(f.adapter.exportDraft().text, 'keep my question')
  })
}

test('a session ending while binding is pending cannot send when its late ACK arrives', async t => {
  const bindWait = deferred()
  const f = await mount(t, { bindWait })
  f.click('retain after exit')
  await until(() => f.calls.some(([kind]) => kind === 'bind'), 'binding was not requested')
  const id = f.calls.find(([kind]) => kind === 'start')[1].sessionId
  f.emit(id, { type: 'session_ended', reason: 'exited', exit: { code: 0, signal: null } })
  bindWait.resolve({ ok: true })
  await tick(); await tick()
  assert.equal(f.calls.filter(([kind]) => kind === 'send').length, 0)
  assert.equal(f.adapter.exportDraft().text, 'retain after exit')
  const released = await f.adapter.releaseTranscript(id)
  assert.equal(released.released, false, 'late ACK was not recorded as a confirmed current binding')
})

test('a session ending before native start resolves retains the first-send draft', async t => {
  const startWait = deferred()
  const f = await mount(t, { startWait })
  f.click('retain through an early exit')
  await until(() => f.calls.some(([kind]) => kind === 'start'), 'Send did not request start')
  const id = f.calls.find(([kind]) => kind === 'start')[1].sessionId
  f.emit(id, { type: 'session_ended', reason: 'exited', exit: { code: 1, signal: null } })
  startWait.resolve()
  await tick(); await tick()
  assert.equal(f.calls.some(([kind]) => ['bind', 'send'].includes(kind)), false)
  assert.equal(f.adapter.exportDraft().text, 'retain through an early exit')
  assert.equal(f.adapter.snapshot().sessionId, null)
})

test('disposal during pending binding preserves draft and prevents late dispatch', async t => {
  const bindWait = deferred()
  const f = await mount(t, { bindWait })
  f.click('retain after close')
  await until(() => f.calls.some(([kind]) => kind === 'bind'), 'binding was not requested')
  f.adapter.dispose()
  bindWait.resolve({ ok: true })
  await tick(); await tick()
  assert.equal(f.calls.filter(([kind]) => kind === 'send').length, 0)
  assert.equal(f.adapter.exportDraft().text, 'retain after close')
})

test('an owner change during delayed binding cannot confirm the previous owner intent', async t => {
  const bindWait = deferred()
  const f = await mount(t, { bindWait })
  f.click('previous owner question')
  await until(() => f.calls.some(([kind]) => kind === 'bind'), 'binding was not requested')
  f.changeOwner()
  bindWait.resolve({ ok: true })
  await tick(); await tick()
  assert.equal(f.calls.filter(([kind]) => kind === 'send').length, 0)
  assert.equal(f.adapter.exportDraft().text, 'previous owner question')
})

test('one Send after an ended session waits for the new binding then dispatches once', async t => {
  const f = await mount(t)
  f.click('first turn')
  await until(() => f.calls.some(([kind]) => kind === 'send'), 'initial turn did not send')
  const firstId = f.calls.find(([kind]) => kind === 'start')[1].sessionId
  f.emit(firstId, { type: 'session_ended', reason: 'exited', exit: { code: 0, signal: null } })
  await tick()
  const bindWait = deferred()
  f.setBindWait(bindWait)
  f.click('exact recovered intent')
  await until(() => f.calls.filter(([kind]) => kind === 'bind').length === 2, 'original Send did not recover and request binding')
  assert.equal(f.calls.filter(([kind]) => kind === 'send').length, 1)
  bindWait.resolve({ ok: true })
  await until(() => f.calls.filter(([kind]) => kind === 'send').length === 2, 'recovered Send required another click')
  await tick()
  const sends = f.calls.filter(([kind]) => kind === 'send')
  assert.equal(sends.length, 2)
  assert.equal(sends[1][1].text, 'exact recovered intent')
  assert.notEqual(sends[1][1].sessionId, firstId)
})

// Actual wrapper + actual shared session mount. The transparent observer only
// exposes the otherwise-private controller; every wrapper callback, start,
// binding, image preparation, transfer and successor drain still runs normally.
const wrapperSource = readFileSync(new URL('../../src/tree-standalone-agent.js', import.meta.url), 'utf8')
const wrapperDeclaration = parseAst(wrapperSource).body.find(node => node.declaration?.id?.name === 'mountStandaloneAgent').declaration
const wrapperFactory = new Function('mountAgentSessionSurface', 'standaloneStartFrom', 'standaloneStartChoices',
  'SOLO_TIERS', 'SOLO_TIER_IDS', 'SOLO_EFFORTS', 'effortForTier', 'STANDALONE_SURFACE',
  'STANDALONE_UNCHOSEN_SENTENCE', 'standaloneStartChangedSentence',
  'return (' + wrapperSource.slice(wrapperDeclaration.start, wrapperDeclaration.end) + ')')
const require = createRequire(import.meta.url)
const { createImageRetentionService } = require('../../shell/image-retention-service.cjs')
const imageDigest = bytes => createHash('sha256').update(bytes).digest('hex')

async function mountedImages(t, { initialBind = null, successorBind = null, startHold = null } = {}) {
  // This fixture deliberately requires explicit task inputs. It never chooses
  // an inherited OS temp location, creates a provider, or deletes evidence.
  assert.ok(process.env.T489_TEST_TEMP, 'T489_TEST_TEMP must name the assigned test directory')
  assert.ok(process.env.T489_PNG_MANIFEST, 'T489_PNG_MANIFEST must name the reviewed PNG manifest')
  const profilePath = value => {
    assert.ok(path.isAbsolute(value), 'fixture inputs must be explicit absolute paths')
    // Account fence is a test-run safety constraint, never product identity.
    if (process.platform === 'win32') {
      const permitted = 'C:/Users/ToolsEnabled-Dev/'
      assert.ok(path.resolve(value).split(path.sep).join('/').toLowerCase().startsWith(permitted.toLowerCase()),
        'fixture path must stay in the permitted Dev profile')
    }
    return value
  }
  const explicitTemp = profilePath(process.env.T489_TEST_TEMP)
  const temp = profilePath(realpathSync(explicitTemp))
  if (process.platform === 'win32') {
    const devTemp = 'C:/Users/ToolsEnabled-Dev/AppData/Local/Temp'
    const relativeTemp = path.relative(devTemp, temp)
    assert.ok(!relativeTemp.startsWith('..') && !path.isAbsolute(relativeTemp),
      'fixture destination must be the literal Dev temp root or a child')
  }
  const root = mkdtempSync(path.join(temp, 'wrapper-binding-'))
  const relative = path.relative(temp, realpathSync(root))
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
  const manifestPath = profilePath(realpathSync(profilePath(process.env.T489_PNG_MANIFEST)))
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.ok(manifest.images.length >= 2, 'two distinct PNG fixtures are required')
  // Scope is exactly the first two manifest images, not the whole manifest.
  const paths = manifest.images.slice(0, 2).map(row => profilePath(realpathSync(profilePath(row.path))))
  const buffers = paths.map(file => readFileSync(file))
  const bytes = buffers.map(imageDigest)
  assert.notEqual(bytes[0], bytes[1])
  console.log('WRAPPER_BINDING_RETAINED_FIXTURE ' + JSON.stringify({ root, bytes }))
  const dom = installDomStandIn()
  const priorStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const storage = new Map([['mc.write.agent-session', 'enabled']])
  globalThis.localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  }
  const computerId = randomUUID(), seatId = 'standalone-' + randomUUID()
  let ownerContext = { version: 1, ownerId: randomUUID(), currentEpoch: randomUUID(), kind: 'local' }
  const calls = [], sent = [], legacy = [], listeners = new Set(), ownerListeners = new Set()
  const sessions = new Map(), transcriptBindings = new Map()
  let activeId = null, candidateId = null, sourceId = null, committedReceipt = null, control
  const authority = request => {
    const record = sessions.get(request.sessionId)
    assert.ok(record, 'image authority requires a native session from the real start/prepare call')
    return { session: record, sessionId: request.sessionId, accountId: 'default',
      provider: 'codex', model: 'fixture-model', effort: null, issued: record.issued }
  }
  const service = createImageRetentionService({
    root: path.join(root, 'retention'),
    authenticate: captured => {
      assert.deepEqual(captured, ownerContext)
      return { authenticated: true, productOwnerId: ownerContext.ownerId, currentEpoch: ownerContext.currentEpoch }
    },
    sourceAuthority: authority, candidateAuthority: authority,
    authorizeTransfer: () => true, engineImageBytes: 8 * 1024 * 1024,
  })
  const emit = (sessionId, event) => { for (const listener of listeners) listener({ sessionId, event }) }
  const bridge = {
    availability: async () => ({ ok: true }),
    confinement: async () => ({ ok: true, tier: 'standard' }),
    ownerContext: async () => ownerContext,
    onOwnerContextChanged: listener => { ownerListeners.add(listener); return () => ownerListeners.delete(listener) },
    onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    async start(request) {
      calls.push({ operation: 'start', ...request })
      await startHold?.promise
      activeId = request.sessionId
      sessions.set(activeId, { issued: new Set() })
      return { ok: true, sessionId: activeId, threadId: randomUUID(), account: null }
    },
    async send(request) {
      legacy.push(request)
      return { ok: true, turnId: 'seed-turn' }
    },
    async pasteAttachment(request) {
      calls.push({ operation: 'pasteAttachment', ...request, data: undefined })
      const record = sessions.get(request.sessionId)
      assert.ok(record, 'paste issuance requires a started native session')
      const index = buffers.findIndex(value => value.toString('base64') === request.data)
      assert.ok(index >= 0, 'unexpected image bytes')
      record.issued.add(paths[index])
      return { ok: true, path: paths[index] }
    },
    close: async request => { calls.push({ operation: 'close', ...request }); return { closed: true } },
    interrupt: async request => { calls.push({ operation: 'interrupt', ...request }); return { ok: true } },
    async switchSession(request) {
      calls.push({ operation: 'switch-' + request.operation, operationId: request.operationId, sessionId: request.sessionId })
      if (request.operation === 'prepare') {
        sourceId = activeId
        candidateId = randomUUID()
        sessions.set(candidateId, { issued: new Set(sessions.get(sourceId).issued) })
        return { operationId: request.operationId, phase: 'prepared', applied: false,
          sourceSessionId: sourceId, sessionId: candidateId }
      }
      if (request.operation === 'commit') {
        emit(sourceId, { type: 'session_ended', reason: 'exited', exit: { code: 0, signal: null } })
        activeId = candidateId
        committedReceipt = { operationId: request.operationId, applied: true, sourceSessionId: sourceId,
          sessionId: candidateId, provider: 'codex', tier: 'fixture-model', effort: null, revision: 1,
          threadId: randomUUID(), account: null, historyLink: { computerId, nodeId: seatId },
          attachmentsTransferred: true, attachmentCount: sessions.get(candidateId).issued.size }
        return committedReceipt
      }
      return { operationId: request.operationId, applied: Boolean(committedReceipt), receipt: committedReceipt }
    },
    async imageQueue(request) {
      calls.push(structuredClone(request))
      if (request.operation === 'binding') {
        // No prebinding shortcut: initial image admission needs the actual
        // wrapper transcript ACK. A committed successor history link is native
        // fixture state; wrapper confirmation is separately delayed below.
        const bound = transcriptBindings.has(request.sessionId)
          || committedReceipt?.sessionId === request.sessionId
        return bound ? { ok: true, result: { conversationId: seatId,
          sessionId: request.sessionId, ownerContext } } : { ok: false, code: 'TEST_TRANSCRIPT_NOT_BOUND' }
      }
      if (request.operation === 'dispatch') {
        const result = await service.dispatch(request, request.ownerContext, async turn => {
          sent.push({ sessionId: request.sessionId, text: turn.text,
            bytes: turn.images.map(image => imageDigest(readFileSync(image.path))) })
          return { ok: true, deliveryDisposition: 'accepted', result: { turnId: randomUUID() } }
        })
        return { ...result, operation: 'dispatch', operationId: request.operationId,
          sessionId: request.sessionId, conversationId: request.conversationId,
          envelopeId: request.envelopeId, ownerContext: request.ownerContext }
      }
      return service.run(request.operation === 'admit' && !request.selection
        ? { ...request, selection: { model: 'fixture-model', effort: null } } : request, request.ownerContext)
    },
  }
  const transcript = {
    async bind(sessionId, nodeId) {
      calls.push({ operation: 'transcript-bind', sessionId, nodeId, started: sessions.has(sessionId) })
      if (!sessions.has(sessionId)) return { ok: false, code: 'TEST_BIND_BEFORE_NATIVE_START' }
      const wait = sessionId === candidateId ? successorBind : initialBind
      const answer = wait ? await wait.promise : { ok: true }
      if (answer?.ok === true) transcriptBindings.set(sessionId, nodeId)
      return answer
    },
    release: async sessionId => ({ ok: true, released: transcriptBindings.delete(sessionId) }),
  }
  const choices = standalone.standaloneStartChoices()
  const observedMount = (surface, options) => mountAgentSessionSurface(surface, {
    ...options,
    onController(...args) {
      const result = Reflect.apply(options.onController, this, args)
      if (args[0]) control = args[0]
      return result
    },
  })
  const realWrapper = wrapperFactory(observedMount, standalone.standaloneStartFrom,
    standalone.standaloneStartChoices, choices.tiers, new Set(choices.tiers.map(row => row.id)),
    choices.efforts.map(row => row.id), tier => choices.tiers.find(row => row.id === tier)?.effort || 'medium',
    standalone.STANDALONE_SURFACE, standalone.STANDALONE_UNCHOSEN_SENTENCE, standalone.standaloneStartChangedSentence)
  const host = dom.document.createElement('div')
  dom.document.body.appendChild(host)
  const adapter = realWrapper(host, { id: seatId, seat: { id: seatId }, computerId, live: true, bridge, transcript })
  t.after(async () => {
    initialBind?.resolve({ ok: true }); successorBind?.resolve({ ok: true }); startHold?.resolve()
    adapter.dispose()
    await tick()
    if (priorStorage) Object.defineProperty(globalThis, 'localStorage', priorStorage)
    else delete globalThis.localStorage
    dom.restore()
  })
  await until(() => control && host.querySelector('.chat-send'), 'real wrapper did not mount its session consumer')
  await tick()
  const chat = () => host.querySelector('[data-chat-panel]')
  const content = () => {
    const draft = adapter.exportDraft()
    return { text: draft.text, images: draft.attachments.map(image => image.path) }
  }
  return {
    control, adapter, calls, sent, legacy, bytes, paths, chat, content,
    async pasteOrdered(text) {
      for (let index = 0; index < buffers.length; index++) {
        const buffer = buffers[index]
        chat().querySelector('.chat-input input').dispatch('paste', {
          clipboardData: { items: [{ kind: 'file', type: 'image/png',
            getAsFile: () => ({ arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) }) }] },
        })
        await until(() => adapter.exportDraft().attachments.length === index + 1, 'paste did not append the next image')
      }
      const input = chat().querySelector('.chat-input input')
      input.value = text; input.dispatch('input')
      return content()
    },
    click: () => chat().querySelector('.chat-send').click(),
    changeOwner() {
      ownerContext = { ...ownerContext, currentEpoch: randomUUID() }
      for (const listener of ownerListeners) listener(ownerContext)
    },
    complete: () => emit(activeId, { type: 'turn_completed', status: 'completed' }),
    setSuccessorBind(value) { successorBind = value },
    durable: () => service.run({ operation: 'read', conversationId: seatId }, ownerContext).result,
    evidence: () => ({ root, sourceId, candidateId }),
  }
}

for (const text of ['', '  exact text with two images  ']) {
  for (const outcome of ['confirmed', 'refused', 'stale-owner']) {
    test('mounted wrapper first ' + (text ? 'text+images' : 'image-only') + ' Send preserves delayed ' + outcome + ' bind', async t => {
      const initialBind = deferred(), startHold = deferred()
      const f = await mountedImages(t, { initialBind, startHold })
      const draft = await f.pasteOrdered(text)
      f.click()
      await until(() => f.calls.some(call => call.operation === 'start'), 'single Send did not start native session')
      assert.equal(f.calls.some(call => call.operation === 'transcript-bind'), false)
      assert.deepEqual(f.content(), draft)
      assert.equal(f.sent.length, 0)
      startHold.resolve()
      await until(() => f.calls.some(call => call.operation === 'transcript-bind'), 'post-start bind missing')
      assert.equal(f.calls.find(call => call.operation === 'transcript-bind').started, true)
      assert.equal(f.calls.some(call => call.operation === 'pasteAttachment'), false)
      assert.equal(f.sent.length, 0)
      assert.deepEqual(f.content(), draft)
      if (outcome === 'stale-owner') f.changeOwner()
      initialBind.resolve(outcome === 'refused' ? { ok: false, error: { code: 'TEST_BIND_REFUSED' } } : { ok: true })
      if (outcome === 'confirmed') {
        await until(() => f.sent.length === 1, 'original image Send did not continue after bind ACK')
        assert.deepEqual(f.sent.map(turn => ({ text: turn.text, bytes: turn.bytes })), [{ text, bytes: f.bytes }])
        assert.equal(f.legacy.length, 0, 'image intent must not create a text recovery turn')
        await until(() => f.adapter.exportDraft().attachments.length === 0, 'accepted draft did not clear')
        f.complete(); f.complete(); await f.control.imageOutbox.refresh(); await tick()
        assert.equal(f.sent.length, 1, 'accepted image Send must never replay')
      } else {
        await until(() => f.calls.some(call => call.operation === 'close'), 'refused/stale start did not settle')
        assert.equal(f.sent.length, 0)
        assert.equal(f.legacy.length, 0)
        assert.deepEqual(f.content(), draft)
        assert.equal(f.calls.some(call => call.operation === 'dispatch'), false)
      }
    })
  }
}

for (const text of ['', '  immutable queued successor text  ']) {
  for (const outcome of ['confirmed', 'refused-then-confirmed', 'stale-owner']) {
    test('mounted wrapper replacement ' + (text ? 'text+images' : 'image-only') + ' holds ' + outcome + ' ACK and preserves one submitted intent', async t => {
      const successorBind = deferred()
      const f = await mountedImages(t, { successorBind })
      assert.equal((await f.control.send('seed native session')).ok, true)
      // Keep the seed turn busy so the one real image Send is admitted but
      // cannot dispatch before replacement begins.
      const draft = await f.pasteOrdered(text)
      f.click()
      await until(() => f.calls.some(call => call.operation === 'admit'), 'single Send did not admit queued images')
      await until(() => f.durable().entries.length === 1, 'queued image intent not durably recorded')
      const before = structuredClone(f.durable().entries)
      assert.equal(before[0].text, text)
      assert.equal(f.sent.length, 0)
      // Durable admission legitimately clears the submitted composer. Keep a
      // separate never-submitted draft visible throughout the replacement;
      // it must be retained and must not inherit the first Send authorization.
      await until(() => f.adapter.exportDraft().attachments.length === 0, 'admitted composer did not settle')
      f.chat().importDraft({ text: '  never submitted successor draft  ',
        attachments: f.paths.map(path => ({ path })) })
      const heldDraft = f.content()
      const operationId = randomUUID()
      const prepared = await f.control.switchSession({ operation: 'prepare', operationId, tier: 'fixture-model' })
      assert.equal(prepared.ok, true)
      const pending = f.control.switchSession({ operation: 'commit', operationId })
      await until(() => f.calls.some(call => call.operation === 'transcript-bind' && call.sessionId === prepared.sessionId),
        'real replaced callback did not invoke wrapper binding')
      assert.equal(f.adapter.snapshot().sessionId, prepared.sessionId, 'host adoption remains a fact while bind waits')
      assert.equal(f.sent.length, 0)
      assert.deepEqual(f.durable().entries, before, 'pending binding cannot alter immutable queued intent')
      assert.deepEqual(f.content(), heldDraft, 'pending successor binding must retain the separate composer text and image order')
      if (outcome === 'stale-owner') f.changeOwner()
      successorBind.resolve(outcome === 'refused-then-confirmed' ? { ok: false, error: { code: 'TEST_SUCCESSOR_BIND_REFUSED' } } : { ok: true })
      const result = await pending
      if (outcome === 'stale-owner') {
        assert.equal(result.ok, false)
        assert.equal(f.sent.length, 0)
        assert.deepEqual(f.content(), heldDraft)
        assert.equal(f.calls.some(call => call.operation === 'dispatch'), false)
      } else {
        if (outcome === 'refused-then-confirmed') {
          assert.equal(result.ok, false)
          assert.equal(result.reconcile, true)
          assert.equal(f.sent.length, 0)
          assert.deepEqual(f.content(), heldDraft)
          assert.deepEqual(f.durable().entries, before)
          f.setSuccessorBind(null)
          assert.equal((await f.control.switchSession({ operation: 'status', operationId })).ok, true,
            'reconciliation should retry binding without repeating host commit')
        } else assert.equal(result.ok, true)
        await until(() => f.sent.length === 1, 'submitted successor intent required a second Send')
        assert.deepEqual(f.sent, [{ sessionId: prepared.sessionId, text, bytes: f.bytes }])
        assert.deepEqual(f.content(), heldDraft, 'never-submitted draft cannot be dispatched or cleared by successor readiness')
        f.complete(); f.complete(); await f.control.imageOutbox.refresh(); await tick()
        assert.equal(f.sent.length, 1)
        assert.equal(f.legacy.length, 1, 'only the seed text turn used legacy send')
      }
      assert.equal(f.calls.filter(call => call.operation === 'switch-commit').length, 1)
      assert.equal(f.calls.filter(call => call.operation === 'admit').length, 1)
    })
  }
}
