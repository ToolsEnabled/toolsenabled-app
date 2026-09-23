// Isolated source-renderer regression. No installed app/profile is opened.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node tools/test/fixtures/run-tree-zoom-responsive.mjs
// Add --baseline <git-revision> to run the same assertions against prior layout source.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const out = mkdtempSync(path.join(tmpdir(), 'tree-zoom-responsive-'))
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
const baselineArg = process.argv.includes('--baseline') ? process.argv[process.argv.indexOf('--baseline') + 1] : null
const baseline = baselineArg ? git('rev-parse', '--verify', `${baselineArg}^{commit}`).trim() : null
const sourceState = () => ({
  revision: git('rev-parse', 'HEAD').trim(),
  status: git('status', '--porcelain=v1', '--untracked-files=all'),
  diff: git('diff', '--no-ext-diff', '--binary', 'HEAD', '--'),
  baseline,
})
const sourceBefore = sourceState()
writeFileSync(path.join(out, 'source-before.json'), JSON.stringify(sourceBefore, null, 2))
writeFileSync(path.join(out, 'source.diff'), sourceBefore.diff)
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const server = await createServer({
  root, configFile: false, cacheDir: path.join(out, 'vite-cache'), logLevel: 'error',
  plugins: baseline ? [{
    name: 'prior-responsive-layout', enforce: 'pre',
    load(id) {
      for (const relative of ['src/tree-graph.css', 'src/views/computers.js']) {
        if (id === path.join(root, relative)) {
          return execFileSync('git', ['show', `${baseline}:${relative}`], { cwd: root, encoding: 'utf8' })
        }
      }
    },
  }] : [],
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null, fs: { allow: [root, realpathSync(path.join(root, 'node_modules'))] } },
})
let browser
const results = []
try {
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true })
  for (const size of [0.9, 1, 1.12]) {
    const page = await browser.newPage({ viewport: { width: 1024, height: 900 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
    await page.addInitScript(textSize => {
      localStorage.setItem('mc.comp-body.rail-w', '900')
      localStorage.setItem('mc.text', String(textSize))
    }, size)
    await page.goto(`${origin}/#/computers`)
    await page.locator('.gz-in').waitFor()
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(900)
    // Resize the same page: this also tests that the saved preference survives
    // the side-by-side/stacked boundary and returns when space is available.
    for (const step of [1024, 1440, 1920, 800, 1024, { width: 800, reload: true }, 1920]) {
      const width = typeof step === 'number' ? step : step.width
      await page.setViewportSize({ width, height: 900 })
      if (step.reload) {
        await page.reload()
        await page.locator('.gz-in').waitFor()
        await page.evaluate(() => document.fonts.ready)
        await page.waitForTimeout(900)
      }
      await page.waitForTimeout(200)
      const geometry = await page.evaluate(() => {
        const pane = document.querySelector('.graph-wrap').getBoundingClientRect()
        const rail = document.querySelector('.rail').getBoundingClientRect()
        const controls = ['.gz-out', '.graph-fit', '.gz-in'].map(selector => {
          const button = document.querySelector(selector), r = button.getBoundingClientRect()
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
          return { selector, rect: r.toJSON(), hittable: button === hit || button.contains(hit) }
        })
        return { pane: pane.toJSON(), rail: rail.toJSON(), controls, saved: localStorage.getItem('mc.comp-body.rail-w') }
      })
      results.push({ width, size, ...geometry })
      writeFileSync(path.join(out, 'measurements.json'), JSON.stringify(results, null, 2))
      await page.screenshot({ path: path.join(out, `width-${width}-text-${size}.png`) })
      for (const control of geometry.controls) {
        assert.ok(control.rect.left >= geometry.pane.left && control.rect.right <= geometry.pane.right,
          `${width}/${size}: ${control.selector} clipped by graph pane`)
        assert.ok(control.hittable, `${width}/${size}: ${control.selector} center must receive native pointer input`)
      }
      assert.equal(geometry.saved, '900', 'responsive cap must preserve the requested width')
      if (width === 1920 && size <= 1) assert.ok(Math.abs(geometry.rail.width / size - 900) <= 1, 'wide window restores preferred rail')
      const scale = () => page.locator('.static-tree-graph').evaluate(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).a)
      const settleZoom = () => page.waitForFunction(() => !window.__mcGraph._zoomFrame && !window.__mcGraph._cameraFrame)
      await page.locator('.graph-fit').click()
      const fitted = await scale()
      await page.locator('.gz-in').click()
      await settleZoom()
      assert.ok(Math.abs(await scale() - fitted * 1.2) < 0.0001, 'mouse plus must zoom')
      await page.locator('.gz-out').click()
      await settleZoom()
      assert.ok(Math.abs(await scale() - fitted) < 0.0001, 'mouse minus must undo the step')
      await page.locator('.gz-in').click()
      await page.locator('.graph-fit').click()
      assert.ok(Math.abs(await scale() - fitted) < 0.0001, 'mouse overview must restore fitted scale')
    }
    const beforeWide = await page.locator('.graph-wrap').evaluate(el => el.getBoundingClientRect().width)
    await page.locator('.tree-wide-toggle').click()
    assert.ok(await page.locator('.graph-wrap').evaluate(el => el.getBoundingClientRect().width) > beforeWide + 100,
      'expanding the tree must recover the details pane width')
    assert.equal(await page.locator('.rail').isVisible(), false)
    await page.locator('.node[data-agent-id]').first().press('Shift+Enter')
    assert.equal(await page.locator('.rail').isVisible(), true, 'opening agent controls restores details without remounting the tree')
    assert.equal(await page.locator('.tree-wide-toggle').getAttribute('aria-pressed'), 'false')
    assert.deepEqual(errors, [])
    await page.close()
  }
  const sourceAfter = sourceState()
  writeFileSync(path.join(out, 'source-after.json'), JSON.stringify(sourceAfter, null, 2))
  assert.deepEqual(sourceAfter, sourceBefore, 'source revision or working tree changed during verification')
  writeFileSync(path.join(out, 'result.json'), JSON.stringify({ verdict: 'PASS', cases: results.length, browser: browser.version(), platform: process.platform, revision: sourceBefore.revision, clean: sourceBefore.status === '', baseline }))
  console.log(`PASS ${results.length} responsive zoom cases: ${out}`)
} catch (error) {
  writeFileSync(path.join(out, 'source-after.json'), JSON.stringify(sourceState(), null, 2))
  writeFileSync(path.join(out, 'result.json'), JSON.stringify({ verdict: 'FAIL', message: error.message }))
  console.error(`FAIL evidence: ${out}`)
  throw error
} finally {
  await browser?.close()
  await server.close()
}
