import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createDocument} from './lib/dom-stand-in.mjs';
import {createSettingsMode,settingsModePanel} from '../../src/settings-mode.js';

import {createResourceSettings,resourceReadingSentence} from '../../src/resource-settings.js';
const settingsSource=fs.readFileSync(new URL('../../src/views/settings.js',import.meta.url),'utf8');
const callbackStart=settingsSource.indexOf('onChange: mode => {',settingsSource.indexOf('const modeController = createSettingsMode'))+'onChange: '.length;
const callbackEnd=settingsSource.indexOf('\n  } })',callbackStart)+'\n  }'.length;
assert.ok(callbackStart>0 && callbackEnd>callbackStart);
const callbackSource=settingsSource.slice(callbackStart,callbackEnd);
const flush=()=>new Promise(resolve=>setImmediate(resolve));

function fixture({mode='advanced',policy='off',status}={}) {
  const document=createDocument(),root=document.createElement('main'),timers=new Set();
  root.className='settings-page';root.dataset.settingsSearch='false';root.dataset.settingsLanding='false';
  let reads=0,writes=0,reader=status;
  const settings={mode:policy,reserveBytes:2147483648,providerBytes:{claude:805306368,codex:1073741824,gemini:1073741824,grok:1073741824,local:1073741824},maxConcurrentStarts:8,sampleMaxAgeMs:6000,settleMs:4000,cpuCeilingPercent:97,cpuBusyPercent:80,startIntervalMs:250,busyStartIntervalMs:5000};
  const reply=()=>({ok:true,mode:policy,fresh:policy!=='off',cpuPercent:20,freeBytes:21474836480,totalBytes:34359738368,atMs:Date.now(),settings,defaults:settings,admission:Object.fromEntries(['claude','codex','gemini','grok','local'].map(p=>[p,{ok:true}]))});
  const controller=createResourceSettings({bridge:()=>({status:()=>{reads++;return reader?reader():Promise.resolve(reply())},configure:async()=>{writes++;return reply()}}),schedule:fn=>{timers.add(fn);return fn},unschedule:fn=>timers.delete(fn)});
  root.innerHTML='<button data-settings-mode-choice="advanced">Advanced</button><button data-settings-mode-choice="simple">Basic</button><p data-settings-mode-description></p>'+settingsModePanel(controller.markup(),'Resources');
  // Execute the exact patched Settings view callback; unrelated navigation and
  // footer/depth rendering are stubs, while the resource controller is real.
  const context=vm.createContext({root,resourceController:controller,landing:null,sectionsNode:root,SECTIONS:['Resources'],levels:new Map(),ENTERPRISE_SECTION:'Enterprise',activeSection:'Resources',syncSectionDepth(){},updateFooter(){},navigate(){throw Error('Unexpected navigation')}});
  const onChange=vm.runInContext('('+callbackSource+')',context);
  const modes=createSettingsMode({root,onChange,storage:{getItem:()=>mode,setItem(){}}});
  controller.bind(root);controller.afterRender(root);
  return {root,controller,timers,get reads(){return reads},get writes(){return writes},reader(value){reader=value},async choose(next){const button=root.querySelector(`[data-settings-mode-choice="${next}"]`),closest=button.closest.bind(button);button.closest=s=>s==='[data-settings-mode-choice], [data-settings-show-mode]'?button:closest(s);button.dispatchEvent({type:'click'});await flush()},async poll(){for(const tick of [...timers])tick();await flush()},destroy(){controller.destroy();modes.destroy()}};
}

test('off policy explains absent measurements without claiming starts wait',()=>{
  assert.match(resourceReadingSentence({mode:'off',fresh:false}),/checks are off/);
  assert.doesNotMatch(resourceReadingSentence({mode:'off',fresh:false}),/unknown or stale/);
  assert.match(resourceReadingSentence({mode:'mechanical',fresh:false}),/wait for fresh readings/);
});

test('visible off policy has no stale-window or next-start refresh warning',async()=>{
  const f=fixture();try{await flush();assert.equal(f.root.querySelector('[data-resource-window]').textContent,'');assert.equal(f.root.querySelector('[data-resource-refresh]').textContent,'Refresh policy');assert.doesNotMatch(f.root.querySelector('[data-resource-admission]').textContent,/Refresh to check/);assert.equal(f.writes,0)}finally{f.destroy()}
});

test('real mode callback stops hidden polling and restores one poller on Advanced',async()=>{
  const f=fixture();try{await flush();assert.equal(f.reads,1);assert.equal(f.timers.size,1);await f.choose('simple');assert.equal(f.timers.size,0);await f.poll();assert.equal(f.reads,1);await f.choose('advanced');assert.equal(f.reads,2);assert.equal(f.timers.size,1);await f.poll();assert.equal(f.reads,3);assert.equal(f.writes,0)}finally{f.destroy()}assert.equal(f.timers.size,0);
});

test('initial Basic gate does not poll; its visible search result can refresh',async()=>{
  const f=fixture({mode:'simple'});try{await flush();assert.equal(f.reads,0);assert.equal(f.timers.size,0);f.root.dataset.settingsSearch='true';f.controller.afterRender(f.root);await flush();assert.equal(f.reads,1);assert.equal(f.timers.size,1);f.root.dataset.settingsSearch='false';f.controller.afterRender(f.root);assert.equal(f.timers.size,0)}finally{f.destroy()}
});

test('off-policy read failure is distinct from intentionally absent samples',async()=>{
  const f=fixture();try{await flush();f.reader(()=>Promise.reject(Error('unavailable')));await f.poll();assert.match(f.root.querySelector('[data-resource-reading]').textContent,/could not be read/);assert.match(f.root.querySelector('[data-resource-admission]').textContent,/Refresh to check/);f.reader(null);await f.poll();assert.match(f.root.querySelector('[data-resource-reading]').textContent,/checks are off/);assert.equal(f.writes,0)}finally{f.destroy()}
});

test('in-flight status cannot restart polling after the panel is hidden',async()=>{
  let resolve;const pending=new Promise(r=>{resolve=r});const f=fixture({status:()=>pending});try{await f.choose('simple');resolve({ok:false});await flush();assert.equal(f.timers.size,0);await f.poll();assert.equal(f.reads,1);f.reader(null);await f.choose('advanced');assert.equal(f.reads,2);assert.equal(f.timers.size,1)}finally{f.destroy()}
});
