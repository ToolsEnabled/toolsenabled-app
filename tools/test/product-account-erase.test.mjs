import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import accountModule from '../../shell/product-account.cjs'

const password = 'private-fixture-password-48'
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const safeStorage = { isEncryptionAvailable:() => true,
  encryptString:value => Buffer.from(`fixture:${value}`),
  decryptString:value => { assert.ok(value.toString().startsWith('fixture:')); return value.toString().slice(8) } }
function fixture(t, { absent = false } = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'product-account-erase-'))
  const directory = path.join(scratch, 'profile')
  if (!absent) fs.mkdirSync(directory)
  t.after(() => fs.rmSync(scratch, { recursive:true, force:true }))
  const store = accountModule.createAccountStore({ directory, safeStorage })
  return { directory, store }
}
async function localAccount(store) {
  assert.equal((await store.createAccount({ username:'fixtureuser', password })).ok, true)
  assert.equal((await store.signIn({ username:'fixtureuser', password })).ok, true)
}
function holdNativeScrypt(t, selected = 1) {
  const original = crypto.scrypt, entered = deferred()
  let calls = 0, release
  crypto.scrypt = (...args) => {
    const callback = args.pop(), call = ++calls
    return original(...args, (error, bytes) => {
      if (call !== selected) { callback(error, bytes); return }
      release = () => callback(error, bytes)
      entered.resolve()
    })
  }
  t.after(() => { crypto.scrypt = original; release?.() })
  return { entered:entered.promise, release:() => { const finish = release; release = null; finish() }, get calls() { return calls } }
}
async function pendingBeforeRelease(promise) {
  let settled = false
  promise.then(() => { settled = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false, 'cleanup still owns the original password operation')
}

test('unused local store seals without creating a profile and all retained mutators refuse', async t => {
  const { directory, store } = fixture(t, { absent:true })
  const first = store.sealForErase()
  assert.equal(store.sealForErase(), first)
  assert.deepEqual(await first, { ok:true, sealed:true, localQuiesced:true })
  for (const result of [
    await store.createAccount({ username:'fixtureuser', password }),
    await store.signIn({ username:'fixtureuser', password }),
    await store.signInWithGoogle(), await store.changePassword(),
    store.signInWithHostedAccount(), store.signOut(), store.signOutEverywhere(),
    store.changeDisplayName({ displayName:'Fixture' }), store.putSetting({ key:'mc.theme', value:'black' }),
    store.attachPaymentMethod(), store.detachPaymentMethod(), store.readAccountData('a'.repeat(32)), store.availability(),
  ]) assert.equal(result.code, 'ACCOUNT_DATA_ERASED')
  assert.equal(store.current().signedIn, false)
  assert.equal(store.hasGoogleProfiles(), false)
  assert.equal(fs.existsSync(directory), false)
})

test('an actually completed native scrypt callback cannot create or adopt account files after the seal', async t => {
  const { directory, store } = fixture(t, { absent:true })
  const held = holdNativeScrypt(t)
  const create = store.createAccount({ username:'fixtureuser', password })
  await held.entered
  const sealed = store.sealForErase()
  await pendingBeforeRelease(sealed)
  held.release()
  assert.equal((await create).code, 'ACCOUNT_DATA_ERASED')
  assert.equal((await sealed).localQuiesced, true)
  assert.equal(fs.existsSync(directory), false)
})

test('password cleanup timeout is sticky and retains the original native callback until actual settlement', async t => {
  const { directory, store } = fixture(t, { absent:true })
  const held = holdNativeScrypt(t)
  const create = store.createAccount({ username:'fixtureuser', password })
  await held.entered
  const sealed = store.sealForErase({ timeoutMs:20 })
  const failed = await sealed
  assert.equal(failed.ok, false)
  assert.equal(failed.localQuiesced, false)
  await pendingBeforeRelease(create)
  held.release()
  assert.equal((await create).code, 'ACCOUNT_DATA_ERASED')
  assert.equal(store.sealForErase(), sealed)
  assert.equal(await store.sealForErase(), failed)
  assert.equal(fs.existsSync(directory), false)
})

for (const matched of [true, false]) test(`a delayed ${matched ? 'valid' : 'invalid'} password cannot mint a session or update lockout after the seal`, async t => {
  const { directory, store } = fixture(t)
  await localAccount(store)
  store.signOut()
  const before = fs.readFileSync(store.accountsPath)
  const held = holdNativeScrypt(t)
  const login = store.signIn({ username:'fixtureuser', password:matched ? password : 'wrong-fixture-password' })
  await held.entered
  const sealed = store.sealForErase()
  await pendingBeforeRelease(sealed)
  held.release()
  assert.equal((await login).code, 'ACCOUNT_DATA_ERASED')
  assert.equal((await sealed).ok, true)
  assert.deepEqual(fs.readFileSync(store.accountsPath), before)
  assert.equal(fs.existsSync(store.sessionPath), false)
  fs.rmSync(directory, { recursive:true })
  assert.equal((await store.signIn({ username:'fixtureuser', password })).code, 'ACCOUNT_DATA_ERASED')
  assert.equal(fs.existsSync(directory), false)
})

for (const phase of [1, 2]) test(`password change stops after held native ${phase === 1 ? 'verification' : 'replacement derivation'}`, async t => {
  const { store } = fixture(t)
  await localAccount(store)
  const before = fs.readFileSync(store.accountsPath)
  const held = holdNativeScrypt(t, phase)
  const changed = store.changePassword({ currentPassword:password, newPassword:'replacement-fixture-password-49' })
  await held.entered
  const sealed = store.sealForErase()
  await pendingBeforeRelease(sealed)
  held.release()
  assert.equal((await changed).code, 'ACCOUNT_DATA_ERASED')
  assert.equal((await sealed).ok, true)
  assert.equal(held.calls, phase, 'no later password derivation starts after sealing')
  assert.deepEqual(fs.readFileSync(store.accountsPath), before)
  assert.equal(store.current().signedIn, false)
})

test('a queued account operation is gated before it starts expensive work', async t => {
  const { directory, store } = fixture(t, { absent:true })
  const create = store.createAccount({ username:'fixtureuser', password })
  const sealed = store.sealForErase()
  assert.equal((await create).code, 'ACCOUNT_DATA_ERASED')
  assert.equal((await sealed).ok, true)
  assert.equal(fs.existsSync(directory), false)
})

test('a delayed timer callback cannot extend the local store cleanup deadline', async t => {
  const { directory, store } = fixture(t, { absent:true })
  const held = holdNativeScrypt(t)
  const create = store.createAccount({ username:'fixtureuser', password })
  await held.entered
  const seal = store.sealForErase({ timeoutMs:10 })
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30)
  held.release()
  assert.equal((await create).code, 'ACCOUNT_DATA_ERASED')
  assert.equal((await seal).localQuiesced, false)
  assert.equal(fs.existsSync(directory), false)
})

test('the shared store keeps its terminal gate when a retained consumer asks for it again', async t => {
  const { directory } = fixture(t, { absent:true })
  accountModule.resetSharedAccountStoreForTests()
  t.after(() => accountModule.resetSharedAccountStoreForTests())
  const store = accountModule.sharedAccountStore({ directory, safeStorage })
  await store.sealForErase()
  const retained = accountModule.sharedAccountStore({ directory, safeStorage })
  assert.equal(retained, store)
  assert.equal((await retained.createAccount({ username:'fixtureuser', password })).code, 'ACCOUNT_DATA_ERASED')
  assert.equal(fs.existsSync(directory), false)
})
