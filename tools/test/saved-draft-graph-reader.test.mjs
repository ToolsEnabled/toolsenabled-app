import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { buildMainRuntime } from '../build-main-runtime.mjs'
import { parseFleetTrees, fleetTreesStorageKey, NODE_STATUS_UNREADABLE } from '../../src/fleet-trees.js'
const require = createRequire(import.meta.url)
const { createSavedDraftGraphReader } = require('../../shell/saved-draft-graph-reader.cjs')
const files = ['../../shell/saved-draft-graph-reader.cjs', '../../src/fleet-trees.js',
  '../../src/editor-attachment-drafts.js', '../../src/tree-session-liveness.js', './saved-draft-graph-reader.test.mjs']
const hashes = () => Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(new URL(file, import.meta.url))).digest('hex')]))
const before = hashes()
console.log('DEPENDENCIES_BEFORE ' + JSON.stringify(before))
test.after(() => { const after = hashes(); console.log('DEPENDENCIES_AFTER ' + JSON.stringify(after)); assert.deepEqual(after, before) })
const saved = () => ({
  version: 1, computerId: 'computer-a',
  trees: [{ id: 'tree-a', createdAt: 'created', updatedAt: 'updated' }],
  nodes: [{ id: 'node-a', treeId: 'tree-a', parentId: null, role: '', message: '', status: 'draft',
    sessionId: null, createdAt: 'created', updatedAt: 'updated' }],
})
function reader(record) {
  return createSavedDraftGraphReader({ parseFleetTrees, fleetTreesStorageKey, readRecord: key => {
    assert.equal(key, fleetTreesStorageKey('computer-a'))
    return typeof record === 'string' ? record : JSON.stringify(record)
  } })
}
test('canonical reader returns the actual whole saved draft and storage identity', () => {
  const graph = saved()
  assert.deepEqual(reader(graph)('computer-a'), parseFleetTrees(graph, { computerId: 'computer-a' }))
})

test('packaged MAIN reads canonical saved trees without a source directory', async t => {
  const packagedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'saved-tree-package-'))
  t.after(() => fs.rm(packagedRoot, { recursive: true, force: true }))
  await fs.mkdir(path.join(packagedRoot, 'shell'))
  await fs.copyFile(new URL('../../shell/saved-draft-graph-reader.cjs', import.meta.url), path.join(packagedRoot, 'shell', 'saved-draft-graph-reader.cjs'))
  await buildMainRuntime({ outdir: path.join(packagedRoot, 'dist', 'main') })
  const { loadSavedDraftGraphReader } = require(path.join(packagedRoot, 'shell', 'saved-draft-graph-reader.cjs'))
  let graph = saved()
  const read = await loadSavedDraftGraphReader({ packaged: true, readRecord: key => {
    assert.equal(key, fleetTreesStorageKey('computer-a'))
    return JSON.stringify(graph)
  } })
  assert.deepEqual(read('computer-a'), parseFleetTrees(graph, { computerId: 'computer-a' }))
  graph = { ...graph, version: 9000 }
  assert.throws(() => read('computer-a'), { code: 'IMAGE_DRAFT_GRAPH_UNAVAILABLE' })
  await assert.rejects(fs.stat(path.join(packagedRoot, 'src')), { code: 'ENOENT' })
})
test('a locally valid draft cannot authorize a malformed whole canvas', () => {
  const mutations = [
    graph => { graph.version = 9000 },
    graph => { graph.computerId = 'different-computer' },
    graph => { graph.nodes.push({ ...graph.nodes[0] }) },
    graph => { graph.nodes.push({ ...graph.nodes[0], id: 'bad-child', parentId: 'absent-parent' }) },
    graph => { graph.nodes[0].parentId = graph.nodes[0].id },
    graph => { graph.nodes[0].status = 'running'; graph.nodes[0].sessionId = null },
    graph => { graph.trees[0].updatedAt = null },
  ]
  for (const mutate of mutations) {
    const graph = saved(); mutate(graph)
    assert.throws(() => reader(graph)('computer-a'), { code: 'IMAGE_DRAFT_GRAPH_UNAVAILABLE' })
  }
})
test('missing broken and asynchronous saved records refuse rather than substitute an empty writable graph', () => {
  for (const record of [null, {}, '{broken']) {
    assert.throws(() => reader(record)('computer-a'), { code: 'IMAGE_DRAFT_GRAPH_UNAVAILABLE' })
  }
  const read = createSavedDraftGraphReader({ parseFleetTrees, fleetTreesStorageKey, readRecord: () => Promise.resolve(saved()) })
  assert.throws(() => read('computer-a'), { code: 'IMAGE_DRAFT_GRAPH_UNAVAILABLE' })
})
test('canonical unknown status quarantine is preserved, not converted into an eligible draft', () => {
  const graph = saved(); graph.nodes[0].status = 'future-status'
  const parsed = reader(graph)('computer-a')
  assert.equal(parsed.nodes[0].status, NODE_STATUS_UNREADABLE)
  assert.notEqual(parsed.nodes[0].status, 'draft')
})
