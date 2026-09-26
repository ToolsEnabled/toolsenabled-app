import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TREE_CONTEXT_CARDS_KEY, TREE_CONTEXT_BOX_SIZE_KEY, TREE_CONTEXT_CARDS_EVENT, TREE_CONTEXT_SIZES, treeContextKey, agentTreeContextKey, readTreeContextCards, updateTreeContextCards, treeContextProfile } from '../../src/tree-context-cards.js'
import { createTreeContextSettings } from '../../src/tree-context-settings.js'
import { createSettingsDraft } from '../../src/settings-draft.js'
import { StaticTreeGraph } from '../../src/tree-graph.js'
import { layoutTree } from '../../src/tree-layout.js'
import { TREE_CONTEXT_SIZE_KEY, treeCardSize } from '../../src/tree-box-layout.js'
import { TreeScope } from '../../src/tree-scope.js'
import { createDocument } from './lib/dom-stand-in.mjs'

function storage(raw = null, legacy = null) {
  return { raw, legacy, boxMemory: null, memoryWrites: 0, writes: 0, failRead: false, failWrite: false,
    getItem(key) { if (this.failRead) throw new Error('Busy'); if (key === TREE_CONTEXT_SIZE_KEY) return this.legacy; if (key === TREE_CONTEXT_BOX_SIZE_KEY) return this.boxMemory; assert.equal(key, TREE_CONTEXT_CARDS_KEY); return this.raw },
    setItem(key, value) { if (this.failWrite) throw new Error('Full'); if (key === TREE_CONTEXT_BOX_SIZE_KEY) { this.memoryWrites++; this.boxMemory = value; return }; assert.equal(key, TREE_CONTEXT_CARDS_KEY); this.writes++; this.raw = value },
  }
}
const a = treeContextKey('computer-a', 'tree-a'), b = treeContextKey('computer-a', 'tree-b'), other = treeContextKey('computer-b', 'tree-a')
const read = store => readTreeContextCards(store).record
function fixture({ store = storage(), staged = true } = {}) {
  const root = createDocument().createElement('main'), events = new EventTarget()
  const draft = staged ? createSettingsDraft() : null
  const controller = createTreeContextSettings({ draft, storage: () => store, eventTarget: events })
  const render = () => { root.innerHTML = controller.markup(); controller.afterRender(root) }
  controller.bind(root); render()
  const select = () => root.querySelector('[data-tree-context-size]')
  return { root, store, draft, controller, render, select, events,
    edit(value) { select().value = value; select().dispatchEvent({ type: 'change' }) },
    reset() { root.querySelector('[data-tree-context-reset]').click() },
    async save() { await draft.save(); controller.refreshSaved() },
    notice: () => root.querySelector('[data-tree-context-notice]').textContent,
  }
}

test('opening preserves Medium without writing; all four sizes use the finalized shared geometry', () => {
  const store = storage(), result = readTreeContextCards(store)
  assert.equal(result.ok, true); assert.equal(store.writes, 0)
  assert.equal(treeContextProfile(result.record).value, 'medium')
  assert.deepEqual(TREE_CONTEXT_SIZES.map(row => row.value), ['mini', 'small', 'medium', 'large', 'off'])
  for (const row of TREE_CONTEXT_SIZES.filter(row => row.value !== 'off')) {
    assert.deepEqual({ width: row.width, height: row.height }, treeCardSize(row.value))
  }
  assert.deepEqual(TREE_CONTEXT_SIZES.slice(0, -1).map(row => row.width), [224, 260, 280, 380])
  /* The line budgets are keyed by size id now rather than indexed by position
     in the geometry table, which is what made removing a size safe: read
     positionally, deleting `mini` would have slid Small onto Mini's one chat
     line and Medium onto Small's two, silently. */
  for (const row of TREE_CONTEXT_SIZES.slice(0, -1)) {
    assert.equal(Number.isInteger(row.chatLines), true,
      `mutation \`index the line budgets by position again\` survived: ${row.value} has no chat-line budget of its own`)
  }
  assert.ok(TREE_CONTEXT_SIZES[2].chatLines > TREE_CONTEXT_SIZES[1].chatLines)
  assert.equal(TREE_CONTEXT_SIZES.at(-1).height, 0)
  const f = fixture({ store }); assert.equal(f.select().value, 'medium'); assert.equal(store.writes, 0); f.controller.destroy()
  assert.equal(f.controller.matches('large cards'), true); assert.equal(f.controller.matches('cards unknown'), false)
})

test('all four sizes and Off reopen per tree without changing other trees or computers', () => {
  const store = storage()
  for (const size of ['mini', 'small', 'medium', 'large', 'off']) {
    assert.equal(updateTreeContextCards({ treeKeys: [a], size }, { storage: store }).ok, true)
    assert.equal(treeContextProfile(read(store), a).value, size)
    assert.equal(treeContextProfile(read(store), b).value, 'medium')
    assert.equal(treeContextProfile(read(store), other).value, 'medium')
  }
  assert.equal(updateTreeContextCards({ defaultSize: 'small' }, { storage: store }).ok, true)
  assert.equal(treeContextProfile(read(store), a).value, 'off')
  assert.equal(treeContextProfile(read(store), b).value, 'small')
  updateTreeContextCards({ treeKeys: [a], size: 'default' }, { storage: store })
  assert.equal(treeContextProfile(read(store), a).value, 'small')
  assert.deepEqual(read(store).trees, {})
  assert.equal(agentTreeContextKey('computer-a', { treeNode: { treeId: 'tree-a' } }), a)
  assert.notEqual(treeContextKey('a:b', 'c'), treeContextKey('a', 'b:c'))
})

test('the legacy size preference is a read-only fallback until canonical policy exists', () => {
  for (const size of ['small', 'medium', 'large']) {
    const store = storage(null, size)
    assert.equal(readTreeContextCards(store).record.defaultSize, size)
    assert.equal(store.writes, 0)
    assert.equal(updateTreeContextCards({ treeKeys: [a], size: 'off' }, { storage: store }).ok, true)
    store.legacy = 'large'
    assert.equal(readTreeContextCards(store).record.defaultSize, size, 'a later legacy write cannot override canonical policy')
    assert.equal(treeContextProfile(read(store), a).value, 'off')
    assert.equal(store.writes, 1)
  }
  assert.equal(readTreeContextCards(storage(), 'large').record.defaultSize, 'large', 'an unsaved mounted view may supply its initial size')
})

test('collapsed groups inherit their actual trees and never invent an organisation policy', () => {
  const nodes = [{ id: 'root', parentId: null, treeId: 'tree-a' },
    ...Array.from({ length: 30 }, (_, i) => ({ id: `child-${i}`, parentId: 'root', treeId: 'tree-a' })),
    { id: 'other', parentId: null, treeId: 'tree-b' }]
  const scope = new TreeScope(nodes)
  const group = scope.group('root', nodes.slice(1, -1).map(node => node.id))
  const mixed = scope.group(null, ['root', 'other'])
  const policy = { version: 1, defaultSize: 'medium', trees: { [a]: 'off', [b]: 'large' } }
  const graph = Object.assign(Object.create(StaticTreeGraph.prototype), { computer: { id: 'computer-a', agents: nodes },
    _contextPolicy: policy, _scopeModel: () => scope, _layoutAgents: () => [group] })
  assert.deepEqual(graph._contextTreeKeys(), [a])
  assert.equal(graph._contextCardProfile(group).value, 'off')
  assert.deepEqual(new Set(graph._contextTreeKeys([mixed])), new Set([a, b]))
  assert.equal(graph._contextCardProfile(mixed).value, 'large')
  assert.equal(graph._contextCardProfile(mixed, { ...policy, trees: { [a]: 'off', [b]: 'off' } }).value, 'off')
  assert.equal(graph._contextCardProfile(group, { ...policy, trees: { [a]: 'small' } }).value, 'small')
})

test('malformed policy and storage failures preserve bytes and never replace saved choices', () => {
  for (const raw of ['{broken', 'null', '[]', JSON.stringify({ version: 2, defaultSize: 'medium', trees: {} }), JSON.stringify({ version: 1, defaultSize: 'huge', trees: {} }), JSON.stringify({ version: 1, defaultSize: 'small', trees: { unsafe: 'large' } }), ' '.repeat(30001)]) {
    const store = storage(raw)
    assert.equal(readTreeContextCards(store).ok, false)
    assert.equal(updateTreeContextCards({ defaultSize: 'off' }, { storage: store }).ok, false)
    assert.equal(store.raw, raw); assert.equal(store.writes, 0)
  }
  const store = storage(); store.failRead = true
  assert.equal(updateTreeContextCards({ defaultSize: 'off' }, { storage: store }).ok, false)
  assert.equal(readTreeContextCards(null).ok, false)
  store.failRead = false; store.failWrite = true
  assert.equal(updateTreeContextCards({ defaultSize: 'off' }, { storage: store }).ok, false)
  assert.equal(read(store).defaultSize, 'medium'); assert.equal(store.raw, null)
})

test('invalid edits are rejected, no-op changes do not write or publish, successful changes publish once', () => {
  const store = storage(), events = new EventTarget(); let published = 0
  events.addEventListener(TREE_CONTEXT_CARDS_EVENT, () => published++)
  const options = { storage: store, eventTarget: events }
  for (const change of [null, [], { unknown: true }, { defaultSize: '' }, { defaultSize: null }, { size: 'bad' }, { treeKeys: [a] }, { treeKeys: [] }, { treeKeys: ['invalid'], size: 'large' }, { resetTrees: 'yes' }]) {
    assert.equal(updateTreeContextCards(change, options).ok, false, JSON.stringify(change))
  }
  for (const change of [{}, { defaultSize: 'medium' }, { resetTrees: true }, { treeKeys: [a], size: 'default' }]) assert.equal(updateTreeContextCards(change, options).ok, true)
  assert.equal(store.writes, 0); assert.equal(published, 0)
  updateTreeContextCards({ defaultSize: 'large' }, options)
  assert.equal(store.writes, 1); assert.equal(published, 1)
})

test('tree override capacity refusal preserves prior choices, while explicit reset restores room', () => {
  const store = storage()
  const treeKeys = Array.from({ length: 512 }, (_, i) => treeContextKey('c', 'tree-' + i))
  assert.equal(updateTreeContextCards({ treeKeys, size: 'small' }, { storage: store }).ok, true)
  const old = store.raw
  assert.equal(updateTreeContextCards({ treeKeys: [a], size: 'off' }, { storage: store }).ok, false)
  assert.equal(store.raw, old)
  assert.equal(updateTreeContextCards({ resetTrees: true, treeKeys: [a], size: 'off' }, { storage: store }).ok, true)
  assert.deepEqual(read(store).trees, { [a]: 'off' })
})

test('Settings drafts survive category revisits; discard and reversion write nothing', () => {
  const f = fixture()
  f.edit('large'); assert.equal(f.draft.dirty, true); assert.equal(f.store.writes, 0)
  f.root.innerHTML = '<section>Other category</section>'; f.controller.afterRender(f.root)
  f.render(); assert.equal(f.select().value, 'large')
  f.draft.discard(); f.render(); assert.equal(f.select().value, 'medium'); assert.equal(f.store.writes, 0)
  f.edit('off'); f.edit('medium'); assert.equal(f.draft.dirty, false); assert.equal(f.store.writes, 0)
  f.controller.destroy()
})

test('Settings Save merges current tree overrides, and reset is staged until Save', async () => {
  const f = fixture(); f.edit('large')
  updateTreeContextCards({ treeKeys: [a], size: 'off' }, { storage: f.store, eventTarget: f.events })
  assert.equal(f.select().value, 'large')
  await f.save(); assert.equal(read(f.store).defaultSize, 'large'); assert.equal(read(f.store).trees[a], 'off')
  f.reset(); assert.equal(read(f.store).trees[a], 'off'); assert.equal(f.draft.dirty, true)
  f.draft.discard(); f.render(); assert.match(f.root.querySelector('[data-tree-context-overrides]').textContent, /1 tree has/)
  f.reset(); await f.save(); assert.deepEqual(read(f.store).trees, {}); assert.equal(read(f.store).defaultSize, 'large')
  f.controller.destroy()
})

test('failed Settings writes retain the draft and prior active sizes through retry and partial Save', async () => {
  const f = fixture(); let earlier = 0
  f.draft.stage('earlier', true, () => { earlier++; return { ok: true } }); f.edit('off'); f.store.failWrite = true
  await assert.rejects(f.save(), /could not be saved/)
  assert.equal(earlier, 1); assert.equal(f.draft.dirty, true); assert.equal(read(f.store).defaultSize, 'medium')
  f.render(); assert.equal(f.select().value, 'off')
  f.store.failWrite = false; await f.save(); assert.equal(earlier, 1); assert.equal(read(f.store).defaultSize, 'off'); assert.equal(f.draft.dirty, false)
  f.controller.destroy()
})

test('invalid selection blocks the shared Save; read errors disable controls and recover on revisit', async () => {
  const f = fixture(); f.edit('invalid'); assert.equal(f.draft.valid, false)
  await assert.rejects(f.save(), /Choose/); assert.equal(f.store.writes, 0)
  f.edit('small'); assert.equal(f.draft.valid, true); await f.save()
  f.store.failRead = true; f.render(); assert.equal(f.root.querySelector('[data-tree-context-fields]').disabled, true)
  assert.match(f.notice(), /could not be read/)
  f.store.failRead = false; f.render(); assert.equal(f.root.querySelector('[data-tree-context-fields]').disabled, false); assert.equal(f.select().value, 'small')
  f.controller.destroy()
})

test('standalone controller reports failed writes and saves a later valid choice', () => {
  const f = fixture({ staged: false }); f.store.failWrite = true; f.edit('off')
  assert.match(f.notice(), /could not be saved/); assert.equal(read(f.store).defaultSize, 'medium')
  f.store.failWrite = false; f.edit('small'); assert.equal(read(f.store).defaultSize, 'small')
  f.controller.destroy()
})

test('native filesystem persistence reopens each choice without touching an existing profile', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-context-settings-test-')); t.after(() => fs.rmSync(folder, { recursive: true, force: true }))
  const file = key => path.join(folder, encodeURIComponent(key) + '.json')
  const adapter = () => ({ getItem: key => fs.existsSync(file(key)) ? fs.readFileSync(file(key), 'utf8') : null, setItem: (key, raw) => fs.writeFileSync(file(key), raw) })
  for (const size of ['mini', 'small', 'medium', 'large', 'off']) {
    assert.equal(updateTreeContextCards({ defaultSize: size, treeKeys: [a], size }, { storage: adapter() }).ok, true)
    assert.equal(read(adapter()).defaultSize, size); assert.equal(treeContextProfile(read(adapter()), a).value, size)
  }
})

test('card spacing grows with the selected size, retaining every agent, hierarchy and readable node radius', () => {
  const nodes = [{ id: 'root', role: 'controller' }, ...Array.from({ length: 50 }, (_, i) => ({ id: 'n-' + i, role: 'worker', parentId: 'root' }))]
  let previous = 0
  for (const profile of [TREE_CONTEXT_SIZES.at(-1), ...TREE_CONTEXT_SIZES.slice(0, -1)]) {
    const layout = layoutTree({ nodes, spacious: true, contextWidth: profile.width, W: 900, H: 600 })
    assert.equal(layout.slots.size, nodes.length); assert.equal(layout.culled.size, 0)
    assert.equal(layout.parents.get('n-0'), 'root')
    const xs = [...layout.slots.values()].map(point => point.x), span = Math.max(...xs) - Math.min(...xs)
    assert.ok(span > previous); previous = span
    assert.ok([...layout.radii.values()].every(radius => radius >= 30))
  }
})

test('Off skips context feed and placement geometry while nodes and open conversation remain available', () => {
  const document = createDocument(), record = { id: 'a', agent: { id: 'a' }, x: 100, y: 100, r: 30, chip: document.createElement('div'), chatOpen: true }
  record.chip.classList.add('screen-chip-visible')
  const graph = Object.assign(Object.create(StaticTreeGraph.prototype), { screenChips: true, screenOverlay: {}, editMode: false, W: 800, H: 600,
    zoomHost: { clientWidth: 800, clientHeight: 600, getBoundingClientRect() { throw new Error('Off must not measure labels') } },
    nodes: new Map([['a', record]]), _culled: new Set(), _layoutVisibleIds: new Set(['a']), panX: 0, panY: 0, zoom: 1,
    _contextPolicy: { version: 1, defaultSize: 'off', trees: {} }, _screenContext() { throw new Error('Off must not read feed') }, panHint: document.createElement('span'),
  })
  assert.equal(graph._renderChipPreview(record), false); graph._placeChips()
  assert.equal(record.chip.classList.contains('screen-chip-visible'), false); assert.equal(record.chip.tabIndex, -1)
  assert.equal(graph.nodes.size, 1); assert.equal(record.chatOpen, true); assert.match(graph.panHint.textContent, /0 previews/)
})

test('circle policy updates repaint visible cards without changing hierarchy or camera', () => {
  let placements = 0
  const graph = Object.assign(Object.create(StaticTreeGraph.prototype), { computer: { id: 'computer-a' }, cardSize: 'medium',
    container: createDocument().createElement('div'), nodeStyle: 'circles', panX: 21, panY: 35, zoom: 1.3,
    _contextPolicy: read(storage()), nodes: new Map(), _layoutAgents: () => [{ treeId: 'tree-a' }],
    _placeChips: () => placements++, _layoutNow: () => assert.fail('circle size must not relayout the hierarchy'),
  })
  graph._applyContextCardPolicy({ version: 1, defaultSize: 'medium', trees: { [b]: 'large' } }); assert.equal(placements, 0)
  graph._applyContextCardPolicy({ version: 1, defaultSize: 'small', trees: { [b]: 'large' } }); assert.equal(placements, 1)
  assert.equal(graph._contextCardProfile({ treeId: 'tree-a' }).value, 'small')
  assert.deepEqual([graph.panX, graph.panY, graph.zoom], [21, 35, 1.3])
  assert.equal(graph.cardSize, 'small')
  graph._destroyed = true
  graph._applyContextCardPolicy({ version: 1, defaultSize: 'large', trees: {} })
  assert.equal(graph.cardSize, 'small', 'destroyed views ignore deferred setting changes')
})

test('lane placement retains hard node and label collision protection while fitting more named cards', () => {
  const graph = Object.assign(Object.create(StaticTreeGraph.prototype), { panX: 0, panY: 0, zoom: 1 })
  const records = Array.from({ length: 5 }, (_, i) => ({ id: 'node-' + i, x: 100 + i * 160, y: 420, r: 30, agent: { role: 'worker' } }))
  const dimensions = new Map(records.map(record => [record.id, { width: 220, height: 112 }]))
  const obstacles = records.map(record => ({ x: record.x - 35, y: record.y - 35, w: 70, h: 110, weight: 5 }))
  const slots = graph._electChipSlots(records, dimensions, obstacles, 950, 800)
  assert.equal(slots.size, 5)
  const intersects = (x, y) => Math.min(x.x + x.w, y.x + y.w) > Math.max(x.x, y.x) && Math.min(x.y + x.h, y.y + y.h) > Math.max(x.y, y.y)
  for (const slot of slots.values()) assert.equal(obstacles.some(box => intersects(slot, box)), false)
  const boxes = [...slots.values()]
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.equal(intersects(boxes[i], boxes[j]), false)
})

// Defaults and per-tree overrides use the same registry and preserve saved Mini choices.
test('saved Mini defaults and overrides reopen without rewriting owner choices', () => {
  const raw = JSON.stringify({ version: 1, defaultSize: 'mini', trees: { [a]: 'mini', [b]: 'large' } })
  const store = storage(raw)
  const result = readTreeContextCards(store)
  assert.equal(result.ok, true)
  assert.equal(result.record.defaultSize, 'mini')
  assert.equal(treeContextProfile(result.record, a).value, 'mini')
  assert.equal(treeContextProfile(result.record, b).value, 'large')
  assert.equal(store.writes, 0)
  assert.equal(store.raw, raw)
  assert.equal(updateTreeContextCards({ defaultSize: 'medium' }, { storage: store }).ok, true)
  assert.equal(JSON.parse(store.raw).trees[a], 'mini', 'saving another choice does not remap Mini')
})

test('Mini can be selected again and survives a per-tree settings save', () => {
  const store = storage()
  assert.equal(updateTreeContextCards({ treeKeys: [a], size: 'mini' }, { storage: store }).ok, true)
  assert.equal(treeContextProfile(readTreeContextCards(store).record, a).value, 'mini')
  assert.equal(treeContextProfile(readTreeContextCards(store).record, b).value, 'medium')
})

test('an unknown size remains a damaged record', () => {
  const store = storage(JSON.stringify({ version: 1, defaultSize: 'huge', trees: {} }))
  assert.equal(readTreeContextCards(store).ok, false,
    'mutation `resolve every unknown id to a live size` survived: expected a value that never named a size to remain the damaged-record case, which is a different fact and a different answer')
})
