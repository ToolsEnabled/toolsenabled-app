/* B31 (found by hand on 1.0.48 candidate 3): Details > Team with a lead and one
 * member. The lead started and answered; the member started, but its brief was
 * refused with MC_TRANSCRIPT_ADMISSION_PENDING, and the Team box still listed
 * "Member 1 ... Started; open its circle".
 *
 * The pending send was the LEAD'S OWN BRIEF. The node transcript store admits one
 * turn at a time (shell/node-transcript-store.cjs reserveTurn), and the host holds
 * that admission from reservation until the provider accepts the turn and the
 * accepted words are saved (shell/agent-host.cjs reportAcceptedPrompt). A Claude
 * turn is accepted at the CLI's system init, seconds after the first send of a
 * new process. startAgentForNode sent a bounded child's brief in the background
 * and answered the controller at once, so run() started the member while the
 * lead's brief still held the admission, and main.cjs's reservation hook turned
 * "wait your turn" into a refusal. The background send also meant no refusal
 * could ever reach the box.
 *
 * This drives the box's own path -- controller.run -> startAgentForNode ->
 * window.mcAgent -- against a host stand-in that keeps the host's order
 * (reserve through main.cjs's own hook over the REAL node transcript store and
 * recovery journal, dispatch once, accept, save, release), and then the real
 * agent host over the same hook.
 *
 *   node --test --import=./tools/test/lib/isolate-native-state-root.mjs tools/test/b31-team-member-brief-admission.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire, register } from 'node:module'
import test, { beforeEach } from 'node:test'
import { useStartConsent } from './lib/start-consent-fixture.mjs'

beforeEach(t => { useStartConsent(t) })
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.css')) return { url: new URL(specifier, context.parentURL).href, shortCircuit: true }
    return nextResolve(specifier, context)
  }
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`), import.meta.url)
const { startAgentForNode } = await import('../../src/views/computers.js')
const { createTreeWorkController } = await import('../../src/tree-bounded-work.js')
const { createAgentHost } = await import('../../shell/agent-host.cjs')
const require = createRequire(import.meta.url)
const { createNodeTranscriptStore } = require('../../shell/node-transcript-store.cjs')
const { createNodeTranscriptCapture } = require('../../shell/node-transcript-capture.cjs')
const { createTranscriptRecoveryJournal } = require('../../shell/transcript-recovery-journal.cjs')
const enginePath = path.resolve(import.meta.dirname, 'fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const engine = require(enginePath)
const mainSource = await fs.readFile(new URL('../../shell/main.cjs', import.meta.url), 'utf8')

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
function useBridge(t, bridge) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  t.after(() => { if (original) Object.defineProperty(globalThis, 'window', original); else delete globalThis.window })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { mcAgent: bridge } })
}

/* main.cjs's own reservation hook, the one buildAgentHost hands createAgentHost. */
function mainReservationHook(context) {
  const begin = mainSource.indexOf('    reserveTranscriptTurn: async request => {')
  const end = mainSource.indexOf('    providerSignIn:', begin)
  assert.ok(begin >= 0 && end > begin, 'the host configuration supplies the reservation hook')
  return vm.runInNewContext('({' + mainSource.slice(begin, end) + '})', context).reserveTranscriptTurn
}

async function transcripts(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'te-b31-'))
  const journal = createTranscriptRecoveryJournal({ directory: path.join(directory, 'recovery'), capacityBytes: 8 * 1024 * 1024 })
  await journal.ready
  const store = createNodeTranscriptStore({ directory, recoveryJournal: journal })
  const bindings = new Map()
  const reserve = mainReservationHook({
    assertConversationWritable: () => store.assertWritable(),
    transcriptCapture: { bindingFor: sessionId => bindings.get(sessionId) || null },
    nodeTranscripts: store,
  })
  const cleanups = []
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup()
    await journal.close()
    await fs.rm(directory, { recursive: true, force: true })
  })
  const bind = (sessionId, nodeId) => { const binding = { sessionId, computerId: 'this-computer', nodeId }; bindings.set(sessionId, binding); return binding }
  return { directory, store, journal, reserve, bind, onCleanup: cleanup => cleanups.push(cleanup) }
}

// The engine's unsigned not-required receipt (audit off, the default), exactly 12 keys.
const basic = (action, target) => ({ action, target, ok: true, disposition: 'not-required', required: false,
  recorded: false, durable: false, anchored: false, signed: false, sequence: null, eventId: null, eventHash: null })
const plan = { computerId: 'this-computer', treeId: 'tree-1', parentNodeId: 'controller', parentSessionId: 'controller-session',
  tier: 'claude-sonnet-5', effort: null, capMs: 1_200_000, brief: 'Every member: reply with exactly the single word TEAMOK.',
  members: ['claude-haiku-4-5'] }

/* The host's send in the host's order (agent-host.cjs sendTurn): reserve through
   main's hook, dispatch once, the provider accepts (Claude's system init), the
   accepted words are saved, the admission is released, the send answers. A
   refusal crosses IPC as its bare code, as rendererSafeAgentError makes it. */
function hostStandIn(tx, { acceptAfterMs = 25, afterAccepted = async () => {}, refuse = () => null } = {}) {
  const dispatched = [], refusals = [], starts = [], events = []
  const bridge = {
    async start(request) {
      starts.push(request)
      const n = starts.length, sessionId = `session-${n}`, nodeId = `node-${n}`, work = request.boundedWork
      tx.bind(sessionId, nodeId)
      return { ok: true, sessionId, threadId: `thread-${n}`, record: basic('controller.agent.launch', sessionId), boundedWork: {
        action: 'tree.dispatch', computerId: work.computerId, treeId: work.treeId, parentNodeId: work.parentNodeId,
        parentSessionId: work.parentSessionId, sessionId, nodeId, agentId: nodeId, capMs: work.capMs - 3,
        startedAt: 1000, deadlineAt: 1000 + work.capMs, state: 'ready', reason: null, endedAt: null } }
    },
    async send({ sessionId, text }) {
      const refused = refuse(sessionId)
      if (refused) { refusals.push({ sessionId, code: refused }); throw new Error(refused) }
      let lease
      try { lease = await tx.reserve({ sessionId, text, transcriptPrompt: { text, additions: [] }, attachments: [] }) }
      catch (error) { refusals.push({ sessionId, code: error?.code }); throw new Error(error?.code || 'AGENT_SESSION_FAILED') }
      dispatched.push(sessionId)
      events.push(`dispatch:${sessionId}`)
      await pause(acceptAfterMs)
      const released = await lease.release()
      assert.equal(released.ok, true)
      await afterAccepted(sessionId)
      return { ok: true, sessionId, turnId: `turn-${sessionId}` }
    },
  }
  return { bridge, dispatched, refusals, starts, events }
}

/* startBoundedChild -> startDraftNode: the start's own answer on success; on a
   refusal the same answer with ok:false and its sentence as `message`. */
function teamController(statuses, closes) {
  return createTreeWorkController({ kind: 'team',
    start: async request => {
      const result = await startAgentForNode({ text: request.brief, surface: 'fleet-tree', tier: request.tier,
        boundedWork: { computerId: request.computerId, treeId: request.treeId, parentNodeId: request.parentNodeId,
          parentSessionId: request.parentSessionId, capMs: request.capMs },
        onCleanupRequired() {} })
      if (result.boundedWork) statuses.set(result.sessionId, { ok: true, ...result.boundedWork, state: 'ready', record: result.record, endRecord: null })
      const nodeId = result.boundedWork?.nodeId || null
      return result.ok ? { ...result, nodeId } : { ...result, ok: false, message: result.sentence, nodeId, sessionId: result.sessionId || null }
    },
    readStatus: async sessionId => statuses.get(sessionId),
    close: async sessionId => {
      closes.push(sessionId)
      const status = statuses.get(sessionId)
      statuses.set(sessionId, { ...status, state: 'closed', endRecord: { ...status.record, action: 'agent_session_end', target: sessionId } })
      return { ok: true }
    },
    isBusy: () => false,
    setTimer: () => null, clearTimer: () => {},
  })
}

test('B31: the member\'s brief goes after the lead\'s brief is accepted, and each child receives its brief once', async t => {
  const tx = await transcripts(t)
  const host = hostStandIn(tx)
  useBridge(t, host.bridge)
  const statuses = new Map(), closes = []
  const controller = teamController(statuses, closes)
  await controller.run(plan)
  await pause(200) // any brief still travelling after the box answered
  assert.deepEqual(host.refusals, [], 'no brief was refused')
  assert.deepEqual(host.dispatched, ['session-1', 'session-2'], 'lead, then member, each exactly once')
  const state = controller.getState()
  assert.deepEqual(state.rows.map(row => row.phase), ['started', 'started'])
  assert.equal(state.phase, 'active')
  assert.equal(tx.store.getStorageStatus().pendingTurns, 0)
  assert.equal(tx.journal.reservedBytes, 0)
})

test('B31: a member\'s brief waits while another agent\'s message is being saved, then goes once', async t => {
  const tx = await transcripts(t)
  tx.bind('controller-session', 'controller')
  const host = hostStandIn(tx, { afterAccepted: async sessionId => {
    if (sessionId !== 'session-1') return
    // At this moment the Controller answers the person: its own message takes the admission.
    const held = await tx.store.reserveTurn({ sessionId: 'controller-session', computerId: 'this-computer', nodeId: 'controller',
      text: 'The person asked the Controller something.', transcriptPrompt: null, attachments: [] })
    host.events.push('controller:reserved')
    setTimeout(() => { host.events.push('controller:released'); void held.release() }, 60)
  } })
  useBridge(t, host.bridge)
  const statuses = new Map(), closes = []
  const controller = teamController(statuses, closes)
  await controller.run(plan)
  await pause(200)
  assert.deepEqual(host.refusals, [], 'the member was not refused while the Controller\'s message was saved')
  assert.deepEqual(host.dispatched, ['session-1', 'session-2'])
  assert.deepEqual(host.events, ['dispatch:session-1', 'controller:reserved', 'controller:released', 'dispatch:session-2'],
    'the member\'s brief waited for the other admission, it did not overlap it')
  assert.deepEqual(controller.getState().rows.map(row => row.phase), ['started', 'started'])
  assert.equal(tx.store.getStorageStatus().pendingTurns, 0)
  assert.equal(tx.journal.reservedBytes, 0)
})

test('B31: a refused brief leaves its member not Started, starts no further member, and Stop still closes both', async t => {
  const tx = await transcripts(t)
  const host = hostStandIn(tx, { refuse: sessionId => sessionId === 'session-2' ? 'MC_TRANSCRIPT_ADMISSION_PENDING' : null })
  useBridge(t, host.bridge)
  const statuses = new Map(), closes = []
  const controller = teamController(statuses, closes)
  await controller.run({ ...plan, members: ['claude-haiku-4-5', 'claude-opus-4-6'] })
  await pause(200)
  const state = controller.getState()
  assert.equal(host.starts.length, 2, 'the second member was not started after the first member\'s brief was refused')
  assert.equal(state.rows.length, 2)
  assert.equal(state.rows[0].phase, 'started')
  assert.equal(state.rows[1].phase === 'started', false, `member row: ${state.rows[1].detail}`)
  assert.match(state.rows[1].detail, /brief did not reach it/)
  assert.doesNotMatch(state.rows[1].detail, /open its circle/)
  assert.equal(state.phase, 'refused')
  assert.equal(state.stoppable, true, 'the started lead and member stay reachable by Stop')
  await controller.stop()
  assert.deepEqual(closes, ['session-2', 'session-1'])
  assert.equal(controller.getState().phase, 'stopped')
})

test('B31: a bounded start answers only once its brief is accepted; a refused brief keeps the session and receipt', async t => {
  const work = { computerId: 'this-computer', treeId: 'tree-1', parentNodeId: 'controller', parentSessionId: 'controller-session', capMs: 60_000 }
  const receipt = { action: 'tree.dispatch', ...work, sessionId: 'worker', nodeId: 'node-w', agentId: 'node-w', startedAt: 1, deadlineAt: 60_001 }
  let accept
  const accepted = new Promise(resolve => { accept = resolve })
  useBridge(t, { async start() { return { ok: true, sessionId: 'worker', boundedWork: receipt, record: basic('controller.agent.launch', 'worker') } },
    send() { return accepted } })
  let settled = false
  const pending = startAgentForNode({ text: 'Reply LAUNCHOK.', surface: 'fleet-tree', boundedWork: work, onCleanupRequired() {} })
    .then(result => { settled = true; return result })
  await pause(20)
  assert.equal(settled, false, 'the box is not told "started" while the brief is still unaccepted')
  accept({ ok: true, turnId: 'turn-1' })
  const result = await pending
  assert.equal(result.ok, true)
  assert.equal(result.boundedWork, receipt)

  useBridge(t, { async start() { return { ok: true, sessionId: 'worker', boundedWork: receipt, record: basic('controller.agent.launch', 'worker') } },
    async send() { throw new Error('MC_TRANSCRIPT_ADMISSION_PENDING') } })
  const refused = await startAgentForNode({ text: 'Reply LAUNCHOK.', surface: 'fleet-tree', boundedWork: work, onCleanupRequired() {} })
  assert.equal(refused.ok, false)
  assert.equal(refused.sessionId, 'worker', 'the started session is kept for Stop')
  assert.equal(refused.boundedWork, receipt, 'with its receipt, so Stop can confirm the close')
  assert.equal(refused.code, 'MC_TRANSCRIPT_ADMISSION_PENDING')
  assert.match(refused.sentence, /did not reach it/)
})

test('B31: through the real agent host, a second agent\'s turn waits for the first one\'s saved acceptance and is sent once', async t => {
  const tx = await transcripts(t)
  const capture = createNodeTranscriptCapture({ store: tx.store })
  for (const [sessionId, nodeId] of [['b31-lead', 'lead'], ['b31-member', 'member']]) capture.bind(tx.bind(sessionId, nodeId))
  const ack = Promise.withResolvers(), entered = Promise.withResolvers(), order = []
  let sends = 0
  t.mock.method(engine, 'startCodexSession', async options => ({
    threadId: 'thread-' + options.sessionId, close() {}, adapter: {
      sendTurn(request) {
        sends++
        order.push('dispatch:' + (request.text.startsWith('The lead') ? 'b31-lead' : 'b31-member'))
        if (sends === 1) { entered.resolve(); return ack.promise }
        return { turnId: 'turn-' + sends }
      },
      async interrupt() {}, answerApproval() {},
    },
  }))
  const host = createAgentHost({ enginePath, defaultCwd: tx.directory, profileRoot: path.parse(tx.directory).root,
    freeMemory: () => 64 * 1024 ** 3,
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
    assertTranscriptWritable: () => tx.store.assertWritable(),
    reserveTranscriptTurn: tx.reserve,
  })
  host.onAcceptedPrompt(request => capture.recordAcceptedTranscriptSend(request).then(() => { order.push('saved:' + request.sessionId) }))
  for (const sessionId of ['b31-lead', 'b31-member']) await host.startSession({ sessionId })
  tx.onCleanup(async () => { ack.resolve({ turnId: 'turn-1' }); await host.closeAll() })

  const first = host.sendTurn({ sessionId: 'b31-lead', text: 'The lead\'s brief.', origin: 'person' })
  await entered.promise
  assert.equal(tx.store.getStorageStatus().pendingTurns, 1)
  const second = host.sendTurn({ sessionId: 'b31-member', text: 'The member\'s brief.', origin: 'person' })
    .then(value => ({ ok: true, value }), error => ({ ok: false, code: error?.code }))
  await pause(50)
  assert.equal(sends, 1, 'nothing is dispatched while another turn holds the admission')
  ack.resolve({ turnId: 'turn-1' })
  await first
  const answer = await second
  assert.equal(answer.ok, true, `the second turn was refused: ${answer.code}`)
  assert.equal(sends, 2, 'each turn reached the provider exactly once')
  assert.deepEqual(order, ['dispatch:b31-lead', 'saved:b31-lead', 'dispatch:b31-member', 'saved:b31-member'])
  assert.equal(tx.store.getStorageStatus().pendingTurns, 0)
  assert.equal(tx.journal.reservedBytes, 0)
})

test('B31: the wait is bounded, reserves nothing while it waits, and never retries any other refusal', async t => {
  const tx = await transcripts(t)
  tx.bind('holder', 'holder'); tx.bind('waiter', 'waiter')
  const holder = await tx.store.reserveTurn({ sessionId: 'holder', computerId: 'this-computer', nodeId: 'holder', text: 'Held.', transcriptPrompt: null, attachments: [] })
  tx.onCleanup(() => holder.release().catch(() => {}))
  const held = tx.journal.reservedBytes

  // The store's own wait: prompt when released, bounded when not.
  const before = Date.now()
  await tx.store.waitForTurnAdmission(40)
  assert.ok(Date.now() - before >= 30, 'a held admission is waited on up to the bound')
  assert.equal(tx.store.getStorageStatus().pendingTurns, 1)

  // main's hook gives up with the store's own refusal once its deadline passes.
  let clock = 1_000_000, attempts = 0
  const waits = []
  const reserve = mainReservationHook({
    Date: { now: () => clock },
    assertConversationWritable: () => tx.store.assertWritable(),
    transcriptCapture: { bindingFor: sessionId => ({ sessionId, computerId: 'this-computer', nodeId: sessionId }) },
    nodeTranscripts: { reserveTurn: request => { attempts++; return tx.store.reserveTurn(request) },
      waitForTurnAdmission: async ms => { waits.push(ms); clock += ms } },
  })
  await assert.rejects(reserve({ sessionId: 'waiter', text: 'Unsent.', transcriptPrompt: null, attachments: [] }), { code: 'MC_TRANSCRIPT_ADMISSION_PENDING' })
  assert.ok(waits.length >= 1 && waits.every(ms => ms > 0 && ms <= 30_000), `bounded waits: ${waits}`)
  assert.equal(attempts, waits.length + 1)
  assert.equal(tx.store.getStorageStatus().pendingTurns, 1, 'the waiting send held no admission of its own')
  assert.equal(tx.journal.reservedBytes, held, 'and reserved no recovery space')

  // Any other refusal is final at once: it may already describe a dispatched message.
  let tries = 0
  const refusing = mainReservationHook({
    assertConversationWritable: async () => {},
    transcriptCapture: { bindingFor: sessionId => ({ sessionId, computerId: 'this-computer', nodeId: sessionId }) },
    nodeTranscripts: { reserveTurn: async () => { tries++; throw Object.assign(new Error('Disk full.'), { code: 'MC_TRANSCRIPT_DISK_FULL' }) },
      waitForTurnAdmission: () => assert.fail('only a pending admission is waited on') },
  })
  await assert.rejects(refusing({ sessionId: 'waiter', text: 'Unsent.' }), { code: 'MC_TRANSCRIPT_DISK_FULL' })
  assert.equal(tries, 1)
})
