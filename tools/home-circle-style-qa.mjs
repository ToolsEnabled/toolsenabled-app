import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const output = path.resolve(process.argv[2] || 'home-circle-style-qa')
const origin = process.argv[3] || 'http://127.0.0.1:4623'
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname))
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.addInitScript(() => {
  if (!localStorage.getItem('home.qa.initialized')) {
    localStorage.setItem('mc.set.home_circle_style', 'simple')
    localStorage.setItem('mc.set.home_circle_motion', 'animate')
    localStorage.setItem('home.qa.initialized', 'true')
  }
  window.circleProbe = { webglRequests: 0, fluidRafRequests: 0 }
  const getContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
    if (/webgl/.test(kind)) window.circleProbe.webglRequests++
    return getContext.call(this, kind, ...args)
  }
  const requestFrame = window.requestAnimationFrame
  window.requestAnimationFrame = function (fn) {
    if (new Error().stack.includes('home-circle-fluid.js')) window.circleProbe.fluidRafRequests++
    return requestFrame.call(this, fn)
  }
})
const page = await context.newPage()
const errors = []
page.on('pageerror', error => errors.push(error.message))
const report = { checks: [] }
const state = () => page.evaluate(() => {
  const ring = document.querySelector('.home-circle')
  return {
    style: ring?.dataset.circleStyle,
    saved: localStorage.getItem('mc.set.home_circle_style'),
    canvas: ring?.querySelectorAll('canvas').length,
    fluid: ring?.homeCircleFluid?.stats() || null,
    reason: ring?.dataset.fluidReason,
    probe: { ...window.circleProbe },
    animations: ring?.getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations === Infinity).length,
  }
})
async function home() {
  await page.locator('a[href="#/"]').first().click()
  await page.locator('.home-circle').waitFor({ state: 'visible' })
}
async function settings() {
  await page.locator('a[href="#/settings"]').first().click()
  const tip = page.getByRole('button', { name: 'Not now', exact: true })
  if (await tip.isVisible()) await tip.click()
  await page.getByRole('searchbox', { name: 'Search all settings' }).fill('Home circle')
  await page.locator('[data-setting-id="home_circle_style"]').waitFor({ state: 'visible' })
}
async function choose(value) {
  await page.locator(`[data-setting-id="home_circle_style"] [data-setting-value="${value}"]`).click()
}
async function save() {
  await page.locator('[data-settings-save]').click()
  await page.waitForFunction(() => document.querySelector('[data-settings-save-state]')?.dataset.settingsSaveState === 'saved')
}
async function sample(label) {
  const cdp = await context.newCDPSession(page)
  await cdp.send('Performance.enable')
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]))
  const before = await metrics(), start = await state()
  await page.waitForTimeout(4000)
  const after = await metrics(), end = await state()
  await cdp.detach()
  report[label] = {
    windowMs: (after.Timestamp - before.Timestamp) * 1000,
    mainThreadTaskMs: (after.TaskDuration - before.TaskDuration) * 1000,
    fluidFrames: end.probe.fluidRafRequests - start.probe.fluidRafRequests,
    state: end,
  }
  return report[label]
}
try {
  await page.goto(`${origin}/#/`, { waitUntil: 'load', timeout: 60000 })
  await page.locator('.home-circle').waitFor()
  const tip = page.getByRole('button', { name: 'Not now', exact: true })
  if (await tip.isVisible()) await tip.click()
  await page.waitForTimeout(1200)
  assert.match(await page.locator('.panel-badge').textContent(), /example/i)
  const simple = await sample('simple')
  assert.equal(simple.state.style, 'simple')
  assert.equal(simple.state.canvas, 0)
  assert.equal(simple.state.fluid, null)
  assert.equal(simple.state.probe.webglRequests, 0)
  assert.equal(simple.state.probe.fluidRafRequests, 0)
  assert.equal(simple.state.animations, 0)
  await page.screenshot({ path: path.join(output, 'simple-white.png') })
  report.checks.push('Simple boots with Animate selected without WebGL, fluid frames, canvas or repeating border animations')

  await settings()
  assert.deepEqual(await page.locator('[data-setting-id="home_circle_style"] [data-setting-value]').allTextContents(), ['Standard', 'Simple'])
  await choose('standard')
  assert.equal(await page.evaluate(() => localStorage.getItem('mc.set.home_circle_style')), 'simple')
  const discardedView = await page.locator('[data-settings-save-state]').elementHandle()
  await page.locator('[data-settings-discard]').click()
  await page.waitForFunction(root => !root.isConnected, discardedView)
  await page.getByRole('searchbox', { name: 'Search all settings' }).fill('Home circle')
  if (await tip.isVisible()) await tip.click()
  await page.waitForFunction(() => document.querySelector('[data-setting-id="home_circle_style"] [data-setting-value="simple"]')?.getAttribute('aria-pressed') === 'true')
  assert.equal(await page.locator('[data-setting-id="home_circle_style"] [data-setting-value="simple"]').getAttribute('aria-pressed'), 'true')
  await choose('standard')
  await save()
  await page.screenshot({ path: path.join(output, 'settings-standard-simple.png') })
  await home()
  await page.waitForFunction(() => document.querySelector('.home-circle')?.homeCircleFluid?.stats().steps > 45, { timeout: 30000 })
  const standard = await sample('standard')
  assert.equal(standard.state.style, 'standard')
  assert.equal(standard.state.canvas, 1)
  assert.ok(standard.fluidFrames > 0)
  await page.screenshot({ path: path.join(output, 'standard-white.png') })
  report.checks.push('Settings offers exactly Standard / Simple; Discard preserves Simple, Save starts Standard')

  await settings()
  await choose('simple')
  await save()
  await home()
  assert.equal((await state()).canvas, 0)
  assert.equal((await state()).fluid, null)
  await page.reload({ waitUntil: 'load' })
  await page.locator('.home-circle').waitFor()
  assert.equal((await state()).style, 'simple')
  assert.equal((await state()).probe.webglRequests, 0)
  report.checks.push('Simple survives Save, navigation and reload without allocating a GPU context')

  // Exercise the same view's settings event, including a rapid reversal
  // before the deferred fluid boot. Old callbacks must never resurrect it.
  await page.evaluate(async () => {
    const choice = await import('/src/home-circle-choice.js')
    choice.setHomeCircleStyle('standard')
  })
  await page.waitForFunction(() => document.querySelector('.home-circle')?.homeCircleFluid?.stats().steps > 10)
  await page.evaluate(async () => {
    window.oldFluid = document.querySelector('.home-circle').homeCircleFluid
    const choice = await import('/src/home-circle-choice.js')
    choice.setHomeCircleStyle('simple')
    window.stepsAtStop = window.oldFluid.stats().steps
  })
  assert.equal((await state()).canvas, 0, 'switch releases canvas synchronously')
  await page.waitForTimeout(800)
  assert.equal(await page.evaluate(() => window.oldFluid.stats().steps), await page.evaluate(() => window.stepsAtStop))
  await page.evaluate(async () => {
    const choice = await import('/src/home-circle-choice.js')
    choice.setHomeCircleStyle('standard')
    choice.setHomeCircleStyle('simple')
  })
  const beforeRace = await state()
  await page.waitForTimeout(1600)
  const afterRace = await state()
  assert.equal(afterRace.canvas, 0)
  assert.equal(afterRace.fluid, null)
  assert.equal(afterRace.probe.webglRequests, beforeRace.probe.webglRequests)
  assert.equal(afterRace.probe.fluidRafRequests, beforeRace.probe.fluidRafRequests)
  report.checks.push('Live switch stops old simulation immediately; rapid toggles cannot resurrect deferred work')

  await page.evaluate(async () => {
    const choice = await import('/src/home-circle-choice.js')
    choice.setHomeCircleMotion('still')
    choice.setHomeCircleStyle('standard')
  })
  await page.waitForTimeout(100)
  assert.equal((await state()).canvas, 0)
  assert.equal((await state()).reason, 'still')
  report.checks.push('Standard continues to honor Still')

  await page.evaluate(async () => (await import('/src/home-circle-choice.js')).setHomeCircleMotion('animate'))
  await page.waitForFunction(() => document.querySelector('.home-circle')?.homeCircleFluid?.stats().steps > 45)
  await page.evaluate(async () => (await import('/src/home-circle-choice.js')).setHomeCircleMotion('still'))
  await page.waitForFunction(() => document.querySelector('.home-circle')?.dataset.fluidReason === 'still')
  await page.evaluate(async () => (await import('/src/home-circle-choice.js')).setHomeCircleStyle('simple'))
  assert.equal((await state()).canvas, 0, 'Simple also removes a canvas already fading out after Still')
  report.checks.push('Still followed by Simple releases the retiring canvas immediately')

  for (const [theme, width, height] of [['black', 1440, 900], ['white', 390, 844]]) {
    await page.evaluate(theme => localStorage.setItem('mc.theme', theme), theme)
    await page.setViewportSize({ width, height })
    await page.reload({ waitUntil: 'load' })
    await page.locator('.home-circle').waitFor()
    await page.waitForTimeout(500)
    await page.screenshot({ path: path.join(output, `simple-${theme}-${width}.png`) })
  }
  assert.deepEqual(errors, [])
  report.passed = true
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  report.passed = false
  report.error = error.stack
  report.state = await state()
  await page.screenshot({ path: path.join(output, 'failure.png') })
  throw error
} finally {
  await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n')
  await browser.close()
}
