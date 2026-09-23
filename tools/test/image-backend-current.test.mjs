import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdtempSync,realpathSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import Module, {createRequire} from 'node:module'
import {createHash} from 'node:crypto'
import {deflateSync} from 'node:zlib'
import {parseAst} from 'rollup/parseAst'
const root=resolve(process.env.IMAGE_APP_ROOT || fileURLToPath(new URL('../..',import.meta.url)))
const require=createRequire(import.meta.url)
const surfacePath=join(root,'shell/agent-command-surface.cjs')
let surfaceModule=require(surfacePath)
if(process.env.IMAGE_MUTATION==='drop-images'){
 const source=readFileSync(surfacePath,'utf8')
 const changed=source.replace('images: request.images','images: []')
 assert.notEqual(changed,source,'mutation must apply')
 const loaded=new Module(surfacePath);loaded.filename=surfacePath;loaded.paths=Module._nodeModulePaths(root);loaded._compile(changed,surfacePath);surfaceModule=loaded.exports
}
const {createAgentCommandSurface,REQUIRED_DEPS}=surfaceModule
const measuredFiles=['shell/main.cjs','shell/agent-host.cjs','shell/agent-command-surface.cjs'].map(f=>join(root,f))
const hashes=()=>Object.fromEntries(measuredFiles.map(f=>[f,createHash('sha256').update(readFileSync(f)).digest('hex')]))
const beforeHashes=hashes()
console.log('SOURCE_BEFORE '+JSON.stringify(beforeHashes))
test.after(()=>{const after=hashes();console.log('SOURCE_AFTER '+JSON.stringify(after));assert.deepEqual(after,beforeHashes,'source bytes changed during suite')})
function declarations(source,names){const found={};function walk(n){if(!n||typeof n!=='object')return;if(n.type==='FunctionDeclaration'&&names.includes(n.id?.name))found[n.id.name]=source.slice(n.start,n.end);for(const v of Object.values(n))if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object')walk(v)}walk(parseAst(source));return names.map(n=>{assert.ok(found[n],n);return found[n]}).join('\n')}
const main=readFileSync(join(root,'shell/main.cjs'),'utf8')
const limits=parseAst(main).body.filter(n=>n.type==='VariableDeclaration').flatMap(n=>n.declarations).filter(n=>['MAX_SESSION_ID_LENGTH','MAX_TURN_TEXT_LENGTH'].includes(n.id.name)).map(n=>'const '+main.slice(n.start,n.end)+';').join('\n')
const parse=new Function(limits+'\n'+declarations(main,['agentIpcError','agentPayload','boundedAgentString','parseAgentSend'])+'; return parseAgentSend')()
const temp=realpathSync(process.env.IMAGE_TEST_TEMP)
const scratch=mkdtempSync(join(temp,'image-backend-current-'))
function crc(bytes){let n=0xffffffff;for(const byte of bytes){n^=byte;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0)}return (n^0xffffffff)>>>0}
function png(color){const chunk=(kind,bytes)=>{const b=Buffer.alloc(bytes.length+12);b.writeUInt32BE(bytes.length);b.write(kind,4);bytes.copy(b,8);b.writeUInt32BE(crc(b.subarray(4,-4)),b.length-4);return b};const header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=2;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,...color]))),chunk('IEND',Buffer.alloc(0))])}
const images=[[255,0,0],[0,0,255]].map((color,i)=>{const path=join(scratch,i+'.png');writeFileSync(path,png(color));return {path}})

function surfaceHarness(){const owner={};const calls=[];const sessions=new Map([['s',{owner,state:'ready',attachments:new Set(images.map(i=>i.path))}]]);const deps={};for(const [k,v]of Object.entries(REQUIRED_DEPS))deps[k]=v==='function'?()=>null:v==='number'?128:v==='string'?root:{};Object.assign(deps,{agentSessions:sessions,currentAgentHost:()=>({sendTurn:async r=>{calls.push(r);return {ok:true}}}),parseAgentSend:parse,agentIpcError:(code,message)=>{throw Object.assign(new Error(message),{code})},rendererSafeAgentError:e=>e,dialog:{showOpenDialog:async()=>({canceled:true,filePaths:[]})},AGENT_EFFORT_VALUES:[]});return {sessions,owner,surface:createAgentCommandSurface(deps),calls,principal:{kind:'window',owner,mayWrite:true,label:'test'}}}
for(const text of ['', '  describe both  '])test('actual parser and surface retain ordered images and exact text '+JSON.stringify(text),async()=>{const h=surfaceHarness();const input={sessionId:'s',text,images};assert.deepEqual(parse(input),input);await h.surface.run('agent:send',input,h.principal);assert.deepEqual(h.calls,[{...input,origin:'person'}])})
test('actual parser rejects empty turn and malformed images',()=>{for(const images of [[],[{path:''}],Array(1),Array(9).fill({path:'x'})])assert.throws(()=>parse({sessionId:'s',text:'',images}),e=>e.code==='MC_AGENT_INVALID_PAYLOAD')})
test('actual surface refuses unissued image without host dispatch',async()=>{const h=surfaceHarness();await assert.rejects(h.surface.run('agent:send',{sessionId:'s',text:'look',images:[{path:join(scratch,'unissued.png')}]},h.principal),{code:'MC_AGENT_ATTACHMENT_UNKNOWN'});assert.equal(h.calls.length,0)})
// Entry validation is executed verbatim up to option narrowing, without provider dispatch.
const host=readFileSync(join(root,'shell/agent-host.cjs'),'utf8')
const fn=declarations(host,['sendTurn'])
const ast=parseAst(fn).body[0];const boundary=ast.body.body.find(n=>n.type==='VariableDeclaration'&&n.declarations.some(d=>d.id.name==='turnOptions'))
assert.ok(boundary)
const prefix=fn.slice(ast.body.start+1,boundary.start)
const entrySession={provider:'codex'}
const entry=new Function('session','providerImageSupport','path',declarations(host,['boundedString','boundedTurnImages'])+'\nconst fail=(code,message)=>{throw Object.assign(new Error(message),{code})};const assertOpen=()=>{};const readySession=()=>session;const parseCloudCommand=()=>null;return async function({sessionId,text,images,options,origin}={},dispatchTracking=null){'+prefix+';return {turnText,turnImages,pictureNotSent}}')(entrySession,require(join(root,'shell/provider-image-support.cjs')),require('node:path'))
test('actual host entry accepts image-only and retains ordered images',async()=>{const result=await entry({sessionId:'s',text:'',images});assert.equal(result.turnText,'');assert.deepEqual(result.turnImages,images)})

test('actual surface refuses another owner before host dispatch',async()=>{const h=surfaceHarness();const foreign={kind:'window',owner:{},mayWrite:true,label:'other'};await assert.rejects(h.surface.run('agent:send',{sessionId:'s',text:'look',images},foreign),{code:'MC_AGENT_UNKNOWN_SESSION'});assert.equal(h.calls.length,0)})
const engineRoot=resolve(process.env.IMAGE_ENGINE_ROOT)
const {ClaudeCliAdapter}=require(join(engineRoot,'src/lib/agent-engine/claude-cli-adapter.js'))
const {CodexAdapter,CODEX_CLI_VERSION}=require(join(engineRoot,'src/lib/agent-engine/codex-adapter.js'))
for(const text of ['', '  describe both  '])test('Claude adapter serializes exact text and ordered real PNG bytes '+JSON.stringify(text),async()=>{const sent=[];const adapter=new ClaudeCliAdapter({transport:{send:m=>sent.push(m),onData(){},onExit(){},close(){},kill(){}}});try{const p=adapter.sendTurn({threadId:'7cf7c88e-6912-4388-a181-78aef262c494',text,images});p.catch(()=>{});await new Promise(r=>setImmediate(r));assert.equal(sent.length,1);const content=sent[0].message.content;assert.deepEqual(content.filter(b=>b.type==='image').map(b=>b.source.data),images.map(i=>readFileSync(i.path).toString('base64')));assert.deepEqual(content.filter(b=>b.type==='text').map(b=>b.text),[text])}finally{adapter.close()}})
for(const text of ['', '  describe both  '])test('Codex adapter serializes exact text and ordered local paths '+JSON.stringify(text),async()=>{const sent=[];let receive;const transport={onData:fn=>{receive=fn;return ()=>{}},write:line=>{const m=JSON.parse(line);sent.push(m);if(m.method==='initialize')receive(JSON.stringify({id:m.id,result:{userAgent:'test',codexHome:root,platformFamily:process.platform,platformOs:process.platform}})+'\n');if(m.method==='turn/start')receive(JSON.stringify({id:m.id,result:{turn:{id:'turn-image'}}})+'\n')},close(){}};const adapter=new CodexAdapter({transport,codexVersion:CODEX_CLI_VERSION});try{await adapter.initialize();const receipt=await adapter.sendTurn({threadId:'thread-image',text,images});const request=sent.find(m=>m.method==='turn/start');assert.deepEqual(request.params.input,[{type:'text',text,text_elements:[]},...images.map(i=>({type:'localImage',path:i.path}))]);assert.equal(receipt.turnId,'turn-image')}finally{adapter.close()}})

test('replacement session without explicit custody refuses original paths',async()=>{const h=surfaceHarness();h.sessions.set('replacement',{owner:h.owner,state:'ready',attachments:new Set()});await assert.rejects(h.surface.run('agent:send',{sessionId:'replacement',text:'retry',images},h.principal),{code:'MC_AGENT_ATTACHMENT_UNKNOWN'});assert.equal(h.calls.length,0)})
const {createAgentHost}=require(join(root,'shell/agent-host.cjs'))
test('full actual host preserves ordered image-only payload; busy replay sends nothing extra',async()=>{
 const prior=process.env.MC_TEST_CONFINEMENT_PLAN
 process.env.MC_TEST_CONFINEMENT_PLAN=JSON.stringify({ok:true,tier:'unrestricted',isolated:false,threadOptions:{},env:{},servers:[]})
 const fixture=join(fileURLToPath(new URL('.',import.meta.url)),'fixtures/dual-engine/src/lib/agent-engine/codex-process.js')
 const recorder=require(fixture)
 const full=createAgentHost({enginePath:fixture,defaultCwd:scratch,startProviderProbe:()=> 'codex',providerCommandResolver:()=>join(scratch,'never-executed'),freeMemory:()=>64*1024**3})
 try{
 await full.startSession({sessionId:'image-full'})
 const before=recorder.adapterCalls.length
 const receipt=await full.sendTurn({sessionId:'image-full',text:'',images,origin:'person'})
 const sent=recorder.adapterCalls.slice(before).filter(c=>c.method==='sendTurn')
 assert.equal(sent.length,1);assert.deepEqual(sent[0].request.images,images);assert.equal(receipt.imagesSent,2)
 await assert.rejects(full.sendTurn({sessionId:'image-full',text:'retry',images,origin:'person'}),{code:'AGENT_TURN_ACTIVE'})
 assert.equal(recorder.adapterCalls.slice(before).filter(c=>c.method==='sendTurn').length,1)
 recorder.calls.at(-1).onEvent({type:'turn_completed',threadId:'thread-1',turnId:'t1',status:'completed'})
 await full.sendTurn({sessionId:'image-full',text:'queued retry',images,origin:'person'})
 assert.deepEqual(recorder.adapterCalls.at(-1).request.images,images)
 }finally{await full.closeAll();if(prior===undefined)delete process.env.MC_TEST_CONFINEMENT_PLAN;else process.env.MC_TEST_CONFINEMENT_PLAN=prior}
})

test('unsupported provider refuses whole image turn before dispatch',async()=>{for(const provider of ['local','grok','gemini']){entrySession.provider=provider;try{await assert.rejects(entry({sessionId:'s',text:'look',images}),{code:'AGENT_IMAGE_UNSUPPORTED'})}finally{entrySession.provider='codex'}}})
