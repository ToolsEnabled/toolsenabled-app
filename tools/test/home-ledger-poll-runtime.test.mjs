import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { homeLedgerStatus } from '../../src/home-ledger-status.js'
import { approvalsReadingChanged, nextApprovalsWaitMs, APPROVALS_POLL_MS } from '../../src/idle-cadence.js'

const load = declaredFunctionSource(readFileSync(new URL('../../src/views/home.js', import.meta.url), 'utf8'), 'loadApprovals')
function fixture(sample = false) {
  const calls = { prompts: 0, ledger: 0, reconcile: 0, scans: 0, paints: 0, waits: [] }
  const state = {
    sample, destroyed: false, state: { ledgerStatus: homeLedgerStatus(), approvals: null },
    ledger: { ok: true, records: [] }, prompts: { ok: true, prompts: [] },
    approvalsMoved: false, approvalsWaitMs: APPROVALS_POLL_MS, approvalsTimer: 0,
    approvalsReadingChanged, nextApprovalsWaitMs,
    homeLedgerStatus(input) { calls.scans++; return homeLedgerStatus(input) },
    ownerPromptSnapshot: async () => { calls.prompts++; return state.prompts },
    readHomeLedger: async () => { calls.ledger++; return state.ledger },
    exampleOwnerPrompts: () => [], sampleLedgerData: () => ({ requests: [{ id: 'R1', status: 'proposed' }] }),
    reconcileUndeliveredDecisions() { calls.reconcile++; return 0 },
    apply() { calls.paints++ }, setTimeout(callback, wait) { calls.waits.push(wait); return calls.waits.length },
  }
  vm.createContext(state); vm.runInContext(load, state)
  return { state, calls, poll: () => state.loadApprovals() }
}

test('one existing poll reads both sources and caches severity; a changed blocker resets backoff', async () => {
  const f = fixture()
  await f.poll()
  assert.equal(f.state.state.ledgerStatus.status, 'clear')
  await f.poll()
  assert.deepEqual(f.calls.waits, [20000, 40000])
  f.state.ledger.records.push({ id: 'T1', status: 'blocked-external' })
  await f.poll()
  assert.equal(f.state.state.ledgerStatus.status, 'blocked')
  assert.deepEqual(f.calls.waits, [20000, 40000, 20000])
  assert.equal(f.calls.scans, 3, 'one summary scan per read')
  assert.equal(f.calls.ledger, 3)
  assert.equal(f.calls.prompts, 3)
})

test('the example never reads live queues or reconciles real undelivered decisions', async () => {
  const f = fixture(true)
  await f.poll()
  assert.equal(f.state.state.ledgerStatus.status, 'attention')
  assert.equal(f.calls.ledger, 0)
  assert.equal(f.calls.prompts, 0)
  assert.equal(f.calls.reconcile, 0)
})

test('unreadable queues remain neutral; a late result after teardown cannot paint or schedule work', async () => {
  const f = fixture()
  f.state.prompts = null; f.state.ledger = { ok: false }
  await f.poll()
  assert.equal(f.state.state.ledgerStatus.status, 'unknown')
  assert.equal(f.calls.reconcile, 0)
  assert.deepEqual(f.calls.waits, [120000])
  let finish
  f.state.readHomeLedger = () => new Promise(resolve => { finish = resolve })
  const pending = f.poll()
  f.state.destroyed = true; finish({ ok: true, records: [] })
  await pending
  assert.equal(f.calls.paints, 1)
  assert.equal(f.calls.waits.length, 1)
})
