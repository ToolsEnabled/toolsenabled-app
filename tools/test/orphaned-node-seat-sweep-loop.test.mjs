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
// The RED baseline is opt-in and names a commit from the history that
// preceded this fix; a checkout without that history skips it by name.
const BASELINE_REF = process.env.LO5_LOOP_BASELINE_REF || '0000000'
const BASELINE_REQUESTED = process.env.LO5_LOOP_VARIANT === 'baseline'
const BASELINE_AVAILABLE = BASELINE_REQUESTED
  && spawnSync('git', ['-C', ROOT, 'cat-file', '-e', `${BASELINE_REF}^{commit}`]).status === 0
const BASELINE_MODE = BASELINE_REQUESTED && BASELINE_AVAILABLE
if (BASELINE_REQUESTED && !BASELINE_AVAILABLE)
  test('the historical RED baseline', t => t.skip(`baseline ref ${BASELINE_REF} is not in this checkout`))

function extractSweep(source) {
  const start = source.indexOf('  const NODE_SEAT_ID')
  const end = source.indexOf('\n  function roleBindingForStart', start)
  assert.ok(start >= 0 && end > start, 'sweepOrphanedNodeSeats extraction markers are present')
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

/* The acceptance path reads the selected Computers source and evaluates that
 * real loop with the selected source module in both source and packed layouts.
 * The historical source is loaded only by the explicit RED baseline mode. */
const PATCHED_SWEEP_SOURCE = SELECTED_SWEEP_SOURCE
const SOURCE_SWEEP_MODULE = Object.freeze({
  orphanedNodeSeatSweepProposal,
  orphanedNodeSeatSweepReadiness,
})
let packedSweepModulePromise
async function loadPackedSweepModule() {
  if (!packedSweepModulePromise) {
    packedSweepModulePromise = build({
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
  return packedSweepModulePromise
}

function evaluateSweep(sweepSource, {
  treeStore,
  org,
  orgAvailability,
  statuses,
  sweepModule = SOURCE_SWEEP_MODULE,
  treeStoreProblem = '',
}) {
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
    sweepSource + '\nreturn sweepOrphanedNodeSeats',
  )
  return factory(
    () => 'local',
    () => true,
    treeStore,
    treeStoreProblem,
    { mcOrg: org },
    orgAvailability,
    () => false,
    async () => {},
    (reason, state, options) => statuses.push({ reason, state, options }),
    sweepModule.orphanedNodeSeatSweepProposal,
    sweepModule.orphanedNodeSeatSweepReadiness,
  )()
}

function runSweep(sweepSource, mode, agentCount = 2, sweepModule = SOURCE_SWEEP_MODULE) {
  const agents = Array.from({ length: agentCount }, (_, index) => ({
    id: 'node-' + (index + 1) + '-seat',
    role: index % 2 === 0 ? 'worker' : 'reviewer',
    managerId: 'manager-root',
  }))
  const liveCount = mode === 'mid-loop' ? 6 : mode === 'fraction-bound' ? 3 : 1
  let phase = 'initial'
  const treeStore = {
    snapshot: () => {
      if (phase === 'empty') return { nodes: [], persistenceFailed: false }
      if (mode === 'throw') throw new Error('synthetic snapshot failure')
      if (mode === 'malformed') return { nodes: [{}], persistenceFailed: false }
      if (mode === 'persistence') {
        return {
          nodes: [{ id: 'node-1-seat' }],
          persistenceFailed: true,
          persistenceProblem: 'synthetic write refusal',
        }
      }
      if (mode === 'empty') return { nodes: [], persistenceFailed: false }
      return {
        nodes: Array.from({ length: liveCount }, (_, index) => ({ id: agents[index].id })),
        persistenceFailed: false,
      }
    },
  }
  const releaseCalls = []
  const org = {
    releaseSeat: async request => {
      releaseCalls.push(request)
      if (mode === 'mid-loop' && releaseCalls.length === 1) phase = 'empty'
      return { ok: true, org: { revision: 2, agents } }
    },
  }
  const statuses = []
  const result = evaluateSweep(sweepSource, {
    treeStore,
    org,
    orgAvailability: { state: 'ready', org: { revision: 1, agents } },
    statuses,
    sweepModule,
  })
  return result.then(outcome => ({ outcome, releaseCalls, statuses }))
}

async function runSelected(mode, agentCount = 2) {
  const packedModule = await loadPackedSweepModule()
  const sourceRun = await runSweep(SELECTED_SWEEP_SOURCE, mode, agentCount, SOURCE_SWEEP_MODULE)
  const packedRun = await runSweep(SELECTED_SWEEP_SOURCE, mode, agentCount, packedModule)
  return { sourceRun, packedRun }
}

test('the selected source loop keeps the empty-store safety boundary and historical RED control', async () => {
  if (BASELINE_MODE) {
    const run = await runSweep(BASELINE_SWEEP_SOURCE, 'empty', 2, SOURCE_SWEEP_MODULE)
    assert.deepEqual(run.releaseCalls.map(request => request.id), [])
    return
  }

  const runs = await runSelected('empty', 2)
  for (const run of [runs.sourceRun, runs.packedRun]) {
    assert.deepEqual(run.releaseCalls, [])
    assert.equal(run.outcome.ok, false)
    assert.equal(run.outcome.code, 'TREE_STORE_EMPTY')
    assert.equal(run.statuses.length, 1)
    assert.equal(run.statuses[0].options.code, 'TREE_STORE_EMPTY')
  }
})

test('the selected source loop refuses empty, persistence-failed, throwing, and malformed stores in both layouts', async () => {
  const expected = new Map([
    ['empty', 'TREE_STORE_EMPTY'],
    ['persistence', 'TREE_STORE_PERSISTENCE_FAILED'],
    ['throw', 'TREE_STORE_UNREADABLE'],
    ['malformed', 'TREE_STORE_UNREADABLE'],
  ])

  for (const [mode, code] of expected) {
    const runs = await runSelected(mode, 2)
    for (const run of [runs.sourceRun, runs.packedRun]) {
      assert.deepEqual(run.releaseCalls, [], mode + ' releases no seats')
      assert.equal(run.outcome.ok, false, mode + ' refuses')
      assert.equal(run.outcome.code, code, mode + ' refusal code')
      assert.equal(run.statuses.length, 1, mode + ' surfaces one refusal')
      assert.equal(run.statuses[0].options.code, code, mode + ' surfaces its code')
    }
  }
})

test('the selected source loop rechecks readiness before each awaited release in both layouts', async () => {
  const runs = await runSelected('mid-loop', 8)

  for (const run of [runs.sourceRun, runs.packedRun]) {
    assert.deepEqual(run.releaseCalls.map(request => request.id), ['node-7-seat'])
    assert.deepEqual(run.outcome.releasedIds, ['node-7-seat'])
    assert.equal(run.outcome.ok, false)
    assert.equal(run.outcome.code, 'TREE_STORE_EMPTY')
    assert.equal(run.statuses.length, 1)
    assert.equal(run.statuses[0].options.code, 'TREE_STORE_EMPTY')
  }
})

test('the selected source loop carries exact seat audit identity and released ids in both layouts', async () => {
  const runs = await runSelected('mid-loop', 8)

  for (const run of [runs.sourceRun, runs.packedRun]) {
    const audit = run.releaseCalls[0].audit
    assert.equal(audit.seatId, 'node-7-seat')
    assert.equal(audit.priorRoleId, 'worker')
    assert.equal(audit.priorManagerId, 'manager-root')
    assert.deepEqual(audit.proposedReleasedSeatIds, ['node-7-seat'])
  }
})

test('the selected source loop refuses count and fraction bounds before release in both layouts', async () => {
  const countRuns = await runSelected('count-bound', 4)
  for (const run of [countRuns.sourceRun, countRuns.packedRun]) {
    assert.deepEqual(run.releaseCalls, [])
    assert.equal(run.outcome.code, 'TREE_SEAT_SWEEP_COUNT_BOUND')
    assert.equal(run.statuses.length, 1)
  }

  const fractionRuns = await runSelected('fraction-bound', 5)
  for (const run of [fractionRuns.sourceRun, fractionRuns.packedRun]) {
    assert.deepEqual(run.releaseCalls, [])
    assert.equal(run.outcome.code, 'TREE_SEAT_SWEEP_FRACTION_BOUND')
    assert.equal(run.statuses.length, 1)
  }
})


test('fresh organisations without node seats stay silent with empty saved trees in both layouts', async () => {
  const ordinarySeats = [
    'controller', 'astra', 'luna', 'terra', 'sol',
    'claude-1', 'claude-2', 'claude-3', 'claude-4',
    'local-node-1', 'local-node-2', 'local-node-3', 'local-node-4',
  ].map(id => ({ id }))
  // Four combinations: no seats or thirteen ordinary seats, source or bundled module.
  for (const agents of [[], ordinarySeats]) {
    for (const sweepModule of [SOURCE_SWEEP_MODULE, await loadPackedSweepModule()]) {
      const statuses = []
      const releaseCalls = []
      const outcome = await evaluateSweep(SELECTED_SWEEP_SOURCE, {
        treeStore: { snapshot: () => ({ nodes: [] }) },
        org: { releaseSeat: async request => { releaseCalls.push(request); return { ok: true } } },
        orgAvailability: { state: 'ready', org: { revision: 1, agents } },
        statuses,
        sweepModule,
      })
      assert.deepEqual(outcome, { ok: true, releasedIds: [] })
      assert.deepEqual(releaseCalls, [])
      assert.deepEqual(statuses, [], 'no sticky refusal for a fresh organisation with nothing to release')
    }
  }
})

test('unreadable organisation candidates refuse visibly instead of becoming an empty successful sweep', async () => {
  for (const agents of [null, undefined, {}]) {
    const statuses = []
    const releaseCalls = []
    const outcome = await evaluateSweep(SELECTED_SWEEP_SOURCE, {
      treeStore: { snapshot: () => ({ nodes: [{ id: 'node-1-live' }] }) },
      org: { releaseSeat: async request => { releaseCalls.push(request); return { ok: true } } },
      orgAvailability: { state: 'ready', org: { revision: 1, agents } },
      statuses,
    })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 'TREE_SEAT_SWEEP_CANDIDATES_UNREADABLE')
    assert.deepEqual(releaseCalls, [])
    assert.equal(statuses.length, 1)
    assert.equal(statuses[0].options.code, outcome.code)
    assert.match(statuses[0].reason, /could not be read/i)
  }
})
