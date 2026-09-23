import '@fontsource-variable/ibm-plex-sans'
import '@fontsource-variable/jetbrains-mono'
import '../../../src/styles.css'
import '../../../src/tree-graph.css'
import '../../../src/board.css'
import { StaticTreeGraph } from '../../../src/tree-graph.js'
import { applyTextSize } from '../../../src/text-size.js'

// Synthetic renderer model only. No shell, bridge, providers, or saved state.
const style = document.createElement('style')
style.textContent = '#fixture{height:100%;padding:24px}.fixture-pane{height:100%;display:flex;flex-direction:column}.fixture-slot{position:relative;flex:1;min-height:0}.fixture-graph{position:absolute;inset:0}'
document.head.append(style)
let graph
const settle = () => new Promise(resolve => setTimeout(resolve, 250))
const rect = el => { const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height} }
window.linuxZoom = {
  async mount({size=1,count=12,placement='bar'}) {
    graph?.destroy()
    document.documentElement.dataset.theme='black'
    document.body.classList.add('reduce-motion')
    applyTextSize(size)
    document.querySelector('#fixture').innerHTML=`<section class="computers graph-wrap fixture-pane">${placement==='bar'?'<div class="graph-bar"><span>Isolated Page 2 zoom</span><div class="graph-tools"></div></div>':''}<div class="fixture-slot"><div class="fixture-graph"></div></div></section>`
    const agents=Array.from({length:count},(_,i)=>({id:`node-${i}`,name:i===0?'Controller':`Builder ${i}`,role:i===0?'coordinator':'default',parentId:i===0?null:`node-${Math.floor((i-1)/4)}`,state:'running',treeNode:true,bornAt:1788560000000}))
    graph=new StaticTreeGraph(document.querySelector('.fixture-graph'),{computer:{id:'linux-zoom-fixture',agents},screenChips:true,contextFeed:()=>({current:'Running',previous:'Synthetic verification task',chat:'Synthetic renderer content.'}),onOpenControls:()=>{}})
    await document.fonts.ready
    await settle()
    return this.snapshot()
  },
  snapshot() {
    return {zoom:graph.zoom,panX:graph.panX,panY:graph.panY,rootId:graph.rootId,visible:graph.visibleAgents().length,total:graph.computer.agents.length,represented:graph.rootId?graph._scopeModel().branch(graph.rootId).length:graph.computer.agents.length,transform:graph.container.style.transform,computedTransform:getComputedStyle(graph.container).transform,readout:graph.zoomerEl.textContent.trim(),host:rect(graph.zoomHost),nodes:graph.nodes.size,culled:graph._culled.size,focus:document.activeElement?.className}
  },
  target(selector) {
    const button=graph.zoomerEl.querySelector(selector),r=rect(button)
    const x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y)
    return {...r,x,y,selector,hit:hit===button||button.contains(hit),hitTag:hit?.tagName,hitClass:hit?.className,label:button.getAttribute('aria-label')}
  },
  focusNode() {const node=[...graph.nodes.values()].find(r=>!r.el.hidden && !graph._culled.has(r.id) && graph._layoutVisibleIds.has(r.id))?.el;node?.focus();return !!node && document.activeElement===node},
  focusButton(selector) {graph.zoomerEl.querySelector(selector).focus()},
  async prepareBranch() {
    // Prepare a real rooted layout; input under test is dispatched by CDP.
    graph.setRoot('node-1')
    await settle()
    graph.resetZoom()
    await settle()
    return this.snapshot()
  },
}
window.page2LayoutReady=true
