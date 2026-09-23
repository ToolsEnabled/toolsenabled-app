import '@fontsource-variable/ibm-plex-sans'
import '@fontsource-variable/manrope'
import '@fontsource-variable/source-sans-3'
import '@fontsource-variable/space-grotesk'
import '@fontsource-variable/jetbrains-mono'
import '../../../src/glow.css'
import '../../../src/styles.css'
import '../../../src/theme-refinements.css'
import '../../../src/common-commands.css'
import '../../../src/hand-controls.css'
import '../../../src/guided-step.css'
import '../../../src/phone-canvas.css'
import '../../../src/phone-ledger.css'
import '../../../src/accessibility-controls.css'
import '../../../src/morphs.css'
import '../../../src/chat-content.css'
import '../../../src/chat-session-changes.css'
import '../../../src/chat-presentation.css'
import '../../../src/chat-response.css'
import '../../../src/chat-activity.css'
import '../../../src/diff-editor.css'
import '../../../src/app-navigation.css'
import '../../../src/sidebar-pages.css'
import '../../../src/first-use-guidance.css'
import '../../../src/readability.css'
import '../../../src/tree-graph.css'
import '../../../src/tree-workspace.css'
// main.js also loads these shared controls styles through its homeView import.
import '../../../src/home-chat.css'
import '../../../src/home-chat-layout.css'
import {computersView} from '../../../src/views/computers.js'
import schema from '../../../public/data/schema/fleet.schema.json'
const stamp=new Date().toISOString(),nodeId='fixture-manager',sessionId='fixture-session',computerId='this-computer'
const listeners=new Set(),calls=[],fetches=[]
let view,container=null,mode='rail',originalChat=null,originalInput=null,pulseCount=0
const fleet={schemaVersion:1,domain:'fleet',generatedAt:stamp,ok:true,reason:null,sources:[],data:{computers:[{id:computerId,label:'Synthetic computer',sourceKind:'observed',observedAt:stamp,activeSessions:1,services:[]}],graph:{revision:1,contentHash:'0'.repeat(64),nodes:[{id:'seat-one',label:'Seat one',role:'builder',provider:'claude',enabled:true}],edges:[]}}}
window.fetch=async input=>{const url=typeof input==='string'?input:input.url;fetches.push(url);const value=url==='/data/fleet.json'?fleet:url==='/data/schema/fleet.schema.json'?schema:null;return {ok:value!==null,status:value===null?404:200,statusText:value===null?'Not Found':'OK',json:async()=>value||{}}}
window.mcShell={getBridgeProof:async()=>({ok:true,proof:'synthetic'}),getBridgeTransport:async()=>null}
window.mcAgent={
 onEvent:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},
 models:async()=>({ok:true,models:[],provider:'codex'}),sessionActivity:async()=>({ok:true,busy:true,closing:false}),
 close:async()=>{calls.push('close');return {ok:true,closed:true}},start:async()=>{calls.push('start');return {ok:false}},
 pickAttachment:async()=>{calls.push('attach');return {ok:true,path:'C:/synthetic/image.png',size:100}},
 pickMention:async()=>{calls.push('mention');return {ok:true,path:'src/synthetic.js'}},
 interrupt:async()=>{calls.push('interrupt');return {ok:true}},send:async()=>{calls.push('send');return {turnId:'unexpected'}},
 setEffort:async()=>({effort:'high'})
}
const settle=async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))}
async function until(predicate){const end=performance.now()+10000;while(!predicate()){if(performance.now()>end)throw Error('Synthetic mount condition timed out');await new Promise(resolve=>setTimeout(resolve,20))}await settle()}
const chat=()=>view?.el.querySelector(mode==='rail'?'.rail-chat-host .chat':'.tree-conversation[data-agent-id="'+nodeId+'"] .chat')
const elInfo=n=>{if(!n)return null;const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y),s=getComputedStyle(n);return {tag:n.tagName,cls:n.className,disabled:n.disabled===true,visible:n.checkVisibility({checkVisibilityCSS:true}),inert:!!n.closest('[inert]'),pointerEvents:s.pointerEvents,zIndex:s.zIndex,rect:{x:r.x,y:r.y,width:r.width,height:r.height},hit:{tag:hit?.tagName,cls:hit?.className,inside:hit===n||n.contains(hit)}}}
const emit=event=>{for(const fn of listeners)fn({sessionId,event})}
window.wholeComposer={
 async setup(nextMode){mode=nextMode;pulseCount=0;
  document.body.style.cssText='margin:0;height:100vh;overflow:hidden';document.documentElement.dataset.theme='white';location.hash='#/computers/this-computer'
  localStorage.setItem('mc.fleet.trees.v1:'+computerId,JSON.stringify({version:1,computerId,trees:[{id:'fixture-tree',name:'Synthetic project',createdAt:stamp,updatedAt:stamp,profileId:null}],nodes:[{id:nodeId,treeId:'fixture-tree',status:'running',createdAt:stamp,updatedAt:stamp,role:'manager',message:'Synthetic ongoing work',statusNote:'',sessionId,parentId:null}]}))
  localStorage.setItem('mc.set.tree_style','boxes')
  view=computersView({initialComputer:computerId,navigate(){}});document.body.append(view.el)
  await until(()=>view.el.querySelector('.static-tree-node[data-agent-id="'+nodeId+'"]'))
  const node=view.el.querySelector('.static-tree-node[data-agent-id="'+nodeId+'"]');node.focus();return {node:elInfo(node),listeners:listeners.size,fetches:fetches.slice()}
 },
 async ready(){await until(()=>chat());originalChat=chat();originalInput=chat().querySelector('.chat-input input');emit({type:'thinking',turnId:'turn-one',itemId:'summary',status:'inProgress',text:'I am checking the synthetic work. Pending fragment'});for(let i=0;i<2;i++)emit({type:'tool_call',turnId:'turn-one',itemId:'tool-'+i,toolCallId:'tool-'+i,tool:'commandExecution',payload:{command:'synthetic command '+i}});emit({type:'assistant_text_delta',turnId:'turn-one',text:'A readable update. Incomplete next sentence'});await settle();return this.snapshot()},
 async snapshot(){await settle();const root=chat(),input=root?.querySelector('.chat-input input');return {controlsInOwner:!!view.el.querySelector('.board-loop-box [data-loop="every"]'),viewport:{width:innerWidth,height:innerHeight},overlay:elInfo(document.querySelector('.home-workspace-controls-overlay')),overlayPosition:document.querySelector('.home-workspace-controls-overlay')?getComputedStyle(document.querySelector('.home-workspace-controls-overlay')).position:null,sameChat:root===originalChat,sameInput:input===originalInput,chatConnected:root?.isConnected,pulseCount,streamedSummary:root?.textContent.includes('Another complete summary '+pulseCount+'.'),chat:elInfo(root),classNames:root?.parentElement?.className,ancestors:(()=>{let n=root,a=[];while(n){a.push(n.tagName+'.'+n.className);n=n.parentElement}return a})(),input:elInfo(input),value:input?.value,active:elInfo(document.activeElement),activity:root?.dataset.chatActivity,controls:Object.fromEntries(['goal','loop'].map(id=>[id,elInfo(root?.querySelector('[data-common-command="'+id+'"]'))])),options:elInfo(root?.querySelector('[data-chat-actions]')),popup:elInfo(root?.querySelector('.chat-actions-pop')),rows:[...(root?.querySelectorAll('.chat-actions-row')||[])].map(n=>({text:n.textContent,disabled:n.disabled,...elInfo(n)})),interval:elInfo(document.querySelector('.board-loop-box [data-loop="every"]')),workspaceTabs:[...view.el.querySelectorAll('[role="tab"]')].map(n=>({text:n.textContent,...elInfo(n)})),openDialogs:document.querySelectorAll('dialog[open],[aria-modal="true"]').length,calls:calls.slice(),tools:root?.querySelectorAll('[data-action-kind="call"]').length,fetches:fetches.slice()}}
 ,focusComposer(){const input=chat().querySelector('.chat-input input');input.focus();return elInfo(input)},
 clearComposer(){const input=chat().querySelector('.chat-input input');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));input.focus()},
 pulse(){pulseCount++;emit({type:'thinking',turnId:'turn-one',itemId:'summary',status:'inProgress',text:'I am checking the synthetic work. Another complete summary '+pulseCount+'. Pending'});emit({type:'tool_result',turnId:'turn-one',itemId:'tool-0',toolCallId:'tool-0',tool:'commandExecution',payload:{exitCode:0},text:'Synthetic complete result'})},
 async wrapDialog(){container=document.createElement('dialog');container.style.cssText='width:calc(100vw - 24px);height:calc(100vh - 24px);max-width:none;max-height:none;padding:0';document.body.append(container);container.append(view.el);container.showModal();await settle()},
 dispose(){view?.destroy();container?.remove()}
}
