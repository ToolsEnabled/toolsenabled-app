import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const out = process.env.TREE_CHAT_EVIDENCE || mkdtempSync(path.join(tmpdir(), 'tree-chat-workspace-'))
const baseline = process.argv.includes('--baseline')
const sourceState = () => ['rev-parse HEAD', 'status --porcelain=v1', 'diff --binary HEAD'].map(command =>
  execFileSync('git', command.split(' '), { cwd: root, encoding: 'utf8' }))
const sourceBefore = sourceState()
writeFileSync(path.join(out, 'source-before.json'), JSON.stringify(sourceBefore, null, 2))
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const server = await createServer({
  root, configFile: false, cacheDir: path.join(out, 'vite-cache'), logLevel: 'error',
  plugins: baseline ? [{ name: 'baseline-tree', enforce: 'pre', load(id) {
    for (const name of ['src/tree-graph.js', 'src/tree-layout.js', 'src/tree-graph.css']) {
      if (id === path.join(root, name)) return execFileSync('git', ['show', `142e0bc9:${name}`], { cwd: root, encoding: 'utf8' })
    }
  } }] : [],
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null, fs: { allow: [root, realpathSync(path.join(root, 'node_modules'))] } },
})
let browser
const results = []
try {
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1854, height: 1040 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  await page.goto(`${origin}/tools/test/fixtures/tree-chat-workspace.html`)
  await page.waitForFunction(() => window.fixture?.metrics)
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(800)
  results.push(await page.evaluate(() => fixture.metrics()))
  await page.screenshot({ path: path.join(out, 'tree.png') })
  if (!baseline) {
    await page.locator('.node[data-agent-id="controller"]').click()
    await page.waitForSelector('.tree-chat-tab[data-agent-id="controller"]')
    assert.equal(await page.evaluate(() => graph.rootId || null), null, 'single-click opens chat without changing the branch')
    await page.locator('.tree-chat-collapse').click()
    await page.locator('.node[data-agent-id="manager"]').dblclick()
    await page.waitForFunction(() => graph.rootId === 'manager')
    await page.waitForTimeout(300)
    assert.equal(await page.locator('.tree-chat-tab[data-agent-id="manager"]').count(), 0, 'double-click focuses before opening chat can move the target')
    await page.evaluate(() => graph.clearRoot())
  }
  await page.evaluate(() => { graph.openChat(graph.nodes.get('controller')); graph.openChat(graph.nodes.get('manager')) })
  await page.waitForTimeout(700)
  results.push(await page.evaluate(() => fixture.metrics()))
  await page.screenshot({ path: path.join(out, 'two-chats.png') })
  if (!baseline) {
    assert.equal(results.at(-1).chats, 2, 'opening a second conversation must keep the first open')
    assert.ok(results[0].previews >= 5, 'the crowded 20-agent fixture must expose several previews')
    const moreClick = async selector => {
      await page.locator('.tree-more > summary').click()
      await page.locator(selector).click()
    }
    const card = id => page.locator(`.tree-conversation[data-agent-id="${id}"]`)
    const input = id => card(id).locator('.chat-input input')
    const tab = id => page.locator(`.tree-chat-tab[data-agent-id="${id}"]`)
    const open = async id => {
      await page.locator('.tree-chat-add').click()
      await page.locator(`.tree-chat-options button[data-agent-id="${id}"]`).click()
    }
    await tab('controller').click()
    assert.equal(await input('controller').evaluate(el => el === document.activeElement), true, 'switching tabs focuses the composer')
    await input('controller').fill('Controller only')
    await input('controller').press('Enter')
    await tab('manager').click()
    await input('manager').fill('Manager only')
    await input('manager').press('Enter')
    await page.waitForFunction(() => fixture.sends.length === 2)
    assert.deepEqual(await page.evaluate(() => fixture.sends), [{ id: 'controller', text: 'Controller only' }, { id: 'manager', text: 'Manager only' }])
    await page.evaluate(() => { fixture.busy.add('controller'); fixture.notify('controller') })
    await tab('controller').click()
    await input('controller').fill('Wait for Controller')
    await input('controller').press('Enter')
    await page.waitForFunction(() => fixture.queues.get('controller').length === 1)
    assert.equal(await card('controller').locator('.chat-queue-strip').isVisible(), true)
    assert.equal(await card('manager').locator('.chat-queue-strip').isVisible(), false)
    await page.evaluate(() => { fixture.busy.clear(); fixture.queues.set('controller', []); fixture.notify('controller') })
    await input('controller').fill('Keep this draft through navigation')
    await card('controller').locator('[data-chat-attach]').click()
    await page.waitForFunction(() => graph.nodes.get('controller').chatRoot.exportDraft().attachments.length === 1)
    await page.evaluate(() => graph.setRoot('manager'))
    await page.waitForTimeout(220)
    assert.equal(await input('controller').inputValue(), 'Keep this draft through navigation')
    assert.equal(await page.evaluate(() => graph.nodes.get('controller').el.hidden), true)
    assert.equal(await card('controller').isVisible(), true, 'a pinned chat survives outside the focused branch')
    await page.locator('.tree-chat-collapse').click()
    assert.equal(await card('controller').isVisible(), false)
    await moreClick('.tree-chats-toggle')
    await page.locator('.tree-chat-tab[data-agent-id="controller"]').click()
    assert.equal(await input('controller').inputValue(), 'Keep this draft through navigation')
    await page.evaluate(() => { fixture.nodes[0].sessionId = 'replacement-session'; graph.refresh() })
    assert.equal(await input('controller').inputValue(), 'Keep this draft through navigation')
    assert.equal(await page.evaluate(() => graph.nodes.get('controller').chatRoot.exportDraft().attachments.length), 1)
    assert.equal(await page.evaluate(() => fixture.subscribers.get('controller').size), 2, 'reconnect disposes the old status/queue subscriptions')
    await page.evaluate(() => graph.clearRoot())
    await page.locator('.tree-chat-full').click()
    assert.equal(await card('controller').evaluate(panel => panel.querySelector('.chat-log').getBoundingClientRect().width > panel.getBoundingClientRect().width * 0.95), true,
      'full chat uses the workspace width for its transcript')
    assert.equal(await card('manager').isVisible(), false)
    await card('controller').press('Escape')
    assert.equal(await card('manager').isVisible(), false, 'the inactive tab stays mounted but hidden')
    assert.equal(await input('controller').inputValue(), 'Keep this draft through navigation')
    for (const id of ['builder-0', 'builder-1', 'worker-0']) await open(id)
    assert.equal(await page.locator('.tree-conversation').count(), 5)
    // Width, text zoom and dark/light must retain readable, reachable composers.
    for (const textSize of [0.9, 1, 1.12]) {
      await page.evaluate(size => { document.body.style.zoom = String(size); document.documentElement.style.setProperty('--zoom', size) }, textSize)
      for (const width of [1854, 1100, 800, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1040 })
        await page.locator('.tree-chat-tab[data-agent-id="manager"]').click()
        await page.waitForTimeout(100)
        const geometry = await card('manager').evaluate(panel => {
          const input = panel.querySelector('.chat-input input'), r = input.getBoundingClientRect()
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
          const shelf = document.querySelector('.tree-conversations').getBoundingClientRect()
          return { width: r.width, hit: hit === input, input: r.toJSON(), shelf: shelf.toJSON(), panel: panel.getBoundingClientRect().toJSON(), pageWidth: document.documentElement.scrollWidth }
        })
        assert.ok(geometry.width > 90 && geometry.hit, `composer reachable at ${width}/${textSize}: ${JSON.stringify(geometry)}`)
        assert.ok(geometry.input.bottom <= geometry.shelf.bottom, 'composer remains inside the shelf')
        assert.ok(geometry.pageWidth <= width + 1, 'horizontal overflow belongs to the shelf, not the page')
        results.push({ width, textSize, geometry, ...(await page.evaluate(() => fixture.metrics())) })
      }
    }
    await page.setViewportSize({ width: 1854, height: 1040 })
    await page.evaluate(() => { document.body.style.zoom = '1'; document.documentElement.style.setProperty('--zoom', '1') })
    await page.locator('.tree-chat-tab[data-agent-id="manager"]').click()
    const resize = page.locator('.tree-shelf-resize')
    const before = await page.locator('.tree-conversations').evaluate(panel => panel.offsetHeight)
    await resize.focus()
    await resize.press('Shift+ArrowUp')
    assert.ok(await page.locator('.tree-conversations').evaluate(panel => panel.offsetHeight) > before, 'keyboard resize gives the chat more height')
    for (let i = 0; i < 8; i++) await resize.press('Shift+ArrowUp')
    assert.equal(await page.locator('.tree-conversations').evaluate(panel => panel.offsetHeight > panel.parentElement.clientHeight * 0.6), true,
      'resizing can give chat most of the workspace without an invisible halfway limit')
    await page.locator('.tree-chat-collapse').click()
    await page.locator('.graph-fit').click()
    const fitted = await page.evaluate(() => {
      const host = graph.zoomHost.getBoundingClientRect()
      return [...graph.nodes.values()].every(rec => {
        if (rec.el.hidden) return true
        const r = rec.el.getBoundingClientRect()
        return r.left >= host.left - 1 && r.right <= host.right + 1 && r.top >= host.top - 1 && r.bottom <= host.bottom + 1
      })
    })
    assert.equal(fitted, true, 'Fit reveals every circle in the current tree')
    await page.screenshot({ path: path.join(out, 'overview.png') })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('.graph-fit').click()
    assert.equal(await page.evaluate(() => graph._contentIsInsideHost(graph._contentBox())), true, 'even a wide tree has a complete phone overview')
    await page.setViewportSize({ width: 1854, height: 1040 })
    await moreClick('.tree-spread')
    const previewOverlap = await page.evaluate(() => {
      const box = el => ({ id: el.dataset.agentId || el.closest('.node')?.dataset.agentId, kind: el.className, ...el.getBoundingClientRect().toJSON() })
      const boxes = [...document.querySelectorAll('.static-tree-chip.screen-chip-visible')].map(box)
      const nodes = [...document.querySelectorAll('.node:not([hidden]), .node:not([hidden]) .node-labels')].map(box)
      const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
      return boxes.flatMap((box, i) => [...boxes.slice(i + 1), ...nodes].filter(other => overlap(box, other)).map(other => ({ box, other })))
    })
    assert.deepEqual(previewOverlap, [], 'visible previews do not cover each other or node/label boxes')
    await page.evaluate(() => graph.setEditMode(true))
    assert.ok(await page.locator('.tree-empty-node:not(.tree-add-compact)').count() > 0, 'Edit mode retains full-size drag/drop offers')
    await page.evaluate(() => graph.setEditMode(false))
    await page.locator('.tree-empty-node[data-empty-kind="new-tree"]').click()
    assert.equal(await page.evaluate(() => fixture.adds.at(-1).kind), 'new-tree')
    // Closing/reopening must not let an old animation timer remove the new chat.
    await moreClick('.tree-chats-toggle')
    await page.locator('.tree-chat-tab[data-agent-id="manager"]').click()
    await input('manager').fill('Keep this after closing the tab')
    await page.locator('.tree-chat-tab-wrap[data-agent-id="manager"] .tree-chat-tab-close').click()
    await open('manager')
    assert.equal(await input('manager').inputValue(), 'Keep this after closing the tab')
    await page.waitForTimeout(600)
    assert.equal(await card('manager').count(), 1)
    assert.equal(await page.evaluate(() => fixture.subscribers.get('manager').size), 2)
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    await page.screenshot({ path: path.join(out, 'dark-chats.png') })
    await page.evaluate(() => graph.destroy())
    assert.equal(await page.locator('.tree-conversations').count(), 0)
    assert.equal(await page.evaluate(() => [...fixture.subscribers.values()].reduce((sum, set) => sum + set.size, 0)), 0, 'destroy releases every mounted chat subscription')
  }
  assert.deepEqual(errors, [])
  assert.deepEqual(sourceState(), sourceBefore, 'source must remain unchanged during browser verification')
  writeFileSync(path.join(out, 'measurements.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify({ out, baseline, results: results.map(({ positions, ...rest }) => rest) }))
} catch (error) {
  writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: error.message, results }, null, 2))
  await browser?.contexts()[0]?.pages()[0]?.screenshot({ path: path.join(out, 'failure.png') })
  console.error(`Evidence: ${out}`)
  throw error
} finally {
  await browser?.close()
  await server.close()
}
