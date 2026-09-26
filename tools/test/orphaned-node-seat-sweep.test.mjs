import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { resolve } from 'node:path'

import {
  ORPHANED_NODE_SEAT_SWEEP_LIMITS,
  orphanedNodeSeatSweepProposal,
  orphanedNodeSeatSweepReadiness,
} from '../../src/orphaned-node-seat-sweep.js'
import './orphaned-node-seat-sweep-loop.test.mjs'

const ROOT = resolve(import.meta.dirname, '..', '..')

const store = ({ nodes = [{ id: 'node-1-live' }], persistenceFailed = false, persistenceProblem = '' } = {}) => ({
  snapshot: () => ({ nodes, persistenceFailed, persistenceProblem }),
})

test('a readable non-empty tree store authorizes the sweep with its snapshot', () => {
  const snapshot = { nodes: [{ id: 'node-1-live' }], persistenceFailed: false, persistenceProblem: '' }
  const result = orphanedNodeSeatSweepReadiness({ store: { snapshot: () => snapshot } })

  assert.equal(result.ok, true)
  assert.equal(result.snapshot, snapshot)
})

test('an empty tree store refuses the sweep before orphan seats can be released', () => {
  const result = orphanedNodeSeatSweepReadiness({ store: store({ nodes: [] }) })

  assert.equal(result.ok, false)
  assert.match(result.reason, /empty/i)
})

test('an absent or unreadable tree store refuses instead of treating it as empty', () => {
  const cases = [
    { store: null, storeProblem: 'The saved trees could not be opened.' },
    { store: { snapshot: () => { throw new Error('synthetic read failure') } } },
    { store: { snapshot: () => ({ nodes: null }) } },
  ]

  for (const nodes of [
    [{}],
    [{ id: null }],
    [{ id: '' }],
    [{ id: 42 }],
    [{ id: 'node-1-live' }, { id: 'node-1-live' }],
  ]) {
    cases.push({ store: { snapshot: () => ({ nodes }) } })
  }

  for (const input of cases) {
    const result = orphanedNodeSeatSweepReadiness(input)
    assert.equal(result.ok, false)
    assert.match(result.reason, /read|open|unavailable/i)
  }
})

test('a readiness recheck refuses a store that becomes empty between releases', () => {
  let nodes = [{ id: 'node-1-live' }, { id: 'node-2-live' }]
  const changingStore = { snapshot: () => ({ nodes, persistenceFailed: false }) }

  const beforeFirstRelease = orphanedNodeSeatSweepReadiness({ store: changingStore })
  nodes = []
  const beforeNextRelease = orphanedNodeSeatSweepReadiness({ store: changingStore })

  assert.equal(beforeFirstRelease.ok, true)
  assert.equal(beforeNextRelease.ok, false)
  assert.equal(beforeNextRelease.code, 'TREE_STORE_EMPTY')
})

test('a persistence-failed store refuses even when nodes remain in memory', () => {
  const result = orphanedNodeSeatSweepReadiness({
    store: store({ nodes: [{ id: 'node-1-live' }], persistenceFailed: true, persistenceProblem: 'synthetic write refusal' }),
  })

  assert.equal(result.ok, false)
  assert.match(result.reason, /save|persist|write/i)
})


test('a proposal refuses more than two candidate releases before any seat write', () => {
  const result = orphanedNodeSeatSweepProposal({
    store: store({ nodes: [{ id: 'node-1-live' }] }),
    candidateIds: ['node-2-orphan', 'node-3-orphan', 'node-4-orphan'],
    nodeSeatCount: 12,
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'TREE_SEAT_SWEEP_COUNT_BOUND')
  assert.match(result.reason, /3 candidate releases|2/)
  assert.equal(ORPHANED_NODE_SEAT_SWEEP_LIMITS.maxReleases, 2)
})

test('a proposal refuses more than one quarter of node seats before any seat write', () => {
  const result = orphanedNodeSeatSweepProposal({
    store: store({ nodes: [{ id: 'node-1-live' }] }),
    candidateIds: ['node-2-orphan', 'node-3-orphan'],
    nodeSeatCount: 5,
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'TREE_SEAT_SWEEP_FRACTION_BOUND')
  assert.match(result.reason, /2 of 5|25%/)
  assert.equal(ORPHANED_NODE_SEAT_SWEEP_LIMITS.maxFraction, 0.25)
})

test('a proposal allows both declared bounds and preserves exact candidate ids', () => {
  const result = orphanedNodeSeatSweepProposal({
    store: store({ nodes: [{ id: 'node-1-live' }] }),
    candidateIds: ['node-2-orphan', 'node-3-orphan'],
    nodeSeatCount: 8,
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.candidateIds, ['node-2-orphan', 'node-3-orphan'])
  assert.equal(result.fraction, 0.25)
})

test('zero eligible candidates remain a successful bounded no-op', () => {
  const result = orphanedNodeSeatSweepProposal({
    store: store({ nodes: [{ id: 'node-1-live' }] }),
    candidateIds: ['node-1-live'],
    nodeSeatCount: 0,
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.candidateIds, [])
})

test('the gate is usable from a packed renderer layout without a source directory', async () => {
  const bundle = await build({
    entryPoints: [resolve(ROOT, 'src/orphaned-node-seat-sweep.js')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
  })
  const packed = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
  const result = packed.orphanedNodeSeatSweepProposal({
    store: store({ nodes: [{ id: 'node-1-live' }] }),
    candidateIds: ['node-2-orphan', 'node-3-orphan'],
    nodeSeatCount: 5,
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'TREE_SEAT_SWEEP_FRACTION_BOUND')
  assert.match(result.reason, /25%/)
})
