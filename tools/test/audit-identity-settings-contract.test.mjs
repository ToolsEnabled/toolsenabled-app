import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createAuditIdentitySettings } = require('../../shell/audit-identity-settings.cjs')
function fixture() {
  const state = { fingerprint: 'one', active: 0, calls: [], opens: [], quiesces: 0 }
  const broker = createAuditIdentitySettings({ stateRoot: '/unused', activeSessions: () => state.active,
    quiesce: async () => { state.quiesces++; return { ok: true } }, openArchive: async selected => { state.opens.push(selected); return '' },
    run: async (operation, request) => {
      state.calls.push(operation)
      if (operation === 'probe') return { ok: true, canRotate: true, canRecover: false, fingerprint: state.fingerprint }
      if (operation === 'reveal') return request.archivePath === '/known' ? { ok: true, archivePath: '/known' } : { ok: false, code: 'AUDIT_REKEY_ARCHIVE_UNKNOWN' }
      return { ok: true, status: 'rotated', restartRequired: true }
    } })
  return { broker, state }
}
test('audit confirmation is one-use, local-owner-bound, expiring, and required before any quiesce', async () => {
  const { broker, state } = fixture()
  assert.equal((await broker.rotate({}, 1)).code, 'AUDIT_REKEY_CONFIRMATION_REQUIRED')
  const wrongOwner = await broker.confirmation({ operation: 'rotate' }, 1)
  assert.equal((await broker.rotate(wrongOwner, 2)).code, 'AUDIT_REKEY_CONFIRMATION_REQUIRED')
  assert.equal((await broker.rotate(wrongOwner, 1)).code, 'AUDIT_REKEY_CONFIRMATION_REQUIRED')
  const expired = await broker.confirmation({ operation: 'rotate' }, 1)
  const original = Date.now
  try { Date.now = () => original() + 120001; assert.equal((await broker.rotate(expired, 1)).code, 'AUDIT_REKEY_CONFIRMATION_REQUIRED') }
  finally { Date.now = original }
  assert.equal(state.quiesces, 0)
  const valid = await broker.confirmation({ operation: 'rotate' }, 1)
  assert.equal((await broker.rotate(valid, 1)).status, 'rotated')
  assert.equal(state.quiesces, 1)
  assert.equal(broker.isBusy(), true)
})
test('changed state and an agent starting after confirmation refuse before maintenance', async () => {
  const { broker, state } = fixture()
  const stale = await broker.confirmation({ operation: 'rotate' }, 1)
  state.fingerprint = 'two'
  assert.equal((await broker.rotate(stale, 1)).code, 'AUDIT_REKEY_STATE_CHANGED')
  const busy = await broker.confirmation({ operation: 'rotate' }, 1)
  state.active = 1
  assert.equal((await broker.rotate(busy, 1)).code, 'AUDIT_REKEY_BUSY')
  assert.equal(state.quiesces, 0)
})
test('archive reveal opens only a path validated by the maintenance module', async () => {
  const { broker, state } = fixture()
  assert.equal((await broker.reveal({ archivePath: '/arbitrary' })).ok, false)
  assert.deepEqual(state.opens, [])
  assert.equal((await broker.reveal({ archivePath: '/known' })).ok, true)
  assert.deepEqual(state.opens, ['/known'])
})

test('repair requires its own available operation and one-use local confirmation after quiescence', async () => {
  const calls = []
  let quiet = false
  const broker = createAuditIdentitySettings({ stateRoot: '/unused',
    quiesce: async () => { quiet = true; return { ok: true, restartRequired: true } },
    run: async (operation, request) => {
      calls.push(operation)
      if (operation === 'probe') return { ok: true, canRepair: true, canRotate: false, fingerprint: 'damaged-content' }
      assert.equal(operation, 'repair')
      assert.equal(quiet, true)
      assert.equal(request.quiesced, true)
      assert.equal(request.fingerprint, 'damaged-content')
      return { ok: true, status: 'repaired', restartRequired: true }
    } })
  assert.equal((await broker.confirmation({ operation: 'rotate' }, 7)).ok, false)
  const confirmation = await broker.confirmation({ operation: 'repair' }, 7)
  assert.equal(confirmation.ok, true)
  assert.equal((await broker.rotate({ ...confirmation, operation: 'rotate' }, 7)).status, 'repaired', 'renderer cannot replace the confirmed operation')
  assert.equal((await broker.rotate(confirmation, 7)).code, 'AUDIT_REKEY_CONFIRMATION_REQUIRED')
  assert.equal(calls.filter(value => value === 'repair').length, 1)
})

for (const active of [0, 1]) test(`an inspection cleanup refusal latches restart while active sessions=${active}`, async () => {
  let count = active
  let restart = true
  let quiesces = 0
  const broker = createAuditIdentitySettings({ stateRoot: '/unused', activeSessions: () => count,
    quiesce: async () => { quiesces++; return { ok: true } },
    run: async () => ({ ok: true, canRepair: true, canRotate: true, canRecover: true, fingerprint: 'same', restartRequired: restart }) })
  const first = await broker.probe()
  assert.equal(first.restartRequired, true)
  assert.equal(first.canRepair, false)
  assert.equal(first.canRotate, false)
  assert.equal(first.canRecover, false)
  restart = false; count = 0
  assert.equal((await broker.probe()).restartRequired, true)
  assert.equal((await broker.confirmation({ operation: 'repair' }, 1)).ok, false)
  assert.equal(broker.isBusy(), true)
  assert.equal(quiesces, 0)
})

test('confirmation and execution recheck a cleanup restart returned by their awaited inspection', async () => {
  for (const stage of ['confirmation', 'execution']) {
    let reads = 0
    let quiesces = 0
    const broker = createAuditIdentitySettings({ stateRoot: '/unused', quiesce: async () => { quiesces++; return { ok: true } },
      run: async operation => {
        assert.equal(operation, 'probe')
        reads++
        return { ok: true, canRepair: true, fingerprint: 'same', restartRequired: reads === (stage === 'confirmation' ? 1 : 2) }
      } })
    const confirmation = await broker.confirmation({ operation: 'repair' }, 1)
    const result = stage === 'confirmation' ? confirmation : await broker.rotate(confirmation, 1)
    assert.equal(result.ok, false)
    assert.equal(result.restartRequired, true)
    assert.equal(quiesces, 0)
  }
})
