// Headless integration: real selection dialog and graph mode, fictional fleet
// and chat callbacks only. No native profile or provider session is opened.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const out = mkdtempSync(path.join(tmpdir(), 'tree-full-edit-'))
const sources = ['src/tree-edit-picker.js', 'src/tree-graph.js', 'src/tree-box-layout.js',
  'src/tree-readability.js', 'src/tree-scope.js', 'src/tree-workspace.js', 'src/tree-windows.js',
  'src/tree-workspace.css', 'src/tree-card-density.css']
const hashes = () => Object.fromEntries(sources.map(name =>
  [name, createHash('sha256').update(readFileSync(path.join(root, name))).digest('hex')]))
const before = hashes(), results = [], errors = []
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const server = await createServer({ root, configFile: false, cacheDir: path.join(out, 'vite-cache'), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null,
    fs: { allow: [root, realpathSync(path.join(root, 'node_modules'))] } } })
let browser, page, stage = 'load'
try {
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true })
  for (const style of ['boxes', 'circles']) {
    stage = `${style} initial view`
    const context = await browser.newContext({ viewport: { width: 1854, height: 1040 } })
    page = await context.newPage()
    page.setDefaultTimeout(8000)
    page.on('pageerror', error => errors.push({ stage, message: error.message }))
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
    await page.goto(`${origin}/tools/test/fixtures/tree-box-workspace.html?style=${style}`)
    await page.waitForFunction(() => window.fixture?.metrics)
    await page.evaluate(() => document.fonts.ready)
    const settle = async () => {
      await page.waitForFunction(() => !graph._cameraFrame && !graph._zoomFrame && !graph._zoomMotion)
      await page.waitForTimeout(400)
    }
    await page.evaluate(async style => {
      const { showTreeEditPicker } = await import('/src/tree-edit-picker.js')
      fixture.editButton = document.createElement('button')
      fixture.editButton.className = 'fixture-edit-trees'
      fixture.editButton.textContent = 'Edit trees'
      document.querySelector('.graph-bar').appendChild(fixture.editButton)
      fixture.editButton.addEventListener('click', () => {
        if (graph.editMode) {
          graph.setEditMode(false)
          fixture.editButton.textContent = 'Edit trees'
          return
        }
        fixture.picker = showTreeEditPicker({ host: graph.container, trees: fixture.trees(), selectedRootIds: graph.windowRootIds,
          onCancel: () => { fixture.cancelled = (fixture.cancelled || 0) + 1 },
          onConfirm: rootIds => {
            fixture.editSelections = rootIds
            graph.setEditMode(true, { rootIds })
            fixture.editButton.textContent = 'Finish editing'
          } })
      })
      graph.setNodeStyle(style)
      graph.setCardSize('large')
      graph.treeWindows.choose(graph.treeWindows.windows[0], ['reviewer'])
      graph.setRoot('review-child')
      fixture.transitionChat = {
        pendingRemoval: graph._removeTimers.size,
        record: graph.nodes.get('reviewer'),
      }
      // Deliberately open during the outgoing-node fade. Its delayed removal
      // must recheck chat ownership, rather than disposing this live tab.
      graph.openFullChat('reviewer')
      fixture.transitionChat.chat = graph.nodes.get('reviewer').chatRoot
    }, style)
    assert.ok(await page.evaluate(() => fixture.transitionChat.pendingRemoval > 0),
      'the chat opened while branch-removal timers were still pending')
    const chat = page.locator('.tree-conversation[data-agent-id="reviewer"]')
    await chat.locator('.chat-input input').fill('My review draft survives editing different trees')
    await chat.locator('[data-chat-attach]').click()
    await page.waitForFunction(() => graph.nodes.get('reviewer').chatRoot.exportDraft().attachments.length === 1)
    await page.evaluate(() => graph.workspace.showTrees({ focus: false }))
    await settle()
    const transition = await page.evaluate(() => ({
      pendingAtOpen: fixture.transitionChat.pendingRemoval,
      pendingAfterSettle: graph._removeTimers.size,
      sameRecord: graph.nodes.get('reviewer') === fixture.transitionChat.record,
      sameChat: graph.nodes.get('reviewer')?.chatRoot === fixture.transitionChat.chat,
      chatOpen: graph.nodes.get('reviewer')?.chatOpen,
    }))
    assert.equal(transition.pendingAfterSettle, 0)
    assert.equal(transition.sameRecord, true)
    assert.equal(transition.sameChat, true)
    assert.equal(transition.chatOpen, true)
    await page.evaluate(() => {
      graph.zoom = 0.93
      graph.panX += 24
      graph.panY -= 18
      graph._viewSteered = true
      graph._applyZoom()
      fixture.savedChat = graph.nodes.get('reviewer').chatRoot
      fixture.beforeEdit = {
        rootId: graph.rootId, history: [...graph._scopeHistory], roots: [...graph.windowRootIds],
        camera: { zoom: graph.zoom, panX: graph.panX, panY: graph.panY }, style: graph.nodeStyle,
        cardSize: graph.cardSize, wide: graph._treeWide,
        draft: fixture.savedChat.exportDraft(), subscriptions: fixture.metrics().subscriptions,
        fleet: JSON.stringify(fixture.computer.agents),
        styleSetting: localStorage.getItem('mc.set.tree_style'), sizeSetting: localStorage.getItem('mc.set.tree_context_size'),
      }
    })

    stage = `${style} choose trees`
    await page.locator('.fixture-edit-trees').click()
    const picker = page.getByRole('dialog', { name: 'Choose trees to edit' })
    await picker.waitFor()
    assert.equal(await picker.evaluate(node => node.parentNode.parentNode === document.body), true)
    await picker.getByRole('checkbox', { name: 'Reviewer tree 2 agents' }).uncheck()
    await picker.getByRole('button', { name: 'Edit selected trees' }).isDisabled().then(disabled => assert.equal(disabled, true))
    assert.equal(await page.evaluate(() => graph.editMode), false, 'choosing roots does not enter edit mode prematurely')
    await picker.getByRole('checkbox', { name: 'Controller tree 20 agents' }).check()
    await picker.getByRole('checkbox', { name: 'Researcher tree 3 agents' }).check()
    await page.screenshot({ path: path.join(out, `${style}-picker.png`) })
    await picker.getByRole('button', { name: 'Edit selected trees' }).click()
    await settle()

    const measure = () => page.evaluate(() => {
      const visible = [...graph.nodes.values()].filter(record => !record.el.hidden && graph._layoutVisibleIds.has(record.id))
      return { editing: graph.editMode, style: graph.nodeStyle, rootId: graph.rootId, roots: graph._editRootIds,
        ids: visible.map(record => record.id), groups: visible.filter(record => record.agent.treeScope?.group).length,
        boxes: visible.filter(record => record.el.classList.contains('tree-agent-box')).length,
        zoom: graph.zoom, panX: graph.panX, panY: graph.panY, fitted: graph._contentIsInsideHost(graph._contentBox()),
        hasExpected: fixture.nodes.filter(agent => ['build-tree', 'research-tree'].includes(agent.treeNode.treeId)).map(agent => agent.id),
        nodes: visible.map(record => { const r = record.el.getBoundingClientRect();
          return { id: record.id, left: r.left, right: r.right, top: r.top, bottom: r.bottom } }) }
    })
    const initial = await measure()
    assert.equal(initial.editing, true)
    assert.equal(initial.style, 'circles')
    assert.equal(initial.rootId, null)
    assert.deepEqual(initial.roots, ['controller', 'researcher'])
    assert.deepEqual(new Set(initial.ids), new Set(initial.hasExpected))
    assert.equal(initial.ids.length, 23, 'the edit canvas includes every real agent from the selected trees')
    assert.equal(initial.groups, 0)
    assert.equal(initial.boxes, 0)
    assert.equal(initial.fitted, true)
    for (const [index, node] of initial.nodes.entries()) for (const other of initial.nodes.slice(index + 1)) {
      assert.ok(Math.min(node.right, other.right) - Math.max(node.left, other.left) <= 1
        || Math.min(node.bottom, other.bottom) - Math.max(node.top, other.top) <= 1, 'fitted edit circles remain separated')
    }
    await page.screenshot({ path: path.join(out, `${style}-full-edit.png`) })

    stage = `${style} edit zoom and pan`
    const node = page.locator('.node[data-agent-id="controller"]:not(.tree-node-removing)')
    const bounds = await node.boundingBox()
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await page.mouse.wheel(0, -180)
    await settle()
    const zoomed = await measure()
    assert.ok(zoomed.zoom > initial.zoom, 'the wheel zooms inside complete edit mode')
    assert.equal(zoomed.rootId, null, 'editing wheel gestures cannot drill or fold a branch')
    assert.deepEqual(new Set(zoomed.ids), new Set(initial.ids))
    const point = await page.evaluate(() => {
      const host = graph.zoomHost, rect = host.getBoundingClientRect()
      for (const y of [.1, .4, .7]) for (const x of [.08, .35, .65]) {
        const point = { x: rect.x + rect.width * x, y: rect.y + rect.height * y }
        const target = document.elementFromPoint(point.x, point.y)
        if (host.contains(target) && !target.closest('.node, button, input, a, .tree-link-marker')) return point
      }
      throw new Error('No available edit canvas background')
    })
    await page.mouse.move(point.x, point.y)
    await page.mouse.down()
    await page.mouse.move(point.x + 48, point.y + 32, { steps: 8 })
    await page.mouse.up()
    await settle()
    const panned = await measure()
    assert.ok(Math.abs(panned.panX - zoomed.panX - 48) < 2 && Math.abs(panned.panY - zoomed.panY - 32) < 2,
      'background panning remains available in edit mode')
    await page.locator('.graph-fit:visible').first().click()
    await settle()
    assert.equal((await measure()).fitted, true, 'Fit returns every editable circle to view')

    stage = `${style} restore previous view`
    await page.locator('.fixture-edit-trees').click()
    await settle()
    const restored = await page.evaluate(() => ({ before: fixture.beforeEdit,
      editing: graph.editMode, style: graph.nodeStyle, rootId: graph.rootId, history: graph._scopeHistory,
      roots: graph.windowRootIds, cardSize: graph.cardSize, wide: graph._treeWide,
      camera: { zoom: graph.zoom, panX: graph.panX, panY: graph.panY },
      sameChat: graph.nodes.get('reviewer').chatRoot === fixture.savedChat,
      draft: fixture.savedChat.exportDraft(), subscriptions: fixture.metrics().subscriptions,
      fleet: JSON.stringify(fixture.computer.agents),
      styleSetting: localStorage.getItem('mc.set.tree_style'), sizeSetting: localStorage.getItem('mc.set.tree_context_size') }))
    assert.equal(restored.editing, false)
    for (const key of ['style', 'rootId', 'history', 'roots', 'cardSize', 'wide', 'draft', 'subscriptions', 'fleet', 'styleSetting', 'sizeSetting']) {
      assert.deepEqual(restored[key], restored.before[key], `${key} returns unchanged after editing other trees`)
    }
    assert.equal(restored.sameChat, true)
    for (const key of ['zoom', 'panX', 'panY']) assert.ok(Math.abs(restored.camera[key] - restored.before.camera[key]) < 0.001,
      'the original manual camera returns instead of refitting the old tree')
    results.push({ style, transition, initial, zoomed, panned, restored })
    await page.screenshot({ path: path.join(out, `${style}-restored.png`) })
    await page.evaluate(() => graph.destroy())
    assert.equal(await page.evaluate(() => fixture.metrics().subscriptions), 0)
    await context.close()
  }

  stage = '1,000-agent complete edit fit'
  const context = await browser.newContext({ viewport: { width: 1854, height: 1040 } })
  page = await context.newPage()
  page.on('pageerror', error => errors.push({ stage, message: error.message }))
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  await page.goto(`${origin}/tools/test/fixtures/tree-box-workspace.html?style=boxes`)
  await page.waitForFunction(() => window.fixture?.metrics)
  await page.evaluate(() => document.fonts.ready)
  await page.evaluate(() => {
    // Replace only the isolated fictional fixture. Two selected 500-agent
    // trees plus an unrelated ten-agent tree exercise forest filtering too.
    const trees = [['large-left', 500], ['large-right', 500], ['excluded', 10]]
    fixture.nodes.splice(0, fixture.nodes.length, ...trees.flatMap(([treeId, count]) =>
      Array.from({ length: count }, (_, index) => ({
        id: `${treeId}-${index}`, name: `${treeId} agent ${index + 1}`,
        parentId: index ? `${treeId}-${Math.floor((index - 1) / 4)}` : null,
        role: index ? 'worker' : 'controller', declaredRole: index ? 'worker' : 'controller',
        state: 'idle', treeNode: { id: `${treeId}-${index}`, treeId },
      }))))
    for (const agent of fixture.nodes) fixture.queues.set(agent.id, [])
    fixture.largeFleetBefore = JSON.stringify(fixture.computer.agents)
    graph.refresh()
    graph.treeWindows.choose(graph.treeWindows.windows[0], ['large-left-0', 'large-right-0'])
    fixture.largeUsualStyle = graph.nodeStyle
    graph.setEditMode(true, { rootIds: ['large-left-0', 'large-right-0'] })
  })
  await page.waitForFunction(() => !graph._cameraFrame && !graph._zoomFrame && !graph._zoomMotion)
  await page.waitForTimeout(400)
  const largeFleet = await page.evaluate(() => {
    const visible = [...graph.nodes.values()].filter(record => !record.el.hidden && graph._layoutVisibleIds.has(record.id))
    const host = graph.zoomHost.getBoundingClientRect()
    const nodes = visible.map(record => {
      const rect = record.el.getBoundingClientRect()
      return { id: record.id, row: graph._layoutResult.rowOf.get(record.id),
        left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
    })
    return { editing: graph.editMode, style: graph.nodeStyle, count: visible.length,
      ids: nodes.map(node => node.id), groups: visible.filter(record => record.agent.treeScope?.group).length,
      boxes: visible.filter(record => record.el.classList.contains('tree-agent-box')).length,
      zoom: graph.zoom, fitted: graph._contentIsInsideHost(graph._contentBox()),
      fleetUnchanged: JSON.stringify(fixture.computer.agents) === fixture.largeFleetBefore,
      host: { left: host.left, right: host.right, top: host.top, bottom: host.bottom }, nodes }
  })
  assert.equal(largeFleet.editing, true)
  assert.equal(largeFleet.style, 'circles')
  assert.equal(largeFleet.count, 1000, 'complete edit retains all 1,000 selected agents')
  assert.equal(largeFleet.groups, 0, 'complete edit never projects synthetic embedding groups')
  assert.equal(largeFleet.boxes, 0)
  assert.equal(new Set(largeFleet.ids).size, 1000)
  assert.ok(largeFleet.ids.every(id => id.startsWith('large-left-') || id.startsWith('large-right-')))
  assert.equal(largeFleet.fitted, true)
  assert.equal(largeFleet.fleetUnchanged, true)
  assert.ok(Number.isFinite(largeFleet.zoom) && largeFleet.zoom > 0)
  const rows = new Map()
  for (const node of largeFleet.nodes) {
    for (const edge of ['left', 'right', 'top', 'bottom']) assert.ok(Number.isFinite(node[edge]), `${node.id} ${edge} is finite`)
    assert.ok(node.right > node.left && node.bottom > node.top)
    assert.ok(node.left >= largeFleet.host.left - 1 && node.right <= largeFleet.host.right + 1
      && node.top >= largeFleet.host.top - 1 && node.bottom <= largeFleet.host.bottom + 1,
    `${node.id} is inside the fitted edit canvas`)
    const row = rows.get(node.row) || []
    row.push(node); rows.set(node.row, row)
  }
  for (const row of rows.values()) {
    row.sort((a, b) => a.left - b.left)
    for (let index = 1; index < row.length; index++) assert.ok(row[index].left >= row[index - 1].right - 0.01,
      'same-rank edit circles remain separated across the complete 1,000-agent forest')
  }
  await page.screenshot({ path: path.join(out, '1000-agent-full-edit.png') })
  await page.evaluate(() => graph.setEditMode(false))
  assert.equal(await page.evaluate(() => !graph.editMode && graph.nodeStyle === fixture.largeUsualStyle
    && JSON.stringify(fixture.computer.agents) === fixture.largeFleetBefore), true)
  results.push({ style: '1000-agent forest', ...largeFleet })
  await page.evaluate(() => graph.destroy())
  assert.equal(await page.evaluate(() => fixture.metrics().subscriptions), 0)
  await context.close()

  assert.deepEqual(errors, [])
  const after = hashes(), sourceChangedDuringRun = JSON.stringify(before) !== JSON.stringify(after)
  writeFileSync(path.join(out, 'measurements.json'), JSON.stringify({ results, errors, before, after, sourceChangedDuringRun }, null, 2))
  console.log(JSON.stringify({ out, passed: true, cases: results.length, sourceChangedDuringRun }))
} catch (error) {
  writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ stage, error: error.message, results, errors, before, after: hashes() }, null, 2))
  await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {})
  console.error(`Evidence: ${out}; stage: ${stage}`)
  throw error
} finally {
  await browser?.close()
  await server.close()
}
