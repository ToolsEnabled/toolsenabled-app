import { openResearchProject } from './research-project-picker.mjs'
// Actual Research renderer, ordinary occurrence fields, fresh local CLI modules.
// Synthetic account/service fixture; no provider, native engine or release action.
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
const origin = process.env.BENCHMARK_TEST_ORIGIN || 'http://127.0.0.1:4708'
const out = resolve(process.env.BENCHMARK_TEST_OUTPUT || 'composition-browser-evidence')
await mkdir(out, { recursive: true })
const errors = [], results = [], reportParity = [], browser = await chromium.launch({ headless: true })
const spec = newExperimentDraft(genericStarter(), { initializePopulation: true })
spec.id = 'nested-ordering'; spec.name = 'Independent nested occurrence construction'
spec.catalog = [
  { id: 'compare', version: '1', kind: 'template', role: 'node', slots: { left: 'node', right: 'node' },
    text: 'Return JSON true if LEFT[{{slot:left}}] is less than RIGHT[{{slot:right}}]; otherwise return false.', semantics: { kind: 'less-than' } },
  { id: 'box', version: '1', kind: 'template', role: 'node', slots: { item: 'node' }, text: '({{slot:item}})', semantics: { kind: 'box' } },
  { id: 'number', version: '1', kind: 'atom', role: 'node', text: '{{value}}', parameters: { value: 1 },
    parameterSchema: { value: { type: 'integer', minimum: 0, maximum: 100 } }, semantics: { kind: 'number', value: '{{value}}' } },
]
spec.tasks = [{ id: 'ordering-source', familyId: 'ordering-family', split: 'development', input: null, expected: true,
  root: { use: 'compare', slots: { left: { use: 'box', slots: { item: { use: 'number', params: { value: 1 } } } },
    right: { use: 'box', slots: { item: { use: 'number', params: { value: 10 } } } } } } }]
spec.protocol.grading = { kind: 'json' }
spec.conditions = ['correct', 'reversed'].map(id => ({ id, label: id, model: { provider: 'local-fixture', id, settings: {} },
  adapter: { kind: 'module', file: 'adapters/' + id + '.mjs' } }))
const adapter = reversed => `export function run(request) {
  if ('expected' in request || 'catalog' in request) throw Error('Private answer leaked');
  const match = request.prompt.match(/LEFT\\[\\((\\d+)\\)\\].*RIGHT\\[\\((\\d+)\\)\\]/);
  if (!match) throw Error('Unexpected public prompt');
  return {output: Number(match[1]) ${reversed ? '>' : '<'} Number(match[2])};
}\n`
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true })
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(origin + '/tools/test/fixtures/research-workflow.html?mode=available')
  await page.waitForFunction(() => window.auditReady)
  await openResearchProject(page, { account: true }); await page.locator('[data-project-select]').selectOption('rp-' + 'a'.repeat(36))
  const f = name => page.locator('[data-bench-' + name + ']')
  const c = name => page.locator('[data-composition-fields-' + name + ']')
  const tab = name => page.locator('[data-bench-tab="' + name + '"]').click()
  const settled = async prefix => { await page.waitForFunction(prefix => document.querySelector('[data-bench-status]').textContent.startsWith(prefix), prefix) }
  await openResearchProject(page); await f('import').setInputFiles({ name: 'nested.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ spec })) })
  await settled('Draft imported')
  await tab('protocol')
  for (const id of ['correct', 'reversed']) {
    await f('attachment-path').fill('adapters/' + id + '.mjs'); await f('attachment-text').fill(adapter(id === 'reversed'))
    await f('attach').click(); await settled('Attached')
  }
  await tab('corpus'); await f('prepare-composition-fields').click(); await settled('Occurrence fields prepared')
  assert.equal(await c('occurrence').locator('option').count(), 5)
  await c('rationale').fill('Cross two independent exact leaf occurrences; retain every declared pair before any sampling.')
  await c('expected-policy').selectOption('reuse-base')
  await c('expected-rationale').fill('For these four literal pairs, the largest left value 2 is smaller than the smallest right value 10. The source true answer applies to all four; fresh qualification remains separate.')
  await c('coverage-kind').selectOption('pairwise')
  for (const [side, values] of [['left', [1, 2]], ['right', [10, 20]]]) {
    await c('occurrence').selectOption(JSON.stringify([side, 'item'])); await c('enabled').check()
    await c('axis-id').fill(side); await c('add-choice').click()
    for (let index = 0; index < 2; index++) {
      const choice = c('choice').nth(index)
      await choice.locator('[data-composition-fields-choice-id]').fill(side + '-' + values[index])
      await choice.locator('[data-composition-fields-parameter-value]').fill(String(values[index]))
    }
  }
  await c('seed').fill('unfinished')
  await f('apply-composition-fields').click(); await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.includes('whole number'))
  await f('save').click(); await settled('Draft saved')
  await page.evaluate(() => window.audit.remount())
  await page.waitForFunction(() => document.querySelector('[data-bench-id]').value === 'nested-ordering')
  await tab('corpus'); await f('prepare-composition-fields').click(); await settled('Occurrence fields prepared')
  assert.equal(await c('seed').inputValue(), 'unfinished'); await c('seed').fill('42')
  const raw = JSON.parse(await f('composition-fields').inputValue())
  await writeFile(resolve(out, 'filled-fields.json'), JSON.stringify(raw, null, 2))
  await f('composition-fields-editor').screenshot({ path: resolve(out, 'fields-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await f('composition-fields-editor').screenshot({ path: resolve(out, 'fields-narrow.png') })
  await page.setViewportSize({ width: 1440, height: 1100 })
  await f('apply-composition-fields').click(); await settled('Task recipe built')
  await f('generate-corpus').click(); await settled('4 tasks generated')
  const generated = JSON.parse(await f('spec-json').inputValue()), ledger = JSON.parse(await f('corpus-ledger').textContent())
  assert.deepEqual(generated.tasks.map(task => [task.root.slots.left.slots.item.params.value, task.root.slots.right.slots.item.params.value]), [[1,10],[1,20],[2,10],[2,20]])
  assert.ok(generated.tasks.every(task => task.expected === true))
  assert.equal(ledger.selectedCount, 4); assert.equal(ledger.candidateCount, 4)
  assert.equal(ledger.coverage.filter(row => row.dimension.includes(' × ')).length, 4)
  assert.match(await f('composition-obligations').textContent(), /20 exact occurrence controls.*80 independent interpreter cases/)
  await writeFile(resolve(out, 'generated-spec.json'), JSON.stringify(generated, null, 2))
  await writeFile(resolve(out, 'corpus-ledger.json'), JSON.stringify(ledger, null, 2))
  results.push('Ordinary fields retain unfinished values across remount; independently construct all four nested pairs and enumerate all20controls/min80cases')
  await tab('run'); await f('freeze').click(); await page.waitForFunction(() => !document.querySelector('[data-bench-export]').disabled)
  assert.equal(await f('run').isDisabled(), true); assert.match(await f('readiness').textContent(), /blocked/)
  await f('readiness').screenshot({ path: resolve(out, 'experiment-blocked.png') })
  await f('execution-purpose').selectOption('apparatus-development'); await f('apply-execution').click(); await settled('Version 2 execution design applied')
  await f('freeze').click(); await page.waitForFunction(() => !document.querySelector('[data-bench-export]').disabled)
  assert.match(await f('readiness').textContent(), /unqualified development evidence/)
  const unpack = async (action, name) => {
    const wait = page.waitForEvent('download'); await f(action).click(); const download = await wait
    const zip = resolve(out, name + '.zip'), directory = resolve(out, name); await download.saveAs(zip)
    const result = spawnSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; z.extractall(sys.argv[2])', zip, directory], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr); return directory
  }
  const directory = await unpack('export', 'exported-project'), output = resolve(out, 'cli-results')
  for (const command of ['verify', 'run', 'analyze']) {
    const result = spawnSync(process.execPath, [resolve(directory, 'cli.mjs'), command, '--output', output], { encoding: 'utf8', timeout: 120000, maxBuffer: 64*1024*1024 })
    await writeFile(resolve(out, command + '.stdout'), result.stdout || ''); await writeFile(resolve(out, command + '.stderr'), result.stderr || '')
    assert.equal(result.status, 0, result.stderr)
  }
  const project = JSON.parse(await readFile(resolve(directory, 'project.json'))), evidence = JSON.parse(await readFile(resolve(output, 'evidence.json')))
  assert.equal(evidence.summary.completed, 8)
  assert.deepEqual(evidence.summary.groups.map(row => [row.condition, row.scheduled, row.measured, row.passed]), [['correct', 4, 4, 4], ['reversed', 4, 4, 0]])
  assert.equal(evidence.summary.execution.purpose, 'apparatus-development')
  assert.equal(project.runtimeFiles.length, RUNTIME_FILES.length)
  for (const file of RUNTIME_FILES) assert.equal(await sha256(await readFile(resolve(directory, file))), project.spec.runtimeSources[file], file)
  await f('import-evidence').setInputFiles(resolve(output, 'evidence.json')); await settled('Evidence imported')
  const reports = await unpack('export-report', 'gui-report')
  async function compare(first, second) {
    for (const entry of await readdir(first, { withFileTypes: true })) {
      if (entry.isDirectory()) await compare(resolve(first, entry.name), resolve(second, entry.name))
      else { assert.equal(await readFile(resolve(first, entry.name), 'utf8'), await readFile(resolve(second, entry.name), 'utf8'), entry.name); reportParity.push(resolve(first, entry.name)) }
    }
  }
  await compare(reports, output)
  results.push('Default experiment admission refuses unqualified controls; explicit apparatus development runs8freshblindlocalmodules with4correct/4reversed results; allGUI/CLIreportbytes agree')
  await writeFile(resolve(out, 'export-parity.json'), JSON.stringify({ projectSha256: project.sha256, runtimePins: RUNTIME_FILES.length, reportParity, nativeRuns: 0, providerCalls: 0 }, null, 2))
  assert.deepEqual(errors, [])
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0]
  if (page) { await page.screenshot({ path: resolve(out, 'failure.png'), fullPage: true }).catch(() => {}); await writeFile(resolve(out, 'failure.json'), JSON.stringify({ error: error.stack, status: await page.locator('[data-bench-status]').textContent().catch(() => null) }, null, 2)) }
  throw error
} finally {
  await writeFile(resolve(out, 'results.json'), JSON.stringify({ results, errors }, null, 2)); await browser.close()
}
