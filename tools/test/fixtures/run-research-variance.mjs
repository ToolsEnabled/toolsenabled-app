import { openResearchProject } from './research-project-picker.mjs'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { genericStarter } from '../../../src/benchmark/starters.mjs'
const { chromium } = createRequire(import.meta.url)(process.env.MC_PLAYWRIGHT_ROOT)
const out = resolve(process.env.BENCHMARK_TEST_OUTPUT || 'variance-browser-proof')
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true }), errors = []
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true })
  page.on('pageerror', error => errors.push(error.message))
  const f = name => page.locator(`[data-bench-${name}]`), v = name => page.locator(`[data-var-${name}]`), n = name => page.locator(`[data-nest-${name}]`)
  const tab = name => page.locator(`[data-bench-tab="${name}"]`).click()
  const idle = () => page.waitForFunction(() => document.querySelector('[data-mc="benchmark"]').getAttribute('aria-busy') === 'false')
  const ready = () => page.waitForFunction(() => { const text = document.querySelector('[data-var-text]'); return text?.value.length > 0 && !document.querySelector('[data-var-source-status]').textContent.includes('Reading the original') })
  const mark = async (text, label) => {
    await v('label').fill(label)
    await v('text').evaluate((node, text) => { const start = node.value.indexOf(text); if (start < 0) throw Error('Missing selection: ' + text); node.focus(); node.setSelectionRange(start, start + text.length); node.dispatchEvent(new Event('select')) }, text)
    await v('mark').click()
  }
  const preview = async () => { await v('preview').click(); await page.waitForFunction(() => document.querySelector('[data-var-status]').textContent.includes('Preview ready')) }
  await page.goto(process.env.BENCHMARK_TEST_ORIGIN + '/#/research')
  await page.locator('button[data-research-area="design"]').click()
  const tip = page.getByRole('button', { name: 'Not now', exact: true }); if (await tip.isVisible()) await tip.click()
  await idle()
  await openResearchProject(page); await f('starter').selectOption('lean-bench-snippets-and-compositions'); await f('use-starter').click(); await idle()
  await tab('nesting'); await n('selected').selectOption('BL-08'); await n('variance').click(); await ready()
  assert.equal(await v('source').inputValue(), 'BL-08')
  await v('filter').selectOption('compositions'); await v('target').selectOption('root/strategy_b#1')
  assert.ok((await v('text').inputValue()).length > 30, 'LeanBench nested levels are available')
  await v('name').fill('BL-08 omission study'); await v('whole').click(); await preview()
  assert.ok((await v('result').textContent()).length < (await v('original').textContent()).length)
  await v('save').click(); await idle()
  assert.match(await v('status').textContent(), /reusable variants saved to Nesting/)
  const leanRouting = JSON.parse(await f('routing').inputValue())
  assert.equal(leanRouting.compositions.at(-1).node.composition, 'BL-08')

  const spec = genericStarter(); spec.protocol.grading = { kind: 'json' }
  spec.catalog = [
    { id: 'leaf', version: '1', title: 'Trading instruction', kind: 'atom', role: 'node', text: 'Buy slowly. Sell tomorrow.', semantics: { kind: 'prompt' } },
    { id: 'pair', version: '1', title: 'Two members', kind: 'template', role: 'node', text: 'First: {{slot:a}}\nSecond: {{slot:b}}\nRepeat: {{slot:a}}', slots: { a: 'node', b: 'node' }, semantics: { kind: 'prompt' } },
  ]
  spec.tasks = [{ id: 'base', root: { use: 'pair', slots: { a: { use: 'leaf' }, b: { use: 'leaf' } } }, input: null, expected: null, split: 'development' }]
  const file = resolve(out, 'source-draft.json'); await writeFile(file, JSON.stringify({ spec, editors: {} }))
  await openResearchProject(page); await f('import').setInputFiles(file); await idle(); await tab('library')
  await page.locator('[data-bench-select-snippet="0"]').click(); await idle()
  await f('vary-snippet').click(); await idle(); await ready()
  assert.equal(await v('kind').inputValue(), 'snippet')
  await v('name').fill('Missing exit'); await mark('Sell tomorrow.', 'Exit detail'); await preview()
  assert.equal(await v('result').textContent(), 'Buy slowly. ')
  assert.equal(await v('original').locator('del').textContent(), 'Sell tomorrow.')
  await v('save').click(); await idle()
  assert.match(await v('status').textContent(), /reusable variants saved to Snippets/)
  assert.equal(await f('task').locator('option').count(), 1, 'saving a reusable variant does not generate tasks')
  await tab('library'); await page.locator('[data-bench-select-snippet="2"]').click(); await idle()
  await page.waitForFunction(() => document.querySelector('[data-bench-snippet-variant-text]').textContent === 'Buy slowly. ')
  await tab('nesting'); await n('from-snippets').click()
  const routing = JSON.parse(await f('routing').inputValue()), mixedIndex = routing.compositions.length - 1
  const cname = n('connection-editor').locator(`[data-routing-composition-name="${mixedIndex}"]`)
  await cname.fill('Mixed'); await cname.press('Tab')
  await n('connection-editor').locator(`[data-routing-use="${mixedIndex}:"]`).selectOption('snippet:pair')
  await n('connection-editor').locator(`[data-routing-use="${mixedIndex}:a"]`).selectOption('snippet:variance-snippet-1')
  await n('connection-editor').locator(`[data-routing-use="${mixedIndex}:b"]`).selectOption('snippet:leaf')
  await page.waitForFunction(() => document.querySelector('[data-nest-preview]').textContent.includes('Repeat: Buy slowly.'))
  assert.equal((await n('preview').textContent()).match(/Sell tomorrow/g).length, 1)
  await n('variance').click(); await ready()
  await v('name').fill('Composition omission'); await v('filter').selectOption('snippets'); await v('target').selectOption('root/b#1')
  await mark('Buy slowly.', 'One member entry'); await preview()
  const variantText = await v('result').textContent()
  assert.equal(variantText.match(/Buy slowly/g).length, 2)
  assert.equal(variantText.match(/Sell tomorrow/g).length, 1)
  await page.locator('[data-bench-panel="variance"]').evaluate(node => node.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: resolve(out, 'variance-desktop.png') })
  await page.setViewportSize({ width: 850, height: 1000 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2))
  await page.locator('[data-var-comparison]').evaluate(node => node.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: resolve(out, 'variance-narrow.png') })
  await page.setViewportSize({ width: 1440, height: 1100 })
  await v('save').click(); await idle()
  const variantName = JSON.parse(await f('routing').inputValue()).compositions.at(-1).name
  await tab('nesting'); await n('new').click()
  for (const name of ['Mixed', variantName]) { await n('search').fill(name); await n('palette').getByRole('button', { name: 'Add ' + name, exact: true }).click() }
  await n('name').fill('Full nest'); await n('save').click(); await idle()
  await n('task').click(); await idle()
  assert.equal(await f('task').locator('option').count(), 2)
  await n('variance').click(); await ready()
  await v('name').fill('Full nest omission'); await v('filter').selectOption('compositions'); await v('target').selectOption('root/member_2#1')
  await v('whole').click(); await preview(); await v('generate').click(); await idle()
  assert.match(await v('status').textContent(), /1 variance tasks added; 1 existing tasks reused/)
  assert.equal(await f('task').locator('option').count(), 3)
  const waiting = page.waitForEvent('download'); await f('draft-export').click(); const download = await waiting
  const exported = resolve(out, 'variance-draft.json'); await download.saveAs(exported)
  const retained = JSON.parse(await readFile(exported, 'utf8'))
  assert.equal(retained.spec.catalog[0].text, spec.catalog[0].text)
  assert.ok(retained.spec.catalog[2].promptOmissions)
  assert.ok(retained.spec.tasks.at(-1).promptOmissions)
  assert.ok(JSON.parse(retained.editors['data-bench-variance-draft']).studies.length >= 3)
  await f('new-empty').click(); await idle(); await openResearchProject(page); await f('import').setInputFiles(exported); await idle(); await tab('variance'); await ready()
  assert.equal(await v('name').inputValue(), 'Full nest omission')
  assert.equal(await page.locator('[data-var-enabled]').count(), 1)
  assert.deepEqual(errors, [])
  const result = { pass: true, leanBenchNestedSelection: true, reusableSnippet: true, mixedOriginalAndVariant: true, compositionOmission: true, fullNestOmission: true, retainedDraft: true, existingControlReused: true, taskCount: 3, errors }
  await writeFile(resolve(out, 'results.json'), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result))
} finally { await browser.close() }
