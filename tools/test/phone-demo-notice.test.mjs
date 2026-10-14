import test from 'node:test';
import assert from 'node:assert/strict';
let example=false,phone=true,node=null;
globalThis.localStorage={getItem:key=>key==='mc.example'&&example?'on':null};
globalThis.document={
 documentElement:{getAttribute:()=>phone?'on':null},
 body:{appendChild:el=>{node=el}},querySelector:()=>node,
 createElement:()=>({dataset:{},children:[],listeners:new Map(),classList:{serious:false,toggle(name,on){if(name==='is-serious')this.serious=on},contains(name){return name==='is-serious'&&this.serious}},setAttribute(name,value){this[name]=value},
  set textContent(value){this.text=value;this.children=[]},get textContent(){return this.children.length?this.children.map(child=>child.textContent).join(''):this.text||''},
  replaceChildren(...children){this.children=children},appendChild(child){this.children.push(child)},addEventListener(name,listener){this.listeners.set(name,listener)},click(){this.listeners.get('click')?.()},remove(){node=null}}),
};
const {syncPhoneExampleNotice,FLEET_PROFILE_RESOLUTION}=await import('../../src/fleet-profile.js');
test('phone demo disclosure updates in both directions without duplicate notices',()=>{
 assert.equal(FLEET_PROFILE_RESOLUTION.kind,'unconfigured');
 example=true;syncPhoneExampleNotice();const first=node;
 assert.match(node.textContent,/built-in example/);
 syncPhoneExampleNotice();assert.equal(node,first);
 example=false;syncPhoneExampleNotice();assert.equal(node,null);
});
test('phone synchronization preserves serious notices and leaves desktop alone',()=>{
 example=true;phone=false;syncPhoneExampleNotice();assert.equal(node,null);
 phone=true;syncPhoneExampleNotice();node.classList.serious=true;const serious=node;
 example=false;syncPhoneExampleNotice();assert.equal(node,serious);
 example=true;syncPhoneExampleNotice();assert.equal(node.classList.serious,true);
});

test('example toast keeps its Settings link and closes without changing the example choice',()=>{
 node=null;phone=true;example=true;syncPhoneExampleNotice();
 const toast=node,link=toast.children.find(child=>child.href),close=toast.children.find(child=>child.type==='button');
 assert.equal(toast.role,'status');
 assert.equal(link.href,'#/settings');
 assert.match(link.textContent,/Every screen is showing the built-in example rather than your own records\. Open Settings →/);
 assert.equal(close['aria-label'],'Close example notice');
 close.click();assert.equal(node,null);assert.equal(example,true);
 syncPhoneExampleNotice();assert.ok(node,'a new disclosure may be mounted for a later example visit');
});
