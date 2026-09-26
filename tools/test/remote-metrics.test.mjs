import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import accountModule from '../../shell/product-account.cjs'
import metricsModule from '../../shell/remote-metrics.cjs'
import queryModule from '../../shell/metrics-record-query.cjs'

const A = { id: 'remote-metrics-fixture-a', email: 'a@example.invalid' }
const B = { id: 'remote-metrics-fixture-b', email: 'b@example.invalid' }
const query = { fromMs: 1786406400000, toMs: 1788998400000 }
const payload = () => ({ limit: 200, metrics: { ...query } })

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'remote-metrics-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const owner = Object.freeze({ fixture: true })
  const state = { hosted: A, epoch: 0, deviceCalls: 0, authorityCalls: 0, readCalls: 0, calls: [] }
  const client = {
    verifiedAccount: () => state.hosted, sessionPersisted: () => false,
    async authorizeDeviceSettings(device) {
      state.authorityCalls++
      assert.deepEqual(device, { deviceId: 'fixture-device', pairId: 'fixture-pair' })
      return state.authorize ? state.authorize() : { ok: true, accountId: A.id }
    },
  }
  const store = accountModule.createAccountStore({ directory, hostedAccount: client,
    safeStorage: { isEncryptionAvailable: () => false } })
  const signIn = account => { state.hosted = account; assert.equal(store.signInWithHostedAccount().ok, true) }
  signIn(A)
  const accountA = store.current().principal
  signIn(B)
  const accountB = store.current().principal
  signIn(A)
  const principal = () => ({ kind: 'relay', owner, mayWrite: false })
  const device = { ok: true, connected: true, deviceId: 'fixture-device', pairId: 'fixture-pair' }
  const entries = [accountA, accountB].flatMap((account, index) => [
    { at: new Date(query.fromMs + 100).toISOString(), sequence: index * 2 + 1,
      sessionId: 'fixture-' + index, action: 'agent_session_start', principal: account, label: 'fixture-' + index },
    { at: new Date(query.fromMs + 200).toISOString(), sequence: index * 2 + 2,
      sessionId: 'fixture-' + index, action: 'agent_turn_usage', principal: account, usage: { inputTokens: 1 } },
  ])
  const controller = metricsModule.createRemoteMetrics({ getStore: () => store, client,
    deviceStatus: async () => { state.deviceCalls++; return state.deviceRead ? state.deviceRead() : device },
    connectionTicket: () => state.epoch, connectionContinues: ticket => ticket === state.epoch,
    currentPrincipal: principal,
    read: async (command, request, who) => {
      state.readCalls++; state.calls.push({ command, request, who })
      const result = { ok: true, verified: true, ...queryModule.selectMetricsRecords(entries,
        { ...request.metrics, principal: store.current().principal }, request.limit, command === 'agent:usage') }
      return state.read ? state.read(result) : result
    },
  })
  const run = (command = 'agent:history', request = payload(), who = principal()) => controller.run(command, request, who)
  return { state, store, signIn, principal, run, device, accountA, accountB }
}

test('remote Metrics reads the actual selected hosted partition with Drive OFF', async t => {
  const f = fixture(t)
  for (const command of ['agent:history', 'agent:usage']) {
    const answer = await f.run(command)
    assert.equal(answer.ok, true)
    assert.equal(answer.metrics.principal, f.accountA)
    assert.equal(answer.metrics.count, 1)
    assert.equal(answer.entries.length, 1)
    assert.equal(answer.entries[0].sessionId, 'fixture-0')
    assert.equal(f.state.calls.at(-1).who.mayWrite, false)
  }
  assert.equal(f.state.authorityCalls, 2)
})

test('remote Metrics refuses whole-computer scope before any device or record read', async t => {
  const f = fixture(t)
  for (const command of ['agent:history', 'agent:usage']) {
    assert.equal((await f.run(command, { ...payload(), metrics: { ...query, scope: 'computer' } })).code, 'METRICS_QUERY_INVALID')
  }
  assert.equal(f.state.deviceCalls, 0)
  assert.equal(f.state.readCalls, 0)
  f.state.read = result => ({ ...result, metrics: { ...result.metrics, scope: 'computer' } })
  const answer = await f.run()
  assert.equal(answer.code, 'REMOTE_METRICS_UNAVAILABLE')
  assert.equal(answer.entries, undefined, 'a widened downstream reply must not leave the remote boundary')
})

test('remote Metrics rejects other principals and caller-selected account fields before any read', async t => {
  const f = fixture(t)
  for (const who of [null, { ...f.principal(), kind: 'window' }, { ...f.principal(), kind: 'agent' }, { ...f.principal(), owner: {} }]) {
    assert.equal((await f.run('agent:history', payload(), who)).code, 'MC_AGENT_PRINCIPAL_INVALID')
  }
  for (const request of [null, [], { ...payload(), account: A.id }, { ...payload(), principal: f.accountB },
    { ...payload(), metrics: { ...query, principal: f.accountB } }, { ...payload(), limit: 201 },
    { ...payload(), limit: 0 }, { ...payload(), metrics: null }]) {
    assert.equal((await f.run('agent:usage', request)).code, 'METRICS_QUERY_INVALID')
  }
  assert.equal((await f.run('agent:send')).code, 'METRICS_QUERY_INVALID')
  assert.equal(f.state.deviceCalls, 0)
  assert.equal(f.state.readCalls, 0)
})

test('device ownership refusal and absent hosted sign-in disclose no journal rows', async t => {
  const f = fixture(t)
  f.state.authorize = () => ({ ok: false, code: 'HOSTED_ACCOUNT_DEVICE_REFUSED', reason: 'private fixture diagnostics' })
  assert.deepEqual(await f.run(), { ok: false, code: 'HOSTED_ACCOUNT_DEVICE_REFUSED' })
  assert.equal(f.state.readCalls, 0)
  f.state.hosted = null
  assert.equal((await f.run()).code, 'REMOTE_ACCOUNT_HOSTED_SIGNIN_REQUIRED')
  assert.equal(f.state.readCalls, 0)
})

test('successful ownership replies still require the exact verified hosted identity', async t => {
  const f = fixture(t)
  for (const accountId of [undefined, null, '', B.id]) {
    f.state.authorize = () => ({ ok: true, accountId })
    assert.deepEqual(await f.run(), { ok: false, code: 'REMOTE_ACCOUNT_CHANGED' })
  }
  assert.equal(f.state.readCalls, 0)
})

for (const step of ['deviceRead', 'authorize', 'read']) {
  test(`account change during ${step} cannot return either account's records`, async t => {
    const f = fixture(t)
    f.state[step] = answer => {
      f.signIn(B)
      return step === 'deviceRead' ? f.device : step === 'authorize' ? { ok: true, accountId: B.id } : answer
    }
    assert.deepEqual(await f.run(), { ok: false, code: 'REMOTE_ACCOUNT_CHANGED' })
    assert.equal(f.state.readCalls, step === 'read' ? 1 : 0)
  })
  test(`connection revocation during ${step} discards the pending result`, async t => {
    const f = fixture(t)
    f.state[step] = answer => {
      f.state.epoch++
      return step === 'deviceRead' ? f.device : step === 'authorize' ? { ok: true, accountId: A.id } : answer
    }
    assert.deepEqual(await f.run(), { ok: false, code: 'MC_AGENT_CONNECTION_CLOSED' })
    assert.equal(f.state.readCalls, step === 'read' ? 1 : 0)
  })
}

test('leaving and returning to the same account does not revive an old read', async t => {
  const f = fixture(t)
  const session = f.store.current().session.id
  f.state.authorize = () => {
    f.signIn(B); f.signIn(A)
    assert.notEqual(f.store.current().session.id, session)
    return { ok: true, accountId: A.id }
  }
  assert.deepEqual(await f.run(), { ok: false, code: 'REMOTE_ACCOUNT_CHANGED' })
  assert.equal(f.state.readCalls, 0)
})

test('journal output must be bound to the admitted account and exact fixed window', async t => {
  const f = fixture(t)
  f.state.read = answer => ({ ...answer, metrics: { ...answer.metrics, principal: f.accountB }, private: 'fixture' })
  assert.deepEqual(await f.run(), { ok: false, code: 'METRICS_ACCOUNT_CHANGED' })
  f.state.read = answer => ({ ...answer, metrics: { ...answer.metrics, fromMs: query.fromMs + 1 } })
  assert.deepEqual(await f.run(), { ok: false, code: 'REMOTE_METRICS_UNAVAILABLE' })
  f.state.read = () => ({ ok: false, code: 'SPAWN_RECORD_UNAVAILABLE', entries: ['private fixture'] })
  assert.deepEqual(await f.run(), { ok: false, code: 'SPAWN_RECORD_UNAVAILABLE' })
})

test('an admitted query cannot be replaced while hosted verification is pending', async t => {
  const f = fixture(t), request = payload()
  f.state.authorize = () => { request.limit = 1; request.metrics.fromMs = 0; return { ok: true, accountId: A.id } }
  const answer = await f.run('agent:history', request)
  assert.equal(answer.ok, true)
  assert.deepEqual(f.state.calls[0].request, { limit: 200, metrics: query })
  assert.equal(Object.isFrozen(f.state.calls[0].request.metrics), true)
})
