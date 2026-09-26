import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'
import { resolve } from 'node:path'

import {
  orphanedNodeSeatSweepProposal,
  orphanedNodeSeatSweepReadiness,
} from '../../src/orphaned-node-seat-sweep.js'

const ROOT = resolve(import.meta.dirname, '..', '..')
// The baseline is a commit from the history that preceded this fix; a checkout
// without that history skips it by name.
const BASELINE_REF = process.env.LO5_NULL_STORE_BASELINE_REF || '0000000'
const BASELINE_REQUESTED = process.env.LO5_NULL_STORE_VARIANT === 'baseline'
const BASELINE_AVAILABLE = BASELINE_REQUESTED
  && spawnSync('git', ['-C', ROOT, 'cat-file', '-e', `${BASELINE_REF}^{commit}`]).status === 0
const BASELINE_MODE = BASELINE_REQUESTED && BASELINE_AVAILABLE
if (BASELINE_REQUESTED && !BASELINE_AVAILABLE)
  test('the historical baseline', t => t.skip(`baseline ref ${BASELINE_REF} is not in this checkout`))
const MODULE_SOURCE = Object.freeze({ orphanedNodeSeatSweepProposal, orphanedNodeSeatSweepReadiness })

function extractSweep(source) {
  const start = source.indexOf('  const NODE_SEAT_ID')
  const end = source.indexOf('\n  function roleBindingForStart', start)
  assert.ok(start >= 0 && end > start, 'the extracted sweep source has its real function markers')
  return source.slice(start, end).trim()
}

const SELECTED_SWEEP_SOURCE = extractSweep(readFileSync(
  resolve(ROOT, 'src/views/computers.js'),
  'utf8',
))
const BASELINE_SWEEP_SOURCE = BASELINE_MODE
  ? extractSweep(execFileSync(
    'git',
    ['-C', ROOT, 'show', `${BASELINE_REF}:src/views/computers.js`],
    { encoding: 'utf8' },
  ))
  : null
// The baseline is opt-in so the normal suite exercises the selected source,
// while LO5_NULL_STORE_VARIANT=baseline proves the unpatched an earlier commit path.
const EXTRACTED_SWEEP = BASELINE_SWEEP_SOURCE || SELECTED_SWEEP_SOURCE
let packedModulePromise

async function packedModule() {
  if (!packedModulePromise) {
    packedModulePromise = build({
      entryPoints: [resolve(ROOT, 'src/orphaned-node-seat-sweep.js')],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      write: false,
      logLevel: 'silent',
    }).then(({ outputFiles }) => import(
      `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
    ))
  }
  return packedModulePromise
}

function evaluateSweep({
  treeStore,
  treeStoreProblem = '',
  agents,
  currentDataSource = 'local',
  orgReady = true,
  hasOrgBridge = true,
  sweepModule = MODULE_SOURCE,
}) {
  const releaseCalls = []
  const statuses = []
  const org = hasOrgBridge
    ? {
        releaseSeat: async request => {
          releaseCalls.push(request)
          return { ok: true, org: { revision: 2, agents } }
        },
      }
    : {}
  const factory = new Function(
    'currentDataSource',
    'orgReady',
    'treeStore',
    'treeStoreProblem',
    'window',
    'orgAvailability',
    'isRevisionConflict',
    'refreshOrg',
    'setOrgStatus',
    'orphanedNodeSeatSweepProposal',
    'orphanedNodeSeatSweepReadiness',
    EXTRACTED_SWEEP + '\nreturn sweepOrphanedNodeSeats',
  )
  const run = factory(
    () => currentDataSource,
    () => orgReady,
    treeStore,
    treeStoreProblem,
    { mcOrg: org },
    { state: 'ready', org: { revision: 1, agents } },
    () => false,
    async () => {},
    (reason, state, options) => statuses.push({ reason, state, options }),
    sweepModule.orphanedNodeSeatSweepProposal,
    sweepModule.orphanedNodeSeatSweepReadiness,
  )
  return run().then(outcome => ({ outcome, releaseCalls, statuses }))
}

function treeStoreFor(mode) {
  if (mode === 'null') return null
  if (mode === 'empty') return { snapshot: () => ({ nodes: [], persistenceFailed: false }) }
  if (mode === 'persistence') {
    return {
      snapshot: () => ({
        nodes: [{ id: 'node-1-live' }],
        persistenceFailed: true,
        persistenceProblem: 'synthetic write refusal',
      }),
    }
  }
  if (mode === 'throw') return { snapshot: () => { throw new Error('synthetic unreadable store') } }
  return { snapshot: () => ({ nodes: [{ id: 'node-1-live' }], persistenceFailed: false }) }
}

async function runsFor(options) {
  const packed = await packedModule()
  return [
    await evaluateSweep({ ...options, sweepModule: MODULE_SOURCE }),
    await evaluateSweep({ ...options, sweepModule: packed }),
  ]
}

function assertRefusal(run, code, label) {
  assert.equal(run.outcome.ok, false, label + ' refuses')
  assert.equal(run.outcome.code, code, label + ' carries the refusal code')
  assert.deepEqual(run.releaseCalls, [], label + ' releases no seats')
  assert.equal(run.statuses.length, 1, label + ' surfaces one refusal')
  assert.equal(run.statuses[0].state, 'refuse', label + ' marks the refusal state')
  assert.equal(run.statuses[0].options.sticky, true, label + ' keeps the refusal visible')
  assert.equal(run.statuses[0].options.code, code, label + ' surfaces the same refusal code')
}

function assertSilent(run, label) {
  assert.deepEqual(run.outcome, { ok: true, releasedIds: [] }, label + ' remains a no-op')
  assert.deepEqual(run.releaseCalls, [], label + ' releases no seats')
  assert.deepEqual(run.statuses, [], label + ' does not surface a false refusal')
}

test('the extracted sweep refuses a null store with actual node seats in source and packed layouts', async () => {
  for (const [index, run] of (await runsFor({
    treeStore: treeStoreFor('null'),
    treeStoreProblem: 'The saved trees could not be opened. They have not been replaced.',
    agents: [{ id: 'node-1-seat', role: 'worker', enabled: true }],
  })).entries()) {
    assertRefusal(run, 'TREE_STORE_UNREADABLE', `null store layout ${index}`)
  }
})

test('the extracted sweep refuses empty, throwing, persistence-failed and unknown candidate stores without releasing', async () => {
  const cases = [
    ['empty', 'TREE_STORE_EMPTY', [{ id: 'node-1-seat', role: 'worker', enabled: true }]],
    ['throw', 'TREE_STORE_UNREADABLE', [{ id: 'node-1-seat', role: 'worker', enabled: true }]],
    ['persistence', 'TREE_STORE_PERSISTENCE_FAILED', [{ id: 'node-1-seat', role: 'worker', enabled: true }]],
    ['unknown candidates', 'TREE_SEAT_SWEEP_CANDIDATES_UNREADABLE', null],
  ]
  for (const [mode, code, agents] of cases) {
    const runs = await runsFor({
      treeStore: treeStoreFor(mode === 'unknown candidates' ? 'null' : mode),
      treeStoreProblem: mode === 'unknown candidates' ? 'The saved trees could not be opened.' : '',
      agents,
    })
    for (const [index, run] of runs.entries()) assertRefusal(run, code, `${mode} layout ${index}`)
  }
})

test('zero authoritative node-seat candidates stay silent even when the tree store is null', async () => {
  const runs = await runsFor({
    treeStore: null,
    treeStoreProblem: 'The saved trees could not be opened. They have not been replaced.',
    agents: [{ id: 'controller', role: 'controller', enabled: true }],
  })
  for (const [index, run] of runs.entries()) assertSilent(run, `zero-candidate layout ${index}`)
})

test('relay and org-unready controls remain silent and never release a seat', async () => {
  const controls = [
    ['relay', { currentDataSource: 'relay', orgReady: true }],
    ['org-unready', { currentDataSource: 'local', orgReady: false }],
    ['missing-org-bridge', { currentDataSource: 'local', orgReady: true, hasOrgBridge: false }],
  ]
  for (const [name, options] of controls) {
    const runs = await runsFor({
      ...options,
      treeStore: null,
      treeStoreProblem: 'The saved trees could not be opened.',
      agents: [{ id: 'node-1-seat', role: 'worker', enabled: true }],
    })
    for (const [index, run] of runs.entries()) assertSilent(run, `${name} layout ${index}`)
  }
})
