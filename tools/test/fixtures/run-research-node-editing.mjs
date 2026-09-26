import { openResearchProject } from './research-project-picker.mjs'
// Real nested authoring and portable artifact controls, without collection.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { operationalStarter } from '../../../src/benchmark/trading-catalog.mjs'
import { newExperimentDraft } from '../../../src/benchmark/starters.mjs'
import { compileTask, deriveTaskExpected } from '../../../src/benchmark/tasks.mjs'
import { canonical, sha256 } from '../../../src/benchmark/prompts.mjs'
import { RUNTIME_FILES } from '../../../src/benchmark/study.mjs'

const { chromium } = createRequire(import.meta.url)(process.env.MC_PLAYWRIGHT_ROOT)
const origin = process.env.BENCHMARK_TEST_ORIGIN || 'http://127.0.0.1:4728'
const out = resolve(process.env.BENCHMARK_TEST_OUTPUT || 'node-editing-browser-evidence')
await mkdir(out, { recursive: true })
const initial = newExperimentDraft(await operationalStarter(), { initializePopulation: true })
initial.id = 'nested-node-edit-control'
initial.tasks[0].root.slots.child1.slots.buy_process.params = { quantity: 2 }
initial.tasks[0].root.slots.child2.slots.child1.slots.buy_process.params = { quantity: 3 }
initial.tasks[0].expected = await deriveTaskExpected(initial, initial.tasks[0])
const nodeCount = async spec => (await compileTask(spec, spec.tasks[0], { requireReview: false, requireTaskReview: false, validateExpected: false })).compiled.composition.nodes.length
assert.equal(await nodeCount(initial), 17)
const browser = await chromium.launch({ headless: true }), results = [], errors = [], pins = []
let page, externalRequests = 0
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
  const c = name => page.locator('[data-composition-fields-' + name + ']')
  const rootBundle = page.locator('[data-node-use=""]'), rootMode = page.locator('[data-node-replacement-mode=""]')
  const tab = name => page.locator('[data-bench-tab="' + name + '"]').click()
  const settled = text => page.waitForFunction(text => document.querySelector('[data-bench-status]').textContent.startsWith(text), text)
  async function download(action, name) {
    const wait = page.waitForEvent('download'); await f(action).click()
    const item = await wait, path = resolve(out, name); await item.saveAs(path); return path
  }
  const draft = async name => JSON.parse(await readFile(await download('draft-export', name)))
  async function importDraft(data) {
    await openResearchProject(page); await f('import').setInputFiles({ name: 'source.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) })
    await settled('Draft imported'); await tab('compose')
  }
  await importDraft({ spec: initial })
  await rootBundle.selectOption('op-sequence-2'); await settled('Bundle changed')
  const edited = await draft('operator-edited.json')
  assert.deepEqual(edited.spec.tasks[0].root.slots, initial.tasks[0].root.slots)
  assert.equal(edited.spec.tasks[0].root.use, 'op-sequence-2')
  assert.equal(await nodeCount(edited.spec), 17)
  assert.deepEqual(edited.spec.tasks[0].expected, initial.tasks[0].expected)
  assert.equal(await rootMode.inputValue(), 'preserve')
  results.push('Operator-only ALL-to-SEQUENCE edit preserves both exact nested branches,17nodes and quantities2/3; it does not replace the old expected observation')

  await rootBundle.selectOption('op-all-3'); await settled('Bundle changed')
  const expanded = await draft('new-child-unfilled.json')
  assert.deepEqual(expanded.spec.tasks[0].root.slots.child3, { use: '' })
  assert.deepEqual(expanded.spec.tasks[0].root.slots.child1, initial.tasks[0].root.slots.child1)
  await page.waitForFunction(() => document.querySelector('[data-bench-preview-meta]').textContent === 'Composition needs attention.')
  await rootBundle.selectOption('op-all-2'); await settled('This bundle would remove')
  assert.deepEqual(await draft('loss-refused.json'), expanded)
  assert.equal(await rootBundle.inputValue(), 'op-all-3')
  await rootMode.selectOption('replace')
  assert.deepEqual(await draft('replacement-mode-only.json'), expanded)
  await rootBundle.selectOption('op-all-2'); await settled('Branch replaced')
  const replaced = await draft('explicit-whole-branch.json')
  assert.equal(await nodeCount(replaced.spec), 11)
  assert.equal(replaced.spec.tasks[0].root.slots.child1.slots.buy_process.params.quantity, 4)
  assert.equal(await rootMode.inputValue(), 'preserve')
  await f('undo').click(); await settled('Previous draft restored')
  assert.deepEqual((await draft('undo-whole-branch.json')).spec, expanded.spec)
  results.push('New child slots stay explicitly unfilled; destructive arity reduction refuses atomically until whole-branch replacement is chosen, then defaults and exact Undo are visible')

  await importDraft(edited)
  await f('derive-expected').click(); await settled('Draft expected observation derived')
  await tab('corpus'); await f('prepare-composition-fields').click(); await settled('Occurrence fields prepared')
  assert.equal(JSON.parse(await f('composition-fields').inputValue()).occurrences.length, 17)
  await c('family').fill('operator-preserved-family')
  await c('rationale').fill('Synthetic control: preserve the investigator-authored nested tree while editing its parent operator.')
  await c('expected-rationale').fill('Derived local semantic apparatus observation; this is not independent qualification or a scientific result.')
  await f('apply-composition-fields').click(); await settled('Task recipe built')
  await f('generate-corpus').click(); await settled('1 tasks generated')
  const generated = await draft('generated-preserved-tree.json')
  assert.deepEqual(generated.spec.tasks[0].root.slots, initial.tasks[0].root.slots)
  assert.equal(await nodeCount(generated.spec), 17)
  await tab('run'); await f('freeze').click()
  await page.waitForFunction(() => /review/i.test(document.querySelector('[data-bench-status]').textContent))
  assert.equal(await f('export').isDisabled(), true)
  await writeFile(resolve(out, 'unapproved-freeze-refusal.txt'), await f('status').textContent())
  // Synthetic review records belong only to this disposable apparatus control.
  // The real review gate remains enabled; these are not investigator approvals.
  const reviewSource = await draft('before-synthetic-reviews.json')
  const reviewTask = await compileTask(reviewSource.spec, reviewSource.spec.tasks[0], { requireReview: false, requireTaskReview: false, validateExpected: false })
  const reviewIds = [], seenReviews = new Set()
  function dependenciesFirst(id) {
    if (seenReviews.has(id)) return
    seenReviews.add(id)
    for (const dependency of reviewSource.spec.catalog.find(row => row.id === id).dependencies || []) dependenciesFirst(dependency)
    reviewIds.push(id)
  }
  for (const bundle of reviewTask.compiled.bundles) dependenciesFirst(bundle.id)
  await tab('library')
  for (const id of reviewIds) {
    await f('bundle').selectOption(String(reviewSource.spec.catalog.findIndex(row => row.id === id)))
    await f('reviewer').fill('Synthetic node editing regression fixture; not investigator approval')
    await f('approve').click()
    await page.waitForFunction(() => document.querySelector('[data-mc="benchmark"]').getAttribute('aria-busy') === 'false')
    assert.match(await f('status').textContent(), /^Your review was recorded/)
  }
  await writeFile(resolve(out, 'synthetic-review-scope.json'), JSON.stringify({ scope: 'Disposable apparatus regression records only; no personal or scientific approval', bundleIds: reviewIds }, null, 2))
  await tab('run'); await f('execution-purpose').selectOption('apparatus-development')
  await f('apply-execution').click(); await settled('Version 2 execution design applied')
  await f('freeze').click(); await settled('Project frozen')
  const zip = await download('export', 'project.zip'), exported = resolve(out, 'exported-project')
  const unpack = spawnSync('python3', ['-c', 'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;z.extractall(sys.argv[2])', zip, exported], { encoding: 'utf8' })
  assert.equal(unpack.status, 0, unpack.stderr)
  const project = JSON.parse(await readFile(resolve(exported, 'project.json')))
  assert.equal(project.spec.executionPlan.purpose, 'apparatus-development')
  assert.equal(project.spec.requireReview, true)
  assert.equal(project.tasks[0].compiled.composition.nodes.length, 17)
  assert.deepEqual(project.spec.tasks[0].root.slots, initial.tasks[0].root.slots)
  const task = project.tasks[0]
  assert.deepEqual(JSON.parse(await readFile(resolve(exported, 'composition/' + task.id + '.json'))), task.compiled.composition)
  assert.equal(await readFile(resolve(exported, 'prompts/' + task.id + '.txt'), 'utf8'), task.compiled.text + '\n')
  for (const name of RUNTIME_FILES) {
    const digest = await sha256(await readFile(new URL('../../../src/benchmark/' + name, import.meta.url)))
    assert.equal(project.spec.runtimeSources[name], digest)
    assert.equal(await sha256(await readFile(resolve(exported, name))), digest)
    pins.push({ name, sha256: digest })
  }
  const verify = spawnSync(process.execPath, [resolve(exported, 'cli.mjs'), 'verify'], { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 })
  await writeFile(resolve(out, 'verify.stdout'), verify.stdout || '')
  await writeFile(resolve(out, 'verify.stderr'), verify.stderr || '')
  assert.equal(verify.status, 0, verify.stderr)
  results.push('Preserved17node tree propagates through ordinary occurrence fields and corpus to exact portable composition/prompt artifacts and45verifiedruntime pins; personal review refusal is observed before explicit apparatus-only fixture export')

  await tab('compose')
  const beforeRefusal = await draft('frozen-before-loss-refusal.json'), frozenText = await f('frozen').textContent()
  await rootBundle.selectOption('op-strategy'); await settled('This bundle would remove')
  assert.deepEqual(await draft('frozen-after-loss-refusal.json'), beforeRefusal)
  assert.equal(await f('frozen').textContent(), frozenText)
  assert.equal(await f('export').isDisabled(), false)
  await f('tree').screenshot({ path: resolve(out, 'nested-tree-preserved.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  results.push('A refused lossy bundle change preserves the complete frozen artifact even through real browser input/change events; nested controls remain within the390px viewport')
  assert.deepEqual(errors, []); assert.equal(externalRequests, 0)
  await writeFile(resolve(out, 'qualification.json'), JSON.stringify({ results, projectSha256: project.sha256, pins,
    compiledNodes: 17, explicitReplacementNodes: 11, cliVerify: 1, externalRequests,
    nativeRuns: 0, providerCalls: 0, recordedTrials: 0, localModuleCalls: 0 }, null, 2) + '\n')
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
