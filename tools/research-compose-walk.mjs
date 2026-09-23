// Hand walk of the Snippets and Compose tasks surfaces in the running app.
// Everything here is done the way a person does it: press what is on the page,
// type into what is on the page, and read back what the page says.
//
// PROMPT B: the library it walks is now the owner's own LeanBench material, so
// the category it presses and the wording it reads back are theirs.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { chromium } from 'playwright'

const temp = process.env.RESEARCH_QA_TEMP || os.tmpdir()
const resolved = await realpath(temp), home = await realpath(os.homedir())
const within = (child, parent) => { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)) }
// The walk only ever writes under the running account's own directories.
if (!within(resolved, home) && !within(resolved, await realpath(os.tmpdir()))) throw new Error(`Walk temp boundary refused: ${resolved} is outside ${home}.`)
const output = await mkdtemp(path.join(resolved, 'research-compose-walk-'))
const origin = process.env.RESEARCH_QA_URL || 'http://127.0.0.1:4623'

const checks = []
const record = note => { checks.push(note); console.log('· ' + note) }

let browser
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.RESEARCH_QA_CHROMIUM || undefined })
  const page = await browser.newPage({ viewport: { width: 1600, height: 1300 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(origin + '/#/research', { waitUntil: 'domcontentloaded', timeout: 60000 })
  const dismiss = page.getByRole('button', { name: 'Not now', exact: true })
  await dismiss.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
  if (await dismiss.isVisible()) await dismiss.click()
  await page.locator('button[data-research-area="design"]').click()
  await page.locator('[data-bench-snippet-list] .snippet-card').first().waitFor({ timeout: 30000 })

  // 1. The library opens with example content, and the strip shows the
  //    categories those examples carry.
  const cards = () => page.locator('[data-bench-snippet-list] .snippet-card')
  const opened = await cards().count()
  const countLine = await page.locator('[data-bench-snippet-count]').innerText()
  assert.match(countLine, /example/, `the library says how many examples it holds: ${countLine}`)
  record(`library opens with ${opened} snippets and says: ${countLine}`)
  const strip = await page.locator('[data-bench-snippet-categories]').innerText()
  assert.match(strip, /QuantCode-Bench/, `the category strip carries the example labels: ${strip.replace(/\n/g, ' / ')}`)
  record(`category strip reads: ${strip.replace(/\n+/g, ' / ')}`)
  await page.screenshot({ path: path.join(output, 'snippets-library.png'), fullPage: true })

  await page.locator('[data-bench-snippet-category="label:QuantCode-Bench"]').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-bench-snippet-list] .snippet-card').length === 4)
  record('pressing a category filters the library to exactly the snippets carrying it')
  await page.locator('[data-bench-snippet-category=""]').click()
  await page.waitForFunction(count => document.querySelectorAll('[data-bench-snippet-list] .snippet-card').length === count, opened)

  // 2. A template's child place is named by the person, not shipped.
  await page.locator('.snippet-advanced > summary').click()
  await page.locator('[data-bench-add-template]').click()
  await page.waitForFunction(() => document.querySelector('[data-bench-slots]')?.value.replace(/\s/g, '') === '{}')
  assert.equal((await page.locator('[data-bench-wording]').inputValue()).includes('{{slot:'), false, 'a new template ships with no child place')
  record('a new template arrives with no child place and no slot name in its wording')
  await page.locator('[data-bench-slot-name]').fill('Preamble')
  await page.locator('[data-bench-add-slot]').click()
  await page.waitForFunction(() => document.querySelector('[data-bench-status]')?.textContent.includes('lowercase'))
  record('an unusable child-place name is refused by name: ' + await page.locator('[data-bench-status]').innerText())
  await page.locator('[data-bench-slot-name]').fill('preamble')
  await page.locator('[data-bench-add-slot]').click()
  await page.waitForFunction(() => document.querySelector('[data-bench-wording]')?.value.includes('{{slot:preamble}}'))
  assert.deepEqual(JSON.parse(await page.locator('[data-bench-slots]').inputValue()), { preamble: 'node' })
  record('the child place the person named is the one the template gets')

  /* 3. PROMPT B. The test the owner will apply: arrive on Compose tasks cold and
        build a rule that routes between two compositions, without opening a
        disclosure, pressing a prepare step, or touching JSON. Every press below
        is on something already visible when the panel opens. */
  await page.locator('[data-bench-tab="compose"]').click()
  await page.locator('[data-routing-add-rule]').waitFor({ timeout: 20000 })
  assert.equal(await page.locator('[data-bench-prepare-routing]').count(), 0, 'there is no prepare step left to find')
  assert.equal(await page.locator('[data-routing-add-field]').isVisible(), true, 'fields are on the glass on arrival')
  assert.equal(await page.locator('[data-routing-add-composition]').isVisible(), true, 'so are compositions')
  assert.equal(await page.locator('[data-routing-add-rule]').isVisible(), true, 'so are rules')
  assert.equal(await page.locator('[data-routing-add-row]').isVisible(), true, 'so are rows')
  record('Compose tasks opens with fields, compositions, rules and rows all visible, no prepare step')
  await page.screenshot({ path: path.join(output, 'compose-arrival.png'), fullPage: true })

  // A second composition, nested two deep inside a third, chosen from the same
  // list a snippet is chosen from.
  const addComposition = async (at, name, snippet) => {
    await page.locator('[data-routing-add-composition]').click()
    await page.locator(`[data-routing-composition-name="${at}"]`).fill(name)
    await page.locator(`[data-routing-composition-name="${at}"]`).press('Tab')
    await page.locator(`[data-routing-use="${at}:"]`).selectOption('snippet:' + snippet)
  }
  await addComposition('1', 'plain-ask', 'lb-ref-impl-prompt-v2')
  await addComposition('2', 'gated-ask', 'lb-race-template')
  await page.locator('[data-routing-use="2:inside"]').selectOption('composition:plain-ask')
  await addComposition('3', 'twice-gated', 'lb-state-gated-template')
  await page.locator('[data-routing-use="3:inside"]').selectOption('composition:gated-ask')
  record('three compositions, each placed inside the next, chosen from the same list as a snippet')

  /* PROMPT C. A rule whose branch contains another rule, three levels deep,
     built from what is already on the page. The owner's test is that nothing
     here needs a disclosure, a prepare step or JSON. */
  for (const field of ['situation', 'size']) {
    await page.locator('[data-routing-add-field]').click()
    const index = await page.locator('[data-routing-field]').count() - 1
    await page.locator(`[data-routing-field="${index}"]`).fill(field)
    await page.locator(`[data-routing-field="${index}"]`).press('Tab')
  }
  const rung = async (set, field, value, outcome) => {
    await page.locator(`[data-routing-add-rule="${set}"]`).click()
    await page.locator(`[data-routing-add-test="${set}:0"]`).click()
    await page.locator(`[data-routing-test-field="${set}:0:0"]`).selectOption(field)
    await page.locator(`[data-routing-test-kind="${set}:0:0"]`).selectOption('is')
    await page.locator(`[data-routing-test-value="${set}:0:0"]`).fill(value)
    await page.locator(`[data-routing-test-value="${set}:0:0"]`).press('Tab')
    await page.locator(`[data-routing-outcome="${set}:0"]`).selectOption(outcome)
  }
  await rung('r', 'situation', 'urgent', 'new-decision')
  await page.locator('[data-routing-outcome="r"]').selectOption('composition:plain-ask')
  await rung('d0', 'size', 'large', 'new-decision')
  await page.locator('[data-routing-outcome="d0"]').selectOption('composition:plain-ask')
  await rung('d1', 'situation', 'urgent', 'composition:twice-gated')
  await page.locator('[data-routing-outcome="d1"]').selectOption('composition:gated-ask')
  record('three sets of rules, each chosen by a rung of the one above, from the same select')

  await page.locator('[data-routing-row-value="0"]').first().fill('urgent')
  await page.locator('[data-routing-row-value="0"]').first().press('Tab')
  const sizeCell = page.locator('[data-routing-row-field="size"]').first()
  await sizeCell.fill('large')
  await sizeCell.press('Tab')

  const ladder = (await page.locator('.routing-ladder').first().innerText()).replace(/\s+/g, ' ')
  assert.match(ladder, /If/, 'the rule set reads as a ladder')
  assert.match(ladder, /Otherwise/)
  const marked = page.locator('.routing-rule[data-winner="true"]')
  assert.equal(await marked.count(), 3, 'one rung marked at each of the three levels')
  record('one rung is marked at each of the three levels for the selected row')

  await page.locator('[data-routing-add-row]').click()
  const uses = (await page.locator('.routing-uses').first().innerText()).replace(/\s+/g, ' ')
  assert.match(uses, /rule 1 . the rules named rules-1: rule 1 . the rules named rules-2: rule 1 . twice-gated/, uses)
  record('the row traces its whole path: ' + uses)
  await page.screenshot({ path: path.join(output, 'compose-routing.png'), fullPage: true })

  await page.locator('[data-bench-apply-routing]').click()
  await page.waitForFunction(() => document.querySelector('[data-bench-preview-meta]')?.textContent.includes('components'), null, { timeout: 30000 })
  const meta = await page.locator('[data-bench-preview-meta]').innerText()
  assert.match(meta, /components/, meta)
  record('the routed task compiles as three nested levels: ' + meta)
  const taskIds = await page.locator('[data-bench-task] option').allInnerTexts()
  assert.deepEqual(taskIds, ['row-1', 'row-2'], 'one ordinary task per row')
  const taskJson = JSON.parse(await page.locator('[data-bench-task-json]').inputValue())
  assert.ok(taskJson.root.use, 'the routed task has a root')
  assert.deepEqual(taskJson.variables, { situation: 'urgent', size: 'large' }, 'the fields the rules read travel into the task')
  record('generated ' + taskIds.join(', ') + ' carrying ' + JSON.stringify(taskJson.variables))
  await page.screenshot({ path: path.join(output, 'compose-routed-task.png'), fullPage: true })

  const unrelated = errors.filter(message => /research-|benchmark|routing/.test(message))
  assert.deepEqual(unrelated, [], 'no page errors from the research modules')
  const report = { ok: true, origin, output, checks, unrelatedPageErrors: errors }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally { await browser?.close() }
