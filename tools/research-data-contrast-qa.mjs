// Check the real Research workspace in an isolated browser across every theme.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const origin = process.env.RESEARCH_QA_URL || 'http://127.0.0.1:4623'
const temp = process.platform === 'win32' ? 'C:/Users/ToolsEnabled-Dev/AppData/Local/Temp' : process.env.RESEARCH_QA_TEMP
if (!temp) throw new Error('Set RESEARCH_QA_TEMP on Linux.')
const resolved = await realpath(temp)
if (process.platform === 'win32' && !resolved.toLowerCase().replaceAll('\\', '/').startsWith('c:/users/toolsenabled-dev/')) throw new Error('QA temp boundary refused.')
process.env.TEMP = resolved; process.env.TMP = resolved
const output = await mkdtemp(path.join(resolved, 'research-data-contrast-qa-'))
const executablePath = process.platform === 'win32' ? 'C:/Users/ToolsEnabled-Dev/AppData/Local/ms-playwright/chromium-1148/chrome-win/chrome.exe' : undefined
const browser = await chromium.launch({ headless: true, executablePath })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 }, timezoneId: 'America/Los_Angeles' }), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(origin + '/#/research', { waitUntil: 'domcontentloaded', timeout: 60000 })
  const dismiss = page.getByRole('button', { name: 'Not now', exact: true })
  await dismiss.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
  if (await dismiss.isVisible()) await dismiss.click()
  await page.locator('button[data-research-area="data"]').click()
  await page.locator('[data-rd-grid] tbody tr').first().waitFor()
  await page.locator('[data-rd-resource]').filter({ hasText: /^Option quotes/ }).click()
  await page.waitForFunction(() => document.querySelector('.rd-workspace')?.getAttribute('aria-busy') === 'false' && document.querySelector('[data-rd-grid] tbody tr'))

  const measure = async samples => page.evaluate(samples => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    const rgba = color => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data] }
    const blend = (over, under) => over.slice(0, 3).map((value, index) => value * over[3] / 255 + under[index] * (1 - over[3] / 255))
    const luminance = rgb => rgb.map(value => { value /= 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4 }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
    return samples.map(({ name, selector, pseudo, minimum = 4.5 }) => {
      const element = document.querySelector(selector)
      if (!element) throw new Error('Missing contrast sample: ' + selector)
      const ancestors = []; for (let item = element; item; item = item.parentElement) ancestors.unshift(item)
      let background = [255, 255, 255]
      for (const item of ancestors) background = blend(rgba(getComputedStyle(item).backgroundColor), background)
      const style = getComputedStyle(element, pseudo || null)
      const foreground = blend(rgba(element instanceof SVGElement ? style.fill : style.color), background)
      const a = luminance(foreground), b = luminance(background)
      return { name, foreground, background, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), fontSize: style.fontSize, minimum }
    })
  }, samples)
  const common = [
    { name: 'data cell', selector: '[data-rd-grid] tbody td .rd-cell-value', minimum: 7 },
    { name: 'column name', selector: '[data-rd-grid] thead th:nth-child(2)', minimum: 7 },
    { name: 'column type', selector: '[data-rd-grid] thead th:nth-child(2) small' },
    { name: 'missing value', selector: '.rd-null' },
    { name: 'data file dropdown', selector: '[data-rd-part]', minimum: 7 },
    { name: 'search value', selector: '[data-rd-search]', minimum: 7 },
    { name: 'search placeholder', selector: '[data-rd-search]', pseudo: '::placeholder' },
    { name: 'validation message', selector: '[data-rd-validation]' },
    { name: 'import button', selector: '[data-rd-import]', minimum: 7 },
    { name: 'open folder button', selector: '[data-rd-open]' },
    { name: 'selected sheet', selector: '[data-rd-resource][aria-pressed="true"] span', minimum: 7 },
    { name: 'selected sheet details', selector: '[data-rd-resource][aria-pressed="true"] small' },
    { name: 'file browser', selector: '[data-rd-entry] span:nth-child(2)', minimum: 7 },
  ]
  const themes = []
  for (const theme of ['white', 'tan', 'black', 'ember', 'cobalt']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
    await page.mouse.move(220, 20)
    const samples = await measure(common)
    await page.locator('[data-rd-grid] tbody td').first().hover()
    samples.push(...await measure([{ name: 'hovered data row', selector: '[data-rd-grid] tbody td .rd-cell-value', minimum: 7 }]))
    await page.locator('[data-rd-open]').hover()
    samples.push(...await measure([{ name: 'hovered primary button', selector: '[data-rd-open]' }]))
    await page.locator('[data-rd-resource][aria-pressed="true"]').hover()
    samples.push(...await measure([{ name: 'hovered selected sheet', selector: '[data-rd-resource][aria-pressed="true"] span', minimum: 7 }]))
    for (const sample of samples) assert.ok(sample.ratio >= sample.minimum, `${theme}: ${sample.name} is ${sample.ratio.toFixed(2)}:1`)
    assert.equal(samples[0].fontSize, '14px')
    await page.locator('.rd-heading').scrollIntoViewIfNeeded()
    await page.mouse.move(220, 20)
    await page.screenshot({ path: path.join(output, `sheet-${theme}.png`), fullPage: true })
    themes.push({ theme, samples })
  }
  await page.locator('[data-rd-search]').fill(await page.locator('[data-rd-grid] tbody td').first().textContent())
  await page.locator('[data-rd-search-go]').click()
  await page.waitForFunction(() => document.querySelector('.rd-workspace')?.getAttribute('aria-busy') === 'false')
  await page.locator('[data-rd-tab="chart"]').click()
  await page.locator('[data-rd-chart] svg').waitFor()
  // Switch themes while a chart is already open, without rebuilding the sheet.
  for (const record of themes) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, record.theme)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    record.chart = await measure([{ name: 'chart labels', selector: '[data-rd-chart] svg text', minimum: 7 }])
    for (const sample of record.chart) assert.ok(sample.ratio >= sample.minimum, `${record.theme}: chart labels are ${sample.ratio.toFixed(2)}:1`)
    await page.locator('[data-rd-chart-panel]').scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(output, `chart-${record.theme}.png`), fullPage: true })
  }
  assert.deepEqual(errors, [])
  const report = { ok: true, output, origin, themes, errors }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ ok: true, output, themes: themes.map(record => ({ theme: record.theme, minimumTextContrast: Math.min(...record.samples.map(sample => sample.ratio)), chartContrast: record.chart[0].ratio })) }, null, 2))
} finally { await browser.close() }
