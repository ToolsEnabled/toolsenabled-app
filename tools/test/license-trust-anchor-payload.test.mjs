// THE LICENCE TRUST ANCHOR, ON THE SHIPPING SIDE OF THE LINE.
//
// Licence verification is pinned to a vendor PUBLIC key and fails closed
// without one. That makes the anchor file a shipping question with two halves
// that must both hold, and which fail in opposite directions:
//
//   PUBLIC HALF MISSING  -> no customer can ever activate a paid licence. This
//                           is not hypothetical: config/license-trust.json did
//                           not exist anywhere in the source tree, so every
//                           verify threw LICENSE_TRUST_ANCHOR_MISSING and the
//                           paid product could not be sold at all, with every
//                           gate green, because nothing asserted the file into
//                           existence.
//   PRIVATE HALF SHIPPED -> every customer can mint their own licences, and the
//                           vendor identity is burned for good.
//
// A test that only checked one half would have passed in both of those states,
// so both are asserted here, against the STAGED BYTES rather than the source
// tree. Staged bytes are what a customer receives; the source tree is only what
// we intended to send.
//
// Run: node --test tools/test/license-trust-anchor-payload.test.mjs

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { assertNoSecretMaterial } from '../pack-capability-layer.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ANCHOR_RELATIVE = 'config/license-trust.json'
const MANIFEST = JSON.parse(readFileSync(path.join(REPO_ROOT, 'tools', 'capability-manifest.json'), 'utf8'))
const BOUNDARY = JSON.parse(readFileSync(path.join(REPO_ROOT, 'config', 'payload-boundary.json'), 'utf8'))

// Same two roots tools/check-payload-boundary.mjs walks: what the packer stages,
// and where electron-builder copied it. The first is CANONICAL -- it is the
// packer's own output and the thing tools/capability-manifest.json governs. The
// second is a copy made by a later build step and can be older than the source.
const STAGED_ROOT = path.join(REPO_ROOT, 'capability')
const PAYLOAD_ROOTS = ['capability', 'release/win-unpacked/resources/capability']
  .map((relative) => path.join(REPO_ROOT, relative))
  .filter((root) => existsSync(root))

/* Two roots can hold two different payloads. `npm run dist` restages before it
 * builds, so the ship path self-heals, but a build left on disk from last week
 * is still on disk. Reading its payload id lets this file tell "the anchor is
 * missing from what we ship" apart from "this directory is last week's build",
 * which are different defects with different fixes. Conflating them would make
 * the test either useless (skip the copy) or a liar (blame the manifest for a
 * stale artifact). */
function payloadId(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, 'PAYLOAD.json'), 'utf8')).payloadSha256 ?? null
  } catch {
    return null
  }
}

function walk(root) {
  const found = []
  const visit = (dir, relative) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name)
      const next = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) visit(absolute, next)
      else if (entry.isFile()) found.push({ relative: next, absolute })
    }
  }
  visit(root, '')
  return found
}

/* ---------- the rule, asserted where the rule lives ---------- */

test('the manifest stages the trust anchor, so a build cannot forget it', () => {
  assert.ok(
    MANIFEST.dataFiles.includes(ANCHOR_RELATIVE),
    `${ANCHOR_RELATIVE} is not in tools/capability-manifest.json dataFiles. Without it the ` +
      'payload ships no vendor public key, licence verification fails closed for every ' +
      'customer, and no paid licence can be activated.',
  )
})

test('the boundary classifies the anchor OPEN -- a public key is the half you hand out', () => {
  assert.ok(BOUNDARY.open.paths.includes(ANCHOR_RELATIVE),
    `${ANCHOR_RELATIVE} must be classified open; unclassified is a build failure by design`)
  for (const klass of ['paid', 'excluded']) {
    const paths = BOUNDARY[klass]?.paths ?? []
    assert.equal(paths.includes(ANCHOR_RELATIVE), false,
      `${ANCHOR_RELATIVE} is classified ${klass}; it is a PUBLIC key and withholding it only ` +
        'breaks verification for paying customers')
  }
})

/* ---------- the fence that keeps the private half out, exercised not read ----------
 *
 * A grep for the constant would pass on a fence nothing calls. These call the
 * real function with the real paths and require it to throw. */

test('the packer REFUSES to stage the vault, by prefix and by basename independently', () => {
  // The vault file the vendor private key actually lives in.
  assert.throws(() => assertNoSecretMaterial(['vault/secrets.json']),
    'the vault prefix must be refused')
  // Renamed out of vault/ -- the basename rule must still catch it.
  assert.throws(() => assertNoSecretMaterial(['config/secrets.json']),
    'the secrets.json basename must be refused outside the vault')
  // Exported as a key file under an innocent name -- the extension rule.
  assert.throws(() => assertNoSecretMaterial(['config/license-signing.pem']),
    'a .pem file must be refused')
  assert.throws(() => assertNoSecretMaterial(['config/license-signing.key']),
    'a .key file must be refused')
  // CONTROL: the fence is not simply refusing everything. If this throws, the
  // three assertions above prove nothing.
  assert.doesNotThrow(() => assertNoSecretMaterial([ANCHOR_RELATIVE, 'config/model-floor.json']))
})

/* ---------- the staged bytes ---------- */

test('the staged payload carries the PUBLIC key and no private key material', (t) => {
  if (!PAYLOAD_ROOTS.length) {
    // Deliberately a skip and not a pass: there is nothing to measure, and
    // saying "clean" about bytes that do not exist is the exact move this
    // file exists to stop.
    t.skip('no staged payload in this checkout (run tools/pack-capability-layer.mjs first)')
    return
  }
  const canonicalId = payloadId(STAGED_ROOT)
  for (const root of PAYLOAD_ROOTS) {
    const files = walk(root)
    assert.ok(files.length > 0, `${root} staged no files`)

    // THE ANCHOR-PRESENT HALF is asserted on the payload we actually stage, and
    // on any copy that IS that payload. A copy carrying a different payload id
    // is an old build; tools/check-payload-current.mjs is the guard that refuses
    // to ship one, and blaming the anchor for it here would point the next
    // reader at the wrong file. The private-key half below is asserted on every
    // root regardless, because a leaked key in an old build is still leaked.
    const current = root === STAGED_ROOT || (canonicalId !== null && payloadId(root) === canonicalId)
    if (!current) {
      t.diagnostic(`${root} holds a different payload than ${STAGED_ROOT} -- an earlier build. ` +
        'Anchor presence is asserted against the staged payload; this copy is checked for ' +
        'private key material only. tools/check-payload-current.mjs refuses a stale ship.')
    } else {
      const anchorFile = files.find((file) => file.relative === ANCHOR_RELATIVE)
      assert.ok(anchorFile, `${root} does not contain ${ANCHOR_RELATIVE}; a customer install ` +
        'built from these bytes cannot verify any licence')

      const anchor = JSON.parse(readFileSync(anchorFile.absolute, 'utf8'))
      let publicKey
      assert.doesNotThrow(() => {
        publicKey = createPublicKey(anchor.publicKeyPem)
      }, `${root} ${ANCHOR_RELATIVE} does not contain a usable public key`)
      assert.equal(publicKey.asymmetricKeyType, 'ed25519',
        `${root} ${ANCHOR_RELATIVE} must contain an Ed25519 public key`)
      // The anchor may declare a keyId; if it does it must be the id OF THIS KEY.
      if (typeof anchor.keyId === 'string' && anchor.keyId) {
        const digest = createHash('sha256')
          .update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
        assert.equal(anchor.keyId, `license-ed25519-${digest}`,
          'the staged anchor declares a keyId that is not its own key')
      }
      // A public key cannot be loaded as a private one. Proved, not asserted.
      assert.throws(() => createPrivateKey(anchor.publicKeyPem))
    }

    // NOW THE OTHER HALF, over every staged byte rather than over the anchor.
    // Any private key in any staged file is the same catastrophe wherever it is.
    const carriers = []
    for (const file of files) {
      if (statSync(file.absolute).size > 8 * 1024 * 1024) continue
      const text = readFileSync(file.absolute).toString('latin1')
      if (/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(text)) carriers.push(file.relative)
      if (/-----BEGIN OPENSSH PRIVATE KEY-----/.test(text)) carriers.push(file.relative)
    }
    assert.deepEqual(carriers, [],
      `${root} stages private key material in: ${carriers.join(', ')}`)

    // And the storage itself, by path, in case a future manifest entry sneaks
    // one past the packer's own fence.
    const storage = files
      .map((file) => file.relative)
      .filter((relative) => /^vault\//i.test(relative) || /(^|\/)secrets\.json$/i.test(relative))
    assert.deepEqual(storage, [], `${root} stages vault storage: ${storage.join(', ')}`)
  }
})
