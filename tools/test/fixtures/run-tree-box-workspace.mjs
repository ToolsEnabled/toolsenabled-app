import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const requestedOut = process.env.TREE_BOX_EVIDENCE
const out = requestedOut ? (existsSync(requestedOut) ? mkdtempSync(`${requestedOut}-`) : requestedOut)
  : mkdtempSync(path.join(tmpdir(), 'tree-box-workspace-'))
mkdirSync(out, { recursive: true })
const sourceState = () => {
  const git = ['rev-parse HEAD', 'status --porcelain=v1', 'diff --binary HEAD'].map(command =>
    execFileSync('git', command.split(' '), { cwd: root, encoding: 'utf8' }))
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(Boolean).sort().map(name => {
      const file = path.join(root, name), symlink = lstatSync(file).isSymbolicLink()
      const contents = symlink ? readlinkSync(file) : readFileSync(file)
      return { path: name, kind: symlink ? 'symlink' : 'file', sha256: createHash('sha256').update(contents).digest('hex') }
    })
  return [...git, { untracked }]
}
const sourceBefore = sourceState()
writeFileSync(path.join(out, 'source-before.json'), JSON.stringify(sourceBefore, null, 2))
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const server = await createServer({ root, configFile: false, cacheDir: path.join(out, 'vite-cache'), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null, fs: { allow: [root, realpathSync(path.join(root, 'node_modules'))] } } })
let browser, stage = 'load'
const results = [], errors = []
try {
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1854, height: 1040 } })
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  await page.goto(`${origin}/tools/test/fixtures/tree-box-workspace.html`)
  await page.waitForFunction(() => window.fixture?.metrics)
  await page.evaluate(() => document.fonts.ready)
  const record = async name => { stage = name; results.push({ stage, ...(await page.evaluate(() => fixture.metrics())) }) }
  const treeTab = id => page.locator(`[role="tab"][data-workspace-id="${id}"]`)
  const chatTab = id => page.locator(`[role="tab"][data-agent-id="${id}"]`)
  const card = id => page.locator(`.tree-conversation[data-agent-id="${id}"]`)
  const input = id => card(id).locator('.chat-input input')
  const box = (id, index = 0) => page.locator('.tree-window').nth(index).locator(`.node[data-agent-id="${id}"]:not(.tree-node-removing)`)
  const camera = index => page.evaluate(index => {
    const view = graph.treeWindows.windows[index].graph
    return { zoom: view.zoom, panX: view.panX, panY: view.panY }
  }, index)
  const settle = async () => {
    await page.waitForFunction(() => graph.treeWindows.windows.every(({ graph: view }) => !view._cameraFrame && !view._zoomFrame && !view._zoomMotion))
    await page.waitForTimeout(220) // ResizeObserver and the tree's short layout transitions.
  }
  const assertCamera = async (index, expected, message) => {
    await settle()
    const actual = await camera(index)
    assert.ok(Math.abs(actual.zoom - expected.zoom) < .0001
      && Math.abs(actual.panX - expected.panX) < 1 && Math.abs(actual.panY - expected.panY) < 1,
    `${message}: ${JSON.stringify({ expected, actual })}`)
  }
  const fit = async (index = 0) => {
    await page.evaluate(index => graph.treeWindows.toolbar.activate(graph.treeWindows.windows[index]), index)
    await page.locator('.tree-action-bar .graph-fit').click()
    await settle()
    assert.equal(await page.evaluate(index => {
      const view = graph.treeWindows.windows[index].graph
      return view._contentIsInsideHost(view._contentBox())
    }, index), true, 'Fit restores every box in the selected window')
  }
  const chooseExistingTrees = async (index, rootIds) => {
    const pane = page.locator('.tree-window').nth(index)
    await pane.locator('.tree-window-select').click()
    for (const rootId of rootIds) await pane.locator(`.tree-window-tree-choices input[value="${rootId}"]`).check()
    const inputs = pane.locator('.tree-window-tree-choices input')
    for (let i = 0; i < await inputs.count(); i++) {
      if (!rootIds.includes(await inputs.nth(i).getAttribute('value'))) await inputs.nth(i).uncheck()
    }
    await pane.locator('.tree-window-picker-apply').click()
  }
  const wheelAtBox = async (id, index = 0) => {
    const before = await camera(index)
    const rect = await box(id, index).boundingBox()
    const anchor = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    await page.mouse.move(anchor.x, anchor.y)
    await page.mouse.wheel(0, -100)
    await page.waitForFunction(({ index, zoom }) => graph.treeWindows.windows[index].graph.zoom > zoom, { index, zoom: before.zoom })
    await settle()
    const after = await box(id, index).boundingBox()
    assert.ok(Math.abs(after.x + after.width / 2 - anchor.x) < 2
      && Math.abs(after.y + after.height / 2 - anchor.y) < 2,
    `wheel zoom holds the box under the pointer: ${JSON.stringify({ anchor, after })}`)
  }
  const dragBackground = async (index = 0) => {
    const point = await page.evaluate(index => {
      const host = graph.treeWindows.windows[index].graph.zoomHost
      const rect = host.getBoundingClientRect()
      for (const y of [.12, .45, .75]) for (const x of [.08, .35, .6]) {
        const point = { x: rect.x + rect.width * x, y: rect.y + rect.height * y }
        const target = document.elementFromPoint(point.x, point.y)
        if (host.contains(target) && !target.closest('.node, .chip, button, input, select, a[href], .tree-link-marker')) return point
      }
      throw new Error('No unobstructed tree background for the pan gesture')
    }, index)
    const before = await camera(index)
    await page.mouse.move(point.x, point.y)
    await page.mouse.down()
    await page.mouse.move(point.x + 32, point.y + 16, { steps: 6 })
    await page.mouse.up()
    await settle()
    const after = await camera(index)
    const movement = { x: after.panX - before.panX, y: after.panY - before.panY }
    // A narrow pane can reach its pan boundary before the pointer stops.
    // Motion must follow the gesture and may stop at that boundary.
    assert.ok(movement.x >= -.01 && movement.x <= 33 && movement.y >= -.01 && movement.y <= 17
      && Math.hypot(movement.x, movement.y) > 1,
      `background drag follows the pointer within its bounds: ${JSON.stringify({ before, after })}`)
    assert.equal(after.zoom, before.zoom, 'dragging does not change zoom')
    await page.mouse.move(point.x + 95, point.y + 65)
    await assertCamera(index, after, 'releasing the mouse ends panning')
    return movement
  }
  // Current product contract: one Trees tab, optional drag-to-inspect split,
  // and agent chat tabs. Fixed frontier counts and extra tree-page assertions
  // belonged to an abandoned design; geometry/navigation policy has its own
  // interaction proof. These cases retain the workspace data/lifecycle checks.
  for (const style of ['boxes', 'circles']) {
    stage = `${style}: load current workspace`
    await page.evaluate(() => localStorage.removeItem('mc.tree.canvas.v2:tree-box-fixture'))
    await page.goto(`${origin}/tools/test/fixtures/tree-box-workspace.html?style=${style}`)
    await page.waitForFunction(() => window.fixture?.metrics)
    await page.evaluate(() => document.fonts.ready)
    await settle()
    assert.equal(await page.locator('.tree-set-tab-wrap').count(), 0)
    assert.equal(await page.locator('.tree-new-workspace').count(), 0)
    assert.equal(await page.evaluate(() => graph._scopeAgentCount()), 25)
    assert.ok(await page.evaluate(() => ['controller', 'reviewer', 'researcher'].every(id => graph._layoutVisibleIds.has(id))))
    await chooseExistingTrees(0, ['reviewer'])
    await fit()
    await wheelAtBox('reviewer')
    await dragBackground()
    const mainCamera = await camera(0)
    await record(`${style}: pointer anchor and background camera`)

    stage = `${style}: full chat draft and attachment`
    await page.locator('.tree-chat-add').click()
    await page.locator('.tree-chat-options button[data-agent-id="reviewer"]').click()
    await input('reviewer').fill('Reviewer draft survives the tree and split view')
    await card('reviewer').locator('[data-chat-attach]').click()
    await page.waitForFunction(() => graph.nodes.get('reviewer').chatRoot.exportDraft().attachments.length === 1)
    await page.locator('.tree-home-tab').click()
    await assertCamera(0, mainCamera, 'returning from full chat preserves the tree camera')

    stage = `${style}: split and independent cameras`
    await chooseExistingTrees(0, ['reviewer', 'researcher'])
    await page.locator('.tree-window-add').click()
    assert.deepEqual(await page.evaluate(() => graph.treeWindows.windows[1].graph.windowRootIds), [])
    assert.equal(await page.locator('.tree-window-select').nth(1).isVisible(), false)
    await page.evaluate(() => graph.setRoot('researcher'))
    await settle()
    await box('researcher').dragTo(page.locator('.tree-window').nth(1))
    await page.waitForFunction(() => graph.treeWindows.windows[1].graph.rootId === 'researcher')
    await chooseExistingTrees(0, ['reviewer'])
    await fit(0)
    await fit(1)
    await wheelAtBox('reviewer', 0)
    await dragBackground(0)
    const leftCamera = await camera(0)
    await wheelAtBox('researcher', 1)
    await dragBackground(1)
    await assertCamera(0, leftCamera, 'steering the right branch leaves the main camera alone')
    const rightCamera = await camera(1)
    await chatTab('reviewer').click()
    assert.equal(await input('reviewer').inputValue(), 'Reviewer draft survives the tree and split view')
    assert.equal(await page.evaluate(() => graph.nodes.get('reviewer').chatRoot.exportDraft().attachments.length), 1)
    await page.locator('.tree-home-tab').click()
    await assertCamera(0, leftCamera, 'left camera survives full chat')
    await assertCamera(1, rightCamera, 'split camera survives full chat')
    await page.locator('.graph-open-btn').click()
    await settle()
    assert.ok(Math.abs((await camera(0)).zoom - leftCamera.zoom) < .0001)
    assert.ok(Math.abs((await camera(1)).zoom - rightCamera.zoom) < .0001)
    await page.locator('.fixture-close-rail').click()
    await assertCamera(0, leftCamera, 'closing Fleet overview restores the main camera')
    await assertCamera(1, rightCamera, 'closing Fleet overview restores the split camera')

    stage = `${style}: secondary chat owns its queue and draft`
    if (style === 'boxes') await box('researcher', 1).locator('.tree-box-chat').click()
    else await page.evaluate(() => {
      const view = graph.treeWindows.windows[1].graph
      view.openChat(view.nodes.get('researcher'))
    })
    assert.equal(await page.locator('.tree-workspace-tabs-bar').count(), 1)
    await input('researcher').waitFor()
    await page.evaluate(() => { fixture.busy.add('researcher'); fixture.notify('researcher') })
    await input('researcher').fill('Queued review request')
    await input('researcher').press('Enter')
    await page.waitForFunction(() => fixture.queues.get('researcher').length === 1)
    assert.match(await card('researcher').locator('.chat-queue-strip').textContent(), /Queued review request/)
    await page.locator('.tree-home-tab').click()
    await chatTab('researcher').click()
    await card('researcher').locator('.chat-queue-cancel').click()
    assert.equal(await page.evaluate(() => fixture.queues.get('researcher').length), 0)
    await page.evaluate(() => { fixture.busy.delete('researcher'); fixture.notify('researcher') })
    await input('researcher').fill('Researcher draft stays with this agent')
    await card('researcher').locator('[data-chat-attach]').click()
    await page.waitForFunction(() => graph.nodes.get('researcher').chatRoot.exportDraft().attachments.length === 1)
    const previousTabId = await page.evaluate(() => {
      const tabs = [...graph.chatTabs.querySelectorAll('[role="tab"]')]
      const index = tabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true')
      return tabs[(index - 1 + tabs.length) % tabs.length].id
    })
    await input('researcher').press('Control+PageUp')
    assert.equal(await page.locator(`[id="${previousTabId}"]`).getAttribute('aria-selected'), 'true')
    await page.keyboard.press('Control+PageDown')
    assert.equal(await chatTab('researcher').getAttribute('aria-selected'), 'true')
    await input('researcher').press('Escape')
    assert.equal(await page.locator('.tree-home-tab').getAttribute('aria-selected'), 'true')
    await assertCamera(0, leftCamera, 'chat keyboard navigation keeps the main camera')
    await assertCamera(1, rightCamera, 'chat keyboard navigation keeps the split camera')
    await record(`${style}: queue, attachment, draft and keyboard ownership`)

    stage = `${style}: cross-view links follow the camera`
    await fit(0)
    await fit(1)
    await page.locator('.tree-link-toggle').click()
    await box('reviewer').click()
    await box('researcher', 1).focus()
    await page.keyboard.press('Escape')
    assert.equal(await page.evaluate(() => graph.treeWindows.windows.some(frame => frame.graph._linkMode)), false)
    assert.deepEqual(await page.evaluate(() => fixture.linkRequests), [])
    await page.locator('.tree-link-toggle').click()
    await box('reviewer').click()
    await box('researcher', 1).click()
    await page.waitForFunction(() => fixture.linkRequests.length === 1 && !graph._linkPending)
    assert.deepEqual(await page.evaluate(() => fixture.linkRequests[0]), { from: 'reviewer', to: 'researcher', connected: true })
    const linkGeometry = async () => {
      await settle()
      return page.evaluate(() => {
        const board = graph.treeWindows, bounds = board.grid.getBoundingClientRect()
        const from = board.windows[0].graph.nodes.get('reviewer').el.getBoundingClientRect()
        const to = board.windows[1].graph.nodes.get('researcher').el.getBoundingClientRect()
        const actual = board.linkSvg.querySelector('.tree-cross-link').getAttribute('d').match(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi).map(Number)
        const expected = [from.right - bounds.left, from.y + from.height / 2 - bounds.top,
          to.left - bounds.left, to.y + to.height / 2 - bounds.top]
        return { actual, expected }
      })
    }
    const beforeLink = await linkGeometry()
    assert.ok(beforeLink.actual.every((value, index) => Math.abs(value - beforeLink.expected[index]) < 1))
    const linkMovement = await dragBackground(0)
    const movedLink = await linkGeometry()
    assert.ok(movedLink.actual.every((value, index) => Math.abs(value - movedLink.expected[index]) < 1))
    assert.ok(Math.abs(movedLink.actual[0] - beforeLink.actual[0] - linkMovement.x) < 1)
    assert.ok(Math.abs(movedLink.actual[1] - beforeLink.actual[1] - linkMovement.y) < 1)
    assert.ok(Math.abs(movedLink.actual[2] - beforeLink.actual[2]) < 1)
    await page.screenshot({ path: path.join(out, `${style}-linked-split.png`) })

    stage = `${style}: closing split preserves agent chats`
    await page.locator('.tree-window').nth(1).locator('.tree-window-close').click()
    assert.equal(await page.locator('.tree-window').count(), 1)
    await chatTab('researcher').click()
    assert.equal(await input('researcher').inputValue(), 'Researcher draft stays with this agent')
    assert.equal(await page.evaluate(() => graph.nodes.get('researcher').chatRoot.exportDraft().attachments.length), 1)
    assert.equal(await page.evaluate(() => fixture.subscribers.get('researcher').size), 2)
    await page.locator('.tree-home-tab').click()
    await chooseExistingTrees(0, ['reviewer', 'researcher'])
    await fit()
    await page.locator('.tree-link.link-direct[data-from="reviewer"][data-to="researcher"]').waitFor({ state: 'attached' })
    await page.locator('.tree-link-marker[aria-label="Direct link: Reviewer and Researcher. Open link controls."]').click()
    assert.equal(await page.locator('.tree-link-popover').isVisible(), true)
    await page.locator('.link-dismiss').click()
    for (const width of [1854, 1100]) {
      await page.setViewportSize({ width, height: 1040 })
      await fit()
      assert.ok(await page.evaluate(width => document.documentElement.scrollWidth <= width + 1, width))
    }
    await page.setViewportSize({ width: 1854, height: 1040 })
    await page.evaluate(() => {
      const extra = { id: 'research-extra', parentId: 'researcher', role: 'worker', declaredRole: 'worker', name: 'New research assistant',
        treeNode: { id: 'research-extra', treeId: 'research-tree' }, state: 'idle' }
      fixture.nodes.push(extra); fixture.queues.set(extra.id, []); graph.refresh()
    })
    assert.deepEqual(await page.evaluate(() => graph.windowRootIds), ['reviewer', 'researcher'])
    assert.equal(await page.evaluate(() => graph._scopeAgentCount()), 6)
    await chatTab('researcher').click()
    await page.locator('.tree-chat-tab-wrap[data-agent-id="researcher"] .tree-chat-tab-close').click()
    await page.locator('.tree-chat-add').click()
    await page.locator('.tree-chat-options button[data-agent-id="researcher"]').click()
    assert.equal(await input('researcher').inputValue(), 'Researcher draft stays with this agent')
    assert.equal(await page.evaluate(() => graph.nodes.get('researcher').chatRoot.exportDraft().attachments.length), 1)
    assert.equal(await page.evaluate(() => fixture.subscribers.get('researcher').size), 2)
    await page.evaluate(() => document.documentElement.dataset.theme = 'black')
    assert.match(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), /dark/)
    await page.screenshot({ path: path.join(out, `${style}-persistent-chat.png`) })
    await page.locator('.tree-home-tab').click()
    await record(`${style}: shared-canvas links and chat ownership survive close and refresh`)
    await page.evaluate(() => graph.destroy())
    assert.equal(await page.locator('.tree-workspace').count(), 0)
    assert.equal(await page.locator('.tree-window').count(), 0)
    assert.equal(await page.evaluate(() => [...fixture.subscribers.values()].reduce((sum, set) => sum + set.size, 0)), 0)
  }
  assert.deepEqual(errors, [])
  const sourceAfter = sourceState()
  const sourceChangedDuringRun = JSON.stringify(sourceAfter) !== JSON.stringify(sourceBefore)
  writeFileSync(path.join(out, 'source-after.json'), JSON.stringify(sourceAfter, null, 2))
  writeFileSync(path.join(out, 'measurements.json'), JSON.stringify({ results, errors, sourceChangedDuringRun }, null, 2))
  console.log(JSON.stringify({ out, passed: true, sourceChangedDuringRun, stages: results.map(result => result.stage) }))
} catch (error) {
  writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ stage, error: error.message, results, errors }, null, 2))
  await browser?.contexts()[0]?.pages()[0]?.screenshot({ path: path.join(out, 'failure.png') })
  console.error(`Evidence: ${out}; stage: ${stage}`)
  throw error
} finally {
  await browser?.close()
  await server.close()
}
