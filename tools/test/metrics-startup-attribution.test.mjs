import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'
import accountModule from '../../shell/product-account.cjs'
import clientModule from '../../shell/hosted-account-client.cjs'
import controllerModule from '../../shell/hosted-account-controller.cjs'
import { createSpawnRecorder } from '../../shell/spawn-record.cjs'

const main = fs.readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
const functions = ['accountPrincipal', 'recordSpawnIntent'].map(name => {
  const found = main.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))
  assert.ok(found, `exercise actual main ${name}`)
  return found[0]
}).join('\n')
const safeStorage = { isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(value).reverse(), decryptString: value => Buffer.from(value).reverse().toString() }

async function fixture(t, { signedIn = true, local = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-startup-attribution-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const account = { id: 'metrics-startup-fixture', email: 'metrics@example.invalid' }
  let at = Date.UTC(2026, 8, 15), saved = null, status = 200, pending = null, entered = null, reset = false, reads = 0
  const storage = { read: () => saved, write: value => { saved = structuredClone(value); return true }, clear: () => { saved = null; return true } }
  const options = { now: () => at, sessionStorage: storage, timeoutMs: 1000,
    fetchImpl: async (address, request) => {
      assert.ok(address.startsWith('https://app.toolsenabled.ai/v1/desktop/'))
      if (request.method === 'POST') return new Response(JSON.stringify({ account }), { status: 200,
        headers: { 'Set-Cookie': `__Host-te_desktop=${'f'.repeat(48)}; Secure; HttpOnly; Path=/; Expires=${new Date(at + 3600000).toUTCString()}` } })
      if (request.method === 'DELETE') return new Response('{}', { status: 200 })
      reads++
      entered?.()
      if (pending) await pending
      if (status === 'throw') throw new Error('fixture transport unavailable')
      return new Response(JSON.stringify({ account }), { status })
    } }
  const open = client => accountModule.createAccountStore({ directory, safeStorage, hostedAccount: client, now: () => at })
  let client = clientModule.createHostedAccountClient(options), store = open(client)
  let controller = controllerModule.createHostedAccountController({ client, store })
  if (local) {
    assert.equal((await store.createAccount({ username: 'local-fixture', displayName: 'Local fixture', password: 'local-fixture-password' })).ok, true)
    assert.equal((await store.signIn({ username: 'local-fixture', password: 'local-fixture-password' })).ok, true)
  } else if (signedIn) assert.equal((await controller.signIn({ username: account.email, password: 'synthetic-password' })).ok, true)
  const expectedPrincipal = store.principal()
  if (!local) {
    client = clientModule.createHostedAccountClient(options)
    store = open(client)
    controller = controllerModule.createHostedAccountController({ client, store })
  }
  const recorder = createSpawnRecorder({ directory, safeStorage, now: () => new Date(at).toISOString() })
  const context = { UNAUTHENTICATED_PRINCIPAL: 'unauthenticated', getAccountStore: () => store,
    getHostedAccountController: () => controller, getSpawnRecorder: () => recorder,
    recordCanonical: async () => ({ ok: true }), spawnRecordDetails: () => ({}),
    agentIpcError: (code, message) => { throw Object.assign(new Error(message), { code }) } }
  Object.defineProperty(context, 'accountResetStarted', { get: () => reset })
  const writeStart = vm.runInNewContext(`${functions}; recordSpawnIntent`, context)
  return { client, store, controller, expectedPrincipal, recorder, directory,
    write: sessionId => writeStart({ sessionId }), reads: () => reads,
    advance: duration => { at += duration }, status: value => { status = value }, reset: () => { reset = true },
    hold: () => { let release; pending = new Promise(resolve => { release = resolve }); return { entered: new Promise(resolve => { entered = resolve }), release } },
  }
}

async function assertRecorded(f, sessionId, expected) {
  const receipt = await f.write(sessionId)
  assert.equal(receipt.durable, true, 'attribution does not add a start refusal')
  assert.equal(receipt.signed, true)
  assert.equal(receipt.principal, expected)
  const row = (await f.recorder.historyAsync({ limit: 1 })).entries[0]
  assert.equal(row.principal, expected)
  assert.equal(row.sessionId, sessionId)
  return receipt
}

test('restored valid hosted sign-in is verified before the actual start freezes its principal', async t => {
  const f = await fixture(t)
  assert.equal(f.client.hasSession(), true)
  assert.equal(f.store.principal(), 'unauthenticated', 'saved identity alone grants no authority')
  await assertRecorded(f, 'restored', f.expectedPrincipal)
  assert.equal(f.reads(), 1)
  await assertRecorded(f, 'already-verified', f.expectedPrincipal)
  assert.equal(f.reads(), 1, 'fresh verified principal needs no extra request')
})

test('concurrent restored starts share the existing refresh and both record the verified account', async t => {
  const f = await fixture(t), held = f.hold()
  const first = f.write('first'); await held.entered
  const second = f.write('second'); held.release()
  const results = await Promise.all([first, second])
  assert.equal(f.reads(), 1)
  assert.ok(results.every(result => result.principal === f.expectedPrincipal && result.durable))
})

for (const scenario of ['missing', 'expired', 'revoked', 'unavailable', 'transport-failure']) {
  test(`${scenario} hosted sign-in still records a successful local start as unauthenticated`, async t => {
    const f = await fixture(t, { signedIn: scenario !== 'missing' })
    if (scenario === 'expired') f.advance(3600001)
    if (scenario === 'revoked') f.status(401)
    if (scenario === 'unavailable') f.status(503)
    if (scenario === 'transport-failure') f.status('throw')
    await assertRecorded(f, scenario, 'unauthenticated')
    if (['missing', 'expired'].includes(scenario)) assert.equal(f.reads(), 0)
    if (['unavailable', 'transport-failure'].includes(scenario)) {
      assert.equal(f.client.hasSession(), true, 'uncertainty preserves the saved session')
      f.status(200)
      await assertRecorded(f, 'recovered', f.expectedPrincipal)
      const rows = (await f.recorder.historyAsync({ limit: 10 })).entries
      assert.equal(rows.find(row => row.sessionId === scenario).principal, 'unauthenticated', 'history stays as originally recorded')
    }
  })
}

test('sign-out during pending verification never writes its late account response', async t => {
  const f = await fixture(t), held = f.hold()
  const writing = f.write('signed-out-during-refresh'); await held.entered
  await f.controller.signOut(); held.release()
  assert.equal((await writing).principal, 'unauthenticated')
  assert.equal(f.store.principal(), 'unauthenticated')
  assert.equal((await f.recorder.historyAsync({ limit: 1 })).entries[0].principal, 'unauthenticated')
})

test('a reset fence that closes while refresh is pending prevents account attribution', async t => {
  const f = await fixture(t), held = f.hold()
  const writing = f.write('reset-during-refresh'); await held.entered
  f.reset(); held.release()
  assert.equal((await writing).principal, 'unauthenticated')
})

test('local sign-in starts without a hosted verification request', async t => {
  const f = await fixture(t, { local: true })
  assert.match(f.expectedPrincipal, /^account:/)
  await assertRecorded(f, 'local', f.expectedPrincipal)
  assert.equal(f.reads(), 0)
})
