import { openResearchProject } from './research-project-picker.mjs'
// Actual browser flow for the labeled grouped-assignment design fields: mounted
// and visible controls, field edits, refusal without losing the draft, apply,
// save and remount, freeze/export, then CLI/report parity on identical evidence.
// Synthetic recorded responses only; every off-origin request is aborted.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { genericStarter } from '../../../src/benchmark/starters.mjs'
import { developmentDraft } from './research-benchmark-development.mjs'

const { chromium } = createRequire(import.meta.url)(process.env.MC_PLAYWRIGHT_ROOT)
const origin = process.env.BENCHMARK_TEST_ORIGIN || 'http://127.0.0.1:4833', out = resolve(process.env.BENCHMARK_TEST_OUTPUT || 'design-fields-browser-evidence')
await mkdir(out, { recursive: true })
const results = [], errors = [], checks = []
const check = (name, ok) => { checks.push(name); assert.ok(ok, name) }
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b))
const unzip = (zip, dir) => { const r = spawnSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; z.extractall(sys.argv[2])', zip, dir], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr) }
// Six tasks over three sites, two per site; the isolation condition answers wrong on the third site.
const draft = developmentDraft(genericStarter()), template = draft.tasks[0]
draft.id = 'design-fields-controls'; draft.name = 'Grouped design field controls'
draft.tasks = ['s1', 's2', 's3'].flatMap((site, s) => [1, 2].map(member => ({ ...structuredClone(template), id: `${site}-t${member}`, familyId: site, split: s < 2 ? 'development' : 'held-out', variables: { a: s + 1, b: member * 10 }, expected: String(s + 1 + member * 10), factors: { site, member: 'm' + member } })))
const all = Object.fromEntries(draft.tasks.map(task => [task.id, task.expected])), flawed = Object.fromEntries(draft.tasks.map(task => [task.id, task.factors.site === 's3' ? 'wrong' : task.expected]))
draft.conditions = [{ ...draft.conditions[0], id: 'seq', adapter: { kind: 'replay', responses: all } }, { ...draft.conditions[0], id: 'iso', adapter: { kind: 'replay', responses: flawed } }]
draft.protocol.replicates = 5; draft.protocol.maxTotalAttempts = 1000; draft.analysisPlan.primaryPopulation = 'all'; draft.analysisPlan.uncertainty = null
delete draft.runtimeSources
const expectedPlan = { version: 1, rationale: 'Two arms over three sites with two colliding tasks each; a two-draw pilot on two sites before a three-draw main phase.',
  arms: [{ id: 'sequential', conditionIds: ['seq'], label: 'One task at a time' }, { id: 'isolation', conditionIds: ['iso'] }],
  unit: { kind: 'draw', groupBy: 'factor:site', members: 2 },
  phases: [{ id: 'pilot', draws: 2, factorLevels: { site: ['s1', 's2'] } }, { id: 'main', draws: 3, requiresRecordedDecision: 'pilot' }],
  contrasts: [{ id: 'isolation-vs-sequential', first: 'isolation', second: 'sequential' }] }
const browser = await chromium.launch({ headless: true })
let outside = 0
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true })
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', async route => { if (new URL(route.request().url()).origin !== origin) { outside++; await route.abort() } else await route.continue() })
  await page.goto(origin + '/tools/test/fixtures/research-workflow.html?mode=available'); await page.waitForFunction(() => window.auditReady === true)
  await openResearchProject(page, { account: true }); await page.locator('[data-project-select]').selectOption('rp-' + 'a'.repeat(36))
  await page.waitForFunction(() => document.querySelector('[data-bench-scope]').textContent.startsWith('Selected project'))
  const f = name => page.locator('[data-bench-' + name + ']'), d = name => page.locator('[data-design-fields-' + name + ']'), tab = name => page.locator('[data-bench-tab="' + name + '"]').click()
  const status = () => f('status').textContent()
  const settled = async prefix => { try { await page.waitForFunction(prefix => document.querySelector('[data-bench-status]').textContent.startsWith(prefix), prefix, { timeout: 60000 }) } catch { throw new Error('Expected status "' + prefix + '" but saw: ' + await status()) } }
  const download = async name => { const wait = page.waitForEvent('download'); await f(name).click(); return wait }
  const specPlan = async () => JSON.parse(await f('spec-json').inputValue()).designPlan
  const visible = async locator => { const box = await locator.boundingBox(); return await locator.isVisible() && !!box && box.width > 0 && box.height > 0 }
  await openResearchProject(page); await f('import').setInputFiles({ name: 'draft.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ spec: draft })) }); await settled('Draft imported')
  await tab('analysis')
  // The design section is a collapsed disclosure; a person opens it first.
  await page.getByText('Grouped assignment design (arms, draws, phases)', { exact: true }).click()
  check('the design editor and its switch are mounted, visible and have nonzero size', await visible(d('editor')) && await visible(d('present')))
  check('no design is declared at first', (await specPlan()) === undefined && /No design is declared/.test(await d('summary').textContent()))
  await d('present').check()
  check('switching the design on mounts the arm, unit, phase and contrast fieldsets', await visible(d('arms')) && await visible(d('unit')) && await visible(d('phases')) && await visible(d('contrasts')))
  await d('rationale').fill(expectedPlan.rationale)
  await d('add-arm').click()
  // syncDesignFields staleness (research-benchmark.js): the first arm added
  // after an import with no design plan must show THIS project's conditions
  // right away, not whatever project the harness page had mounted before it.
  const firstArmConditionIds = await d('arm').nth(0).locator('[data-design-fields-arm-condition]').evaluateAll(boxes => boxes.map(box => box.getAttribute('data-design-fields-arm-condition')))
  check('the first arm added after import shows this project\'s conditions (seq, iso), not a stale project\'s', JSON.stringify(firstArmConditionIds.slice().sort()) === JSON.stringify(['iso', 'seq']))
  await d('add-arm').click()
  check('two arm rows are mounted', await d('arm').count() === 2)
  // Reviewer-reproduced defect class: type the first arm identifier keystroke by keystroke.
  const firstArmId = d('arm').nth(0).locator('[data-design-fields-arm-id]')
  await firstArmId.pressSequentially('sequential', { delay: 20 })
  check('an arm identifier typed key by key is retained in full', (await firstArmId.inputValue()) === 'sequential')
  check('the typed input still has focus after typing', await firstArmId.evaluate(el => document.activeElement === el))
  check('the caret sits at the end of the typed text with no selection', await firstArmId.evaluate(el => el.selectionStart === el.value.length && el.selectionEnd === el.value.length))
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft')
  await page.keyboard.type('X', { delay: 20 })
  check('typing after moving the caret left inserts at the caret, not at the end', (await firstArmId.inputValue()) === 'sequentXial')
  check('the input keeps focus and the caret sits right after the inserted character', await firstArmId.evaluate(el => document.activeElement === el && el.selectionStart === 8 && el.selectionEnd === 8))
  await firstArmId.fill('sequential')
  await d('arm').nth(0).locator('[data-design-fields-arm-label]').fill('One task at a time'); await d('arm').nth(0).locator('[data-design-fields-arm-condition="seq"]').check()
  await d('arm').nth(1).locator('[data-design-fields-arm-id]').fill('isolation'); await d('arm').nth(1).locator('[data-design-fields-arm-condition="iso"]').check()
  await d('unit-enabled').check(); await d('unit-factor').selectOption('site'); await d('unit-members').fill('x')
  await d('add-phase').click(); await d('add-phase').click()
  check('two phase rows are mounted with one level list per task factor', await d('phase').count() === 2 && await d('phase').nth(0).locator('[data-design-fields-phase-levels]').count() === 2)
  await d('phase').nth(0).locator('[data-design-fields-phase-id]').fill('pilot'); await d('phase').nth(0).locator('[data-design-fields-phase-draws]').fill('2'); await d('phase').nth(0).locator('[data-design-fields-phase-levels]').nth(1).fill('s1, s2')
  await d('phase').nth(1).locator('[data-design-fields-phase-id]').fill('main'); await d('phase').nth(1).locator('[data-design-fields-phase-draws]').fill('3'); await d('phase').nth(1).locator('[data-design-fields-phase-decision]').selectOption('pilot')
  await d('add-contrast').click()
  await d('contrast-id').fill('isolation-vs-sequential'); await d('contrast-first').selectOption('isolation'); await d('contrast-second').selectOption('sequential')
  check('the summary counts the declared rows', /2 arms, draw unit on site, 2 phases, 1 contrast/.test(await d('summary').textContent()))
  const rowsBefore = await f('design-fields').inputValue()
  await f('apply-design').click(); await page.waitForFunction(() => /members per draw must be a whole number/.test(document.querySelector('[data-bench-status]').textContent))
  check('a refused apply keeps every field row and the unfinished members text', (await f('design-fields').inputValue()) === rowsBefore && (await d('unit-members').inputValue()) === 'x')
  check('a refused apply leaves the draft without a design', (await specPlan()) === undefined)
  await d('unit-members').fill('2')
  await d('editor').screenshot({ path: resolve(out, 'design-fields-desktop.png') })
  await f('apply-design').click(); await settled('Design plan applied')
  check('the applied design equals the expected contract exactly', same(await specPlan(), expectedPlan))
  await f('save').click(); await settled('Draft saved')
  await page.evaluate(() => window.audit.remount())
  await page.waitForFunction(() => document.querySelector('[data-mc="benchmark"]')?.getAttribute('aria-busy') === 'false' && document.querySelector('[data-bench-id]')?.value === 'design-fields-controls')
  await tab('analysis'); await page.getByText('Grouped assignment design (arms, draws, phases)', { exact: true }).click()
  const remounted = { plan: await specPlan(), arms: await d('arm').count(), phases: await d('phase').count(), contrasts: await d('contrast').count(), factor: await d('unit-factor').inputValue(), members: await d('unit-members').inputValue(), status: await f('design-fields-status').textContent() }
  await writeFile(resolve(out, 'after-remount.json'), JSON.stringify(remounted, null, 2) + '\n')
  check('after a remount the design is still applied and the fields show it', same(remounted.plan, expectedPlan) && remounted.arms === 2 && remounted.phases === 2 && remounted.contrasts === 1 && remounted.factor === 'site' && remounted.members === '2')
  check('after a remount the fields are mounted, visible and have nonzero size', await visible(d('arms')) && await visible(d('phases')))
  // Reviewer-reproduced defect class: after a real page reload, a restored draft's row keys must not collide with a new row.
  const exportedDraft = resolve(out, 'draft-before-reload.json'); await (await download('draft-export')).saveAs(exportedDraft)
  await page.reload(); await page.waitForFunction(() => window.auditReady === true)
  await openResearchProject(page, { account: true }); await page.locator('[data-project-select]').selectOption('rp-' + 'a'.repeat(36))
  await page.waitForFunction(() => document.querySelector('[data-bench-scope]').textContent.startsWith('Selected project'))
  await openResearchProject(page); await f('import').setInputFiles(exportedDraft); await settled('Draft imported')
  await tab('analysis'); await page.getByText('Grouped assignment design (arms, draws, phases)', { exact: true }).click()
  check('after a real reload the imported draft restores the applied design and its two arms', same(await specPlan(), expectedPlan) && await d('arm').count() === 2)
  await d('add-arm').click(); await d('add-phase').click(); await d('add-contrast').click()
  const fieldsAfterAdd = () => f('design-fields').inputValue().then(JSON.parse)
  const keysAfterAdd = await fieldsAfterAdd().then(rows => [...rows.arms, ...rows.phases, ...rows.contrasts].map(row => row.key))
  check('an arm, a phase and a contrast added after the reload each get a key no restored row holds', keysAfterAdd.length === 8 && new Set(keysAfterAdd).size === 8)
  // Editing the newly added rows must not touch the restored rows' own data.
  await d('arm').nth(2).locator('[data-design-fields-arm-id]').fill('extra'); await d('arm').nth(2).locator('[data-design-fields-arm-label]').fill('Extra')
  await d('phase').nth(2).locator('[data-design-fields-phase-id]').fill('extra-phase')
  await d('contrast').nth(1).locator('[data-design-fields-contrast-id]').fill('extra-contrast')
  const editedFields = await fieldsAfterAdd()
  check('editing the newly added arm leaves the two restored arms\' identifiers and labels unchanged', JSON.stringify(editedFields.arms.slice(0, 2).map(row => [row.id, row.label])) === JSON.stringify([['sequential', 'One task at a time'], ['isolation', '']]))
  check('editing the newly added phase leaves the two restored phases unchanged', JSON.stringify(editedFields.phases.slice(0, 2).map(row => row.id)) === JSON.stringify(['pilot', 'main']))
  check('editing the newly added contrast leaves the restored contrast unchanged', editedFields.contrasts[0].id === 'isolation-vs-sequential')
  // Removing each newly added row removes only that row.
  await d('remove-arm').nth(2).click(); await d('remove-phase').nth(2).click(); await d('remove-contrast').nth(1).click()
  const afterRemove = await fieldsAfterAdd()
  check('removing the new arm, phase and contrast leaves exactly the restored rows', JSON.stringify(afterRemove.arms.map(row => row.id)) === JSON.stringify(['sequential', 'isolation'])
    && JSON.stringify(afterRemove.phases.map(row => row.id)) === JSON.stringify(['pilot', 'main']) && afterRemove.contrasts.length === 1 && afterRemove.contrasts[0].id === 'isolation-vs-sequential')
  // The add/remove experiment above left unapplied field edits pending; apply
  // them back (they now describe exactly the restored rows again) so freezing
  // below is not blocked by a pending design edit.
  await f('apply-design').click(); await settled('Design plan applied')
  check('reapplying after the add/remove experiment still equals the expected contract exactly', same(await specPlan(), expectedPlan))
  await page.setViewportSize({ width: 390, height: 844 })
  check('the fields fit a 390px viewport without horizontal overflow', !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)))
  await d('editor').screenshot({ path: resolve(out, 'design-fields-narrow.png') })
  await page.setViewportSize({ width: 1440, height: 1100 })
  await tab('run'); await f('freeze').click(); await settled('Project frozen')
  await page.waitForFunction(() => !document.querySelector('[data-bench-run]').disabled)
  await f('run').click(); await page.waitForFunction(() => /52 of 52 trials completed/.test(document.querySelector('[data-bench-results]').textContent), null, { timeout: 180000 })
  check('the page schedules and completes the 52 design trials (8 pilot trials of the third site are unscheduled)', /52 of 52 trials completed/.test(await f('results').textContent()))
  const zip = resolve(out, 'export.zip'); await (await download('export')).saveAs(zip)
  const exported = resolve(out, 'exported-project'); await mkdir(exported, { recursive: true }); unzip(zip, exported)
  const design = JSON.parse(await readFile(resolve(exported, 'design', 'plan.json'), 'utf8')), schedule = JSON.parse(await readFile(resolve(exported, 'schedule.json'), 'utf8'))
  check('the export retains design/plan.json with 26 units, 52 scheduled trials and 8 excluded identities', design.units === 26 && design.scheduled === 52 && design.excludedTrials.length === 8 && schedule.length === 52 && schedule.every(row => row.unitId && row.armId && row.phase))
  const cli = args => spawnSync(process.execPath, [resolve(exported, 'cli.mjs'), ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const results_ = resolve(out, 'cli-results')
  check('the exported CLI verifies the project including its design artifact', cli(['verify']).status === 0)
  const run = cli(['run', '--output', results_]); check('the CLI run completes all 52 trials', run.status === 0 && JSON.parse(run.stdout).completed === 52)
  check('the CLI analysis writes the design tables', cli(['analyze', '--output', results_]).status === 0)
  await f('import-evidence').setInputFiles(resolve(results_, 'evidence.json')); await settled('Evidence imported')
  const reportZip = resolve(out, 'gui-report.zip'); await (await download('export-report')).saveAs(reportZip)
  const guiReport = resolve(out, 'gui-report'); await mkdir(guiReport, { recursive: true }); unzip(reportZip, guiReport)
  const guiTables = (await readdir(resolve(guiReport, 'tables'))).filter(name => name.startsWith('design')).sort(), cliTables = (await readdir(resolve(results_, 'tables'))).filter(name => name.startsWith('design')).sort()
  const expectedTables = ['design-arm-contrasts.csv', 'design-arms.csv', 'design-phases.csv', 'design-units.csv']
  check('both surfaces produce exactly the four design tables', JSON.stringify(guiTables) === JSON.stringify(expectedTables) && JSON.stringify(cliTables) === JSON.stringify(expectedTables))
  let compared = 0
  for (const name of [...expectedTables.map(name => 'tables/' + name), 'design.json']) { const a = await readFile(resolve(guiReport, name)), b = await readFile(resolve(results_, name)); assert.ok(a.equals(b), name + ' differs between page and CLI'); compared++ }
  check('the four design tables and design.json are byte-identical between page and CLI (' + compared + ' files)', compared === 5)
  const summary = JSON.parse(await readFile(resolve(results_, 'design.json'), 'utf8'))
  check('the arm ledger shows 26 sequential passes and 20 isolation passes over 26 scheduled each', JSON.stringify(summary.arms.map(row => [row.arm, row.scheduled, row.passed])) === JSON.stringify([['sequential', 26, 26], ['isolation', 26, 20]]))
  check('the draw ledger has 26 units of two members and the phases record 16 pilot and 36 main trials with a not-evaluated main decision', summary.units.length === 26 && summary.units.every(unit => unit.members === 2) && JSON.stringify(summary.phases.map(row => [row.phase, row.scheduled, row.decision])) === JSON.stringify([['pilot', 16, null], ['main', 36, 'not-evaluated']]))
  const report = await readFile(resolve(guiReport, 'report.md'), 'utf8')
  check('the report states that draw times are arithmetic over retained member observations', /arithmetic over the retained member attempt observations/.test(report))
  results.push(...checks)
} finally {
  await browser.close()
  await writeFile(resolve(out, 'results.json'), JSON.stringify({ checks: results, errors, outsideRequests: outside }, null, 2) + '\n')
  console.log(JSON.stringify({ checks: results.length, errors, outsideRequests: outside }, null, 2))
}
assert.equal(errors.length, 0); assert.equal(outside, 0)
