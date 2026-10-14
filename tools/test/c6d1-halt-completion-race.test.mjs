import assert from 'node:assert/strict'
import test from 'node:test'
import Module, { createRequire, registerHooks } from 'node:module'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { canonicalRootForTests } from '../canonical-root.mjs'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

// Historical comparison reads Git objects in memory: no checkout or worktree.
const appRoot = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(import.meta.url)
if (process.env.C6D1_APP_REVISION) {
  const revision = process.env.C6D1_APP_REVISION
  assert.match(revision, /^[a-f0-9]{7,40}$/)
  registerHooks({ load(url, context, nextLoad) {
    if (url.startsWith('file:')) {
      const relative = path.relative(appRoot, fileURLToPath(url)).split(path.sep).join('/')
      if (relative.startsWith('src/')) {
        return { source: execFileSync('git', ['show', `${revision}:${relative}`], { cwd: appRoot, encoding: 'utf8' }),
          format: 'module', shortCircuit: true }
      }
    }
    return nextLoad(url, context)
  } })
  const loadCommonJS = Module._extensions['.cjs'] || Module._extensions['.js']
  Module._extensions['.cjs'] = (module, filename) => {
    const relative = path.relative(appRoot, filename).split(path.sep).join('/')
    if (relative.startsWith('shell/')) module._compile(execFileSync('git', ['show', `${revision}:${relative}`],
      { cwd: appRoot, encoding: 'utf8' }), filename)
    else loadCommonJS(module, filename)
  }
}
const { createAgentHost } = require('../../shell/agent-host.cjs')
const { mountStandaloneAgent } = await import('../../src/tree-standalone-agent.js')
const { resetLiveSessionForTest } = await import('../../src/agent-session-registry.js')
const enginePath = fileURLToPath(new URL('./fixtures/confined-engine/src/lib/agent-engine/codex-process.js', import.meta.url))
const fixtureEngine = require(enginePath)
const { CodexAdapter, CODEX_CLI_VERSION } = require(path.join(canonicalRootForTests(), 'src/lib/agent-engine/codex-adapter.js'))
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => Promise.withResolvers()
async function waitFor(predicate, description) {
  // Bound: 400 event-loop turns with a 1 ms yield, never a provider deadline.
  for (let attempt = 0; attempt < 400; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  assert.fail(`timed out waiting for ${description}`)
}

async function fixture(t, { cancel = () => {} } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'c6d1-halt-'))
  const world = installDomStandIn()
  globalThis.requestAnimationFrame = callback => setTimeout(() => callback(performance.now()), 0)
  globalThis.cancelAnimationFrame = clearTimeout
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map([['mc.write.agent-session', 'enabled']])
  globalThis.localStorage = { getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) }
  const wire = [], packets = [], cancellations = [], accepted = [], interrupts = [], sends = []
  const readers = new Set(), threadId = 'c6d1-fixture-thread'
  const receive = packet => { for (const reader of readers) reader(JSON.stringify(packet) + '\n') }
  const adapter = new CodexAdapter({ codexVersion: CODEX_CLI_VERSION, transport: {
    onData: reader => { readers.add(reader); return () => readers.delete(reader) },
    write: line => {
      const request = JSON.parse(line); wire.push(request)
      if (request.method === 'initialize') queueMicrotask(() => receive({ id: request.id,
        result: { userAgent: 'c6d1-fixture', codexHome: root, platformFamily: 'unix', platformOs: 'linux' } }))
      if (request.method === 'turn/start') queueMicrotask(() => receive({ id: request.id,
        result: { turn: { id: `turn-${wire.filter(value => value.method === 'turn/start').length}` } } }))
    },
  } })
  await adapter.initialize()
  let emit
  t.mock.method(fixtureEngine, 'startCodexSession', async options => {
    emit = options.onEvent
    adapter.onEvent(options.onEvent)
    return { adapter, threadId, close: () => adapter.close() }
  })
  const host = createAgentHost({ enginePath, defaultCwd: root, profileRoot: path.parse(root).root,
    freeMemory: () => 64 * 1024 ** 3,
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
    sessionAuthority: {
      bind: () => ({ bound: true, credential: Buffer.alloc(32, 1).toString('base64url') }),
      assert: () => ({ valid: true }), revoke() {}, cancelVersion: 2,
      cancelWork: value => { cancellations.push(value.sessionId); return cancel(value) }, resumeWork() {},
    },
  })
  host.onEvent(packet => { packets.push(packet) })
  host.onAcceptedPrompt(value => accepted.push(value))
  const bridge = {
    ownerContext: async () => ({ version: 1, ownerId: 'c6d1-fixture-owner', currentEpoch: 'c6d1-fixture-epoch', kind: 'local' }),
    onOwnerContextChanged: () => () => {}, availability: async () => ({ ok: true }),
    confinement: async () => ({ ok: true, tier: 'standard' }), onEvent: host.onEvent,
    start: value => host.startSession({ ...value, cwd: root }),
    send: value => { sends.push(value); return host.sendTurn(value) },
    interrupt: value => {
      const result = host.interrupt(value).then(value => ({ value }), error => ({ error }))
      interrupts.push(result)
      return result.then(outcome => { if (outcome.error) throw outcome.error; return outcome.value })
    },
    close: value => host.closeSession(value),
  }
  const element = document.createElement('div'); document.body.appendChild(element)
  const panel = mountStandaloneAgent(element, { id: 'c6d1-agent', name: 'Race fixture', live: true, bridge,
    start: { tier: 'astra' }, transcript: { bind: async () => ({ ok: true }), release: async () => ({ ok: true, released: true }) } })
  t.after(async () => {
    panel.dispose(); adapter.close(); await host.closeAll(); await tick(); resetLiveSessionForTest()
    if (storage) Object.defineProperty(globalThis, 'localStorage', storage); else delete globalThis.localStorage
    world.restore(); rmSync(root, { recursive: true, force: true })
  })
  const chat = () => element.querySelector('[data-chat-panel]')
  const type = text => {
    const input = element.querySelector('.chat-input textarea')
    input.value = text; input.dispatch('input')
  }
  const send = async (text, now = false) => {
    type(text)
    const selector = now ? '.chat-chip-sendnow' : '.chat-send'
    await waitFor(() => chat().querySelector(selector).disabled === false, 'the ready rendered Send button')
    chat().querySelector(selector).click()
    try { await waitFor(() => panel.snapshot().turnId != null, 'the real host to accept the rendered Send') }
    catch (error) { error.message += `: ${JSON.stringify({ snapshot: panel.snapshot(), methods: wire.map(value => value.method), text: element.textContent })}`; throw error }
  }
  const complete = (status = 'completed', turnId = 'turn-1') => receive({ method: 'turn/completed',
    params: { threadId, turn: { id: turnId, status } } })
  const halt = async () => {
    const before = interrupts.length
    await waitFor(() => chat().querySelector('.chat-chip-halt')?.hidden === false
      && chat().querySelector('.chat-chip-halt').disabled === false, 'the mounted Halt chip')
    chat().querySelector('.chat-chip-halt').click()
    await waitFor(() => interrupts.length === before + 1, 'the mounted Halt to reach the host')
    await waitFor(() => wire.some(value => value.method === 'turn/interrupt'), 'the actual Codex interrupt request')
  }
  const answerInterrupt = (error = false) => {
    const request = wire.find(value => value.method === 'turn/interrupt')
    receive({ id: request.id, ...(error ? { error: { code: -32600, message: 'turn already completed' } } : { result: {} }) })
  }
  return { panel, host, wire, packets, cancellations, accepted, interrupts, sends, send, halt, complete, answerInterrupt,
    emit: event => emit(event),
    say: (text, turnId = 'turn-1') => receive({ method: 'item/agentMessage/delta',
      params: { threadId, turnId, itemId: `reply-${turnId}`, delta: text } }),
    queue: async text => {
      type(text)
      await waitFor(() => chat().querySelector('.chat-send').disabled === false, 'the mounted Send next button')
      chat().querySelector('.chat-send').click(); await tick()
    } }
}

for (const order of ['completion-before-refusal', 'refusal-before-completion']) {
  test(`mounted Halt/completed crossing settles idle and next Send arrives once: ${order}`, async t => {
    const f = await fixture(t)
    await f.send('FIRST_EXACT_INTENT')
    const sessionId = f.panel.snapshot().sessionId
    f.say('FIRST_REPLY')
    await f.halt()
    f.say('_LAST_WORDS')
    if (order === 'completion-before-refusal') { f.complete(); f.answerInterrupt(true) }
    else { f.answerInterrupt(true); await tick(); f.complete() }
    const stopped = await f.interrupts[0]
    assert.equal(stopped.error, undefined, 'the exact terminal receipt settles the crossed interrupt refusal')
    await waitFor(() => f.panel.snapshot().phase === 'open', 'the renderer to settle idle')
    assert.equal(f.host.sessionActivity(sessionId).busy, false, 'host and renderer agree that the turn ended')
    assert.equal(f.panel.snapshot().lastTurnStatus, 'completed', 'Halt cannot rewrite a completed turn as interrupted')
    assert.deepEqual(f.panel.snapshot().transcript.filter(row => row.who === 'agent').map(row => row.text),
      ['FIRST_REPLY_LAST_WORDS'], 'the completed answer survives Halt once, including its last words')
    await f.send('SECOND_EXACT_INTENT', true)
    assert.equal(f.sends.length, 2)
    assert.equal(f.sends[1].text, 'SECOND_EXACT_INTENT')
    assert.equal(f.wire.filter(value => value.method === 'turn/start').length, 2)
    assert.equal(f.wire.filter(value => value.method === 'turn/interrupt').length, 1)
    assert.equal(f.accepted.length, 2, 'each original intent is accepted once')
    f.say('SECOND_REPLY', 'turn-2'); f.complete('completed', 'turn-2')
    await waitFor(() => f.panel.snapshot().lastTurnStatus === 'completed', 'the next actual reply to finish')
    assert.deepEqual(f.panel.snapshot().transcript.filter(row => row.who === 'agent').map(row => row.text),
      ['FIRST_REPLY_LAST_WORDS', 'SECOND_REPLY'])
  })
}

for (const status of ['completed', 'interrupted']) {
  test(`mounted Halt retains the actual ${status} outcome when interrupt acknowledges`, async t => {
    const f = await fixture(t)
    await f.send('ONE_INTENT'); const sessionId = f.panel.snapshot().sessionId
    await f.halt(); f.complete(status); f.answerInterrupt()
    assert.equal((await f.interrupts[0]).error, undefined)
    await waitFor(() => f.panel.snapshot().phase === 'open', 'the terminal renderer state')
    assert.equal(f.host.sessionActivity(sessionId).busy, false)
    assert.equal(f.panel.snapshot().lastTurnStatus, status)
  })
}

test('completion cannot acknowledge refused command cleanup; retry cleans up without replay', async t => {
  let attempts = 0
  const f = await fixture(t, { cancel: () => { if (++attempts === 1) throw Error('fixture cleanup unconfirmed') } })
  await f.send('HELD_INTENT'); const sessionId = f.panel.snapshot().sessionId
  await f.halt(); f.complete(); f.answerInterrupt(true)
  assert.equal((await f.interrupts[0]).error.code, 'AGENT_STOP_PENDING')
  assert.equal(f.host.sessionActivity(sessionId).busy, true)
  assert.equal(f.panel.snapshot().phase, 'working', 'the renderer retains a retryable Halt while cleanup is unproven')
  await assert.rejects(f.host.sendTurn({ sessionId, text: 'MUST_NOT_DISPATCH' }), { code: 'AGENT_TURN_ACTIVE' })
  await f.halt(); assert.equal((await f.interrupts[1]).error, undefined)
  await waitFor(() => f.panel.snapshot().phase === 'open', 'the cleanup retry to release the held completion')
  assert.equal(f.panel.snapshot().lastTurnStatus, 'completed')
  assert.equal(f.host.sessionActivity(sessionId).busy, false)
  assert.equal(attempts, 2)
  assert.equal(f.wire.filter(value => value.method === 'turn/interrupt').length, 1)
  assert.equal(f.wire.filter(value => value.method === 'turn/start').length, 1)
})

test('a queued next message waits for Halt cleanup and drains once after the completed turn', async t => {
  const cleanup = deferred()
  t.after(() => cleanup.resolve())
  const f = await fixture(t, { cancel: () => cleanup.promise })
  await f.send('ORIGINAL_INTENT'); const sessionId = f.panel.snapshot().sessionId
  await f.queue('QUEUED_EXACT_INTENT')
  await f.halt(); f.complete(); f.answerInterrupt(true)
  await tick()
  assert.equal(f.host.sessionActivity(sessionId).busy, true)
  assert.equal(f.panel.snapshot().phase, 'working', 'Halt waits for command cleanup before opening Send')
  await tick()
  assert.equal(f.wire.filter(value => value.method === 'turn/start').length, 1)
  cleanup.resolve(); assert.equal((await f.interrupts[0]).error, undefined)
  try { await waitFor(() => f.sends.length === 2 && f.panel.snapshot().turnId === 'turn-2', 'the queued intent to drain after Halt') }
  catch (error) { error.message += `: ${JSON.stringify({ snapshot: f.panel.snapshot(), sends: f.sends.map(value => value.text) })}`; throw error }
  assert.equal(f.sends[1].text, 'QUEUED_EXACT_INTENT')
  f.complete('completed', 'turn-2'); await tick(); await tick()
  assert.equal(f.wire.filter(value => value.method === 'turn/start').length, 2)
  assert.equal(f.accepted.length, 2)
  assert.equal(f.host.sessionActivity(sessionId).busy, false)
  assert.equal(f.panel.snapshot().lastTurnStatus, 'completed')
})

for (const completion of ['another-turn', 'nameless']) test(`${completion} terminal evidence cannot release the captured Halt or dispatch a second intent`, async t => {
  const f = await fixture(t)
  await f.send('CAPTURED_INTENT'); const sessionId = f.panel.snapshot().sessionId
  await f.halt()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  // Host-level injection models a stale terminal packet from another turn.
  // The real adapter correctly refuses unrelated turn/completed wire packets.
  // Keep this distinct from the exact completion exercised above.
  f.emit({ type: 'turn_completed', ...(completion === 'nameless' ? {} : { turnId: completion }), status: 'completed' })
  f.answerInterrupt(true)
  let stopped
  f.interrupts[0].then(value => { stopped = value })
  // Bound: at most three release ceilings. This also makes a weakened gate
  // report a behavioral assertion failure instead of an unresolved mock timer.
  for (let attempt = 0; attempt < 3 && stopped === undefined; attempt++) {
    await tick(); t.mock.timers.tick(2501); await tick()
  }
  assert.ok(stopped, 'the bounded Halt must answer')
  assert.equal(stopped.error?.code, 'AGENT_STOP_PENDING')
  assert.equal(f.host.sessionActivity(sessionId).busy, true)
  await assert.rejects(f.host.sendTurn({ sessionId, text: 'NOT_SENT' }), { code: 'AGENT_TURN_ACTIVE' })
  f.complete(); await f.host.interrupt({ sessionId })
  assert.equal(f.wire.filter(value => value.method === 'turn/start').length, 1)
})
