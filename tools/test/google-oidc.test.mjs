/* Direct contract tests for shell/google-oidc.cjs.  Keep these separate from the
 * end-to-end sign-in tests: this is main-process code, but its dependencies are
 * injected, so loading it must never require launching Electron. */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { verifyIdToken, createJwksCache } = require('../../shell/google-oidc.cjs')

const CLIENT_ID = '123456789012-contract.apps.googleusercontent.com'
const NOW = 1_760_000_000_000
const keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const publicJwk = keyPair.publicKey.export({ format: 'jwk' })
const signingKey = {
  kty: 'RSA',
  kid: 'contract-key',
  use: 'sig',
  alg: 'RS256',
  n: publicJwk.n,
  e: publicJwk.e,
}

function token(overrides = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: signingKey.kid })).toString('base64url')
  const claims = Buffer.from(JSON.stringify({
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: 'google-subject-123',
    email: ' Person@Example.com ',
    email_verified: true,
    name: 'Person Name',
    nonce: 'caller-nonce',
    iat: NOW / 1000 - 10,
    exp: NOW / 1000 + 600,
    ...overrides,
  })).toString('base64url')
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`, 'ascii'), keyPair.privateKey)
  return `${header}.${claims}.${signature.toString('base64url')}`
}

const jwks = {
  async find(kid) {
    return kid === signingKey.kid
      ? { ok: true, key: signingKey }
      : { ok: false, code: 'GOOGLE_TOKEN_KEY_UNKNOWN', reason: 'No matching Google key was available.' }
  },
}

function verify(value) {
  return verifyIdToken(value, {
    clientId: CLIENT_ID,
    nonce: 'caller-nonce',
    now: () => NOW,
    jwks,
  })
}

test('shell/google-oidc.cjs returns the complete verified identity consumed by the sign-in caller', async () => {
  const result = await verify(token())

  assert.equal(result.ok, true, `a valid Google token was refused: ${result.code}`)
  assert.deepEqual(result.identity, {
    provider: 'google',
    subject: 'google-subject-123',
    email: 'person@example.com',
    emailVerified: true,
    displayName: 'Person Name',
    assurance: 'id_token-verified',
  }, 'verified identity lost data or its downstream assurance stamp')
})

test('shell/google-oidc.cjs distinguishes the configured audience and explains refusal', async () => {
  const refused = await verify(token({ aud: 'another-application.apps.googleusercontent.com' }))
  assert.equal(refused.ok, false, 'a Google token for another application was accepted')
  assert.equal(refused.code, 'GOOGLE_TOKEN_AUDIENCE_REFUSED', 'wrong-audience refusal lost its machine-readable reason')
  assert.equal(typeof refused.reason, 'string', 'wrong-audience refusal lost its human-readable reason')
  assert.ok(refused.reason.length > 0, 'wrong-audience refusal carried an empty human-readable reason')

  const accepted = await verify(token({ aud: CLIENT_ID }))
  assert.equal(accepted.ok, true, `the configured audience was refused: ${accepted.code}`)
})

test('shell/google-oidc.cjs treats an unreadable key response as indeterminate, never as verified', async () => {
  const cache = createJwksCache({
    now: () => NOW,
    fetchImpl: async () => ({
      ok: true,
      async text() { throw new Error('connection ended while reading') },
    }),
  })

  const result = await cache.find(signingKey.kid)
  assert.deepEqual({ ok: result.ok, code: result.code }, {
    ok: false,
    code: 'GOOGLE_JWKS_REFUSED',
  }, 'an unreadable Google key response did not fail closed with a specific refusal')
  assert.equal(typeof result.reason, 'string', 'key-read refusal lost its human-readable reason')
  assert.ok(result.reason.length > 0, 'key-read refusal carried an empty human-readable reason')
})
