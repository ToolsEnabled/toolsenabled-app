/* THE ACCOUNT A GOOGLE IDENTITY BECOMES, and the things it must refuse to do.
 *
 * tools/test/google-signin.test.mjs proves the token verification. This proves
 * what the STORE does once an identity has been verified: which account it is,
 * what happens when two identities collide, and that a Google account has
 * exactly one door into it.
 *
 * NO NETWORK, NO ELECTRON, NO REAL ACCOUNT. Every address here is
 * `@example.com`. The store is built over a scratch directory and thrown away.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createAccountStore,
  GOOGLE_PROVIDER,
  REQUIRED_IDENTITY_ASSURANCE,
  normalizeIdentityEmail,
  validateVerifiedIdentity,
} from '../../shell/product-account.cjs'

const PASSWORD = 'correct horse battery staple'

function scratch() {
  return mkdtempSync(path.join(tmpdir(), 'google-account-'))
}

function identity(overrides = {}) {
  return {
    provider: GOOGLE_PROVIDER,
    subject: '109876543210987654321',
    email: 'probe.user@example.com',
    emailVerified: true,
    displayName: 'Probe User',
    assurance: REQUIRED_IDENTITY_ASSURANCE,
    ...overrides,
  }
}

test('a verified identity becomes an account whose NAME is the verified address', async () => {
  const directory = scratch()
  try {
    const store = createAccountStore({ directory })
    const result = await store.signInWithGoogle({ identity: identity() })
    assert.equal(result.ok, true, result.reason)
    assert.equal(result.created, true)
    assert.equal(result.account.username, 'probe.user@example.com')

    const current = store.current()
    assert.equal(current.signedIn, true)
    assert.equal(current.account.signInMethod, 'google')
    assert.equal(current.account.email, 'probe.user@example.com')
    assert.ok(/^account:[0-9a-f]{32}$/.test(current.principal))

    /* NO PASSWORD VERIFIER AND NO TOKEN ON DISK. The record holds the subject
       identifier and the address; there is nowhere in it for a Google
       credential, which is the point of not asking for one. */
    const onDisk = readFileSync(store.accountsPath, 'utf8')
    assert.ok(!/scrypt\$/.test(onDisk), 'a Google account was given a password verifier')
    assert.ok(!/access_token|refresh_token|"id_token"|Bearer/i.test(onDisk), 'a Google token was written to disk')
    const persisted = JSON.parse(onDisk)
    assert.equal(
      persisted.accounts[0].identity.subject,
      '109876543210987654321',
      'the Google subject was not persisted with the account',
    )
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('an identity that was never verified is refused, however well formed it is', async () => {
  const directory = scratch()
  try {
    const store = createAccountStore({ directory })
    const refusals = [
      ['no assurance stamp', { assurance: undefined }],
      ['the wrong stamp', { assurance: 'trust-me' }],
      ['email Google did not verify', { emailVerified: false }],
      ['no subject', { subject: '' }],
      ['a subject with a path in it', { subject: '../../etc/passwd' }],
      ['not an address', { email: 'probe.user' }],
      ['another provider', { provider: 'facebook' }],
    ]
    for (const [label, overrides] of refusals) {
      const result = await store.signInWithGoogle({ identity: identity(overrides) })
      assert.equal(result.ok, false, `${label} produced a sign-in`)
      assert.equal(result.code, 'ACCOUNT_GOOGLE_IDENTITY_REFUSED', label)
      assert.equal(store.current().signedIn, false, `${label} left somebody signed in`)
    }
    /* Nothing was written by any of them. */
    assert.equal(store.availability().accountCount, 0)
    for (const shape of [undefined, null, {}, [], 'probe.user@example.com', 42]) {
      assert.equal((await store.signInWithGoogle({ identity: shape })).ok, false)
    }
    assert.equal((await store.signInWithGoogle()).ok, false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('signing in again is the SAME account, and a changed address follows the person', async () => {
  const directory = scratch()
  try {
    const store = createAccountStore({ directory })
    const first = await store.signInWithGoogle({ identity: identity() })
    store.signOut()
    const second = await store.signInWithGoogle({ identity: identity() })
    assert.equal(second.created, false, 'a second sign-in made a second account')
    assert.equal(second.account.id, first.account.id)

    /* THE ADDRESS CHANGED AT GOOGLE. Keyed on the subject, so the account, its
       settings and its history stay with the person rather than being left
       behind under the old string. */
    store.signOut()
    const renamed = await store.signInWithGoogle({ identity: identity({ email: 'probe.renamed@example.com' }) })
    assert.equal(renamed.ok, true, renamed.reason)
    assert.equal(renamed.created, false, 'a changed address made a new account instead of following the person')
    assert.equal(renamed.account.id, first.account.id)
    assert.equal(store.current().account.email, 'probe.renamed@example.com')
    assert.equal(store.availability().accountCount, 1)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('an address that already identifies a DIFFERENT Google account is refused, not adopted', async () => {
  const directory = scratch()
  try {
    const store = createAccountStore({ directory })
    const first = await store.signInWithGoogle({ identity: identity() })
    assert.equal(first.ok, true)
    store.signOut()

    /* The reissued-address case: a Workspace address deleted and given to a new
       person. Handing them the previous holder's account -- their settings,
       their history, their attached payment method -- because two strings match
       is exactly what keying on the subject prevents. */
    const impostor = await store.signInWithGoogle({ identity: identity({ subject: '555000111222333444555' }) })
    assert.equal(impostor.ok, false)
    assert.equal(impostor.code, 'ACCOUNT_GOOGLE_SUBJECT_MISMATCH')
    assert.equal(store.current().signedIn, false)
    assert.equal(store.availability().accountCount, 1, 'the refusal still wrote an account')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('a Google account has exactly one door: no password sign-in, no password change', async () => {
  const directory = scratch()
  try {
    const store = createAccountStore({ directory })
    await store.signInWithGoogle({ identity: identity() })

    /* Signed in as this account, so there is nothing to leak by saying why. */
    const change = await store.changePassword({ currentPassword: PASSWORD, newPassword: `${PASSWORD}!` })
    assert.equal(change.ok, false)
    assert.equal(change.code, 'ACCOUNT_GOOGLE_NO_PASSWORD')
    assert.ok(/Google/.test(change.reason))

    /* And the password door itself: the SAME refusal a wrong password gets,
       because a distinct message would confirm the account exists. */
    store.signOut()
    const attempt = await store.signIn({ username: 'probe.user@example.com', password: PASSWORD })
    assert.equal(attempt.ok, false)
    assert.equal(attempt.code, 'ACCOUNT_CREDENTIALS_REJECTED')
    assert.equal(store.current().signedIn, false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('local accounts still work, side by side, and neither can shadow the other', async () => {
  const directory = scratch()
  try {
    const store = createAccountStore({ directory })
    const local = await store.createAccount({ username: 'josh', displayName: 'Josh', password: PASSWORD })
    assert.equal(local.ok, true, local.reason)
    const signedIn = await store.signIn({ username: 'josh', password: PASSWORD })
    assert.equal(signedIn.ok, true)
    assert.equal(store.current().account.signInMethod, 'local')
    assert.equal(store.current().account.email, null)
    store.signOut()

    const google = await store.signInWithGoogle({ identity: identity() })
    assert.equal(google.ok, true, google.reason)
    assert.equal(store.availability().accountCount, 2)

    /* A local username can never contain `@`, so the two name spaces cannot
       collide -- checked rather than asserted in prose. */
    assert.equal(normalizeIdentityEmail('josh'), null)
    const collide = await store.createAccount({ username: 'probe.user@example.com', displayName: '', password: PASSWORD })
    assert.equal(collide.ok, false)
    assert.equal(collide.code, 'ACCOUNT_USERNAME_INVALID')

    /* And the local account's password still works after all of that. */
    store.signOut()
    assert.equal((await store.signIn({ username: 'josh', password: PASSWORD })).ok, true)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('a record with two doors, or none, condemns the file rather than being repaired', async () => {
  const directory = scratch()
  try {
    const store = createAccountStore({ directory })
    await store.signInWithGoogle({ identity: identity() })
    const raw = JSON.parse(readFileSync(store.accountsPath, 'utf8'))

    /* BOTH: a Google account that also carries a password verifier would be an
       account with a weaker second door nobody was told about. */
    const both = structuredClone(raw)
    both.accounts[0].verifier = 'scrypt$N=131072,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA==$'
      + Buffer.alloc(64, 7).toString('base64')
    writeFileSync(store.accountsPath, JSON.stringify(both))
    const twoDoors = createAccountStore({ directory })
    assert.equal(twoDoors.availability().ok, false, 'a record with a password AND a Google identity was accepted')
    assert.equal(twoDoors.current().signedIn, false)

    /* NEITHER: no verifier and no identity is a record nobody can sign in to. */
    const neither = structuredClone(raw)
    delete neither.accounts[0].identity
    writeFileSync(store.accountsPath, JSON.stringify(neither))
    assert.equal(createAccountStore({ directory }).availability().ok, false)

    /* AND THE NAME MUST BE THE VERIFIED ADDRESS. A record whose displayed name
       is one address and whose verified identity is another is the
       impersonation this design exists to prevent. */
    const mismatched = structuredClone(raw)
    mismatched.accounts[0].username = 'somebody.else@example.com'
    writeFileSync(store.accountsPath, JSON.stringify(mismatched))
    assert.equal(createAccountStore({ directory }).availability().ok, false)

    /* ...and the untouched original still reads, so none of the above passes
       because the reader refuses everything. */
    writeFileSync(store.accountsPath, JSON.stringify(raw))
    assert.equal(createAccountStore({ directory }).availability().ok, true)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('an unverified identity cannot be smuggled past validateVerifiedIdentity', () => {
  assert.equal(validateVerifiedIdentity(identity()).email, 'probe.user@example.com')
  assert.equal(validateVerifiedIdentity(identity({ assurance: undefined })), null)
  assert.equal(validateVerifiedIdentity(identity({ emailVerified: 'yes' })), null)
  assert.equal(validateVerifiedIdentity(null), null)
  /* The address is normalized on the way in, so two spellings of one address
     cannot become two accounts. */
  assert.equal(validateVerifiedIdentity(identity({ email: '  Probe.User@Example.COM ' })).email, 'probe.user@example.com')
})

test('the first Google account on a computer adopts what is already there; the second does not', async () => {
  const directory = scratch()
  try {
    writeFileSync(path.join(directory, 'renderer-prefs.json'), JSON.stringify({
      values: { 'mc.theme': 'black', 'mc.set.chatbox': 'timeline' },
    }))
    const store = createAccountStore({ directory })
    const first = await store.signInWithGoogle({ identity: identity() })
    assert.equal(first.adoptedSettings, true, 'the first account did not inherit the settings already on this computer')
    assert.equal(first.adoptedSettingCount, 2)
    store.signOut()

    const second = await store.signInWithGoogle({ identity: identity({ subject: '222333444555666777888', email: 'other.person@example.com' }) })
    assert.equal(second.created, true)
    assert.equal(second.adoptedSettings, false, 'a later account inherited somebody else\'s settings')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
