import test from 'node:test'
import assert from 'node:assert/strict'
import clientModule from '../../shell/hosted-account-client.cjs'

const { createHostedAccountClient } = clientModule
const account = { id: 'account-fixture', email: 'person@example.invalid' }
const device = { deviceId: 'device-fixture', pairId: 'pair-fixture' }
const cookie = '__Host-te_desktop=fixture_token_012345678901234567890123; Path=/; Secure; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 2099 00:00:00 GMT'
function fixture(handler) {
  const calls = []
  const client = createHostedAccountClient({ fetchImpl: async (url, options) => {
    calls.push({ url, options })
    if (url.endsWith('/v1/desktop/sessions') && options.method === 'POST') {
      return new Response(JSON.stringify({ account }), { headers: { 'set-cookie': cookie } })
    }
    if (options.method === 'DELETE') return new Response('{}')
    return handler(url, options)
  } })
  return { client, calls }
}
const good = () => new Response(JSON.stringify({ authorized: true, account, ...device, privateField: 'private-fixture' }))

test('device ownership uses only the saved desktop session and projects no cookie or server fields', async () => {
  const { client, calls } = fixture(good)
  assert.equal((await client.signIn({ email: account.email, password: 'fixture' })).ok, true)
  assert.deepEqual(await client.authorizeDeviceSettings(device), { ok: true, accountId: account.id })
  assert.equal(calls[1].url, 'https://app.toolsenabled.ai/v1/desktop/device-settings-access?deviceId=device-fixture&pairId=pair-fixture')
  assert.equal(calls[1].options.method, 'GET')
  assert.match(calls[1].options.headers.Cookie, /^__Host-te_desktop=/)
  assert.equal(calls[1].options.redirect, 'manual')
  assert.equal(calls[1].options.credentials, 'omit')
  assert.deepEqual(client.verifiedAccount(), account)
})

test('anonymous or malformed requests do not reach the service', async () => {
  const { client, calls } = fixture(good)
  assert.equal((await client.authorizeDeviceSettings(device)).code, 'HOSTED_ACCOUNT_SIGNIN_REQUIRED')
  for (const value of [{}, { ...device, deviceId: '../device' }, { ...device, pairId: 'p'.repeat(129) }, { ...device, deviceId: null }]) {
    assert.equal((await client.authorizeDeviceSettings(value)).code, 'HOSTED_ACCOUNT_DEVICE_REFUSED')
  }
  assert.equal(calls.length, 0)
})

for (const status of [401, 403, 404, 500, 302]) test(`device authorization refuses HTTP ${status}`, async () => {
  const { client } = fixture(() => new Response(JSON.stringify({ authorized: true, account, ...device }), { status }))
  assert.equal((await client.signIn({ email: account.email, password: 'fixture' })).ok, true)
  assert.equal((await client.authorizeDeviceSettings(device)).ok, false)
  if (status === 401) assert.equal(client.verifiedAccount(), null)
})

for (const mutation of [
  body => { body.account.id = 'another-account' },
  body => { body.deviceId = 'another-device' },
  body => { body.pairId = 'another-pair' },
  body => { body.authorized = 'true' },
  body => { delete body.account },
]) test('a mismatched ownership response cannot authorize native settings', async () => {
  const { client } = fixture(() => {
    const body = { authorized: true, account: { ...account }, ...device }
    mutation(body)
    return new Response(JSON.stringify(body))
  })
  assert.equal((await client.signIn({ email: account.email, password: 'fixture' })).ok, true)
  assert.deepEqual(await client.authorizeDeviceSettings(device), { ok: false, code: 'HOSTED_ACCOUNT_RESPONSE_INVALID' })
})

test('sign-out invalidates a device authorization already waiting on the service', async () => {
  let release, arrived
  const waiting = new Promise(resolve => { arrived = resolve })
  const { client } = fixture(async () => { arrived(); return new Promise(resolve => { release = resolve }) })
  assert.equal((await client.signIn({ email: account.email, password: 'fixture' })).ok, true)
  const pending = client.authorizeDeviceSettings(device)
  await waiting
  await client.signOut()
  release(good())
  assert.equal((await pending).code, 'HOSTED_ACCOUNT_CANCELLED')
  assert.equal(client.verifiedAccount(), null)
})
