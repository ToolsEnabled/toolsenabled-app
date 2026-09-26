import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import test from 'node:test'
import { fetchLiveLedger } from '../../src/ledger-live.js'
import { readDesktopTreeSnapshot as readAuthoritativeDesktopTreeSnapshot } from '../../src/desktop-tree-authority.js'
import { ownerAvailabilityOf } from '../../src/ledger-owner-visibility.js'

const require = createRequire(import.meta.url)
const { readDesktopTreeSnapshot } = require('../../shell/desktop-tree-snapshot.cjs')
const key = 'mc.fleet.trees.v1:this-computer'
const stamp = '2026-09-23T00:00:00.000Z'

const emptyForest = () => ({ version: 1, computerId: 'this-computer', trees: [], nodes: [] })
const task = (scope = 'tree', scopeKey = 'gone-node') => ({
  id: 'T1101', kind: 'T', scope, scopeKey, status: 'in-progress', words: 'Retain this task.',
  filedBy: 'codex', filedAt: stamp, decisions: [], history: [],
})

function nativeAnswer(desktopTree, extra = {}) {
  return {
    ok: true, mayWrite: false,
    desktopTree: { ...desktopTree, ...(extra.desktopTree || {}) },
    sessions: [], sessionsTruncated: false,
  }
}

async function readWith({ values, record = task(), answerExtra = {} }) {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  const desktopTree = readDesktopTreeSnapshot({ ok: true, damaged: false, values })
  const answer = nativeAnswer(desktopTree, answerExtra)
  try {
    globalThis.window = {
      mcAgent: { ledger: async () => ({ ok: true, records: [record], revision: 1, exists: true, chain: { checked: true, ok: true, events: 1 } }) },
      mcDesktopTree: { read: async () => answer },
    }
    globalThis.fetch = async () => ({ ok: false, json: async () => ({}) })
    const snapshot = await readAuthoritativeDesktopTreeSnapshot(globalThis.window.mcDesktopTree)
    return { desktopTree, snapshot, result: await fetchLiveLedger({ scope: record.scope }) }
  } finally {
    globalThis.window = previousWindow
    globalThis.fetch = previousFetch
  }
}

function assertImmutableTaskProjection(row, record) {
  assert.equal(row.id, record.id)
  assert.equal(row.scope, record.scope)
  assert.equal(row.scopeKey, record.scopeKey)
  assert.equal(row.status, record.status)
  assert.equal(row.words, record.words)
  assert.equal(row.decisions, 0)
  assert.deepEqual(row.decisionHistory, [])
  assert.deepEqual(row.history, [])
}

async function readPaged(desktopTree) {
  const bytes = Buffer.from(JSON.stringify(nativeAnswer(desktopTree)), 'utf8')
  const snapshot = {
    version: 1,
    page: 0,
    bytes: bytes.length,
    pages: 1,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    data: bytes.toString('base64'),
  }
  return readAuthoritativeDesktopTreeSnapshot({
    read: async () => ({ ok: true, desktopTreeSnapshot: snapshot }),
  })
}

test('the native reader distinguishes an absent saved-forest key from a present valid empty forest', async () => {
  const absent = readDesktopTreeSnapshot({ ok: true, damaged: false, values: {} })
  assert.equal(absent.storagePresent, false)
  const present = readDesktopTreeSnapshot({
    ok: true, damaged: false,
    values: { [key]: JSON.stringify(emptyForest()) },
  })
  assert.equal(present.storagePresent, true)
  assert.deepEqual(present.trees, [])
  assert.deepEqual(present.nodes, [])
})

test('a present empty tree answers unavailable while absent or malformed authority stays unknown through the live feed', async () => {
  const present = await readWith({ values: { [key]: JSON.stringify(emptyForest()) } })
  assert.equal(present.snapshot.storagePresent, true)
  assert.equal(present.result.ok, true)
  assertImmutableTaskProjection(present.result.data.requests[0], task())
  assert.equal(present.result.data.requests[0].ownerAvailability, 'unavailable')

  const { kind: _kind, ...legacyRecord } = task()
  const legacy = await readWith({
    values: { [key]: JSON.stringify(emptyForest()) },
    record: legacyRecord,
  })
  assert.equal(legacy.result.data.requests[0].ownerAvailability, 'unavailable')

  const absent = await readWith({ values: {} })
  assert.equal(absent.snapshot.storagePresent, false)
  assertImmutableTaskProjection(absent.result.data.requests[0], task())
  assert.equal(absent.result.data.requests[0].ownerAvailability, 'unknown')

  const malformed = await readWith({
    values: { [key]: JSON.stringify(emptyForest()) },
    answerExtra: { desktopTree: { storagePresent: 'true' } },
  })
  assert.equal(malformed.snapshot.storagePresent, null)
  assertImmutableTaskProjection(malformed.result.data.requests[0], task())
  assert.equal(malformed.result.data.requests[0].ownerAvailability, 'unknown')
})

test('a stopped or idle saved owner remains available and thread scope uses the same authoritative node identity', async () => {
  const forest = {
    version: 1, computerId: 'this-computer',
    trees: [{ id: 'tree-a', name: 'Saved', createdAt: stamp, updatedAt: stamp }],
    nodes: [{ id: 'owner-node', treeId: 'tree-a', parentId: null, role: 'worker', status: 'finished',
      message: '', statusNote: '', createdAt: stamp, updatedAt: stamp }],
  }
  const result = await readWith({
    values: { [key]: JSON.stringify(forest) },
    record: task('thread', 'owner-node'),
  })
  assertImmutableTaskProjection(result.result.data.requests[0], task('thread', 'owner-node'))
  assert.equal(result.result.data.requests[0].ownerAvailability, 'available')
})

test('paged decoded authority preserves missing or false storage presence instead of inventing completeness', async () => {
  const absent = await readPaged(emptyForest())
  assert.equal(absent.storagePresent, null)
  const falseFlag = await readPaged({ ...emptyForest(), storagePresent: false })
  assert.equal(falseFlag.storagePresent, false)
  const present = await readPaged({ ...emptyForest(), storagePresent: true })
  assert.equal(present.storagePresent, true)
})

test('malformed forest identity, duplicate nodes and parent cycles remain unknown at the consumer boundary', () => {
  const base = {
    version: 1, computerId: 'this-computer', storagePresent: true,
    source: 'native-desktop-tree', sessions: [], sessionsTruncated: false,
    trees: [{ id: 'tree-a' }],
    nodes: [{ id: 'owner-node', treeId: 'tree-a', parentId: null, sessionId: null, status: 'finished' }],
  }
  assert.equal(ownerAvailabilityOf(task('tree', 'owner-node'), base), 'available')
  const { kind: _kind, ...legacyTask } = task('tree', 'owner-node')
  assert.equal(ownerAvailabilityOf(legacyTask, base), 'available')

  const malformedIdentity = { ...base, trees: [{ id: 'tree a' }] }
  assert.equal(ownerAvailabilityOf(task('tree', 'gone-node'), malformedIdentity), 'unknown')

  const duplicate = {
    ...base,
    nodes: [...base.nodes, { ...base.nodes[0] }],
  }
  assert.equal(ownerAvailabilityOf(task('tree', 'gone-node'), duplicate), 'unknown')

  const cyclic = {
    ...base,
    nodes: [
      { id: 'owner-node', treeId: 'tree-a', parentId: 'child-node', sessionId: null, status: 'finished' },
      { id: 'child-node', treeId: 'tree-a', parentId: 'owner-node', sessionId: null, status: 'finished' },
    ],
  }
  assert.equal(ownerAvailabilityOf(task('tree', 'gone-node'), cyclic), 'unknown')
})

test('a missing or refused ledger does not wait for an unrelated stalled tree read', async () => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  let releaseTreeRead
  const stalledTreeRead = new Promise(resolve => { releaseTreeRead = resolve })
  try {
    globalThis.fetch = async () => ({ ok: false, json: async () => ({}) })
    globalThis.window = {
      mcAgent: {},
      mcDesktopTree: { read: async () => stalledTreeRead },
    }
    const noLedger = await fetchLiveLedger()
    assert.equal(noLedger.ok, false)
    assert.equal(noLedger.code, 'AGENT_LEDGER_UNAVAILABLE')

    globalThis.window.mcAgent = {
      ledger: async () => ({ ok: false, code: 'AGENT_LEDGER_UNREADABLE', reason: 'fixture refusal' }),
    }
    const refused = await fetchLiveLedger()
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'AGENT_LEDGER_UNREADABLE')
    releaseTreeRead({ ok: false, code: 'MC_AGENT_DESKTOP_TREE_UNAVAILABLE' })
  } finally {
    globalThis.window = previousWindow
    globalThis.fetch = previousFetch
  }
})

test('a stalled tree join resolves unknown on the controlled owner-read deadline', async () => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  const previousSetTimeout = globalThis.setTimeout
  const previousClearTimeout = globalThis.clearTimeout
  let releaseTreeRead
  let deadline
  const cleared = []
  const stalledTreeRead = new Promise(resolve => { releaseTreeRead = resolve })
  try {
    globalThis.setTimeout = callback => {
      deadline = callback
      return 'owner-read-deadline'
    }
    globalThis.clearTimeout = token => { cleared.push(token) }
    globalThis.fetch = async () => ({ ok: false, json: async () => ({}) })
    globalThis.window = {
      mcAgent: {
        ledger: async () => ({ ok: true, records: [task()], revision: 1, exists: true, chain: { checked: true, ok: true, events: 1 } }),
      },
      mcDesktopTree: { read: async () => stalledTreeRead },
    }
    const pending = fetchLiveLedger()
    assert.equal(typeof deadline, 'function')
    deadline()
    const result = await pending
    assert.equal(result.ok, true)
    assert.equal(result.data.requests[0].ownerAvailability, 'unknown')
    assert.deepEqual(cleared, ['owner-read-deadline'])
    releaseTreeRead(nativeAnswer({
      version: 1,
      computerId: 'this-computer',
      storagePresent: true,
      trees: [{ id: 'tree-a' }],
      nodes: [{ id: 'gone-node', treeId: 'tree-a', parentId: null, sessionId: null, status: 'finished' }],
    }))
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(result.data.requests[0].ownerAvailability, 'unknown')
  } finally {
    globalThis.window = previousWindow
    globalThis.fetch = previousFetch
    globalThis.setTimeout = previousSetTimeout
    globalThis.clearTimeout = previousClearTimeout
    releaseTreeRead({ ok: false, code: 'MC_AGENT_DESKTOP_TREE_UNAVAILABLE' })
  }
})
