import test from 'node:test';
import assert from 'node:assert/strict';
let example=false,phone=true,node=null;
globalThis.localStorage={getItem:key=>key==='mc.example'&&example?'on':null};
globalThis.document={
 documentElement:{getAttribute:()=>phone?'on':null},
 body:{appendChild:el=>{node=el}},querySelector:()=>node,
 createElement:()=>({dataset:{},classList:{serious:false,toggle(name,on){if(name==='is-serious')this.serious=on},contains(name){return name==='is-serious'&&this.serious}},setAttribute(){},remove(){node=null}}),
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
