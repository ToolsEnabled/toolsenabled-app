import { openResearchProject } from './research-project-picker.mjs'
// Actual coherent v2 workflow setup with canonical recorded controls.
// No native/provider/module campaign. Analyze the same GUI journal in the CLI.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises'
import {resolve,relative} from 'node:path'
import {spawnSync} from 'node:child_process'
import {newExperimentDraft,genericStarter} from '../../../src/benchmark/starters.mjs'
import {workflowFixture} from './research-benchmark-workflow.mjs'
import {RUNTIME_FILES,validateStudy} from '../../../src/benchmark/study.mjs'
import {sha256} from '../../../src/benchmark/prompts.mjs'
assert.ok(process.env.MC_PLAYWRIGHT_ROOT)
const {chromium}=createRequire(import.meta.url)(process.env.MC_PLAYWRIGHT_ROOT)
const origin=process.env.BENCHMARK_TEST_ORIGIN||'http://127.0.0.1:4713',out=resolve(process.env.BENCHMARK_TEST_OUTPUT||'workflow-setup-browser-evidence')
await mkdir(out,{recursive:true})
const initial=newExperimentDraft(genericStarter(),{purpose:'recorded-diagnostic',initializePopulation:true}),target=workflowFixture()
initial.id='workflow-setup-controls';initial.name='Explicit workflow setup controls'
const conditions=structuredClone(target.conditions);conditions[0].id='workflow-control';delete conditions[0].workflowId
const config={plan:target.workflowPlan,assignments:{'workflow-control':'revise'}},accounting=target.observationPlan
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
 await openResearchProject(page); await f('import').setInputFiles({name:'starter.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({spec:initial}))});await settled('Draft imported')
 await tab('workflow');await f('seed-workflow').click();await settled('Workflow draft created')
 await tab('observations');await f('seed-observations').click();await settled('Accounting draft created')
 await f('observation-plan').fill(JSON.stringify(accounting,null,2))
 await tab('workflow');await f('workflow-config').fill(JSON.stringify(config,null,2))
 await tab('protocol');await f('conditions').fill(JSON.stringify(conditions,null,2));await f('timeout').fill('5');await f('duration').fill('60');await f('total').fill('2')
 await f('decisions').fill('SYNTHETIC RECORDED CONTROLS ONLY. Two authored tasks and one declared branch; no provider performance or treatment effect is measured.')
 const pending=await draft('pending-three-groups.json');assert.deepEqual(pending.pending.sort(),['observations','protocol','workflow'])
 await f('apply-protocol').click();await page.waitForFunction(()=>document.querySelector('[data-bench-status]').textContent.includes('Recorded envelopes require a frozen observation plan'))
 assert.deepEqual((await draft('after-individual-refusal.json')).spec,pending.spec)
 await tab('workflow');const invalid=structuredClone(config);invalid.plan.workflows[0].stages[1].next.otherwise='draft'
 await f('workflow-config').fill(JSON.stringify(invalid,null,2));const beforeInvalid=await draft('invalid-three-groups.json')
 await f('apply-workflow-setup').click();await page.waitForFunction(()=>document.querySelector('[data-bench-status]').textContent.includes('acyclic'))
 assert.deepEqual(await draft('after-joint-refusal.json'),beforeInvalid)
 await f('workflow-config').fill(JSON.stringify(config,null,2));await f('apply-workflow-setup').click();await settled('Workflow, protocol and accounting applied together')
 const applied=await draft('applied-workflow.json');validateStudy(applied.spec);assert.deepEqual(applied.pending,[])
 assert.equal(applied.spec.conditions[0].id,'workflow-control');assert.equal(applied.spec.conditions[0].workflowId,'revise');assert.equal(applied.spec.protocol.timeoutMs,5000)
 assert.deepEqual(applied.spec.observationPlan,accounting);assert.equal(applied.spec.executionPlan.purpose,'recorded-diagnostic')
 assert.deepEqual(applied.spec.tasks,initial.tasks);assert.deepEqual(applied.spec.catalog,initial.catalog)
 await f('workflow-config').screenshot({path:resolve(out,'workflow-setup-desktop.png')});await page.setViewportSize({width:390,height:844})
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 await page.locator('[data-bench-panel="workflow"]').screenshot({path:resolve(out,'workflow-setup-narrow.png')});await page.setViewportSize({width:1440,height:1100})
 results.push('Three mutually dependent v2 editor groups apply atomically; existing individual refusal and cyclic-graph refusal preserve applied specification/raw text, while new condition roster/budgets/accounting apply without changing tasks or purpose')
 await tab('run');await f('freeze').click();await page.waitForFunction(()=>!document.querySelector('[data-bench-run]').disabled)
 const exported=await unpack('export','exported-project')
 await f('run').click();await settled('Recorded-response run finished')
 const evidence=JSON.parse(await readFile(await downloaded('export-evidence','gui-evidence.json'))),report=await unpack('export-report','gui-report')
 assert.equal(evidence.summary.completed,2);assert.equal(evidence.summary.groups[0].passed,2)
 assert.equal(evidence.events.filter(event=>event.type==='workflow-started').length,3)
 assert.equal(evidence.events.filter(event=>event.type==='workflow-finished').length,3)
 const project=JSON.parse(await readFile(resolve(exported,'project.json')));assert.equal(project.sha256,evidence.projectSha256)
 const pins=[];for(const name of RUNTIME_FILES){const digest=await sha256(await readFile(new URL('../../../src/benchmark/'+name,import.meta.url)));assert.equal(project.spec.runtimeSources[name],digest);assert.equal(await sha256(await readFile(resolve(exported,name))),digest);pins.push({name,sha256:digest})}
 const cli=resolve(out,'cli-analysis');await mkdir(cli,{recursive:true});await writeFile(resolve(cli,'attempts.jsonl'),evidence.events.map(event=>JSON.stringify(event)).join('\n')+'\n')
 for(const command of ['verify','analyze']){const child=spawnSync(process.execPath,[resolve(exported,'cli.mjs'),command,'--output',cli],{encoding:'utf8',timeout:120000,maxBuffer:64*1024*1024});await writeFile(resolve(out,command+'.stdout'),child.stdout||'');await writeFile(resolve(out,command+'.stderr'),child.stderr||'');assert.equal(child.status,0,child.stderr)}
 async function compare(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const path=resolve(dir,entry.name);if(entry.isDirectory())await compare(path);else{const name=relative(report,path),bytes=await readFile(path);assert.deepEqual(bytes,await readFile(resolve(cli,name)),name);parity.push({name,sha256:await sha256(bytes)})}}}
 await compare(report)
 results.push('Canonical browser runner completes2recorded trials across3workflow stages; exportedCLI verifies45unchanged runtime sources and analyzes the identical retained journal with byte-identical GUI/CLIreports; no provider/model collection')
 await tab('compose');await f('undo').click();await settled('Previous draft restored')
 const undone=await draft('undone-pending-draft.json');assert.deepEqual(undone.spec,pending.spec);assert.deepEqual(undone.pending.sort(),['observations','protocol','workflow'])
 assert.deepEqual(JSON.parse(undone.editors['data-bench-workflow-config']),config)
 assert.equal(await f('export-evidence').isDisabled(),true)
 results.push('Existing Undo restores the preceding applied draft and all3raw pending editor groups without claiming to recover old measured evidence')
 assert.deepEqual(errors,[])
 await writeFile(resolve(out,'qualification.json'),JSON.stringify({results,projectSha256:project.sha256,pins,parity,recordedTrials:2,recordedStages:3,providerCalls:0,nativeRuns:0,localModuleCalls:0,cliVerify:1,cliAnalyzeSameJournal:1},null,2))
} catch(error){if(page){await page.screenshot({path:resolve(out,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(resolve(out,'failure.json'),JSON.stringify({error:error.stack,status:await page.locator('[data-bench-status]').textContent().catch(()=>null)},null,2))}throw error}
finally{await writeFile(resolve(out,'results.json'),JSON.stringify({results,errors},null,2));await browser.close()}
