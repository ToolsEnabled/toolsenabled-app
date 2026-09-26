import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const requested = process.env.TREE_LINK_POPOVER_EVIDENCE
const out = requested && !existsSync(requested) ? requested : mkdtempSync(requested ? `${requested}-` : path.join(tmpdir(), 'tree-link-popover-'))
mkdirSync(out, { recursive: true })
const sources = ['src/tree-graph.js', 'src/tree-graph.css', 'src/tree-workspace.css', 'src/tree-windows.js',
  'src/tree-workspace.js', 'src/text-size.js', 'tools/test/fixtures/tree-box-workspace.html',
  'tools/test/fixtures/tree-box-workspace.mjs', 'tools/test/fixtures/run-tree-link-popover.mjs']
const hashes = () => Object.fromEntries(sources.map(file => [file, createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')]))
const sourceBefore = hashes()
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const server = await createServer({ root, configFile: false, cacheDir: path.join(out, 'vite-cache'), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null, fs: { allow: [root, realpathSync(path.join(root, 'node_modules'))] } } })
let browser, page
const errors = [], results = []
const firstName = 'Reviewer — independent verification of the agent workspace, navigation and conversation changes'
const secondName = 'Researcher — source evidence, implementation notes and follow-up questions for the next review'
try {
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true })
  for (const style of ['boxes', 'circles']) {
    page = await browser.newPage({ viewport: { width: 1500, height: 900 }, reducedMotion: 'reduce' })
    page.setDefaultTimeout(8000)
    page.on('pageerror', error => errors.push({ style, message: error.message }))
    await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
    await page.goto(`${origin}/tools/test/fixtures/tree-box-workspace.html?style=${style}`)
    await page.waitForFunction(() => !!window.fixture?.metrics)
    await page.evaluate(() => document.fonts.ready)
    await page.evaluate(({ firstName, secondName }) => {
      fixture.nodes.find(agent => agent.id === 'reviewer').name = firstName
      fixture.nodes.find(agent => agent.id === 'researcher').name = secondName
      graph.refresh()
      graph.treeWindows.choose(graph.treeWindows.windows[0], ['reviewer', 'researcher'])
      fixture.links = [{ from: 'reviewer', to: 'researcher' }]
      graph.setCommunicationLinks(fixture.links)
    }, { firstName, secondName })
    // Select the actual settled marker, after the initial resize has adopted
    // the fixture's two-tree canvas and loaded font metrics.
    await page.waitForTimeout(200)
    await page.waitForFunction(() => !graph._animationRaf && !graph._cameraFrame && !graph._zoomFrame)
    const popup = page.locator('.tree-link-popover')
    const marker = () => page.locator('.tree-link-marker').first()
    const open = async () => {
      await marker().focus()
      await marker().press('Enter')
      await popup.waitFor()
      assert.equal(await popup.evaluate(node => node.matches(':popover-open')), true)
      assert.equal(await popup.locator('.link-open-first').evaluate(node => node === document.activeElement), true)
    }
    const checkBounds = async () => {
      const geometry = await popup.evaluate(node => {
        const r = node.getBoundingClientRect()
        return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width,
          viewport: [innerWidth, innerHeight], radius: getComputedStyle(node).borderRadius }
      })
      assert.ok(geometry.x >= -.5 && geometry.y >= -.5 && geometry.right <= geometry.viewport[0] + .5
        && geometry.bottom <= geometry.viewport[1] + .5, `popover stays in the viewport: ${JSON.stringify(geometry)}`)
      assert.ok(parseFloat(geometry.radius) <= 3, 'popover corners match the angular app chrome')
      for (const selector of ['.link-dismiss', '.link-open-first', '.link-open-second', '.link-remove']) {
        const button = popup.locator(selector)
        await button.scrollIntoViewIfNeeded()
        assert.ok(await button.evaluate(node => {
          const r = node.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
          return hit === node || node.contains(hit)
        }), `${selector} remains reachable within the popover`)
      }
      return geometry
    }
    await open()
    assert.deepEqual(await popup.locator('.link-agent-name').allTextContents(), [firstName, secondName])
    assert.match(await popup.locator('.link-open-first').getAttribute('aria-label'), /Chat with Reviewer/)
    await popup.locator('.link-dismiss').focus()
    await page.keyboard.press('Shift+Tab')
    assert.equal(await popup.locator('.link-remove').evaluate(node => node === document.activeElement), true)
    await page.keyboard.press('Tab')
    assert.equal(await popup.locator('.link-dismiss').evaluate(node => node === document.activeElement), true)
    await page.keyboard.press('Escape')
    assert.equal(await popup.count(), 0)
    assert.equal(await marker().evaluate(node => node === document.activeElement), true, 'Escape returns focus to the link marker')

    for (const [width, height, textSize, theme] of [[1500, 900, 1, 'white'], [360, 640, 1, 'white'], [360, 640, 1.12, 'black'], [1280, 480, 1.12, 'black']]) {
      await page.setViewportSize({ width, height })
      await page.evaluate(async ({ textSize, theme }) => {
        const { applyTextSize } = await import('/src/text-size.js')
        applyTextSize(textSize)
        document.documentElement.dataset.theme = theme
      }, { textSize, theme })
      await page.waitForTimeout(200)
      await open()
      const geometry = await checkBounds()
      assert.ok(await popup.locator('.link-peer-list').evaluate(node => node.scrollHeight <= node.clientHeight + 1), 'long names use the available space above the link before introducing scrolling')
      await popup.locator('.link-peer-list').evaluate(node => { node.scrollTop = 0 })
      await page.screenshot({ path: path.join(out, `${style}-${width}-${height}-${textSize}-${theme}.png`) })
      results.push({ style, width, height, textSize, theme, geometry })
      await popup.locator('.link-dismiss').click()
      assert.equal(await popup.count(), 0)
    }
    await page.setViewportSize({ width: 1500, height: 900 })
    await page.evaluate(async () => { (await import('/src/text-size.js')).applyTextSize(1) })
    await open()
    await page.setViewportSize({ width: 360, height: 640 })
    await checkBounds()
    await page.locator('.tree-home-tab').click()
    await popup.waitFor({ state: 'detached' })
    assert.equal(await page.locator('.tree-home-tab').evaluate(node => node === document.activeElement), true, 'light-dismiss does not steal focus from the clicked control')
    await page.setViewportSize({ width: 1500, height: 900 })

    for (const [selector, id] of [['.link-open-first', 'reviewer'], ['.link-open-second', 'researcher']]) {
      await open()
      await popup.locator(selector).click()
      assert.equal(await popup.count(), 0)
      assert.equal(await page.evaluate(() => graph.activeChatId), id)
      assert.equal(await page.evaluate(() => graph.workspace.mode), 'chat')
      await page.locator('.tree-home-tab').click()
    }

    await page.evaluate(() => {
      fixture.linkFailure = true
      const save = graph.onLinkChange
      graph.onLinkChange = request => fixture.linkFailure ? Promise.resolve({ ok: false, reason: 'Fixture connection is temporarily unavailable.' }) : save(request)
    })
    await open()
    await popup.locator('.link-remove').click()
    await popup.locator('.link-action-error').waitFor()
    assert.match(await popup.locator('.link-action-error').textContent(), /temporarily unavailable/)
    assert.equal(await popup.locator('.link-remove').isEnabled(), true)
    assert.equal(await page.evaluate(() => graph.communicationLinks.length), 1, 'failed removal keeps the real link intact')
    await page.evaluate(() => { fixture.linkFailure = false })
    await popup.locator('.link-remove').click()
    await popup.waitFor({ state: 'detached' })
    assert.deepEqual(await page.evaluate(() => fixture.linkRequests.at(-1)), { from: 'reviewer', to: 'researcher', connected: false })
    assert.equal(await page.evaluate(() => graph.communicationLinks.length), 0)
    assert.equal(await page.locator('.tree-link-marker').count(), 0)

    // Secondary renderers share the primary mutation callback. A link shown
    // inside the inspected pane must remove through that same owner.
    await page.evaluate(() => {
      fixture.links = [{ from: 'reviewer', to: 'researcher' }]
      graph.setCommunicationLinks(fixture.links)
      graph.treeWindows.add(['reviewer', 'researcher'])
      graph.treeWindows.windows[1].graph._showLinkDetails(fixture.links[0])
    })
    await popup.locator('.link-remove').click()
    await popup.waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => fixture.linkRequests.filter(request => !request.connected).length), 2)
    assert.equal(await page.evaluate(() => graph.communicationLinks.length), 0)

    // A response belongs to the popup that requested it. Once the person
    // dismisses that popup, a delayed error must not pull focus back to it.
    for (const dismissal of ['outside', 'close', 'chat']) {
      await page.evaluate(() => {
        fixture.links = [{ from: 'reviewer', to: 'researcher' }]
        graph.setCommunicationLinks(fixture.links)
        fixture.savedLinkChange = graph.onLinkChange
        graph.onLinkChange = () => new Promise(resolve => {
          fixture.finishPendingLink = () => resolve({ ok: false, reason: 'Delayed fixture failure.' })
        })
      })
      await open()
      await popup.locator('.link-remove').click()
      if (dismissal === 'close') await popup.locator('.link-dismiss').click()
      if (dismissal === 'chat') await popup.locator('.link-open-first').click()
      if (dismissal === 'outside') await page.locator('.tree-home-tab').click()
      await popup.waitFor({ state: 'detached' })
      await page.locator('.tree-home-tab').focus()
      await page.evaluate(() => fixture.finishPendingLink())
      await page.waitForFunction(() => !graph._linkPending)
      assert.equal(await page.locator('.tree-home-tab').evaluate(node => node === document.activeElement), true,
        `${dismissal}: a dismissed popup cannot reclaim focus when removal later fails`)
      assert.equal(await popup.count(), 0)
      assert.equal(await page.evaluate(() => graph.communicationLinks.length), 1)
      await page.evaluate(() => { graph.onLinkChange = fixture.savedLinkChange })
      await page.locator('.tree-home-tab').click()
    }
    await page.evaluate(() => graph.destroy())
    assert.equal(await popup.count(), 0)
    assert.equal(await page.evaluate(() => [...fixture.subscribers.values()].reduce((sum, set) => sum + set.size, 0)), 0)
    results.push({ style, lifecycle: 'keyboard, chats, failure retry, real removal, secondary owner and dismissed-pending focus passed' })
    await page.close()
  }
  assert.deepEqual(errors, [])
  const sourceAfter = hashes(), sourceChangedDuringRun = JSON.stringify(sourceBefore) !== JSON.stringify(sourceAfter)
  writeFileSync(path.join(out, 'evidence.json'), JSON.stringify({ passed: true, sourceChangedDuringRun, sourceBefore, sourceAfter, results, errors }, null, 2))
  console.log(JSON.stringify({ passed: true, out, sourceChangedDuringRun, checks: results.length, errors }))
} catch (error) {
  await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {})
  writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: error.message, results, errors }, null, 2))
  console.error(`Evidence: ${out}`)
  throw error
} finally { await browser?.close(); await server.close() }
