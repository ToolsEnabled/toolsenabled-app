import { openResearchProject } from './research-project-picker.mjs'
// Actual browser authoring, canonical saved responses and portable parity.
// Synthetic review records only; no investigator approval or provider/native run.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { informationContextFixture, contextReviewer } from './research-benchmark-information-context.mjs'
import { RUNTIME_FILES } from '../../../src/benchmark/study.mjs'
import { sha256 } from '../../../src/benchmark/prompts.mjs'

const { chromium } = createRequire(import.meta.url)(process.env.MC_PLAYWRIGHT_ROOT)
const origin = process.env.BENCHMARK_TEST_ORIGIN || 'http://127.0.0.1:4728'
const out = resolve(process.env.BENCHMARK_TEST_OUTPUT || 'information-context-browser-evidence')
await mkdir(out, { recursive: true })
const initial = await informationContextFixture(); delete initial.taskReviews
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
  const tab = name => page.locator('[data-bench-tab="' + name + '"]').click()
  const settled = text => page.waitForFunction(text => document.querySelector('[data-bench-status]').textContent.startsWith(text), text)
  const current = approved => page.waitForFunction(approved => {
    const text = document.querySelector('[data-bench-information-review-status]').textContent
    return approved ? text.includes('has a current review') : text.includes('no current review')
  }, approved)
  const packet = async () => JSON.parse(await f('information-packet').textContent())
  async function download(action, name) {
    const wait = page.waitForEvent('download'); await f(action).click()
    const item = await wait, path = resolve(out, name); await item.saveAs(path); return path
  }
  const draft = async name => JSON.parse(await readFile(await download('draft-export', name)))
  async function importDraft(spec) {
    await openResearchProject(page); await f('import').setInputFiles({ name: 'source.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ spec })) })
    await settled('Draft imported'); await tab('compose')
  }
  async function approve() {
    await tab('compose'); await f('information-details').evaluate(node => { node.open = true })
    await f('prepare-information').click(); await settled('Current prompt, readings')
    await f('information-reviewer').fill(contextReviewer)
    await f('approve-information').click(); await settled('Your review is bound'); await current(true)
  }
  const workflowDraft = spec => ({ plan: spec.workflowPlan, assignments: Object.fromEntries(spec.conditions.map(condition => [condition.id, condition.workflowId])) })
  async function applyWorkflow(value) {
    await tab('workflow')
    await f('workflow-config').fill(JSON.stringify(value, null, 2))
    await f('apply-workflow').click(); await settled('Workflow applied')
  }
  await importDraft(initial); await current(false); await approve()
  const baselinePacket = await packet()
  assert.equal(baselinePacket.version, 2)
  assert.deepEqual(baselinePacket.collectionContext.workflowPlan, initial.workflowPlan)
  await tab('run'); await f('freeze').click(); await settled('Project frozen')
  const frozenBefore = await draft('baseline-reviewed-draft.json')
  const edit = workflowDraft(initial)
  edit.plan = structuredClone(edit.plan)
  edit.plan.workflows[1].stages[0].includeTaskPrompt = false
  edit.plan.workflows[1].stages[0].instructions.system = 'The required number is 2. Only 2 satisfies this task.'
  await applyWorkflow(edit); await current(false)
  const changedPacket = await packet()
  assert.notEqual(changedPacket.sha256, baselinePacket.sha256)
  assert.equal(changedPacket.prompt, baselinePacket.prompt)
  assert.deepEqual(changedPacket.readings, baselinePacket.readings)
  await tab('run'); await f('freeze').click(); await settled('number-task: review the current visible prompt')
  assert.equal(await f('export').isDisabled(), true)
  await writeFile(resolve(out, 'changed-context-freeze-refusal.txt'), await f('status').textContent())
  const refused = await draft('stale-review-refused.json')
  assert.deepEqual(refused.spec.taskReviews, frozenBefore.spec.taskReviews)
  await applyWorkflow(workflowDraft(initial)); await current(true)
  assert.equal((await packet()).sha256, baselinePacket.sha256)
  results.push('Actual workflow disclosure edit refreshes review status and refuses Freeze; exact restored declarations restore only the matching synthetic review')

  const swapped = workflowDraft(initial)
  ;[swapped.assignments.control, swapped.assignments.treatment] = [swapped.assignments.treatment, swapped.assignments.control]
  await applyWorkflow(swapped); await current(false)
  assert.notEqual((await packet()).sha256, baselinePacket.sha256)
  await tab('run'); await f('freeze').click(); await settled('number-task: review the current visible prompt')
  await applyWorkflow(workflowDraft(initial)); await current(true)
  results.push('Swapping the two condition workflow assignments invalidates the task review despite unchanged task text and workflow definitions')

  await tab('run'); await f('freeze').click(); await settled('Project frozen')
  const zip = await download('export', 'project.zip'), exported = resolve(out, 'exported-project')
  await unpack(zip, exported)
  const project = JSON.parse(await readFile(resolve(exported, 'project.json')))
  assert.equal(project.spec.requireReview, true)
  assert.equal(project.spec.executionPlan.purpose, 'apparatus-development')
  assert.deepEqual(JSON.parse(await readFile(resolve(exported, 'information/number-task.json'))), baselinePacket)
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
  const evidence = JSON.parse(await readFile(await download('export-evidence', 'evidence.json')))
  assert.equal(evidence.summary.completed, 2)
  assert.equal(evidence.events.filter(row => row.type === 'workflow-started').length, 4)
  const reportZip = await download('export-report', 'report.zip'), reportRoot = resolve(out, 'gui-report')
  await unpack(reportZip, reportRoot)
  await mkdir(resolve(exported, 'results'))
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
  assert.ok(parity.some(row => row.file === 'tables/information-contexts.csv'))
  assert.match(await readFile(resolve(reportRoot, 'report.md'), 'utf8'), /exact compiled task text/)
  results.push('Actual ZIP preserves version2 packet and45runtime pins; canonical GUI replay completes2trials4stages, and every exported report file exactly matches CLI analysis of the same journal')

  const ordinary = await informationContextFixture({ workflow: false }); delete ordinary.taskReviews
  await importDraft(ordinary); await approve()
  const ordinaryPacket = await packet()
  assert.equal(ordinaryPacket.collectionContext.ordinaryCollectionIncluded, false)
  await tab('protocol')
  const conditions = structuredClone(ordinary.conditions)
  conditions[1].model.id = 'different-requested-system'
  conditions[1].model.settings = { temperature: 0.8, enabled: true, optional: null, label: 0 }
  await f('conditions').fill(JSON.stringify(conditions, null, 2))
  await f('apply-protocol').click(); await settled('Protocol applied'); await current(false)
  assert.notEqual((await packet()).sha256, ordinaryPacket.sha256)
  await tab('run'); await f('freeze').click(); await settled('number-task: review the current visible prompt')
  await tab('compose'); await f('information-details').evaluate(node => { node.open = true })
  await f('information-details').screenshot({ path: resolve(out, 'context-review.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  results.push('Without accounting, edited model identity and typed settings still invalidate the review through ordinary fields; packet and guidance stay within the390px viewport')
  assert.deepEqual(errors, []); assert.equal(externalRequests, 0)
  await writeFile(resolve(out, 'qualification.json'), JSON.stringify({ results, projectSha256: project.sha256, pins, parity,
    cliVerify: 1, cliAnalyze: 1, recordedTrials: 2, workflowStages: 4, externalRequests, nativeRuns: 0, providerCalls: 0 }, null, 2) + '\n')
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
