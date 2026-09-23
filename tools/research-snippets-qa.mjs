import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const origin = process.env.RESEARCH_QA_URL || 'http://127.0.0.1:4623'
const temp = process.platform === 'win32' ? 'C:/Users/ToolsEnabled-Dev/AppData/Local/Temp' : process.env.RESEARCH_QA_TEMP
if (!temp) throw new Error('Set RESEARCH_QA_TEMP on Linux.')
const resolved = await realpath(temp)
if (process.platform === 'win32' && !resolved.toLowerCase().replaceAll('\\', '/').startsWith('c:/users/toolsenabled-dev/')) throw new Error('QA temp boundary refused.')
process.env.TEMP = resolved; process.env.TMP = resolved
const output = await mkdtemp(path.join(resolved, 'research-snippets-qa-'))
const executablePath = process.platform === 'win32' ? 'C:/Users/ToolsEnabled-Dev/AppData/Local/ms-playwright/chromium-1148/chrome-win/chrome.exe' : undefined
const browser = await chromium.launch({ headless: true, executablePath }), errors = []
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  const open = async () => {
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message))
    await page.goto(origin + '/#/research', { waitUntil: 'domcontentloaded', timeout: 60000 })
    const dismiss = page.getByRole('button', { name: 'Not now', exact: true })
    await dismiss.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {})
    if (await dismiss.isVisible()) await dismiss.click()
    await page.locator('button[data-research-area="design"]').click()
    await page.waitForFunction(() => document.querySelector('.benchmark-builder')?.getAttribute('aria-busy') === 'false')
    assert.equal(await page.locator('[data-bench-tab="library"]').getAttribute('aria-pressed'), 'true')
    return page
  }
  const page = await open()
  const idle = async page => page.waitForFunction(() => document.querySelector('.benchmark-builder')?.getAttribute('aria-busy') === 'false')
  const create = async (title, labels, text) => {
    await page.locator('[data-bench-add-atom]').click(); await idle(page)
    await page.locator('[data-bench-bundle-title]').fill(title)
    await page.locator('[data-bench-bundle-labels]').fill(labels)
    await page.locator('[data-bench-wording]').fill(text)
    await page.locator('[data-bench-apply-bundle]').click(); await idle(page)
    assert.match(await page.locator('[data-bench-snippet-status]').innerText(), /applied/)
  }
  await create('Price decline', 'Reason to buy, Entry', 'Act when the observed price is below the declared threshold.')
  await create('Market order', 'How to buy, Entry', 'Submit the declared quantity as a market order.')
  const selector = page.locator('[data-bench-snippet-label-filter]')
  await selector.selectOption('label:Reason to buy')
  assert.equal(await page.locator('[data-bench-select-snippet]').count(), 1)
  assert.match(await page.locator('[data-bench-snippet-list]').innerText(), /Price decline/)
  await selector.selectOption('label:How to buy')
  assert.equal(await page.locator('[data-bench-select-snippet]').count(), 1)
  await page.locator('[data-bench-snippet-search]').fill('not-in-this-library')
  assert.equal(await page.locator('[data-bench-select-snippet]').count(), 0)
  await page.locator('[data-bench-snippet-search]').fill('')
  await selector.selectOption('')
  await page.locator('[data-bench-select-snippet]').filter({ hasText: 'Price decline' }).click(); await idle(page)
  await page.locator('[data-bench-bundle-labels]').fill('Reason to buy, Intraday')
  await page.locator('[data-bench-select-snippet]').filter({ hasText: 'Market order' }).click(); await idle(page)
  assert.match(await page.locator('[data-bench-status]').innerText(), /Apply the current snippet/)
  assert.equal(await page.locator('[data-bench-bundle-title]').inputValue(), 'Price decline')
  await page.locator('[data-bench-apply-bundle]').click(); await idle(page)
  await page.locator('[data-bench-clone-bundle]').click(); await idle(page)
  assert.equal(await page.locator('[data-bench-bundle-labels]').inputValue(), 'Reason to buy, Intraday')
  await page.locator('[data-bench-bundle-title]').fill('Literal <snippet>')
  await page.locator('[data-bench-bundle-labels]').fill('Observation, <category>')
  await page.locator('[data-bench-wording]').fill('Record this literal value: <img src=x onerror=alert(1)>')
  await page.locator('[data-bench-apply-bundle]').click(); await idle(page)
  assert.equal(await page.locator('.snippet-workspace img, .snippet-workspace snippet, .snippet-workspace category').count(), 0)

  for (const theme of ['white', 'black', 'cobalt']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
    await page.locator('.snippet-heading').scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(output, `constructor-${theme}.png`), fullPage: true })
  }
  const exporting = page.waitForEvent('download')
  await page.locator('[data-bench-export-snippets]').click()
  const download = await exporting, file = path.join(output, 'snippets.json')
  await download.saveAs(file)
  const library = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(library.catalog.find(bundle => bundle.title === 'Price decline').labels, ['Reason to buy', 'Intraday'])
  assert.equal(library.catalog.find(bundle => bundle.title === 'Market order').text, 'Submit the declared quantity as a market order.')

  const restored = await open()
  const choosing = restored.waitForEvent('filechooser')
  await restored.locator('[data-bench-import-snippets]').click()
  await (await choosing).setFiles(file); await idle(restored)
  await restored.locator('[data-bench-select-snippet]').filter({ hasText: 'Market order' }).click(); await idle(restored)
  assert.equal(await restored.locator('[data-bench-bundle-labels]').inputValue(), 'How to buy, Entry')
  const id = await restored.locator('[data-bench-bundle-id]').inputValue()
  await restored.locator('[data-bench-compose-snippets]').click(); await idle(restored)
  const choice = restored.locator('[data-node-use=""]')
  assert.match(await choice.locator(`option[value="${id}"]`).innerText(), /How to buy/)
  await restored.locator('[data-node-replacement-mode=""]').selectOption('replace')
  await choice.selectOption(id); await idle(restored)
  await restored.waitForFunction(() => document.querySelector('[data-bench-prompt]')?.textContent.includes('Submit the declared quantity as a market order.'))
  await restored.locator('[data-bench-tab="library"]').click()
  await restored.setViewportSize({ width: 720, height: 1000 })
  assert.equal(await restored.locator('.snippet-workspace').evaluate(element => element.scrollWidth <= element.clientWidth + 2), true)
  await restored.locator('[data-bench-bundle-title]').scrollIntoViewIfNeeded()
  await restored.screenshot({ path: path.join(output, 'constructor-narrow.png'), fullPage: true })
  assert.deepEqual(errors, [])
  const report = { ok: true, output, checks: ['Design opens the snippet constructor', 'create and edit custom names/text/labels', 'category filtering and text search', 'unapplied edits protected', 'duplicate retains labels', 'literal HTML stays text', 'local export and import in hotload', 'imported snippet composes into the actual task prompt', 'light/dark/cobalt and narrow layouts'], snippets: library.catalog.length, errors }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally { await browser.close() }
