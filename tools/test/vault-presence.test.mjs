import assert from 'node:assert/strict'
import fs, { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  ABSENT_EXIT,
  NO_STORE_EXIT,
  UNREADABLE_EXIT,
  vaultRecordPresence,
  vaultRecordValues,
} from '../../shell/vault-presence.cjs'

function fixture() {
  const capabilityRoot = mkdtempSync(path.join(tmpdir(), 'vault-presence-'))
  mkdirSync(path.join(capabilityRoot, 'tools'))
  writeFileSync(path.join(capabilityRoot, 'tools', 'secrets.ps1'), '# test seam only\n')
  return { capabilityRoot, stateRoot: path.join(capabilityRoot, 'state'), platform: 'win32' }
}

function exit(status) {
  return () => { throw Object.assign(new Error('fixed test failure'), { status }) }
}

test('presence keeps absent store, absent record, unreadable store, and probe failure distinct', async () => {
  const options = fixture()
  const present = await vaultRecordPresence('example_key', { ...options, run: () => '' })
  const absent = await vaultRecordPresence('example_key', { ...options, run: exit(ABSENT_EXIT) })
  const noStore = await vaultRecordPresence('example_key', { ...options, run: exit(NO_STORE_EXIT) })
  const unreadable = await vaultRecordPresence('example_key', { ...options, run: exit(UNREADABLE_EXIT) })
  const failed = await vaultRecordPresence('example_key', { ...options, run: exit(1) })

  assert.deepEqual(
    [present.code, absent.code, noStore.code, unreadable.code, failed.code],
    ['VAULT_RECORD_PRESENT', 'VAULT_RECORD_ABSENT', 'VAULT_STORE_ABSENT', 'VAULT_UNREADABLE', 'VAULT_PROBE_FAILED'],
  )
  assert.equal(unreadable.present, null)
  assert.equal(failed.present, null)
})

test('presence names a bounded timeout and unavailable tooling without carrying the child error', async () => {
  const options = fixture()
  const canary = 'must-not-cross-vault-boundary'
  const timeout = await vaultRecordPresence('example_key', {
    ...options,
    run: () => { throw Object.assign(new Error(canary), { code: 'ETIMEDOUT', stderr: canary }) },
  })
  const unavailable = await vaultRecordPresence('example_key', {
    ...options,
    run: () => { throw Object.assign(new Error(canary), { code: 'ENOENT', stderr: canary }) },
  })

  assert.equal(timeout.code, 'VAULT_TIMEOUT')
  assert.equal(unavailable.code, 'VAULT_TOOLING_UNAVAILABLE')
  assert.ok(!JSON.stringify(timeout).includes(canary))
  assert.ok(!JSON.stringify(unavailable).includes(canary))
})

test('a null options object returns an unknown result instead of throwing', async () => {
  const presence = await vaultRecordPresence('example_key', null)
  const values = await vaultRecordValues(['example_key'], null)

  assert.equal(presence.code, 'VAULT_TOOLING_ABSENT')
  assert.equal(presence.present, null)
  assert.equal(values.code, 'VAULT_TOOLING_ABSENT')
  assert.equal(values.readable, false)
  assert.equal(values.absent, null)
})

test('a busy tooling lookup is unknown, is not latched, and ENOENT remains definite absence', async () => {
  const options = fixture()
  const originalStatSync = fs.statSync
  let calls = 0
  try {
    fs.statSync = (...args) => {
      calls += 1
      if (calls === 1) throw Object.assign(new Error('machine busy'), { code: 'EBUSY' })
      return originalStatSync(...args)
    }

    const busy = await vaultRecordPresence('example_key', { ...options, run: () => '' })
    const retried = await vaultRecordPresence('example_key', { ...options, run: () => '' })
    assert.equal(busy.code, 'VAULT_TOOLING_CHECK_FAILED')
    assert.equal(busy.present, null)
    assert.equal(busy.readable, false)
    assert.match(busy.detail, /not claiming .* absent/i)
    assert.equal(retried.code, 'VAULT_RECORD_PRESENT')
    assert.equal(calls, 2, 'a could-not-check result must not be cached or latched')

    fs.statSync = () => { throw Object.assign(new Error('I/O unavailable'), { code: 'EIO' }) }
    const unreadableValues = await vaultRecordValues(['example_key'], options)
    assert.equal(unreadableValues.code, 'VAULT_TOOLING_CHECK_FAILED')
    assert.equal(unreadableValues.readable, false)
    assert.equal(unreadableValues.absent, null)

    fs.statSync = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }
    const absent = await vaultRecordPresence('example_key', options)
    assert.equal(absent.code, 'VAULT_TOOLING_ABSENT')
    assert.equal(absent.present, null)
  } finally {
    fs.statSync = originalStatSync
  }
})

function linuxFixture(t, reader) {
  const capabilityRoot = mkdtempSync(path.join(tmpdir(), 'linux-vault-shell-'))
  mkdirSync(path.join(capabilityRoot, 'src', 'lib'), { recursive: true })
  const modulePath = path.join(capabilityRoot, 'src', 'lib', 'vault-linux.js')
  writeFileSync(modulePath, '// The test injects the adapter; native backend acceptance is in the engine.\n')
  t.after(() => fs.rmSync(capabilityRoot, { recursive: true, force: true }))
  const stateRoot = path.join(capabilityRoot, 'state')
  return {
    platform: 'linux', capabilityRoot, stateRoot,
    run: () => assert.fail('Linux must not launch PowerShell'),
    loadLinuxVault(file) {
      assert.equal(file, modulePath)
      return {
        createReader(options) {
          assert.equal(options.stateRoot, stateRoot)
          assert.equal(options.environment.TOOLSENABLED_STATE_ROOT, stateRoot)
          assert.equal(Object.hasOwn(options.environment, 'TOOLSENABLED_VAULT_PATH'), false)
          assert.notEqual(options.environment, process.env)
          return reader
        },
      }
    },
  }
}

test('Linux presence awaits the installed engine reader and keeps all three observed states distinct', async t => {
  let selected = 'present'
  let settled = false
  const options = linuxFixture(t, {
    async presence(key) {
      assert.equal(key, 'example_key')
      await new Promise(resolve => setImmediate(resolve))
      settled = true
      return selected
    },
  })
  const pending = vaultRecordPresence('example_key', options)
  assert.equal(settled, false, 'shell reader must yield while native work is running')
  assert.equal((await pending).code, 'VAULT_RECORD_PRESENT')
  selected = 'absent'
  assert.equal((await vaultRecordPresence('example_key', options)).code, 'VAULT_RECORD_ABSENT')
  selected = 'no-store'
  assert.equal((await vaultRecordPresence('example_key', options)).code, 'VAULT_STORE_ABSENT')
  selected = 'maybe'
  const malformed = await vaultRecordPresence('example_key', options)
  assert.equal(malformed.present, null)
  assert.equal(malformed.code, 'SECRET_HELPER_PROTOCOL_INVALID')
})

test('Linux vault values share one async engine read and keep absent and unreadable separate', async t => {
  let selected = new Map([['first', ' value '], ['blank', '  ']])
  const options = linuxFixture(t, { async getMany() { return selected } })
  const result = await vaultRecordValues(['first', 'blank', 'missing'], options)
  assert.equal(result.readable, true)
  assert.deepEqual([...result.values], [['first', 'value']])
  assert.deepEqual(result.absent, ['blank', 'missing'])
  for (const malformed of [null, {}, new Map([['first', 12]]), new Map([['unexpected', 'private']])]) {
    selected = malformed
    const failed = await vaultRecordValues(['first'], options)
    assert.equal(failed.code, 'VAULT_RESPONSE_INVALID')
    assert.equal(failed.values, null)
    assert.equal(failed.absent, null)
  }
})

test('Linux backend failures remain unknown and never carry child diagnostics or values', async t => {
  const canary = 'private-vault-test-value-must-not-escape'
  let code = 'SECRET_BACKEND_LOCKED'
  const fail = async () => { throw Object.assign(new Error(canary), { code, stdout: canary, stderr: canary }) }
  const options = linuxFixture(t, { presence: fail, getMany: fail })
  for (const errorCode of ['SECRET_BACKEND_LOCKED', 'SECRET_BACKEND_UNSAFE', 'SECRET_ACCESS_DENIED', 'UNRECOGNIZED_PRIVATE_ERROR']) {
    code = errorCode
    const presence = await vaultRecordPresence('example_key', options)
    const values = await vaultRecordValues(['example_key'], options)
    assert.equal(presence.present, null)
    assert.equal(presence.readable, false)
    assert.equal(values.readable, false)
    assert.equal(values.absent, null)
    assert.equal(values.values, null)
    assert.ok(!JSON.stringify([presence, values]).includes(canary))
    assert.equal(values.code, errorCode === 'UNRECOGNIZED_PRIVATE_ERROR' ? 'VAULT_READ_FAILED' : errorCode)
  }
})

test('unsupported platforms and missing Linux state roots never invoke a fallback', async t => {
  let called = false
  const options = linuxFixture(t, { presence: async () => { called = true; return 'present' } })
  const unsupported = await vaultRecordPresence('example_key', { ...options, platform: 'darwin' })
  assert.equal(unsupported.code, 'VAULT_PLATFORM_UNSUPPORTED')
  const invalid = await vaultRecordPresence('example_key', { ...options, stateRoot: 'relative' })
  assert.equal(invalid.code, 'SECRET_VAULT_PATH_UNSAFE')
  assert.equal(called, false)
})

test('Linux refuses whitespace-ambiguous state roots before loading or consulting a vault', async t => {
  const options = linuxFixture(t, {})
  options.loadLinuxVault = () => assert.fail('an ambiguous state root must not reach the engine reader')
  options.stateRoot += ' '
  const presence = await vaultRecordPresence('example_key', options)
  const values = await vaultRecordValues(['example_key'], options)
  assert.equal(presence.code, 'SECRET_VAULT_PATH_UNSAFE')
  assert.equal(presence.present, null)
  assert.equal(values.code, 'SECRET_VAULT_PATH_UNSAFE')
  assert.equal(values.readable, false)
  assert.equal(values.absent, null)
})

/* THE OWNER'S ACCESS SWITCHES, ASSERTED AT THE SEAM THAT ENFORCES THEM.
 *
 * These call vaultRecordValues with values and read what comes back; none of
 * them pins a spelling. The `run` seam throws if it is ever reached, which is
 * how a refusal is proved to happen BEFORE the vault is opened rather than
 * after -- a gate that read the record and then dropped it would pass a test
 * that only checked the return code. */
function policyFixture() {
  const base = fixture()
  mkdirSync(path.join(base.stateRoot, 'state'), { recursive: true })
  return base
}

function writePolicyFile(stateRoot, records) {
  writeFileSync(
    path.join(stateRoot, 'state', 'vault-access-policy.json'),
    JSON.stringify({ version: 1, records }),
  )
}

const mustNotOpen = () => { throw new Error('the vault was opened for a refused read') }
const oneRecord = () => JSON.stringify({
  example_key: { found: true, value: 'value-must-not-be-asserted' },
  second_key: { found: true, value: 'value-must-not-be-asserted' },
})

test('a credential the owner turned off for a role is refused without opening the vault', async () => {
  const options = policyFixture()
  writePolicyFile(options.stateRoot, { example_key: { nickname: null, access: { builder: false } } })

  const denied = await vaultRecordValues(['example_key'], {
    ...options, principal: 'builder', run: mustNotOpen,
  })

  assert.equal(denied.readable, false)
  assert.equal(denied.code, 'VAULT_ACCESS_DENIED')
  assert.equal(denied.values, null)
})

test('a role the owner has not ruled on still reads, and the same record reads with no principal', async () => {
  const options = policyFixture()
  writePolicyFile(options.stateRoot, { example_key: { nickname: null, access: { builder: false } } })

  const otherRole = await vaultRecordValues(['example_key'], {
    ...options, principal: 'reviewer', run: oneRecord,
  })
  /* The installation reading its own credential to sign itself in names no
     principal and is not governed by a per-agent switch. */
  const installation = await vaultRecordValues(['example_key'], { ...options, run: oneRecord })

  assert.equal(otherRole.readable, true)
  assert.equal(installation.readable, true)
})

test('one denied key refuses the whole set rather than returning the rest', async () => {
  const options = policyFixture()
  writePolicyFile(options.stateRoot, { second_key: { nickname: null, access: { builder: false } } })

  const mixed = await vaultRecordValues(['example_key', 'second_key'], {
    ...options, principal: 'builder', run: mustNotOpen,
  })

  assert.equal(mixed.readable, false)
  assert.equal(mixed.code, 'VAULT_ACCESS_DENIED')
})

test('a policy that exists and cannot be parsed refuses the read instead of allowing it', async () => {
  const options = policyFixture()
  writeFileSync(path.join(options.stateRoot, 'state', 'vault-access-policy.json'), '{not-json')

  const refused = await vaultRecordValues(['example_key'], {
    ...options, principal: 'builder', run: mustNotOpen,
  })

  assert.equal(refused.readable, false)
  assert.equal(refused.code, 'VAULT_POLICY_UNREADABLE')
})

test('an absent policy is no rules and allows, which is what keeps an upgraded copy working', async () => {
  const options = policyFixture()

  const allowed = await vaultRecordValues(['example_key'], {
    ...options, principal: 'builder', run: oneRecord,
  })

  assert.equal(allowed.readable, true)
})

test('a refusal carries neither the credential value nor the store path it would have read', async () => {
  const options = policyFixture()
  writePolicyFile(options.stateRoot, { example_key: { nickname: 'my bank', access: { builder: false } } })

  const denied = await vaultRecordValues(['example_key'], {
    ...options, principal: 'builder', run: mustNotOpen,
  })

  const serialized = JSON.stringify(denied)
  assert.ok(!serialized.includes('value-must-not-be-asserted'))
  /* The nickname is the owner's private label. A refusal handed to whoever was
     denied must not republish it. */
  assert.ok(!serialized.includes('my bank'))
})
