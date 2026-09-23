import test from 'node:test'
import assert from 'node:assert/strict'
import { createVoiceController } from '../../src/voice-controller.js'
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b}); return {promise,resolve,reject} }
function harness({interrupt, send}={}) {
  let clock=0, next=0
  const timers=new Map(), sent=[], stopped=[], spoken=[], entries=[], notices=[]
  const binding={sessionId:'voice',targetAgentId:'lean-agent',generation:7,speechEpoch:0}
  const c=createVoiceController({
    schedule:(fn,ms)=>{const id=++next;timers.set(id,{fn,at:clock+ms});return id},unschedule:id=>timers.delete(id),
    agent:{interrupt:async p=>{stopped.push(p);return interrupt?.(p)},send:async p=>{sent.push(p);return send?.(p)||{turnId:'new-turn'}}},
    voice:{interrupt:async()=>({speechEpoch:10}),reply:async p=>spoken.push(p)},
    queue:{enqueue:(sessionId,text)=>{const entry={id:++next,sessionId,text};entries.push(entry);return {ok:true,entry}},takeNext:()=>entries.shift(),confirmDelivered:()=>{},requeueFront:(_,entry)=>entries.unshift(entry)},
    notify:p=>notices.push(p),id:()=>String(++next)
  });c.bind(binding)
  const emit=(type,epoch,more={})=>c.onVoice({...binding,type,speechEpoch:epoch,sequence:++next,...more})
  return {c,sent,stopped,spoken,entries,notices,emit,
    start:e=>emit('speech.started',e),stop:e=>emit('speech.stopped',e),final:(e,text)=>emit('transcript.final',e,{utteranceId:'u'+e,text}),
    event:(type,text,turnId='old-turn')=>c.onAgent({sessionId:binding.targetAgentId,event:{type,text,turnId}}),
    advance:async ms=>{clock+=ms;for(const [id,t] of [...timers])if(t.at<=clock){timers.delete(id);t.fn()}await tick()}
  }
}
test('speech cancels selected agent before STT and repeated onset is idempotent',async()=>{
 const h=harness();h.event('assistant_text_delta','Old answer. ');h.start(1);h.start(1);await tick()
 assert.deepEqual(h.stopped,[{sessionId:'lean-agent'}]);assert.equal(h.spoken.length,0);assert.equal(h.sent.length,0)
 h.event('assistant_text_delta','Late canceled output. ');h.event('turn_completed');await h.advance(10000)
 assert.equal(h.sent.length,0);assert.equal(h.spoken.length,0)
})
test('continued speech resets endpoint and becomes one combined generation',async()=>{
 const h=harness();h.start(1);h.stop(1);h.final(1,'Compare the results');await tick();await h.advance(700)
 assert.equal(h.sent.length,0);h.start(2);await h.advance(1000);h.stop(2);h.final(2,'but only use the latest run');await tick()
 await h.advance(899);assert.equal(h.sent.length,0);await h.advance(1)
 assert.deepEqual(h.sent,[{sessionId:'lean-agent',text:'Compare the results but only use the latest run'}])
})
test('late recognition cannot close newer speech or send an incomplete instruction',async()=>{
 const h=harness();h.start(1);h.stop(1);h.start(2);h.final(1,'First condition');await tick();await h.advance(5000)
 assert.equal(h.sent.length,0);h.stop(2);await h.advance(5000);assert.equal(h.sent.length,0)
 h.final(2,'second condition');await tick();await h.advance(900);assert.equal(h.sent[0].text,'First condition second condition')
})
test('out-of-order finals preserve the spoken order and await every segment',async()=>{
 const h=harness();h.start(1);h.stop(1);h.start(2);h.stop(2);h.final(2,'second');await tick();await h.advance(2000)
 assert.equal(h.sent.length,0);h.final(1,'first');await tick();await h.advance(900);assert.equal(h.sent[0].text,'first second')
})
test('cancellation acknowledgement gates generation; failure holds words',async()=>{
 const pending=deferred(),h=harness({interrupt:()=>pending.promise});h.start(1);h.stop(1);h.final(1,'New request');await tick();await h.advance(3000)
 assert.equal(h.sent.length,0);pending.resolve();await tick();await h.advance(900);assert.equal(h.sent.length,1)
 const bad=harness({interrupt:()=>{throw new Error('transport lost')}});bad.start(1);bad.final(1,'Do not proceed');await tick();await bad.advance(5000)
 assert.equal(bad.sent.length,0);assert.match(bad.notices.at(-1),/Could not stop/)
})
test('no-active-turn cancellation is benign, but noise never starts a paid turn',async()=>{
 const h=harness({interrupt:()=>{throw new Error('AGENT_TURN_NONE')}});h.start(1);h.stop(1);h.final(1,'');await tick();await h.advance(900)
 assert.equal(h.sent.length,0);h.start(2);h.final(2,'Hello');await tick();await h.advance(900);assert.equal(h.sent.length,1)
})
test('barge-in during send admission cancels the admitted turn and suppresses its output',async()=>{
 const admission=deferred(),h=harness({send:()=>admission.promise});h.final(0,'First request');await h.advance(900);assert.equal(h.sent.length,1)
 h.start(1);await tick();h.event('assistant_text_delta','Must not play. ','new-turn');admission.resolve({turnId:'new-turn'});await tick()
 assert.ok(h.stopped.length>=1);assert.equal(h.spoken.length,0)
 h.stop(1);h.final(1,'Correction');await tick();await h.advance(900);assert.equal(h.sent.length,2)
})
test('switching or disconnecting invalidates endpoint timers and old interruption acknowledgements',async()=>{
 const pending=deferred(),h=harness({interrupt:()=>pending.promise});h.start(1);h.final(1,'Old words');await tick();h.c.unbind();pending.resolve();await tick();await h.advance(5000)
 assert.equal(h.sent.length,0)
 const j=harness();j.final(0,'Pending words');j.c.bind({sessionId:'other',targetAgentId:'other',generation:8});await j.advance(5000);assert.equal(j.sent.length,0)
})
test('combined instructions never silently lose a trailing qualification',async()=>{
 const h=harness();h.start(1);h.final(1,'a'.repeat(3990));await tick();await h.advance(500);h.start(2);h.final(2,'do not delete any files');await tick();await h.advance(900)
 assert.equal(h.sent.length,0);assert.match(h.notices.at(-1),/too long.*Nothing was sent/)
})

test('voice holds automatic queue drains in other views until a complete instruction',async()=>{
 const queue=await import('../../src/session-outbox.js'),sessionId='duplex-shared-queue'
 const binding={sessionId:'speech-shared',targetAgentId:sessionId,generation:1,speechEpoch:1}
 let endpoint;const sent=[]
 const c=createVoiceController({queue,schedule:fn=>{endpoint=fn;return 1},unschedule:()=>{endpoint=null},
 agent:{interrupt:async()=>{},send:async p=>{sent.push(p);return {turnId:'turn'}}},voice:{reply:async()=>{},interrupt:async()=>({})}})
 try {
 c.bind(binding);queue.enqueue(sessionId,'Previously queued typed instruction')
 c.onVoice({...binding,type:'speech.started'});await tick()
 assert.equal(queue.takeNext(sessionId),null,'a different view cannot burn tokens on completion')
 c.onVoice({...binding,type:'transcript.final',utteranceId:'u',text:'My continued instruction'});await tick()
 assert.equal(queue.takeNext(sessionId),null);endpoint();await tick();assert.equal(sent.length,1)
 c.unbind();assert.equal(queue.takeNext(sessionId).text,'My continued instruction')
 } finally {c.unbind();queue.clearSession(sessionId)}
})

test('a canceled turn first observed after new admission can never speak',async()=>{
 const h=harness({interrupt:()=>({turnId:'old-turn'})});h.start(1);h.final(1,'New instruction');await tick();await h.advance(900)
 h.event('assistant_text_delta','Stale old reply. ','old-turn');h.event('turn_completed','', 'old-turn')
 h.event('assistant_text_delta','Current reply. ','new-turn');h.event('turn_completed','', 'new-turn');await tick()
 assert.equal(h.spoken.map(v=>v.text).join(''),'Current reply. ')
})
