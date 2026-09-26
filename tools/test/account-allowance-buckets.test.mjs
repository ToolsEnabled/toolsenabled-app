import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readAccountList, readUsageReply, mergeAccounts, accountBars, accountRoomLeft, loadUsage, allowanceBucketPercent } from '../../src/account-switcher-state.js'

// Exact shared Engine fixture, also packaged by the real capability packer.
// These examples contain no account data, credentials or provider requests.
const { normalizeAllowanceBuckets } = createRequire(import.meta.url)('../../capability/src/lib/usage/allowance-buckets.js')
const now = Date.parse('2031-01-01T00:00:00Z')
const generation = token => ({ kind: 'file', token: token.repeat(64) })
const account = { name: 'Synthetic', provider: 'gemini', signedIn: 'yes', allowanceBinding: 'a'.repeat(64), authGeneration: generation('b') }
const context = { provider: 'gemini', source: 'gemini-cli-core/retrieveUserQuota', sourceVersion: '0.58.0', observedAt: new Date(now).toISOString() }
const amount = '9007199254740993123456789.125'
const meter = { modelId: 'gemini-pro', tokenType: 'REQUESTS', remainingFraction: 0.375, remainingAmount: amount, resetsAt: '2031-01-02T01:02:03.123456789+02:00' }
const quota = buckets => normalizeAllowanceBuckets({ ...context, buckets })
const row = (allowanceBuckets, extra = {}) => ({ ...account, status: 'healthy', canServe: true, usageStatus: 'measured', readAt: context.observedAt,
  windows: { hourly: null, weekly: null, weeklyWindows: [] }, allowanceBuckets, ...extra })
const answer = accounts => ({ ok: true, readAt: context.observedAt, accounts, orders: [] })
const parse = (value, extra = {}) => readUsageReply(answer([row(value, extra)]))
const merge = (usage, current = account) => mergeAccounts(readAccountList({ ok: true, accounts: [current] }), usage, { now })[0]

test('canonical independent scopes survive reply, identity merge and display without invented totals or periods', () => {
  const value = quota([meter, { ...meter, tokenType: 'TOKENS', remainingFraction: 0, remainingAmount: '0' },
    { modelId: 'gemini-lite', tokenType: 'TOKENS', remainingAmount: '9007199254740993' }])
  const result = merge(parse(value))
  assert.deepEqual(result.allowanceBuckets, value)
  assert.equal(result.measured, true)
  assert.equal(result.binding, null)
  assert.equal(accountRoomLeft(result), null)
  const bars = accountBars(result, { now })
  assert.equal(bars.length, 3)
  assert.deepEqual(bars.map(bar => bar.bucket.remainingAmount), [amount, '0', '9007199254740993'])
  assert.equal(bars.some(bar => /5-hour|week|month/i.test(bar.label)), false)
  assert.equal(bars[2].bucket.remainingFraction, null)
})

test('canonical partial, conflicting, absent and malformed scopes retain their honest issues', () => {
  for (const buckets of [[], [{ remainingFraction: 0.4 }], [meter, { ...meter, remainingFraction: 0.2 }],
    [{ ...meter, modelId: '' }], [{ ...meter, resetsAt: '2031-02-30T00:00:00Z' }], [null], Array(257).fill(meter)]) {
    const value = quota(buckets)
    assert.deepEqual(merge(parse(value)).allowanceBuckets, value)
  }
  const unknown = merge(parse(quota([{ modelId: 'gemini-pro', tokenType: 'REQUESTS' }])))
  assert.equal(unknown.measured, false)
  assert.equal(accountBars(unknown, { now })[0].bucket.remainingFraction, null)
})

test('renderer rejects corrupt normalized metadata, fields, duplicate keys and accessor data without coercion', () => {
  const valid = quota([meter])
  const badBucket = override => ({ ...valid, buckets: [{ ...valid.buckets[0], ...override }] })
  let invoked = 0
  const accessor = { ...valid }
  Object.defineProperty(accessor, 'buckets', { get() { invoked++; throw Error('must not read'); } })
  for (const value of [{ ...valid, schemaVersion: 2 }, { ...valid, provider: 'claude' }, { ...valid, observedAt: '2031-02-30T00:00:00Z' },
    badBucket({ remainingFraction: '0.5' }), badBucket({ remainingFraction: 1.1 }), badBucket({ remainingAmount: 42 }),
    badBucket({ remainingAmount: '1e9' }), badBucket({ remainingAmount: '9'.repeat(129) }), badBucket({ key: 'mismatched scope' }),
    badBucket({ status: 'healthy' }), badBucket({ issues: ['invented_issue'] }), badBucket({ status: 'partial', issues: ['invalid_remainingFraction'] }),
    { ...valid, buckets: [...valid.buckets, ...valid.buckets] }, accessor]) {
    const result = merge(parse(value))
    assert.equal(result.measured, false)
    assert.equal(result.allowanceBuckets.status, 'unknown')
    assert.equal(result.allowanceBuckets.issues[0].code, 'invalid_reading')
    assert.equal(accountBars(result, { now }).length, 0)
  }
  assert.equal(invoked, 0)
})

test('untrusted extra fields cannot enter normalized display/cache data', () => {
  const value = quota([meter])
  const result = merge(parse({ ...value, private: 'synthetic-discard', buckets: [{ ...value.buckets[0], private: 'synthetic-discard' }] }))
  assert.equal(JSON.stringify(result.allowanceBuckets).includes('synthetic-discard'), false)
  assert.equal(Object.isFrozen(result.allowanceBuckets.buckets[0]), true)
})

test('valid decimal amounts stay exact at the bound and displayed fractions never round positive data to zero or full', () => {
  const value = quota([{ ...meter, remainingAmount: '9'.repeat(128) }])
  assert.equal(merge(parse(value)).allowanceBuckets.buckets[0].remainingAmount, '9'.repeat(128))
  assert.deepEqual([0, 0.000001, 0.123456789, 0.999999, 1].map(allowanceBucketPercent), ['0', '<0.1', '12.3', '>99.9', '100'])
})

test('only a same binding and file generation may show bucket data or keep an older failed reading', async () => {
  const previousUsage = parse(quota([meter]))
  const unavailable = extra => ({ mcProviders: { accounts: async () => ({ ok: true, accounts: [account] }), accountUsage: async () => answer([row(null, { usageStatus: 'unavailable', usageReason: 'Synthetic service failure', ...extra })]) } })
  const retained = await loadUsage(unavailable({}), { previousUsage })
  const result = merge(retained)
  assert.equal(result.usageState, 'failed')
  assert.equal(result.allowanceBuckets.buckets[0].remainingAmount, amount)
  assert.equal(result.usageReadAt, context.observedAt)
  for (const extra of [{ authGeneration: generation('c') }, { allowanceBinding: 'd'.repeat(64) }, { status: 'signed_out' }, { status: 'transient', usageCode: 'ACCOUNT_USAGE_AUTH_CHANGED' }]) {
    const denied = await loadUsage(unavailable(extra), { previousUsage })
    assert.equal(Object.values(denied.readings)[0].allowanceBuckets, null)
  }
  assert.equal(merge(previousUsage, { ...account, authGeneration: generation('c') }).allowanceBuckets, null)
  assert.equal(merge(previousUsage, { ...account, allowanceBinding: 'd'.repeat(64) }).allowanceBuckets, null)
})

test('an observed empty/unknown response replaces old buckets and never inherits a previous number', async () => {
  const previousUsage = parse(quota([meter]))
  for (const buckets of [[], [{ modelId: 'gemini-pro', tokenType: 'REQUESTS' }]]) {
    const value = quota(buckets)
    const usage = await loadUsage({ mcProviders: { accounts: async () => ({ ok: true, accounts: [account] }), accountUsage: async () => answer([row(value, { usageStatus: 'not_reported' })]) } }, { previousUsage })
    assert.deepEqual(merge(usage).allowanceBuckets, value)
    assert.equal(merge(usage).measured, false)
  }
})
