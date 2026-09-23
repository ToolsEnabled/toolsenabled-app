import { canonicalRootForTests } from '../canonical-root.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSpawnRecorder } from '../../shell/spawn-record.cjs'
import { createUsageRecorder, turnUsageFrom, usageLabel } from '../../shell/usage-record.cjs'
import { validateMetricsQuery } from '../../shell/metrics-record-query.cjs'
import { readMetricsRecords } from '../../src/metrics-records.js'
import { metricsPeriod } from '../../src/metrics-period.js'
import { liveWindow, tokenBands } from '../../src/metrics-live-charts.js'

const A = `account:${'a'.repeat(32)}`, B = `account:${'b'.repeat(32)}`
const NOW = Date.UTC(2026, 8, 8, 5, 55), DAY = 86400000
const safeStorage = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: buffer => buffer.toString() }
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'metrics-records-'))
  t.after(() => {
    if (process.env.TOOLSENABLED_TEST_RETAIN_FIXTURES === '1') t.diagnostic(`RETAINED_METRICS_FIXTURE ${directory}`)
    else rmSync(directory, { recursive: true, force: true })
  })
  let at = NOW, principal = A
  const now = () => new Date(at).toISOString()
  const runs = createSpawnRecorder({ directory, safeStorage, now })
  const usage = createUsageRecorder({ directory, safeStorage, now })
  const agent = {
    history: ({ limit, metrics }) => runs.historyAsync({ limit, metrics: { ...metrics, principal } }),
    usage: ({ limit, metrics }) => usage.usageAsync({ limit, metrics: { ...metrics, principal } }),
  }
  return { directory, runs, usage, agent, setAt: value => { at = value }, setPrincipal: value => { principal = value } }
}

test('explicit computer scope pages all recorded principals, survives reopen, and leaves ledger bytes unchanged', async t => {
  const f = fixture(t)
  for (let index = 0; index < 425; index++) {
    const principal = [A, B, 'unauthenticated', null][index % 4]
    f.setAt(NOW - (index % 29) * DAY)
    const sessionId = `computer-${index}`
    const start = f.runs.record({ action: 'agent_session_start', sessionId, principal, details: { cwd: 'private-computer-path' } })
    f.runs.record({ action: 'agent_session_outcome', sessionId, principal, outcome: { resolves: start.sequence, result: 'started' } })
    f.usage.recordTurn({ sessionId, principal, tier: 'luna', account: 'fixture-seat', status: 'completed', usage: { totalTokens: 10, basis: 'turn' } })
  }
  const bytes = readFileSync(f.runs.ledgerPath)
  const window = liveWindow('30d', NOW)
  const account = await readMetricsRecords({ agent: f.agent, window })
  assert.equal(account.sessions.runs.length, 107, 'default account isolation remains unchanged')
  const result = await readMetricsRecords({ agent: f.agent, window, scope: 'computer' })
  assert.equal(result.scope, 'computer')
  assert.equal(result.principal, A, 'scope does not replace trusted session identity')
  assert.equal(result.sessions.runs.length, 425)
  assert.equal(result.usage.turns.length, 425)
  assert.equal(result.sessions.verified, true)
  assert.equal(result.usage.verified, true)
  const reopened = createSpawnRecorder({ directory: f.directory, safeStorage })
  const page = await reopened.historyAsync({ limit: 200, metrics: { fromMs: window.startMs, toMs: window.endMs, principal: A, scope: 'computer' } })
  assert.equal(page.metrics.count, 425)
  assert.equal(page.metrics.scope, 'computer')
  assert.doesNotMatch(JSON.stringify(page), /private-computer-path|eventHash|signature/)
  assert.deepEqual(readFileSync(f.runs.ledgerPath), bytes, 'scope reads never rewrite original attribution')
  f.setPrincipal('unauthenticated')
  assert.equal((await readMetricsRecords({ agent: f.agent, window, scope: 'computer' })).sessions.runs.length, 425)
})

test('computer requests refuse an old host or mixed scope replies instead of silently returning an account subset', async t => {
  const f = fixture(t), window = liveWindow('30d', NOW)
  const old = { history: async () => ({ ok: false, code: 'METRICS_QUERY_INVALID' }), usage: async () => ({ ok: false, code: 'METRICS_QUERY_INVALID' }) }
  const unsupported = await readMetricsRecords({ agent: old, window, scope: 'computer' })
  assert.equal(unsupported.needsUpdate, true)
  assert.equal(unsupported.sessions.readable, false)
  const bad = await readMetricsRecords({ window, scope: 'computer', agent: { history: async request => {
    const result = await f.agent.history(request); result.metrics.scope = 'account'; return result
  }, usage: f.agent.usage } })
  assert.equal(bad.sessions.readable, false)
  const wrongScope = await readMetricsRecords({ window, agent: { history: request => f.agent.history({ ...request, metrics: { ...request.metrics, scope: 'computer' } }), usage: f.agent.usage } })
  assert.equal(wrongScope.sessions.readable, false)
})

test('Metrics reads beyond the 200-line tail, reopens on disk, and isolates each account', async t => {
  const f = fixture(t)
  for (let index = 0; index < 425; index++) {
    const principal = index % 3 === 0 ? B : A
    f.setAt(NOW - (index % 29) * DAY)
    const start = f.runs.record({ action: 'agent_session_start', sessionId: `s-${index}`, principal, details: { cwd: 'private-install-exclusion-sentinel' } })
    f.runs.record({ action: 'agent_session_outcome', sessionId: `s-${index}`, principal, outcome: { resolves: start.sequence, result: index % 2 ? 'started' : 'refused' } })
    f.usage.recordTurn({ sessionId: `s-${index}`, principal, tier: 'luna', account: 'test-seat', status: 'completed', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, basis: 'turn' } })
  }
  f.setAt(NOW + DAY)
  f.runs.record({ action: 'agent_session_start', sessionId: 'future', principal: A })
  f.setAt(NOW - 40 * DAY)
  f.runs.record({ action: 'agent_session_start', sessionId: 'too-old', principal: A })
  f.setAt(NOW)
  f.runs.record({ action: 'agent_session_start', sessionId: 'unowned', principal: null })
  const window = liveWindow('30d', NOW)
  const result = await readMetricsRecords({ agent: f.agent, window })
  assert.equal(result.sessions.readable, true)
  assert.equal(result.sessions.runs.length, 283)
  assert.equal(result.sessions.total, 283)
  assert.equal(result.sessions.verified, true)
  assert.equal(result.usage.turns.length, 283)
  for (const range of ['24h', '7d', '30d']) {
    const selected = liveWindow(range, NOW)
    const period = metricsPeriod({ ...result, conversations: null }, selected)
    const expected = Array.from({ length: 425 }, (_, i) => i).filter(i => i % 3 !== 0 && NOW - (i % 29) * DAY >= selected.startMs).length
    assert.equal(period.runs.length, expected)
    assert.equal(period.turns.length, expected)
    assert.equal(period.tokens, expected * 15)
    assert.equal(period.local.usage.byModel.rows[0].tokens, expected * 15)
    assert.equal(period.local.usage.byAccount.rows[0].tokens, expected * 15)
    assert.equal(tokenBands(result.usage.turns, selected).total, expected * 15)
    assert.equal(period.local.runs.rows.length, expected, 'history must not stop at 40 runs')
  }
  const reopened = createSpawnRecorder({ directory: f.directory, safeStorage })
  const page = await reopened.historyAsync({ limit: 200, metrics: { fromMs: window.startMs, toMs: window.endMs, principal: A } })
  assert.equal(page.metrics.count, 283)
  assert.doesNotMatch(JSON.stringify(page), /private-install-exclusion-sentinel|details|eventHash|signature/)
  assert.ok(readFileSync(reopened.ledgerPath, 'utf8').includes('private-install-exclusion-sentinel'), 'privacy check must have a positive control')
  f.setPrincipal(B)
  const second = await readMetricsRecords({ agent: f.agent, window })
  assert.equal(second.sessions.runs.length, 142)
  assert.equal(second.usage.turns.length, 142)
  assert.equal(second.sessions.runs.some(run => result.sessions.runs.some(other => other.sessionId === run.sessionId)), false)
})

test('a page keeps matching start/outcome pairs across interleaving and sign-in changes', async t => {
  const f = fixture(t)
  const start = f.runs.record({ action: 'agent_session_start', sessionId: 'owned', principal: A })
  f.runs.record({ action: 'agent_session_outcome', sessionId: 'somebody-else', principal: B, outcome: { resolves: start.sequence, result: 'refused' } })
  f.runs.record({ action: 'agent_session_outcome', sessionId: 'owned', principal: B, outcome: { resolves: start.sequence, result: 'started' } })
  const result = await readMetricsRecords({ agent: f.agent, window: liveWindow('30d', NOW) })
  assert.equal(result.sessions.runs[0].result, 'started')
  assert.equal(result.sessions.started, 1)
  assert.equal(result.sessions.refused, 0)
})

test('legacy replies and an account change between records never become a complete reading', async t => {
  const window = liveWindow('30d', NOW)
  const old = await readMetricsRecords({ window, agent: { history: async () => ({ ok: true, entries: [], total: 900 }), usage: async () => ({ ok: true, entries: [], total: 100 }) } })
  assert.equal(old.sessions.readable, false)
  assert.equal(old.needsUpdate, true)
  const f = fixture(t)
  const agent = { history: f.agent.history, usage: async request => { f.setPrincipal(B); return f.agent.usage(request) } }
  const changed = await readMetricsRecords({ agent, window })
  assert.equal(changed.sessions.readable, false)
  assert.equal(changed.usage.readable, false)
})

test('the old running main-process rejection requests an update instead of presenting its 200-row tail as complete', async () => {
  const result = await readMetricsRecords({ window: liveWindow('30d', NOW), agent: {
    history: async () => { throw new Error('Unexpected agent IPC field: metrics') },
    usage: async () => { throw new Error('Unexpected agent IPC field: metrics') },
  } })
  assert.equal(result.needsUpdate, true)
  assert.equal(result.sessions.readable, false)
  assert.equal(result.usage.readable, false)
})

test('the client cannot select an account, widen beyond 32 days, or reuse a backwards cursor', () => {
  const query = { fromMs: NOW - DAY, toMs: NOW }
  assert.equal(validateMetricsQuery(query), true)
  assert.equal(validateMetricsQuery({ ...query, principal: B }), false)
  assert.equal(validateMetricsQuery({ ...query, fromMs: NOW - 33 * DAY }), false)
  assert.equal(validateMetricsQuery({ ...query, before: -1 }), false)
})

test('a rolling day excludes future and old timestamps and keeps the two partial hours', () => {
  const window = liveWindow('24h', NOW)
  const turns = [-DAY - 1, -DAY, -DAY + 1, -1, 0, 1].map(offset => ({ atMs: NOW + offset, basis: 'turn', tier: 'luna', totalTokens: 10 }))
  const bands = tokenBands(turns, window)
  assert.equal(bands.total, 40)
  assert.equal(window.startMs, NOW - DAY)
  assert.equal(window.endMs, NOW + 1)
  assert.equal(bands.bands[0].values.reduce((sum, n) => sum + n, 0), 40)
})

test('unknown and cumulative usage never become zeroes or an inflated period total', () => {
  const records = {
    sessions: { readable: true, supported: true, runs: [] },
    usage: { readable: true, supported: true, turns: [
      { atMs: NOW, sessionId: 'same-session', tier: 'luna', account: 'seat-a', totalTokens: 15, status: 'completed' },
      { atMs: NOW, sessionId: 'same-session', tier: 'claude-sonnet', account: 'seat-b', totalTokens: 25, status: 'error' },
      { atMs: NOW, totalTokens: null, unknownTotal: true, status: 'new-unknown-status' },
      { atMs: NOW, totalTokens: 9999, basis: 'session-total', status: 'completed' },
    ] },
  }
  const period = metricsPeriod(records, liveWindow('24h', NOW))
  assert.equal(period.tokens, 40)
  assert.equal(period.average, 20)
  assert.equal(period.unknown, 1)
  assert.equal(period.cumulative, 1)
  assert.equal(period.succeeded, 1)
  assert.equal(period.failed, 1)
  assert.equal(period.unrecorded, 1)
  assert.deepEqual(period.local.usage.byAccount.rows.map(row => row.tokens), [25, 15, null])
  assert.equal(period.local.usage.byModel.rows.length, 3, 'a session changing model retains each turn’s attribution')
})

test('a truncated last page is rejected rather than treated as the complete month', async () => {
  const window = liveWindow('30d', NOW)
  const reply = { ok: true, entries: [], metrics: { v: 1, fromMs: window.startMs, toMs: window.endMs, head: 100, count: 99, principal: A, nextBefore: null } }
  const result = await readMetricsRecords({ window, agent: { history: async () => reply, usage: async () => reply } })
  assert.equal(result.sessions.readable, false)
  assert.equal(result.usage.readable, false)
})

test('malformed, out-of-period, repeated and cross-session rows cannot masquerade as a complete snapshot', async () => {
  const window = liveWindow('30d', NOW)
  const meta = { v: 1, fromMs: window.startMs, toMs: window.endMs, head: 10, count: 1, principal: A, nextBefore: null }
  const empty = { ok: true, entries: [], metrics: { ...meta, count: 0 } }
  const turn = { sequence: 1, action: 'agent_turn_usage', sessionId: 's', at: new Date(NOW).toISOString(), usage: { totalTokens: 15 } }
  for (const bad of [
    { ...turn, sequence: null }, { ...turn, sequence: 11 }, { ...turn, at: 'invalid' },
    { ...turn, at: new Date(NOW + 1).toISOString() }, { ...turn, at: new Date(window.startMs - 1).toISOString() },
    { ...turn, usage: [] }, { ...turn, usage: null }, { ...turn, action: 'agent_session_start' },
  ]) {
    const agent = { history: async () => empty, usage: async () => ({ ok: true, entries: [bad], metrics: meta }) }
    assert.equal((await readMetricsRecords({ agent, window })).usage.readable, false, JSON.stringify(bad))
  }
  const repeated = await readMetricsRecords({ window, agent: { history: async () => empty,
    usage: async () => ({ ok: true, entries: [turn, turn], metrics: { ...meta, count: 2 } }) } })
  assert.equal(repeated.usage.readable, false)
  const mismatched = await readMetricsRecords({ window, agent: { usage: async () => empty,
    history: async () => ({ ok: true, entries: [
      { ...turn, action: 'agent_session_start' },
      { ...turn, sequence: 2, sessionId: 'another-session', action: 'agent_session_outcome', outcome: { resolves: 1, result: 'started' } },
    ], metrics: meta }) } })
  assert.equal(mismatched.sessions.readable, false)
})

test('a stalled cursor is rejected immediately instead of continuing to read or silently skipping records', async () => {
  const window = liveWindow('30d', NOW)
  let calls = 0
  const result = await readMetricsRecords({ window, agent: { usage: async () => {
    calls += 1
    return { ok: true, entries: [{ sequence: 10, at: new Date(NOW).toISOString(), action: 'agent_turn_usage', sessionId: 's', usage: { totalTokens: 1 } }],
      metrics: { v: 1, fromMs: window.startMs, toMs: window.endMs, head: 10, count: 2, principal: A, nextBefore: 5 } }
  } } })
  assert.equal(result.usage.readable, false)
  assert.equal(calls, 1)
})

test('the actual main-process writer keeps the starting account across async start and turn completion', async t => {
  const f = fixture(t)
  const source = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  const functions = ['recordSpawnIntent', 'recordSpawnOutcome', 'noteAgentTurnUsageImpl'].map(name => {
    const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))
    assert.ok(match, `the real ${name} writer must exist`)
    return match[0]
  }).join('\n')
  let signedIn = A
  const writer = vm.runInNewContext(`${functions}; ({ recordSpawnIntent, recordSpawnOutcome, noteAgentTurnUsageImpl })`, {
    UNAUTHENTICATED_PRINCIPAL: 'unauthenticated', accountResetStarted: false,
    CAPABILITY_STATE_ROOT: '/test-capability', captureAuditPolicy: () => ({ ok: true, legacy: true }),
    accountPrincipal: () => signedIn,
    recordCanonical: async () => { signedIn = B; return { ok: true } },
    spawnRecordDetails: () => ({}), getSpawnRecorder: () => f.runs, getUsageRecorder: () => f.usage,
    turnUsageFrom, usageLabel, turnFailureSentence: () => null, MAX_PENDING_TURN_USAGE: 20,
    agentIpcError: (code, message) => { throw Object.assign(new Error(message), { code }) },
  })
  const request = { sessionId: 'switch-during-start' }
  const receipt = await writer.recordSpawnIntent(request)
  assert.equal(receipt.principal, A)
  writer.recordSpawnOutcome(request, receipt, 'started', null)
  const session = { metricsPrincipal: receipt.principal, usageAuditRequired: true, tier: 'luna', account: 'provider-seat' }
  writer.noteAgentTurnUsageImpl(session, { sessionId: request.sessionId, event: { type: 'usage', turnId: '1', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } })
  writer.noteAgentTurnUsageImpl(session, { sessionId: request.sessionId, event: { type: 'turn_completed', turnId: '1', status: 'completed' } })
  await f.usage.flush()
  const result = await readMetricsRecords({ agent: f.agent, window: liveWindow('30d', NOW) })
  assert.equal(result.sessions.runs.length, 1)
  assert.equal(result.sessions.runs[0].result, 'started')
  assert.equal(result.usage.turns.length, 1)
  assert.equal(result.usage.turns[0].totalTokens, 15)
  f.setPrincipal(B)
  const other = await readMetricsRecords({ agent: f.agent, window: liveWindow('30d', NOW) })
  assert.equal(other.sessions.runs.length, 0)
  assert.equal(other.usage.turns.length, 0)
})

const emptyMetricsPage = (request, principal = A) => ({ ok: true, verified: true, entries: [],
  metrics: { v: 1, ...request.metrics, head: 0, count: 0, principal, nextBefore: null } })
const microtasks = async () => { for (let index = 0; index < 24; index++) await Promise.resolve() }

test('a pending usage page settles as timed out while the readable empty history stays empty', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let result
  readMetricsRecords({ window: liveWindow('30d', NOW), requestTimeoutMs: 20, agent: {
    history: async request => emptyMetricsPage(request), usage: () => new Promise(() => {}),
  } }).then(value => { result = value })
  await microtasks()
  assert.equal(result, undefined, 'the page is still waiting before its read deadline')
  t.mock.timers.tick(21); await microtasks()
  assert.ok(result, 'an unanswered IPC page must settle so the view can offer retry')
  assert.equal(result.sessions.readable, true)
  assert.equal(result.sessions.runs.length, 0)
  assert.equal(result.usage.readable, false, 'unreadable usage must not become measured zero usage')
  assert.deepEqual(result.readErrors, { history: null, usage: 'METRICS_READ_TIMEOUT' })
  assert.equal(result.scope, 'account')
  assert.equal(result.principal, A)
})

test('cancelling an in-flight metrics read settles without waiting for the host or accepting its late answer', async t => {
  const controller = new AbortController(), replies = []
  t.after(async () => { replies.forEach(reply => reply()); await microtasks() })
  let result
  readMetricsRecords({ window: liveWindow('30d', NOW), signal: controller.signal, agent:
    Object.fromEntries(['history', 'usage'].map(channel => [channel, request => new Promise(resolve => {
      replies.push(() => resolve(emptyMetricsPage(request)))
    })])),
  }).then(value => { result = value })
  await microtasks()
  controller.abort(); await microtasks()
  assert.ok(result, 'cancellation must retire a read even while IPC has not answered')
  assert.equal(result.sessions.readable, false)
  assert.equal(result.usage.readable, false)
  assert.deepEqual(result.readErrors, { history: 'METRICS_READ_CANCELLED', usage: 'METRICS_READ_CANCELLED' })
  const before = structuredClone(result)
  replies.forEach(reply => reply()); await microtasks()
  assert.deepEqual(result, before, 'a cancelled account read must not publish late data')
})

test('a timed-out later page never presents a partial month as complete', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0, result
  readMetricsRecords({ window: liveWindow('30d', NOW), requestTimeoutMs: 20, agent: {
    history: async request => emptyMetricsPage(request),
    usage: async request => {
      calls++
      if (calls > 1) return new Promise(() => {})
      return { ok: true, verified: true, entries: [{ sequence: 2, at: new Date(NOW).toISOString(),
        action: 'agent_turn_usage', sessionId: 'partial', usage: { totalTokens: 7 } }],
      metrics: { v: 1, ...request.metrics, head: 2, count: 2, principal: A, nextBefore: 2 } }
    },
  } }).then(value => { result = value })
  await microtasks()
  assert.equal(calls, 2, 'the first complete page must still request the remainder')
  t.mock.timers.tick(21); await microtasks()
  assert.ok(result, 'a stalled remainder must settle with an explicit read failure')
  assert.equal(result.usage.readable, false)
  assert.equal(result.readErrors.usage, 'METRICS_READ_TIMEOUT')
  assert.deepEqual(result.usage.turns, [])
})

test('retry after a timed-out read uses the requested account scope and ignores old replies', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const replies = [], requests = []
  let first
  const agent = Object.fromEntries(['history', 'usage'].map(channel => [channel, request =>
    new Promise(resolve => replies.push(() => resolve(emptyMetricsPage(request, A))))]))
  readMetricsRecords({ window: liveWindow('30d', NOW), agent, requestTimeoutMs: 20 }).then(value => { first = value })
  await microtasks(); t.mock.timers.tick(21); await microtasks()
  assert.ok(first, 'the timed-out attempt must finish before retry')
  const next = await readMetricsRecords({ window: liveWindow('30d', NOW), agent:
    Object.fromEntries(['history', 'usage'].map(channel => [channel, async request => {
      requests.push(request); return emptyMetricsPage(request, B)
    }])),
  })
  assert.equal(next.sessions.readable, true)
  assert.equal(next.usage.readable, true)
  assert.equal(next.principal, B)
  assert.equal(next.scope, 'account')
  assert.ok(requests.every(request => request.metrics.scope === undefined && request.metrics.principal === undefined))
  replies.forEach(reply => reply()); await microtasks()
  assert.equal(first.usage.readable, false)
  assert.equal(next.principal, B)
})

test('failed metrics requests expose bounded failure categories without private error text', async () => {
  const result = await readMetricsRecords({ window: liveWindow('30d', NOW), agent: {
    history: async () => { throw new Error('private fixture message must not reach the page') },
    usage: async () => ({ ok: false, code: 'PRIVATE_FIXTURE_DETAIL' }),
  } })
  assert.equal(result.sessions.readable, false)
  assert.equal(result.usage.readable, false)
  assert.deepEqual(result.readErrors, { history: 'METRICS_READ_UNAVAILABLE', usage: 'METRICS_READ_UNAVAILABLE' })
  assert.doesNotMatch(JSON.stringify(result), /private fixture|PRIVATE_FIXTURE/)
})

test('Basic actual start and end writers skip optional signing and account-attribution refresh', async () => {
  const path = require('node:path')
  const operation = require(path.join(canonicalRootForTests({ requireConfigured: true }), 'src/lib/operation-audit.js'))
  const source = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  const functions = ['recordSpawnIntent', 'recordSpawnOutcome', 'recordSessionEndImpl', 'noteAgentTurnUsageImpl', 'spawnRecordAvailability', 'spawnRecordHistory', 'usageRecordHistory'].map(name => {
    const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))
    assert.ok(match); return match[0]
  }).join('\n')
  let optionalCalls = 0, revocations = 0
  const decision = operation.capturePolicy({ loadSettings: () => ({ values: {}, provenance: {}, rejected: [] }) })
  const unavailable = () => { optionalCalls++; throw Error('optional infrastructure must remain unopened') }
  const writer = vm.runInNewContext(`${functions}; ({ recordSpawnIntent, recordSpawnOutcome, recordSessionEndImpl, noteAgentTurnUsageImpl, spawnRecordAvailability, spawnRecordHistory, usageRecordHistory })`, {
    CAPABILITY_STATE_ROOT: '/test-capability', captureAuditPolicy: () => ({ ok: true, decision, operation }),
    UNAUTHENTICATED_PRINCIPAL: 'unauthenticated', accountResetStarted: false,
    accountPrincipal: () => A, getHostedAccountController: unavailable,
    recordCanonical: unavailable, getSpawnRecorder: unavailable, getUsageRecorder: unavailable,
    sessionDiffAccess: { ended() { revocations++ } }, accessibilityHost: { revokeSession() { revocations++ } },
    screenControlHost: { revokeSession() { revocations++ } }, resolveCapabilityRoot: () => '/test-capability', path,
    require: () => ({ closeSession: async () => {} }),
  })
  const request = { sessionId: 'basic-start' }
  const receipt = await writer.recordSpawnIntent(request)
  assert.deepEqual(receipt.audit, operation.skippedStatus('controller.agent.launch', request.sessionId))
  assert.equal(receipt.principal, A, 'Basic retains native session and attachment ownership')
  writer.recordSpawnOutcome(request, receipt, 'started', null)
  const session = { started: receipt.audit }
  const ended = writer.recordSessionEndImpl(session, request.sessionId, 'exited')
  assert.equal(session.ended, true)
  assert.equal(ended.disposition, 'not-required')
  assert.equal(ended.signed, false)
  writer.noteAgentTurnUsageImpl(session, { event: { type: 'usage', turnId: 'turn-1', usage: {} } })
  writer.noteAgentTurnUsageImpl(session, { event: { type: 'turn_completed', turnId: 'turn-1' } })
  assert.equal(writer.spawnRecordAvailability().ok, true)
  assert.equal(writer.spawnRecordAvailability().auditRequired, false)
  assert.equal((await writer.spawnRecordHistory(20)).code, 'AUDIT_NOT_ENABLED')
  assert.equal((await writer.usageRecordHistory(20)).code, 'AUDIT_NOT_ENABLED')
  assert.equal(optionalCalls, 0)
  assert.equal(revocations, 3, 'disabling audit must retain access revocation')
})


test('Basic canonical Ledger reads preserve current rows without claiming history verification', () => {
  const { readCanonicalLedger } = require('../../shell/canonical-ledger-read.cjs')
  const { resolveRuntimePolicy } = require(require('node:path').join(canonicalRootForTests({ requireConfigured: true }), 'src/lib/runtime-policy.js'))
  let enabled = false, checks = 0
  const readPolicy = () => resolveRuntimePolicy({ values: { 'ledger.verify_history': enabled }, provenance: { 'ledger.verify_history': { source: 'user' } } })
  const store = { readAll: () => ({ exists: true, revision: 7, records: [{ id: 'T1', kind: 'T', words: 'Continue', status: 'open' }] }),
    verifyHistory() { checks++; return { ok: false, code: 'R_LEDGER_CHAIN_MISSING', missing: ['R1'] } } }
  const read = () => readCanonicalLedger({ loadModule: () => store, readPolicy })
  const basic = read()
  assert.equal(basic.ok, true)
  assert.equal(basic.records[0].words, 'Continue')
  assert.equal(basic.chain.checked, false)
  assert.equal(basic.chain.ok, null)
  assert.equal(checks, 0)
  enabled = true
  const audited = read()
  assert.equal(audited.chain.checked, true)
  assert.equal(audited.chain.ok, false)
  assert.equal(audited.chain.code, 'AGENT_LEDGER_CHAIN_MISSING')
  assert.deepEqual(audited.chain.missing, ['R1'])
  assert.equal(checks, 1)
  enabled = false
  assert.equal(read().chain.checked, false)
  assert.equal(checks, 1)
  store.readAll = () => { throw Error('malformed current records') }
  assert.equal(read().code, 'AGENT_LEDGER_UNREADABLE')
})
