// Native integration check. Requires an explicitly named isolated dev instance
// containing two development-example roots and no running sessions.
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const recordFile = process.argv[2]
if (!recordFile) throw new Error('Pass the isolated instance native-dev.json path.')
const info = JSON.parse(readFileSync(recordFile, 'utf8'))
assert.equal(info.root, fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, ''))
assert.ok(info.profile.startsWith(path.join(os.homedir(), '.toolsenabled-native-dev') + path.sep))
const out = path.join(info.profile, 'page2-check')
mkdirSync(out, { recursive: true })
const browser = await chromium.connectOverCDP(info.debugOrigin, { timeout: 8000 })
try {
  const page = browser.contexts()[0].pages()[0]
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.evaluate(() => { location.hash = '#/computers' })
  await page.waitForFunction(() => window.__mcGraph?.computer.id === 'this-computer')
  assert.deepEqual(await page.evaluate(async () => (await window.mcAgent.sessionAccounts()).sessions), [])
  const roots = await page.evaluate(() => window.__mcGraph.computer.agents.filter(agent => !agent.parentId)
    .map(agent => ({ id: agent.id, message: agent.treeNode?.message })))
  assert.equal(roots.length, 2)
  assert.ok(roots.every(root => root.message.startsWith('Development example:')))
  await page.evaluate(() => {
    window.__mcGraph._hideChats()
    window.__mcGraph.setWide(false)
    window.__mcGraph.resetToOverview()
  })
  const node = id => page.locator(`.node[data-agent-id="${id}"]`)
  const saved = await page.evaluate(() => window.mcAgent.treeLinks())
  assert.ok(saved.links.every(link => roots.some(root => root.id === link.from) && roots.some(root => root.id === link.to)), 'leave unrelated links alone')
  if (saved.links.length) {
    await page.locator('.tree-link-marker').click()
    await page.locator('.link-remove').click()
    await page.waitForFunction(() => window.__mcGraph.communicationLinks.length === 0)
  }
  async function linkRoots() {
    await page.locator('.tree-link-toggle').click()
    await node(roots[0].id).click()
    await node(roots[1].id).click()
    await page.waitForFunction(() => window.__mcGraph.communicationLinks.length === 1)
    assert.equal(await page.locator('.link-direct').count(), 1)
    assert.equal(await page.locator('.tree-link-marker text').textContent(), '›')
  }
  await linkRoots()
  const created = await page.evaluate(() => window.mcAgent.treeLinks())
  await page.locator('.tree-link-marker').click()
  assert.equal(await page.locator('.tree-link-popover').isVisible(), true)
  await page.locator('.link-dismiss').click()
  await page.screenshot({ path: path.join(out, 'linked-tree.png') })
  await page.reload()
  await page.waitForFunction(() => window.__mcGraph?.communicationLinks.length === 1)
  await page.locator('.tree-link-marker').click()
  await page.locator('.link-remove').click()
  await page.waitForFunction(() => window.__mcGraph.communicationLinks.length === 0)
  assert.deepEqual((await page.evaluate(() => window.mcAgent.treeLinks())).links, [])
  await linkRoots()
  assert.equal(await page.evaluate(() => !!window.__mcGraph._treeWide), false)
  await page.locator('.graph-open-btn').click()
  assert.equal(await page.evaluate(() => window.__mcGraph._treeWide), true, 'Full chat opens the whole workspace directly')
  assert.equal(await page.locator('.tree-conversations').evaluate(el => el.classList.contains('is-expanded')), true)
  await page.locator('.tree-chat-add').click()
  await page.locator(`.tree-chat-options button[data-agent-id="${roots[1].id}"]`).click()
  assert.equal(await page.locator('.tree-chat-tab').count(), 2)
  assert.equal(await page.locator('.tree-conversation:visible').count(), 1)
  assert.equal(await page.locator('.tree-conversations').evaluate(el => el.classList.contains('is-expanded')), true)
  await page.locator(`.tree-chat-tab[data-agent-id="${roots[0].id}"]`).click()
  const alignment = await page.locator('.tree-conversation:visible').evaluate(panel => {
    const input = panel.querySelector('.chat-input').getBoundingClientRect()
    const actions = panel.querySelector('.chat-common-actions').getBoundingClientRect()
    return Math.abs(input.left - actions.left) < 1 && Math.abs(input.width - actions.width) < 1
  })
  assert.equal(alignment, true, 'full chat commands follow the composer column')
  await page.screenshot({ path: path.join(out, 'full-chat.png') })
  await page.locator('.tree-chat-full').click()
  assert.equal(await page.evaluate(() => window.__mcGraph._treeWide), false, 'Dock restores the original page width')
  await page.screenshot({ path: path.join(out, 'chat-dock.png') })
  assert.deepEqual(errors, [])
  writeFileSync(path.join(out, 'results.json'), JSON.stringify({ native: info, created, persisted: true, unlinkVerified: true, tabSwitchVerified: true, errors }, null, 2))
  console.log(`PASS native: two-node link, visible › control, persistence, unlink, tab switching and full chat. Evidence: ${out}`)
} finally { await browser.close() }
