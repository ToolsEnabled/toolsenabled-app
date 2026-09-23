// Walk the actual configured folder connection. No fixture, network stubbing,
// application writes, or attachment to the owner's browser session.
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
const output = await mkdtemp(path.join(resolved, 'research-data-open-qa-'))
const executablePath = process.platform === 'win32' ? 'C:/Users/ToolsEnabled-Dev/AppData/Local/ms-playwright/chromium-1148/chrome-win/chrome.exe' : undefined
const browser = await chromium.launch({ headless: true, executablePath })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(origin + '/#/research', { waitUntil: 'domcontentloaded', timeout: 60000 })
  const dismiss = page.getByRole('button', { name: 'Not now', exact: true })
  await dismiss.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
  if (await dismiss.isVisible()) await dismiss.click()
  await page.locator('button[data-research-area="data"]').click()
  await page.waitForFunction(() => document.querySelector('[data-rd-folder-name]')?.textContent !== 'No folder open')
  const folder = await page.locator('[data-rd-folder-name]').innerText()
  const expected = Number(process.env.RESEARCH_QA_EXPECT_SHEETS || 0)
  if (expected) await page.waitForFunction(count => document.querySelectorAll('[data-rd-resource]').length === count, expected)
  const sheets = [], count = await page.locator('[data-rd-resource]').count()
  for (let index = 0; index < count; index++) {
    await page.locator(`[data-rd-resource="${index}"]`).click()
    await page.waitForFunction(() => document.querySelector('.rd-workspace')?.getAttribute('aria-busy') === 'false' && document.querySelector('[data-rd-grid] thead'))
    const title = await page.locator('[data-rd-sheet-title]').innerText()
    const validation = await page.locator('[data-rd-validation]').innerText()
    assert.match(validation, /checks passed/)
    const rows = await page.locator('[data-rd-grid] tbody tr').count()
    assert.ok(rows > 0, `${title} has no preview records`)
    const sheet = { title, rows, files: await page.locator('[data-rd-part] option').count(), headers: await page.locator('[data-rd-grid] thead').innerText(), firstRow: await page.locator('[data-rd-grid] tbody tr').first().innerText(), validation }
    sheets.push(sheet)
    await page.screenshot({ path: path.join(output, `sheet-${index + 1}.png`), fullPage: true })
    if (index === 0) {
      await page.locator('[data-rd-tab="chart"]').click()
      assert.match(await page.locator('[data-rd-chart-note]').innerText(), /Multiple categories in Symbol/)
      assert.equal(await page.locator('[data-rd-chart] svg').count(), 0)
      await page.locator('[data-rd-series]').selectOption('0')
      await page.locator('[data-rd-chart] svg').waitFor()
      sheet.groupedChart = await page.locator('[data-rd-chart]').getAttribute('aria-label')
      assert.match(sheet.groupedChart, /separate series grouped by symbol/)
      await page.screenshot({ path: path.join(output, 'grouped-stocks.png'), fullPage: true })
      for (const theme of ['black', 'cobalt']) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
        await page.screenshot({ path: path.join(output, `grouped-stocks-${theme}.png`), fullPage: true })
      }
      await page.setViewportSize({ width: 390, height: 1000 })
      await page.locator('[data-rd-chart-panel]').scrollIntoViewIfNeeded()
      assert.equal(await page.locator('[data-rd-sheet]').evaluate(element => element.scrollWidth <= element.clientWidth + 2), true)
      await page.screenshot({ path: path.join(output, 'grouped-stocks-narrow.png'), fullPage: true })
      await page.setViewportSize({ width: 1440, height: 1100 })
      await page.evaluate(() => { document.documentElement.dataset.theme = 'white' })
      await page.locator('[data-rd-series]').selectOption('auto')
      await page.locator('[data-rd-tab="sheet"]').click()
    }
    if (title === 'Option quotes') {
      const exportHeight = await page.locator('[data-rd-export]').evaluate(element => element.getBoundingClientRect().height)
      assert.ok(exportHeight < 50, 'Export package description stays on one line beside a long description')
    }
    // Exercise a real table-to-chart interaction on the owner's prepared data.
    // Filtering one identifier avoids plotting several instruments as one line.
    if (index === 0 || title === 'Option quotes') {
      const identifier = await page.locator('[data-rd-grid] tbody tr').first().locator('td').first().textContent()
      await page.locator('[data-rd-search]').fill(identifier)
      await page.locator('[data-rd-search-go]').click()
      await page.waitForFunction(() => document.querySelector('.rd-workspace')?.getAttribute('aria-busy') === 'false' && document.querySelector('[data-rd-grid] tbody tr'))
      await page.locator('[data-rd-tab="chart"]').click()
      await page.locator('[data-rd-chart] svg').waitFor()
      sheet.chart = { filter: identifier, description: await page.locator('[data-rd-chart]').getAttribute('aria-label'), coverage: await page.locator('[data-rd-chart-note]').innerText() }
      await page.screenshot({ path: path.join(output, `chart-${index + 1}.png`), fullPage: true })
      await page.locator('[data-rd-tab="sheet"]').click()
    }
    if (title === 'Option chains') {
      sheet.fileChecks = []
      const files = await page.locator('[data-rd-part] option').count()
      for (let part = 0; part < files; part++) {
        await page.locator('[data-rd-part]').selectOption(String(part))
        await page.waitForFunction(() => document.querySelector('.rd-workspace')?.getAttribute('aria-busy') === 'false')
        await page.locator('[data-rd-validate]').click()
        await page.waitForFunction(() => document.querySelector('.rd-workspace')?.getAttribute('aria-busy') === 'false')
        const message = await page.locator('[data-rd-validation]').innerText()
        assert.match(message, /0 errors/)
        sheet.fileChecks.push(message)
      }
    }
  }
  await page.locator('[data-rd-entry="README.md"]').click()
  await page.waitForFunction(() => document.querySelector('[data-rd-file-text]')?.textContent.length > 0)
  assert.ok((await page.locator('[data-rd-file-text]').innerText()).length > 0)
  await page.screenshot({ path: path.join(output, 'folder.png'), fullPage: true })
  if (count) await page.locator('[data-rd-resource="0"]').click()
  assert.deepEqual(errors, [])
  const report = { ok: true, origin, folder, sheets, checked: ['actual folder connection', 'actual README preview', ...(count ? ['all imported sheet previews'] : [])], errors, output }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally { await browser.close() }
