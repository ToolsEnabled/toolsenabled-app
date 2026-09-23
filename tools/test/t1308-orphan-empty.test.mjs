import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
register('./helpers/css-stub-loader.mjs', import.meta.url)
import { orphanedNodeSeatSweepProposal } from '../../src/orphaned-node-seat-sweep.js'
import { mountComputers } from './helpers/t1308-computers-fixture.mjs'

test('zero authoritative candidates is a silent no-op without reading an empty or unknown tree store', () => {
  for (const snapshot of [() => ({ nodes: [] }), () => { throw new Error('unreadable') }, () => null]) {
    let reads = 0
    const result = orphanedNodeSeatSweepProposal({ candidateIds: [], store: { snapshot() { reads++; return snapshot() } } })
    assert.equal(result.ok, true)
    assert.deepEqual(result.candidateIds, [])
    assert.equal(result.snapshot, null, 'no invented authoritative tree snapshot')
    assert.equal(reads, 0, 'nothing to release needs no tree read')
  }
})

test('unknown candidates and actual candidates retain the sweep safety refusals', () => {
  for (const candidateIds of [null, {}, 'node-1-seat']) {
    assert.equal(orphanedNodeSeatSweepProposal({ candidateIds }).code, 'TREE_SEAT_SWEEP_CANDIDATES_UNREADABLE')
  }
  for (const [snapshot, code] of [
    [() => ({ nodes: [] }), 'TREE_STORE_EMPTY'],
    [() => { throw new Error('unreadable') }, 'TREE_STORE_UNREADABLE'],
    [() => ({ nodes: [{ id: 'live' }], persistenceFailed: true }), 'TREE_STORE_PERSISTENCE_FAILED'],
  ]) {
    const result = orphanedNodeSeatSweepProposal({ candidateIds: ['node-1-seat'], nodeSeatCount: 4, store: { snapshot } })
    assert.equal(result.ok, false)
    assert.equal(result.code, code)
  }
  const store = { snapshot: () => ({ nodes: [{ id: 'live' }] }) }
  assert.equal(orphanedNodeSeatSweepProposal({ store, candidateIds: [''], nodeSeatCount: 4 }).code, 'TREE_SEAT_SWEEP_CANDIDATES_UNREADABLE')
  const accepted = orphanedNodeSeatSweepProposal({ store, candidateIds: ['live', 'node-1-seat', 'node-1-seat'], nodeSeatCount: 4 })
  assert.equal(accepted.ok, true)
  assert.deepEqual(accepted.candidateIds, ['node-1-seat'])
  assert.equal(accepted.fraction, 0.25)
})

test('fresh mounted Computers with no node seats shows no sweep refusal or release', async t => {
  const fixture = await mountComputers(t, { agents: [{ id: 'controller', role: 'controller', enabled: true }] })
  const status = fixture.view.el.querySelector('.org-status')
  assert.ok(status)
  assert.equal(status.textContent, '')
  assert.equal(status.hidden, true)
  assert.deepEqual(fixture.operations, [])
})

test('mounted Computers refuses an empty fleet with actual seats and refuses unknown org candidates', async t => {
  for (const [agents, code] of [
    [[{ id: 'node-1-seat', role: 'worker', enabled: true }], 'TREE_STORE_EMPTY'],
    [null, 'TREE_SEAT_SWEEP_CANDIDATES_UNREADABLE'],
  ]) await t.test(code, async child => {
    const fixture = await mountComputers(child, { agents })
    const status = fixture.view.el.querySelector('.org-status')
    assert.equal(status.hidden, false)
    assert.equal(status.dataset.refusalCode, code)
    assert.ok(status.textContent.length > 0)
    assert.deepEqual(fixture.operations, [])
  })
})
