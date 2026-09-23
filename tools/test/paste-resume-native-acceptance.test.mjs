import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {template,validate} from '../paste-resume-native-acceptance.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'paste-resume-contract-'));
fs.writeFileSync(path.join(root,'mock.log'),'Synthetic contract evidence, not native.');
function fixture(){const d=template();d.mode='native';d.controllerRun='synthetic';d.disposableProfile='synthetic';for(const r of d.cases){r.evidence=['mock.log'];r.observed={nativeImage:true,providerReceivedImage:true,visualChallenge:'blue triangle',providerAnswer:'blue triangle',receiptId:'synthetic',wordsPreserved:true,attachmentCount:1,mcpImageBlock:true,refusal:'Codex cannot resume Claude',visible:true,closeCalls:0,startCalls:0,replacementCalls:0,sessionBefore:'old',sessionAfter:'old',transcriptPreserved:true,resumed:true,refused:false,savedThread:'saved',resumedThread:'saved'};}return d;}
test('unexecuted fails closed',()=>assert.ok(validate(template(),root).errors.length));
test('synthetic contract never grants acceptance',()=>assert.deepEqual(validate(fixture(),root),{status:'NATIVE_EVIDENCE_READY_FOR_REVIEW',errors:[],accepted:false}));
test('mock cannot qualify',()=>{const d=fixture();d.mode='mock';assert.ok(validate(d,root).errors.length)});
test('each case required',()=>{for(let i=0;i<10;i++){const d=fixture();d.cases.splice(i,1);assert.ok(validate(d,root).errors.length)}});
test('wrong pair and missing evidence rejected',()=>{const d=fixture();d.pair={};d.cases[0].evidence=['missing'];assert.ok(validate(d,root).errors.length>=2)});
test('provider ack insufficient',()=>{const d=fixture();d.cases[0].observed.providerAnswer='ack';assert.ok(validate(d,root).errors.length)});
test('both mismatches require preservation and no side effects',()=>{for(const id of ['resume-codex-claude','resume-claude-codex'])for(const [key,value] of [['startCalls',1],['closeCalls',1],['replacementCalls',1],['sessionAfter','new'],['transcriptPreserved',false],['visible',false]]){const d=fixture();d.cases.find(r=>r.id===id).observed[key]=value;assert.ok(validate(d,root).errors.length)}});
test('same provider and legacy retain thread',()=>{for(const id of ['resume-codex-codex','resume-claude-claude','resume-legacy']){const d=fixture();d.cases.find(r=>r.id===id).observed.resumedThread='fresh';assert.ok(validate(d,root).errors.length)}});
after(()=>fs.rmSync(root,{recursive:true,force:true}));
