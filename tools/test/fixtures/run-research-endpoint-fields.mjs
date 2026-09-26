import { openResearchProject } from './research-project-picker.mjs'
// Actual browser flow for the labeled typed-endpoint fields: add, edit and
// remove endpoints, refuse unfinished input without losing the draft, reapply,
// save and remount, freeze/export, then CLI/report parity on identical evidence.
// Synthetic recorded responses only; every off-origin request is aborted.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { developmentStarter } from './research-benchmark-development.mjs'

const { chromium } = createRequire(import.meta.url)(process.env.MC_PLAYWRIGHT_ROOT)
const origin = process.env.BENCHMARK_TEST_ORIGIN || 'http://127.0.0.1:4833', out = resolve(process.env.BENCHMARK_TEST_OUTPUT || 'endpoint-fields-browser-evidence')
await mkdir(out, { recursive: true })
const results = [], errors = [], checks = []
const check = (name, ok) => { checks.push(name); assert.ok(ok, name) }
// Saved drafts are canonical JSON (sorted keys); compare structure, not key order.
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b))
const unzip = (zip, dir) => { const r = spawnSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; z.extractall(sys.argv[2])', zip, dir], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr) }
// A draft whose second task has no recorded response: its trials fail, so a
// proportion over `passed` is only partially observed.
const draft = developmentStarter()
draft.id = 'endpoint-fields-controls'; draft.name = 'Typed endpoint field controls'
draft.conditions[0].adapter.responses = { 'addition-a': '5' }
draft.protocol.replicates = 2; draft.protocol.maxAttemptsPerTrial = 1; draft.protocol.maxTotalAttempts = 8
draft.analysisPlan.primaryPopulation = 'all'
delete draft.runtimeSources
const EXPECTED_IDS = ['bytes', 'latency', 'throughput', 'pass-share']
const browser = await chromium.launch({ headless: true })
let outside = 0
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true })
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', async route => { if (new URL(route.request().url()).origin !== origin) { outside++; await route.abort() } else await route.continue() })
  await page.goto(origin + '/tools/test/fixtures/research-workflow.html?mode=available'); await page.waitForFunction(() => window.auditReady === true)
  await openResearchProject(page, { account: true }); await page.locator('[data-project-select]').selectOption('rp-' + 'a'.repeat(36))
  await page.waitForFunction(() => document.querySelector('[data-bench-scope]').textContent.startsWith('Selected project'))
  const f = name => page.locator('[data-bench-' + name + ']'), c = name => page.locator('[data-endpoint-fields-' + name + ']'), tab = name => page.locator('[data-bench-tab="' + name + '"]').click()
  const status = () => f('status').textContent()
  const settled = async prefix => { try { await page.waitForFunction(prefix => document.querySelector('[data-bench-status]').textContent.startsWith(prefix), prefix, { timeout: 60000 }) } catch { throw new Error('Expected status "' + prefix + '" but saw: ' + await status()) } }
  const download = async name => { const wait = page.waitForEvent('download'); await f(name).click(); return wait }
  const specJson = async () => JSON.parse(await f('spec-json').inputValue())
  const rows = async () => JSON.parse(await f('endpoint-fields').inputValue())
  await openResearchProject(page); await f('import').setInputFiles({ name: 'draft.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ spec: draft })) }); await settled('Draft imported')
  await tab('analysis')
  check('the labeled endpoint editor is mounted and visible', await c('editor').isVisible() && await c('add').isVisible())
  check('no endpoint is declared at first', /No typed endpoints are declared/.test(await c('count').textContent()))
  const add = async ({ id, kind, source, unit, direction = 'higher-better', exposurePath, exposureUnit, cap, rationale }) => {
    await c('add').click(); await c('id').fill(id); await c('kind').selectOption(kind); await c('source').fill(source); await c('unit').fill(unit); await c('direction').selectOption(direction)
    if (exposurePath) { await c('exposure-path').fill(exposurePath); await c('exposure-unit').selectOption(exposureUnit) }
    if (cap !== undefined) await c('cap').fill(cap)
    await c('rationale').fill(rationale)
  }
  await add({ id: 'bytes', kind: 'count', source: 'response.outputBytes', unit: 'bytes', rationale: 'Bytes of each returned answer.' })
  await add({ id: 'latency', kind: 'duration', source: 'elapsedMs', unit: 'ms', direction: 'lower-better', rationale: 'Attempt time.' })
  // Reviewer-reproduced defect: type the identifier keystroke by keystroke, not with a bulk fill.
  await c('add').click(); await c('id').pressSequentially('throughput', { delay: 20 })
  check('an identifier typed key by key is retained in full', await c('id').inputValue() === 'throughput' && (await rows()).at(-1).id === 'throughput')
  const focusedAfterTyping = await c('id').evaluate(node => node === document.activeElement)
  const caretAfterTyping = await c('id').evaluate(node => ({ start: node.selectionStart, end: node.selectionEnd, length: node.value.length }))
  check('after typing, the identifier input keeps focus with the caret collapsed at the end', focusedAfterTyping && caretAfterTyping.start === caretAfterTyping.length && caretAfterTyping.end === caretAfterTyping.length)
  check('the identifier input is not disabled while typing', await c('id').isDisabled() === false)
  // Move the caret with the keyboard and insert a character mid-string; both the value and the caret position must reflect the insertion point, not an append.
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft')
  await page.keyboard.type('X', { delay: 20 })
  const midEdit = await c('id').evaluate(node => ({ value: node.value, start: node.selectionStart, end: node.selectionEnd }))
  check('a caret move plus a keystroke inserts the character at the caret, not at the end', midEdit.value === 'throughXput' && midEdit.start === 8 && midEdit.end === 8)
  // Reviewer-reproduced defect class also covers deletion, not only insertion, at a mid-string caret.
  await page.keyboard.press('Backspace')
  const afterBackspace = await c('id').evaluate(node => ({ value: node.value, start: node.selectionStart, end: node.selectionEnd }))
  check('deleting the inserted character at the caret restores the identifier with the caret at the deletion point, not at the end', afterBackspace.value === 'throughput' && afterBackspace.start === 7 && afterBackspace.end === 7)
  await c('id').fill('throughput')
  check('the identifier disabled state is unchanged by typing and caret movement', await c('id').isDisabled() === false)
  await c('kind').selectOption('rate'); await c('source').fill('response.outputBytes'); await c('unit').fill('bytes per ms'); await c('exposure-path').fill('elapsedMs'); await c('exposure-unit').selectOption('ms'); await c('rationale').fill('Bytes over attempt time.')
  check('the exposure fields are visible for a rate endpoint and the cap field is hidden', await c('exposure').isVisible() && !(await c('cap-field').isVisible()))
  await add({ id: 'stall', kind: 'event-time', source: 'elapsedMs', cap: '12e', unit: 'ms', direction: 'lower-better', rationale: 'Unfinished cap.' })
  check('the cap field is visible for an event-time endpoint', await c('cap-field').isVisible())
  check('the editor counts four declared rows', /4 typed endpoints declared/.test(await c('count').textContent()))
  const before = await rows(); await f('apply-analysis').click()
  await page.waitForFunction(() => /censoring cap must be a whole number/.test(document.querySelector('[data-bench-status]').textContent))
  check('a refused apply keeps all four rows and the unfinished cap text', JSON.stringify(await rows()) === JSON.stringify(before) && await c('cap').inputValue() === '12e')
  check('a refused apply leaves the applied plan without endpoints', (await specJson()).analysisPlan.endpoints === undefined)
  await c('remove').click()
  check('removing the unfinished endpoint leaves three rows', (await rows()).length === 3)
  await add({ id: 'pass-share', kind: 'proportion', source: 'passed', unit: 'share', rationale: 'Share of trials that passed among trials with a graded answer.' })
  await c('row-fields').screenshot({ path: resolve(out, 'endpoint-fields-desktop.png') })
  await f('apply-analysis').click(); await settled('Analysis plan applied with 4 typed endpoints')
  const applied = (await specJson()).analysisPlan.endpoints
  check('exactly the four named endpoints are applied, in field order', JSON.stringify(applied.map(endpoint => endpoint.id)) === JSON.stringify(EXPECTED_IDS))
  check('the rate endpoint carries its exposure and the count endpoint none', JSON.stringify(applied[2].exposure) === JSON.stringify({ path: ['elapsedMs'], unit: 'ms' }) && applied[0].exposure === undefined)
  await f('analysis-rationale').fill('Reapplied with a changed rationale only.'); await f('apply-analysis').click(); await settled('Analysis plan applied with 4 typed endpoints')
  check('reapplying the plan keeps the same four endpoints', same((await specJson()).analysisPlan.endpoints, applied))
  await f('save').click(); await settled('Draft saved')
  await page.evaluate(() => window.audit.remount())
  await page.waitForFunction(() => document.querySelector('[data-mc="benchmark"]')?.getAttribute('aria-busy') === 'false' && document.querySelector('[data-bench-id]')?.value === 'endpoint-fields-controls')
  await tab('analysis')
  const remounted = { endpoints: (await specJson()).analysisPlan.endpoints, rows: (await rows()).length, fieldsVisible: await c('row-fields').isVisible(), editorVisible: await c('editor').isVisible(), status: await status() }
  await writeFile(resolve(out, 'after-remount.json'), JSON.stringify(remounted, null, 2) + '\n')
  check('after a remount the four endpoints are still applied', same(remounted.endpoints, applied))
  check('after a remount the retained field draft still lists four rows', remounted.rows === 4)
  check('after a remount the labeled fields are mounted and visible with nonzero size', remounted.fieldsVisible && (await c('row-fields').boundingBox())?.height > 0)
  // Reviewer-reproduced defect: after a real page reload, a restored draft's row keys must not collide with a new row.
  const exportedDraft = resolve(out, 'draft-before-reload.json'); await (await download('draft-export')).saveAs(exportedDraft)
  await page.reload(); await page.waitForFunction(() => window.auditReady === true)
  await openResearchProject(page, { account: true }); await page.locator('[data-project-select]').selectOption('rp-' + 'a'.repeat(36))
  await page.waitForFunction(() => document.querySelector('[data-bench-scope]').textContent.startsWith('Selected project'))
  await openResearchProject(page); await f('import').setInputFiles(exportedDraft); await settled('Draft imported')
  await tab('analysis')
  const restoredRows = await rows()
  check('after a real reload the imported draft restores the four rows with their keys', restoredRows.length === 4 && new Set(restoredRows.map(row => row.key)).size === 4)
  // Selecting each restored row after the reload shows its own values, not another row's; a selection
  // change alone does not edit the draft, so this is read-only with respect to the rows below.
  for (const row of restoredRows) {
    await c('row').selectOption(row.key)
    check('after the reload, selecting restored row "' + row.id + '" shows its own identifier and source', await c('id').inputValue() === row.id && await c('source').inputValue() === row.source)
  }
  // Editing one restored row after the reload must change only that row, leaving its siblings untouched, then revert it.
  await c('row').selectOption(restoredRows[0].key)
  await c('rationale').fill('Edited after reload, to be reverted.')
  const afterEdit = await rows()
  check('editing one restored row after the reload changes only that row', afterEdit.find(row => row.key === restoredRows[0].key).rationale === 'Edited after reload, to be reverted.' &&
    restoredRows.slice(1).every(row => same(afterEdit.find(candidate => candidate.key === row.key), row)))
  await c('rationale').fill(restoredRows[0].rationale)
  await c('add').click()
  const withNew = await rows()
  check('a row added after the reload gets a key no restored row holds', withNew.length === 5 && new Set(withNew.map(row => row.key)).size === 5)
  const newKey = withNew.find(row => !restoredRows.some(restored => restored.key === row.key)).key
  check('the newly added row after the reload is selected', await c('row').inputValue() === newKey)
  await c('row').selectOption(newKey)
  await c('remove').click()
  check('removing the new row after the reload leaves exactly the four restored rows, unchanged by the edit-and-revert above', same(await rows(), restoredRows))
  // The edits above left the draft's `analysis` field marked pending; reapply so freezing is not blocked, and confirm the applied plan is unaffected.
  await f('apply-analysis').click(); await settled('Analysis plan applied with 4 typed endpoints')
  check('reapplying after the post-reload edits keeps the same four endpoints', same((await specJson()).analysisPlan.endpoints, applied))
  await page.setViewportSize({ width: 390, height: 844 })
  check('the fields fit a 390px viewport without horizontal overflow', !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)))
  await c('editor').screenshot({ path: resolve(out, 'endpoint-fields-narrow.png') })
  await page.setViewportSize({ width: 1440, height: 1100 })
  await tab('run'); await f('freeze').click(); await settled('Project frozen')
  await page.waitForFunction(() => !document.querySelector('[data-bench-run]').disabled)
  await f('run').click(); await page.waitForFunction(() => /of 4 trials completed/.test(document.querySelector('[data-bench-results]').textContent), null, { timeout: 120000 })
  check('the page run completed the two answered trials and failed the two unanswered ones', /2 of 4 trials completed/.test(await f('results').textContent()))
  const zip = resolve(out, 'export.zip'); await (await download('export')).saveAs(zip)
  const exported = resolve(out, 'exported-project'); await mkdir(exported, { recursive: true }); unzip(zip, exported)
  const projectJson = JSON.parse(await readFile(resolve(exported, 'project.json'), 'utf8'))
  check('the exported frozen project declares exactly the four endpoints', JSON.stringify(projectJson.spec.analysisPlan.endpoints.map(endpoint => endpoint.id)) === JSON.stringify(EXPECTED_IDS))
  const cli = args => spawnSync(process.execPath, [resolve(exported, 'cli.mjs'), ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const results_ = resolve(out, 'cli-results')
  check('the exported CLI verifies the project', cli(['verify']).status === 0)
  const run = cli(['run', '--output', results_]); check('the CLI run completes two of four trials (exit 2 marks the incomplete schedule)', run.status === 2 && JSON.parse(run.stdout).completed === 2)
  check('the CLI analysis writes the endpoint tables', cli(['analyze', '--output', results_]).status === 0)
  await f('import-evidence').setInputFiles(resolve(results_, 'evidence.json')); await settled('Evidence imported')
  const reportZip = resolve(out, 'gui-report.zip'); await (await download('export-report')).saveAs(reportZip)
  const guiReport = resolve(out, 'gui-report'); await mkdir(guiReport, { recursive: true }); unzip(reportZip, guiReport)
  const guiTables = (await readdir(resolve(guiReport, 'tables'))).filter(name => name.startsWith('endpoint')).sort(), cliTables = (await readdir(resolve(results_, 'tables'))).filter(name => name.startsWith('endpoint')).sort()
  const expectedTables = [...EXPECTED_IDS.flatMap(id => ['endpoint-conditions-' + id + '.csv', 'endpoint-strata-' + id + '.csv']), 'endpoints-records.csv', 'endpoints-replicates.csv'].sort()
  check('both surfaces produce exactly the expected endpoint tables (' + expectedTables.length + ')', JSON.stringify(guiTables) === JSON.stringify(expectedTables) && JSON.stringify(cliTables) === JSON.stringify(expectedTables))
  let compared = 0
  for (const name of [...guiTables.map(name => 'tables/' + name), 'endpoints.json']) {
    const a = await readFile(resolve(guiReport, name)), b = await readFile(resolve(results_, name)); assert.ok(a.equals(b), name + ' differs between page and CLI'); compared++
  }
  check('every endpoint table and the endpoints sidecar are byte-identical between page and CLI (' + compared + ' files)', compared === expectedTables.length + 1)
  const share = JSON.parse(await readFile(resolve(results_, 'endpoints.json'), 'utf8')).groups.find(row => row.endpoint === 'pass-share')
  check('the partially observed proportion counts 2 available values out of 4 scheduled with 2 unavailable', share.scheduled === 4 && share.n === 2 && share.unavailable === 2 && share.k === 2 && share.rate === 1 && share.scheduledRate === 0.5)
  const bytes = JSON.parse(await readFile(resolve(results_, 'endpoints.json'), 'utf8')).groups.find(row => row.endpoint === 'bytes')
  check('the count endpoint totals the bytes of the two answers', bytes.n === 2 && bytes.total === 2 && bytes.unavailable === 2)
  const latency = JSON.parse(await readFile(resolve(results_, 'endpoints.json'), 'utf8')).groups.find(row => row.endpoint === 'latency')
  check('the duration endpoint has two observed values with a finite mean', latency.n === 2 && Number.isFinite(latency.mean) && latency.mean >= 0)
  const report = await readFile(resolve(guiReport, 'report.md'), 'utf8')
  check('the report states the binary and proportion denominators accurately', /Binary estimates follow the frozen scheduled denominator/.test(report) && /Proportion estimates are the observed share k \\?\/ n/.test(report))
  results.push(...checks)
} finally {
  await browser.close()
  await writeFile(resolve(out, 'results.json'), JSON.stringify({ checks: results, errors, outsideRequests: outside }, null, 2) + '\n')
  console.log(JSON.stringify({ checks: results.length, errors, outsideRequests: outside }, null, 2))
}
assert.equal(errors.length, 0); assert.equal(outside, 0)
