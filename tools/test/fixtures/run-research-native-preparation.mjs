import { openResearchProject } from './research-project-picker.mjs'
// Actual-page source-only native preparation authoring and portable exports.
// No run/qualify command, native engine, provider or candidate is executed.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { canonical, sha256 } from '../../../src/benchmark/prompts.mjs'
import { RUNTIME_FILES, freezeStudy, safePath } from '../../../src/benchmark/study.mjs'
import { materializeNativeControl, verifyNativeControl } from '../../../src/benchmark/audit.mjs'
import { projectFiles } from '../../../src/benchmark/export.mjs'

const { chromium } = createRequire(import.meta.url)(process.env.MC_PLAYWRIGHT_ROOT)
const origin = process.env.BENCHMARK_TEST_ORIGIN || 'http://127.0.0.1:4728', out = resolve(process.env.BENCHMARK_TEST_OUTPUT)
const retained = JSON.parse(await readFile(process.env.BENCHMARK_TEST_FIXTURE)), sourceDraft = structuredClone(retained.draft)
delete sourceDraft.spec.nativePreparationPlan
const imported = { spec: sourceDraft.spec, attachments: sourceDraft.attachments }
const sources = Object.fromEntries(await Promise.all(RUNTIME_FILES.map(async name => [name, await readFile(new URL('../../../src/benchmark/' + name, import.meta.url), 'utf8')])))
const recipe = { version: 1, coverage: 'all-selected-readings-occurrences-and-probes', rationale: 'Explicit synthetic native controls for five registered composition occurrences.',
  referenceReplicates: 3, mutantReplicates: 1, budgets: { maxNativeExecutions: 100, executionTimeoutMs: 120000, attemptTimeoutMs: 150000, maxDurationMs: 3600000 } }
const fields = { rationale: recipe.rationale, 'reference-replicates': '3', 'mutant-replicates': '1', 'max-executions': '100', 'execution-timeout': '120000', 'attempt-timeout': '150000', duration: '3600000' }
const checks = [], errors = [], commands = [], exportedControls = [], parity = [], pins = []
let page, outside = 0
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true })
async function save(name, value) { const path = resolve(out, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n') }
async function unpack(path, directory, expected = null) {
  const bytes = await readFile(path), decoded = {}, seen = new Set(); let offset = 0
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0, 'The generated ZIP retains stored files.')
    const size = bytes.readUInt32LE(offset + 18), length = bytes.readUInt16LE(offset + 26), extra = bytes.readUInt16LE(offset + 28)
    const name = bytes.subarray(offset + 30, offset + 30 + length).toString('utf8'), start = offset + 30 + length + extra
    assert.ok(safePath(name) && !seen.has(name.toLowerCase()) && start + size <= bytes.length); seen.add(name.toLowerCase())
    const data = bytes.subarray(start, start + size); decoded[name] = data
    const target = resolve(directory, name); await mkdir(dirname(target), { recursive: true }); await writeFile(target, data, { flag: 'wx' })
    offset = start + size
  }
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50, 'A central directory follows the stored payload.')
  if (expected) {
    assert.deepEqual(Object.keys(decoded).sort(), Object.keys(expected).sort())
    for (const [name, value] of Object.entries(expected)) assert.deepEqual(decoded[name], Buffer.from(value), name)
  }
  return decoded
}
async function cli(directory, command, expectedProject) {
  assert.ok(['verify', 'readiness', 'analyze'].includes(command), 'No native or collection command is permitted.')
  const result = spawnSync(process.execPath, [resolve(directory, 'cli.mjs'), command], { encoding: 'utf8', timeout: 30000 })
  const name = directory.split('/').at(-1) + '-' + command
  await save(name + '.stdout', result.stdout || ''); await save(name + '.stderr', result.stderr || '')
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  if (command !== 'analyze') {
    assert.equal(output.projectSha256, expectedProject.sha256)
    assert.ok(output.readiness.collect.blockers.some(row => row.code === 'native-admission-unavailable'))
  }
  commands.push({ directory, command, status: result.status, stdoutSha256: await sha256(result.stdout) })
  return output
}
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true })
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', async route => { if (new URL(route.request().url()).origin !== origin) { outside++; await route.abort() } else await route.continue() })
  await page.goto(origin + '/tools/test/fixtures/research-workflow.html?mode=available'); await page.waitForFunction(() => window.auditReady)
  await openResearchProject(page, { account: true }); await page.locator('[data-project-select]').selectOption('rp-' + 'a'.repeat(36))
  const f = name => page.locator('[data-bench-' + name + ']')
  const idle = () => page.waitForFunction(() => document.querySelector('[data-mc="benchmark"]').getAttribute('aria-busy') === 'false')
  const settled = async text => { await page.waitForFunction(text => document.querySelector('[data-bench-status]').textContent.startsWith(text), text); await idle() }
  const tab = name => page.locator('[data-bench-tab="' + name + '"]').click()
  const upload = (name, value) => f(name).setInputFiles({ name: 'synthetic-native-controls.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) })
  async function download(action, name) {
    const waiting = page.waitForEvent('download'); await f(action).click(); const item = await waiting, path = resolve(out, name); await item.saveAs(path); await idle(); return path
  }
  const draft = async name => JSON.parse(await readFile(await download('draft-export', name)))
  await upload('import', imported); await settled('Draft imported'); await tab('protocol')
  await page.getByText('Native preparation controls', { exact: true }).click()
  assert.deepEqual(await f('native-preparation-mode').locator('option').evaluateAll(nodes => nodes.map(node => node.value)), ['none', 'planned'])
  assert.equal(await f('native-preparation-mode').inputValue(), 'none')
  await f('native-preparation-mode').selectOption('planned')
  for (const [name, value] of Object.entries(fields)) await f('native-preparation-' + name).fill(value)
  await f('apply-native-preparation').click(); await settled('Native control plan applied')
  const applied = await draft('applied-draft.json')
  assert.deepEqual(applied.spec.nativePreparationPlan, recipe); assert.deepEqual(applied.spec.reviews, imported.spec.reviews)
  const plan = JSON.parse(await f('native-preparation-plan').textContent())
  assert.deepEqual(plan.counts, { jobs: 6, referenceJobs: 1, mutantJobs: 5, nativeExecutions: 8, coverageRows: 10 })
  assert.equal(plan.executionStatus, 'not-run'); assert.equal(plan.coverageStatus, 'complete')
  await f('prepare-native-preparation').click(); await settled('Native control roster previewed')
  assert.deepEqual(await draft('after-preview.json'), applied)
  await f('native-preparation-mode').scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(out, 'native-fields.png') })
  checks.push('Actual ordinary fields select planned mode, apply the exact recipe and preview all10coverage rows/6physicaljobs/8plannedexecutions without changing reviews or running controls')

  await f('native-preparation-execution-timeout').fill('12e')
  const invalid = await draft('invalid-before.json')
  await f('apply-native-preparation').click(); await settled('Native execution timeout needs a complete nonnegative integer')
  assert.equal(await f('native-preparation-execution-timeout').inputValue(), '12e')
  assert.deepEqual(await draft('invalid-after.json'), invalid)
  assert.deepEqual(invalid.spec.nativePreparationPlan, recipe)
  await f('native-preparation-execution-timeout').fill('120000'); await f('apply-native-preparation').click(); await settled('Native control plan applied')
  checks.push('An unfinished numeric field refuses atomically, preserves its raw text and retains the preceding applied plan')

  await tab('run'); await f('freeze').click(); await settled('Project frozen')
  assert.equal(await f('run').isDisabled(), true); assert.equal(await f('native-control-job').inputValue(), '')
  assert.match(await f('readiness').textContent(), /Native candidate collection remains blocked/)
  const parent = await freezeStudy(applied.spec), parentDir = resolve(out, 'parent-project')
  const parentFiles = await unpack(await download('export', 'parent.zip'), parentDir, await projectFiles(parent, sources, imported.attachments))
  assert.deepEqual(JSON.parse(parentFiles['project.json']), parent)
  assert.deepEqual(JSON.parse(parentFiles['native-preparation/plan.json']), parent.nativePreparation)
  for (const name of RUNTIME_FILES) { const hash = await sha256(sources[name]); assert.equal(parent.spec.runtimeSources[name], hash); assert.equal(await sha256(parentFiles[name]), hash); pins.push({ name, sha256: hash }) }
  for (const kind of ['reference', 'mutant']) {
    const job = parent.nativePreparation.jobs.find(row => row.kind === kind && (kind === 'reference' || row.source.wrongReadingId === 'other-asset'))
    assert.ok(job); await f('native-control-job').selectOption(job.id); await idle()
    const control = await materializeNativeControl(parent, job.id, { runtimeFiles: sources, inputFiles: imported.attachments })
    await verifyNativeControl({ parentProject: parent, control }, { runtimeFiles: sources, inputFiles: imported.attachments })
    const controlInputs = { ...imported.attachments, 'native-control/binding.json': canonical(control.binding) + '\n' }
    const directory = resolve(out, kind + '-project'), payload = await unpack(await download('export-native-control', kind + '.zip'), directory, await projectFiles(control.controlProject, sources, controlInputs))
    const child = JSON.parse(payload['project.json'])
    assert.deepEqual(child, control.controlProject); assert.equal(payload['native-control/binding.json'].toString(), canonical(control.binding) + '\n')
    assert.equal(child.spec.inputs.find(row => row.path === 'native-control/binding.json').sha256, await sha256(payload['native-control/binding.json']))
    assert.equal(child.spec.executionPlan.purpose, 'apparatus-development'); assert.equal(child.spec.analysisPlan.primaryDenominator, 'scheduled')
    assert.equal(child.schedule.length, kind === 'reference' ? 3 : 1)
    assert.deepEqual(child.tasks[0].expected, control.binding.programExpected)
    if (kind === 'mutant') { assert.equal(child.tasks[0].root.params.asset, 'QQQ'); assert.notDeepEqual(child.tasks[0].expected, control.binding.referenceExpected) }
    for (const name of RUNTIME_FILES) assert.equal(await sha256(payload[name]), parent.spec.runtimeSources[name])
    await save(kind + '-control-envelope.json', control)
    const verified = await cli(directory, 'verify', child), readiness = await cli(directory, 'readiness', child)
    assert.deepEqual(verified, readiness)
    exportedControls.push({ kind, jobId: job.id, projectSha256: child.sha256, envelopeSha256: control.sha256, fileCount: Object.keys(payload).length, programSha256: control.programSha256 })
  }
  await f('native-control-status').screenshot({ path: resolve(out, 'selected-control-status.png') })
  checks.push('Actual reference and asset-mutant ZIPs match shared materialization byte-for-byte, including45runtimepins/binding/generatedcode; portable verify/readiness retain native admission refusal and program-own oracle')

  await upload('import-evidence', { projectSha256: parent.sha256, events: [] }); await settled('Evidence imported')
  const empty = JSON.parse(await readFile(await download('export-evidence', 'empty-evidence.json')))
  assert.deepEqual(empty.events, []); assert.equal(empty.summary.completed, 0); assert.equal(empty.summary.selectedInputPreparation.qualified, 0)
  const reportDir = resolve(out, 'gui-empty-report'); await unpack(await download('export-report', 'empty-report.zip'), reportDir)
  await mkdir(resolve(parentDir, 'results')); await writeFile(resolve(parentDir, 'results/attempts.jsonl'), '')
  await cli(parentDir, 'verify', parent); await cli(parentDir, 'readiness', parent); await cli(parentDir, 'analyze', parent)
  async function compare(directory = '') {
    for (const entry of await readdir(resolve(reportDir, directory), { withFileTypes: true })) {
      const path = directory ? directory + '/' + entry.name : entry.name
      if (entry.isDirectory()) await compare(path)
      else { const bytes = await readFile(resolve(reportDir, path)); assert.deepEqual(await readFile(resolve(parentDir, 'results', path)), bytes); parity.push({ path, bytes: bytes.length, sha256: await sha256(bytes) }) }
    }
  }
  await compare(); await f('results').screenshot({ path: resolve(out, 'zero-collection-report.png') })
  checks.push('Parent empty-journal GUI and CLI reports match every file with0completedtrials/0acceptedpreparations and no collection or replacement campaign')

  await openResearchProject(page, { account: true }); await page.locator('[data-project-select]').selectOption('all'); await idle()
  assert.equal(await f('native-control-job').inputValue(), ''); assert.equal(await f('export-native-control').isDisabled(), true)
  assert.equal(await f('native-preparation-plan').textContent(), '')
  await openResearchProject(page, { account: true }); await page.locator('[data-project-select]').selectOption('rp-' + 'a'.repeat(36)); await settled('Project draft restored')
  assert.equal(await f('native-control-job').inputValue(), '')
  await tab('protocol')
  if (!await f('native-preparation-mode').isVisible()) await page.getByText('Native preparation controls', { exact: true }).click()
  await f('native-preparation-mode').selectOption('none'); await f('apply-native-preparation').click(); await settled('Native control plan removed')
  const removed = await draft('removed-plan.json'); assert.equal(Object.hasOwn(removed.spec, 'nativePreparationPlan'), false)
  assert.equal(await f('native-preparation-plan').textContent(), ''); assert.equal(await f('native-control-job').inputValue(), '')
  await f('native-preparation-mode').selectOption('planned')
  for (const [name, value] of Object.entries(fields)) await f('native-preparation-' + name).fill(value)
  await f('apply-native-preparation').click(); await settled('Native control plan applied')
  await tab('run'); await f('freeze').click(); await settled('Project frozen')
  await f('native-control-job').selectOption(parent.nativePreparation.jobs[0].id)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('mc:data-source-changed')))
  await page.waitForFunction(() => document.querySelector('[data-bench-native-preparation-plan]').textContent === '' && document.querySelector('[data-bench-native-control-job]').value === '')
  await idle(); assert.equal(await f('export-native-control').isDisabled(), true)
  assert.equal(await f('native-preparation-mode').inputValue(), 'none')
  checks.push('Project navigation, explicit none mode and account-refresh reset clear prior roster/selection; controls do not leak across context or survive unsaved account reload')
  assert.deepEqual(errors, []); assert.equal(outside, 0)
  const accountWrites = await page.evaluate(() => window.audit.state.accountWrites.length)
  assert.equal(accountWrites, 0)
  await save('qualification.json', { checks, projectSha256: parent.sha256, pins, exportedControls, commands, parity,
    newCollections: 0, importedCompletedTrials: 0, semanticInterpreterProcesses: 0, nativeRuns: 0, providerCalls: 0, graderCalls: 0, externalRequests: outside, accountWrites })
} catch (error) {
  if (page) { await page.screenshot({ path: resolve(out, 'failure.png'), fullPage: true }).catch(() => {}); await save('failure.json', { error: error.stack, status: await page.locator('[data-bench-status]').textContent().catch(() => null) }) }
  throw error
} finally { await save('results.json', { checks, errors, externalRequests: outside, commands }); await browser.close() }
