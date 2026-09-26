import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { TREE_CONTEXT_SIZES } from '../../../src/tree-box-layout.js'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const requested = process.env.TREE_TYPOGRAPHY_EVIDENCE
const out = requested && !existsSync(requested) ? requested : mkdtempSync(requested ? `${requested}-` : path.join(tmpdir(), 'tree-typography-'))
mkdirSync(out, { recursive: true })
const sources = ['src/tree-graph.js', 'src/tree-workspace.js', 'src/tree-windows.js', 'src/tree-toolbar.js',
  'src/tree-workspace.css', 'src/tree-card-density.css', 'src/tree-box-layout.js', 'src/tree-readability.js',
  'src/tree-scope.js', 'src/tree-graph.css', 'tools/test/fixtures/tree-box-workspace.html',
  'tools/test/fixtures/tree-box-workspace.mjs', 'tools/test/fixtures/run-tree-card-typography.mjs']
const hashes = () => Object.fromEntries(sources.map(name => [name, createHash('sha256').update(readFileSync(path.join(root, name))).digest('hex')]))
const sourceBefore = hashes()
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const server = await createServer({ root, configFile: false, cacheDir: path.join(out, 'vite-cache'), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null, fs: { allow: [root, realpathSync(path.join(root, 'node_modules'))] } } })
let browser, page
const errors = [], results = []
try {
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1500, height: 900 }, reducedMotion: 'reduce' })
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  await page.goto(`${origin}/tools/test/fixtures/tree-box-workspace.html`)
  await page.waitForFunction(() => window.fixture?.metrics)
  await page.evaluate(() => document.fonts.ready)
  await page.evaluate(() => document.documentElement.dataset.theme = 'white')
  const setContext = async kind => page.evaluate(kind => {
    // Explicit synthetic context stresses every card field without a provider,
    // native profile or session. The production renderer/layout remain intact.
    graph.contextFeed = agent => ({ current: 'Reviewing the implementation and checking the latest evidence',
      task: 'Inspect the full implementation, verify behavior with meaningful tests, and report the exact remaining work so the next agent can continue without losing context.',
      tool: kind === 'taskOnly' ? '' : 'Read src/tree-workspace.js and compare the latest viewport and conversation changes with the saved implementation.',
      chat: kind === 'taskOnly' ? '' : `${agent.name}: The current implementation preserves saved tree selections, camera positions, and independent conversation drafts. I am now checking the remaining layout cases and collecting evidence.` })
    graph._reconcile()
  }, kind)
  const measureCards = () => page.evaluate(() => {
    const rect = element => {
      const r = element.getBoundingClientRect()
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
    }
    const visible = element => !!element && element.checkVisibility({ checkVisibilityCSS: true })
    const host = rect(graph.zoomHost)
    return { zoom: graph.zoom, textScale: Number(graph.container.style.getPropertyValue('--tree-box-text-scale')), host, pageWidth: document.documentElement.scrollWidth,
      cards: [...graph.nodes.values()].filter(record => graph._layoutVisibleIds.has(record.id) && visible(record.el)).map(record => {
        const node = record.el, context = node.querySelector('.tree-box-context'), heading = node.querySelector('.tree-box-heading')
        const glass = getComputedStyle(node.querySelector('.node-glass'))
        const rows = [...node.querySelector('.node-glass').children].filter(visible)
        const texts = [...context.querySelectorAll('p')].filter(visible).map(p => ({ ...rect(p), text: p.textContent, font: parseFloat(getComputedStyle(p).fontSize),
          line: parseFloat(getComputedStyle(p).lineHeight), heightUnscaled: p.getBoundingClientRect().height / graph.zoom,
          clamp: Number(getComputedStyle(p).webkitLineClamp), detail: !!p.closest('.tree-box-detail') }))
        const meta = [...node.querySelectorAll('.node-role,.tree-box-status,.tree-box-branch,.rt,.tree-box-context-label,.tree-context-caption,.tree-box-open-hint,.tree-box-add-agent')]
          .filter(visible).map(p => ({ selector: p.className, font: parseFloat(getComputedStyle(p).fontSize) }))
        return { id: record.id, group: !!record.agent.treeScope?.group,
          members: graph._scopeModel().groups.get(record.id)?.memberIds.length || 0,
          frame: { top: parseFloat(glass.borderTopWidth), side: parseFloat(glass.borderLeftWidth), borderStyle: glass.borderTopStyle, sideStyle: glass.borderLeftStyle, shadow: glass.boxShadow },
          rect: rect(node), physical: [node.offsetWidth, node.offsetHeight], context: rect(context),
          rows: rows.map(rect), heading: rect(heading), labels: rect(node.querySelector('.node-labels')),
          chat: visible(node.querySelector('.tree-box-chat')) ? rect(node.querySelector('.tree-box-chat')) : null,
          nameFont: parseFloat(getComputedStyle(node.querySelector('.node-name')).fontSize), texts, meta }
      }) }
  })
  for (const width of [1280, 1854]) for (const size of ['mini', 'small', 'medium', 'large']) for (const camera of ['fit', .72, .86, 1]) for (const content of size === 'large' ? ['rich', 'taskOnly'] : ['rich']) {
    await setContext(content)
    await page.setViewportSize({ width, height: 1000 })
    await page.locator('.tree-card-size-select').selectOption(size)
    await page.locator('.tree-action-bar .graph-fit').click()
    await page.waitForTimeout(350)
    if (camera !== 'fit') await page.evaluate(zoom => {
      graph._cancelZoomMotion()
      graph.zoom = zoom
      graph._viewSteered = true
      graph._applyZoom()
    }, camera)
    const measurement = await measureCards()
    results.push({ width, size, camera, content, ...measurement })
    assert.ok(measurement.cards.length > 0)
    assert.ok(measurement.pageWidth <= width + 1)
    const dimensions = [TREE_CONTEXT_SIZES[size].box.width, TREE_CONTEXT_SIZES[size].box.height]
    const { host, cards } = measurement
    for (const card of cards) {
      const info = `${width}/${size}/${camera}/${content}/${card.id}`
      assert.deepEqual(card.physical, dimensions, `${info}: typography preserves the chosen dimensions`)
      assert.ok(card.frame.top > card.frame.side && card.frame.side >= 1 && card.frame.sideStyle === 'solid'
        && card.frame.borderStyle === (card.group ? 'double' : 'solid') && card.frame.shadow !== 'none',
        `${info}: the rendered card retains its strong cap and frame despite shared graph CSS`)
      assert.ok(Math.abs(card.nameFont - (size === 'mini' ? 15 : 18) * measurement.textScale) < .01, `${info}: the name compensates for overview zoom`)
      assert.ok(card.meta.every(text => text.font >= 12 * measurement.textScale - .01), `${info}: supporting text compensates for overview zoom`)
      if (camera === 'fit') assert.ok(card.rect.x >= host.x - 1 && card.rect.right <= host.right + 1 && card.rect.y >= host.y - 1 && card.rect.bottom <= host.bottom + 1,
        `${info}: Fit keeps every shown card in the viewport`)
      assert.ok(card.labels.y >= card.heading.y - 1 && card.labels.bottom <= card.heading.bottom + 1, `${info}: name and role fit the header`)
      if (card.chat) assert.ok(card.labels.right <= card.chat.x + 1, `${info}: labels do not collide with the chat button`)
      card.rows.forEach((row, index) => {
        if (index) assert.ok(row.y >= card.rows[index - 1].bottom - 1, `${info}: card rows do not overlap`)
      })
      for (const text of card.texts) {
        assert.ok(text.font >= (size === 'mini' ? 14 : 15), `${info}: context uses the larger font`)
        if (camera !== 'fit') assert.ok(text.font * measurement.zoom >= (size === 'mini' ? 12.6 : 13.5) - .01,
          `${info}: overview context stays legible at screen scale`)
        assert.ok(text.bottom <= card.context.bottom + 1, `${info}: visible text fits without a clipped final line`)
        const lines = text.heightUnscaled / text.line
        assert.ok(Math.abs(lines - Math.round(lines)) < .03 && lines >= .98 && lines <= text.clamp + .03,
          `${info}: context shows complete lines: ${JSON.stringify(text)}`)
      }
    }
    for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
      const a = cards[i].rect, b = cards[j].rect
      assert.ok(a.right <= b.x + 1 || b.right <= a.x + 1 || a.bottom <= b.y + 1 || b.bottom <= a.y + 1,
        `${width}/${size}: cards do not overlap`)
    }
    if (content === 'taskOnly') assert.ok(cards.some(card => card.texts.some(text => text.text.startsWith('Inspect the full implementation'))), 'a task-only draft keeps its brief as the actual context')
    await page.screenshot({ path: path.join(out, `cards-${width}-${size}-${camera}-${content}.png`) })
    if (width === 1854 && (camera === 'fit' || camera === .72)) {
      await page.evaluate(() => document.documentElement.dataset.theme = 'black')
      assert.match(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), /dark/, 'dark screenshots use an actual supported dark theme')
      await page.screenshot({ path: path.join(out, `cards-${width}-${size}-${camera}-${content}-dark.png`) })
      await page.evaluate(() => document.documentElement.dataset.theme = 'white')
    }
  }
  // Open a real broad branch so Large group cards, including their fifth
  // "+ more" line, are exercised rather than only summary roots.
  await page.evaluate(() => {
    for (let index = 0; index < 12; index++) {
      const agent = { id: `group-list-worker-${index}`, parentId: 'manager', role: 'worker', declaredRole: 'worker',
        name: `Additional worker ${index + 1}`, treeNode: { id: `group-list-worker-${index}`, treeId: 'build-tree' }, state: 'idle' }
      fixture.nodes.push(agent); fixture.queues.set(agent.id, [])
    }
    graph.refresh()
  })
  await setContext('rich')
  await page.setViewportSize({ width: 1280, height: 1000 })
  await page.locator('.tree-card-size-select').selectOption('large')
  await page.evaluate(() => graph.setRoot('manager'))
  await page.locator('.tree-action-bar .graph-fit').click()
  await page.waitForTimeout(350)
  for (const zoom of [.72, 1]) {
    await page.evaluate(zoom => { graph._cancelZoomMotion(); graph.zoom = zoom; graph._applyZoom() }, zoom)
    const measurement = await measureCards(), groups = measurement.cards.filter(card => card.group)
    results.push({ size: 'large', camera: zoom, content: 'groupMembers', ...measurement })
    assert.ok(groups.some(card => card.members > 4), 'the large-card proof includes a real group with a fifth summary line')
    for (const card of groups) {
      assert.equal(card.texts.length, 1)
      const text = card.texts[0], lines = text.heightUnscaled / text.line
      assert.equal(text.clamp, 5)
      assert.ok(text.bottom <= card.context.bottom + 1 && Math.abs(lines - Math.round(lines)) < .03,
        `group member list has no clipped final line at ${zoom}: ${JSON.stringify(card)}`)
      assert.ok(card.labels.bottom <= card.heading.bottom + 1, 'group titles fit their header')
    }
    await page.screenshot({ path: path.join(out, `large-group-members-${zoom}.png`) })
  }
  await page.locator('.tree-action-bar .graph-fit').click()
  await page.waitForTimeout(200)
  const groupNode = page.locator('.tree-scope-group.tree-agent-box:not([hidden])').first()
  await groupNode.hover()
  const paint = () => groupNode.locator('.node-glass').evaluate(node => {
    const style = getComputedStyle(node)
    return { top: parseFloat(style.borderTopWidth), side: parseFloat(style.borderLeftWidth), borderStyle: style.borderTopStyle, sideStyle: style.borderLeftStyle, shadow: style.boxShadow }
  })
  const hovered = await paint()
  await groupNode.evaluate(node => node.classList.add('selected'))
  const selected = await paint()
  for (const [state, frame] of [['hover', hovered], ['selected', selected]]) assert.ok(frame.top > frame.side && frame.side >= 1 && frame.sideStyle === 'solid' && frame.borderStyle === 'double' && frame.shadow !== 'none',
    `the card cap and solid frame survive the ${state} cascade: ${JSON.stringify(frame)}`)
  results.push({ content: 'computed hover and selected frame', hovered, selected })
  assert.deepEqual(errors, [])
  const sourceAfter = hashes(), sourceChangedDuringRun = JSON.stringify(sourceBefore) !== JSON.stringify(sourceAfter)
  writeFileSync(path.join(out, 'evidence.json'), JSON.stringify({ passed: true, sourceChangedDuringRun, sourceBefore, sourceAfter, results, errors }, null, 2))
  console.log(JSON.stringify({ passed: true, out, sourceChangedDuringRun, cases: results.length, errors }))
} catch (error) {
  await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {})
  writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: error.message, results, errors }, null, 2))
  console.error(`Evidence: ${out}`)
  throw error
} finally { await browser?.close(); await server.close() }
