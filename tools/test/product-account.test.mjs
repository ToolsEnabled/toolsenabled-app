// THE PRODUCT ACCOUNT: is it actually an auth system, or does it just look
// like one?
//
// The owner ruled that a user login is a launch requirement, and an auth system
// is the one kind of code where "it works when I try it" is worth nothing. All
// three of the ways this can be quietly wrong are silent from the interface:
//
//   1. THE SECRET IS RECOVERABLE. A password stored in the clear, or reversibly,
//      or hashed at parameters cheap enough to brute force. Nothing on screen
//      changes; the failure only appears when the file is stolen.
//   2. IT FAILS OPEN. An unreadable, absent, corrupt, expired or superseded
//      piece of state resolving to SIGNED IN rather than signed out. This is the
//      exact mutant that survived a first mutation round on a peer lane -- an
//      unreadable preference resolving to "use judgement" instead of refusing --
//      so every failure path below is asserted individually rather than trusted
//      to a single happy-path test.
//   3. REVOCATION IS DECORATIVE. Signing out that only deletes a file, so a copy
//      of it taken beforehand still works. An expiry nothing ever checks.
//
// NO ASSERTION HERE COMPARES A SECRET. They assert shape, presence, absence and
// refusal codes. The one place a password value appears is where a test proves
// it is NOT in a file, which is the only honest way to check that.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  LOCKOUT_MS,
  MAX_FAILED_ATTEMPTS,
  MIN_PASSWORD_LENGTH,
  PRINCIPAL_PREFIX,
  SCRYPT_PARAMETERS,
  UNAUTHENTICATED_PRINCIPAL,
  createAccountStore,
  decodeVerifier,
  normalizeUsername,
  verifyPassword,
} from '../../shell/product-account.cjs'

/* A fake keystore, so these run without Electron. It stands in for
   safeStorage's contract only, and it genuinely transforms the bytes rather
   than prefixing them -- so a test asserting the session is not readable on
   disk is testing THIS MODULE's encryption and not the fake's passthrough. */
function keystore({ available = true, corruptOnRead = false, failOnWrite = false } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: text => {
      if (failOnWrite) throw new Error('keystore refused')
      return Buffer.from(`enc:${Buffer.from(text, 'utf8').toString('base64')}`, 'utf8')
    },
    decryptString: buffer => {
      if (corruptOnRead) throw new Error('decryption failed')
      const stored = buffer.toString('utf8')
      if (!stored.startsWith('enc:')) throw new Error('not encrypted by this keystore')
      return Buffer.from(stored.slice(4), 'base64').toString('utf8')
    },
  }
}

function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), 'product-account-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

const PASSWORD = 'correct horse battery staple'
const OTHER_PASSWORD = 'a different set of words entirely'

function store(directory, options = {}) {
  return createAccountStore({ safeStorage: keystore(options.keystore), directory, ...options.store })
}

async function withAccount(directory, options = {}) {
  const account = store(directory, options)
  const created = await account.createAccount({ username: 'josh', displayName: 'Josh P', password: PASSWORD })
  assert.equal(created.ok, true, 'the fixture account must be creatable')
  return account
}

test('a failed durable rename does not leave the replacement file behind', async (t) => {
  const directory = workspace(t)
  const account = store(directory)
  const renameSync = fs.renameSync
  fs.renameSync = () => { throw new Error('simulated rename failure') }
  try {
    const created = await account.createAccount({ username: 'josh', password: PASSWORD })
    assert.equal(created.ok, false)
    assert.equal(created.code, 'ACCOUNT_STORE_WRITE_FAILED')
    assert.deepEqual(readdirSync(directory), [], 'the failed replacement was left beside the account file')
  } finally {
    fs.renameSync = renameSync
  }
})

/* ------------------------------ the secret ------------------------------ */

test('the password is not on disk, in any form, anywhere in the account directory', async (t) => {
  const directory = workspace(t)
  const account = await withAccount(directory)
  assert.equal((await account.signIn({ username: 'josh', password: PASSWORD })).ok, true)

  /* Every file the store touched, not just the one it is expected to write.
     A password leaking into a stray temp file is still a leak. */
  const files = readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
  assert.ok(files.length > 0, 'the store must have written something')
  for (const entry of files) {
    const name = join(entry.parentPath, entry.name)
    const bytes = readFileSync(name)
    const text = bytes.toString('utf8')
    const base64 = bytes.toString('base64')
    assert.ok(!text.includes(PASSWORD), `${name} contains the password in the clear`)
    assert.ok(!text.includes(Buffer.from(PASSWORD, 'utf8').toString('base64')), `${name} contains the password base64-encoded`)
    assert.ok(!base64.includes(Buffer.from(PASSWORD, 'utf8').toString('base64')), `${name} contains the password base64-encoded`)
    /* A single word of it is enough to lose. */
    assert.ok(!text.includes('staple'), `${name} contains part of the password`)
  }
})

test('the stored verifier is scrypt at the shipped parameters, with a per-account random salt', async (t) => {
  const directory = workspace(t)
  const account = store(directory)
  assert.equal((await account.createAccount({ username: 'ann', password: PASSWORD })).ok, true)
  assert.equal((await account.createAccount({ username: 'bea', password: PASSWORD })).ok, true)

  const written = JSON.parse(readFileSync(account.accountsPath, 'utf8'))
  assert.equal(written.accounts.length, 2)

  const salts = new Set()
  for (const entry of written.accounts) {
    const decoded = decodeVerifier(entry.verifier)
    assert.ok(decoded, 'the verifier must be in the documented scrypt form')
    assert.equal(decoded.parameters.N, SCRYPT_PARAMETERS.N)
    assert.equal(decoded.parameters.r, SCRYPT_PARAMETERS.r)
    assert.equal(decoded.parameters.p, SCRYPT_PARAMETERS.p)
    assert.ok(decoded.salt.length >= 16, 'the salt must be at least 16 bytes')
    assert.equal(decoded.digest.length, SCRYPT_PARAMETERS.keyLength)
    salts.add(decoded.salt.toString('hex'))
  }
  /* Two accounts with the SAME password must not produce the same verifier.
     A shared or absent salt is what makes one cracked password crack every
     account at once, and it is invisible from the interface. */
  assert.equal(salts.size, 2, 'each account must have its own salt')
  assert.notEqual(written.accounts[0].verifier, written.accounts[1].verifier)
})

/* The cost is the security property. It is asserted as an exact value, not a
   floor, because a "tuning" commit that lowers it is a security change and must
   read as one in review rather than passing as a performance tweak.
   N=2^17, r=8, p=1 is the configuration OWASP lists first for scrypt. */
test('the shipped scrypt cost is the OWASP configuration and cannot be lowered silently', () => {
  assert.deepEqual({ ...SCRYPT_PARAMETERS }, { N: 131072, r: 8, p: 1, keyLength: 64 })
  assert.equal(SCRYPT_PARAMETERS.N, 2 ** 17)
  assert.ok(128 * SCRYPT_PARAMETERS.N * SCRYPT_PARAMETERS.r >= 128 * 1024 * 1024,
    'the memory cost must stay at or above 128 MiB')
})

test('no reply from any channel carries a password, a verifier, a salt or a token', async (t) => {
  const directory = workspace(t)
  const account = store(directory)

  const replies = [
    account.availability(),
    await account.createAccount({ username: 'josh', displayName: 'Josh P', password: PASSWORD }),
    await account.signIn({ username: 'josh', password: PASSWORD }),
    account.current(),
    await account.signIn({ username: 'josh', password: 'wrong wrong wrong wrong' }),
    await account.changePassword({ currentPassword: PASSWORD, newPassword: OTHER_PASSWORD }),
    account.signOut(),
    account.signOutEverywhere(),
  ]
  for (const reply of replies) {
    const encoded = JSON.stringify(reply)
    assert.ok(!encoded.includes(PASSWORD), `a reply carried the password: ${encoded}`)
    assert.ok(!encoded.includes(OTHER_PASSWORD), `a reply carried the new password: ${encoded}`)
    assert.ok(!encoded.includes('scrypt$'), `a reply carried the verifier: ${encoded}`)
    assert.ok(!/"(verifier|salt|token|digest|epoch)"/.test(encoded), `a reply carried an internal secret field: ${encoded}`)
  }
})

/* The defensive branch inside verifyPassword, exercised directly.
 *
 * In normal operation `readStore` refuses a malformed verifier long before this
 * function sees one, so a mutation that made it ADMIT on an unreadable verifier
 * survived the entire suite: the branch was real, the coverage was not. An
 * unreachable fail-open is a fail-open waiting for the guard in front of it to
 * be changed by somebody who does not know it was load-bearing. */
test('an unreadable verifier is never a match, whatever the password', async () => {
  for (const stored of [
    undefined, null, 42, '', 'nonsense', 'scrypt$', 'scrypt$N=1$$', 'bcrypt$N=131072,r=8,p=1$c2FsdA==$ZGlnZXN0',
    'scrypt$N=0,r=8,p=1$c2FsdA==$ZGlnZXN0', 'scrypt$N=131072,r=8,p=1$c2E=$ZGln',
  ]) {
    assert.equal(await verifyPassword(PASSWORD, stored), false,
      `an unreadable verifier (${JSON.stringify(stored)}) must never verify`)
    assert.equal(await verifyPassword('', stored), false)
  }
})

test('a well-formed verifier matches its own password and nothing else', async (t) => {
  const directory = workspace(t)
  const account = await withAccount(directory)
  const stored = JSON.parse(readFileSync(account.accountsPath, 'utf8')).accounts[0].verifier
  assert.equal(await verifyPassword(PASSWORD, stored), true)
  assert.equal(await verifyPassword(OTHER_PASSWORD, stored), false)
  assert.equal(await verifyPassword(`${PASSWORD} `, stored), false, 'a trailing space is a different password')
})

/* ---------------------- create, sign in, out, again ---------------------- */

test('a person can create an account, sign in, and be named by the principal', async (t) => {
  const directory = workspace(t)
  const account = store(directory)

  assert.equal(account.principal(), UNAUTHENTICATED_PRINCIPAL)
  assert.equal(account.current().signedIn, false)

  const created = await account.createAccount({ username: 'Josh', displayName: 'Josh P', password: PASSWORD })
  assert.equal(created.ok, true)
  assert.equal(created.account.username, 'josh', 'the username is normalized to lower case')

  /* Creating does NOT sign anyone in. The two are separate actions, so an
     account file appearing on disk can never by itself produce a signed-in
     user. */
  assert.equal(account.principal(), UNAUTHENTICATED_PRINCIPAL)

  const signedIn = await account.signIn({ username: 'JOSH', password: PASSWORD })
  assert.equal(signedIn.ok, true)
  assert.equal(signedIn.persisted, true)

  const state = account.current()
  assert.equal(state.signedIn, true)
  assert.equal(state.account.displayName, 'Josh P')
  assert.match(state.principal, new RegExp(`^${PRINCIPAL_PREFIX}[0-9a-f]{32}$`))
  assert.equal(account.principal(), state.principal)
})

test('the sign-in survives a relaunch, and signing out ends it', async (t) => {
  const directory = workspace(t)
  const first = await withAccount(directory)
  const signedIn = await first.signIn({ username: 'josh', password: PASSWORD })
  assert.equal(signedIn.ok, true)
  const principal = first.principal()

  /* A SECOND STORE over the same directory is what a relaunch is: new process,
     new in-memory state, same files. */
  const relaunched = store(directory)
  assert.equal(relaunched.current().signedIn, true)
  assert.equal(relaunched.principal(), principal, 'the same person must be named after a relaunch')

  relaunched.signOut()
  assert.equal(relaunched.principal(), UNAUTHENTICATED_PRINCIPAL)

  const afterSignOut = store(directory)
  assert.equal(afterSignOut.current().signedIn, false)
  assert.equal(afterSignOut.principal(), UNAUTHENTICATED_PRINCIPAL)
})

test('the persisted session is encrypted, not readable JSON on disk', async (t) => {
  const directory = workspace(t)
  const account = await withAccount(directory)
  assert.equal((await account.signIn({ username: 'josh', password: PASSWORD })).ok, true)

  const raw = readFileSync(account.sessionPath, 'utf8')
  assert.match(raw, /^enc:/, 'the session must go through the keystore')
  assert.ok(!raw.includes('accountId'), 'the session must not be readable as plain JSON')
  assert.ok(!raw.includes('sessionId'), 'the session must not be readable as plain JSON')
})

/* ------------------------------ fails closed ------------------------------ */
//
// Each of these plants ONE broken thing and asserts the answer is SIGNED OUT.
// They are separate tests on purpose: a single test covering all of them can be
// satisfied by a single early return, which is exactly the shape that hides a
// fail-open branch behind a fail-closed one.

test('fails closed: a session file that cannot be decrypted', async (t) => {
  const directory = workspace(t)
  const account = await withAccount(directory)
  assert.equal((await account.signIn({ username: 'josh', password: PASSWORD })).ok, true)

  const broken = createAccountStore({ safeStorage: keystore({ corruptOnRead: true }), directory })
  assert.equal(broken.current().signedIn, false)
  assert.equal(broken.principal(), UNAUTHENTICATED_PRINCIPAL)
})

test('fails closed: a session file of garbage bytes', async (t) => {
  const directory = workspace(t)
  const account = await withAccount(directory)
  assert.equal((await account.signIn({ username: 'josh', password: PASSWORD })).ok, true)

  writeFileSync(account.sessionPath, Buffer.from('not encrypted by anything'))
  assert.equal(store(directory).principal(), UNAUTHENTICATED_PRINCIPAL)
})

test('fails closed: a session file that decrypts to a valid-looking but wrong shape', async (t) => {
  const directory = workspace(t)
  const account = await withAccount(directory)
  assert.equal((await account.signIn({ username: 'josh', password: PASSWORD })).ok, true)

  /* Encrypted correctly by the same keystore, so decryption SUCCEEDS -- the
     refusal has to come from validating the contents, which is the check most
     easily left out. */
  const forged = keystore().encryptString(JSON.stringify({
    sessionId: 'f'.repeat(32),
    accountId: 'a'.repeat(32),
    issuedAtMs: Date.now(),
    expiresAtMs: Date.now() + 86_400_000,
    epoch: 1,
  }))
  writeFileSync(account.sessionPath, forged)
  assert.equal(store(directory).principal(), UNAUTHENTICATED_PRINCIPAL,
    'a session naming an account that does not exist must not sign anyone in')
})

/* JSON.parse accepts `null`, `"text"` and `42` as perfectly valid documents.
   Each of them then meets a property read on the way to being validated, and a
   TypeError thrown out of a read that the whole shell calls inside the spawn
   path is not "signed out" -- it is a crash on the path that starts an agent. */
test('fails closed: a session file that decrypts to valid JSON that is not an object', async (t) => {
  const directory = workspace(t)
  const account = await withAccount(directory)
  assert.equal((await account.signIn({ username: 'josh', password: PASSWORD })).ok, true)

  for (const document of ['null', '"signed in"', '42', '[]', 'true']) {
    writeFileSync(account.sessionPath, keystore().encryptString(document))
    const reopened = store(directory)
    assert.doesNotThrow(() => reopened.current(), `a session file of ${document} must not throw`)
    assert.equal(reopened.current().signedIn, false, `a session file of ${document} must not sign anyone in`)
    assert.equal(reopened.principal(), UNAUTHENTICATED_PRINCIPAL)
  }
})

/* An account file that could not be read is a security-relevant event, not a
   hiccup. Having answered "signed out" once because of it, the store must not
   silently resurrect the old session when the file becomes readable again --
   the person signs in, which is cheap, rather than being re-admitted by a
   recovery nobody observed. */
test('fails closed: a session is not resurrected after the account file becomes readable again', async (t) => {
  const directory = workspace(t)
  const account = await withAccount(directory)
  assert.equal((await account.signIn({ username: 'josh', password: PASSWORD })).ok, true)
  const goodStore = readFileSync(account.accountsPath)

  const reopened = store(directory)
  assert.equal(reopened.current().signedIn, true, 'the fixture must start signed in')

  writeFileSync(account.accountsPath, '{ not json')
  assert.equal(reopened.current().signedIn, false, 'an unreadable account file signs the session out')

  writeFileSync(account.accountsPath, goodStore)
  assert.equal(reopened.current().signedIn, false,
    'and the session stays out; a readable file again is not a re-authentication')
  assert.equal(reopened.principal(), UNAUTHENTICATED_PRINCIPAL)
})

test('fails closed: an expired session', async (t) => {
  const directory = workspace(t)

  /* THE FIXTURE GETS THE INJECTED CLOCK TOO, not just the reader below.
     Measured 2026-08-11 (R1526): with three suite runs going at once this
     case failed on the line under the sign-in -- `signedIn` was already
     false -- because the lifetime here is ONE REAL SECOND and the machine
     took longer than that to get from signIn() to the check. The runner
     recorded duration_ms 2006 for the case that failed. Nothing had failed
     closed; the test was racing the wall clock to set up its own
     precondition, and losing.
     The claim being made is "a session past its lifetime is not signed in",
     and that claim has nothing to do with how fast the machine is. The case
     immediately below already knew this and says so in three words. */
  let clock = Date.now()
  const account = await withAccount(directory, { store: { sessionLifetimeMs: 1000, now: () => clock } })
  assert.equal((await account.signIn({ username: 'josh', password: PASSWORD })).ok, true)
  assert.equal(account.current().signedIn, true)

  /* Time moves, nothing else does. */
  clock += 60_000
  const later = createAccountStore({ safeStorage: keystore(), directory, now: () => clock })
  assert.equal(later.current().signedIn, false)
  assert.equal(later.principal(), UNAUTHENTICATED_PRINCIPAL)
})

test('fails closed: a session that expires while the window is still open', async (t) => {
  const directory = workspace(t)
  let clock = Date.now()
  const account = createAccountStore({ safeStorage: keystore(), directory, now: () => clock, sessionLifetimeMs: 60_000 })
  assert.equal((await account.createAccount({ username: 'josh', password: PASSWORD })).ok, true)
  assert.equal((await account.signIn({ username: 'josh', password: PASSWORD })).ok, true)
  assert.equal(account.current().signedIn, true)

  /* The same live store, no relaunch. An expiry only checked at startup is an
     expiry a long-running window never reaches. */
  clock += 120_000
  assert.equal(account.current().signedIn, false)
  assert.equal(account.principal(), UNAUTHENTICATED_PRINCIPAL)
})

test('fails closed: an unreadable account file refuses rather than offering a fresh start', async (t) => {
  const directory = workspace(t)
  const account = await withAccount(directory)
  writeFileSync(account.accountsPath, '{ this is not json')

  const damaged = store(directory)
  const availability = damaged.availability()
  assert.equal(availability.ok, false)
  assert.equal(availability.code, 'ACCOUNT_STORE_CORRUPT')
  assert.equal(damaged.current().signedIn, false)
  assert.equal(damaged.principal(), UNAUTHENTICATED_PRINCIPAL)

  /* And it must not quietly let a new account be written over the one it could
     not read. */
  const created = await damaged.createAccount({ username: 'someone', password: PASSWORD })
  assert.equal(created.ok, false)
  assert.equal(created.code, 'ACCOUNT_STORE_CORRUPT')
})

test('fails closed: an account file whose entry is missing its verifier', async (t) => {
  const directory = workspace(t)
  const account = await withAccount(directory)
  const written = JSON.parse(readFileSync(account.accountsPath, 'utf8'))
  delete written.accounts[0].verifier
  writeFileSync(account.accountsPath, JSON.stringify(written))

  const damaged = store(directory)
  assert.equal(damaged.availability().ok, false)
  assert.equal(damaged.principal(), UNAUTHENTICATED_PRINCIPAL)
  /* An entry with no verifier must never be signable-into with any password. */
  const attempt = await damaged.signIn({ username: 'josh', password: PASSWORD })
  assert.equal(attempt.ok, false)
})

test('fails closed: no keystore means signed out after relaunch, not signed in', async (t) => {
  const directory = workspace(t)
  const account = createAccountStore({ safeStorage: keystore({ available: false }), directory })
  assert.equal((await account.createAccount({ username: 'josh', password: PASSWORD })).ok, true)

  const availability = account.availability()
  assert.equal(availability.ok, true, 'a missing keystore must not make the product unusable')
  assert.equal(availability.canPersistSession, false, 'and it must say so rather than pretend')

  const signedIn = await account.signIn({ username: 'josh', password: PASSWORD })
  assert.equal(signedIn.ok, true, 'sign-in still works for this run')
  assert.equal(signedIn.persisted, false, 'and reports that it will not survive a relaunch')
  assert.equal(account.current().signedIn, true)

  const relaunched = createAccountStore({ safeStorage: keystore({ available: false }), directory })
  assert.equal(relaunched.principal(), UNAUTHENTICATED_PRINCIPAL)
})

test('fails closed: a store with no safeStorage at all', async (t) => {
  const directory = workspace(t)
  const account = createAccountStore({ safeStorage: undefined, directory })
  assert.equal(account.availability().canPersistSession, false)
  assert.equal(account.principal(), UNAUTHENTICATED_PRINCIPAL)
  assert.equal((await account.createAccount({ username: 'josh', password: PASSWORD })).ok, true)
  assert.equal((await account.signIn({ username: 'josh', password: PASSWORD })).ok, true)
  assert.equal(account.current().signedIn, true, 'this run signs in')
  assert.equal(createAccountStore({ safeStorage: undefined, directory }).principal(), UNAUTHENTICATED_PRINCIPAL)
})

/* ------------------------------- revocation ------------------------------- */

test('signing out everywhere refuses a session file copied beforehand', async (t) => {
  const directory = workspace(t)
  const account = await withAccount(directory)
  assert.equal((await account.signIn({ username: 'josh', password: PASSWORD })).ok, true)

  /* The backup a real attacker takes: the exact bytes, while they were valid. */
  const stolen = readFileSync(account.sessionPath)

  const revoked = account.signOutEverywhere()
  assert.equal(revoked.ok, true)
  assert.equal(revoked.revoked, true)

  writeFileSync(account.sessionPath, stolen)
  const replayed = store(directory)
  assert.equal(replayed.current().signedIn, false, 'a revoked session must not be replayable')
  assert.equal(replayed.principal(), UNAUTHENTICATED_PRINCIPAL)
})

test('changing the password ends every session and only the new password works', async (t) => {
  const directory = workspace(t)
  const account = await withAccount(directory)
  assert.equal((await account.signIn({ username: 'josh', password: PASSWORD })).ok, true)
  const stolen = readFileSync(account.sessionPath)

  const wrongCurrent = await account.changePassword({ currentPassword: 'not the password', newPassword: OTHER_PASSWORD })
  assert.equal(wrongCurrent.ok, false)
  assert.equal(wrongCurrent.code, 'ACCOUNT_CREDENTIALS_REJECTED')
  assert.equal(account.current().signedIn, true, 'a refused change must not sign anyone out')

  const changed = await account.changePassword({ currentPassword: PASSWORD, newPassword: OTHER_PASSWORD })
  assert.equal(changed.ok, true)
  assert.equal(changed.signedOut, true)
  assert.equal(account.principal(), UNAUTHENTICATED_PRINCIPAL, 'changing the password signs this window out')

  writeFileSync(account.sessionPath, stolen)
  assert.equal(store(directory).principal(), UNAUTHENTICATED_PRINCIPAL,
    'a session from before the password change must not be replayable')

  assert.equal((await account.signIn({ username: 'josh', password: PASSWORD })).ok, false, 'the old password must stop working')
  assert.equal((await account.signIn({ username: 'josh', password: OTHER_PASSWORD })).ok, true, 'the new password must work')
})

test('changing the password requires being signed in', async (t) => {
  const directory = workspace(t)
  const account = await withAccount(directory)
  const refused = await account.changePassword({ currentPassword: PASSWORD, newPassword: OTHER_PASSWORD })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'ACCOUNT_NOT_SIGNED_IN')
})

/* ------------------------------- refusals ------------------------------- */

test('a wrong password and an unknown username are indistinguishable', async (t) => {
  const directory = workspace(t)
  const account = await withAccount(directory)

  const wrongPassword = await account.signIn({ username: 'josh', password: 'wrong wrong wrong wrong' })
  const noSuchUser = await account.signIn({ username: 'nobody', password: 'wrong wrong wrong wrong' })

  /* Identical code AND identical wording. Two different messages enumerate the
     account list to anyone willing to read them. */
  assert.equal(wrongPassword.ok, false)
  assert.equal(wrongPassword.code, 'ACCOUNT_CREDENTIALS_REJECTED')
  assert.equal(noSuchUser.code, wrongPassword.code)
  assert.equal(noSuchUser.reason, wrongPassword.reason)
  assert.ok(!wrongPassword.reason.includes('josh'), 'the refusal must not confirm the username exists')
})

/* Identical WORDING is not enough on its own. If an unknown username returns in
   microseconds while a wrong password takes about a second, the account list is
   enumerable with a stopwatch regardless of what the message says -- and no
   assertion on the message can see that.

   The bound is a floor, not a comparison between the two timings. A test that
   asserted the two durations were close would be flaky on a loaded machine; a
   floor is not, because the only way to come in under it is to skip the
   derivation entirely, which is exactly the defect. The real work is ~450ms
   here, so 100ms is far below the true cost and far above any code path that
   does not hash. */
test('an unknown username costs the same work as a real one, so the account list is not enumerable', async (t) => {
  const directory = workspace(t)
  const account = await withAccount(directory)

  const started = process.hrtime.bigint()
  const unknown = await account.signIn({ username: 'nobodyhere', password: 'wrong wrong wrong wrong' })
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6

  assert.equal(unknown.code, 'ACCOUNT_CREDENTIALS_REJECTED')
  assert.ok(elapsedMs >= 100,
    `an unknown username answered in ${elapsedMs.toFixed(1)}ms, fast enough to distinguish it from a real one`)
})

test('a malformed sign-in request also costs the work, rather than returning instantly', async (t) => {
  const directory = workspace(t)
  const account = await withAccount(directory)
  const started = process.hrtime.bigint()
  const refused = await account.signIn({ username: 'josh', password: null })
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
  assert.equal(refused.code, 'ACCOUNT_CREDENTIALS_REJECTED')
  assert.ok(elapsedMs >= 100, `a malformed request answered in ${elapsedMs.toFixed(1)}ms`)
})

test('repeated wrong passwords lock the account, and the lock survives a relaunch', async (t) => {
  const directory = workspace(t)
  let clock = Date.now()
  const account = createAccountStore({ safeStorage: keystore(), directory, now: () => clock })
  assert.equal((await account.createAccount({ username: 'josh', password: PASSWORD })).ok, true)

  for (let attempt = 1; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
    const result = await account.signIn({ username: 'josh', password: 'wrong wrong wrong wrong' })
    assert.equal(result.code, 'ACCOUNT_CREDENTIALS_REJECTED', `attempt ${attempt} should not lock yet`)
  }
  const locked = await account.signIn({ username: 'josh', password: 'wrong wrong wrong wrong' })
  assert.equal(locked.code, 'ACCOUNT_LOCKED')

  /* THE RIGHT password is refused while locked, or the lock buys nothing. */
  const whileLocked = await account.signIn({ username: 'josh', password: PASSWORD })
  assert.equal(whileLocked.code, 'ACCOUNT_LOCKED')

  /* A new process must not clear it -- otherwise the lock is bypassed by
     closing the window. */
  const relaunched = createAccountStore({ safeStorage: keystore(), directory, now: () => clock })
  assert.equal((await relaunched.signIn({ username: 'josh', password: PASSWORD })).code, 'ACCOUNT_LOCKED')

  clock += LOCKOUT_MS + 1000
  const afterWait = createAccountStore({ safeStorage: keystore(), directory, now: () => clock })
  assert.equal((await afterWait.signIn({ username: 'josh', password: PASSWORD })).ok, true, 'the lock must expire')
})

test('a successful sign-in clears the failed-attempt count', async (t) => {
  const directory = workspace(t)
  const account = await withAccount(directory)
  for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS - 1; attempt += 1) {
    await account.signIn({ username: 'josh', password: 'wrong wrong wrong wrong' })
  }
  assert.equal((await account.signIn({ username: 'josh', password: PASSWORD })).ok, true)
  /* If the counter had not been cleared, this run of wrong attempts would lock. */
  for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS - 1; attempt += 1) {
    const result = await account.signIn({ username: 'josh', password: 'wrong wrong wrong wrong' })
    assert.equal(result.code, 'ACCOUNT_CREDENTIALS_REJECTED')
  }
})

test('the password rules are enforced where they can be, and stated as they are', async (t) => {
  const directory = workspace(t)
  const account = store(directory)

  const short = await account.createAccount({ username: 'josh', password: 'a'.repeat(MIN_PASSWORD_LENGTH - 1) })
  assert.equal(short.code, 'ACCOUNT_PASSWORD_TOO_SHORT')

  const long = await account.createAccount({ username: 'josh', password: 'a'.repeat(5000) })
  assert.equal(long.code, 'ACCOUNT_PASSWORD_TOO_LONG')

  const common = await account.createAccount({ username: 'josh', password: 'PasswordPassword' })
  assert.equal(common.code, 'ACCOUNT_PASSWORD_COMMON', 'the screen must be case-insensitive')

  const sameAsName = await account.createAccount({ username: 'josharchibald', password: 'josharchibald' })
  assert.equal(sameAsName.code, 'ACCOUNT_PASSWORD_IS_USERNAME')

  const blank = await account.createAccount({ username: 'josh', password: '            ' })
  assert.equal(blank.code, 'ACCOUNT_PASSWORD_BLANK')

  /* Nothing was written by any of those. */
  assert.equal(account.availability().accountCount, 0)
})

test('usernames are bounded, normalized, unique, and free of confusables', async (t) => {
  assert.equal(normalizeUsername('  JoSh  '), 'josh')
  assert.equal(normalizeUsername('a.b_c-d'), 'a.b_c-d')
  assert.equal(normalizeUsername('ab'), null, 'too short')
  assert.equal(normalizeUsername('a'.repeat(65)), null, 'too long')
  assert.equal(normalizeUsername('.leading'), null)
  assert.equal(normalizeUsername('trailing.'), null)
  assert.equal(normalizeUsername('has space'), null)
  assert.equal(normalizeUsername('раssword'), null, 'Cyrillic look-alikes must be refused')
  assert.equal(normalizeUsername('josh\n'), 'josh')
  assert.equal(normalizeUsername(null), null)
  assert.equal(normalizeUsername(123), null)

  const directory = workspace(t)
  const account = store(directory)
  assert.equal((await account.createAccount({ username: 'josh', password: PASSWORD })).ok, true)
  const duplicate = await account.createAccount({ username: 'JOSH', password: OTHER_PASSWORD })
  assert.equal(duplicate.code, 'ACCOUNT_USERNAME_TAKEN', 'case must not create a second account')
})

test('a display name cannot smuggle control characters into the interface', async (t) => {
  const directory = workspace(t)
  const account = store(directory)
  /* Escapes, not literal characters: a test file containing a real bidi
     override displays its own source misleadingly, which is the attack. */
  const hostile = 'Josh\u202e gnihtemos\u0000\r\n\u200b '
  const created = await account.createAccount({ username: 'josh', displayName: hostile, password: PASSWORD })
  assert.equal(created.ok, true)
  const name = created.account.displayName
  assert.ok(!/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(name),
    'control, zero-width and bidi characters must be stripped from a display name')
  assert.equal(name, 'Josh gnihtemos')

  /* And the stripped name is what is stored and read back, not just what the
     create call returned. */
  assert.equal((await account.signIn({ username: 'josh', password: PASSWORD })).ok, true)
  assert.equal(account.current().account.displayName, 'Josh gnihtemos')
})

/* The product's own source must not contain what it strips from user input.
   An invisible bidi override in a reviewed file is a known supply-chain trick:
   the reviewer reads one order of statements and the compiler reads another. */
test('the account source files contain no invisible control or bidi characters', () => {
  for (const relative of ['shell/product-account.cjs', 'src/account-state.js', 'src/views/account.js']) {
    const source = readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')
    const found = [...source].filter(character => /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(character))
    assert.equal(found.length, 0,
      `${relative} contains ${found.length} invisible character(s): ${found.map(c => `U+${c.codePointAt(0).toString(16).padStart(4, '0')}`).join(', ')}`)
  }
})

test('an empty display name falls back to the username rather than to nothing', async (t) => {
  const directory = workspace(t)
  const account = store(directory)
  assert.equal((await account.createAccount({ username: 'josh', displayName: '   ', password: PASSWORD })).ok, true)
  assert.equal((await account.signIn({ username: 'josh', password: PASSWORD })).ok, true)
  assert.equal(account.current().account.displayName, 'josh')
})

test('signing out when nobody is signed in is a no-op that still reports success', async (t) => {
  const directory = workspace(t)
  const account = await withAccount(directory)
  assert.equal(account.signOut().ok, true)
  const everywhere = account.signOutEverywhere()
  assert.equal(everywhere.ok, true)
  assert.equal(everywhere.revoked, false)
  assert.equal(account.principal(), UNAUTHENTICATED_PRINCIPAL)
})

test('the principal is always a bounded non-empty string the spawn record accepts', async (t) => {
  const directory = workspace(t)
  const account = await withAccount(directory)

  for (const value of [account.principal(), (await account.signIn({ username: 'josh', password: PASSWORD })) && account.principal()]) {
    assert.equal(typeof value, 'string')
    assert.ok(value.length > 0 && value.length <= 200,
      'shell/spawn-record.cjs refuses a principal outside 1..200 characters')
  }
  assert.equal(UNAUTHENTICATED_PRINCIPAL, 'unauthenticated')
})

/* ------------------------- the account partition -------------------------
 *
 * THE FOURTH WAY THIS CAN BE QUIETLY WRONG, and until now the product had it:
 * signing in changed a NAME on a record and nothing else. `accountId` appeared
 * nowhere in the application outside shell/product-account.cjs, so every byte
 * the product kept -- theme, first-run answers, write fences -- was one shared
 * pile that the next person to sign in inherited. "Your data" was a sentence
 * the product could not write.
 *
 * These tests are what stop the isolation claim being vacuous. Some of them
 * would pass against a store that ignored the account entirely (a single shared
 * file answers "settingCount: 1" to both accounts just fine), so the ones that
 * matter are the CROSS-ACCOUNT ones: B writes, A reads, and A must not see it.
 */

test('two accounts on one computer do not see each other settings', async (t) => {
  const directory = workspace(t)
  const account = store(directory)
  assert.equal((await account.createAccount({ username: 'josh', password: PASSWORD })).ok, true)
  assert.equal((await account.createAccount({ username: 'guest', password: OTHER_PASSWORD })).ok, true)

  assert.equal((await account.signIn({ username: 'josh', password: PASSWORD })).ok, true)
  assert.equal(account.putSetting({ key: 'mc.theme', value: 'black' }).ok, true)
  assert.equal(account.getSetting('mc.theme').value, 'black')
  const joshId = account.current().account.id

  assert.equal((await account.signIn({ username: 'guest', password: OTHER_PASSWORD })).ok, true)
  const guestId = account.current().account.id
  assert.notEqual(guestId, joshId)
  /* THE ASSERTION THE WHOLE PARTITION EXISTS FOR. */
  assert.equal(account.getSetting('mc.theme').value, null,
    'the second account can read the first account settings, so the partition does nothing')
  assert.equal(account.accountDataForRenderer().settingCount, 0)

  assert.equal(account.putSetting({ key: 'mc.theme', value: 'white' }).ok, true)
  assert.equal((await account.signIn({ username: 'josh', password: PASSWORD })).ok, true)
  assert.equal(account.getSetting('mc.theme').value, 'black',
    'the second account overwrote the first account setting, so they share one file')
})


test('a captured account fence refuses an account switch before either partition is read or written', async t => {
  const directory = workspace(t)
  const account = store(directory)
  assert.equal((await account.createAccount({ username: 'josh', password: PASSWORD })).ok, true)
  assert.equal((await account.createAccount({ username: 'guest', password: OTHER_PASSWORD })).ok, true)
  assert.equal((await account.signIn({ username: 'josh', password: PASSWORD })).ok, true)
  assert.equal(account.putSetting({ key: 'research_queue', value: 'account-a' }).ok, true)
  const captured = account.getSetting('research_queue')
  assert.equal(captured.ok, true)
  assert.equal(captured.value, 'account-a')
  assert.match(captured.accountId, /^[0-9a-f]{32}$/)

  assert.equal((await account.signIn({ username: 'guest', password: OTHER_PASSWORD })).ok, true)
  assert.equal(account.getSetting('research_queue').value, null)
  assert.equal(account.getSetting('research_queue', { expectedAccountId: captured.accountId }).code, 'ACCOUNT_CHANGED')
  assert.equal(account.putSetting({ key: 'research_queue', value: 'must-not-land', expectedAccountId: captured.accountId }).code, 'ACCOUNT_CHANGED')
  assert.equal(account.getSetting('research_queue').value, null, 'a stale A write reached B')
  for (const expectedAccountId of [undefined, null, 1, '', 'not-an-account-id', '0'.repeat(33)]) {
    assert.equal(account.putSetting({ key: 'research_queue', value: 'must-not-land', expectedAccountId }).code, 'ACCOUNT_CHANGED')
    assert.equal(account.getSetting('research_queue', { expectedAccountId }).code, 'ACCOUNT_CHANGED')
  }
  assert.equal(account.putSetting({ key: 'research_queue', value: 'ordinary-b' }).ok, true,
    'an unfenced legacy caller must still write the current account')
  assert.equal(account.getSetting('research_queue').value, 'ordinary-b')
  assert.equal((await account.signIn({ username: 'josh', password: PASSWORD })).ok, true)
  assert.equal(account.getSetting('research_queue').value, 'account-a', 'the refused write crossed partitions')
})

test('signed out, nothing can be read from or written to any account partition', async (t) => {
  const directory = workspace(t)
  const account = await withAccount(directory)
  assert.equal((await account.signIn({ username: 'josh', password: PASSWORD })).ok, true)
  assert.equal(account.putSetting({ key: 'mc.theme', value: 'black' }).ok, true)

  account.signOut()
  const read = account.accountDataForRenderer()
  assert.equal(read.ok, false)
  assert.equal(read.code, 'ACCOUNT_NOT_SIGNED_IN')
  assert.equal(account.getSetting('mc.theme').ok, false)
  assert.equal(account.putSetting({ key: 'mc.theme', value: 'white' }).ok, false)
  assert.equal(account.attachPaymentMethod({ vaultKey: 'payment_card_default' }).ok, false)
  /* And the write that was refused really did not happen. */
  assert.equal((await account.signIn({ username: 'josh', password: PASSWORD })).ok, true)
  assert.equal(account.getSetting('mc.theme').value, 'black')
})

test('the first account on a used computer inherits its settings and the second does not', async (t) => {
  const directory = workspace(t)
  writeFileSync(join(directory, 'renderer-prefs.json'), JSON.stringify({
    storageVersion: 1,
    values: { 'mc.theme': 'black', 'mc.setup.profile': '{"status":"complete"}' },
  }))
  const account = store(directory)

  const first = await account.createAccount({ username: 'josh', password: PASSWORD })
  assert.equal(first.ok, true)
  assert.equal(first.adoptedSettings, true, 'the settings already on this computer were thrown away')
  assert.equal(first.adoptedSettingCount, 2)

  const second = await account.createAccount({ username: 'guest', password: OTHER_PASSWORD })
  assert.equal(second.ok, true)
  assert.equal(second.adoptedSettings, false,
    'a later account inherited settings that belong to whoever made the first one')

  assert.equal((await account.signIn({ username: 'josh', password: PASSWORD })).ok, true)
  assert.equal(account.getSetting('mc.setup.profile').value, '{"status":"complete"}')
  assert.equal(account.accountDataForRenderer().adopted.count, 2)

  assert.equal((await account.signIn({ username: 'guest', password: OTHER_PASSWORD })).ok, true)
  assert.equal(account.getSetting('mc.setup.profile').value, null)
  assert.equal(account.accountDataForRenderer().adopted, null)

  /* The device file is READ, never moved. Signing out must leave the product
     exactly as it was for whoever has not made an account. */
  const device = JSON.parse(readFileSync(join(directory, 'renderer-prefs.json'), 'utf8'))
  assert.equal(device.values['mc.theme'], 'black')
})

test('a damaged partition is reported, never silently replaced with an empty one', async (t) => {
  const directory = workspace(t)
  const account = await withAccount(directory)
  assert.equal((await account.signIn({ username: 'josh', password: PASSWORD })).ok, true)
  assert.equal(account.putSetting({ key: 'mc.theme', value: 'black' }).ok, true)

  const id = account.current().account.id
  writeFileSync(account.accountDataPath(id), '{ not json')
  const read = account.accountDataForRenderer()
  assert.equal(read.ok, false)
  assert.equal(read.code, 'ACCOUNT_DATA_CORRUPT')
  /* And a write on top of a damaged file is refused rather than flattening it. */
  assert.equal(account.putSetting({ key: 'mc.theme', value: 'white' }).ok, false)
  assert.equal(readFileSync(account.accountDataPath(id), 'utf8'), '{ not json')
})

test('a partition file whose contents name another account is refused', async (t) => {
  const directory = workspace(t)
  const account = store(directory)
  assert.equal((await account.createAccount({ username: 'josh', password: PASSWORD })).ok, true)
  assert.equal((await account.createAccount({ username: 'guest', password: OTHER_PASSWORD })).ok, true)
  assert.equal((await account.signIn({ username: 'josh', password: PASSWORD })).ok, true)
  const joshId = account.current().account.id
  assert.equal((await account.signIn({ username: 'guest', password: OTHER_PASSWORD })).ok, true)
  const guestId = account.current().account.id
  /* Give the guest a partition file of their own first, so the directory
     exists and the file being overwritten below is a real one. */
  assert.equal(account.putSetting({ key: 'mc.theme', value: 'white' }).ok, true)

  /* Somebody copies one account file over another one name. The file is named
     by id; if its CONTENTS name a different account, answering with it would
     show one person another person settings. */
  writeFileSync(account.accountDataPath(guestId), JSON.stringify({
    version: 1, accountId: joshId, settings: { 'mc.theme': 'black' }, paymentMethod: null, updatedAtMs: 1,
  }))
  const read = account.accountDataForRenderer()
  assert.equal(read.ok, false)
  assert.equal(read.code, 'ACCOUNT_DATA_CORRUPT')
})

/* --------------------- the payment method is a REFERENCE --------------------- */

test('attaching a payment method writes a vault key name and nothing that could be a card', async (t) => {
  const directory = workspace(t)
  const account = await withAccount(directory)
  assert.equal((await account.signIn({ username: 'josh', password: PASSWORD })).ok, true)

  const attached = account.attachPaymentMethod({ vaultKey: 'payment_card_default', vaultStore: 'C:\\somewhere\\vault\\secrets.json' })
  assert.equal(attached.ok, true)
  assert.equal(attached.vaultKey, 'payment_card_default')

  const id = account.current().account.id
  const raw = readFileSync(account.accountDataPath(id), 'utf8')
  const stored = JSON.parse(raw)
  /* The whole record, enumerated. A field that could hold a card must not
     exist -- not empty, not null: absent. */
  assert.deepEqual(Object.keys(stored.paymentMethod).sort(), ['attachedAtMs', 'note', 'vaultKey', 'vaultStore'])
  assert.match(raw, /payment_card_default/)
  /* Every STRING in the record, checked for a card shape. Deliberately not a
     scan of the raw text: `attachedAtMs` is a thirteen-digit epoch, so a naive
     digit-run assertion fails on a correct file -- and the person who hits that
     deletes the assertion rather than narrowing it. */
  for (const value of Object.values(stored.paymentMethod)) {
    if (typeof value !== 'string') continue
    assert.doesNotMatch(value.replace(/[ -]/g, ''), /\d{12,19}/,
      'a payment-method field holds something shaped like a card number')
  }

  const view = account.accountDataForRenderer()
  assert.equal(view.paymentMethod.vaultKey, 'payment_card_default')
  assert.equal(account.detachPaymentMethod().ok, true)
  assert.equal(account.accountDataForRenderer().paymentMethod, null)
})

test('only an allowlisted vault key may be attached, and never the identity record', async (t) => {
  const directory = workspace(t)
  const account = await withAccount(directory)
  assert.equal((await account.signIn({ username: 'josh', password: PASSWORD })).ok, true)

  for (const vaultKey of ['owner_legal_identity_v1', 'google_client_secret', '../../elsewhere', '', null, 42]) {
    const result = account.attachPaymentMethod({ vaultKey })
    assert.equal(result.ok, false, `${String(vaultKey)} was accepted as a payment method`)
    assert.equal(result.code, 'ACCOUNT_PAYMENT_KEY_REFUSED')
  }
  assert.equal(account.accountDataForRenderer().paymentMethod, null)
})

test('a payment method does not survive into another account', async (t) => {
  const directory = workspace(t)
  const account = store(directory)
  assert.equal((await account.createAccount({ username: 'josh', password: PASSWORD })).ok, true)
  assert.equal((await account.createAccount({ username: 'guest', password: OTHER_PASSWORD })).ok, true)

  assert.equal((await account.signIn({ username: 'josh', password: PASSWORD })).ok, true)
  assert.equal(account.attachPaymentMethod({ vaultKey: 'payment_card_default' }).ok, true)

  assert.equal((await account.signIn({ username: 'guest', password: OTHER_PASSWORD })).ok, true)
  assert.equal(account.accountDataForRenderer().paymentMethod, null,
    'the second account is shown the first account payment method')
})

/* T1520: A DAMAGED ACCOUNT FILE CAN BE SET ASIDE, BYTE FOR BYTE, AND SIGN-IN
   STARTS AGAIN. A torn file refused every sign-in, and the page's only action
   was removing all of this program's data. setAsideDamagedStore() moves only
   an account file that will not read, to a kept name beside it. */
test('a damaged account file is set aside unchanged, after which an account can be created again', async (t) => {
  const directory = workspace(t)
  const account = await withAccount(directory)
  const whole = readFileSync(account.accountsPath)
  const torn = whole.subarray(0, Math.floor(whole.length / 2))
  writeFileSync(account.accountsPath, torn)

  const damaged = store(directory)
  assert.equal(damaged.availability().code, 'ACCOUNT_STORE_CORRUPT')
  const answer = damaged.setAsideDamagedStore()
  assert.equal(answer.ok, true, JSON.stringify(answer))
  assert.equal(answer.keptAs.length, 1)
  assert.match(answer.keptAs[0], /\.damaged-/)
  assert.deepEqual(readFileSync(join(directory, answer.keptAs[0])), torn, 'the damaged bytes were not kept exactly')
  assert.equal(existsSync(account.accountsPath), false, 'the damaged file is still in place')

  const fresh = store(directory)
  assert.equal(fresh.availability().ok, true, 'the account page still cannot read its accounts after the set-aside')
  const created = await fresh.createAccount({ username: 'after-damage', password: PASSWORD })
  assert.equal(created.ok, true, 'an account could not be created after the damaged file was set aside')
})

test('a readable account file is never set aside', async (t) => {
  const directory = workspace(t)
  const account = await withAccount(directory)
  const bytes = readFileSync(account.accountsPath)
  const answer = store(directory).setAsideDamagedStore()
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'ACCOUNT_STORE_READABLE')
  assert.deepEqual(readFileSync(account.accountsPath), bytes)
  assert.equal(readdirSync(directory).some(name => name.includes('.damaged-')), false)
})
