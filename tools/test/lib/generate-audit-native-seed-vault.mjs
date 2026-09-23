/* Regenerates tools/test/fixtures/audit-native-seed-vault.json.
 *
 * audit-repair-native.test.mjs spawns one grandchild process per scenario,
 * and each grandchild used to bootstrap its own audit signing key from
 * nothing via runtime's getOrCreateSecret -- a live powershell.exe/DPAPI
 * round trip for a container that does not exist yet. That cold-bootstrap
 * spawn is the one that goes missing under load; adding a key to a vault
 * that already has one does not. So the fixture holds one real, validly
 * DPAPI-protected SIGNING_VAULT_KEY entry (bytes only decrypt for the
 * OS account that made them, so this must be regenerated -- run this file
 * directly -- if the fixture ever stops decrypting for the account CI runs
 * as), and nothing else: no anchor, no audit history, no owner secrets.
 * audit-repair-fixture.cjs copies it into a fresh scratch root's
 * vault/secrets.json before the real requireRecord() call, so that call's
 * own key read succeeds immediately and the anchor is established by the
 * ordinary first-write path every real install already goes through.
 *
 * Run with: node tools/test/lib/generate-audit-native-seed-vault.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const engineRoot = path.resolve(process.env.MC_SETTINGS_ENGINE_ROOT || process.env.MC_CANONICAL_ROOT || path.join(here, '../../../capability'))
const engine = createRequire(path.join(engineRoot, 'package.json'))

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'te-audit-seed-vault-gen-'))
const stateRoot = path.join(scratch, 'profile', 'capability')
fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
process.env.TOOLSENABLED_TEST_ISOLATED = '1'
process.env.LOCALAPPDATA = path.join(scratch, 'local-app-data')
process.env.TOOLSENABLED_STATE_ROOT = stateRoot
process.env.TOOLSENABLED_VAULT_PATH = path.join(stateRoot, 'vault', 'secrets.json')

try {
  const runtime = engine('./src/lib/runtime.js')
  const audit = engine('./src/lib/audit.js')
  const generated = crypto.generateKeyPairSync('ed25519')
  const candidate = generated.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  runtime.getOrCreateSecret(audit.SIGNING_VAULT_KEY, candidate)
  const stored = JSON.parse(fs.readFileSync(runtime.vaultFilePath(), 'utf8').replace(/^﻿/, ''))
  const ciphertext = stored[audit.SIGNING_VAULT_KEY]
  if (typeof ciphertext !== 'string' || !ciphertext) throw new Error('The generated vault did not contain the expected signing key entry.')
  // Prove it round-trips through the real backend before trusting it as a fixture.
  // The PowerShell pipeline is free to re-encode line endings, so a structural
  // check (does it still parse as the same Ed25519 key) is what matters, not
  // byte-for-byte string equality.
  runtime.invalidateSecretValueCache()
  const readBack = runtime.getSecret(audit.SIGNING_VAULT_KEY)
  const originalKeyId = audit.signerFromPrivateKey(candidate).keyId
  const readBackKeyId = audit.signerFromPrivateKey(readBack).keyId
  if (readBackKeyId !== originalKeyId) throw new Error('The generated signing key did not read back as the same Ed25519 identity.')
  const fixture = { [audit.SIGNING_VAULT_KEY]: ciphertext }
  const fixturePath = path.join(here, '../fixtures/audit-native-seed-vault.json')
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true })
  fs.writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`)
  console.log(`Wrote ${fixturePath}`)
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}
