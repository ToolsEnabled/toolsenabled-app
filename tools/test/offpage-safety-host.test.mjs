import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { parseAst } from 'rollup/parseAst'
import { fileURLToPath } from 'node:url'
import { inspectSourceSuite } from '../lib/adapters/source-suites.mjs'
import { createAccountRecoveryCoordinator } from '../../src/account-recovery-coordinator.js'
import { createFleetTreeStore } from '../../src/fleet-trees.js'
import { createTranscriptStore } from '../../src/session-transcript-store.js'
const require = createRequire(import.meta.url)
const { createAgentHost } = require('../../shell/agent-host.cjs')
const { createAgentCommandSurface, REQUIRED_DEPS } = require('../../shell/agent-command-surface.cjs')
const enginePath = require.resolve('./fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const engine = require(enginePath)
const directory = require('./fixtures/confined-engine/src/lib/agent-comms/tree-node-directory.js')
const provider = require('./fixtures/confined-engine/src/lib/providers/agent-comms-local.js')
const source = fs.readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
const ast = parseAst(source)
const names = ['agentIpcError', 'agentPayload', 'boundedAgentString', 'parseAgentSend', 'parseAgentSessionCommand']
const helpersSource = names.map(name => {
  const node = ast.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === name)
  assert.ok(node, name); return source.slice(node.start, node.end)
}).join('\n')
const limits = ast.body.filter(n => n.type === 'VariableDeclaration').flatMap(n => n.declarations)
  .filter(n => ['MAX_SESSION_ID_LENGTH', 'MAX_TURN_TEXT_LENGTH'].includes(n.id.name))
  .map(n => 'const ' + source.slice(n.start, n.end) + ';').join('\n')
const helpers = new Function(limits + '\n' + helpersSource + '; return {' + names.join(',') + '}')()
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(done => setImmediate(done)) }

async function fixture(t) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'offpage-host-'))
  directory.reset(); provider.reset()
  const sends = [], automatic = [], activityReads = [], queue = [], delivered = []
  let providerOptions, active, admission = null, activityGate = null, afterDispatch = null, activityOverride = null
  t.mock.method(engine, 'startCodexSession', async options => {
    providerOptions = options
    return { threadId: 'synthetic-thread', close() {}, adapter: {
      async sendTurn(request) {
        sends.push(request); const turnId = 'synthetic-turn-' + sends.length; active = turnId
        if (afterDispatch) await afterDispatch(turnId)
        return { turnId }
      }, async steerTurn(request) { sends.push(request); return { turnId: active } },
      async interrupt() {}, answerApproval() {},
    } }
  })
  const host = createAgentHost({ enginePath, defaultCwd: scratch, freeMemory: () => 64 * 1024 ** 3,
    assertTranscriptWritable: async () => { if (admission) { admission.entered.resolve(); await admission.gate.promise } },
    confinementPlanner: () => ({ ok: true, tier: 'standard', isolated: true,
      threadOptions: { sandbox: 'workspace-write', approvalPolicy: 'never' },
      env: { CODEX_HOME: path.join(scratch, 'synthetic-home') }, servers: ['toolsenabled-readonly', 'toolsenabled'] }) })
  const sessionId = 'synthetic-offpage-session', owner = {}
  const principal = { kind: 'window', owner, mayWrite: true, label: 'Synthetic window' }
  const agentSessions = new Map([[sessionId, { owner, ownerKind: 'window', state: 'ready', attachments: new Set() }]])
  const deps = {}
  for (const [key, kind] of Object.entries(REQUIRED_DEPS)) deps[key] = kind === 'function' ? () => null : kind === 'number' ? 128 : kind === 'string' ? scratch : {}
  Object.assign(deps, helpers, { agentSessions, currentAgentHost: () => activityOverride ? { ...host, sessionActivity: () => activityOverride } : host, getAgentHost: async () => host,
    rendererSafeAgentError: error => error, dialog: { showOpenDialog: async () => ({ canceled: true }) }, AGENT_EFFORT_VALUES: ['medium'] })
  const surface = createAgentCommandSurface(deps)
  const bridge = {
    onEvent: listener => host.onEvent(listener),
    send: request => surface.run('agent:send', request, principal),
    sendAutomatic: async request => { automatic.push(request); return surface.run('agent:send-automatic', request, principal) },
    sessionActivity: async request => { activityReads.push(request); if (activityGate) await activityGate.promise; return surface.run('agent:session-activity', request, principal) },
  }
  const cells = new Map(), storage = { read: key => cells.get(key) || null,
    write: (key, value) => { cells.set(key, structuredClone(value)); return true } }
  let serial = 0
  const treeStore = createFleetTreeStore({ computerId: 'local', storage, makeId: kind => kind + '-' + ++serial })
  const node = treeStore.addNode({ role: 'worker', message: 'Synthetic task' }).node
  treeStore.attachSession(node.id, sessionId); treeStore.setNodeStatus(node.id, 'running')
  const transcriptStore = createTranscriptStore({ computerId: 'local', storage })
  const owned = new Map([[sessionId, node.id]])
  let takes = 0, coordinator
  const outbox = { takeNext() { takes++; const i = queue.findIndex(row => !row.deliveryUnconfirmed); return i < 0 ? null : queue.splice(i, 1)[0] },
    confirmDelivered: (_id, row) => delivered.push(row), requeueFront: (_id, row) => queue.unshift(row) }
  const mount = () => {
    coordinator = createAccountRecoveryCoordinator({ bridge, sessionNodeIds: owned, outbox, canStart: () => true, canContinue: () => true })
    coordinator.register('local', { treeStore, transcriptStore })
  }
  const emit = event => providerOptions.onEvent({ threadId: 'synthetic-thread', ...event })
  const complete = () => emit({ type: 'turn_completed', turnId: active, status: 'completed' })
  const refuse = (code, turnId = active) => emit({ type: 'turn_completed', turnId, status: 'failed',
    payload: { failure: { code, category: 'safety-policy', retryable: false, summary: 'Synthetic safety refusal.' } } })
  const unlisten = host.onEvent(packet => {
    if (packet.event.type === 'turn_completed') Object.assign(agentSessions.get(sessionId), {
      lastTurnStatus: packet.event.status, lastTurnId: packet.event.turnId,
    })
  })
  t.after(async () => { admission?.gate.resolve(); activityGate?.resolve(); coordinator?.destroy(); unlisten(); await host.closeAll(); directory.reset(); provider.reset(); fs.rmSync(scratch, { recursive: true, force: true }) })
  await host.startSession({ sessionId }); mount(); await settle()
  await bridge.send({ sessionId, text: 'Synthetic initial request' })
  return { bridge, host, surface, principal, sessionId, node, treeStore, queue, delivered, sends, automatic, activityReads, complete, refuse, emit,
    enqueue: text => queue.push({ id: 'synthetic-entry-' + queue.length, text }),
    takes: () => takes, setAfterDispatch: fn => { afterDispatch = fn },
    pauseAdmission() { admission = { gate: deferred(), entered: deferred() }; return admission.entered.promise },
    releaseAdmission() { admission?.gate.resolve(); admission = null },
    setActivityOverride(value) { activityOverride = value },
    pauseActivity() { activityGate = deferred() },
    releaseActivity() { activityGate?.resolve(); activityGate = null },
    async recreate() { coordinator.destroy(); mount(); await settle() },
  }
}

for (const code of ['misalignment_policy_violation', 'misalignmentPolicyViolation']) {
  test('real automatic host admission retains one queued entry when refusal arrives during awaited admission: ' + code, async t => {
    const f = await fixture(t)
    const entered = f.pauseAdmission()
    f.enqueue('Synthetic retained old input'); f.complete(); await entered
    f.refuse(code, null); f.releaseAdmission(); await settle()
    assert.equal(f.sends.length, 1); assert.equal(f.automatic.length, 1)
    assert.equal(f.queue.length, 1); assert.equal(f.queue[0].text, 'Synthetic retained old input')
    assert.equal(f.delivered.length, 0); assert.notEqual(f.queue[0].deliveryUnconfirmed, true)
    await f.bridge.send({ sessionId: f.sessionId, text: 'Synthetic deliberate new input' })
    f.complete(); await settle()
    assert.equal(f.sends.length, 2); assert.equal(f.queue.length, 1)
    assert.equal(f.host.sessionActivity(f.sessionId).lastTurnStatus, 'completed')
    assert.equal(f.host.sessionActivity(f.sessionId).automaticTurnBlock.code, 'PROVIDER_SAFETY_REFUSAL')
  })
  test('recreated off-page coordinator reads actual persistent hold after deliberate success: ' + code, async t => {
    const f = await fixture(t)
    f.refuse(code); await f.bridge.send({ sessionId: f.sessionId, text: 'Synthetic deliberate success' })
    f.complete(); await settle(); f.enqueue('Synthetic old queued input')
    const before = f.takes(), reads = f.activityReads.length
    await f.recreate()
    assert.ok(f.activityReads.length > reads)
    await f.bridge.send({ sessionId: f.sessionId, text: 'Synthetic next deliberate input' })
    f.complete(); await settle()
    assert.equal(f.sends.length, 3); assert.equal(f.automatic.length, 0)
    assert.equal(f.takes(), before); assert.equal(f.queue.length, 1)
    assert.equal(f.treeStore.getNode(f.node.id).status, 'finished')
    const activity = await f.bridge.sessionActivity({ sessionId: f.sessionId })
    assert.equal(activity.lastTurnStatus, 'completed')
    assert.deepEqual(activity.automaticTurnBlock, { code: 'PROVIDER_SAFETY_REFUSAL', reason: 'safety-policy' })
  })
}

test('completion concurrent with safety hydration cannot take retained input', async t => {
  const f = await fixture(t)
  f.refuse('misalignmentPolicyViolation')
  await f.bridge.send({ sessionId: f.sessionId, text: 'Synthetic deliberate input' })
  f.enqueue('Synthetic old input'); const before = f.takes()
  f.pauseActivity(); await f.recreate(); f.complete(); await settle()
  assert.equal(f.takes(), before); assert.equal(f.automatic.length, 0)
  f.releaseActivity(); await settle()
  assert.equal(f.takes(), before); assert.equal(f.queue.length, 1); assert.equal(f.sends.length, 2)
})

test('ordinary completion concurrent with hydration drains exactly one queued entry', async t => {
  const f = await fixture(t)
  f.enqueue('Synthetic next input'); f.enqueue('Synthetic following input')
  f.pauseActivity(); await f.recreate(); f.complete(); await settle()
  assert.equal(f.automatic.length, 0)
  f.releaseActivity(); await settle()
  assert.equal(f.sends.length, 2); assert.equal(f.delivered.length, 1); assert.equal(f.queue.length, 1)
})

test('actual host completion during automatic send acknowledgement releases exactly the next entry', async t => {
  const f = await fixture(t)
  f.enqueue('Synthetic quick input'); f.enqueue('Synthetic following input')
  f.setAfterDispatch(async turnId => {
    if (f.sends.length === 2) f.emit({ type: 'turn_completed', turnId, status: 'completed' })
  })
  f.complete(); await settle()
  assert.equal(f.sends.length, 3); assert.equal(f.automatic.length, 2)
  assert.deepEqual(f.delivered.map(row => row.text), ['Synthetic quick input', 'Synthetic following input'])
  assert.equal(f.queue.length, 0)
})

test('public activity hold retains session ownership and principal validation', async t => {
  const f = await fixture(t); f.refuse('misalignmentPolicyViolation')
  await assert.rejects(f.surface.run('agent:session-activity', { sessionId: f.sessionId }, { ...f.principal, owner: {} }), { code: 'MC_AGENT_UNKNOWN_SESSION' })
  await assert.rejects(f.surface.run('agent:session-activity', { sessionId: f.sessionId }, { ...f.principal, kind: 'relay' }), { code: 'MC_AGENT_PRINCIPAL_INVALID' })
  const activity = await f.bridge.sessionActivity({ sessionId: f.sessionId })
  assert.equal(activity.automaticTurnBlock.code, 'PROVIDER_SAFETY_REFUSAL')
  assert.equal(activity.busy, false); assert.equal(activity.closing, false)
})

test('public activity projects only constant safety metadata and preserves ordinary fields', async t => {
  const f = await fixture(t)
  f.setActivityOverride({ busy: false, closing: false,
    automaticTurnBlock: { code: 'PROVIDER_SAFETY_REFUSAL', reason: 'Synthetic unrelated diagnostics', details: 'Synthetic private field' } })
  const reply = await f.surface.run('agent:session-activity', { sessionId: f.sessionId }, { ...f.principal, mayWrite: false })
  assert.deepEqual(reply.automaticTurnBlock, { code: 'PROVIDER_SAFETY_REFUSAL', reason: 'safety-policy' })
  assert.equal(reply.busy, false); assert.equal(reply.closing, false); assert.equal(reply.turnsCompleted, 0)
  assert.doesNotMatch(JSON.stringify(reply), /Synthetic unrelated diagnostics|Synthetic private field/)
})

test('an earlier clear activity read cannot erase a newly observed safety refusal', async t => {
  const f = await fixture(t), gate = deferred(), entered = deferred()
  const read = f.bridge.sessionActivity
  f.bridge.sessionActivity = async request => { const answer = await read(request); entered.resolve(); await gate.promise; return answer }
  await f.recreate(); await entered.promise
  f.refuse('misalignmentPolicyViolation'); gate.resolve(); await settle()
  f.enqueue('Synthetic retained work')
  await f.bridge.send({ sessionId: f.sessionId, text: 'Synthetic new deliberate work' })
  f.complete(); await settle()
  assert.equal(f.sends.length, 2); assert.equal(f.automatic.length, 0); assert.equal(f.queue.length, 1)
})

test('unreadable activity retains input and a later ordinary completion can reread', async t => {
  const f = await fixture(t)
  const read = f.bridge.sessionActivity
  f.bridge.sessionActivity = async () => ({ ok: false, code: 'MC_AGENT_UNKNOWN_SESSION' })
  await f.recreate(); f.enqueue('Synthetic ordinary queued work'); f.complete(); await settle()
  assert.equal(f.sends.length, 1); assert.equal(f.queue.length, 1)
  f.bridge.sessionActivity = read
  await f.bridge.send({ sessionId: f.sessionId, text: 'Synthetic ordinary new input' })
  f.complete(); await settle()
  assert.equal(f.sends.length, 3); assert.equal(f.queue.length, 0); assert.equal(f.delivered.length, 1)
})

test('public activity does not turn an unrelated block into a safety hold', async t => {
  const f = await fixture(t)
  f.setActivityOverride({ busy: false, closing: false, automaticTurnBlock: { code: 'SYNTHETIC_OTHER_BLOCK', reason: 'safety-policy' } })
  const reply = await f.bridge.sessionActivity({ sessionId: f.sessionId })
  assert.equal(reply.automaticTurnBlock, undefined)
})

test('joined off-page host suite is selected as a required release execution', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const selected = inspectSourceSuite('app', { sourceRoots: { app: root } })
  const file = 'tools/test/offpage-safety-host.test.mjs'
  assert.equal(selected.files.filter(value => value === file).length, 1)
  assert.equal(selected.exclusions.some(row => row.file === file), false)
  assert.equal(selected.obligations.some(row => row.id === 'unreconciled-tests' && row.files.includes(file)), false)
})
