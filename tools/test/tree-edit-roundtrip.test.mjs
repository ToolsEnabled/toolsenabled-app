import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { StaticTreeGraph } from '../../src/tree-graph.js'
import { Element } from './lib/dom-stand-in.mjs'

const agents = () => [
  { id: 'root', name: 'Root', parentId: null },
  { id: 'child', name: 'Child', parentId: 'root' },
  { id: 'other', name: 'Other', parentId: null },
]
function fixture(overrides = {}) {
  const subject = Object.assign(Object.create(StaticTreeGraph.prototype), {
    computer: { agents: agents() }, declaredEdges: [], smartScope: true,
    editMode: false, nodeStyle: 'boxes', selectedId: 'child', rootId: null,
    windowRootId: 'root', windowRootIds: ['root', 'other'], _treeWide: false,
    zoom: .65, panX: 24, panY: -31, _fitFloor: .45, _viewSteered: true,
    _autoFitted: false, _scopeExitZoom: .3, _scopeHistory: [],
    container: new Element('div'), screenOverlay: new Element('div'), panHint: new Element('div'),
    nodes: new Map(), _cancelZoomMotion() {}, _cancelPendingNodeClicks() {},
    _setRenderStyle(style) { this.nodeStyle = style },
    setWide(wide) { this._treeWide = wide },
    _reconcile() { this.lastProjection = this.visibleAgents() }, resize() {},
    fitCurrentTree() { this.zoom = .2; this.panX = 100; this.panY = 80 },
    _applyZoom() {}, ...overrides,
  })
  for (const agent of subject.computer.agents) subject.nodes.set(agent.id, { id: agent.id, agent, el: new Element('div') })
  subject.select(subject.selectedId)
  return subject
}
const view = g => ({ rootId:g.rootId, nodeStyle:g.nodeStyle, wide:g._treeWide,
  zoom:g.zoom,panX:g.panX,panY:g.panY,fitFloor:g._fitFloor,steered:g._viewSteered,
  autoFitted:g._autoFitted,exitZoom:g._scopeExitZoom,history:g._scopeHistory })

test('Edit then Done restores a forest overview, style and exact steered camera', () => {
  const g=fixture(), before=view(g)
  g.setEditMode(true,{rootIds:['root','other']})
  assert.equal(g.nodeStyle,'circles')
  assert.equal(g._treeWide,true)
  g.setEditMode(false)
  assert.deepEqual(view(g),before,'a null overview root must not become the first window root')
})

test('Done restores the pre-edit selection after another node is selected for editing', () => {
  const g=fixture({rootId:'root'})
  g.setEditMode(true,{rootIds:['root']})
  g.select('root')
  g.setEditMode(false)
  assert.equal(g.selectedId,'child')
  assert.equal(g.nodes.get('child').el.classList.contains('selected'),true)
  assert.equal(g.nodes.get('root').el.classList.contains('selected'),false)
})

test('Done clears a pre-edit selection that was removed, rather than leaving a stale ID', () => {
  const g=fixture({rootId:'root'})
  g.setEditMode(true,{rootIds:['root']})
  g.computer.agents=g.computer.agents.filter(a=>a.id!=='child')
  g.nodes.delete('child')
  g.setEditMode(false)
  assert.equal(g.selectedId,null)
})

test('repeated Edit and Done requests do not replace the saved view', () => {
  const g=fixture({rootId:'root'}),before=view(g)
  g.setEditMode(true,{rootIds:['root']})
  g.setEditMode(true,{rootIds:['other']})
  assert.deepEqual(g.visibleAgents().map(a=>a.id),['root','child'])
  g.setEditMode(false);g.setEditMode(false)
  assert.deepEqual(view(g),before)
})

test('a vanished selected tree cannot enter an editing mode containing no agents', () => {
  const g=fixture(), before=view(g)
  assert.equal(g.setEditMode(true,{rootIds:['removed-root']}),false)
  assert.equal(g.editMode,false)
  assert.deepEqual(view(g),before)
  assert.ok(g.panHint.textContent.length>0,'the refusal must explain what happened')
})

test('hiding context cards cannot replace the edit instructions with an open-chat instruction', () => {
  const g=fixture({circleCards:false,screenChips:true})
  g.setEditMode(true,{rootIds:['root']})
  const instructions=g.panHint.textContent
  g._placeChips()
  assert.equal(g.panHint.textContent,instructions)
  assert.equal(g.screenOverlay.hidden,true)
})

test('the captured unresolved-manager shape remains complete and unique in edit mode', () => {
  const shape=JSON.parse(readFileSync(new URL('./fixtures/tree-edit-live-shape.json',import.meta.url),'utf8'))
  const g=fixture({computer:{agents:shape.agents},windowRootIds:null,windowRootId:null})
  const roots=g._scopeModel().children.get(null)
  g.setEditMode(true,{rootIds:roots})
  const shown=g.visibleAgents()
  assert.equal(shown.length,shape.agents.length)
  assert.equal(new Set(shown.map(a=>a.id)).size,shape.agents.length)
  assert.equal(shown.filter(a=>a.unresolvedManager).length,shape.counts.unresolvedManagers)
  assert.ok(shown.every(a=>!a.treeScope?.group),'edit must show actual agents, not folded groups')
})
