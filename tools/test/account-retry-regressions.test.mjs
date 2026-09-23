// Regressions for the 2026-09-10 adversarial review of Keep trying accounts /
// Wait for resets (findings R1-R7, R10, R11). Each test states the corrected
// behavior; each failed against fd49d8235c.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createAccountRecoveryCoordinator } from '../../src/account-recovery-coordinator.js'
import { createFleetTreeStore } from '../../src/fleet-trees.js'
import { createTranscriptStore } from '../../src/session-transcript-store.js'
import { createRecoveryHandoffStore } from '../../src/recovery-handoff-store.js'
import * as manual from '../../src/manual-account-continuation.js'
import { LAUNCH_TIERS } from '../../src/orchestration-controls.js'

function memoryStorage() {
  const cells = new Map()
  return {
    fail: false, writes: 0,
    read(key) { return cells.has(key) ? structuredClone(cells.get(key)) : null },
    write(key, value) { if (this.fail) return false; this.writes++; cells.set(key, structuredClone(value)); return true },
  }
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const settle = () => new Promise(resolve => setImmediate(resolve))
async function waitFor(check, label, rounds = 400) {
  for (let i = 0; i < rounds; i++) { if (check()) return; await settle() }
  assert.fail('timed out waiting for: ' + label)
}
function fixture(t, overrides = {}) {
  let serial = 0
  const treeStorage = memoryStorage(), transcriptStorage = memoryStorage(), handoffStorage = memoryStorage()
  const handoffStore = createRecoveryHandoffStore({ computerId: 'local', storage: handoffStorage, bridge: overrides.handoffBridge || null })
  const treeStore = createFleetTreeStore({ computerId: 'local', storage: treeStorage, makeId: kind => `${kind}-${++serial}` })
  const add = args => { const result = treeStore.addNode(args); assert.equal(result.ok, true); return result.node }
  const manager = add({ role: 'controller', message: 'Manage the work' })
  const node = add({ parentId: manager.id, role: 'worker', message: 'Finish the task', tier: overrides.nodeTier || 'claude-sonnet' })
  assert.equal(treeStore.attachSession(node.id, 'old-session').ok, true)
  treeStore.setNodeStatus(node.id, overrides.nodeStatus || 'turn-failed', overrides.nodeNote ? { note: overrides.nodeNote } : undefined)
  const transcriptStore = createTranscriptStore({ computerId: 'local', storage: transcriptStorage })
  assert.equal(transcriptStore.save(node.id, { lines: [{ who: 'you', text: 'Finish the task', at: 1 },
    { who: 'agent', text: 'The first step is complete.', at: 2 }], threadId: 'old-thread', account: 'old-account', provider: 'claude' }), true)
  const calls = { close: [], start: [], send: [], sendAutomatic: [], continuations: [], address: [] }
  const listeners = new Set()
  const bridge = {
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async close(args) { calls.close.push(args); return { sessionId: args.sessionId, closed: true } },
    async start(args) { calls.start.push(args); return overrides.start(args) },
    /* Recovery and escalation are automatic notices, not owner turns. The
       dedicated channel is required by 16cf5d642/b6b3102b3; retain generic
       send for the separate queued-turn behavior. */
    async send(args) { calls.send.push(args); return { ok: true } },
    async sendAutomatic(args) { calls.sendAutomatic.push(args); return { ok: true, deliveryDisposition: 'accepted', result: { ok: true } } },
    async updateTreeAddress(args) { calls.address.push(args); return overrides.updateTreeAddress ? overrides.updateTreeAddress(args) : { ok: true } },
    async continuations(args) { calls.continuations.push(args); return overrides.continuations ? overrides.continuations(args) : { ok: true, enabled: false, actionable: false, taskIds: [], records: [] } },
  }
  const sessionNodeIds = new Map([['old-session', node.id]])
  const coordinator = createAccountRecoveryCoordinator({ bridge, sessionNodeIds, ...overrides.retryOptions,
    onCleanupRequired: () => {}, canStart: () => true, canContinue: () => true })
  const transcripts = { ...transcriptStore, readLatest: async id => ({ ...transcriptStore.get(id), recoveryDirectory: '/owned/node-records' }) }
  coordinator.register('local', { treeStore, transcriptStore: transcripts, handoffStore })
  t.after(() => coordinator.destroy())
  return { coordinator, bridge, calls, treeStore, transcripts, handoffStore, handoffStorage, sessionNodeIds, node,
    emit: packet => { for (const listener of listeners) listener(packet) } }
}
const orgBridge = {
  read: async () => ({ ok: true, org: { revision: 2, agents: [{ id: 'worker-seat', role: 'worker', enabled: true }] }, roles: [{ id: 'worker', revision: 3 }] }),
  ensureSeat: async () => ({ ok: true, org: { revision: 4 } }),
}
const TIERS = [
  { id: 'claude-sonnet', provider: 'claude', label: 'Sonnet' },
  { id: 'astra', provider: 'codex', label: 'GPT-6-Astra', effort: 'max' },
  { id: 'grok-4-6', provider: 'grok', label: 'Grok 4.6', effort: 'xhigh' },
]
const options = ({ accounts, now, tiers = TIERS }) => ({ tiers, orgBridge, now, readAccounts: async () => ({ available: true, accounts }) })
const keepRequest = (f, extra = {}) => ({ computerId: 'local', nodeId: f.node.id, waitForReset: true,
  startOptions: { tier: 'claude-sonnet', effort: 'max', roleBinding: { agentId: 'worker-seat', id: 'worker', expectedOrgRevision: 2, expectedRoleRevision: 3 } }, ...extra })
const blocked = (provider, at) => ({ ok: false, code: 'ACCOUNT_RECOVERY_NO_ALTERNATE', reason: `${provider} has no eligible account.`,
  accountRetry: { provider, account: null, attempts: [], retry: { nextAttemptAt: new Date(at).toISOString(), resetAt: new Date(at - 1000).toISOString(), reason: 'observed-reset', allQuotaExhausted: true } } })

for (const [label, grokRefusal] of [
  ['expired Grok sign-in', { ok: false, code: 'ACP_AUTH_REQUIRED', reason: 'This assistant needs its official sign-in.',
    accountRetry: { provider: 'grok', account: 'g1', attempts: [{ account: 'g1', status: 'healthy' }], retry: { nextAttemptAt: null, resetAt: null, reason: 'account-action-required' } } }],
  ['Research-only tool surface', { ok: false, code: 'AGENT_ACP_REQUIRES_APP_TOOLS', reason: 'Gemini and Grok Research sessions need ToolsEnabled tools only.' }],
]) test(`R1 a provider-scoped refusal (${label}) skips that provider and keeps the observed reset wait`, async t => {
  let clock = Date.parse('2026-09-11T00:00:00Z')
  const claudeReset = clock + 2 * 3600e3, codexReset = clock + 3 * 3600e3
  const f = fixture(t, { retryOptions: options({ now: () => clock, accounts: [
    { name: 'old-account', provider: 'claude' }, { name: 'own-codex', provider: 'codex' }, { name: 'g1', provider: 'grok' }] }),
    start: request => request.tier === 'claude-sonnet' ? blocked('claude', claudeReset) : request.tier === 'astra' ? blocked('codex', codexReset) : grokRefusal })
  assert.equal(await f.coordinator.keepTryingAccounts(keepRequest(f, { allowedProviders: ['codex', 'claude', 'grok'] })), false)
  assert.deepEqual(f.calls.start.map(row => row.tier), ['claude-sonnet', 'astra', 'grok-4-6'])
  const policy = f.coordinator.retryPolicy(f.node.id)
  assert.equal(policy.state, 'waiting')
  assert.equal(policy.nextAttemptAt, claudeReset, 'the earliest observed reset survives a later provider refusal')
  clock = claudeReset + 60e3
  await f.coordinator.pollAccountRetries()
  await waitFor(() => f.calls.start.length > 3, 'retry at the Claude reset')
  assert.equal(f.calls.start[3].tier, 'claude-sonnet')
})

test('R2 a restart mid-sweep re-attempts; a transient pause auto-resumes (bounded) and never blocks native resume', async t => {
  const f = fixture(t, { retryOptions: options({ now: Date.now, accounts: [{ name: 'old-account', provider: 'claude' }, { name: 'next', provider: 'claude' }] }),
    start: () => new Promise(() => {}) })
  void f.coordinator.keepTryingAccounts(keepRequest(f, { allowedProviders: ['claude'] }))
  await waitFor(() => f.calls.start.length === 1, 'first start')
  assert.equal(f.handoffStore.get(f.node.id).retryPolicy.state, 'starting')
  const record = { key: 'c'.repeat(64), revision: 1, descriptor: { sessionId: 'old-session', resumeThreadId: 'old-thread', resumeThreadProvider: 'claude',
    requestKeys: { threadId: f.node.id, treeAnchors: [f.treeStore.getNode(f.node.id).parentId, f.node.id] } } }
  let clock = Date.now() + 86400e3
  const calls = []
  const bridge = { onEvent: () => () => {}, async close() { return { closed: true } }, async sendAutomatic() { return { ok: true, deliveryDisposition: 'accepted', result: { ok: true } } },
    async start(a) { calls.push(['start', a]); return { ok: false } },
    async continuations(a) { calls.push([a.action, a]); return a.action === 'read' ? { ok: true, enabled: true, records: [record] } : a.action === 'direction' ? { ok: true, enabled: true, actionable: true, taskIds: ['T1'] } : { ok: false } } }
  const reopened = createAccountRecoveryCoordinator({ bridge, sessionNodeIds: new Map(), canStart: () => true, canContinue: () => true,
    ...options({ now: () => clock, accounts: [{ name: 'old-account', provider: 'claude' }, { name: 'next', provider: 'claude' }] }) })
  t.after(() => reopened.destroy())
  reopened.register('local', { treeStore: f.treeStore, transcriptStore: f.transcripts, handoffStore: f.handoffStore })
  await waitFor(() => calls.some(row => row[0] === 'start') && !reopened.isRecovering(f.node.id), 'restart re-attempt')
  const afterAttempt = reopened.retryPolicy(f.node.id)
  assert.notEqual(afterAttempt.state, 'starting')
  assert.doesNotMatch(reopened.retryStatus(f.node.id), /Trying another signed-in account/)
  assert.equal(afterAttempt.state, 'paused'); assert.ok(Number.isFinite(afterAttempt.autoResumeAt), 'a one-off refusal re-checks itself')
  await reopened.pollContinuations(); await settle(); await settle()
  assert.ok(calls.some(row => row[0] === 'resume'), 'a paused retry does not block the Autonomous+ native resume')
  for (let i = 0; i < 12; i++) {
    clock += 40 * 60e3
    await reopened.pollAccountRetries()
    await waitFor(() => !reopened.isRecovering(f.node.id), 'auto resume ' + i)
  }
  assert.equal(calls.filter(row => row[0] === 'start').length, 6, 'one restart attempt plus five bounded automatic re-checks')
})

test('R3 quota-refused accounts stay on per-account backoff; unmeasured providers are capped', async t => {
  let clock = Date.parse('2026-09-11T00:00:00Z'), n = 0
  const grokAccounts = ['g1', 'g2'], okStarts = []
  const f = fixture(t, { retryOptions: options({ now: () => clock, accounts: [{ name: 'old-account', provider: 'claude' }, ...grokAccounts.map(name => ({ name, provider: 'grok' }))] }),
    start: request => {
      const free = grokAccounts.find(name => !request.accountRetry.excludeAccounts.includes(name))
      if (!free) return { ok: false, code: 'ACCOUNT_RECOVERY_NO_ALTERNATE', reason: 'The listed accounts have already been tried.', accountRetry: { provider: 'grok', account: null, attempts: [],
        retry: { nextAttemptAt: new Date(clock + Math.min(300000, 30000 * 2 ** Math.min(4, request.accountRetry.recheckAttempt))).toISOString(), resetAt: null, reason: 'status-recheck', allQuotaExhausted: false } } }
      okStarts.push(request.sessionId)
      return { ok: true, sessionId: request.sessionId, threadId: `grok-thread-${++n}`, account: free }
    } })
  let refused = 0
  const refuseStarted = async () => {
    for (let guard = 0; guard < 20; guard++) {
      await waitFor(() => !f.coordinator.isRecovering(f.node.id), 'flight settles')
      if (refused >= okStarts.length) return
      const sessionId = okStarts[refused++]
      f.emit({ sessionId, event: { type: 'turn_completed', status: 'failed', code: 'ACP_RATE_LIMITED', turnId: `turn-${refused}` } })
      for (let i = 0; i < 5; i++) await settle()
    }
  }
  assert.equal(await f.coordinator.keepTryingAccounts(keepRequest(f, { allowedProviders: ['grok'] })), true)
  await refuseStarted()
  assert.equal(f.calls.sendAutomatic.length, 2)
  const sendsAt = []
  for (let minute = 5; minute <= 48 * 60; minute += 5) {
    clock += 5 * 60e3
    await f.coordinator.pollAccountRetries()
    await refuseStarted()
    sendsAt.push(f.calls.sendAutomatic.length)
    if (minute === 25) assert.equal(f.calls.sendAutomatic.length, 2, 'rechecks inside the 30 minute hold dispatch nothing')
  }
  assert.ok(f.calls.sendAutomatic.length <= 2 * 6, `each unmeasured account is capped; handoffs sent: ${f.calls.sendAutomatic.length}`)
  assert.equal(sendsAt.at(-1), sendsAt[sendsAt.length - 12 * 24 - 1] ?? sendsAt.at(-1), 'no dispatch in the final 24 hours once capped')
})

test('R4 Stop never waits on storage; a failed write leaves retries off and warns; a second Stop works', async t => {
  const f = fixture(t, { retryOptions: options({ now: Date.now, accounts: [{ name: 'old-account', provider: 'claude' }] }), start: () => ({ ok: false }), nodeStatus: 'running' })
  assert.equal(await f.coordinator.keepTryingAccounts(keepRequest(f)), true)
  f.handoffStorage.fail = true
  await f.coordinator.stopContinuation(f.node.id)
  assert.equal(f.coordinator.retryPolicy(f.node.id).enabled, false)
  await waitFor(() => /could not be saved/.test(f.coordinator.retryStatus(f.node.id)), 'visible persistence warning')
  await f.coordinator.stopContinuation(f.node.id)
  await f.coordinator.pollAccountRetries(); await settle()
  assert.equal(f.calls.start.length, 0)
})

test('R5 a quota-failed turn is open work, and no-direction polls back off without rewriting the record', async t => {
  const f = fixture(t, { retryOptions: options({ now: Date.now, accounts: [{ name: 'old-account', provider: 'claude' }, { name: 'next', provider: 'claude' }] }),
    start: request => ({ ok: true, sessionId: request.sessionId, threadId: 'next-thread', account: 'next' }), nodeStatus: 'running',
    continuations: request => request.action === 'direction' ? { ok: true, enabled: true, actionable: false, taskIds: [], reason: 'no-actionable-ledger-work' } : { ok: true, enabled: true, records: [] } })
  assert.equal(await f.coordinator.keepTryingAccounts(keepRequest(f)), true)
  f.emit({ sessionId: 'old-session', event: { type: 'turn_completed', status: 'failed', code: 'rate_limit_exceeded', turnId: 'quota-turn' } })
  await waitFor(() => f.calls.start.length === 1 && !f.coordinator.isRecovering(f.node.id), 'retry of the failed turn')
  assert.equal(f.calls.continuations.filter(row => row.action === 'direction').length, 0, 'the failed turn needs no ledger task to be retried')
  // A retry with no failed turn asks for direction, backing off and writing only on change.
  let clock = Date.now()
  const g = fixture(t, { retryOptions: options({ now: () => clock, accounts: [{ name: 'old-account', provider: 'claude' }] }), start: () => ({ ok: false }), nodeStatus: 'finished',
    continuations: request => request.action === 'direction' ? { ok: true, enabled: true, actionable: false, taskIds: [] } : { ok: true, enabled: true, records: [] } })
  assert.equal(await g.coordinator.keepTryingAccounts(keepRequest(g)), true)
  const saved = g.handoffStore.get(g.node.id)
  g.handoffStorage.write(`mc.agent-recovery.v1:local:${encodeURIComponent(g.node.id)}`, { ...saved, retryPolicy: { ...saved.retryPolicy, state: 'no-direction' } })
  g.coordinator.destroy()
  const reopened = createAccountRecoveryCoordinator({ bridge: g.bridge, sessionNodeIds: new Map(), canStart: () => true, canContinue: () => true,
    ...options({ now: () => clock, accounts: [{ name: 'old-account', provider: 'claude' }] }) })
  t.after(() => reopened.destroy())
  const writesBefore = g.handoffStorage.writes, queriesBefore = g.calls.continuations.filter(row => row.action === 'direction').length
  reopened.register('local', { treeStore: g.treeStore, transcriptStore: g.transcripts, handoffStore: g.handoffStore })
  for (let i = 0; i < 10; i++) { await settle(); await settle(); await reopened.pollAccountRetries(); await waitFor(() => !reopened.isRecovering(g.node.id), 'poll'); clock += 5000 }
  const queries = g.calls.continuations.filter(row => row.action === 'direction').length - queriesBefore
  assert.ok(queries >= 1 && queries <= 5, `direction queries back off: ${queries}`)
  assert.ok(g.handoffStorage.writes - writesBefore <= 1, `unchanged no-direction state is not rewritten: ${g.handoffStorage.writes - writesBefore}`)
})

test('R6 typed Antigravity results are classified: a limit retries, a generic turn error does not', async t => {
  for (const [code, retried] of [['AGY_CLI_RATE_LIMITED', true], ['AGY_CLI_TURN_ERROR', false]]) {
    const f = fixture(t, { retryOptions: options({ now: Date.now, accounts: [{ name: 'old-account', provider: 'claude' }, { name: 'own-codex', provider: 'codex' }] }),
      start: request => ({ ok: true, sessionId: request.sessionId, threadId: 'replacement', account: 'own-codex' }), nodeStatus: 'running' })
    assert.equal(await f.coordinator.keepTryingAccounts(keepRequest(f)), true)
    f.emit({ sessionId: 'old-session', event: { type: 'turn_completed', turnId: 'agy-turn', status: 'failed', code } })
    for (let i = 0; i < 30; i++) await settle()
    assert.equal(f.calls.start.length > 0, retried, code)
  }
})

for (const cancelVia of ['Cancel retries', 'coordinator teardown']) test(`R7 a cancel after attach (${cancelVia}) closes the replacement`, async t => {
  const records = new Map()
  let saveGate = null
  const addressGate = deferred()
  const handoffBridge = {
    async save({ nodeId, record }) { if (saveGate) await saveGate.promise; records.set(nodeId, structuredClone(record)); return { ok: true } },
    async get({ nodeId }) { return { ok: true, authoritative: true, record: records.has(nodeId) ? structuredClone(records.get(nodeId)) : null } },
  }
  const f = fixture(t, { handoffBridge, retryOptions: options({ now: Date.now, accounts: [{ name: 'old-account', provider: 'claude' }, { name: 'next', provider: 'claude' }] }),
    start: request => ({ ok: true, sessionId: request.sessionId, threadId: 'late-thread', account: 'next' }),
    updateTreeAddress: () => addressGate.promise.then(() => ({ ok: true })) })
  const attempt = f.coordinator.keepTryingAccounts(keepRequest(f, { allowedProviders: ['claude'] }))
  await waitFor(() => f.calls.address.length === 1, 'replacement attached')
  const replacement = f.calls.start[0].sessionId
  assert.equal(f.treeStore.getNode(f.node.id).sessionId, replacement)
  saveGate = deferred()
  const cancelling = cancelVia === 'Cancel retries' ? f.coordinator.cancelAccountRetries(f.node.id) : (f.coordinator.destroy(), Promise.resolve(true))
  addressGate.resolve()
  assert.equal(await attempt, false)
  saveGate.resolve()
  await cancelling
  await waitFor(() => f.calls.close.some(row => row.sessionId === replacement), 'replacement closed')
  assert.equal(f.calls.sendAutomatic.length, 0)
})

test('R10 Keep trying on a stopped or idle agent reports honestly and is not silently undone', async t => {
  const stopped = fixture(t, { retryOptions: options({ now: Date.now, accounts: [{ name: 'old-account', provider: 'claude' }] }), start: () => ({ ok: false }),
    nodeStatus: 'finished', nodeNote: 'Stopped by you.' })
  assert.equal(await stopped.coordinator.keepTryingAccounts(keepRequest(stopped)), true)
  await stopped.coordinator.pollAccountRetries(); await settle()
  assert.equal(stopped.coordinator.retryPolicy(stopped.node.id).enabled, true, 'an explicit opt-in is not undone by the old Stop note')
  assert.match(stopped.coordinator.retryStatus(stopped.node.id), /stopped this agent/)
  assert.doesNotMatch(stopped.coordinator.retryStatus(stopped.node.id), /is working/)
  assert.equal(stopped.calls.start.length, 0)
  const idle = fixture(t, { retryOptions: options({ now: Date.now, accounts: [{ name: 'old-account', provider: 'claude' }] }), start: () => ({ ok: false }), nodeStatus: 'finished' })
  assert.equal(await idle.coordinator.keepTryingAccounts(keepRequest(idle)), true)
  assert.match(idle.coordinator.retryStatus(idle.node.id), /idle/)
  assert.doesNotMatch(idle.coordinator.retryStatus(idle.node.id), /is working/)
})

test('R11 owner intent: Codex stands in on Claude Opus at max, Gemini/Grok are opt-in, Claude tries Claude first', async t => {
  const accounts = [{ name: 'own-codex', provider: 'codex' }, { name: 'opus-account', provider: 'claude' }, { name: 'g1', provider: 'grok' }, { name: 'agy', provider: 'gemini', client: 'antigravity' }]
  assert.deepEqual(manual.accountRetryCandidates('astra', LAUNCH_TIERS, accounts).slice(0, 2), ['astra', 'claude-opus'])
  assert.deepEqual(manual.accountRetryCandidates('claude-sonnet', LAUNCH_TIERS, accounts).slice(0, 2), ['claude-sonnet', 'astra'])
  assert.equal(typeof manual.defaultRetryProviders, 'function')
  assert.deepEqual(manual.defaultRetryProviders('codex'), ['codex', 'claude'])
  assert.deepEqual(manual.defaultRetryProviders('claude'), ['codex', 'claude'])
  assert.deepEqual(manual.defaultRetryProviders('grok'), ['codex', 'claude', 'grok'])
  const source = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
  assert.match(source, /data-retry-provider value="\$\{id\}"\$\{defaultRetryProviders\(/, 'Page 2 checks Gemini/Grok only for agents already on them')
  const f = fixture(t, { retryOptions: options({ now: Date.now, tiers: LAUNCH_TIERS, accounts: [{ name: 'own-codex', provider: 'codex' }, { name: 'opus-account', provider: 'claude' }] }),
    start: request => request.tier === 'astra' ? blocked('codex', Date.now() + 86400e3) : { ok: true, sessionId: request.sessionId, threadId: 'opus-thread', account: 'opus-account', effort: request.effort } })
  assert.equal(await f.coordinator.keepTryingAccounts(keepRequest(f, { startOptions: { ...keepRequest(f).startOptions, tier: 'astra', effort: 'max' } })), true)
  assert.deepEqual(f.calls.start.map(row => [row.tier, row.effort]), [['astra', 'max'], ['claude-opus', 'max']])
  const g = fixture(t, { retryOptions: options({ now: Date.now, tiers: LAUNCH_TIERS, accounts }), start: () => ({ ok: false }), nodeStatus: 'finished' })
  await g.coordinator.keepTryingAccounts(keepRequest(g))
  assert.deepEqual(g.coordinator.retryPolicy(g.node.id).allowedProviders, ['codex', 'claude'], 'a Claude worker does not fall back to Gemini/Grok by default')
})
