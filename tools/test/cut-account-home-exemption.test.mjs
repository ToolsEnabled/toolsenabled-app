// THE SECOND FENCE THE USERPROFILE/HOME EXEMPTION RESTS ON.
//
// tools/lib/scratch-fence.mjs holds USERPROFILE and HOME to the not-live rule
// only, and does NOT require them inside the cut scratch. The original reason
// given was "the product only reads them", drawn from three files. That was
// false: capability/src/lib/multi-account/registry-write.js resolves
// homeDir = process.env.USERPROFILE || process.env.HOME (:391, :493), creates an
// account home with mkdirSync (:452) and deletes a credential with unlinkSync
// (:309). So the pair IS written and deleted through.
//
// The exemption survives on a different basis: the delete at :309 does not take
// a raw path. :307 passes it through provider-session-isolation.js
// assertIsolatedCredential, which refuses a credential path outside the
// isolation context. This file tests THAT guard, because an exemption resting
// on a second fence is only as good as the second fence, and the mutation below
// is what stops it being taken on trust.
//
// Bound to the payload the cut packs (MC_TEST_CAPABILITY_PAYLOAD, which
// buildDistChainEnvironment sets), falling back to the engine checkout named by
// MC_CANONICAL_ROOT. In a cut both are set, so this is a real gate there.

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'

import { ACCOUNT_IDENTITY_NAMES } from '../lib/scratch-fence.mjs'

const require_ = createRequire(import.meta.url)
const ENGINE = process.env.MC_TEST_CAPABILITY_PAYLOAD || process.env.MC_CANONICAL_ROOT || process.env.TOOLSENABLED_SOURCE || ''
const GUARD = ENGINE ? path.join(ENGINE, 'src', 'lib', 'provider-session-isolation.js') : ''
const available = Boolean(GUARD) && existsSync(GUARD)

test('the exemption names exactly the pair it claims', () => {
  assert.deepEqual([...ACCOUNT_IDENTITY_NAMES], ['USERPROFILE', 'HOME'])
})

test('assertIsolatedCredential refuses a credential path outside the isolation context', (t) => {
  if (!available) {
    t.skip(`neither MC_TEST_CAPABILITY_PAYLOAD nor MC_CANONICAL_ROOT names a checkout carrying src/lib/provider-session-isolation.js, so the guard the USERPROFILE/HOME exemption rests on was NOT inspected. That is "could not look", not "the guard is sound". A cut sets both.`)
    return
  }
  const isolation = require_(GUARD)
  assert.equal(typeof isolation.assertIsolatedCredential, 'function',
    'the exemption rests on this export existing')

  // Built by the module's OWN constructor, from an environment object handed
  // in -- inventing the context shape from outside produced a TypeError, which
  // would have "passed" a throws() assertion that only checked that something
  // threw. The context root must be inside this account and not the account
  // root itself, so it is a scratch directory under the profile.
  assert.equal(typeof isolation.isolationContext, 'function', 'the guard needs its own context constructor')
  // The constructor lstats the root, so it must exist. A test may create a
  // directory; the FENCE may not, which is the whole point of that module.
  const privateRoot = path.join(os.homedir(), 'w86s', 'isolation-probe')
  mkdirSync(path.join(privateRoot, 'account-homes', 'claude', 'acct', '.claude'), { recursive: true })
  t.after(() => rmSync(privateRoot, { recursive: true, force: true }))
  // The constructor also requires the state root to live inside the isolated
  // session, so both are handed in together -- and from an OBJECT, never the
  // ambient environment.
  const context = isolation.isolationContext({
    TOOLSENABLED_PROVIDER_ISOLATION_ROOT: privateRoot,
    TOOLSENABLED_STATE_ROOT: path.join(privateRoot, 'state'),
  })
  assert.ok(context, 'a private runtime profile must yield a context')
  // A credential path outside the isolation context -- the owner's real home.
  const outside = path.join('C:', 'Users', 'Someone', '.claude', 'credentials.json')
  assert.throws(
    () => isolation.assertIsolatedCredential(outside, context),
    (error) => {
      assert.ok(/ISOLATION|isolated|private/i.test(`${error.code || ''} ${error.message}`),
        `the refusal must say the path was outside the isolation context; got: ${error.message}`)
      return true
    },
    'a credential outside the context must be refused, or the exemption has nothing behind it',
  )

  // And with no context at all the guard is a pass-through, which is why the
  // fence cannot rely on it alone for anything but this narrow case.
  assert.equal(isolation.assertIsolatedCredential(outside, null), outside,
    'no context means no second fence -- worth knowing, and why the not-live rule still applies')

  // And the path INSIDE the context is accepted, so the refusal above is the
  // guard discriminating and not refusing everything it is handed.
  const inside = path.join(privateRoot, 'account-homes', 'claude', 'acct', '.claude', 'credentials.json')
  assert.equal(isolation.assertIsolatedCredential(inside, context), path.resolve(inside),
    'a credential inside the isolation context must be allowed')
})
