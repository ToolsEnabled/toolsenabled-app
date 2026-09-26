import { openResearchProject } from './research-project-picker.mjs'
// Actual generation/refill controls. Recorded fixture metadata is not a provider receipt.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises'
import {resolve,relative} from 'node:path'
import {spawnSync} from 'node:child_process'
import {newExperimentDraft,genericStarter} from '../../../src/benchmark/starters.mjs'
import {workflowFixture,workflowEnvelope} from './research-benchmark-workflow.mjs'
import {RUNTIME_FILES,validateStudy} from '../../../src/benchmark/study.mjs'
import {sha256} from '../../../src/benchmark/prompts.mjs'
assert.ok(process.env.MC_PLAYWRIGHT_ROOT)
const {chromium}=createRequire(import.meta.url)(process.env.MC_PLAYWRIGHT_ROOT)
const origin=process.env.BENCHMARK_TEST_ORIGIN||'http://127.0.0.1:4714',out=resolve(process.env.BENCHMARK_TEST_OUTPUT||'recorded-reset-browser-evidence')
await mkdir(out,{recursive:true})
const initial=newExperimentDraft(genericStarter(),{purpose:'recorded-diagnostic',initializePopulation:true})
initial.id='recorded-reset-controls';initial.name='Generation preserves declared recorded controls'
initial.observationPlan=workflowFixture().observationPlan
initial.conditions[0].model.surface='recorded-fixture'
initial.conditions[0].model.settings={temperature:0,topP:1}
initial.conditions[0].adapter.mode='envelope'
initial.conditions[0].adapter.responses={'addition-a':workflowEnvelope('5'),'addition-b':workflowEnvelope('11')}
initial.protocol.maxTotalAttempts=2
initial.decisions='SYNTHETIC RECORDED CONTROLS ONLY. Declared arithmetic outputs and recorded identity/usage test response interpretation after generation; no provider measurement or independent key qualification.'
validateStudy(initial)
const results=[],errors=[],parity=[],browser=await chromium.launch({headless:true})
let page
try {
 page=await browser.newPage({viewport:{width:1440,height:1100},acceptDownloads:true});page.on('pageerror',error=>errors.push(error.message))
 await page.goto(origin+'/tools/test/fixtures/research-workflow.html?mode=available');await page.waitForFunction(()=>window.auditReady)
 await openResearchProject(page, { account: true }); await page.locator('[data-project-select]').selectOption('rp-'+'a'.repeat(36))
 const f=name=>page.locator('[data-bench-'+name+']'),tab=name=>page.locator('[data-bench-tab="'+name+'"]').click()
 const settled=text=>page.waitForFunction(text=>document.querySelector('[data-bench-status]').textContent.startsWith(text),text)
 async function downloaded(action,name){const wait=page.waitForEvent('download');await f(action).click();const file=await wait,path=resolve(out,name);await file.saveAs(path);return path}
 async function draft(name){return JSON.parse(await readFile(await downloaded('draft-export',name)))}
 async function unpack(action,name){const zip=await downloaded(action,name+'.zip'),dir=resolve(out,name);const p=spawnSync('python3',['-c','import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;z.extractall(sys.argv[2])',zip,dir],{encoding:'utf8'});assert.equal(p.status,0,p.stderr);return dir}
 async function importSpec(spec,name){await openResearchProject(page); await f('import').setInputFiles({name,mimeType:'application/json',buffer:Buffer.from(JSON.stringify({spec}))});await settled('Draft imported')}
 async function generate(){
  await tab('corpus');await f('seed-corpus').click();await settled('Draft recipe prepared')
  const recipe=JSON.parse(await f('corpus-plan').inputValue())
  recipe.families[0].axes=[{id:'value',choices:[2,3].map(value=>({id:'n-'+value,edits:[{kind:'parameter',path:['task'],name:'a',value},{kind:'expected',value:String(value+3)}]}))}]
  recipe.coverage=[{dimension:'axis:value',minimum:1}];recipe.selection={kind:'all',limit:2}
  await f('corpus-plan').fill(JSON.stringify(recipe,null,2));await f('generate-corpus').click();await settled('2 tasks generated')
 }
 await importSpec(initial,'envelope-source.json');await generate()
 const generated=await draft('generated-empty-responses.json'),condition=generated.spec.conditions[0]
 validateStudy(generated.spec);assert.equal(condition.adapter.mode,'envelope');assert.deepEqual(condition.adapter.responses,{})
 assert.equal(Object.hasOwn(condition.adapter,'workflowResponses'),false)
 assert.deepEqual(condition.model,initial.conditions[0].model);assert.deepEqual(generated.spec.observationPlan,initial.observationPlan)
 assert.deepEqual(generated.spec.executionPlan,initial.executionPlan)
 assert.deepEqual(generated.spec.tasks.map(task=>task.expected).sort(),['5','6'])
 assert.ok(generated.spec.tasks.every(task=>!initial.tasks.some(old=>old.id===task.id)))
 results.push('Actual corpus generation removes old task responses and preserves envelope mode, ordinary workflow-map absence, explicit settings, accounting and recorded-diagnostic purpose')
 // Explicit fixture answers for declared factor choices; the product supplies none.
 const answers={'n-2':'5','n-3':'6'},conditions=structuredClone(generated.spec.conditions)
 conditions[0].adapter.responses=Object.fromEntries(generated.spec.tasks.map(task=>{
  const answer=answers[task.generation.choices.value];assert.ok(answer)
  return [task.id,workflowEnvelope(answer,0,'0.00')]
 }))
 await tab('protocol');await f('conditions').fill(JSON.stringify(conditions,null,2));await f('apply-protocol').click();await settled('Protocol applied')
 await f('conditions').screenshot({path:resolve(out,'refilled-envelope-desktop.png')})
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 await page.locator('[data-bench-panel="protocol"]').screenshot({path:resolve(out,'refilled-envelope-narrow.png')});await page.setViewportSize({width:1440,height:1100})
 await tab('run');await f('freeze').click();await page.waitForFunction(()=>!document.querySelector('[data-bench-run]').disabled)
 const exported=await unpack('export','exported-project')
 await f('run').click();await settled('Recorded-response run finished')
 const evidence=JSON.parse(await readFile(await downloaded('export-evidence','gui-evidence.json'))),report=await unpack('export-report','gui-report')
 assert.equal(evidence.summary.completed,2);assert.equal(evidence.summary.groups[0].passed,2)
 const observed=evidence.events.filter(event=>event.observations)
 assert.equal(observed.length,2)
 for(const event of observed){const reported=event.observations.reported;assert.equal(reported.metadataOrigin,'recorded-response');assert.equal(reported.identityStatus,'match');assert.equal(reported.eligible,true);assert.equal(reported.usage.outputTokens.value,0);assert.equal(reported.reportedCost.amount,'0')}
 const project=JSON.parse(await readFile(resolve(exported,'project.json')));assert.equal(project.sha256,evidence.projectSha256)
 const pins=[];for(const name of RUNTIME_FILES){const digest=await sha256(await readFile(new URL('../../../src/benchmark/'+name,import.meta.url)));assert.equal(project.spec.runtimeSources[name],digest);assert.equal(await sha256(await readFile(resolve(exported,name))),digest);pins.push({name,sha256:digest})}
 const cli=resolve(out,'cli-analysis');await mkdir(cli,{recursive:true});await writeFile(resolve(cli,'attempts.jsonl'),evidence.events.map(event=>JSON.stringify(event)).join('\n')+'\n')
 for(const command of ['verify','analyze']){const child=spawnSync(process.execPath,[resolve(exported,'cli.mjs'),command,'--output',cli],{encoding:'utf8',timeout:120000,maxBuffer:64*1024*1024});await writeFile(resolve(out,command+'.stdout'),child.stdout||'');await writeFile(resolve(out,command+'.stderr'),child.stderr||'');assert.equal(child.status,0,child.stderr)}
 async function compare(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const path=resolve(dir,entry.name);if(entry.isDirectory())await compare(path);else{const name=relative(report,path),bytes=await readFile(path);assert.deepEqual(bytes,await readFile(resolve(cli,name)),name);parity.push({name,sha256:await sha256(bytes)})}}}
 await compare(report)
 results.push('Explicit new envelope controls produce2correct recorded trials with retained identity and observed zero usage/cost; exported CLI verifies45runtime pins and analyzes the same GUI journal with byte-identical reports')
 const workflow=newExperimentDraft(workflowFixture(),{purpose:'recorded-diagnostic',initializePopulation:true})
 await importSpec(workflow,'workflow-source.json');await generate()
 const workflowGenerated=await draft('generated-empty-workflow.json');validateStudy(workflowGenerated.spec)
 const old=workflow.conditions[0],next=workflowGenerated.spec.conditions[0]
 assert.equal(next.workflowId,old.workflowId);assert.deepEqual(next.model,old.model);assert.deepEqual(next.collection,old.collection)
 assert.deepEqual(next.adapter,{...old.adapter,responses:{},workflowResponses:{}})
 assert.deepEqual(workflowGenerated.spec.workflowPlan,workflow.workflowPlan);assert.deepEqual(workflowGenerated.spec.observationPlan,workflow.observationPlan)
 await tab('run');await f('freeze').click();await page.waitForFunction(()=>!document.querySelector('[data-bench-run]').disabled)
 assert.equal(await f('export-evidence').isDisabled(),true)
 results.push('Assigned workflow corpus generation keeps the exact workflow/accounting/settings and empty explicit fixture maps; structurally valid freeze creates no measured evidence')
 assert.deepEqual(errors,[])
 await writeFile(resolve(out,'qualification.json'),JSON.stringify({results,projectSha256:project.sha256,pins,parity,recordedTrials:2,workflowTrials:0,providerCalls:0,nativeRuns:0,localModuleCalls:0,cliVerify:1,cliAnalyzeSameJournal:1},null,2))
}catch(error){if(page){await page.screenshot({path:resolve(out,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(resolve(out,'failure.json'),JSON.stringify({error:error.stack,status:await page.locator('[data-bench-status]').textContent().catch(()=>null)},null,2))}throw error}
finally{await writeFile(resolve(out,'results.json'),JSON.stringify({results,errors},null,2));await browser.close()}
