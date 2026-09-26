// The real continuation-prune engine against the snapshots shell/saved-data-maintenance.cjs hands it.
//
// saved-data-maintenance.test.mjs answers for the adapter with a deliberately blind fake engine. This file is the other
// half: the engine's own treeIdentity() and planRows(), which are pure (no SQLite file is opened, nothing is written),
// decide whether a snapshot is acceptable and what its scope hash is bound to. It needs the engine checkout that the other
// engine-backed suites need (MC_CANONICAL_ROOT or TOOLSENABLED_SOURCE) and fails, by name, when there is none.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'

import { canonicalRootForTests } from '../canonical-root.mjs'

const require = createRequire(import.meta.url)
const { readTreeSnapshot } = require('../../shell/saved-data-maintenance.cjs')
const { RENDERER_FLEET_FILE } = require('../../shell/renderer-prefs.cjs')

const TREE_KEY = 'mc.fleet.trees.v1:this-computer'
const DIFF_KEY = 'mc.fleet.chat-diffs.v1:synthetic-node'
const sha = data => crypto.createHash('sha256').update(data).digest('hex')
const treeDocument = ids => JSON.stringify({ version: 1, computerId: 'this-computer', trees: [{ id: 'tree-this-computer' }], nodes: ids.map(id => ({ id, treeId: 'tree-this-computer', status: 'running' })) })
const wrapperOf = values => `${JSON.stringify({ storageVersion: 1, values })}\n`
const baseValues = () => ({ [TREE_KEY]: treeDocument(['node-a1', 'node-a2']), [DIFF_KEY]: 'unrelated chat diff bytes' })
const healthy = (values, extra = {}) => ({ ok: true, values, drainedOrigins: [], damaged: null, fleetDamaged: null, fleetPending: false, fleetWriteError: null, preservedAt: null, ...extra })
const fakePrefs = snapshot => ({ snapshot: () => snapshot, commitFleetMaintenance: () => ({ ok: true }) })
const STORE = path.resolve('synthetic-engine-contract', RENDERER_FLEET_FILE)
const agreeing = (values, file = wrapperOf(values)) => ({ rendererPrefs: fakePrefs(healthy(values)), storePath: STORE, fs: { readFileSync: () => file } })

const enginePath = path.join(canonicalRootForTests(), 'src', 'lib', 'continuation-prune.js')
function engine() {
  assert.ok(existsSync(enginePath), `No engine checkout at ${enginePath}: this suite drives the REAL continuation-prune module. Declare it with MC_CANONICAL_ROOT or TOOLSENABLED_SOURCE, as the other engine-backed suites need.`)
  return require(enginePath)
}
// A saved continuation row for one thread, as the engine reads it (the fields planRows uses).
const continuation = threadId => {
  const value = JSON.stringify({ version: 1, status: 'idle', descriptor: { requestKeys: { threadId, treeAnchors: [threadId] } } })
  return { entry_key: `continuation-${threadId}`, revision: 1, value_json: value, value_hash: sha(value) }
}

test('the engine accepts the snapshot of a settled store and refuses every store the adapter refuses', () => {
  const { treeIdentity } = engine()
  const values = baseValues()
  const identity = treeIdentity(readTreeSnapshot(agreeing(values)))
  assert.deepEqual([...identity.nodes].sort(), ['node-a1', 'node-a2'])
  const refused = {
    'changes still being written': readTreeSnapshot({ ...agreeing(values), rendererPrefs: fakePrefs(healthy(values, { fleetPending: true })) }),
    'a durable file that differs from the cache': readTreeSnapshot({ ...agreeing(values), fs: { readFileSync: () => wrapperOf({ ...values, [DIFF_KEY]: 'written by someone else' }) } }),
    'a damaged fleet file': readTreeSnapshot({ ...agreeing(values), rendererPrefs: fakePrefs(healthy(values, { fleetDamaged: 'malformed' })) }),
    'a failed save': readTreeSnapshot({ ...agreeing(values), rendererPrefs: fakePrefs(healthy(values, { fleetWriteError: 'EIO' })) }),
    'no saved trees': readTreeSnapshot(agreeing({})),
  }
  for (const [name, snapshot] of Object.entries(refused)) {
    assert.throws(() => treeIdentity(snapshot), { code: 'CONTINUATION_PRUNE_TREES_UNAVAILABLE' }, name)
  }
})

test('the engine\'s scope hash is bound to every byte of the durable store, not only to the tree and node ids', () => {
  const { planRows } = engine()
  const rows = [continuation('node-gone'), continuation('node-a1')]
  const plan = values => planRows(rows, readTreeSnapshot(agreeing(values)), { file: '/state/toolsenabled.sqlite3', limit: 10, now: Date.now() })
  const first = plan(baseValues())
  assert.equal(first.scanned, 2)
  assert.equal(first.eligible, 1, 'only the thread whose node is no longer saved is orphaned')
  assert.deepEqual(first.rows.map(row => row.key), ['continuation-node-gone'])
  assert.equal(plan(baseValues()).scopeHash, first.scopeHash, 'the same store is the same scope')
  const laterDiff = plan({ ...baseValues(), [DIFF_KEY]: 'a later chat diff' })
  assert.equal(laterDiff.eligible, first.eligible, 'no node was added or removed')
  assert.notEqual(laterDiff.scopeHash, first.scopeHash, 'yet a preview of the earlier store cannot be confirmed against this one')
  const laterNode = plan({ ...baseValues(), [TREE_KEY]: treeDocument(['node-a1', 'node-a2', 'node-gone']) })
  assert.equal(laterNode.eligible, 0, 'a node that now exists keeps its continuation')
  assert.notEqual(laterNode.scopeHash, first.scopeHash)
})
