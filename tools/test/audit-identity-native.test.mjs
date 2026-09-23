import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { canonicalRootForTests } from '../canonical-root.mjs'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'
const engineRoot = process.env.MC_SETTINGS_ENGINE_ROOT
  ? path.resolve(process.env.MC_SETTINGS_ENGINE_ROOT)
  : ownedFixtureTempRoot({ selected: canonicalRootForTests() })
const engine = createRequire(path.join(engineRoot, 'package.json'))
const root = fs.mkdtempSync(path.join(process.platform === 'win32' ? path.dirname(engineRoot) : os.tmpdir(), '.audit-native-test-'))
engine('./tests/lib/isolated-environment.js').configure(root)
const stateRoot = process.env.TOOLSENABLED_STATE_ROOT
for (const [id, relative] of Object.entries({ TOOLSENABLED_AUDIT_DB: 'state/audit.sqlite3', TOOLSENABLED_AUDIT_JSONL_PATH: 'logs/actions.jsonl', TOOLSENABLED_AUDIT_TEXT_PATH: 'logs/actions.log', TOOLSENABLED_AUDIT_EMERGENCY_PATH: 'logs/audit-emergency.jsonl', TOOLSENABLED_VAULT_PATH: 'vault/secrets.json' })) process.env[id] = path.join(stateRoot, relative)
fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
const runtime = engine('./src/lib/runtime.js')
const audit = engine('./src/lib/audit.js')
const identity = engine('./src/lib/audit-identity-maintenance.js')
const shell = createRequire(import.meta.url)('../../shell/product-settings.cjs')
let custodyAvailable = false
test.after(async () => { await audit.close(); fs.rmSync(root, { recursive: true, force: true }) })

test('native vault either safely reports unavailable custody or rotates an isolated real identity', async t => {
  try { runtime.setSecret('audit_maintenance_disposable_fixture', 'benign disposable test record') }
  catch (error) {
    // Windows DPAPI is a required qualified branch. Linux needs the supported
    // unlocked persistent GNOME keyring; a headless runner may lack it.
    // Say what is missing when Windows cannot set the fixture secret: the
    // 1.0.45 cut of 2026-09-16 (ledger T146) reported this branch as
    // "'win32' !== 'linux'", which names the platform and hides the cause.
    if (process.platform !== 'linux') {
      assert.fail(`${process.platform}: native custody is required here, and setting the disposable fixture secret failed with ${error.code || 'no code'}: ${error.message}`)
    }
    assert.match(error.code || '', /^SECRET_(BACKEND_|HELPER_)/)
    const refused = identity.probe({ stateRoot })
    assert.equal(refused.canRotate, false)
    assert.equal(refused.code, 'AUDIT_REKEY_CUSTODY_UNAVAILABLE')
    t.diagnostic(`Linux native rotation unavailable: ${error.code}; custody refusal verified, healthy branch not executed.`)
    return
  }
  custodyAvailable = true
  const seed = audit.requireRecord('settings.native.fixture', 'disposable', { purpose: 'No real payment or service credential.' })
  assert.equal(seed.durable, true)
  await audit.close()
  const beforeVault = JSON.parse(fs.readFileSync(runtime.vaultFilePath(), 'utf8'))
  const before = identity.probe({ stateRoot })
  assert.equal(before.canRotate, true, before.reason)
  const result = identity.rotate({ stateRoot, fingerprint: before.fingerprint })
  assert.equal(result.status, 'rotated')
  assert.equal(identity.probe({ stateRoot }).canRotate, true)
  assert.equal(runtime.getSecret('audit_maintenance_disposable_fixture'), 'benign disposable test record')
  if (process.platform === 'win32') {
    const afterVault = JSON.parse(fs.readFileSync(runtime.vaultFilePath(), 'utf8'))
    assert.equal(afterVault.audit_maintenance_disposable_fixture, beforeVault.audit_maintenance_disposable_fixture)
  }
  assert.equal(fs.existsSync(path.join(result.archivePath, 'unsigned-break.json')), true)
  t.diagnostic(`${process.platform}: real native vault rotation and unrelated-record preservation verified.`)
})

test('saved credential interval changes real presence probes and content changes invalidate even with restored mtime', async t => {
  if (!custodyAvailable) { t.skip('The prior native custody check was unavailable; helper timing was not qualified.'); return }
  const presence = engine('./src/lib/vault-presence.js')
  const performance = engine('./src/lib/tool-performance-settings.js')
  const setInterval = value => {
    const saved = shell.setProductSetting({ id: 'tools.credential_check_interval_seconds', value }, { root: engineRoot, fresh: true })
    assert.equal(saved.ok, true, saved.reason)
    performance.performanceSettings({ fresh: true })
  }
  setInterval(1)
  presence.resetVaultPresenceCache()
  const key = 'audit_maintenance_disposable_fixture'
  assert.equal(presence.vaultRecordPresence(key).present, true)
  assert.equal(presence.vaultRecordPresence(key).present, true)
  if (process.platform === 'linux') {
    assert.deepEqual(presence.vaultPresenceMeasurements(), { probes: 2, cacheHits: 0, expired: 0, invalidations: 0 })
    t.diagnostic('Linux uses the native custody reader each time; the Windows presence-cache control is inapplicable.')
    return
  }
  assert.deepEqual(presence.vaultPresenceMeasurements(), { probes: 1, cacheHits: 1, expired: 0, invalidations: 0 })
  const realNow = Date.now
  const later = realNow() + 1001
  try {
    Date.now = () => later
    assert.equal(presence.vaultRecordPresence(key).present, true)
  } finally { Date.now = realNow }
  assert.equal(presence.vaultPresenceMeasurements().probes, 2)
  assert.equal(presence.vaultPresenceMeasurements().expired, 1)
  setInterval(0)
  presence.resetVaultPresenceCache()
  const absentKey = 'audit_presence_disposable_new'
  assert.equal(presence.vaultRecordPresence(absentKey).present, false)
  const file = runtime.vaultFilePath()
  const originalStat = fs.statSync(file)
  runtime.setSecret(absentKey, 'benign presence fixture')
  await audit.close()
  fs.utimesSync(file, originalStat.atime, originalStat.mtime)
  assert.equal(presence.vaultRecordPresence(absentKey).present, true)
  assert.deepEqual(presence.vaultPresenceMeasurements(), { probes: 2, cacheHits: 0, expired: 0, invalidations: 1 })
  t.diagnostic('Windows actual PowerShell probes verified: cache hit, saved expiry, and changed vault bytes despite restored mtime.')
})

test('unreadable or malformed native custody refuses rotation without rewriting unrelated records', async t => {
  if (!custodyAvailable) { t.skip('The prior native custody check was unavailable; tamper preservation was not qualified.'); return }
  await audit.close()
  const file = runtime.vaultFilePath()
  const original = fs.readFileSync(file)
  const malformed = process.platform === 'win32'
    ? [JSON.stringify({ ...JSON.parse(original), audit_maintenance_disposable_fixture: { invalid: 'fixture' } }),
      JSON.stringify({ ...JSON.parse(original), [audit.SIGNING_VAULT_KEY]: 'invalid-ciphertext-fixture' })]
    : ['{"malformed_disposable_vault":true}']
  try {
    for (const bytes of malformed) {
      fs.writeFileSync(file, bytes)
      runtime.invalidateSecretValueCache()
      const result = identity.probe({ stateRoot })
      assert.equal(result.canRotate, false)
      if (process.platform === 'win32' && JSON.parse(bytes)[audit.SIGNING_VAULT_KEY] === 'invalid-ciphertext-fixture') {
        assert.equal(result.canRepair, true)
        assert.equal(result.repairReason, 'unreadable-key')
      } else {
        assert.equal(result.canRepair, false)
        assert.equal(result.code, 'AUDIT_REKEY_CUSTODY_UNAVAILABLE')
      }
      if (process.platform === 'win32' && typeof JSON.parse(bytes).audit_maintenance_disposable_fixture !== 'string') {
        assert.throws(() => runtime.setSecretPair('audit_disposable_pair_a', 'benign a', 'audit_disposable_pair_b', 'benign b'))
      }
      assert.equal(fs.readFileSync(file, 'utf8'), bytes)
    }
  } finally {
    fs.writeFileSync(file, original)
    runtime.invalidateSecretValueCache()
    await audit.close()
  }
  assert.equal(identity.probe({ stateRoot }).canRotate, true)
})
