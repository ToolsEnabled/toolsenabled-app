/* SIGN IN WITH GOOGLE: the verification, the flow, and every way it must refuse.
 *
 * WHAT THIS FILE IS FOR. The sign-in screen can be driven end to end (see
 * tools/google-signin-packaged-qa.mjs, which does exactly that against the
 * packaged product). What a driven run CANNOT show is the set of things that
 * must not work: a token signed by the wrong key, a token addressed to another
 * application, a replayed token, a token whose email Google never verified.
 * Those are the whole security argument, and each one is asserted here against
 * a real RSA signature produced in this process.
 *
 * THE KEYS ARE GENERATED HERE. Nothing in this file reaches the network, no
 * Google account is involved, and every address in it is `@example.com` --
 * which cannot be a real Google account.
 *
 * THE MUTATION DISCIPLINE THIS REPO USES: for each refusal, the ACCEPTING case
 * is asserted immediately next to it from the same builder. A test that only
 * checks refusals passes just as well against a verifier that refuses
 * everything, which would be a product nobody can sign in to.
 */

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import test from 'node:test'

import {
  verifyIdToken,
  createJwksCache,
  normalizeVerifiedEmail,
  GOOGLE_ISSUERS,
  JWKS_FORCED_REFETCHES_PER_KEY_SET,
} from '../../shell/google-oidc.cjs'
import {
  createGoogleSignIn,
  SIGNIN_SCOPES,
  REDIRECT_PATH,
  LOOPBACK_HOST,
  AUTHORIZATION_ENDPOINT,
  TOKEN_ENDPOINT,
} from '../../shell/google-signin.cjs'
import {
  resolveGoogleSignInConfig,
  readConfigFile,
  CLIENT_ID_PATTERN,
  VAULT_CLIENT_ID_KEY,
  VAULT_CLIENT_SECRET_KEY,
  VAULT_CAPABILITY_CLIENT_ID_KEY,
} from '../../shell/google-signin-config.cjs'
import { vaultRecordValues } from '../../shell/vault-presence.cjs'

const CLIENT_ID = '123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com'
const OTHER_CLIENT_ID = '999999999999-zyxwvutsrqponmlkjihgfedcba543210.apps.googleusercontent.com'

/* One key pair for "Google", one for "somebody else". The second is what proves
   the signature check is doing work: a token that is correct in every other
   respect but signed by the wrong key must be refused. */
const googleKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const impostorKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })

const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url')

function jwksFor(keyPair, kid) {
  const jwk = keyPair.publicKey.export({ format: 'jwk' })
  return { keys: [{ kty: 'RSA', kid, use: 'sig', alg: 'RS256', n: jwk.n, e: jwk.e }] }
}

function signToken(claims, { key = googleKey.privateKey, kid = 'test-key-1', alg = 'RS256' } = {}) {
  const header = b64({ alg, kid, typ: 'JWT' })
  const payload = b64(claims)
  if (alg === 'none') return `${header}.${payload}.`
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`, 'ascii'), key)
  return `${header}.${payload}.${signature.toString('base64url')}`
}

const NOW = 1_760_000_000_000
const now = () => NOW

function goodClaims(overrides = {}) {
  return {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: '109876543210987654321',
    email: 'probe.user@example.com',
    email_verified: true,
    name: 'Probe User',
    nonce: 'test-nonce-value',
    iat: Math.floor(NOW / 1000) - 10,
    exp: Math.floor(NOW / 1000) + 3600,
    ...overrides,
  }
}

/* A JWKS server that counts its calls, so the cache can be measured rather than
   assumed. */
function jwksFetcher(document, { onCall = () => {} } = {}) {
  return async () => {
    onCall()
    return { ok: true, text: async () => JSON.stringify(document) }
  }
}

const verifyWith = (token, options = {}) => verifyIdToken(token, {
  clientId: CLIENT_ID,
  nonce: 'test-nonce-value',
  now,
  fetchImpl: jwksFetcher(jwksFor(googleKey, 'test-key-1')),
  ...options,
})

/* ------------------------------- the verifier ------------------------------- */

test('a correctly signed, correctly addressed, current token verifies', async () => {
  const result = await verifyWith(signToken(goodClaims()))
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.identity.provider, 'google')
  assert.equal(result.identity.subject, '109876543210987654321')
  assert.equal(result.identity.email, 'probe.user@example.com')
  assert.equal(result.identity.emailVerified, true)
  assert.equal(result.identity.displayName, 'Probe User')
  /* The stamp shell/product-account.cjs demands. Without it the store refuses
     the identity, which is what makes an unverified path fail closed. */
  assert.equal(result.identity.assurance, 'id_token-verified')
})

test('a token signed by anybody but Google is refused', async () => {
  /* THE CENTRAL ONE. Every claim in this token is correct; only the signature
     is somebody else's. Reading the claims without checking the signature is
     how "sign in with Google" is most often got wrong, and it would sign this
     impostor in as the real user. */
  const forged = signToken(goodClaims(), { key: impostorKey.privateKey })
  const result = await verifyWith(forged)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'GOOGLE_TOKEN_SIGNATURE_INVALID')
  assert.ok(!/eyJ/.test(result.reason), 'the refusal must not quote the token')
})

test('an unsigned token is refused, and so is one that names another algorithm', async () => {
  const none = await verifyWith(signToken(goodClaims(), { alg: 'none' }))
  assert.equal(none.ok, false)
  assert.equal(none.code, 'GOOGLE_TOKEN_ALG_REFUSED')

  /* HS256 against a PUBLISHED RSA public key: the classic algorithm-confusion
     attack. The algorithm must come from us, not from the token. */
  const jwk = googleKey.publicKey.export({ format: 'jwk' })
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', kid: 'test-key-1', typ: 'JWT' })).toString('base64url')
  const payload = b64(goodClaims())
  const mac = crypto.createHmac('sha256', Buffer.from(jwk.n, 'base64url')).update(`${header}.${payload}`).digest('base64url')
  const confused = await verifyWith(`${header}.${payload}.${mac}`)
  assert.equal(confused.ok, false)
  assert.equal(confused.code, 'GOOGLE_TOKEN_ALG_REFUSED')
})

test('a token issued for a different application is refused', async () => {
  /* Google signs every application's tokens with the same keys, so a valid
     signature only says "Google issued this" -- the audience is what says it
     was issued to US. Without this check, a token from any other Google
     application signs a person in here. */
  const other = await verifyWith(signToken(goodClaims({ aud: OTHER_CLIENT_ID })))
  assert.equal(other.ok, false)
  assert.equal(other.code, 'GOOGLE_TOKEN_AUDIENCE_REFUSED')

  const multi = await verifyWith(signToken(goodClaims({ aud: [CLIENT_ID, OTHER_CLIENT_ID] })))
  assert.equal(multi.ok, false, 'a token addressed to several applications must not be searched for a match')

  const azp = await verifyWith(signToken(goodClaims({ azp: OTHER_CLIENT_ID })))
  assert.equal(azp.ok, false)
  assert.equal(azp.code, 'GOOGLE_TOKEN_AUDIENCE_REFUSED')

  /* ...and the accepting case, so this is not a verifier that refuses all. */
  assert.equal((await verifyWith(signToken(goodClaims({ azp: CLIENT_ID })))).ok, true)
})

test('a token from an issuer that merely looks like Google is refused', async () => {
  for (const issuer of ['https://evil-accounts.google.com', 'https://accounts.google.com.evil.test', 'accounts.google.com.evil', '']) {
    const result = await verifyWith(signToken(goodClaims({ iss: issuer })))
    assert.equal(result.ok, false, `${issuer} was accepted as Google`)
    assert.equal(result.code, 'GOOGLE_TOKEN_ISSUER_REFUSED')
  }
  for (const issuer of GOOGLE_ISSUERS) {
    assert.equal((await verifyWith(signToken(goodClaims({ iss: issuer })))).ok, true, `${issuer} must be accepted`)
  }
})

test('an expired token is refused, and one dated in the future is refused', async () => {
  const expired = await verifyWith(signToken(goodClaims({ exp: Math.floor(NOW / 1000) - 3600 })))
  assert.equal(expired.ok, false)
  assert.equal(expired.code, 'GOOGLE_TOKEN_EXPIRED')

  const future = await verifyWith(signToken(goodClaims({ iat: Math.floor(NOW / 1000) + 3600 })))
  assert.equal(future.ok, false)
  assert.equal(future.code, 'GOOGLE_TOKEN_NOT_YET_VALID')

  /* Just inside the skew allowance still works: a desktop whose clock is a few
     seconds out must not be locked out of its own product. */
  assert.equal((await verifyWith(signToken(goodClaims({ exp: Math.floor(NOW / 1000) - 30 })))).ok, true)
})

test('a token from a different sign-in is refused, which is what stops a replay', async () => {
  const replayed = await verifyWith(signToken(goodClaims({ nonce: 'a-nonce-from-an-earlier-sign-in' })))
  assert.equal(replayed.ok, false)
  assert.equal(replayed.code, 'GOOGLE_TOKEN_NONCE_MISMATCH')

  const absent = await verifyWith(signToken(goodClaims({ nonce: undefined })))
  assert.equal(absent.ok, false)
  assert.equal(absent.code, 'GOOGLE_TOKEN_NONCE_MISMATCH')

  /* And a verifier asked WITHOUT an expected nonce refuses rather than skipping
     the check -- absence of the expectation must not read as "no check needed",
     which is this codebase's signature defect. */
  const noExpectation = await verifyIdToken(signToken(goodClaims()), {
    clientId: CLIENT_ID, now, fetchImpl: jwksFetcher(jwksFor(googleKey, 'test-key-1')),
  })
  assert.equal(noExpectation.ok, false)
  assert.equal(noExpectation.code, 'GOOGLE_TOKEN_NONCE_MISSING')
})

test('an email Google has not verified is refused', async () => {
  for (const value of [false, undefined, 'true', 1, null]) {
    const result = await verifyWith(signToken(goodClaims({ email_verified: value })))
    assert.equal(result.ok, false, `email_verified=${JSON.stringify(value)} was accepted`)
    assert.equal(result.code, 'GOOGLE_TOKEN_EMAIL_UNVERIFIED')
  }
  /* An unverified address is a claim by whoever holds the account, not by
     Google -- and this product's identity IS the address, so accepting one
     would let a person take an identity that names somebody else. */
  assert.equal((await verifyWith(signToken(goodClaims({ email_verified: true })))).ok, true)
})

test('a token with no subject, or no readable address, is refused', async () => {
  assert.equal((await verifyWith(signToken(goodClaims({ sub: undefined })))).code, 'GOOGLE_TOKEN_NO_SUBJECT')
  assert.equal((await verifyWith(signToken(goodClaims({ sub: '   ' })))).code, 'GOOGLE_TOKEN_NO_SUBJECT')
  for (const email of [undefined, '', 'not-an-address', 'two@@example.com', 'a@b', `${'x'.repeat(400)}@example.com`]) {
    const result = await verifyWith(signToken(goodClaims({ email })))
    assert.equal(result.ok, false, `${email} was accepted as an address`)
  }
})

test('a display name carrying a bidi override or a control character is stripped', async () => {
  /* A name that renders as a DIFFERENT name is an impersonation primitive in an
     attribution record. Written as escapes, never as the characters. */
  const hostile = `josh${String.fromCharCode(0x202e)}nimda${String.fromCharCode(0x0a)}admin`
  const result = await verifyWith(signToken(goodClaims({ name: hostile })))
  assert.equal(result.ok, true)
  assert.ok(!new RegExp("[\\u0000-\\u001f\\u200b-\\u200f\\u202a-\\u202e]").test(result.identity.displayName),
    'the display name still carries a control or bidi character')
})

test('a display name is not truncated in the middle of a Unicode character', async () => {
  const result = await verifyWith(signToken(goodClaims({ name: `${'a'.repeat(63)}😀 after-limit` })))
  assert.equal(result.ok, true)
  assert.equal(result.identity.displayName, 'a'.repeat(63))
  assert.ok(!result.identity.displayName.includes('\uFFFD'), 'the truncated display name contains a replacement character')
})

test('the key set is cached, refetched once for an unknown key, and never hammered', async () => {
  let calls = 0
  const document = jwksFor(googleKey, 'test-key-1')
  const cache = createJwksCache({ fetchImpl: jwksFetcher(document, { onCall: () => { calls += 1 } }), now })
  assert.equal((await cache.find('test-key-1')).ok, true)
  assert.equal(calls, 1)
  assert.equal((await cache.find('test-key-1')).ok, true)
  assert.equal(calls, 1, 'a second verification refetched the keys')

  /* An unknown kid is what a rotation looks like: one forced refetch. */
  const unknown = await cache.find('rotated-key')
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, 'GOOGLE_TOKEN_KEY_UNKNOWN')
  assert.equal(calls, 2, 'an unknown key id did not force a refetch')

  /* ...and then it stops, so a hostile token cannot turn this into a request
     loop against Google. */
  await cache.find('rotated-key')
  await cache.find('another-invented-key')
  assert.equal(calls, 2, 'a stream of invented key ids can make this fetch without limit')
  assert.equal(JWKS_FORCED_REFETCHES_PER_KEY_SET, 1)
  assert.equal(cache.stateForTests().forcedRefetches, 1)
})

test('when Google cannot be reached, or answers with nothing usable, nobody is signed in', async () => {
  const unreachable = await verifyWith(signToken(goodClaims()), {
    fetchImpl: async () => { throw new Error('ENOTFOUND') },
  })
  assert.equal(unreachable.ok, false)
  assert.equal(unreachable.code, 'GOOGLE_JWKS_UNREACHABLE')
  assert.ok(/could not reach Google/i.test(unreachable.reason))

  for (const body of ['{}', '{"keys":[]}', 'not json', '{"keys":[{"kty":"oct","kid":"x","n":"a","e":"b"}]}']) {
    const result = await verifyWith(signToken(goodClaims()), {
      fetchImpl: async () => ({ ok: true, text: async () => body }),
    })
    assert.equal(result.ok, false, `${body} produced a sign-in`)
  }
  const refused = await verifyWith(signToken(goodClaims()), { fetchImpl: async () => ({ ok: false, text: async () => '' }) })
  assert.equal(refused.code, 'GOOGLE_JWKS_REFUSED')
})

test('a key marked for encryption is never used to check a signature', async () => {
  const jwk = googleKey.publicKey.export({ format: 'jwk' })
  const encryptionOnly = { keys: [{ kty: 'RSA', kid: 'test-key-1', use: 'enc', n: jwk.n, e: jwk.e }] }
  const result = await verifyWith(signToken(goodClaims()), { fetchImpl: jwksFetcher(encryptionOnly) })
  assert.equal(result.ok, false)
})

test('addresses are normalized the same way the account store normalizes them', async () => {
  assert.equal(normalizeVerifiedEmail('  Probe.User@Example.COM '), 'probe.user@example.com')
  for (const bad of ['', 'a', 'no-at-sign', '@example.com', 'user@', 'user@@example.com', 'usér@example.com']) {
    assert.equal(normalizeVerifiedEmail(bad), null, `${bad} normalized to something`)
  }
})

/* ------------------------------ configuration ------------------------------ */

test('the shipped client id is checked for shape, and a Desktop client SECRET is carried, never echoed', async () => {
  assert.ok(CLIENT_ID_PATTERN.test(CLIENT_ID))
  for (const bad of ['', 'not-an-id', 'abc.apps.googleusercontent.com', `${CLIENT_ID}.evil.test`]) {
    assert.equal(CLIENT_ID_PATTERN.test(bad), false, `${bad} passed as a client id`)
  }
  /* THIS TEST USED TO ASSERT THE OPPOSITE, and it was asserting a false premise.
     Google refuses a Desktop-app code exchange that carries no client_secret --
     `HTTP 400 invalid_request: client_secret is missing.`, measured against the
     real client on 2026-08-11 with a correct S256 verifier present. A config
     that refuses the secret cannot complete one real sign-in. Google's own
     position for installed apps is that this value "is obviously not treated as
     a secret". So it is READ -- and must never be echoed anywhere. */
  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const dir = mkdtempSync(path.join(tmpdir(), 'gsc-'))
  const file = path.join(dir, 'google-signin.json')
  const SECRET = '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e'

  writeFileSync(file, JSON.stringify({ clientId: CLIENT_ID, clientSecret: SECRET }))
  const read = readConfigFile(file)
  assert.equal(read.ok, true, 'a Desktop-app client secret was refused')
  assert.equal(read.clientId, CLIENT_ID)
  assert.equal(read.clientSecret, SECRET, 'the client secret did not survive the read')

  /* Google's own downloaded client_secret.json spells it `client_secret`. */
  writeFileSync(file, JSON.stringify({ clientId: CLIENT_ID, client_secret: SECRET }))
  assert.equal(readConfigFile(file).clientSecret, SECRET, 'Google\'s own spelling was not read')

  /* Absent stays absent -- the client types that need none must not acquire one. */
  writeFileSync(file, JSON.stringify({ clientId: CLIENT_ID }))
  assert.equal(readConfigFile(file).clientSecret, '', 'a secret appeared where none was configured')

  /* A malformed one is REFUSED WITHOUT QUOTING ITSELF. A secret pasted with a
     newline in it fails at Google with an error nobody can read backwards. */
  writeFileSync(file, JSON.stringify({ clientId: CLIENT_ID, clientSecret: `${SECRET}\n GOCSPX-second` }))
  const refused = readConfigFile(file)
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'GOOGLE_SIGNIN_CLIENT_SECRET_INVALID')
  assert.ok(!/GOCSPX/.test(JSON.stringify(refused)), 'the refusal echoed the secret it refused')
})

test('NO CLIENT ID IS A STATED ABSENCE, not a silent one and not a fallback', async () => {
  /* THE STATE THIS MACHINE IS IN until the owner registers the client. It must
     resolve to a refusal WITH A SENTENCE that a screen can print next to a
     disabled button -- never to "unavailable, say nothing", and never to
     "carry on with something else and do not mention it". */
  const absent = await resolveGoogleSignInConfig({ userDataDir: null, appRoot: null, env: {} })
  assert.equal(absent.ok, false)
  assert.equal(absent.code, 'GOOGLE_SIGNIN_NOT_CONFIGURED')
  assert.ok(absent.reason.length > 60, 'the absence must be explained, not just coded')
  assert.ok(/account on this computer/i.test(absent.reason), 'and it must name what does work instead')

  const fromEnvironment = await resolveGoogleSignInConfig({ env: { TOOLSENABLED_GOOGLE_CLIENT_ID: CLIENT_ID } })
  assert.equal(fromEnvironment.ok, true)
  assert.equal(fromEnvironment.source, 'environment')
  assert.equal(fromEnvironment.testProvider, null)

  const bad = await resolveGoogleSignInConfig({ env: { TOOLSENABLED_GOOGLE_CLIENT_ID: 'nonsense' } })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'GOOGLE_SIGNIN_CLIENT_ID_INVALID')
})

test('a test identity provider must announce itself, and may only be on this computer', async () => {
  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const dir = mkdtempSync(path.join(tmpdir(), 'gsc-'))
  const file = path.join(dir, 'google-signin.json')
  const endpoints = {
    authorizationEndpoint: 'http://127.0.0.1:9999/auth',
    tokenEndpoint: 'http://127.0.0.1:9999/token',
    jwksUri: 'http://127.0.0.1:9999/jwks',
    issuer: 'http://127.0.0.1:9999',
  }

  writeFileSync(file, JSON.stringify({ clientId: CLIENT_ID, testProvider: endpoints }))
  assert.equal(readConfigFile(file).code, 'GOOGLE_SIGNIN_TEST_PROVIDER_UNACKNOWLEDGED',
    'endpoints were repointed away from Google without the file saying so')

  writeFileSync(file, JSON.stringify({
    clientId: CLIENT_ID,
    testProvider: { ...endpoints, tokenEndpoint: 'https://evil.test/token', iUnderstandThisIsNotGoogle: true },
  }))
  assert.equal(readConfigFile(file).code, 'GOOGLE_SIGNIN_TEST_PROVIDER_NOT_LOOPBACK',
    'a test override could point the product at somebody else\'s server')

  writeFileSync(file, JSON.stringify({
    clientId: CLIENT_ID,
    testProvider: { authorizationEndpoint: endpoints.authorizationEndpoint, iUnderstandThisIsNotGoogle: true },
  }))
  assert.equal(readConfigFile(file).code, 'GOOGLE_SIGNIN_TEST_PROVIDER_INCOMPLETE',
    'a half-declared override would send a real code to a local port')

  writeFileSync(file, JSON.stringify({ clientId: CLIENT_ID, testProvider: { ...endpoints, iUnderstandThisIsNotGoogle: true } }))
  const accepted = readConfigFile(file)
  assert.equal(accepted.ok, true)
  assert.equal(accepted.testProvider.issuer, 'http://127.0.0.1:9999')
})

/* ------------------------------- the vault ---------------------------------- */

/* WHAT THESE PIN, AND THE SENTENCE THAT MADE THEM NECESSARY. The owner, having
   stored the Google client where this product's own credential catalogue says
   credentials go: "we have the oauth in vault ive done this like 10 times".
   The resolver read two files and an environment variable and never asked the
   vault, and the refusal it produced said only that the feature was
   unavailable -- so ten deliberate attempts and never having tried looked
   exactly alike from the screen. */

const VAULT_STORE = 'C:\\Users\\somebody\\AppData\\Roaming\\ToolsEnabled\\capability\\vault\\secrets.json'
const VAULT_SECRET = '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choed'
const CAPABILITY_ROOT = 'C:\\program\\resources\\capability'

/* A vault, faked at the seam shell/vault-presence.cjs presents, so every branch
   below is reachable without PowerShell, a real store, or a Windows account
   that can decrypt one. */
function vaultReader({ readable = true, records = {}, store = VAULT_STORE, code = 'VAULT_UNREADABLE', detail = 'This installation’s vault could not be read, so what it holds is unknown.' } = {}) {
  return (keys) => {
    if (!readable) {
      return {
        readable: false,
        code,
        detail,
        store,
        values: null,
        absent: null,
      }
    }
    const values = new Map()
    const absent = []
    for (const key of keys) {
      const value = records[key]
      if (typeof value === 'string' && value.trim()) values.set(key, value.trim())
      else absent.push(key)
    }
    return { readable: true, code: 'VAULT_RECORDS_READ', detail: '', store, values, absent }
  }
}

function presenceProbe(present) {
  return () => ({ present, readable: present !== null, code: 'PROBE', detail: '' })
}

async function vaultConfigured(records, extra = {}) {
  return await resolveGoogleSignInConfig({
    userDataDir: null,
    appRoot: null,
    env: {},
    capabilityRoot: CAPABILITY_ROOT,
    stateRoot: 'C:\\Users\\somebody\\AppData\\Roaming\\ToolsEnabled\\capability',
    readVaultValues: vaultReader(records),
    probeVaultRecord: presenceProbe(false),
    ...extra,
  })
}

test('THE VAULT IS A SOURCE: credentials stored where the product says they go make Google sign-in available', async () => {
  const resolved = await vaultConfigured({
    records: {
      [VAULT_CLIENT_ID_KEY]: CLIENT_ID,
      [VAULT_CLIENT_SECRET_KEY]: VAULT_SECRET,
    },
  })
  assert.equal(resolved.ok, true, 'a client stored in the vault was still reported unavailable')
  assert.equal(resolved.source, 'vault')
  assert.equal(resolved.clientId, CLIENT_ID)
  assert.equal(resolved.clientSecret, VAULT_SECRET, 'the secret did not survive the vault read')
  /* A vault carries two strings, never four endpoints: a vault-sourced build is
     always pointed at Google itself. */
  assert.equal(resolved.testProvider, null)
})

test('THE ORDER HOLDS: environment over vault, vault over the per-installation file, file over the shipped default', async () => {
  const { writeFileSync, mkdtempSync, mkdirSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')

  const userData = mkdtempSync(path.join(tmpdir(), 'gsv-user-'))
  const appRoot = mkdtempSync(path.join(tmpdir(), 'gsv-app-'))
  mkdirSync(path.join(appRoot, 'config'))
  const SHIPPED_ID = '111111111111-shippedaaaaaaaaaaaaaaaaaaaaaaaaaa.apps.googleusercontent.com'
  writeFileSync(path.join(userData, 'google-signin.json'), JSON.stringify({ clientId: OTHER_CLIENT_ID, clientSecret: 'GOCSPX-from-the-installation-file' }))
  writeFileSync(path.join(appRoot, 'config', 'google-signin.json'), JSON.stringify({ clientId: SHIPPED_ID, clientSecret: 'GOCSPX-from-the-artifact' }))

  const withVault = {
    capabilityRoot: CAPABILITY_ROOT,
    stateRoot: 'C:\\state',
    readVaultValues: vaultReader({ records: { [VAULT_CLIENT_ID_KEY]: CLIENT_ID, [VAULT_CLIENT_SECRET_KEY]: VAULT_SECRET } }),
    probeVaultRecord: presenceProbe(false),
  }

  /* 1. The environment overrides one launch and must not be quietly replaced by
        whatever this machine has stored -- that is how a harness that named a
        client ends up testing a different one. */
  const fromEnvironment = await resolveGoogleSignInConfig({
    userDataDir: userData, appRoot, env: { TOOLSENABLED_GOOGLE_CLIENT_ID: OTHER_CLIENT_ID }, ...withVault,
  })
  assert.equal(fromEnvironment.source, 'environment')
  assert.equal(fromEnvironment.clientId, OTHER_CLIENT_ID)

  /* 2. The vault outranks a file anything running as this user can drop into
        userData. */
  const fromVault = await resolveGoogleSignInConfig({ userDataDir: userData, appRoot, env: {}, ...withVault })
  assert.equal(fromVault.source, 'vault')
  assert.equal(fromVault.clientId, CLIENT_ID)

  /* 3. With the vault empty, the per-installation file still wins over the
        shipped one -- the order that was there before the vault existed. */
  const fromFile = await resolveGoogleSignInConfig({
    userDataDir: userData, appRoot, env: {}, ...withVault, readVaultValues: vaultReader({ records: {} }),
  })
  assert.equal(fromFile.source, 'installation')
  assert.equal(fromFile.clientId, OTHER_CLIENT_ID)

  /* 4. And with neither, the artifact's own default. */
  const fromShipped = await resolveGoogleSignInConfig({
    userDataDir: mkdtempSync(path.join(tmpdir(), 'gsv-empty-')),
    appRoot,
    env: {},
    ...withVault,
    readVaultValues: vaultReader({ records: {} }),
  })
  assert.equal(fromShipped.source, 'shipped')
  assert.equal(fromShipped.clientId, SHIPPED_ID)
})

test('THE REFUSAL NAMES THE VAULT: an absence says where the two strings go and which store was read', async () => {
  const absent = await vaultConfigured({ records: {} })
  assert.equal(absent.ok, false)
  assert.equal(absent.code, 'GOOGLE_SIGNIN_NOT_CONFIGURED')

  /* THE CUSTOMER'S HALF IS UNCHANGED. Somebody who will never configure this is
     still told that nothing is wrong with them and what works today. */
  assert.ok(/account on this computer/i.test(absent.reason), 'the refusal stopped naming what does work instead')
  assert.ok(/nothing is wrong with your computer/i.test(absent.reason))

  /* THE HALF THAT WAS MISSING FOR TEN ATTEMPTS. */
  assert.ok(/vault/i.test(absent.reason), 'the refusal does not name the vault')
  assert.ok(absent.reason.includes(VAULT_CLIENT_ID_KEY), 'the refusal does not say where the client id goes')
  assert.ok(absent.reason.includes(VAULT_CLIENT_SECRET_KEY), 'the refusal does not say where the client secret goes')
  /* WHICH STORE, spelled out. The whole trap is that the vault somebody filled
     and the vault this installation reads can be two different files -- the
     same split shell/vault-presence.cjs was built for on the payment card. */
  assert.ok(absent.reason.includes(VAULT_STORE), 'the refusal does not say which vault it read')
})

test('AN UNREADABLE VAULT IS UNKNOWN, NEVER ABSENT', async () => {
  const unknown = await vaultConfigured({ readable: false })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, 'GOOGLE_SIGNIN_VAULT_UNREADABLE', 'a vault that could not be read was reported as one that is empty')
  assert.ok(/unknown/i.test(unknown.reason), 'the refusal does not say the answer is unknown')
  assert.ok(/not the same as it holding none/i.test(unknown.reason))

  /* THE CLAIMS IT MUST NOT MAKE. Not that the vault holds nothing, and not
     that the person has failed to store anything -- neither was measured. */
  assert.ok(!/holds neither/i.test(unknown.reason), 'an unreadable vault was described as empty')
  assert.ok(!unknown.reason.includes(VAULT_CLIENT_ID_KEY), 'an unreadable vault was answered with setup instructions it did not earn')

  for (const [vaultCode, expected] of [
    ['VAULT_RESPONSE_INVALID', 'GOOGLE_SIGNIN_VAULT_RESPONSE_INVALID'],
    ['VAULT_TIMEOUT', 'GOOGLE_SIGNIN_VAULT_TIMEOUT'],
    ['VAULT_TOOLING_UNAVAILABLE', 'GOOGLE_SIGNIN_VAULT_TOOLING_UNAVAILABLE'],
  ]) {
    const untrustedDetail = `must-not-cross-vault-boundary-${vaultCode}`
    const distinct = await vaultConfigured({ readable: false, code: vaultCode, detail: untrustedDetail })
    assert.equal(distinct.code, expected, `${vaultCode} was collapsed into a generic unreadable refusal`)
    assert.ok(!distinct.reason.includes(untrustedDetail), 'a vault reader detail crossed into a person-facing error')
  }

  /* AND IT DOES NOT VETO A SOURCE THAT DOES ANSWER. A locked vault beside a
     working config file must not take the working one down with it. */
  return (async () => {
    const { writeFileSync, mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const path = await import('node:path')
    const userData = mkdtempSync(path.join(tmpdir(), 'gsv-locked-'))
    writeFileSync(path.join(userData, 'google-signin.json'), JSON.stringify({ clientId: CLIENT_ID, clientSecret: 'GOCSPX-file' }))
    const resolved = await resolveGoogleSignInConfig({
      userDataDir: userData,
      appRoot: null,
      env: {},
      capabilityRoot: CAPABILITY_ROOT,
      stateRoot: 'C:\\state',
      readVaultValues: vaultReader({ readable: false }),
      probeVaultRecord: presenceProbe(null),
    })
    assert.equal(resolved.ok, true, 'a vault that could not be read blocked a config file that could')
    assert.equal(resolved.source, 'installation')
  })()
})

test('THE OTHER GOOGLE CLIENT IS SAID OUT LOUD, because "you set up the other one" is not "you set up nothing"', async () => {
  const confused = await vaultConfigured({ records: {} }, { probeVaultRecord: presenceProbe(true) })
  assert.equal(confused.ok, false)
  assert.equal(confused.code, 'GOOGLE_SIGNIN_VAULT_HOLDS_OTHER_CLIENT')
  assert.ok(confused.reason.includes(VAULT_CAPABILITY_CLIENT_ID_KEY), 'the refusal does not name the record that IS there')
  assert.ok(confused.reason.includes(VAULT_CLIENT_ID_KEY) && confused.reason.includes(VAULT_CLIENT_SECRET_KEY),
    'the refusal does not name the records that should be')
  assert.ok(/Drive/.test(confused.reason), 'the refusal does not say why the other client must not be used')
  assert.ok(/account on this computer/i.test(confused.reason))

  const asynchronouslyConfused = await vaultConfigured({ records: {} }, {
    probeVaultRecord: async () => ({ present: true, readable: true, code: 'PROBE', detail: '' }),
  })
  assert.equal(asynchronouslyConfused.code, 'GOOGLE_SIGNIN_VAULT_HOLDS_OTHER_CLIENT')
})

test('HALF A CLIENT STOPS THE SEARCH AND SAYS WHICH HALF, and never quotes the half it has', async () => {
  const noSecret = await vaultConfigured({ records: { [VAULT_CLIENT_ID_KEY]: CLIENT_ID } })
  assert.equal(noSecret.ok, false)
  assert.equal(noSecret.code, 'GOOGLE_SIGNIN_VAULT_CLIENT_SECRET_MISSING')
  assert.ok(noSecret.reason.includes(VAULT_CLIENT_SECRET_KEY))

  const noId = await vaultConfigured({ records: { [VAULT_CLIENT_SECRET_KEY]: VAULT_SECRET } })
  assert.equal(noId.ok, false)
  assert.equal(noId.code, 'GOOGLE_SIGNIN_VAULT_CLIENT_ID_MISSING')
  assert.ok(noId.reason.includes(VAULT_CLIENT_ID_KEY))
  assert.ok(!/GOCSPX/.test(JSON.stringify(noId)), 'the refusal echoed the secret it was holding')

  /* A malformed secret is refused by shape and still says nothing about it. */
  const malformed = await vaultConfigured({
    records: { [VAULT_CLIENT_ID_KEY]: CLIENT_ID, [VAULT_CLIENT_SECRET_KEY]: `${VAULT_SECRET}\n GOCSPX-second` },
  })
  assert.equal(malformed.ok, false)
  assert.equal(malformed.code, 'GOOGLE_SIGNIN_CLIENT_SECRET_INVALID')
  assert.ok(!/GOCSPX/.test(JSON.stringify(malformed)), 'the refusal echoed the secret it refused')

  /* A vault id that is not a Google id is refused by the same rule the files
     get, and it stops the search rather than quietly using another client. */
  const badId = await vaultConfigured({ records: { [VAULT_CLIENT_ID_KEY]: 'nonsense', [VAULT_CLIENT_SECRET_KEY]: VAULT_SECRET } })
  assert.equal(badId.code, 'GOOGLE_SIGNIN_CLIENT_ID_INVALID')
})

test('NO PATH OUT OF THIS RESOLVER CAN EMIT THE CLIENT SECRET', async () => {
  /* THE CLIENT ID IS PUBLIC BY CONSTRUCTION -- it travels in a URL the browser
     opens. THE SECRET IS NOT, and it has exactly one destination: the token
     POST body, from `clientSecret` on a resolved config. Nothing else -- no
     refusal, no code, no log line, no field a renderer is handed -- may carry
     it. */
  const fs = (await import('node:fs')).default
  const emitted = []
  const restore = []
  const intercept = (target, name) => {
    const original = target[name]
    target[name] = (...args) => { emitted.push({ name, args }) }
    restore.push(() => { target[name] = original })
  }

  /* Observe the output boundaries while driving both successful and refusing
     credential paths. This used to search the modules' source for a few output
     API spellings, which stayed green if output was added through an alias. */
  for (const name of ['log', 'info', 'warn', 'error', 'debug']) intercept(console, name)
  intercept(process.stdout, 'write')
  intercept(process.stderr, 'write')
  intercept(fs, 'writeFileSync')
  intercept(fs, 'appendFileSync')

  let everyRefusal
  let resolved
  try {
    everyRefusal = [
      await vaultConfigured({ records: {} }),
      await vaultConfigured({ readable: false }),
      await vaultConfigured({ records: {} }, { probeVaultRecord: presenceProbe(true) }),
      await vaultConfigured({ records: { [VAULT_CLIENT_ID_KEY]: CLIENT_ID } }),
      await vaultConfigured({ records: { [VAULT_CLIENT_SECRET_KEY]: VAULT_SECRET } }),
      await vaultConfigured({ records: { [VAULT_CLIENT_ID_KEY]: CLIENT_ID, [VAULT_CLIENT_SECRET_KEY]: `${VAULT_SECRET}\n x` } }),
      await vaultConfigured({ records: { [VAULT_CLIENT_ID_KEY]: 'nonsense', [VAULT_CLIENT_SECRET_KEY]: VAULT_SECRET } }),
    ]
    resolved = await vaultConfigured({ records: { [VAULT_CLIENT_ID_KEY]: CLIENT_ID, [VAULT_CLIENT_SECRET_KEY]: VAULT_SECRET } })
  } finally {
    for (const undo of restore.reverse()) undo()
  }

  assert.deepEqual(emitted, [], 'resolver and vault reader emitted output while handling credentials')

  for (const refused of everyRefusal) {
    assert.equal(refused.ok, false)
    assert.ok(!JSON.stringify(refused).includes(VAULT_SECRET), `${refused.code} carried the client secret`)
    assert.ok(!/GOCSPX/.test(JSON.stringify(refused)), `${refused.code} carried a secret-shaped string`)
    /* A refusal is three fields. A fourth is a field somebody forwards. */
    assert.deepEqual(Object.keys(refused).sort(), ['code', 'ok', 'reason'])
  }

  /* The one object that DOES carry it carries it in one named place. */
  const carrying = Object.entries(resolved).filter(([, value]) => value === VAULT_SECRET).map(([key]) => key)
  assert.deepEqual(carrying, ['clientSecret'])
})

test('THE VAULT READER ITSELF KEEPS ABSENT AND UNREADABLE APART', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const root = mkdtempSync(path.join(tmpdir(), 'gsv-cap-'))
  mkdirSync(path.join(root, 'tools'))
  writeFileSync(path.join(root, 'tools', 'secrets.ps1'), '# stand-in for the real vault script\n')
  const options = (run) => ({ capabilityRoot: root, stateRoot: 'C:\\state', run, platform: 'win32' })
  const KEYS = [VAULT_CLIENT_ID_KEY, VAULT_CLIENT_SECRET_KEY]

  /* Both on file. */
  const both = await vaultRecordValues(KEYS, options(() => JSON.stringify({
    [VAULT_CLIENT_ID_KEY]: { found: true, value: CLIENT_ID },
    [VAULT_CLIENT_SECRET_KEY]: { found: true, value: VAULT_SECRET },
  })))
  assert.equal(both.readable, true)
  assert.equal(both.values.get(VAULT_CLIENT_ID_KEY), CLIENT_ID)
  assert.deepEqual([...both.absent], [])

  /* Read, and genuinely empty. This is a definite fact, not an unknown. */
  const empty = await vaultRecordValues(KEYS, options(() => JSON.stringify({
    [VAULT_CLIENT_ID_KEY]: { found: false },
    [VAULT_CLIENT_SECRET_KEY]: { found: false },
  })))
  assert.equal(empty.readable, true)
  assert.deepEqual([...empty.absent].sort(), [...KEYS].sort())

  /* A record holding whitespace is not a credential. */
  const blank = await vaultRecordValues(KEYS, options(() => JSON.stringify({
    [VAULT_CLIENT_ID_KEY]: { found: true, value: '   ' },
    [VAULT_CLIENT_SECRET_KEY]: { found: false },
  })))
  assert.equal(blank.readable, true)
  assert.equal(blank.values.size, 0)

  /* Every way the read can fail is UNKNOWN, and none of them is "absent".
     EACH ANSWER BELOW IS MALFORMED IN BOTH RECORDS, on purpose: an earlier
     version of this list left the second key out of the object, so the loop
     reached the "no entry at all" branch and returned unknown before it ever
     tested the branch the case was written for. It passed against a reader that
     had stopped keeping absent and unknown apart. */
  const throws = () => { const error = new Error('vault is locked'); error.status = 1; throw error }
  const bothKeys = (entry) => () => JSON.stringify({ [VAULT_CLIENT_ID_KEY]: entry, [VAULT_CLIENT_SECRET_KEY]: entry })
  for (const run of [
    throws,
    () => 'not json at all',
    async () => JSON.stringify(['a']),
    /* `found` is a word this reader does not know -- not a "no". */
    bothKeys({ found: 'maybe' }),
    /* found, and no value with it. */
    bothKeys({ found: true }),
    /* an entry that is not an object at all. */
    bothKeys('GOCSPX-bare-string'),
  ]) {
    const failed = await vaultRecordValues(KEYS, options(run))
    assert.equal(failed.readable, false, 'a failed read was reported as a completed one')
    assert.equal(failed.values, null, 'a failed read handed back values')
    assert.equal(failed.absent, null, 'a failed read claimed records were absent')
  }

  const failureCanary = 'must-not-cross-value-reader-boundary'
  const stopped = await vaultRecordValues(KEYS, options(() => {
    throw Object.assign(new Error(failureCanary), { code: 1, stderr: failureCanary, stdout: failureCanary })
  }))
  assert.equal(stopped.code, 'VAULT_READ_FAILED')
  assert.ok(!JSON.stringify(stopped).includes(failureCanary), 'a child-process error reached the vault reader response')

  const timedOut = await vaultRecordValues(KEYS, options(() => { throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }))
  assert.equal(timedOut.code, 'VAULT_TIMEOUT')

  const unavailable = await vaultRecordValues(KEYS, options(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }))
  assert.equal(unavailable.code, 'VAULT_TOOLING_UNAVAILABLE')

  const malformed = await vaultRecordValues(KEYS, options(() => '{not-json'))
  assert.equal(malformed.code, 'VAULT_RESPONSE_INVALID')

  /* No helper program is UNKNOWN too -- it is not evidence about a store. */
  const noTooling = await vaultRecordValues(KEYS, { capabilityRoot: null, stateRoot: 'C:\\state' })
  assert.equal(noTooling.readable, false)
  assert.equal(noTooling.code, 'VAULT_TOOLING_ABSENT')

  /* And a failure never carries what it was reading. */
  const leaked = await vaultRecordValues(KEYS, options(() => { const error = new Error(`stderr: ${VAULT_SECRET}`); error.stderr = VAULT_SECRET; throw error }))
  assert.ok(!JSON.stringify({ ...leaked }).includes(VAULT_SECRET), 'a vault failure quoted the record it was reading')
})

/* --------------------------------- the flow --------------------------------- */

test('the scopes are identity only, and the endpoints are Google', () => {
  assert.deepEqual([...SIGNIN_SCOPES], ['openid', 'email', 'profile'])
  assert.equal(AUTHORIZATION_ENDPOINT, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(TOKEN_ENDPOINT, 'https://oauth2.googleapis.com/token')
  assert.equal(LOOPBACK_HOST, '127.0.0.1')
})

test('a configured client secret reaches the TOKEN endpoint only, and never the browser', async () => {
  /* WHY THIS IS HERE. Google refuses a Desktop-app exchange without it --
     `invalid_request: client_secret is missing.` -- so it has to be sent. The
     thing that must never happen is it being sent anywhere ELSE: the
     authorization URL goes to the person's browser, into their history, and
     across whatever proxy they are behind. */
  const SECRET = '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y'
  let opened = null
  let exchangeBody = null
  const attempt = createGoogleSignIn({
    clientId: CLIENT_ID,
    clientSecret: SECRET,
    openExternal: async url => { opened = url },
    fetchImpl: async (target, init) => {
      if (target === TOKEN_ENDPOINT) { exchangeBody = new URLSearchParams(init.body) }
      return { ok: false, text: async () => JSON.stringify({ error: 'invalid_grant' }) }
    },
    timeoutMs: 4000,
  })

  const running = attempt.run()
  while (!opened) await new Promise(resolve => setTimeout(resolve, 5))
  const url = new URL(opened)
  assert.ok(!opened.includes(SECRET), 'the client secret reached the browser')
  assert.ok(!/client_secret/i.test(opened), 'a client secret parameter reached the authorization URL')

  const redirect = new URL(url.searchParams.get('redirect_uri'))
  await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${redirect.port}${REDIRECT_PATH}?code=abc&state=${encodeURIComponent(url.searchParams.get('state'))}`,
      response => { response.resume(); response.on('end', resolve) }).on('error', reject)
  })
  const outcome = await running

  assert.equal(exchangeBody?.get('client_secret'), SECRET, 'the exchange did not carry the configured client secret')
  /* PKCE IS NOT REPLACED BY IT. The two travel together or the flow is weaker
     than it was before this line existed. */
  assert.ok((exchangeBody?.get('code_verifier') || '').length >= 43, 'the exchange dropped PKCE once a secret was configured')
  assert.equal(outcome.ok, false)
  assert.ok(!JSON.stringify(outcome).includes(SECRET), 'a refusal echoed the client secret')
})

test('the authorization request carries PKCE, a state, a nonce, and NO client secret', async () => {
  let opened = null
  const attempt = createGoogleSignIn({
    clientId: CLIENT_ID,
    openExternal: async url => { opened = url },
    fetchImpl: async () => ({ ok: false, text: async () => '{}' }),
    timeoutMs: 50,
  })
  const outcome = await attempt.run()
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'GOOGLE_SIGNIN_TIMED_OUT')

  const url = new URL(opened)
  assert.equal(url.origin + url.pathname, AUTHORIZATION_ENDPOINT)
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('client_id'), CLIENT_ID)
  assert.equal(url.searchParams.get('scope'), 'openid email profile')
  /* S256 ONLY. `plain` is a PKCE challenge that proves nothing. */
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.ok((url.searchParams.get('code_challenge') || '').length >= 43)
  assert.ok((url.searchParams.get('state') || '').length >= 32)
  assert.ok((url.searchParams.get('nonce') || '').length >= 32)
  assert.equal(url.searchParams.get('prompt'), 'select_account')
  /* NOT ASKED FOR, so Google issues no refresh token and there is no durable
     credential to somebody's Google account for this product to hold. */
  assert.equal(url.searchParams.get('access_type'), null)
  assert.ok(!/client_secret/i.test(opened), 'a client secret reached the authorization URL')

  const redirect = new URL(url.searchParams.get('redirect_uri'))
  assert.equal(redirect.hostname, '127.0.0.1', 'the redirect must be the literal loopback address, not a name')
  assert.equal(redirect.pathname, REDIRECT_PATH)
  assert.ok(Number(redirect.port) > 0, 'the redirect must use an operating-system chosen port')
})

test('the loopback listener answers only its own path, and only with the right state', async () => {
  let opened = null
  const attempt = createGoogleSignIn({
    clientId: CLIENT_ID,
    openExternal: async url => { opened = url },
    fetchImpl: async () => ({ ok: false, text: async () => '{"error":"invalid_grant"}' }),
    timeoutMs: 4000,
  })
  const running = attempt.run()
  /* Wait for the URL, which is only produced once the listener is up. */
  while (!opened) await new Promise(resolve => setTimeout(resolve, 5))
  const url = new URL(opened)
  const redirect = new URL(url.searchParams.get('redirect_uri'))
  const base = `http://127.0.0.1:${redirect.port}`

  const get = async path => new Promise((resolve, reject) => {
    http.get(`${base}${path}`, response => {
      response.resume()
      resolve(response.statusCode)
    }).on('error', reject)
  })

  assert.equal(await get('/'), 404, 'a stray request to the root was answered')
  assert.equal(await get('/anything-else'), 404)
  /* A WRONG STATE MUST NOT SETTLE THE ATTEMPT EITHER. A page that could make
     somebody's sign-in fail by loading an address is a denial of service. */
  assert.equal(await get(`${REDIRECT_PATH}?code=abc&state=wrong`), 400)
  assert.equal(attempt.settled, false, 'a wrong-state callback ended the sign-in')

  /* The real one. The exchange is stubbed to refuse, which is what makes this
     resolve rather than hang. */
  assert.equal(await get(`${REDIRECT_PATH}?code=abc&state=${encodeURIComponent(url.searchParams.get('state'))}`), 200)
  const outcome = await running
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'GOOGLE_SIGNIN_REFUSED_BY_GOOGLE')
  assert.ok(/invalid_grant/.test(outcome.reason), 'Google\'s own reason should be nameable')
})

test('every absence resolves to signed out with a sentence, and never to a sign-in', async () => {
  const cases = [
    ['no client id', { clientId: '' }, 'GOOGLE_SIGNIN_NOT_CONFIGURED'],
    ['no browser', { openExternal: undefined }, 'GOOGLE_SIGNIN_NO_BROWSER'],
    ['no network stack', { fetchImpl: null }, 'GOOGLE_SIGNIN_NO_NETWORK_STACK'],
    ['the browser will not open', { openExternal: async () => { throw new Error('no handler') } }, 'GOOGLE_SIGNIN_BROWSER_FAILED'],
    ['the port is refused', {
      createServer: () => {
        const listener = http.createServer(() => {})
        listener.listen = () => { const error = new Error('EACCES'); error.code = 'EACCES'; listener.emit('error', error) }
        listener.on = listener.on.bind(listener)
        return listener
      },
    }, 'GOOGLE_SIGNIN_PORT_REFUSED'],
    ['the person never finishes', { timeoutMs: 40 }, 'GOOGLE_SIGNIN_TIMED_OUT'],
  ]
  for (const [label, overrides, expected] of cases) {
    const attempt = createGoogleSignIn({
      clientId: CLIENT_ID,
      openExternal: async () => {},
      fetchImpl: async () => ({ ok: true, text: async () => '{}' }),
      timeoutMs: 200,
      ...overrides,
    })
    const outcome = await attempt.run()
    assert.equal(outcome.ok, false, `${label} produced a sign-in`)
    assert.equal(outcome.code, expected, `${label} gave ${outcome.code}`)
    assert.ok(typeof outcome.reason === 'string' && outcome.reason.length > 40,
      `${label} refused without saying what happened`)
    assert.ok(!('identity' in outcome), `${label} returned an identity on a failure`)
  }
})

test('cancelling is the honest answer to a browser somebody closed', async () => {
  const attempt = createGoogleSignIn({
    clientId: CLIENT_ID,
    openExternal: async () => {},
    fetchImpl: async () => ({ ok: true, text: async () => '{}' }),
    timeoutMs: 60_000,
  })
  const running = attempt.run()
  await new Promise(resolve => setTimeout(resolve, 20))
  attempt.cancel()
  const outcome = await running
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'GOOGLE_SIGNIN_CANCELLED')
})

test('starting the same attempt twice does not strand the first caller', async () => {
  let listeners = 0
  const attempt = createGoogleSignIn({
    clientId: CLIENT_ID,
    openExternal: async () => {},
    fetchImpl: async () => ({ ok: true, text: async () => '{}' }),
    createServer: handler => { listeners += 1; return http.createServer(handler) },
    timeoutMs: 60_000,
  })
  const first = attempt.run()
  const second = await attempt.run()
  assert.equal(second.ok, false)
  assert.equal(second.code, 'GOOGLE_SIGNIN_ALREADY_USED')
  assert.equal(listeners, 1, 'the repeated call opened another callback listener')

  attempt.cancel()
  const outcome = await first
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'GOOGLE_SIGNIN_CANCELLED')
})

test('a network failure at the exchange is named separately from Google refusing', async () => {
  let opened = null
  const attempt = createGoogleSignIn({
    clientId: CLIENT_ID,
    openExternal: async url => { opened = url },
    fetchImpl: async () => { throw new Error('ENOTFOUND oauth2.googleapis.com') },
    timeoutMs: 4000,
  })
  const running = attempt.run()
  while (!opened) await new Promise(resolve => setTimeout(resolve, 5))
  const url = new URL(opened)
  const redirect = new URL(url.searchParams.get('redirect_uri'))
  await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${redirect.port}${REDIRECT_PATH}?code=abc&state=${encodeURIComponent(url.searchParams.get('state'))}`,
      response => { response.resume(); resolve() }).on('error', reject)
  })
  const outcome = await running
  assert.equal(outcome.code, 'GOOGLE_SIGNIN_UNREACHABLE')
  assert.ok(/could not reach Google/i.test(outcome.reason))
  assert.ok(/account on this computer/i.test(outcome.reason), 'the offline case must name what still works')
})

test('the person pressing Cancel on Google\'s own screen is reported as a choice', async () => {
  let opened = null
  const attempt = createGoogleSignIn({
    clientId: CLIENT_ID,
    openExternal: async url => { opened = url },
    fetchImpl: async () => ({ ok: true, text: async () => '{}' }),
    timeoutMs: 4000,
  })
  const running = attempt.run()
  while (!opened) await new Promise(resolve => setTimeout(resolve, 5))
  const url = new URL(opened)
  const redirect = new URL(url.searchParams.get('redirect_uri'))
  await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${redirect.port}${REDIRECT_PATH}?error=access_denied&state=${encodeURIComponent(url.searchParams.get('state'))}`,
      response => { response.resume(); resolve() }).on('error', reject)
  })
  const outcome = await running
  assert.equal(outcome.code, 'GOOGLE_SIGNIN_DECLINED')
  assert.ok(/cancelled/i.test(outcome.reason))
})

test('the page the browser lands on carries no code and runs no script', async () => {
  let opened = null
  const attempt = createGoogleSignIn({
    clientId: CLIENT_ID,
    openExternal: async url => { opened = url },
    fetchImpl: async () => ({ ok: false, text: async () => '{"error":"invalid_grant"}' }),
    timeoutMs: 4000,
  })
  const running = attempt.run()
  while (!opened) await new Promise(resolve => setTimeout(resolve, 5))
  const url = new URL(opened)
  const redirect = new URL(url.searchParams.get('redirect_uri'))
  const secret = 'AUTHORIZATION-CODE-THAT-MUST-NOT-BE-RENDERED'
  const body = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${redirect.port}${REDIRECT_PATH}?code=${secret}&state=${encodeURIComponent(url.searchParams.get('state'))}`,
      response => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', chunk => { text += chunk })
        response.on('end', async () => resolve({ text, headers: response.headers }))
      }).on('error', reject)
  })
  await running
  assert.ok(!body.text.includes(secret), 'the completion page rendered the authorization code')
  assert.ok(!/<script/i.test(body.text), 'the completion page runs script')
  assert.equal(body.headers['cache-control'], 'no-store')
  assert.ok(/default-src 'none'/.test(body.headers['content-security-policy'] || ''))
})

test('the whole flow, end to end, against a signed token — the accepting case', async () => {
  /* Everything above proves a refusal. This proves the flow WORKS, so none of
     them is passing because the verifier refuses everything. */
  let opened = null
  const jwks = jwksFor(googleKey, 'test-key-1')
  let issuedNonce = null

  const attempt = createGoogleSignIn({
    clientId: CLIENT_ID,
    openExternal: async url => { opened = url },
    now,
    timeoutMs: 4000,
    fetchImpl: async (target, init) => {
      if (target === TOKEN_ENDPOINT) {
        const body = new URLSearchParams(init.body)
        /* PKCE, checked from the provider's side: the verifier must arrive. No
           client secret was configured for this attempt, so none may be
           invented -- absence stays absence. */
        assert.ok((body.get('code_verifier') || '').length >= 43, 'the exchange carried no PKCE verifier')
        assert.equal(body.get('client_secret'), null, 'the exchange carried a client secret nobody configured')
        assert.equal(body.get('grant_type'), 'authorization_code')
        return {
          ok: true,
          text: async () => JSON.stringify({
            id_token: signToken(goodClaims({ nonce: issuedNonce })),
            access_token: 'an-access-token-that-must-not-be-stored',
            token_type: 'Bearer',
          }),
        }
      }
      return { ok: true, text: async () => JSON.stringify(jwks) }
    },
  })

  const running = attempt.run()
  while (!opened) await new Promise(resolve => setTimeout(resolve, 5))
  const url = new URL(opened)
  issuedNonce = url.searchParams.get('nonce')
  const redirect = new URL(url.searchParams.get('redirect_uri'))
  await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${redirect.port}${REDIRECT_PATH}?code=good-code&state=${encodeURIComponent(url.searchParams.get('state'))}`,
      response => { response.resume(); resolve() }).on('error', reject)
  })
  const outcome = await running
  assert.equal(outcome.ok, true, outcome.reason)
  assert.equal(outcome.identity.email, 'probe.user@example.com')
  assert.equal(outcome.identity.assurance, 'id_token-verified')
  /* NOTHING GOOGLE ISSUED COMES BACK. The access token was in the reply and is
     nowhere in what this returns. */
  const serialized = JSON.stringify(outcome)
  assert.ok(!/an-access-token-that-must-not-be-stored/.test(serialized), 'the access token escaped the flow')
  /* Field names a token would arrive in. `id_token-verified` is deliberately
     not one of them: it is the name of a check that happened, and an earlier
     version of this line flagged it -- a guard firing on the evidence that the
     verification ran. */
  assert.ok(!/"access_token"|"refresh_token"|accessToken|refreshToken|token_type/.test(serialized),
    'a token field escaped the flow')
})
