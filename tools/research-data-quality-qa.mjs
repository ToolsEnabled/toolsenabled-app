import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'
import { createResearchDataServer } from './research-data-server.mjs'

const temp = process.platform === 'win32' ? 'C:/Users/ToolsEnabled-Dev/AppData/Local/Temp' : process.env.RESEARCH_QA_TEMP
if (!temp) throw new Error('Set RESEARCH_QA_TEMP to an explicit QA directory on Linux.')
const resolved = await realpath(temp)
if (process.platform === 'win32' && !resolved.toLowerCase().replaceAll('\\', '/').startsWith('c:/users/toolsenabled-dev/')) throw new Error('QA temp boundary refused.')
process.env.TEMP = resolved; process.env.TMP = resolved
const output = await mkdtemp(path.join(resolved, 'research-data-quality-qa-')), data = path.join(output, 'generic-study'), nested = path.join(data, 'dataset')
await mkdir(nested, { recursive: true })
const schema = { fields: [{ name: 'timestamp', type: 'datetime' }, { name: 'station', type: 'string' }, { name: 'reading', type: 'number' }] }
const qualityFields = ['resource', 'path', 'verdict', 'reason', 'measured_metric'].map(name => ({ name, type: 'string' })).concat({ name: 'measured_value', type: 'number' }, { name: 'reported_date', type: 'date' }, { name: 'action', type: 'string' })
const descriptor = { name: 'sensor-study', toolsenabled: { sourceQuality: 'quality-notes' }, resources: [
  { name: 'observations', path: ['a.csv', 'b.csv'], schema },
  { name: 'calibrations', path: 'single.csv', schema },
  { name: 'quality-notes', path: 'quality.csv', schema: { fields: qualityFields } },
] }
const content = 'timestamp,station,reading\n2026-01-01T12:00:00Z,North,0\n2026-01-01T12:01:00Z,North,1\n'
await Promise.all(['a.csv', 'b.csv', 'single.csv'].map(file => writeFile(path.join(nested, file), content)))
await writeFile(path.join(nested, 'datapackage.json'), JSON.stringify(descriptor))
const qualityCSV = qualityFields.map(field => field.name).join(',') + '\nobservations,a.csv,excluded,<img src=x onerror=alert(1)>,coverage,0,2026-01-02,Exclude from training\ncalibrations,single.csv,pass,Source calibration complete,coverage,100,2026-01-02,Retain\n'
await writeFile(path.join(nested, 'quality.csv'), qualityCSV)
const origin = process.env.RESEARCH_QA_URL || 'http://127.0.0.1:4623'
const server = await createResearchDataServer({ root: data, origin, packages: ['dataset/datapackage.json'] })
const base = `http://127.0.0.1:${server.address().port}`
let browser
try {
  browser = await chromium.launch({ headless: true, executablePath: process.platform === 'win32' ? 'C:/Users/ToolsEnabled-Dev/AppData/Local/ms-playwright/chromium-1148/chrome-win/chrome.exe' : undefined })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/research-workspace.json', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ url: base }) }))
  const ready = async (reload = false) => {
    if (reload) await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
    else await page.goto(origin + '/#/research', { waitUntil: 'domcontentloaded', timeout: 60000 })
    const dismiss = page.getByRole('button', { name: 'Not now', exact: true })
    await dismiss.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
    if (await dismiss.isVisible()) await dismiss.click()
    await page.locator('[data-rd-grid] tbody tr').first().waitFor()
  }
  await ready()
  const notice = page.locator('[data-rd-quality]')
  assert.match(await notice.innerText(), /Source quality: excluded/)
  assert.match(await notice.innerText(), /coverage: 0/)
  assert.equal(await notice.locator('img').count(), 0)
  await page.locator('[data-rd-search]').fill('North')
  await page.locator('[data-rd-search-go]').click()
  await page.waitForFunction(() => document.querySelector('.rd-workspace')?.getAttribute('aria-busy') === 'false')
  assert.match(await notice.innerText(), /Source quality: excluded/)
  await page.locator('[data-rd-validate]').click()
  await page.waitForFunction(() => document.querySelector('[data-rd-validation]')?.textContent.includes('2 rows checked'))
  assert.match(await notice.innerText(), /excluded/)
  assert.match(await page.locator('[data-rd-validation]').innerText(), /0 errors/)
  await page.locator('[data-rd-tab="chart"]').click()
  await page.locator('[data-rd-chart] svg').waitFor()
  assert.equal(await notice.isVisible(), true)
  const contrasts = []
  for (const theme of ['white', 'black', 'cobalt']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
    const ratio = await notice.evaluate(element => {
      const css = getComputedStyle(element), canvas = document.createElement('canvas'), context = canvas.getContext('2d')
      const lum = value => {
        context.fillStyle = value; context.fillRect(0, 0, 1, 1)
        const colors = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => { const s = value / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4 })
        return colors[0] * .2126 + colors[1] * .7152 + colors[2] * .0722
      }
      const fg = lum(css.color), bg = lum(css.backgroundColor)
      return (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05)
    })
    assert.ok(ratio >= 4.5, `Quality notice contrast in ${theme}: ${ratio}`)
    contrasts.push({ theme, ratio })
    await notice.scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(output, `quality-${theme}.png`), fullPage: true })
  }
  await page.setViewportSize({ width: 390, height: 1000 })
  assert.equal(await page.locator('[data-rd-sheet]').evaluate(element => element.scrollWidth <= element.clientWidth + 2), true)
  await notice.scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(output, 'quality-narrow.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1100 })
  await page.locator('[data-rd-part]').selectOption('1')
  await page.waitForFunction(() => document.querySelector('.rd-workspace')?.getAttribute('aria-busy') === 'false')
  assert.match(await notice.innerText(), /no assessment recorded/)
  await page.locator('[data-rd-quality-notes]').click()
  await page.waitForFunction(() => document.querySelector('[data-rd-sheet-title]')?.textContent === 'quality-notes')
  assert.equal(await page.locator('[data-rd-grid] tbody tr').count(), 2)
  await page.locator('[data-rd-tab="sheet"]').click()
  assert.equal(await notice.isVisible(), false)
  await page.locator('[data-rd-entry="dataset"]').click()
  await page.locator('[data-rd-entry="dataset/single.csv"]').click()
  await page.locator('[data-rd-setup]').waitFor({ state: 'visible' })
  await page.locator('[data-rd-sheet-name]').fill('Rechecked calibration')
  await page.locator('[data-rd-field-type="0"]').selectOption('datetime')
  await page.locator('[data-rd-field-type="2"]').selectOption('number')
  await page.locator('[data-rd-apply-schema]').click()
  await page.waitForFunction(() => document.querySelector('[data-rd-sheet-title]')?.textContent === 'Rechecked calibration')
  assert.match(await notice.innerText(), /Source quality: pass/)
  const exporting = page.waitForEvent('download'); await page.locator('[data-rd-export]').click()
  const file = await exporting, exportPath = path.join(output, 'exported-datapackage.json'); await file.saveAs(exportPath)
  const exported = JSON.parse(await readFile(exportPath, 'utf8'))
  assert.equal(exported.toolsenabled.sourceQuality, 'quality-notes')
  assert.equal(exported.resources[1].name, 'calibrations')
  assert.equal(exported.resources[1].path, 'single.csv', 'Nested package keeps its existing root and quality references')
  await writeFile(path.join(nested, 'datapackage.json'), JSON.stringify(exported))
  await ready(true)
  assert.match(await notice.innerText(), /Source quality: excluded/)
  await writeFile(path.join(nested, 'quality.csv'), qualityCSV.replace('observations,a.csv', 'observations,not-declared.csv'))
  await ready(true)
  assert.match(await notice.innerText(), /Source quality unavailable/)
  assert.match(await notice.innerText(), /undeclared data file/)
  assert.deepEqual(errors, [])
  const report = { ok: true, output, checks: ['source verdict separate from format validation', 'quality warning persists through filtering and charting', 'zero metric and source action preserved', 'literal source text stays text', 'unassessed partition is explicit', 'quality resource browsable', 'nested package and stable resource references survive edits/export/reimport', 'unreadable quality notes are visible', 'dark and narrow layouts'], contrasts, errors }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)) }
