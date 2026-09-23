import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import accountModule from '../../shell/product-account.cjs'
import controllerModule from '../../shell/hosted-account-controller.cjs'
const googleIdentity={provider:'google',subject:'google-fixture',email:'person@example.invalid',emailVerified:true,assurance:accountModule.REQUIRED_IDENTITY_ASSURANCE}
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}}
test('concurrent hosted status reads preserve a verification refusal without consulting cached local identity', async () => {
 const reply=deferred()
 let reads=0,localReads=0
 const controller=controllerModule.createHostedAccountController({
  client:{hasSession:()=>true,current(){reads++;return reply.promise}},
  store:{current(){localReads++;throw Error('cached identity must not answer a failed verification')},currentForRenderer(){localReads++;return {signedIn:true}}},
 })
 const first=controller.current(),second=controller.current()
 reply.resolve({ok:false,code:'HOSTED_ACCOUNT_UNAVAILABLE'})
 for (const result of await Promise.all([first,second])) {
  assert.equal(result.ok,false)
  assert.equal(result.code,'HOSTED_ACCOUNT_STATUS_UNAVAILABLE')
  assert.equal(result.signedIn,undefined)
 }
 assert.equal(reads,1)
 assert.equal(localReads,0)
})
test('actual current-account IPC forwards verification failure and preserves the erase fence', async () => {
 const source=fs.readFileSync(new URL('../../shell/main.cjs',import.meta.url),'utf8')
 const start=source.indexOf("ipcMain.handle('mc-account:current'")
 const end=source.indexOf('\n/*',start)
 assert.ok(start>=0&&end>start)
 for(const resetting of [false,true]) {
  let handler,controllerReads=0,storeReads=0
  const refusal={ok:false,code:'HOSTED_ACCOUNT_STATUS_UNAVAILABLE'}
  new Function('ipcMain','withFleetProfileSender','accountResetStarted','getHostedAccountController','getAccountStore',source.slice(start,end))(
   {handle(_name,fn){handler=fn}},(_event,action)=>action(),resetting,
   ()=>({current(){controllerReads++;return refusal},refresh(){return refusal}}),
   ()=>({currentForRenderer(){storeReads++;return {signedIn:false}}}))
  assert.deepEqual(await handler({}),resetting?{signedIn:false}:refusal)
  assert.equal(controllerReads,resetting?0:1)
  assert.equal(storeReads,resetting?1:0)
 }
})
test('idle controller cancellation never calls the client logout/cancel boundary',async()=>{
 let calls=0
 const controller=controllerModule.createHostedAccountController({client:{cancelSignIn(){calls++;throw Error('must not cancel completed session')}},store:{}})
 assert.deepEqual(await controller.cancelSignIn(),{ok:true,cancelled:false})
 assert.equal(calls,0)
})
test('completed hosted client admission awaiting controller continuation is not cancelled',async()=>{
 const reply=deferred()
 let admitted=false,cancels=0
 const controller=controllerModule.createHostedAccountController({
  client:{signIn:()=>reply.promise,hasPendingSignIn:()=>false,cancelSignIn(){cancels++}},
  store:{signInWithHostedAccount(){admitted=true;return {ok:true}}},
 })
 const pending=controller.signIn({username:'fixture@example.invalid',password:'fixture'})
 reply.resolve({ok:true})
 assert.deepEqual(await controller.cancelSignIn(),{ok:true,cancelled:false})
 assert.equal((await pending).ok,true)
 assert.equal(admitted,true)
 assert.equal(cancels,0)
})
test('actual main cancel handler refreshes account retention through the mutation boundary',async()=>{
 const source=fs.readFileSync(new URL('../../shell/main.cjs',import.meta.url),'utf8')
 const start=source.indexOf("ipcMain.handle('mc-account:google-cancel'")
 const end=source.indexOf('\n/**',start)
 assert.ok(start>=0&&end>start)
 let handler,mirrored=0
 const mutation=async(_event,action)=>{try{return await action()}finally{mirrored++}}
 new Function('ipcMain','withAccountMutation','withFleetProfileSender','hostedAccountClient','getHostedAccountController','googleSignInAttempt',source.slice(start,end))(
  {handle(_name,fn){handler=fn}},mutation,(_event,action)=>action(),
  {browserAuthorizationAddress:()=>null},()=>({cancelSignIn:async()=>({ok:true,cancelled:false})}),null)
 assert.deepEqual(await handler({}),{ok:true,cancelled:false})
 assert.equal(mirrored,1)
})
function fixture(t) {
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hosted-controller-'))
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}))
 let verified=null,hasSession=false
 const client={
  verifiedAccount:()=>verified,hasSession:()=>hasSession,sessionPersisted:()=>false,
  async signIn(){verified={id:'hosted-fixture',email:'person@example.invalid'};hasSession=true;return {ok:true,account:verified}},
  async current(){return {ok:true,signedIn:Boolean(verified)}},
  async signOut(){verified=null;hasSession=false;return {ok:true,remoteEnded:true}},
 }
 const store=accountModule.createAccountStore({directory,hostedAccount:client})
 return {client,store,controller:controllerModule.createHostedAccountController({client,store})}
}
test('Google sign-in cannot complete after sign-out',async t=>{
 const {store,controller}=fixture(t),flow=deferred(),entered=deferred()
 const pending=controller.signInGoogle(()=>{entered.resolve();return flow.promise})
 await entered.promise
 await controller.signOut()
 flow.resolve({ok:true,identity:googleIdentity})
 assert.equal((await pending).code,'HOSTED_ACCOUNT_CANCELLED')
 assert.equal(store.current().signedIn,false)
})
test('Google and password sign-in share one transition owner',async t=>{
 const {controller,store}=fixture(t),flow=deferred(),entered=deferred()
 const pending=controller.signInGoogle(()=>{entered.resolve();return flow.promise})
 await entered.promise
 assert.equal((await controller.signIn({username:'person@example.invalid',password:'fixture'})).code,'HOSTED_ACCOUNT_BUSY')
 flow.resolve({ok:true,identity:googleIdentity})
 const result=await pending
 assert.equal(result.ok,true)
 assert.equal(store.current().account.signInMethod,'google')
 assert.equal('identity' in result,false)
})
test('Google cancellation invalidates an already requested provider flow',async t=>{
 const {controller,store}=fixture(t),flow=deferred(),entered=deferred()
 const pending=controller.signInGoogle(()=>{entered.resolve();return flow.promise})
 await entered.promise
 controller.cancelSignIn()
 flow.resolve({ok:true,identity:googleIdentity})
 assert.equal((await pending).ok,false)
 assert.equal(store.current().signedIn,false)
})
test('switching from hosted to Google clears the saved hosted session and retains separate local partitions',async t=>{
 const {client,controller,store}=fixture(t)
 const first=await controller.signIn({username:'person@example.invalid',password:'fixture'})
 assert.equal(first.ok,true)
 assert.equal(store.putSetting({key:'mc.theme',value:'black'}).ok,true)
 const second=await controller.signInGoogle(async()=>({ok:true,identity:googleIdentity}))
 assert.equal(second.ok,true)
 assert.notEqual(second.account.id,first.account.id)
 assert.equal(store.getSetting('mc.theme').value,null)
 assert.equal(client.hasSession(),false)
 await controller.refresh()
 assert.equal(store.current().account.signInMethod,'google')
})
test('failed deletion of a saved hosted login prevents switching to Google',async t=>{
 const {client,controller}=fixture(t)
 client.signOut=async()=>({ok:true,remoteEnded:false,localCleared:false})
 let started=false
 const result=await controller.signInGoogle(async()=>{started=true;return {ok:true,identity:googleIdentity}})
 assert.equal(result.code,'HOSTED_ACCOUNT_LOCAL_CLEAR_FAILED')
 assert.equal(started,false)
})
test('late local password success cannot undo sign-out',async t=>{
 const {controller,store}=fixture(t),local=deferred(),entered=deferred()
 // A boundary fixture drives the expensive password-comparison await. Its
 // completion is explicitly checked for cleanup; no customer store is used.
 let signedIn=false
 const stubStore={...store,signIn:async()=>{entered.resolve();await local.promise;signedIn=true;return {ok:true}},signOut(){signedIn=false;return {ok:true}}}
 const client={hasSession:()=>false,signOut:async()=>({ok:true,remoteEnded:true})}
 const subject=controllerModule.createHostedAccountController({client,store:stubStore})
 const pending=subject.signIn({username:'localuser',password:'fixture'})
 await entered.promise
 await subject.signOut()
 local.resolve()
 assert.equal((await pending).code,'HOSTED_ACCOUNT_CANCELLED')
 assert.equal(signedIn,false)
})
test('hosted Google selects the hosted subject partition and preserves an older local Google profile',async t=>{
 const {client,controller,store}=fixture(t)
 const prior=await controller.signInGoogle(async()=>({ok:true,identity:googleIdentity}))
 assert.equal(store.putSetting({key:'mc.theme',value:'black'}).ok,true)
 client.signInBrowser=async({provider})=>{assert.equal(provider,'google');return client.signIn()}
 const hosted=await controller.signInHostedGoogle()
 assert.equal(hosted.ok,true)
 assert.notEqual(hosted.account.id,prior.account.id)
 assert.equal(store.current().account.signInMethod,'hosted')
 assert.equal(store.getSetting('mc.theme').value,null)
 const restored=await controller.signInGoogle(async()=>({ok:true,identity:googleIdentity}))
 assert.equal(restored.account.id,prior.account.id)
 assert.equal(store.getSetting('mc.theme').value,'black')
})
test('cancel and local sign-in cannot race a pending hosted Google transition',async t=>{
 const {client,controller,store}=fixture(t),entered=deferred(),release=deferred()
 let cancelled=0
 client.cancelSignIn=async()=>{cancelled++}
 client.signInBrowser=async()=>{entered.resolve();await release.promise;return client.signIn()}
 const pending=controller.signInHostedGoogle()
 await entered.promise
 assert.equal((await controller.signIn({username:'localuser',password:'fixture'})).code,'HOSTED_ACCOUNT_BUSY')
 await controller.cancelSignIn()
 release.resolve()
 assert.equal((await pending).code,'HOSTED_ACCOUNT_CANCELLED')
 assert.equal(cancelled,1)
 assert.equal(store.current().signedIn,false)
})
test('the explicit previous-profile transition cannot create a new local Google account',async t=>{
 const {controller,store}=fixture(t)
 const result=await controller.signInGoogle(async()=>({ok:true,identity:googleIdentity}),{existingOnly:true})
 assert.equal(result.code,'ACCOUNT_GOOGLE_PROFILE_NOT_FOUND')
 assert.equal(store.hasGoogleProfiles(),false)
 assert.equal(store.current().signedIn,false)
})
