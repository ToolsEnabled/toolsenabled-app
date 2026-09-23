/* T785 joined proof: actual standalone composer -> fleet preload -> selected
 * main IPC registrations/parsers -> command surface -> host/courier.
 * DOM, localStorage, IPC transport, Engine adapter and tree inbox are inert.
 * No filesystem fixture, native worker, network, or physical cleanup. Computers
 * remains separately blocked under T808; this suite does not qualify that view. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import test from 'node:test'
import { parseAst } from 'rollup/parseAst'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
const require = createRequire(import.meta.url)
const { createAgentHost } = require('../../shell/agent-host.cjs')
const APP = fileURLToPath(new URL('../../', import.meta.url))
const FIXTURE = path.join(APP, 'tools/test/fixtures/confined-engine')
const ENGINE = path.join(FIXTURE, 'src/lib/agent-engine/codex-process.js')
const engine = require(ENGINE)
const directory = require(path.join(FIXTURE, 'src/lib/agent-comms/tree-node-directory.js'))
const provider = require(path.join(FIXTURE, 'src/lib/providers/agent-comms-local.js'))
const { createAgentCommandSurface, REQUIRED_DEPS } = require('../../shell/agent-command-surface.cjs')
const mainSource = readFileSync(path.join(APP, 'shell/main.cjs'), 'utf8')
const mainAst = parseAst(mainSource)
const helperNames = ['agentIpcError', 'agentPayload', 'boundedAgentString', 'parseAgentSend', 'parseAgentSessionCommand', 'assertTrustedAgentSender', 'windowPrincipal']
const helperSource = helperNames.map(name => {
  const node = mainAst.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === name)
  assert.ok(node, name)
  return mainSource.slice(node.start, node.end)
}).join('\n')
const limitSource = mainAst.body.filter(n => n.type === 'VariableDeclaration').flatMap(n => n.declarations)
  .filter(n => ['MAX_SESSION_ID_LENGTH', 'MAX_TURN_TEXT_LENGTH'].includes(n.id.name))
  .map(n => 'const ' + mainSource.slice(n.start, n.end) + ';').join('\n')
const helpers = new Function('trustedFleetProfileSender', limitSource + '\n' + helperSource + ';return {' + helperNames.join(',') + '}')(event => event.trusted === true)
const operations = ['start', 'send', 'interrupt', 'reserve-send-now', 'release-send-now', 'availability', 'confinement', 'session-activity']
const registrationSource = operations.map(op => {
  const node = mainAst.body.find(n => n.type === 'ExpressionStatement' && n.expression.type === 'CallExpression'
    && n.expression.callee.object?.name === 'ipcMain' && n.expression.callee.property?.name === 'handle'
    && n.expression.arguments[0]?.value === 'mc-agent:' + op)
  assert.ok(node, op)
  return mainSource.slice(node.start, node.end)
}).join('\n')
const preloadSource = readFileSync(path.join(APP, 'shell/fleet-profile-preload.cjs'), 'utf8')
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
let fixtureNumber = 0

async function fixture(t, { refuseStop = false, reserveGate = null, releaseFailure = false, sendGate = null } = {}) {
  const dom = installDomStandIn(globalThis)
  const previousStorage = globalThis.localStorage
  const saved = new Map([['mc.write.agent-session', 'enabled']])
  let onHeldTake = null
  globalThis.localStorage = {
    getItem: k => saved.get(k) ?? null,
    setItem(k, v) {
      saved.set(k, String(v))
      const currentHeld = onHeldTake && k === 'mc.session-outbox.v1'
        && JSON.parse(String(v)).sessions.some(row => row.sessionId === onHeldTake.sessionId
          && row.entries.some(entry => entry.deliveryUnconfirmed === true))
      if (currentHeld) {
        const run = onHeldTake.run; onHeldTake = null
        run()
      }
    },
    removeItem: k => saved.delete(k),
  }
  const { mountAgentSessionSurface } = await import('../../src/agent-session.js')
  const { resetLiveSessionForTest } = await import('../../src/agent-session-registry.js')
  const outbox = await import('../../src/session-outbox.js')
  resetLiveSessionForTest(); directory.reset(); provider.reset()
  // Keep the fixture's actual Map directory, without its unrelated disk-I/O
  // timing probe. Production courier registration/inbox/pump code is unchanged.
  const directoryEntry = require.cache[require.resolve(path.join(FIXTURE, 'src/lib/agent-comms/tree-node-directory.js'))]
  const originalDirectory = directoryEntry.exports
  directoryEntry.exports = { ...directory, createTreeNodeDirectory: options => directory.createTreeNodeDirectory({ ...options, fsImpl: null }) }
  t.after(() => { directoryEntry.exports = originalDirectory })
  // Map-only custody storage for teardown, including an assertion failure
  // while the real courier still owns a queued envelope.
  const providerEntry = require.cache[require.resolve(path.join(FIXTURE, 'src/lib/providers/agent-comms-local.js'))]
  const originalProvider = providerEntry.exports, retired = new Map()
  const retire = (verb, { agentId, message }) => {
    assert.equal(agentId, message.audience.agent.agentId)
    assert.ok(message.id)
    const key = agentId + ':' + message.id
    if (retired.has(key)) assert.deepEqual(retired.get(key), { verb, message })
    retired.set(key, { verb, message })
    return { accepted: true, code: verb === 'defer' ? 'BROKER_DELIVERY_DEFERRED' : 'BROKER_MESSAGE_DEAD_LETTERED' }
  }
  providerEntry.exports = { ...provider, defer: request => retire('defer', request), discard: request => retire('discard', request) }
  t.after(() => { providerEntry.exports = originalProvider })
  let clock = Date.now()
  t.mock.method(Date, 'now', () => clock)
  const timers = new Set()
  t.mock.method(globalThis, 'setInterval', fn => { const timer = { fn, unref() {} }; timers.add(timer); return timer })
  t.mock.method(globalThis, 'clearInterval', timer => timers.delete(timer))
  const events = [], engines = [], sends = [], ipcCalls = []
  const complete = index => {
    const row = engines[index]
    assert.ok(row?.active, 'an actual accepted adapter turn must exist')
    row.options.onEvent({ type: 'turn_completed', turnId: row.active, status: 'completed' })
    row.active = null
  }
  t.mock.method(engine, 'startCodexSession', async options => {
    const row = { options, active: null }
    engines.push(row)
    const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null })
    return { threadId: 'thread-' + engines.length, close() {}, adapter: {
      transport: { child },
      async sendTurn(request) { sends.push({ row, request }); row.active = 'turn-' + sends.length; return { turnId: row.active } },
      async interrupt() {
        events.push('adapter-interrupt')
        if (refuseStop) throw Object.assign(new Error('fixture interrupt refused'), { code: 'AGENT_INTERRUPT_REFUSED' })
        complete(engines.indexOf(row))
      }, answerApproval() {},
    } }
  })
  const host = createAgentHost({ enginePath: ENGINE, defaultCwd: FIXTURE, profileRoot: path.parse(APP).root,
    freeMemory: () => 64 * 1024 ** 3,
    messageDeliveryReader: () => ({ mode: 'next-turn', maxWaitMs: 60000 }),
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
    treeCourier: { pollMs: 150, personYieldMs: 1200 },
  })
  let dispose = () => {}, unlisten = () => {}
  t.after(async () => {
    reserveGate?.resolve()
    sendGate?.resolve()
    refuseStop = false // retire the inert adapter even after the tested refusal
    dispose()
    unlisten()
    try { await host.closeAll() } finally {
      directory.reset(); provider.reset(); resetLiveSessionForTest()
      globalThis.localStorage = previousStorage; dom.restore()
    }
  })
  const agentSessions = new Map(), deps = {}
  for (const [key,kind] of Object.entries(REQUIRED_DEPS)) deps[key] = kind === 'function' ? () => null : kind === 'number' ? 128 : kind === 'string' ? FIXTURE : {}
  Object.assign(deps, helpers, { agentSessions, currentAgentHost: () => host, getAgentHost: () => host,
    // Start admission uses an inert account/workspace boundary; send and
    // reservation payload parsing below is the shipping main implementation.
    parseAgentStart: value => ({ ...value }),
    rendererSafeAgentError: error => error, spawnRecordAvailability: () => ({ ok: true }),
    engineAvailability: () => ({ ok: true }), readAgentConfinement: () => ({ ok: true, tier: 'standard' }),
    ensureWorkspaceRoot: () => FIXTURE, chosenWorkspaceCwd: () => FIXTURE,
    recordSpawnIntent: () => ({ sequence: 1, eventHash: 'fixture-hash' }),
    recordSpawnOutcome() {}, recordSessionEnd() {}, bindAgentOwner() {},
    sessionProfiles: { resolveCwd: () => FIXTURE },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    AGENT_EFFORT_VALUES: ['medium'], MAX_AGENT_SESSIONS: 8,
  })
  const surface = createAgentCommandSurface(deps), handlers = new Map()
  const env = { ...helpers, ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, getAgentCommandSurface: () => surface }
  new Function(...Object.keys(env), registrationSource)(...Object.values(env))
  const owner = {}, event = { trusted: true, sender: owner }
  const ipc = new EventEmitter(), exposed = {}
  ipc.sendSync = () => null
  let afterInterrupt = null, beforeActivity = null
  ipc.invoke = async (channel, request) => {
    const row = { channel, request }; ipcCalls.push(row)
    assert.ok(handlers.has(channel), 'registered IPC: ' + channel)
    if (channel === 'mc-agent:release-send-now' && releaseFailure) throw Error('inert IPC release unavailable')
    if (channel === 'mc-agent:session-activity' && beforeActivity) await beforeActivity()
    row.result = await handlers.get(channel)(event, request)
    if (channel === 'mc-agent:reserve-send-now' && reserveGate) await reserveGate.promise
    if (channel === 'mc-agent:send' && request.text === 'held person words' && sendGate) await sendGate.promise
    if (channel === 'mc-agent:interrupt' && afterInterrupt) await afterInterrupt()
    return row.result
  }
  vm.runInNewContext(preloadSource, {
    require: name => { assert.equal(name, 'electron'); return { ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value } } } },
    process: { platform: process.platform }, window: { addEventListener() {} },
  }, { filename: 'fleet-profile-preload.cjs' })
  unlisten = host.onEvent(packet => ipc.emit('mc-agent:event', {}, packet))
  let controller = null
  const root = document.createElement('div'); document.body.appendChild(root)
  dispose = mountAgentSessionSurface(root, { live: true, agentId: 'joined-' + ++fixtureNumber,
    chatComposer: true, bridge: exposed.mcAgent, publishSession: false,
    retainSessionOnDispose: () => true, onController: value => { controller = value },
  })
  await tick()
  const first = await controller.send('Tree address: you are "Manager", at the top of your tree.\n\nInitial work.')
  assert.equal(first.ok, true, JSON.stringify(first))
  const sessionId = first.sessionId
  assert.ok(sessionId)
  await host.startSession({ sessionId: 'peer' })
  await host.sendTurn({ sessionId: 'peer', text: 'Tree address: you are "Worker", and your manager is "Manager".\n\nWork.', origin: 'brief' })
  complete(1)
  const pump = async (advanceMs = 0) => { clock += advanceMs; for (const timer of [...timers]) timer.fn(); for (let i=0;i<8;i++) await tick() }
  const enqueuePeer = () => {
    const recipientAgentId = directory.agentIdForSession(sessionId), senderAgentId = directory.agentIdForSession('peer')
    assert.ok(directory.listNodes().some(row => row.agentId === recipientAgentId) && directory.listNodes().some(row => row.agentId === senderAgentId), 'actual host address registration')
    provider.deliver({ recipientAgentId, senderAgentId, body: 'Worker: NEW COURIER RESULT.' })
  }
  const composerSends = () => sends.filter(row => row.row === engines[0]).map(row => row.request.text)
  const click = door => {
    const input = root.querySelector('.chat-input input'); assert.ok(input)
    input.value = 'held person words'
    if (door === 'strip') {
      root.querySelector('.chat-send').dispatch('click')
      const button = root.querySelector('.chat-queue-now'); assert.ok(button, 'real queued row button')
      button.dispatch('click')
    } else input.dispatch('keydown', { key: 'Enter', shiftKey: true })
  }
  return { root, dispose, controller: () => controller, host, outbox, sessionId, ipcCalls, surface, event, handlers,
    complete, pump, enqueuePeer, composerSends, sentTextsFor: index => sends.filter(row => row.row === engines[index]).map(row => row.request.text), click, allowStop: () => { refuseStop = false }, setAfterInterrupt: fn => { afterInterrupt = fn },
    setOnHeldTake: fn => { onHeldTake = { sessionId, run: fn } }, setBeforeActivity: fn => { beforeActivity = fn } }
}

test('actual preload/main/surface rejects a foreign reservation owner and malformed payload before host release', async t => {
  const f = await fixture(t)
  const reserved = await f.handlers.get('mc-agent:reserve-send-now')(f.event, { sessionId: f.sessionId })
  await assert.rejects(f.handlers.get('mc-agent:release-send-now')({ trusted: true, sender: {} }, { sessionId: f.sessionId, token: reserved.token }), { code: 'MC_AGENT_UNKNOWN_SESSION' })
  assert.throws(() => f.handlers.get('mc-agent:reserve-send-now')({ ...f.event, trusted: false }, { sessionId: f.sessionId }), { code: 'MC_AGENT_SENDER_REFUSED' })
  await assert.rejects(f.handlers.get('mc-agent:release-send-now')(f.event, { sessionId: f.sessionId, token: reserved.token, authority: true }), { code: 'MC_AGENT_INVALID_PAYLOAD' })
  const released = await f.handlers.get('mc-agent:release-send-now')(f.event, { sessionId: f.sessionId, token: reserved.token })
  assert.equal(released.released, true)
})

for (const door of ['strip', 'composer']) {
  test('actual standalone ' + door + ' Send now keeps the courier behind the held person message at the freed boundary', async t => {
    const f = await fixture(t)
    f.enqueuePeer()
    let boundaryChecked = false
    f.setAfterInterrupt(async () => {
      await f.pump()
      assert.equal(f.composerSends().length, 1, 'the idle host courier cannot take the reserved boundary before the interrupt reply reaches the renderer')
      boundaryChecked = true
    })
    f.click(door)
    for (let i=0;i<25;i++) await tick()
    assert.equal(boundaryChecked, true)
    assert.equal(f.composerSends()[1], 'held person words', 'the held words reach the actual host before courier work')
    assert.equal(f.composerSends().length, 2)
    assert.deepEqual(f.outbox.list(f.sessionId), [], 'a host-confirmed send settles the held outbox row')
    const reserve = f.ipcCalls.find(row => row.channel === 'mc-agent:reserve-send-now')
    assert.ok(reserve?.result?.token)
    assert.ok(f.ipcCalls.indexOf(reserve) < f.ipcCalls.findIndex(row => row.channel === 'mc-agent:interrupt'))
    f.complete(0)
    await f.pump(200)
    assert.match(f.composerSends()[2], /NEW COURIER RESULT/, 'courier work still arrives after the person turn ends')
    assert.equal(f.composerSends().length, 3)
  })

  test('actual standalone ' + door + ' Stop refusal releases a still-held pre-host token exactly once', async t => {
    const f = await fixture(t, { refuseStop: true })
    f.enqueuePeer()
    f.click(door)
    for (let i=0;i<15;i++) await tick()
    const reserves = f.ipcCalls.filter(row => row.channel === 'mc-agent:reserve-send-now')
    const releases = f.ipcCalls.filter(row => row.channel === 'mc-agent:release-send-now')
    assert.equal(reserves.length, 1)
    assert.equal(releases.length, 1, 'one release must actually run; zero releases is not success')
    assert.equal(releases[0].request.sessionId, f.sessionId)
    assert.equal(releases[0].request.token, reserves[0].result.token)
    assert.equal(releases[0].result.released, true, 'the release clears a token still held by the host, before any person send can clear it')
    assert.equal(f.composerSends().length, 1, 'a refused Stop does not dispatch the queued person turn')
    const queue = f.outbox.list(f.sessionId)
    assert.equal(queue.length, 1)
    assert.equal(queue[0].deliveryUnconfirmed, undefined)
    await f.pump(200)
    assert.equal(f.composerSends().length, 1, 'releasing a reservation cannot clear the independently pending Stop or dispatch courier work')
    f.outbox.cancel(f.sessionId, queue[0].id)
    f.allowStop()
    assert.equal((await f.controller().pause()).ok, true, 'an actual settled Stop retry is distinct from the refused Stop')
    await f.pump(200)
    assert.match(f.composerSends()[1], /NEW COURIER RESULT/, 'the courier resumes after the real Stop settles')
  })

  test('actual standalone ' + door + ' pending reserve settles on disposal with captured owner and async release rejection contained', async t => {
    const gate = deferred()
    const f = await fixture(t, { reserveGate: gate, releaseFailure: true })
    f.click(door)
    for (let i=0;i<4;i++) await tick()
    const reserve = f.ipcCalls.find(row => row.channel === 'mc-agent:reserve-send-now')
    assert.ok(reserve?.result?.token, 'the host already owns a reservation while IPC reply is pending')
    f.dispose()
    gate.resolve()
    for (let i=0;i<8;i++) await tick()
    const releases = f.ipcCalls.filter(row => row.channel === 'mc-agent:release-send-now')
    assert.equal(releases.length, 1, 'disposed pre-host work must attempt its captured release')
    assert.equal(releases[0].request.sessionId, f.sessionId)
    assert.equal(releases[0].request.token, reserve.result.token)
    assert.equal(f.ipcCalls.filter(row => row.channel === 'mc-agent:interrupt').length, 0)
    assert.equal(f.composerSends().length, 1)
    // The transport refused release; no false cleared claim. The same token
    // remains releasable at the actual validated handler.
    const settled = await f.handlers.get('mc-agent:release-send-now')(f.event, releases[0].request)
    assert.equal(settled.released, true)
  })
}

test('standalone disposal preserves a dispatched unknown row until its exact accepted host receipt arrives', async t => {
  const gate = deferred()
  const f = await fixture(t, { sendGate: gate })
  f.click('composer')
  for (let i=0;i<16;i++) await tick()
  assert.equal(f.composerSends()[1], 'held person words')
  assert.equal(f.outbox.list(f.sessionId)[0]?.deliveryUnconfirmed, true)
  f.dispose()
  for (let i=0;i<3;i++) await tick()
  assert.equal(f.outbox.list(f.sessionId)[0]?.deliveryUnconfirmed, true)
  assert.equal(f.ipcCalls.filter(row => row.channel === 'mc-agent:release-send-now').length, 0,
    'disposal alone cannot claim a dispatched send was not delivered')
  gate.resolve()
  for (let i=0;i<6;i++) await tick()
  assert.deepEqual(f.outbox.list(f.sessionId), [], 'the captured accepted receipt settles custody even after the view was disposed')
  assert.equal(f.composerSends().filter(text => text === 'held person words').length, 1)
})

test('actual standalone ordinary queued text remains queued until the real turn completes, without a reservation', async t => {
  const f = await fixture(t)
  const input = f.root.querySelector('.chat-input input')
  input.value = 'ordinary queued words'
  f.root.querySelector('.chat-send').dispatch('click')
  for (let i=0;i<3;i++) await tick()
  assert.equal(f.composerSends().length, 1)
  assert.equal(f.outbox.list(f.sessionId)[0]?.text, 'ordinary queued words')
  assert.equal(f.outbox.list(f.sessionId)[0]?.deliveryUnconfirmed, undefined)
  assert.equal(f.ipcCalls.filter(row => row.channel === 'mc-agent:reserve-send-now').length, 0)
  f.complete(0)
  for (let i=0;i<8;i++) await tick()
  assert.equal(f.composerSends()[1], 'ordinary queued words')
  assert.deepEqual(f.outbox.list(f.sessionId), [])
})

test('a rejected IPC reply after dispatch preserves unknown delivery across disposal without replay or fabricated acceptance', async t => {
  const gate = deferred()
  const f = await fixture(t, { sendGate: gate })
  f.click('composer')
  for (let i=0;i<12;i++) await tick()
  assert.equal(f.composerSends()[1], 'held person words')
  f.dispose()
  gate.reject(Object.assign(new Error('unconfirmed transport reply'), { code: 'AGENT_SEND_UNKNOWN' }))
  for (let i=0;i<8;i++) await tick()
  assert.equal(f.outbox.list(f.sessionId)[0]?.deliveryUnconfirmed, true)
  assert.equal(f.composerSends().filter(text => text === 'held person words').length, 1)
  const releases = f.ipcCalls.filter(row => row.channel === 'mc-agent:release-send-now')
  assert.equal(releases.length, 1, 'the asynchronous failure settles the captured reservation callback once')
  assert.equal(releases[0].result.released, false, 'the already dispatched send consumed this token; release cannot claim otherwise')
})

test('plain standalone Halt leaves the actual idle courier boundary available without reserving', async t => {
  const f = await fixture(t)
  f.enqueuePeer()
  const halt = f.root.querySelector('.working-step button'); assert.ok(halt)
  halt.dispatch('click')
  for (let i=0;i<12;i++) await tick()
  assert.equal(f.ipcCalls.filter(row => row.channel === 'mc-agent:reserve-send-now').length, 0)
  await f.pump(200)
  assert.match(f.composerSends()[1], /NEW COURIER RESULT/)
})

test('actual idle courier with no prior completion is held by the reservation and proceeds only after its exact release', async t => {
  const f = await fixture(t)
  const id = 'idle-no-boundary'
  await f.handlers.get('mc-agent:start')(f.event, { sessionId: id })
  f.host.updateTreeAddress({ sessionId: id, selfName: 'Idle', managerName: 'Manager' })
  const recipient = directory.agentIdForSession(id)
  assert.ok(directory.listNodes().some(row => row.agentId === recipient))
  provider.deliver({ recipientAgentId: recipient, senderAgentId: directory.agentIdForSession('peer'), body: 'Worker: IDLE COURIER RESULT.' })
  const reserve = await f.handlers.get('mc-agent:reserve-send-now')(f.event, { sessionId: id })
  await f.pump()
  assert.deepEqual(f.sentTextsFor(2), [], 'no turn/completion or synthetic timestamp masks the reservation')
  const release = f.handlers.get('mc-agent:release-send-now')
  assert.equal((await release(f.event, { sessionId: id, token: reserve.token + 1 })).released, false)
  await f.pump()
  assert.deepEqual(f.sentTextsFor(2), [])
  assert.equal((await release(f.event, { sessionId: id, token: reserve.token })).released, true)
  await f.pump()
  assert.equal(f.sentTextsFor(2).length, 1)
  assert.match(f.sentTextsFor(2)[0], /IDLE COURIER RESULT/)
})

test('constant-clock host refusal revises ownership before immediate old-token release; another session cannot clear it', async t => {
  t.mock.method(Date, 'now', () => 1_700_000_000_000)
  const f = await fixture(t)
  const reserve = f.handlers.get('mc-agent:reserve-send-now')
  const release = f.handlers.get('mc-agent:release-send-now')
  const first = await reserve(f.event, { sessionId: f.sessionId })
  await assert.rejects(f.handlers.get('mc-agent:send')(f.event, { sessionId: f.sessionId, text: 'busy overlap' }), { code: 'AGENT_TURN_ACTIVE' })
  assert.equal((await release(f.event, { sessionId: f.sessionId, token: first.token })).released, false,
    'refusal must make the old token stale without a later reservation masking it')
  const peer = f.host.reserveSendNow({ sessionId: 'peer' })
  assert.equal(f.host.releaseSendNow({ sessionId: 'peer', token: first.token + 1 }).released, false)
  assert.equal((await release(f.event, { sessionId: f.sessionId, token: first.token + 1 })).released, true)
  assert.equal(f.host.releaseSendNow({ sessionId: 'peer', token: peer.token }).released, true)
})

function heldRetryClock(t) {
  const nativeSetTimeout = globalThis.setTimeout
  const nativeClearTimeout = globalThis.clearTimeout
  const pending = new Set()
  t.mock.method(globalThis, 'setTimeout', (fn, delay, ...args) => {
    if (![120, 250, 500, 1000].includes(delay)) return nativeSetTimeout(fn, delay, ...args)
    const timer = { run: () => fn(...args), delay }
    pending.add(timer)
    return timer
  })
  t.mock.method(globalThis, 'clearTimeout', timer => pending.delete(timer) || nativeClearTimeout(timer))
  return {
    pending,
    async drain() {
      for (let attempt = 0; attempt < 6 && pending.size; attempt++) {
        for (const timer of [...pending]) { pending.delete(timer); timer.run() }
        for (let i = 0; i < 8; i++) await tick()
      }
    },
  }
}

/* SCRIPTED USER FLOW (T785): use the real mounted composer on a running turn.
 * The first Send-now press is interrupted/refused, so the row is requeued. The
 * second press uses that same row and must deliver its words once. The first
 * reservation is released exactly once; the accepted second send leaves the
 * host to clear its own reservation, and teardown must not replay the words.
 */
test('scripted mounted Send now: refused first press requeues, second press delivers once with one release', async t => {
  const f = await fixture(t, { refuseStop: true })
  f.click('strip')
  for (let i = 0; i < 15; i++) await tick()

  const firstRows = f.outbox.list(f.sessionId)
  assert.equal(firstRows.length, 1, 'the refused first press returns the same message to the queue')
  assert.equal(firstRows[0].deliveryUnconfirmed, undefined, 'a refused interrupt is known-not-sent')
  assert.equal(f.composerSends().filter(text => text === 'held person words').length, 0, 'the first press does not dispatch the words')

  f.allowStop()
  const secondButton = f.root.querySelector('.chat-queue-now')
  assert.ok(secondButton, 'the requeued row remains pressable')
  secondButton.dispatch('click')
  for (let i = 0; i < 25; i++) await tick()

  const delivered = f.composerSends().filter(text => text === 'held person words')
  assert.equal(delivered.length, 1, 'the second press delivers the same words exactly once')
  assert.deepEqual(f.outbox.list(f.sessionId), [], 'the accepted host receipt settles the row')
  const reserves = f.ipcCalls.filter(row => row.channel === 'mc-agent:reserve-send-now')
  const releases = f.ipcCalls.filter(row => row.channel === 'mc-agent:release-send-now')
  assert.equal(reserves.length, 2, 'one reservation was made per real Send-now press')
  assert.equal(releases.length, 1, 'the refused first reservation is released exactly once')
  assert.equal(releases[0].request.token, reserves[0].result.token, 'release targets the refused attempt')
  assert.equal(releases[0].result.released, true, 'the refused attempt clears its live host reservation')
  assert.equal(f.ipcCalls.filter(row => row.channel === 'mc-agent:send' && row.request.text === 'held person words').length, 1,
    'no replay reaches the real send IPC')
})

for (const door of ['strip', 'composer']) {
  for (const code of ['AGENT_TURN_ACTIVE', 'CLAUDE_CLI_TURN_ACTIVE', 'AGENT_SESSION_NOT_READY']) {
    test('coded unknown: ' + door + ' ' + code + ' never retries a dispatched envelope', async t => {
      const gate = deferred()
      const f = await fixture(t, { sendGate: gate })
      const retryClock = heldRetryClock(t)
      f.click(door)
      for (let i = 0; i < 12; i++) await tick()
      assert.equal(f.composerSends().filter(text => text === 'held person words').length, 1)
      const original = f.outbox.list(f.sessionId)[0]
      assert.equal(original?.deliveryUnconfirmed, true)
      gate.reject(Object.assign(new Error('IPC outcome is unknown despite its busy code'), { code }))
      for (let i = 0; i < 8; i++) await tick()
      // Let the real accepted host turn finish, then exercise any scheduled
      // retry. Keeping the host busy would hide a duplicate from this control.
      f.complete(0)
      for (let i = 0; i < 4; i++) await tick()
      await retryClock.drain()
      assert.equal(f.composerSends().filter(text => text === 'held person words').length, 1,
        'a busy-looking unknown reply must never dispatch the same words again')
      const rows = f.outbox.list(f.sessionId)
      assert.equal(rows.length, 1)
      assert.equal(rows[0].id, original.id)
      assert.equal(rows[0].deliveryUnconfirmed, true, 'completion is not the missing send receipt')
      const releases = f.ipcCalls.filter(row => row.channel === 'mc-agent:release-send-now')
      assert.equal(releases.length, 1, 'unknown settlement attempts its captured release exactly once')
      assert.equal(releases[0].result.released, false, 'actual send already consumed the token')
      assert.equal(retryClock.pending.size, 0)
      f.dispose()
      assert.equal(f.outbox.list(f.sessionId)[0]?.deliveryUnconfirmed, true)
    })
  }

  if (door === 'composer') test('known refusal: composer retries only after actual local preflight refused without dispatch', async t => {
    const f = await fixture(t)
    const retryClock = heldRetryClock(t)
    let interposed = null
    // At the in-memory persistence boundary for the held row, another real
    // controller send occupies the just-freed session. The held sender then
    // meets the shipping local busy preflight before its bridge.send call.
    f.setOnHeldTake(() => { interposed = f.controller().send('interposed actual turn') })
    // The inert transport defers the real activity read until the interposed
    // controller send lands; the busy answer still comes from the real host.
    f.setBeforeActivity(() => interposed)
    f.click(door)
    for (let i = 0; i < 12; i++) await tick()
    assert.ok(interposed, 'the held row must actually be taken')
    const interposedResult = await interposed
    assert.equal(interposedResult.deliveryDisposition, 'accepted', JSON.stringify(interposedResult))
    assert.equal(f.composerSends().filter(text => text === 'interposed actual turn').length, 1)
    assert.equal(f.composerSends().filter(text => text === 'held person words').length, 0)
    assert.equal(f.ipcCalls.filter(row => row.channel === 'mc-agent:send' && row.request.text === 'held person words').length, 0,
      'the refused attempt never reached the transport')
    assert.equal(retryClock.pending.size, 1, 'positive not-sent busy refusal retains the bounded retry')
    f.complete(0)
    for (let i = 0; i < 4; i++) await tick()
    await retryClock.drain()
    assert.equal(f.composerSends().filter(text => text === 'held person words').length, 1)
    assert.equal(f.ipcCalls.filter(row => row.channel === 'mc-agent:send' && row.request.text === 'held person words').length, 1)
    assert.deepEqual(f.outbox.list(f.sessionId), [], 'only the positive host receipt confirms the original held row')
    assert.equal(retryClock.pending.size, 0)
  })
}

for (const code of ['AGENT_TURN_ACTIVE', 'CLAUDE_CLI_TURN_ACTIVE', 'AGENT_SESSION_NOT_READY']) {
  test('coded unknown disposal: composer ' + code + ' retains uncertainty before any retry timer can run', async t => {
    const gate = deferred()
    const f = await fixture(t, { sendGate: gate })
    const retryClock = heldRetryClock(t)
    f.click('composer')
    for (let i = 0; i < 12; i++) await tick()
    assert.equal(f.composerSends().filter(text => text === 'held person words').length, 1)
    const original = f.outbox.list(f.sessionId)[0]
    assert.equal(original?.deliveryUnconfirmed, true)
    gate.reject(Object.assign(new Error('unknown transport outcome carrying a busy code'), { code }))
    for (let i = 0; i < 8; i++) await tick()
    assert.equal(f.outbox.list(f.sessionId)[0]?.deliveryUnconfirmed, true)
    // Dispose in the exact gap after the coded rejection and before a
    // previously scheduled retry. Teardown cannot convert unknown to unsent.
    f.dispose()
    const retained = f.outbox.list(f.sessionId)
    assert.equal(retained.length, 1)
    assert.equal(retained[0].id, original.id)
    assert.equal(retained[0].deliveryUnconfirmed, true,
      'disposal must preserve the uncertainty of an already dispatched envelope')
    f.complete(0)
    for (let i = 0; i < 4; i++) await tick()
    await retryClock.drain()
    assert.equal(f.composerSends().filter(text => text === 'held person words').length, 1)
    assert.equal(f.outbox.list(f.sessionId)[0]?.deliveryUnconfirmed, true)
    assert.equal(retryClock.pending.size, 0)
    const releases = f.ipcCalls.filter(row => row.channel === 'mc-agent:release-send-now')
    assert.equal(releases.length, 1, 'disposal cannot erase or duplicate the captured release')
    assert.equal(releases[0].result.released, false, 'the dispatched send already consumed this token')
  })
}
