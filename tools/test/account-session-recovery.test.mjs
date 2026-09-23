import assert from 'node:assert/strict'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { lstatSync, realpathSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { canonicalRootForTests } from '../canonical-root.mjs'
import { tmpdir } from 'node:os'
const require = createRequire(import.meta.url)
const { limitReason, createRecoveryState, rememberRecoveryText, recoveryHandoff, createRecoveryTickets } = require('../../shell/account-session-recovery.cjs')
// These recording engines start no provider process. Real machine pressure
// must not prevent the account-recovery cases from reaching their subject.
// agent-memory-admission and agent-resource-wiring cover admission separately.
const TEST_FREE_MEMORY = () => 64 * 1024 * 1024 * 1024
// The native fixture may use only the current owner's validated temp. Check the
// complete parent chain before creation and the final directory before removal.
const SCRATCH_PARENT = ownedFixtureTempRoot()
function admitScratchDirectory(directory) {
 if (process.platform !== 'win32') return directory
 const normalized = path.win32.resolve(directory)
 const parent = SCRATCH_PARENT.toLowerCase()
 assert.ok(normalized.toLowerCase() === parent || normalized.toLowerCase().startsWith(parent + '\\'),
  'fixture scratch must be inside the validated owner temp before any path inspection')
 let cursor = path.win32.parse(normalized).root
 for (const segment of path.win32.relative(cursor, normalized).split('\\')) {
  cursor = path.win32.join(cursor, segment)
  const entry = lstatSync(cursor)
  assert.ok(entry.isDirectory() && !entry.isSymbolicLink(), 'fixture scratch parents must be ordinary directories')
 }
 const finalPath = path.win32.normalize(realpathSync.native(normalized)).replace(/^\\\\\?\\/, '')
 assert.equal(finalPath.toLowerCase(), normalized.toLowerCase(), 'fixture scratch must not resolve through a path alias')
 return normalized
}
function createScratch(prefix) {
 admitScratchDirectory(SCRATCH_PARENT)
 return admitScratchDirectory(mkdtempSync(path.join(SCRATCH_PARENT, prefix)))
}
function removeScratch(directory) {
 admitScratchDirectory(directory)
 rmSync(directory, { recursive: true, force: true })
}
const failure = { type: 'turn_completed', status: 'failed', text: "You've hit your limit. Please try again later." }
function session(id = 'old', excluded = []) {
 const recovery = createRecoveryState(); recovery.excluded = excluded
 rememberRecoveryText(recovery, 'person', 'Build the installer; preserve existing files.')
 rememberRecoveryText(recovery, 'assistant', 'Tests passed; installer build remains.')
 return { sessionId: id, provider: 'claude', account: { name: 'primary' }, treeIdentity: { selfName: 'Builder', managerName: 'Controller' }, treeNodeKey: 'node-42', recovery }
}
test('classifies provider limits, not transient failures or assistant prose', () => {
 assert.equal(limitReason(failure), 'account-limit')
 assert.equal(limitReason({ type: 'turn_completed', status: 'failed', code: 'ACP_RATE_LIMITED' }), 'account-limit')
 assert.equal(limitReason({ ...failure, text: "You've hit your session limit. Resets at 12:40pm." }), 'account-limit')
 assert.equal(limitReason({ ...failure, text: 'Session limit reached. Try again after the reset.' }), 'account-limit')
 assert.equal(limitReason({ ...failure, text: 'Prompt is too long: context window exceeded' }), 'context-limit')
 for (const text of ['Network error', 'Request timed out', 'HTTP 429 retry later', 'Account is signed out', 'Tool token limit documentation']) assert.equal(limitReason({ ...failure, text }), null)
 assert.equal(limitReason({ ...failure, type: 'assistant_text_delta' }), null)
 assert.equal(limitReason({ ...failure, status: 'completed' }), null)
})
test('default off offers nothing; enabling recovers observed failure exactly once', () => {
 let enabled = false; const tickets = createRecoveryTickets({ enabled: () => enabled }); const old = session()
 assert.equal(tickets.offer(old, failure), null)
 enabled = true
 const event = tickets.offer(old, old.recovery.failure)
 assert.equal(event.reason, 'account-limit'); assert.deepEqual(event.excludedAccounts, ['primary'])
 assert.match(event.handoff, /Build the installer/); assert.match(event.handoff, /build remains/)
 assert.equal(tickets.offer(old, failure), null); assert.equal(tickets.pending().length, 1)
 enabled = false; assert.deepEqual(tickets.pending(), [])
 assert.throws(() => tickets.claim(event.recoveryId, { sessionId: 'new', replacesSessionId: 'old', provider: 'claude', nodeKey: 'node-42' }), { code: 'AGENT_ACCOUNT_RECOVERY_UNAVAILABLE' })
})
test('ticket survives predecessor close, prevents duplicate spawn and preserves a failed retry', () => {
 const tickets = createRecoveryTickets({ enabled: () => true }); const old = session(); const event = tickets.offer(old, failure)
 old.closeRequested = true
 const request = { sessionId: 'new', replacesSessionId: 'old', provider: 'claude', nodeKey: 'node-42' }
 for (const bad of [{ provider: 'codex' }, { nodeKey: 'other' }, { replacesSessionId: 'other' }]) assert.throws(() => tickets.claim(event.recoveryId, { ...request, ...bad }))
 const first = tickets.claim(event.recoveryId, request)
 assert.throws(() => tickets.claim(event.recoveryId, { ...request, sessionId: 'duplicate' }))
 tickets.settle(first, false)
 const second = tickets.claim(event.recoveryId, { ...request, sessionId: 'retry' })
 tickets.settle(second, true)
 assert.throws(() => tickets.claim(event.recoveryId, request)); assert.deepEqual(tickets.pending(), [])
})
test('lineage never reuses prior accounts and cannot retry indefinitely', () => {
 const tickets = createRecoveryTickets({ enabled: () => true })
 assert.deepEqual(tickets.offer(session('next', ['backup']), failure).excludedAccounts, ['backup', 'primary'])
 assert.equal(tickets.offer(session('end', Array.from({ length: 8 }, (_, i) => 'a' + i)), failure), null)
})
test('handoff memory and serialized context stay bounded during long streams', () => {
 const state = createRecoveryState(); rememberRecoveryText(state, 'person', 'ORIGINAL ' + 'a'.repeat(200000))
 for (let i = 0; i < 20000; i++) rememberRecoveryText(state, 'assistant', 'small delta')
 rememberRecoveryText(state, 'assistant', 'LATEST WORK')
 const handoff = recoveryHandoff(state)
 assert.ok(handoff.length <= 48000); assert.match(handoff, /ORIGINAL/); assert.match(handoff, /LATEST WORK/)
 assert.ok(state.segments.length < 5000)
})


for (const failureText of ["You've hit your limit", "You've hit your session limit. Resets at 12:40pm."]) test(`host limit rejection offers a ticket and fresh recovery selects another account: ${failureText}`, async t => {
 const cwd = createScratch('recovery-host-')
 const enginePath = require.resolve('./fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
 const engine = require(enginePath); let starts = 0
 t.mock.method(engine, 'startCodexSession', async () => { starts++; return {
   threadId: 'thread-' + starts, close() {}, adapter: { interrupt() {}, sendTurn: async () => { throw new Error(failureText) } }
 } })
 const { createAgentHost } = require('../../shell/agent-host.cjs')
 const selections = []; let stale = false; let enabled = true
 const host = createAgentHost({ enginePath, defaultCwd: cwd, freeMemory: TEST_FREE_MEMORY,
   confinementPlanner: ({ account } = {}) => ({ account: account?.name || null, ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
   recoveryEnabled: () => enabled,
   accountResolver: async request => { selections.push(request); return { rotated: true, account: { name: !request.excludeAccounts || stale ? 'primary' : 'backup', provider: 'codex' } } },
 })
 try {
  const packets = []; host.onEvent(packet => packets.push(packet))
  const identity = { requestKeys: { treeAnchors: ['root-node', 'node-42'], threadId: 'node-42' }, treeIdentity: { selfName: 'Builder', managerName: 'Controller' } }
  await host.startSession({ sessionId: 'original', ...identity })
  await assert.rejects(host.sendTurn({ sessionId: 'original', text: 'Finish the installer' }), /hit your (?:session )?limit/)
  await new Promise(resolve => setImmediate(resolve))
  const offer = packets.find(packet => packet.event.type === 'account_recovery_needed')
  assert.ok(offer); assert.equal(offer.sessionId, 'original'); assert.equal(offer.event.nodeId, 'node-42')
  assert.match(offer.event.handoff, /Finish the installer/)
  enabled = false
  await assert.rejects(host.closeSession({ sessionId: 'original', accountRecovery: { recoveryId: offer.event.recoveryId } }), { code: 'AGENT_ACCOUNT_RECOVERY_UNAVAILABLE' })
  assert.ok(host.sessionAccounts().some(row => row.sessionId === 'original'), 'turning recovery off must leave the original session open')
  enabled = true
  await host.closeSession({ sessionId: 'original', accountRecovery: { recoveryId: offer.event.recoveryId } })
  stale = true
  const recovery = { ...identity, replacesSessionId: 'original', accountRecovery: { recoveryId: offer.event.recoveryId } }
  await assert.rejects(host.startSession({ sessionId: 'refused', ...recovery }), { code: 'AGENT_ACCOUNT_RECOVERY_NO_ALTERNATE' })
  assert.equal(starts, 1, 'a stale resolver must not spawn on the exhausted account')
  stale = false
  const result = await host.startSession({ sessionId: 'replacement', ...recovery })
  assert.equal(result.account, 'backup'); assert.equal(starts, 2)
  assert.deepEqual(selections.at(-1).excludeAccounts, ['primary'])
  await assert.rejects(host.startSession({ sessionId: 'duplicate', ...recovery }), { code: 'AGENT_ACCOUNT_RECOVERY_UNAVAILABLE' })
  assert.equal(starts, 2)
 } finally { await host.closeAll(); removeScratch(cwd) }
})


test('an explicit new turn invalidates stale recovery and failed setting reads stay off', () => {
 const tickets = createRecoveryTickets({ enabled: () => true }); const old = session(); const offer = tickets.offer(old, failure)
 tickets.newTurn(old)
 assert.deepEqual(tickets.pending(), []); assert.equal(old.recovery.failure, null)
 assert.throws(() => tickets.claim(offer.recoveryId, { sessionId: 'late', replacesSessionId: 'old', provider: 'claude', nodeKey: 'node-42' }))
 const unavailable = createRecoveryTickets({ enabled: () => { throw new Error('settings unreadable') } })
 assert.equal(unavailable.offer(session(), failure), null)
})


test('main uses automatic backup traversal only for a recovery under manual account selection', async () => {
 const { readFileSync } = require('node:fs')
 const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
 const at = main.indexOf('async function resolveSessionAccount('); const end = main.indexOf('\n}', at)
 assert.ok(at > 0 && end > at)
 const calls = []; let mode = 'manual'
 const resolve = new Function('loadRotation', 'selectionPolicyFromRegistry', 'resolveServicesRootForAccounts', 'ACCOUNT_HOME_DIR', 'PROVIDER_ISOLATION_REQUESTED', 'ACCOUNT_REGISTRY_FILE',
  main.slice(at, end + 2) + '; return resolveSessionAccount;')(
  () => ({ resolveAccountForSession: async args => { calls.push(args); return { rotated: true } } }),
  () => ({ selectionMode: mode }), () => 'services-root', 'owner-home', false, 'fixture-account-registry')
 await resolve({ provider: 'claude' })
 assert.equal(calls.at(-1).selectionMode, 'manual')
 await resolve({ provider: 'claude', excludeAccounts: ['exhausted-original'] })
 assert.equal(calls.at(-1).selectionMode, 'priority'); assert.deepEqual(calls.at(-1).excludeAccounts, ['exhausted-original'])
 await resolve({ provider: 'claude', preferred: 'saved-owner', exact: true })
 assert.equal(calls.at(-1).selectionMode, 'manual'); assert.equal(calls.at(-1).preferred, 'saved-owner')
 mode = 'most-room'
 await resolve({ provider: 'claude', excludeAccounts: ['exhausted-original'] })
 assert.equal(calls.at(-1).selectionMode, 'most-room')
})

test('a bug inside the account resolver surfaces instead of reading as an unchecked account', async () => {
 const { readFileSync } = require('node:fs')
 const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
 const at = main.indexOf('async function resolveSessionAccount('); const end = main.indexOf('\n}', at)
 assert.ok(at > 0 && end > at)
 const slice = main.slice(at, end + 2) + '; return resolveSessionAccount;'
 /* ACCOUNT_REGISTRY_FILE is left unbound on purpose. A private start reads it, so
    the resolver's own code throws a ReferenceError: the shape of a real bug. */
 const broken = new Function('loadRotation', 'selectionPolicyFromRegistry', 'resolveServicesRootForAccounts', 'ACCOUNT_HOME_DIR',
  'PROVIDER_ISOLATION_REQUESTED', slice)(
  () => ({ resolveAccountForSession: async () => ({ rotated: true }) }), () => null, () => 'services-root', 'owner-home', true)
 await assert.rejects(broken({ provider: 'claude' }), error => error instanceof ReferenceError,
  'a ReferenceError in the resolver was reported as an account that could not be checked')
 /* A real failed account read keeps the generic refusal and does not repeat its private detail. */
 const failing = new Function('loadRotation', 'selectionPolicyFromRegistry', 'resolveServicesRootForAccounts', 'ACCOUNT_HOME_DIR',
  'PROVIDER_ISOLATION_REQUESTED', 'ACCOUNT_REGISTRY_FILE', slice)(
  () => ({ resolveAccountForSession: async () => { throw Object.assign(new Error('private read failure'), { code: 'EIO' }) } }),
  () => null, () => 'services-root', 'owner-home', true, 'registry')
 await assert.rejects(failing({ provider: 'claude' }),
  error => error.code === 'AGENT_ACCOUNT_UNAVAILABLE' && !error.message.includes('private read failure'))
})


test('exact resume preserves original-account limit and sign-in classifications before any provider spawn', async t => {
 const cwd = createScratch('resume-reason-')
 const enginePath = require.resolve('./fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
 const engine = require(enginePath); let starts = 0; let status = 'exhausted'
 t.mock.method(engine, 'resumeCodexSession', async () => { starts++; throw new Error('must not spawn') })
 const { createAgentHost } = require('../../shell/agent-host.cjs')
 const host = createAgentHost({ enginePath, defaultCwd: cwd, freeMemory: TEST_FREE_MEMORY,
  confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
  accountResolver: async () => ({ rotated: false, blocked: true, code: 'ACCOUNT_EXHAUSTED_MANUAL',
    attempts: [{ account: 'different-account', status: 'exhausted' }, { account: 'primary', status }] }),
 })
 try {
  for (const [state, code] of [['exhausted', 'AGENT_RESUME_ACCOUNT_LIMIT'], ['signed_out', 'AGENT_RESUME_ACCOUNT_SIGNED_OUT'], ['not_provisioned', 'AGENT_RESUME_ACCOUNT_SIGNED_OUT'], ['transient', 'AGENT_RESUME_ACCOUNT_UNAVAILABLE']]) {
   status = state
   await assert.rejects(host.startSession({ sessionId: 'resume-' + state, resumeThreadId: 'saved-provider-thread', resumeAccount: 'primary' }), error => error.code === code && error.message.length < 300)
  }
  assert.equal(starts, 0)
 } finally { await host.closeAll(); removeScratch(cwd) }
})

test('resume account-limit refusal leaves the running predecessor intact before replacement teardown', async t => {
 const cwd = createScratch('resume-replacement-limit-')
 const enginePath = require.resolve('./fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
 const engine = require(enginePath); let starts = 0; let closes = 0; let blocked = false
 t.mock.method(engine, 'startCodexSession', async () => {
  starts++
  return { threadId: 'old-thread', close() { closes++ }, adapter: { sendTurn: async () => ({ turnId: 't' }), interrupt() {} } }
 })
 t.mock.method(engine, 'resumeCodexSession', async () => {
  starts++
  return { threadId: 'replacement-thread', close() { closes++ }, adapter: { sendTurn: async () => ({ turnId: 't2' }), interrupt() {} } }
 })
 const { createAgentHost } = require('../../shell/agent-host.cjs')
 const identity = { treeIdentity: { selfName: 'Worker', managerName: 'Controller' }, requestKeys: { treeAnchors: ['root', 'node-42'], threadId: 'node-42' } }
 const host = createAgentHost({ enginePath, defaultCwd: cwd, freeMemory: TEST_FREE_MEMORY,
  confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
  accountResolver: async () => blocked
   ? ({ rotated: false, blocked: true, code: 'ACCOUNT_EXHAUSTED_MANUAL', attempts: [{ account: 'primary', status: 'exhausted' }] })
   : ({ rotated: true, account: { name: 'primary', provider: 'codex' } }),
 })
 try {
  await host.startSession({ sessionId: 'old', ...identity })
  assert.equal(starts, 1)
  blocked = true
  await assert.rejects(host.startSession({ sessionId: 'replacement', resumeThreadId: 'saved-provider-thread', resumeAccount: 'primary', replacesSessionId: 'old', ...identity }),
   { code: 'AGENT_RESUME_ACCOUNT_LIMIT' })
  assert.equal(starts, 1, 'account refusal must not dispatch a replacement provider')
  assert.equal(closes, 0, 'account refusal must not close the running predecessor')
  assert.ok(host.sessionAccounts().some(row => row.sessionId === 'old'), 'the original session remains running after refusal')
  blocked = false
  await host.startSession({ sessionId: 'replacement', resumeThreadId: 'saved-provider-thread', resumeAccount: 'primary', replacesSessionId: 'old', ...identity })
  assert.equal(starts, 2, 'an admitted replacement starts exactly one provider')
  assert.equal(closes, 1, 'an admitted replacement closes exactly one predecessor')
  assert.ok(!host.sessionAccounts().some(row => row.sessionId === 'old'), 'the predecessor is retired only after replacement admission')
  assert.ok(host.sessionAccounts().some(row => row.sessionId === 'replacement'))
 } finally { await host.closeAll(); removeScratch(cwd) }
})

test('explicit continuation uses a fresh alternate session with automatic recovery off and fails closed on a stale selection', async t => {
 const cwd = createScratch('manual-backup-')
 const enginePath = require.resolve('./fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
 const engine = require(enginePath); let starts = 0; let selected = 'primary'; let provider = 'codex'; const choices = []
 t.mock.method(engine, 'startCodexSession', async () => { starts++; return { threadId: 'fresh-thread', close() {}, adapter: { sendTurn: async () => ({ turnId: 't' }), interrupt() {} } } })
 t.mock.method(engine, 'resumeCodexSession', async () => { throw new Error('must not resume an account-bound thread') })
 const { createAgentHost } = require('../../shell/agent-host.cjs')
 const host = createAgentHost({ enginePath, defaultCwd: cwd, freeMemory: TEST_FREE_MEMORY, recoveryEnabled: () => false,
  confinementPlanner: ({ account } = {}) => ({ account: account?.name || null, ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
  accountResolver: async request => { choices.push(request); return { rotated: true, account: { name: selected, provider } } },
 })
 const request = { continueFromAccount: 'primary', replacesSessionId: 'old-not-in-host',
  treeIdentity: { selfName: 'Controller', managerName: null }, requestKeys: { treeAnchors: ['same-root-node'], threadId: 'same-root-node' } }
 try {
  await assert.rejects(host.startSession({ sessionId: 'same-account', ...request }), { code: 'AGENT_ACCOUNT_RECOVERY_NO_ALTERNATE' })
  assert.equal(starts, 0, 'the excluded original account must not spawn')
  selected = 'backup'; provider = 'claude'
  // Provider validation is shared and precedes continuation-specific exclusions.
  await assert.rejects(host.startSession({ sessionId: 'wrong-provider', ...request }), { code: 'AGENT_ACCOUNT_UNAVAILABLE' })
  assert.equal(starts, 0, 'a different provider must not spawn or fall back')
  provider = 'codex'
  const result = await host.startSession({ sessionId: 'new-manual', ...request })
  assert.equal(result.account, 'backup'); assert.equal(result.threadId, 'fresh-thread'); assert.equal(starts, 1)
  assert.deepEqual(choices.at(-1), { provider: 'codex', excludeAccounts: ['primary'] })
  assert.throws(() => host.startSession({ sessionId: 'illegal-resume', ...request, resumeThreadId: 'old-thread' }), { code: 'AGENT_HOST_INVALID_ARGUMENT' })
  assert.equal(host.pendingAccountRecoveries().length, 0)
 } finally { await host.closeAll(); removeScratch(cwd) }
})

test('persistent account selection preserves reset facts, fails closed without an eligible named account and starts no provider', async t => {
 const cwd = createScratch('persistent-account-host-')
 const enginePath = require.resolve('./fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
 const engine = require(enginePath)
 let starts = 0, selected
 t.mock.method(engine, 'startCodexSession', async () => { starts++; throw new Error('must not start') })
 const { createAgentHost } = require('../../shell/agent-host.cjs')
 const retry = { nextAttemptAt: '2026-09-11T01:00:00Z', resetAt: null, reason: 'status-recheck', allQuotaExhausted: false, exhaustedCount: 0, unmeasuredCount: 0 }
 const host = createAgentHost({ enginePath, defaultCwd: cwd, freeMemory: TEST_FREE_MEMORY,
   confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
   accountResolver: async request => { selected = request; return { rotated: false, blocked: true, code: 'ACCOUNT_RECOVERY_NO_ALTERNATE',
     reason: 'No eligible account now.', retry, attempts: [], credential: 'must-not-cross', home: '/must-not-cross' } },
 })
 try {
  const request = { sessionId: 'persistent-retry', accountRetry: { excludeAccounts: ['old'], recheckAttempt: 4 },
    requestKeys: { threadId: 'node-42', treeAnchors: ['root-node', 'node-42'] }, treeIdentity: { selfName: 'Worker', managerName: 'Controller' } }
  await assert.rejects(host.startSession(request), error => {
    assert.equal(error.code, 'ACCOUNT_RECOVERY_NO_ALTERNATE')
    assert.deepEqual(error.accountRetry, { provider: 'codex', account: null, attempts: [], retry })
    assert.equal(JSON.stringify(error.accountRetry).includes('must-not-cross'), false)
    return true
  })
  assert.equal(selected.keepTryingAccounts, true)
  assert.equal(selected.recheckAttempt, 4)
  assert.deepEqual(selected.excludeAccounts, ['old'])
  await assert.rejects(host.startSession({ ...request, sessionId: 'opus-retry', tier: 'claude-opus' }),
    { code: 'ACCOUNT_RECOVERY_NO_ALTERNATE' })
  assert.equal(selected.provider, 'claude')
  assert.equal(selected.model, 'claude/opus', 'account admission must receive the exact app model identifier')
  // Drive the actual paired engine with the value produced by this host.
  // Testing the two halves with different model spellings missed the LIVE bug.
  const { claudeAllowanceFromReading } = require(path.join(canonicalRootForTests(), 'src/lib/multi-account/rotation.js'))
  const reading = { status: 'MEASURED', limits: [
    { kind: 'weekly_all', group: 'weekly', percent: 97, isActive: false },
    { kind: 'weekly_scoped', group: 'weekly', percent: 100, isActive: true, model: 'Fable' },
  ] }
  const allowance = claudeAllowanceFromReading(reading, { model: selected.model, exhaustedAtPercent: 100 })
  assert.equal(allowance.usedPercent, 97)
  assert.equal(allowance.exhausted, false)
  reading.limits[0].percent = 100
  assert.equal(claudeAllowanceFromReading(reading, { model: selected.model, exhaustedAtPercent: 100 }).exhausted, true)
  assert.deepEqual(selected.excludeAccounts, ['old'])
  assert.equal(starts, 0)
  assert.equal(host.sessionAccounts().length, 0, 'refused startup completed real host cleanup')
  assert.throws(() => host.startSession({ ...request, sessionId: 'not-a-resume', resumeThreadId: 'native-original' }))
  assert.equal(starts, 0)
 } finally { await host.closeAll(); removeScratch(cwd) }
})

/* THE ATTRIBUTION LEAVES THE HOST ON THE REFUSAL, OR NOT AT ALL.
 *
 * ABSENT FIRST. A probe that predates exhaustedBy says nothing, and the refusal
 * must then say nothing either -- not 'provider', not 'configured'. Everything
 * downstream treats a missing answer as "leave this conversation alone", so a
 * default invented here would defeat that at the source. */
test('a resume limit refusal carries the measured attribution, and carries nothing when the probe did not say', async t => {
 const cwd = createScratch('resume-attribution-')
 const enginePath = require.resolve('./fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
 const engine = require(enginePath)
 t.mock.method(engine, 'resumeCodexSession', async () => { throw new Error('must not spawn') })
 const { createAgentHost } = require('../../shell/agent-host.cjs')
 let measured = null
 const host = createAgentHost({ enginePath, defaultCwd: cwd, freeMemory: TEST_FREE_MEMORY,
  confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
  accountResolver: async () => ({ rotated: false, blocked: true, code: 'ACCOUNT_EXHAUSTED_MANUAL',
   attempts: [{ account: 'primary', status: 'exhausted', ...measured }] }),
 })
 const refusalFor = async id => {
  let thrown = null
  await host.startSession({ sessionId: id, resumeThreadId: 'saved-provider-thread', resumeAccount: 'primary' })
   .then(() => { throw new Error('the resume should have been refused') }, error => { thrown = error })
  return thrown
 }
 try {
  // 1. THE PROBE DID NOT SAY. No attribution may appear.
  measured = null
  const silent = await refusalFor('resume-silent')
  assert.equal(silent.code, 'AGENT_RESUME_ACCOUNT_LIMIT')
  assert.equal('exhaustedBy' in silent, false, 'an unmeasured limit must not acquire an attribution')

  // 2. THE PROVIDER REFUSED IT, measured. The fact travels verbatim.
  measured = { exhaustedBy: 'provider', exhaustedLimit: 100 }
  const provider = await refusalFor('resume-provider')
  assert.equal(provider.code, 'AGENT_RESUME_ACCOUNT_LIMIT')
  assert.equal(provider.exhaustedBy, 'provider')

  // 3. AND A VALUE THIS CONTRACT DOES NOT NAME IS DROPPED, not passed through:
  // the refusal is an allowlist, never a way for an arbitrary field to leave.
  measured = { exhaustedBy: 'something-else' }
  const junk = await refusalFor('resume-junk')
  assert.equal('exhaustedBy' in junk, false)
 } finally { await host.closeAll(); removeScratch(cwd) }
})
