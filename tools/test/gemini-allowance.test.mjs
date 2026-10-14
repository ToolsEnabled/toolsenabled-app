import test from 'node:test'
import assert from 'node:assert/strict'
import { readAccountList, readUsageReply, mergeAccounts, accountBars, rowLines } from '../../src/account-switcher-state.js'

const now = Date.parse('2031-01-01T00:00:00Z')
const account = { name: 'Synthetic', provider: 'gemini', signedIn: 'yes', allowanceBinding: 'a'.repeat(64),
  authGeneration: { kind: 'file', token: 'b'.repeat(64) } }
const row = extra => ({ ...account, status: 'healthy', canServe: true, usageStatus: 'measured',
  readAt: new Date(now).toISOString(), windows: { hourly: null, weekly: null, weeklyWindows: [] }, ...extra })
const answer = accounts => ({ ok: true, readAt: new Date(now).toISOString(), accounts })
const merge = (usage, current = account) => mergeAccounts(readAccountList({ ok: true, accounts: [current] }), usage, { now })[0]
const windows = { hourly: { usedPercent: 42 }, weekly: { usedPercent: 38 }, weeklyWindows: [] }
const buckets = { schemaVersion: 1, provider: 'gemini', status: 'measured', buckets: [{ remainingFraction: 0.5 }] }

test('Gemini CLI allowance stays unknown when an older reply contains buckets, totals or period windows', () => {
  const result = merge(readUsageReply(answer([row({ allowanceBuckets: buckets, usedPercent: 42,
    reportedUsage: { usedPercent: 42, period: 'week' }, windows })])))
  assert.equal(result.allowanceBuckets, null)
  assert.equal(result.reportedUsage, null)
  assert.equal(result.measured, false)
  assert.equal(result.binding, null)
  assert.deepEqual(result.windows, { hourly: null, weekly: null, weeklyWindows: [] })
  assert.deepEqual(accountBars(result), [])
  assert.ok(rowLines(result).some(line => /Gemini allowance is unknown/i.test(line.text)))
})

test('cached Gemini CLI observations cannot establish current allowance or identity', () => {
  const list = readAccountList({ ok: true, accounts: [account],
    usageCache: answer([row({ allowanceBuckets: buckets, email: 'old@example.test', windows })]) })
  assert.equal(Object.keys(list.cachedUsage.readings).length, 0)
  const result = mergeAccounts(list, list.cachedUsage, { now })[0]
  assert.equal(result.measured, false)
  assert.equal(result.email, null)
  assert.deepEqual(accountBars(result), [])
})

test('Gemini Antigravity allowance reported by its official client still displays', () => {
  const current = { ...account, client: 'antigravity' }
  const usage = readUsageReply(answer([row({ client: 'antigravity', usageSource: 'antigravity-quota',
    windows: { hourly: null, weekly: { usedPercent: 38, resetsAt: '2031-01-02T00:00:00Z' }, weeklyWindows: [] } })]))
  const result = merge(usage, current)
  assert.equal(result.measured, true)
  assert.equal(result.windows.weekly.usedPercent, 38)
  assert.deepEqual(accountBars(result).filter(bar => bar.window).map(bar => bar.window.usedPercent), [38])
})

test('the retired bucket reply is ignored without inspecting its contents', () => {
  let inspected = 0
  const legacy = row({})
  Object.defineProperty(legacy, 'allowanceBuckets', { get() { inspected++; throw Error('must not inspect'); } })
  const result = merge(readUsageReply(answer([legacy])))
  assert.equal(inspected, 0)
  assert.equal(result.allowanceBuckets, null)
  assert.equal(result.measured, false)
})

test('the Gemini CLI bar display ignores old periods even without a prior merge', () => {
  assert.deepEqual(accountBars(row({ windows, allowanceBuckets: buckets })), [])
})
