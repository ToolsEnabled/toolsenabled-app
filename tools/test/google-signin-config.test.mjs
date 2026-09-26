/* The main-process configuration resolver is tested without loading Electron.
 * Its vault readers are injected at the module's existing seam, so these tests
 * neither launch a window nor touch a real credential store. */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const {
  resolveGoogleSignInConfig,
  VAULT_CLIENT_ID_KEY,
  VAULT_CLIENT_SECRET_KEY,
} = require('../../shell/google-signin-config.cjs')

const CLIENT_ID = '123456789012-productsigninclient.apps.googleusercontent.com'
const FILE_ID = '223456789012-installationclient.apps.googleusercontent.com'
const SHIPPED_ID = '323456789012-shippedclient.apps.googleusercontent.com'
const SECRET = 'GOCSPX-test-secret'
const CAPABILITY_ROOT = '/fake/capability'
const scratch = mkdtempSync(path.join(tmpdir(), 'google-signin-config-'))

test.after(() => rmSync(scratch, { recursive: true, force: true }))

function vaultRead({ readable = true, records = {}, code = 'VAULT_READ_FAILED' } = {}) {
  return async keys => ({
    readable,
    code,
    store: '/fake/state/vault/secrets.json',
    values: readable
      ? new Map(keys.flatMap(key => records[key] ? [[key, records[key]]] : []))
      : null,
  })
}

function writeConfig(directory, clientId, clientSecret = SECRET) {
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, 'google-signin.json'), JSON.stringify({ clientId, clientSecret }))
}

test('a caller-provided environment client is returned with its paired secret, while malformed input is refused with a reason', async () => {
  const accepted = await resolveGoogleSignInConfig({
    env: {
      TOOLSENABLED_GOOGLE_CLIENT_ID: `  ${CLIENT_ID}  `,
      TOOLSENABLED_GOOGLE_CLIENT_SECRET: SECRET,
    },
  })
  assert.deepEqual(
    { ok: accepted.ok, source: accepted.source, clientId: accepted.clientId, clientSecret: accepted.clientSecret },
    { ok: true, source: 'environment', clientId: CLIENT_ID, clientSecret: SECRET },
  )

  const refused = await resolveGoogleSignInConfig({ env: { TOOLSENABLED_GOOGLE_CLIENT_ID: 'not-a-google-client' } })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'GOOGLE_SIGNIN_CLIENT_ID_INVALID')
  assert.equal(typeof refused.reason, 'string')
  assert.ok(refused.reason.length > 0, 'the refusal must carry a person-facing reason')
})

test('the protected vault outranks an installation file, but an unreadable vault does not veto that file', async () => {
  const userDataDir = path.join(scratch, 'precedence')
  writeConfig(userDataDir, FILE_ID)
  const common = { userDataDir, env: {}, capabilityRoot: CAPABILITY_ROOT, stateRoot: '/fake/state' }

  const fromVault = await resolveGoogleSignInConfig({
    ...common,
    readVaultValues: vaultRead({ records: { [VAULT_CLIENT_ID_KEY]: CLIENT_ID, [VAULT_CLIENT_SECRET_KEY]: SECRET } }),
  })
  assert.deepEqual(
    { ok: fromVault.ok, source: fromVault.source, clientId: fromVault.clientId },
    { ok: true, source: 'vault', clientId: CLIENT_ID },
  )

  const fromFile = await resolveGoogleSignInConfig({
    ...common,
    readVaultValues: vaultRead({ readable: false }),
  })
  assert.deepEqual(
    { ok: fromFile.ok, source: fromFile.source, clientId: fromFile.clientId },
    { ok: true, source: 'installation', clientId: FILE_ID },
  )
})

test('an unreadable vault remains unknown rather than becoming a definite not-configured answer', async () => {
  const common = {
    env: {},
    capabilityRoot: CAPABILITY_ROOT,
    stateRoot: '/fake/state',
    probeVaultRecord: async () => ({ readable: true, present: false }),
  }
  const unknown = await resolveGoogleSignInConfig({ ...common, readVaultValues: vaultRead({ readable: false }) })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.code, 'GOOGLE_SIGNIN_VAULT_UNREADABLE')
  assert.match(unknown.reason, /unknown/i, 'the refusal must explain that vault contents are unknown')

  const absent = await resolveGoogleSignInConfig({ ...common, readVaultValues: vaultRead({ records: {} }) })
  assert.equal(absent.ok, false)
  assert.equal(absent.code, 'GOOGLE_SIGNIN_NOT_CONFIGURED')
  assert.doesNotMatch(absent.reason, /could not read/i, 'a successfully read empty vault must not be called unreadable')
})

test('an invalid installation file stops resolution instead of silently allowing the shipped client', async () => {
  const userDataDir = path.join(scratch, 'invalid-installation')
  const appRoot = path.join(scratch, 'app')
  writeConfig(userDataDir, 'invalid-client')
  writeConfig(path.join(appRoot, 'config'), SHIPPED_ID)

  const refused = await resolveGoogleSignInConfig({ userDataDir, appRoot, env: {} })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'GOOGLE_SIGNIN_CLIENT_ID_INVALID')
  assert.ok(refused.reason.length > 0, 'the invalid installation setting must carry its refusal reason')

  rmSync(path.join(userDataDir, 'google-signin.json'))
  const accepted = await resolveGoogleSignInConfig({ userDataDir, appRoot, env: {} })
  assert.deepEqual(
    { ok: accepted.ok, source: accepted.source, clientId: accepted.clientId },
    { ok: true, source: 'shipped', clientId: SHIPPED_ID },
  )
})
