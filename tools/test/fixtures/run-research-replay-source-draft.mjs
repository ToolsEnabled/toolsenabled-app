import { openResearchProject } from './research-project-picker.mjs'
// Actual ordinary replay source derivative, protocol application and final freeze.
// No candidate/provider/native execution; portable CLI verification only.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
import {validateStudy,RUNTIME_FILES} from '../../../src/benchmark/study.mjs'
import {sha256} from '../../../src/benchmark/prompts.mjs'
assert.ok(process.env.MC_PLAYWRIGHT_ROOT);assert.ok(process.env.BENCHMARK_SOURCE_DRAFT_BASELINE)
const {chromium}=createRequire(import.meta.url)(process.env.MC_PLAYWRIGHT_ROOT)
const baseline=resolve(process.env.BENCHMARK_SOURCE_DRAFT_BASELINE),out=resolve(process.env.BENCHMARK_TEST_OUTPUT||'replay-source-draft-evidence')
const origin=process.env.BENCHMARK_TEST_ORIGIN||'http://127.0.0.1:4712'
await mkdir(out,{recursive:true})
const prior=JSON.parse(await readFile(resolve(baseline,'exported-project/project.json'))),spec=structuredClone(prior.spec)
spec.conditions=spec.conditions.map(condition=>({...condition,adapter:{kind:'replay',responses:Object.fromEntries(spec.tasks.map(task=>[task.id,condition.id==='correct']))}}))
validateStudy(spec)
const familyFields=await readFile(resolve(baseline,'filled-workspace.json'),'utf8')
const attachments=Object.fromEntries(await Promise.all(spec.inputs.map(async input=>[input.path,await readFile(resolve(baseline,'exported-project',input.path),'utf8')])))
const original={version:1,spec,attachments,editors:{'data-bench-composition-family-fields':familyFields},pending:[]}
const browser=await chromium.launch({headless:true}),results=[],errors=[]
let page
try {
 page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});page.on('pageerror',error=>errors.push(error.message))
 await page.goto(origin+'/tools/test/fixtures/research-workflow.html?mode=available');await page.waitForFunction(()=>window.auditReady)
 await openResearchProject(page, { account: true }); await page.locator('[data-project-select]').selectOption('rp-'+'a'.repeat(36))
 const f=name=>page.locator('[data-bench-'+name+']')
 const tab=name=>page.locator('[data-bench-tab="'+name+'"]').click()
 const settled=text=>page.waitForFunction(text=>document.querySelector('[data-bench-status]').textContent.startsWith(text),text)
 async function imported(draft){await openResearchProject(page); await f('import').setInputFiles({name:'draft.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(draft))});await settled('Draft imported')}
 async function downloaded(action,name){const pending=page.waitForEvent('download');await f(action).click();const file=await pending,path=resolve(out,name);await file.saveAs(path);return path}
 await imported(original);await tab('corpus')
 const path=await downloaded('export-family-sources','ordinary-source-draft.json'),derivative=JSON.parse(await readFile(path))
 assert.equal(derivative.spec.schemaVersion,2);validateStudy(derivative.spec)
 for(const condition of derivative.spec.conditions){assert.equal(Object.hasOwn(condition.adapter,'workflowResponses'),false);assert.deepEqual(condition.adapter.responses,{})}
 assert.deepEqual(derivative.spec.tasks,JSON.parse(familyFields).families.map(row=>row.sourceTask))
 assert.deepEqual(JSON.parse(await f('spec-json').inputValue()),spec)
 await imported(derivative);await tab('protocol');await f('apply-protocol').click();await settled('Protocol applied')
 assert.ok(JSON.parse(await f('spec-json').inputValue()).conditions.every(condition=>!Object.hasOwn(condition.adapter,'workflowResponses')))
 results.push('Valid ordinary schema2 replay source derivative preserves absent workflow configuration; ordinary Apply protocol succeeds after Import instead of rejecting invented workflow state')
 await tab('corpus');await page.locator('[data-composition-family-fields-family]').selectOption('source-a');await settled('Family fields inspected')
 await f('apply-composition-fields').click();await settled('Task recipe built')
 await f('generate-corpus').click();await settled('4 tasks generated')
 await tab('run');await f('freeze').click();await page.waitForFunction(()=>!document.querySelector('[data-bench-export]').disabled)
 assert.equal(await f('export-evidence').isDisabled(),true)
 const zip=await downloaded('export','ordinary-rebuilt-project.zip'),directory=resolve(out,'ordinary-rebuilt-project')
 const unpack=spawnSync('python3',['-c','import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;z.extractall(sys.argv[2])',zip,directory],{encoding:'utf8'});assert.equal(unpack.status,0,unpack.stderr)
 const project=JSON.parse(await readFile(resolve(directory,'project.json')));assert.equal(project.tasks.length,4);assert.equal(project.schedule.length,8)
 assert.deepEqual(project.spec.tasks,spec.tasks)
 const pins=[]
 for(const name of RUNTIME_FILES){const digest=await sha256(await readFile(new URL('../../../src/benchmark/'+name,import.meta.url)));assert.equal(project.spec.runtimeSources[name],digest);assert.equal(await sha256(await readFile(resolve(directory,name))),digest);pins.push({name,sha256:digest})}
 const check=spawnSync(process.execPath,[resolve(directory,'cli.mjs'),'verify'],{encoding:'utf8',timeout:120000});await writeFile(resolve(out,'verify.stdout'),check.stdout||'');await writeFile(resolve(out,'verify.stderr'),check.stderr||'');assert.equal(check.status,0,check.stderr)
 await f('frozen-details').screenshot({path:resolve(out,'ordinary-replay-frozen.png')})
 results.push('Ordinary replay source fields rebuild4cases, freeze8scheduled trials and export45unchanged runtime files; normal CLIverify passes with no evidence or execution fabricated')
 assert.deepEqual(errors,[])
 await writeFile(resolve(out,'qualification.json'),JSON.stringify({results,projectSha256:project.sha256,pins,taskCount:4,scheduledTrials:8,freshCandidateCalls:0,nativeRuns:0,providerCalls:0,cliVerify:1},null,2))
} catch(error){if(page){await page.screenshot({path:resolve(out,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(resolve(out,'failure.json'),JSON.stringify({error:error.stack,status:await page.locator('[data-bench-status]').textContent().catch(()=>null)},null,2))}throw error}
finally{await writeFile(resolve(out,'results.json'),JSON.stringify({results,errors},null,2));await browser.close()}
