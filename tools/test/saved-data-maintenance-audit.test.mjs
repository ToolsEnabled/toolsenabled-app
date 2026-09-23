import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { registerSavedDataMaintenanceIpc } = require('../../shell/saved-data-maintenance-ipc.cjs')
const receipt = () => ({ ok: true, sequence: 1, eventHash: 'a'.repeat(64) })
const routes = ['continuation-prune-preview', 'continuation-prune-confirm', 'node-status-repair-preview',
  'node-status-repair-confirm', 'node-status-rollback-preview', 'node-status-rollback-confirm']
function fixture({ policy = { ok: true, decision: { required: false } }, record } = {}) {
  const handlers = new Map(), audit = [], calls = []
  const owner = { isDestroyed: () => false }
  let principal = { kind: 'window', mayWrite: true, owner }
  const result = { ok: true, confirmed: true, changedKeys: ['mc.fleet.trees.v1:synthetic-private-key'],
    details: 'synthetic-private-result-canary' }
  registerSavedDataMaintenanceIpc({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    principalFor: () => principal, assertTrustedSender() {}, capturePolicy: () => policy,
    recordAudit: async (...args) => { audit.push(args); return record ? record(args, () => { principal = { ...principal, mayWrite: false } }) : receipt() },
    getAdapter: () => new Proxy({}, { get: (_target, name) => async input => { calls.push([name, input]); return result } }) })
  return { calls, audit, run: route => handlers.get('mc-agent:' + route)({}, { text: 'synthetic-private-request-canary' }) }
}

test('Basic-off maintenance reaches every native route without touching an unavailable audit writer or inventing a receipt', async () => {
  const f = fixture({ record: () => { throw new Error('audit unavailable') } })
  for (const route of routes) {
    const result = await f.run(route)
    assert.equal(result.ok, true)
    assert.deepEqual(result.audit, { required: false, disposition: 'not-required' })
    assert.equal(Object.hasOwn(result.audit, 'recorded'), false)
  }
  assert.equal(f.calls.length, 6)
  assert.deepEqual(f.audit, [])
})

test('an absent optional audit payload is named and does not block native maintenance', async () => {
  const f = fixture({ policy: { ok: false, code: 'AUDIT_PAYLOAD_ABSENT' } })
  const result = await f.run(routes[0])
  assert.equal(result.ok, true)
  assert.deepEqual(result.audit, { available: false, code: 'AUDIT_PAYLOAD_ABSENT' })
  assert.deepEqual(f.audit, [])
})

test('explicit audited maintenance refuses every route before action when its intent cannot be recorded', async () => {
  const f = fixture({ policy: { ok: true, decision: { required: true } }, record: () => ({ ok: false }) })
  for (const route of routes) {
    const result = await f.run(route)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'MC_SAVED_DATA_AUDIT_UNAVAILABLE')
  }
  assert.deepEqual(f.calls, [])
  assert.equal(f.audit.length, 6)
})

test('an outcome recording failure preserves the real maintenance result and reports only bounded metadata', async () => {
  const decision = { required: true }, f = fixture({ policy: { ok: true, decision },
    record: args => args[0].endsWith('.intent') ? receipt() : { ok: false } })
  const result = await f.run('node-status-repair-confirm')
  assert.equal(result.ok, true)
  assert.equal(result.confirmed, true)
  assert.deepEqual(result.audit, { required: true, recorded: false, code: 'MC_SAVED_DATA_AUDIT_OUTCOME_UNAVAILABLE' })
  assert.equal(f.calls.length, 1)
  assert.equal(f.audit.length, 2)
  assert.equal(f.audit[0][3], decision)
  assert.deepEqual(f.audit[1][2], { surface: 'app.ipc', ok: true, changedTrees: 1 })
  assert.doesNotMatch(JSON.stringify(f.audit), /synthetic-private/)
})

test('a window revoked during its intent append cannot perform maintenance afterward', async () => {
  const f = fixture({ policy: { ok: true, decision: { required: true } },
    record: (_args, revoke) => { revoke(); return receipt() } })
  const result = await f.run('node-status-repair-confirm')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'MC_SAVED_DATA_PERSON_REQUIRED')
  assert.deepEqual(f.calls, [])
})

test('an audited maintenance intent requires an actual append receipt, never a skipped or merely successful status', async () => {
  for (const answer of [{ ok: true }, { ...receipt(), disposition: 'not-required', recorded: false },
    { ...receipt(), eventHash: null }, { ...receipt(), sequence: null }]) {
    const f = fixture({ policy: { ok: true, decision: { required: true } }, record: () => answer })
    assert.equal((await f.run(routes[0])).code, 'MC_SAVED_DATA_AUDIT_UNAVAILABLE')
    assert.deepEqual(f.calls, [])
  }
})
