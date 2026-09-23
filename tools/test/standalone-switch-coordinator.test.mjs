import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createStandaloneSwitchCoordinator } = require('../../shell/standalone-switch-coordinator.cjs')
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture(overrides = {}) {
  const events = []
  let current = true
  const content = { history: ['earlier answer'], draft: { text: 'unsent', images: ['image-reference'] }, queue: ['q1', 'q2'] }
  const candidate = { sessionId: 'successor', provider: 'local', account: null, threadId: 'new-thread' }
  const history = { seatId: 'existing-seat', predecessor: 'source', successor: 'successor', content }
  const receipt = { applied: true, sourceSessionId: 'source', sessionId: 'successor',
    sourceDisposition: 'retired', provider: 'local', account: null, threadId: 'new-thread', tier: 'local', effort: 'medium' }
  const source = { sourceSessionId: 'source', revision: 2,
    assertCurrent() { events.push('check'); if (!current) throw Object.assign(new Error('Changed'), { code: 'SOURCE_CHANGED' }) },
    release() { events.push('release') },
  }
  const hooks = {
    claimSource(request, context) {
      events.push('claim')
      assert.equal(context.owner, 'owned-window')
      assert.equal(request.expectedRevision, 2)
      return { ...source, sourceSessionId: request.sourceSessionId }
    },
    async startCandidate({ source, target, signal }) {
      events.push('start'); assert.equal(source.sourceSessionId, 'source')
      assert.equal(target.account.mode, 'automatic'); assert.equal(signal.aborted, false)
      return candidate
    },
    async closeCandidate(value) { assert.equal(value, candidate); events.push('close-candidate') },
    async prepareHistory({ candidate: value }) { assert.equal(value, candidate); events.push('history'); return history },
    async rollbackHistory(value) { assert.equal(value, history); events.push('rollback-history') },
    async commitReplacement({ assertCurrent }) { events.push('commit'); assertCurrent(); return receipt },
    ...overrides,
  }
  const coordinator = createStandaloneSwitchCoordinator(hooks)
  const request = { sourceSessionId: 'source', expectedRevision: 2, target: { tier: 'local', account: { mode: 'automatic' } } }
  return { coordinator, request, events, candidate, history, receipt, content, source, hooks,
    stale() { current = false },
    prepare: () => coordinator.prepare(request, { owner: 'owned-window' }) }
}
test('prepare retains source, history, draft, queue and images without publishing; target is snapshotted', async () => {
  const h = fixture()
  const before = structuredClone(h.content)
  const handle = h.prepare()
  h.request.target.account.mode = 'exact'
  await handle.prepared
  assert.equal(handle.status().phase, 'prepared')
  assert.deepEqual(h.content, before)
  assert.ok(!h.events.includes('commit') && !h.events.includes('release') && !h.events.includes('close-candidate'))
  const result = await handle.cancel()
  assert.equal(result.cancelled, true)
  assert.deepEqual(h.content, before)
})
test('one source admits one claim until rollback releases it', async () => {
  const h = fixture(), first = h.prepare()
  assert.throws(() => h.prepare(), { code: 'AGENT_SWITCH_BUSY' })
  await first.cancel()
  const next = h.prepare()
  await next.cancel()
  assert.equal(h.events.filter(x => x === 'claim').length, 2)
})
test('cancelling before the first await starts no candidate', async () => {
  const h = fixture(), handle = h.prepare()
  await handle.cancel()
  await assert.rejects(handle.prepared, { code: 'AGENT_SWITCH_CANCELLED' })
  assert.ok(!h.events.includes('start'))
  assert.equal(h.events.filter(x => x === 'release').length, 1)
})
test('cancel during startup waits for retained candidate and closes it exactly once', async () => {
  const pending = deferred()
  const h = fixture({ startCandidate: () => pending.promise })
  const handle = h.prepare()
  await tick()
  const cancellation = handle.cancel()
  assert.ok(!h.events.includes('release'))
  pending.resolve(h.candidate)
  await cancellation
  assert.equal(h.events.filter(x => x === 'close-candidate').length, 1)
  assert.ok(!h.events.includes('history'))
})
test('stale source after startup refuses before preparing history', async () => {
  const pending = deferred(), h = fixture({ startCandidate: () => pending.promise })
  const handle = h.prepare()
  await tick(); h.stale(); pending.resolve(h.candidate)
  await assert.rejects(handle.prepared, { code: 'SOURCE_CHANGED' })
  assert.ok(h.events.includes('close-candidate'))
  assert.ok(!h.events.includes('history'))
})
test('stale source after history preparation rolls back only provisional linkage', async () => {
  const pending = deferred(), h = fixture({ prepareHistory: () => pending.promise })
  const before = structuredClone(h.content), handle = h.prepare()
  await tick(); h.stale(); pending.resolve(h.history)
  await assert.rejects(handle.prepared, { code: 'SOURCE_CHANGED' })
  assert.deepEqual(h.events.filter(x => ['close-candidate', 'rollback-history', 'release'].includes(x)),
    ['close-candidate', 'rollback-history', 'release'])
  assert.deepEqual(h.content, before)
})
test('cancel during history preparation waits for linkage before rolling back', async () => {
  const pending = deferred(), h = fixture({ prepareHistory: () => pending.promise }), handle = h.prepare()
  await tick()
  const cancellation = handle.cancel()
  assert.ok(!h.events.includes('close-candidate'))
  pending.resolve(h.history)
  await cancellation
  assert.ok(h.events.includes('rollback-history'))
})
test('commit returns immutable actual metadata once and cancellation cannot retire the successor', async () => {
  const h = fixture(), handle = h.prepare()
  const first = handle.commit(), second = handle.commit()
  assert.equal(first, second)
  const receipt = await first
  assert.deepEqual(receipt, h.receipt)
  assert.ok(Object.isFrozen(receipt))
  assert.equal(h.events.filter(x => x === 'commit').length, 1)
  assert.equal(handle.status().sourceDisposition, 'retired')
  assert.equal((await handle.cancel()).applied, true)
  assert.ok(!h.events.includes('close-candidate'))
})
test('commit rechecks the source after prepare before entering the irreversible hook', async () => {
  const h = fixture(), handle = h.prepare()
  await handle.prepared; h.stale()
  await assert.rejects(handle.commit(), { code: 'SOURCE_CHANGED' })
  assert.ok(!h.events.includes('commit'))
  assert.ok(h.events.includes('rollback-history'))
})
test('a thrown commit retains candidate and history with truthful uncertain disposition', async () => {
  const h = fixture({ commitReplacement: async () => { throw Object.assign(new Error('Source cleanup incomplete'), { sourceDisposition: 'closing' }) } })
  const handle = h.prepare()
  await assert.rejects(handle.commit(), { code: 'AGENT_SWITCH_OUTCOME_UNCERTAIN', sourceDisposition: 'closing' })
  assert.equal(handle.status().phase, 'cleanup-required')
  assert.equal(handle.status().sourceDisposition, 'closing')
  await assert.rejects(handle.cancel(), { code: 'AGENT_SWITCH_OUTCOME_UNCERTAIN' })
  assert.ok(!h.events.some(x => ['close-candidate', 'rollback-history', 'release'].includes(x)))
  assert.throws(() => h.prepare(), { code: 'AGENT_SWITCH_BUSY' })
})
test('proven unapplied commit rolls back and allows another claim', async () => {
  const h = fixture({ commitReplacement: async () => ({ applied: false, sourceDisposition: 'retained', code: 'NO_CAPACITY' }) })
  const handle = h.prepare()
  await assert.rejects(handle.commit(), { code: 'NO_CAPACITY' })
  assert.ok(h.events.includes('close-candidate') && h.events.includes('rollback-history'))
  await h.prepare().cancel()
})
for (const applied of [true, false]) test('cancel during commit waits for disposition: applied=' + applied, async () => {
  const pending = deferred(), h = fixture({ commitReplacement: () => pending.promise }), handle = h.prepare()
  const committing = handle.commit()
  await tick()
  const cancellation = handle.cancel()
  assert.equal(handle.status().phase, 'committing')
  assert.ok(!h.events.includes('close-candidate'))
  pending.resolve(applied ? h.receipt : { applied: false, sourceDisposition: 'retained' })
  if (applied) await committing
  else await assert.rejects(committing, { code: 'AGENT_SWITCH_NOT_APPLIED' })
  const result = await cancellation
  assert.equal(result.applied, applied)
  assert.equal(h.events.includes('close-candidate'), !applied)
})
test('failed candidate cleanup retains claim and history; explicit cancel retries', async () => {
  let calls = 0
  const h = fixture({ closeCandidate: async () => { if (++calls === 1) throw new Error('not closed') } })
  const handle = h.prepare()
  await handle.prepared; h.stale()
  await assert.rejects(handle.commit(), { code: 'AGENT_SWITCH_CLEANUP_REQUIRED' })
  assert.ok(!h.events.includes('rollback-history') && !h.events.includes('release'))
  await handle.cancel()
  assert.equal(calls, 2)
  assert.ok(h.events.includes('rollback-history') && h.events.includes('release'))
})
test('a false cleanup receipt is not proof of closure', async () => {
  const h = fixture({ closeCandidate: async () => ({ closed: false }) }), handle = h.prepare()
  await handle.prepared
  await assert.rejects(handle.cancel(), { code: 'AGENT_SWITCH_CLEANUP_REQUIRED' })
  assert.ok(!h.events.includes('release') && !h.events.includes('rollback-history'))
})
test('missing history binding refuses before commit and retains old conversation', async () => {
  const h = fixture({ prepareHistory: async () => null }), handle = h.prepare()
  await assert.rejects(handle.commit(), { code: 'AGENT_SWITCH_HISTORY_UNCONFIRMED' })
  assert.ok(!h.events.includes('commit'))
  assert.deepEqual(h.content.history, ['earlier answer'])
})
test('candidate identity equal to source never closes the original', async () => {
  const h = fixture({ startCandidate: async () => ({ sessionId: 'source' }) }), handle = h.prepare()
  await assert.rejects(handle.prepared, { code: 'AGENT_SWITCH_OUTCOME_UNCERTAIN' })
  assert.ok(!h.events.includes('close-candidate') && !h.events.includes('release'))
})
test('malformed applied receipt retains custody instead of rolling back an applied candidate', async () => {
  const h = fixture({ commitReplacement: async () => ({ applied: true, sessionId: 'unrelated' }) }), handle = h.prepare()
  await assert.rejects(handle.commit(), { code: 'AGENT_SWITCH_OUTCOME_UNCERTAIN' })
  assert.ok(!h.events.includes('close-candidate') && !h.events.includes('release'))
})
test('an explicit false source verdict refuses before starting', async () => {
  const h = fixture()
  h.source.assertCurrent = () => false
  const handle = h.prepare()
  await assert.rejects(handle.prepared, { code: 'AGENT_SWITCH_SOURCE_CHANGED' })
  assert.ok(!h.events.includes('start'))
})
test('source release failure reports applied receipt and never closes successor', async () => {
  const h = fixture()
  h.source.release = () => { throw new Error('lease retained') }
  const handle = h.prepare()
  await assert.rejects(handle.commit(), error => error.code === 'AGENT_SWITCH_CLAIM_RELEASE_FAILED' && error.applied === true && error.receipt.sessionId === 'successor')
  assert.equal(handle.status().phase, 'applied-cleanup-required')
  await assert.rejects(handle.cancel(), { code: 'AGENT_SWITCH_CLAIM_RELEASE_FAILED' })
  assert.ok(!h.events.includes('close-candidate'))
})

test('missing trusted hooks and missing source identity refuse before any work', () => {
  assert.throws(() => createStandaloneSwitchCoordinator({}), { code: 'AGENT_SWITCH_HOOK_INVALID' })
  const h = fixture()
  assert.throws(() => h.coordinator.prepare({}), { code: 'AGENT_SWITCH_INVALID' })
  assert.deepEqual(h.events, [])
})
test('a claim for another source is refused before candidate startup', () => {
  const h = fixture({ claimSource: () => ({ sourceSessionId: 'other', assertCurrent() {}, release() {} }) })
  assert.throws(() => h.prepare(), { code: 'AGENT_SWITCH_HOOK_INVALID' })
  assert.ok(!h.events.includes('start'))
})
test('asynchronous source validation is not an atomic claim check', async () => {
  const h = fixture()
  h.source.assertCurrent = () => Promise.resolve()
  await assert.rejects(h.prepare().prepared, { code: 'AGENT_SWITCH_HOOK_INVALID' })
  assert.ok(!h.events.includes('start'))
})
test('rollback refusal retains source claim and retries without closing candidate twice', async () => {
  let retries = 0
  const h = fixture({ rollbackHistory: async () => (++retries > 1 ? { ok: true } : { ok: false }) })
  const handle = h.prepare()
  await handle.prepared
  await assert.rejects(handle.cancel(), { code: 'AGENT_SWITCH_CLEANUP_REQUIRED' })
  assert.ok(!h.events.includes('release'))
  await handle.cancel()
  assert.equal(retries, 2)
  assert.equal(h.events.filter(x => x === 'close-candidate').length, 1)
})
test('applied false without proof source is retained is not permission to rollback', async () => {
  const h = fixture({ commitReplacement: async () => ({ applied: false, sourceDisposition: 'closing' }) })
  const handle = h.prepare()
  await assert.rejects(handle.commit(), { code: 'AGENT_SWITCH_OUTCOME_UNCERTAIN' })
  assert.ok(!h.events.includes('close-candidate') && !h.events.includes('rollback-history'))
})
test('unproven failed startup retains custody rather than releasing source', async () => {
  const h = fixture({ startCandidate: async () => { throw Object.assign(new Error('retained root'), { cleanupRequired: true }) } })
  const handle = h.prepare()
  await assert.rejects(handle.prepared, { code: 'AGENT_SWITCH_OUTCOME_UNCERTAIN' })
  await assert.rejects(handle.cancel(), { code: 'AGENT_SWITCH_OUTCOME_UNCERTAIN' })
  assert.ok(!h.events.includes('release'))
})

test('stale source refusal does not claim the original is still retained', async () => {
  const h = fixture(), handle = h.prepare()
  await handle.prepared
  h.stale()
  await assert.rejects(handle.commit(), { code: 'SOURCE_CHANGED' })
  assert.equal(handle.status().sourceDisposition, 'unknown')
})
test('status reconciles a lost applied commit reply with exact immutable receipt and revision', async () => {
  const h = fixture()
  h.hooks.claimSource = () => h.source
  const handle = h.prepare()
  await handle.commit()
  h.source.revision = 99
  h.candidate.sessionId = 'mutated-after-commit'
  h.receipt.threadId = 'mutated-hook-receipt'
  const status = handle.status()
  assert.equal(status.applied, true)
  assert.equal(status.phase, 'applied')
  assert.equal(status.sourceSessionId, 'source')
  assert.equal(status.candidateSessionId, 'successor')
  assert.equal(status.revision, 2)
  assert.equal(status.receipt.sessionId, 'successor')
  assert.equal(status.receipt.threadId, 'new-thread')
  assert.equal(status.receipt.account, null)
  assert.ok(Object.isFrozen(status) && Object.isFrozen(status.receipt))
  assert.throws(() => { status.receipt.account = 'other-account' }, TypeError)
})
test('applied cleanup failure status retains proven outcome for reconciliation', async () => {
  const h = fixture()
  h.source.release = () => { throw new Error('lease release failed') }
  const handle = h.prepare()
  await assert.rejects(handle.commit(), { code: 'AGENT_SWITCH_CLAIM_RELEASE_FAILED' })
  const status = handle.status()
  assert.equal(status.phase, 'applied-cleanup-required')
  assert.equal(status.applied, true)
  assert.deepEqual(status.receipt, h.receipt)
  assert.equal(status.revision, 2)
  assert.equal(status.code, 'AGENT_SWITCH_CLAIM_RELEASE_FAILED')
  assert.ok(Object.isFrozen(status.receipt))
})
test('uncertain commit status cannot advertise an applied receipt or invite blind retry', async () => {
  let calls = 0
  const h = fixture({ commitReplacement: async () => {
    calls++
    throw Object.assign(new Error('close unproven'), { sourceDisposition: 'closing' })
  } })
  const handle = h.prepare()
  await assert.rejects(handle.commit(), { code: 'AGENT_SWITCH_OUTCOME_UNCERTAIN' })
  const status = handle.status()
  assert.equal(status.phase, 'cleanup-required')
  assert.equal(status.applied, null)
  assert.equal('receipt' in status, false)
  assert.equal(status.sourceDisposition, 'closing')
  assert.equal(status.candidateSessionId, 'successor')
  assert.equal(status.sourceSessionId, 'source')
  assert.equal(status.revision, 2)
  assert.equal(status.code, 'AGENT_SWITCH_OUTCOME_UNCERTAIN')
  await assert.rejects(handle.commit(), { code: 'AGENT_SWITCH_OUTCOME_UNCERTAIN' })
  assert.equal(calls, 1)
})
test('status is indeterminate while commit is in flight and false only for proven unapplied work', async () => {
  const pending = deferred()
  const h = fixture({ commitReplacement: () => pending.promise }), handle = h.prepare()
  await handle.prepared
  assert.equal(handle.status().applied, false)
  const committing = handle.commit()
  await tick()
  assert.equal(handle.status().applied, null)
  assert.equal('receipt' in handle.status(), false)
  pending.resolve({ applied: false, sourceDisposition: 'retained' })
  await assert.rejects(committing, { code: 'AGENT_SWITCH_NOT_APPLIED' })
  assert.equal(handle.status().applied, false)
  assert.equal('receipt' in handle.status(), false)
})
