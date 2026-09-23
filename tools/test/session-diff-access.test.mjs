import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { canonicalRootForTests } from '../canonical-root.mjs'
import { testScratchRoot } from '../lib/test-scratch-root.mjs'
import { createFleetTreeStore } from '../../src/fleet-trees.js'
const require = createRequire(import.meta.url)
const engine = canonicalRootForTests({ requireConfigured: true })
const { createSessionDiffAccess } = require('../../shell/session-diff-access.cjs')
const { createDiffFiles } = require('../../shell/diff-file.cjs')
const { createSessionProfileStore } = require('../../shell/session-profiles.cjs')
const { assertAccountProfilePath } = require(path.join(engine,'src/lib/account-profile-boundary.js'))
const { captureWorkspaceCeiling, intersectWorkspaceCeiling } = require(path.join(engine,'src/lib/session-workspace-ceiling.js'))
function fixture() {
  const root=fs.mkdtempSync(testScratchRoot('session-diff-access-'))
  const chosen=path.join(root,'chosen'), project=path.join(root,'project'), other=path.join(root,'other')
  for(const folder of [chosen,project,other])fs.mkdirSync(folder)
  const file=path.join(project,'edited.txt'); fs.writeFileSync(file,'current\n')
  const profiles=createSessionProfileStore({file:path.join(root,'profiles.json')})
  const profile=profiles.create({name:'Synthetic project',cwd:project})
  const cells=new Map()
  const store=createFleetTreeStore({computerId:'this-computer',storage:{read:key=>cells.get(key)||null,write:(key,value)=>{cells.set(key,structuredClone(value));return true}}})
  const node=store.addNode({name:'Synthetic complete work'}).node
  store.setTreeProfile(node.treeId,profile.id)
  store.attachSession(node.id,'session-one'); store.setNodeStatus(node.id,'finished')
  const owner={isDestroyed:()=>false}
  const session={owner,ownerKind:'window',cwd:project,profileId:profile.id,treeNodeId:node.id,started:{sequence:1},state:'ready',ended:false}
  const sessions=new Map([['session-one',session]])
  const defaultFiles=createDiffFiles({fs,path,workspaceRoots:()=>[chosen]})
  const make=(overrides={})=>createSessionDiffAccess({fs,path,sessions,readDefault:candidate=>defaultFiles.readChange(candidate),
    stampDefault:candidate=>defaultFiles.stamp(candidate),writeDefault:(candidate,text)=>defaultFiles.write(candidate,text),
    readPreferences:()=>({ok:true,values:Object.fromEntries([...cells].map(([key,value])=>[key,JSON.stringify(value)]))}),
    resolveProfile:id=>profiles.resolveCwd(id),assertPath:candidate=>assertAccountProfilePath(candidate),
    captureCeiling:captureWorkspaceCeiling,intersectCeiling:intersectWorkspaceCeiling,...overrides})
  const service=make(); service.remember('session-one',session)
  return {root,chosen,project,other,file,profiles,profile,store,node,owner,session,sessions,defaultFiles,service,make,cells,
    read:(serviceOverride=service,id='session-one',pathOverride=file)=>serviceOverride.read(owner,{sessionId:id,path:pathOverride})}
}

test('T57 an owned registered-project diff can save an edited version and read it back',()=>{
  const f=fixture()
  assert.equal(typeof f.service.write,'function','The registered project needs a guarded save route')
  assert.equal(f.read().readOnly,false)
  assert.equal(f.service.write(f.owner,{sessionId:'session-one',path:f.file,text:'my correction\n'}).ok,true)
  assert.equal(fs.readFileSync(f.file,'utf8'),'my correction\n')
  assert.equal(f.read().text,'my correction\n')
  assert.equal(f.defaultFiles.write(f.file,'unbound').code,'MC_DIFF_OUTSIDE_WORKSPACE')
})
test('a finished turn retains guarded access to its registered project without granting unbound writes',()=>{
  const f=fixture(); const answer=f.read()
  assert.equal(answer.ok,true);assert.equal(answer.text,'current\n');assert.equal(answer.readOnly,false)
  assert.equal(f.defaultFiles.write(f.file,'unexpected').code,'MC_DIFF_OUTSIDE_WORKSPACE')
  assert.equal(fs.readFileSync(f.file,'utf8'),'current\n')
})
test('natural child exit preserves the owned review association',()=>{
  const f=fixture();f.session.state='ended';f.session.ended=true
  f.service.ended('session-one',f.session,'exited');f.sessions.delete('session-one')
  assert.equal(f.read().ok,true)
})

test('T347 unexpected registered-session file work is distinct from revoked authority',()=>{
  const f=fixture()
  const brokenFs={...fs,statSync:candidate=>{
    const stat=fs.statSync(candidate)
    if(candidate===f.file)stat.isFile=()=>{throw Error('fixture-internal-details')}
    return stat
  }}
  const service=f.make({fs:brokenFs})
  assert.deepEqual(f.read(service),{ok:false,code:'MC_DIFF_HANDLER_FAILED'})
  // A failed read grants no edit authority.
  assert.equal(service.write(f.owner,{sessionId:'session-one',path:f.file,text:'unwanted'}).ok,false)
  service.ended('session-one',f.session,'closed')
  assert.deepEqual(f.read(service),{ok:false,code:'MC_DIFF_SESSION_SCOPE_UNAVAILABLE'})
  assert.equal(fs.readFileSync(f.file,'utf8'),'current\n')
})

test('session saves refuse unopened paths, other senders, revoked and rebound sessions without changing files',()=>{
  for(const variant of ['unopened','other-file','sender','closed','replaced','profile','directory','link']) {
    const f=fixture(); if(variant!=='unopened')assert.equal(f.read().ok,true)
    let target=f.file, owner=f.owner
    if(variant==='other-file'){target=path.join(f.project,'other.txt');fs.writeFileSync(target,'current\n')}
    if(variant==='sender')owner={isDestroyed:()=>false}
    if(variant==='closed')f.service.ended('session-one',f.session,'closed')
    if(variant==='replaced')f.sessions.set('session-one',{...f.session})
    if(variant==='profile')f.profiles.remove(f.profile.id)
    if(variant==='directory'){fs.renameSync(f.project,path.join(f.root,'old-project'));fs.mkdirSync(f.project);fs.writeFileSync(f.file,'current\n')}
    let outside=null
    if(variant==='link') {
      outside=path.join(f.other,'target.txt');fs.writeFileSync(outside,'outside\n')
      fs.unlinkSync(f.file);fs.symlinkSync(outside,f.file,'file')
    }
    const before=fs.readFileSync(target,'utf8')
    const answer=f.service.write(owner,{sessionId:'session-one',path:target,text:'unexpected\n',cwd:f.project})
    assert.equal(answer.ok,false,variant)
    assert.equal(fs.readFileSync(target,'utf8'),before,variant)
    if(outside)assert.equal(fs.readFileSync(outside,'utf8'),'outside\n')
  }
})

test('an opened deleted file can be restored through the same session while unbound saves stay fenced',()=>{
  const f=fixture();fs.unlinkSync(f.file)
  assert.equal(f.read().exists,false)
  assert.equal(f.service.stamp(f.owner,{sessionId:'session-one',path:f.file}).exists,false)
  assert.equal(f.service.write(f.owner,{sessionId:'session-one',path:f.file,text:'restored\r\n'}).ok,true)
  assert.equal(fs.readFileSync(f.file,'utf8'),'restored\r\n')
  assert.equal(f.service.write(f.owner,{path:f.file,text:'unbound'}).ok,false)
})
test('explicit close revokes process access; an app reload can independently use the current saved profile',()=>{
  const f=fixture();f.service.ended('session-one',f.session,'closed');f.sessions.delete('session-one')
  assert.equal(f.read().code,'MC_DIFF_SESSION_SCOPE_UNAVAILABLE')
  const reloaded=f.make();const answer=f.read(reloaded)
  assert.equal(answer.ok,true);assert.equal(answer.readOnly,false);assert.equal(answer.text,'current\n')
})
test('forged, removed, or replaced saved session identities cannot recover a root',()=>{
  for(const mutation of ['forged','removed','replaced']){
    const f=fixture();f.sessions.clear()
    if(mutation==='removed')assert.equal(f.store.removeNode(f.node.id).ok,true)
    if(mutation==='replaced')f.store.attachSession(f.node.id,'replacement')
    assert.equal(f.read(f.make(),mutation==='forged'?'forged-session':'session-one').ok,false,mutation)
  }
})
test('a live replacement or unrelated sender cannot use a retained association',()=>{
  const f=fixture()
  assert.equal(f.service.read({isDestroyed:()=>false},{sessionId:'session-one',path:f.file}).ok,false)
  f.sessions.set('session-two',{...f.session})
  assert.equal(f.read().ok,false)
})
test('removed and rebound profile IDs cannot authorize the old file',()=>{
  const f=fixture();f.profiles.remove(f.profile.id)
  assert.equal(f.read().ok,false)
  f.sessions.clear();assert.equal(f.read(f.make()).ok,false)
  const g=fixture();const record=JSON.parse(fs.readFileSync(path.join(g.root,'profiles.json'),'utf8'))
  record.profiles[0].cwd=g.other;fs.writeFileSync(path.join(g.root,'profiles.json'),JSON.stringify(record))
  assert.equal(g.read().ok,false);g.sessions.clear();assert.equal(g.read(g.make()).ok,false)
})
test('retargeted project directories and escaping file links fail the same realpath fence',()=>{
  const f=fixture();const link=path.join(f.project,'escape')
  fs.symlinkSync(f.other,link,process.platform==='win32'?'junction':'dir')
  fs.writeFileSync(path.join(f.other,'outside.txt'),'outside\n')
  assert.equal(f.read(f.service,'session-one',path.join(link,'outside.txt')).ok,false)
  fs.renameSync(f.project,path.join(f.root,'old-project'));fs.mkdirSync(f.project)
  fs.writeFileSync(f.file,'replacement directory\n')
  assert.equal(f.read().ok,false)
})
test('deleted and new untracked project files retain their exact targets',()=>{
  const f=fixture();const removed=path.join(f.project,'deleted.txt')
  const answer=f.read(f.service,'session-one',removed)
  assert.equal(answer.ok,true);assert.equal(answer.exists,false);assert.equal(answer.text,'')
  const moved=path.join(f.project,'renamed.txt');fs.renameSync(f.file,moved)
  assert.equal(f.read(f.service,'session-one',moved).text,'current\n')
})
test('history cannot supply a cwd, profile ID, or path outside the registered root',()=>{
  const f=fixture();const target=path.join(f.other,'outside.txt');fs.writeFileSync(target,'outside\n')
  const response=f.service.read(f.owner,{sessionId:'session-one',path:target,cwd:f.other,profileId:'forged'})
  assert.equal(response.ok,false)
})
test('default-workspace files retain normal editing even without a session association',()=>{
  const f=fixture();const file=path.join(f.chosen,'normal.txt');fs.writeFileSync(file,'normal\n')
  const answer=f.service.read(f.owner,{path:file})
  assert.equal(answer.ok,true);assert.notEqual(answer.readOnly,true)
  assert.equal(f.defaultFiles.write(file,'edited\n').ok,true)
})
test('Windows common account fence rejects a foreign profile before any filesystem call', {skip:process.platform!=='win32'},()=>{
  const f=fixture();const touched=[]
  const fileSystem=new Proxy({}, {get:(_target,name)=>(...args)=>{touched.push([name,...args]);throw Error('Unexpected filesystem access')}})
  assert.throws(()=>assertAccountProfilePath('C:\\Users\\DiffFixtureForeign\\file.txt', {
    fileSystem,resolveProfileShortPath:()=>null,
  }),error=>error.code==='AGENT_CONFINEMENT_FOREIGN_PROFILE')
  assert.deepEqual(touched,[])
  assert.equal(f.read(f.service,'session-one','C:\\Users\\DiffFixtureForeign\\file.txt').ok,false)
})
test('the actual preload keeps optional session context and never accepts a directory grant',async()=>{
  const source=fs.readFileSync(new URL('../../shell/fleet-profile-preload.cjs',import.meta.url),'utf8')
  const at=source.indexOf("contextBridge.exposeInMainWorld('mcDiff'")
  const end=source.indexOf('\n}))',at)+4
  const calls=[];let bridge
  vm.runInNewContext(source.slice(at,end),{contextBridge:{exposeInMainWorld:(name,value)=>{bridge=value}},
    ipcRenderer:{invoke:(...args)=>{calls.push(args);return Promise.resolve({ok:true})}}})
  await bridge.readChange('/project/file.txt',{sessionId:'session-one',cwd:'/forged'})
  await bridge.stamp('/project/file.txt',{sessionId:'session-one',cwd:'/forged'})
  await bridge.save('/project/file.txt','edited',{sessionId:'session-one',cwd:'/forged'})
  assert.equal(calls[0][0],'mc-diff:read-change')
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1])),{path:'/project/file.txt',sessionId:'session-one'})
  assert.deepEqual(JSON.parse(JSON.stringify(calls.slice(1))),[
    ['mc-diff:stamp',{path:'/project/file.txt',sessionId:'session-one'}],
    ['mc-diff:save',{path:'/project/file.txt',text:'edited',sessionId:'session-one'}]])
})
