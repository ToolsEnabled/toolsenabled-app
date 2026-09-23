import test from 'node:test'
import assert from 'node:assert/strict'
import { createImageOwnerClient } from '../../src/image-owner-client.js'
const context = (ownerId = 'local-owner', currentEpoch = 'epoch-1', kind = 'local') => ({ version: 1, ownerId, currentEpoch, kind })
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b }); return { promise, resolve, reject } }
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
function fixture(read) {
  let listener, removed = 0
  const notices = [], order = []
  const bridge = { onOwnerContextChanged(callback) { order.push('subscribe'); listener=callback; return () => { removed++ } }, ownerContext() { order.push('read'); return read() } }
  const client = createImageOwnerClient({ bridge, onChange: state => notices.push(state) })
  return { client, notices, order, emit: value => listener(value), removed: () => removed }
}
test('missing bridge is unavailable, no fallback owner authority', async () => {
  const client = createImageOwnerClient({ bridge: {} })
  assert.equal((await client.start()).status, 'unavailable'); assert.equal(client.capture(), null)
  client.dispose()
})
test('subscribe precedes read; local authority preserved exactly', async () => {
  const f=fixture(async () => context())
  await f.client.start()
  assert.deepEqual(f.order, ['subscribe','read'])
  assert.deepEqual(f.client.capture(), context())
  assert.equal(f.client.isCurrent(f.client.capture()), true)
  assert.equal(f.client.isCurrent(context()), false, 'uncaptured lookalike cannot authorize a callback')
  f.client.dispose(); f.client.dispose(); assert.equal(f.removed(), 1)
})
test('initial read event discards overtaken response and coalesces a fresh read', async () => {
  let calls=0, f
  f=fixture(async () => { calls++; if(calls===1) { f.emit(context('next','epoch-2','account')); return context() } return context('next','epoch-2','account') })
  await f.client.start()
  assert.equal(calls, 2)
  assert.deepEqual(f.notices.filter(n=>n.status==='ready').map(n=>n.ownerContext), [context('next','epoch-2','account')])
  f.client.dispose()
})
test('concurrent refresh requests serialize reads and never publish delayed old completion', async () => {
  const first=deferred(), second=deferred(); let calls=0
  const f=fixture(() => ++calls===1 ? first.promise : second.promise)
  const start=f.client.start(); await tick()
  f.emit({version:1,invalidated:true}); const a=f.client.refresh(), b=f.client.refresh()
  assert.equal(calls, 1); assert.equal(a,b)
  second.resolve(context('new','epoch-2','account'))
  first.resolve(context())
  await start
  assert.equal(calls,2)
  assert.deepEqual(f.notices.filter(n=>n.status==='ready').map(n=>n.ownerContext), [context('new','epoch-2','account')])
  f.client.dispose()
})
test('invalidation fences captured callbacks synchronously and does not consume external intent', async () => {
  let value=context(); const f=fixture(async()=>value)
  const intent={text:'  keep\n  ',images:[{path:'/first'},{path:'/second'}],state:'unknown'}
  const before=structuredClone(intent)
  await f.client.start(); const old=f.client.capture()
  value=context('account','epoch-2','account')
  f.emit({version:1,invalidated:true})
  assert.equal(f.client.capture(),null); assert.equal(f.client.isCurrent(old),false)
  await tick()
  assert.equal(f.client.capture().ownerId,'account'); assert.deepEqual(intent,before)
  f.client.dispose()
})
test('local account local transition requires new epoch, never revives old capture', async () => {
  let value=context(); const f=fixture(async()=>value)
  await f.client.start(); const old=f.client.capture()
  value=context('account','epoch-2','account'); f.emit(value); await tick()
  const account=f.client.capture()
  value=context('local-owner','epoch-3','local'); f.emit(value); await tick()
  assert.equal(f.client.capture().ownerId,old.ownerId)
  assert.notEqual(f.client.capture().currentEpoch,old.currentEpoch)
  assert.equal(f.client.isCurrent(old),false); assert.equal(f.client.isCurrent(account),false)
  f.client.dispose()
})
test('dispose during pending read suppresses late publication and unsubscribes once', async () => {
  const wait=deferred(); const f=fixture(()=>wait.promise)
  const pending=f.client.start(); await tick()
  f.client.dispose(); const count=f.notices.length
  wait.resolve(context()); await pending
  f.emit(context('other'))
  assert.equal(f.notices.length,count); assert.equal(f.removed(),1); assert.equal(f.client.capture(),null)
})
test('invalid or refused owner read closes admission without retaining cached authority', async () => {
  let value=context(); const f=fixture(async()=> { if(value instanceof Error)throw value; return value })
  await f.client.start(); const old=f.client.capture()
  value={version:1,invalidated:true}; await f.client.refresh()
  assert.equal(f.client.capture(),null); assert.equal(f.client.isCurrent(old),false)
  value=Object.assign(new Error('changed'),{code:'IMAGE_OWNER_CHANGED'}); await f.client.refresh()
  assert.equal(f.client.snapshot().code,'IMAGE_OWNER_CHANGED')
  f.client.dispose()
})

test('reentrant refresh while pending coalesces rather than recursively publishing', async () => {
  let client, reads=0, refreshed=false
  client=createImageOwnerClient({ bridge:{onOwnerContextChanged:()=>()=>{},ownerContext:async()=>{reads++;return context()}},
    onChange: state=> {if(state.status==='pending'&&!refreshed){refreshed=true;void client.refresh()}} })
  await client.start()
  assert.equal(reads,1); assert.equal(client.snapshot().status,'ready');client.dispose()
})
test('disposal from pending publication prevents host read', async () => {
  let client, reads=0, off=0
  client=createImageOwnerClient({bridge:{onOwnerContextChanged:()=>()=>{off++},ownerContext:async()=>{reads++;return context()}},
    onChange:state=>{if(state.status==='pending')client.dispose()} })
  await client.start();assert.equal(reads,0);assert.equal(off,1);assert.equal(client.capture(),null)
})
test('synchronous subscription invalidation followed by disposal still releases listener', async () => {
  let client, reads=0, off=0
  client=createImageOwnerClient({bridge:{onOwnerContextChanged:fn=>{fn({version:1,invalidated:true});return()=>{off++}},ownerContext:async()=>{reads++;return context()}},
    onChange:()=>client.dispose()})
  await client.start();assert.equal(reads,0);assert.equal(off,1)
})

test('event queued after ready publication cannot be lost at flight settlement', async () => {
  let listener, client, reads=0, queued=false
  client=createImageOwnerClient({bridge:{onOwnerContextChanged:fn=>{listener=fn;return()=>{}},ownerContext:async()=>{reads++;return context('owner','epoch-'+reads)}},
    onChange:state=>{if(state.status==='ready'&&!queued){queued=true;queueMicrotask(()=>listener({version:1,invalidated:true}))}}})
  await client.start();await tick()
  assert.equal(reads,2);assert.equal(client.capture().currentEpoch,'epoch-2');client.dispose()
})
