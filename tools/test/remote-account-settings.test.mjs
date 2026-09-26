import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import accountModule from '../../shell/product-account.cjs'
import remoteModule from '../../shell/remote-account-settings.cjs'

const { createRemoteAccountSettings, KEYS } = remoteModule
const A = { id: 'hosted-fixture-a', email: 'a@example.invalid' }
const B = { id: 'hosted-fixture-b', email: 'b@example.invalid' }
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'remote-account-settings-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const state = { hosted: A, epoch: 0, write: true, deviceCalls: 0, authorityCalls: 0,
    device: { ok: true, connected: true, deviceId: 'device-fixture', pairId: 'pair-fixture' } }
  const client = {
    verifiedAccount: () => state.hosted,
    sessionPersisted: () => false,
    async authorizeDeviceSettings(device) {
      state.authorityCalls++
      assert.deepEqual(device, { deviceId: 'device-fixture', pairId: 'pair-fixture' })
      return state.authorize ? state.authorize() : { ok: true, accountId: state.hosted.id }
    },
  }
  const store = accountModule.createAccountStore({ directory, hostedAccount: client,
    safeStorage: { isEncryptionAvailable: () => false } })
  assert.equal(store.signInWithHostedAccount().ok, true)
  const owner = Object.freeze({ fixture: true })
  const principal = () => ({ kind: 'relay', owner, mayWrite: state.write, label: 'web (relay)' })
  const controller = createRemoteAccountSettings({ getStore: () => store, client,
    deviceStatus: async () => { state.deviceCalls++; return state.readDevice ? state.readDevice() : state.device },
    connectionTicket: () => state.epoch,
    connectionContinues: ticket => ticket === state.epoch,
    currentPrincipal: principal,
  })
  const run = (op, payload, who = principal()) => controller.run(op, payload, who)
  return { state, store, client, run, principal }
}

test('only the four ordinary settings round-trip through the actual hosted partition', async t => {
  const f = fixture(t)
  assert.deepEqual(KEYS, ['agent_tool_states', 'agent_tools_disabled', 'research_queue', 'research_experiments'])
  for (const key of KEYS) {
    assert.deepEqual(await f.run('get', { key }), { ok: true, key, value: null, accountId: f.store.current().account.id })
    assert.deepEqual(await f.run('put', { key, value: '{"fixture":true}' }), { ok: true, key, removed: false })
    assert.equal(f.store.getSetting(key).value, '{"fixture":true}')
    assert.equal((await f.run('get', { key })).value, '{"fixture":true}')
    assert.deepEqual(await f.run('put', { key, value: null }), { ok: true, key, removed: true })
    assert.equal(f.store.getSetting(key).value, null)
  }
})

test('a remote captured partition fence cannot write a later hosted account', async t => {
  const f = fixture(t)
  const captured = (await f.run('get', { key: 'research_queue' })).accountId
  assert.match(captured, /^[0-9a-f]{32}$/)
  f.state.hosted = B
  assert.equal(f.store.signInWithHostedAccount().ok, true)
  assert.equal((await f.run('put', { key: 'research_queue', value: 'must-not-land', expectedAccountId: captured })).code, 'ACCOUNT_CHANGED')
  assert.equal(f.store.getSetting('research_queue').value, null, 'the A fence wrote B’s partition')
  for (const expectedAccountId of [undefined, null, 1, '', 'not-an-account-id', '0'.repeat(33)]) {
    assert.equal((await f.run('put', { key: 'research_queue', value: 'must-not-land', expectedAccountId })).code, 'ACCOUNT_CHANGED')
    assert.equal((await f.run('get', { key: 'research_queue', expectedAccountId })).code, 'ACCOUNT_CHANGED')
  }
  assert.deepEqual(await f.run('put', { key: 'research_queue', value: 'ordinary-b' }),
    { ok: true, key: 'research_queue', removed: false })
  const read = await f.run('get', { key: 'research_queue' })
  assert.equal(read.value, 'ordinary-b')
  assert.equal(read.accountId, f.store.current().account.id)
})

test('unknown keys, account selectors, missing values and oversized data never reach ownership or storage', async t => {
  const f = fixture(t)
  for (const key of ['payment_card_default', 'owner_legal_identity_v1', 'mc.relay.web-drive', 'agent.agent_api', '__proto__', '../research_queue', '', null]) {
    assert.equal((await f.run('get', { key })).ok, false)
    assert.equal((await f.run('put', { key, value: 'secret-fixture' })).ok, false)
  }
  for (const payload of [{ key: 'research_queue', accountId: A.id }, { key: 'research_queue', value: 'x', account: A.id }, null, []]) {
    assert.equal((await f.run('put', payload)).ok, false)
  }
  for (const value of [undefined, {}, [], false, 1, 'x'.repeat(65537)]) {
    assert.equal((await f.run('put', { key: 'research_queue', value })).code, 'ACCOUNT_DATA_BAD_VALUE')
  }
  assert.equal((await f.run('put', { key: 'research_queue' })).code, 'ACCOUNT_DATA_BAD_VALUE')
  assert.equal(f.state.deviceCalls, 0)
  assert.equal(f.state.authorityCalls, 0)
  assert.equal(f.store.getSetting('research_queue').value, null)
})

test('Drive OFF refuses writes before payload access but permits the authorized read', async t => {
  const f = fixture(t)
  f.store.putSetting({ key: 'research_queue', value: 'existing' })
  f.state.write = false
  const payload = { get key() { assert.fail('a refused write must not inspect its payload') } }
  assert.equal((await f.run('put', payload)).code, 'MC_AGENT_PRINCIPAL_READ_ONLY')
  assert.equal(f.state.deviceCalls, 0)
  assert.equal((await f.run('get', { key: 'research_queue' })).value, 'existing')
})

test('non-relay and other relay owners cannot reach any account data', async t => {
  const f = fixture(t)
  for (const who of [null, { ...f.principal(), kind: 'agent' }, { ...f.principal(), kind: 'window' }, { ...f.principal(), owner: {} }]) {
    assert.equal((await f.run('get', { key: 'research_queue' }, who)).code, 'MC_AGENT_PRINCIPAL_INVALID')
  }
  assert.equal(f.state.deviceCalls, 0)
})

test('a device that does not belong to the desktop account cannot read or write its partition', async t => {
  const f = fixture(t)
  f.store.putSetting({ key: 'research_queue', value: 'private-fixture' })
  f.state.authorize = () => ({ ok: false, code: 'HOSTED_ACCOUNT_DEVICE_REFUSED', reason: 'private diagnostics' })
  for (const operation of ['get', 'put']) {
    const result = await f.run(operation, { key: 'research_queue', ...(operation === 'put' ? { value: 'new' } : {}) })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'HOSTED_ACCOUNT_DEVICE_REFUSED')
    assert.match(result.reason, /same ToolsEnabled account/)
    assert.equal(result.reason.includes('private diagnostics'), false)
  }
  assert.equal(f.store.getSetting('research_queue').value, 'private-fixture')
})

test('real account switching during authorization never reads or changes the replacement account', async t => {
  const f = fixture(t)
  f.store.putSetting({ key: 'research_queue', value: 'account-a' })
  f.state.authorize = () => {
    f.state.hosted = B
    assert.equal(f.store.signInWithHostedAccount().ok, true)
    f.store.putSetting({ key: 'research_queue', value: 'account-b' })
    return { ok: true, accountId: B.id }
  }
  assert.equal((await f.run('put', { key: 'research_queue', value: 'web-a' })).code, 'REMOTE_ACCOUNT_CHANGED')
  assert.equal(f.store.getSetting('research_queue').value, 'account-b')
  f.state.hosted = A
  assert.equal(f.store.signInWithHostedAccount().ok, true)
  assert.equal(f.store.getSetting('research_queue').value, 'account-a')
})

for (const stage of ['readDevice', 'authorize']) test(`connection revocation during ${stage} stops the operation`, async t => {
  const f = fixture(t)
  f.state[stage] = () => {
    f.state.epoch++
    return stage === 'readDevice' ? f.state.device : { ok: true, accountId: A.id }
  }
  assert.equal((await f.run('put', { key: 'research_queue', value: 'new' })).code, 'MC_AGENT_CONNECTION_CLOSED')
  assert.equal(f.store.getSetting('research_queue').value, null)
})

test('Drive revocation after hosted authorization is checked before the real write', async t => {
  const f = fixture(t)
  f.state.authorize = () => { f.state.write = false; return { ok: true, accountId: A.id } }
  assert.equal((await f.run('put', { key: 'research_queue', value: 'new' })).code, 'MC_AGENT_PRINCIPAL_READ_ONLY')
  assert.equal(f.store.getSetting('research_queue').value, null)
})

test('signed-out state and mismatched hosted identity fail closed', async t => {
  const f = fixture(t)
  f.state.authorize = () => ({ ok: true, accountId: B.id })
  assert.equal((await f.run('get', { key: 'research_queue' })).code, 'REMOTE_ACCOUNT_CHANGED')
  f.state.hosted = null
  assert.equal((await f.run('get', { key: 'research_queue' })).code, 'REMOTE_ACCOUNT_HOSTED_SIGNIN_REQUIRED')
})

test('the admitted key and value cannot change while ownership verification is pending', async t => {
  const f = fixture(t)
  const payload = { key: 'research_queue', value: 'admitted' }
  f.state.authorize = () => { payload.key = 'mc.relay.web-drive'; payload.value = 'on'; return { ok: true, accountId: A.id } }
  assert.equal((await f.run('put', payload)).ok, true)
  assert.equal(f.store.getSetting('research_queue').value, 'admitted')
  assert.equal(f.store.getSetting('mc.relay.web-drive').value, null)
})
