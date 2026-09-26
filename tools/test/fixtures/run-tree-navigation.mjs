// Run against a live dev instance; each browser owns isolated example state.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tools/test/fixtures/run-tree-navigation.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
const { chromium, firefox } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const origin = process.env.TREE_DEV_ORIGIN || 'http://127.0.0.1:4600'
const out = mkdtempSync(path.join(tmpdir(), 'tree-navigation-'))
const results = []
for (const [name, engine] of Object.entries({ chromium, firefox })) {
  const browser = await engine.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1838, height: 1075 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${origin}/#/computers`)
    await page.waitForFunction(() => window.__mcGraph?.nodes.size)
    await page.evaluate(() => document.fonts.ready)
    const settle = () => page.waitForFunction(() => {
      const g = window.navigationGraph || window.__mcGraph
      return !g._zoomFrame && !g._zoomMotion && !g._cameraFrame
    })
    const wheel = async (x, y) => {
      const before = await page.evaluate(() => (window.navigationGraph || window.__mcGraph)._wheelGesture?.at || 0)
      await page.mouse.wheel(x, y)
      await page.waitForFunction(before => (window.navigationGraph || window.__mcGraph)._wheelGesture?.at > before, before)
    }
    await page.locator('.graph-fit').click()
    const fitted = await page.evaluate(() => window.__mcGraph.zoom)
    await page.locator('.gz-in').click(); await settle()
    assert.ok(Math.abs(await page.evaluate(() => window.__mcGraph.zoom) - fitted * 1.2) < 1e-4)
    await page.locator('.gz-out').click(); await settle()
    assert.ok(Math.abs(await page.evaluate(() => window.__mcGraph.zoom) - fitted) < 1e-4)
    // The existing tree list must recover its whole branch after manual zoom.
    await page.evaluate(() => window.__mcGraph.zoomBy(1.4))
    await page.locator('[data-fleet-open-tree]').nth(1).click()
    assert.equal(await page.locator('[data-fleet-open-tree]').nth(1).getAttribute('aria-current'), 'true')
    assert.equal(await page.evaluate(() => window.__mcGraph._contentIsInsideHost(window.__mcGraph._contentBox())), true)
    const selectedTree = await page.evaluate(() => window.__mcGraph.rootId)
    await page.locator('.graph-fit').click()
    assert.equal(await page.evaluate(() => window.__mcGraph.rootId), selectedTree, 'Fit stays inside the selected tree')
    await page.locator('.graph-crumb > button').first().click()
    assert.equal(await page.evaluate(() => window.__mcGraph.rootId), null)
    assert.equal(await page.locator('[data-fleet-show-all]').getAttribute('aria-pressed'), 'true')
    for (const width of [1024, 800, 1838]) {
      await page.setViewportSize({ width, height: 1075 })
      await page.waitForTimeout(180)
      assert.equal(await page.evaluate(() => [...document.querySelectorAll('.graph-tools button')].filter(el => !el.hidden && el.getBoundingClientRect().width).every(el => {
        const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
        return el === hit || el.contains(hit)
      })), true, `${name}/${width}: every toolbar button must receive the pointer`)
    }
    await page.screenshot({ path: path.join(out, `${name}-computers.png`) })
    await page.setViewportSize({ width: 1200, height: 980 })
    await page.goto(`${origin}/tools/test/fixtures/tree-navigation.html`)
    await page.waitForFunction(() => window.navigationGraph?.nodes.size)
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(180)
    const twenty = await page.evaluate(() => {
      const g = window.navigationGraph
      return { count: g.visibleAgents().length, zoom: g.zoom, diam: Math.min(...[...g.nodes.values()].map(r => r.el.getBoundingClientRect().width)), fit: g._contentIsInsideHost(g._contentBox()) }
    })
    assert.equal(twenty.count, 20)
    assert.ok(twenty.diam >= 47, `${name}: overview circles stay readable`)
    assert.equal(twenty.fit, true)
    await page.screenshot({ path: path.join(out, `${name}-twenty.png`) })
    // Use native wheel and pointer events to exercise laptop and mouse modes.
    const mode = async value => {
      await page.locator('.tree-more > summary').click()
      await page.selectOption('.tree-input-mode', value)
      await page.locator('.tree-more > summary').click()
    }
    const view = () => page.evaluate(() => {
      const g = window.navigationGraph
      return { x: g.panX, y: g.panY, zoom: g.zoom, selected: g.selectedId || null }
    })
    await page.evaluate(() => window.navigationGraph.zoomBy(2))
    await settle()
    const aimAtNode = async () => {
      const point = await page.evaluate(() => {
        const g = window.navigationGraph
        const r = [...g.nodes.values()].map(node => node.el.getBoundingClientRect())
          .find(r => r.left > 100 && r.right < innerWidth - 100 && r.top > 150 && r.bottom < innerHeight - 100)
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      })
      await page.mouse.move(point.x, point.y)
    }
    await aimAtNode()
    let before = await view()
    await wheel(0, -24)
    await settle()
    assert.ok((await view()).zoom > before.zoom, `${name}: a fine wheel keeps the selected zoom behavior`)
    await mode('trackpad')
    await aimAtNode()
    before = await view()
    await wheel(24, 18)
    await page.waitForTimeout(100)
    let after = await view()
    assert.equal(after.zoom, before.zoom, `${name}: fine trackpad scrolling preserves zoom`)
    assert.ok(after.x !== before.x && after.y !== before.y, `${name}: trackpad scrolling pans both axes`)
    await page.keyboard.down('Control')
    await wheel(0, -50)
    await page.keyboard.up('Control')
    await settle()
    assert.ok((await view()).zoom > after.zoom, `${name}: pinch zooms the tree`)
    await mode('mouse')
    await aimAtNode()
    before = await view()
    await wheel(0, -24)
    await settle()
    assert.ok((await view()).zoom > before.zoom, `${name}: mouse override zooms on a fine wheel`)
    await mode('trackpad')
    await aimAtNode()
    before = await view()
    await wheel(0, 120)
    await page.waitForTimeout(100)
    after = await view()
    assert.equal(after.zoom, before.zoom, `${name}: trackpad override pans a coarse event`)
    assert.notEqual(after.y, before.y)
    await mode('mouse')
    await aimAtNode()
    before = await view()
    await page.keyboard.down('Shift')
    await wheel(0, 24)
    await page.keyboard.up('Shift')
    await page.waitForTimeout(100)
    after = await view()
    assert.equal(after.zoom, before.zoom)
    assert.equal(after.y, before.y)
    assert.notEqual(after.x, before.x, `${name}: Shift scroll pans horizontally`)
    await aimAtNode()
    before = await view()
    await page.mouse.down({ button: 'middle' })
    const point = await page.evaluate(() => ({ x: window.navigationGraph._panState.x, y: window.navigationGraph._panState.y }))
    await page.mouse.move(point.x + 38, point.y + 26, { steps: 4 })
    await page.mouse.up({ button: 'middle' })
    after = await view()
    assert.ok(after.x !== before.x && after.y !== before.y, `${name}: middle drag pans over a node`)
    assert.equal(after.selected, before.selected)
    await page.mouse.move(point.x + 70, point.y + 70)
    assert.deepEqual(await view(), after, `${name}: releasing middle drag stops panning`)
    await mode('mouse')
    await aimAtNode()
    for (let notch = 0; notch < 10; notch++) {
      before = await view()
      await wheel(0, -120)
      await settle()
      after = await view()
      assert.ok(after.zoom >= before.zoom, `${name}: zoom-in never reverses direction`)
      assert.equal(await page.evaluate(() => window.navigationGraph.rootId), null, 'zooming an ordinary 20-agent tree preserves its hierarchy')
    }
    await page.selectOption('[aria-label="Tree size"]', '1000')
    await page.waitForTimeout(250)
    assert.ok(await page.evaluate(() => window.navigationGraph.visibleAgents().length) <= 6)
    const levels = []
    for (let depth = 0; depth < 12; depth++) {
      await page.waitForTimeout(280)
      const target = await page.evaluate(() => {
        const g = window.navigationGraph
        const r = [...g.nodes.values()].filter(r => g._layoutVisibleIds.has(r.id) && r.agent.treeScope?.expandable)
          .sort((a, b) => b.agent.treeScope.summary.total - a.agent.treeScope.summary.total)[0]
        if (!r) return null
        const box = r.el.getBoundingClientRect()
        return { id: r.id, root: g.rootId, total: r.agent.treeScope.summary.total, x: box.x + box.width / 2, y: box.y + box.height / 2 }
      })
      if (!target) break
      await page.mouse.move(target.x, target.y)
      for (let notch = 0; notch < 14; notch++) {
        await wheel(0, -120); await settle()
        if (await page.evaluate(() => window.navigationGraph.rootId) !== target.root) break
      }
      assert.equal(await page.evaluate(() => window.navigationGraph.rootId), target.id, 'native wheel captures the intended branch')
      assert.equal(await page.evaluate(() => window.navigationGraph._contentIsInsideHost(window.navigationGraph._contentBox())), true, 'revealed children must be inside the pane')
      levels.push(target.total)
      assert.ok(depth < 11, 'progressive detail must reach individual agents')
    }
    assert.ok(levels.length >= 3, 'the check must cross several real scope boundaries')
    assert.ok(levels.every((count, i) => !i || count < levels[i - 1]))
    await page.screenshot({ path: path.join(out, `${name}-detail.png`) })
    await page.mouse.move(600, 400)
    for (let notch = 0; notch < 80 && await page.evaluate(() => !!window.navigationGraph.rootId); notch++) {
      await wheel(0, 120); await settle()
    }
    assert.equal(await page.evaluate(() => window.navigationGraph.rootId), null, 'wheel-out must return all the way to the overview')
    assert.equal(await page.evaluate(() => window.navigationGraph._scopeModel().summary('example-0').total), 1000)
    await page.screenshot({ path: path.join(out, `${name}-thousand.png`) })
    assert.deepEqual(errors, [])
    results.push({ browser: name, version: browser.version(), twenty, levels, inputControls: true, errors })
    console.log(`PASS ${name}: readable circles, toolbar, fitted tree tabs, mouse/trackpad controls, ${levels.length} zoom levels, complete return`)
  } finally { await browser.close() }
}
writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2))
console.log(`Evidence: ${out}`)
