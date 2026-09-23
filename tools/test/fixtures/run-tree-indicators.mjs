import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const requested = process.env.TREE_INDICATOR_EVIDENCE
const out = requested && !existsSync(requested) ? requested : mkdtempSync(requested ? `${requested}-` : path.join(tmpdir(), 'tree-indicators-'))
mkdirSync(out, { recursive: true })
const sources = ['src/tree-graph.js', 'src/tree-graph.css', 'src/tree-workspace.css', 'src/tree-windows.js', 'src/lane-marks.js', 'src/agent-screen-voice-controls.css', 'tools/test/fixtures/tree-interactions.mjs']
const hashes = () => Object.fromEntries(sources.map(name => [name, createHash('sha256').update(readFileSync(path.join(root, name))).digest('hex')]))
const before = hashes(), results = [], errors = []
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const server = await createServer({ root, configFile: false, cacheDir: path.join(out, 'vite-cache'), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null, fs: { allow: [root, realpathSync(path.join(root, 'node_modules'))] } } })
let browser
try {
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true })
  for (const style of ['boxes', 'circles']) {
    const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, reducedMotion: 'reduce' })
    const page = await context.newPage()
    page.on('pageerror', error => errors.push({ style, message: error.message }))
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
    await page.goto(`${origin}/tools/test/fixtures/tree-interactions.html?style=${style}&contacts=1&fleet=progressive`)
    await page.waitForFunction(() => window.graph?.treeWindows)
    await page.evaluate(() => document.fonts.ready)
    await page.evaluate(() => graph.treeWindows.choose(graph.treeWindows.windows[0], 'alpha'))
    const setLane = value => page.evaluate(value => {
      fixture.nodes[0].cloudLane = value
      graph.refresh()
    }, value)
    const marks = () => page.evaluate(() => {
      const record = graph.nodes.get('alpha'), box = record.el.querySelector('.node-lane-box'), light = record.el.querySelector('.node-drift-light')
      return { burn: box?.dataset.burn || null, stage: light?.dataset.stage || null,
        box: box?.title || null, light: light?.title || null,
        accessible: [box, light].filter(Boolean).every(mark => mark.getAttribute('role') === 'img' && mark.getAttribute('aria-label') === mark.title && !mark.hasAttribute('aria-hidden')),
        wrapper: !!record.el.querySelector('.tree-box-lane-marks'), stateClass: record.el.classList.contains('has-lane-marks') }
    })
    assert.equal((await marks()).box, null, 'missing cloud telemetry never fabricates a swarm')
    for (const [tokens, hue] of [[0, 'blue'], [999999, 'blue'], [1000000, 'green'], [4999999, 'green'], [5000000, 'gold'], [9999999, 'gold'], [10000000, 'red']]) {
      await setLane({ running: true, tokens, drift: 'drifting' })
      const value = await marks()
      assert.equal(value.burn, hue)
      assert.equal(value.stage, 'gold')
      assert.ok(value.accessible)
      assert.ok(value.box.includes(`${tokens.toLocaleString('en-US')} tokens`))
    }
    await setLane({ running: true, tokens: 111, drift: 'off-course' })
    await page.evaluate(() => window.savedSwarmElement = graph.nodes.get('alpha').el.querySelector('.node-lane-box'))
    await setLane({ running: true, tokens: 222, drift: 'off-course' })
    assert.ok((await marks()).box.includes('222 tokens'), 'same-hue token updates refresh the tooltip')
    assert.equal(await page.evaluate(() => savedSwarmElement === graph.nodes.get('alpha').el.querySelector('.node-lane-box')), true, 'usage ticks preserve the icon and its sweep phase')
    assert.equal((await marks()).stage, 'red')
    await setLane({ running: true })
    assert.equal((await marks()).burn, null)
    assert.ok((await marks()).box.includes('token use not reported'))
    assert.equal((await marks()).light, null)
    await setLane({ running: false, drift: 'off-course' })
    assert.equal((await marks()).box, null)
    assert.equal((await marks()).stage, 'red')
    await page.evaluate(() => {
      window.laneGetterReads = 0
      fixture.nodes[0].cloudLane = { get running() { laneGetterReads++; return true }, get tokens() { laneGetterReads++; return 10000000 }, get drift() { laneGetterReads++; return 'off-course' } }
      graph.refresh()
    })
    assert.equal(await page.evaluate(() => laneGetterReads), 0, 'untrusted telemetry getters are not evaluated')
    assert.deepEqual(await marks(), { burn: null, stage: null, box: null, light: null, accessible: true, wrapper: false, stateClass: false })
    await setLane({ running: true, tokens: 6200000, drift: 'drifting' })
    await page.evaluate(() => graph.treeWindows.add('alpha'))
    await page.waitForTimeout(250)
    await page.evaluate(() => graph.setContactMarks({ voiceNodeId: 'alpha', voiceState: 'listening', screenNodeIds: ['alpha'] }))
    for (const pane of [0, 1]) {
      const mic = page.locator('.tree-window').nth(pane).locator('.node[data-agent-id="alpha"] .node-contact-icon')
      const beforeClick = await page.evaluate(() => ({ root: graph.rootId, chats: graph.workspace.records().filter(record => record.chatOpen).length }))
      await mic.click()
      assert.equal(await mic.getAttribute('data-voice-state'), 'listening')
      assert.equal(await mic.getAttribute('aria-pressed'), 'true')
      assert.equal(await mic.getAttribute('data-screen-access'), 'true')
      assert.deepEqual(await page.evaluate(() => ({ root: graph.rootId, chats: graph.workspace.records().filter(record => record.chatOpen).length })), beforeClick)
    }
    assert.deepEqual(await page.evaluate(() => fixture.contacts), ['alpha', 'alpha'])
    const groupsShown = await page.locator('.tree-scope-group').count()
    if (style === 'boxes') assert.ok(groupsShown > 0, 'voice exclusion is checked against actual synthetic groups')
    assert.equal(await page.locator('.tree-scope-group .node-contact-icon').count(), 0, 'synthetic groups cannot be voice contacts')
    const beforeBadge = await page.evaluate(() => ({ root: graph.rootId, chats: graph.workspace.records().filter(record => record.chatOpen).length }))
    await page.locator('.tree-window').first().locator('.node[data-agent-id="alpha"] .node-drift-light').click()
    assert.deepEqual(await page.evaluate(() => ({ root: graph.rootId, chats: graph.workspace.records().filter(record => record.chatOpen).length })), beforeBadge, 'status badges do not issue a chat or drill action')
    await page.evaluate(() => graph.setNodeStyle(graph.nodeStyle === 'boxes' ? 'circles' : 'boxes'))
    await page.evaluate(style => graph.setNodeStyle(style), style)
    assert.equal((await marks()).burn, 'gold', 'shape changes preserve explicit lane telemetry')
    assert.equal(await page.locator('.tree-window').nth(1).locator('.node[data-agent-id="alpha"] .node-contact-icon').getAttribute('data-voice-state'), 'listening')
    await page.evaluate(() => graph.treeWindows.close(graph.treeWindows.windows[1]))
    const contrasts = []
    for (const theme of ['white', 'tan', 'black']) for (const tokens of [0, 1000000, 5000000, 10000000]) {
      await setLane({ running: true, tokens, drift: tokens < 10000000 ? 'drifting' : 'off-course' })
      const contrast = await page.evaluate(theme => {
        document.documentElement.dataset.theme = theme
        const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
        const luminance = css => {
          context.fillStyle = css; context.fillRect(0, 0, 1, 1)
          const channels = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => {
            const srgb = value / 255; return srgb <= .04045 ? srgb / 12.92 : ((srgb + .055) / 1.055) ** 2.4
          })
          return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722
        }
        return [...graph.nodes.get('alpha').el.querySelectorAll('.node-lane-box,.node-drift-light')].map(mark => {
          const css = getComputedStyle(mark), foreground = luminance(css.color), background = luminance(css.backgroundColor)
          return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05)
        })
      }, theme)
      assert.ok(contrast.every(value => value >= 3), `${theme}/${tokens}: status glyph contrast must reach 3:1 (${contrast})`)
      contrasts.push({ theme, tokens, contrast })
    }
    await setLane({ running: true, tokens: 6200000, drift: 'drifting' })
    const layouts = []
    for (const size of ['mini', 'small', 'medium', 'large']) for (const zoom of [.72, 1]) {
      await page.evaluate(({ size, zoom }) => { graph.setCardSize(size); graph.zoom = zoom; graph._applyZoom() }, { size, zoom })
      await page.waitForTimeout(40)
      const layout = await page.evaluate(() => {
        const node = graph.nodes.get('alpha').el, glass = node.querySelector('.node-glass'), row = node.querySelector('.tree-box-status-row')
        const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height } }
        const indicators = [...node.querySelectorAll('.node-lane-box,.node-drift-light')]
        return { size: graph.cardSize, zoom: graph.zoom, box: rect(glass), row: row && rect(row), marks: indicators.map(rect),
          branch: row && rect(row.querySelector('.tree-box-branch')),
          runtimeHidden: !row || getComputedStyle(row.querySelector('.node-runtime')).display === 'none',
          parents: indicators.map(mark => mark.parentElement.className),
          sweep: getComputedStyle(node.querySelector('.lb i')).animationName,
          drift: getComputedStyle(node.querySelector('.node-drift-light')).animationName }
      })
      assert.equal(layout.sweep, 'none'); assert.equal(layout.drift, 'none')
      if (style === 'boxes') {
        assert.equal(layout.runtimeHidden, true)
        for (const mark of layout.marks) {
          assert.ok(mark.y >= layout.row.y - 1 && mark.bottom <= layout.row.bottom + 1, `${size}/${zoom}: indicators stay inside status row`)
          assert.ok(mark.x >= layout.box.x && mark.right <= layout.box.right)
          assert.ok(mark.right <= layout.branch.x + 1, `${size}/${zoom}: branch action remains separate`)
        }
        assert.ok(layout.parents.every(name => name === 'tree-box-lane-marks'))
      } else {
        assert.ok(layout.marks[1].bottom <= layout.marks[0].y, 'circle drift stays above swarm')
        assert.ok(layout.parents.every(name => name === 'node-glass'))
      }
      layouts.push(layout)
    }
    await page.screenshot({ path: path.join(out, `${style}.png`) })
    await setLane(null)
    assert.equal((await marks()).stateClass, false)
    await page.evaluate(() => graph.destroy())
    assert.equal(await page.locator('.node-lane-box,.node-drift-light,.node-contact-icon').count(), 0, 'teardown removes all node overlays')
    results.push({ style, passed: true, groupsShown, layouts, contrasts })
    await context.close()
  }
  assert.deepEqual(errors, [])
} catch (error) {
  errors.push({ message: error.message, stack: error.stack })
  process.exitCode = 1
} finally {
  const after = hashes()
  writeFileSync(path.join(out, 'evidence.json'), JSON.stringify({ results, errors, before, after, sourceChangedDuringRun: JSON.stringify(before) !== JSON.stringify(after) }, null, 2))
  await browser?.close()
  await server.close()
  console.log(JSON.stringify({ out, cases: results.length, errors }))
}
