import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
const require = createRequire(import.meta.url)
const { createRemoteDesktopSessions, MAX_RESPONSE_BYTES } = require('../../shell/remote-desktop-sessions.cjs')
const { createNodeTranscriptStore } = require('../../shell/node-transcript-store.cjs')
const { createNodeTranscriptCapture } = require('../../shell/node-transcript-capture.cjs')
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const code = expected => error => error.code === expected

function setup(overrides = {}) {
  const owner = {}, window = {}, state = { generation: 0, enrolled: true, mayWrite: true, owner,
    claim: { connected: true, deviceId: 'device-current', pairId: 'pair-current' } }
  const sessions = new Map([['desktop-1', { owner: window, ownerKind: 'window', pairingOwner: owner,
    agentId: 'worker', treeNodeId: 'node-1', desktopName: 'My worker', state: 'ready', tier: 'luna',
    turnsCompleted: 2, lastTurnStatus: 'completed', cwd: '/private/place', metricsPrincipal: { secret: 'private' } }]])
  const sent = [], remote = [], local = [], reads = [], recorded = []
  const host = {
    sessionTranscriptMetadata: () => ({ provider: 'codex', account: 'private account', threadId: 'private native id' }),
    sessionActivity: () => ({ busy: false }),
    sendTurn: async request => { sent.push(request); return { ok: true, turnId: 'turn-3' } },
  }
  const deps = {
    sessions, host: () => host,
    currentPrincipal: () => ({ kind: 'relay', owner: state.owner, mayWrite: state.mayWrite }),
    connectionTicket: () => state.generation,
    connectionContinues: ticket => state.enrolled && ticket === state.generation,
    deviceStatus: async () => ({ ...state.claim }),
    bindingFor: sessionId => sessions.has(sessionId) ? { computerId: 'computer', nodeId: sessions.get(sessionId).treeNodeId } : null,
    readTranscript: async request => { reads.push(request); return { entries: [
      { id: 'you:desktop-1:turn-2', who: 'you', text: 'Earlier desktop message', turnStamp: 'turn-2', at: 123,
        recoveryFiles: ['/private/recovery'], credentials: { token: 'private token' } },
      { id: 'agent:desktop-1:turn-2', who: 'agent', text: 'Earlier reply', at: 124 },
    ], before: null } },
    recordSend: async value => recorded.push(value),
    emitRemote: value => remote.push(value), emitWindow: value => local.push(value), ...overrides,
  }
  const controller = createRemoteDesktopSessions(deps)
  const principal = () => ({ kind: 'relay', owner: state.owner, mayWrite: state.mayWrite })
  return { controller, deps, state, sessions, host, sent, remote, local, reads, recorded, principal }
}

test('paired owner lists actual window sessions with an explicit metadata allowlist', async () => {
  const f = setup()
  f.sessions.set('browser-owned', { ...f.sessions.get('desktop-1'), ownerKind: 'relay' })
  f.sessions.set('ended', { ...f.sessions.get('desktop-1'), ended: true })
  const result = await f.controller.list(f.principal())
  assert.equal(result.sessions.length, 1)
  assert.deepEqual(Object.keys(result.sessions[0]).sort(), [
    'sessionId', 'agentId', 'nodeId', 'name', 'provider', 'tier', 'busy', 'turnsCompleted',
    'lastTurnStatus', 'transcript', 'openable', 'refusal',
  ].sort())
  assert.equal(result.sessions[0].sessionId, 'desktop-1')
  assert.equal(result.sessions[0].openable, true)
  assert.doesNotMatch(JSON.stringify(result), /private|credentials|owner|cwd|threadId/)
})

for (const [label, change, expected] of [
  ['wrong principal kind', f => ({ ...f.principal(), kind: 'window' }), 'MC_AGENT_PRINCIPAL_INVALID'],
  ['stale relay owner', f => ({ ...f.principal(), owner: {} }), 'MC_AGENT_CONNECTION_CLOSED'],
  ['disconnected claim', f => { f.state.claim.connected = false; return f.principal() }, 'MC_AGENT_CONNECTION_CLOSED'],
  ['unenrolled computer', f => { f.state.enrolled = false; return f.principal() }, 'MC_AGENT_CONNECTION_CLOSED'],
]) test(`${label} cannot list, read or send desktop conversations`, async () => {
  const f = setup(), principal = change(f)
  await assert.rejects(f.controller.list(principal), code(expected))
  await assert.rejects(f.controller.transcript({ sessionId: 'desktop-1' }, principal), code(expected))
  await assert.rejects(f.controller.send({ sessionId: 'desktop-1', text: 'hello' }, principal), code(expected))
  assert.equal(f.sent.length + f.reads.length, 0)
})

for (const [kind, mutate, reason] of [
  ['previous pairing', session => { session.pairingOwner = {} }, 'MC_AGENT_REMOTE_SESSION_PREVIOUS_CONNECTION'],
  ['bounded work', session => { session.boundedWork = { private: 'not shared' } }, 'MC_AGENT_REMOTE_SESSION_BOUNDED_WORK'],
]) test(`${kind} stays listed with a reason but cannot be opened or steered`, async () => {
  const f = setup(); mutate(f.sessions.get('desktop-1'))
  const result = await f.controller.list(f.principal())
  assert.equal(result.sessions[0].openable, false)
  assert.equal(result.sessions[0].refusal, reason)
  await assert.rejects(f.controller.transcript({ sessionId: 'desktop-1' }, f.principal()), code('MC_AGENT_REMOTE_SESSION_REFUSED'))
  await assert.rejects(f.controller.send({ sessionId: 'desktop-1', text: 'hello' }, f.principal()), code('MC_AGENT_REMOTE_SESSION_REFUSED'))
  assert.equal(f.sent.length + f.reads.length, 0)
})

test('web-drive off permits owned transcript reads and refuses writes before parsing', async () => {
  const f = setup(); f.state.mayWrite = false
  const listed = await f.controller.list(f.principal())
  assert.equal(listed.mayWrite, false)
  assert.equal((await f.controller.transcript({ sessionId: 'desktop-1' }, f.principal())).entries.length, 2)
  await assert.rejects(f.controller.send(null, f.principal()), code('MC_AGENT_PRINCIPAL_READ_ONLY'))
  assert.equal(f.sent.length, 0)
})

test('canonical transcript exposes only conversation fields and arms streaming', async () => {
  const f = setup()
  const result = await f.controller.transcript({ sessionId: 'desktop-1' }, f.principal())
  assert.deepEqual(result.entries[0], { id: 'you:desktop-1:turn-2', who: 'you', text: 'Earlier desktop message',
    at: 123, turnId: 'turn-2', context: null, clipped: false })
  assert.doesNotMatch(JSON.stringify(result), /private|recoveryFiles|credentials/)
  const packet = { sessionId: 'desktop-1', event: { type: 'assistant_text_delta', text: 'live reply' } }
  assert.equal(f.controller.forward(packet), true)
  assert.deepEqual(f.remote, [packet])
  assert.equal(f.sessions.get('desktop-1').ownerKind, 'window')
})

test('unbound single-agent sessions open with empty history and still accept messages', async () => {
  const f = setup({ bindingFor: () => null })
  const result = await f.controller.transcript({ sessionId: 'desktop-1' }, f.principal())
  assert.equal(result.bound, false); assert.deepEqual(result.entries, [])
  assert.equal((await f.controller.send({ sessionId: 'desktop-1', text: 'hello' }, f.principal())).turnId, 'turn-3')
})

test('connection change while reading the claim discards the request before any transcript read', async () => {
  const waiting = deferred(), f = setup({ deviceStatus: () => waiting.promise })
  const pending = f.controller.transcript({ sessionId: 'desktop-1' }, f.principal())
  f.state.generation++
  waiting.resolve(f.state.claim)
  await assert.rejects(pending, code('MC_AGENT_CONNECTION_CLOSED'))
  assert.equal(f.reads.length, 0)
})

for (const change of ['generation', 'owner', 'claim', 'session', 'consent']) test(`a ${change} change during an awaited read or admission fails closed`, async () => {
  const waiting = deferred(), entered = deferred()
  const f = setup({ readTranscript: async () => { entered.resolve(); return waiting.promise } })
  const pending = f.controller.transcript({ sessionId: 'desktop-1' }, f.principal())
  await entered.promise
  if (change === 'generation') f.state.generation++
  if (change === 'owner') f.state.owner = {}
  if (change === 'claim') f.state.claim.pairId = 'different-pair'
  if (change === 'session') f.sessions.set('desktop-1', { ...f.sessions.get('desktop-1') })
  if (change === 'consent') f.state.mayWrite = false
  waiting.resolve({ entries: [], before: null })
  if (change === 'consent') assert.equal((await pending).ok, true)
  else await assert.rejects(pending, code(change === 'session' ? 'MC_AGENT_REMOTE_SESSION_REFUSED' : 'MC_AGENT_CONNECTION_CLOSED'))
  if (change !== 'consent') assert.equal(f.controller.forward({ sessionId: 'desktop-1', event: {} }), false)
})

test('send rechecks consent after the claim await and never starts a refused turn', async () => {
  const waiting = deferred(), f = setup({ deviceStatus: () => waiting.promise })
  const pending = f.controller.send({ sessionId: 'desktop-1', text: 'hello' }, f.principal())
  f.state.mayWrite = false; waiting.resolve(f.state.claim)
  await assert.rejects(pending, code('MC_AGENT_PRINCIPAL_READ_ONLY'))
  assert.equal(f.sent.length, 0)
})

test('accepted phone input goes to the same host session and both screens exactly once', async () => {
  const f = setup(), session = f.sessions.get('desktop-1'), originalOwner = session.owner
  f.host.sendTurn = async request => {
    f.sent.push(request)
    f.controller.acceptedPrompt({ ...request, turnId: 'turn-3' })
    assert.equal(f.local.length, 1, 'the person line arrives before reply events')
    return { ok: true, turnId: 'turn-3' }
  }
  await f.controller.send({ sessionId: 'desktop-1', text: 'From the phone' }, f.principal())
  assert.deepEqual(f.sent, [{ sessionId: 'desktop-1', text: 'From the phone', origin: 'person' }])
  assert.equal(f.local.length, 1); assert.equal(f.remote.length, 1)
  assert.equal(f.local[0].event.via, 'remote'); assert.equal(session.owner, originalOwner)
  assert.equal(session.ownerKind, 'window')
})

test('desktop input streams to the phone while scheduler prompts are not labelled as person input', async () => {
  const f = setup(); await f.controller.transcript({ sessionId: 'desktop-1' }, f.principal())
  f.controller.acceptedPrompt({ sessionId: 'desktop-1', text: 'Local words', turnId: 't', origin: 'person' })
  f.controller.acceptedPrompt({ sessionId: 'desktop-1', text: 'Scheduler', turnId: 'u', origin: 'agent' })
  assert.equal(f.remote.length, 1); assert.equal(f.remote[0].event.via, 'desktop')
  assert.equal(f.local.length, 0)
})

for (const payload of [null, {}, { sessionId: 'desktop-1', text: '' }, { sessionId: 'desktop-1', text: 'x', owner: 'window' },
  { sessionId: 'desktop-1', text: 'x', images: [] }, { sessionId: 'desktop-1', text: 'x', model: 'anything' },
  { sessionId: 'desktop-1', text: 'x'.repeat(200001) }]) test(`send refuses invalid or extra fields (${Object.keys(payload || {}).join(',')})`, async () => {
  const f = setup()
  await assert.rejects(f.controller.send(payload, f.principal()), code('MC_AGENT_INVALID_PAYLOAD'))
  assert.equal(f.sent.length, 0)
})

test('busy refusal sends no second turn and never retries', async () => {
  const f = setup(), waiting = deferred(), entered = deferred()
  f.host.sendTurn = request => { f.sent.push(request); entered.resolve(); return waiting.promise }
  const first = f.controller.send({ sessionId: 'desktop-1', text: 'first' }, f.principal())
  await entered.promise
  await assert.rejects(f.controller.send({ sessionId: 'desktop-1', text: 'second' }, f.principal()), code('AGENT_TURN_ACTIVE'))
  waiting.resolve({ ok: true, turnId: 'first-turn' }); await first
  assert.equal(f.sent.length, 1)
})

test('revocation after acceptance suppresses remote events but never misreports a delivered turn as refused', async () => {
  const f = setup(), waiting = deferred(), entered = deferred()
  f.host.sendTurn = request => { f.sent.push(request); entered.resolve(); return waiting.promise }
  const pending = f.controller.send({ sessionId: 'desktop-1', text: 'accepted' }, f.principal())
  await entered.promise; f.state.generation++
  waiting.resolve({ ok: true, turnId: 'accepted-turn' })
  assert.deepEqual(await pending, { ok: true, sessionId: 'desktop-1', turnId: 'accepted-turn' })
  assert.equal(f.sent.length, 1); assert.equal(f.remote.length, 0)
})

test('accepted sends do not depend on a second claim status lookup', async () => {
  const f = setup(); let claims = 0
  f.deps.deviceStatus = async () => ++claims === 1 ? { ...f.state.claim } : { ok: false, code: 'DEVICE_CLAIM_BUSY' }
  assert.equal((await f.controller.send({ sessionId: 'desktop-1', text: 'one message' }, f.principal())).ok, true)
  assert.equal(f.sent.length, 1); assert.equal(claims, 1)
})

for (const failure of ['throw', 'answer']) test(`a host ${failure} after its acceptance hook preserves the delivered message receipt`, async () => {
  const f = setup()
  f.host.sendTurn = async request => {
    f.sent.push(request)
    f.controller.acceptedPrompt({ ...request, turnId: 'accepted-before-stop' })
    f.sessions.delete(request.sessionId)
    if (failure === 'throw') throw Object.assign(new Error('stopped after acceptance'), { code: 'AGENT_SESSION_ENDED' })
    return { ok: false, code: 'AGENT_SESSION_ENDED' }
  }
  assert.deepEqual(await f.controller.send({ sessionId: 'desktop-1', text: 'arrived before Stop' }, f.principal()),
    { ok: true, sessionId: 'desktop-1', turnId: 'accepted-before-stop' })
  assert.equal(f.sent.length, 1)
  assert.equal(f.local.length, 1)
  assert.equal(f.remote.length, 1)
  assert.equal(f.recorded.length, 0, 'the fallback cannot write to an ended or replacement session')
})

test('an acceptance hook for a replacement session cannot confirm an old pending send', async () => {
  const f = setup()
  f.host.sendTurn = async request => {
    f.sessions.set(request.sessionId, { ...f.sessions.get(request.sessionId) })
    f.controller.acceptedPrompt({ ...request, turnId: 'replacement-turn' })
    throw Object.assign(new Error('original session gone'), { code: 'AGENT_SESSION_ENDED' })
  }
  await assert.rejects(f.controller.send({ sessionId: 'desktop-1', text: 'same words' }, f.principal()), code('AGENT_SESSION_ENDED'))
  assert.equal(f.local.length + f.remote.length + f.recorded.length, 0)
})

for (const change of ['consent', 'session']) test(`a ${change} change after acceptance preserves the success receipt`, async () => {
  const f = setup(), waiting = deferred(), entered = deferred()
  f.host.sendTurn = request => { f.sent.push(request); entered.resolve(); return waiting.promise }
  const pending = f.controller.send({ sessionId: 'desktop-1', text: 'accepted' }, f.principal())
  await entered.promise
  if (change === 'consent') f.state.mayWrite = false
  else f.sessions.set('desktop-1', { ...f.sessions.get('desktop-1') })
  waiting.resolve({ ok: true, turnId: 'accepted-turn' })
  assert.deepEqual(await pending, { ok: true, sessionId: 'desktop-1', turnId: 'accepted-turn' })
  assert.equal(f.sent.length, 1)
  if (change === 'session') {
    assert.equal(f.recorded.length, 0, 'no fallback transcript write into a replacement session')
    assert.equal(f.local.length + f.remote.length, 0, 'no person input delivered to the replacement')
  }
})

test('busy desktop sessions are refused before the host can reserve a waiting person turn', async () => {
  const f = setup(); f.host.sessionActivity = () => ({ busy: true })
  await assert.rejects(f.controller.send({ sessionId: 'desktop-1', text: 'later' }, f.principal()), code('AGENT_TURN_ACTIVE'))
  assert.equal(f.sent.length, 0)
  assert.equal(f.controller.forward({ sessionId: 'desktop-1', event: {} }), false)
})

for (const operation of ['transcript', 'send']) test(`a failed fifth ${operation} restores the evicted conversation watch`, async () => {
  const f = setup(), template = f.sessions.get('desktop-1')
  for (let i = 2; i <= 6; i++) f.sessions.set(`desktop-${i}`, { ...template })
  for (let i = 1; i <= 4; i++) await f.controller.transcript({ sessionId: `desktop-${i}` }, f.principal())
  if (operation === 'transcript') {
    f.deps.readTranscript = async () => { throw new Error('disk') }
    await assert.rejects(f.controller.transcript({ sessionId: 'desktop-5' }, f.principal()), code('MC_AGENT_TRANSCRIPT_UNAVAILABLE'))
  } else {
    f.host.sendTurn = async () => ({ ok: false, code: 'AGENT_TURN_ACTIVE' })
    await assert.rejects(f.controller.send({ sessionId: 'desktop-5', text: 'busy race' }, f.principal()), code('AGENT_TURN_ACTIVE'))
  }
  for (let i = 1; i <= 4; i++) assert.equal(f.controller.forward({ sessionId: `desktop-${i}`, event: {} }), true)
  assert.equal(f.controller.forward({ sessionId: 'desktop-5', event: {} }), false)
  f.deps.readTranscript = async () => ({ entries: [], before: null })
  await f.controller.transcript({ sessionId: 'desktop-6' }, f.principal())
  assert.equal(f.controller.forward({ sessionId: 'desktop-1', event: {} }), false, 'rollback preserves the evicted watch as oldest')
  assert.equal(f.controller.forward({ sessionId: 'desktop-2', event: {} }), true)
})

test('a thrown host refusal rolls back its watch while preserving an already-open conversation', async () => {
  const f = setup()
  f.host.sendTurn = async () => { throw Object.assign(new Error('busy'), { code: 'AGENT_TURN_ACTIVE' }) }
  await assert.rejects(f.controller.send({ sessionId: 'desktop-1', text: 'busy race' }, f.principal()), code('AGENT_TURN_ACTIVE'))
  assert.equal(f.controller.forward({ sessionId: 'desktop-1', event: {} }), false)
  await f.controller.transcript({ sessionId: 'desktop-1' }, f.principal())
  await assert.rejects(f.controller.send({ sessionId: 'desktop-1', text: 'busy race' }, f.principal()), code('AGENT_TURN_ACTIVE'))
  assert.equal(f.controller.forward({ sessionId: 'desktop-1', event: {} }), true)
})

test('overlapping watch admission keeps the newer watch and close prevents rollback resurrection', async () => {
  const f = setup(), waiting = deferred(), entered = deferred()
  const read = f.deps.readTranscript
  f.deps.readTranscript = async () => { entered.resolve(); return waiting.promise }
  const first = f.controller.transcript({ sessionId: 'desktop-1' }, f.principal())
  await entered.promise
  f.deps.readTranscript = read
  await f.controller.transcript({ sessionId: 'desktop-1' }, f.principal())
  waiting.resolve({ entries: null })
  await assert.rejects(first)
  assert.equal(f.controller.forward({ sessionId: 'desktop-1', event: {} }), true)

  const hold = deferred(), started = deferred(), template = f.sessions.get('desktop-1')
  for (let i = 2; i <= 5; i++) f.sessions.set(`desktop-${i}`, { ...template })
  for (let i = 2; i <= 4; i++) await f.controller.transcript({ sessionId: `desktop-${i}` }, f.principal())
  f.deps.readTranscript = async () => { started.resolve(); return hold.promise }
  const fifth = f.controller.transcript({ sessionId: 'desktop-5' }, f.principal())
  await started.promise; f.controller.close(); hold.resolve({ entries: [], before: null })
  await assert.rejects(fifth, code('MC_AGENT_CONNECTION_CLOSED'))
  for (let i = 1; i <= 5; i++) assert.equal(f.controller.forward({ sessionId: `desktop-${i}`, event: {} }), false)
})

test('starting and ended sessions have distinct refusal codes and random person stamps are not turn ids', async () => {
  const f = setup(), session = f.sessions.get('desktop-1')
  session.state = 'starting'
  await assert.rejects(f.controller.transcript({ sessionId: 'desktop-1' }, f.principal()), code('MC_AGENT_REMOTE_SESSION_REFUSED'))
  session.ended = true
  await assert.rejects(f.controller.send({ sessionId: 'desktop-1', text: 'x' }, f.principal()), code('MC_AGENT_SESSION_ENDED'))
  session.ended = false; session.state = 'ready'
  f.deps.readTranscript = async () => ({ entries: [{ id: 'you:desktop-1:random-uuid', who: 'you', text: 'no turn id' }], before: null })
  assert.equal((await f.controller.transcript({ sessionId: 'desktop-1' }, f.principal())).entries[0].turnId, null)
})

test('watch fan-out is bounded to four sessions and closes on terminal events, revocation and facade close', async () => {
  const f = setup(), template = f.sessions.get('desktop-1')
  for (let i = 2; i <= 5; i++) f.sessions.set(`desktop-${i}`, { ...template })
  for (let i = 1; i <= 5; i++) await f.controller.transcript({ sessionId: `desktop-${i}` }, f.principal())
  assert.equal(f.controller.forward({ sessionId: 'desktop-1', event: {} }), false)
  assert.equal(f.controller.forward({ sessionId: 'desktop-2', event: { type: 'session_ended' } }), true)
  assert.equal(f.controller.forward({ sessionId: 'desktop-2', event: {} }), false)
  f.state.generation++
  assert.equal(f.controller.forward({ sessionId: 'desktop-3', event: {} }), false)
  f.controller.close()
  assert.equal(f.controller.forward({ sessionId: 'desktop-4', event: {} }), false)
})

test('session inventory stays under both the row and response byte bounds', async () => {
  const f = setup(), template = f.sessions.get('desktop-1')
  for (let i = 2; i <= 250; i++) f.sessions.set(`desktop-${i}`, { ...template, desktopName: '\u0001'.repeat(120) })
  const answer = await f.controller.list(f.principal())
  assert.equal(answer.truncated, true); assert.ok(answer.sessions.length <= 200)
  assert.ok(Buffer.byteLength(JSON.stringify(answer)) <= MAX_RESPONSE_BYTES)
})

test('real transcript paging rejects foreign cursors and fits oversized entries without skipping older messages', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fra-desktop-transcript-'))
  const store = createNodeTranscriptStore({ directory })
  const capture = createNodeTranscriptCapture({ store })
  t.after(async () => { await capture.shutdown(); await store.shutdown(); await rm(directory, { recursive: true, force: true }) })
  capture.bind({ sessionId: 'desktop-1', computerId: 'computer', nodeId: 'node-1' })
  const binding = capture.bindingFor('desktop-1')
  await store.append({ ...binding, entries: [
    { id: 'old', who: 'you', text: 'Older message' },
    { id: 'huge', who: 'agent', text: '\u0001'.repeat(100000) },
  ] })
  const f = setup({ bindingFor: capture.bindingFor, readTranscript: async (request, assertCurrent) => {
    await capture.flushNode(request); assertCurrent(); return store.read(request)
  } })
  const page = await f.controller.transcript({ sessionId: 'desktop-1', limit: 60 }, f.principal())
  assert.equal(page.entries.length, 1); assert.equal(page.entries[0].id, 'huge')
  assert.equal(page.entries[0].clipped, true); assert.ok(page.before)
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= MAX_RESPONSE_BYTES)
  const older = await f.controller.transcript({ sessionId: 'desktop-1', before: page.before }, f.principal())
  assert.equal(older.entries[0].text, 'Older message'); assert.equal(older.before, null)
  await assert.rejects(f.controller.transcript({ sessionId: 'desktop-1', before: '0000000000009999-' + 'f'.repeat(64) + '.json' }, f.principal()), code('MC_AGENT_TRANSCRIPT_CURSOR_INVALID'))
  await assert.rejects(f.controller.transcript({ sessionId: 'desktop-1', before: '../private' }, f.principal()), code('MC_AGENT_TRANSCRIPT_CURSOR_INVALID'))
})

test('a completion during snapshot hydration is streamed and a failed snapshot releases its watch', async () => {
  const waiting = deferred(), entered = deferred()
  const f = setup({ readTranscript: async () => { entered.resolve(); return waiting.promise } })
  const pending = f.controller.transcript({ sessionId: 'desktop-1' }, f.principal())
  await entered.promise
  const packet = { sessionId: 'desktop-1', event: { type: 'turn_completed', turnId: 'turn-3' } }
  assert.equal(f.controller.forward(packet), true)
  waiting.resolve({ entries: [], before: null }); await pending
  assert.deepEqual(f.remote, [packet])
  const bad = setup({ readTranscript: async () => { throw new Error('private path must not cross') } })
  await assert.rejects(bad.controller.transcript({ sessionId: 'desktop-1' }, bad.principal()), code('MC_AGENT_TRANSCRIPT_UNAVAILABLE'))
  assert.equal(bad.controller.forward(packet), false)
})

test('unknown and relay-owned sessions refuse with the same code without reading any transcript', async () => {
  const f = setup()
  f.sessions.set('relay-owned', { ...f.sessions.get('desktop-1'), ownerKind: 'relay' })
  for (const sessionId of ['unknown', 'relay-owned']) {
    await assert.rejects(f.controller.transcript({ sessionId }, f.principal()), code('MC_AGENT_REMOTE_SESSION_REFUSED'))
    await assert.rejects(f.controller.send({ sessionId, text: 'hello' }, f.principal()), code('MC_AGENT_REMOTE_SESSION_REFUSED'))
  }
  assert.equal(f.reads.length + f.sent.length, 0)
})


test('accepted task and history context survives canonical capture and remote projection without becoming person rules', async () => {
  const rows = []
  const capture = createNodeTranscriptCapture({ store: { append: async ({ entries }) => { rows.push(...entries); return { ok: true } } } })
  capture.bind({ sessionId: 'desktop-1', computerId: 'computer', nodeId: 'node-1' })
  const kinds = ['tasks', 'history', 'tree', 'requests', 'role', 'tools', 'capabilities']
  const text = 'Exact initiating message.'
  const transcriptPrompt = { text, additions: kinds.map(kind => ({ kind, text: `${kind}: current context` })) }
  await capture.recordAcceptedTranscriptSend({ sessionId: 'desktop-1', turnId: 'first', text, origin: 'person', transcriptPrompt })
  await capture.shutdown()
  assert.equal(rows.length, 8, 'all seven host additions must survive the capture limit')
  assert.equal(rows[0].text, text)
  assert.deepEqual(rows.slice(1).map(row => row.promptKind), kinds)
  assert.ok(rows.slice(1).every(row => row.promptSource === 'toolsenabled' && row.turnStamp === 'first' && row.at === rows[0].at))
  const f = setup({ readTranscript: async () => ({ entries: rows, before: null }) })
  const page = await f.controller.transcript({ sessionId: 'desktop-1' }, f.principal())
  assert.deepEqual(page.entries.map(row => row.context), [null, ...kinds])
  assert.equal(page.entries[0].text, text)
})
