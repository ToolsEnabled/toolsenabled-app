import { openResearchProject } from './research-project-picker.mjs'
// Actual field authoring and canonical saved-response controls only.
// Synthetic review records are not investigator approval or native evidence.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { informationContextFixture, contextReviewer } from './research-benchmark-information-context.mjs'
import { operationalStarter } from '../../../src/benchmark/trading-catalog.mjs'
import { newExperimentDraft } from '../../../src/benchmark/starters.mjs'
import { compileTask } from '../../../src/benchmark/tasks.mjs'
import { RUNTIME_FILES } from '../../../src/benchmark/study.mjs'
import { sha256 } from '../../../src/benchmark/prompts.mjs'

const { chromium } = createRequire(import.meta.url)(process.env.MC_PLAYWRIGHT_ROOT)
const origin = process.env.BENCHMARK_TEST_ORIGIN || 'http://127.0.0.1:4728'
const out = resolve(process.env.BENCHMARK_TEST_OUTPUT || 'information-fields-browser-evidence')
await mkdir(out, { recursive: true })
const initial = await informationContextFixture({ workflow: false, review: false })
initial.requireReview = true; delete initial.tasks[0].information
for (const condition of initial.conditions) condition.adapter.responses['number-task'] = 0
const browser = await chromium.launch({ headless: true }), results = [], errors = [], pins = [], parity = []
let page, externalRequests = 0
async function unpack(zip, destination) {
  const result = spawnSync('python3', ['-c', 'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;z.extractall(sys.argv[2])', zip, destination], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true })
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', async route => {
    if (new URL(route.request().url()).origin !== origin) { externalRequests++; await route.abort() }
    else await route.continue()
  })
  await page.goto(origin + '/tools/test/fixtures/research-workflow.html?mode=available')
  await page.waitForFunction(() => window.auditReady)
  await openResearchProject(page, { account: true }); await page.locator('[data-project-select]').selectOption('rp-' + 'a'.repeat(36))
  const f = name => page.locator('[data-bench-' + name + ']')
  const c = name => f('information-fields-editor').locator('[data-information-fields-' + name + ']')
  const tab = name => page.locator('[data-bench-tab="' + name + '"]').click()
  const settled = text => page.waitForFunction(text => document.querySelector('[data-bench-status]').textContent.startsWith(text), text)
  const fields = async () => JSON.parse(await f('information-fields').inputValue())
  async function download(action, name) {
    const wait = page.waitForEvent('download'); await f(action).click()
    const item = await wait, path = resolve(out, name); await item.saveAs(path); return path
  }
  const draft = async name => JSON.parse(await readFile(await download('draft-export', name)))
  async function importDraft(spec) {
    await openResearchProject(page); await f('import').setInputFiles({ name: 'source.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ spec })) })
    await settled('Draft imported'); await tab('compose')
  }
  async function addReading(id) {
    await c('source').selectOption('baseline'); await c('add-reading').click()
    await c('reading-id').fill(id); await c('reading-rationale').fill('Synthetic explicit reading ' + id + '; no scientific completeness claim.')
  }
  async function override(path, name, value) {
    await c('parameter').selectOption(JSON.stringify([path, name])); await c('add-edit').click()
    await c('edit-value').last().fill(value)
    assert.equal((await fields()).readings.at(-1).expected.mode, '')
  }
  async function prepareFields(path) {
    await f('prepare-information-fields').click(); await settled('Information fields prepared')
    assert.deepEqual((await fields()).readings, [])
    await c('rationale').fill('Synthetic local information treatment; exact declared reading set only.')
    await f('information-fields-editor').locator('[data-information-fields-path="' + path + '"]').check()
  }
  async function approveBundles(spec) {
    const task = await compileTask(spec, spec.tasks[0], { requireReview: false, requireTaskReview: false })
    const ids = [], seen = new Set()
    function visit(id) {
      if (seen.has(id)) return; seen.add(id)
      for (const dependency of spec.catalog.find(bundle => bundle.id === id).dependencies || []) visit(dependency)
      ids.push(id)
    }
    for (const bundle of task.compiled.bundles) visit(bundle.id)
    await tab('library')
    for (const id of ids) {
      await f('bundle').selectOption(String(spec.catalog.findIndex(bundle => bundle.id === id)))
      await f('reviewer').fill(contextReviewer); await f('approve').click(); await settled('Your review was recorded')
    }
    await tab('compose')
  }
  async function approveInformation() {
    await tab('compose'); await f('information-details').evaluate(node => { node.open = true })
    await f('prepare-information').click(); await settled('Current prompt, readings')
    await f('information-reviewer').fill(contextReviewer)
    await f('approve-information').click(); await settled('Your review is bound')
  }
  await importDraft(initial); await prepareFields('root/rule')
  await addReading('number-zero'); await override(['rule'], 'value', '0')
  const beforeRefusal = await draft('generic-incomplete-policy.json')
  await f('apply-information-fields').click(); await settled('Choose retained')
  assert.deepEqual(await draft('generic-policy-refused.json'), beforeRefusal)
  await c('expected-mode').selectOption('declare'); await c('expected-text').fill('0')
  await addReading('number-two')
  assert.equal((await fields()).readings[1].expected.mode, 'retained')
  await f('apply-information-fields').click(); await settled('Information treatment built')
  const built = await draft('generic-built.json'), task = built.spec.tasks[0]
  assert.deepEqual(task.information.withheldPaths, ['root/rule'])
  assert.equal(task.information.readings[0].root.slots.rule.params.value, 0)
  assert.equal(task.information.readings[0].expected, 0)
  assert.deepEqual(task.information.readings[1].root, initial.tasks[0].root)
  assert.equal(task.information.readings[1].expected, 2)
  assert.equal(task.expected, 2); assert.equal(built.spec.taskReviews?.length || 0, 0)
  await f('undo').click(); await settled('Previous draft restored')
  assert.equal((await fields()).readings.length, 2)
  assert.equal((await draft('generic-undo.json')).spec.tasks[0].information, undefined)
  // Undo restores retained field text. Prepare inspects its same source before rebuilding.
  await f('prepare-information-fields').click(); await settled('Information fields prepared')
  await f('apply-information-fields').click(); await settled('Information treatment built')
  results.push('Actual numeric fields produce explicit 0/2 readings, refuse the missing expected-answer policy atomically, and Undo retains the unpublished fields without changing the source task')

  await tab('run'); await f('freeze').click()
  await page.waitForFunction(() => /review/i.test(document.querySelector('[data-bench-status]').textContent))
  assert.equal(await f('export').isDisabled(), true)
  await writeFile(resolve(out, 'generic-unreviewed-refusal.txt'), await f('status').textContent())
  await approveBundles((await draft('generic-before-review.json')).spec)
  await approveInformation(); await tab('run'); await f('freeze').click(); await settled('Project frozen')
  const zip = await download('export', 'generic-project.zip'), exported = resolve(out, 'generic-project')
  await unpack(zip, exported)
  const project = JSON.parse(await readFile(resolve(exported, 'project.json')))
  assert.equal(project.spec.executionPlan.purpose, 'apparatus-development')
  assert.equal(project.tasks[0].informationPacket.version, 2)
  assert.deepEqual(project.tasks[0].interpretations.map(reading => reading.expected), [0, 2])
  for (const name of RUNTIME_FILES) {
    const digest = await sha256(await readFile(new URL('../../../src/benchmark/' + name, import.meta.url)))
    assert.equal(project.spec.runtimeSources[name], digest)
    assert.equal(await sha256(await readFile(resolve(exported, name))), digest)
    pins.push({ name, sha256: digest })
  }
  const verify = spawnSync(process.execPath, [resolve(exported, 'cli.mjs'), 'verify'], { encoding: 'utf8', timeout: 30000 })
  await writeFile(resolve(out, 'verify.stdout'), verify.stdout || ''); await writeFile(resolve(out, 'verify.stderr'), verify.stderr || '')
  assert.equal(verify.status, 0, verify.stderr)
  await f('run').click(); await settled('Recorded-response run finished')
  const evidence = JSON.parse(await readFile(await download('export-evidence', 'generic-evidence.json')))
  assert.equal(evidence.summary.completed, 2)
  assert.equal(evidence.events.filter(row => row.type === 'workflow-started').length, 0)
  const reportZip = await download('export-report', 'generic-report.zip'), reportRoot = resolve(out, 'gui-report')
  await unpack(reportZip, reportRoot); await mkdir(resolve(exported, 'results'))
  await writeFile(resolve(exported, 'results/attempts.jsonl'), evidence.events.map(row => JSON.stringify(row)).join('\n') + '\n')
  const analyze = spawnSync(process.execPath, [resolve(exported, 'cli.mjs'), 'analyze'], { encoding: 'utf8', timeout: 30000 })
  await writeFile(resolve(out, 'analyze.stdout'), analyze.stdout || ''); await writeFile(resolve(out, 'analyze.stderr'), analyze.stderr || '')
  assert.equal(analyze.status, 0, analyze.stderr)
  async function compare(directory = '') {
    for (const entry of await readdir(resolve(reportRoot, directory), { withFileTypes: true })) {
      const file = directory ? directory + '/' + entry.name : entry.name
      if (entry.isDirectory()) await compare(file)
      else {
        const bytes = await readFile(resolve(reportRoot, file))
        assert.deepEqual(await readFile(resolve(exported, 'results', file)), bytes, file)
        parity.push({ file, sha256: await sha256(bytes), bytes: bytes.length })
      }
    }
  }
  await compare()
  results.push('Review remains required; explicit synthetic reviews allow apparatus-only export with45runtime pins,2canonical saved trials and byte-identical GUI/CLI reports for the new reading treatment')

  const nested = newExperimentDraft(await operationalStarter(), { initializePopulation: true })
  nested.id = 'nested-information-fields-control'
  await importDraft(nested); assert.equal(await f('information-fields').inputValue(), '')
  await prepareFields('root/child1/buy_process')
  for (const quantity of [2, 4]) {
    await addReading('quantity-' + quantity); await override(['child1', 'buy_process'], 'quantity', String(quantity))
    await c('expected-mode').selectOption('derive-lean')
  }
  await f('apply-information-fields').click(); await settled('Information treatment built')
  const nestedBuilt = await draft('nested-built.json')
  const compiled = await compileTask(nestedBuilt.spec, nestedBuilt.spec.tasks[0], { requireReview: false, requireTaskReview: false })
  assert.deepEqual(nestedBuilt.spec.tasks[0].root, nested.tasks[0].root)
  assert.equal(compiled.informationPacket.version, 2)
  assert.equal(compiled.compiled.composition.nodes.length, 17)
  assert.deepEqual(compiled.interpretations.map(reading => reading.expected.lots.filter(lot => lot.owner === 'root/child1').reduce((sum, lot) => sum + lot.boughtQuantity, 0)), [2, 4])
  for (const reading of compiled.interpretations) {
    assert.equal(reading.compiled.composition.nodes.length, 17)
    assert.equal(reading.compiled.text, compiled.compiled.text)
    assert.deepEqual(reading.root.slots.child2, nested.tasks[0].root.slots.child2)
  }
  await writeFile(resolve(out, 'nested-compiled.json'), JSON.stringify(compiled, null, 2) + '\n')
  results.push('Actual recursive LEAN fields select one of12atoms and derive explicit quantity2/4 readings, retaining all17nodes, other branches and exact compiled task text; no native execution or approval is inferred')

  await f('prepare-information-fields').click(); await settled('Information fields prepared')
  const retained = await f('information-fields').inputValue()
  await f('information-fields-editor').screenshot({ path: resolve(out, 'information-fields-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await f('information-fields-editor').screenshot({ path: resolve(out, 'information-fields-mobile.png') })
  assert.equal(await f('information-fields').inputValue(), retained)
  assert.deepEqual(errors, []); assert.equal(externalRequests, 0)
  results.push('Desktop and390px field layouts preserve the exact retained draft with no horizontal page overflow, browser error or external request')
  await writeFile(resolve(out, 'qualification.json'), JSON.stringify({ results, projectSha256: project.sha256, pins, parity,
    cliVerify: 1, cliAnalyze: 1, recordedTrials: 2, workflowStages: 0, externalRequests, nativeRuns: 0, providerCalls: 0 }, null, 2) + '\n')
} catch (error) {
  if (page) {
    await page.screenshot({ path: resolve(out, 'failure.png'), fullPage: true }).catch(() => {})
    await writeFile(resolve(out, 'failure.json'), JSON.stringify({ error: error.stack, status: await page.locator('[data-bench-status]').textContent().catch(() => null) }, null, 2))
  }
  throw error
} finally {
  await writeFile(resolve(out, 'results.json'), JSON.stringify({ results, errors, externalRequests }, null, 2) + '\n')
  await browser.close()
}
