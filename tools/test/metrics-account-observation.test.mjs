import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import vm from 'node:vm'
import { createAccountStore, GOOGLE_PROVIDER, REQUIRED_IDENTITY_ASSURANCE, UNAUTHENTICATED_PRINCIPAL } from '../../shell/product-account.cjs'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { createHostedAccountClient } from '../../shell/hosted-account-client.cjs'
import { createHostedSessionStorage } from '../../shell/hosted-session-storage.cjs'

const NOW = 2000
const accountId = 'a'.repeat(32)
const sessionId = 'b'.repeat(32)
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from('fixture:' + Buffer.from(value).toString('base64')),
  decryptString: bytes => {
    const value = bytes.toString()
    if (!value.startsWith('fixture:')) throw Error('Synthetic unreadable session')
    return Buffer.from(value.slice(8), 'base64').toString()
  },
}
const account = { id: accountId, username: 'reader@example.test', displayName: 'Reader fixture',
  identity: { provider: GOOGLE_PROVIDER, subject: 'synthetic-reader', email: 'reader@example.test', emailVerified: true },
  createdAtMs: 1000, epoch: 1 }
const session = { sessionId, accountId, issuedAtMs: 1000, expiresAtMs: 4000, epoch: 1 }
function fixture(t, { sessionValue = session, accounts = [account], storage = safeStorage, hostedAccount = null, persist = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-account-observation-'))
  t.after(() => t.diagnostic('RETAINED_ACCOUNT_OBSERVATION_FIXTURE ' + directory))
  fs.writeFileSync(path.join(directory, 'product-accounts.json'), JSON.stringify({ version: 1, accounts }))
  fs.writeFileSync(path.join(directory, 'renderer-prefs.json'), JSON.stringify({ values: { 'mc.theme': 'light' } }))
  if (persist) fs.writeFileSync(path.join(directory, 'product-session.enc'), safeStorage.encryptString(JSON.stringify(sessionValue)))
  let at = NOW
  const store = createAccountStore({ directory, safeStorage: storage, hostedAccount, now: () => at })
  return { directory, store, setTime: value => { at = value } }
}
function files(directory) {
  const result = {}
  for (const name of fs.readdirSync(directory, { recursive: true }).sort()) {
    const file = path.join(directory, name), stat = fs.lstatSync(file)
    assert.ok(!stat.isSymbolicLink())
    if (stat.isDirectory()) { result[name] = { directory: true }; continue }
    assert.ok(stat.isFile())
    result[name] = { sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
      bytes: stat.size, mode: stat.mode, inode: stat.ino, modified: stat.mtimeMs }
  }
  return result
}
function observe(store) {
  let value
  assert.doesNotThrow(() => { value = store.observePrincipal() }, 'the observation must return a bounded status')
  assert.deepEqual(Object.keys(value).sort(), ['ok', 'principal', 'signedIn', 'status'])
  return value
}
function unchanged(f, expected) {
  const before = files(f.directory)
  assert.deepEqual(observe(f.store), expected)
  assert.deepEqual(observe(f.store), expected, 'a repeated read must not consume identity or change cache authority')
  assert.deepEqual(files(f.directory), before, 'read must neither unlink/rewrite session nor adopt preferences')
}
const current = { ok: true, status: 'current', signedIn: true, principal: 'account:' + accountId }
const refused = status => ({ ok: false, status, signedIn: false, principal: null })

test('a cold valid account observation preserves session files and does not adopt preferences', t => {
  const f = fixture(t)
  unchanged(f, current)
  assert.equal(fs.existsSync(f.store.dataDirectory), false)
  // The ordinary account action must still perform its existing adoption.
  assert.equal(f.store.current().principal, current.principal)
  assert.equal(fs.existsSync(f.store.accountDataPath(accountId)), true)
  unchanged(f, current)
})
test('an expired session is reported without deleting it or admitting its account', t => {
  const f = fixture(t, { sessionValue: { ...session, expiresAtMs: NOW } })
  unchanged(f, refused('expired'))
})
for (const [name, sessionValue, accounts] of [
  ['revoked epoch', { ...session, epoch: 2 }, [account]],
  ['missing account', session, []],
  ['malformed session fields', { ...session, sessionId: 'not-a-session' }, [account]],
  ['non-object session', null, [account]],
]) test(name + ' is refused without session or preference mutation', t => {
  unchanged(fixture(t, { sessionValue, accounts }), refused('invalid'))
})
test('an undecryptable persisted session is preserved and reported invalid', t => {
  const f = fixture(t, { storage: { ...safeStorage, decryptString() { throw Error('Synthetic decryption failure') } } })
  unchanged(f, refused('invalid'))
})
test('an unreadable account store is unavailable rather than signed out or current', t => {
  const f = fixture(t)
  fs.writeFileSync(f.store.accountsPath, '{synthetic invalid account file')
  unchanged(f, refused('unavailable'))
})
test('absence of a persisted session is a truthful signed-out read', t => {
  unchanged(fixture(t, { persist: false }), { ok: true, status: 'signed-out', signedIn: false, principal: UNAUTHENTICATED_PRINCIPAL })
})
test('an unavailable keystore does not claim that persisted account records are signed out', t => {
  unchanged(fixture(t, { storage: { ...safeStorage, isEncryptionAvailable: () => false } }), refused('unavailable'))
})
test('an in-memory signed-in account remains observable when session persistence is unavailable', async t => {
  const f = fixture(t, { persist: false, accounts: [], storage: { ...safeStorage, isEncryptionAvailable: () => false } })
  const answer = await f.store.signInWithGoogle({ identity: { ...account.identity, assurance: REQUIRED_IDENTITY_ASSURANCE } })
  assert.equal(answer.ok, true)
  assert.equal(answer.persisted, false)
  const before = files(f.directory), first = observe(f.store)
  assert.equal(first.status, 'current')
  assert.match(first.principal, /^account:[a-f0-9]{32}$/)
  assert.equal(observe(f.store).principal, first.principal)
  assert.deepEqual(files(f.directory), before)
  assert.equal(fs.existsSync(f.store.sessionPath), false)
})
test('a valid read rechecks expiry without consuming the cached active session', t => {
  const f = fixture(t)
  assert.equal(f.store.current().signedIn, true)
  const before = files(f.directory)
  f.setTime(session.expiresAtMs)
  assert.deepEqual(observe(f.store), refused('expired'))
  assert.deepEqual(files(f.directory), before)
})
test('hosted verification is still required and a mismatched verified identity is refused', t => {
  let verified = null
  const f = fixture(t, { accounts: [], hostedAccount: { verifiedAccount: () => verified, hasSession: () => true,
    observeSession: () => ({ status: verified ? 'current' : 'unverified', account: verified }) } })
  fs.writeFileSync(path.join(f.directory, 'hosted-product-accounts.json'), JSON.stringify({ version: 1, accounts: [{
    ...account, username: 'hosted:synthetic-hosted', identity: { provider: 'hosted', subject: 'synthetic-hosted', email: 'reader@example.test' },
  }] }))
  unchanged(f, refused('unverified'))
  verified = { id: 'other-subject', email: 'reader@example.test' }
  unchanged(f, refused('invalid'))
  verified = { id: 'synthetic-hosted', email: 'reader@example.test' }
  unchanged(f, current)
})

const main = fs.readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
const names = ['metricsAccountPrincipal', 'spawnRecordHistory', 'usageRecordHistory']
const functions = names.map(name => declaredFunctionSource(main, name)).join('\n')
function handlers(storeForRead, onRead = async () => ({ ok: true, entries: [] })) {
  const calls = []
  const read = async value => { calls.push(value); return onRead(value) }
  const scope = {
    getAccountStore: storeForRead,
    getSpawnRecorder: () => ({ historyAsync: read }),
    getUsageRecorder: () => ({ usageAsync: read }),
    accountPrincipal() { assert.fail('Metrics must not invoke the actionful principal lookup') },
    Object, Error,
  }
  return { calls, ...vm.runInNewContext(functions + '; ({spawnRecordHistory, usageRecordHistory})', scope) }
}
for (const name of ['spawnRecordHistory', 'usageRecordHistory']) {
  test(name + ' uses the non-mutating identity and preserves query scope', async t => {
    const f = fixture(t), before = files(f.directory), h = handlers(() => f.store)
    const query = { v: 1, fromMs: 100, toMs: 200, scope: 'account' }
    assert.equal((await h[name](20, query)).ok, true)
    assert.equal(h.calls.length, 1)
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0])), { limit: 20, metrics: { ...query, principal: current.principal } })
    assert.deepEqual(files(f.directory), before)
  })
  test(name + ' refuses expired identity before reading any historical records', async t => {
    const f = fixture(t, { sessionValue: { ...session, expiresAtMs: NOW } }), before = files(f.directory), h = handlers(() => f.store)
    const value = await h[name](20, { v: 1, fromMs: 100, toMs: 200 })
    assert.equal(value.ok, false)
    assert.equal(value.code, 'METRICS_ACCOUNT_EXPIRED')
    assert.equal(h.calls.length, 0)
    assert.deepEqual(files(f.directory), before)
  })
  test(name + ' rejects an identity change while records are being read', async t => {
    const f = fixture(t), before = files(f.directory)
    const h = handlers(() => f.store, async () => { f.setTime(session.expiresAtMs); return { ok: true, entries: [] } })
    assert.equal((await h[name](20, { v: 1, fromMs: 100, toMs: 200 })).code, 'METRICS_ACCOUNT_EXPIRED')
    assert.deepEqual(files(f.directory), before)
  })
  test(name + ' preserves legacy unscoped reads without consulting account state', async () => {
    const h = handlers(() => { assert.fail('Unscoped legacy history must not acquire a principal') })
    assert.equal((await h[name](20)).ok, true)
    assert.equal(h.calls.length, 1)
    assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0])), { limit: 20 })
  })
}

const hostedIdentity = { id: 'synthetic-hosted', email: 'reader@example.test' }
function hostedFixture(t, { fetchImpl = () => assert.fail('No network or identity verification expected') } = {}) {
  let at = NOW, unavailable = false, reads = 0
  const retained = { version: 1, origin: 'https://app.toolsenabled.ai',
    cookie: '__Host-te_desktop=' + crypto.randomBytes(32).toString('hex'),
    accountId: hostedIdentity.id, expiresAtMs: session.expiresAtMs }
  let saved = retained
  const storage = {
    read() { reads++; if (unavailable) throw Error('Synthetic storage temporarily unavailable'); return saved },
    write() { assert.fail('Observation must not persist a hosted session') },
    clear() { assert.fail('Observation must not clear a hosted session') },
  }
  const client = createHostedAccountClient({ now: () => at, sessionStorage: storage, fetchImpl })
  const f = fixture(t, { accounts: [], hostedAccount: client })
  fs.writeFileSync(path.join(f.directory, 'hosted-product-accounts.json'), JSON.stringify({ version: 1, accounts: [{
    ...account, username: 'hosted:' + hostedIdentity.id,
    identity: { provider: 'hosted', subject: hostedIdentity.id, email: hostedIdentity.email },
  }] }))
  return { ...f, client, retained, storage, reads: () => reads,
    setUnavailable(value) { unavailable = value },
    setSaved(value) { saved = value },
    setTime(value) { at = value; f.setTime(value) } }
}

test('actual hosted observation leaves later normal restoration available after storage failure', t => {
  const f = hostedFixture(t), before = files(f.directory)
  f.setUnavailable(true)
  assert.deepEqual(observe(f.store), refused('unavailable'))
  assert.equal(f.client.sessionPersisted(), false)
  f.setUnavailable(false)
  assert.equal(f.client.hasSession(), true, 'later normal restore must retry the now-readable storage')
  const control = createHostedAccountClient({ now: () => NOW, sessionStorage: { read: () => f.retained } })
  assert.equal(f.client.hasSession(), control.hasSession(), 'observation must not consume the ordinary restore latch')
  assert.equal(f.reads(), 2)
  assert.equal(f.client.sessionPersisted(), true, 'ordinary restore still adopts retained state')
  assert.deepEqual(files(f.directory), before)
})

test('actual cold hosted observations neither adopt nor cache successful reads', t => {
  const f = hostedFixture(t)
  unchanged(f, refused('unverified'))
  assert.equal(f.client.sessionPersisted(), false)
  assert.equal(f.client.verifiedAccount(), null)
  f.setSaved({ ...f.retained, origin: 'https://invalid.example.test' })
  unchanged(f, refused('invalid'))
  f.setSaved(f.retained)
  assert.equal(f.client.hasSession(), true)
  assert.equal(f.client.sessionPersisted(), true)
  assert.equal(f.reads(), 5, 'four observations and the independent ordinary restore each read storage')
})

test('actual hosted malformed retained states remain invalid and do not prevent a later valid restore', t => {
  const f = hostedFixture(t)
  for (const value of [false, {}, { ...f.retained, version: 2 }, { ...f.retained, cookie: '' },
    { ...f.retained, accountId: 'invalid space' }, { ...f.retained, expiresAtMs: 1.5 }]) {
    f.setSaved(value)
    unchanged(f, refused('invalid'))
    assert.equal(f.client.sessionPersisted(), false)
  }
  f.setSaved(f.retained)
  assert.equal(f.client.hasSession(), true)
})

test('actual hosted expired observation preserves storage and permits a replacement to restore', t => {
  const f = hostedFixture(t)
  f.setSaved({ ...f.retained, expiresAtMs: NOW })
  unchanged(f, refused('expired'))
  assert.equal(f.client.sessionPersisted(), false)
  f.setSaved(f.retained)
  assert.equal(f.client.hasSession(), true)
})

test('actual hosted missing state denies the local hosted principal without consuming restoration', t => {
  const f = hostedFixture(t)
  f.setSaved(null)
  unchanged(f, refused('invalid'))
  assert.deepEqual(f.client.observeSession(), { status: 'signed-out', account: null })
  f.setSaved(f.retained)
  assert.equal(f.client.hasSession(), true)
})

test('actual hosted verified cache authorizes observation without another request or storage read', async t => {
  let requests = 0
  const f = hostedFixture(t, { fetchImpl: async () => {
    requests++
    return new Response(JSON.stringify({ account: hostedIdentity }), { status: 200 })
  } })
  unchanged(f, refused('unverified'))
  assert.equal(requests, 0)
  assert.equal((await f.client.current()).signedIn, true, 'normal verification remains required')
  const reads = f.reads()
  f.setUnavailable(true)
  unchanged(f, current)
  assert.equal(f.reads(), reads, 'initialized cache remains authoritative')
  assert.equal(requests, 1, 'observation never performs online verification')
})

test('actual hosted verified identity mismatch is refused by the shared product verifier', async t => {
  const other = { id: 'other-synthetic-hosted', email: hostedIdentity.email }
  const f = hostedFixture(t, { fetchImpl: async () => new Response(JSON.stringify({ account: other }), { status: 200 }) })
  f.setSaved({ ...f.retained, accountId: other.id })
  assert.equal((await f.client.current()).signedIn, true)
  unchanged(f, refused('invalid'))
})

test('actual hosted expired cache observation does not consume ordinary expiry cleanup', async () => {
  let at = NOW, clears = 0
  let saved = { version: 1, origin: 'https://app.toolsenabled.ai',
    cookie: '__Host-te_desktop=' + crypto.randomBytes(32).toString('hex'),
    accountId: hostedIdentity.id, expiresAtMs: 3000 }
  const client = createHostedAccountClient({ now: () => at,
    fetchImpl: () => assert.fail('Expired session must not request a server'),
    sessionStorage: { read: () => saved, clear() { clears++; saved = null; return true } } })
  assert.equal(client.hasSession(), true)
  at = 3000
  assert.deepEqual(client.observeSession(), { status: 'expired', account: null })
  assert.equal(clears, 0)
  assert.equal(client.hasSession(), true, 'observation cannot clear the authoritative cache')
  assert.deepEqual(await client.current(), { ok: true, signedIn: false })
  assert.equal(clears, 1, 'ordinary action still performs its existing synthetic-storage cleanup')
  assert.equal(saved, null)
})

for (const name of ['spawnRecordHistory', 'usageRecordHistory']) test(name + ' reports unavailable actual hosted storage before reading records', async t => {
  const f = hostedFixture(t), before = files(f.directory), h = handlers(() => f.store)
  f.setUnavailable(true)
  const result = await h[name](20, { v: 1, fromMs: 100, toMs: 200 })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'METRICS_ACCOUNT_UNAVAILABLE')
  assert.equal(h.calls.length, 0)
  f.setUnavailable(false)
  assert.equal(f.client.hasSession(), true)
  assert.deepEqual(files(f.directory), before)
})

function actualStorageFixture(t, { lockAfterProductRead = false, present = true, storedValue } = {}) {
  let available = true, unreadable = false, directory
  const protectedStorage = { ...safeStorage,
    isEncryptionAvailable: () => available,
    decryptString(bytes) {
      if (unreadable) throw Error('Synthetic keystore lost access during decryption')
      const decoded = safeStorage.decryptString(bytes)
      if (lockAfterProductRead && JSON.parse(decoded)?.sessionId) available = false
      return decoded
    },
  }
  const storage = createHostedSessionStorage({ directory: () => directory, safeStorage: protectedStorage })
  const client = createHostedAccountClient({ now: () => NOW, sessionStorage: storage,
    fetchImpl: () => assert.fail('No network or live identity call permitted') })
  const f = fixture(t, { accounts: [], hostedAccount: client, storage: protectedStorage })
  directory = f.directory
  fs.writeFileSync(path.join(directory, 'hosted-product-accounts.json'), JSON.stringify({ version: 1, accounts: [{
    ...account, username: 'hosted:' + hostedIdentity.id,
    identity: { provider: 'hosted', subject: hostedIdentity.id, email: hostedIdentity.email },
  }] }))
  const retained = storedValue === undefined ? { version: 1, origin: 'https://app.toolsenabled.ai',
    cookie: '__Host-te_desktop=' + crypto.randomBytes(32).toString('hex'),
    accountId: hostedIdentity.id, expiresAtMs: session.expiresAtMs } : storedValue
  if (present) fs.writeFileSync(path.join(directory, 'hosted-session.enc'),
    safeStorage.encryptString(JSON.stringify(retained)), { mode: 0o600 })
  return { ...f, storage, client, setAvailable(value) { available = value }, setUnreadable(value) { unreadable = value } }
}

test('actual hosted storage availability transitions remain unavailable through principal and both Metrics handlers', async t => {
  const direct = actualStorageFixture(t), directBefore = files(direct.directory)
  direct.setAvailable(false)
  assert.deepEqual(direct.client.observeSession(), { status: 'unavailable', account: null })
  direct.setAvailable(true)
  assert.deepEqual(direct.client.observeSession(), { status: 'unverified', account: null })
  assert.equal(direct.client.hasSession(), true, 'a failed storage observation cannot consume normal restore')
  assert.deepEqual(files(direct.directory), directBefore)
  const principal = actualStorageFixture(t, { lockAfterProductRead: true }), before = files(principal.directory)
  assert.deepEqual(observe(principal.store), refused('unavailable'))
  principal.setAvailable(true)
  assert.equal(principal.client.hasSession(), true)
  assert.deepEqual(files(principal.directory), before)
  for (const name of ['spawnRecordHistory', 'usageRecordHistory']) {
    const f = actualStorageFixture(t, { lockAfterProductRead: true }), original = files(f.directory), h = handlers(() => f.store)
    const result = await h[name](20, { v: 1, fromMs: 100, toMs: 200 })
    assert.equal(result.code, 'METRICS_ACCOUNT_UNAVAILABLE')
    assert.equal(h.calls.length, 0)
    f.setAvailable(true)
    assert.equal(f.client.hasSession(), true)
    assert.deepEqual(files(f.directory), original)
  }
})

test('actual absent hosted storage remains distinct from unavailable storage without creating a file', t => {
  const f = actualStorageFixture(t, { present: false }), before = files(f.directory)
  assert.deepEqual(f.storage.observe(), { status: 'absent' })
  assert.equal(f.storage.read(), null, 'ordinary absent read retains its null contract')
  assert.deepEqual(f.client.observeSession(), { status: 'signed-out', account: null })
  f.setAvailable(false)
  assert.deepEqual(f.client.observeSession(), { status: 'unavailable', account: null })
  assert.deepEqual(files(f.directory), before)
})

test('actual present malformed hosted records cannot masquerade as absence', t => {
  for (const storedValue of [null, false, {}, { version: 2 }]) {
    const f = actualStorageFixture(t, { storedValue }), before = files(f.directory)
    assert.equal(f.storage.observe().status, 'present')
    assert.deepEqual(f.client.observeSession(), { status: 'invalid', account: null })
    unchanged(f, refused('invalid'))
    assert.deepEqual(files(f.directory), before)
  }
})

test('actual hosted decryption failure stays unavailable and leaves subsequent ordinary restore usable', t => {
  const f = actualStorageFixture(t), before = files(f.directory)
  f.setUnreadable(true)
  assert.deepEqual(f.client.observeSession(), { status: 'unavailable', account: null })
  assert.throws(() => f.storage.read(), /Synthetic keystore lost access/, 'normal read keeps its existing error contract')
  f.setUnreadable(false)
  assert.deepEqual(f.client.observeSession(), { status: 'unverified', account: null })
  assert.equal(f.client.hasSession(), true)
  assert.deepEqual(files(f.directory), before)
})

test('actual ordinary hosted read keeps its unavailable-null contract while observation remains explicit', t => {
  const f = actualStorageFixture(t), before = files(f.directory)
  f.setAvailable(false)
  assert.equal(f.storage.read(), null)
  assert.deepEqual(f.storage.observe(), { status: 'unavailable' })
  assert.equal(f.client.sessionPersisted(), false)
  f.setAvailable(true)
  assert.equal(f.storage.observe().status, 'present')
  assert.equal(f.storage.read().accountId, hostedIdentity.id)
  assert.equal(f.client.sessionPersisted(), false, 'neither storage API adopts client state')
  assert.equal(f.client.hasSession(), true)
  assert.equal(f.client.sessionPersisted(), true)
  assert.deepEqual(files(f.directory), before)
})
