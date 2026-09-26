import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createImageOwnerContext } = require('../../shell/image-owner-context.cjs')
test('host local owner persists namespace but context does not survive restart', () => {
  const create = () => createImageOwnerContext({scope:'owned-installation',readState:()=>({principal:'unauthenticated',signedIn:false})})
  const a=create(), b=create(), first=a.read()
  assert.equal(first.kind,'local')
  assert.equal(a.authenticate(first).authenticated,true)
  assert.equal(b.read().ownerId,first.ownerId)
  assert.notEqual(b.read().currentEpoch,first.currentEpoch)
  assert.throws(()=>b.authenticate(first),{code:'IMAGE_OWNER_CHANGED'})
})
test('account mutation invalidates before dispatch and fences same-account ABA', () => {
  let state={principal:'account:a',signedIn:true,session:{id:'session-a'}}
  const notices=[]
  const gate=createImageOwnerContext({scope:'owned-installation',readState:()=>state,publish:v=>notices.push(v)})
  const initial=gate.read(), end=gate.beginMutation()
  assert.throws(()=>gate.authenticate(initial),{code:'IMAGE_OWNER_CHANGED'})
  state={principal:'account:b',signedIn:true,session:{id:'session-b'}}
  end()
  assert.notEqual(gate.read().ownerId,initial.ownerId)
  const endAgain=gate.beginMutation()
  state={principal:'account:a',signedIn:true,session:{id:'session-a'}}
  endAgain()
  assert.equal(gate.read().ownerId,initial.ownerId)
  assert.throws(()=>gate.authenticate(initial),{code:'IMAGE_OWNER_CHANGED'})
  assert.equal(notices.filter(n=>n.invalidated).length,2)
})
test('external expiry or sign-in changes invalidate before storage access', () => {
  let state={principal:'account:a',signedIn:true,session:{id:'one'}}
  const gate=createImageOwnerContext({scope:'owned-installation',readState:()=>state})
  const initial=gate.read()
  state={principal:'unauthenticated',signedIn:false}
  assert.throws(()=>gate.authenticate(initial),{code:'IMAGE_OWNER_CHANGED'})
  assert.equal(gate.read().kind,'local')
  assert.throws(()=>gate.authenticate({...gate.read(),ownerId:'renderer-choice'}),{code:'IMAGE_OWNER_CHANGED'})
})

// Found by hand on published 1.0.46 (2026-09-25): after every relaunch the first agent start was
// refused "this copy could not work out why". The host announced its FIRST context as a change, the
// notice reached the page that had just read it, the page re-read, and the start's captured owner was
// no longer current (IMAGE_OWNER_CHANGED). This drives the real host module and the real page client
// through an IPC stand-in that delivers notices after the read answers, as Electron does.
test('the first owner context is not announced as a change, so the page that read it keeps it', async () => {
  const { createImageOwnerClient } = await import('../../src/image-owner-client.js')
  let state = { principal: 'account:a', signedIn: true, session: { id: 'one' } }
  const pages = new Set()
  const notices = []
  const host = createImageOwnerContext({ scope: 'owned-installation', readState: () => state,
    publish: value => { notices.push(value); for (const page of pages) setImmediate(() => page(value)) } })
  const bridge = {
    ownerContext: async () => host.read(),
    onOwnerContextChanged: listener => { pages.add(listener); return () => pages.delete(listener) },
  }
  const client = createImageOwnerClient({ bridge })
  await client.start()
  const captured = client.capture()
  assert.ok(captured, 'the start captures an owner')
  for (let i = 0; i < 5; i++) await new Promise(setImmediate)
  assert.deepEqual(notices, [], 'nothing was replaced, so nothing is announced')
  assert.equal(client.isCurrent(captured), true, 'the start that captured it is still current')
  assert.equal(host.authenticate(captured).authenticated, true)

  // A real change still reaches the page and fences the old context.
  state = { principal: 'unauthenticated', signedIn: false }
  host.read()
  for (let i = 0; i < 5; i++) await new Promise(setImmediate)
  assert.equal(notices.length, 1, 'a sign-out is announced once')
  assert.equal(client.isCurrent(captured), false, 'and a start holding the old owner is refused')
  client.dispose()
})
