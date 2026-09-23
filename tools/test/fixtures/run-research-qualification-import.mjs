import { openResearchProject } from './research-project-picker.mjs'
// Actual-page import of retained synthetic arithmetic qualification evidence.
// This driver collects no responses and executes no interpreter or provider.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { sha256 } from '../../../src/benchmark/prompts.mjs'
import { RUNTIME_FILES } from '../../../src/benchmark/study.mjs'
const { chromium } = createRequire(import.meta.url)(process.env.MC_PLAYWRIGHT_ROOT)
const origin = process.env.BENCHMARK_TEST_ORIGIN || 'http://127.0.0.1:4728'
const out = resolve(process.env.BENCHMARK_TEST_OUTPUT)
const fixture = JSON.parse(await readFile(process.env.BENCHMARK_TEST_FIXTURE)), { project, events } = fixture
assert.equal(project.version, 2); assert.equal(project.spec.executionPlan.purpose, 'apparatus-development')
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true }), errors = [], checks = [], parity = [], pins = []
let page, outside = 0
function unpack(zip, directory) {
  const result = spawnSync('python3', ['-c', 'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;z.extractall(sys.argv[2])', zip, directory], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}
try {
  page = await browser.newPage({ viewport: { width: 1400, height: 1050 }, acceptDownloads: true })
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', async route => { if (new URL(route.request().url()).origin !== origin) { outside++; await route.abort() } else await route.continue() })
  await page.goto(origin + '/tools/test/fixtures/research-workflow.html?mode=available'); await page.waitForFunction(() => window.auditReady)
  await openResearchProject(page, { account: true }); await page.locator('[data-project-select]').selectOption('rp-' + 'a'.repeat(36))
  const f = name => page.locator('[data-bench-' + name + ']')
  const settle = async prefix => { await page.waitForFunction(prefix => document.querySelector('[data-bench-status]').textContent.startsWith(prefix), prefix); await page.waitForFunction(() => document.querySelector('[data-mc="benchmark"]').getAttribute('aria-busy') === 'false') }
  const upload = (name, value) => f(name).setInputFiles({ name: 'synthetic-qualification.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) })
  async function download(name, path) {
    const wait = page.waitForEvent('download'); await f(name).click(); const item = await wait, target = resolve(out, path); await item.saveAs(target); return target
  }
  await upload('import', { spec: project.spec }); await settle('Draft imported')
  await page.locator('[data-bench-tab="run"]').click(); await f('freeze').click(); await settle('Project frozen')
  const exported = resolve(out, 'exported-project'); unpack(await download('export', 'project.zip'), exported)
  assert.deepEqual(JSON.parse(await readFile(resolve(exported, 'project.json'))), project)
  for (const name of RUNTIME_FILES) {
    const hash = await sha256(await readFile(new URL('../../../src/benchmark/' + name, import.meta.url)))
    assert.equal(project.spec.runtimeSources[name], hash); assert.equal(await sha256(await readFile(resolve(exported, name))), hash); pins.push({ name, sha256: hash })
  }
  await upload('import-evidence', { projectSha256: project.sha256, events }); await settle('Evidence imported')
  const good = JSON.parse(await readFile(await download('export-evidence', 'accepted-evidence.json')))
  assert.deepEqual(good.events, events); assert.equal(good.summary.completed, 1)
  assert.equal(good.summary.execution.experimentalCollection, 'not-admitted')
  const report = resolve(out, 'gui-report'); unpack(await download('export-report', 'report.zip'), report)
  await mkdir(resolve(exported, 'results')); await writeFile(resolve(exported, 'results/attempts.jsonl'), events.map(row => JSON.stringify(row)).join('\n') + '\n')
  for (const command of ['verify', 'analyze']) {
    const result = spawnSync(process.execPath, [resolve(exported, 'cli.mjs'), command], { encoding: 'utf8', timeout: 30000 })
    await writeFile(resolve(out, command + '.stdout'), result.stdout || ''); await writeFile(resolve(out, command + '.stderr'), result.stderr || ''); assert.equal(result.status, 0, result.stderr)
  }
  async function compare(directory = '') {
    for (const entry of await readdir(resolve(report, directory), { withFileTypes: true })) {
      const name = directory ? directory + '/' + entry.name : entry.name
      if (entry.isDirectory()) await compare(name)
      else { const bytes = await readFile(resolve(report, name)); assert.deepEqual(await readFile(resolve(exported, 'results', name)), bytes); parity.push({ file: name, bytes: bytes.length, sha256: await sha256(bytes) }) }
    }
  }
  await compare(); checks.push('Valid modern preparation imports through the actual page and retains identical GUI/CLI reports and 45 frozen source pins')
  const altered = structuredClone(events)
  const proof = altered.find(row => row.type === 'qualification').record.requirements.targets[0].probes[0].wrongReadings[0].shrink
  assert.ok(proof.attempts.length); proof.attempts[0].inputSha256 = 'f'.repeat(64)
  await upload('import-evidence', { projectSha256: project.sha256, events: altered }); await settle('A shrink candidate digest differs')
  assert.deepEqual(JSON.parse(await readFile(await download('export-evidence', 'after-refused-import.json'))), good)
  await writeFile(resolve(out, 'refusal.txt'), await f('status').textContent()); await f('results').screenshot({ path: resolve(out, 'preserved-evidence.png') })
  checks.push('Changing only a retained shrink candidate digest refuses before publication and preserves the exact preceding evidence and summary')
  assert.deepEqual(errors, []); assert.equal(outside, 0)
  await writeFile(resolve(out, 'qualification.json'), JSON.stringify({ checks, projectSha256: project.sha256, parity, pins, importedSavedCompletions: 1, newCollections: 0, interpreterRuns: 0, nativeRuns: 0, providerCalls: 0, externalRequests: outside }, null, 2) + '\n')
} catch (error) {
  if (page) { await page.screenshot({ path: resolve(out, 'failure.png'), fullPage: true }).catch(() => {}); await writeFile(resolve(out, 'failure.json'), JSON.stringify({ error: error.stack, status: await page.locator('[data-bench-status]').textContent().catch(() => null) }, null, 2)) }
  throw error
} finally { await writeFile(resolve(out, 'results.json'), JSON.stringify({ checks, errors, externalRequests: outside }, null, 2) + '\n'); await browser.close() }
