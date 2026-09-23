import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {randomUUID} from 'node:crypto'
import {setTimeout as pause} from 'node:timers/promises'
const {createVoiceRelay}=createRequire(import.meta.url)('../../shell/voice-relay.cjs')
function setup(t,options={}) {
  const owner={}, calls=[], clientId=randomUUID()
  const binding={sessionId:randomUUID(),targetAgentId:'agent',generation:1,speechEpoch:0}
  let writes=true
  const host={targets:who=>{assert.equal(who,owner);return [{sessionId:'agent'}]},
    async start(who,value){assert.equal(who,owner);calls.push(['start',value]);return binding},
    async stop(who){assert.equal(who,owner);calls.push(['stop']);return {ok:true}},
    async offer(who,value){assert.equal(who,owner);calls.push(['offer',value]);return {type:'answer',sdp:'answer'}}}
  const relay=createVoiceRelay({host,owner,mayWrite:()=>writes,...options})
  t.after(()=>relay.close())
  return {relay,host,clientId,binding,calls,write:value=>{writes=value},
    start:()=>relay.run('start',{clientId,targetAgentId:'agent',provider:'local'}),
    async ready(){await pause(0);return relay.run('poll',{clientId,after:0})}}
}
test('remote voice checks web-drive permission and never selects a cloud speech account',async t=>{
  const h=setup(t); h.write(false)
  assert.equal((await h.relay.run('targets',{})).length,1)
  await assert.rejects(h.start(),/MC_AGENT_PRINCIPAL_READ_ONLY/)
  h.write(true)
  await assert.rejects(h.relay.run('start',{clientId:h.clientId,targetAgentId:'agent',provider:'openai'}),/VOICE_REMOTE_LOCAL_ONLY/)
  assert.equal(h.calls.length,0)
})
test('another browser cannot read speech events, signal or stop the current contact',async t=>{
  const h=setup(t);await h.start();assert.equal((await h.ready()).state,'ready')
  const other=randomUUID()
  for(const command of ['poll','stop']) await assert.rejects(h.relay.run(command,{clientId:other}),/VOICE_STALE_SESSION/)
  await assert.rejects(h.relay.run('offer',{...h.binding,clientId:other,type:'offer',sdp:'offer'}),/VOICE_STALE_SESSION/)
  await h.relay.run('offer',{...h.binding,clientId:h.clientId,type:'offer',sdp:'offer'})
  assert.equal(Object.hasOwn(h.calls.at(-1)[1],'clientId'),false)
})
test('pending GPU startup can be canceled without publishing its late binding',async t=>{
  let finish
  const h=setup(t);h.host.start=()=>new Promise(resolve=>{finish=resolve})
  assert.equal((await h.start()).state,'preparing')
  await pause(0)
  await h.relay.run('stop',{clientId:h.clientId})
  finish(h.binding);await pause(0)
  await assert.rejects(h.relay.run('poll',{clientId:h.clientId}),/VOICE_STALE_SESSION/)
  assert.equal(h.calls.filter(x=>x[0]==='stop').length,1)
})
test('permission revocation stops the contact and stale controls cannot revive it',async t=>{
  const h=setup(t);await h.start();await h.ready();h.write(false)
  await assert.rejects(h.relay.run('poll',{clientId:h.clientId}),/MC_AGENT_PRINCIPAL_READ_ONLY/)
  h.write(true)
  await assert.rejects(h.relay.run('poll',{clientId:h.clientId}),/VOICE_STALE_SESSION/)
  assert.equal(h.calls.filter(x=>x[0]==='stop').length,1)
})
test('an absent browser expires its lease, including after a relay reconnect',async t=>{
  let clock=0
  const h=setup(t,{now:()=>clock,leaseMs:15})
  await h.start();await h.ready();await h.relay.disconnect()
  await h.start();await h.ready();clock=100
  await pause(40)
  await assert.rejects(h.relay.run('poll',{clientId:h.clientId}),/VOICE_STALE_SESSION/)
  assert.equal(h.calls.filter(x=>x[0]==='stop').length,2)
})
test('bounded event responses expose a gap instead of silently losing transcripts',async t=>{
  const h=setup(t);await h.start();await h.ready()
  for(let sequence=1;sequence<=300;sequence++)h.relay.emit({...h.binding,sequence,type:'transcript.final',text:'x'.repeat(8192),privatePath:'never forward'})
  const reply=await h.relay.run('poll',{clientId:h.clientId,after:0})
  assert.equal(reply.dropped,true);assert.ok(reply.events.length>0)
  assert.ok(Buffer.byteLength(JSON.stringify(reply))<60*1024)
  assert.equal(JSON.stringify(reply).includes('never forward'),false)
  await assert.rejects(h.relay.run('poll',{clientId:h.clientId,after:301}),/VOICE_REQUEST_INVALID/)
})
test('an unreadable web-drive permission cannot authorize speech',async t=>{
  const h=setup(t,{mayWrite(){throw new Error('Unreadable permission fixture')}})
  await assert.rejects(h.start(),/MC_AGENT_PRINCIPAL_READ_ONLY/)
  assert.equal(h.calls.length,0)
})
test('a late poll cannot renew an expired lease before the timer runs',async t=>{
  let clock=0
  const h=setup(t,{now:()=>clock,leaseMs:45000});await h.start();await h.ready()
  clock=45001
  await assert.rejects(h.relay.run('poll',{clientId:h.clientId}),/VOICE_STALE_SESSION/)
  await pause(0)
  assert.equal(h.calls.filter(x=>x[0]==='stop').length,1)
})
test('a failed remote start and its cleanup preserve a desktop-owned voice contact',async t=>{
  const {EventEmitter}=await import('node:events')
  const {createVoiceHost}=createRequire(import.meta.url)('../../shell/voice-host.cjs')
  const desktop={}, remote={}, sessions=new Map([['desktop-agent',{owner:desktop,state:'ready'}],['remote-agent',{owner:remote,state:'ready'}]])
  const host=createVoiceHost({appRoot:process.cwd(),sessions,emit(){},
    findRuntime:()=>({python:'fixture-python',worker:'fixture-worker.py',dataRoot:'fixture-runtime'}),
    spawnProcess(){
      const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter()
      child.stdin.write=()=>queueMicrotask(()=>child.stdout.emit('data',Buffer.from('{"type":"ready","protocolVersion":1,"port":32123}\n')))
      child.stdin.end=()=>{};child.kill=()=>child.emit('exit',0);return child
    },
    async fetchHttp(url){if(url.includes('/events?'))return new Promise(()=>{});return {ok:true,status:200,json:async()=>({speechEpoch:0})}},
  })
  const relay=createVoiceRelay({host,owner:remote,mayWrite:()=>true});t.after(async()=>{await relay.close();host.close()})
  await host.start(desktop,{targetAgentId:'desktop-agent',provider:'local'})
  const clientId=randomUUID()
  await relay.run('start',{clientId,targetAgentId:'remote-agent',provider:'local'});await pause(0)
  const result=await relay.run('poll',{clientId})
  assert.equal(result.state,'error');assert.equal(result.code,'VOICE_ALREADY_ACTIVE')
  await relay.run('stop',{clientId})
  assert.equal(host.allowsMicrophone(desktop),true)
  await host.stop(desktop)
  await relay.run('start',{clientId,targetAgentId:'remote-agent',provider:'local'});await pause(0)
  assert.equal((await relay.run('poll',{clientId})).state,'ready')
  assert.equal(host.allowsMicrophone(remote),true)
})
