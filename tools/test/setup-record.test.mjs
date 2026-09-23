import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const setupRecord = require_(path.join(REPO, 'shell', 'setup-record.cjs'))

function modules(overrides = {}) {
  const writes = []
  const existing = overrides.existing ?? null
  const machineRecord = {
    TIERS: ['guided', 'standard'],
    resolveServicesRoot: () => '/services',
    readMachineRecord: () => existing,
    buildMachineRecord: input => ({
      tier: input.tier,
      installRoot: input.installRoot,
      servicesRoot: input.servicesRoot,
      nodePath: input.nodePath,
      workspaceRoots: input.workspaceRoots,
      machine: { id: input.machineId, label: input.machineLabel },
      createdAtMs: input.createdAtMs,
    }),
    resolveNodePath: ({ execPath }) => execPath,
    defaultMachineId: () => 'new-id',
    defaultMachineLabel: () => 'new-label',
    writeMachineRecord: record => writes.push(record),
    writeMcpConfig: () => ({ document: { mcpServers: {} } }),
    ...overrides.machineRecord,
  }
  return {
    ok: true,
    root: '/capability',
    machineRecord,
    workspace: {
      defaultWorkspacePath: () => '/suggested',
      checkWorkspaceCandidate: () => ({ ok: true }),
      provisionWorkspace: () => ({ ok: true }),
    },
    writes,
  }
}

test('loadSetupModules distinguishes an absent payload from a usable payload', () => {
  const absent = setupRecord.loadSetupModules({ root: '' })
  assert.deepEqual(
    { ok: absent.ok, code: absent.code, hasReason: typeof absent.reason === 'string' && absent.reason.length > 0 },
    { ok: false, code: 'SETUP_PAYLOAD_ABSENT', hasReason: true },
    'an unavailable setup payload must be a typed refusal with an explanation',
  )

  const loaded = setupRecord.loadSetupModules({
    root: '/payload',
    load: filename => filename.endsWith('machine-record.js') ? modules().machineRecord : modules().workspace,
  })
  assert.equal(loaded.ok, true, 'a complete payload should be available')
  assert.equal(loaded.root, '/payload', 'the accepted payload root must travel with its modules')
})

test('readTierState keeps not-configured, configured, and could-not-read distinct', () => {
  const empty = setupRecord.readTierState({ modules: modules() })
  assert.deepEqual(
    { available: empty.available, configured: empty.configured, tier: empty.tier, tiers: empty.tiers },
    { available: true, configured: false, tier: null, tiers: ['guided', 'standard'] },
  )

  const configured = setupRecord.readTierState({ modules: modules({ existing: { tier: 'standard' } }) })
  assert.deepEqual(
    { available: configured.available, configured: configured.configured, tier: configured.tier },
    { available: true, configured: true, tier: 'standard' },
    'a caller must receive the permission level already recorded',
  )

  const unreadableModules = modules({
    machineRecord: { readMachineRecord: () => { throw Object.assign(new Error('integrity check failed'), { code: 'BAD_SEAL' }) } },
  })
  const unreadable = setupRecord.readTierState({ modules: unreadableModules })
  assert.deepEqual(
    { configured: unreadable.configured, unreadable: unreadable.unreadable, code: unreadable.code, reason: unreadable.reason },
    { configured: false, unreadable: true, code: 'BAD_SEAL', reason: 'integrity check failed' },
    'a record that could not be read must not collapse into the definite never-configured answer',
  )
})

test('recordTier refuses an unknown level with a reason and performs no write', () => {
  const injected = modules()
  const result = setupRecord.recordTier('unrestricted', { modules: injected, documentsDir: null })
  assert.deepEqual(
    { ok: result.ok, code: result.code, hasReason: typeof result.reason === 'string' && result.reason.length > 0 },
    { ok: false, code: 'SETUP_TIER_UNKNOWN', hasReason: true },
  )
  assert.equal(injected.writes.length, 0, 'a refused permission level must not reach the record writer')
})

test('recordTier changes only the tier of a caller\'s existing record', () => {
  const existing = {
    tier: 'guided',
    installRoot: '/original-install',
    servicesRoot: '/services',
    nodePath: '/original-runtime',
    workspaceRoots: ['/chosen-workspace'],
    machine: { id: 'machine-7', label: 'Desk' },
    createdAtMs: 1234,
    workspaceChosen: true,
  }
  const injected = modules({ existing })
  const result = setupRecord.recordTier('standard', { modules: injected })

  assert.equal(result.ok, true)
  assert.equal(result.tier, 'standard')
  assert.equal(injected.writes.length, 1, 'an accepted permission level must be persisted exactly once')
  assert.deepEqual(injected.writes[0], { ...existing, tier: 'standard' },
    'changing a permission level must preserve the chosen workspace and machine identity')
})

test('recordTier reports an unreadable existing record and never overwrites it', () => {
  const injected = modules({
    machineRecord: { readMachineRecord: () => { throw Object.assign(new Error('record seal is invalid'), { code: 'BAD_SEAL' }) } },
  })
  const result = setupRecord.recordTier('guided', { modules: injected, documentsDir: null })
  assert.deepEqual(
    { ok: result.ok, code: result.code, reason: result.reason },
    { ok: false, code: 'BAD_SEAL', reason: 'record seal is invalid' },
    'could-not-read must be returned as a refusal rather than treated as no existing record',
  )
  assert.equal(injected.writes.length, 0, 'an unreadable record must never be overwritten')
})

function tierRecord(tier) {
  return {
    tier, installRoot: path.resolve('fixture-install'), servicesRoot: path.resolve('fixture-services'),
    nodePath: process.execPath, workspaceRoots: [path.resolve('fixture-workspace')],
    machine: { id: 'fixture-machine', label: 'Fixture' }, createdAtMs: 1234,
  }
}

test('a stale host snapshot refuses before building or writing a machine or assistant config', () => {
  let builds = 0, configs = 0
  const injected = modules({
    existing: tierRecord('guided'),
    machineRecord: {
      TIERS: ['guided', 'standard', 'unrestricted'],
      buildMachineRecord() { builds++; throw new Error('must not build a stale change') },
      writeMcpConfig() { configs++; throw new Error('must not project a stale change') },
    },
  })
  const result = setupRecord.recordTier('unrestricted', {
    modules: injected, expectedPreviousTier: 'unrestricted', dispatchRoot: path.resolve('fixture-dispatch'),
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SETUP_TIER_STATE_CHANGED')
  assert.match(result.reason, /changed/i)
  assert.equal(builds, 0)
  assert.equal(configs, 0)
  assert.deepEqual(injected.writes, [])
})

test('expected prior tier distinguishes first-run absence, a matching tier and intervening changes', () => {
  const cases = [
    { actual: null, expected: null, ok: true },
    { actual: 'guided', expected: 'guided', ok: true },
    { actual: 'guided', expected: null, ok: false },
    { actual: null, expected: 'guided', ok: false },
    { actual: 'standard', expected: 'guided', ok: false },
  ]
  for (const { actual, expected, ok } of cases) {
    const injected = modules({ existing: actual === null ? null : tierRecord(actual) })
    const result = setupRecord.recordTier('standard', {
      modules: injected, expectedPreviousTier: expected, documentsDir: null,
    })
    assert.equal(result.ok, ok, JSON.stringify({ actual, expected }))
    if (!ok) assert.equal(result.code, 'SETUP_TIER_STATE_CHANGED')
    assert.equal(injected.writes.length, ok ? 1 : 0)
  }
})

test('omitting the host snapshot preserves ordinary recordTier callers', () => {
  const existing = tierRecord('guided')
  const injected = modules({ existing, machineRecord: { resolveServicesRoot: () => existing.servicesRoot } })
  const result = setupRecord.recordTier('standard', { modules: injected })
  assert.equal(result.ok, true)
  assert.deepEqual(injected.writes, [{ ...tierRecord('guided'), tier: 'standard' }])
})

test('an expected tier never turns an unreadable record into absence', () => {
  const injected = modules({
    machineRecord: { readMachineRecord() { throw Object.assign(new Error('fixture unreadable'), { code: 'BAD_SEAL' }) } },
  })
  const result = setupRecord.recordTier('guided', { modules: injected, expectedPreviousTier: null })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'BAD_SEAL')
  assert.deepEqual(injected.writes, [])
})
