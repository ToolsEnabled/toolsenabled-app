import { openResearchProject } from './research-project-picker.mjs'
// Actual browser journey. MC_PLAYWRIGHT_ROOT names the installed test kit;
// this is a renderer fixture with synthetic account/service transports.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { informationFixture as legacyInformationFixture } from './research-benchmark-information.mjs'
import { operationalRequirementFixture } from './research-benchmark-requirements.mjs'
import { requirementReportFiles } from '../../../src/benchmark/requirements.mjs'
import { workflowFixture as legacyWorkflowFixture } from './research-benchmark-workflow.mjs'
import { coverageFixture } from './research-benchmark-coverage.mjs'
import { activationFixture } from './research-benchmark-activation.mjs'
import { genericActivationFixture } from './research-benchmark-generic-activation.mjs'
import { primaryPopulationFixture as legacyPrimaryPopulationFixture } from './research-benchmark-primary-population.mjs'
import { newExperimentDraft } from '../../../src/benchmark/starters.mjs'
import { developmentStarter, developmentDraft } from './research-benchmark-development.mjs'
import { RUNTIME_FILES } from '../../../src/benchmark/study.mjs'
import { sha256 } from '../../../src/benchmark/prompts.mjs'
const genericStarter = developmentStarter
const informationFixture = () => developmentDraft(legacyInformationFixture())
const workflowFixture = () => developmentDraft(legacyWorkflowFixture())
const primaryPopulationFixture = () => developmentDraft(legacyPrimaryPopulationFixture())
const require = createRequire(import.meta.url)
assert.ok(process.env.MC_PLAYWRIGHT_ROOT, 'MC_PLAYWRIGHT_ROOT must name the authorized Playwright test kit')
const { chromium } = require(process.env.MC_PLAYWRIGHT_ROOT)
const origin = process.env.BENCHMARK_TEST_ORIGIN || 'http://127.0.0.1:4707'
const out = resolve(process.env.BENCHMARK_TEST_OUTPUT || 'benchmark-browser-evidence')
async function compareReports(first, second) {
  for (const file of await readdir(first, { withFileTypes: true })) {
    if (file.isDirectory()) await compareReports(resolve(first, file.name), resolve(second, file.name))
    else { assert.equal(await readFile(resolve(first, file.name), 'utf8'), await readFile(resolve(second, file.name), 'utf8'), file.name + ': every GUI and CLI report file must agree'); reportParity.push({ gui: resolve(first, file.name), cli: resolve(second, file.name) }) }
  }
}
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true }), errors = [], results = [], reportParity = []
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true })
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(origin + '/tools/test/fixtures/research-workflow.html?mode=available')
  await page.waitForFunction(() => window.auditReady === true)
  const field = name => page.locator(`[data-bench-${name}]`)
  const tab = name => page.locator(`[data-bench-tab="${name}"]`).click()
  const purpose = async value => { await tab('run'); await field('execution-purpose').selectOption(value); await field('apply-execution').click(); await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Version 2 execution design applied')) }
  await openResearchProject(page, { account: true }); await page.locator('[data-project-select]').selectOption('rp-' + 'a'.repeat(36))
  await page.waitForFunction(() => document.querySelector('[data-bench-scope]').textContent.startsWith('Selected project'))
  await tab('run'); await field('freeze').click(); await page.waitForFunction(() => document.querySelector('[data-bench-frozen]').textContent.includes('SHA-256'))
  assert.equal(await field('run').isDisabled(), true); assert.match(await field('readiness').textContent(), /blocked/)
  await field('readiness').screenshot({ path: resolve(out, 'unqualified-default-blocked.png') })
  results.push('Default version 2 experiment refuses an unqualified answer key; an explicit recorded diagnostic is chosen for the retained replay controls')
  await purpose('recorded-diagnostic')
  await tab('analysis'); await field('analysis-rationale').fill('Recorded-response qualification; retain every scheduled trial.')
  await field('apply-analysis').click()
  await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Analysis plan applied'))
  await field('name').fill('Browser acceptance benchmark'); await field('save').click()
  await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.includes('Draft saved'))
  await tab('run'); await field('freeze').click()
  await page.waitForFunction(() => !document.querySelector('[data-bench-run]').disabled)
  await field('run').click(); await page.waitForFunction(() => document.querySelector('[data-bench-results]').textContent.includes('2 of 2 trials completed'))
  const downloadWait = page.waitForEvent('download'); await field('export').click(); const download = await downloadWait
  const zip = resolve(out, 'browser-export.zip'); await download.saveAs(zip)
  await field('results').screenshot({ path: resolve(out, 'generic-results.png') })
  const extracted = resolve(out, 'exported-project'); await mkdir(extracted, { recursive: true })
  const unpack = spawnSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; z.extractall(sys.argv[2])', zip, extracted], { encoding: 'utf8' })
  assert.equal(unpack.status, 0, unpack.stderr)
  const cli = spawnSync(process.execPath, [resolve(extracted, 'cli.mjs'), 'run', '--output', resolve(out, 'cli-results')], { encoding: 'utf8' })
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).completed, 2)
  await field('import-evidence').setInputFiles(resolve(out, 'cli-results/evidence.json'))
  await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Evidence imported'))
  results.push('GUI ZIP extracted and executed independently; CLI evidence reimported and recomputed')
  const reportWait = page.waitForEvent('download'); await field('export-report').click(); const reportDownload = await reportWait
  const reportZip = resolve(out, 'gui-report.zip'); await reportDownload.saveAs(reportZip)
  const reportDirectory = resolve(out, 'gui-report'); await mkdir(reportDirectory, { recursive: true })
  const reportUnpack = spawnSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; z.extractall(sys.argv[2])', reportZip, reportDirectory], { encoding: 'utf8' })
  assert.equal(reportUnpack.status, 0, reportUnpack.stderr)
  await compareReports(reportDirectory, resolve(out, 'cli-results'))
  const reportPage = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
  reportPage.on('pageerror', error => errors.push(error.message))
  await reportPage.goto('file://' + resolve(reportDirectory, 'report.html'))
  assert.equal(await reportPage.locator('h1').textContent(), 'Browser acceptance benchmark')
  assert.ok(await reportPage.getByText('Passed / scheduled', { exact: true }).count())
  await reportPage.screenshot({ path: resolve(out, 'report-desktop.png'), fullPage: true })
  await reportPage.setViewportSize({ width: 390, height: 844 })
  assert.equal(await reportPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await reportPage.screenshot({ path: resolve(out, 'report-narrow.png'), fullPage: true }); await reportPage.close()
  results.push('Structured analysis plan freezes through the GUI; HTML/Markdown/SVG/CSV/analysis bytes match CLI output exactly; desktop and narrow reports render')
  await tab('observations'); await field('seed-observations').click()
  await field('apply-observations').click()
  await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Accounting plan applied'))
  await tab('protocol')
  await field('attachment-path').fill('fixtures/allocation.json')
  await field('attachment-text').fill(JSON.stringify({ purpose: 'SYNTHETIC BROWSER ALLOCATION ONLY', amount: '0.125', currency: 'USD' }))
  await field('attach').click()
  await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Attached fixtures/allocation.json'))
  const observedConditions = JSON.parse(await field('conditions').inputValue())
  observedConditions[0].model = { ...observedConditions[0].model, version: '1', surface: 'recorded-fixture' }
  observedConditions[0].collection = { comparisonUnit: 'apparatus', instructions: { system: null, developer: null }, tools: [], contextConstruction: 'One frozen synthetic answer.', sessionIsolation: 'Independent recorded fixture.' }
  observedConditions[0].adapter.mode = 'envelope'
  observedConditions[0].adapter.responses = Object.fromEntries(Object.entries(observedConditions[0].adapter.responses).map(([id, output], index) => [id, { output,
    identity: { provider: 'fixture', id: index ? 'different-recorded-model' : 'arithmetic-v1', version: '1', surface: 'recorded-fixture' },
    completion: { status: index ? 'incomplete' : 'complete', reason: index ? 'Synthetic incomplete response.' : 'Synthetic complete response.' },
    usage: index ? { inputTokens: 5 } : { inputTokens: 0, outputTokens: 0, toolCalls: 0, generationMs: 2.5, cost: { amount: '0.10', currency: 'USD' } } }]))
  await field('conditions').fill(JSON.stringify(observedConditions)); await field('apply-protocol').click(); await page.waitForFunction(() => document.querySelector('[data-mc="benchmark"]').getAttribute('aria-busy') === 'false'); assert.match(await field('status').textContent(), /^Protocol applied/)
  await tab('observations')
  const observedPlan = JSON.parse(await field('observation-plan').inputValue())
  observedPlan.rationale = 'Synthetic resource controls: distinguish missing metadata, explicit zero, mismatched identity and a declared allocation.'
  observedPlan.costEstimate = { kind: 'per-started-attempt', amount: '0.125', currency: 'USD', rationale: 'Explicit synthetic allocation, not a billed charge.', sourcePaths: ['fixtures/allocation.json'] }
  await field('observation-plan').fill(JSON.stringify(observedPlan, null, 2)); await field('apply-observations').click()
  await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Accounting plan applied'))
  await page.screenshot({ path: resolve(out, 'accounting-authoring.png'), fullPage: true })
  await tab('run'); await field('freeze').click(); await page.waitForFunction(() => !document.querySelector('[data-bench-run]').disabled)
  await field('run').click(); await page.waitForFunction(() => document.querySelector('[data-bench-results]').textContent.includes('All attempt resources'))
  const observedExportWait = page.waitForEvent('download'); await field('export').click(); const observedDownload = await observedExportWait
  const observedZip = resolve(out, 'accounting-project.zip'); await observedDownload.saveAs(observedZip)
  const observedDirectory = resolve(out, 'accounting-project'), observedOutput = resolve(out, 'accounting-results')
  const observedUnpack = spawnSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; z.extractall(sys.argv[2])', observedZip, observedDirectory], { encoding: 'utf8' })
  assert.equal(observedUnpack.status, 0, observedUnpack.stderr)
  const observedCLI = spawnSync(process.execPath, [resolve(observedDirectory, 'cli.mjs'), 'run', '--output', observedOutput], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  assert.equal(observedCLI.status, 0, observedCLI.stderr)
  const observedEvidence = JSON.parse(await readFile(resolve(observedOutput, 'evidence.json'), 'utf8')), observedSummary = observedEvidence.summary.observations
  assert.equal(observedSummary.totals.usage.inputTokens.total, '5'); assert.equal(observedSummary.totals.usage.outputTokens.observedSubtotal, '0'); assert.equal(observedSummary.totals.usage.outputTokens.total, null)
  assert.deepEqual(observedSummary.totals.identities, { match: 1, mismatch: 1 })
  assert.equal(observedSummary.totals.reportedCost.byOrigin[0].byCurrency[0].total, null)
  assert.equal(observedSummary.totals.estimatedCost.byOrigin[0].byCurrency[0].total, '0.25')
  await field('import-evidence').setInputFiles(resolve(observedOutput, 'evidence.json'))
  await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Evidence imported'))
  await field('results').screenshot({ path: resolve(out, 'accounting-results.png') })
  const observedReportWait = page.waitForEvent('download'); await field('export-report').click(); const observedReport = await observedReportWait
  const observedReportZip = resolve(out, 'accounting-report.zip'); await observedReport.saveAs(observedReportZip)
  const observedReportDirectory = resolve(out, 'accounting-report')
  const observedReportUnpack = spawnSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; z.extractall(sys.argv[2])', observedReportZip, observedReportDirectory], { encoding: 'utf8' })
  assert.equal(observedReportUnpack.status, 0, observedReportUnpack.stderr); await compareReports(observedReportDirectory, observedOutput)
  const observedPage = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
  await observedPage.goto('file://' + resolve(observedReportDirectory, 'report.html'))
  await observedPage.locator('h2').filter({ hasText: 'Attempt resources and identity' }).scrollIntoViewIfNeeded()
  await observedPage.screenshot({ path: resolve(out, 'accounting-report-desktop.png') })
  await observedPage.setViewportSize({ width: 390, height: 844 })
  assert.equal(await observedPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  assert.ok(await observedPage.locator('.table-wrap[tabindex="0"]').count())
  await observedPage.screenshot({ path: resolve(out, 'accounting-report-narrow.png') }); await observedPage.close()
  results.push('Accounting authored and frozen through Research; zero, missing, mismatched and incomplete recorded metadata remain distinct; all report bytes equal fresh CLI output; narrow tables remain accessible')
  await tab('compose'); await page.locator('[data-node-wrap=""]').click()
  await page.waitForFunction(() => document.querySelector('[data-bench-preview-meta]').textContent.includes('depth 2'))
  await field('expected').fill('"Unapplied expected result"')
  await tab('run'); await field('freeze').click()
  await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.includes('pending editor changes'))
  await field('save').click(); await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.includes('Draft saved'))
  await page.evaluate(() => window.audit.remount())
  await page.waitForFunction(() => document.querySelector('[data-bench-name]').value === 'Browser acceptance benchmark')
  assert.equal(await field('expected').inputValue(), '"Unapplied expected result"')
  results.push('Nested composition and unapplied editor text survive account save and page remount; stale freeze refused')
  const info = informationFixture(), readings = info.tasks[0].information.readings
  for (const reading of readings) reading.conventions = { chosen_number: reading.expected }
  delete info.tasks[0].information
  await openResearchProject(page); await field('import').setInputFiles({ name: 'information-fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ spec: info })) })
  await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Draft imported'))
  await tab('compose'); await field('add-information').click()
  await field('information-readings').fill(JSON.stringify(readings))
  await field('information-mode').selectOption('tagged-json')
  await field('information-rationale').fill('Synthetic full versus omitted requirement control; the candidate set is explicitly finite.')
  await field('apply-information').click(); await field('prepare-information').click()
  await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.includes('prepared for your review'))
  await field('information-reviewer').fill('BROWSER INFORMATION FIXTURE ONLY'); await field('approve-information').click()
  await page.waitForFunction(() => document.querySelector('[data-bench-information-review-status]').textContent.includes('has a current review'))
  await field('information-details').screenshot({ path: resolve(out, 'information-authoring.png') })
  await tab('corpus'); await field('seed-corpus').click()
  const recipe = JSON.parse(await field('corpus-plan').inputValue())
  recipe.families[0].axes = [{ id: 'disclosure', choices: [{ id: 'full', edits: [] }, { id: 'omitted', edits: [{ kind: 'withhold', path: ['rule'] }] }] }]
  recipe.coverage = [{ dimension: 'axis:disclosure', minimum: 1 }]
  await field('corpus-plan').fill(JSON.stringify(recipe, null, 2)); await field('generate-corpus').click()
  await page.waitForFunction(() => document.querySelector('[data-bench-task]').options.length === 2)
  const generated = JSON.parse(await field('spec-json').inputValue()), controls = [
    ['number-one', { kind: 'answer', answer: 1 }], ['number-two', { kind: 'answer', answer: 2 }],
    ['clarification', { kind: 'clarification', message: 'Which number?' }], ['refusal', { kind: 'refusal', message: 'Synthetic refusal.' }],
    ['outside-set', { kind: 'answer', answer: 3 }], ['malformed', { kind: 'answer' }],
  ]
  generated.conditions = controls.map(([id, response]) => ({ id, label: 'Recorded response control', model: { provider: 'fixture', id: 'synthetic', settings: {} }, adapter: { kind: 'replay', responses: Object.fromEntries(generated.tasks.map(task => [task.id, response])) } }))
  await field('name').fill('Information and conventions: apparatus controls')
  await tab('protocol'); await field('conditions').fill(JSON.stringify(generated.conditions)); await field('apply-protocol').click(); await page.waitForFunction(() => document.querySelector('[data-mc="benchmark"]').getAttribute('aria-busy') === 'false'); assert.match(await field('status').textContent(), /^Protocol applied/)
  await tab('run'); await field('freeze').click(); await page.waitForFunction(() => !document.querySelector('[data-bench-run]').disabled)
  await field('run').click(); await page.waitForFunction(() => document.querySelector('[data-bench-results]').textContent.includes('12 of 12 trials completed'))
  assert.ok((await field('results').textContent()).includes('Admissible / scheduled'))
  const infoDownloadWait = page.waitForEvent('download'); await field('export').click(); const infoDownload = await infoDownloadWait
  const infoZip = resolve(out, 'information-project.zip'), infoExport = resolve(out, 'information-project'), infoResults = resolve(out, 'information-cli-results')
  await infoDownload.saveAs(infoZip)
  const infoUnpack = spawnSync('python3', ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', infoZip, infoExport], { encoding: 'utf8' })
  assert.equal(infoUnpack.status, 0, infoUnpack.stderr)
  const infoCli = spawnSync(process.execPath, [resolve(infoExport, 'cli.mjs'), 'run', '--output', infoResults], { encoding: 'utf8' })
  assert.equal(infoCli.status, 0, infoCli.stderr)
  await field('import-evidence').setInputFiles(resolve(infoResults, 'evidence.json'))
  await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Evidence imported'))
  const infoReportWait = page.waitForEvent('download'); await field('export-report').click(); const infoReportDownload = await infoReportWait
  const infoReportZip = resolve(out, 'information-report.zip'), infoReport = resolve(out, 'information-report')
  await infoReportDownload.saveAs(infoReportZip)
  const infoReportUnpack = spawnSync('python3', ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', infoReportZip, infoReport], { encoding: 'utf8' })
  assert.equal(infoReportUnpack.status, 0, infoReportUnpack.stderr)
  await compareReports(infoReport, infoResults)
  const infoPage = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
  infoPage.on('pageerror', error => errors.push(error.message))
  await infoPage.goto('file://' + resolve(infoReport, 'report.html'))
  assert.equal(await infoPage.getByRole('heading', { name: 'Corpus construction', exact: true }).count(), 1)
  assert.equal(await infoPage.getByRole('heading', { name: 'Observations and conventions', exact: true }).count(), 1)
  await infoPage.screenshot({ path: resolve(out, 'information-report-desktop.png'), fullPage: true })
  await infoPage.setViewportSize({ width: 390, height: 844 })
  assert.equal(await infoPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await infoPage.screenshot({ path: resolve(out, 'information-report-narrow.png'), fullPage: true }); await infoPage.close()
  results.push('Information authoring and exact task review; seeded full/omitted corpus; 12 measured disposition controls; all portable CLI/GUI report files agree; information/convention reports render at desktop and 390px')
  const referenceCLI = spawnSync(process.execPath, [resolve(infoExport, 'cli.mjs'), 'reference', '--output', infoResults], { encoding: 'utf8' })
  assert.equal(referenceCLI.status, 0, referenceCLI.stderr)
  await tab('audit')
  const referenceWait = page.waitForEvent('download'); await field('export-reference').click(); const referenceDownload = await referenceWait
  const referenceFile = resolve(out, 'source-reference.json'); await referenceDownload.saveAs(referenceFile)
  assert.equal(await readFile(referenceFile, 'utf8'), await readFile(resolve(infoResults, 'reference-bundle.json'), 'utf8'), 'GUI and CLI seal identical source reference bytes')
  await field('import-reference').setInputFiles(referenceFile)
  await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Source reference verified'))
  const auditPlan = JSON.parse(await field('audit-plan').inputValue())
  auditPlan.criterion = { kind: 'admissible-witness', statement: 'Accept a response supported by an admissible reading of the task. Use undetermined when the declared evidence cannot establish a verdict, or abstain when you cannot assess it.' }
  auditPlan.provenance.kind = 'generated-controls'
  await field('audit-plan').fill(JSON.stringify(auditPlan, null, 2)); await field('generate-audit').click()
  await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.includes('audit cases generated'))
  await purpose('apparatus-development')
  const auditDraft = JSON.parse(await field('spec-json').inputValue())
  assert.equal(auditDraft.tasks.length, 12)
  const judgeControls = ['accept', 'reject', 'abstain', 'malformed', 'transport-failure'].map(verdict => ({
    id: verdict, label: 'Synthetic judge control: ' + verdict, model: { provider: 'fixture', id: 'recorded-verdict', settings: {} },
    adapter: { kind: 'replay', responses: verdict === 'transport-failure' ? {} : Object.fromEntries(auditDraft.tasks.map(task => [task.id, { verdict }])) },
  }))
  await tab('protocol'); await field('conditions').fill(JSON.stringify(judgeControls)); await field('apply-protocol').click(); await page.waitForFunction(() => document.querySelector('[data-mc="benchmark"]').getAttribute('aria-busy') === 'false'); assert.match(await field('status').textContent(), /^Protocol applied/)
  await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Protocol applied'))
  await tab('library'); await field('reviewer').fill('BROWSER JUDGE BUNDLE FIXTURE ONLY'); await field('approve').click()
  await page.waitForFunction(() => document.querySelector('[data-bench-review-status]').textContent.startsWith('Reviewed by BROWSER JUDGE'))
  await tab('audit'); await field('prepare-audit').click()
  await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Current judge requests'))
  await field('audit-reviewer').fill('BROWSER JUDGE CASE FIXTURE ONLY')
  for (let i = 0; i < auditDraft.tasks.length; i++) {
    await field('audit-case').selectOption(String(i)); await field('approve-audit').click()
    await page.waitForFunction(() => document.querySelector('[data-bench-audit-review-status]').textContent.includes('has a current review'))
  }
  await page.locator('[data-bench-panel="audit"]').screenshot({ path: resolve(out, 'audit-authoring.png') })
  await tab('run'); await field('freeze').click(); await page.waitForFunction(() => !document.querySelector('[data-bench-run]').disabled)
  await field('run').click(); await page.waitForFunction(() => document.querySelector('[data-bench-results]').textContent.includes('48 of 60 trials completed'))
  assert.ok(await field('results').getByText('Eligible scheduled', { exact: true }).count())
  const auditExportWait = page.waitForEvent('download'); await field('export').click(); const auditExportDownload = await auditExportWait
  const auditZip = resolve(out, 'audit-export.zip'), auditExported = resolve(out, 'audit-exported'), auditResults = resolve(out, 'audit-cli-results')
  await auditExportDownload.saveAs(auditZip)
  const auditUnpack = spawnSync('python3', ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', auditZip, auditExported], { encoding: 'utf8' })
  assert.equal(auditUnpack.status, 0, auditUnpack.stderr)
  const auditCLI = spawnSync(process.execPath, [resolve(auditExported, 'cli.mjs'), 'run', '--output', auditResults], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  assert.equal(auditCLI.status, 2, 'The deliberate collection-failure condition must set the incomplete-run exit code: ' + auditCLI.stderr); assert.equal(JSON.parse(auditCLI.stdout).completed, 48)
  await field('import-evidence').setInputFiles(resolve(auditResults, 'evidence.json'))
  await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Evidence imported'))
  const auditReportWait = page.waitForEvent('download'); await field('export-report').click(); const auditReportDownload = await auditReportWait
  const auditReportZip = resolve(out, 'audit-report.zip'), auditReport = resolve(out, 'audit-report')
  await auditReportDownload.saveAs(auditReportZip)
  const auditReportUnpack = spawnSync('python3', ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', auditReportZip, auditReport], { encoding: 'utf8' })
  assert.equal(auditReportUnpack.status, 0, auditReportUnpack.stderr); await compareReports(auditReport, auditResults)
  const auditPage = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
  auditPage.on('pageerror', error => errors.push(error.message))
  await auditPage.goto('file://' + resolve(auditReport, 'report.html'))
  assert.equal(await auditPage.getByRole('heading', { name: 'Audit source and criterion', exact: true }).count(), 1)
  assert.equal(await auditPage.getByRole('heading', { name: 'Judge decisions against the reference', exact: true }).count(), 1)
  await auditPage.screenshot({ path: resolve(out, 'audit-report-desktop.png'), fullPage: true })
  await auditPage.setViewportSize({ width: 390, height: 844 })
  assert.equal(await auditPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  assert.ok(await auditPage.locator('.table-wrap').first().evaluate(element => element.scrollWidth > element.clientWidth), 'Narrow reports scroll wide tables instead of squeezing headings into individual letters')
  assert.equal(await auditPage.locator('.table-wrap').first().getAttribute('tabindex'), '0', 'Scrollable tables remain accessible from the keyboard')
  assert.equal(await auditPage.locator('th').first().evaluate(element => getComputedStyle(element).overflowWrap), 'normal', 'Table headers keep whole words intact')
  await auditPage.screenshot({ path: resolve(out, 'audit-report-narrow.png'), fullPage: true }); await auditPage.close()
  results.push('GUI/CLI reference bytes identical; 12 judge audit cases generated and individually reviewed; 48 completed and 12 collection-failure controls retain unresolved scores; all audit report bytes agree and render at desktop/390px')
  await tab('compose'); await openResearchProject(page); await field('starter').selectOption('lean-bench'); await field('use-starter').click()
  await page.waitForFunction(() => document.querySelector('[data-bench-name]').value === 'Lean Bench')
  await page.waitForFunction(() => document.querySelector('[data-bench-prompt]').textContent.includes('Buy reason:'))
  await page.locator('[data-node-wrapper="strategy"]').selectOption('sequence'); await page.locator('[data-node-wrap="strategy"]').click()
  await page.waitForFunction(() => document.querySelector('[data-bench-prompt]').textContent.includes('SEQUENCE'))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-mc="benchmark"]').screenshot({ path: resolve(out, 'lean-narrow.png') })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.setViewportSize({ width: 1440, height: 1100 })
  await page.locator('[data-mc="benchmark"]').screenshot({ path: resolve(out, 'lean-desktop.png') })
  for (const theme of ['white', 'tan', 'black']) {
    const ratios = await page.evaluate(theme => {
      document.documentElement.dataset.theme = theme
      const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(channel => channel / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
      return ['[data-bench-name]', '.bench-steps [aria-pressed=true]'].map(selector => {
        const style = getComputedStyle(document.querySelector(selector)), a = luminance(style.color), b = luminance(style.backgroundColor)
        return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
      })
    }, theme)
    assert.ok(ratios.every(ratio => ratio >= 4.5), `${theme}: input and active-tab text must remain readable (${ratios})`)
    if (theme === 'black') await page.locator('[data-mc="benchmark"]').screenshot({ path: resolve(out, 'lean-black.png') })
  }
  await page.emulateMedia({ forcedColors: 'active' })
  assert.equal(await page.locator('.bench-steps [aria-pressed=true]').evaluate(element => getComputedStyle(element).borderTopWidth), '2px')
  await page.emulateMedia({ forcedColors: 'none' })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'white' })
  results.push('Builder input and selected-tab text pass contrast checks in white/tan/black; forced-color selected state stays visible')
  await tab('run'); await field('freeze').click()
  await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.includes('needs review'))
  await tab('library'); await field('bundle').selectOption('0'); await field('wording').fill('Unapplied semantic wording')
  await field('bundle').selectOption('1')
  assert.equal(await field('bundle').inputValue(), '0'); assert.equal(await field('wording').inputValue(), 'Unapplied semantic wording')
  // Exercise the review flow in a clearly labelled synthetic fixture only.
  await field('reviewer').fill('BROWSER TEST FIXTURE'); await field('approve').click()
  await page.waitForFunction(() => document.querySelector('[data-bench-review-status]').textContent.startsWith('Reviewed by BROWSER TEST FIXTURE'))
  await field('wording').fill('Changed again'); await field('apply-bundle').click()
  await page.waitForFunction(() => document.querySelector('[data-bench-review-status]').textContent.includes('no current review'))
  results.push('Lean roles and nested templates render at desktop/390px; unreviewed freeze refused; exact review invalidates after edits')
  await tab('compose'); await openResearchProject(page); await field('starter').selectOption('lean-operational'); await field('use-starter').click()
  await page.waitForFunction(() => document.querySelector('[data-bench-prompt]').textContent.includes('Semantic answer contract'))
  assert.match(await field('prompt').textContent(), /Return only the complete JSON observation value/)
  assert.doesNotMatch(await field('prompt').textContent(), /Return only Python source/)
  await purpose('apparatus-development'); await tab('compose')
  await page.locator('[data-node-wrapper=""]').selectOption('op-all-3'); await page.locator('[data-node-wrap=""]').click()
  await page.waitForFunction(() => document.querySelector('[data-bench-prompt]').textContent.includes('ALL with 3 Node children'))
  await field('derive-expected').click()
  await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Draft expected observation derived'))
  const operationalTask = JSON.parse(await field('task-json').inputValue())
  assert.equal(operationalTask.expected.format, 'lean-operational-observation')
  assert.ok(operationalTask.expected.events.some(event => event.status === 'partial'))
  await page.locator('[data-mc="benchmark"]').screenshot({ path: resolve(out, 'operational-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.locator('[data-mc="benchmark"]').screenshot({ path: resolve(out, 'operational-narrow.png') })
  await page.setViewportSize({ width: 1440, height: 1100 })
  await tab('protocol')
  const operationalConditions = JSON.parse(await field('conditions').inputValue())
  operationalConditions[0].adapter.responses[operationalTask.id] = operationalTask.expected
  await field('conditions').fill(JSON.stringify(operationalConditions)); await field('apply-protocol').click(); await page.waitForFunction(() => document.querySelector('[data-mc="benchmark"]').getAttribute('aria-busy') === 'false'); assert.match(await field('status').textContent(), /^Protocol applied/)
  await tab('run'); await field('freeze').click()
  await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.includes('needs review'))
  await tab('library')
  const operationalBundles = await field('bundle').locator('option').evaluateAll(options => options.map(option => ({ id: option.textContent, value: option.value })))
  for (const id of ['operational-contract-v1', 'op-above', 'op-shares', 'op-after', 'op-sell-all', 'op-strategy', 'op-all-2', 'op-all-3', 'op-sequence-2']) {
    await field('bundle').selectOption(operationalBundles.find(bundle => bundle.id.endsWith(' · ' + id)).value)
    await field('reviewer').fill('SYNTHETIC OPERATIONAL BROWSER FIXTURE ONLY'); await field('approve').click()
    await page.waitForFunction(() => document.querySelector('[data-bench-review-status]').textContent.startsWith('Reviewed by SYNTHETIC OPERATIONAL BROWSER FIXTURE ONLY'))
  }
  await tab('run'); await field('freeze').click(); await page.waitForFunction(() => !document.querySelector('[data-bench-run]').disabled)
  await field('run').click(); await page.waitForFunction(() => document.querySelector('[data-bench-results]').textContent.includes('1 of 1 trials completed'))
  const operationalExportWait = page.waitForEvent('download'); await field('export').click(); const operationalExport = await operationalExportWait
  const operationalZip = resolve(out, 'operational-project.zip'), operationalDirectory = resolve(out, 'operational-project'), operationalResults = resolve(out, 'operational-results')
  await operationalExport.saveAs(operationalZip)
  const operationalUnpack = spawnSync('python3', ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', operationalZip, operationalDirectory], { encoding: 'utf8' })
  assert.equal(operationalUnpack.status, 0, operationalUnpack.stderr)
  for (const args of [['qualify'], ['run', '--output', operationalResults]]) {
    const run = spawnSync(process.execPath, [resolve(operationalDirectory, 'cli.mjs'), ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    assert.equal(run.status, 0, run.stderr)
  }
  await field('import-evidence').setInputFiles(resolve(operationalResults, 'evidence.json'))
  await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Evidence imported'))
  const operationalReportWait = page.waitForEvent('download'); await field('export-report').click(); const operationalReport = await operationalReportWait
  const operationalReportZip = resolve(out, 'operational-report.zip'), operationalReportDirectory = resolve(out, 'operational-report')
  await operationalReport.saveAs(operationalReportZip)
  const operationalReportUnpack = spawnSync('python3', ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', operationalReportZip, operationalReportDirectory], { encoding: 'utf8' })
  assert.equal(operationalReportUnpack.status, 0, operationalReportUnpack.stderr)
  await compareReports(operationalReportDirectory, operationalResults)
  results.push('Operational draft uses recursive three-child/four-role authoring, derives modeled broker observations, enforces exact synthetic review controls, exports a ZIP checked by separate JS/Python interpreters and reproduces every GUI/CLI report byte')
  const requirementSpec = developmentDraft(await operationalRequirementFixture({ shrink: true })), requirementPlan = requirementSpec.requirementPlan
  delete requirementSpec.requirementPlan
  await openResearchProject(page); await field('import').setInputFiles({ name: 'synthetic-requirement-draft.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ spec: requirementSpec })) })
  await page.waitForFunction(() => document.querySelector('[data-bench-task-json]').value.includes('four-roles'))
  await tab('requirements'); if (!await field('requirement-plan').isVisible()) await page.getByText('Advanced requirement plan', { exact: true }).click(); await field('requirement-plan').fill(JSON.stringify(requirementPlan))
  await tab('run'); await field('freeze').click()
  await page.waitForFunction(() => /Apply.*requirement|unapplied.*requirement/i.test(document.querySelector('[data-bench-status]').textContent))
  await tab('requirements'); await field('apply-requirements').click()
  await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.includes('exact bindings'))
  await field('prepare-requirements').click()
  await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.includes('does not execute qualification'))
  const requirementRegistry = JSON.parse(await field('requirement-registry').textContent())
  assert.equal(requirementRegistry.targets.length, 5); assert.ok(requirementRegistry.unregistered.length > 0)
  await page.locator('[data-mc="benchmark"]').screenshot({ path: resolve(out, 'requirements-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.locator('[data-mc="benchmark"]').screenshot({ path: resolve(out, 'requirements-narrow.png') })
  await page.setViewportSize({ width: 1440, height: 1100 })
  await tab('library')
  const requirementBundles = await field('bundle').locator('option').evaluateAll(options => options.map(option => ({ id: option.textContent, value: option.value })))
  for (const id of ['operational-contract-v1', 'op-above', 'op-shares', 'op-after', 'op-sell-all', 'op-sell-fraction', 'op-strategy', 'op-race-accepted-2', 'op-race-filled-2']) {
    await field('bundle').selectOption(requirementBundles.find(bundle => bundle.id.endsWith(' · ' + id)).value)
    await field('reviewer').fill('SYNTHETIC REQUIREMENT BROWSER FIXTURE ONLY'); await field('approve').click()
    await page.waitForFunction(() => document.querySelector('[data-bench-review-status]').textContent.startsWith('Reviewed by SYNTHETIC REQUIREMENT BROWSER FIXTURE ONLY'))
  }
  await tab('run'); await field('freeze').click(); await page.waitForFunction(() => !document.querySelector('[data-bench-run]').disabled)
  await field('run').click(); await page.waitForFunction(() => document.querySelector('[data-bench-results]').textContent.includes('2 of 2 trials completed'))
  const requirementExportWait = page.waitForEvent('download'); await field('export').click(); const requirementExport = await requirementExportWait
  const requirementZip = resolve(out, 'requirement-project.zip'), requirementDirectory = resolve(out, 'requirement-project'), requirementResults = resolve(out, 'requirement-results')
  await requirementExport.saveAs(requirementZip)
  const requirementUnpack = spawnSync('python3', ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', requirementZip, requirementDirectory], { encoding: 'utf8' })
  assert.equal(requirementUnpack.status, 0, requirementUnpack.stderr)
  for (const command of ['qualify', 'run']) {
    const run = spawnSync(process.execPath, [resolve(requirementDirectory, 'cli.mjs'), command, '--output', requirementResults], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    assert.equal(run.status, 0, run.stderr)
  }
  const requirementResult = JSON.parse(await readFile(resolve(requirementResults, 'qualification.json'), 'utf8'))
  assert.equal(requirementResult.requirements.status, 'qualified')
  assert.ok(requirementResult.requirements.targets.every(target => target.probes[0].wrongReadings[0].shrink.oneMinimal))
  for (const [file, contents] of Object.entries(requirementReportFiles(requirementResult))) assert.equal(await readFile(resolve(requirementResults, file), 'utf8'), contents)
  await field('import-evidence').setInputFiles(resolve(requirementResults, 'evidence.json'))
  await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Evidence imported'))
  const requirementReportWait = page.waitForEvent('download'); await field('export-report').click(); const requirementReport = await requirementReportWait
  const requirementReportZip = resolve(out, 'requirement-report.zip'), requirementReportDirectory = resolve(out, 'requirement-report')
  await requirementReport.saveAs(requirementReportZip)
  const requirementReportUnpack = spawnSync('python3', ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', requirementReportZip, requirementReportDirectory], { encoding: 'utf8' })
  assert.equal(requirementReportUnpack.status, 0, requirementReportUnpack.stderr)
  await compareReports(requirementReportDirectory, requirementResults)
  results.push('Requirement registry authored with pending-edit and synthetic review controls; exported CLI independently detects five registered wrong readings, shrinks five witnesses, retains unregistered requirements and reproduces report bytes')
  const workflowSpec = workflowFixture(), workflowConfig = { plan: workflowSpec.workflowPlan, assignments: { recorded: 'revise' } }
  delete workflowSpec.workflowPlan; delete workflowSpec.conditions[0].workflowId
  await openResearchProject(page); await field('import').setInputFiles({ name: 'synthetic-workflow-draft.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ spec: workflowSpec })) })
  await page.waitForFunction(() => document.querySelector('[data-bench-task-json]').value.includes('addition-'))
  await tab('workflow'); await field('workflow-config').fill(JSON.stringify(workflowConfig, null, 2))
  await tab('run'); await field('freeze').click()
  await page.waitForFunction(() => /Apply.*workflow|unapplied.*workflow/i.test(document.querySelector('[data-bench-status]').textContent))
  await tab('workflow'); await field('apply-workflow').click()
  await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Workflow applied'))
  await page.locator('[data-mc="benchmark"]').screenshot({ path: resolve(out, 'workflow-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.locator('[data-mc="benchmark"]').screenshot({ path: resolve(out, 'workflow-narrow.png') })
  await page.setViewportSize({ width: 1440, height: 1100 })
  await tab('run'); await field('freeze').click(); await page.waitForFunction(() => !document.querySelector('[data-bench-run]').disabled)
  await field('run').click(); await page.waitForFunction(() => document.querySelector('[data-bench-results]').textContent.includes('2 of 2 trials completed'))
  const workflowExportWait = page.waitForEvent('download'); await field('export').click(); const workflowExport = await workflowExportWait
  const workflowZip = resolve(out, 'workflow-project.zip'), workflowDirectory = resolve(out, 'workflow-project'), workflowResults = resolve(out, 'workflow-results')
  await workflowExport.saveAs(workflowZip)
  const workflowUnpack = spawnSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; z.extractall(sys.argv[2])', workflowZip, workflowDirectory], { encoding: 'utf8' })
  assert.equal(workflowUnpack.status, 0, workflowUnpack.stderr)
  const workflowRun = spawnSync(process.execPath, [resolve(workflowDirectory, 'cli.mjs'), 'run', '--output', workflowResults], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  assert.equal(workflowRun.status, 0, workflowRun.stderr)
  const workflowEvidence = JSON.parse(await readFile(resolve(workflowResults, 'evidence.json'), 'utf8'))
  assert.equal(workflowEvidence.summary.completed, 2); assert.equal(workflowEvidence.summary.workflows.stages.length, 3)
  assert.equal(workflowEvidence.summary.observations.totals.usage.outputTokens.total, '12')
  const revised = workflowEvidence.summary.workflows.stages.find(stage => stage.stageId === 'revise')
  assert.deepEqual(JSON.parse(revised.request.prompt).parents, [{ stageId: 'draft', path: ['answer'], output: '10' }])
  assert.equal(revised.request.prompt.includes('DO NOT TRANSFER'), false)
  await field('import-evidence').setInputFiles(resolve(workflowResults, 'evidence.json'))
  await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Evidence imported'))
  const workflowReportWait = page.waitForEvent('download'); await field('export-report').click(); const workflowReport = await workflowReportWait
  const workflowReportZip = resolve(out, 'workflow-report.zip'), workflowReportDirectory = resolve(out, 'workflow-report')
  await workflowReport.saveAs(workflowReportZip)
  const workflowReportUnpack = spawnSync('python3', ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', workflowReportZip, workflowReportDirectory], { encoding: 'utf8' })
  assert.equal(workflowReportUnpack.status, 0, workflowReportUnpack.stderr)
  await compareReports(workflowReportDirectory, workflowResults)
  const workflowReportPage = await browser.newPage({ viewport: { width: 390, height: 844 } })
  workflowReportPage.on('pageerror', error => errors.push(error.message))
  await workflowReportPage.goto('file://' + resolve(workflowReportDirectory, 'report.html'))
  assert.equal(await workflowReportPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  assert.equal(await workflowReportPage.getByRole('heading', { name: 'Frozen prompt workflows', exact: true }).count(), 1)
  await workflowReportPage.screenshot({ path: resolve(out, 'workflow-report-narrow.png'), fullPage: true }); await workflowReportPage.close()
  results.push('Frozen workflow authored with pending-edit gates; three stage requests retain exact parent projections, branch before grading, account for all calls and reproduce every GUI/CLI report byte')
  {
    const spec = developmentDraft(await coverageFixture()), plan = spec.corpusPlan, responses = spec.conditions[0].adapter.responses
    delete spec.corpusPlan
    await openResearchProject(page); await field('import').setInputFiles({ name: 'synthetic-coverage-draft.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ spec })) })
    await page.waitForFunction(() => document.querySelector('[data-bench-task-json]').value.includes('arithmetic-family'))
    await tab('corpus'); plan.selection.limit = 3
    await field('corpus-plan').fill(JSON.stringify(plan, null, 2)); await field('generate-corpus').click()
    await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.includes('coverage-unmet'))
    const failed = JSON.parse(await field('corpus-ledger').textContent())
    assert.equal(failed.selectedCount, 3); assert.ok(failed.unmetCoverage.length > 0)
    plan.selection.limit = 4
    await field('corpus-plan').fill(JSON.stringify(plan, null, 2)); await field('generate-corpus').click()
    await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('4 tasks generated from 8 candidates'))
    const ledger = JSON.parse(await field('corpus-ledger').textContent())
    assert.equal(ledger.status, 'ready'); assert.equal(ledger.coverageDefinition.rules.length, 6)
    assert.equal(ledger.candidates.filter(row => row.disposition === 'selected').length, 4)
    assert.ok(ledger.coverage.every(row => row.selected >= row.minimum))
    await writeFile(resolve(out, 'coverage-generation.json'), JSON.stringify({ refused: failed, ready: ledger }, null, 2) + '\n')
    await page.locator('[data-mc="benchmark"]').screenshot({ path: resolve(out, 'coverage-desktop.png') })
    await page.setViewportSize({ width: 390, height: 844 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.locator('[data-mc="benchmark"]').screenshot({ path: resolve(out, 'coverage-narrow.png') })
    await page.setViewportSize({ width: 1440, height: 1100 })
    await tab('protocol')
    const conditions = JSON.parse(await field('conditions').inputValue())
    assert.deepEqual(conditions[0].adapter.responses, {})
    conditions[0].adapter.responses = responses
    await field('conditions').fill(JSON.stringify(conditions)); await field('apply-protocol').click(); await page.waitForFunction(() => document.querySelector('[data-mc="benchmark"]').getAttribute('aria-busy') === 'false'); assert.match(await field('status').textContent(), /^Protocol applied/)
    await tab('run'); await field('freeze').click(); await page.waitForFunction(() => !document.querySelector('[data-bench-run]').disabled)
    await field('run').click(); await page.waitForFunction(() => document.querySelector('[data-bench-results]').textContent.includes('4 of 4 trials completed'))
    const unpackDownload = async (action, stem) => {
      const wait = page.waitForEvent('download'); await field(action).click(); const download = await wait
      const zip = resolve(out, stem + '.zip'), directory = resolve(out, stem)
      await download.saveAs(zip)
      const unpack = spawnSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; z.extractall(sys.argv[2])', zip, directory], { encoding: 'utf8' })
      assert.equal(unpack.status, 0, unpack.stderr); return directory
    }
    const directory = await unpackDownload('export', 'coverage-project'), resultsDirectory = resolve(out, 'coverage-results')
    for (const command of ['verify', 'run', 'analyze']) {
      const result = spawnSync(process.execPath, [resolve(directory, 'cli.mjs'), command, '--output', resultsDirectory], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      assert.equal(result.status, 0, result.stderr)
    }
    const project = JSON.parse(await readFile(resolve(directory, 'project.json'), 'utf8'))
    for (const [first, second] of [['number', 'wording'], ['number', 'depth'], ['wording', 'depth']]) assert.equal(new Set(project.tasks.map(task => task.factors[first] + '/' + task.factors[second])).size, 4)
    await field('import-evidence').setInputFiles(resolve(resultsDirectory, 'evidence.json'))
    await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Evidence imported'))
    const reportDirectory = await unpackDownload('export-report', 'coverage-report')
    await compareReports(reportDirectory, resultsDirectory)
    const reportPage = await browser.newPage({ viewport: { width: 390, height: 844 } })
    reportPage.on('pageerror', error => errors.push(error.message))
    await reportPage.goto('file://' + resolve(reportDirectory, 'report.html'))
    assert.equal(await reportPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    assert.equal(await reportPage.getByRole('heading', { name: 'Corpus construction', exact: true }).count(), 1)
    await reportPage.screenshot({ path: resolve(out, 'coverage-report-narrow.png'), fullPage: true }); await reportPage.close()
    results.push('Joint corpus authoring refuses insufficient quotas, freezes four pair-covering tasks from eight candidates, checks compiled features and reproduces all GUI/CLI report bytes after standalone verification and journal reanalysis')
  }
  for (const kind of ['generic', 'lean']) {
    const fixture = kind === 'generic' ? await genericActivationFixture() : { spec: developmentDraft(await activationFixture()) }
    const plan = fixture.spec.requirementPlan; delete fixture.spec.requirementPlan
    const stem = 'activation-' + kind
    await openResearchProject(page); await field('import').setInputFiles({ name: stem + '.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) })
    await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Draft imported'))
    await tab('requirements'); if (!await field('requirement-plan').isVisible()) await page.getByText('Advanced requirement plan', { exact: true }).click(); await field('requirement-plan').fill(JSON.stringify(plan, null, 2))
    await tab('run'); await field('freeze').click()
    await page.waitForFunction(() => /Apply.*requirement|unapplied.*requirement/i.test(document.querySelector('[data-bench-status]').textContent))
    await tab('requirements'); await field('apply-requirements').click()
    await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.includes('exact bindings'))
    await field('prepare-requirements').click()
    await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.includes('does not execute qualification'))
    const registry = JSON.parse(await field('requirement-registry').textContent())
    assert.equal(registry.selectedInput.unregistered.length, 0)
    assert.equal(registry.selectedInput.compositionOccurrences, kind === 'generic' ? 1 : 5)
    await page.locator('[data-mc="benchmark"]').screenshot({ path: resolve(out, stem + '-authoring.png') })
    if (kind === 'lean') {
      await tab('library')
      const bundles = await field('bundle').locator('option').evaluateAll(options => options.map(option => ({ id: option.textContent, value: option.value })))
      for (const id of ['operational-contract-v1', 'op-above', 'op-shares', 'op-after', 'op-sell-all', 'op-sell-fraction', 'op-strategy']) {
        await field('bundle').selectOption(bundles.find(bundle => bundle.id.endsWith(' · ' + id)).value)
        await field('reviewer').fill('SYNTHETIC ACTIVATION BROWSER FIXTURE ONLY'); await field('approve').click()
        await page.waitForFunction(() => document.querySelector('[data-bench-review-status]').textContent.startsWith('Reviewed by SYNTHETIC ACTIVATION BROWSER FIXTURE ONLY'))
      }
    }
    await tab('run'); await field('freeze').click()
    await page.waitForFunction(() => !document.querySelector('[data-bench-export]').disabled)
    assert.equal(await field('run').isDisabled(), true)
    assert.match(await field('frozen-details').textContent(), /Selected-input qualification is required/)
    const unpackDownload = async (action, name) => {
      const wait = page.waitForEvent('download'); await field(action).click(); const download = await wait
      const zip = resolve(out, name + '.zip'), directory = resolve(out, name); await download.saveAs(zip)
      const unpack = spawnSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; z.extractall(sys.argv[2])', zip, directory], { encoding: 'utf8' })
      assert.equal(unpack.status, 0, unpack.stderr); return directory
    }
    const directory = await unpackDownload('export', stem + '-project'), resultsDirectory = resolve(out, stem + '-results')
    for (const command of ['verify', 'run', 'analyze', 'run']) {
      const result = spawnSync(process.execPath, [resolve(directory, 'cli.mjs'), command, '--output', resultsDirectory], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      assert.equal(result.status, 0, result.stderr)
    }
    const evidence = JSON.parse(await readFile(resolve(resultsDirectory, 'evidence.json'), 'utf8'))
    assert.equal(evidence.summary.completed, 1)
    assert.equal(evidence.events.filter(event => event.type === 'qualification').length, 1)
    const gate = evidence.events.find(event => event.type === 'qualification'), receipt = gate.record
    assert.equal(evidence.events[0].type, 'qualification-started'); assert.equal(gate.preparationSeq, evidence.events[0].seq)
    assert.equal(gate.budgetChargeMs, gate.elapsedMs); assert.ok(gate.elapsedMs >= 0)
    assert.equal(receipt.requirements.selectedInput.compositionStatus, 'qualified')
    assert.equal(receipt.requirements.selectedInput.apparatusRequirements.length, kind === 'generic' ? 0 : 1)
    if (kind === 'generic') assert.equal(receipt.moduleExecutions.length, 10)
    await field('import-evidence').setInputFiles(resolve(resultsDirectory, 'evidence.json'))
    await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Evidence imported'))
    const reportDirectory = await unpackDownload('export-report', stem + '-report')
    await compareReports(reportDirectory, resultsDirectory)
    const reportPage = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
    reportPage.on('pageerror', error => errors.push(error.message))
    await reportPage.goto('file://' + resolve(reportDirectory, 'report.html'))
    assert.equal(await reportPage.getByRole('heading', { name: 'Selected-input qualification', exact: true }).count(), 1)
    await reportPage.getByRole('link', { name: 'Inspect qualification before collection (journal sequence ' + gate.seq + ')' }).click()
    assert.equal(await reportPage.locator('h1').textContent(), 'Requirement qualification')
    assert.equal(await reportPage.locator('table').count(), 8)
    await reportPage.screenshot({ path: resolve(out, stem + '-receipt-desktop.png'), fullPage: true })
    await reportPage.setViewportSize({ width: 390, height: 844 })
    assert.equal(await reportPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await reportPage.screenshot({ path: resolve(out, stem + '-receipt-narrow.png'), fullPage: true }); await reportPage.close()
    results.push(kind + ' selected-input policy authored and frozen; direct browser replay refuses; standalone independent gate precedes collection, completed resume adds no calls, and every imported receipt/report byte agrees with CLI reanalysis')
  }
  {
    const spec = primaryPopulationFixture(); delete spec.analysisPlan.primaryPopulation
    await openResearchProject(page); await field('import').setInputFiles({ name: 'primary-population.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ spec })) })
    await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Draft imported'))
    await tab('analysis'); await field('analysis-population').selectOption('held-out')
    await tab('run'); await field('freeze').click()
    await page.waitForFunction(() => /Apply.*analysis|unapplied.*analysis/i.test(document.querySelector('[data-bench-status]').textContent))
    await tab('analysis'); await field('apply-analysis').click()
    await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Analysis plan applied'))
    assert.match(await field('analysis-population-preview').textContent(), /1 included tasks; 9 excluded tasks/)
    await page.locator('[data-mc="benchmark"]').screenshot({ path: resolve(out, 'population-authoring-desktop.png') })
    await page.setViewportSize({ width: 390, height: 844 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.locator('[data-mc="benchmark"]').screenshot({ path: resolve(out, 'population-authoring-narrow.png') })
    await page.setViewportSize({ width: 1440, height: 1100 })
    await tab('run'); await field('freeze').click(); await page.waitForFunction(() => !document.querySelector('[data-bench-run]').disabled)
    await field('run').click(); await page.waitForFunction(() => document.querySelector('[data-bench-results]').textContent.includes('20 of 20 trials completed'))
    assert.match(await field('primary-results').textContent(), /0.0%.*100.0%/s)
    assert.match(await field('all-results').textContent(), /90.0%.*10.0%/s)
    const unpackDownload = async (action, name) => {
      const wait = page.waitForEvent('download'); await field(action).click(); const download = await wait
      const zip = resolve(out, name + '.zip'), directory = resolve(out, name); await download.saveAs(zip)
      const unpack = spawnSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; z.extractall(sys.argv[2])', zip, directory], { encoding: 'utf8' })
      assert.equal(unpack.status, 0, unpack.stderr); return directory
    }
    const directory = await unpackDownload('export', 'population-project'), resultsDirectory = resolve(out, 'population-results')
    for (const command of ['verify', 'run', 'analyze']) {
      const result = spawnSync(process.execPath, [resolve(directory, 'cli.mjs'), command, '--output', resultsDirectory], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      assert.equal(result.status, 0, result.stderr)
    }
    const evidence = JSON.parse(await readFile(resolve(resultsDirectory, 'evidence.json'), 'utf8'))
    assert.deepEqual(evidence.summary.groups.map(group => group.primaryRate), [0, 1])
    assert.equal(evidence.summary.contrasts[0].difference, -1)
    assert.equal(evidence.summary.primaryPopulation.excludedScheduled, 18)
    const population = JSON.parse(await readFile(resolve(directory, 'analysis/population.json'), 'utf8'))
    assert.deepEqual(population.taskIds, ['held-out-1'])
    await field('import-evidence').setInputFiles(resolve(resultsDirectory, 'evidence.json'))
    await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Evidence imported'))
    const reportDirectory = await unpackDownload('export-report', 'population-report')
    await compareReports(reportDirectory, resultsDirectory)
    const reportPage = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
    reportPage.on('pageerror', error => errors.push(error.message))
    await reportPage.goto('file://' + resolve(reportDirectory, 'report.html'))
    assert.equal(await reportPage.getByRole('heading', { name: 'Primary development computations', exact: true }).count(), 1)
    await reportPage.screenshot({ path: resolve(out, 'population-report-desktop.png'), fullPage: true })
    await reportPage.setViewportSize({ width: 390, height: 844 }); assert.equal(await reportPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await reportPage.screenshot({ path: resolve(out, 'population-report-narrow.png'), fullPage: true }); await reportPage.close()
    results.push('Investigator population field freezes one held-out task; primary 0% versus 100% and contrast -1 remain separate from pooled 90% versus 10%; all 20 trials, 18 excluded primary rows and exact GUI/CLI report bytes survive export and journal reanalysis')
  }
  {
    const spec = genericStarter(); spec.id = 'custom-grade-integrity'; spec.name = 'Synthetic custom outcome integrity'; spec.tasks.length = 1
    const grader = 'export function grade() { return { passed: true, score: 1, classification: "contained", metrics: { affectedResources: 1, units: "resources", severity: null } }; }\n'
    spec.protocol.grading = { kind: 'module', file: 'grader.mjs' }; spec.inputs = [{ path: 'grader.mjs', sha256: await sha256(grader) }]
    await openResearchProject(page); await field('import').setInputFiles({ name: 'custom-grade.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ spec, attachments: { 'grader.mjs': grader } })) })
    await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Draft imported'))
    await tab('run'); await field('freeze').click(); await page.waitForFunction(() => !document.querySelector('[data-bench-export]').disabled)
    assert.equal(await field('run').isDisabled(), true)
    const unpackDownload = async (action, name) => {
      const wait = page.waitForEvent('download'); await field(action).click(); const download = await wait
      const zip = resolve(out, name + '.zip'), directory = resolve(out, name); await download.saveAs(zip)
      const unpack = spawnSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; z.extractall(sys.argv[2])', zip, directory], { encoding: 'utf8' })
      assert.equal(unpack.status, 0, unpack.stderr); return directory
    }
    const directory = await unpackDownload('export', 'grade-proof-project'), resultsDirectory = resolve(out, 'grade-proof-results')
    for (const command of ['verify', 'run', 'analyze']) {
      const result = spawnSync(process.execPath, [resolve(directory, 'cli.mjs'), command, '--output', resultsDirectory], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      assert.equal(result.status, 0, result.stderr)
    }
    const evidence = JSON.parse(await readFile(resolve(resultsDirectory, 'evidence.json'), 'utf8')), forged = structuredClone(evidence)
    forged.events.find(event => event.type === 'finished').grade.classification = 'escaped'
    await writeFile(resolve(out, 'grade-proof-forged.json'), JSON.stringify(forged, null, 2) + '\n')
    await field('import-evidence').setInputFiles(resolve(out, 'grade-proof-forged.json'))
    await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.includes('recorded custom grade disagrees'))
    await writeFile(resolve(out, 'grade-proof-rejection.json'), JSON.stringify({ status: await field('status').textContent(), forgedClassificationRejected: true }, null, 2) + '\n')
    const withoutReceipt = structuredClone(evidence)
    delete withoutReceipt.events.find(event => event.type === 'finished').grade.process
    await writeFile(resolve(out, 'grade-proof-without-receipt.json'), JSON.stringify(withoutReceipt, null, 2) + '\n')
    await field('import-evidence').setInputFiles(resolve(out, 'grade-proof-without-receipt.json'))
    await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Evidence imported'))
    assert.match(await field('custom-grade-evidence').textContent(), /0 completed grades have retained process receipts; 1 have no process receipt/)
    await field('import-evidence').setInputFiles(resolve(resultsDirectory, 'evidence.json'))
    await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Evidence imported'))
    assert.match(await field('custom-grade-evidence').textContent(), /1 completed grades have retained process receipts; 0 have no process receipt/)
    const reportDirectory = await unpackDownload('export-report', 'grade-proof-report'); await compareReports(reportDirectory, resultsDirectory)
    results.push('Source-pinned custom grader executes and rechecks all deterministic fields in standalone CLI; browser import refuses classification inconsistent with retained raw process output; valid evidence regenerates identical reports')
  }
  {
    await tab('compose'); await openResearchProject(page); await field('starter').selectOption('resource-action-plan'); await field('use-starter').click()
    await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Starter loaded'))
    await tab('experiment')
    await page.locator('[data-resource-template-case-instruction]').fill('Set target to released. Leave every other resource unchanged.')
    await page.locator('[data-resource-template-goal-value]').fill('released')
    await tab('run'); await field('freeze').click()
    await page.waitForFunction(() => /Apply.*experiment/.test(document.querySelector('[data-bench-status]').textContent))
    await tab('experiment'); await field('apply-resource-template').click()
    await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('2 resource cases generated'))
    assert.match(await field('resource-preview').textContent(), /released/)
    assert.doesNotMatch(await field('resource-preview').textContent(), /PRIVATE_RESOURCE_CONTROL_/)
    await page.locator('[data-mc="benchmark"]').screenshot({ path: resolve(out, 'resource-fields-desktop.png') })
    await page.setViewportSize({ width: 390, height: 844 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.locator('[data-mc="benchmark"]').screenshot({ path: resolve(out, 'resource-fields-narrow.png') })
    await page.setViewportSize({ width: 1440, height: 1100 })
    await tab('run'); await field('freeze').click(); await page.waitForFunction(() => !document.querySelector('[data-bench-run]').disabled)
    await field('run').click(); await page.waitForFunction(() => document.querySelector('[data-bench-results]').textContent.includes('4 of 4 trials completed'))
    assert.match(await field('resource-results').textContent(), /Observed resource effects/)
    assert.match(await field('primary-results').textContent(), /100.0%.*0.0%/s)
    await page.locator('[data-mc="benchmark"]').screenshot({ path: resolve(out, 'resource-results.png') })
    const unpackDownload = async (action, name) => {
      const wait = page.waitForEvent('download'); await field(action).click(); const download = await wait
      const zip = resolve(out, name + '.zip'), directory = resolve(out, name); await download.saveAs(zip)
      const unpack = spawnSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; z.extractall(sys.argv[2])', zip, directory], { encoding: 'utf8' })
      assert.equal(unpack.status, 0, unpack.stderr); return directory
    }
    const directory = await unpackDownload('export', 'resource-project'), resultsDirectory = resolve(out, 'resource-results')
    for (const command of ['verify', 'run', 'analyze']) {
      const result = spawnSync(process.execPath, [resolve(directory, 'cli.mjs'), command, '--output', resultsDirectory], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      assert.equal(result.status, 0, result.stderr)
    }
    const evidence = JSON.parse(await readFile(resolve(resultsDirectory, 'evidence.json'), 'utf8'))
    assert.equal(evidence.summary.completed, 4)
    assert.equal(evidence.events.filter(event => event.type === 'template-qualified').length, 1)
    assert.equal(evidence.events.filter(event => event.type === 'resource-prepared').length, 4)
    assert.deepEqual(evidence.summary.groups.map(group => group.primaryRate), [1, 0])
    assert.ok(evidence.summary.resourceEffects.rows.every(row => row.effects.taskSuccess))
    assert.deepEqual([...new Set(evidence.summary.resourceEffects.rows.map(row => row.effects.everCollateralCount))].sort(), [0, 1])
    const originalJournal = await readFile(resolve(resultsDirectory, 'attempts.jsonl'))
    const resumed = spawnSync(process.execPath, [resolve(directory, 'cli.mjs'), 'run', '--output', resultsDirectory], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    assert.equal(resumed.status, 0, resumed.stderr); assert.ok(originalJournal.equals(await readFile(resolve(resultsDirectory, 'attempts.jsonl'))))
    const forged = structuredClone(evidence); forged.events.find(event => event.type === 'finished').grade.resourceEffects.everCollateralCount = 99
    await writeFile(resolve(out, 'resource-forged-grade.json'), JSON.stringify(forged, null, 2) + '\n')
    await field('import-evidence').setInputFiles(resolve(out, 'resource-forged-grade.json'))
    await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.includes('resource grade differs'))
    await writeFile(resolve(out, 'resource-grade-rejection.json'), JSON.stringify({ rejected: true, status: await field('status').textContent() }, null, 2) + '\n')
    await field('import-evidence').setInputFiles(resolve(resultsDirectory, 'evidence.json'))
    await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Evidence imported'))
    const reportDirectory = await unpackDownload('export-report', 'resource-report'); await compareReports(reportDirectory, resultsDirectory)
    const reportPage = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
    reportPage.on('pageerror', error => errors.push(error.message))
    await reportPage.goto('file://' + resolve(reportDirectory, 'report.html'))
    assert.equal(await reportPage.getByRole('heading', { name: 'Observed resource effects', exact: true }).count(), 1)
    assert.equal(await reportPage.getByRole('heading', { name: 'Experiment template qualification', exact: true }).count(), 1)
    await reportPage.screenshot({ path: resolve(out, 'resource-report-desktop.png'), fullPage: true })
    await reportPage.setViewportSize({ width: 390, height: 844 }); assert.equal(await reportPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await reportPage.screenshot({ path: resolve(out, 'resource-report-narrow.png'), fullPage: true }); await reportPage.close()
    results.push('Ordinary resource fields generate public prompts, private fixtures, reference and collateral plans; mandatory conformance precedes four fresh observed episodes; forged effects refuse; completed CLI resume adds nothing and all GUI/CLI report bytes match')
  }
  {
    const fixture = await genericActivationFixture(), spec = newExperimentDraft(fixture.spec, { purpose: 'experiment', initializePopulation: true })
    spec.id = 'ordinary-requirement-fields'; spec.name = 'Ordinary requirement fields browser proof'
    delete spec.requirementPlan; spec.inputs = []
    await openResearchProject(page); await field('import').setInputFiles({ name: 'ordinary-fields.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ spec })) })
    await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Draft imported'))
    await tab('protocol')
    for (const [path, contents] of Object.entries(fixture.attachments)) {
      await field('attachment-path').fill(path); await field('attachment-text').fill(contents); await field('attach').click()
      await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Attached'))
    }
    await tab('requirements'); await field('prepare-requirement-fields').click()
    await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Requirement controls prepared'))
    const control = name => page.locator('[data-requirement-fields-' + name + ']')
    assert.equal(await control('target').locator('option').count(), 1)
    await control('rationale').fill('Every occurrence must distinguish its local wrong reading on the actual selected input and the independently asserted witness.')
    await control('reference').selectOption('interpreters/direct.mjs'); await control('independent').selectOption('interpreters/steps.mjs')
    await control('interpreter-rationale').fill('Separate direct arithmetic and repeated signed unit steps implement the bounded integer domain with different algorithms.')
    await control('target-rationale').fill('The first operand contributes its declared value to the requested sum.')
    await control('activation-name').fill('evaluated')
    await control('probe').locator('details > summary').click()
    await page.locator('[data-requirement-fields-value-context="probe-0/input/offset"] [data-requirement-fields-value-text]').fill('2')
    await control('add-assertion').click(); await control('assertion-path').selectOption('[]')
    await control('assertion').locator('[data-requirement-fields-value-kind]').selectOption('string')
    await control('assertion').locator('[data-requirement-fields-value-text]').fill('7')
    await control('add-alternative').click(); await control('parameter').selectOption('a')
    await control('alternative').locator('[data-requirement-fields-value-text]').fill('1')
    await control('alternative-rationale').fill('Substituting one for the first operand subtracts one from the required answer while preserving the other operands.')
    await control('timeout').fill('unfinished')
    await field('apply-requirement-fields').click()
    await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.includes('whole number'))
    await field('save').click(); await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.includes('Draft saved'))
    await page.evaluate(() => window.audit.remount())
    await page.waitForFunction(() => document.querySelector('[data-bench-id]').value === 'ordinary-requirement-fields')
    await tab('requirements'); await field('prepare-requirement-fields').click()
    await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Requirement controls prepared'))
    assert.equal(await control('timeout').inputValue(), 'unfinished')
    await control('timeout').fill('120000')
    const original = JSON.parse(await field('requirement-fields').inputValue())
    await tab('compose'); await field('input').fill('{"offset":3}'); await field('expected').fill('"8"'); await field('apply-input').click()
    await tab('requirements'); await field('apply-requirement-fields').click()
    await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.includes('Regenerate'))
    await field('prepare-requirement-fields').click(); await page.waitForFunction(() => document.querySelector('[data-requirement-fields-status]').textContent.includes('fields are stale'))
    await field('reset-requirement-fields').click(); await page.waitForFunction(() => !document.querySelector('[data-requirement-fields-status]').textContent.includes('fields are stale'))
    assert.equal(JSON.parse(await field('requirement-fields').inputValue()).targets[0].probes[0].assertions.length, 0)
    await tab('compose'); await field('undo').click(); await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Previous draft restored'))
    assert.deepEqual(JSON.parse(await field('requirement-fields').inputValue()), original)
    await tab('compose'); await field('input').fill('{"offset":1}'); await field('expected').fill('"6"'); await field('apply-input').click()
    await tab('requirements'); await field('prepare-requirement-fields').click(); await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Requirement controls prepared'))
    await field('apply-requirement-fields').click(); await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Qualification plan generated'))
    const authored = JSON.parse(await field('spec-json').inputValue()), registry = JSON.parse(await field('requirement-registry').textContent())
    assert.equal(authored.requirementPlan.selectedInput.policy, 'require-composition'); assert.equal(registry.selectedInput.unregistered.length, 0)
    assert.deepEqual(authored.requirementPlan.targets[0].probes[0].assertions, [{ path: [], equals: '7' }])
    await field('requirement-fields-editor').screenshot({ path: resolve(out, 'ordinary-fields-desktop.png') })
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.locator('[data-mc="benchmark"]').screenshot({ path: resolve(out, 'ordinary-fields-narrow.png') }); await page.setViewportSize({ width: 1440, height: 1100 })
    await tab('run'); await field('freeze').click(); await page.waitForFunction(() => !document.querySelector('[data-bench-export]').disabled)
    assert.equal(await field('run').isDisabled(), true)
    assert.match(await field('readiness').textContent(), /Design eligible.*Fresh executed controls/)
    const unpackDownload = async (action, name) => {
      const wait = page.waitForEvent('download'); await field(action).click(); const download = await wait
      const zip = resolve(out, name + '.zip'), directory = resolve(out, name); await download.saveAs(zip)
      const unpack = spawnSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; z.extractall(sys.argv[2])', zip, directory], { encoding: 'utf8' })
      assert.equal(unpack.status, 0, unpack.stderr); return directory
    }
    const directory = await unpackDownload('export', 'ordinary-fields-project'), resultsDirectory = resolve(out, 'ordinary-fields-results')
    for (const command of ['verify', 'run', 'analyze']) {
      const result = spawnSync(process.execPath, [resolve(directory, 'cli.mjs'), command, '--output', resultsDirectory], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      await writeFile(resolve(out, 'ordinary-fields-' + command + '.stdout'), result.stdout); await writeFile(resolve(out, 'ordinary-fields-' + command + '.stderr'), result.stderr)
      assert.equal(result.status, 0, result.stderr)
    }
    const evidence = JSON.parse(await readFile(resolve(resultsDirectory, 'evidence.json'), 'utf8')), qualified = evidence.events.find(event => event.type === 'qualification')
    assert.equal(evidence.summary.completed, 1); assert.equal(evidence.summary.execution.purpose, 'experiment')
    assert.equal(qualified.record.requirements.selectedInput.compositionStatus, 'qualified'); assert.equal(qualified.record.moduleExecutions.length, 10)
    await field('import-evidence').setInputFiles(resolve(resultsDirectory, 'evidence.json')); await page.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.startsWith('Evidence imported'))
    const reportDirectory = await unpackDownload('export-report', 'ordinary-fields-report'); await compareReports(reportDirectory, resultsDirectory)
    results.push('Ordinary fields author independent counterpart files, witness values, activation and local alternatives; unfinished/stale fields survive remount and reset Undo; exact complete-composition plan qualifies through standalone CLI and all imported GUI report bytes agree')
  }
  const example = await browser.newPage({ viewport: { width: 390, height: 844 } })
  example.on('pageerror', error => errors.push(error.message))
  await example.goto(origin + '/tools/test/fixtures/research-workflow.html?mode=example'); await example.waitForFunction(() => window.auditReady)
  await example.locator('[data-bench-save]').click()
  await example.waitForFunction(() => document.querySelector('[data-bench-status]').textContent.includes('Example mode'))
  const actions = await example.evaluate(() => ({ writes: window.audit.state.accountWrites.length, actions: window.audit.state.backendActions.length }))
  assert.deepEqual(actions, { writes: 0, actions: 0 })
  results.push('Example save refuses with zero account or service writes')
  assert.deepEqual(errors, [])
  const exports = []
  for (const entry of await readdir(out, { withFileTypes: true })) if (entry.isDirectory()) {
    let project; try { project = JSON.parse(await readFile(resolve(out, entry.name, 'project.json'), 'utf8')) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    assert.notEqual(project.spec.protocol.grading.kind, 'lean-python', 'Browser apparatus acceptance must not launch the native engine')
    assert.equal(project.runtimeFiles.length, RUNTIME_FILES.length)
    for (const file of RUNTIME_FILES) assert.equal(await sha256(await readFile(resolve(out, entry.name, file))), project.spec.runtimeSources[file], entry.name + '/' + file)
    exports.push({ directory: entry.name, projectSha256: project.sha256, runtimePins: RUNTIME_FILES.length, purpose: project.spec.executionPlan.purpose })
  }
  await writeFile(resolve(out, 'source-export-parity.json'), JSON.stringify({ exports, reportParity, nativeRuns: 0, providerCalls: 0 }, null, 2))
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0]
  if (page) { await page.screenshot({ path: resolve(out, 'failure.png'), fullPage: true }).catch(() => {}); await writeFile(resolve(out, 'failure.json'), JSON.stringify({ error: error.stack, status: await page.locator('[data-bench-status]').textContent().catch(() => null), readiness: await page.locator('[data-bench-readiness]').textContent().catch(() => null) }, null, 2)) }
  throw error
} finally {
  await writeFile(resolve(out, 'results.json'), JSON.stringify({ results, errors }, null, 2)); await browser.close()
}
console.log(JSON.stringify({ results, errors, out }))
