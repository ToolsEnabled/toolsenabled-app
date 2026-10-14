import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
const root = fileURLToPath(new URL('../../../', import.meta.url))
if (!process.env.NODE_MENU_EVIDENCE) throw new Error('Set NODE_MENU_EVIDENCE to a private evidence directory.')
const out = path.resolve(process.env.NODE_MENU_EVIDENCE)
mkdirSync(out, { recursive: true })
const files = ['src/node-action-menu.js', 'src/node-action-menu.css', 'src/tree-graph.js', 'src/tree-workspace.js', 'src/tree-windows.js', 'tools/test/fixtures/run-node-action-menu.mjs']
const hashes = () => Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')]))
const before = hashes(), results = [], errors = []
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const server = await createServer({ root, configFile: false, cacheDir: path.join(out, 'vite-cache'), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null, fs: { allow: [root, realpathSync(path.join(root, 'node_modules'))] } } })
let browser, page
try {
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) })
  for (const style of ['boxes', 'circles']) {
    page = await browser.newPage({ viewport: { width: 1200, height: 800 }, reducedMotion: 'reduce' })
    page.setDefaultTimeout(6000)
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
    await page.goto(`${origin}/tools/test/fixtures/tree-box-workspace.html?style=${style}`)
    await page.waitForFunction(() => !!window.graph?.treeWindows)
    await page.evaluate(() => {
      fixture.menuRuns = []; fixture.stopped = false
      graph.nodeActions = agent => ({
        rows: () => [
          { id: 'stop', group: 'This agent', label: 'Stop this agent', enabled: !fixture.stopped,
            disabledHint: 'This agent is already stopped.', run: () => { fixture.menuRuns.push(agent.id); fixture.stopped = true; fixture.notify(agent.id) } },
          { id: 'model', group: 'This agent', label: 'Switch model', enabled: true,
            run: ctx => ctx.show([{ id: 'choice', label: 'Example model', current: true, run: () => {} }], { title: 'Choose model' }) },
          { id: 'clear', label: 'Start over', run: ctx => ctx.show([{ id: 'confirm', label: 'Confirm restart', run: () => fixture.menuRuns.push('clear') }]) },
        ],
        subscribe: listener => { fixture.subscribers.set(agent.id, new Set([listener])); return () => fixture.subscribers.delete(agent.id) },
        openInChat: id => { fixture.menuRuns.push(`chat:${id}`); graph.openChat(graph.nodes.get(agent.id)) },
      })
      graph.treeWindows.choose(graph.treeWindows.windows[0], ['reviewer'])
    })
    const node = page.locator('.static-tree-node[data-agent-id="reviewer"]').first()
    const menu = page.getByRole('menu')
    await node.focus(); await page.keyboard.press('Shift+F10'); await menu.waitFor()
    assert.equal(await menu.getByRole('menuitem', { name: 'Open chat', exact: true }).evaluate(el => el === document.activeElement), true)
    await page.keyboard.press('End')
    assert.equal(await menu.getByRole('menuitem', { name: 'All actions', exact: true }).evaluate(el => el === document.activeElement), true)
    await page.keyboard.press('Escape'); assert.equal(await menu.count(), 0)
    assert.equal(await node.evaluate(el => el === document.activeElement), true)
    await node.click({ button: 'right' }); await menu.waitFor()
    await menu.getByRole('menuitem', { name: 'Stop this agent', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => fixture.menuRuns), ['reviewer'])
    const stop = menu.getByRole('menuitem', { name: 'Stop this agent', exact: true })
    assert.equal(await stop.getAttribute('aria-disabled'), 'true')
    await stop.focus(); await page.keyboard.press('Enter')
    assert.equal(await menu.getByRole('status').textContent(), 'This agent is already stopped.')
    assert.deepEqual(await page.evaluate(() => fixture.menuRuns), ['reviewer'])
    await menu.getByRole('menuitem', { name: 'Switch model', exact: true }).click()
    assert.equal(await menu.getByRole('menuitemradio', { name: 'Example model' }).getAttribute('aria-checked'), 'true')
    await page.keyboard.press('ArrowLeft')
    await menu.getByRole('menuitem', { name: 'Start over', exact: true }).click()
    await page.keyboard.press('Escape')
    assert.deepEqual(await page.evaluate(() => fixture.menuRuns), ['reviewer'])
    await node.focus(); await page.keyboard.press('Enter')
    const tab = page.locator('.tree-chat-tab[data-agent-id="reviewer"]')
    await tab.focus(); await page.keyboard.press('Shift+F10'); await menu.waitFor()
    assert.equal(await menu.getByRole('menuitem', { name: 'Close tab', exact: true }).count(), 1)
    await page.keyboard.press('Escape'); assert.equal(await tab.evaluate(el => el === document.activeElement), true)
    await page.locator('.tree-home-tab').click()
    await page.setViewportSize({ width: 390, height: 640 })
    await page.waitForTimeout(200)
    await page.waitForFunction(() => !graph._animationRaf && !graph._cameraFrame && !graph._zoomFrame)
    await node.dispatchEvent('contextmenu', { clientX: 389, clientY: 639 })
    await menu.waitFor()
    const bounds = await menu.evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom } })
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.right <= 390 && bounds.bottom <= 640, JSON.stringify(bounds))
    const zoomBounds = []
    await page.setViewportSize({ width: 280, height: 340 })
    await page.waitForTimeout(200)
    for (const zoom of [0.9, 1, 1.12]) {
      await page.keyboard.press('Escape')
      await page.evaluate(value => { document.body.style.zoom = value; document.body.style.setProperty('--zoom', value) }, String(zoom))
      await node.dispatchEvent('contextmenu', { clientX: 389, clientY: 639 })
      await menu.waitFor()
      const measured = await menu.evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom } })
      assert.ok(measured.x >= 0 && measured.y >= 0 && measured.right <= 280 && measured.bottom <= 340, JSON.stringify({ zoom, measured }))
      zoomBounds.push({ zoom, ...measured })
    }
    const cdp = await page.context().newCDPSession(page)
    const ax = await cdp.send('Accessibility.getFullAXTree')
    const menus = ax.nodes.filter(n => ['menu', 'menuitem'].includes(n.role?.value)).map(n => ({ role: n.role.value, name: n.name?.value, properties: n.properties }))
    assert.ok(menus.some(n => n.name?.includes('Reviewer') && n.role === 'menu'))
    assert.ok(menus.some(n => n.name === 'Stop this agent' && n.properties.some(p => p.name === 'disabled' && p.value.value === true)))
    writeFileSync(path.join(out, `${style}-accessibility.json`), JSON.stringify(menus, null, 2))
    await page.screenshot({ path: path.join(out, `${style}-menu.png`) })
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !graph._animationRaf && !graph._cameraFrame && !graph._zoomFrame)
    await page.waitForTimeout(200)
    await node.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 31, isPrimary: true, clientX: 80, clientY: 80 })
    await page.waitForTimeout(600); await menu.waitFor()
    await node.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 31 })
    await page.keyboard.press('Escape')
    results.push({ style, keyboard: true, stoppedRefusal: true, submenu: true, cancellation: true, conversationTab: true, longPress: true, bounds, zoomBounds, accessibility: true })
    await page.close(); page = null
  }
  assert.deepEqual(errors, [])
  assert.deepEqual(hashes(), before)
  writeFileSync(path.join(out, 'results.json'), JSON.stringify({ ok: true, sourceHashes: before, results, errors, scope: 'One browser page at a time; synthetic callbacks; no native provider or LIVE acceptance.' }, null, 2))
  console.log(JSON.stringify({ ok: true, styles: results.length, out }))
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(out, 'failure.png') })
    writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ message: error.message, errors, state: await page.evaluate(() => ({ edit: graph.editMode, pan: !!graph._panState, drag: !!graph._nodeDrag, menu: !!graph.nodeMenu?.root.isConnected, mode: graph.workspace.mode })) }, null, 2))
  }
  throw error
} finally { await page?.close(); await browser?.close(); await server.close() }
