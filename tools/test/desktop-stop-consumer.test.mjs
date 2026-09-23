import test from 'node:test'
import assert from 'node:assert/strict'
import { readDesktopStopTarget, readDesktopStopReceipt, readDesktopSessionList, desktopStopController } from '../../src/desktop-sessions.js'
const target = Object.freeze({version:1, treeId:'tree-a', nodeId:'node-a',sessionId:'session-a',revision:'a'.repeat(64)})
const id = '11111111-2222-3333-4444-555555555555'
const row = {sessionId:target.sessionId,nodeId:target.nodeId,stopTarget:target,openable:true}
const list = (extra={}) => ({ok:true,mayWrite:true,desktopStopVersion:1,sessions:[row],...extra})
const receipt = (request,extra={}) => ({ok:true,...request,state:'pending',closed:false,savedState:'pending',...extra})
function fixture(extra={}) {
 let scope=1; const calls=[]; const changed=[],completed=[]
 const bridge={stopVersion:1,stopScope:()=>scope,list:async()=>list(),stop:async r=>{calls.push(['stop',r]);return receipt(r)},stopStatus:async r=>{calls.push(['status',r]);return receipt({requestId:r.requestId,target})},...extra}
 const options={bridge,row,mayWrite:true,randomUUID:()=>id,changed:m=>changed.push(m),completed:r=>completed.push(r)}
 return {bridge,options,calls,changed,completed,scope:()=>scope++,controller:desktopStopController(options)}
}
test('native version and exact node/session decide target capability',()=>{
 assert.equal(readDesktopSessionList({...list(),desktopStopVersion:undefined}).rows[0].stopTarget,undefined)
 assert.deepEqual(readDesktopSessionList(list()).rows[0].stopTarget,target)
 for(const bad of [null,{...target,revision:'bad'},{...target,version:2},{...target,nodeId:'other'}]) assert.equal(readDesktopStopTarget(bad,row),null)
})
test('receipt cannot claim completion without exact target, closure and saved record',()=>{
 const r={requestId:id,target};assert.equal(readDesktopStopReceipt(receipt(r),r).state,'pending')
 for(const bad of [null,[],receipt(r,{requestId:'other'}),receipt(r,{target:{...target,nodeId:'b'}}),receipt(r,{state:'completed'}),receipt(r,{state:'completed',closed:true,savedState:'unconfirmed'}),receipt(r,{state:'refused',ok:false})])assert.equal(readDesktopStopReceipt(bad,r),null)
 assert.equal(readDesktopStopReceipt(receipt(r,{state:'completed',closed:true,savedState:'recorded'}),r).state,'completed')
})
test('one Stop then status only, retained across mounted controller replacement',async()=>{
 const f=fixture();await f.controller.run();assert.equal(f.controller.blocksSend,true)
 const b=desktopStopController(f.options);await b.run();assert.deepEqual(f.calls.map(x=>x[0]),['stop','status']);assert.equal(b.request.requestId,id);assert.equal(f.completed.length,0)
})
test('genuine completion refreshes once and does not synthesize a native tree',async()=>{
 const f=fixture({stop:async r=>receipt(r,{state:'completed',closed:true,savedState:'recorded'})});await f.controller.run();await f.controller.run();assert.equal(f.completed.length,1);assert.match(f.controller.message,/stopped.*saved/);assert.equal(f.controller.action().enabled,false)
})
test('lost answer is uncertain and never sends a second Stop',async()=>{
 const f=fixture({stop:async r=>{f.calls.push(['stop',r]);throw Error('lost')}});await f.controller.run();assert.match(f.controller.message,/answer was lost/);await f.controller.run();assert.deepEqual(f.calls.map(x=>x[0]),['stop','status'])
})
test('unknown closure and unconfirmed save remain attention, not success',async()=>{
 for(const closed of [true,false]){const f=fixture({stop:async r=>receipt(r,{state:'needs-attention',closed,savedState:closed?'unconfirmed':'pending'})});await f.controller.run();assert.equal(f.completed.length,0);assert.equal(f.controller.blocksSend,true);assert.match(f.controller.message,/not confirmed/)}
})
test('refused receipt is not-sent and permits ordinary send, without automatic Stop retry',async()=>{
 const f=fixture({stop:async r=>receipt(r,{ok:false,state:'refused',outcome:'not-sent'})});await f.controller.run();assert.match(f.controller.message,/refused/);assert.equal(f.controller.blocksSend,false);assert.equal(f.controller.action().enabled,false)
})
test('read-only and absent capability never call native Stop',async()=>{
 for(const opts of [{mayWrite:false},{row:{...row,stopTarget:null}},{bridge:{list:async()=>list()}}]){const f=fixture();const c=desktopStopController({...f.options,...opts});await c.run();assert.equal(c.action().enabled,false);assert.equal(f.calls.length,0)}
})
test('fresh list replacement or write revocation refuses before POST',async()=>{
 for(const answer of [list({mayWrite:false}),list({desktopStopVersion:undefined}),list({sessions:[{...row,stopTarget:{...target,revision:'b'.repeat(64)}}]})]){const f=fixture({list:async()=>answer});await f.controller.run();assert.equal(f.calls.length,0);assert.equal(f.controller.request,null)}
})
test('source boundary during preflight prevents destructive call',async()=>{
 let release;const f=fixture({list:()=>new Promise(r=>release=r)});const p=f.controller.run();f.scope();release(list());await p;assert.equal(f.calls.length,0);assert.equal(f.controller.action().enabled,false)
})
test('account or view change during POST discards response effects',async()=>{
 for(const source of [true,false]){let release;let active=true;const f=fixture({stop:r=>new Promise(resolve=>release=()=>resolve(receipt(r,{state:'completed',closed:true,savedState:'recorded'})))});const c=desktopStopController({...f.options,isCurrent:()=>active});const p=c.run();await Promise.resolve();if(source)f.scope();else active=false;release();await p;assert.equal(f.completed.length,0);assert.equal(c.action().enabled,false)}
})
test('double click admits only one destructive POST',async()=>{
 let release;const f=fixture({stop:r=>{f.calls.push(['stop',r]);return new Promise(resolve=>release=()=>resolve(receipt(r)))}});const p=f.controller.run();await Promise.resolve();await f.controller.run();release();await p;assert.equal(f.calls.length,1)
})
test('stale status receipt cannot be consumed by a new account',async()=>{
 let release;const f=fixture({stopStatus:r=>new Promise(resolve=>release=()=>resolve(receipt({requestId:r.requestId,target},{state:'completed',closed:true,savedState:'recorded'})))});await f.controller.run();const p=f.controller.run();f.scope();release();await p;assert.equal(f.completed.length,0)
})
test('merely opening 100 chats does not consume operation capacity',async()=>{
 const f=fixture();for(let i=0;i<100;i++)desktopStopController({...f.options,row:{...row,stopTarget:{...target,revision:i.toString(16).padStart(64,'0')}}})
 await f.controller.run();assert.equal(f.calls.length,1)
})
test('new source can operate after 64 prior-scope unresolved requests',async()=>{
 const f=fixture();for(let i=0;i<64;i++){
   const t={...target,revision:i.toString(16).padStart(64,'0')},r={...row,stopTarget:t};f.bridge.list=async()=>list({sessions:[r]})
   await desktopStopController({...f.options,row:r}).run()
 }
 assert.equal(f.calls.length,64);f.scope();f.bridge.list=async()=>list();await desktopStopController(f.options).run();assert.equal(f.calls.length,65)
})
test('retained request remains current through final receipt after native row vanishes',async()=>{
 let rowExists=true,control;const f=fixture({stopStatus:r=>{rowExists=false;return Promise.resolve(receipt({requestId:r.requestId,target},{state:'completed',closed:true,savedState:'recorded'}))}})
 control=desktopStopController({...f.options,isCurrent:()=>rowExists||Boolean(control?.request)});await control.run();await control.run();assert.equal(f.completed.length,1);assert.match(control.message,/stopped.*saved/)
})
