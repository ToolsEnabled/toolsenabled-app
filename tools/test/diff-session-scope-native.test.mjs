import { fileURLToPath } from 'node:url'
import { canonicalRootForTests } from '../canonical-root.mjs'
import { testScratchRoot } from '../lib/test-scratch-root.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'
import test from 'node:test'
const source = fileURLToPath(new URL('../../',import.meta.url))
const root = path.join(source,'tools/test/helpers')
const require = createRequire(import.meta.url)
const { installationProfileRoot } = require(path.join(canonicalRootForTests({requireConfigured:true}),'src/lib/account-profile-boundary.js'))
const esbuild = require('esbuild')
const data = fs.mkdtempSync(testScratchRoot('diff-session-scope-native-'))
fs.writeFileSync(path.join(data,'inputs.json'),JSON.stringify({canonicalRoot:canonicalRootForTests({requireConfigured:true}),profileRoot:installationProfileRoot()}))
try {
  await esbuild.build({entryPoints:[path.join(root,'diff-session-scope-renderer.mjs')],bundle:true,format:'iife',outfile:path.join(data,'fixture.js'),loader:{'.woff2':'dataurl'},logLevel:'silent'})
  fs.writeFileSync(path.join(data,'index.html'),'<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; font-src data:; img-src data:"><link rel="stylesheet" href="./fixture.css"><body><script src="./fixture.js"></script></body>')
  const preload=fs.readFileSync(path.join(source,'shell/fleet-profile-preload.cjs'),'utf8')
  const start=preload.indexOf("contextBridge.exposeInMainWorld('mcDiff'")
  assert(start>=0)
  const bridge=preload.slice(start,preload.indexOf('\n}))',start)+4)
  fs.writeFileSync(path.join(data,'preload.cjs'),"const {contextBridge,ipcRenderer}=require('electron')\n"+bridge+"\ncontextBridge.exposeInMainWorld('auditInputs',{read:()=>ipcRenderer.invoke('audit:inputs')})\n")
  const execution=await promisify(execFile)(require('electron'),[path.join(root,'diff-session-scope-electron.cjs'),data,'--user-data-dir='+path.join(data,'userData')],{cwd:source,env:process.env,windowsHide:true,timeout:45000,maxBuffer:1048576})
  fs.writeFileSync(path.join(data,'execution.json'),JSON.stringify(execution,null,2)+'\n')
} finally { esbuild.stop(); console.log('Synthetic session diff evidence: '+data.replaceAll('\\','/')) }
const observed=JSON.parse(fs.readFileSync(path.join(data,'observations.json'),'utf8'))
assert.equal(observed.profileResolvedOutsideDefaultRoots,true)
assert.equal(observed.visible,false)
assert.equal(observed.destroyed,true)
assert.equal(observed.pickCount,0)
assert.deepEqual(observed.pageErrors,[])
assert.deepEqual(observed.deniedRequests,[])
const expected={
  'chosen-modified':['before\n','after\n'],
  'chosen-added-untracked':['','new\n'],
  'chosen-deleted':['removed\n',''],
  'profile-modified':['before\n','after\n'],
  'profile-added-untracked':['','new\n'],
}
for(const row of observed.cases) test('real chat Open diff auto-loads '+row.id,()=>{
  assert.equal(row.modalCount,1)
  assert.equal(row.refusalCode,null,'registered working folder must be readable through the owning selection')
  assert.deepEqual([row.original,row.proposed],expected[row.id])
  assert.equal(row.proposedBound,true)
  assert.equal(row.readOnly,false)
})

test('pointer and keyboard edits save through the actual bridge and reopen from real files',()=>{
  assert.equal(observed.hand.length,5)
  assert(observed.identity.pid>0)
  for(const row of observed.hand) {
    assert.equal(row.savedText,row.editedText)
    assert.equal(row.reopenedText,row.editedText)
    assert.equal(row.savedVisible,true)
    assert.equal(row.liveUpdated,true)
    assert.equal(row.caretPreserved,true)
    assert.equal(row.outerOverflow,false)
  }
})
