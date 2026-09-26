// Real renderer over an explicitly fictional uneven forest. No native profile,
// provider calls, or external network; exercise the actual SVG pointer target.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
const root = fileURLToPath(new URL('../../../', import.meta.url))
const requested = process.env.TREE_LINK_CLEARANCE_EVIDENCE
const out = requested && !existsSync(requested) ? requested : mkdtempSync(requested ? `${requested}-` : path.join(tmpdir(), 'tree-link-clearance-'))
mkdirSync(out, { recursive: true })
const files = ['src/tree-graph.js', 'src/tree-link-marker.js', 'src/tree-box-layout.js', 'src/tree-readability.js',
  'src/tree-graph.css', 'tools/test/fixtures/tree-box-workspace.mjs', 'tools/test/fixtures/run-tree-link-clearance.mjs']
const hashes = () => Object.fromEntries(files.map(file => [file, existsSync(path.join(root, file))
  ? createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex') : null]))
const before = hashes(), results = [], errors = []
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const server = await createServer({ root, configFile: false, cacheDir: path.join(out, 'vite-cache'), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null, fs: { allow: [root, realpathSync(path.join(root, 'node_modules'))] } } })
let browser, page, stage = 'load'
try {
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1854, height: 1180 }, reducedMotion: 'reduce' })
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  await page.goto(`${origin}/tools/test/fixtures/tree-box-workspace.html?style=boxes`)
  await page.waitForFunction(() => window.fixture?.metrics)
  await page.evaluate(() => document.fonts.ready)
  await page.evaluate(() => {
    const agents = [], add = (id, parentId, name, role, tree) => agents.push({ id, parentId, name, role, declaredRole: role,
      state: 'idle', treeNode: { id, treeId: tree } })
    add('controller', null, 'Controller', 'controller', 'original')
    for (let i = 0; i < 5; i++) add(`builder-${i}`, 'controller', `Builder ${i + 1}`, 'builder', 'original')
    add('manager', 'controller', 'Manager', 'manager', 'original')
    for (let i = 0; i < 11; i++) add(`worker-${i}`, 'manager', `Worker ${i + 1}`, 'worker', 'original')
    add('reviewer', null, 'Reviewer', 'reviewer', 'review')
    add('review-child', 'reviewer', 'Builder', 'builder', 'review')
    add('product', null, 'Product controller', 'controller', 'product')
    for (let i = 0; i < 4; i++) {
      add(`product-manager-${i}`, 'product', `Manager ${i + 1}`, 'manager', 'product')
      for (let j = 0; j < 5; j++) add(`product-worker-${i}-${j}`, `product-manager-${i}`, `Worker ${i + 1}.${j + 1}`, 'worker', 'product')
    }
    add('coordinator', null, 'Coordinator', 'controller', 'research')
    for (let i = 0; i < 2; i++) {
      add(`research-manager-${i}`, 'coordinator', `Research lead ${i + 1}`, 'manager', 'research')
      for (let j = 0; j < 6; j++) add(`research-worker-${i}-${j}`, `research-manager-${i}`, `Researcher ${i + 1}.${j + 1}`, 'worker', 'research')
    }
    const headIds = { controller: 'a-controller', reviewer: 'b-reviewer', product: 'c-product', coordinator: 'd-coordinator' }
    for (const agent of agents) { agent.id = headIds[agent.id] || agent.id; agent.parentId = headIds[agent.parentId] || agent.parentId; agent.treeNode.id = agent.id }
    fixture.nodes.splice(0, fixture.nodes.length, ...agents)
    for (const agent of agents) fixture.queues.set(agent.id, [])
    fixture.originalFleet = JSON.stringify(fixture.nodes)
    const frame = graph.treeWindows.windows[0]
    graph.treeWindows.grid.style.gridTemplateColumns = '1740px'; frame.pane.style.width = '1740px'
    graph.zoomHost.style.width = '1738px'; graph.zoomHost.style.flex = '0 0 866px'
    graph.zoomHost.style.height = graph.zoomHost.style.minHeight = graph.zoomHost.style.maxHeight = '866px'
    graph.refresh(); graph.treeWindows.choose(frame, ['a-controller', 'b-reviewer', 'c-product', 'd-coordinator'])
    graph.setCardSize('large')
    fixture.links = [{ from: 'a-controller', to: 'b-reviewer' }, { from: 'c-product', to: 'd-coordinator' }]
    graph.setCommunicationLinks(fixture.links); graph.resize(true); graph.fitCurrentTree()
  })
  const settle = async () => { await page.waitForFunction(() => !graph._cameraFrame && !graph._zoomFrame); await page.waitForTimeout(180) }
  const measure = () => page.evaluate(() => {
    const distance = (point, rect) => Math.hypot(Math.max(rect.left - point.x, 0, point.x - rect.right), Math.max(rect.top - point.y, 0, point.y - rect.bottom))
    const nodes = [...graph.nodes.values()].filter(r => !r.el.hidden && graph._layoutVisibleIds.has(r.id)).map(r => {
      const rect = r.el.getBoundingClientRect(); return { id: r.id, group: !!r.agent.treeScope?.group,
        rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } }
    })
    const paths = [...graph.svg.querySelectorAll('.link-direct')], markers = [...graph.svg.querySelectorAll('.tree-link-marker')]
    const links = paths.map((path, i) => {
      const matrix = path.getScreenCTM(), length = path.getTotalLength()
      const convert = point => { const p = point.matrixTransform(matrix); return { x: p.x, y: p.y } }
      const start = convert(path.getPointAtLength(0)), end = convert(path.getPointAtLength(length)), midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
      const marker = markers[i], center = new DOMPoint(0, 0).matrixTransform(marker.getScreenCTM())
      const samples = [[0, 0], ...Array.from({ length: 8 }, (_, j) => [9 * Math.cos(j * Math.PI / 4), 9 * Math.sin(j * Math.PI / 4)])]
      return { from: path.dataset.from, to: path.dataset.to, d: path.getAttribute('d'), start, end, midpoint,
        marker: { x: center.x, y: center.y }, midpointObstacles: nodes.filter(node => distance(midpoint, node.rect) < 13).map(node => ({ id: node.id, group: node.group })),
        markerClearance: Math.min(...nodes.map(node => distance(center, node.rect))),
        reachable: samples.every(([x, y]) => { const hit = document.elementFromPoint(center.x + x, center.y + y); return hit === marker || marker.contains(hit) }) }
    })
    return { style: graph.nodeStyle, zoom: graph.zoom, fit: graph._contentIsInsideHost(graph._contentBox()), nodes, links,
      fleetUnchanged: JSON.stringify(fixture.nodes) === fixture.originalFleet }
  })
  await settle()
  for (const [name, zoom] of [['fit', null], ['zoom-out', 0.85], ['zoom-in', 1.4]]) {
    stage = name
    if (zoom) await page.evaluate(factor => graph.zoomBy(factor, null, null, { explore: false }), zoom)
    await settle()
    const view = await measure(); results.push({ stage, ...view })
    if (name === 'fit') {
      assert.equal(view.fit, true)
      assert.ok(view.links.some(link => link.midpointObstacles.some(node => node.group)), 'uneven multirow forest reproduces a group covering the old midpoint')
    }
    assert.equal(view.fleetUnchanged, true)
    assert.equal(view.links.length, 2)
    for (const link of view.links) {
      assert.match(link.d, /^M [\d.e+ -]+ L [\d.e+ -]+$/)
      const dx = link.end.x - link.start.x, dy = link.end.y - link.start.y, length = Math.hypot(dx, dy)
      assert.ok(Math.abs((link.marker.x - link.start.x) * dy - (link.marker.y - link.start.y) * dx) / length < 0.1, 'control stays on the unchanged straight line')
      assert.ok(link.markerClearance >= 12.5, 'entire marker hit area clears every painted box')
      assert.equal(link.reachable, true, `${link.from} › ${link.to} receives pointer hits at its center and rim`)
      if (!link.midpointObstacles.length) assert.ok(Math.hypot(link.marker.x - link.midpoint.x, link.marker.y - link.midpoint.y) < 0.1, 'an exposed midpoint does not move')
    }
    await page.screenshot({ path: path.join(out, `${name}.png`) })
    if (name === 'fit') {
      const link = view.links.find(link => link.from === 'c-product')
      await page.mouse.click(link.marker.x, link.marker.y)
      await page.locator('.tree-link-popover').waitFor()
      assert.deepEqual(await page.locator('.link-agent-name').allTextContents(), ['Product controller', 'Coordinator'])
      await page.locator('.link-dismiss').click()
    }
  }
  stage = 'circles unchanged'
  await page.evaluate(() => { graph.setNodeStyle('circles'); graph.fitCurrentTree() })
  await settle()
  const circles = await measure(); results.push({ stage, ...circles })
  for (const link of circles.links) assert.ok(Math.hypot(link.marker.x - link.midpoint.x, link.marker.y - link.midpoint.y) < 0.1, 'circle marker remains at its original midpoint')
  assert.deepEqual(errors, [])
  const after = hashes(), sourceChangedDuringRun = JSON.stringify(before) !== JSON.stringify(after)
  writeFileSync(path.join(out, 'evidence.json'), JSON.stringify({ passed: true, before, after, sourceChangedDuringRun, results, errors }, null, 2))
  console.log(JSON.stringify({ out, passed: true, cases: results.length, sourceChangedDuringRun, errors }))
} catch (error) {
  writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ stage, error: error.message, results, errors, before, after: hashes() }, null, 2))
  await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {})
  console.error(`Evidence: ${out}; ${stage}`); throw error
} finally { await browser?.close(); await server.close() }
