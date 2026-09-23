import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const requested = process.env.TREE_STANDALONE_EVIDENCE
const out = requested ? existsSync(requested) ? mkdtempSync(`${requested}-`) : requested : mkdtempSync(path.join(tmpdir(), 'tree-standalone-'))
mkdirSync(out, { recursive: true })
const sourceState = () => Object.fromEntries([
  'src/agent-session.js', 'src/tree-standalone-agent.js', 'src/tree-workspace.js', 'src/tree-workspace.css',
  'src/tree-windows.js', 'src/tree-toolbar.js', 'src/tree-graph.js', 'src/tree-edit-picker.js',
  'src/tree-card-density.css', 'src/components.js', 'tools/test/tree-standalone-agent.test.mjs',
  'tools/test/fixtures/tree-box-workspace.html', 'tools/test/fixtures/tree-box-workspace.mjs',
  'tools/test/fixtures/run-tree-standalone-agent.mjs',
].map(file => [file, createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')]))
const sourceBefore = sourceState()
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const server = await createServer({ root, configFile: false, cacheDir: path.join(out, 'vite-cache'), logLevel: 'error',
  optimizeDeps: { entries: ['tools/test/fixtures/tree-box-workspace.html'] },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null, fs: { allow: [root, realpathSync(path.join(root, 'node_modules'))] } } })
let browser
const errors = [], results = []
try {
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } })
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  const legacyViews = JSON.stringify({ activeId: 'old-second', workspaces: [
    { id: 'old-first', views: [{ rootIds: ['controller'] }] },
    { id: 'old-second', views: [{ rootIds: ['reviewer'] }, { rootIds: ['researcher'] }] },
  ] })
  await page.addInitScript(value => localStorage.setItem('mc.tree.workspaces.v1:tree-box-fixture', value), legacyViews)
  await page.goto(`${origin}/tools/test/fixtures/tree-box-workspace.html`)
  await page.waitForFunction(() => !!window.fixture?.metrics)
  const viewState = () => page.evaluate(() => ({ workspaces: graph.treeWindows.workspaces.length,
    active: graph.treeWindows.activeId, roots: graph.treeWindows.windows.map(frame => [...frame.graph.windowRootIds]),
    agents: graph.computer.agents.map(agent => agent.id), creations: fixture.adds.length }))
  const initialView = await viewState()
  const initialParents = await page.evaluate(() => graph.computer.agents.map(agent => [agent.id, agent.parentId]))
  const chooseTrees = async (index, ids) => {
    const pane = page.locator('.tree-window').nth(index)
    await pane.locator('.tree-window-select').click()
    for (const id of ids) await pane.locator(`.tree-window-tree-choices input[value="${id}"]`).check()
    const inputs = pane.locator('.tree-window-tree-choices input')
    for (let i = 0; i < await inputs.count(); i++) if (!ids.includes(await inputs.nth(i).getAttribute('value'))) await inputs.nth(i).uncheck()
    await pane.locator('.tree-window-picker-apply').click()
  }
  assert.equal(await page.locator('.tree-action-bar .graph-edit-btn').isVisible(), true, 'Edit stays accessible in the shared action row')
  assert.equal(await page.locator('.tree-window-add').textContent(), 'Split view')
  const singleChrome = await page.locator('.tree-window').evaluate(pane => ({ border: getComputedStyle(pane).borderWidth,
    radius: getComputedStyle(pane).borderRadius, gridPadding: getComputedStyle(pane.parentElement).padding }))
  assert.deepEqual(singleChrome, { border: '0px', radius: '0px', gridPadding: '0px' }, 'one canvas has no nested panel frame')
  assert.equal(initialView.workspaces, 1, 'legacy tree pages merge into one Trees tab')
  assert.deepEqual(initialView.roots[0].sort(), ['controller', 'researcher', 'reviewer'])
  assert.equal(await page.locator('.tree-new-workspace').count(), 0)
  assert.equal(await page.locator('.tree-set-tab-wrap').count(), 0)
  const beforePicker = await viewState()
  await page.locator('.tree-window-select').click()
  await page.locator('.tree-window-tree-choices input[value="reviewer"]').uncheck()
  await page.locator('.tree-window-tree-choices input[value="researcher"]').uncheck()
  assert.deepEqual(await viewState(), beforePicker, 'checking trees stages selection without moving the canvas')
  await page.locator('.tree-window-picker-cancel').click()
  assert.deepEqual(await viewState(), beforePicker, 'Cancel leaves the view unchanged')
  await page.locator('.tree-window-select').click()
  await page.locator('.tree-window-tree-choices input[value="reviewer"]').uncheck()
  await page.locator('.tree-window-tree-choices input').first().press('Escape')
  assert.deepEqual(await viewState(), beforePicker, 'Escape discards the staged selection')
  await chooseTrees(0, ['controller'])
  assert.deepEqual((await viewState()).roots[0], ['controller'], 'Show selected trees applies the selection once')
  await chooseTrees(0, ['controller', 'reviewer', 'researcher'])
  await page.locator('.tree-window-add').click()
  assert.equal(await page.locator('.tree-window').count(), 2)
  assert.equal(await page.locator('.tree-window-add').textContent(), 'Single view')
  assert.equal((await viewState()).creations, initialView.creations)
  assert.equal(await page.locator('.tree-window-picker').count(), 0)
  assert.deepEqual((await viewState()).roots[1], [], 'Split view opens empty instead of picking an unrelated tree')
  assert.equal(await page.locator('.tree-window-dropzone').nth(1).isVisible(), true)
  assert.equal(await page.locator('.tree-window-select').nth(1).isVisible(), false)
  await page.evaluate(() => graph.refresh())
  assert.deepEqual((await viewState()).roots[1], [], 'a fleet refresh cannot silently populate the empty split')
  assert.equal(await page.locator('.tree-window').nth(1).evaluate(pane => getComputedStyle(pane).borderLeftWidth), '1px')
  await page.evaluate(() => {
    const dataTransfer = new DataTransfer()
    dataTransfer.setData('application/x-toolsenabled-tree-agent', JSON.stringify({ id: 'manager', computerId: 'another-computer' }))
    graph.treeWindows.windows[1].pane.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }))
  })
  assert.deepEqual((await viewState()).roots[1], [], 'a different computer cannot supply a branch for this view')
  const dragAgent = async id => {
    await page.evaluate(id => graph.setRoot(id), id)
    await page.waitForTimeout(350)
    const source = page.locator('.tree-window').first().locator(`.node[data-agent-id="${id}"]`)
    await source.dragTo(page.locator('.tree-window').nth(1))
    await page.waitForFunction(id => graph.treeWindows.windows[1].graph.rootId === id, id)
  }
  await dragAgent('manager')
  assert.deepEqual((await viewState()).roots[1], ['controller'], 'split stores the owning tree while focusing the dropped agent')
  assert.equal(await page.locator('.tree-window-branch-title').nth(1).textContent(), 'Manager')
  assert.match(await page.locator('.tree-window-navigation span').nth(1).textContent(), /Controller tree.*13 agents/)
  assert.equal(await page.locator('.tree-window').nth(1).evaluate(pane => pane.classList.contains('is-toolbar-active')), true, 'drop transfers the shared zoom controls to its view')
  assert.deepEqual((await viewState()).agents, initialView.agents, 'dragging is a view operation, with no agent or parent changes')
  assert.deepEqual(await page.evaluate(() => graph.computer.agents.map(agent => [agent.id, agent.parentId])), initialParents)
  await page.evaluate(() => {
    // Simulate a later authoritative fleet update; the split follows the
    // observed parentage and never invokes a reparenting command itself.
    fixture.savedBranch = graph._scopeModel().branch('manager').map(id => {
      const agent = fixture.nodes.find(agent => agent.id === id)
      return { id, parentId: agent.parentId, treeId: agent.treeNode.treeId }
    })
    fixture.nodes.find(agent => agent.id === 'manager').parentId = 'reviewer'
    for (const saved of fixture.savedBranch) fixture.nodes.find(agent => agent.id === saved.id).treeNode.treeId = 'review-tree'
    graph.refresh()
  })
  assert.deepEqual((await viewState()).roots[1], ['reviewer'], 'an inspected agent follows its new authoritative owning tree')
  assert.equal(await page.evaluate(() => graph.treeWindows.windows[1].graph.rootId), 'manager')
  await page.evaluate(() => {
    for (const saved of fixture.savedBranch) {
      const agent = fixture.nodes.find(agent => agent.id === saved.id)
      agent.parentId = saved.parentId; agent.treeNode.treeId = saved.treeId
    }
    graph.refresh()
  })
  assert.deepEqual((await viewState()).roots[1], ['controller'])
  await page.locator('.tree-link-toggle').click()
  await page.waitForTimeout(200)
  assert.equal(await page.evaluate(() => graph.treeWindows.windows[1].graph._layoutVisibleIds.has('controller')), true, 'Link exposes the full owning head after a descendant drop')
  await page.locator('.tree-link-toggle').click()
  await dragAgent('researcher')
  assert.deepEqual((await viewState()).roots[1], ['researcher'], 'another drop replaces the branch in the persistent split')
  await page.reload()
  await page.waitForFunction(() => !!window.fixture?.metrics)
  assert.equal(await page.locator('.tree-window').count(), 2, 'the populated split survives a page reload')
  assert.equal(await page.evaluate(() => graph.treeWindows.windows[1].graph.rootId), 'researcher')
  assert.equal(await page.evaluate(() => localStorage.getItem('mc.tree.workspaces.v1:tree-box-fixture')), legacyViews, 'the legacy view preferences remain intact')
  await page.locator('.tree-chat-add').click()
  await page.locator('.tree-new-tree').click()
  const created = await viewState()
  assert.equal(created.creations, initialView.creations + 1, 'New tree reaches exactly one creation callback')
  assert.deepEqual(created.agents, initialView.agents)
  assert.equal(created.workspaces, 1, 'creating a tree does not create a view tab')
  await page.evaluate(() => graph.treeWindows.showPicker())
  assert.equal(await page.locator('.tree-window-tree-picker').first().isVisible(), true, 'Fleet overview shares the primary existing-tree selector')
  await page.locator('.tree-window-tree-picker').first().locator('input').first().press('Escape')
  await page.locator('.fixture-close-rail').click()
  await page.locator('.tree-action-bar .graph-fit').click()
  await page.screenshot({ path: path.join(out, 'tree-view-controls.png') })
  results.push({ stage: 'one Trees tab, staged selection and drag-to-inspect split preserve the fleet', ...created, singleChrome })
  const beforeEdit = await viewState()
  await page.locator('.tree-action-bar .graph-edit-btn').click()
  const dialog = page.locator('.tree-edit-picker')
  await dialog.waitFor()
  const overlay = await page.locator('.tree-edit-picker-backdrop').boundingBox()
  assert.deepEqual(overlay, { x: 0, y: 0, width: 1500, height: 900 }, 'edit chooser covers the viewport outside the contained graph')
  assert.equal(await dialog.evaluate(node => getComputedStyle(node).borderRadius), '3px')
  await dialog.locator('input[value="controller"]').check()
  await dialog.locator('input[value="reviewer"]').check()
  await dialog.locator('input[value="researcher"]').uncheck()
  await page.screenshot({ path: path.join(out, 'tree-edit-picker-light.png') })
  await page.evaluate(() => document.documentElement.dataset.theme = 'black')
  assert.match(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), /dark/)
  await page.screenshot({ path: path.join(out, 'tree-edit-picker-dark.png') })
  await page.evaluate(() => document.documentElement.dataset.theme = 'white')
  await dialog.locator('.tree-edit-picker-confirm').click()
  assert.equal(await page.locator('.tree-window-grid').evaluate(grid => grid.classList.contains('is-editing')), true)
  assert.equal(await page.locator('.tree-window').nth(1).isVisible(), false)
  for (const selector of ['.tree-display-controls', '.tree-workspace-controls', '.tree-window-add', '.tree-window-select']) {
    assert.equal(await page.locator(selector).first().isVisible(), false, `${selector} stays out of complete-structure editing`)
  }
  assert.equal(await page.locator('.tree-action-bar .graph-edit-btn').isVisible(), true)
  assert.equal(await page.locator('.tree-action-bar .graph-fit').isVisible(), true)
  assert.equal(await page.evaluate(() => graph.treeWindows.toolbar.active.graph === graph), true)
  assert.equal(await page.evaluate(() => graph.nodeStyle), 'circles')
  assert.equal(await page.evaluate(() => graph.visibleAgents().length), 22)
  assert.equal(await page.locator('.tree-window-navigation span').first().textContent(), 'Editing 2 trees · 22 agents')
  assert.equal(await page.locator('.tree-window-back').first().isVisible(), false)
  assert.equal(await page.locator('.tree-chat-tabs').isVisible(), false)
  assert.deepEqual(await page.locator('.tree-chat-tabs').evaluate(bar => ({ inert: bar.inert, hidden: bar.getAttribute('aria-hidden') })),
    { inert: true, hidden: 'true' })
  assert.equal(await page.locator('.tree-chat-add').isVisible(), true, 'Edit retains the header creation and branch-drop target')
  assert.equal(await page.locator('.tree-chat-add').evaluate(button => Boolean(button.closest('[inert]'))), false)
  assert.equal(await page.locator('.tree-empty-node[data-empty-kind="new-tree"]').count(), 0)
  const editGuard = await page.evaluate(() => {
    const board = graph.treeWindows
    const snapshot = () => JSON.stringify({ active: board.activeId, views: board.workspaces.map(tab => ({
      id: tab.id, views: tab.views.map(view => ({ rootIds: view.rootIds, focusId: view.focusId, camera: view.camera })) })),
      roots: board.windows.map(frame => frame.graph.windowRootIds), standalone: graph.workspace.standalone.size })
    const before = snapshot()
    board.capture(); board.activate('old-second'); board.addWorkspace(); board.closeWorkspace('old-second')
    board.toggleSplit(); board.showPicker(); graph.workspace.showPicker(); graph.workspace.openStandalone()
    return { unchanged: before === snapshot(), chooserHidden: graph.chatChooser.hidden, mode: graph.workspace.mode }
  })
  assert.deepEqual(editGuard, { unchanged: true, chooserHidden: true, mode: 'trees' }, 'edit cannot capture its temporary camera or switch saved views')
  await page.locator('.tree-action-bar .graph-edit-btn').click()
  assert.equal(await page.locator('.tree-window').nth(1).isVisible(), true)
  assert.equal(await page.locator('.tree-window-add').isVisible(), true)
  assert.equal(await page.evaluate(() => graph.nodeStyle), 'boxes')
  assert.equal(await page.locator('.tree-workspace-tabs-bar').isVisible(), true)
  assert.equal(await page.locator('.tree-chat-tabs').evaluate(bar => bar.inert), false)
  assert.deepEqual((await viewState()).roots, beforeEdit.roots, 'Done restores both pane selections without rewriting them')
  await page.evaluate(() => {
    const newRoot = { id: 'new-tree-root', parentId: null, name: 'New requested tree', role: 'controller', declaredRole: 'controller',
      treeNode: { id: 'new-tree-root', treeId: 'new-tree' }, state: 'idle' }
    fixture.nodes.push(newRoot)
    fixture.queues.set(newRoot.id, [])
    graph.refresh()
  })
  const afterCreatedRoot = await viewState()
  assert.deepEqual(afterCreatedRoot.roots[0], [...beforeEdit.roots[0], 'new-tree-root'], 'a requested tree becomes visible when the fleet actually supplies its root')
  assert.deepEqual(afterCreatedRoot.roots[1], beforeEdit.roots[1], 'new tree creation leaves the inspected split branch alone')
  assert.equal(afterCreatedRoot.workspaces, 1)
  await page.locator('.tree-window-add').click()
  results.push({ stage: 'themed chooser and full edit canvas return to the saved split view', ...await viewState() })
  await page.evaluate(() => {
    // Explicit synthetic bridge: this browser never contacts a native host,
    // provider, account, filesystem attachment service, or paid session.
    localStorage.setItem('mc.write.agent-session', 'enabled')
    const listeners = new Set(), calls = []
    window.sessionFixture = { listeners, calls, emit: (sessionId, event) => listeners.forEach(listener => listener({ sessionId, event })) }
    graph.standaloneAgent = { live: true, bridge: {
      availability: async () => ({ ok: true }), confinement: async () => ({ ok: true, tier: 'standard' }),
      onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener) },
      start: async value => { calls.push(['start', value]); return { sessionId: value.sessionId } },
      send: async value => { calls.push(['send', value]); return { turnId: `turn-${calls.filter(([kind]) => kind === 'send').length}` } },
      interrupt: async value => { calls.push(['interrupt', value]); return { ok: true } },
      close: async value => { calls.push(['close', value]); return { closed: true } },
    } }
  })
  const metrics = () => page.evaluate(() => ({ calls: sessionFixture.calls, subscriptions: sessionFixture.listeners.size,
    agents: graph.computer.agents.length, records: graph.nodes.size, standalone: graph.workspace.standalone.size,
    agentIds: graph.computer.agents.map(agent => agent.id), recordIds: [...graph.nodes.keys()],
    mode: graph.workspace.mode, active: graph.activeChatId }))
  const initial = await metrics()
  const activePanel = () => page.locator('.tree-standalone-conversation:not([hidden])')
  const tab = id => page.locator(`[role="tab"][data-agent-id="${id}"]`)
  const add = async () => { await page.locator('.tree-chat-add').click(); await page.locator('.tree-new-agent').click() }
  await add()
  assert.equal(await page.locator('.tree-agent-notice').isVisible(), true)
  assert.equal((await metrics()).standalone, 0)
  await page.locator('.tree-agent-cancel').click()
  assert.equal((await metrics()).calls.length, 0)
  await page.locator('.tree-new-agent').click()
  await page.locator('.tree-agent-continue').click()
  const first = (await metrics()).active
  await activePanel().locator('.chat-input input').waitFor()
  assert.equal((await metrics()).calls.length, 0)
  assert.equal(await activePanel().locator('[data-session-form]').isVisible(), false)
  const dimensions = await activePanel().evaluate(panel => ({ width: panel.clientWidth,
    chatWidth: panel.querySelector('[data-chat-panel]').getBoundingClientRect().width,
    panelHeight: panel.clientHeight, chatHeight: panel.querySelector('[data-chat-panel]').getBoundingClientRect().height,
    formVisible: getComputedStyle(panel.querySelector('[data-session-form]')).display !== 'none' }))
  assert.ok(dimensions.chatWidth > dimensions.width * .85 && dimensions.chatHeight > dimensions.panelHeight * .65,
    `the standalone chat uses the full conversation view: ${JSON.stringify(dimensions)}`)
  await activePanel().locator('.chat-input input').fill('Inspect the workspace and explain your plan.')
  await activePanel().locator('.chat-input input').press('Enter')
  await page.waitForFunction(() => sessionFixture.calls.some(([kind]) => kind === 'send'))
  const firstId = (await metrics()).calls.find(([kind]) => kind === 'start')[1].sessionId
  assert.deepEqual((await metrics()).calls.find(([kind]) => kind === 'start')[1], { sessionId: firstId })
  assert.equal(await activePanel().locator('.msg.me').count(), 1)
  await activePanel().locator('.chat-input input').fill('A draft that stays with this agent')
  await page.locator('.tree-home-tab').click()
  await page.evaluate(id => {
    sessionFixture.emit(id, { type: 'assistant_text_delta', text: 'I will inspect the current source and report what I find.', turnId: 'turn-1' })
    sessionFixture.emit(id, { type: 'turn_completed', status: 'completed', turnId: 'turn-1' })
  }, firstId)
  await tab(first).click()
  assert.equal(await activePanel().locator('.chat-input input').inputValue(), 'A draft that stays with this agent')
  assert.match(await activePanel().innerText(), /inspect the current source/)
  results.push({ stage: 'first agent returns from tree tab', ...await metrics(), dimensions })
  await add()
  const second = (await metrics()).active
  assert.notEqual(second, first)
  assert.equal(await page.locator('.tree-agent-notice').isVisible(), false)
  assert.equal((await metrics()).calls.filter(([kind]) => kind === 'start').length, 1)
  await activePanel().locator('.chat-input input').fill('Review the latest change independently.')
  await activePanel().locator('.chat-input input').press('Enter')
  await page.waitForFunction(() => sessionFixture.calls.filter(([kind]) => kind === 'send').length === 2)
  const secondId = (await metrics()).calls.filter(([kind]) => kind === 'start')[1][1].sessionId
  await page.evaluate(id => sessionFixture.emit(id, { type: 'assistant_text_delta', text: 'I am checking the latest changes and their tests.', turnId: 'turn-2' }), secondId)
  await tab(first).click()
  assert.doesNotMatch(await activePanel().innerText(), /checking the latest changes/)
  await activePanel().locator('.chat-input input').fill('What should we verify next?')
  await activePanel().locator('.chat-input input').press('Enter')
  await page.waitForFunction(() => sessionFixture.calls.filter(([kind]) => kind === 'send').length === 3)
  await page.evaluate(id => {
    sessionFixture.emit(id, { type: 'assistant_text_delta', text: 'Check the interactions at several window sizes.', turnId: 'turn-3' })
    sessionFixture.emit(id, { type: 'turn_completed', status: 'completed', turnId: 'turn-3' })
  }, firstId)
  const replies = await activePanel().locator('.msg.them').allTextContents()
  await page.waitForFunction(() => [...document.querySelectorAll('.tree-standalone-conversation:not([hidden]) .msg')]
    .every(message => Number(getComputedStyle(message).opacity) >= .99))
  await page.screenshot({ path: path.join(out, 'standalone-chat.png') })
  assert.equal(replies.length, 2, JSON.stringify(replies))
  assert.doesNotMatch(replies[1], /inspect the current source/)
  await page.locator('.tree-chat-tab-wrap').filter({ has: tab(first) }).locator('.tree-chat-tab-close').click()
  await page.waitForFunction(() => sessionFixture.calls.filter(([kind]) => kind === 'close').length === 1)
  assert.equal((await metrics()).active, second)
  assert.match(await activePanel().innerText(), /checking the latest changes/)
  const current = await metrics()
  assert.equal(current.agents, initial.agents)
  assert.deepEqual(current.agentIds, initial.agentIds)
  assert.equal(current.recordIds.includes(first) || current.recordIds.includes(second), false,
    'standalone sessions never become graph records; responsive projection may change which fleet records are drawn')
  assert.equal(current.subscriptions, 1)
  results.push({ stage: 'closing first leaves second active and trees unchanged', ...current })
  await page.evaluate(() => graph.destroy())
  await page.waitForFunction(() => sessionFixture.calls.filter(([kind]) => kind === 'close').length === 2)
  assert.equal(await page.evaluate(() => sessionFixture.listeners.size), 0)
  assert.equal(await page.locator('.graph-tools .graph-edit-btn').count(), 1, 'the page-owned Edit control survives renderer teardown')
  assert.deepEqual(await page.evaluate(() => sessionFixture.calls.filter(([kind]) => kind === 'interrupt').map(([, value]) => value.sessionId)), [secondId])
  assert.deepEqual(errors, [])
  const sourceAfter = sourceState()
  const sourceChangedDuringRun = JSON.stringify(sourceBefore) !== JSON.stringify(sourceAfter)
  writeFileSync(path.join(out, 'evidence.json'), JSON.stringify({ passed: true, sourceChangedDuringRun, sourceBefore, sourceAfter, results, errors }, null, 2))
  console.log(JSON.stringify({ passed: true, out, sourceChangedDuringRun, stages: results.map(result => result.stage) }))
} catch (error) {
  writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: error.message, results, errors }, null, 2))
  console.error(`Evidence: ${out}`)
  throw error
} finally { await browser?.close(); await server.close() }
