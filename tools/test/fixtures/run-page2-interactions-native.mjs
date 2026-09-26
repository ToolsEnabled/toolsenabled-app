// Reversible UI checks against an explicit native dev instance. Never creates
// nodes, starts sessions, sends messages, or changes stored communication links.
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
if (!process.argv[2]) throw new Error('Pass the isolated native-dev.json record.')
const info = JSON.parse(readFileSync(process.argv[2], 'utf8'))
assert.equal(info.root, fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, ''))
assert.ok(info.profile.startsWith(path.join(os.homedir(), '.toolsenabled-native-dev') + path.sep))
const out = path.join(info.profile, 'interaction-check')
mkdirSync(out, { recursive: true })
const browser = await chromium.connectOverCDP(info.debugOrigin, { timeout: 8000 })
try {
  const page = browser.contexts()[0].pages()[0]
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.evaluate(() => { location.hash = '#/computers' })
  await page.waitForFunction(() => window.__mcGraph?.computer.id === 'this-computer')
  const before = await page.evaluate(async () => ({
    agents: window.__mcGraph.computer.agents.map(agent => agent.id),
    links: (await mcAgent.treeLinks()).links,
  }))
  await page.evaluate(() => { __mcGraph._hideChats(); __mcGraph.setWide(false); __mcGraph.clearRoot() })
  await page.waitForTimeout(200)
  assert.equal(await page.locator('.graph-bar .graph-tree-switch, .graph-bar .graph-tree-starts').count(), 0)
  const target = await page.evaluate(() => [...__mcGraph.nodes.values()].find(record => !record.el.hidden && !record.agent.treeScope?.group
    && __mcGraph.computer.agents.some(agent => agent.parentId === record.id))?.id)
  assert.ok(target, 'provide a saved branch for click/double-click review')
  const node = () => page.locator(`.node[data-agent-id="${target}"]`)
  await node().click()
  await page.waitForFunction(id => __mcGraph.activeChatId === id && !__mcGraph.chatShelf.hidden, target)
  assert.equal(await page.evaluate(() => __mcGraph.rootId || null), null)
  await page.locator('.tree-chat-collapse').click()
  await node().dblclick()
  await page.waitForFunction(id => __mcGraph.rootId === id, target)
  await page.waitForTimeout(300)
  assert.equal(await page.locator('.tree-conversations').isVisible(), false, 'double-click keeps the canvas open')
  await page.locator('.graph-fit').click()
  assert.equal(await page.evaluate(() => __mcGraph.rootId), target, 'Fit keeps the selected branch')
  await page.locator('.graph-crumb > button').first().click()
  await page.locator('.graph-open-btn').click()
  const fullWidth = await page.locator('.tree-conversation:visible').evaluate(panel => ({
    panel: panel.getBoundingClientRect().width,
    log: panel.querySelector('.chat-log').getBoundingClientRect().width,
    input: panel.querySelector('.chat-input').getBoundingClientRect().width,
  }))
  assert.ok(fullWidth.log > fullWidth.panel * 0.95 && fullWidth.input > fullWidth.panel * 0.95)
  assert.equal(await page.evaluate(() => __mcGraph._treeWide), true)
  await page.screenshot({ path: path.join(out, 'full-chat.png') })
  await page.locator('.tree-chat-full').click()
  // Old saved sizes must not clip the composer after reopening the app.
  // Change only the mounted style for this probe, never its saved preference.
  const shelfStyle = await page.locator('.tree-conversations').getAttribute('style')
  await page.locator('.tree-conversations').evaluate(shelf => shelf.style.setProperty('--conversation-height', '220px'))
  await page.waitForTimeout(100)
  const shortDock = await page.locator('.tree-conversation:visible').evaluate(panel => ({
    panel: panel.getBoundingClientRect().toJSON(),
    input: panel.querySelector('.chat-input').getBoundingClientRect().toJSON(),
  }))
  assert.ok(shortDock.input.bottom <= shortDock.panel.bottom && shortDock.input.top >= shortDock.panel.top,
    'a short restored dock keeps the composer inside the visible chat')
  await page.screenshot({ path: path.join(out, 'short-dock.png') })
  await page.locator('.tree-conversations').evaluate((shelf, style) => {
    if (style === null) shelf.removeAttribute('style'); else shelf.setAttribute('style', style)
  }, shelfStyle)
  await page.locator('.tree-chat-collapse').click()
  await page.locator('.graph-fit').click()
  const fitted = await page.evaluate(() => __mcGraph.zoom)
  async function inspectAddControls() {
    const gaps = await page.evaluate(() => {
      const g = __mcGraph
      return [...g.emptySlots.values()].filter(slot => !slot.hidden && slot.parentId && slot.r < 34).map(slot => {
        const a = g.nodes.get(slot.parentId).el.getBoundingClientRect(), b = slot.el.getBoundingClientRect()
        return Math.hypot(b.x + b.width / 2 - a.x - a.width / 2, b.y + b.height / 2 - a.y - a.height / 2)
          - a.width / 2 - b.width / 2
      })
    })
    assert.ok(gaps.length > 0)
    assert.ok(gaps.every(gap => Math.abs(gap - 8) < 1), `add circles keep their gap: ${JSON.stringify(gaps)}`)
  }
  await inspectAddControls()
  for (let i = 0; i < 12; i++) await page.locator('.gz-out').click()
  await page.waitForFunction(() => !__mcGraph._zoomMotion && !__mcGraph._zoomFrame)
  const zoomedOut = await page.evaluate(() => __mcGraph.zoom)
  assert.ok(zoomedOut < fitted / 2)
  assert.equal(await page.evaluate(() => __mcGraph.screenOverlay.hidden), true, 'context cards step aside in the distant overview')
  await inspectAddControls()
  await page.screenshot({ path: path.join(out, 'zoomed-out.png') })
  await page.locator('.graph-fit').click()
  assert.ok(Math.abs(await page.evaluate(() => __mcGraph.zoom) - fitted) < 0.001)
  assert.equal(await page.evaluate(() => __mcGraph.screenOverlay.hidden), false, 'Fit restores the context cards')
  const paths = await page.locator('.link-direct').evaluateAll(elements => elements.map(el => el.getAttribute('d')))
  assert.ok(paths.every(d => d.includes(' L ') && !d.includes(' Q ')), 'direct links have no sag')
  await page.locator('.tree-more > summary').click()
  assert.equal(await page.locator('.graph-edit-btn').isVisible(), true)
  await page.locator('.tree-more > summary').press('Escape')
  assert.equal(await page.locator('.graph-edit-btn').isVisible(), false)
  await page.screenshot({ path: path.join(out, 'tree.png') })
  const after = await page.evaluate(async () => ({
    agents: __mcGraph.computer.agents.map(agent => agent.id),
    links: (await mcAgent.treeLinks()).links,
  }))
  assert.deepEqual(after, before, 'UI inspection preserves saved agents and communication links')
  assert.deepEqual(errors, [])
  writeFileSync(path.join(out, 'results.json'), JSON.stringify({ fullWidth, shortDock, fitted, zoomedOut, straightLinks: paths.length, savedStatePreserved: true, errors }, null, 2))
  console.log(`PASS native: click/chat, double-click/branch, full width, More, zoom-out, Fit, aligned + controls and straight links. Evidence: ${out}`)
} finally { await browser.close() }
