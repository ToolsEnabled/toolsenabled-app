import test from 'node:test'
import assert from 'node:assert/strict'
import facadeModule from '../../shell/agent-facade.cjs'
import surfaceModule from '../../shell/agent-command-surface.cjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSpawnRecorder } from '../../shell/spawn-record.cjs'
import { createUsageRecorder } from '../../shell/usage-record.cjs'
import { createRemoteMetrics, validateMetricsQuery } from '../../shell/remote-metrics.cjs'
import { readMetricsRecords } from '../../src/metrics-records.js'

const owner = Object.freeze({ fixture: true })
const principal = () => ({ kind: 'relay', owner, mayWrite: false })
const windowQuery = { fromMs: 1786406400000, toMs: 1788998400000, before: 215, head: 450 }

async function fixture(t, metrics = null) {
  const calls = []
  const surface = { commands: Object.keys(surfaceModule.COMMANDS), sessionLoad: () => ({ open: 0, max: 8 }),
    run: async (command, payload) => { calls.push({ command, payload }); return { ok: true } } }
  const facade = facadeModule.createAgentFacade({ surface, principalForRelay: principal,
    metrics: metrics ? { validateQuery: validateMetricsQuery, ...metrics } : null, log() {} })
  const { origin, token } = await facade.listen()
  t.after(() => facade.close())
  const call = async (query, path = '/v1/agent/history', headers = {}) => {
    const response = await fetch(origin + path + (query ? '?' + query : ''), { headers: { Authorization: 'Bearer ' + token, ...headers } })
    return { status: response.status, body: await response.json() }
  }
  return { call, calls }
}

test('remote Metrics query reaches only its authorized controller with exact native fields', async t => {
  const reached = []
  const f = await fixture(t, { run: async (command, payload, who) => {
    reached.push({ command, payload, who }); return { ok: true, marker: 'authorized fixture' }
  } })
  for (const method of ['history', 'usage']) {
    const answer = await f.call(new URLSearchParams({ limit: '200', metrics: JSON.stringify(windowQuery) }), '/v1/agent/' + method)
    assert.equal(answer.status, 200)
    assert.equal(answer.body.marker, 'authorized fixture')
    assert.deepEqual(reached.at(-1), { command: 'agent:' + method, payload: { limit: 200, metrics: windowQuery }, who: principal() })
  }
  assert.equal(f.calls.length, 0, 'account-bound reads cannot bypass their controller')
})

test('remote Metrics refuses absent authorization, extra selectors and invalid or repeated query fields', async t => {
  const f = await fixture(t)
  const good = new URLSearchParams({ metrics: JSON.stringify(windowQuery) }).toString()
  assert.deepEqual(await f.call(good), { status: 503, body: { ok: false, error: { code: 'REMOTE_METRICS_UNAVAILABLE' } } })
  const guarded = await fixture(t, { run: async () => assert.fail('invalid query reached the read controller') })
  for (const value of [null, [], {}, { ...windowQuery, principal: 'account:' + 'b'.repeat(32) },
    { ...windowQuery, fromMs: -1 }, { ...windowQuery, toMs: windowQuery.fromMs },
    { ...windowQuery, head: Number.MAX_SAFE_INTEGER + 1 }, { ...windowQuery, before: 0 }]) {
    assert.equal((await guarded.call(new URLSearchParams({ metrics: JSON.stringify(value) }))).status, 400)
  }
  for (const query of ['metrics=%7B', good + '&metrics=%7B%7D', good + '&account=another', 'limit=2&limit=3&' + good]) {
    assert.equal((await guarded.call(query)).status, 400)
  }
  for (const method of ['history', 'usage']) {
    const computer = new URLSearchParams({ metrics: JSON.stringify({ ...windowQuery, scope: 'computer' }) })
    assert.equal((await guarded.call(computer, '/v1/agent/' + method)).status, 400)
  }
  assert.equal(f.calls.length, 0)
  assert.equal(guarded.calls.length, 0)
})

test('Metrics preserves the facade Origin and bearer gates', async t => {
  let reads = 0
  const f = await fixture(t, { run: async () => { reads++; return { ok: true } } })
  const query = new URLSearchParams({ metrics: JSON.stringify(windowQuery) })
  assert.equal((await f.call(query, '/v1/agent/history', { Origin: 'https://toolsenabled.ai' })).status, 403)
  assert.equal((await f.call(query, '/v1/agent/history', { Authorization: 'Bearer wrong-fixture-token' })).status, 401)
  assert.equal(reads, 0)
})

test('real journal files reach the real Metrics collector through bounded HTTP pages without missing rows', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'remote-metrics-journals-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: value => value.toString() }
  const A = 'account:' + 'a'.repeat(32), B = 'account:' + 'b'.repeat(32)
  const now = () => new Date(windowQuery.fromMs + 86400000).toISOString()
  const runs = createSpawnRecorder({ directory, safeStorage, now })
  const usage = createUsageRecorder({ directory, safeStorage, now })
  for (let i = 0; i < 425; i++) {
    const account = i % 3 === 0 ? B : A, sessionId = `fixture-${i}-` + 'x'.repeat(80)
    const start = runs.record({ action: 'agent_session_start', sessionId, principal: account,
      details: { cwd: 'private-journal-fixture-path' } })
    runs.record({ action: 'agent_session_outcome', sessionId, principal: account,
      outcome: { resolves: start.sequence, result: i % 2 ? 'started' : 'refused' } })
    usage.recordTurn({ sessionId, principal: account, tier: 'luna', account: 'fixture-seat', status: 'completed',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, basis: 'turn' } })
  }
  // Use the actual query readers after reopening their on-disk journals.
  const reopened = createSpawnRecorder({ directory, safeStorage, now })
  const reopenedUsage = createUsageRecorder({ directory, safeStorage, now })
  const current = { signedIn: true, account: { signInMethod: 'hosted' }, principal: A, session: { id: 'fixture-session' } }
  let authorizations = 0
  const metrics = createRemoteMetrics({ getStore: () => ({ current: () => current }),
    client: { verifiedAccount: () => ({ id: 'fixture-hosted-a' }), authorizeDeviceSettings: async () => {
      authorizations++; return { ok: true, accountId: 'fixture-hosted-a' }
    } },
    deviceStatus: async () => ({ ok: true, connected: true, deviceId: 'fixture-device', pairId: 'fixture-pair' }),
    connectionTicket: () => 1, connectionContinues: ticket => ticket === 1, currentPrincipal: principal,
    read: (command, request) => command === 'agent:history'
      ? reopened.historyAsync({ ...request, metrics: { ...request.metrics, principal: A } })
      : reopenedUsage.usageAsync({ ...request, metrics: { ...request.metrics, principal: A } }),
  })
  const f = await fixture(t, metrics), pages = []
  const agent = Object.fromEntries(['history', 'usage'].map(method => [method, async request => {
    const answer = await f.call(new URLSearchParams({ limit: String(request.limit), metrics: JSON.stringify(request.metrics) }), '/v1/agent/' + method)
    assert.equal(answer.status, 200)
    assert.doesNotMatch(JSON.stringify(answer.body), /private-journal-fixture-path|eventHash|signature/)
    pages.push({ method, body: answer.body })
    return answer.body
  }]))
  const result = await readMetricsRecords({ agent, window: { startMs: windowQuery.fromMs, endMs: windowQuery.toMs } })
  assert.equal(result.sessions.readable, true)
  assert.equal(result.usage.readable, true)
  assert.equal(result.sessions.runs.length, 283)
  assert.equal(result.usage.turns.length, 283)
  assert.equal(result.sessions.verified, true)
  assert.equal(result.principal, A)
  assert.equal(new Set(result.sessions.runs.map(row => row.sessionId)).size, 283)
  assert.ok(pages.some(page => page.body.truncated), 'the real journal page must exercise the wire bound')
  assert.ok(pages.filter(page => page.method === 'history').length > 1)
  assert.ok(pages.filter(page => page.method === 'usage').length > 1)
  assert.equal(authorizations, pages.length, 'each page must verify account/device ownership')
  assert.equal(f.calls.length, 0, 'Metrics never takes the unscoped history path')
})

test('a single oversized Metrics record is refused without an empty successful page', async t => {
  const f = await fixture(t, { run: async () => ({ ok: true,
    entries: [{ action: 'agent_turn_usage', sequence: 1, sessionId: 'fixture', usage: { note: 'x'.repeat(facadeModule.MAX_RESPONSE_BYTES) } }],
    metrics: { v: 1, ...windowQuery, count: 1, nextBefore: null, principal: 'account:' + 'a'.repeat(32) },
  }) })
  const answer = await f.call(new URLSearchParams({ metrics: JSON.stringify(windowQuery) }), '/v1/agent/usage')
  assert.equal(answer.status, 500)
  assert.equal(answer.body.error.code, 'AGENT_FACADE_RESPONSE_TOO_LARGE')
  assert.equal(answer.body.entries, undefined)
})
