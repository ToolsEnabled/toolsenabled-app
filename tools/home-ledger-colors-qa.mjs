import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'
import { defaultHomeStatusColors } from '../src/home-status-colors.js'

// The labelled example supplies controlled ledger records. Only data feeds
// are substituted; Home's polling, severity, Settings and GPU renderer run
// unchanged. No provider or owner-decision writes are made.
/* REFUSE BY NAME. Run without its output directory this script used to die
   inside path.resolve with "The paths[0] argument must be of type string" --
   a raw Node stack that named neither the script nor what it wanted, which is
   the silent-skip shape this codebase keeps re-finding. Both preconditions now
   say what is missing and exit 2 (a refusal, distinct from a failed check). */
const usage = 'usage: node tools/home-ledger-colors-qa.mjs <output-dir> [origin]   (origin defaults to http://127.0.0.1:4623 and must be loopback)'
function refuse (reason) {
  console.error(`home-ledger-colors-qa: REFUSED -- ${reason}
${usage}`)
  process.exit(2)
}
if (typeof process.argv[2] !== 'string' || !process.argv[2].trim()) refuse('no output directory was given; every capture and the report.json need somewhere to land')
const output = path.resolve(process.argv[2])
const origin = process.argv[3] || 'http://127.0.0.1:4623'
let originHost = null
try { originHost = new URL(origin).hostname } catch { refuse(`the origin '${origin}' is not a URL`) }
if (!['127.0.0.1', 'localhost', '[::1]'].includes(originHost)) refuse(`the origin '${origin}' is not loopback; this walk drives a local dev server only`)
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.routeWebSocket(url => url.host === new URL(origin).host && url.searchParams.has('token'), socket => socket.close())
for (const [file, exported, expression] of [
  ['sample-ledger.js', 'sampleLedgerData', '({ ...originalSample(nowMs), requests: window.qaLedgerRecords })'],
  ['approvals-example.js', 'exampleOwnerPrompts', 'window.qaOwnerPrompts'],
]) {
  await context.route(`**/src/${file}`, async route => {
    const response = await route.fetch()
    const source = (await response.text()).replace(`export function ${exported}(`, 'function originalSample(')
    assert.ok(source.includes('function originalSample('))
    await route.fulfill({ response, body: `${source}\nexport function ${exported}(nowMs = Date.now()) { return ${expression} }\n` })
  })
}
await context.addInitScript(() => {
  localStorage.setItem('mc.example', 'on')
  window.qaLedgerRecords = [{ id: 'T1', status: 'in-progress' }]
  window.qaOwnerPrompts = []
  for (const kind of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
    const proto = window[kind]?.prototype
    if (!proto) continue
    const names = new WeakMap(), lookup = proto.getUniformLocation, uniform = proto.uniform3fv
    proto.getUniformLocation = function (program, name) { const location = lookup.call(this, program, name); if (location) names.set(location, name); return location }
    proto.uniform3fv = function (location, values) {
      if (names.get(location) === 'uLight' && this.canvas.classList.contains('home-circle-fluid')) window.qaFluidColor = Array.from(values)
      return uniform.call(this, location, values)
    }
  }
})
const page = await context.newPage(), report = { checks: [], errors: [], method: 'Controlled example ledger data, real Home/Settings controls and WebGL renderer, headless Edge.' }
page.on('pageerror', error => report.errors.push(error.message))
async function home() {
  await page.locator('a[href="#/"]').first().click()
  await page.locator('.home-circle').waitFor({ state: 'visible' })
}
async function settings(query = 'Home circle') {
  await page.locator('a[href="#/settings"]').first().click()
  const tip = page.getByRole('button', { name: 'Not now', exact: true })
  if (await tip.isVisible()) await tip.click()
  await page.getByRole('searchbox', { name: 'Search all settings' }).fill(query)
}
async function save() {
  await page.locator('[data-settings-save]').click()
  await page.waitForFunction(() => document.querySelector('[data-settings-save-state]')?.dataset.settingsSaveState === 'saved')
}
async function status(expected, hex, { fluid = true, timeout = 10000 } = {}) {
  await page.waitForFunction(expected => document.querySelector('.home')?.dataset.ledgerStatus === expected, expected, { timeout })
  const got = await page.evaluate(() => {
    const ring = document.querySelector('.home-circle')
    return { status: ring.dataset.ledgerStatus, color: getComputedStyle(ring).getPropertyValue('--core-status-color').trim(), label: document.querySelector('[data-home-ledger-status]').textContent, canvas: ring.querySelectorAll('canvas').length }
  })
  assert.equal(got.status, expected)
  if (hex) assert.equal(got.color.toLowerCase(), hex)
  if (fluid && hex) {
    const rgb = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
    await page.waitForFunction(rgb => window.qaFluidColor?.every((value, index) => Math.abs(value - rgb[index]) < .005), rgb)
  }
  return got
}
async function records(items) {
  await page.evaluate(items => { window.qaLedgerRecords = items }, items)
  await settings()
  await home()
}
async function color(status, hex) {
  await page.locator(`[data-setting-id="home_circle_${status}_color"] input[type="color"]`).evaluate((input, hex) => {
    input.value = hex
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, hex)
}
async function theme(name) {
  await settings('Theme')
  await page.locator(`[data-setting-id="theme"] [data-setting-value="${name}"]`).click()
  if (await page.locator('[data-settings-save]').isEnabled()) await save()
  await home()
}
try {
  await page.goto(`${origin}/#/`, { waitUntil: 'load' })
  await page.locator('.home-circle').waitFor({ state: 'visible' })
  await status('clear', defaultHomeStatusColors('white').clear)
  assert.match(await page.locator('[data-panel-badge]').textContent(), /Example/i)
  report.checks.push('Ordinary in-progress tasks are clear; fixture remains visibly labelled Example')

  await records([{ id: 'A1', status: 'open' }, { id: 'R1', status: 'proposed' }])
  await status('attention', defaultHomeStatusColors('white').attention)
  assert.match(await page.locator('[data-home-ledger-status]').textContent(), /2 owner requests/)
  await page.screenshot({ path: path.join(output, 'yellow-home.png') })
  await page.evaluate(() => { window.qaCanvas = document.querySelector('.home-circle canvas'); window.qaLedgerRecords.push({ id: 'T2', status: 'blocked-external' }) })
  await status('blocked', defaultHomeStatusColors('white').blocked, { timeout: 30000 })
  assert.equal(await page.evaluate(() => window.qaCanvas === document.querySelector('.home-circle canvas')), true)
  report.checks.push('Existing owner-queue poll raises yellow to red without replacing the fluid canvas')

  for (const name of ['white', 'tan', 'black', 'ember', 'cobalt']) {
    await theme(name)
    await status('blocked', defaultHomeStatusColors(name).blocked)
    await records([{ id: 'A1', status: 'open' }])
    await status('attention', defaultHomeStatusColors(name).attention)
    await records([{ id: 'A1', status: 'answered' }, { id: 'T2', status: 'done' }])
    await status('clear', defaultHomeStatusColors(name).clear)
    await records([{ id: 'T2', status: 'blocked-external' }])
    await page.screenshot({ path: path.join(output, `red-${name}.png`) })
    report.checks.push(`${name}: default clear/yellow/red reach both the frame and actual fluid palette`)
  }

  await settings()
  assert.equal(await page.locator('input[data-setting-color]').count(), 3)
  await color('blocked', '#ab5678')
  assert.equal(await page.evaluate(() => localStorage.getItem('mc.set.home_circle_blocked_color.cobalt')), null)
  await page.locator('[data-settings-discard]').click()
  await page.locator('[data-setting-id="home_circle_blocked_color"]').waitFor()
  assert.equal(await page.locator('[data-setting-id="home_circle_blocked_color"] input').inputValue(), defaultHomeStatusColors('cobalt').blocked)
  const custom = { clear: '#329e8e', attention: '#b89636', blocked: '#c16c83' }
  for (const [name, value] of Object.entries(custom)) await color(name, value)
  await page.screenshot({ path: path.join(output, 'custom-settings.png') })
  await save()
  await home()
  await status('blocked', custom.blocked)
  await records([{ id: 'A1', status: 'open' }]); await status('attention', custom.attention)
  await records([]); await status('clear', custom.clear)
  await page.reload({ waitUntil: 'load' }); await status('clear', custom.clear)
  await theme('tan'); await status('clear', defaultHomeStatusColors('tan').clear)
  await theme('cobalt'); await status('clear', custom.clear)
  report.checks.push('Three independent pickers honor Discard/Save and retain custom choices separately for each theme through reload')

  await page.locator('#open-settings').click()
  assert.equal(await page.locator('[data-home-color]').count(), 3)
  assert.equal(await page.locator('[data-home-colors-theme]').textContent(), 'Cobalt')
  await page.locator('[data-home-color="clear"]').evaluate(input => {
    input.value = '#66c8ba'; input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await status('clear', '#66c8ba')
  await page.locator('#theme-seg [data-theme="ember"]').click()
  await status('clear', defaultHomeStatusColors('ember').clear)
  assert.equal(await page.locator('[data-home-color="clear"]').inputValue(), defaultHomeStatusColors('ember').clear)
  await page.locator('[data-home-color="attention"]').evaluate(input => {
    input.value = '#efc785'; input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await page.screenshot({ path: path.join(output, 'quick-colors-ember.png') })
  await page.locator('#theme-seg [data-theme="cobalt"]').click()
  await status('clear', '#66c8ba')
  await page.locator('[data-home-color-reset="clear"]').click()
  await status('clear', defaultHomeStatusColors('cobalt').clear)
  await page.locator('#close-settings').click()
  await page.locator('#open-settings').click()
  assert.equal(await page.locator('[data-home-color="blocked"]').inputValue(), custom.blocked)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: path.join(output, 'quick-colors-narrow.png') })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
  await page.locator('#close-settings').click()
  await page.setViewportSize({ width: 1440, height: 900 })
  report.checks.push('Home Quick Settings changes colors immediately, updates on theme choice, restores defaults, persists on reopening, and fits a narrow screen')

  await settings()
  for (const name of Object.keys(custom)) await page.locator(`[data-setting-id="home_circle_${name}_color"] [data-setting-value="auto"]`).click()
  await save()
  await home(); await status('clear', defaultHomeStatusColors('cobalt').clear)
  await settings()
  await page.locator('[data-setting-id="home_circle_style"] [data-setting-value="simple"]').click()
  await save(); await home()
  const simple = await status('clear', defaultHomeStatusColors('cobalt').clear, { fluid: false })
  assert.equal(simple.canvas, 0)
  await records([{ id: 'T2', status: 'blocked-external' }])
  await status('blocked', defaultHomeStatusColors('cobalt').blocked, { fluid: false })
  await records([{ id: 'R1', status: 'unrecognized' }])
  await status('unknown', null, { fluid: false })
  assert.match(await page.locator('[data-home-ledger-status]').textContent(), /unavailable/)
  await page.locator('[data-home-ledger-status]').click()
  await page.waitForURL('**/#/ledger')
  report.checks.push('Reset restores theme defaults; Simple uses the same severity with no canvas; unknown stays neutral; status link opens Ledger')
  assert.deepEqual(report.errors, [])
} catch (error) {
  report.failure = error.stack
  process.exitCode = 1
} finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  await page.screenshot({ path: path.join(output, 'last.png') }).catch(() => {})
  await browser.close()
  console.log(JSON.stringify(report, null, 2))
}
