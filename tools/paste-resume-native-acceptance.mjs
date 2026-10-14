import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
export const pair = {app:'07091006f633d8e452ea9b6a27d0281c88f6249b',engine:'f3d8bb3d81fb6a1868a13b2c4f1dbb1dafd0544c'};
export const cases = ['paste-agent-first','paste-agent-continue','paste-session-first','paste-session-continue','capture-mcp','resume-codex-claude','resume-claude-codex','resume-codex-codex','resume-claude-claude','resume-legacy'];
export function template() { return {schema:1, mode:'unexecuted', pair, controllerRun:'', disposableProfile:'', cases:cases.map(id=>({id,evidence:[],observed:{}}))}; }
export function validate(doc, root) {
 const errors=[];
 const need=(ok,msg)=>{if(!ok)errors.push(msg)};
 need(doc?.schema===1,'schema');
 need(doc?.mode==='native','native execution required; mock/unexecuted is not native evidence');
 need(doc?.pair?.app===pair.app && doc?.pair?.engine===pair.engine,'exact pair');
 for(const key of ['controllerRun','disposableProfile']) need(typeof doc?.[key]==='string' && doc[key].trim().length>0,key);
 const rows=Array.isArray(doc?.cases)?doc.cases:[];
 for(const id of cases){
  const matches=rows.filter(r=>r?.id===id); need(matches.length===1,`${id}: exactly one result`);
  const r=matches[0]; if(!r)continue;
  need(Array.isArray(r.evidence)&&r.evidence.length>0,`${id}: evidence files`);
  for(const f of Array.isArray(r.evidence)?r.evidence:[]){
   try { need(typeof f==='string' && !path.isAbsolute(f),`${id}: relative evidence path`);
    const base=fs.realpathSync(root), target=fs.realpathSync(path.resolve(root,f));
    need(target.startsWith(base+path.sep)&&fs.statSync(target).isFile()&&fs.statSync(target).size>0,`${id}: nonempty contained evidence`);
   }catch{need(false,`${id}: unreadable evidence`)}
  }
  const o=r.observed??{};
  const mismatch=['resume-codex-claude','resume-claude-codex'].includes(id);
  if(mismatch){
   need(typeof o.refusal==='string' && o.refusal.includes('Codex') && o.refusal.includes('Claude'),`${id}: named visible refusal`);
   need(o.visible===true && o.closeCalls===0 && o.startCalls===0 && o.replacementCalls===0,`${id}: refusal before side effects`);
   need(typeof o.sessionBefore==='string' && o.sessionBefore.length>0 && o.sessionBefore===o.sessionAfter && o.transcriptPreserved===true,`${id}: existing session preserved`);
  }else if(id.startsWith('resume-')){
   need(o.resumed===true && o.refused===false && typeof o.savedThread==='string' && o.savedThread.length>0 && o.resumedThread===o.savedThread,`${id}: original thread resumed`);
  }else{
   need(o.nativeImage===true && o.providerReceivedImage===true,`${id}: native image/provider receipt`);
   need(typeof o.visualChallenge==='string' && o.visualChallenge.length>0 && o.providerAnswer===o.visualChallenge,`${id}: image-only challenge read by provider`);
   need(typeof o.receiptId==='string' && o.receiptId.length>0,`${id}: provider receipt identifier`);
   if(id==='capture-mcp')need(o.mcpImageBlock===true,`${id}: MCP image block`);
   else need(o.wordsPreserved===true && o.attachmentCount===1,`${id}: one attachment and words preserved`);
  }
 }
 return {status:errors.length?'INCOMPLETE':'NATIVE_EVIDENCE_READY_FOR_REVIEW',errors,accepted:false};
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try {
  if(process.argv[2]==='template')process.stdout.write(JSON.stringify(template(),null,2)+'\n');
  else if(process.argv[2]==='validate' && process.argv[3]){
   const file=path.resolve(process.argv[3]); const result=validate(JSON.parse(fs.readFileSync(file,'utf8')),path.dirname(file));
   console.log(JSON.stringify(result,null,2)); process.exitCode=result.errors.length?1:0;
  }else throw Error('Usage: node tools/paste-resume-native-acceptance.mjs template | validate receipt.json');
 }catch(e){console.error(e.message);process.exitCode=2}
}
