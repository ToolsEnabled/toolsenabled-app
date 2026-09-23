// Walks the running hotloaded Research page against the connected research
// folder: captures the Option chains first chart and the excluded-session
// heading at three widths in three themes. Read-only against the page.
//
// Setting the theme remounts the view and returns to the first sheet, so the
// theme is chosen before navigating rather than between screenshots.
import assert from 'node:assert/strict'
import path from 'node:path'
import { chromium } from 'playwright'

const ORIGIN = process.env.RESEARCH_QA_URL || 'http://127.0.0.1:4623'
const OUT = process.argv[2]
if (!OUT) throw new Error('Pass the directory to write screenshots into.')
const WIDTHS = [1440, 760, 390], THEMES = ['black', 'cobalt', 'ember']
const EXCLUDED_FILE = process.env.RESEARCH_WALK_EXCLUDED || 'QQQ_cbbo-1m_2023-12-27'

const browser = await chromium.launch({ headless: true, executablePath: process.env.RESEARCH_QA_CHROMIUM || undefined })
const captured = [], errors = [], seen = []
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
  page.on('pageerror', error => errors.push(error.message))
  const settled = () => page.waitForFunction(() => document.querySelector('.rd-workspace')?.getAttribute('aria-busy') === 'false', null, { timeout: 240000 })

  async function openResearch(theme) {
    await page.setViewportSize({ width: 1440, height: 1100 })
    await page.goto(ORIGIN + '/#/research', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.evaluate(name => { document.documentElement.dataset.theme = name }, theme)
    const dismiss = page.getByRole('button', { name: 'Not now', exact: true })
    await dismiss.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
    if (await dismiss.isVisible()) await dismiss.click()
    await page.locator('button[data-research-area="data"]').click()
    // A reload restores the previously active tab, which may be the chart.
    await page.locator('[data-rd-sheet]').waitFor({ state: 'visible', timeout: 120000 })
    await page.locator('[data-rd-tab="sheet"]').click()
    await page.locator('[data-rd-grid] tbody tr').first().waitFor({ timeout: 120000 })
  }
  async function openSheet(name) {
    await page.setViewportSize({ width: 1440, height: 1100 })
    await page.locator('[data-rd-resource]', { hasText: name }).first().click()
    await page.locator('[data-rd-tab="sheet"]').click()
    await settled()
    await page.locator('[data-rd-grid] tbody tr').first().waitFor({ timeout: 240000 })
  }
  // At narrow widths the sheet sits below the fold, so bring the subject into
  // view first: the capture must show what the assertion is about.
  const shot = async (label, width, theme, focus) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
    await page.waitForTimeout(250)
    if (focus) await page.locator(focus).first().scrollIntoViewIfNeeded().catch(() => {})
    await page.waitForTimeout(150)
    const name = `${label}-${width}-${theme}.png`
    await page.screenshot({ path: path.join(OUT, 'screens', name) })
    captured.push(name)
  }

  for (const theme of THEMES) {
    // The excluded session, marked by the package's own source-quality notes.
    await openResearch(theme)
    await openSheet('Option quotes')
    await page.locator('[data-rd-part-filter]').fill(EXCLUDED_FILE)
    await page.waitForFunction(() => document.querySelectorAll('[data-rd-part] option').length <= 2, null, { timeout: 60000 })
    await page.locator('[data-rd-part]').selectOption(await page.locator('[data-rd-part] option').last().getAttribute('value'))
    await settled()
    await page.locator('[data-rd-sheet-flag]').waitFor({ state: 'visible', timeout: 240000 })
    const heading = await page.locator('[data-rd-sheet-flag]').innerText()
    assert.match(heading, /excluded/i, 'the recorded exclusion reaches the sheet heading on the live page')
    assert.match(await page.locator('[data-rd-part] option:checked').innerText(), new RegExp(EXCLUDED_FILE), 'the marked file is the one displayed')
    seen.push(`${theme}: heading = ${heading}`)
    for (const width of WIDTHS) await shot('excluded-session', width, theme, '.rd-sheet-heading')

    // The first chart Option chains draws, with no choices made by hand.
    await openSheet('Option chains')
    await page.locator('[data-rd-tab="chart"]').click()
    const x = await page.locator('[data-rd-x] option:checked').innerText()
    const y = await page.locator('[data-rd-y] option:checked').innerText()
    assert.doesNotMatch(x, /snapshot|ts_utc|time/i, 'a single-instant column is not the default X axis')
    seen.push(`${theme}: Option chains default axes = X ${x}, Y ${y}`)
    await page.locator('[data-rd-series]').selectOption('all')
    await page.locator('[data-rd-chart] svg').waitFor({ timeout: 60000 })
    for (const width of WIDTHS) await shot('option-chains-chart', width, theme, '[data-rd-chart]')
  }
  console.log(seen.join('\n'))
  console.log(`\nscreenshots: ${captured.length}\n` + captured.join('\n'))
  console.log('page errors: ' + JSON.stringify(errors))
  assert.deepEqual(errors.filter(message => /research-data|readTable|createDataChart/.test(message)), [])
} finally { await browser.close() }
