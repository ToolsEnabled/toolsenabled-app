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
