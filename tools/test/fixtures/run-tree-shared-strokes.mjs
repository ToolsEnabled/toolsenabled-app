import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const requested = process.env.TREE_STROKE_EVIDENCE
const out = requested ? existsSync(requested) ? mkdtempSync(`${requested}-`) : requested : mkdtempSync(path.join(tmpdir(), 'tree-strokes-'))
mkdirSync(out, { recursive: true })
const baselineRef = 'fd7c16bc'
const baseline = execFileSync('git', ['show', `${baselineRef}:src/tree-graph.js`], { cwd: root, encoding: 'utf8' })
const sourceState = () => Object.fromEntries([
  'src/tree-graph.js', 'src/tree-graph.css', 'src/tree-workspace.css', 'src/tree-stroke-paths.js',
  'tools/test/tree-shared-strokes.test.mjs', 'tools/test/fixtures/tree-shared-strokes.html',
  'tools/test/fixtures/tree-shared-strokes.mjs', 'tools/test/fixtures/run-tree-shared-strokes.mjs',
].map(file => [file, createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')]))
const sourceBefore = sourceState()
const virtualPath = path.join(root, 'src/tree-graph-shared-strokes-baseline.js')
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const server = await createServer({ root, configFile: false, cacheDir: path.join(out, 'vite-cache'), logLevel: 'error',
  optimizeDeps: { entries: ['tools/test/fixtures/tree-shared-strokes.html'] },
  plugins: [{ name: 'reviewed-stroke-baseline', enforce: 'pre',
    resolveId(id) { if (id.endsWith('/src/tree-graph-shared-strokes-baseline.js')) return virtualPath },
    load(id) { if (id === virtualPath) return baseline },
  }],
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null, fs: { allow: [root, realpathSync(path.join(root, 'node_modules'))] } } })
let browser
const results = [], errors = []
try {
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1100, height: 620 }, deviceScaleFactor: 1 })
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  for (const style of ['circles', 'boxes']) for (const before of [true, false]) {
    await page.goto(`${origin}/tools/test/fixtures/tree-shared-strokes.html?style=${style}&baseline=${before ? 1 : 0}`)
    await page.waitForFunction(() => !!window.fixture)
    for (const scale of [1, .73, 1.37]) {
      await page.evaluate(scale => fixture.setScale(scale), scale)
      const points = await page.evaluate(() => fixture.points())
      const shot = await page.screenshot({ path: path.join(out, `${style}-${before ? 'before' : 'after'}-${scale}.png`) })
      const pixels = await page.evaluate(async ({ encoded, points }) => {
        const picture = new Image()
        picture.src = `data:image/png;base64,${encoded}`
        await picture.decode()
        const canvas = document.createElement('canvas')
        canvas.width = picture.width; canvas.height = picture.height
        const ctx = canvas.getContext('2d'); ctx.drawImage(picture, 0, 0)
        const profile = (point, horizontal) => Array.from({ length: 7 }, (_, i) => {
          const x = Math.floor(point.x) + (horizontal ? 0 : i - 3), y = Math.floor(point.y) + (horizontal ? i - 3 : 0)
          return [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3)
        })
        const minimum = [255, 255, 255]
        const region = ctx.getImageData(Math.ceil(points.hierarchyStart.x), Math.ceil(points.hierarchyStart.y),
          Math.floor(points.hierarchyEnd.x - points.hierarchyStart.x), Math.floor(points.hierarchyEnd.y - points.hierarchyStart.y)).data
        for (let i = 0; i < region.length; i += 4) for (let channel = 0; channel < 3; channel++) minimum[channel] = Math.min(minimum[channel], region[i + channel])
        const result = { trunk: profile(points.trunk), branch: profile(points.branch), sharedBus: profile(points.sharedBus, true), singleBus: profile(points.singleBus, true), minimum }
        ctx.globalAlpha = 1; ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 1, 1)
        ctx.globalAlpha = .45; ctx.fillStyle = getComputedStyle(graph.container).getPropertyValue('--ink-3'); ctx.fillRect(0, 0, 1, 1)
        result.fullCoverageColor = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3)
        return result
      }, { encoded: shot.toString('base64'), points })
      const difference = (a, b) => Math.max(...a.flat().map((value, index) => Math.abs(value - b.flat()[index])))
      const trunkDifference = difference(pixels.trunk, pixels.branch), busDifference = difference(pixels.sharedBus, pixels.singleBus)
      const structure = await page.evaluate(() => ({
        hierarchyPaints: graph.svg.querySelectorAll('path.tree-link.link-top').length,
        routes: graph.svg.querySelectorAll('[data-edge-type="hierarchy"]').length,
        curves: [...graph.svg.querySelectorAll('[data-edge-type="hierarchy"]')].map(element => element.getAttribute('d')),
        direct: graph.svg.querySelector('.link-direct').getAttribute('d'),
        directMark: graph.svg.querySelector('.tree-link-marker text').textContent,
      }))
      results.push({ style, before, scale, trunkDifference, busDifference, pixels, structure })
      if (before) {
        assert.ok(trunkDifference > 10 && busDifference > 5, 'the reviewed baseline reproduces darker shared trunks and buses')
      } else {
        assert.ok(trunkDifference <= 1 && busDifference <= 1,
          `shared and single strokes have the same raster color at ${style}/${scale}: ${JSON.stringify({ trunkDifference, busDifference, pixels })}`)
        assert.ok(pixels.minimum.every((value, channel) => value >= pixels.fullCoverageColor[channel] - 1),
          `rounded junctions never accumulate darker ink at ${style}/${scale}: ${JSON.stringify(pixels)}`)
        assert.equal(structure.hierarchyPaints, 1)
        assert.equal(structure.routes, 5)
        assert.ok(structure.curves.some(route => route.includes(' Q ')))
      }
      assert.equal(structure.direct, style === 'boxes' ? 'M 460 50 L 490 50' : 'M 320 50 L 630 50', 'the straight direct link is unchanged')
      assert.equal(structure.directMark, '›')
    }
  }
  assert.deepEqual(errors, [])
  const sourceAfter = sourceState()
  const sourceChangedDuringRun = JSON.stringify(sourceAfter) !== JSON.stringify(sourceBefore)
  writeFileSync(path.join(out, 'measurements.json'), JSON.stringify({ baselineRef, sourceBefore, sourceAfter, sourceChangedDuringRun, results, errors }, null, 2))
  console.log(JSON.stringify({ out, passed: true, sourceChangedDuringRun,
    results: results.map(({ style, before, scale, trunkDifference, busDifference }) => ({ style, before, scale, trunkDifference, busDifference })) }))
} catch (error) {
  writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: error.message, results, errors }, null, 2))
  console.error(`Evidence: ${out}`)
  throw error
} finally { await browser?.close(); await server.close() }
