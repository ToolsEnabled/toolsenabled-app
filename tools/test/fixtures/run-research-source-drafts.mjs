import { openResearchProject } from './research-project-picker.mjs'
// Actual UI source-derivative journey; reuse accepted runtime-bound evidence.
// No native, provider, module or candidate runs. Standard CLI verification only.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { RUNTIME_FILES } from '../../../src/benchmark/study.mjs'
import { sha256 } from '../../../src/benchmark/prompts.mjs'
assert.ok(process.env.MC_PLAYWRIGHT_ROOT)
assert.ok(process.env.BENCHMARK_SOURCE_DRAFT_BASELINE, 'Supply the accepted family-browser artifact directory explicitly.')
const { chromium } = createRequire(import.meta.url)(process.env.MC_PLAYWRIGHT_ROOT)
const origin = process.env.BENCHMARK_TEST_ORIGIN || 'http://127.0.0.1:4711'
const out = resolve(process.env.BENCHMARK_TEST_OUTPUT || 'source-draft-browser-evidence')
const baseline = resolve(process.env.BENCHMARK_SOURCE_DRAFT_BASELINE)
await mkdir(out, { recursive: true })
const project = JSON.parse(await readFile(resolve(baseline, 'exported-project/project.json')))
const evidence = JSON.parse(await readFile(resolve(baseline, 'cli-results/evidence.json')))
const rawFamily = await readFile(resolve(baseline, 'filled-workspace.json'), 'utf8')
const workspace = JSON.parse(rawFamily), rawSingle = JSON.stringify({ ...workspace.families[0].fields, rationale: 'Archived unfinished single-family text\n' }, null, 4)
const files = Object.fromEntries(await Promise.all(project.spec.inputs.map(async row => {
  const text = await readFile(resolve(baseline, 'exported-project', row.path), 'utf8')
  assert.equal(await sha256(text), row.sha256, row.path); return [row.path, text]
})))
const runtimeMatches = []
for (const name of RUNTIME_FILES) {
  const digest = await sha256(await readFile(new URL('../../../src/benchmark/' + name, import.meta.url)))
  assert.equal(digest, project.spec.runtimeSources[name], name)
  assert.equal(digest, await sha256(await readFile(resolve(baseline, 'exported-project', name))), name)
  runtimeMatches.push({ name, sha256: digest })
}
assert.equal(evidence.projectSha256, project.sha256)
const original = { version: 1, spec: project.spec, attachments: files, pending: [], taskIndex: 3, bundleIndex: 0,
  editors: { 'data-bench-composition-family-fields': rawFamily, 'data-bench-composition-fields': rawSingle } }
const results = [], errors = [], parity = [], browser = await chromium.launch({ headless: true })
let page
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true })
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(origin + '/tools/test/fixtures/research-workflow.html?mode=available'); await page.waitForFunction(() => window.auditReady)
  await openResearchProject(page, { account: true }); await page.locator('[data-project-select]').selectOption('rp-' + 'a'.repeat(36))
  const f = name => page.locator('[data-bench-' + name + ']')
  const tab = name => page.locator('[data-bench-tab="' + name + '"]').click()
  const settled = text => page.waitForFunction(text => document.querySelector('[data-bench-status]').textContent.startsWith(text), text)
  async function imported(draft) {
    await openResearchProject(page); await f('import').setInputFiles({ name: 'draft.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(draft)) }); await settled('Draft imported')
  }
  async function download(action, name) {
    const wait = page.waitForEvent('download'); await f(action).click(); const result = await wait
    const path = resolve(out, name); await result.saveAs(path); return { path, name: result.suggestedFilename() }
  }
  async function jsonDownload(action, name) { return JSON.parse(await readFile((await download(action, name)).path)) }
  async function unpack(action, name) {
    const file = await download(action, name + '.zip'), directory = resolve(out, name)
    const child = spawnSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; z.extractall(sys.argv[2])', file.path, directory], { encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr); return directory
  }
  await imported(original); await tab('run'); await f('freeze').click()
  await page.waitForFunction(() => !document.querySelector('[data-bench-export]').disabled)
  await f('import-evidence').setInputFiles(resolve(baseline, 'cli-results/evidence.json')); await settled('Evidence imported')
  const before = await jsonDownload('draft-export', 'before-draft.json')
  const beforeEvidence = await jsonDownload('export-evidence', 'before-evidence.json')
  assert.deepEqual(beforeEvidence, evidence)
  const beforeFrozen = await f('frozen').textContent(), beforeResults = await f('results').textContent()
  await tab('corpus')
  await f('apply-composition-fields').click(); await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.includes('source task is unavailable'))
  const sourceDownload = await download('export-family-sources', 'editable-family-sources.json')
  await settled('Editable family source draft exported')
  assert.equal(sourceDownload.name, project.spec.id + '-family-sources-draft.json')
  const derivative = JSON.parse(await readFile(sourceDownload.path))
  assert.deepEqual(derivative.spec.tasks, workspace.families.map(row => row.sourceTask))
  assert.equal(derivative.editors['data-bench-composition-family-fields'], rawFamily)
  assert.equal(derivative.editors['data-bench-composition-fields'], rawSingle)
  assert.deepEqual(Object.keys(derivative.editors).sort(), ['data-bench-composition-family-fields', 'data-bench-composition-fields'])
  assert.deepEqual(derivative.pending, ['compositionFamilies']); assert.equal(derivative.taskIndex, 0)
  assert.equal(derivative.spec.corpusPlan, undefined)
  assert.deepEqual(derivative.spec.corpusHistory.at(-1), { kind: 'detached-recipe', recipe: project.spec.corpusPlan })
  assert.deepEqual(await jsonDownload('draft-export', 'after-draft.json'), before)
  assert.equal(await f('frozen').textContent(), beforeFrozen); assert.equal(await f('results').textContent(), beforeResults)
  await tab('run'); assert.deepEqual(await jsonDownload('export-evidence', 'after-evidence.json'), beforeEvidence)
  const report = await unpack('export-report', 'preserved-gui-report')
  async function compare(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) await compare(path)
      else {
        const name = relative(report, path), bytes = await readFile(path), prior = await readFile(resolve(baseline, 'cli-results', name))
        assert.deepEqual(bytes, prior, name); parity.push({ name, sha256: await sha256(bytes) })
      }
    }
  }
  await compare(report)
  results.push('Explicit source download preserves current generated draft, frozen project, actual retained attempt journal and every GUI/CLI report byte; no execution repeated')
  await tab('corpus'); await f('family-workspace').screenshot({ path: resolve(out, 'source-export-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await f('family-workspace').screenshot({ path: resolve(out, 'source-export-narrow.png') })
  await page.setViewportSize({ width: 1440, height: 1100 })
  await imported(derivative); await tab('run'); await f('freeze').click(); await settled('Apply the pending editor changes before freezing: compositionFamilies')
  assert.equal(await f('export-evidence').isDisabled(), true)
  await tab('corpus'); await page.locator('[data-composition-family-fields-family]').selectOption(workspace.families[0].sourceTask.id); await settled('Family fields inspected')
  await f('apply-composition-fields').click(); await settled('Task recipe built')
  assert.deepEqual(JSON.parse(await f('corpus-plan').inputValue()), project.spec.corpusPlan)
  await f('generate-corpus').click(); await settled('4 tasks generated')
  assert.deepEqual(JSON.parse(await f('spec-json').inputValue()).tasks, project.spec.tasks)
  results.push('Separate ordinary Import restores exact live source tasks with old bindings and pending fields; unchanged compiler rebuilds the same plan and all4 scoped cases before Freeze')
  await tab('run'); await f('freeze').click(); await page.waitForFunction(() => !document.querySelector('[data-bench-export]').disabled)
  await f('import-evidence').setInputFiles([])
  await f('import-evidence').setInputFiles(resolve(baseline, 'cli-results/evidence.json'))
  await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.includes('different frozen project'))
  assert.equal(await f('export-evidence').isDisabled(), true)
  const exported = await unpack('export', 'regenerated-project'), regenerated = JSON.parse(await readFile(resolve(exported, 'project.json')))
  assert.notEqual(regenerated.sha256, project.sha256)
  for (const row of runtimeMatches) assert.equal(await sha256(await readFile(resolve(exported, row.name))), row.sha256)
  const verified = spawnSync(process.execPath, [resolve(exported, 'cli.mjs'), 'verify'], { encoding: 'utf8', timeout: 120000 })
  await writeFile(resolve(out, 'verify.stdout'), verified.stdout || ''); await writeFile(resolve(out, 'verify.stderr'), verified.stderr || '')
  assert.equal(verified.status, 0, verified.stderr)
  results.push('Regeneration retains detached recipe provenance and creates a different frozen identity; old attempt evidence is refused, new portable project passes normal CLIverify with unchanged runtime pins')
  assert.deepEqual(errors, [])
  await writeFile(resolve(out, 'qualification.json'), JSON.stringify({ results, baseline, baselineProjectSha256: project.sha256,
    regeneratedProjectSha256: regenerated.sha256, runtimeMatches, parity, nativeRuns: 0, providerCalls: 0, localModuleCalls: 0,
    retainedPriorModuleCalls: 8, freshCliVerify: 1 }, null, 2))
} catch (error) {
  if (page) { await page.screenshot({ path: resolve(out, 'failure.png'), fullPage: true }).catch(() => {}); await writeFile(resolve(out, 'failure.json'), JSON.stringify({ error: error.stack, status: await page.locator('[data-bench-status]').textContent().catch(() => null) }, null, 2)) }
  throw error
} finally { await writeFile(resolve(out, 'results.json'), JSON.stringify({ results, errors }, null, 2)); await browser.close() }
