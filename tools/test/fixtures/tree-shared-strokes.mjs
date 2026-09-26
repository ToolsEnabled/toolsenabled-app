// Fixed geometry isolates SVG painting from layout and provider activity.
// Both cases invoke a real StaticTreeGraph renderer; the baseline module is
// supplied from the reviewed pre-fix commit by the private browser driver.
import '../../../src/styles.css'
import '../../../src/tree-graph.css'
import '../../../src/tree-workspace.css'

const params = new URLSearchParams(location.search)
const baselineModule = '../../../src/tree-graph-shared-strokes-baseline.js'
const { StaticTreeGraph } = params.get('baseline') === '1'
  ? await import(/* @vite-ignore */ baselineModule)
  : await import('../../../src/tree-graph.js')
const container = document.querySelector('#graph')
document.body.style.cssText = 'margin:0;background:white;zoom:1;overflow:hidden'
container.style.cssText = 'position:absolute;left:20.25px;top:20.25px;width:700px;height:400px;--ink-3:#26445d;--sheet:white;--c-coordinator:#2e7b98;transform-origin:0 0'
container.dataset.nodeStyle = params.get('style') === 'boxes' ? 'boxes' : 'circles'
const records = [
  { id: 'root', x: 300, y: 50, r: 20, agent: { id: 'root', name: 'Controller' } },
  ...[100, 200, 300, 400, 500].map((x, index) => ({ id: `child-${index}`, x, y: 300, r: 20,
    agent: { id: `child-${index}`, name: `Child ${index + 1}`, parentId: 'root' } })),
  { id: 'reviewer', x: 650, y: 50, r: 20, agent: { id: 'reviewer', name: 'Reviewer' } },
]
const graph = window.graph = Object.assign(Object.create(StaticTreeGraph.prototype), {
  container, svg: container.querySelector('svg'), nodes: new Map(records.map(record => [record.id, record])),
  _culled: new Set(), _layoutVisibleIds: new Set(records.map(record => record.id)), emptySlots: new Map(),
  spacious: false, nodeStyle: container.dataset.nodeStyle, zoom: 1,
  declaredEdges: [], communicationLinks: [{ from: 'root', to: 'reviewer' }],
})
window.fixture = {
  setScale(scale) {
    graph.zoom = scale
    container.style.transform = `scale(${scale})`
    graph._renderLinks()
  },
  points() {
    const bounds = container.getBoundingClientRect(), scale = graph.zoom
    const screen = (x, y) => ({ x: bounds.x + x * scale, y: bounds.y + y * scale })
    return { trunk: screen(300, 110), branch: screen(100, 240), sharedBus: screen(245, 185.5), singleBus: screen(145, 185.5),
      hierarchyStart: screen(50, 85), hierarchyEnd: screen(560, 281) }
  },
}
fixture.setScale(1)
