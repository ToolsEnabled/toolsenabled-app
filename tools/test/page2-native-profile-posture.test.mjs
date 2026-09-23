import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { createFleetTreeStore } from '../../src/fleet-trees.js'
import { StaticTreeGraph } from '../../src/tree-graph.js'
import { Element } from './lib/dom-stand-in.mjs'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'

const source = readFileSync(new URL('../lib/page2-native-controls-scenarios.cjs', import.meta.url), 'utf8')

// Run the actual native overview helper and the actual graph root/slot methods.
// Rendering geometry and Playwright input are explicit fixture boundaries;
// this source regression does not claim a real browser or provider action.
function fixture({ drilled = true, details = false, ignoreShowAll = false } = {}) {
  let raw = null
  const store = createFleetTreeStore({ computerId: 'profile-posture',
    storage: { read: () => raw ? JSON.parse(raw) : null, write: (_key, value) => { raw = JSON.stringify(value); return true } } })
  const root = store.addNode({ role: 'manager', tier: 'astra', effort: 'max', message: 'Keep this exact staged Manager.' }).node
  assert.equal(store.setTreeProfile(root.treeId, 'retained-profile').ok, true)
  const record = { id: root.id, agent: root, el: new Element('div'), x: 20, y: 20 }
  const graph = Object.assign(Object.create(StaticTreeGraph.prototype), {
    computer: { agents: [root] }, rootId: drilled ? root.id : null,
    nodes: new Map([[root.id, record]]), emptySlotsEnabled: true, tabbedWorkspace: true, _destroyed: false,
    canExtend: null, _culled: new Set(), _positions: {}, _transitionRevision: 0,
    _layoutNow: () => {}, _renderLinks: () => {}, updateDensity: () => {}, _placeChips: () => {},
    // clearRoot also fits the real canvas. Geometry is outside this fixture;
    // retain the actual root transition and slot planning under test.
    fitToHost: () => false,
  })
  const actions = [], ledger = Buffer.from('unchanged owned start-ledger fixture\n')
  const showAll = { async click() { actions.push('every-tree'); if (!ignoreShowAll) graph.clearRoot() },
    async getAttribute(name) { assert.equal(name, 'aria-pressed'); return String(graph.rootId === null) } }
  const context = { page: {
    url: () => 'file:///fixture/index.html#/computers',
    keyboard: { async press(key) { assert.equal(key, 'Escape'); actions.push('escape') } },
    locator(selector) {
      if (selector === '.tree-chats-toggle') return { async waitFor() {} }
      if (selector === '.stats-page.is-active [data-fleet-show-all]') return showAll
      throw Error('Unexpected native locator: ' + selector)
    },
    getByRole(role, options) {
      if (role === 'button' && options.name === 'Back to the fleet overview') return {
        async isVisible() { return details }, async click() { details = false; actions.push('rail-back') },
      }
      if (role === 'region' && options.name === 'Agent folders') return { async waitFor() { assert.equal(details, false) } }
      throw Error('Unexpected native role: ' + role)
    },
  } }
  const scope = vm.createContext({ assert, URL })
  for (const name of ['computers', 'overview']) vm.runInContext(declaredFunctionSource(source, name), scope)
  const slots = () => graph._planEmptySlots(graph.visibleAgents(), { slots: new Map([[root.id, {}]]), culled: new Set() })
  return { graph, root, store, actions, context, ledger, saved: () => raw, slots, run: () => scope.overview(context) }
}

for (const details of [false, true]) test(`native folder overview leaves a drilled graph through Every tree from the ${details ? 'Details rail' : 'overview rail'}`, async () => {
  const f = fixture({ details }), before = f.saved(), ledgerBefore = Buffer.from(f.ledger)
  assert.equal(f.slots().some(row => row.kind === 'new-tree'), false, 'the actual drilled graph withholds a separate-tree slot')
  await f.run()
  assert.equal(f.graph.rootId, null, 'the native helper must show the full graph for its node-retention checks')
  assert.equal(f.slots().filter(row => row.kind === 'new-tree').length, 0, 'the header remains the separate-tree entry in the overview')
  assert.deepEqual(f.actions, details ? ['escape', 'rail-back', 'every-tree'] : ['escape', 'every-tree'])
  assert.equal(f.saved(), before, 'changing graph posture must retain every saved tree, node and profile byte')
  assert.ok(f.ledger.equals(ledgerBefore))
  assert.equal(f.store.getNode(f.root.id).sessionId, null)
})

test('showing every tree again preserves an already unfiltered graph and its assigned profile', async () => {
  const f = fixture({ drilled: false }), before = f.saved()
  await f.run()
  assert.equal(f.graph.rootId, null)
  assert.equal(f.slots().filter(row => row.kind === 'new-tree').length, 0)
  assert.equal(f.saved(), before)
  assert.equal(f.store.treeProfile(f.root.treeId), 'retained-profile')
})

test('an ignored Every tree action cannot claim that the full graph is visible', async () => {
  const f = fixture({ ignoreShowAll: true }), before = f.saved()
  await assert.rejects(f.run(), /must display every tree/)
  assert.equal(f.graph.rootId, f.root.id)
  assert.equal(f.slots().some(row => row.kind === 'new-tree'), false)
  assert.equal(f.saved(), before)
})
