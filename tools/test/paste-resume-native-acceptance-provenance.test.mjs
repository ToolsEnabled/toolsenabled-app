import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {capture,verify} from '../paste-resume-native-acceptance-provenance.mjs';
import {template} from '../paste-resume-native-acceptance.mjs';
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
function run(fn) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'paste-resume-provenance-'));
 try {const receipt=template(); receipt.cases[0].evidence=['original.txt']; fs.writeFileSync(path.join(root,'original.txt'),'Synthetic offline artifact'); fs.writeFileSync(path.join(root,'receipt.json'),JSON.stringify(receipt)); fn(root,capture(path.join(root,'receipt.json'),source));}
 finally {fs.rmSync(root,{recursive:true,force:true});}
}
test('intact inventory retains incomplete contract and cannot grant native acceptance',()=>run((root,m)=>{const r=verify(m,root,source); assert.equal(r.status,'INVENTORY_VERIFIED');assert.equal(r.contract.status,'INCOMPLETE');assert.equal(r.accepted,false);assert.equal(r.runtimeAuthenticated,false)}));
test('changed artifact rejected',()=>run((root,m)=>{fs.appendFileSync(path.join(root,'original.txt'),' altered');assert.equal(verify(m,root,source).status,'BINDING_MISMATCH')}));
test('missing artifact rejected',()=>run((root,m)=>{fs.unlinkSync(path.join(root,'original.txt'));assert.equal(verify(m,root,source).status,'BINDING_MISMATCH')}));
test('receipt mutation rejected',()=>run((root,m)=>{fs.appendFileSync(path.join(root,'receipt.json'),' ');assert.ok(verify(m,root,source).errors.includes('receipt: binding changed'))}));
test('source revision mutation rejected',()=>run((root,m)=>{m.source.head='0'.repeat(40);assert.ok(verify(m,root,source).errors.includes('source: binding changed'))}));
test('escaping evidence rejected',()=>run((root)=>{const d=template();d.cases[0].evidence=['../outside'];fs.writeFileSync(path.join(root,'receipt.json'),JSON.stringify(d));assert.throws(()=>capture(path.join(root,'receipt.json'),source),/unsafe/)}));
test('symlink escape rejected',()=>run((root)=>{fs.symlinkSync(import.meta.filename || fileURLToPath(import.meta.url),path.join(root,'escape'));const d=template();d.cases[0].evidence=['escape'];fs.writeFileSync(path.join(root,'receipt.json'),JSON.stringify(d));assert.throws(()=>capture(path.join(root,'receipt.json'),source),/outside/)}));
