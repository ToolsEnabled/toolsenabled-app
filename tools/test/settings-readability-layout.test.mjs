import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import {createRequire} from 'node:module'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {fileURLToPath} from 'node:url'
import {testScratchRoot} from '../lib/test-scratch-root.mjs'

test('actual Settings sections remain readable without writing any setting',async()=>{
  const root=fileURLToPath(new URL('../../',import.meta.url)),require=createRequire(import.meta.url)
  const {prepareSterileProfile,sterileProfileDirectories,sterileLaunchEnvironment}=require('../lib/sterile-launch.cjs')
  const data=fs.mkdtempSync(testScratchRoot('settings-readability-'))
  const env=sterileLaunchEnvironment(prepareSterileProfile(sterileProfileDirectories(path.join(data,'environment'))))
  for(const key of Object.keys(env))if(/^NODE_OPTIONS$/i.test(key))delete env[key]
  const esbuild=require('esbuild')
  try{
    await esbuild.build({entryPoints:[path.join(root,'tools/test/helpers/settings-readability-renderer.mjs')],bundle:true,format:'iife',outfile:path.join(data,'fixture.js'),logLevel:'silent',loader:{'.woff2':'dataurl','.woff':'dataurl','.svg':'dataurl'}})
    fs.writeFileSync(path.join(data,'index.html'),'<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; font-src data:"><link rel="stylesheet" href="./fixture.css"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}body{display:block}.settings-page{box-sizing:border-box}</style><body><script src="./fixture.js"></script></body>')
    const result=await promisify(execFile)(require('electron'),[path.join(root,'tools/test/helpers/settings-readability-electron.cjs'),data],{cwd:root,env,windowsHide:true,timeout:90000,maxBuffer:1048576})
    fs.writeFileSync(path.join(data,'execution.json'),JSON.stringify(result,null,2)+'\n')
    const observed=JSON.parse(fs.readFileSync(path.join(data,'observations.json'),'utf8'))
    assert.deepEqual(observed.pageErrors,[]);assert.deepEqual(observed.deniedRequests,[])
    assert.equal(observed.cases.length,7);assert.equal(observed.final.writes,0)
    assert.equal(observed.visible,false);assert.equal(observed.destroyed,true)
    for(const fixture of observed.cases){
      assert.equal(fixture.top.mode,'expert',fixture.name)
      assert.equal(fixture.top.dirty,'false',fixture.name+' formatting does not stage settings')
      /* Every category fixture still carries the same four-row floor it always
         did. The landing category is not a row-editing category -- "This
         computer" holds the installs, the sign-ins and the coordinator reply,
         three rows in total -- so it is held to what it actually shows rather
         than to a threshold written for the tool and appearance categories. */
      assert.ok(fixture.top.rows.length>=(fixture.name==='landing-600'?3:4),fixture.name+' real rows')
      assert.deepEqual(fixture.top.values,fixture.content.values,fixture.name+' scroll keeps values')
      assert.ok(fixture.top.pageScrollWidth<=fixture.top.pageClientWidth+2,fixture.name+' page width')
      assert.ok(fixture.top.names.every(name=>parseFloat(name.font)>=14),fixture.name+' label reading size')
      assert.deepEqual(fixture.top.overflow,[],fixture.name+' labels and controls fit')
    }
    assert.equal(observed.profile.unchanged,true,'opening the profile disclosure keeps every value')
    assert.equal(observed.profile.opened.sliderVisible,true,'the native slider remains reachable')
    assert.equal(observed.profile.opened.choices,6,'every existing profile remains available')
    assert.equal(observed.profile.closed,true,'profiles can fold away after review')
    assert.equal(observed.profile.stateVisible,true,'saved profile remains visible when folded')
    assert.equal(observed.profile.pendingVisible,true,'pending profile feedback remains visible when folded')
    assert.equal(observed.profile.warningVisible,true,'profile warning remains visible when folded')
    const narrow=observed.cases.find(fixture=>fixture.name==='tools-600').top
    const inset=observed.cases.find(fixture=>fixture.name==='tools-inset-1120').top
    for(const layout of [narrow,inset]){
      assert.equal(layout.navigation.pickerVisible,true,'narrow content offers every section without horizontal panning')
      assert.equal(layout.navigation.railVisible,false,'one category control is shown')
      assert.equal(layout.navigation.selected,'Tool use')
      assert.equal(new Set(layout.navigation.categories).size,20,'all current categories remain available')
    }
    const selection=observed.categorySelection
    assert.equal(selection.before.focused,true)
    assert.equal(selection.after.selected,'Tool use','a navigation that has not mounted keeps the current category label')
    assert.deepEqual(selection.after.navigations,['#/settings?category=agents-delegation'],'native selection requests the actual category route')
    assert.deepEqual(selection.after.values,selection.before.values,'category navigation does not change a setting')
    assert.equal(selection.after.writes,0)
    assert.ok(narrow.rows[0].control.bottom<narrow.height,'first actual control is visible without scrolling past page chrome')

    /* THE QUICK STRIP IS THE LANDING PAGE'S, AND ONLY THE LANDING PAGE'S.
     *
     * Owner, 2026-09-15: the sliders belong where Settings opens -- "easily
     * accessible on the settings landing page". Drawn above every category
     * instead, the strip stacks to about 1300px at this width and pushes the
     * first row of the category a person navigated to below the fold, which is
     * what the assertion directly above catches. Both halves are asserted here
     * so neither can be satisfied by removing the strip altogether. */
    const landing=observed.cases.find(fixture=>fixture.name==='landing-600').top
    assert.equal(landing.quick.shown,true,'the quick strip is drawn on the landing category')
    assert.ok(landing.quick.sliders>=3,'the landing category shows the strip’s sliders, not just its heading')
    assert.ok(landing.quick.firstSlider,'the first quick slider is drawn on the landing category')
    assert.ok(landing.quick.firstSlider.bottom<landing.height,
      'the first quick slider is reachable without scrolling where Settings opens')
    assert.equal(narrow.quick.shown,false,
      'the quick strip stands down once a person has navigated into a category to edit its rows')
    assert.equal(observed.cases.find(fixture=>fixture.name==='appearance-900').top.contextVisible,true,'category guidance without a second explanation remains visible')
    assert.equal(observed.details.before.bodyVisible,false,'help is initially a compact disclosure')
    assert.equal(observed.details.open,true,'the native Details control opens')
    assert.equal(observed.details.after.bodyVisible,true,'expanded help remains visible')
    assert.equal(observed.details.before.text,observed.details.after.text,'all supplied guidance is retained')
    assert.ok(observed.details.after.text.includes('risk')||observed.details.after.text.includes('cost'),'expanded guidance includes the risks')
    assert.equal(observed.details.before.control.y,observed.details.after.control.y,'opening guidance keeps the control in place')
    assert.ok(observed.details.after.body.width>observed.details.after.row.width*.7,'expanded guidance uses the content width')
  }finally{esbuild.stop();console.log('Settings readability evidence: '+data.replaceAll('\\','/'))}
})
