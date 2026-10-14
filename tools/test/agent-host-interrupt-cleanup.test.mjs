import { canonicalRootForTests } from '../canonical-root.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAgentHost } from '../../shell/agent-host.cjs'
const require = createRequire(import.meta.url)
const enginePath = path.resolve(import.meta.dirname, 'fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const engine = require(enginePath)
const deferred = () => Promise.withResolvers()
const tick = () => new Promise(resolve => setImmediate(resolve))
const capture = promise => promise.then(value => ({ value }), error => ({ error }))

function fixture(t, { cancel, resume, interrupt, send, legacy = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'te-interrupt-cleanup-'))
  const entries = new Map(), cancellations = [], resumptions = [], interruptions = [], closed = [], revoked = []
  let startingId
  t.mock.method(engine, 'startCodexSession', async options => {
    const sessionId = startingId
    let number = 0
    const entry = { options, sendCount: 0 }
    entries.set(sessionId, entry)
    return { threadId: `thread-${sessionId}`, close() { closed.push(sessionId) }, adapter: {
      sendTurn(request) { entry.sendCount++; const turnId = `turn-${++number}`; return send ? send(entry, { ...request, turnId }) : Promise.resolve({ turnId }) },
      interrupt(value) { interruptions.push(sessionId); return interrupt?.(entry, value) },
      answerApproval() {},
      forkThread: () => ({ threadId: 'fork' }),
    } }
  })
  const host = createAgentHost({ enginePath, defaultCwd: root, profileRoot: path.parse(root).root,
    freeMemory: () => 64 * 1024 ** 3,
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
    sessionAuthority: {
      bind: value => ({ bound: true, credential: Buffer.from(value.sessionId.padEnd(32, 'x')).toString('base64url') }),
      revoke: value => { revoked.push(value.sessionId) }, assert: () => ({ valid: true }),
      ...(!legacy ? { cancelVersion: 2,
        cancelWork: value => { cancellations.push(value); return cancel?.(value) },
        resumeWork: value => { resumptions.push(value); return resume?.(value) },
      } : {}),
    },
  })
  t.after(async () => { await host.closeAll(); if (process.env.TOOLSENABLED_TEST_RETAIN_FIXTURES === '1') console.log('RETAINED_INTERRUPT_FIXTURE ' + root); else rmSync(root, { recursive: true, force: true }) })
  const open = async sessionId => { startingId = sessionId; await host.startSession({ sessionId }); return entries.get(sessionId) }
  const start = async sessionId => { const entry = await open(sessionId); await host.sendTurn({ sessionId, text: 'work' }); return entry }
  const complete = (sessionId, turnId = 'turn-1') => entries.get(sessionId).options.onEvent({ type: 'turn_completed', turnId, status: 'interrupted' })
  return { host, open, start, complete, entries, cancellations, resumptions, interruptions, closed, revoked }
}

test('Stop waits for both model interruption and command cleanup, isolating another session', async t => {
  const model = deferred(), work = deferred()
  const f = fixture(t, { cancel: () => work.promise, interrupt: () => model.promise })
  await f.start('mine'); await f.start('other')
  let answered = false
  const stopped = f.host.interrupt({ sessionId: 'mine' }).then(value => { answered = true; return value })
  try {
    await tick()
    assert.deepEqual(f.interruptions, ['mine']); assert.deepEqual(f.cancellations.map(v => v.sessionId), ['mine'])
    assert.ok(f.cancellations[0].credential, 'uses the retained exact credential')
    f.complete('mine'); model.resolve(); await tick()
    assert.equal(answered, false)
    assert.equal(f.host.sessionActivity('mine').busy, true, 'terminal event cannot hide pending cleanup')
    await assert.rejects(f.host.sendTurn({ sessionId: 'mine', text: 'too early' }), { code: 'AGENT_TURN_ACTIVE' })
    await assert.rejects(f.host.rewindSession({ sessionId: 'mine', turnId: 'turn-1' }), { code: 'AGENT_TURN_ACTIVE' })
    assert.equal(f.host.sessionActivity('other').busy, true)
    work.resolve(); assert.deepEqual(await stopped, { sessionId: 'mine', turnId: 'turn-1' })
    assert.equal(f.host.sessionActivity('mine').busy, false)
    await f.host.sendTurn({ sessionId: 'mine', text: 'next turn' })
    assert.deepEqual(f.resumptions.map(v => v.sessionId), ['mine'])
    assert.deepEqual(f.revoked, []); assert.deepEqual(f.closed, [])
  } finally { model.resolve(); work.resolve(); await stopped }
})

test('Stop also waits for the provider when command cleanup finishes first', async t => {
  const model = deferred()
  const f = fixture(t, { interrupt: () => model.promise })
  await f.start('model-wait')
  let answered = false
  const stopped = f.host.interrupt({ sessionId: 'model-wait' }).then(() => { answered = true })
  await tick(); assert.equal(answered, false)
  f.complete('model-wait'); model.resolve(); await stopped
})

test('cleanup refusal retains Stop across the terminal event and retries without re-interrupting', async t => {
  let attempts = 0
  const f = fixture(t, { cancel() { if (++attempts === 1) throw Object.assign(new Error('cleanup unproven'), { code: 'OWNER_HOST_SESSION_CLEANUP_FAILED' }) } })
  await f.start('retry')
  const stopped = capture(f.host.interrupt({ sessionId: 'retry' })); await tick(); f.complete('retry')
  assert.equal((await stopped).error.code, 'AGENT_STOP_PENDING')
  assert.equal(f.host.sessionActivity('retry').busy, true)
  await assert.rejects(f.host.sendTurn({ sessionId: 'retry', text: 'refused' }), { code: 'AGENT_TURN_ACTIVE' })
  assert.deepEqual(await f.host.interrupt({ sessionId: 'retry' }), { sessionId: 'retry', turnId: 'turn-1' })
  assert.equal(attempts, 2); assert.deepEqual(f.interruptions, ['retry'])
  await f.host.sendTurn({ sessionId: 'retry', text: 'recovered' })
  assert.equal(f.entries.get('retry').sendCount, 2)
})

test('concurrent Stop clicks share one provider interruption and cleanup', async t => {
  const work = deferred(), f = fixture(t, { cancel: () => work.promise })
  await f.start('shared')
  const first = f.host.interrupt({ sessionId: 'shared' }), second = f.host.interrupt({ sessionId: 'shared' })
  await tick(); assert.equal(f.cancellations.length, 1); assert.equal(f.interruptions.length, 1)
  f.complete('shared'); work.resolve(); assert.deepEqual(await first, await second)
})

test('a failed tool-lane resume never sends a replacement turn', async t => {
  const f = fixture(t, { resume() { throw Object.assign(new Error('still held'), { code: 'OWNER_HOST_SESSION_CLEANUP_FAILED' }) } })
  await f.start('held'); await f.host.interrupt({ sessionId: 'held' }); f.complete('held')
  await assert.rejects(f.host.sendTurn({ sessionId: 'held', text: 'new work' }), { code: 'OWNER_HOST_SESSION_CLEANUP_FAILED' })
  assert.equal(f.entries.get('held').sendCount, 1)
})

test('a provider that must resume is retired only after its commands finish', async t => {
  const work = deferred(), f = fixture(t, { interrupt: () => ({ requiresResume: true }), cancel: () => work.promise })
  await f.start('retire')
  const stopped = f.host.interrupt({ sessionId: 'retire' }); await tick()
  await assert.rejects(f.host.sendTurn({ sessionId: 'retire', text: 'too soon' }), { code: 'AGENT_TURN_ACTIVE' })
  work.resolve(); assert.equal((await stopped).requiresResume, true)
  await assert.rejects(f.host.sendTurn({ sessionId: 'retire', text: 'needs resume' }), { code: 'AGENT_SESSION_ENDED' })
})

test('older owned engines fall back to closing and revoking instead of acknowledging model-only Stop', async t => {
  const f = fixture(t, { legacy: true }); await f.start('legacy')
  assert.equal((await f.host.interrupt({ sessionId: 'legacy' })).requiresResume, true)
  assert.deepEqual(f.revoked, ['legacy']); assert.deepEqual(f.closed, ['legacy'])
})

for (const mode of ['announced-receipt', 'pending-receipt']) test('T489 busy Send now reaches interrupt before first output: ' + mode, async t => {
  const { ClaudeCliAdapter } = require(path.join(canonicalRootForTests(), 'src/lib/agent-engine/claude-cli-adapter.js'))
  const claudeEngine = require('./fixtures/confined-engine/src/lib/agent-engine/claude-cli-process.js')
  const root = mkdtempSync(path.join(os.tmpdir(), 'te-busy-admission-'))
  const threadId = '91e7b7eb-bb57-4b28-b08e-2ca887fb043b'
  const wire = [], cancellations = []
  let inbound, adapter
  const receive = packet => inbound(packet)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const transport = { onData: listener => { inbound = listener }, close() {}, send: packet => {
    wire.push(packet)
    if (packet.type === 'control_request' && packet.request?.subtype === 'interrupt') queueMicrotask(() => {
      receive({ type: 'control_response', response: { subtype: 'success', request_id: packet.request_id } })
      receive({ type: 'result', subtype: 'success', result: '', is_error: false })
    })
  } }
  t.mock.method(claudeEngine, 'startClaudeSession', async options => {
    adapter = new ClaudeCliAdapter({ transport, turnTimeoutMs: 60_000 })
    adapter.threadId = threadId
    adapter.onEvent(options.onEvent)
    return { threadId, adapter, close: () => adapter.close() }
  })
  const host = createAgentHost({ enginePath, defaultCwd: root, profileRoot: path.parse(root).root,
    freeMemory: () => 64 * 1024 ** 3,
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
    sessionAuthority: {
      bind: value => ({ bound: true, credential: Buffer.from(value.sessionId.padEnd(32, 'x')).toString('base64url') }),
      revoke() {}, assert: () => ({ valid: true }), cancelVersion: 2,
      cancelWork: value => { cancellations.push(value.sessionId) }, resumeWork() {},
    },
  })
  const sessionId = 'busy-before-output'
  let sending, stopping
  try {
    await host.startSession({ sessionId, tier: 'claude-sonnet' })
    const first = host.sendTurn({ sessionId, text: 'Previous turn.' })
    receive({ type: 'system', subtype: 'init', session_id: threadId })
    receive({ type: 'result', subtype: 'success', result: '', is_error: false })
    await first
    sending = host.sendTurn({ sessionId, text: 'Current busy turn.' })
    assert.ok(adapter.activeTurn, 'the shipping adapter has already installed and written this turn')
    const say = () => receive({ type: 'assistant', message: { content: [{ type: 'text', text: 'FIRST_OUTPUT' }] } })
    if (mode === 'announced-receipt') { say(); await sending }
    let settled = false
    stopping = host.interrupt({ sessionId }).then(value => { settled = true; return value })
    await tick()
    t.mock.timers.tick(2751)
    await tick()
    const blocked = { mode, simulatedMsAfterStop: 2751, inputWrites: wire.filter(x => x.type === 'user').length,
      interruptWrites: wire.filter(x => x.request?.subtype === 'interrupt').length,
      authorityCancelCalls: cancellations.length, stopSettled: settled, adapterTurnActive: Boolean(adapter.activeTurn),
      hostBusy: host.sessionActivity(sessionId).busy }
    // Release the controlled provider silence before asserting. This proves the
    // wait's location and leaves no unresolved stop, send, timer or adapter.
    if (mode === 'pending-receipt') say()
    await sending; await stopping
    assert.equal(wire.filter(x => x.request?.subtype === 'interrupt').length, 1)
    assert.equal(cancellations.length, 1)
    console.log('T489_BUSY_ADMISSION ' + JSON.stringify(blocked))
    assert.equal(blocked.interruptWrites, 1, 'Host must dispatch Stop for an adapter-owned busy turn before waiting for its first response')
  } finally {
    adapter?.close()
    await Promise.allSettled([sending, stopping].filter(Boolean))
    await host.closeAll()
    console.log('RETAINED_BUSY_ADMISSION ' + root)
  }
})

async function pendingAdapterFixture(t, { family = 'claude', cancel = () => {}, resume = () => {} } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'te-pending-stop-'))
  const engineRoot = path.join(canonicalRootForTests(), 'src/lib/agent-engine')
  const wire = [], accepted = [], cancellations = []
  let receive, adapter, releaseLocal, localSignal
  let threadId = 'a51a39b6-7fb2-4f35-801a-1ff8f5b9c9b9'
  t.mock.timers.enable({ apis: ['setTimeout'] })
  if (family === 'claude') {
    const { ClaudeCliAdapter } = require(path.join(engineRoot, 'claude-cli-adapter.js'))
    adapter = new ClaudeCliAdapter({ turnTimeoutMs: 60_000, transport: {
      send: value => wire.push(value), onData: fn => { receive = fn }, close() {},
    } })
    adapter.threadId = threadId
  } else if (family === 'local') {
    const { LocalNodeAdapter } = require(path.join(engineRoot, 'local-node-adapter.js'))
    adapter = new LocalNodeAdapter({ model: 'fixture:tiny', turnTimeoutMs: 60_000, transport: {
      chat: (value, options) => { wire.push(value); localSignal = options.signal; return new Promise(resolve => { releaseLocal = resolve }) },
    } })
    threadId = (await adapter.startThread()).threadId
  } else {
    const readers = new Set()
    receive = value => { for (const fn of readers) fn(JSON.stringify({ ...(family === 'acp' ? { jsonrpc: '2.0' } : {}), ...value }) + '\n') }
    const transport = { onData: fn => { readers.add(fn); return () => readers.delete(fn) }, write: line => {
      const value = JSON.parse(line); wire.push(value)
      if (value.method === 'initialize') queueMicrotask(() => receive({ id: value.id, result: family === 'acp'
        ? { protocolVersion: 1, agentCapabilities: {}, authMethods: [] }
        : { userAgent: 'fixture', codexHome: root, platformFamily: 'unix', platformOs: 'linux' } }))
    } }
    if (family === 'acp') {
      const { AcpAdapter } = require(path.join(engineRoot, 'acp-adapter.js'))
      adapter = new AcpAdapter({ transport })
    } else {
      const { CodexAdapter, CODEX_CLI_VERSION } = require(path.join(engineRoot, 'codex-adapter.js'))
      adapter = new CodexAdapter({ transport, codexVersion: CODEX_CLI_VERSION })
    }
    await adapter.initialize()
  }
  t.mock.method(engine, 'startCodexSession', async options => {
    adapter.onEvent(options.onEvent)
    return { threadId, adapter, close: () => adapter.close() }
  })
  const host = createAgentHost({ enginePath, defaultCwd: root, profileRoot: path.parse(root).root,
    freeMemory: () => 64 * 1024 ** 3,
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
    sessionAuthority: { bind: value => ({ bound: true, credential: Buffer.from(value.sessionId.padEnd(32, 'x')).toString('base64url') }),
      revoke() {}, assert: () => ({ valid: true }), cancelVersion: 2,
      cancelWork: value => { cancellations.push(value.sessionId); return cancel(value) }, resumeWork: resume },
  })
  host.onAcceptedPrompt(value => accepted.push(value))
  const sessionId = 'pending-' + family
  await host.startSession({ sessionId })
  const pending = []
  t.after(async () => { releaseLocal?.(); adapter.close(); await host.closeAll(); await Promise.allSettled(pending); console.log('RETAINED_PENDING_STOP ' + root) })
  const track = promise => { const held = capture(promise); pending.push(held); return held }
  const sends = () => wire.filter(x => x.type === 'user' || x.method === 'session/prompt' || x.method === 'turn/start' || x.model)
  const controls = () => wire.filter(x => x.request?.subtype === 'interrupt' || x.method === 'session/cancel' || x.method === 'turn/interrupt')
  return { host, adapter, sessionId, threadId, wire, accepted, cancellations, track, sends, controls,
    receive: value => receive(value), releaseLocal: () => releaseLocal?.(), localAborted: () => localSignal?.aborted,
    send: () => track(host.sendTurnTracked({ sessionId, text: 'EXACT_BUSY_INTENT', origin: 'person' })),
    stop: () => track(host.interrupt({ sessionId })),
    complete: () => family === 'claude' ? receive({ type: 'result', subtype: 'success' })
      : family === 'acp' ? receive({ id: sends().at(-1).id, result: { stopReason: 'cancelled' } })
      : family === 'local' ? releaseLocal()
      : receive({ method: 'turn/completed', params: { threadId, turn: { id: 'native-turn', status: 'interrupted' } } }),
    ack: subtype => { const call = controls().at(-1); receive(family === 'claude'
      ? { type: 'control_response', response: { request_id: call.request_id, ...(subtype ? { subtype } : {}) } }
      : { id: call.id, result: {} }) },
  }
}

for (const response of ['error', 'missing', 'unknown']) test('pre-response Claude Stop preserves custody after ' + response, async t => {
  const f = await pendingAdapterFixture(t), sent = f.send(), stopped = f.stop()
  await tick()
  assert.equal(f.controls().length, 1); assert.equal(f.cancellations.length, 1)
  assert.equal(f.accepted.length, 0, 'cancellation ownership cannot invent prompt acceptance')
  if (response === 'unknown') { t.mock.timers.tick(10_001); await tick() }
  else f.ack(response === 'missing' ? null : response)
  assert.equal((await stopped).error.code, 'AGENT_STOP_PENDING')
  assert.equal(f.host.sessionActivity(f.sessionId).busy, true)
  assert.equal((await f.host.sendTurnTracked({ sessionId: f.sessionId, text: 'do not replay' })).deliveryDisposition, 'not-sent')
  f.complete(); assert.equal((await sent).value.deliveryDisposition, 'accepted', 'only actual later terminal evidence acknowledges the original send')
  assert.equal(f.host.sessionActivity(f.sessionId).busy, true, 'late result cannot release Stop custody')
  assert.ok((await f.stop()).value)
  assert.equal(f.sends().length, 1); assert.equal(f.controls().length, 1, 'late completion needs no second provider cancellation')
})

test('pre-response concurrent Stop shares cancellation and retains refused cleanup through late result', async t => {
  let attempts = 0
  const f = await pendingAdapterFixture(t, { cancel: () => { if (++attempts === 1) throw Error('cleanup refused') } })
  const sent = f.send(), first = f.stop(), second = f.stop()
  await tick(); assert.equal(f.controls().length, 1); f.ack('success')
  assert.equal((await first).error.code, 'AGENT_STOP_PENDING'); assert.equal((await second).error.code, 'AGENT_STOP_PENDING')
  f.complete(); await sent
  assert.equal(f.host.sessionActivity(f.sessionId).busy, true)
  assert.ok((await f.stop()).value); assert.equal(attempts, 2); assert.equal(f.controls().length, 1)
})

test('pre-response cancellation acknowledgement without terminal evidence stays pending and never replays', async t => {
  const f = await pendingAdapterFixture(t), sent = f.send(), stopped = f.stop()
  await tick(); f.ack('success'); await tick(); t.mock.timers.tick(2501); await tick()
  assert.equal((await stopped).error.code, 'AGENT_STOP_PENDING'); assert.equal(f.accepted.length, 0)
  assert.equal(f.host.sessionActivity(f.sessionId).busy, true)
  f.complete(); await sent; assert.ok((await f.stop()).value)
  assert.equal(f.controls().length, 1); assert.equal(f.sends().length, 1)
})

test('a dispatched pre-response send failing without a terminal receipt remains unknown', async t => {
  const f = await pendingAdapterFixture(t), sent = f.send(), stopped = f.stop()
  await tick(); f.adapter.close()
  assert.equal((await sent).value.deliveryDisposition, 'unknown')
  assert.equal((await stopped).error.code, 'AGENT_STOP_PENDING')
  assert.equal(f.accepted.length, 0); assert.equal(f.sends().length, 1)
  assert.equal(f.host.sessionActivity(f.sessionId).busy, true)
})

for (const family of ['acp', 'local', 'codex']) test('pending cancellation respects actual ' + family + ' semantics', async t => {
  const f = await pendingAdapterFixture(t, { family }), sent = f.send(), stopped = f.stop()
  await tick()
  assert.equal(f.accepted.length, 0)
  assert.equal(f.cancellations.length, 1)
  if (family === 'codex') {
    assert.equal(f.controls().length, 0, 'Codex needs a genuine provider turn ID')
    t.mock.timers.tick(2501); await tick()
    assert.equal((await stopped).error.code, 'AGENT_STOP_PENDING')
    f.receive({ id: f.sends()[0].id, result: { turn: { id: 'native-turn' } } })
    let sentResult; sent.then(value => { sentResult = value }); await tick()
    assert.ok(sentResult, 'the real Codex receipt must settle the original send')
    const retried = f.stop(); await tick(); assert.equal(f.controls().length, 1)
    f.ack(); f.complete(); let stopResult; retried.then(value => { stopResult = value }); await tick()
    assert.ok(stopResult, 'the terminal packet must settle the matching retried Stop')
    assert.ok(stopResult.value, JSON.stringify(stopResult))
  } else {
    if (family === 'acp') assert.equal(f.controls().length, 1, 'ACP cancellation is only a notification')
    else assert.equal(f.localAborted(), true, 'Local abort reaches the owned request before output')
    assert.equal(f.host.sessionActivity(f.sessionId).busy, true)
    f.complete(); let sendOutcome, stopOutcome; sent.then(v => { sendOutcome = v }); stopped.then(v => { stopOutcome = v }); await tick()
    assert.ok(sendOutcome, 'terminal receipt settles send'); assert.ok(stopOutcome?.value, 'terminal receipt and cleanup settle Stop')
  }
  assert.equal(f.sends().length, 1)
})

for (const outcome of ['success', 'refusal', 'timeout']) test('Stop holds a deferred tool-lane resume through ' + outcome, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const resume = deferred()
  const f = fixture(t, { resume: () => resume.promise,
    interrupt: (entry, request) => entry.options.onEvent({ type: 'turn_completed', turnId: request.turnId, status: 'interrupted' }) })
  await f.start('resuming'); await f.host.interrupt({ sessionId: 'resuming' })
  const sent = capture(f.host.sendTurnTracked({ sessionId: 'resuming', text: 'NEVER_DISPATCH_AFTER_STOP', images: [{ path: path.join(os.tmpdir(), 'never-dispatched.png') }] }))
  await tick()
  assert.equal(f.resumptions.length, 1)
  const stopped = capture(f.host.interrupt({ sessionId: 'resuming' }))
  let stopResult; stopped.then(value => { stopResult = value }); await tick()
  assert.equal(stopResult, undefined, 'Stop cannot complete while the captured resume can still reopen work')
  assert.equal(f.entries.get('resuming').sendCount, 1)
  assert.equal(f.cancellations.length, 1, 'the second cancellation must follow the pending resume')
  if (outcome === 'timeout') {
    t.mock.timers.tick(2501); await tick()
    assert.equal((await stopped).error.code, 'AGENT_STOP_PENDING')
    assert.equal(f.host.sessionActivity('resuming').busy, true)
  }
  if (outcome === 'refusal') resume.reject(Error('resume refused'))
  else resume.resolve()
  assert.equal((await sent).value.deliveryDisposition, 'not-sent')
  assert.equal(f.entries.get('resuming').sendCount, 1)
  if (outcome === 'timeout') assert.ok(await f.host.interrupt({ sessionId: 'resuming' }))
  else assert.ok((await stopped).value)
  assert.equal(f.cancellations.length, 2)
  assert.equal(f.host.sessionActivity('resuming').busy, false)
})

test('a late resume and Stop cannot dispatch to or cancel a replacement session', async t => {
  const resume = deferred()
  const f = fixture(t, { resume: () => resume.promise,
    interrupt: (entry, request) => entry.options.onEvent({ type: 'turn_completed', turnId: request.turnId, status: 'interrupted' }) })
  const old = await f.start('reused'); await f.host.interrupt({ sessionId: 'reused' })
  const sent = capture(f.host.sendTurnTracked({ sessionId: 'reused', text: 'old intent' })); await tick()
  const stopped = capture(f.host.interrupt({ sessionId: 'reused' })); await tick()
  await f.host.closeSession({ sessionId: 'reused' })
  const replacement = await f.start('reused')
  resume.resolve()
  assert.equal((await sent).value.deliveryDisposition, 'not-sent')
  assert.equal((await stopped).error.code, 'AGENT_STOP_PENDING')
  assert.equal(old.sendCount, 1); assert.equal(replacement.sendCount, 1)
  assert.equal(f.cancellations.length, 1); assert.equal(f.interruptions.length, 1)
  assert.equal(f.host.sessionActivity('reused').busy, true)
})

for (const family of ['claude', 'acp', 'local']) test('pending cancellation ownership rejects another ' + family + ' thread or turn', async t => {
  const f = await pendingAdapterFixture(t, { family }), sent = f.send(); await tick()
  const owned = f.adapter.pendingTurnForInterrupt({ threadId: f.threadId })
  assert.ok(owned?.turnId); assert.equal(owned.threadId, f.threadId); assert.equal(Object.isFrozen(owned), true)
  assert.equal(f.adapter.pendingTurnForInterrupt({ threadId: 'another-thread' }), null)
  await assert.rejects(f.adapter.interrupt({ threadId: 'another-thread', turnId: owned.turnId }))
  await assert.rejects(f.adapter.interrupt({ threadId: f.threadId, turnId: 'another-turn' }))
  assert.equal(f.controls().length, 0); assert.notEqual(f.localAborted(), true)
  assert.equal(f.accepted.length, 0)
  f.complete(); await sent
  assert.equal(f.adapter.pendingTurnForInterrupt({ threadId: f.threadId }), null)
})

for (const timing of ['inside sendTurn', 'immediately before Stop']) test('Stop keeps exact completion observed ' + timing, async t => {
  const receipt = deferred()
  const f = fixture(t, { send: (entry, { turnId }) => {
    if (timing === 'inside sendTurn') entry.options.onEvent({ type: 'turn_completed', turnId, status: 'completed' })
    return receipt.promise
  } })
  const entry = await f.open('early-complete')
  const sent = capture(f.host.sendTurn({ sessionId: 'early-complete', text: 'one exact intent' }))
  if (timing === 'immediately before Stop') f.complete('early-complete')
  const stopped = capture(f.host.interrupt({ sessionId: 'early-complete' }))
  receipt.resolve({ turnId: 'turn-1' })
  assert.equal((await sent).value.turnId, 'turn-1')
  const outcome = await stopped
  assert.deepEqual(outcome, { value: { sessionId: 'early-complete', turnId: 'turn-1' } }, 'a genuine completed pending send must release Stop')
  assert.equal(f.cancellations.length, 1); assert.equal(f.interruptions.length, 0)
  assert.equal(entry.sendCount, 1); assert.equal(f.host.sessionActivity('early-complete').busy, false)
})

for (const completion of ['wrong-turn', 'unknown']) test('Stop excludes ' + completion + ' completion observed before admission settles', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(t, { send: (entry, { turnId }) => {
    if (completion === 'wrong-turn') entry.options.onEvent({ type: 'assistant_text_delta', turnId, text: 'actual turn' })
    entry.options.onEvent({ type: 'turn_completed', ...(completion === 'wrong-turn' ? { turnId: 'another-turn' } : {}), status: 'completed' })
    return Promise.resolve({ turnId })
  } })
  const entry = await f.open('unconfirmed-complete')
  const sent = capture(f.host.sendTurn({ sessionId: 'unconfirmed-complete', text: 'do not replay' }))
  const stopped = capture(f.host.interrupt({ sessionId: 'unconfirmed-complete' }))
  await tick(); t.mock.timers.tick(2501); await tick()
  assert.equal((await sent).value.turnId, 'turn-1')
  assert.equal((await stopped).error.code, 'AGENT_STOP_PENDING')
  assert.equal(f.host.sessionActivity('unconfirmed-complete').busy, true)
  assert.equal(entry.sendCount, 1); assert.equal(f.cancellations.length, 1)
  f.complete('unconfirmed-complete'); assert.ok(await f.host.interrupt({ sessionId: 'unconfirmed-complete' }))
  assert.equal(entry.sendCount, 1); assert.equal(f.host.sessionActivity('unconfirmed-complete').busy, false)
})
