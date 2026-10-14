/* 1.0.50 REVIEW #2. A CLAUDE TURN THAT ENDS ON A USAGE LIMIT IS AN ACCOUNT LIMIT.
 *
 * The Claude CLI adapter (engine src/lib/agent-engine/claude-cli-adapter.js
 * handleResult) RESOLVES a limited turn and emits a turn_completed with status
 * 'error', the CLI's own sentence on `text`, and, when the CLI also sent
 * assistant.error, that code on `payload.code`. The shell's account-limit
 * verdict (`failureReason`) was added only on a REJECTED send, so this shape
 * left the host with no verdict, the New agent tab's queue kept sending into
 * the spent account, and the tree's limit fence never rose.
 *
 * The two shapes below are the engine's own measured fixtures, copied, not
 * invented:
 *   - tests/agent-engine/claude-cli-process.test.js ("a FAILED result's own
 *     sentence rides the completion event"): result is_error, api_error_status
 *     429, "You're out of usage credits · resets Aug 25, 12am"; text only.
 *   - tests/agent-engine/claude-cli-adapter-refusals.test.js
 *     (testSessionLimitCompletion): assistant.error 'rate_limit' with "You've
 *     reached your Fable limit · resets 12:40pm (America/Los_Angeles)", then a
 *     failed result; payload { code: 'rate_limit' }.
 * The ordinary failures are from the same files (testApiErrorIsNotAgentSpeech,
 * testModelRefusalIsMarked).
 *
 * Driven through the real host with a fake Claude adapter, and the host's own
 * packet is then handed to the real New agent tab and the real tree
 * coordinator. No provider is contacted and no credential is involved.
 *
 *   node --test tools/test/claude-usage-limit-hold.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createAgentHost } from '../../shell/agent-host.cjs'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { createAccountRecoveryCoordinator } from '../../src/account-recovery-coordinator.js'
import { createFleetTreeStore } from '../../src/fleet-trees.js'
import { createTranscriptStore } from '../../src/session-transcript-store.js'
import { createRecoveryHandoffStore } from '../../src/recovery-handoff-store.js'
import { LAUNCH_TIERS } from '../../src/orchestration-controls.js'

const require = createRequire(import.meta.url)
const ENGINE = path.resolve(import.meta.dirname, 'fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const CLAUDE_ENGINE = path.resolve(import.meta.dirname, 'fixtures/confined-engine/src/lib/agent-engine/claude-cli-process.js')
const engine = require(ENGINE)
const claudeEngine = require(CLAUDE_ENGINE)

const CLAUDE_LIMITS = {
  'out of usage credits (text only)': { status: 'error', text: "You're out of usage credits · resets Aug 25, 12am" },
  'model limit with rate_limit code': { status: 'error',
    text: "You've reached your Fable limit · resets 12:40pm (America/Los_Angeles)", payload: { code: 'rate_limit' } },
}
const CLAUDE_ORDINARY = {
  'server error': { status: 'error', text: 'API Error: 500 Internal server error' },
  /* 1.0.50 review of fixes, 3.5. The CLI (2.1.296) puts error 'rate_limit' on EVERY HTTP 429, and for one
     that is not a usage-limit response its sentence is this one. The code alone is not the account's limit. */
  'transient 429 with rate_limit code': { status: 'error',
    text: 'API Error: Request rejected (429) · this may be a temporary capacity issue.', payload: { code: 'rate_limit' } },
  'signed out': { status: 'error', text: 'Not logged in · Please run /login', payload: { code: 'authentication_failed' } },
  'model refused': { status: 'error',
    text: "There's an issue with the selected model (my-typed-model). It may not exist or you may not have access to it. Run /model to pick a different model.",
    payload: { failure: { provider: 'claude', source: 'turn', category: 'model-refused' } } },
  'provider refusal': { status: 'refusal' },
}
const settle = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

/* THE HOST'S OWN PACKET for one Claude turn that ends with `ending`. */
async function claudeTurnThroughHost(t, ending, { tier = 'claude-sonnet' } = {}) {
  const root = mkdtempSync(path.join(ownedFixtureTempRoot(), 'te-claude-limit-'))
  let onEvent = null
  let turn = 0
  const started = async options => {
    onEvent = options.onEvent
    return { threadId: 'thread-1', close() {}, adapter: {
      sendTurn: async () => ({ turnId: `turn-${++turn}` }),
      interrupt: async () => {},
      answerApproval() {},
    } }
  }
  t.mock.method(engine, 'startCodexSession', started)
  t.mock.method(claudeEngine, 'startClaudeSession', started)
  const host = createAgentHost({
    enginePath: ENGINE,
    defaultCwd: root,
    profileRoot: process.platform === 'win32' ? os.homedir() : path.parse(root).root,
    freeMemory: () => 64 * 1024 ** 3,
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
  })
  t.after(async () => { await host.closeAll(); rmSync(root, { recursive: true, force: true }) })
  const completions = []
  host.onEvent(packet => { if (packet.event?.type === 'turn_completed') completions.push(packet) })
  await host.startSession({ sessionId: 'claude-session', tier })
  const sent = await host.sendTurn({ sessionId: 'claude-session', text: 'continue' })
  assert.equal(sent.turnId, 'turn-1')
  onEvent({ type: 'turn_completed', threadId: 'thread-1', turnId: 'turn-1', ...ending })
  assert.equal(completions.length, 1, 'the host forwards exactly one completion')
  return completions[0]
}

/* The New agent tab, as agent-session-failure-details.test.mjs mounts it. */
async function mountTab(t) {
  const { document, restore } = installDomStandIn(globalThis)
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => key === 'mc.write.agent-session' ? 'enabled' : null,
    setItem() {}, removeItem() {},
  } })
  let dispose, control, listener, sessionId, sends = 0
  t.after(() => {
    dispose?.(); restore()
    if (prior) Object.defineProperty(globalThis, 'localStorage', prior)
    else delete globalThis.localStorage
  })
  const bridge = {
    availability: async () => ({ ok: true }),
    onEvent(fn) { listener = fn; return () => {} },
    async start(request) { sessionId = request.sessionId; return { ok: true, sessionId } },
    async send() { return { ok: true, turnId: `turn-${++sends}` } },
    async close() { return { ok: true } },
    interrupt: async () => ({ ok: true }),
  }
  const { mountAgentSessionSurface } = await import('../../src/agent-session.js')
  const root = document.createElement('div'); document.body.appendChild(root)
  dispose = mountAgentSessionSurface(root, { live: true, chatComposer: true,
    agentId: 'claude-limit-test', bridge, onController(value) { control = value } })
  await settle(0)
  assert.equal((await control.send('Bounded check.')).ok, true)
  const outbox = await import('../../src/session-outbox.js')
  t.after(() => outbox.clearSession(sessionId))
  return { control, outbox, sessionId: () => sessionId, sends: () => sends,
    /* The host's packet, delivered to this tab's session as the bridge would. */
    deliver: packet => listener({ sessionId, event: packet.event }) }
}

/* The tree's limit fence, as t124-account-limit-failover-loop.test.mjs builds it. */
function treeFence(t, { tier = 'claude-sonnet', provider = 'claude' } = {}) {
  const memory = () => {
    const cells = new Map()
    return { read: key => cells.has(key) ? structuredClone(cells.get(key)) : null,
      write: (key, value) => { cells.set(key, structuredClone(value)); return true } }
  }
  let serial = 0
  const treeStore = createFleetTreeStore({ computerId: 'local', storage: memory(), makeId: kind => `${kind}-${++serial}` })
  const add = args => { const result = treeStore.addNode(args); assert.equal(result.ok, true); return result.node }
  const controller = add({ role: 'controller', message: 'Run the work' })
  const worker = add({ parentId: controller.id, role: 'worker', message: 'Finish the task', tier })
  assert.equal(treeStore.attachSession(controller.id, 'controller-session').ok, true)
  assert.equal(treeStore.attachSession(worker.id, 'claude-session').ok, true)
  const transcriptStore = createTranscriptStore({ computerId: 'local', storage: memory() })
  assert.equal(transcriptStore.save(worker.id, { lines: [{ who: 'you', text: 'Finish the task', at: 1 }],
    threadId: 'thread-1', account: `${provider}-account`, provider }), true)
  const handoffStore = createRecoveryHandoffStore({ computerId: 'local', storage: memory(), bridge: null })
  const listeners = new Set()
  const notices = []
  const bridge = {
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async close(args) { return { sessionId: args.sessionId, closed: true } },
    async start() { return { ok: false, code: 'AGENT_ACCOUNT_LIMIT', reason: 'This account reached its limit.' } },
    async send() { return { ok: true } },
    async sendAutomatic(args) { notices.push(args); return { ok: true, deliveryDisposition: 'accepted', result: { ok: true } } },
    async updateTreeAddress() { return { ok: true } },
    async continuations() { return { ok: true, enabled: false, actionable: false, taskIds: [], records: [] } },
  }
  const sessionNodeIds = new Map([['claude-session', worker.id], ['controller-session', controller.id]])
  const coordinator = createAccountRecoveryCoordinator({ bridge, sessionNodeIds, tiers: LAUNCH_TIERS,
    canStart: () => true, canContinue: () => true, onCleanupRequired: () => {} })
  coordinator.register('local', { treeStore, handoffStore,
    transcriptStore: { ...transcriptStore, readLatest: async id => ({ ...transcriptStore.get(id), recoveryDirectory: '/owned/node-records' }) } })
  t.after(() => coordinator.destroy())
  return { treeStore, worker, notices,
    deliver: packet => { for (const listener of listeners) listener(packet) },
    block: () => coordinator.externalBlock(worker.id) }
}

for (const [label, ending] of Object.entries(CLAUDE_LIMITS)) {
  test(`the host marks Claude's usage-limit completion as an account limit (${label})`, async t => {
    const packet = await claudeTurnThroughHost(t, ending)
    assert.equal(packet.event.failureReason, 'account-limit', 'the shell gave no account-limit verdict for a Claude usage limit')
    assert.equal(packet.event.status, 'error', 'the provider status is carried unchanged')
    assert.equal(packet.event.text, ending.text, 'the provider sentence is carried unchanged')
    assert.deepEqual(packet.event.payload, ending.payload)
  })

  test(`a New agent tab holds its queue after Claude's usage limit (${label}), and the person's own message still goes`, async t => {
    const packet = await claudeTurnThroughHost(t, ending)
    const tab = await mountTab(t)
    tab.outbox.enqueue(tab.sessionId(), 'Synthetic queued follow-up.')
    tab.deliver(packet)
    await settle()
    assert.equal(tab.sends(), 1, 'the waiting message was sent into the spent Claude account')
    assert.equal(tab.outbox.list(tab.sessionId()).length, 1)
    assert.equal(tab.outbox.list(tab.sessionId())[0].heldReason, 'ACCOUNT_LIMIT_HELD', 'the row does not say why it waits')
    assert.equal((await tab.control.send('After the reset.')).ok, true, 'the person\'s own message is still taken')
    assert.equal(tab.sends(), 2)
    tab.deliver({ event: { type: 'turn_completed', turnId: 'turn-2', status: 'success' } })
    await settle()
    assert.equal(tab.sends(), 3, 'once a turn succeeds the waiting message goes')
    assert.equal(tab.outbox.list(tab.sessionId()).length, 0)
  })

  test(`the tree's limit fence rises on Claude's usage limit (${label})`, async t => {
    const packet = await claudeTurnThroughHost(t, ending)
    const tree = treeFence(t)
    tree.deliver(packet)
    await settle()
    assert.equal(tree.block()?.blocked, true, 'the tree kept delivering turns to the spent Claude account')
    assert.match(tree.treeStore.getNode(tree.worker.id).statusNote, /Usage limit reached/)
    assert.equal(tree.notices.length, 1, 'the manager is told once')
    assert.match(tree.notices[0].text, /Only the person can choose another account/)
  })
}

for (const [label, ending] of Object.entries(CLAUDE_ORDINARY)) {
  test(`an ordinary Claude ending is not an account limit (${label})`, async t => {
    const packet = await claudeTurnThroughHost(t, ending)
    assert.equal(Object.hasOwn(packet.event, 'failureReason'), false)
    const tree = treeFence(t)
    tree.deliver(packet)
    await settle()
    assert.equal(tree.block(), null, 'an ordinary failure raised the usage-limit fence')
  })
}

/* 1.0.50 review of fixes, 3.5: the one rule, read two ways. A rejected send
   (the host's own catch) still takes the code alone, as before; a turn the
   adapter resolved takes `rate_limit` only with the provider's limit sentence,
   and never with one that begins "API Error". */
test('a resolved turn with the rate_limit code is a limit only when the sentence says so', () => {
  const { limitReason, resolvedTurnLimitReason } = require('../../shell/account-session-recovery.cjs')
  const resolved = (text, code = 'rate_limit') => resolvedTurnLimitReason({ type: 'turn_completed', status: 'error', text, payload: { code } })
  assert.equal(resolved("You've reached your Fable limit · resets 12:40pm (America/Los_Angeles)"), 'account-limit')
  assert.equal(resolved("You're out of usage credits · resets Aug 25, 12am"), 'account-limit')
  assert.equal(resolved('API Error: Request rejected (429) · this may be a temporary capacity issue.'), null)
  assert.equal(resolved('API Error: 429 You have exceeded your usage limit'), null, 'an "API Error" sentence is never promoted on this code')
  assert.equal(resolved(''), null)
  assert.equal(resolved(undefined), null)
  // The other limit codes are not the generic 429 code and read as before.
  assert.equal(resolved('', 'usage_limit_reached'), 'account-limit')
  assert.equal(resolved('API Error: 429', 'insufficient_quota'), 'account-limit')
  // A rejected send still reads the code alone.
  assert.equal(limitReason({ type: 'turn_completed', status: 'failed', code: 'rate_limit', text: 'API Error: Request rejected (429)' }), 'account-limit')
  assert.equal(limitReason({ type: 'turn_completed', status: 'error', text: 'API Error: 429', payload: { code: 'rate_limit' } }), 'account-limit')
})

test('a New agent tab still sends its queue after a transient 429 that carries the rate_limit code', async t => {
  const packet = await claudeTurnThroughHost(t, CLAUDE_ORDINARY['transient 429 with rate_limit code'])
  assert.equal(Object.hasOwn(packet.event, 'failureReason'), false)
  assert.deepEqual(packet.event.payload, { code: 'rate_limit' }, 'the provider code is carried unchanged')
  const tab = await mountTab(t)
  tab.outbox.enqueue(tab.sessionId(), 'Synthetic queued follow-up.')
  tab.deliver(packet)
  await settle()
  assert.equal(tab.sends(), 2, 'the queue was held for a 429 that is not the account’s limit')
  assert.equal(tab.outbox.list(tab.sessionId()).length, 0)
})

test('a New agent tab still sends its queue after an ordinary Claude failure', async t => {
  const packet = await claudeTurnThroughHost(t, CLAUDE_ORDINARY['server error'])
  const tab = await mountTab(t)
  tab.outbox.enqueue(tab.sessionId(), 'Synthetic queued follow-up.')
  tab.deliver(packet)
  await settle()
  assert.equal(tab.sends(), 2)
  assert.equal(tab.outbox.list(tab.sessionId()).length, 0)
})

test('a successful Claude turn and Claude prose that mentions a limit are not marked', async t => {
  const packet = await claudeTurnThroughHost(t, { status: 'success' })
  assert.equal(Object.hasOwn(packet.event, 'failureReason'), false)
  const spoken = await claudeTurnThroughHost(t, { status: 'success', text: "You're out of usage credits · resets Aug 25, 12am" })
  assert.equal(Object.hasOwn(spoken.event, 'failureReason'), false, 'a successful turn is never a limit, whatever its words')
})

/* PLATFORM REVIEW FOLLOW-UP TO #2: A CODEX TURN THAT ENDS ON A USAGE LIMIT.
 *
 * The Codex adapter (engine src/lib/agent-engine/codex-adapter.js, turn/completed
 * with codexErrorInfo 'usageLimitExceeded') ends the turn as status 'failed' with
 * its own sentence and the data marker payload { limit: 'usage', resetsAt? }. It
 * carries no `code` and no sentence limitReason() reads as a limit, so the host
 * gave no verdict and the tree's limit fence never rose for a Codex agent in a
 * tree. The New agent tab already held its queue on `payload.limit`; the host's
 * verdict must not make it hold, notify or release twice.
 *
 * The shapes are the engine's own fixtures, copied, not invented:
 * tests/agent-engine/codex-turn-failure-details.test.js ("a recorded Codex
 * usage-limit ending carries its reset time ...", "... keeps the plain limit
 * sentence and invents no time", and the rateLimitExceeded / unauthorized /
 * contextWindowExceeded / sessionBudgetExceeded rows). */
const CODEX_LIMIT_WITH_RESET = 'This Codex account has reached its usage limit. The limit resets Sep 29, 2:13 AM. Until then, use Switch and continue to move this agent to another account. In a New agent tab, use Add to tree first.'
const CODEX_LIMIT_PLAIN = 'This Codex account has reached its usage limit. Wait for its allowance to reset, or use Switch and continue to move this agent to another account. In a New agent tab, use Add to tree first.'
const codexFailure = (code, summary) => ({ provider: 'codex', source: 'turn', code, summary })
const CODEX_LIMITS = {
  'usage limit with a reset time': { status: 'failed', text: CODEX_LIMIT_WITH_RESET,
    payload: { limit: 'usage', resetsAt: '2026-09-29T09:13:00.000Z', failure: codexFailure('usageLimitExceeded', CODEX_LIMIT_WITH_RESET) } },
  'usage limit without a reset time': { status: 'failed', text: CODEX_LIMIT_PLAIN,
    payload: { limit: 'usage', failure: codexFailure('usageLimitExceeded', CODEX_LIMIT_PLAIN) } },
}
const CODEX_ORDINARY = Object.fromEntries([
  ['rateLimitExceeded', 'Codex is temporarily rate limited. Wait before trying again.'],
  ['unauthorized', 'Codex could not authenticate this account. Check its sign-in.'],
  ['contextWindowExceeded', "This Codex conversation has reached the model's context limit."],
  ['sessionBudgetExceeded', 'This Codex session has reached its budget limit.'],
].map(([code, text]) => [code, { status: 'failed', text, payload: { failure: codexFailure(code, text) } }]))
const CODEX = { tier: 'terra' }
const CODEX_TREE = { tier: 'terra', provider: 'codex' }

for (const [label, ending] of Object.entries(CODEX_LIMITS)) {
  test(`the host marks Codex's usage-limit completion as an account limit (${label})`, async t => {
    const packet = await claudeTurnThroughHost(t, ending, CODEX)
    assert.equal(packet.event.failureReason, 'account-limit', 'the shell gave no account-limit verdict for a Codex usage limit')
    assert.equal(packet.event.status, 'failed', 'the provider status is carried unchanged')
    assert.equal(packet.event.text, ending.text, 'the engine sentence is carried unchanged')
    assert.deepEqual(packet.event.payload, ending.payload)
  })

  test(`a New agent tab holds its queue once after Codex's usage limit (${label}), and the person's own message still goes`, async t => {
    const packet = await claudeTurnThroughHost(t, ending, CODEX)
    const tab = await mountTab(t)
    tab.outbox.enqueue(tab.sessionId(), 'Synthetic queued follow-up.')
    tab.deliver(packet)
    await settle()
    assert.equal(tab.sends(), 1, 'the waiting message was sent into the spent Codex account')
    assert.equal(tab.outbox.list(tab.sessionId()).length, 1, 'the waiting message was duplicated or dropped')
    assert.equal(tab.outbox.list(tab.sessionId())[0].heldReason, 'ACCOUNT_LIMIT_HELD')
    assert.equal((await tab.control.send('After the reset.')).ok, true, 'the person\'s own message is still taken')
    assert.equal(tab.sends(), 2)
    tab.deliver({ event: { type: 'turn_completed', turnId: 'turn-2', status: 'success' } })
    await settle()
    assert.equal(tab.sends(), 3, 'once a turn succeeds the waiting message goes exactly once')
    assert.equal(tab.outbox.list(tab.sessionId()).length, 0)
  })

  test(`the tree's limit fence rises once on Codex's usage limit (${label})`, async t => {
    const packet = await claudeTurnThroughHost(t, ending, CODEX)
    const tree = treeFence(t, CODEX_TREE)
    tree.deliver(packet)
    await settle()
    assert.equal(tree.block()?.blocked, true, 'the tree kept delivering turns to the spent Codex account')
    assert.match(tree.treeStore.getNode(tree.worker.id).statusNote, /Usage limit reached/)
    assert.equal(tree.notices.length, 1, 'the manager is told once')
    assert.match(tree.notices[0].text, /Only the person can choose another account/)
  })
}

for (const [label, ending] of Object.entries(CODEX_ORDINARY)) {
  test(`an ordinary Codex ending is not an account limit (${label})`, async t => {
    const packet = await claudeTurnThroughHost(t, ending, CODEX)
    assert.equal(Object.hasOwn(packet.event, 'failureReason'), false)
    const tree = treeFence(t, CODEX_TREE)
    tree.deliver(packet)
    await settle()
    assert.equal(tree.block(), null, 'an ordinary failure raised the usage-limit fence')
  })
}

test('a completed Codex turn is never marked, whatever its payload says', async t => {
  const packet = await claudeTurnThroughHost(t, { status: 'completed', payload: { limit: 'usage' } }, CODEX)
  assert.equal(Object.hasOwn(packet.event, 'failureReason'), false)
})
