import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

// Normal Home controls and the example fleet's normal heartbeat. No calls
// to the renderer's play API, simulated DOM changes or provider requests.
const output = path.resolve(process.argv[2] || 'home-circle-agent-qa')
const origin = process.argv[3] || 'http://127.0.0.1:4623'
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname))
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
// Peer hotload edits should not reload this independent acceptance session.
await context.routeWebSocket(url => url.host === new URL(origin).host && url.searchParams.has('token'), socket => socket.close())
await context.addInitScript(() => {
  localStorage.setItem('mc.set.home_circle_style', 'standard')
  localStorage.setItem('mc.set.home_circle_motion', 'animate')
})
const page = await context.newPage(), report = { checks: [] }, errors = []
page.on('pageerror', error => errors.push(error.message))
const state = () => page.evaluate(() => {
  const ring = document.querySelector('.home-circle')
  // A recorded run can have no agent identity. It cannot be followed; the
  // next named run is the first agent actually displayed in this scope.
  const row = [...document.querySelectorAll('.home-runs .home-run:not([hidden])')]
    .find(node => node.querySelector('.run-agent')?.textContent.trim())
  return { key: ring.dataset.agentKey, name: ring.dataset.agentName, top: row?.querySelector('.run-agent')?.textContent,
    followed: row?.hasAttribute('data-followed'), stats: ring.homeCircleFluid.stats() }
})
const record = async name => {
  const measured = await state()
  assert.equal(measured.name, measured.top, 'the circle follows the first displayed run')
  assert.equal(measured.followed, true)
  assert.equal(measured.stats.agent.key, measured.key)
  report.checks.push({ name, ...measured })
  await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n')
  console.log('PASS', name, measured.key)
  return measured
}
try {
  await page.goto(`${origin}/#/`, { waitUntil: 'load', timeout: 60000 })
  await page.locator('[data-home-glance]:not([hidden])').waitFor()
  const tip = page.getByRole('button', { name: 'Not now', exact: true })
  if (await tip.isVisible()) await tip.click()
  assert.match(await page.locator('.panel-badge').textContent(), /example/i)
  await page.waitForFunction(() => document.querySelector('.home-circle')?.homeCircleFluid?.stats().steps > 30)
  const initial = await record('Initial All agents follows the displayed head')
  assert.equal(initial.stats.played, 0, 'mounting the first agent is not a switch')
  const pick = page.locator('[data-home-agent]')
  const choices = await pick.locator('option').evaluateAll(nodes => nodes.map(node => node.value))
  const other = choices.find(key => key && key !== initial.key)
  assert.ok(other, 'there are multiple example agents')
  await pick.selectOption(other)
  await page.waitForFunction(key => {
    const s = document.querySelector('.home-circle').homeCircleFluid.stats()
    return s.agent.key === key && s.episode?.reason === 'agent-change'
  }, other)
  await record('Dropdown starts Navier-Stokes for the selected agent')
  await page.screenshot({ path: path.join(output, 'dropdown-transition.png') })
  await page.waitForFunction(() => !document.querySelector('.home-circle').homeCircleFluid.stats().episode, null, { timeout: 20000 })

  await pick.selectOption('')
  await page.waitForFunction(() => document.querySelector('.home-circle').homeCircleFluid.stats().episode?.reason === 'agent-change')
  await record('All agents restores the topmost agent through the same transition')
  await page.waitForFunction(() => !document.querySelector('.home-circle').homeCircleFluid.stats().episode, null, { timeout: 20000 })
  const beforeAutomatic = await state()
  await page.waitForFunction(key => {
    const ring = document.querySelector('.home-circle'), s = ring.homeCircleFluid.stats()
    return ring.dataset.agentKey !== key && s.agent.key === ring.dataset.agentKey && s.episode?.reason === 'agent-change'
  }, beforeAutomatic.key, { timeout: 100000 })
  await record('Normal example heartbeat switches the followed agent automatically')
  await page.screenshot({ path: path.join(output, 'automatic-transition.png') })
  await page.waitForFunction(() => !document.querySelector('.home-circle').homeCircleFluid.stats().episode, null, { timeout: 20000 })

  await page.locator('[data-chat-expand]').click()
  await page.locator('.home-takeover').waitFor({ state: 'visible' })
  const beforeFull = await state()
  await page.waitForFunction(key => document.querySelector('.home-circle').dataset.agentKey !== key, beforeFull.key, { timeout: 100000 })
  // Full view may hide/pause the circle. Returning must show the latest agent,
  // with a transition played either as it changed or as the circle resumes.
  await page.locator('[data-chat-collapse]').click()
  await page.waitForFunction(played => {
    const ring = document.querySelector('.home-circle'), s = ring.homeCircleFluid.stats()
    return s.agent.key === ring.dataset.agentKey && s.played > played
  }, beforeFull.stats.played)
  await record('Automatic changes in Full view carry the latest agent back to Home')
  await page.screenshot({ path: path.join(output, 'full-view-return.png') })
  assert.deepEqual(errors, [], 'no page exceptions')
  report.passed = true
} catch (error) {
  report.passed = false; report.error = error.stack
  await page.screenshot({ path: path.join(output, 'failure.png') })
  throw error
} finally {
  report.errors = errors
  await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n')
  await context.close(); await browser.close()
}
