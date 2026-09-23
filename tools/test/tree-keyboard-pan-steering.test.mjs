import assert from 'node:assert/strict'
import test from 'node:test'
import { StaticTreeGraph } from '../../src/tree-graph.js'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

for (const target of ['host', 'toolbar']) {
  for (const [key, dx, dy, shiftKey] of [
    ['ArrowLeft', 48, 0, false],
    ['ArrowRight', -120, 0, true],
    ['ArrowUp', 0, 48, false],
    ['ArrowDown', 0, -120, true],
  ]) {
    test(`${target} ${key} preserves manual pan after overview auto-fit`, t => {
      const { document, restore } = installDomStandIn()
      t.after(restore)
      const pane = document.createElement('div')
      pane.className = 'graph-wrap'
      document.body.appendChild(pane)
      const tools = document.createElement('div')
      tools.className = 'graph-tools'
      pane.appendChild(tools)
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
        // Model a constrained pane with no outer scroll route; keep actual
        // fitting and panning so auto-fit can expose lost user steering.
        _overflowIsReachable: () => false,
      })
      graph._buildFitControl()
      graph._wireHostInteractions()
      graph.resetToOverview()
      const before = [graph.panX, graph.panY]
      const element = target === 'host' ? host : graph.zoomerEl.querySelector('.gz-in')
      const event = element.dispatch('keydown', { key, shiftKey })
      assert.equal(event.defaultPrevented, true)
      assert.deepEqual([graph.panX, graph.panY], [before[0] + dx, before[1] + dy])
      const steered = [graph.zoom, graph.panX, graph.panY]

      // Layout/resize calls this real fitting method. It must not re-center
      // a view that the person has just moved with the keyboard.
      graph._autoFitToHost()
      assert.deepEqual([graph.zoom, graph.panX, graph.panY], steered,
        'auto-fit must preserve the keyboard pan')
      host.clientWidth = 700
      graph._autoFitToHost()
      assert.deepEqual([graph.zoom, graph.panX, graph.panY], steered,
        'a changed pane size must also preserve manual steering')
      assert.equal(graph._viewSteered, true)
      assert.equal(graph._autoFitted, false)

      graph.resetToOverview()
      assert.equal(graph._viewSteered, false, 'explicit overview restores automatic fitting')
      assert.equal(graph._autoFitted, true)
    })
  }
}
