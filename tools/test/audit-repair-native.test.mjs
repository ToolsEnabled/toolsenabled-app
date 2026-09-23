import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const require = createRequire(import.meta.url)
const helper = require('./audit-repair-fixture.cjs')
const engineRoot = path.resolve(process.env.MC_SETTINGS_ENGINE_ROOT || process.env.MC_CANONICAL_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '../../capability'))
const cases = [...helper.MODES, 'crash-prepared', 'crash-archived', 'crash-installed', 'crash-vault-committed', 'whole-vault-refusal', 'changed-audit-pair', 'unrelated-update']
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
function temporaryRoot() {
  if (process.platform !== 'win32') return os.tmpdir()
  const explicit = process.env.MC_SETTINGS_NATIVE_SCRATCH_ROOT
  if (!explicit || !path.isAbsolute(explicit)) throw new Error('Native Windows qualification requires an explicit approved MC_SETTINGS_NATIVE_SCRATCH_ROOT.')
  const root = path.resolve(explicit)
  for (let current = root; ; current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Native qualification scratch ancestors must not contain links.')
    if (path.dirname(current) === current) break
  }
  if (fs.realpathSync.native(root).toLowerCase() !== root.toLowerCase()) throw new Error('Native qualification scratch root must use its canonical path.')
  return root
}

if (process.env.MC_AUDIT_REPAIR_CHILD === '1') {
  const scenario = process.argv[2]
  const scratchRoot = process.argv[3]
  const stateRoot = path.join(scratchRoot, 'profile', 'capability')
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
  const context = helper.prepare({ stateRoot, scratchRoot, engineRoot })
  try {
    const seed = await helper.seed(context, helper.MODES.includes(scenario) ? scenario : 'missing-key')
    assert.equal(seed.ok, true, JSON.stringify(seed.probe))
    const before = helper.unrelated(context)
    const options = { stateRoot, quiesced: true, fingerprint: seed.probe.fingerprint }
    if (scenario === 'whole-vault-refusal') {
      const file = context.runtime.vaultFilePath()
      const original = fs.readFileSync(file)
      const { container, records } = helper.vaultRecords(context)
      records[helper.FIXTURE_KEY] = { malformed: 'unrelated disposable record' }
      const variants = ['{', JSON.stringify(container)]
      try {
        for (const bytes of variants) {
          fs.writeFileSync(file, bytes)
          context.runtime.invalidateSecretValueCache()
          const refusal = context.maintenance.probe({ stateRoot })
          assert.equal(refusal.canRepair, false)
          assert.equal(refusal.canRotate, false)
          assert.throws(() => context.maintenance.repair(options))
          assert.equal(fs.readFileSync(file, 'utf8'), bytes)
        }
      } finally { fs.writeFileSync(file, original); context.runtime.invalidateSecretValueCache() }
      process.stdout.write(JSON.stringify({ scenario, ok: true, wholeVaultRefused: true, unrelatedCiphertextPreserved: true }) + '\n')
    } else if (scenario === 'changed-audit-pair') {
      assert.throws(() => context.maintenance.repair({ ...options, fault(phase) {
        if (phase === 'installed') context.runtime.setSecret(context.audit.HEAD_VAULT_KEY, 'concurrent disposable head mutation')
      } }), { code: 'AUDIT_REKEY_RECOVERY_REQUIRED' })
      assert.equal(context.maintenance.probe({ stateRoot }).canRecover, false)
      assert.equal(context.runtime.getSecret(context.audit.HEAD_VAULT_KEY), 'concurrent disposable head mutation')
      assert.deepEqual(helper.unrelated(context), before)
      process.stdout.write(JSON.stringify({ scenario, ok: true, conflictingPairRefused: true, journalPreserved: true, unrelatedCiphertextPreserved: true }) + '\n')
    } else {
      let result
      if (scenario.startsWith('crash-')) {
        const point = scenario.slice(6)
        assert.throws(() => context.maintenance.repair({ ...options, fault(phase) {
          if (phase === point) throw Object.assign(new Error('simulated native process stop'), { code: 'SIMULATED_PROCESS_STOP' })
        } }), { code: 'SIMULATED_PROCESS_STOP' })
        assert.equal(context.maintenance.probe({ stateRoot }).canRecover, true)
        result = context.maintenance.recover({ stateRoot, quiesced: true })
        assert.equal(result.status, point === 'vault-committed' ? 'repaired' : 'rolled-back')
        assert.deepEqual(helper.unrelated(context), before)
        if (result.status === 'rolled-back') {
          const again = context.maintenance.probe({ stateRoot })
          assert.equal(again.canRepair, true)
          result = context.maintenance.repair({ stateRoot, quiesced: true, fingerprint: again.fingerprint })
        }
      } else {
        result = context.maintenance.repair({ ...options, fault: scenario === 'unrelated-update' ? phase => {
          if (phase === 'installed') {
            context.runtime.setSecret(helper.FIXTURE_KEY, 'concurrent benign unrelated update')
            before[helper.FIXTURE_KEY] = helper.unrelated(context)[helper.FIXTURE_KEY]
          }
        } : undefined })
      }
      assert.equal(result.status, 'repaired')
      assert.deepEqual(helper.unrelated(context), before)
      const manifest = JSON.parse(fs.readFileSync(path.join(result.archivePath, 'manifest.json'), 'utf8'))
      assert.equal(manifest.priorHistoryVerified, false)
      for (const row of manifest.files) assert.equal(digest(fs.readFileSync(path.join(result.archivePath, 'history', row.relative))), row.sha256)
      for (const row of manifest.unverifiedInputFiles) assert.equal(digest(fs.readFileSync(path.join(result.archivePath, 'unverified-input', row.relative))), row.sha256)
      if (scenario === 'malformed-wal') {
        const expected = JSON.parse(fs.readFileSync(context.metadata, 'utf8')).unverifiedWal
        assert.equal(digest(fs.readFileSync(path.join(result.archivePath, 'unverified-input', expected.relative))), expected.sha256)
      }
      assert.equal(JSON.parse(fs.readFileSync(path.join(result.archivePath, 'unsigned-break.json'))).signed, false)
      const next = context.audit.requireRecord('settings.set', 'audit.repair.native.followup', { value: true, purpose: 'Benign durable append after repair.' })
      assert.equal(next.durable, true); assert.equal(next.anchored, true)
      await context.audit.close()
      const probe = context.maintenance.probe({ stateRoot })
      assert.equal(probe.canRotate, true, probe.reason)
      assert.equal(probe.headSequence, 2)
      assert.deepEqual(helper.unrelated(context), before)
      process.stdout.write(JSON.stringify({ scenario, ok: true, status: result.status, unrelatedCiphertextPreserved: true,
        archiveFilesVerified: manifest.files.length, newChainHeadSequence: probe.headSequence,
        interruptedRecovery: scenario.startsWith('crash-'), subsequentWriteAnchored: true }) + '\n')
    }
  } finally { await context.audit.close() }
} else {
  test('native custody receipt records path metadata without reading records or following links', t => {
    const scratch = fs.mkdtempSync(path.join(temporaryRoot(), 'te-audit-custody-receipt-'))
    t.after(() => fs.rmSync(scratch, { recursive: true, force: true }))
    const vault = path.join(scratch, 'profile/capability/vault')
    fs.mkdirSync(vault, { recursive: true, mode: 0o700 })
    const file = path.join(vault, 'secrets.json')
    const marker = 'DISPOSABLE_CUSTODY_CONTENT_MUST_NOT_BE_REPORTED'
    fs.writeFileSync(file, marker, { mode: 0o600 })
    const rows = helper.custodyMetadata(scratch)
    assert.equal(rows.find(row => row.path === file).type, 'file')
    assert.equal(rows.find(row => row.path === `${file}.lock`).code, 'ENOENT')
    assert.equal(JSON.stringify(rows).includes(marker), false)
    if (process.platform === 'linux') {
      assert.equal(rows.find(row => row.path === file).mode, '600')
      fs.rmSync(vault, { recursive: true })
      fs.symlinkSync(scratch, vault, 'dir')
      const linked = helper.custodyMetadata(scratch)
      assert.equal(linked.find(row => row.path === vault).type, 'link')
      assert.equal(linked.some(row => row.path.startsWith(`${vault}${path.sep}`)), false)
    }
  })
  for (const scenario of cases) test(`native ${process.platform} custody: ${scenario}`, { timeout: 300000 }, t => {
    /* T312: THE COLD CUSTODY BOOTSTRAP IS TIMING-SENSITIVE UNDER LOAD, AND
       RETRYING IT IS SAFE ONLY BECAUSE EACH ATTEMPT IS A FRESH VAULT.
       keyMaterial()'s first read and audit.requireRecord()'s anchor write
       both try src/lib/vault-host/worker.js's persistent host before its
       own per-call fallback, and that host's cold spawn (READY_TIMEOUT_MS)
       and each request's round trip (REQUEST_TIMEOUT_MS/ATOMICS_TIMEOUT_MS,
       32-34s) are ordinary wall-clock waits on a real powershell.exe -- not
       a bug, but genuinely slower under heavy CPU contention from other work
       on a shared machine. A write left uncertain after that wait is
       DELIBERATELY refused rather than silently retried in place
       (vault-host-client.js: "a lost reply after dispatch ... refuses
       without replaying the operation"), so the product is correct to fail
       loudly there. Retrying the WHOLE scenario is still safe because
       `scratch` is minted fresh below every attempt: there is no vault, no
       sequence number and no in-flight write left over from the failed one
       for a retry to collide with. A non-transient failure -- a real
       assertion mismatch, a genuine defect -- does not match this signature
       and is reported on the first attempt, exactly as before.

       T329: THE SIGNATURE IS THE TWO SHAPES THAT ARE GENUINELY TIMING, AND
       NOTHING WIDER. The first version of this recognizer also listed the
       engine's two generic wrapper sentences ("could not be read from the
       local vault." and "Unable to advance monotonic secret"), and Worker
       98 measured what that costs: with a genuine anchor regression
       injected into the engine's writeAnchor so it fired on attempt 1 only,
       the retried suite went GREEN, because those sentences wrap EVERY
       failure reason -- a sequence that moved backward looks identical to a
       lock that timed out. The engine now relays the host's own reason and
       code behind those prefixes (engine T329, relayHostedVaultFailure), so
       the retry can key on the reason instead of the wrapper. Two shapes:
       the exclusive-access timeout sentence tools/secrets.ps1 emits, and
       the vault-host client's SECRET_VAULT_HOST_UNCERTAIN code (a lost
       reply deliberately not repeated). Any other custody failure, however
       intermittent, is reported on the attempt it happened. The diagnostic
       below names which of them matched. */
    const TRANSIENT_CUSTODY_SIGNALS = [
      { name: 'exclusive-access timeout', pattern: /Timed out waiting for exclusive access to the secret vault/ },
      { name: 'SECRET_VAULT_HOST_UNCERTAIN', pattern: /SECRET_VAULT_HOST_UNCERTAIN/ },
      // Linux never reaches the vault host (runtime.js returns through
      // vault-linux first); its one timing shape is the kernel-lock deadline,
      // thrown as failure('SECRET_VAULT_LOCK_TIMEOUT') with that code. The
      // rollback refusal there is SECRET_MONOTONIC_CONFLICT and is NOT listed.
      { name: 'SECRET_VAULT_LOCK_TIMEOUT', pattern: /SECRET_VAULT_LOCK_TIMEOUT/ },
    ]
    const ATTEMPTS = 3
    let lastRun = null
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      const temporaryBase = temporaryRoot()
      const scratch = fs.mkdtempSync(path.join(temporaryBase, 'te-audit-repair-native-'))
      try {
        /* T310: the custody backend is OS-account-scoped, not directory-scoped
           -- readable or not depends on WHETHER TOOLSENABLED_VAULT_PATH/
           TOOLSENABLED_STATE_ROOT are set, not which value they hold. Spreading
           the parent's full env onto this child let a stray inherited value
           (a real profile's, or a differently-shaped scratch from a suite that
           ran earlier in the same process tree) reach a child whose own
           stateRoot above already names the one vault this scenario owns.
           Both must be absent here so the child's own stateRoot -- passed
           explicitly to helper.prepare(), never read from the environment --
           is the only thing that decides where its vault lives. */
        const { TOOLSENABLED_STATE_ROOT: _unusedParentStateRoot, TOOLSENABLED_VAULT_PATH: _unusedParentVaultPath, ...inherited } = process.env
        const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), scenario, scratch], {
          env: { ...inherited, MC_AUDIT_REPAIR_CHILD: '1', MC_SETTINGS_ENGINE_ROOT: engineRoot },
          encoding: 'utf8', timeout: 295000, maxBuffer: 1024 * 1024, windowsHide: true
        })
        lastRun = run
        const failed = Boolean(run.error) || run.status !== 0
        const output = `${run.stdout}\n${run.stderr}`
        const signal = failed ? TRANSIENT_CUSTODY_SIGNALS.find(candidate => candidate.pattern.test(output)) : undefined
        const transient = Boolean(signal)
        if (failed) t.diagnostic(JSON.stringify({ scenario, attempt, transient, signal: signal?.name ?? null, custody: helper.custodyMetadata(scratch) }))
        if (transient && attempt < ATTEMPTS) {
          t.diagnostic(`attempt ${attempt}/${ATTEMPTS} hit the load-timing custody signal "${signal.name}", retrying with a fresh vault: ${output}`)
          continue
        }
        assert.equal(run.error, undefined, run.error?.code)
        assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
        const report = JSON.parse(run.stdout.trim())
        assert.equal(report.ok, true)
        t.diagnostic(JSON.stringify(report))
        return
      } finally { fs.rmSync(scratch, { recursive: true, force: true }) }
    }
    // Unreachable except by the ATTEMPTS loop exhausting itself without an
    // early return, which only happens if the final attempt's own asserts
    // above did not throw -- kept as a named backstop rather than silence.
    assert.fail(`exhausted ${ATTEMPTS} attempts without a resolved outcome: ${lastRun?.stdout}\n${lastRun?.stderr}`)
  })
}
