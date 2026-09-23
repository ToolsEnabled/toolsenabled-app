// Actual browser geometry over explicit fictional agents; no native profile,
// provider session, or external network is used.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const out = mkdtempSync(path.join(tmpdir(), 'tree-box-forest-'))
const sources = ['src/tree-box-layout.js', 'src/tree-layout.js', 'src/tree-readability.js', 'src/tree-scope.js',
  'src/tree-graph.js', 'src/tree-graph.css', 'src/tree-workspace.js', 'src/tree-windows.js',
  'src/tree-toolbar.js', 'src/tree-workspace.css', 'src/tree-card-density.css']
const hashes = () => Object.fromEntries(sources.map(name => [name,
  createHash('sha256').update(readFileSync(path.join(root, name))).digest('hex')]))
const before = hashes(), results = [], errors = []
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const server = await createServer({ root, configFile: false, cacheDir: path.join(out, 'vite-cache'), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null,
    fs: { allow: [root, realpathSync(path.join(root, 'node_modules'))] } } })
let browser, page, stage = 'load'
const within = (box, host) => box.left >= host.left - 1 && box.right <= host.right + 1
  && box.top >= host.top - 1 && box.bottom <= host.bottom + 1
try {
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1854, height: 1100 } })
  page = await context.newPage()
  page.on('pageerror', error => errors.push({ stage, message: error.message }))
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  await page.goto(`${origin}/tools/test/fixtures/tree-box-workspace.html?style=circles`)
  await page.waitForFunction(() => window.fixture?.metrics)
  await page.evaluate(() => document.fonts.ready)
  const settle = async () => {
    await page.waitForFunction(() => !graph._cameraFrame && !graph._zoomFrame && !graph._zoomMotion)
    await page.waitForTimeout(450)
  }
  await page.evaluate(() => {
    fixture.nodes.splice(0, fixture.nodes.length, ...Array.from({ length: 4 }, (_, tree) =>
      Array.from({ length: 15 }, (_, index) => ({
        id: `tree-${tree}:${index}`, name: index ? `Worker ${tree}.${index}` : `Controller ${tree + 1}`,
        parentId: index ? `tree-${tree}:${Math.floor((index - 1) / 3)}` : null,
        role: index ? 'worker' : 'controller', declaredRole: index ? 'worker' : 'controller', state: 'idle',
        treeNode: { id: `tree-${tree}:${index}`, treeId: `tree-${tree}` },
      }))).flat())
    fixture.forestInput = JSON.stringify(fixture.computer.agents)
    for (const agent of fixture.nodes) fixture.queues.set(agent.id, [])
    const frame = graph.treeWindows.windows[0]
    graph.treeWindows.grid.style.gridTemplateColumns = '877px'
    frame.pane.style.width = '877px'
    graph.zoomHost.style.width = '875px'
    graph.zoomHost.style.flex = '0 0 856px'
    graph.zoomHost.style.height = graph.zoomHost.style.minHeight = graph.zoomHost.style.maxHeight = '856px'
    graph.refresh()
    graph.treeWindows.choose(frame, [0, 1, 2, 3].map(tree => `tree-${tree}:0`))
    graph.setCardSize('large')
    graph.setCommunicationLinks([{ from: 'tree-0:0', to: 'tree-3:0' }])
    graph.resize(true)
    graph.fitCurrentTree()
  })
  await settle()
  const measure = () => page.evaluate(() => {
    const rect = element => { const r = element.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } }
    const records = [...graph.nodes.values()].filter(record => !record.el.hidden && graph._layoutVisibleIds.has(record.id))
    const links = [...graph.svg.querySelectorAll('.link-direct, .tree-link-route[data-edge-type="hierarchy"]')].map(path => {
      const ctm = path.getScreenCTM(), length = path.getTotalLength()
      const point = at => { const p = path.getPointAtLength(at).matrixTransform(ctm); return { x: p.x, y: p.y } }
      return { from: path.dataset.from, to: path.dataset.to, type: path.dataset.edgeType, d: path.getAttribute('d'),
        start: point(0), end: point(length), samples: Array.from({ length: 41 }, (_, index) => point(length * index / 40)) }
    })
    return { style: graph.nodeStyle, size: graph.cardSize, host: rect(graph.zoomHost),
      client: { width: graph.zoomHost.clientWidth, height: graph.zoomHost.clientHeight },
      zoom: graph.zoom, contentBox: graph._contentBox(1), projectionFit: graph._projection?.fitScale,
      fitted: graph._contentIsInsideHost(graph._contentBox()),
      nodes: records.map(record => ({ id: record.id, parentId: record.agent.parentId,
        x: record.x, y: record.y, radius: record.r, group: !!record.agent.treeScope?.group,
        summary: record.agent.treeScope?.summary, rect: rect(record.el) })),
      links, marker: graph.svg.querySelector('.tree-link-marker text')?.textContent,
      fleetUnchanged: JSON.stringify(fixture.computer.agents) === fixture.forestInput }
  })
  const circlesBefore = await measure()
  assert.deepEqual(circlesBefore.client, { width: 875, height: 856 })
  const circleSignature = view => view.nodes.map(({ id, parentId, x, y, radius, group }) => ({ id, parentId, x, y, radius, group }))
    .sort((a, b) => a.id.localeCompare(b.id))
  results.push({ stage: 'circles before', ...circlesBefore })

  for (const size of ['large', 'mini']) {
    stage = `packed ${size} boxes`
    await page.evaluate(size => { graph.setNodeStyle('boxes'); graph.setCardSize(size); graph.fitCurrentTree() }, size)
    await settle()
    const measured = await measure()
    results.push({ stage, ...measured })
    assert.deepEqual(measured.client, { width: 875, height: 856 })
    assert.equal(measured.fitted, true)
    assert.equal(measured.fleetUnchanged, true)
    for (const tree of [0, 1, 2, 3]) {
      const head = measured.nodes.find(node => node.id === `tree-${tree}:0`)
      assert.ok(head, 'each dense tree retains its actual named head')
      assert.equal(head.group, false)
      assert.equal(head.summary.total, 15)
    }
    for (const [index, node] of measured.nodes.entries()) {
      assert.ok(within(node.rect, measured.host), `${node.id} fits inside both viewport boundaries`)
      for (const other of measured.nodes.slice(index + 1)) assert.ok(node.rect.right <= other.rect.left + 1
        || other.rect.right <= node.rect.left + 1 || node.rect.bottom <= other.rect.top + 1
        || other.rect.bottom <= node.rect.top + 1, 'actual painted cards do not overlap')
    }
    if (size === 'large') {
      assert.equal(measured.nodes.length, 4)
      assert.equal(new Set(measured.nodes.map(node => node.y)).size, 2)
      // The live Fit includes the adjacent Add tree control as well as cards.
      // Its complete painted footprint must remain above the readable floor.
      assert.ok(measured.zoom >= 0.72, 'all four named heads fit together above the readable box scale')
    } else assert.ok(measured.links.some(link => link.type === 'hierarchy'), 'the smaller size exposes real hierarchy connectors too')
    assert.equal(measured.links.filter(link => link.type === 'direct').length, 1)
    assert.equal(measured.marker, '›')
    for (const link of measured.links) {
      const from = measured.nodes.find(node => node.id === link.from).rect
      const to = measured.nodes.find(node => node.id === link.to).rect
      for (const [point, box] of [[link.start, from], [link.end, to]]) {
        assert.ok(point.x >= box.left - 1 && point.x <= box.right + 1 && point.y >= box.top - 1 && point.y <= box.bottom + 1)
        assert.ok(Math.min(Math.abs(point.x - box.left), Math.abs(point.x - box.right),
          Math.abs(point.y - box.top), Math.abs(point.y - box.bottom)) < 1,
        'SVG endpoints meet the actual painted rectangle perimeter after packing')
      }
      if (link.type === 'hierarchy') {
        assert.ok(Math.abs(link.start.y - from.bottom) < 1 && Math.abs(link.end.y - to.top) < 1)
        for (const point of link.samples) for (const node of measured.nodes) assert.ok(
          point.x <= node.rect.left + 0.1 || point.x >= node.rect.right - 0.1
          || point.y <= node.rect.top + 0.1 || point.y >= node.rect.bottom - 0.1,
        'shared hierarchy strokes do not cross any packed box interior')
      } else assert.match(link.d, /^M [\d. -]+ L [\d. -]+$/)
    }
    await page.screenshot({ path: path.join(out, `packed-${size}.png`) })
  }
  stage = 'circles restored'
  await page.evaluate(() => { graph.setCardSize('large'); graph.setNodeStyle('circles'); graph.fitCurrentTree() })
  await settle()
  const circlesAfter = await measure()
  assert.deepEqual(circleSignature(circlesAfter), circleSignature(circlesBefore),
    'box packing cannot alter the circle projection, ranks, radii, or internal geometry')
  assert.equal(circlesAfter.fleetUnchanged, true)
  assert.equal(circlesAfter.fitted, true)
  results.push({ stage, ...circlesAfter })
  await page.screenshot({ path: path.join(out, 'circles-restored.png') })
  assert.deepEqual(errors, [])
  const after = hashes(), sourceChangedDuringRun = JSON.stringify(before) !== JSON.stringify(after)
  writeFileSync(path.join(out, 'measurements.json'), JSON.stringify({ results, errors, before, after, sourceChangedDuringRun }, null, 2))
  console.log(JSON.stringify({ out, passed: true, cases: results.length, sourceChangedDuringRun }))
  await page.evaluate(() => graph.destroy())
  await context.close()
} catch (error) {
  writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ stage, error: error.message, results, errors, before, after: hashes() }, null, 2))
  await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {})
  console.error(`Evidence: ${out}; stage: ${stage}`)
  throw error
} finally {
  await browser?.close()
  await server.close()
}
