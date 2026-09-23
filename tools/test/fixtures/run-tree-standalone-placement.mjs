import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
const root = fileURLToPath(new URL('../../../', import.meta.url))
const requested = process.env.TREE_STANDALONE_PLACEMENT_EVIDENCE
const out = requested && !existsSync(requested) ? requested : mkdtempSync(requested ? `${requested}-` : path.join(tmpdir(), 'tree-standalone-placement-'))
mkdirSync(out, { recursive: true })
const files = ['src/tree-workspace.js', 'src/tree-workspace.css', 'src/tree-standalone-placement.js', 'src/tree-standalone-agent.js', 'src/agent-session.js', 'src/tree-graph.js',
  'tools/test/fixtures/tree-standalone-placement.html', 'tools/test/fixtures/tree-standalone-placement.mjs', 'tools/test/fixtures/run-tree-standalone-placement.mjs']
const hashes = () => Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')]))
const before = hashes(), results = [], errors = []
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const server = await createServer({ root, configFile: false, cacheDir: path.join(out, 'vite-cache'), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null, fs: { allow: [root, realpathSync(path.join(root, 'node_modules'))] } } })
let browser, page, stage = 'load'
try {
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1500, height: 950 }, reducedMotion: 'reduce' })
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  await page.goto(`${origin}/tools/test/fixtures/tree-standalone-placement.html`)
  await page.waitForFunction(() => window.placementFixture?.ready)
  await page.evaluate(() => document.fonts.ready)
  const tab = id => page.locator(`[role="tab"][data-agent-id="${id}"]`)
  const activePanel = () => page.locator('.tree-standalone-conversation:not([hidden])')
  const add = async () => {
    await page.locator('.tree-chat-add').click(); await page.locator('.tree-new-agent').click()
    if (await page.locator('.tree-agent-notice').isVisible()) await page.locator('.tree-agent-continue').click()
    await activePanel().locator('.chat-input input').waitFor()
    const id = await page.evaluate(() => graph.activeChatId)
    await page.evaluate(id => {
      const r = graph.workspace.standalone.get(id)
      placementFixture.originals ||= new Map()
      placementFixture.originals.set(id, { record: r, panel: r.chatPanel, session: r.session })
    }, id)
    return id
  }
  const intact = id => page.evaluate(id => {
    const r = graph.workspace.standalone.get(id), original = placementFixture.originals.get(id)
    return r === original.record && r.chatPanel === original.panel && r.session === original.session && r.chatPanel.isConnected
  }, id)
  const first = await add()
  assert.equal(await page.evaluate(() => placementFixture.calls.length), 0, 'opening a tab does not start work')
  await activePanel().locator('.chat-input input').fill('Preserve this draft through placement')
  stage = 'placement menu'
  await page.locator('.tree-standalone-place').click()
  const picker = page.locator('.tree-standalone-placement')
  assert.match(await picker.locator('option[value="reviewer"]').textContent(), /Reviewer — Reviewer tree/)
  assert.equal(await picker.locator('option[value="review-child"]').count(), 0, 'parents that cannot accept a child are not offered')
  await page.setViewportSize({ width: 360, height: 640 })
  await page.evaluate(async () => { document.documentElement.dataset.theme = 'black'; (await import('/src/text-size.js')).applyTextSize(1.12) })
  await page.waitForTimeout(150)
  const bounds = await picker.evaluate(node => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight } })
  assert.ok(bounds.left >= 0 && bounds.top >= 0 && bounds.right <= bounds.width + 1 && bounds.bottom <= bounds.height + 1, JSON.stringify(bounds))
  await page.screenshot({ path: path.join(out, 'placement-narrow-dark.png') })
  await picker.locator('select').press('Escape')
  await picker.waitFor({ state: 'detached' })
  assert.equal(await page.evaluate(() => graph.workspace.mode), 'chat')
  await page.setViewportSize({ width: 1500, height: 950 })
  await page.evaluate(async () => { document.documentElement.dataset.theme = 'white'; (await import('/src/text-size.js')).applyTextSize(1) })
  await page.locator('.tree-standalone-place').click()
  await picker.locator('select').selectOption('reviewer')
  await page.evaluate(() => { placementFixture.hold = true; placementFixture.fail = true })
  await picker.locator('.tree-standalone-place-confirm').click()
  assert.equal(await picker.locator('.tree-standalone-place-confirm').isDisabled(), true)
  assert.equal(await page.locator('.tree-chat-tab-wrap').filter({ has: tab(first) }).locator('.tree-chat-tab-close').isDisabled(), true)
  await page.evaluate(id => { void graph.workspace.placeStandalone(id, null); graph.workspace.close(graph.workspace.standalone.get(id)) }, first)
  assert.equal(await page.evaluate(() => placementFixture.placements.length), 1)
  assert.equal(await intact(first), true)
  await page.evaluate(() => placementFixture.finish())
  await picker.locator('.tree-standalone-place-error').waitFor()
  assert.match(await picker.locator('.tree-standalone-place-error').textContent(), /temporarily unavailable/)
  assert.equal(await intact(first), true)
  await page.evaluate(() => { placementFixture.hold = false; placementFixture.fail = false })
  await picker.locator('.tree-standalone-place-confirm').click()
  await picker.waitFor({ state: 'detached' })
  const firstNode = await page.evaluate(id => graph.workspace.standalone.get(id).treeNodeId, first)
  assert.equal(await intact(first), true)
  assert.equal(await tab(first).getAttribute('draggable'), 'false')
  assert.match(await tab(first).textContent(), /Placed Agent 1/)
  assert.equal(await page.locator('.tree-standalone-place').isVisible(), false)
  assert.equal(await activePanel().locator('.chat-input input').inputValue(), 'Preserve this draft through placement')
  await page.locator('.tree-home-tab').click()
  await page.evaluate(id => graph.openChat(graph.nodes.get(id)), firstNode)
  assert.equal(await page.evaluate(() => graph.activeChatId), first)
  assert.equal(await intact(first), true)
  assert.equal(await page.evaluate(() => placementFixture.calls.length), 0)
  results.push({ stage, bounds, firstNode, placements: await page.evaluate(() => placementFixture.placements) })

  const drag = async (id, target) => {
    const start = await tab(id).boundingBox()
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2)
    await page.mouse.down()
    await page.mouse.move(start.x + start.width / 2 + 12, start.y + start.height / 2 + 14, { steps: 5 })
    await page.waitForFunction(() => graph.workspace.mode === 'trees' && !!graph.workspace.draggedStandaloneId)
    await page.waitForTimeout(150)
    assert.equal(await intact(id), true, 'drag reveal keeps the actual source tab and composer alive')
    const end = await target.boundingBox()
    assert.ok(end, 'the requested real tree drop target is visible')
    await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 15 })
    await page.mouse.up()
    await page.waitForFunction(id => !!graph.workspace.standalone.get(id)?.treeNodeId, id)
    await page.waitForFunction(() => !graph.workspace.draggedStandaloneId)
    assert.equal(await page.locator('.standalone-drop-target').count(), 0, 'drop highlights are cleaned after drag')
    assert.equal(await intact(id), true)
  }
  stage = 'new tree drag retains a running chat'
  await page.locator('.tree-home-tab').click()
  await page.evaluate(() => { graph.treeWindows.choose(graph.treeWindows.windows[0], ['reviewer', 'researcher']); graph.fitCurrentTree() })
  const second = await add()
  await activePanel().locator('.chat-input input').fill('Start the explicitly synthetic session')
  await activePanel().locator('.chat-input input').press('Enter')
  await page.waitForFunction(() => placementFixture.calls.some(([kind]) => kind === 'send'))
  const sessionId = await page.evaluate(() => placementFixture.calls.find(([kind]) => kind === 'start')[1].sessionId)
  await page.evaluate(sessionId => placementFixture.emit(sessionId, { type: 'turn_completed', status: 'completed', turnId: 'turn-1' }), sessionId)
  await activePanel().locator('.chat-input input').fill('Draft after the first turn')
  assert.equal(await page.locator('.tree-empty-node[data-empty-kind="new-tree"]').count(), 0)
  await drag(second, page.locator('.tree-chat-add'))
  assert.equal(await page.evaluate(() => placementFixture.placements.at(-1).parentId), null)
  assert.deepEqual(await page.evaluate(() => placementFixture.lastDrag), { payload: JSON.stringify({ id: second, computerId: 'tree-box-fixture' }), effect: 'move' })
  await tab(second).click()
  assert.equal(await activePanel().locator('.chat-input input').inputValue(), 'Draft after the first turn')
  assert.equal(await page.evaluate(() => placementFixture.calls.filter(([kind]) => kind === 'start').length), 1)
  assert.equal(await page.evaluate(() => placementFixture.calls.filter(([kind]) => kind === 'close').length), 0)
  results.push({ stage, nodeId: await page.evaluate(id => graph.workspace.standalone.get(id).treeNodeId, second), sessionId })

  stage = 'circle child drop'
  await page.locator('.tree-home-tab').click()
  await page.evaluate(() => { graph.setNodeStyle('circles'); graph.treeWindows.choose(graph.treeWindows.windows[0], 'reviewer'); graph.fitCurrentTree() })
  const third = await add()
  await drag(third, page.locator('.tree-empty-node[data-empty-kind="child"][data-parent-id="reviewer"]').first())
  assert.equal(await page.evaluate(() => placementFixture.placements.at(-1).parentId), 'reviewer')
  results.push({ stage, nodeId: await page.evaluate(id => graph.workspace.standalone.get(id).treeNodeId, third) })

  stage = 'secondary box child drop'
  await page.evaluate(() => { graph.setNodeStyle('boxes'); graph.setCardSize('medium'); graph.treeWindows.add('researcher'); graph.fitCurrentTree() })
  const fourth = await add()
  const target = page.locator('.tree-window').nth(1).locator('.node[data-agent-id="researcher"] .tree-box-add-agent')
  await drag(fourth, target)
  assert.equal(await page.evaluate(() => placementFixture.placements.at(-1).parentId), 'researcher')
  assert.equal(await page.evaluate(() => graph.workspace.standalone.size), 4)
  results.push({ stage, nodeId: await page.evaluate(id => graph.workspace.standalone.get(id).treeNodeId, fourth) })

  stage = 'refused foreign drop'
  const fifth = await add()
  await page.locator('.tree-home-tab').click()
  const count = await page.evaluate(() => placementFixture.placements.length)
  await target.evaluate((node, id) => {
    const transfer = new DataTransfer()
    transfer.setData('application/x-toolsenabled-standalone-agent', JSON.stringify({ id, computerId: 'another-computer' }))
    node.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
  }, fifth)
  assert.equal(await page.evaluate(() => placementFixture.placements.length), count)
  assert.equal(await page.evaluate(id => graph.workspace.standalone.get(id).treeNodeId || null, fifth), null)
  assert.equal(await intact(fifth), true)
  await page.screenshot({ path: path.join(out, 'placed-agent-trees.png') })
  await page.evaluate(() => graph.destroy())
  assert.equal(await page.evaluate(() => placementFixture.listeners.size), 0)
  assert.deepEqual(errors, [])
  const after = hashes(), sourceChangedDuringRun = JSON.stringify(before) !== JSON.stringify(after)
  writeFileSync(path.join(out, 'evidence.json'), JSON.stringify({ passed: true, sourceChangedDuringRun, before, after, results, errors }, null, 2))
  console.log(JSON.stringify({ out, passed: true, stages: results.length, sourceChangedDuringRun, errors }))
} catch (error) {
  writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ stage, error: error.message, results, errors, before, after: hashes() }, null, 2))
  await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {})
  console.error(`Evidence: ${out}; stage: ${stage}`); throw error
} finally { await browser?.close(); await server.close() }
