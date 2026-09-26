// Walk the snippet constructor the way a person uses it: create, name, give it
// categories, find it by category, find it by search, edit it, duplicate it,
// delete it, and check it survives a reload.
import { chromium } from 'playwright'

const ORIGIN = process.env.RESEARCH_QA_URL || 'http://127.0.0.1:4623'
const problems = []
const step = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) problems.push(name + (detail ? ': ' + detail : ''))
}

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const open = async () => {
    await page.goto(ORIGIN + '/#/research', { waitUntil: 'domcontentloaded', timeout: 60000 })
    const dismiss = page.getByRole('button', { name: 'Not now', exact: true })
    await dismiss.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
    if (await dismiss.isVisible()) await dismiss.click()
    await page.locator('button[data-research-area="design"]').click()
    await page.locator('[data-bench-snippet-list]').waitFor({ timeout: 30000 })
    await page.waitForTimeout(500)
  }
  const titles = () => page.$$eval('[data-bench-select-snippet] strong', ns => ns.map(n => n.textContent))
  const has = sel => page.locator(sel).count().then(n => n > 0)
  const status = () => page.locator('[data-bench-snippet-status]').innerText().catch(() => '')

  await open()
  const start = (await titles()).length

  // create
  await page.locator('[data-bench-add-atom]').click()
  await page.locator('[data-bench-bundle-title]').fill('Reason to buy')
  await page.locator('[data-bench-bundle-labels]').fill('reason to buy, Entry')
  await page.locator('[data-bench-wording]').fill('Buy when the measured spread narrows below the stated threshold.')
  await page.locator('[data-bench-apply-bundle]').click()
  await page.waitForTimeout(400)
  step('create a snippet with a name and categories', (await titles()).includes('Reason to buy'), await status())

  // find by category
  await page.locator('[data-bench-snippet-category="label:reason to buy"]').click().catch(() => {})
  await page.waitForTimeout(300)
  step('find it by its category', JSON.stringify(await titles()) === JSON.stringify(['Reason to buy']))
  await page.locator('[data-bench-snippet-category=""]').click(); await page.waitForTimeout(250)

  // find by search
  await page.locator('[data-bench-snippet-search]').fill('spread narrows'); await page.waitForTimeout(300)
  step('find it by searching its text', JSON.stringify(await titles()) === JSON.stringify(['Reason to buy']))
  await page.locator('[data-bench-snippet-search]').fill(''); await page.waitForTimeout(250)

  // edit
  await page.locator(`[data-bench-select-snippet]`).filter({ hasText: 'Reason to buy' }).first().click()
  await page.waitForTimeout(250)
  await page.locator('[data-bench-bundle-title]').fill('Reason to buy (edited)')
  await page.locator('[data-bench-wording]').fill('Buy when the spread narrows and volume holds.')
  await page.locator('[data-bench-apply-bundle]').click()
  await page.waitForTimeout(400)
  step('edit it and apply', (await titles()).includes('Reason to buy (edited)'), await status())

  // duplicate
  await page.locator('[data-bench-clone-bundle]').click(); await page.waitForTimeout(400)
  const afterClone = await titles()
  step('duplicate it', afterClone.some(t => /copy/i.test(t)), afterClone.join(', '))

  // delete
  const canDelete = await has('[data-bench-delete-bundle], [data-bench-delete-snippet]')
  step('delete a snippet', canDelete, canDelete ? '' : 'no delete control exists in the snippet editor')
  if (canDelete) {
    const before = (await titles()).length
    await page.locator('[data-bench-delete-bundle], [data-bench-delete-snippet]').first().click()
    await page.waitForTimeout(400)
    const msg = await page.locator('[data-bench-status]').innerText().catch(() => '')
    step('delete removes it from the library', (await titles()).length === before - 1, msg.slice(0, 160))
  }

  // deleting something a task still uses must refuse, not orphan the task
  await page.locator('[data-bench-select-snippet]').filter({ hasText: 'Task' }).first().click()
  await page.waitForTimeout(300)
  const countBefore = (await titles()).length
  await page.locator('[data-bench-delete-snippet]').click()
  await page.waitForTimeout(400)
  const refusal = await page.locator('[data-bench-status]').innerText().catch(() => '')
  step('a snippet a task uses cannot be deleted', (await titles()).length === countBefore && /used by/i.test(refusal), refusal.slice(0, 140))

  // save + reload
  await page.locator('[data-bench-save]').click(); await page.waitForTimeout(600)
  const saveMessage = await page.locator('[data-bench-status]').innerText().catch(() => '')
  step('save the draft', !/example mode/i.test(saveMessage), saveMessage.slice(0, 110))
  await open()
  step('it survived a reload', (await titles()).includes('Reason to buy (edited)'), (await titles()).join(', ') || 'library empty')

  console.log(`\nstarted with ${start} snippets`)
  console.log('page errors: ' + (errors.length ? JSON.stringify(errors.slice(0, 3)) : 'none'))
  console.log(problems.length ? `\nPROBLEMS (${problems.length}):\n  ` + problems.join('\n  ') : '\nno problems')
} finally { await browser.close() }
