import { openResearchProject } from './research-project-picker.mjs'
// Actual Research verification of hand-retained synthetic native artifacts.
// No candidate, grader callback, provider or native engine is run here.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { auditFileBytes, nativeEvidencePaths, verifyNativeJournalEvidence } from '../../../src/benchmark/audit.mjs'
import { RUNTIME_FILES } from '../../../src/benchmark/study.mjs'
import { canonical, sha256 } from '../../../src/benchmark/prompts.mjs'
const { chromium } = createRequire(import.meta.url)(process.env.MC_PLAYWRIGHT_ROOT)
const origin = process.env.BENCHMARK_TEST_ORIGIN || 'http://127.0.0.1:4728'
const out = resolve(process.env.BENCHMARK_TEST_OUTPUT || 'native-verification-browser-evidence')
const bundle = JSON.parse(await readFile(process.env.BENCHMARK_TEST_BUNDLE)), { project, events } = bundle
assert.equal(bundle.format, 'benchmark-native-evidence'); assert.equal(project.version, 2)
assert.equal(project.spec.executionPlan.purpose, 'apparatus-development')
const expectedReceipt = await verifyNativeJournalEvidence(bundle)
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true }), results = [], errors = [], parity = [], pins = []
let page, externalRequests = 0
async function unpack(zip, destination) {
  const result = spawnSync('python3', ['-c', 'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;z.extractall(sys.argv[2])', zip, destination], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true })
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', async route => {
    if (new URL(route.request().url()).origin !== origin) { externalRequests++; await route.abort() } else await route.continue()
  })
  await page.goto(origin + '/tools/test/fixtures/research-workflow.html?mode=available')
  await page.waitForFunction(() => window.auditReady)
  await openResearchProject(page, { account: true }); await page.locator('[data-project-select]').selectOption('rp-' + 'a'.repeat(36))
  const f = name => page.locator('[data-bench-' + name + ']')
  const idle = () => page.waitForFunction(() => document.querySelector('[data-mc="benchmark"]').getAttribute('aria-busy') === 'false')
  const settled = async text => { await page.waitForFunction(text => document.querySelector('[data-bench-status]').textContent.startsWith(text), text); await idle() }
  const upload = (name, value) => f(name).setInputFiles({ name: 'synthetic-native-evidence.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) })
  async function download(action, name) {
    const wait = page.waitForEvent('download'); await f(action).click()
    const item = await wait, path = resolve(out, name); await item.saveAs(path); return path
  }
  await upload('import', { spec: project.spec }); await settled('Draft imported')
  await page.locator('[data-bench-tab="run"]').click(); await f('freeze').click(); await settled('Project frozen')
  const exported = resolve(out, 'exported-project')
  await unpack(await download('export', 'project.zip'), exported)
  assert.deepEqual(JSON.parse(await readFile(resolve(exported, 'project.json'))), project)
  for (const name of RUNTIME_FILES) {
    const digest = await sha256(await readFile(new URL('../../../src/benchmark/' + name, import.meta.url)))
    assert.equal(project.spec.runtimeSources[name], digest); assert.equal(await sha256(await readFile(resolve(exported, name))), digest)
    pins.push({ name, sha256: digest })
  }
  await upload('import-native-evidence', bundle); await settled('Native artifacts verified for consistency')
  const receipt = JSON.parse(await readFile(await download('export-native-verification', 'gui-native-verification.json')))
  assert.deepEqual(receipt, expectedReceipt)
  const retained = JSON.parse(await readFile(await download('export-evidence', 'evidence.json')))
  assert.deepEqual(retained.events, events); assert.equal(retained.summary.completed, 1)
  assert.equal(retained.summary.execution.experimentalCollection, 'not-admitted')
  const report = resolve(out, 'gui-report'); await unpack(await download('export-report', 'report.zip'), report)
  const output = resolve(exported, 'results'); await mkdir(output)
  await writeFile(resolve(output, 'attempts.jsonl'), events.map(row => JSON.stringify(row)).join('\n') + '\n')
  for (const row of nativeEvidencePaths(project, events.filter(row => row.type === 'finished' && row.status === 'completed')).files) {
    if (!Object.hasOwn(bundle.files, row.key)) { assert.equal(row.required, false); continue }
    const path = resolve(row.location === 'project' ? exported : output, row.path)
    const bytes = auditFileBytes(bundle.files[row.key]); await mkdir(dirname(path), { recursive: true })
    if (row.key.startsWith('runtime/')) assert.deepEqual(new Uint8Array(await readFile(path)), bytes)
    else await writeFile(path, bytes)
  }
  for (const command of ['verify', 'analyze', 'verify-native']) {
    const result = spawnSync(process.execPath, [resolve(exported, 'cli.mjs'), command], { encoding: 'utf8', timeout: 30000 })
    await writeFile(resolve(out, command + '.stdout'), result.stdout || ''); await writeFile(resolve(out, command + '.stderr'), result.stderr || '')
    assert.equal(result.status, 0, result.stderr)
  }
  assert.deepEqual(JSON.parse(await readFile(resolve(output, 'native-verification.json'))), receipt)
  async function compare(directory = '') {
    for (const entry of await readdir(resolve(report, directory), { withFileTypes: true })) {
      const file = directory ? directory + '/' + entry.name : entry.name
      if (entry.isDirectory()) await compare(file)
      else {
        const bytes = await readFile(resolve(report, file)); assert.deepEqual(await readFile(resolve(output, file)), bytes, file)
        parity.push({ file, bytes: bytes.length, sha256: await sha256(bytes) })
      }
    }
  }
  await compare()
  results.push('Actual Research Freeze retains exact project and 45 source pins; native verification receipt equals portable API/CLI and all report files match GUI/CLI bytes with no new execution')
  const finish = value => value.events.find(row => row.type === 'finished'), native = 'native/' + finish(bundle).trialId + '-1/'
  const negatives = []
  for (const [name, mutate] of [['different-project', value => { value.project.sha256 = '0'.repeat(64) }],
    ['source-tamper', value => { value.files['runtime/runner.mjs'] += '\n// changed pinned runtime' }],
    ['missing-raw-result', value => { delete value.files[native + 'result.json'] }],
    ['hidden-events', value => { value.files[native + 'order-events.json'] = '[]' }]]) {
    const value = structuredClone(bundle); mutate(value)
    await upload('import-native-evidence', value); await idle()
    const message = await f('status').textContent()
    assert.doesNotMatch(message, /^Native artifacts verified/)
    assert.deepEqual(JSON.parse(await readFile(await download('export-evidence', name + '-evidence.json'))), retained)
    assert.deepEqual(JSON.parse(await readFile(await download('export-native-verification', name + '-receipt.json'))), receipt)
    negatives.push({ name, message })
  }
  await writeFile(resolve(out, 'refusals.json'), JSON.stringify(negatives, null, 2) + '\n')
  results.push('Actual native imports reject a different project, changed runtime, missing raw result and hidden order events atomically; preceding evidence and receipt remain exact')
  await f('native-verification').screenshot({ path: resolve(out, 'verification-status.png') })
  await upload('import-evidence', { projectSha256: project.sha256, events }); await settled('Evidence imported')
  assert.equal(await f('export-native-verification').isDisabled(), true)
  assert.match(await f('native-verification').textContent(), /No native artifact verification/)
  assert.deepEqual(JSON.parse(await readFile(await download('export-evidence', 'ordinary-import-evidence.json'))), retained)
  results.push('Ordinary journal import preserves existing report mathematics and clears the distinct native verification receipt')
  await upload('import-native-evidence', bundle); await settled('Native artifacts verified for consistency')
  await openResearchProject(page, { account: true }); await page.locator('[data-project-select]').selectOption('all'); await idle()
  assert.equal(await f('export-native-verification').isDisabled(), true)
  await openResearchProject(page, { account: true }); await page.locator('[data-project-select]').selectOption('rp-' + 'a'.repeat(36)); await settled('Project draft restored')
  assert.equal(await f('export-native-verification').isDisabled(), true)
  assert.deepEqual(JSON.parse(await readFile(await download('export-evidence', 'restored-evidence.json'))), retained)
  results.push('Project navigation preserves each project draft/evidence but restores no native verification status without reimport')
  assert.deepEqual(errors, []); assert.equal(externalRequests, 0)
  await writeFile(resolve(out, 'qualification.json'), JSON.stringify({ results, projectSha256: project.sha256, pins, parity,
    importedCompletedTrials: 1, newRecordedTrials: 0, cliVerify: 1, cliAnalyze: 1, cliVerifyNative: 1, providerCalls: 0, nativeRuns: 0, graderCalls: 0, externalRequests }, null, 2) + '\n')
} catch (error) {
  if (page) {
    await page.screenshot({ path: resolve(out, 'failure.png'), fullPage: true }).catch(() => {})
    await writeFile(resolve(out, 'failure.json'), JSON.stringify({ error: error.stack, status: await page.locator('[data-bench-status]').textContent().catch(() => null) }, null, 2))
  }
  throw error
} finally { await writeFile(resolve(out, 'results.json'), JSON.stringify({ results, errors, externalRequests }, null, 2) + '\n'); await browser.close() }
