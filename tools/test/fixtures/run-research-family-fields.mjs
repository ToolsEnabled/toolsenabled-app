import { openResearchProject } from './research-project-picker.mjs'
// Actual Research family workspace, frozen provenance and fresh local CLI controls.
// Synthetic account/service fixture. No native engine or provider calls.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { genericStarter, newExperimentDraft } from '../../../src/benchmark/starters.mjs'
import { RUNTIME_FILES } from '../../../src/benchmark/study.mjs'
import { sha256 } from '../../../src/benchmark/prompts.mjs'
assert.ok(process.env.MC_PLAYWRIGHT_ROOT)
const { chromium } = createRequire(import.meta.url)(process.env.MC_PLAYWRIGHT_ROOT)
const origin = process.env.BENCHMARK_TEST_ORIGIN || 'http://127.0.0.1:4710'
const out = resolve(process.env.BENCHMARK_TEST_OUTPUT || 'family-browser-evidence')
await mkdir(out, { recursive: true })
const results = [], errors = [], reportParity = [], browser = await chromium.launch({ headless: true })
const spec = newExperimentDraft(genericStarter(), { initializePopulation: true })
spec.id = 'two-source-families'; spec.name = 'Two families with separately required factor choices'
spec.catalog = [
  { id: 'less', version: '1', role: 'node', kind: 'template', slots: { left: 'node', right: 'node' }, text: 'LESS[{{slot:left}}][{{slot:right}}]', semantics: { kind: 'less' } },
  { id: 'number', version: '1', role: 'node', kind: 'atom', text: '{{value}}', parameters: { value: 1 }, parameterSchema: { value: { type: 'integer' } }, semantics: { kind: 'number', value: '{{value}}' } },
]
spec.tasks = ['a','b'].map((id,i) => ({ id: 'source-' + id, familyId: 'family-' + id, split: i ? 'held-out' : 'development', input: { source: id, offset: i }, expected: true,
  root: { use: 'less', slots: { left: { use: 'number', params: { value: 1 } }, right: { use: 'number', params: { value: (i+1)*10 } } } } }))
spec.protocol.grading = { kind: 'json' }
spec.conditions = ['correct','reversed'].map(id => ({ id, label: id, model: { provider: 'local-fixture', id, settings: {} }, adapter: { kind: 'module', file: 'adapters/' + id + '.mjs' } }))
let page
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true })
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(origin + '/tools/test/fixtures/research-workflow.html?mode=available'); await page.waitForFunction(() => window.auditReady)
  await openResearchProject(page, { account: true }); await page.locator('[data-project-select]').selectOption('rp-' + 'a'.repeat(36))
  const f = name => page.locator('[data-bench-' + name + ']')
  const c = name => page.locator('[data-composition-fields-' + name + ']')
  const w = name => page.locator('[data-composition-family-fields-' + name + ']')
  const tab = name => page.locator('[data-bench-tab="' + name + '"]').click()
  const settled = prefix => page.waitForFunction(prefix => document.querySelector('[data-bench-status]').textContent.startsWith(prefix), prefix)
  const raw = async () => JSON.parse(await f('composition-family-fields').inputValue())
  await openResearchProject(page); await f('import').setInputFiles({ name: 'families.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ spec })) }); await settled('Draft imported')
  await tab('protocol')
  for (const name of ['correct','reversed']) {
    const source = `export function run(request) { if ('expected' in request || 'catalog' in request) throw Error('Private answer leaked'); const match=/^LESS\\[(\\d+)\\]\\[(\\d+)\\]$/.exec(request.prompt.trim()); if(!match)throw Error('Unexpected public prompt'); return {output:Number(match[1])${name === 'correct' ? '<' : '>'}Number(match[2])}; }\n`
    await f('attachment-path').fill('adapters/' + name + '.mjs'); await f('attachment-text').fill(source); await f('attach').click(); await settled('Attached')
  }
  await tab('corpus'); await f('prepare-composition-fields').click(); await settled('Occurrence fields prepared')
  await f('start-family-workspace').click(); await settled('Family workspace started')
  await w('rationale').fill('Retain both choices independently within each original source family; share one global selection budget.')
  await w('selection-kind').selectOption('balanced'); await w('selection-limit').fill('2')
  async function fillFamily(id) {
    await c('rationale').fill('Vary the left operand within original family ' + id + '; retain the declared source input and split.')
    await c('expected-policy').selectOption('reuse-base')
    await c('expected-rationale').fill(id === 'a' ? 'Both 1 and 2 are less than 10. The source true answer applies to both cases.' : 'Both 1 and 2 are less than 20. The source true answer applies to both cases.')
    await c('occurrence').selectOption('["left"]'); await c('enabled').check(); await c('axis-id').fill('quantity')
    await c('add-choice').click()
    for (const [index,value] of [1,2].entries()) {
      const choice = c('choice').nth(index)
      await choice.locator('[data-composition-fields-choice-id]').fill(index ? 'y' : 'x')
      await choice.locator('[data-composition-fields-parameter-value]').fill(String(value))
    }
  }
  await fillFamily('a')
  await w('source').selectOption('source-b'); await w('add').click(); await settled('Source family added'); await fillFamily('b')
  assert.equal(await c('selection-kind').count(), 0, 'Only the workspace sampling policy is visible')
  const beforeNavigation = await raw()
  await w('family').selectOption('source-a'); await settled('Family fields inspected'); assert.deepEqual(await raw(), beforeNavigation)
  await w('seed').fill('unfinished seed'); await f('save').click(); await settled('Draft saved')
  await page.evaluate(() => window.audit.remount()); await page.waitForFunction(() => document.querySelector('[data-bench-id]').value === 'two-source-families')
  await tab('corpus'); assert.equal(await w('seed').inputValue(), 'unfinished seed')
  await w('family').selectOption('source-b'); await settled('Family fields inspected')
  assert.match(await c('expected-rationale').inputValue(), /less than 20/)
  await w('seed').fill('42')
  await f('apply-composition-fields').click(); await settled('Task recipe built')
  await f('generate-corpus').click(); await settled('Task generation is coverage-unmet')
  const limited = JSON.parse(await f('corpus-ledger').textContent())
  assert.equal(limited.unmetCoverage.length, 2)
  assert.equal(JSON.parse(await f('spec-json').inputValue()).tasks.length, 2)
  await writeFile(resolve(out, 'coverage-limit-two.json'), JSON.stringify(limited, null, 2))
  await w('selection-limit').fill('4'); await f('apply-composition-fields').click(); await settled('Task recipe built')
  const sourceWorkspace = await raw(); await writeFile(resolve(out, 'filled-workspace.json'), JSON.stringify(sourceWorkspace, null, 2))
  await f('family-workspace').screenshot({ path: resolve(out, 'family-fields-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await f('family-editor').screenshot({ path: resolve(out, 'family-policy-narrow.png') }); await page.setViewportSize({ width: 1440, height: 1100 })
  await f('generate-corpus').click(); await settled('4 tasks generated')
  const generated = JSON.parse(await f('spec-json').inputValue()), ledger = JSON.parse(await f('corpus-ledger').textContent())
  assert.equal(ledger.status, 'ready'); assert.deepEqual(ledger.unmetCoverage, [])
  assert.equal(ledger.coverage.filter(cell => cell.dimension.startsWith('axis:')).length, 4)
  for (const id of ['a','b']) {
    const tasks = generated.tasks.filter(task => task.familyId === 'family-' + id)
    assert.equal(tasks.length, 2); assert.deepEqual(tasks.map(task => task.root.slots.left.params.value).sort(), [1,2])
    assert.ok(tasks.every(task => task.input.source === id && task.expected === true && task.split === (id === 'a' ? 'development' : 'held-out')))
  }
  assert.equal(new Set(generated.corpusPlan.fieldAuthoring.axisMappings.map(row => row.recipeAxisId)).size, 2)
  assert.match(await f('composition-obligations').textContent(), /12 exact occurrence controls.*48 independent interpreter cases/)
  await writeFile(resolve(out, 'generated-spec.json'), JSON.stringify(generated, null, 2)); await writeFile(resolve(out, 'corpus-ledger.json'), JSON.stringify(ledger, null, 2))
  await f('apply-composition-fields').click(); await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.includes('source task is unavailable'))
  assert.deepEqual(await raw(), sourceWorkspace)
  results.push('Ordinary family workspace retains unfinished fields across remount, refuses pooled coverage atlimit2, preserves bothoriginalsources and generatesall4family-scoped cases atlimit4 with12targets/min48cases; missingoriginals cannot be replaced by capsules')
  await tab('run'); await f('freeze').click(); await page.waitForFunction(() => !document.querySelector('[data-bench-export]').disabled); assert.equal(await f('run').isDisabled(), true)
  await f('execution-purpose').selectOption('apparatus-development'); await f('apply-execution').click(); await settled('Version 2 execution design applied')
  await f('freeze').click(); await page.waitForFunction(() => !document.querySelector('[data-bench-export]').disabled)
  async function unpack(action, name) {
    const wait = page.waitForEvent('download'); await f(action).click(); const download = await wait
    const zip = resolve(out, name+'.zip'), dir = resolve(out,name); await download.saveAs(zip)
    const child = spawnSync('python3',['-c','import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; z.extractall(sys.argv[2])',zip,dir],{encoding:'utf8'})
    assert.equal(child.status,0,child.stderr);return dir
  }
  const directory = await unpack('export','exported-project'), output = resolve(out,'cli-results')
  for(const command of ['verify','run','analyze']) {
    const child=spawnSync(process.execPath,[resolve(directory,'cli.mjs'),command,'--output',output],{encoding:'utf8',timeout:120000,maxBuffer:64*1024*1024})
    await writeFile(resolve(out,command+'.stdout'),child.stdout||'');await writeFile(resolve(out,command+'.stderr'),child.stderr||'');assert.equal(child.status,0,child.stderr)
  }
  const project=JSON.parse(await readFile(resolve(directory,'project.json'))),evidence=JSON.parse(await readFile(resolve(output,'evidence.json')))
  assert.deepEqual(JSON.parse(await readFile(resolve(directory,'corpus/field-authoring.json'))),generated.corpusPlan.fieldAuthoring)
  assert.equal(evidence.summary.completed,8);assert.deepEqual(evidence.summary.groups.map(row=>[row.condition,row.measured,row.passed]),[['correct',4,4],['reversed',4,0]])
  assert.equal(evidence.summary.execution.purpose,'apparatus-development')
  assert.equal(project.runtimeFiles.length,RUNTIME_FILES.length)
  for(const file of RUNTIME_FILES)assert.equal(await sha256(await readFile(resolve(directory,file))),project.spec.runtimeSources[file],file)
  await f('import-evidence').setInputFiles(resolve(output,'evidence.json'));await settled('Evidence imported')
  const reports=await unpack('export-report','gui-report')
  async function compare(first,second) {for(const entry of await readdir(first,{withFileTypes:true})) {if(entry.isDirectory())await compare(resolve(first,entry.name),resolve(second,entry.name));else {assert.equal(await readFile(resolve(first,entry.name),'utf8'),await readFile(resolve(second,entry.name),'utf8'),entry.name);reportParity.push(resolve(first,entry.name))}}}
  await compare(reports,output)
  results.push('Export preserves exact family-source/expected-policy/factor provenance;8freshblindlocalmodulecalls give4correct/4reversed controls and allGUI/CLIreportbytes agree')
  await writeFile(resolve(out,'export-parity.json'),JSON.stringify({projectSha256:project.sha256,runtimePins:RUNTIME_FILES.length,reportParity,nativeRuns:0,providerCalls:0,localModuleCalls:8},null,2))
  assert.deepEqual(errors,[])
} catch(error) {
  if(page){await page.screenshot({path:resolve(out,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(resolve(out,'failure.json'),JSON.stringify({error:error.stack,status:await page.locator('[data-bench-status]').textContent().catch(()=>null)},null,2))}throw error
} finally {await writeFile(resolve(out,'results.json'),JSON.stringify({results,errors},null,2));await browser.close()}
