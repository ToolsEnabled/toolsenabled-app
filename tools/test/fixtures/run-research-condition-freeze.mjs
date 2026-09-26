import { openResearchProject } from './research-project-picker.mjs'
// Actual renderer authoring control. No collection, provider or native execution.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { genericStarter, newExperimentDraft } from '../../../src/benchmark/starters.mjs'
import { canonical, sha256 } from '../../../src/benchmark/prompts.mjs'
import { RUNTIME_FILES } from '../../../src/benchmark/study.mjs'
import { assertCollectionAdmission } from '../../../src/benchmark/readiness.mjs'

assert.ok(process.env.MC_PLAYWRIGHT_ROOT)
const { chromium } = createRequire(import.meta.url)(process.env.MC_PLAYWRIGHT_ROOT)
const origin = process.env.BENCHMARK_TEST_ORIGIN || 'http://127.0.0.1:4716'
const out = resolve(process.env.BENCHMARK_TEST_OUTPUT || 'condition-freeze-browser-evidence')
await mkdir(out, { recursive: true })
const initial = newExperimentDraft(genericStarter(), { initializePopulation: true })
initial.id = 'condition-freeze-browser'
initial.name = 'Offline condition field continuation control'
initial.conditions[0].model.settings = { temperature: 0.1, enabled: false, nullable: null, literal: '0' }
initial.conditions.push({ ...structuredClone(initial.conditions[0]), id: 'recorded-b' })
initial.conditions[1].model.settings.temperature = 0.25
initial.decisions = 'Synthetic authoring control only. No provider, recorded trial or native process is run.'
const results = [], errors = [], pins = [], browser = await chromium.launch({ headless: true })
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
  const c = name => page.locator('[data-condition-fields-' + name + ']')
  const tab = name => page.locator('[data-bench-tab="' + name + '"]').click()
  const settled = text => page.waitForFunction(text => document.querySelector('[data-bench-status]').textContent.startsWith(text), text)
  async function download(action, name) {
    const wait = page.waitForEvent('download'); await f(action).click()
    const file = await wait, path = resolve(out, name); await file.saveAs(path); return path
  }
  const draft = async name => JSON.parse(await readFile(await download('draft-export', name)))
  const fields = async () => JSON.parse(await f('condition-fields').inputValue())
  await openResearchProject(page); await f('import').setInputFiles({ name: 'source.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ spec: initial })) })
  await settled('Draft imported'); await tab('protocol')
  await f('prepare-condition-fields').click(); await settled('Condition fields prepared')
  await f('apply-condition-fields').click(); await settled('Condition setup applied')
  const before = await draft('before-first-freeze.json'), beforeFields = await fields()
  const selected = beforeFields.rows.find(row => row.id === 'recorded-b').key
  await c('row').selectOption(selected)
  const temperatureIndex = beforeFields.rows.find(row => row.key === selected).model.settings.findIndex(row => row.key === 'temperature')
  assert.ok(temperatureIndex >= 0)
  const temperature = c('setting-row').nth(temperatureIndex).locator('[data-condition-fields-setting-text]')
  assert.equal(await temperature.inputValue(), '0.25')
  await tab('run'); await f('freeze').click(); await settled('Project frozen')
  assert.equal(await f('export-evidence').isDisabled(), true)
  const frozen = await draft('after-first-freeze.json'), frozenFields = await fields()
  const withoutPins = structuredClone(frozen.spec); delete withoutPins.runtimeSources
  assert.deepEqual(withoutPins, before.spec)
  assert.equal(Object.hasOwn(before.spec, 'runtimeSources'), false)
  assert.deepEqual(frozenFields, { ...beforeFields, binding: frozenFields.binding })
  assert.notEqual(frozenFields.binding, beforeFields.binding)
  assert.deepEqual(JSON.parse(frozenFields.binding).spec, frozen.spec)
  for (const key of ['conditions', 'workflow-config', 'observation-plan']) {
    assert.equal(frozen.editors['data-bench-' + key], before.editors['data-bench-' + key])
  }
  assert.deepEqual(frozen.pending, [])
  const zip = await download('export', 'project.zip'), exported = resolve(out, 'exported-project')
  const unpack = spawnSync('python3', ['-c', 'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;z.extractall(sys.argv[2])', zip, exported], { encoding: 'utf8' })
  assert.equal(unpack.status, 0, unpack.stderr)
  const project = JSON.parse(await readFile(resolve(exported, 'project.json')))
  for (const name of RUNTIME_FILES) {
    const digest = await sha256(await readFile(new URL('../../../src/benchmark/' + name, import.meta.url)))
    assert.equal(project.spec.runtimeSources[name], digest)
    assert.equal(await sha256(await readFile(resolve(exported, name))), digest)
    pins.push({ name, sha256: digest })
  }
  const verification = spawnSync(process.execPath, [resolve(exported, 'cli.mjs'), 'verify'], { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 })
  await writeFile(resolve(out, 'verify.stdout'), verification.stdout || '')
  await writeFile(resolve(out, 'verify.stderr'), verification.stderr || '')
  assert.equal(verification.status, 0, verification.stderr)
  assert.throws(() => assertCollectionAdmission(project), /independent-oracle-required/)
  results.push('First Freeze changes only45runtime pins and field binding; expert buffers, selected row and pristine field values survive a CLI-verified runnable export, with collection admission unchanged')

  await tab('protocol')
  assert.equal(await c('row').inputValue(), selected)
  assert.equal(await temperature.isDisabled(), false)
  assert.equal(await temperature.inputValue(), '0.25')
  await temperature.fill('0.6')
  const pending = await draft('after-model-edit.json')
  assert.deepEqual(pending.spec, frozen.spec); assert.ok(pending.pending.includes('conditionFields'))
  await tab('run'); await f('freeze').click(); await settled('Apply the pending editor changes')
  assert.deepEqual(await draft('pending-freeze-refused.json'), pending)
  await tab('protocol'); await f('apply-condition-fields').click(); await settled('Condition setup applied')
  const applied = await draft('applied-model-edit.json')
  assert.equal(applied.spec.conditions[1].model.settings.temperature, 0.6)
  assert.equal(applied.spec.conditions[0].model.settings.temperature, 0.1)
  assert.deepEqual(applied.spec.conditions[1].model.settings, { temperature: 0.6, enabled: false, nullable: null, literal: '0' })
  assert.deepEqual(applied.pending, []); assert.equal(await f('export-evidence').isDisabled(), true)
  await c('model').screenshot({ path: resolve(out, 'after-freeze-model-edit.png') })
  results.push('After first Freeze/Export the same selected row accepts numeric0.25→0.6; typedfalse/null/string0 and the other condition are unchanged, while pending edits still refuse Freeze')

  await tab('compose'); await f('undo').click(); await settled('Previous draft restored')
  const undone = await draft('undo-model-apply.json')
  assert.deepEqual(undone.spec, pending.spec)
  assert.equal(undone.editors['data-bench-condition-fields'], pending.editors['data-bench-condition-fields'])
  assert.ok(undone.pending.includes('conditionFields'))
  await tab('protocol'); await f('conditions').fill((await f('conditions').inputValue()) + '\n')
  const stale = await draft('raw-stale-before.json')
  await f('apply-condition-fields').click(); await settled('Condition fields are stale')
  assert.equal(canonical(await draft('raw-stale-after.json')), canonical(stale))
  results.push('Undo restores exact pending field text and applied source; independent expert JSON whitespace still rejects Apply atomically')
  assert.deepEqual(errors, []); assert.equal(externalRequests, 0)
  await writeFile(resolve(out, 'qualification.json'), JSON.stringify({ results, projectSha256: project.sha256, pins, cliVerify: 1,
    externalRequests, providerCalls: 0, nativeRuns: 0, recordedTrials: 0, localModuleCalls: 0 }, null, 2) + '\n')
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
