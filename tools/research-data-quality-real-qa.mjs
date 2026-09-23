// Read-only walk of the actual configured research folder and source verdict.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const temp = process.platform === 'win32' ? 'C:/Users/ToolsEnabled-Dev/AppData/Local/Temp' : process.env.RESEARCH_QA_TEMP
if (!temp) throw new Error('Set RESEARCH_QA_TEMP on Linux.')
const resolved = await realpath(temp)
if (process.platform === 'win32' && !resolved.toLowerCase().replaceAll('\\', '/').startsWith('c:/users/toolsenabled-dev/')) throw new Error('QA temp boundary refused.')
process.env.TEMP = resolved; process.env.TMP = resolved
const output = await mkdtemp(path.join(resolved, 'research-data-quality-real-qa-'))
const browser = await chromium.launch({ headless: true, executablePath: process.platform === 'win32' ? 'C:/Users/ToolsEnabled-Dev/AppData/Local/ms-playwright/chromium-1148/chrome-win/chrome.exe' : undefined })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }), errors = []
  page.setDefaultTimeout(60000)
  page.on('pageerror', error => errors.push(error.message))
  await page.goto((process.env.RESEARCH_QA_URL || 'http://127.0.0.1:4623') + '/#/research', { waitUntil: 'domcontentloaded', timeout: 60000 })
  const dismiss = page.getByRole('button', { name: 'Not now', exact: true })
  await dismiss.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
  if (await dismiss.isVisible()) await dismiss.click()
  await page.locator('[data-rd-resource]').filter({ hasText: /^Option quotes/ }).click()
  await page.waitForFunction(() => document.querySelector('.rd-workspace')?.getAttribute('aria-busy') === 'false')
  const selectFile = async name => {
    const value = await page.locator('[data-rd-part] option').evaluateAll((items, name) => items.find(item => item.textContent.endsWith(name))?.value, name)
    assert.ok(value, `Prepared file missing: ${name}`)
    await page.locator('[data-rd-part]').selectOption(value)
    await page.waitForFunction(() => document.querySelector('.rd-workspace')?.getAttribute('aria-busy') === 'false')
  }
  await selectFile('QQQ_cbbo-1m_2023-12-27.csv.gz')
  const notice = page.locator('[data-rd-quality]')
  const sourceNotice = await notice.innerText()
  assert.match(sourceNotice, /Source quality: excluded/)
  assert.match(sourceNotice, /two_sided_pct: 0/)
  assert.match(sourceNotice, /2026-08-24/)
  await page.locator('[data-rd-validate]').click()
  await page.waitForFunction(() => document.querySelector('[data-rd-validation]')?.textContent.includes('151,470 rows checked'), null, { timeout: 120000 })
  const validation = await page.locator('[data-rd-validation]').innerText()
  assert.match(validation, /0 errors/)
  assert.equal(await notice.innerText(), sourceNotice, 'Format success must not clear the source exclusion')
  await page.locator('[data-rd-tab="chart"]').click()
  await page.locator('[data-rd-series]').selectOption('0')
  await page.locator('[data-rd-chart] svg').waitFor()
  assert.equal(await notice.isVisible(), true)
  await notice.scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(output, 'excluded-file.png'), fullPage: true })
  const downloading = page.waitForEvent('download'); await page.locator('[data-rd-export]').click()
  const exportPath = path.join(output, 'datapackage.json'); await (await downloading).saveAs(exportPath)
  const descriptor = JSON.parse(await readFile(exportPath, 'utf8'))
  const qualityName = descriptor.toolsenabled.sourceQuality
  assert.ok(descriptor.resources.some(resource => resource.name === qualityName))
  const quotes = descriptor.resources.find(resource => resource.name === 'option-quotes')
  assert.ok(quotes.path.some(path => path.endsWith('QQQ_cbbo-1m_2023-12-27.csv.gz')), 'Excluded source stays present with its assessment')
  await selectFile('QQQ_cbbo-1m_2023-12-28.csv.gz')
  assert.match(await notice.innerText(), /no assessment recorded/)
  await page.locator('[data-rd-quality-notes]').click()
  await page.waitForFunction(() => document.querySelector('[data-rd-sheet-title]')?.textContent.toLowerCase().includes('quality'))
  await page.locator('[data-rd-tab="sheet"]').click()
  assert.match(await page.locator('[data-rd-grid]').innerText(), /QQQ_cbbo-1m_2023-12-27/)
  await page.screenshot({ path: path.join(output, 'quality-notes.png'), fullPage: true })
  assert.deepEqual(errors, [])
  const report = { ok: true, output, sourceNotice, validation, qualityResource: qualityName, retainedExcludedFile: true, errors }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally { await browser.close() }
