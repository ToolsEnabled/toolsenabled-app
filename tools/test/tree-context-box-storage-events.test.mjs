import assert from 'node:assert/strict'
import test from 'node:test'
import { StaticTreeGraph } from '../../src/tree-graph.js'
import { createTreeContextSettings } from '../../src/tree-context-settings.js'
import { createSettingsDraft } from '../../src/settings-draft.js'
import { TREE_CONTEXT_CARDS_KEY, TREE_CONTEXT_BOX_SIZE_KEY, treeContextKey, updateTreeContextCards, readTreeContextCards } from '../../src/tree-context-cards.js'
import { readTreeContextSize, TREE_CONTEXT_SIZE_KEY, treeBoxSize } from '../../src/tree-box-layout.js'
import { installWorld, fleetFetch } from './lib/tree-command-real-mount.mjs'

// Real graph constructors, Settings controls and storage/event paths. Only
// browser facilities are substituted; no renderer methods or policy are mocked.
async function fixture(t) {
  const world = await installWorld(fleetFetch(), { asyncFrames: true })
  const style = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle')
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: window.getComputedStyle })
  document.body.classList.add('reduce-motion')
  const graphs = [], settings = []
  t.after(() => {
    for (const graph of graphs) if (!graph._destroyed) graph.destroy()
    for (const controller of settings) controller.destroy()
    world.restore()
    if (style) Object.defineProperty(globalThis, 'getComputedStyle', style)
    else delete globalThis.getComputedStyle
  })
  function mount(id = 'one', nodeStyle = 'boxes') {
    const host = document.createElement('div'), container = document.createElement('div')
    host.clientWidth = 1000; host.clientHeight = 700
    container.clientWidth = 1000; container.clientHeight = 700
    document.body.appendChild(host); host.appendChild(container)
    const agent = { id, name: id, role: 'worker', parentId: null, treeId: id, state: 'finished' }
    const graph = new StaticTreeGraph(container, {
      computer: { id: 'computer', agents: [agent] }, nodeStyle,
      cardSize: readTreeContextSize(), screenChips: true, emptySlots: false,
    })
    graphs.push(graph)
    assert.equal(graph.nodes.size, 1, 'the real graph must mount an agent')
    return graph
  }
  function mountSettings() {
    const root = document.createElement('main')
    document.body.appendChild(root)
    const draft = createSettingsDraft()
    const controller = createTreeContextSettings({ draft, storage: () => world.storage, eventTarget: window })
    root.innerHTML = controller.markup(); controller.bind(root); controller.afterRender(root)
    settings.push(controller)
    return { root, draft,
      async save(size) {
        const select = root.querySelector('[data-tree-context-size]')
        select.value = size; select.dispatch('change')
        await draft.save(); controller.refreshSaved()
      },
      async reset() {
        root.querySelector('[data-tree-context-reset]').click()
        await draft.save(); controller.refreshSaved()
      },
    }
  }
  return { ...world, mount, mountSettings }
}

function assertBox(graph, size) {
  assert.equal(graph.container.dataset.cardSize, size, 'mounted box size')
  assert.equal(graph.container.style.getPropertyValue('--tree-box-width'), `${treeBoxSize(size).width}px`)
  assert.equal(graph.container.style.getPropertyValue('--tree-box-height'), `${treeBoxSize(size).height}px`)
}

test('either failed Settings write preserves both mounted views, the draft and a fresh mount until retry', async t => {
  const f = await fixture(t), settings = f.mountSettings()
  const first = f.mount('one'), second = f.mount('two')
  const set = f.storage.setItem.bind(f.storage)
  for (const failureKey of [TREE_CONTEXT_BOX_SIZE_KEY, TREE_CONTEXT_CARDS_KEY]) {
    await settings.save('large')
    f.storage.setItem = (key, value) => { if (key === failureKey) throw Error('Full'); set(key, value) }
    await assert.rejects(settings.save('off'), /could not be saved/)
    assert.equal(settings.draft.dirty, true)
    assert.equal(settings.root.querySelector('[data-tree-context-size]').value, 'off')
    assertBox(first, 'large'); assertBox(second, 'large')
    assert.equal(first._contextPolicy.defaultSize, 'large')
    assert.equal(second._contextPolicy.defaultSize, 'large')
    const beforeRetry = f.mount('before-retry'); assertBox(beforeRetry, 'large'); beforeRetry.destroy()
    f.storage.setItem = set
    await settings.save('off')
    assert.equal(settings.draft.dirty, false)
    assertBox(first, 'large'); assertBox(second, 'large')
    const reopened = f.mount('reopened'); assertBox(reopened, 'large'); reopened.destroy()
    assert.equal(first._contextPolicy.defaultSize, 'off')
  }
})

test('companion storage event updates box geometry even when final v1 policy bytes are identical', async t => {
  const f = await fixture(t), settings = f.mountSettings()
  const first = f.mount('one'), second = f.mount('two')
  await settings.save('large'); await settings.save('off')
  const oldPolicy = f.storage.getItem(TREE_CONTEXT_CARDS_KEY)
  // A different window writes Small then Off. Its normal custom event is not
  // dispatched in these mounted documents; the browser storage event is.
  assert.equal(updateTreeContextCards({ defaultSize: 'small' }, { storage: f.storage, eventTarget: null }).ok, true)
  assert.equal(updateTreeContextCards({ defaultSize: 'off' }, { storage: f.storage, eventTarget: null }).ok, true)
  assert.equal(f.storage.getItem(TREE_CONTEXT_CARDS_KEY), oldPolicy)
  assertBox(first, 'large'); assertBox(second, 'large')
  window.dispatchEvent({ type: 'storage', key: TREE_CONTEXT_BOX_SIZE_KEY })
  assertBox(first, 'small'); assertBox(second, 'small')
  assertBox(f.mount('reopened'), 'small')
  assert.equal(first._contextPolicy.defaultSize, 'off')
  assert.equal(second._contextPolicy.defaultSize, 'off')
})

test('tree-specific circles and resetting Off overrides preserve remembered boxes through storage events and remount', async t => {
  const f = await fixture(t), settings = f.mountSettings()
  const box = f.mount('one'), circle = f.mount('two', 'circles')
  await settings.save('large'); await settings.save('off')
  const one = treeContextKey('computer', 'one'), two = treeContextKey('computer', 'two')
  assert.equal(updateTreeContextCards({ treeKeys: [one, two], size: 'small' }).ok, true)
  assertBox(box, 'large'); assert.equal(circle.cardSize, 'large')
  assert.equal(circle._contextCardProfile({ treeId: 'two' }).value, 'small')
  await settings.reset()
  assert.deepEqual(readTreeContextCards(f.storage).record.trees, {})
  assertBox(box, 'large'); assert.equal(circle.cardSize, 'large')
  assert.equal(circle._contextCardProfile({ treeId: 'two' }).value, 'off')
  window.dispatchEvent({ type: 'storage', key: TREE_CONTEXT_CARDS_KEY })
  box.destroy(); circle.destroy()
  assertBox(f.mount('one'), 'large')
  const reopenedCircle = f.mount('two', 'circles')
  assert.equal(reopenedCircle.cardSize, 'large')
  assert.equal(reopenedCircle._contextCardProfile({ treeId: 'two' }).value, 'off')
})
