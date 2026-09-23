import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { treeInteractionViteConfig } from './tree-interactions-vite-config.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const requested = process.env.TREE_INTERACTION_EVIDENCE
const caseFilter = new Set((process.env.TREE_INTERACTION_CASES || '').split(',').filter(Boolean))
const retainBrowser = process.env.TREE_INTERACTION_RETAIN_BROWSER === '1'
const out = requested && !existsSync(requested) ? requested : mkdtempSync(requested ? `${requested}-` : path.join(tmpdir(), 'tree-interactions-'))
mkdirSync(out, { recursive: true })
const sources = ['src/tree-graph.js', 'src/tree-workspace.js', 'src/tree-windows.js', 'src/tree-box-layout.js', 'src/tree-layout.js', 'src/tree-readability.js', 'src/tree-scope.js', 'src/tree-workspace.css', 'src/tree-card-density.css', 'src/tree-toolbar.js', 'src/tree-standalone-agent.js', 'src/agent-session.js']
const hashes = () => Object.fromEntries(sources.map(name => [name, createHash('sha256').update(readFileSync(path.join(root, name))).digest('hex')]))
const before = hashes()
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const server = await createServer(treeInteractionViteConfig({ root, out, retainBrowser }))
let browser
const results = [], errors = [], retainedBrowsers = []
try {
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  if (!retainBrowser) browser = await chromium.launch({ headless: true })
  const run = async (name, style, check, fleet = '') => {
    if (caseFilter.size && !caseFilter.has(name)) return
    const contextOptions = { viewport: { width: 1854, height: 1100 }, reducedMotion: 'reduce', acceptDownloads: false }
    let context, page
    if (retainBrowser) {
      // A fresh retained profile per case preserves isolation while keeping
      // exactly one live context and page, with downloads disabled on it.
      const profile = path.join(out, `${name}-profile`)
      const artifacts = path.join(out, `${name}-artifacts`)
      mkdirSync(artifacts, { recursive: true })
      retainedBrowsers.push({ name, profile, artifacts })
      context = await chromium.launchPersistentContext(profile, {
        ...contextOptions, headless: true, artifactsDir: artifacts,
      })
      browser = context.browser()
      assert.ok(context.pages().length <= 1, 'a fresh retained context starts at most one page')
      page = context.pages()[0] || await context.newPage()
    } else {
      context = await browser.newContext(contextOptions)
      page = await context.newPage()
    }
    page.setDefaultTimeout(8000)
    page.on('pageerror', error => errors.push({ name, message: error.message }))
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
    let failure
    try {
      await page.goto(`${origin}/tools/test/fixtures/tree-interactions.html?style=${style}&fleet=${fleet}`)
      await page.waitForFunction(() => window.fixture?.metrics)
      await page.evaluate(() => document.fonts.ready)
      await page.evaluate(() => graph.treeWindows.choose(graph.treeWindows.windows[0], 'alpha'))
      const node = (id, index = 0) => page.locator('.tree-window').nth(index).locator(`.node[data-agent-id="${id}"]:not(.tree-node-removing)`)
      const metrics = () => page.evaluate(() => fixture.metrics())
      const settle = () => page.waitForTimeout(250)
      const home = async () => { await page.locator('.tree-home-tab').click(); await settle() }
      const enableLinks = async () => {
        if (await page.locator('.tree-link-toggle').getAttribute('aria-pressed') !== 'true') await page.locator('.tree-link-toggle').click()
        await settle()
      }
      await settle()
      await check({ page, node, metrics, settle, home, enableLinks })
      results.push({ name, passed: true, metrics: await metrics() })
      await page.screenshot({ path: path.join(out, `${name}.png`) })
    } catch (error) {
      failure = error
      results.push({ name, passed: false, error: error.message, metrics: await page.evaluate(() => window.fixture?.metrics?.()).catch(() => null) })
      await page.screenshot({ path: path.join(out, `${name}-failure.png`) }).catch(() => {})
    } finally {
      await page.evaluate(() => fixture.dispose()).catch(() => {})
      const subscriptions = await page.evaluate(() => window.fixture?.subscribers.size).catch(() => null)
      if (subscriptions) results.push({ name: `${name}-cleanup`, passed: false, error: `${subscriptions} chat subscriptions remained after destroy` })
      const bridgeSubscriptions = await page.evaluate(() => window.fixture?.bridgeListeners.size).catch(() => null)
      if (bridgeSubscriptions) results.push({ name: `${name}-standalone-cleanup`, passed: false, error: `${bridgeSubscriptions} bridge subscriptions remained after destroy` })
      const ownerSubscriptions = await page.evaluate(() => window.fixture?.ownerListeners.size).catch(() => null)
      if (ownerSubscriptions) results.push({ name: `${name}-owner-cleanup`, passed: false, error: `${ownerSubscriptions} owner subscriptions remained after destroy` })
      await context.close()
      if (retainBrowser) browser = undefined
    }
    console.log(JSON.stringify({ name, passed: !failure, error: failure?.message }))
  }

  await run('fixed-node-drag', 'circles', async ({ page, node, settle }) => {
    await page.evaluate(() => {
      graph.setEditMode(true, { rootIds: ['alpha'] })
      graph.canDrag = () => false
      fixture.dragRefusals = []
      graph.onDropRefused = reason => fixture.dragRefusals.push(reason)
    })
    await settle()
    const snapshot = () => page.evaluate(() => {
      const record = graph.nodes.get('alpha-worker')
      return { x: record.x, y: record.y, active: !!graph._nodeDrag,
        positions: JSON.stringify(graph._positions), topology: JSON.stringify(fixture.computer.agents) }
    })
    const before = await snapshot(), box = await node('alpha-worker').boundingBox()
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    await page.mouse.move(point.x, point.y)
    await page.mouse.down()
    assert.equal((await snapshot()).active, false)
    await page.mouse.move(point.x + 75, point.y + 25, { steps: 3 })
    await page.mouse.up()
    assert.deepEqual(await snapshot(), before, 'fixed nodes never save a free nudge')
    await page.evaluate(() => { graph.canDrag = () => true })
    await page.mouse.move(point.x, point.y)
    await page.mouse.down()
    await page.mouse.move(point.x + 75, point.y + 25, { steps: 3 })
    assert.equal((await snapshot()).active, true)
    await page.evaluate(() => { graph.canDrag = () => false })
    await page.mouse.up()
    assert.deepEqual(await snapshot(), before, 'a revoked drag returns to its original position')
    assert.deepEqual(await page.evaluate(() => fixture.dragRefusals), ['notDraggable', 'notDraggable'])
  })

  await run('background-pan-teardown', 'circles', async ({ page, node }) => {
    const box = await node('alpha-worker').boundingBox()
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    const snapshot = () => page.evaluate(() => ({
      active: !!graph._panState,
      captured: graph.zoomHost.hasPointerCapture(1),
      panning: graph.zoomHost.classList.contains('panning'),
    }))
    await page.mouse.move(point.x, point.y)
    await page.mouse.down({ button: 'middle' })
    await page.mouse.move(point.x + 20, point.y + 10)
    assert.deepEqual(await snapshot(), { active: true, captured: true, panning: true },
      'the real browser pointer owns the camera before teardown')
    await page.evaluate(() => fixture.dispose())
    assert.deepEqual(await snapshot(), { active: false, captured: false, panning: false },
      'teardown releases the held camera pointer and gesture state')
    await page.mouse.up({ button: 'middle' })
    assert.deepEqual(await snapshot(), { active: false, captured: false, panning: false },
      'a stale release cannot revive the destroyed gesture')
  })

  await run('standalone-exit-before-binding', 'circles', async ({ page, metrics }) => {
    await page.evaluate(() => { fixture.bindingWait = new Promise(resolve => { fixture.finishBinding = resolve }) })
    await page.locator('.tree-chat-add').click()
    await page.locator('.tree-new-agent').click()
    await page.locator('.tree-agent-continue').click()
    const input = page.locator('.tree-standalone-conversation:not([hidden]) .chat-input input')
    await input.fill('Keep this message if start ends before binding')
    await input.press('Enter')
    await page.waitForFunction(() => fixture.bindingRequests.length === 1)
    assert.equal((await metrics()).bridgeCalls.some(row => row.method === 'send'), false)
    await page.evaluate(() => {
      const sessionId = fixture.bindingRequests[0].sessionId
      for (const listener of fixture.bridgeListeners) listener({ sessionId,
        event: { type: 'session_ended', reason: 'exited', exit: { code: 1, signal: null } } })
      fixture.finishBinding()
    })
    await page.waitForFunction(() => document.querySelector('.tree-standalone-conversation:not([hidden]) .chat-input input').value
      === 'Keep this message if start ends before binding')
    assert.equal((await metrics()).bridgeCalls.some(row => row.method === 'send'), false)
    assert.equal(await page.evaluate(() => [...graph.workspace.standalone.values()][0].session.snapshot().sessionId), null)
  })

  await run('node-drag-cancellation', 'circles', async ({ page, node, settle }) => {
    await page.evaluate(() => {
      fixture.moves = []
      graph.treeWindows.choose(graph.treeWindows.windows[0], ['alpha', 'beta'])
      graph.onReparent = (id, parentId) => {
        fixture.moves.push({ id, parentId })
        fixture.computer.agents.find(agent => agent.id === id).parentId = parentId
        graph.refresh()
        return true
      }
      graph.setEditMode(true, { rootIds: ['alpha', 'beta'] })
    })
    await settle()
    const snapshot = () => page.evaluate(() => {
      const record = graph.nodes.get('alpha-worker')
      return { x: record?.x, y: record?.y, parent: record?.agent.parentId,
        dragging: !!record?.el.classList.contains('dragging'), active: !!graph._nodeDrag,
        target: graph._dropRec?.id || null, raw: graph._dropRaw?.id || null,
        autoPan: !!graph._dragPan, positions: JSON.stringify(graph._positions), moves: [...fixture.moves] }
    })
    const center = async id => {
      const box = await node(id).boundingBox()
      assert.ok(box, `${id} is visible`)
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }
    const drag = async () => {
      const source = await center('alpha-worker'), target = await center('beta')
      await page.mouse.move(source.x, source.y)
      await page.mouse.down()
      await page.mouse.move(target.x, target.y, { steps: 4 })
      assert.equal((await snapshot()).target, 'beta', 'the live drag reaches a valid new parent')
    }
    const before = await snapshot()
    await drag()
    await page.evaluate(() => {
      const record = graph.nodes.get('alpha-worker')
      // Release the browser's real capture; its native lostpointercapture
      // event must cancel, rather than apply, the highlighted drop.
      record.el.releasePointerCapture(1)
    })
    const target = await center('beta')
    await page.mouse.move(target.x + 1, target.y)
    assert.deepEqual(await snapshot(), before)
    await page.mouse.up()
    assert.deepEqual(await snapshot(), before)

    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 })
    const source = await center('alpha-worker')
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 7, ...source }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 7, ...target }] })
    assert.equal((await snapshot()).target, 'beta')
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
    assert.deepEqual(await snapshot(), before, 'native touch cancellation preserves the branch and saved nudge')
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false })
    await cdp.detach()

    await drag()
    await page.evaluate(() => graph._layoutNow())
    await page.mouse.up()
    assert.deepEqual(await snapshot(), before, 'a changed layout cannot retain a drag measured against old slots')

    await drag()
    await page.evaluate(() => graph.setEditMode(false))
    await page.mouse.up()
    let state = await snapshot()
    assert.deepEqual(state.moves, [], 'leaving edit cannot commit a pending drag')
    assert.equal(state.active || state.dragging || state.autoPan, false)
    assert.equal(state.positions, before.positions)
    await page.evaluate(() => graph.setEditMode(true, { rootIds: ['alpha', 'beta'] }))
    await settle()
    await drag()
    await page.mouse.up()
    state = await snapshot()
    assert.deepEqual(state.moves, [{ id: 'alpha-worker', parentId: 'beta' }])
    assert.equal(state.parent, 'beta', 'a deliberate release still applies the real fixture reparent callback')
    assert.equal(state.active || state.dragging || state.autoPan, false)
    await settle()

    const beginReturnDrag = async () => {
      const start = await center('alpha-worker'), end = await center('alpha')
      await page.mouse.move(start.x, start.y)
      await page.mouse.down()
      await page.mouse.move(end.x, end.y, { steps: 4 })
      assert.equal((await snapshot()).target, 'alpha', JSON.stringify({ start, end, state: await snapshot() }))
    }
    await beginReturnDrag()
    await page.evaluate(() => {
      fixture.retainedAgents = fixture.computer.agents
      fixture.computer.agents = fixture.computer.agents.filter(agent => !['alpha-worker', 'alpha-leaf'].includes(agent.id))
      graph.refresh()
    })
    await page.mouse.up()
    assert.equal((await snapshot()).active, false, 'removing the captured node ends its gesture immediately')
    assert.equal((await snapshot()).autoPan, false)
    assert.deepEqual((await snapshot()).moves, state.moves)
    await page.evaluate(() => { fixture.computer.agents = fixture.retainedAgents; graph.refresh() })
    await settle()
    await beginReturnDrag()
    await page.evaluate(() => fixture.dispose())
    await page.mouse.up()
    assert.equal((await snapshot()).active, false, 'destroying the graph cannot leave a captured gesture alive')
    assert.equal((await snapshot()).autoPan, false)
    assert.deepEqual((await snapshot()).moves, state.moves)
  })

  // Owner, 2026-09-10: "double clicking the circle should bring up a window and
  // clicking on the card should bring up the sidebar".
  await run('circle-clicks', 'circles', async ({ page, node, metrics, settle }) => {
    const before = (await metrics()).windows[0].focus
    await node('alpha-worker').click()
    await page.waitForFunction(() => graph.selectedId === 'alpha-worker')
    await page.waitForTimeout(320)
    assert.equal((await metrics()).mode, 'trees')
    assert.deepEqual((await metrics()).controls, [])
    assert.deepEqual((await metrics()).chats, [], 'single circle click only selects')
    await node('alpha-worker').dblclick()
    await page.waitForFunction(() => graph.workspace.mode === 'chat' && graph.activeChatId === 'alpha-worker')
    await settle()
    assert.deepEqual((await metrics()).controls, [], 'double click opens the conversation, not side chat')
    assert.equal((await metrics()).windows[0].focus, before, 'double click does not drill into the tree')
  })

  await run('circle-card-chat', 'circles', async ({ page, metrics, home }) => {
    await page.evaluate(() => { graph._viewSteered = true })
    const first = page.locator('.static-tree-chip.screen-chip-visible').first()
    await first.waitFor()
    const id = await first.getAttribute('data-agent-id')
    const card = page.locator(`.static-tree-chip[data-agent-id="${id}"]`)
    await card.click()
    await page.waitForFunction(id => fixture.controls.at(-1) === id, id)
    assert.equal((await metrics()).mode, 'trees', 'a context card opens side chat beside the tree')
    assert.deepEqual((await metrics()).chats, [], 'a context card click does not open a full-chat tab')
    const camera = await page.evaluate(() => ({ zoom: graph.zoom, panX: graph.panX, panY: graph.panY }))
    await card.press('Shift+Enter')
    await page.waitForFunction(id => graph.workspace.mode === 'chat' && graph.activeChatId === id, id)
    const input = page.locator(`.tree-conversation[data-agent-id="${id}"] .chat-input input`)
    await input.fill('A draft opened from the detached context card')
    assert.deepEqual((await metrics()).controls, [id], 'Shift+Enter on the card goes directly to a full-chat tab')
    for (const selector of ['.tree-display-controls', '.tree-active-zoom', '.tree-workspace-controls', '.tree-window-add']) {
      assert.equal(await page.locator(selector).isVisible(), false, `${selector} cannot change a hidden tree while full chat is open`)
    }
    assert.equal(await page.locator('.graph-open-btn').isVisible(), true, 'Fleet overview stays available from full chat')
    await home()
    await page.waitForTimeout(180)
    assert.deepEqual(await page.evaluate(() => ({ zoom: graph.zoom, panX: graph.panX, panY: graph.panY })), camera, 'returning from full chat preserves the steered camera')
    assert.equal(await page.locator('.tree-active-zoom').isVisible(), true, 'tree controls return with their canvas')
    await page.locator(`[role="tab"][data-agent-id="${id}"]`).click()
    assert.equal(await input.inputValue(), 'A draft opened from the detached context card')
  })

  await run('circle-cards-persistence', 'circles', async ({ page, metrics, settle }) => {
    await page.locator('.tree-cards-toggle:visible').click()
    assert.equal(await page.evaluate(() => localStorage.getItem('mc.set.tree_cards')), 'false')
    assert.deepEqual((await metrics()).windows[0].visibleCards, [])
    await page.evaluate(() => graph.treeWindows.add('beta'))
    await settle()
    assert.ok((await metrics()).windows.every(view => !view.cards && !view.visibleCards.length), 'new windows inherit hidden cards')
    await page.locator('.tree-window').nth(1).locator('.node:visible').first().focus()
    await page.locator('.tree-cards-toggle:visible').click()
    await settle()
    assert.ok((await metrics()).windows.every(view => view.cards), 'the secondary Cards control updates both windows')
    assert.ok((await metrics()).windows.every(view => view.visibleCards.length > 0), 'show restores detached cards in both windows')
    await page.locator('.tree-cards-toggle:visible').click()
    await page.reload(); await page.waitForFunction(() => window.fixture?.metrics); await settle()
    assert.equal((await metrics()).windows.length, 2, 'the selected windows persist')
    assert.ok((await metrics()).windows.every(view => !view.cards && !view.visibleCards.length), 'hidden cards survive reload in every window')
    await page.locator('.tree-window').nth(1).locator('.node:visible').first().focus()
    await page.locator('.tree-cards-toggle:visible').click()
    await page.reload(); await page.waitForFunction(() => window.fixture?.metrics); await settle()
    assert.ok((await metrics()).windows.every(view => view.cards && view.visibleCards.length), 'showing cards also survives reload')
  })

  await run('box-clicks', 'boxes', async ({ page, node, metrics, home, settle }) => {
    const before = (await metrics()).windows[0].focus
    await node('alpha-worker').click()
    await page.waitForFunction(() => fixture.controls.at(-1) === 'alpha-worker')
    await settle()
    assert.equal((await metrics()).mode, 'trees', 'a single box click opens side chat beside the tree')
    assert.deepEqual((await metrics()).chats, [], 'a single box click does not open a full-chat tab')
    await node('alpha').dblclick()
    await page.waitForFunction(() => graph.workspace.mode === 'chat' && graph.activeChatId === 'alpha')
    await settle()
    assert.equal((await metrics()).windows[0].focus, before)
    assert.equal((await metrics()).controls.includes('alpha'), false, 'double click does not fire the delayed side-chat action')
    await home()
  })

  await run('standalone-page-remount', 'circles', async ({ page, metrics }) => {
    await page.locator('.tree-chat-add').click()
    await page.locator('.tree-new-agent').click()
    await page.locator('.tree-agent-continue').click()
    const input = () => page.locator('.tree-standalone-conversation:not([hidden]) .chat-input input')
    await input().fill('Keep this draft when I use Research')
    const id = (await metrics()).standalone[0].id
    await page.evaluate(() => fixture.remount())
    await page.locator(`.tree-chat-tab[data-agent-id="${id}"]`).click()
    assert.equal(await input().inputValue(), 'Keep this draft when I use Research')
    await input().press('Enter')
    await page.waitForFunction(() => fixture.bridgeCalls.some(row => row.method === 'send'))
    await input().fill('My next message')
    await page.evaluate(() => fixture.remount())
    await page.evaluate(() => {
      const sessionId = fixture.bridgeCalls.find(row => row.method === 'start').request.sessionId
      for (const event of [{ type: 'assistant_text_delta', text: 'Arrived while away', turnId: 'fixture-turn' },
        { type: 'turn_completed', status: 'completed', turnId: 'fixture-turn' }]) {
        for (const listener of fixture.bridgeListeners) listener({ sessionId, event })
      }
    })
    await page.locator(`.tree-chat-tab[data-agent-id="${id}"]`).click()
    assert.equal(await input().inputValue(), 'My next message')
    assert.ok((await page.locator('.tree-standalone-conversation:not([hidden])').innerText()).includes('Arrived while away'))
    assert.equal((await metrics()).bridgeCalls.filter(row => row.method === 'start').length, 1)
    assert.equal((await metrics()).bridgeCalls.filter(row => row.method === 'send').length, 1)
    assert.equal((await metrics()).bridgeCalls.filter(row => row.method === 'close').length, 0)
    await page.locator(`.tree-chat-tab-wrap[data-agent-id="${id}"] .tree-chat-tab-close`).click()
    await page.waitForFunction(() => fixture.bridgeCalls.some(row => row.method === 'close'))
    await page.evaluate(() => fixture.remount())
    assert.deepEqual((await metrics()).standalone, [])
  })

  await run('plus-menu-standalone-tabs', 'circles', async ({ page, metrics, home }) => {
    const before = await page.evaluate(() => JSON.stringify(fixture.computer.agents))
    const noticeSeen = () => page.evaluate(() => localStorage.getItem('mc.tree.standalone-notice.v1'))
    const tab = id => page.locator(`[role="tab"][data-agent-id="${id}"]`)
    const input = () => page.locator('.tree-standalone-conversation:not([hidden]) .chat-input input')
    await page.locator('.tree-chat-add').click()
    assert.equal(await page.locator('.tree-new-tree').isVisible(), true)
    await page.locator('.tree-new-agent').click()
    assert.equal(await page.locator('.tree-agent-notice').isVisible(), true)
    assert.deepEqual((await metrics()).standalone, [], 'the explanation appears before a tab or agent is created')
    assert.deepEqual((await metrics()).bridgeCalls, [], 'showing the explanation does not start a session')
    assert.equal(await noticeSeen(), null)
    await page.locator('.tree-agent-cancel').click()
    assert.equal(await page.locator('.tree-agent-notice').isVisible(), false)
    assert.equal(await noticeSeen(), null, 'cancel does not mark the first-use explanation as seen')
    await page.locator('.tree-new-agent').click()
    assert.equal(await page.locator('.tree-agent-notice').isVisible(), true)
    await page.locator('.tree-agent-continue').click()
    await input().waitFor()
    const first = (await metrics()).activeChat
    assert.match(first, /^standalone-/)
    assert.equal(await noticeSeen(), 'true')
    assert.equal(await tab(first).getAttribute('aria-selected'), 'true')
    assert.equal(await page.evaluate(id => graph.nodes.has(id) || fixture.computer.agents.some(agent => agent.id === id), first), false)
    assert.deepEqual((await metrics()).bridgeCalls, [], 'opening an agent tab waits for an explicit send before starting')
    const geometry = await page.locator('.tree-standalone-conversation:not([hidden])').evaluate(panel => ({
      width: panel.getBoundingClientRect().width, available: panel.closest('.tree-workspace-body').getBoundingClientRect().width,
      inputBottom: panel.querySelector('.chat-input input').getBoundingClientRect().bottom, height: innerHeight,
    }))
    assert.ok(geometry.width >= geometry.available * .98 && geometry.inputBottom <= geometry.height, 'standalone chat uses the full workspace width and keeps its composer visible')
    await input().fill('Independent agent draft')
    await home()
    await page.locator('.tree-chat-add').click()
    await page.locator('.tree-chat-options button[data-agent-id="alpha"]').click()
    const treeInput = page.locator('.tree-conversation[data-agent-id="alpha"] .chat-input input')
    await treeInput.fill('Tree agent draft remains separate')
    await tab(first).click()
    assert.equal(await input().inputValue(), 'Independent agent draft')
    await page.locator('.tree-chat-add').click()
    await page.locator('.tree-new-agent').click()
    assert.equal(await page.locator('.tree-agent-notice').isVisible(), true, 'each new agent offers its program and model choice')
    await page.locator('.tree-agent-continue').click()
    await page.waitForFunction(() => graph.workspace.standalone.size === 2)
    assert.equal(await page.locator('.tree-agent-notice').isVisible(), false, 'confirming the program closes the chooser')
    const second = (await metrics()).activeChat
    assert.notEqual(first, second)
    await input().fill('Second independent draft')
    await tab(first).click()
    assert.equal(await input().inputValue(), 'Independent agent draft')
    await tab(second).click()
    assert.equal(await input().inputValue(), 'Second independent draft')
    await page.locator(`.tree-chat-tab-wrap[data-agent-id="${second}"] .tree-chat-tab-close`).click()
    assert.equal((await metrics()).activeChat, 'alpha', 'closing the active agent selects its visually adjacent chat tab')
    assert.equal(await treeInput.inputValue(), 'Tree agent draft remains separate')
    await tab(first).click()
    assert.equal(await input().inputValue(), 'Independent agent draft')
    await page.locator(`.tree-chat-tab-wrap[data-agent-id="${first}"] .tree-chat-tab-close`).click()
    assert.deepEqual((await metrics()).standalone, [])
    assert.equal((await metrics()).bridgeSubscriptions, 0)
    assert.deepEqual((await metrics()).bridgeCalls, [], 'opening, switching and closing unsent tabs performs no native starts or turns')
    await page.locator('.tree-chat-add').click()
    await page.locator('.tree-new-tree').click()
    const request = await page.evaluate(() => fixture.adds.at(-1))
    assert.equal(request.kind, 'new-tree', 'New tree uses the existing empty-slot compose callback')
    assert.equal(request.parentId, null)
    assert.equal((await metrics()).mode, 'trees')
    assert.equal(await page.evaluate(() => JSON.stringify(fixture.computer.agents)), before, 'independent tabs and composer entry never mutate the saved tree agents')
  })

  await run('shared-toolbar', 'circles', async ({ page, metrics, settle }) => {
    await page.evaluate(() => graph.treeWindows.add('beta'))
    await settle()
    assert.equal(await page.locator('.tree-action-bar .graph-zoomer:visible').count(), 1, 'one zoom cluster is shown for the active canvas')
    assert.equal(await page.locator('.tree-window .graph-zoomer:visible').count(), 0, 'window headers do not duplicate the action row')
    const camera = () => page.evaluate(() => graph.treeWindows.windows.map(({ graph: view }) => view.zoom))
    await page.locator('.tree-window').nth(1).locator('.node:visible').first().focus()
    const before = await camera()
    await page.locator('.tree-action-bar .gz-in:visible').click()
    await page.waitForFunction(zoom => graph.treeWindows.windows[1].graph.zoom > zoom, before[1])
    await settle()
    const right = await camera()
    assert.equal(right[0], before[0], 'right-window zoom leaves the left camera unchanged')
    await page.locator('.tree-window').first().locator('.tree-window-select').focus()
    await page.locator('.tree-action-bar .gz-out:visible').click()
    await page.waitForFunction(zoom => graph.zoom < zoom, right[0])
    await settle()
    assert.equal((await camera())[1], right[1], 'left-window zoom leaves the right camera unchanged')
    await page.locator('.tree-shape-select').selectOption('boxes')
    assert.ok((await metrics()).windows.every(view => view.style === 'boxes'))
    assert.equal(await page.locator('.tree-cards-toggle:visible').count(), 0)
    assert.equal(await page.locator('.tree-card-size-select').isVisible(), true, 'card size remains available for boxes')
    const sizes = []
    for (const size of ['mini', 'small', 'medium', 'large']) {
      await page.locator('.tree-card-size-select').selectOption(size)
      await settle()
      assert.ok((await metrics()).windows.every(view => view.cardSize === size))
      sizes.push(await page.locator('.tree-window').first().locator('.node').first().evaluate(node => node.offsetWidth))
    }
    assert.ok(sizes.every((size, index) => !index || size > sizes[index - 1]), 'each size choice produces a larger physical box')
    await page.locator('.tree-shape-select').selectOption('circles')
    assert.ok((await metrics()).windows.every(view => view.style === 'circles'))
    assert.equal(await page.locator('.tree-cards-toggle:visible').count(), 1)
    for (const [width, height] of [[1854, 1100], [1366, 768], [1280, 800], [430, 844], [390, 844], [360, 844]]) {
      await page.setViewportSize({ width, height })
      for (const wide of width < 600 ? [true] : [true, false]) {
        await page.evaluate(wide => graph.setWide(wide), wide)
        await settle()
        const geometry = await page.locator('.tree-action-bar').evaluate(bar => {
          const buttons = [...bar.querySelectorAll('button,select')].filter(element => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
          return { pageWidth: document.documentElement.scrollWidth, controls: buttons.map(element => {
            const r = element.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
            return { name: element.getAttribute('aria-label') || element.textContent, x: r.x, y: r.y, right: r.right, bottom: r.bottom,
              clickable: hit === element || element.contains(hit) }
          }) }
        })
        assert.ok(geometry.pageWidth <= width + 1, `toolbar does not create page overflow at ${width}, wide=${wide}`)
        assert.ok(geometry.controls.every(control => control.x >= -.5 && control.right <= width + .5 && control.bottom <= height + .5 && control.clickable),
          `every toolbar action remains visible and clickable: ${JSON.stringify({ width, wide, geometry })}`)
        await page.screenshot({ path: path.join(out, `toolbar-${width}-${wide ? 'wide' : 'rail'}.png`) })
      }
    }
  })

  for (const style of ['boxes', 'circles']) await run(`${style}-progressive-frontier`, style, async ({ page, node, metrics, settle, home, enableLinks }) => {
    // Medium fits the real Manager at this viewport in the finalized layout.
    // Start the group journey with Large so it actually needs a synthetic
    // frontier; the later Mini stage separately exercises the real Manager.
    if (style === 'boxes') await page.locator('.tree-card-size-select').selectOption('large')
    await page.evaluate(() => graph.treeWindows.choose(graph.treeWindows.windows[0], ['alpha', 'beta']))
    await settle()
    const snapshot = async () => {
      const state = await page.evaluate(() => ({
      root: graph.rootId, visible: [...graph._layoutVisibleIds].sort(), scopeCount: graph._scopeAgentCount(),
      historyDepth: graph._scopeHistory?.length || 0,
      roots: ['alpha', 'beta'].map(id => graph._scopeModel().summary(id).total),
      records: [...graph._layoutVisibleIds].map(id => ({ id, missing: !graph.nodes.has(id), ...graph.nodes.get(id)?.agent.treeScope })),
      }))
      assert.deepEqual(state.records.filter(record => record.missing).map(record => record.id), [], 'every node in the visible layout has a mounted record')
      return state
    }
    const overview = await snapshot()
    assert.ok(overview.visible.length > 2 && overview.visible.length < 20, 'the forest exposes a partly expanded frontier instead of only two heads')
    assert.deepEqual(overview.roots, [18, 2], 'frontier cards retain the complete tree context')
    const group = overview.records.filter(record => record.group && record.expandable).sort((a, b) => b.summary.total - a.summary.total)[0]
    assert.ok(group, 'this viewport retains a group with more agents to explore')
    const centerPoint = () => page.evaluate(() => ({
      x: (graph.zoomHost.clientWidth / 2 - graph.panX) / graph.zoom,
      y: (graph.zoomHost.clientHeight / 2 - graph.panY) / graph.zoom,
    }))
    const groupBox = await node(group.id).boundingBox()
    const anchor = { x: groupBox.x + groupBox.width / 2, y: groupBox.y + groupBox.height / 2 }
    await page.mouse.move(anchor.x, anchor.y)
    await page.keyboard.down('Control'); await page.mouse.wheel(0, -10); await page.keyboard.up('Control')
    await settle()
    const anchoredBox = await node(group.id).boundingBox()
    assert.equal((await snapshot()).root, overview.root, 'a small inward zoom does not prematurely change scope')
    assert.ok(Math.hypot(anchoredBox.x + anchoredBox.width / 2 - anchor.x, anchoredBox.y + anchoredBox.height / 2 - anchor.y) < 2,
      'ordinary inward zoom holds the pointed branch steady before entering it')
    await page.locator('.tree-action-bar .graph-fit:visible').click()
    await settle()
    const centerBefore = await centerPoint(), hostBox = await page.locator('.tree-window .graph-zoom-host').first().boundingBox()
    await page.mouse.move(hostBox.x + hostBox.width * .94, hostBox.y + hostBox.height * .5)
    await page.keyboard.down('Control'); await page.mouse.wheel(0, 10); await page.keyboard.up('Control')
    await settle()
    const centerAfter = await centerPoint()
    assert.equal((await snapshot()).root, overview.root)
    assert.ok(Math.hypot(centerAfter.x - centerBefore.x, centerAfter.y - centerBefore.y) < 1,
      'outward zoom keeps the viewport center on the same graph point despite a pointer near the edge')
    await page.locator('.tree-action-bar .graph-fit:visible').click()
    await settle()
    const pinchInto = async (id, { pointAt = id, near = false } = {}) => {
      const before = await snapshot(), oldRoot = before.root
      for (let step = 0; step < 8 && (await snapshot()).root === oldRoot; step++) {
        const box = await node(pointAt).boundingBox()
        assert.ok(box, 'the branch remains mounted before the zoom enters it')
        const host = await page.locator('.tree-window .graph-zoom-host').first().boundingBox()
        const pointer = near ? { x: box.x + box.width / 2, y: Math.min(box.y + box.height + 40, host.y + host.height - 16) }
          : { x: box.x + box.width / 2, y: box.y + box.height / 2 }
        assert.ok(pointer.x >= host.x && pointer.x <= host.x + host.width && pointer.y >= host.y && pointer.y <= host.y + host.height,
          'the intended branch is recentered before it can slide outside the canvas')
        await page.mouse.move(pointer.x, pointer.y)
        await page.keyboard.down('Control')
        await page.mouse.wheel(0, -120)
        await page.keyboard.up('Control')
        await page.waitForTimeout(60)
      }
      await page.waitForFunction(id => graph.rootId === id, id)
      await page.evaluate(() => {
        const host = graph.zoomHost, rect = host.getBoundingClientRect()
        // The remainder of one trackpad pinch must not cascade through more
        // than one newly revealed scope, even over another expandable node.
        for (let pulse = 0; pulse < 6; pulse++) host.dispatchEvent(new WheelEvent('wheel', {
          deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true,
          clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2,
        }))
      })
      assert.equal((await snapshot()).root, id, 'one continuous pinch enters only one branch')
      assert.equal((await snapshot()).historyDepth, before.historyDepth + 1)
      await settle()
      const centered = await page.evaluate(() => {
        const box = graph._contentBox(graph.zoom)
        return { x: (graph.panX + (box.x + box.w / 2) * graph.zoom) / graph.zoomHost.clientWidth,
          y: (graph.panY + (box.y + box.h / 2) * graph.zoom) / graph.zoomHost.clientHeight }
      })
      assert.ok(centered.x > .2 && centered.x < .8 && centered.y > .2 && centered.y < .8,
        `entering the intended branch centers its content: ${JSON.stringify(centered)}`)
    }
    const zoomBack = async root => {
      for (let step = 0; step < 30 && (await snapshot()).root !== root; step++) {
        await page.locator('.tree-action-bar .gz-out:visible').click()
        await page.waitForTimeout(25)
      }
      await page.waitForFunction(root => graph.rootId === root, root)
      await settle()
    }
    await pinchInto(group.id, { near: true })
    const entered = await snapshot()
    assert.equal(entered.scopeCount, group.summary.total, 'zoom enters the complete represented branch')
    assert.ok(entered.records.some(record => !record.group && !overview.visible.includes(record.id)), 'zoom reveals actual agents hidden by the previous frontier')
    assert.deepEqual(entered.roots, [18, 2], 'drilling does not truncate full-tree context')
    assert.deepEqual((await metrics()).chats, [], 'exploring a group does not create an agent chat')
    await zoomBack(overview.root)
    assert.deepEqual((await snapshot()).visible, overview.visible, 'zoom out restores the same partly expanded frontier')
    await node(group.id).click()
    await page.waitForFunction(id => graph.rootId === id, group.id)
    await zoomBack(overview.root)
    assert.deepEqual((await snapshot()).visible, overview.visible, 'click-entered groups also return naturally by zooming out')
    await pinchInto('beta', { pointAt: 'beta-worker' })
    assert.equal((await snapshot()).scopeCount, 2, 'zooming toward a visible leaf in another tree captures its full tree head')
    await zoomBack(overview.root)
    if (style === 'boxes') {
      await page.locator('.tree-card-size-select').selectOption('mini')
      await page.evaluate(() => graph.treeWindows.choose(graph.treeWindows.windows[0], 'alpha'))
      await settle()
      const mini = await snapshot(), manager = mini.records.find(record => record.id === 'alpha-manager')
      assert.ok(manager && !manager.group && manager.hidden > 0, 'Mini exposes the real Manager with its workers still available below')
      assert.equal(manager.summary.total, 12)
      await node('alpha-manager').locator('.tree-box-chat').click()
      assert.equal((await metrics()).activeChat, 'alpha-manager', 'the real Manager opens its own chat, never a synthetic group chat')
      await home()
      await pinchInto('alpha-manager')
      assert.equal((await snapshot()).scopeCount, 12)
      await zoomBack('alpha')
      assert.deepEqual((await snapshot()).visible, mini.visible)
    }
    await page.evaluate(() => graph.treeWindows.choose(graph.treeWindows.windows[0], ['alpha', 'beta']))
    const beforeEdit = await page.evaluate(() => JSON.stringify(fixture.computer.agents))
    await page.evaluate(() => graph.setEditMode(true, { rootIds: ['alpha', 'beta'] }))
    await settle()
    const literalIds = await page.evaluate(() => fixture.computer.agents.map(agent => agent.id).sort())
    assert.equal(await page.evaluate(() => graph.nodeStyle), 'circles', 'editing uses the literal circle tree')
    assert.deepEqual((await snapshot()).visible, literalIds, 'editing exposes all20 actual agents from the selected trees')
    const editBox = await node('alpha').boundingBox()
    await page.mouse.move(editBox.x + editBox.width / 2, editBox.y + editBox.height / 2)
    await page.keyboard.down('Control'); await page.mouse.wheel(0, -120); await page.keyboard.up('Control')
    for (let step = 0; step < 3; step++) await page.locator('.tree-action-bar .gz-in:visible').click()
    assert.equal((await snapshot()).root, null, 'zoom never changes scope during structural editing')
    assert.deepEqual((await snapshot()).visible, literalIds, 'editing never substitutes synthetic groups while zooming')
    await page.evaluate(() => graph.setEditMode(false))
    await settle()
    assert.equal(await page.evaluate(() => graph.nodeStyle), style)
    assert.equal(await page.evaluate(() => JSON.stringify(fixture.computer.agents)), beforeEdit, 'entering, zooming and leaving edit does not mutate the fleet')
    await enableLinks()
    assert.deepEqual((await snapshot()).visible, ['alpha', 'beta'], 'link mode discards the partial frontier and exposes only complete tree heads')
    await node('alpha').click(); await node('beta').click()
    await page.waitForFunction(() => fixture.linkRequests.length === 1)
    assert.deepEqual((await metrics()).links[0], { from: 'alpha', to: 'beta', connected: true })
    assert.equal(await page.evaluate(() => fixture.computer.agents.length), 20, 'zoom and links never mutate the saved fleet')
  }, 'progressive')

  for (const style of ['circles', 'boxes']) await run(`${style}-head-links`, style, async ({ page, node, metrics, settle, enableLinks }) => {
    await page.evaluate(() => {
      graph.treeWindows.add('beta')
      graph.treeWindows.windows[0].graph.setRoot('alpha-worker')
      graph.treeWindows.windows[1].graph.setRoot('beta-worker')
      fixture.linkChildRecords = graph.treeWindows.windows.map(({ graph: view }, index) => view.nodes.get(`${index ? 'beta' : 'alpha'}-worker`))
    })
    await enableLinks()
    let state = await metrics()
    assert.deepEqual(state.windows.map(view => view.visible), [['alpha'], ['beta']], 'link mode resets both windows and displays only their actual tree heads')
    const roots = state.windows.map(view => view.focus)
    await node('alpha').dblclick()
    await settle()
    assert.deepEqual((await metrics()).windows.map(view => view.focus), roots, 'double click does not drill while linking')
    assert.deepEqual((await metrics()).controls, [], 'double click does not open side chat while linking')
    assert.deepEqual((await metrics()).chats, [], 'double click does not open a conversation while linking')
    await enableLinks()
    await node('alpha').press('Shift+Enter')
    assert.deepEqual((await metrics()).controls, [], 'Shift Enter cannot open side chat while linking')
    if (style === 'boxes') await node('alpha').locator('.tree-box-branch').click()
    else await node('alpha').press('f')
    await settle()
    assert.deepEqual((await metrics()).windows.map(view => view.focus), roots, 'branch controls do not change the linking overview')
    await page.keyboard.press('Escape')
    await enableLinks()
    await page.evaluate(async () => {
      await graph._chooseLinkNode(fixture.linkChildRecords[0])
      await graph._chooseLinkNode(graph.nodes.get('alpha'))
    })
    await settle()
    assert.deepEqual((await metrics()).links, [], 'two nodes in one tree cannot create a link')
    await page.keyboard.press('Escape')
    await enableLinks()
    await node('alpha').click()
    await node('beta', 1).click()
    await page.waitForFunction(() => fixture.linkRequests.length === 1 && !graph._linkPending)
    assert.deepEqual((await metrics()).links, [{ from: 'alpha', to: 'beta', connected: true }], 'the visible heads create their direct link')
    assert.ok((await metrics()).windows.every(view => !view.linking), 'successful linking leaves every window out of link mode')
    await page.locator('.tree-window-links [role="button"]').click()
    await page.locator('.link-remove').click()
    await page.waitForFunction(() => fixture.linkRequests.length === 2 && !graph._linkPending)
    await enableLinks()
    await page.evaluate(async () => {
      await graph._chooseLinkNode(fixture.linkChildRecords[0])
      await graph._chooseLinkNode(fixture.linkChildRecords[1])
    })
    await page.waitForFunction(() => fixture.linkRequests.length === 3 && !graph._linkPending)
    assert.deepEqual((await metrics()).links.at(-1), { from: 'alpha', to: 'beta', connected: true }, 'the link boundary resolves retained child records to their full tree heads')
  })
} finally {
  await browser?.close()
  await server.close()
  const after = hashes()
  writeFileSync(path.join(out, 'results.json'), JSON.stringify({ results, errors, before, after,
    retainedBrowsers: retainedBrowsers.map(record => ({ ...record,
      profileExistsAfterClose: existsSync(record.profile),
      artifactsExistAfterClose: existsSync(record.artifacts),
    })),
    sourceChangedDuringRun: JSON.stringify(before) !== JSON.stringify(after) }, null, 2))
}
const passed = results.every(result => result.passed) && !errors.length
console.log(JSON.stringify({ out, passed, cases: results.length, errors }))
if (!passed) process.exitCode = 1
