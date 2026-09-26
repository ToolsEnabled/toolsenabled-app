import { openResearchProject } from './research-project-picker.mjs'
// Real field authoring and portable request checks. No external endpoint is contacted.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
import {newExperimentDraft,genericStarter} from '../../../src/benchmark/starters.mjs'
import {RUNTIME_FILES,validateStudy} from '../../../src/benchmark/study.mjs'
import {collectionRequest} from '../../../src/benchmark/workflow.mjs'
import {observationContract,observeResponse} from '../../../src/benchmark/observations.mjs'
import {assertCollectionAdmission} from '../../../src/benchmark/readiness.mjs'
import {sha256} from '../../../src/benchmark/prompts.mjs'
assert.ok(process.env.MC_PLAYWRIGHT_ROOT)
const {chromium}=createRequire(import.meta.url)(process.env.MC_PLAYWRIGHT_ROOT)
const origin=process.env.BENCHMARK_TEST_ORIGIN||'http://127.0.0.1:4715',out=resolve(process.env.BENCHMARK_TEST_OUTPUT||'condition-fields-browser-evidence')
await mkdir(out,{recursive:true})
const initial=newExperimentDraft(genericStarter(),{initializePopulation:true})
initial.id='condition-fields-controls';initial.name='Two declared external model configurations'
initial.decisions='OFFLINE AUTHORING CONTROL ONLY. The endpoints are inert placeholders. This fixture tests declared requests and report checks; no provider measurement, independent answer-key qualification or performance claim.'
const results=[],errors=[],browser=await chromium.launch({headless:true})
let page,externalRequests=0
try {
 page=await browser.newPage({viewport:{width:1440,height:1100},acceptDownloads:true});page.on('pageerror',error=>errors.push(error.message))
 await page.route('https://condition.example.invalid/**',async route=>{externalRequests++;await route.abort()})
 await page.goto(origin+'/tools/test/fixtures/research-workflow.html?mode=available');await page.waitForFunction(()=>window.auditReady)
 await openResearchProject(page, { account: true }); await page.locator('[data-project-select]').selectOption('rp-'+'a'.repeat(36))
 const f=name=>page.locator('[data-bench-'+name+']'),c=name=>page.locator('[data-condition-fields-'+name+']'),tab=name=>page.locator('[data-bench-tab="'+name+'"]').click()
 const settled=text=>page.waitForFunction(text=>document.querySelector('[data-bench-status]').textContent.startsWith(text),text)
 async function download(action,name){const wait=page.waitForEvent('download');await f(action).click();const file=await wait,path=resolve(out,name);await file.saveAs(path);return path}
 async function draft(name){return JSON.parse(await readFile(await download('draft-export',name)))}
 const fields=async()=>JSON.parse(await f('condition-fields').inputValue())
 async function select(id){const row=(await fields()).rows.find(row=>row.id===id);assert.ok(row,id);await c('row').selectOption(row.key)}
 async function setting(key,type,text){await c('settings-present').check();await c('add-setting').click();const row=c('setting-row').last();await row.locator('[data-condition-fields-setting-key]').fill(key);await row.locator('[data-condition-fields-setting-type]').selectOption(type);if(type==='boolean')await row.locator('[data-condition-fields-setting-text]').selectOption(text);else if(type!=='null')await row.locator('[data-condition-fields-setting-text]').fill(text)}
 await openResearchProject(page); await f('import').setInputFiles({name:'source.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({spec:initial}))});await settled('Draft imported')
 await tab('protocol');const before=await draft('before-preparation.json');await f('prepare-condition-fields').click();await settled('Condition fields prepared')
 assert.deepEqual((await draft('prepared.json')).spec,before.spec)
 await c('new-id').fill('model-a');await c('new-profile').selectOption('http');await c('add').click();await select('model-a')
 await c('provider').fill('fixture-provider');await c('model-id').fill('requested-a');await c('url').fill('https://condition.example.invalid/collect')
 await c('system-kind').selectOption('text');await c('system').fill('Return the requested answer from the disclosed prompt.')
 await setting('temperature','number','0');await setting('feature','boolean','false');await setting('nullable','null','');await setting('literal','string','0')
 await setting('nested','object','{ "choices": [0, false, null], "literal": "0" }')
 await c('require-checks').click()
 await c('duplicate-id').fill('model-b');await c('duplicate').click();await select('model-b');await c('model-id').fill('requested-b')
 await c('setting-row').first().locator('[data-condition-fields-setting-text]').fill('1')
 await select('recorded');await c('remove').click();assert.equal((await fields()).rows.length,2)
 const pending=await draft('pending-fields.json')
 assert.deepEqual(pending.spec,initial);assert.ok(pending.pending.includes('conditionFields'))
 // Editing expert whitespace is a different source buffer and cannot be overwritten.
 const rawConditions=await f('conditions').inputValue();await f('conditions').fill(rawConditions+'\n')
 const stale=await draft('stale-before-apply.json');await f('apply-condition-fields').click();await page.waitForFunction(()=>document.querySelector('[data-bench-status]').textContent.includes('stale'))
 assert.deepEqual(await draft('stale-after-refusal.json'),stale)
 await f('conditions').fill(rawConditions)
 await f('apply-condition-fields').click();await settled('Condition setup applied')
 const applied=await draft('applied-conditions.json');validateStudy(applied.spec)
 assert.deepEqual(applied.pending,[]);assert.deepEqual(applied.spec.tasks,initial.tasks);assert.deepEqual(applied.spec.catalog,initial.catalog)
 assert.deepEqual(applied.spec.executionPlan,initial.executionPlan);assert.deepEqual(applied.spec.analysisPlan,initial.analysisPlan)
 const expected=id=>({id,label:undefined,model:{provider:'fixture-provider',id:id==='model-a'?'requested-a':'requested-b',settings:{temperature:id==='model-a'?0:1,feature:false,nullable:null,literal:'0',nested:{choices:[0,false,null],literal:'0'}}},adapter:{kind:'http',url:'https://condition.example.invalid/collect'},collection:{comparisonUnit:'model',instructions:{system:'Return the requested answer from the disclosed prompt.',developer:null},tools:[],contextConstruction:'frozen-public-request',sessionIsolation:'fresh-request'}})
 for(const condition of applied.spec.conditions){const declared=expected(condition.id);delete declared.label;assert.deepEqual(condition,declared);const contract=observationContract(applied.spec,condition);assert.equal(contract.identity.policy,'require-match');assert.deepEqual(contract.identity.fields,['provider','id']);assert.equal(contract.completion.policy,'require-complete')}
 const preview=JSON.parse(await f('condition-fields-preview').textContent());assert.deepEqual(preview.conditions,applied.spec.conditions);assert.deepEqual(preview.accounting,applied.spec.observationPlan)
 await select('model-a');await c('model').screenshot({path:resolve(out,'condition-model-desktop.png')})
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 await c('model').screenshot({path:resolve(out,'condition-model-narrow.png')});await page.setViewportSize({width:1440,height:1100})
 results.push('Two HTTPS configurations authored through real roster/model/settings/report-check controls; numeric0/1,false,null,string0 and nested JSON remain typed, a configuration duplicate is edited independently, and stale expert text refuses without mutation')
 await tab('run');await f('freeze').click();await page.waitForFunction(()=>!document.querySelector('[data-bench-export]').disabled)
 assert.equal(await f('run').isDisabled(),true)
 const zip=await download('export','project.zip'),exported=resolve(out,'exported-project')
 const unpack=spawnSync('python3',['-c','import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;z.extractall(sys.argv[2])',zip,exported],{encoding:'utf8'});assert.equal(unpack.status,0,unpack.stderr)
 const project=JSON.parse(await readFile(resolve(exported,'project.json'))),pins=[],requests=[]
 for(const name of RUNTIME_FILES){const digest=await sha256(await readFile(new URL('../../../src/benchmark/'+name,import.meta.url)));assert.equal(project.spec.runtimeSources[name],digest);assert.equal(await sha256(await readFile(resolve(exported,name))),digest);pins.push({name,sha256:digest})}
 const verification=spawnSync(process.execPath,[resolve(exported,'cli.mjs'),'verify'],{encoding:'utf8',timeout:120000,maxBuffer:32*1024*1024});await writeFile(resolve(out,'verify.stdout'),verification.stdout||'');await writeFile(resolve(out,'verify.stderr'),verification.stderr||'');assert.equal(verification.status,0,verification.stderr)
 assert.throws(()=>assertCollectionAdmission(project),/independent-oracle-required/)
 for(const trial of project.schedule){const condition=project.spec.conditions.find(row=>row.id===trial.conditionId),task=project.tasks.find(row=>row.id===trial.taskId),request=collectionRequest(project,condition,task,trial,1)
  assert.deepEqual(request.model,condition.model);assert.equal(request.trial.taskId,task.id);assert.equal(Object.hasOwn(request,'expected'),false);assert.equal(Object.hasOwn(request,'credentialEnv'),false);requests.push(request)
  const missing=observeResponse(project.spec,condition,{output:'authored-control'});assert.equal(missing.eligible,false);assert.equal(missing.usage.outputTokens.status,'unavailable')
 }
 await writeFile(resolve(out,'public-requests.json'),JSON.stringify(requests,null,2))
 results.push('Frozen export verifies45runtime files;4actual canonical public request constructions retain model/settings and omit answer/credential fields, while independent-oracle and missing reported metadata gates remain enforced; no endpoint requests')
 await tab('compose');await f('undo').click();await settled('Previous draft restored')
 const undone=await draft('undo-pending-fields.json');assert.deepEqual(undone.spec,pending.spec)
 assert.deepEqual(JSON.parse(undone.editors['data-bench-condition-fields']),JSON.parse(pending.editors['data-bench-condition-fields']))
 assert.equal(await f('export-evidence').isDisabled(),true)
 results.push('Undo restores the preceding applied source and exact typed raw condition field draft without restoring pre-edit measured evidence')
 assert.deepEqual(errors,[]);assert.equal(externalRequests,0)
 await writeFile(resolve(out,'qualification.json'),JSON.stringify({results,projectSha256:project.sha256,pins,publicRequests:requests.length,externalRequests,providerCalls:0,nativeRuns:0,recordedTrials:0,localModuleCalls:0,cliVerify:1},null,2))
}catch(error){if(page){await page.screenshot({path:resolve(out,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(resolve(out,'failure.json'),JSON.stringify({error:error.stack,status:await page.locator('[data-bench-status]').textContent().catch(()=>null)},null,2))}throw error}
finally{await writeFile(resolve(out,'results.json'),JSON.stringify({results,errors,externalRequests},null,2));await browser.close()}
