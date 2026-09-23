import { openResearchProject } from './research-project-picker.mjs'
// Actual Research fields, frozen source copies and recursive generic construction.
// Synthetic account/service transport; fresh local modules only, no native/provider runs.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { genericStarter, newExperimentDraft } from '../../../src/benchmark/starters.mjs'
import { operationalStarter } from '../../../src/benchmark/trading-catalog.mjs'
import { compilePrompt, sha256 } from '../../../src/benchmark/prompts.mjs'
import { RUNTIME_FILES } from '../../../src/benchmark/study.mjs'

assert.ok(process.env.MC_PLAYWRIGHT_ROOT)
const { chromium } = createRequire(import.meta.url)(process.env.MC_PLAYWRIGHT_ROOT)
const origin = process.env.BENCHMARK_TEST_ORIGIN || 'http://127.0.0.1:4709'
const out = resolve(process.env.BENCHMARK_TEST_OUTPUT || 'topology-browser-evidence')
await mkdir(out, { recursive: true })
const errors = [], results = [], reportParity = [], exports = [], browser = await chromium.launch({ headless: true })
let page
const f = name => page.locator('[data-bench-' + name + ']')
const c = name => page.locator('[data-composition-fields-' + name + ']')
const settled = async prefix => page.waitForFunction(prefix => document.querySelector('[data-bench-status]').textContent.startsWith(prefix), prefix)
const choice = index => c('choice').nth(index)
// Structural editor fieldsets are flat and carry exact relative slot paths.
const at = (index, path) => choice(index).locator('[data-composition-fields-structural-node][data-composition-fields-node-path=' + JSON.stringify(JSON.stringify(path)) + ']')
const control = (index, path, name) => at(index, path).locator('[data-composition-fields-' + name + ']')
async function fresh(spec) {
  if (page) await page.close()
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true })
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(origin + '/tools/test/fixtures/research-workflow.html?mode=available')
  await page.waitForFunction(() => window.auditReady)
  await openResearchProject(page, { account: true }); await page.locator('[data-project-select]').selectOption('rp-' + 'a'.repeat(36))
  await openResearchProject(page); await f('import').setInputFiles({ name: 'topology.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ spec })) })
  await settled('Draft imported')
}
async function prepare(reason, expectedReason) {
  await page.locator('[data-bench-tab="corpus"]').click()
  await f('prepare-composition-fields').click(); await settled('Occurrence fields prepared')
  await c('rationale').fill(reason)
  await c('expected-rationale').fill(expectedReason)
}
async function copyBranch(index, path, source) {
  await control(index, path, 'node-kind').selectOption('copy')
  await control(index, path, 'copy-path').selectOption(JSON.stringify(source))
}
async function buildBranch(index, path, bundle) {
  await control(index, path, 'node-kind').selectOption('bundle')
  await control(index, path, 'node-bundle').selectOption(bundle)
}
async function unpack(action, name) {
  const wait = page.waitForEvent('download'); await f(action).click(); const download = await wait
  const zip = resolve(out, name + '.zip'), directory = resolve(out, name); await download.saveAs(zip)
  const result = spawnSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; z.extractall(sys.argv[2])', zip, directory], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr); return directory
}
async function cli(directory, command, output, prefix) {
  const result = spawnSync(process.execPath, [resolve(directory, 'cli.mjs'), command, '--output', output], { encoding: 'utf8', timeout: 120000, maxBuffer: 64*1024*1024 })
  await writeFile(resolve(out, prefix + '-' + command + '.stdout'), result.stdout || '')
  await writeFile(resolve(out, prefix + '-' + command + '.stderr'), result.stderr || '')
  assert.equal(result.status, 0, result.stderr)
}
async function checkExport(directory, name) {
  const project = JSON.parse(await readFile(resolve(directory, 'project.json')))
  assert.equal(project.runtimeFiles.length, RUNTIME_FILES.length)
  for (const file of RUNTIME_FILES) assert.equal(await sha256(await readFile(resolve(directory, file))), project.spec.runtimeSources[file], file)
  exports.push({ name, projectSha256: project.sha256, runtimePins: RUNTIME_FILES.length })
  return project
}
try {
  const operational = newExperimentDraft(await operationalStarter(), { initializePopulation: true })
  await fresh(operational)
  await prepare('Explicitly retain all three root arities with the original nested branch and added source Strategy copies.',
    'Use the existing LEAN semantic compiler on each complete tree. These construction checks do not establish native execution, complete activation or scientific approval.')
  await c('enabled').check(); await c('axis-id').fill('root-arity')
  await c('add-choice').click(); await c('add-choice').click()
  for (const [index, arity] of [2, 3, 4].entries()) {
    await choice(index).locator('[data-composition-fields-choice-id]').fill('arity-' + arity)
    await choice(index).locator('[data-composition-fields-choice-kind]').selectOption('subtree')
    await control(index, [], 'node-bundle').selectOption('op-all-' + arity)
    for (let child = 3; child <= arity; child++) {
      assert.equal(await control(index, ['child' + child], 'node-kind').inputValue(), 'unfilled')
      if (arity === 3 && child === 3) {
        await f('apply-composition-fields').click()
        await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.includes('unfilled'))
        await f('save').click(); await settled('Draft saved')
        await page.evaluate(() => window.audit.remount())
        await page.waitForFunction(() => document.querySelector('[data-bench-id]').value.length > 0)
        await page.locator('[data-bench-tab="corpus"]').click()
        await f('prepare-composition-fields').click(); await settled('Occurrence fields prepared')
        assert.equal(await control(index, ['child' + child], 'node-kind').inputValue(), 'unfilled')
      }
      await copyBranch(index, ['child' + child], ['child1'])
    }
    assert.equal(await control(index, ['child1'], 'copy-path').inputValue(), '["child1"]')
    assert.equal(await control(index, ['child2'], 'copy-path').inputValue(), '["child2"]')
    if (arity > 2) {
      const option = choice(index).locator('[data-composition-fields-choice-kind] option[value="local"]')
      const state = await option.evaluate(element => ({ disabled: element.disabled, outerHTML: element.outerHTML }))
      await writeFile(resolve(out, 'conversion-option-' + arity + '.json'), JSON.stringify({ ...state, playwrightDisabled: await option.isDisabled() }, null, 2))
      assert.equal(state.disabled, true)
    }
  }
  await writeFile(resolve(out, 'operational-fields.json'), await f('composition-fields').inputValue())
  await f('composition-fields-editor').screenshot({ path: resolve(out, 'operational-topology-desktop.png') })
  await choice(2).screenshot({ path: resolve(out, 'operational-choice-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await f('composition-fields-editor').screenshot({ path: resolve(out, 'operational-topology-narrow.png') })
  await page.setViewportSize({ width: 1440, height: 1100 })
  await f('apply-composition-fields').click(); await settled('Task recipe built')
  await f('generate-corpus').click(); await settled('3 tasks generated')
  const operationalGenerated = JSON.parse(await f('spec-json').inputValue())
  const nodeCounts = []
  for (const task of operationalGenerated.tasks) nodeCounts.push((await compilePrompt(operationalGenerated.catalog, task.root)).nodeCount)
  assert.deepEqual(nodeCounts, [17,22,27])
  assert.match(await f('composition-obligations').textContent(), /66 exact occurrence controls.*264 independent interpreter cases/)
  await writeFile(resolve(out, 'operational-generated.json'), JSON.stringify(operationalGenerated, null, 2))
  await writeFile(resolve(out, 'operational-ledger.json'), await f('corpus-ledger').textContent())
  await page.locator('[data-bench-tab="run"]').click()
  await f('freeze').click(); await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.includes('needs review'))
  assert.equal(await f('export').isDisabled(), true)
  await page.locator('[data-bench-tab="library"]').click()
  const bundleOptions = await f('bundle').locator('option').evaluateAll(options => options.map(option => ({ id: option.textContent, value: option.value })))
  for (const id of ['operational-contract-v1','op-above','op-shares','op-after','op-sell-all','op-strategy','op-all-2','op-all-3','op-all-4','op-sequence-2']) {
    await f('bundle').selectOption(bundleOptions.find(bundle => bundle.id.endsWith(' · ' + id)).value)
    await f('reviewer').fill('SYNTHETIC TOPOLOGY BROWSER FIXTURE ONLY'); await f('approve').click()
    await page.waitForFunction(() => document.querySelector('[data-bench-review-status]').textContent.startsWith('Reviewed by SYNTHETIC TOPOLOGY BROWSER FIXTURE ONLY'))
  }
  await page.locator('[data-bench-tab="run"]').click()
  await f('freeze').click(); await page.waitForFunction(() => !document.querySelector('[data-bench-export]').disabled)
  assert.equal(await f('run').isDisabled(), true)
  const operationalDirectory = await unpack('export', 'operational-export')
  await checkExport(operationalDirectory, 'operational')
  await cli(operationalDirectory, 'verify', resolve(out, 'operational-cli'), 'operational')
  results.push('Ordinary fields retain missing children across save/remount, explicitly build three full17/22/27node designs, retain66controls/min264cases and export a CLI-verified project with experiment admission blocked')

  const generic = newExperimentDraft(genericStarter(), { initializePopulation: true })
  generic.id = 'recursive-generic'; generic.name = 'Explicit recursive generic branch fields'
  generic.catalog = [
    { id: 'less', version: '1', role: 'node', kind: 'template', slots: { left: 'node', right: 'node' }, text: 'LESS[{{slot:left}}][{{slot:right}}]', semantics: { kind: 'less' } },
    { id: 'sum', version: '1', role: 'node', kind: 'template', slots: { a: 'node', b: 'node' }, text: 'SUM[{{slot:a}}][{{slot:b}}]', semantics: { kind: 'sum' } },
    { id: 'literal', version: '1', role: 'node', kind: 'atom', text: '{{value}}', parameters: { value: 1 }, parameterSchema: { value: { type: 'integer' } }, semantics: { kind: 'literal', value: '{{value}}' } },
  ]
  generic.tasks = [{ id: 'recursive-source', familyId: 'recursive-family', split: 'development', input: null, expected: true,
    root: { use: 'less', slots: { left: { use: 'literal', params: { value: 1 } }, right: { use: 'literal', params: { value: 10 } } } } }]
  generic.protocol.grading = { kind: 'json' }
  generic.conditions = ['correct','reversed'].map(id => ({ id, label: id, model: { provider: 'local-fixture', id, settings: {} }, adapter: { kind: 'module', file: 'adapters/' + id + '.mjs' } }))
  await fresh(generic)
  await page.locator('[data-bench-tab="protocol"]').click()
  for (const name of ['correct','reversed']) {
    const source = `export function run(request) {
      if ('expected' in request || 'catalog' in request) throw Error('Private answer leaked');
      const text=request.prompt.trim(); let i=0;
      const take=c=>{if(text[i++]!==c)throw Error('Invalid public expression');};
      function expression(){
        const number=/^-?\\d+/.exec(text.slice(i)); if(number){i+=number[0].length;return Number(number[0]);}
        const operation=text.startsWith('LESS',i)?'LESS':text.startsWith('SUM',i)?'SUM':null;
        if(!operation)throw Error('Unknown public operation'); i+=operation.length;
        take('[');const a=expression();take(']');take('[');const b=expression();take(']');
        return operation==='SUM'?a+b:a${name === 'correct' ? '<' : '>'}b;
      }
      const output=expression();if(i!==text.length)throw Error('Trailing public expression');return {output};
    }\n`
    await f('attachment-path').fill('adapters/' + name + '.mjs'); await f('attachment-text').fill(source)
    await f('attach').click(); await settled('Attached')
  }
  await prepare('Vary one exact right occurrence between its source literal and an explicitly built recursive sum.',
    'Hand calculation: 1 < 10 and 1 < (10 + (1 + 1)). The source true answer applies to both cases; no general oracle or qualification is inferred.')
  await c('expected-policy').selectOption('reuse-base'); await c('occurrence').selectOption('["right"]')
  await c('enabled').check(); await c('axis-id').fill('right-shape'); await c('add-choice').click()
  await choice(0).locator('[data-composition-fields-choice-id]').fill('source-literal')
  await choice(0).locator('[data-composition-fields-choice-kind]').selectOption('subtree')
  await copyBranch(0, [], ['right'])
  await choice(1).locator('[data-composition-fields-choice-id]').fill('nested-sum')
  await choice(1).locator('[data-composition-fields-choice-kind]').selectOption('subtree')
  await buildBranch(1, [], 'sum'); await copyBranch(1, ['a'], ['right'])
  await buildBranch(1, ['b'], 'sum'); await copyBranch(1, ['b','a'], ['left']); await copyBranch(1, ['b','b'], ['left'])
  await writeFile(resolve(out, 'generic-fields.json'), await f('composition-fields').inputValue())
  await f('composition-fields-editor').screenshot({ path: resolve(out, 'generic-topology-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await f('composition-fields-editor').screenshot({ path: resolve(out, 'generic-topology-narrow.png') })
  await choice(1).screenshot({ path: resolve(out, 'generic-choice-narrow.png') })
  await page.setViewportSize({ width: 1440, height: 1100 })
  await f('apply-composition-fields').click(); await settled('Task recipe built')
  await f('generate-corpus').click(); await settled('2 tasks generated')
  const genericGenerated = JSON.parse(await f('spec-json').inputValue()), prompts = []
  for (const task of genericGenerated.tasks) prompts.push((await compilePrompt(genericGenerated.catalog, task.root)).text)
  assert.deepEqual(prompts, ['LESS[1][10]', 'LESS[1][SUM[10][SUM[1][1]]]'])
  assert.match(await f('composition-obligations').textContent(), /10 exact occurrence controls.*40 independent interpreter cases/)
  await writeFile(resolve(out, 'generic-generated.json'), JSON.stringify(genericGenerated, null, 2))
  await writeFile(resolve(out, 'generic-ledger.json'), await f('corpus-ledger').textContent())
  await page.locator('[data-bench-tab="run"]').click()
  await f('freeze').click(); await page.waitForFunction(() => !document.querySelector('[data-bench-export]').disabled)
  assert.equal(await f('run').isDisabled(), true)
  await f('execution-purpose').selectOption('apparatus-development'); await f('apply-execution').click(); await settled('Version 2 execution design applied')
  await f('freeze').click(); await page.waitForFunction(() => !document.querySelector('[data-bench-export]').disabled)
  const directory = await unpack('export', 'generic-export'), output = resolve(out, 'generic-cli')
  await checkExport(directory, 'generic')
  for (const command of ['verify', 'run', 'analyze']) await cli(directory, command, output, 'generic')
  const evidence = JSON.parse(await readFile(resolve(output, 'evidence.json')))
  assert.equal(evidence.summary.completed, 4)
  assert.deepEqual(evidence.summary.groups.map(row => [row.condition, row.measured, row.passed]), [['correct',2,2],['reversed',2,0]])
  assert.equal(evidence.summary.execution.purpose, 'apparatus-development')
  await f('import-evidence').setInputFiles(resolve(output, 'evidence.json')); await settled('Evidence imported')
  const reports = await unpack('export-report', 'generic-gui-report')
  async function compare(first, second) {
    for (const entry of await readdir(first, { withFileTypes: true })) {
      if (entry.isDirectory()) await compare(resolve(first, entry.name), resolve(second, entry.name))
      else { assert.equal(await readFile(resolve(first, entry.name), 'utf8'), await readFile(resolve(second, entry.name), 'utf8'), entry.name); reportParity.push(resolve(first, entry.name)) }
    }
  }
  await compare(reports, output)
  results.push('Ordinary fields replace a generic atom with a recursive expression; exact public prompts match hand calculations;4freshblindlocalmodules give2correct/2reversed outcomes and allGUI/CLIreportbytes agree')
  await writeFile(resolve(out, 'export-parity.json'), JSON.stringify({ exports, reportParity, nativeRuns: 0, providerCalls: 0, localModuleCalls: 4 }, null, 2))
  assert.deepEqual(errors, [])
} catch (error) {
  if (page) {
    await page.screenshot({ path: resolve(out, 'failure.png'), fullPage: true }).catch(() => {})
    await writeFile(resolve(out, 'failure.json'), JSON.stringify({ error: error.stack, status: await f('status').textContent().catch(() => null) }, null, 2))
  }
  throw error
} finally {
  await writeFile(resolve(out, 'results.json'), JSON.stringify({ results, errors }, null, 2)); await browser.close()
}
