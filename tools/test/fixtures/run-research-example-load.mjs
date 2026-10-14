import { openResearchProject } from './research-project-picker.mjs'
// Browser regression for loading a bundled draft through Vite's module pipeline.
// Node-only imports cannot catch a browser's JSON-module MIME type rejection.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

assert.ok(process.env.MC_PLAYWRIGHT_ROOT, 'MC_PLAYWRIGHT_ROOT must name the installed Playwright kit')
assert.ok(process.env.BENCHMARK_TEST_ORIGIN, 'BENCHMARK_TEST_ORIGIN must name the preview to verify')
const { chromium } = createRequire(import.meta.url)(process.env.MC_PLAYWRIGHT_ROOT)
const out = resolve(process.env.BENCHMARK_TEST_OUTPUT || 'example-load-browser-evidence')
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true })
const errors = [], requested = []
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => requested.push(request.url()))
  await page.goto(process.env.BENCHMARK_TEST_ORIGIN + '/#/research')
  await page.locator('button[data-research-area="design"]').click()
  const field = name => page.locator(`[data-bench-${name}]`)
  await page.waitForFunction(() => document.querySelector('[data-mc="benchmark"]')?.getAttribute('aria-busy') === 'false')
  assert.equal(await field('task').locator('option').count(), 0, 'a fresh workspace stays empty')
  assert.ok(!requested.some(url => /research-lean-example|lean-bench-example-draft/.test(url)), 'the large example is not loaded at startup')
  await openResearchProject(page); await field('starter').selectOption('lean-bench-snippets-and-compositions')
  await field('use-starter').click()
  await page.waitForFunction(() => document.querySelector('[data-mc="benchmark"]').getAttribute('aria-busy') === 'false')
  assert.match(await field('status').textContent(), /Example draft loaded: Lean Bench/)
  assert.equal(await field('task').locator('option').count(), 41)
  assert.equal(JSON.parse(await field('routing').inputValue()).compositions.length, 66)
  assert.equal(await page.locator('[data-bench-panel="compose"]').isVisible(), true)
  await page.locator('[data-bench-tab="library"]').click()
  assert.equal(await page.locator('[data-bench-select-snippet]').count(), 74)
  assert.equal(await page.locator('[data-bench-panel="library"]').isVisible(), true)
  assert.doesNotMatch(await field('snippet-status').textContent(), /has no snippets/, 'the empty-library message must clear when the example opens')
  await page.locator('[data-bench-panel="library"]').scrollIntoViewIfNeeded()
  await page.screenshot({ path: resolve(out, 'lean-bench-loaded.png') })
  await field('undo').click()
  await page.waitForFunction(() => document.querySelector('[data-mc="benchmark"]').getAttribute('aria-busy') === 'false')
  assert.equal(await field('task').locator('option').count(), 0, 'Undo restores the empty draft')
  assert.deepEqual(errors, [])
  const result = { pass: true, tasks: 41, compositions: 66, snippets: 74, lazy: true, undo: true, pageErrors: errors }
  await writeFile(resolve(out, 'results.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
} finally {
  await browser.close()
}
