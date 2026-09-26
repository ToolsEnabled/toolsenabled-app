import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import accountModule from '../../shell/product-account.cjs'
import clientModule from '../../shell/hosted-account-client.cjs'
import controllerModule from '../../shell/hosted-account-controller.cjs'
const { createAccountStore, REQUIRED_IDENTITY_ASSURANCE } = accountModule
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-account-store-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let verified = null
  const store = createAccountStore({ directory, hostedAccount: { verifiedAccount: () => verified } })
  return { store, directory, set: value => { verified = value } }
}

function persistedHostedFixture(t, { sessionLifetimeMs = 3600000, hostedSessionLifetimeMs = 7200000 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-session-continuity-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const account = { id: 'hosted-continuity', email: 'continuity@example.invalid' }
  let at = 1700000000000, status = 200, saved = null, logins = 0
  // An injected storage contract, not an OS keystore or an owner credential.
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value).reverse(),
    decryptString: value => Buffer.from(value).reverse().toString(),
  }
  const sessionStorage = {
    read: () => saved,
    write: value => { saved = structuredClone(value); return true },
    clear: () => { saved = null; return true },
  }
  const clientOptions = { now: () => at, sessionStorage, fetchImpl: async (address, request) => {
    assert.ok(address.startsWith('https://app.toolsenabled.ai/v1/desktop/'))
    if (request.method === 'POST') {
      logins++
      return new Response(JSON.stringify({ account }), { status: 200, headers: {
        'Set-Cookie': `__Host-te_desktop=${'f'.repeat(48)}; Secure; HttpOnly; Path=/; Expires=${new Date(at + hostedSessionLifetimeMs).toUTCString()}`,
      } })
    }
    return new Response(JSON.stringify({ account }), { status })
  } }
  const client = clientModule.createHostedAccountClient(clientOptions)
  const openStore = (hostedAccount = client) => createAccountStore({ directory, safeStorage, hostedAccount, now: () => at, sessionLifetimeMs })
  const store = openStore()
  const controller = controllerModule.createHostedAccountController({ client, store })
  return { client, store, controller, openStore, reopenClient: () => clientModule.createHostedAccountClient(clientOptions),
    sessionPath: path.join(directory, 'product-session.enc'),
    advance: value => { at += value }, status: value => { status = value }, logins: () => logins }
}

test('a recently verified hosted identity cannot open account data after its cookie expires', async t => {
  const f = persistedHostedFixture(t, { hostedSessionLifetimeMs: 30000 })
  assert.equal((await f.controller.signIn({ username: 'continuity@example.invalid', password: 'fixture' })).ok, true)
  assert.equal(f.store.putSetting({ key: 'research_queue', value: 'private-fixture' }).ok, true)
  f.advance(29999)
  assert.equal((await f.controller.current()).signedIn, true)
  assert.equal(f.store.getSetting('research_queue').value, 'private-fixture')
  f.advance(1)
  // Read the real account partition directly, before a background HTTP refresh
  // has a chance to notice expiration and clear the client's cached identity.
  assert.equal(f.client.verifiedAccount(), null)
  assert.equal(f.store.current().signedIn, false)
  assert.equal(f.store.getSetting('research_queue').ok, false)
})

for (const trigger of ['expired verification cache', 'temporary verification failure']) {
  test(`a ${trigger} denies access without discarding the saved hosted session`, async t => {
    const f = persistedHostedFixture(t)
    assert.equal((await f.controller.signIn({ username: 'continuity@example.invalid', password: 'fixture' })).persisted, true)
    const original = f.store.current(), saved = fs.readFileSync(f.sessionPath)
    if (trigger === 'expired verification cache') f.advance(60000)
    else {
      f.status(503)
      assert.equal((await f.controller.current()).code, 'HOSTED_ACCOUNT_STATUS_UNAVAILABLE')
    }
    assert.equal(f.client.verifiedAccount(), null)
    assert.equal(f.store.current().signedIn, false, 'unverified cached identity must grant no access')
    assert.deepEqual(fs.readFileSync(f.sessionPath), saved, 'uncertainty must not delete a still-saved session')
    f.status(200)
    assert.equal((await f.controller.current()).signedIn, true)
    assert.equal(f.store.current().session.id, original.session.id, 'fresh verification must retain the original session')
    assert.equal(f.store.current().account.id, original.account.id)
    assert.deepEqual(fs.readFileSync(f.sessionPath), saved)
    assert.equal(f.logins(), 1, 'recovery must not require another sign-in')
  })
}

test('reading a restored hosted session before online verification retains it for the same verified account', async t => {
  const f = persistedHostedFixture(t)
  assert.equal((await f.controller.signIn({ username: 'continuity@example.invalid', password: 'fixture' })).ok, true)
  const original = f.store.current(), saved = fs.readFileSync(f.sessionPath)
  const client = f.reopenClient(), store = f.openStore(client)
  assert.equal(store.current().signedIn, false)
  assert.deepEqual(fs.readFileSync(f.sessionPath), saved)
  const controller = controllerModule.createHostedAccountController({ client, store })
  assert.equal((await controller.current()).signedIn, true)
  assert.equal(store.current().session.id, original.session.id)
})

for (const ending of ['explicit logout', 'server revocation', 'local expiry']) {
  test(`${ending} still discards a saved hosted session while verification is unavailable`, async t => {
    const f = persistedHostedFixture(t, { sessionLifetimeMs: ending === 'local expiry' ? 60001 : 3600000 })
    assert.equal((await f.controller.signIn({ username: 'continuity@example.invalid', password: 'fixture' })).ok, true)
    f.advance(60000)
    assert.equal(f.client.verifiedAccount(), null)
    if (ending === 'explicit logout') assert.equal((await f.controller.signOut()).ok, true)
    else if (ending === 'server revocation') {
      f.status(401)
      assert.equal((await f.controller.current()).signedIn, false)
    } else f.advance(1)
    assert.equal(f.store.current().signedIn, false)
    assert.equal(fs.existsSync(f.sessionPath), false)
    if (ending !== 'local expiry') assert.equal(f.client.hasSession(), false)
  })
}
test('hosted account cannot be selected using renderer-supplied identity data', t => {
  const {store} = fixture(t)
  assert.equal(store.signInWithHostedAccount({ id:'forged', email:'forged@example.invalid' }).ok, false)
  assert.equal(store.current().signedIn, false)
})
test('hosted subject retains its settings across email changes and never merges another subject by email', t => {
  const {store,set} = fixture(t)
  set({ id:'hosted-first', email:'person@example.invalid' })
  const first = store.signInWithHostedAccount()
  assert.equal(first.ok,true)
  assert.equal(store.current().account.signInMethod,'hosted')
  assert.equal(store.current().account.username,'person@example.invalid')
  assert.equal(store.putSetting({ key:'mc.theme', value:'black' }).ok,true)
  store.signOut()
  set({ id:'hosted-first', email:'renamed@example.invalid' })
  const renamed = store.signInWithHostedAccount()
  assert.equal(renamed.account.id,first.account.id)
  assert.equal(store.getSetting('mc.theme').value,'black')
  assert.equal(store.current().account.username,'renamed@example.invalid')
  store.signOut()
  set({ id:'hosted-second', email:'renamed@example.invalid' })
  const second = store.signInWithHostedAccount()
  assert.equal(second.ok,true)
  assert.notEqual(second.account.id,first.account.id)
  assert.equal(store.getSetting('mc.theme').value,null)
})
test('hosted local attribution stops when the hosted client no longer verifies that subject', t => {
  const {store,set} = fixture(t)
  set({ id:'hosted-first', email:'person@example.invalid' })
  assert.equal(store.signInWithHostedAccount().ok,true)
  assert.equal(store.current().signedIn,true)
  set(null)
  assert.equal(store.current().signedIn,false)
})
test('Google entry refuses a hosted identity even with the Google assurance string', async t => {
  const {store} = fixture(t)
  const result = await store.signInWithGoogle({ identity: { provider:'hosted', subject:'hosted-first', email:'person@example.invalid', emailVerified:true, assurance:REQUIRED_IDENTITY_ASSURANCE } })
  assert.equal(result.ok,false)
  assert.equal(store.current().signedIn,false)
})
test('the previous-profile action requires the existing Google subject and preserves its data', async t => {
  const {store,set,directory}=fixture(t)
  const identity={provider:'google',subject:'existing-google',email:'same@example.invalid',emailVerified:true,assurance:REQUIRED_IDENTITY_ASSURANCE}
  assert.equal(store.hasGoogleProfiles(),false)
  assert.equal((await store.signInWithGoogle({identity,existingOnly:true})).code,'ACCOUNT_GOOGLE_PROFILE_NOT_FOUND')
  assert.equal(fs.existsSync(store.accountsPath),false)
  const prior=await store.signInWithGoogle({identity})
  assert.equal(store.hasGoogleProfiles(),true)
  assert.equal(store.putSetting({key:'mc.theme',value:'black'}).ok,true)
  store.signOut()
  const legacy=fs.readFileSync(store.accountsPath)
  set({id:'hosted-same-email',email:identity.email})
  const hosted=store.signInWithHostedAccount()
  assert.notEqual(hosted.account.id,prior.account.id)
  store.signOut()
  const sidecar=fs.readFileSync(path.join(directory,'hosted-product-accounts.json'))
  const wrong=await store.signInWithGoogle({identity:{...identity,subject:'another-google'},existingOnly:true})
  assert.equal(wrong.code,'ACCOUNT_GOOGLE_PROFILE_NOT_FOUND')
  assert.deepEqual(fs.readFileSync(store.accountsPath),legacy)
  assert.deepEqual(fs.readFileSync(path.join(directory,'hosted-product-accounts.json')),sidecar)
  assert.equal(store.current().signedIn,false)
  const restored=await store.signInWithGoogle({identity:{...identity,email:'renamed@example.invalid'},existingOnly:true})
  assert.equal(restored.account.id,prior.account.id)
  assert.equal(store.getSetting('mc.theme').value,'black')
  assert.deepEqual(fs.readFileSync(path.join(directory,'hosted-product-accounts.json')),sidecar)
})
test('hosted login and account changes preserve the legacy account file and its data', async t => {
  const {store,directory,set}=fixture(t)
  const identity={provider:'google',subject:'google-fixture',email:'person@example.invalid',emailVerified:true,assurance:REQUIRED_IDENTITY_ASSURANCE}
  const local=await store.signInWithGoogle({identity})
  assert.equal(local.ok,true)
  assert.equal(store.putSetting({key:'mc.theme',value:'black'}).ok,true)
  store.signOut()
  const original=fs.readFileSync(store.accountsPath)
  set({id:'hosted-fixture',email:identity.email})
  const hosted=store.signInWithHostedAccount()
  assert.equal(hosted.ok,true)
  assert.notEqual(hosted.account.id,local.account.id)
  assert.equal(store.getSetting('mc.theme').value,null)
  store.signOut()
  set({id:'hosted-fixture',email:'renamed@example.invalid'})
  assert.equal(store.signInWithHostedAccount().account.id,hosted.account.id)
  assert.deepEqual(fs.readFileSync(store.accountsPath),original)
  const sidecar=fs.readFileSync(path.join(directory,'hosted-product-accounts.json'))
  store.signOut()
  assert.equal((await store.signInWithGoogle({identity})).account.id,local.account.id)
  assert.equal(store.getSetting('mc.theme').value,'black')
  assert.deepEqual(fs.readFileSync(path.join(directory,'hosted-product-accounts.json')),sidecar)
})
