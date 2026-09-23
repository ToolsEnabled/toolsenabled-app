import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {readFileSync,writeFileSync,mkdtempSync,realpathSync} from 'node:fs'
import path from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import {EventEmitter} from 'node:events'
import {parseAst} from 'rollup/parseAst'
import {createNodeTranscriptClient} from '../../src/node-transcript-client.js'
const root=path.resolve(import.meta.dirname,'../..'),require=createRequire(import.meta.url)
const mainRequire=createRequire(path.join(root,'shell/main.cjs'))
const main=readFileSync(path.join(root,'shell/main.cjs'),'utf8'),ast=parseAst(main)
const fun=name=>{const n=ast.body.find(n=>n.type==='FunctionDeclaration'&&n.id.name===name);assert.ok(n,name);return main.slice(n.start,n.end)}
const constants=ast.body.filter(n=>n.type==='VariableDeclaration').flatMap(n=>n.declarations)
 .filter(n=>['MAX_SESSION_ID_LENGTH','MAX_CWD_LENGTH','MAX_SURFACE_LENGTH','MAX_TURN_TEXT_LENGTH','AGENT_EFFORT_VALUES'].includes(n.id.name))
 .map(n=>'const '+main.slice(n.start,n.end)+';').join('\n')
const helpers=new Function('require','randomUUID',constants+'\n'+['agentIpcError','agentPayload','boundedAgentString','parseAgentStart'].map(fun).join('\n')+';return {agentIpcError,agentPayload,boundedAgentString,parseAgentStart}')(mainRequire,randomUUID)
function walk(n,fn){if(!n||typeof n!=='object')return;fn(n);for(const v of Object.values(n)){if(Array.isArray(v))for(const x of v)walk(x,fn);else if(v&&typeof v==='object')walk(v,fn)}}
let historyNode
walk(ast,n=>{if(n.type==='Property'&&n.key?.name==='standaloneSwitchHistory')historyNode=n.value})
assert.ok(historyNode)
const historyCode=main.slice(historyNode.start,historyNode.end)
const bindingRegistration=ast.body.find(n=>n.type==='ExpressionStatement'&&n.expression?.callee?.object?.name==='ipcMain'&&n.expression.arguments?.[0]?.value==='mc-transcripts:bind')
const bindCallback=bindingRegistration.expression.arguments[1]
const bindCode=main.slice(bindCallback.start,bindCallback.end)
const testSource=readFileSync(path.join(root,'tools/test/agent-command-surface.test.mjs'),'utf8'),testAst=parseAst(testSource)
const names=['fakeDeps','agentIpcError','agentPayload','boundedAgentString','rendererSafeAgentError','parseAgentStart','parseAgentSend','parseAgentSessionCommand','parseAgentPasteAttachment']
const declarations=testAst.body.filter(n=>n.type==='FunctionDeclaration'&&names.includes(n.id.name)).map(n=>testSource.slice(n.start,n.end)).join('\n')
const fixtureConstants=testAst.body.filter(n=>n.type==='VariableDeclaration').flatMap(n=>n.declarations)
 .filter(n=>['MAX_SESSION_ID_LENGTH','AGENT_EFFORT_VALUES','PASTE_IMAGE_MIME_EXTENSIONS','MAX_PASTE_IMAGE_BYTES','MAX_PASTE_IMAGE_DATA_LENGTH'].includes(n.id.name))
 .map(n=>'const '+testSource.slice(n.start,n.end)+';').join('\n')
const fakeDeps=new Function('require',fixtureConstants+'\n'+declarations+';return fakeDeps')(require)
const {createAgentCommandSurface}=require('../../shell/agent-command-surface.cjs')
const {createAgentHost}=require('../../shell/agent-host.cjs')
const {createNodeTranscriptCapture}=require('../../shell/node-transcript-capture.cjs')
const {createNodeTranscriptStore}=require('../../shell/node-transcript-store.cjs')
const fixtureEnginePath=path.join(root,'tools/test/fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const fixtureEngine=require(fixtureEnginePath)
const tracked=['shell/main.cjs','shell/agent-command-surface.cjs','shell/agent-host.cjs','shell/standalone-switch-coordinator.cjs',
 'shell/node-transcript-capture.cjs','shell/node-transcript-store.cjs','shell/image-retention-service.cjs','shell/durable-image-custody.cjs',
 'shell/image-outbox.cjs','shell/provider-image-support.cjs','src/tree-workspace.js','src/tree-standalone-agent.js','src/node-transcript-client.js',
 'tools/test/agent-command-surface.test.mjs','tools/test/t545-standalone-image-binding-review.test.mjs']
const hashes=()=>Object.fromEntries(tracked.map(f=>[f,createHash('sha256').update(readFileSync(path.join(root,f))).digest('hex')]))
const before=hashes()
console.log('DEPENDENCIES_BEFORE '+JSON.stringify(before))
test.after(()=>{const after=hashes();console.log('DEPENDENCIES_AFTER '+JSON.stringify(after));assert.deepEqual(after,before)})
function standaloneIdentity(){
 const source=readFileSync(path.join(root,'src/tree-workspace.js'),'utf8')
 let method
 walk(parseAst(source),n=>{if(n.type==='MethodDefinition'&&n.key?.name==='openStandalone')method=n.value})
 assert.ok(method)
 const body=source.slice(method.body.start,method.body.end)
 let mounted
 const call=new Function('crypto','el','mountStandaloneAgent','standalonePlaced','return async function(start)'+body)(
  {randomUUID},()=>({}),(_panel,options)=>{mounted=options;return {focus(){}}},()=>{})
 const owner={graph:{editMode:false,chatTrack:{appendChild(){}},standaloneAgent:{}},standalone:new Map(),showPicker(){},sync(){}}
 return call.call(owner,{tier:'luna'}).then(()=>({id:mounted.id,record:owner.standalone.get(mounted.id)}))
}
async function setup(t){
 const temp=realpathSync(process.env.T545_REVIEW_TEMP)
 const scratch=mkdtempSync(path.join(temp,'t545-standalone-images-'))
 assert.ok(path.relative(temp,realpathSync(scratch))&&!path.relative(temp,realpathSync(scratch)).startsWith('..'))
 let starts=0,sends=0
 t.mock.method(fixtureEngine,'startCodexSession',async options=>{
  const threadId='review-thread-'+(++starts)
  return {threadId,adapter:{transport:{child:Object.assign(new EventEmitter(),{exitCode:null,signalCode:null})},
   sendTurn:async()=>{sends++;return {turnId:'simulated-turn'}},interrupt:async()=>{options.onEvent?.({type:'turn_completed',turnId:'simulated-turn',status:'interrupted'})},answerApproval(){}},close(){}}
 })
 const host=createAgentHost({enginePath:fixtureEnginePath,defaultCwd:root,profileRoot:root,freeMemory:()=>64*1024**3,
  confinementPlanner:()=>({ok:true,tier:'unrestricted',isolated:false,threadOptions:{},env:{}})})
 const store=createNodeTranscriptStore({directory:scratch})
 const capture=createNodeTranscriptCapture({store,sessionMetadata:id=>host.sessionTranscriptMetadata(id)})
 const owner={isDestroyed:()=>false},principal={kind:'window',owner,mayWrite:true,label:'review application window'}
 const context={epoch:randomUUID()},productOwner=randomUUID()
 const deps=fakeDeps({parseAgentStart:helpers.parseAgentStart,agentPayload:helpers.agentPayload,
  currentAgentHost:()=>host,getAgentHost:()=>host,chosenWorkspaceCwd:()=>root,ensureWorkspaceRoot:()=>root,
  recordSpawnIntent:()=>({sequence:1,durable:true,signed:true,principal:productOwner}),recordTranscriptBinding:()=>{throw Error('No synthetic tree binding allowed')}})
 const surface=createAgentCommandSurface(deps)
 const history=new Function('transcriptCapture','nodeTranscripts','return ('+historyCode+')')(capture,store)
 deps.standaloneSwitchHistory=history
 const env={...helpers,getAgentCommandSurface:()=>surface,getImageOwnerContext:()=>({authenticate:value=>{assert.equal(value,context);return {authenticated:true,productOwnerId:productOwner}},read:()=>context}),
  accountPrincipal:()=>productOwner,agentSessions:deps.agentSessions,agentHost:host,transcriptCapture:capture,
  require:mainRequire,path,app:{getPath:()=>scratch},resolveCapabilityRoot:()=>process.env.T545_ENGINE_ROOT}
 deps.imageQueue=new Function(...Object.keys(env),'return ('+fun('runImageQueue')+')')(...Object.values(env))
 const bindHandler=new Function('trustedFleetProfileSender','prefsRefusal','transcriptCapture','transcriptRefusalCode','return ('+bindCode+')')(
  ()=>true,()=>{throw Error('unexpected sender refusal')},capture,e=>e.code||'MC_TRANSCRIPT_STORAGE_FAILED')
 const computerId=randomUUID(),sourceId=randomUUID()
 const client=createNodeTranscriptClient({computerId,bridge:{list:r=>store.list(r),read:r=>store.read(r),bind:r=>bindHandler({sender:owner},r)}})
 await client.ready
 const standalone=await standaloneIdentity()
 await surface.run('agent:start',{sessionId:sourceId,tier:'luna',surface:'standalone-agent'},principal)
 assert.equal(host.sessionIsOnTree(sourceId),false)
 assert.equal(deps.agentSessions.get(sourceId).treeNodeId,null)
 assert.equal(capture.bindingFor(sourceId),null)
 await client.bind(sourceId,standalone.id)
 const binding=await surface.run('agent:image-queue',{operation:'binding',sessionId:sourceId,ownerContext:context},principal)
 assert.equal(binding.ok,true)
 assert.equal(binding.result.conversationId,standalone.id)
 t.after(async()=>{await host.closeAll();await capture.shutdown()})
 return {root:scratch,host,store,capture,surface,principal,context,sourceId,standalone,computerId,deps,
  starts:()=>starts,sends:()=>sends,queue:r=>surface.run('agent:image-queue',{conversationId:standalone.id,sessionId:sourceId,ownerContext:context,...r},principal)}
}
test('actual standalone transcript binding feeds image custody, but actual switch prepare must succeed',async t=>{
 const f=await setup(t)
 // Valid PNG fixtures are derived from the existing review suite helper.
 const imageSource=readFileSync(path.join(root,'tools/test/image-retention-ipc-review.test.mjs'),'utf8')
 const imageAst=parseAst(imageSource),imageNode=imageAst.body.find(n=>n.type==='FunctionDeclaration'&&n.id.name==='image')
 const {deflateSync}=require('node:zlib')
 const image=new Function('deflateSync','return ('+imageSource.slice(imageNode.start,imageNode.end)+')')(deflateSync)
 const pixels=[image([255,0,0]),image([0,0,255])]
 const images=pixels.map((bytes,i)=>{const file=path.join(f.root,'ordered-'+i+'.png');writeFileSync(file,bytes,{flag:'wx'});return {path:file}})
 for(const item of images)f.deps.agentSessions.get(f.sourceId).attachments.add(item.path)
 const retained=await f.queue({operation:'retain',operationId:randomUUID(),images})
 assert.equal(retained.ok,true)
 const admitted=await f.queue({operation:'admit',operationId:randomUUID(),expectedGeneration:null,text:'queued exact text',imageReceipts:[retained.result]})
 assert.equal(admitted.ok,true)
 let snapshot=admitted.result
 const assigned=await f.queue({operation:'transfer',operationId:randomUUID(),expectedGeneration:snapshot.generation,expectedDestinationSessionId:null,destinationSessionId:f.sourceId})
 assert.equal(assigned.ok,true);snapshot=assigned.result
 await f.host.sendTurn({sessionId:f.sourceId,text:'simulated ongoing source turn'})
 await f.surface.run('agent:interrupt',{sessionId:f.sourceId},f.principal)
 const afterStop=(await f.queue({operation:'read'})).result
 assert.deepEqual(afterStop.entries,snapshot.entries)
 const originalBinding=f.capture.bindingFor(f.sourceId)
 const operationId=randomUUID()
 let prepared,error
 try{prepared=await f.surface.run('agent:switch',{operation:'prepare',sessionId:f.sourceId,operationId,tier:'luna',account:{mode:'keep'}},f.principal)}
 catch(e){error=e}
 console.log('ACTUAL_SWITCH_OUTCOME '+JSON.stringify({code:error?.code,prepared:prepared||null,starts:f.starts(),sourceReady:f.host.sessionActivity(f.sourceId),binding:originalBinding}))
 if(error){
  assert.equal(error.code,'MC_AGENT_CWD_NOT_YOURS')
  assert.equal(f.starts(),1,'refusal occurs before replacement engine start')
  assert.deepEqual(f.capture.bindingFor(f.sourceId),originalBinding)
  const reissued=await f.queue({operation:'reissue',envelopeId:afterStop.entries[0].envelopeId})
  assert.equal(reissued.ok,true)
  assert.deepEqual(reissued.result.images.map(i=>readFileSync(i.path)),pixels)
  console.log('RETAINED_AFTER_REFUSAL '+JSON.stringify({orderedBytes:true,automaticSend:reissued.result.automaticSend,treeNodeId:f.deps.agentSessions.get(f.sourceId).treeNodeId}))
 }
 assert.equal(error,undefined,'Actual standalone replacement must cross the trusted start boundary; got '+error?.code)
 assert.equal(prepared.phase,'prepared')
 const committed=await f.surface.run('agent:switch',{operation:'commit',sessionId:f.sourceId,operationId},f.principal)
 assert.equal(committed.applied,true)
 const moved=await f.queue({operation:'transfer',operationId:randomUUID(),expectedGeneration:afterStop.generation,
  expectedDestinationSessionId:f.sourceId,destinationSessionId:committed.sessionId})
 assert.equal(moved.ok,true)
 const bytes=await f.queue({operation:'reissue',sessionId:committed.sessionId,envelopeId:afterStop.entries[0].envelopeId})
 assert.equal(bytes.ok,true);assert.deepEqual(bytes.result.images.map(i=>readFileSync(i.path)),pixels)
})
