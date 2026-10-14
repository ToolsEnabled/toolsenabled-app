import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

// Source browser only, fresh example storage and blocked off-origin requests.
assert.ok(process.argv[2] && process.argv[3], 'Supply an output directory and an independently served source origin.')
const output = path.resolve(process.argv[2]), origin = new URL(process.argv[3]).origin
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname), 'Following QA requires a loopback source origin')
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, ...(process.env.HOME_QA_BROWSER ? { executablePath: path.resolve(process.env.HOME_QA_BROWSER) } : {}) })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.route('**/*', route => {
  const url = new URL(route.request().url())
  return url.origin === origin || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort('blockedbyclient')
})
await context.routeWebSocket(url => url.host === new URL(origin).host && url.searchParams.has('token'), socket => socket.close())
await context.addInitScript(() => {
  localStorage.clear(); localStorage.setItem('mc.example', 'on')
  localStorage.setItem('mc.set.feature_guides.v1', JSON.stringify({version: 1, quiet: true, seen: {}}))
})
const page = await context.newPage(), report = { checks: [], bounds: { automaticChangeTimeoutMs: 100000 } }, errors = []
page.on('pageerror', error => errors.push(error.message))
const state = () => page.evaluate(() => {
  const card = document.querySelector('[data-home-following]')
  const rows = [...document.querySelectorAll('.home-runs .home-run:not([hidden])')]
    .filter(node => node.querySelector('.run-agent')?.textContent.trim())
  // The real action line is populated from the same observed/example-work
  // value used by Following. Then attention, then displayed order.
  const row = rows.find(node => node.querySelector('.run-action')?.textContent.trim())
    || rows.find(node => node.dataset.status === 'attention') || rows[0]
  return { key: card.dataset.agentKey, name: card.dataset.agentName,
    expected: row?.querySelector('.run-agent')?.textContent || '',
    followed: row?.hasAttribute('data-followed') ?? false,
    action: card.querySelector('[data-follow-action]').textContent }
})
const record = async name => {
  const got = await state()
  assert.equal(got.name, got.expected, 'Following preserves actual work/attention/display-order precedence')
  assert.equal(got.followed, Boolean(got.name))
  report.checks.push({ check: name, ...got })
  await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n')
  return got
}
try {
  await page.goto(`${origin}/#/`, { waitUntil: 'load', timeout: 60000 })
  await page.locator('[data-home-glance]:not([hidden])').waitFor()
  assert.match(await page.locator('[data-panel-badge]').textContent(), /example/i)
  const initial = await record('Initial All trees follows the actual active row')
  const pick = page.locator('[data-home-agent]')
  const choices = await pick.locator('option[data-kind="agent"]').evaluateAll(nodes => nodes.map(node => node.value))
  const other = choices.find(key => key && key !== initial.key)
  assert.ok(other, 'the example offers multiple agents')
  await pick.selectOption(other)
  await page.waitForFunction(key => document.querySelector('[data-home-following]').dataset.agentKey === key, other)
  await record('Dropdown follows the chosen agent and opens its existing chat')
  assert.ok(await page.locator('[data-home-chat]').isVisible())
  await page.screenshot({ path: path.join(output, 'dropdown.png') })
  await pick.selectOption('')
  await record('All trees restores the active agent in displayed order')
  const before = await state()
  await page.waitForFunction(key => document.querySelector('[data-home-following]').dataset.agentKey !== key, before.key, { timeout: 100000 })
  await record('The normal example heartbeat follows the newly active agent')
  await page.locator('[data-chat-expand]').click()
  await page.locator('[data-chat-takeover]:not([hidden])').waitFor()
  await page.locator('[data-chat-view="everything"]').click()
  const beforeFull = await state()
  await page.waitForFunction(key => document.querySelector('[data-home-following]').dataset.agentKey !== key, beforeFull.key, { timeout: 100000 })
  await page.locator('[data-chat-collapse]').click()
  await record('Full view returns to Home with current Following identity')
  await page.screenshot({ path: path.join(output, 'full-view-return.png') })
  assert.deepEqual(errors, [], 'no page exceptions')
  report.passed = true
} catch(error) {
  report.passed = false; report.error = error.stack
  await page.screenshot({ path: path.join(output, 'failure.png') }); throw error
} finally {
  report.errors = errors
  await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n')
  await context.close(); await browser.close()
}
