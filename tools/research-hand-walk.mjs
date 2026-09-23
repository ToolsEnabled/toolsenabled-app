// The owner's own acceptance sequence, walked in their stated order:
// load a research folder, browse its files and contents, load data into a
// visible sheet, chart it, then build a snippet, label it into a category,
// filter by that label and search for it.
//
// This is not a pass/fail gate. It records what a first-time person meets at
// each step -- what is on screen, what they would reasonably try next, and what
// actually happens -- so friction shows up even where nothing is broken.
import { mkdtemp, writeFile, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'

const ORIGIN = process.env.RESEARCH_QA_URL || 'http://127.0.0.1:4623'
const temp = await realpath(process.env.RESEARCH_QA_TEMP || os.tmpdir())
const output = process.argv[2] || await mkdtemp(path.join(temp, 'research-hand-walk-'))
const notes = []
const note = (step, what, detail) => { notes.push({ step, what, detail }); console.log(`[${step}] ${what}\n        ${detail}`) }
const text = async (locator, fallback = '') => locator.innerText().catch(() => fallback)

const browser = await chromium.launch({ headless: true, executablePath: process.env.RESEARCH_QA_CHROMIUM || undefined })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const shot = async name => { await page.screenshot({ path: path.join(output, name + '.png'), fullPage: false }) }

  // --- 1. Arriving -------------------------------------------------------
  await page.goto(ORIGIN + '/#/research', { waitUntil: 'domcontentloaded', timeout: 60000 })
  const dismiss = page.getByRole('button', { name: 'Not now', exact: true })
  const hadPrompt = await dismiss.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)
  if (hadPrompt) {
    note('1 arrive', 'A prompt stands in front of the page', 'Dismissed with "Not now" before anything else could be read.')
    await dismiss.click()
  }
  await page.locator("button[data-research-area=\"data\"]").waitFor({ timeout: 30000 })
  note('1 arrive', 'Areas offered', (await page.locator("button[data-research-area]").allInnerTexts()).join(' / '))
  note('1 arrive', 'Opening status line', JSON.stringify((await text(page.locator('[data-rd-status]'))).slice(0, 150)))

  // --- 2. The folder -----------------------------------------------------
  await page.locator('button[data-research-area="data"]').click()
  await page.locator('[data-rd-grid] tbody tr').first().waitFor({ timeout: 120000 })
  note('2 folder', 'A folder was already connected', `"${await text(page.locator('[data-rd-folder-name]'))}" opened on its own through a configured local folder connection, so "Open folder" was never pressed.`)
  const sheets = await page.locator('[data-rd-resource]').allInnerTexts()
  note('2 folder', `${sheets.length} data sheets offered`, sheets.map(item => item.split('\n')[0]).join(' / '))

  // --- 3. Browsing files -------------------------------------------------
  const entries = await page.locator('[data-rd-entry]').allInnerTexts()
  note('3 browse', `Folder tree shows ${entries.length} entries`, entries.slice(0, 8).map(item => item.trim().split('\n')[0]).join(', '))
  await page.locator('[data-rd-entry="README.md"]').click().catch(() => {})
  await page.waitForTimeout(700)
  const preview = await text(page.locator('[data-rd-file-text]'))
  note('3 browse', 'Opening README.md', preview ? `Text preview rendered, ${preview.length} characters.` : 'No preview appeared.')
  await shot('walk-3-browse')

  // --- 4. A sheet --------------------------------------------------------
  await page.locator('[data-rd-resource]', { hasText: 'Stock prices' }).first().click()
  await page.locator('[data-rd-tab="sheet"]').click()
  await page.waitForFunction(() => document.querySelector('.rd-workspace')?.getAttribute('aria-busy') === 'false', null, { timeout: 180000 })
  note('4 sheet', 'Stock prices opened', `${await page.locator('[data-rd-grid] tbody tr').count()} rows shown. ${await text(page.locator('[data-rd-validation]'))}`)
  note('4 sheet', 'Pagination reads', await text(page.locator('[data-rd-page]')))
  await shot('walk-4-sheet')

  // --- 5. Charting it ----------------------------------------------------
  await page.locator('[data-rd-tab="chart"]').click()
  await page.waitForTimeout(1000)
  const drew = await page.locator('[data-rd-chart] svg').count()
  note('5 chart', 'The first chart, with nothing chosen', `${drew ? 'A chart is drawn.' : 'No chart is drawn.'} X=${await text(page.locator('[data-rd-x] option:checked'))}, Y=${await text(page.locator('[data-rd-y] option:checked'))}. Note reads: "${(await text(page.locator('[data-rd-chart-note]'))).slice(0, 200)}"`)
  await shot('walk-5-chart-default')
  const grouping = await page.locator('[data-rd-series] option').allInnerTexts()
  note('5 chart', 'What is offered to resolve it', `Series choices: ${grouping.slice(0, 4).join(' / ')}${grouping.length > 4 ? ` (and ${grouping.length - 4} columns)` : ''}`)
  await page.locator('[data-rd-series]').selectOption({ label: 'Symbol' }).catch(() => page.locator('[data-rd-series]').selectOption('0'))
  await page.waitForTimeout(1000)
  note('5 chart', 'After choosing a grouping', `${await page.locator('[data-rd-chart] svg').count() ? 'Chart drawn.' : 'Still no chart.'} Note reads: "${(await text(page.locator('[data-rd-chart-note]'))).slice(0, 200)}"`)
  await shot('walk-5-chart-grouped')

  // --- 6. A snippet, labelled into a category ----------------------------
  await page.locator('button[data-research-area="design"]').click()
  await page.locator('[data-bench-add-atom]').waitFor({ timeout: 30000 })
  note('6 snippet', 'Design area', `Steps offered: ${(await page.locator('.bench-steps button').allInnerTexts()).join(' / ')}`)
  const beforeCount = await text(page.locator('[data-bench-snippet-count]'))
  await page.locator('[data-bench-add-atom]').click()
  await page.locator('[data-bench-bundle-title]').fill('Reason to buy')
  await page.locator('[data-bench-bundle-labels]').fill('reason to buy')
  await page.locator('[data-bench-wording]').fill('Buy when the measured spread narrows below the stated threshold.')
  await page.locator('[data-bench-apply-bundle]').click()
  await page.waitForTimeout(500)
  note('6 snippet', 'Created it and labelled it "reason to buy"', `Library went from "${beforeCount}" to "${await text(page.locator('[data-bench-snippet-count]'))}". Status: "${await text(page.locator('[data-bench-snippet-status]'))}"`)
  note('6 snippet', 'Categories now on screen', (await page.locator('[data-bench-snippet-category]').allInnerTexts()).map(item => item.replace('\n', ' ')).join(' / '))
  await shot('walk-6-snippet')

  // --- 7. Filter by that label, then search for it -----------------------
  await page.locator('[data-bench-snippet-category="label:reason to buy"]').click()
  await page.waitForTimeout(400)
  note('7 find', 'Pressed the "reason to buy" category', `Shows: ${(await page.locator('[data-bench-select-snippet] strong').allInnerTexts()).join(', ')} — count reads "${await text(page.locator('[data-bench-snippet-count]'))}"`)
  await page.locator('[data-bench-snippet-category=""]').click()
  await page.waitForTimeout(300)
  await page.locator('[data-bench-snippet-search]').fill('spread narrows')
  await page.waitForTimeout(400)
  note('7 find', 'Searched its wording', (await page.locator('[data-bench-select-snippet] strong').allInnerTexts()).join(', ') || 'nothing found')
  await page.locator('[data-bench-snippet-search]').fill('reason to buy')
  await page.waitForTimeout(400)
  note('7 find', 'Searched the category name', (await page.locator('[data-bench-select-snippet] strong').allInnerTexts()).join(', ') || 'nothing found')
  await shot('walk-7-find')

  note('end', 'Page errors during the whole walk', errors.length ? JSON.stringify(errors.slice(0, 5)) : 'none')
  await writeFile(path.join(output, 'hand-walk.json'), JSON.stringify({ notes, errors }, null, 2) + '\n')
  console.log('\noutput: ' + output)
} finally { await browser.close() }
