import assert from 'node:assert/strict'
import test from 'node:test'
import { StaticTreeGraph } from '../../src/tree-graph.js'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

// Linux Chromium reproduced this after clicking + in the page-2 toolbar:
// keyboard +, - and 0 never reached the sibling canvas's keydown listener.
// Exercise the real control construction and event bubbling in both placements.
for (const toolbar of [true, false]) {
  test(`zoom shortcuts work once per press with toolbar ${toolbar ? 'outside' : 'inside'} the host`, t => {
    const { document, restore } = installDomStandIn()
    t.after(restore)
    const pane = document.createElement('div')
    pane.className = 'graph-wrap'
    document.body.appendChild(pane)
    if (toolbar) {
      const tools = document.createElement('div')
      tools.className = 'graph-tools'
      pane.appendChild(tools)
    }
    const host = document.createElement('div')
    pane.appendChild(host)
    const canvas = document.createElement('div')
    host.appendChild(canvas)
    Object.assign(host, { clientWidth: 800, clientHeight: 600 })
    const graph = Object.assign(Object.create(StaticTreeGraph.prototype), {
      zoomHost: host, container: canvas, W: 800, H: 600,
      zoom: 1, panX: 0, panY: 0, editMode: false,
      nodes: new Map(), emptySlots: new Map(),
      _placeChips() {}, _renderLinks() {},
      _contentBox: () => ({ x: 0, y: 0, w: 1000, h: 800 }),
      _hostOffset: () => ({ x: 0, y: 0 }),
    })
    graph._buildFitControl()
    graph._wireHostInteractions()
    const plus = graph.zoomerEl.querySelector('.gz-in')
    plus.click()
    assert.equal(graph.zoom, 1.2)
    plus.dispatch('keydown', { key: '-' })
    assert.equal(graph.zoom, 1, 'toolbar minus shortcut must reach the graph exactly once')
    plus.dispatch('keydown', { key: '+' })
    assert.equal(graph.zoom, 1.2)
    plus.dispatch('keydown', { key: '0' })
    const overview = graph.zoom
    assert.ok(overview < 1)
    assert.equal(graph._autoFitted, true)
    plus.click()
    graph.zoomerEl.querySelector('.graph-fit').click()
    assert.equal(graph.zoom, overview, 'keyboard reset and mouse overview must fit identically')
    graph.zoomerEl.querySelector('.gz-out').click()
    assert.equal(graph.zoom, overview / 1.2)
    plus.dispatch('keydown', { key: '+', ctrlKey: true })
    assert.equal(graph.zoom, overview / 1.2, 'browser zoom modifier remains untouched')
    graph.editMode = true
    plus.dispatch('keydown', { key: '+' })
    assert.equal(graph.zoom, overview / 1.2, 'edit mode still owns its keyboard')
  })
}

for (const input of ['button', 'wheel']) for (const expandable of [false, true]) {
  test(`${input} zoom ${expandable ? 'explores hidden branches only through wheel gestures' : 'preserves an ordinary branch'}`, t => {
    const { document, restore } = installDomStandIn()
    t.after(restore)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const canvas = document.createElement('div')
    host.appendChild(canvas)
    Object.assign(host, { clientWidth: 800, clientHeight: 600, clientLeft: 0, clientTop: 0 })
    host.getBoundingClientRect = () => ({ left: 0, top: 0 })
    const node = document.createElement('div')
    const graph = Object.assign(Object.create(StaticTreeGraph.prototype), {
      zoomHost: host, container: canvas, W: 800, H: 600,
      zoom: 1.65, panX: 0, panY: 0, editMode: false, rootId: null,
      computer: { agents: [{ id: 'branch' }] },
      nodes: new Map([['branch', { id: 'branch', x: 400 / 1.65, y: 300 / 1.65, r: 40,
        agent: { treeScope: { expandable } }, el: node }]]),
      emptySlots: new Map(), _culled: new Set(), _layoutVisibleIds: new Set(['branch']), _placeChips() {}, _renderLinks() {},
      // Native browser checks cover layout and camera transitions. Here the
      // real wheel/button routing decides whether a transition is warranted.
      _captureRootAt(id) { this.rootId = id; this.zoom = 1; this.panX = 0; this.panY = 0; this._fitFloor = 1 },
    })
    graph._buildFitControl()
    graph._wireHostInteractions()
    const step = factor => {
      if (input === 'button') {
        graph.zoomerEl.querySelector(factor > 1 ? '.gz-in' : '.gz-out').click()
      } else {
        graph._wheelGesture = null // a separate gesture after the previous one settled
        host.dispatch('wheel', { deltaX: 0, deltaY: factor > 1 ? -120 : 120, deltaMode: 0, clientX: 400, clientY: 300 })
      }
    }
    step(1.2)
    if (input === 'wheel' && expandable) {
      assert.equal(graph.rootId, 'branch', 'inward zoom captures the branch with hidden children')
      assert.equal(graph.zoom, 1)
      for (let i = 0; i < 12 && graph.rootId; i++) step(0.8)
      assert.equal(graph.rootId, null, 'outward zoom returns from a revealed branch')
      assert.equal(graph._scopeHistory.length, 0)
    } else assert.equal(graph.rootId, null, 'ordinary zoom never replaces the tree with a nearby leaf')

    // A crossing over empty canvas must not choose a distant branch.
    graph.zoom = 1.65
    graph.nodes.get('branch').x = 10000
    step(1.2)
    assert.equal(graph.rootId, null)
    assert.ok(graph.zoom > 1.65, 'empty space still allows manual zoom')
  })
}
