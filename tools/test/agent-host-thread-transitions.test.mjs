import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { createAgentHost } from '../../shell/agent-host.cjs'
import { testScratchRoot } from '../lib/test-scratch-root.mjs'
import { canonicalRootForTests } from '../canonical-root.mjs'

// Use the maintained offline engine's confinement/tool fixtures. Its launch
// export is replaced with a controllable adapter; no provider or child starts.
const require = createRequire(import.meta.url)
const ENGINE = fileURLToPath(new URL('./fixtures/confined-engine/src/lib/agent-engine/codex-process.js', import.meta.url))
const engine = require(ENGINE)
const capture = promise => promise.then(value => ({ value }), error => ({ error }))

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function fixture(t, overrides = {}, hostOptions = {}) {
  const scratch = testScratchRoot('.toolsenabled-thread-transitions')
  mkdirSync(scratch, { recursive: true })
  const cwd = mkdtempSync(path.join(scratch, 'run-'))
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null })
  const calls = []
  let emit
  const packets = []
  const acceptedPrompts = []
  const fork = deferred()
  const adapter = {
    transport: { child },
    sendTurn: async request => {
      calls.push({ method: 'send', request })
      return { turnId: 'turn-next' }
    },
    forkThread: (threadId, options) => {
      calls.push({ method: 'fork', threadId, options })
      return fork.promise
    },
    interrupt: async request => { calls.push({ method: 'interrupt', request }) },
    answerApproval() {},
    ...overrides,
  }
  t.mock.method(engine, 'startCodexSession', async options => {
    emit = options.onEvent
    return { threadId: 'thread-original', adapter, close() {} }
  })
  const host = createAgentHost({
    enginePath: ENGINE, defaultCwd: cwd,
    profileRoot: process.platform === 'win32' ? os.homedir() : path.parse(cwd).root,
    freeMemory: () => 64 * 1024 * 1024 * 1024,
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
    ...hostOptions,
  })
  host.onEvent(packet => packets.push(packet))
  host.onAcceptedPrompt(prompt => acceptedPrompts.push(prompt))
  t.after(async () => {
    fork.resolve({ threadId: 'thread-forked' })
    await host.closeAll()
    rmSync(cwd, { recursive: true, force: true })
  })
  await host.startSession({ sessionId: 'circle' })
  return { host, child, calls, packets, fork, acceptedPrompts, emit: event => emit(event) }
}

test('a person cloud request reaches the native adapter with its workflow and exact transcript after host acceptance', async t => {
  const f = await fixture(t)
  const text = '/cloud --workers 10 -- Check tree actions and API wiring'
  const sent = await f.host.sendTurn({ sessionId: 'circle', text, origin: 'person' })
  assert.equal(sent.turnId, 'turn-next')
  const wire = f.calls[0].request.text
  assert.ok(wire.startsWith(text + '\n\n'))
  assert.match(wire, /at most 10 cloud workers TOTAL/)
  assert.match(wire, /cloud\.account_list/)
  assert.match(wire, /Record intent BEFORE each cloud\.task_launch/)
  assert.match(wire, /cloud\.task_status/)
  assert.match(wire, /cloud\.task_diff/)
  assert.match(wire, /never blindly retry/)
  assert.match(wire, /appropriate tests after each fix/)
  const prompt = f.acceptedPrompts[0].transcriptPrompt
  assert.equal(prompt.text, text)
  assert.equal([prompt.text, ...prompt.additions.map(part => part.text)].join('\n\n'), wire)
  assert.equal(f.calls.filter(call => call.method === 'send').length, 1)
})

test('bare /cloud delegates the current objective and does not ask for setup', async t => {
  const f = await fixture(t)
  await f.host.sendTurn({ sessionId: 'circle', text: '/cloud', origin: 'person' })
  assert.match(f.calls[0].request.text, /Use the current unfinished objective/)
  assert.match(f.calls[0].request.text, /at most 5 cloud workers TOTAL/)
  assert.match(f.calls[0].request.text, /Do not route the person into a setup form/)
})

test('invalid cloud arguments never reach the adapter or acceptance spool', async t => {
  const f = await fixture(t)
  await assert.rejects(f.host.sendTurn({ sessionId: 'circle', text: '/cloud --workers 1000', origin: 'person' }),
    { code: 'AGENT_CLOUD_COMMAND_INVALID' })
  assert.deepEqual(f.calls, [])
  assert.deepEqual(f.acceptedPrompts, [])
  assert.equal(f.host.sessionActivity('circle').busy, false)
})

test('agent-origin text cannot invoke the person-only cloud workflow', async t => {
  const f = await fixture(t)
  await f.host.sendTurn({ sessionId: 'circle', text: '/cloud investigate', origin: 'agent' })
  assert.doesNotMatch(f.calls[0].request.text, /\[ToolsEnabled cloud swarm request\]/)
})

for (const origin of ['person', 'agent']) {
  test(`a pending rewind reserves the thread against ${origin} turns`, async t => {
    const f = await fixture(t)
    const rewinding = capture(f.host.rewindSession({ sessionId: 'circle', turnId: 'turn-kept' }))
    assert.equal(f.calls.length, 1, 'the fork reached the adapter')
    await assert.rejects(f.host.sendTurn({ sessionId: 'circle', text: 'new work', origin }),
      { code: 'AGENT_TURN_ACTIVE' }, 'a new turn reached the old thread while its replacement was still pending')
    assert.equal(f.host.sessionActivity('circle').busy, true, 'the courier must see the reserved thread as busy')
    assert.equal(f.calls.length, 1)
    f.fork.resolve({ threadId: 'thread-forked' })
    assert.equal((await rewinding).value?.threadId, 'thread-forked')
    const sent = await f.host.sendTurn({ sessionId: 'circle', text: 'new work', origin })
    assert.equal(sent.threadId, 'thread-forked')
    assert.equal(f.acceptedPrompts.at(-1).origin, origin, 'the acceptance hook distinguishes person input from scheduler turns')
    assert.equal(f.calls.at(-1).request.threadId, 'thread-forked')
    await f.host.interrupt({ sessionId: 'circle' })
    assert.deepEqual(f.calls.at(-1), { method: 'interrupt', request: { threadId: 'thread-forked', turnId: 'turn-next' } })
  })
}

test('two overlapping rewinds cannot replace each other out of order', async t => {
  const f = await fixture(t)
  const first = capture(f.host.rewindSession({ sessionId: 'circle', turnId: 'turn-kept' }))
  const second = capture(f.host.rewindSession({ sessionId: 'circle', turnId: 'older-turn' }))
  f.fork.resolve({ threadId: 'thread-forked' })
  assert.equal((await second).error?.code, 'AGENT_TURN_ACTIVE')
  assert.equal(f.calls.filter(call => call.method === 'fork').length, 1)
  assert.equal((await first).value?.threadId, 'thread-forked')
})

for (const synchronous of [false, true]) {
  test(`a ${synchronous ? 'synchronous' : 'delayed'} fork refusal releases the original thread`, async t => {
    const refused = Object.assign(new Error('fork refused'), { code: 'FIXTURE_FORK_REFUSED' })
    const f = await fixture(t, synchronous ? { forkThread() { throw refused } } : {})
    const rewinding = capture(f.host.rewindSession({ sessionId: 'circle', turnId: 'turn-kept' }))
    if (!synchronous) f.fork.reject(refused)
    assert.equal((await rewinding).error, refused)
    assert.equal(f.host.sessionActivity('circle').busy, false)
    const sent = await f.host.sendTurn({ sessionId: 'circle', text: 'keep working' })
    assert.equal(sent.threadId, 'thread-original')
  })
}

for (const ending of ['close', 'exit', 'replacement']) {
  for (const operation of ['rewind', 'send']) {
    test(`a late ${operation} reply after ${ending} cannot report a live operation`, async t => {
      const reply = deferred()
      const f = await fixture(t, operation === 'send' ? { sendTurn: () => reply.promise } : {})
      const pending = capture(operation === 'send'
        ? f.host.sendTurn({ sessionId: 'circle', text: 'work' })
        : f.host.rewindSession({ sessionId: 'circle', turnId: 'turn-kept' }))
      if (ending !== 'exit') await f.host.closeSession({ sessionId: 'circle' })
      else f.child.emit('exit', 1, null)
      if (ending === 'replacement') await f.host.startSession({ sessionId: 'circle' })
      assert.equal(f.acceptedPrompts.length, 0, 'a still-pending send or fork has no accepted prompt to persist')
      reply.resolve({ turnId: 'late-turn' })
      f.fork.resolve({ threadId: 'late-fork' })
      const result = await pending
      assert.equal(result.value, undefined, 'the caller was told an ended session accepted the operation')
      assert.ok(['AGENT_SESSION_UNKNOWN', 'AGENT_SESSION_ENDED', 'AGENT_SESSION_NOT_READY'].includes(result.error?.code),
        `expected a session lifecycle refusal, got ${result.error?.code}`)
      assert.equal(f.packets.filter(packet => packet.event?.type === 'session_ended').length, ending === 'exit' ? 1 : 0)
      assert.deepEqual(f.acceptedPrompts.map(({ sessionId, text, turnId }) => ({ sessionId, text, turnId })),
        operation === 'send' ? [{ sessionId: 'circle', text: 'work', turnId: 'late-turn' }] : [],
        'an accepted send must reach canonical input capture once even when the final session guard rejects its response')
      if (operation === 'send') {
        assert.equal(f.acceptedPrompts[0].transcriptPrompt.text, 'work')
        assert.ok(Object.isFrozen(f.acceptedPrompts[0].transcriptPrompt), 'capture receives the host-owned prompt snapshot')
      }
      if (ending === 'replacement') {
        assert.equal(f.host.sessionActivity('circle').busy, false)
        const sent = await f.host.sendTurn({ sessionId: 'circle', text: 'new session work' })
        assert.equal(sent.threadId, 'thread-original', 'the replacement retained its own thread')
      }
    })
  }
}


test('accepted rewinds and effort changes retain the exact next native continuation across preset changes', async t => {
  const root = canonicalRootForTests()
  assert.ok(root, 'this test needs the paired engine payload')
  const { createLedgerContinuation } = require(path.join(root, 'src/lib/agent-ledger-continuation.js'))
  const { createContinuationState } = require(path.join(root, 'src/lib/agent-continuation-state.js'))
  let enabled = true, runner, durable
  const f = await fixture(t, { updateThreadSettings: async () => {} }, {
    ledgerContinuationLoader: () => ({ createLedgerContinuation(options) {
      return (runner = createLedgerContinuation({ ...options,
        readSettings: () => ({ values: { 'agent.persistent_continuation': enabled }, provenance: { 'agent.persistent_continuation': { source: 'user' } } }),
        readTasks: () => [], stateFactory: () => (durable = createContinuationState({ file: ':memory:' })),
      }))
    } }),
  })
  // Built-in roles use revision zero in the real role library and start parser.
  // Persist their exact binding through the paired engine, including Stop while
  // the continuation preset is off.
  f.host.rememberContinuation('circle', { tier: 'luna', roleBinding: {
    id: 'manager', agentId: 'circle', expectedOrgRevision: 0, expectedRoleRevision: 0,
  } })
  assert.equal(durable.list().length, 1, 'the paired engine must accept the app built-in role binding')
  assert.equal(durable.list()[0].descriptor.resumeThreadId, 'thread-original')
  const rewind = f.host.rewindSession({ sessionId: 'circle', turnId: 'kept' })
  f.fork.resolve({ threadId: 'thread-forked' }); await rewind
  assert.equal(durable.list()[0].descriptor.resumeThreadId, 'thread-forked')
  enabled = false
  await f.host.setSessionEffort({ sessionId: 'circle', effort: 'high' })
  assert.notEqual(durable.list()[0].descriptor.effort, 'high')
  enabled = true; runner.tick()
  assert.equal(durable.list()[0].descriptor.effort, 'high', 're-enabling persistence records the last accepted effort')
  enabled = false
  await f.host.closeSession({ sessionId: 'circle' })
  assert.equal(durable.list()[0].status, 'stopped', 'a built-in role must never prevent the owner stopping the native session')
});


for (const synchronous of [false, true]) test(`one ${synchronous ? 'synchronous' : 'asynchronous'} native pre-accept refusal owns exactly one continuation outcome`, async t => {
  const root = canonicalRootForTests()
  assert.ok(root, 'this test needs the paired engine payload')
  const { createLedgerContinuation } = require(path.join(root, 'src/lib/agent-ledger-continuation.js'))
  const { createContinuationState, DEFAULT_BASE_DELAY_MS } = require(path.join(root, 'src/lib/agent-continuation-state.js'))
  let time = 100000, runner, durable, sends = 0, f
  const changed = [], pauses = []
  t.mock.method(Date, 'now', () => time)
  f = await fixture(t, { sendTurn(request) {
    sends += 1
    if (sends === 2) {
      const error = Object.assign(new Error('fixture pre-accept reset'), { code: 'ECONNRESET' })
      if (synchronous) throw error
      return Promise.reject(error)
    }
    const turnId = `turn-${sends}`
    f.emit({ type: 'turn_completed', threadId: request.threadId, turnId, status: 'completed' })
    return Promise.resolve({ turnId })
  } }, { ledgerContinuationLoader: () => ({ createLedgerContinuation(options) {
    return (runner = createLedgerContinuation({ ...options, now: () => time,
      readSettings: () => ({ values: { 'agent.persistent_continuation': true }, provenance: { 'agent.persistent_continuation': { source: 'user' } } }),
      readTasks: () => [{ id: 'T1', kind: 'T', status: 'open', scope: 'session', scopeKey: 'circle', words: 'Continue owned fixture work' }],
      stateFactory: () => (durable = createContinuationState({ file: ':memory:', now: () => time, onChange: row => changed.push(row) })),
      onPause(session, text) { pauses.push(text); options.onPause(session, text) },
    }))
  } }) })
  f.host.rememberContinuation('circle', { tier: 'luna' })
  await f.host.sendTurn({ sessionId: 'circle', text: 'begin owned work', origin: 'person' })
  assert.equal(durable.list()[0].status, 'ready')
  time += DEFAULT_BASE_DELAY_MS
  runner.tick()
  await new Promise(resolve => setImmediate(resolve))
  const retry = durable.list()[0]
  assert.equal(sends, 2, 'exactly one scheduled send reached the actual host adapter')
  assert.equal(retry.status, 'retry_wait')
  assert.equal(retry.retries, 1)
  assert.equal(changed.filter(row => row.status === 'retry_wait').length, 1, 'one rejection writes one failure transition')
  assert.deepEqual(pauses, [], 'the real host refusal and controller catch must not write the same failure twice')
  assert.equal(f.host.sessionActivity('circle').busy, false)
  time += 5000; runner.tick(); await new Promise(resolve => setImmediate(resolve))
  time += 5000; runner.tick(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(sends, 2, 'no retry can run before its durable due time')
  assert.equal(durable.list()[0].revision, retry.revision)
  time = retry.dueAtMs; runner.tick(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(sends, 3, 'the single retry runs when due')
  assert.equal(durable.list()[0].status, 'ready')
  assert.deepEqual(pauses, [])
})
