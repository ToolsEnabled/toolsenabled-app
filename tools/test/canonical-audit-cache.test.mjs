// A CALLER'S MISTAKE MUST NOT BECOME THE PROCESS'S PERMANENT STATE.
//
// Reproduced on a staged packaged build 2026-08-18 (legal-x4's driver,
// scenario C): a settings toggle was the first ledger-touching act after
// launch, its handler called the raw recordCanonical with no stateRoot, and
// shell/canonical-audit.cjs cached the resulting AUDIT_STATE_ROOT_INVALID for
// the life of the process. From that moment every correctly-addressed
// canonical write in the process -- settings records, account records, agent
// launch records, the unrestricted-tier consent record -- returned the same
// poisoned failure. The settings change was never recorded while the code
// around it says recording is enforced; the next agent start refused with
// MC_AGENT_RECORD_UNAVAILABLE for a reason nobody could see.
//
// The rule this file pins: AUDIT_STATE_ROOT_INVALID is a statement about the
// CALLER, not about this installation's ledger, so it is answered but never
// cached. Genuine load outcomes (a real open, a missing payload) stay cached
// exactly as before -- the cache exists so a copy with no payload does not pay
// module resolution on every keystroke, and this file proves it still works.
//
// Failing-first: the second assertion below FAILS at the pre-fix
// canonical-audit.cjs (the valid call returns the poisoned failure object) and
// passes after. The scratch state root is set to a fresh temp directory and
// the load happens through the real capability payload, exactly as the
// packaged shell does it -- no stubs on the cache path, because the cache path
// is the thing under test.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// Stage the smallest recognized writer and point the real resolver at it. The
// cache contract must not depend on a developer having run pack:capability:
// without this fixture, an unconfigured checkout returns PAYLOAD_ABSENT and
// never exercises the successful-load/cache branch these tests claim to pin.
const payloadFixture = mkdtempSync(path.join(tmpdir(), 'canonical-audit-payload-'))
mkdirSync(path.join(payloadFixture, 'src', 'lib'), { recursive: true })
writeFileSync(path.join(payloadFixture, 'src', 'lib', 'audit.js'), `
  exports.requireRecord = () => ({ sequence: 1, eventHash: 'fixture-hash' })
  exports.verify = () => ({ valid: true })
  exports.resetForTests = () => {}
`)

const capabilityPath = require.resolve('../../shell/capability-layer.cjs')
const canonicalPath = require.resolve('../../shell/canonical-audit.cjs')
const capability = require(capabilityPath)
const originalResolve = capability.resolveCapabilityRoot
capability.resolveCapabilityRoot = () => payloadFixture
delete require.cache[canonicalPath]
const audit = require(canonicalPath)
capability.resolveCapabilityRoot = originalResolve

test.after(() => {
  audit.closeCanonical()
  rmSync(payloadFixture, { recursive: true, force: true })
})

function scratchRoot() {
  return mkdtempSync(path.join(tmpdir(), 'canonical-audit-cache-'))
}

test('a missing state root is refused but NOT cached: the next correct caller succeeds', () => {
  audit.resetForTests()
  const bad = audit.canonicalAudit({})
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'AUDIT_STATE_ROOT_INVALID')

  const root = scratchRoot()
  try {
    const good = audit.canonicalAudit({ stateRoot: root })
    assert.notEqual(good, bad,
      'the caller error was cached: a correctly-addressed call received the poisoned failure object')
    assert.equal(good.ok, true,
      `the correct caller still failed after a bad first call: ${good.code} ${good.reason}`)
  } finally {
    audit.closeCanonical()
    audit.resetForTests()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a genuine load outcome IS still cached (one load per process, reused)', () => {
  audit.resetForTests()
  const root = scratchRoot()
  try {
    const first = audit.canonicalAudit({ stateRoot: root })
    const second = audit.canonicalAudit({ stateRoot: root })
    assert.equal(first.ok, true)
    assert.equal(second, first, 'the second call did not reuse the cached load')
  } finally {
    audit.closeCanonical()
    audit.resetForTests()
    rmSync(root, { recursive: true, force: true })
  }
})

test('repeated caller errors stay cheap and stay uncached', () => {
  audit.resetForTests()
  const a = audit.canonicalAudit({})
  const b = audit.canonicalAudit({ stateRoot: 'relative/not-absolute' })
  assert.equal(a.code, 'AUDIT_STATE_ROOT_INVALID')
  assert.equal(b.code, 'AUDIT_STATE_ROOT_INVALID')
  const root = scratchRoot()
  try {
    const good = audit.canonicalAudit({ stateRoot: root })
    assert.equal(good.ok, true,
      `two consecutive caller errors still poisoned the process: ${good.code ?? ''} ${good.reason ?? ''}`)
  } finally {
    audit.closeCanonical()
    audit.resetForTests()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a payload loader throwing no Error still returns a structured load failure', () => {
  const loaded = audit.loadCanonicalAudit({
    stateRoot: path.resolve('state'),
    root: path.resolve('capability'),
    load() { throw undefined },
    env: {},
  })

  assert.equal(loaded.ok, false)
  // WAS AUDIT_MODULE_ABSENT, changed 2026-08-27 with the reason stated rather
  // than the number quietly moved. This test's subject is that a loader throwing
  // a non-Error still yields a STRUCTURED failure with a readable reason instead
  // of crashing on error.message -- and that is unchanged and still asserted
  // below. What moved is the classification: `throw undefined` carries no code,
  // so nothing here says the writer is missing, and the module now answers the
  // could-not-tell code rather than making a definite claim it cannot support.
  // See canonical-audit-unreadable-is-not-absent.test.mjs for why: every throw
  // used to mean ABSENT, and that answer is cached for the life of the process.
  assert.equal(loaded.code, 'AUDIT_MODULE_UNREADABLE')
  assert.match(loaded.reason, /no reason given/)
})
