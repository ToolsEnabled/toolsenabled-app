import { openResearchProject } from './research-project-picker.mjs'
// Import retained synthetic apparatus evidence through the actual Research view.
// No collection, grader, provider or native host is invoked by this driver.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { gradeInterpretations } from '../../../src/benchmark/information.mjs'
import { RUNTIME_FILES } from '../../../src/benchmark/study.mjs'
import { sha256 } from '../../../src/benchmark/prompts.mjs'
const { chromium } = createRequire(import.meta.url)(process.env.MC_PLAYWRIGHT_ROOT)
const origin = process.env.BENCHMARK_TEST_ORIGIN || 'http://127.0.0.1:4728'
const out = resolve(process.env.BENCHMARK_TEST_OUTPUT || 'native-information-browser-evidence')
const project = JSON.parse(await readFile(process.env.BENCHMARK_TEST_PROJECT))
const events = JSON.parse(await readFile(process.env.BENCHMARK_TEST_EVENTS))
assert.equal(project.spec.executionPlan.purpose, 'apparatus-development')
assert.equal(project.tasks[0].compiled.nodeCount, 17)
const complete = events.find(row => row.type === 'finished' && row.status === 'completed')
assert.equal(complete.grade.trace.format, 'lean-operational-observation')
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
    if (new URL(route.request().url()).origin !== origin) { externalRequests++; await route.abort() }
    else await route.continue()
  })
  await page.goto(origin + '/tools/test/fixtures/research-workflow.html?mode=available')
  await page.waitForFunction(() => window.auditReady)
  await openResearchProject(page, { account: true }); await page.locator('[data-project-select]').selectOption('rp-' + 'a'.repeat(36))
  const f = name => page.locator('[data-bench-' + name + ']')
  const settled = text => page.waitForFunction(text => document.querySelector('[data-bench-status]').textContent.startsWith(text), text)
  const upload = (name, value) => f(name).setInputFiles({ name: 'synthetic.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) })
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
    assert.equal(project.spec.runtimeSources[name], digest)
    assert.equal(await sha256(await readFile(resolve(exported, name))), digest)
    pins.push({ name, sha256: digest })
  }
  await upload('import-evidence', { projectSha256: project.sha256, events }); await settled('Evidence imported')
  const retained = JSON.parse(await readFile(await download('export-evidence', 'evidence.json')))
  assert.deepEqual(retained.events, events); assert.equal(retained.summary.completed, 1)
  assert.equal(retained.summary.execution.experimentalCollection, 'not-admitted')
  const report = resolve(out, 'gui-report')
  await unpack(await download('export-report', 'report.zip'), report)
  await mkdir(resolve(exported, 'results'))
  await writeFile(resolve(exported, 'results/attempts.jsonl'), events.map(row => JSON.stringify(row)).join('\n') + '\n')
  for (const command of ['verify', 'analyze']) {
    const result = spawnSync(process.execPath, [resolve(exported, 'cli.mjs'), command], { encoding: 'utf8', timeout: 30000 })
    await writeFile(resolve(out, command + '.stdout'), result.stdout || ''); await writeFile(resolve(out, command + '.stderr'), result.stderr || '')
    assert.equal(result.status, 0, result.stderr)
  }
  async function compare(directory = '') {
    for (const entry of await readdir(resolve(report, directory), { withFileTypes: true })) {
      const file = directory ? directory + '/' + entry.name : entry.name
      if (entry.isDirectory()) await compare(file)
      else {
        const bytes = await readFile(resolve(report, file))
        assert.deepEqual(await readFile(resolve(exported, 'results', file)), bytes, file)
        parity.push({ file, bytes: bytes.length, sha256: await sha256(bytes) })
      }
    }
  }
  await compare()
  results.push('Actual Research Freeze retains exact17node project and45pins; Import evidence accepts the operational information observation and exports byte-identical GUI/CLI reports without a new collection or grade')
  const wrong = structuredClone(events), altered = wrong.find(row => row.type === 'finished' && row.status === 'completed')
  altered.grade = { ...altered.grade, ...gradeInterpretations(project.tasks[0], [], 'json'), trace: [] }
  await upload('import-evidence', { projectSha256: project.sha256, events: wrong }); await settled('The retained native trace has the wrong observation profile')
  assert.deepEqual(JSON.parse(await readFile(await download('export-evidence', 'after-refused-import.json'))), retained)
  await writeFile(resolve(out, 'wrong-profile-refusal.txt'), await f('status').textContent())
  await f('results').screenshot({ path: resolve(out, 'retained-results.png') })
  results.push('A counterfactual wrong-profile array is refused by actual evidence import; the prior complete evidence and recomputed summary remain unchanged')
  assert.deepEqual(errors, []); assert.equal(externalRequests, 0)
  await writeFile(resolve(out, 'qualification.json'), JSON.stringify({ results, projectSha256: project.sha256, pins, parity,
    importedCompletedTrials: 1, newRecordedTrials: 0, cliVerify: 1, cliAnalyze: 1, providerCalls: 0, nativeRuns: 0, graderCalls: 0, externalRequests }, null, 2) + '\n')
} catch (error) {
  if (page) {
    await page.screenshot({ path: resolve(out, 'failure.png'), fullPage: true }).catch(() => {})
    await writeFile(resolve(out, 'failure.json'), JSON.stringify({ error: error.stack, status: await page.locator('[data-bench-status]').textContent().catch(() => null) }, null, 2))
  }
  throw error
} finally { await writeFile(resolve(out, 'results.json'), JSON.stringify({ results, errors, externalRequests }, null, 2) + '\n'); await browser.close() }
