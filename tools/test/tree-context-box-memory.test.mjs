import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import * as cards from '../../src/tree-context-cards.js'
import { TREE_CONTEXT_SIZE_KEY } from '../../src/tree-box-layout.js'

const BOX_KEY = 'mc.tree.context-box-size.v1'
const { createRendererPrefs, MAX_VALUE_LENGTH } = createRequire(import.meta.url)('../../shell/renderer-prefs.cjs')
const key = cards.treeContextKey('computer', 'tree')
const policy = (defaultSize, trees = {}) => JSON.stringify({ version: 1, defaultSize, trees })
function storage(raw = null, legacy = null, companion = null) {
  const values = new Map([[cards.TREE_CONTEXT_CARDS_KEY, raw], [TREE_CONTEXT_SIZE_KEY, legacy], [BOX_KEY, companion]])
  return { values, writes: [], failKey: null,
    getItem(name) { if (this.failReadKey === name) throw Error('Unreadable'); return values.get(name) ?? null },
    setItem(name, value) { if (this.failKey === name) throw Error('Full'); this.writes.push(name); values.set(name, value) },
  }
}
const read = store => cards.readTreeContextCards(store)
const save = (store, change, eventTarget) => cards.updateTreeContextCards(change, { storage: store, eventTarget })

test('legacy Off resolves one durable fallback independent of the mounted initial size; reads never write', () => {
  for (const [legacy, expected] of [[null, 'medium'], ['large', 'large'], ['small', 'small'], ['mini', 'mini'], ['invalid', 'medium']]) {
    const store = storage(policy('off'), legacy)
    for (const mountedSize of ['small', 'large']) {
      const result = cards.readTreeContextCards(store, mountedSize)
      assert.equal(result.ok, true); assert.equal(result.boxSize, expected)
      assert.equal(result.record.defaultSize, 'off')
    }
    assert.deepEqual(store.writes, [])
  }
  const unreadableLegacy = storage(policy('off'), 'large'); unreadableLegacy.failReadKey = TREE_CONTEXT_SIZE_KEY
  assert.equal(read(unreadableLegacy).ok, true); assert.equal(read(unreadableLegacy).boxSize, 'medium')
  assert.equal(read(storage(policy('small'), 'large')).boxSize, 'small')
  assert.equal(read(storage(policy('mini'), 'large')).boxSize, 'mini')
})

test('Off keeps the last explicit box size through per-tree edits and reset without extending the strict v1 record', () => {
  const store = storage()
  assert.equal(save(store, { defaultSize: 'large' }).ok, true)
  assert.equal(save(store, { defaultSize: 'off' }).ok, true)
  for (const change of [{ treeKeys: [key], size: 'small' }, { resetTrees: true }, { treeKeys: [key], size: 'off' }]) {
    assert.equal(save(store, change).ok, true)
    const result = read(store)
    assert.equal(result.boxSize, 'large'); assert.equal(result.record.defaultSize, 'off')
    const persisted = JSON.parse(store.values.get(cards.TREE_CONTEXT_CARDS_KEY))
    assert.deepEqual(Object.keys(persisted).sort(), ['defaultSize', 'trees', 'version'])
    assert.equal(persisted.version, 1)
    assert.deepEqual(persisted, result.record, 'older strict v1 readers receive the original exact schema')
  }
  assert.equal(store.values.get(TREE_CONTEXT_SIZE_KEY), null)
  store.values.set(TREE_CONTEXT_SIZE_KEY, 'small')
  assert.equal(read(store).boxSize, 'large', 'a later legacy-key write cannot replace a bound saved choice')
  assert.equal(save(store, { defaultSize: 'small' }).ok, true)
  assert.equal(save(store, { defaultSize: 'off' }).ok, true)
  assert.equal(read(store).boxSize, 'small')
})

test('old-version edits stay readable and cannot use a companion bound to different v1 content', () => {
  const store = storage(null, 'small')
  save(store, { defaultSize: 'large' }); save(store, { defaultSize: 'off' })
  store.values.set(cards.TREE_CONTEXT_CARDS_KEY, policy('off', { [key]: 'large' }))
  assert.equal(read(store).ok, true); assert.equal(read(store).boxSize, 'small')
  store.values.set(cards.TREE_CONTEXT_CARDS_KEY, policy('medium'))
  assert.equal(read(store).boxSize, 'medium')
  assert.equal(save(store, { defaultSize: 'off' }).ok, true)
  assert.equal(read(store).boxSize, 'medium')
  assert.ok(JSON.parse(store.values.get(BOX_KEY)).entries.length <= 2)
})

test('malformed companion data refuses replacement and leaves both preferences byte-identical', () => {
  const validEntry = { policy: JSON.parse(policy('off')), size: 'large' }
  for (const companion of ['{broken', 'null', JSON.stringify({ version: 2, entries: [] }),
    JSON.stringify({ version: 1, entries: [{ ...validEntry, size: 'off' }] }),
    JSON.stringify({ version: 1, entries: [{ ...validEntry, size: ['large'] }] }),
    JSON.stringify({ version: 1, entries: [{ ...validEntry, size: null }] }),
    JSON.stringify({ version: 1, entries: [validEntry, validEntry] }),
    JSON.stringify({ version: 1, entries: [{ ...validEntry, extra: true }] }),
    JSON.stringify({ version: 1, entries: [{ ...validEntry, policy: JSON.parse(policy('small')) }] }),
    ' '.repeat(65537)]) {
    const store = storage(policy('off'), null, companion), before = [...store.values]
    assert.equal(read(store).ok, false, companion.slice(0, 100))
    assert.equal(save(store, { defaultSize: 'large' }).ok, false)
    assert.deepEqual([...store.values], before); assert.deepEqual(store.writes, [])
  }
  const unreadable = storage(policy('off')); unreadable.failReadKey = BOX_KEY
  assert.equal(read(unreadable).ok, false)
})

test('either failed write preserves the prior active policy and box size, and retry publishes exactly once', () => {
  for (const startingOff of [false, true]) for (const failKey of [BOX_KEY, cards.TREE_CONTEXT_CARDS_KEY]) {
    const store = storage(), events = new EventTarget(); let published = 0
    events.addEventListener(cards.TREE_CONTEXT_CARDS_EVENT, () => published++)
    save(store, { defaultSize: 'large' })
    if (startingOff) save(store, { defaultSize: 'off', treeKeys: [key], size: 'small' })
    const before = read(store), rawBefore = store.values.get(cards.TREE_CONTEXT_CARDS_KEY)
    const change = startingOff ? { resetTrees: true } : { defaultSize: 'off' }
    store.failKey = failKey
    assert.equal(save(store, change, events).ok, false)
    assert.equal(store.values.get(cards.TREE_CONTEXT_CARDS_KEY), rawBefore)
    assert.deepEqual(read(store).record, before.record); assert.equal(read(store).boxSize, before.boxSize)
    assert.equal(published, 0)
    store.failKey = null
    assert.equal(save(store, change, events).ok, true)
    assert.equal(read(store).boxSize, 'large'); assert.equal(read(store).record.defaultSize, 'off')
    assert.equal(published, 1)
  }
})

test('companion preparation is inert to readers until the matching v1 policy commits', () => {
  const store = storage()
  save(store, { defaultSize: 'large' }); save(store, { defaultSize: 'off', treeKeys: [key], size: 'small' })
  const before = read(store), set = store.setItem.bind(store), observations = []
  store.setItem = (name, value) => { set(name, value); observations.push({ name, state: read(store) }) }
  assert.equal(save(store, { resetTrees: true }).ok, true)
  assert.deepEqual(observations.map(row => row.name), [BOX_KEY, cards.TREE_CONTEXT_CARDS_KEY])
  assert.deepEqual(observations[0].state.record, before.record)
  assert.equal(observations[0].state.boxSize, 'large')
  assert.deepEqual(observations[1].state.record.trees, {})
  assert.equal(observations[1].state.boxSize, 'large')
})

test('no-op saves do not create companion data or events', () => {
  for (const raw of [null, policy('off')]) {
    const store = storage(raw)
    const before = read(store)
    assert.equal(save(store, {}).ok, true)
    assert.equal(save(store, { defaultSize: before.record.defaultSize }).ok, true)
    assert.deepEqual(store.writes, []); assert.equal(store.values.get(BOX_KEY), null)
  }
})

test('near-capacity escaped policies preserve Mini and reopen from the actual native store', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'te-box-memory-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const open = () => {
    const prefs = createRendererPrefs({ directory, fs, path, randomUUID })
    return { prefs, getItem: name => prefs.snapshot().values[name] ?? null,
      setItem(name, value) { const result = prefs.set(name, value); if (!result.ok) throw Error(result.error.message) },
    }
  }
  let store = open()
  const rows = Array.from({ length: 512 }, (_, i) => [String(i) + '"\\'.repeat(4), 0])
  const rawFor = () => policy('off', Object.fromEntries(rows.map(([id, padding]) => [cards.treeContextKey('c', id + 'x'.repeat(padding)), 'mini'])))
  const padding = 29990 - rawFor().length
  assert.ok(padding > 0)
  for (let i = 0; i < padding; i++) rows[i % rows.length][1]++
  const original = rawFor()
  assert.ok(original.length <= 30000)
  store.setItem(cards.TREE_CONTEXT_CARDS_KEY, original)
  store.setItem(TREE_CONTEXT_SIZE_KEY, 'large')
  assert.equal(JSON.stringify(read(store).record), original, 'saved Mini choices remain byte-identical')
  const trees = Object.keys(read(store).record.trees)
  // Retain two near-capacity policies to exercise the native companion limit.
  assert.equal(save(store, { treeKeys: trees.slice(0, 16), size: 'default' }).ok, true)
  const memory = store.getItem(BOX_KEY)
  assert.ok(memory.length > 58000 && memory.length < MAX_VALUE_LENGTH)
  store = open()
  assert.equal(read(store).ok, true); assert.equal(read(store).boxSize, 'large')
  assert.equal(Object.keys(read(store).record.trees).length, 496)
  assert.equal(save(store, { resetTrees: true }).ok, true)
  store = open()
  assert.equal(read(store).boxSize, 'large'); assert.deepEqual(read(store).record.trees, {})
})
