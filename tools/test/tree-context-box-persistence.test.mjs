import assert from 'node:assert/strict'
import test from 'node:test'
import { StaticTreeGraph } from '../../src/tree-graph.js'
import { createTreeContextSettings } from '../../src/tree-context-settings.js'
import { createSettingsDraft } from '../../src/settings-draft.js'
import { TREE_CONTEXT_CARDS_KEY, treeContextKey, updateTreeContextCards } from '../../src/tree-context-cards.js'
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
    return {
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

test('Settings Large -> Off keeps identical box geometry in two mounted graphs and after remount', async t => {
  const f = await fixture(t), settings = f.mountSettings()
  const first = f.mount('one'), second = f.mount('two')
  assertBox(first, 'medium'); assertBox(second, 'medium')
  await settings.save('large')
  assertBox(first, 'large'); assertBox(second, 'large')
  await settings.save('off')
  assertBox(first, 'large'); assertBox(second, 'large')
  const raw = f.storage.getItem(TREE_CONTEXT_CARDS_KEY)
  assert.equal(f.storage.getItem(TREE_CONTEXT_SIZE_KEY), null, 'Settings must exercise canonical-only persistence')
  first.destroy()
  const reopened = f.mount('one')
  assert.equal(f.storage.getItem(TREE_CONTEXT_CARDS_KEY), raw, 'remount must not rewrite settings')
  assertBox(reopened, 'large')
  assertBox(second, 'large')
  assert.equal(reopened._contextCardProfile({ treeId: 'one' }).value, 'off')
  assert.equal(second._contextCardProfile({ treeId: 'two' }).value, 'off')
})
