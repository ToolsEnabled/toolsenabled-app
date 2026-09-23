import test from 'node:test'
import assert from 'node:assert/strict'
import Module, {createRequire} from 'node:module'
import {readFileSync,writeFileSync,mkdtempSync,realpathSync,existsSync,readdirSync} from 'node:fs'
import path from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import {deflateSync} from 'node:zlib'
import {parseAst} from 'rollup/parseAst'

const appRoot=path.resolve(process.env.IMAGE_APP_ROOT)
const mainPath=path.join(appRoot,'shell/main.cjs')
const require=createRequire(mainPath)
const source=readFileSync(mainPath,'utf8')
const ast=parseAst(source)
const statement=ast.body.find(n=>n.type==='ExpressionStatement'&&n.expression.type==='CallExpression'
 &&n.expression.callee.object?.name==='ipcMain'&&n.expression.callee.property?.name==='handle'
 &&n.expression.arguments[0]?.value==='mc-agent:image-queue')
assert.ok(statement,'actual IPC registration must exist')
const callback=statement.expression.arguments[1]
const body=source.slice(callback.start,callback.end)
const runNode=ast.body.find(n=>n.type==='FunctionDeclaration'&&n.id.name==='runImageQueue')
assert.ok(runNode,'actual queue implementation must exist')
const queueBody=source.slice(runNode.start,runNode.end)
const functions=['agentIpcError','agentPayload','boundedAgentString','parseAgentSend','assertTrustedAgentSender','windowPrincipal'].map(name=>{
 const n=ast.body.find(n=>n.type==='FunctionDeclaration'&&n.id.name===name)
 assert.ok(n,name);return source.slice(n.start,n.end)
}).join('\n')
const limitCode=ast.body.filter(n=>n.type==='VariableDeclaration').flatMap(n=>n.declarations).filter(n=>['MAX_SESSION_ID_LENGTH','MAX_TURN_TEXT_LENGTH'].includes(n.id.name)).map(n=>'const '+source.slice(n.start,n.end)+';').join('\n')
const helpers=new Function('trustedFleetProfileSender',limitCode+'\n'+functions+';return {agentIpcError,agentPayload,parseAgentSend,assertTrustedAgentSender,windowPrincipal}')(event=>event.trusted===true)
const {createAgentCommandSurface,REQUIRED_DEPS}=require('./agent-command-surface.cjs')
const sha=value=>createHash('sha256').update(value).digest('hex')
const tracked=['agent-host.cjs','main.cjs','agent-command-surface.cjs','image-retention-service.cjs','durable-image-custody.cjs','image-outbox.cjs']
const measured=()=>Object.fromEntries(tracked.map(f=>[f,sha(readFileSync(path.join(appRoot,'shell',f)))]))
const before=measured()
console.log('IPC_BEFORE '+JSON.stringify(before))
test.after(()=>{const after=measured();console.log('IPC_AFTER '+JSON.stringify(after));assert.deepEqual(after,before)})
function image(color) {
  function crc(bytes) {
    let value=0xffffffff
    for(const byte of bytes) {value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0)}
    return (value^0xffffffff)>>>0
  }
  function chunk(type,bytes) {
    const result=Buffer.alloc(bytes.length+12)
    result.writeUInt32BE(bytes.length)
    result.write(type,4)
    bytes.copy(result,8)
    result.writeUInt32BE(crc(result.subarray(4,-4)),result.length-4)
    return result
  }
  const header=Buffer.alloc(13)
  header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=2
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),
    chunk('IDAT',deflateSync(Buffer.from([0,...color]))),chunk('IEND',Buffer.alloc(0))])
}

function fixture(provider='codex',fullHost=null) {
 let beforeTracked=null,authenticationHook=null,ownerValid=true
 const root=mkdtempSync(path.join(realpathSync(process.env.IMAGE_TEST_TEMP),'image-ipc-review-'))
 const owner={isDestroyed:()=>false},ownerContext={epoch:'fixture'}
 const pixels=[image([255,0,0]),image([0,0,255])]
 const images=pixels.map((bytes,i)=>{const file=path.join(root,i+'.png');writeFileSync(file,bytes);return {path:file}})
 const sessions=new Map([
 ['source',{owner,state:'ready',metricsPrincipal:'product-owner',attachments:new Set(images.map(i=>i.path))}],
 ['successor',{owner,state:'ready',metricsPrincipal:'product-owner',attachments:new Set()}],
 ])
 const metadata=new Map([['source',{account:'source-account',provider:'codex'}],['successor',{account:'chosen-account',provider}]])
 const bindings=new Map([['source',{nodeId:'conversation'}],['successor',{nodeId:'conversation'}]])
 const deps={}
 for(const [name,kind]of Object.entries(REQUIRED_DEPS))deps[name]=kind==='function'?()=>null:kind==='number'?128:kind==='string'?root:{}
 Object.assign(deps,{agentSessions:sessions,agentIpcError:helpers.agentIpcError,parseAgentSend:helpers.parseAgentSend,
 currentAgentHost:()=>({sendTurnTracked:async request=>{if(beforeTracked)await beforeTracked();return fullHost.sendTurnTracked(request)}}),dialog:{showOpenDialog:()=>{}},AGENT_EFFORT_VALUES:[]})
 const surface=createAgentCommandSurface(deps)
 const event={trusted:true,sender:owner}
 const environment={...helpers,getAgentCommandSurface:()=>surface,getImageOwnerContext:()=>({
 authenticate:context=>{authenticationHook?.();if(!ownerValid||context!==ownerContext)helpers.agentIpcError('IMAGE_OWNER_CHANGED','fixture owner changed');return {authenticated:true,productOwnerId:'product-owner'}},
 read:()=>ownerContext,
 }),accountPrincipal:()=> 'product-owner',agentSessions:sessions,agentHost:{holdQueuedUserMessage:(id,waiting)=>fullHost?.holdQueuedUserMessage(id,waiting),sessionTranscriptMetadata:id=>metadata.get(id),sessionDeliverySettings:id=>fullHost?fullHost.sessionDeliverySettings(id):({model:'fixture-model',effort:null,provider:metadata.get(id)?.provider})},
 transcriptCapture:{bindingFor:id=>bindings.get(id)},require,path,app:{getPath:()=>root},
 resolveCapabilityRoot:()=>path.resolve(process.env.IMAGE_ENGINE_ROOT)}
 deps.imageQueue=new Function(...Object.keys(environment),'return ('+queueBody+')')(...Object.values(environment))
 const handler=new Function(...Object.keys(environment),'return ('+body+')')(...Object.values(environment))
 const run=async request=>await handler(event,{conversationId:'conversation',ownerContext,...request})
 const retain=async()=>(await run({operation:'retain',operationId:randomUUID(),sessionId:'source',images})).result
 async function prepare() {
  const receipt=await retain()
  const admitted=(await run({operation:'admit',sessionId:'successor',operationId:randomUUID(),expectedGeneration:null,text:'',imageReceipts:[receipt]})).result
  const moved=(await run({operation:'transfer',operationId:randomUUID(),expectedGeneration:admitted.generation,
    expectedDestinationSessionId:null,destinationSessionId:'successor'})).result
  return {envelopeId:moved.entries[0].envelopeId,generation:moved.generation}
 }
 function latestStored() {
 const directory=path.join(root,'image-retention',sha('product-owner'),sha('conversation'),'outbox')
 if(!existsSync(directory))return null
 const revisions=readdirSync(directory).filter(name=>/^\d+$/.test(name)).sort((a,b)=>Number(b)-Number(a))
 return revisions.length?JSON.parse(readFileSync(path.join(directory,revisions[0],'snapshot.json'),'utf8')):null
 }
 return {run,prepare,retain,event,handler,ownerContext,sessions,bindings,metadata,pixels,images,latestStored,
 setAuthenticationHook:fn=>{authenticationHook=fn},invalidateOwner:()=>{ownerValid=false},setBeforeTracked:fn=>{beforeTracked=fn}}
}

for(const provider of ['codex','claude'])test('actual IPC surface/service reissues ordered bytes to '+provider,async()=>{
 const h=fixture(provider),ready=await h.prepare()
 const result=(await h.run({operation:'reissue',sessionId:'successor',envelopeId:ready.envelopeId})).result
 assert.deepEqual(result.images.map(i=>readFileSync(i.path)),h.pixels)
 assert.deepEqual([...h.sessions.get('successor').attachments],result.images.map(i=>i.path))
 assert.equal(result.automaticSend,false)
})

test('actual sender and parser refuse untrusted and unexpected IPC inputs',async()=>{
 const h=fixture()
 assert.throws(()=>h.handler({...h.event,trusted:false},{operation:'read'}),{code:'MC_AGENT_SENDER_REFUSED'})
 await refusal(()=>h.run({operation:'read',unexpected:true}),{code:'MC_AGENT_INVALID_PAYLOAD'})
 await refusal(()=>h.run({operation:'read',ownerContext:{epoch:'other'}}),{code:'IMAGE_OWNER_CHANGED'})
})

test('actual source/candidate authorities refuse unissued, other owner and wrong conversation',async()=>{
 const h=fixture()
 await refusal(()=>h.run({operation:'retain',operationId:randomUUID(),sessionId:'source',images:[{path:'unissued.png'}]}),
  {code:'MC_AGENT_ATTACHMENT_UNKNOWN'})
 const ready=await h.prepare()
 h.bindings.set('successor',{nodeId:'different-conversation'})
 await refusal(()=>h.run({operation:'reissue',sessionId:'successor',envelopeId:ready.envelopeId}),
  {code:'IMAGE_CUSTODY_CANDIDATE_REFUSED'})
 h.bindings.set('successor',{nodeId:'conversation'})
 h.sessions.get('successor').metricsPrincipal='previous-owner'
 await refusal(()=>h.run({operation:'reissue',sessionId:'successor',envelopeId:ready.envelopeId}),{code:'IMAGE_OWNER_CHANGED'})
 assert.equal(h.sessions.get('successor').attachments.size,0)
})

async function refusal(action,expected) {
 const result=await action()
 assert.equal(result.ok,false)
 assert.equal(result.code,expected.code)
 assert.equal(result.committed,null)
 assert.equal(result.reconcile,true)
 return result
}
async function actualHost(behavior='accept',tier='luna') {
 let hostModule=require('./agent-host.cjs')
 if(process.env.IMAGE_DISPATCH_MUTATION==='forget-adapter-boundary') {
  const filename=path.join(appRoot,'shell/agent-host.cjs')
  const originalSource=readFileSync(filename,'utf8')
  const changed=originalSource.replace('dispatchTracking.dispatched = true','dispatchTracking.dispatched = false')
  assert.notEqual(changed,originalSource,'boundary mutation must apply')
  const loaded=new Module(filename);loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename))
  loaded._compile(changed,filename);hostModule=loaded.exports
 }
 const {createAgentHost}=hostModule
 const fixturePath=path.join(appRoot,'tools/test/fixtures/dual-engine/src/lib/agent-engine/codex-process.js')
 const fixtureEngine=require(fixturePath)
 const original=fixtureEngine.startCodexSession
 const adapterCalls=[]
 let release
 const root=mkdtempSync(path.join(realpathSync(process.env.IMAGE_TEST_TEMP),'image-dispatch-host-'))
 const prior=process.env.MC_TEST_CONFINEMENT_PLAN
 process.env.MC_TEST_CONFINEMENT_PLAN=JSON.stringify({ok:true,tier:'unrestricted',isolated:false,threadOptions:{},env:{},servers:[]})
 fixtureEngine.startCodexSession=async options=>{
  const started=await original(options)
  started.adapter.sendTurn=request=>{
   adapterCalls.push(request)
   if(behavior==='hold')return new Promise(resolve=>{release=()=>resolve({turnId:'fixture-turn'})})
   if(behavior==='throw')throw Object.assign(new Error('fixture adapter invoked then failed'),{code:'FIXTURE_ADAPTER_THROW'})
   return Promise.resolve({turnId:'fixture-turn'})
  }
  return started
 }
 const host=createAgentHost({enginePath:fixturePath,defaultCwd:root,startProviderProbe:()=> 'codex',
  providerCommandResolver:()=>path.join(root,'never-executed'),freeMemory:()=>64*1024**3})
 try {await host.startSession({sessionId:'successor',tier})}
 finally {fixtureEngine.startCodexSession=original;if(prior===undefined)delete process.env.MC_TEST_CONFINEMENT_PLAN;else process.env.MC_TEST_CONFINEMENT_PLAN=prior}
 return {host,adapterCalls,release:()=>release?.(),close:()=>host.closeAll()}
}

test('tracked full chain accepts once and refuses double dispatch without another adapter call',async()=>{
 const live=await actualHost()
 try {
  const h=fixture('codex',live.host),ready=await h.prepare()
  const request={operation:'dispatch',sessionId:'successor',envelopeId:ready.envelopeId,
   expectedGeneration:ready.generation,operationId:randomUUID()}
  const outcome=await h.run(request)
  assert.equal(outcome.deliveryDisposition,'accepted')
  assert.equal(live.adapterCalls.length,1)
  assert.deepEqual(live.adapterCalls[0].images.map(i=>readFileSync(i.path)),h.pixels)
  const saved=(await h.run({operation:'read'})).result
  assert.equal(saved.entries[0].state,'accepted')
  await refusal(()=>h.run(request),{code:'IMAGE_OUTBOX_STALE'})
  await refusal(()=>h.run({...request,operationId:randomUUID(),expectedGeneration:saved.generation}),{code:'IMAGE_OUTBOX_ENVELOPE_CONFLICT'})
  assert.equal(live.adapterCalls.length,1)
 } finally {await live.close()}
})

test('busy race after durable claim restores not-sent only with actual host no-dispatch proof',async()=>{
 const live=await actualHost()
 try {
  const h=fixture('codex',live.host),ready=await h.prepare()
  h.setBeforeTracked(async()=>{
   const snapshot=(await h.run({operation:'read'})).result
   assert.equal(snapshot.entries[0].state,'unknown','claim must precede competing send')
   await live.host.sendTurn({sessionId:'successor',text:'competing turn',origin:'person'})
  })
  const outcome=await h.run({operation:'dispatch',sessionId:'successor',envelopeId:ready.envelopeId,
   expectedGeneration:ready.generation,operationId:randomUUID()})
  assert.equal(outcome.deliveryDisposition,'not-sent')
  assert.equal(outcome.code,'AGENT_TURN_ACTIVE')
  assert.equal(live.adapterCalls.length,1,'only the competing turn may reach the adapter')
  assert.deepEqual(live.adapterCalls[0].images,[])
  const saved=(await h.run({operation:'read'})).result
  assert.equal(saved.entries[0].state,'not-sent')
  assert.equal(saved.automaticSend,false)
 } finally {await live.close()}
})

test('synchronous adapter throw is unknown and cannot be replayed as a refusal',async()=>{
 const live=await actualHost('throw')
 try {
  const h=fixture('codex',live.host),ready=await h.prepare()
  const outcome=await h.run({operation:'dispatch',sessionId:'successor',envelopeId:ready.envelopeId,
   expectedGeneration:ready.generation,operationId:randomUUID()})
  assert.equal(outcome.deliveryDisposition,'unknown')
  assert.equal(outcome.code,'FIXTURE_ADAPTER_THROW')
  assert.equal(live.adapterCalls.length,1)
  const saved=(await h.run({operation:'read'})).result
  assert.equal(saved.entries[0].state,'unknown')
  await refusal(()=>h.run({operation:'dispatch',sessionId:'successor',envelopeId:ready.envelopeId,
   expectedGeneration:saved.generation,operationId:randomUUID()}),{code:'IMAGE_OUTBOX_ENVELOPE_CONFLICT'})
  assert.equal(live.adapterCalls.length,1)
 } finally {await live.close()}
})


test('overlapping dispatches claim one unknown envelope and invoke one adapter',async()=>{
 const live=await actualHost('hold')
 let first
 try {
  const h=fixture('codex',live.host),ready=await h.prepare()
  const request={operation:'dispatch',sessionId:'successor',envelopeId:ready.envelopeId,
   expectedGeneration:ready.generation,operationId:randomUUID()}
  first=h.run(request)
  for(let attempts=0;live.adapterCalls.length===0&&attempts<100;attempts++)await new Promise(resolve=>setImmediate(resolve))
  assert.equal(live.adapterCalls.length,1)
  const pending=(await h.run({operation:'read'})).result
  assert.equal(pending.entries[0].state,'unknown')
  await refusal(()=>h.run(request),{code:'IMAGE_OUTBOX_STALE'})
  await refusal(()=>h.run({...request,operationId:randomUUID(),expectedGeneration:pending.generation}),{code:'IMAGE_OUTBOX_ENVELOPE_CONFLICT'})
  await refusal(()=>h.run({operation:'resolveNoDispatch'}),{code:'IMAGE_QUEUE_DISPATCH_AUTHORITY'})
  assert.equal((await h.run({operation:'read'})).result.generation,pending.generation)
  assert.equal(live.adapterCalls.length,1)
  live.release()
  assert.equal((await first).deliveryDisposition,'accepted')
 } finally {live.release();if(first)await first;await live.close()}
})


for(const change of ['session','owner'])test('claim-to-send '+change+' mutation cannot invoke the adapter',async()=>{
 const live=await actualHost()
 try {
  const h=fixture('codex',live.host),ready=await h.prepare()
  let changed=false
  h.setAuthenticationHook(()=>{
   if(changed||h.latestStored()?.entries[0]?.state!=='unknown')return
   changed=true
   if(change==='owner')h.invalidateOwner()
   else h.sessions.set('successor',{...h.sessions.get('successor'),attachments:new Set()})
  })
  const outcome=await h.run({operation:'dispatch',sessionId:'successor',envelopeId:ready.envelopeId,
   expectedGeneration:ready.generation,operationId:randomUUID()})
  assert.equal(changed,true,'mutation must occur after persisted claim')
  assert.equal(live.adapterCalls.length,0)
  assert.equal(outcome.deliveryDisposition,change==='owner'?'unknown':'not-sent')
  assert.equal(h.latestStored().entries[0].state,change==='owner'?'unknown':'not-sent')
  if(change==='session')assert.equal(h.sessions.get('successor').attachments.size,0)
 } finally {await live.close()}
})

for(const explicitNull of [false,true])test('actual IPC model override with '+(explicitNull?'explicit null':'omitted')+' effort',async()=>{
 const live=await actualHost('accept','terra')
 try {
  assert.equal(live.host.sessionDeliverySettings('successor').effort,'high')
  const h=fixture('codex',live.host),receipt=await h.retain()
  const selection={model:'gpt-6-astra',...(explicitNull?{effort:null}:{})}
  const admitted=await h.run({operation:'admit',sessionId:'successor',operationId:randomUUID(),
   expectedGeneration:null,text:'',imageReceipts:[receipt],selection})
  assert.equal(admitted.ok,true,JSON.stringify(admitted))
  const snapshot=admitted.result
  assert.deepEqual(snapshot.entries[0].selection,{model:'gpt-6-astra',effort:explicitNull?null:'high'})
  const moved=(await h.run({operation:'transfer',operationId:randomUUID(),expectedGeneration:snapshot.generation,
   expectedDestinationSessionId:null,destinationSessionId:'successor'})).result
  const outcome=await h.run({operation:'dispatch',sessionId:'successor',operationId:randomUUID(),
   expectedGeneration:moved.generation,envelopeId:moved.entries[0].envelopeId})
  if(explicitNull) {
   assert.equal(outcome.ok,false)
   assert.equal(outcome.code,'IMAGE_QUEUE_SELECTION_CHANGED')
   assert.equal(live.adapterCalls.length,0)
   assert.equal((await h.run({operation:'read'})).result.entries[0].state,'not-sent')
  } else {
   assert.equal(outcome.deliveryDisposition,'accepted')
   assert.equal(live.adapterCalls.length,1)
   assert.deepEqual(live.adapterCalls[0].images.map(image=>readFileSync(image.path)),h.pixels)
  }
 } finally {await live.close()}
})
test('actual IPC omitted-effort admission refuses wrong owner without changing stored queue',async()=>{
 const live=await actualHost('accept','terra')
 try {
  const h=fixture('codex',live.host),receipt=await h.retain()
  const before=(await h.run({operation:'read'})).result
  await refusal(()=>h.run({operation:'admit',ownerContext:{epoch:'wrong-owner'},sessionId:'successor',
   operationId:randomUUID(),expectedGeneration:before.generation,text:'',imageReceipts:[receipt],
   selection:{model:'gpt-6-astra'}}),{code:'IMAGE_OWNER_CHANGED'})
  assert.deepEqual((await h.run({operation:'read'})).result,before)
  assert.equal(h.sessions.get('successor').attachments.size,0)
  assert.equal(live.adapterCalls.length,0)
 } finally {await live.close()}
})
