import '@fontsource-variable/ibm-plex-sans'
import '@fontsource-variable/jetbrains-mono'
import '../../../src/styles.css'
import '../../../src/tree-graph.css'
import '../../../src/board.css'
import { buildChat } from '../../../src/components.js'
import { StaticTreeGraph } from '../../../src/tree-graph.js'
import { applyTextSize } from '../../../src/text-size.js'
import { markRoleContext } from '../../../src/chat-role-context.js'
import { applyRoleColors } from '../../../src/role-colors.js'

// Only renderer modules: no application shell, credentials, bridge, or provider.
const sheet = document.createElement('style')
sheet.textContent = `
  #fixture { padding:24px; height:100%; display:grid; grid-template-columns:minmax(0,1fr) 520px; gap:20px; }
  .fixture-chat { display:flex; min-height:0; min-width:0; height:600px; background:var(--sheet); border:1px solid var(--line-2); padding:20px; }
  .fixture-canvas { position:relative; min-width:0; min-height:0; overflow:hidden; background:var(--sheet); border:1px solid var(--line-2); }
  .fixture-title { position:absolute; left:18px; top:50px; font-size:14px; font-weight:600; }
  .fixture-graph { position:absolute; inset:0; }
`
document.head.append(sheet)
let chat = null
let graph = null
let lastSelected = null
const at = 1788560000000
const answer = '## The restart is ready\n\nThe measured result is **unchanged**: the saved tree is available, and the owner can choose when to restart.\n\n### What was checked\n\n- The current tree still has its named controller.\n- Queued messages remain editable and send only once.\n- No provider session was started by this layout check.\n\nA long path stays readable: `C:\\work\\' + 'nested-folder-'.repeat(22) + 'report.md`.\n\n```javascript\nconst message = "' + 'long code '.repeat(25) + '";\nconsole.log(message);\n```\n\n| Check | Result |\n| --- | --- |\n| Controls | Preserved |\n| Layout | Measured in Chromium |\n\nThe final paragraph follows the tool summary without crossing its border.'
const rect = el => { const r = el.getBoundingClientRect(); return { x:r.x, y:r.y, w:r.width, h:r.height, right:r.right, bottom:r.bottom } }
const wait = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))

async function mount({ theme='black', size=1, short=false, count=12 } = {}) {
  chat?.dispose(); graph?.destroy()
  document.documentElement.dataset.theme = theme
  applyRoleColors()
  applyTextSize(size)
  document.body.classList.add('reduce-motion')
  document.querySelector('#fixture').innerHTML = '<section class="computers fixture-canvas"><div class="fixture-title">Agent tree · isolated layout check</div><div class="fixture-graph"></div></section><section class="fixture-chat"></section>'
  chat = buildChat({ title:'Controller', roleKey:'coordinator', seed:0, onSend:()=>{}, subtitle:'Your agent · live session',
    headerMeta:{ path:{ value:'C:\\work\\ToolsEnabled\\workspace', source:'profile-cwd' }, status:{ key:'running', source:'session-node-status' } },
    history:[{ who:'you', text:'Review the saved tree and explain what changed.', at },markRoleContext({who:'you',text:'TOOLSENABLED ROLE DIRECTIONS (configured in the Role library)\nRole: Controller\nPurpose: Coordinate the requested work.\nOwns: The tree and its final verification.\nMust not: Claim unmeasured success.\nHands off to: Managers for bounded work.\n\nFollow these directions while carrying out the person\'s task. They do not grant tools, permissions, or authority beyond this session\'s enforced limits.',at},'fixture')] })
  document.querySelector('.fixture-chat').append(chat)
  // Reproduces the live order: an initially short stream, tools, then a much
  // longer push into that same stream while the log already needs to scroll.
  const stream = chat.openStream({ at:at+1000, turnStamp:'fixture-turn-01' })
  stream.push('Checking the saved tree.')
  for(let i=0;i<14;i++) chat.addAction({id:`tool-${i}`,tool:'Read',detail:`src/check-${i}.js`,body:'Measured fixture output\n'+'Details remain available.\n'.repeat(4),state:'finished',stateKey:'done',durationMs:600,at:at+2000+i})
  await wait()
  stream.push(short ? 'The measured result is unchanged.' : answer)
  await wait()
  const streamBounds = measureChat()
  stream.close(short ? 'The measured result is unchanged.' : answer)
  const started=performance.now()
  const agents = Array.from({length:count},(_,i)=>({id:`node-${i}`,name:i===0?'Controller':i<4?`Manager ${i}`:`Worker ${i-3}`,role:i===0?'coordinator':i<4?'manager':'default',parentId:i===0?null:count>12?`node-${Math.floor((i-1)/4)}`:i<4?'node-0':`node-${1+Math.floor((i-4)/3)}`,tier:count>12?Math.floor(Math.log(i*3+1)/Math.log(4)):i===0?0:i<4?1:2,state:'running',bornAt:at,treeNode:true}))
  graph = new StaticTreeGraph(document.querySelector('.fixture-graph'),{computer:{id:'isolated-layout',agents},contextFeed:agent=>({current:'Running',previous:'Asked: '+('Review the latest trees, preserve pending messages, and explain the measured result. ').repeat(18),chat:'The saved tree is available. '+('Details remain in the full conversation. ').repeat(14)}),onOpenControls:agent=>{lastSelected={id:agent.id,state:agent.state}},screenChips:true})
  await wait(); await wait()
  chat.querySelector('.chat-log').scrollTop=0
  return { streamBounds, renderMs:performance.now()-started, suppliedNodes:count, retainedNodes:graph.nodes.size, culledNodes:[...graph.nodes.keys()].filter(id=>graph._culled.has(id)).length, ...measure() }
}
function measureChat() {
  const log=chat.querySelector('.chat-log')
  const rows=[...log.children].map(row=>({className:row.className,...rect(row),contentBottom:Math.max(...[...row.querySelectorAll('.chat-msg-text, .chat-msg-footer')].map(n=>rect(n).bottom),rect(row).bottom)}))
  return {log:rect(log),rows,overlaps:rows.slice(0,-1).filter((row,i)=>row.contentBottom>rows[i+1].y+1),horizontalOverflow:log.scrollWidth-log.clientWidth}
}
function measure() {
  const host=graph.zoomHost
  const cards=[...host.querySelectorAll('.screen-chip-visible:not(.as-chat)')].filter(n=>getComputedStyle(n).visibility==='visible').map(rect)
  const previewHeights=[...host.querySelectorAll('.chip-preview')].map(n=>n.offsetHeight)
  const nodes=[...graph.nodes.values()].filter(r=>!r.el.hidden && !graph._culled.has(r.id) && graph._layoutVisibleIds.has(r.id)).map(r=>rect(r.el.querySelector('.node-glass')||r.el))
  return {chat:measureChat(),host:rect(host),cards,previewHeights,nodes,zoom:graph.zoom,docOverflow:document.documentElement.scrollWidth-innerWidth}
}
window.page2Layout = {
  mount,measure,
  async toggleTools(){const head=chat.querySelector('.chat-action-run > summary');head.click();await wait();return {open:head.parentElement.open,...measureChat()}},
  async resizeAfterManualZoom(){graph.zoomBy(1.25);const before={zoom:graph.zoom,panX:graph.panX,panY:graph.panY};graph._autoFitToHost();return {before,after:{zoom:graph.zoom,panX:graph.panX,panY:graph.panY}}},
  async negativeControl(){const rule=document.createElement('style');rule.textContent='.chat-log > .msg { flex: 0 1 auto; }';document.head.append(rule);try{return (await mount()).streamBounds.overlaps.length}finally{rule.remove()}},
  async scrollEnd(){chat.querySelector('.chat-log').scrollTop=chat.querySelector('.chat-log').scrollHeight;await wait();return measureChat()},
  focusToolSummary(){const summary=chat.querySelector('.chat-action-run > summary');summary.focus();return summary.parentElement.open},
  toolDisclosureState(){return chat.querySelector('.chat-action-run').open},
  async bodySelection(){const context=chat.querySelector('.chat-context');context.querySelector('summary').click();const body=context.querySelector('.chat-context-body');body.click();return {open:context.open,words:body.textContent}},
  nextDrillTarget(id){
    const ancestors=[]
    for(let agent=graph.computer.agents.find(a=>a.id===id);agent;agent=graph.computer.agents.find(a=>a.id===agent.parentId))ancestors.push(agent.id)
    const visible=ancestors.map(key=>graph.nodes.get(key)).filter(r=>r && !r.el.hidden && !graph._culled.has(r.id) && graph._layoutVisibleIds.has(r.id))
    const target=visible.find(r=>r.id===id || r.el.classList.contains('focusable'))
    if(!target)return {refused:true,rootId:graph.rootId,visible:visible.map(r=>r.id)}
    const box=rect(target.el.querySelector('.node-glass'));const x=box.x+box.w/2,y=box.y+box.h/2
    return {id:target.id,x,y,hit:document.elementFromPoint(x,y)?.closest('.static-tree-node')?.dataset.agentId===target.id,wasCulled:graph._culled.has(id),rootId:graph.rootId,lastSelected}
  },
  selection(){return {lastSelected,rootId:graph.rootId,modelCount:graph.computer.agents.length}},
  async returnOverview(){graph.clearRoot();graph.resetToOverview();await new Promise(resolve=>setTimeout(resolve,800));return {rootId:graph.rootId,modelCount:graph.computer.agents.length,retainedNodes:graph.nodes.size,...measure()}},
}
window.page2LayoutReady=true
