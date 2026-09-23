import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { createRendererPrefs } from '../../shell/renderer-prefs.cjs'
import { createFleetTreeStore, fleetTreesStorageKey, safeTreeStorage, parseFleetTrees } from '../../src/fleet-trees.js'

test('1,000 synthetic staged nodes survive the actual durable preference writer and a new tree-store instance', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'te-resource-tree-scale-'))
  // Caller supplies an explicitly fenced Temp in the test invocation. No app,
  // provider, account or owner record is opened by this fixture.
  const stamp = '2026-09-04T20:00:00.000Z'
  const record = { version: 1, computerId: 'synthetic-scale', trees: Array.from({ length: 14 }, (_, i) => ({ id: `tree-${i}`, name: `Batch ${i}`, createdAt: stamp, updatedAt: stamp })),
    nodes: Array.from({ length: 1000 }, (_, i) => {
      const tree = Math.floor(i / 73); const local = i % 73; const base = tree * 73
      return { id: `node-${i}`, treeId: `tree-${tree}`, parentId: local === 0 ? null : `node-${base + (local <= 8 ? 0 : 1 + Math.floor((local - 9) / 8))}`,
        role: 'worker', nameOrdinal: i + 1, message: `${i}: Audit a bounded sample. "Preserve identity". ${'Useful synthetic work; '.repeat(40)}`.trim(),
        status: 'draft', statusNote: '', reply: '', sessionId: null, tier: 'sonnet', effort: 'high', createdAt: stamp, updatedAt: stamp }
    }) }
  const serialized = JSON.stringify(record)
  assert.equal(parseFleetTrees(record, 'synthetic-scale').nodes.length, 1000)
  const prefs = createRendererPrefs({ directory, fs, path, randomUUID })
  const key = fleetTreesStorageKey('synthetic-scale')
  const started = performance.now()
  assert.equal(prefs.set(key, serialized).ok, true)
  const reopened = createRendererPrefs({ directory, fs, path, randomUUID })
  const backing = { getItem: name => reopened.snapshot().values[name], setItem(name, text) { const result = reopened.set(name, text); if (!result.ok) throw new Error(result.error?.code) } }
  const store = createFleetTreeStore({ computerId: 'synthetic-scale', storage: safeTreeStorage(backing) })
  assert.equal(store.snapshot().nodes.length, 1000)
  assert.equal(store.getNode('node-999').message, record.nodes[999].message)
  assert.equal(store.setNodeStatus('node-999', 'starting').ok, true)
  assert.equal(store.snapshot().persistenceFailed, false)
  assert.equal(JSON.parse(createRendererPrefs({ directory, fs, path, randomUUID }).snapshot().values[key]).nodes.find(node => node.id === 'node-999').status, 'starting')
  console.log(`Synthetic tree persistence: ${Buffer.byteLength(serialized)} UTF-8 bytes, 1,000 nodes, durable write/reopen/update ${(performance.now() - started).toFixed(1)} ms. No provider process was launched.`)
  assert.equal(prefs.set('mc.ordinary-setting', 'x'.repeat(65537)).ok, false, 'ordinary preferences retain the original cell bound')
  assert.equal(prefs.set('mc.fleet.trees.v1:', 'x'.repeat(65537)).ok, false, 'a malformed tree namespace does not receive the larger envelope')
})
