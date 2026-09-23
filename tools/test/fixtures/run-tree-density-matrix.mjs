// Headless-only checks against the real graph and explicitly fictional fleet.
// Reuses the workspace fixture; never opens a native profile or provider session.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { TREE_CONTEXT_SIZES } from '../../../src/tree-box-layout.js'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const out = mkdtempSync(path.join(tmpdir(), 'tree-density-matrix-'))
const sourceState = () => ({
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  files: Object.fromEntries(['src/tree-graph.js', 'src/tree-workspace.js', 'src/tree-windows.js',
    'src/tree-scope.js', 'src/tree-readability.js', 'src/tree-box-layout.js', 'src/tree-graph.css',
    'src/tree-workspace.css', 'src/tree-card-density.css', 'src/tree-preview-fit.js'].map(name =>
    [name, createHash('sha256').update(readFileSync(path.join(root, name))).digest('hex')])),
})
const before = sourceState()
writeFileSync(path.join(out, 'source-before.json'), JSON.stringify(before, null, 2))
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const server = await createServer({ root, configFile: false, cacheDir: path.join(out, 'vite-cache'), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null,
    fs: { allow: [root, realpathSync(path.join(root, 'node_modules'))] } } })
const errors = [], results = [], failures = []
let browser, page, stage = 'load'
const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
  && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
const within = (a, b, tolerance = 2) => a.left >= b.left - tolerance && a.top >= b.top - tolerance
  && a.right <= b.right + tolerance && a.bottom <= b.bottom + tolerance
try {
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1854, height: 1040 } })
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  await page.goto(`${origin}/tools/test/fixtures/tree-box-workspace.html`)
  await page.waitForFunction(() => window.fixture?.metrics && graph.setCardSize && graph.setNodeStyle)
  await page.evaluate(() => document.fonts.ready)
  const settle = async () => {
    await page.waitForFunction(() => graph.treeWindows.windows.every(({ graph: view }) => !view._cameraFrame && !view._zoomFrame && !view._zoomMotion))
    await page.waitForTimeout(400)
  }
  await settle()
  await page.evaluate(() => {
    const elect = graph._electChipSlots.bind(graph)
    graph._electChipSlots = (...args) => {
      const result = elect(...args)
      const [records, dimensions, obstacles, width, height, discs, labels] = args
      fixture.lastElection = { count: result.size, width, height, obstacles, discs, labels,
        records: records.map(record => ({ id: record.id, x: graph.panX + record.x * graph.zoom,
          y: graph.panY + record.y * graph.zoom, size: dimensions.get(record.id),
          candidates: graph._chipCandidates(record, dimensions.get(record.id).width, dimensions.get(record.id).height, width, height) })) }
      return result
    }
    graph.contextFeed = agent => ({ current: 'Reviewing the source',
      task: `Inspect ${agent.name}'s source changes and validate the layout and keyboard controls. Keep the report concise and attach concrete evidence.`,
      tool: 'Read src/tree-graph.js',
      chat: `${agent.name}: The changes pass inspection. The direct links land on each node border, and the chat draft remains intact.` })
    graph.treeWindows.choose(graph.treeWindows.windows[0], ['reviewer', 'researcher'])
    graph.setCommunicationLinks([{ from: 'reviewer', to: 'researcher' }])
    graph.openFullChat('reviewer')
  })
  const chat = page.locator('.tree-conversation[data-agent-id="reviewer"]')
  await chat.locator('.chat-input input').fill('A draft kept across all context sizes and tree styles')
  await chat.locator('[data-chat-attach]').click()
  await page.waitForFunction(() => graph.nodes.get('reviewer').chatRoot.exportDraft().attachments.length === 1)
  await page.evaluate(() => {
    window.retainedChat = graph.nodes.get('reviewer').chatRoot
    window.retainedRecord = graph.nodes.get('reviewer')
    window.retainedDraft = retainedChat.exportDraft()
    window.retainedSubscriptions = fixture.metrics().subscriptions
    graph.workspace.showTrees({ focus: false })
  })
  await settle()

  for (const viewport of [{ width: 1854, height: 1040 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(viewport)
    await settle()
    for (const style of ['boxes', 'circles']) for (const size of Object.keys(TREE_CONTEXT_SIZES)) {
      stage = `${viewport.width} ${style} ${size}`
      await page.evaluate(({ style, size }) => {
        graph.setNodeStyle(style)
        graph.setCardSize(size)
        graph.fitCurrentTree()
      }, { style, size })
      await settle()
      const measured = await page.evaluate(() => {
        const rect = element => {
          const box = element.getBoundingClientRect()
          return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height }
        }
        const view = graph.treeWindows.windows[0].graph
        const uiZoom = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--zoom')) || 1
        const shown = [...view.nodes.values()].filter(record => !record.el.hidden && view._layoutVisibleIds.has(record.id))
        const nodes = shown.map(record => {
          const text = record.el.querySelector('.tree-box-context > p')
          const context = record.el.querySelector('.tree-box-context')
          const detail = [...record.el.querySelectorAll('.tree-box-detail > div')].map(element => ({
            text: element.textContent, rect: rect(element), caption: element.querySelector('.tree-context-caption')?.textContent,
          }))
          return { id: record.id, rect: rect(record.el),
            title: record.el.querySelector('.nn-t')?.textContent,
            text: text?.textContent, textRect: text && rect(text), contextRect: context && rect(context),
            fontSize: text && Number.parseFloat(getComputedStyle(text).fontSize), detail,
            heading: context && rect(record.el.querySelector('.tree-box-heading')),
            status: context && rect(record.el.querySelector('.tree-box-status-row')),
            statusOverflow: context && (record.el.querySelector('.tree-box-status-row').scrollWidth - record.el.querySelector('.tree-box-status-row').clientWidth),
            indicators: [...record.el.querySelectorAll('.tree-box-context-indicator')].map(element => ({ title: element.title, kind: element.dataset.contextKind, rect: rect(element) })),
            addInHeading: !!record.el.querySelector('.tree-box-heading .tree-box-add-agent'),
            footerVisible: context && getComputedStyle(record.el.querySelector('.tree-box-footer')).display !== 'none',
            innerOverflow: record.el.querySelector('.node-glass').scrollHeight - record.el.querySelector('.node-glass').clientHeight,
          }
        })
        const cards = shown.filter(record => view.nodeStyle === 'circles' && record.chip?.classList.contains('screen-chip-visible')).map(record => {
          const activity = record.chip.querySelector('.chip-preview-activity')
          return { id: record.id, rect: rect(record.chip),
            previewRect: rect(record.chip.querySelector('.chip-preview')),
            activityRect: rect(activity), fontSize: Number.parseFloat(getComputedStyle(record.chip.querySelector('.cl-chat .chip-context-text, .cl-previous .chip-context-text')).fontSize),
            rows: [...activity.children].map(element => ({ text: element.textContent, className: element.className,
              display: getComputedStyle(element).display, rect: rect(element) })),
          }
        })
        const links = [...view.svg.querySelectorAll('.link-direct')].map(path => {
          const transform = path.getScreenCTM()
          const point = at => { const p = path.getPointAtLength(at).matrixTransform(transform); return { x: p.x, y: p.y } }
          return { from: path.dataset.from, to: path.dataset.to, d: path.getAttribute('d'),
            start: point(0), end: point(path.getTotalLength()) }
        })
        return { style: view.nodeStyle, size: view.cardSize, zoom: view.zoom, uiZoom, host: rect(view.zoomHost),
          nodes, cards, links, directMark: view.svg.querySelector('.tree-link-marker text')?.textContent,
          emptyCardElection: view.nodeStyle === 'circles' && !cards.length ? fixture.lastElection : undefined,
          chatIdentity: graph.nodes.get('reviewer') === retainedRecord && graph.nodes.get('reviewer').chatRoot === retainedChat,
          draft: graph.nodes.get('reviewer').chatRoot.exportDraft(), expectedDraft: retainedDraft,
          subscriptions: fixture.metrics().subscriptions, expectedSubscriptions: retainedSubscriptions,
          fitted: view._contentIsInsideHost(view._contentBox()), mode: graph.workspace.mode,
          selectedRoots: view.windowRootIds, treeCount: fixture.trees().length }
      })
      results.push({ stage, viewport, ...measured })
      try {
        assert.equal(measured.style, style)
        assert.equal(measured.size, size)
        assert.equal(measured.mode, 'trees')
        assert.equal(measured.chatIdentity, true, `${stage}: switching keeps the actual mounted chat and record`)
        assert.deepEqual(measured.draft, measured.expectedDraft, `${stage}: draft text and attachment remain intact`)
        assert.equal(measured.subscriptions, measured.expectedSubscriptions, `${stage}: switching neither drops nor duplicates subscriptions`)
        assert.equal(measured.fitted, true, `${stage}: fitted projected nodes stay inside the canvas`)
        assert.deepEqual(measured.selectedRoots, ['reviewer', 'researcher'])
        assert.equal(measured.treeCount, 3, 'selection does not mutate the underlying fictional fleet')
        assert.ok(measured.nodes.length >= 2)
        for (const [i, node] of measured.nodes.entries()) {
          assert.ok(within(node.rect, measured.host), `${stage}: ${node.id} stays inside its tree canvas`)
          for (const other of measured.nodes.slice(i + 1)) {
            assert.equal(overlap(node.rect, other.rect), false, `${stage}: ${node.id} and ${other.id} do not overlap`)
          }
          if (style === 'boxes') {
            const expected = TREE_CONTEXT_SIZES[size].box, scale = measured.zoom * measured.uiZoom
            assert.ok(Math.abs(node.rect.width - expected.width * scale) < 1, `${stage}: actual box width matches its layout footprint`)
            assert.ok(Math.abs(node.rect.height - expected.height * scale) < 1, `${stage}: actual box height matches its layout footprint`)
            assert.ok(node.fontSize * scale >= 10.5, `${stage}: body text stays readable (${node.fontSize * scale}px)`)
            assert.ok(node.innerOverflow <= 2, `${stage}: the box grid does not overflow (${node.innerOverflow}px)`)
            assert.ok(within(node.textRect, node.contextRect), `${stage}: context fits inside the allocated box body`)
            /* This used to assert that Mini's box showed the TOOL line instead
               of the agent's own words -- the `compact` branch in
               _paintBoxPreview. Mini was retired for exactly that (R1207: "THE
               WHOLE POINT IS TO INFORM THE USER"), the branch went with it, and
               the assertion is inverted rather than deleted: the SMALLEST size
               must now show what the agent said. */
            if (size === 'small') assert.notEqual(node.text, 'Read src/tree-graph.js',
              `${stage}: the smallest card must show the agent's own words, not only its latest tool call`)
            if (size === 'large') {
              assert.deepEqual(node.detail, [], `${stage}: the whole lower box is conversation context`)
              assert.equal(node.footerVisible, false, `${stage}: no footer occupies the context window`)
              assert.equal(node.addInHeading, true, `${stage}: add-agent control remains available in the header`)
              assert.ok(node.statusOverflow <= 1, `${stage}: header indicators do not overflow`)
              for (const kind of ['task', 'action']) assert.ok(node.indicators.some(item => item.kind === kind), `${stage}: ${kind} remains available as an indicator`)
              for (const indicator of node.indicators) assert.ok(within(indicator.rect, node.status), `${stage}: ${indicator.kind} stays in the upper box`)
              assert.ok(node.contextRect.height > node.rect.height * 0.6, `${stage}: context uses most of the retained footprint`)
            } else {
              assert.equal(node.addInHeading, false, `${stage}: smaller sizes retain their footer control`)
            }
          }
        }
        if (style === 'circles') {
          assert.ok(measured.cards.length > 0, `${stage}: available space yields readable detached context cards`)
          for (const [i, card] of measured.cards.entries()) {
            const expected = TREE_CONTEXT_SIZES[size].card
            assert.ok(Math.abs(card.rect.width - expected.width * measured.uiZoom) < 1, `${stage}: context card width follows preference`)
            const heights = size === 'large' && viewport.height === 800 ? [expected.height, 240] : [expected.height]
            assert.ok(heights.some(height => Math.abs(card.rect.height - height * measured.uiZoom) < 1),
              `${stage}: context card height follows preference or the bounded Large fallback`)
            assert.ok(card.fontSize * measured.uiZoom >= 12, `${stage}: detached text retains screen-space size`)
            assert.ok(within(card.rect, measured.host), `${stage}: context card stays inside canvas`)
            for (const other of measured.cards.slice(i + 1)) assert.equal(overlap(card.rect, other.rect), false, `${stage}: cards do not overlap`)
            for (const node of measured.nodes) assert.equal(overlap(card.rect, node.rect), false, `${stage}: cards do not cover a node`)
            const visible = card.rows.filter(row => row.display !== 'none')
            assert.ok(visible.some(row => row.className.includes('cl-tool') && row.rect.height >= 12), `${stage}: latest action has a visible line`)
            for (const row of visible.filter(row => /cl-current|cl-tool|cl-task/.test(row.className))) {
              assert.ok(within(row.rect, card.activityRect), `${stage}: ${row.className} remains inside the readable activity area`)
            }
            if (size === 'small') assert.ok(visible.some(row => /cl-chat|cl-previous/.test(row.className)),
              `${stage}: the smallest detached card must still carry a conversation row -- hiding it outright is what R1207 retired Mini for`)
            if (size === 'large') assert.ok(visible.some(row => row.className.includes('cl-task') && row.rect.height >= 48),
              `${stage}: Large task context wraps into several readable lines`)
          }
        }
        assert.equal(measured.links.length, 1, `${stage}: the selected two roots retain their direct link`)
        assert.equal(measured.directMark, '›')
        for (const link of measured.links) {
          assert.match(link.d, /^M [\d. -]+ L [\d. -]+$/, `${stage}: direct links stay straight`)
          for (const [id, point] of [[link.from, link.start], [link.to, link.end]]) {
            const { rect } = measured.nodes.find(node => node.id === id)
            if (style === 'boxes') {
              const edgeDistance = Math.min(Math.abs(point.x - rect.left), Math.abs(point.x - rect.right),
                Math.abs(point.y - rect.top), Math.abs(point.y - rect.bottom))
              assert.ok(edgeDistance <= 2 && point.x >= rect.left - 2 && point.x <= rect.right + 2
                && point.y >= rect.top - 2 && point.y <= rect.bottom + 2, `${stage}: direct port lands on ${id}'s actual box border`)
            } else {
              const radius = Math.hypot(point.x - (rect.left + rect.width / 2), point.y - (rect.top + rect.height / 2))
              assert.ok(Math.abs(radius - rect.width / 2) <= 2, `${stage}: direct port lands on ${id}'s actual circle perimeter`)
            }
          }
        }
      } catch (error) {
        failures.push({ stage, error: error.message })
        await page.locator('.tree-window').first().screenshot({ path: path.join(out, `failure-${viewport.width}-${style}-${size}.png`) })
      }
      const imageName = `${viewport.width === 1854 ? '' : `${viewport.width}-`}${style}-${size}.png`
      await page.locator('.tree-window').first().screenshot({ path: path.join(out, imageName) })
    }
  }
  stage = 'fractional zoom context allocation'
  await page.evaluate(() => {
    graph.contextFeed = () => ({ current: 'Working', task: 'Do it.', chat: 'Long conversation update '.repeat(60) })
    graph.setNodeStyle('boxes')
    graph.setCardSize('large')
    for (const record of graph.nodes.values()) graph._renderChipPreview(record)
  })
  for (const zoom of [1, 0.8, 0.65, 1.1]) {
    await page.evaluate(zoom => {
      const view = graph.treeWindows.windows[0].graph
      view.zoom = zoom
      view._applyZoom()
    }, zoom)
    await settle()
    const budgets = await page.evaluate(() => {
      const view = graph.treeWindows.windows[0].graph
      return [...view.nodes.values()].filter(record => !record.el.hidden && view._layoutVisibleIds.has(record.id)).map(record => {
        const context = record.el.querySelector('.tree-box-context')
        const body = context.querySelector(':scope > p')
        const bounds = context.getBoundingClientRect()
        const scale = bounds.height / context.offsetHeight
        return { id: record.id, remaining: bounds.bottom - body.getBoundingClientRect().bottom,
          lineHeight: parseFloat(getComputedStyle(body).lineHeight) * scale }
      })
    })
    assert.ok(budgets.length > 0)
    for (const budget of budgets) {
      assert.ok(budget.remaining >= -1, `${zoom}: ${budget.id} conversation fits after zoom changes`)
      assert.ok(budget.remaining < budget.lineHeight + 1, `${zoom}: ${budget.id} uses every available conversation line`)
    }
  }
  stage = 'large box context and header interactions'
  await page.setViewportSize({ width: 1854, height: 1040 })
  await page.evaluate(() => {
    fixture.contacts = []
    fixture.boxFeed = { current: 'Working on the requested changes', task: 'Task indicator context', tool: 'Action indicator context',
      thinking: 'Current working context '.repeat(80), chat: 'Completed conversation context' }
    for (const agent of fixture.nodes) {
      agent.bornAt = Date.now() - 18 * 3600_000
      agent.stoppedAt = Date.now()
      agent.cloudLane = { running: true, tokens: 2_000_000, drift: 'drifting' }
    }
    for (const view of new Set([graph, ...graph.treeWindows.windows.map(frame => frame.graph)])) view.onContact = agent => fixture.contacts.push(agent.id)
    graph.contextFeed = () => fixture.boxFeed
    graph.setNodeStyle('circles')
    graph.setNodeStyle('boxes')
    graph.fitCurrentTree()
  })
  await settle()
  const headerChecks = await page.evaluate(() => {
    const view = graph.treeWindows.windows[0].graph
    return [...view.nodes.values()].filter(record => !record.el.hidden && view._layoutVisibleIds.has(record.id)).map(record => {
      const heading = record.el.querySelector('.tree-box-heading').getBoundingClientRect()
      const status = record.el.querySelector('.tree-box-status-row')
      const buttons = [...record.el.querySelectorAll('.tree-box-heading button')].filter(button => !button.hidden)
      return { id: record.id, statusOverflow: status.scrollWidth - status.clientWidth,
        headingFits: buttons.every(button => { const r = button.getBoundingClientRect(); return r.left >= heading.left - 1 && r.right <= heading.right + 1 }),
        context: record.el.querySelector('.tree-box-context > p').textContent,
        task: record.el.querySelector('[data-context-kind="task"]').title,
        action: record.el.querySelector('[data-context-kind="action"]').title,
        laneMarks: record.el.querySelectorAll('.tree-box-status-row :is(.node-lane-box, .node-drift-light)').length }
    })
  })
  for (const check of headerChecks) {
    assert.equal(check.headingFits, true, `${check.id}: voice, chat and add controls fit together`)
    assert.ok(check.statusOverflow <= 1, `${check.id}: context indicators coexist with lane and drift status`)
    assert.equal(check.laneMarks, 2)
    assert.match(check.context, /^Current working context /)
    assert.equal(check.task, 'Task: Task indicator context')
    assert.equal(check.action, 'Latest action: Action indicator context')
  }
  const reviewerBox = page.locator('.tree-window .static-tree-node[data-agent-id="reviewer"]')
  await reviewerBox.locator('.node-contact-icon').click()
  assert.deepEqual(await page.evaluate(() => fixture.contacts), ['reviewer'])
  await reviewerBox.locator('.tree-box-add-agent').focus()
  await page.keyboard.press('Enter')
  assert.equal(await page.evaluate(() => fixture.adds.at(-1)?.parentId), 'reviewer')
  await page.evaluate(() => {
    fixture.boxFeed.thinking = 'A different working update'
    graph.refreshChip('reviewer')
    for (const { graph: view } of graph.treeWindows.windows) view.refreshChip('reviewer')
  })
  await settle()
  assert.equal(await reviewerBox.locator('.tree-box-context > p').textContent(), 'A different working update')
  await page.evaluate(() => {
    fixture.boxFeed.thinking = ''
    graph.refreshChip('reviewer')
    for (const { graph: view } of graph.treeWindows.windows) view.refreshChip('reviewer')
  })
  await settle()
  assert.equal(await reviewerBox.locator('.tree-box-context > p').textContent(), 'Completed conversation context')
  await page.locator('.tree-window').first().screenshot({ path: path.join(out, 'large-header-context.png') })
  await reviewerBox.locator('.tree-box-chat').click()
  stage = 'retained chat interaction'
  await page.locator('[role="tab"][data-agent-id="reviewer"]').click()
  assert.equal(await chat.locator('.chat-input input').inputValue(), 'A draft kept across all context sizes and tree styles')
  await chat.locator('.chat-input input').press('Enter')
  await page.waitForFunction(() => fixture.sends.length === 1)
  assert.equal(await page.evaluate(() => fixture.sends[0].id), 'reviewer')
  assert.ok((await chat.locator('.chat-log').textContent()).includes('Reviewer received:'))
  await page.evaluate(() => graph.destroy())
  assert.equal(await page.locator('.tree-workspace').count(), 0)
  assert.equal(await page.evaluate(() => fixture.metrics().subscriptions), 0)
  assert.deepEqual(errors, [])
  const after = sourceState()
  writeFileSync(path.join(out, 'source-after.json'), JSON.stringify(after, null, 2))
  const sourceChangedDuringRun = JSON.stringify(before) !== JSON.stringify(after)
  writeFileSync(path.join(out, 'measurements.json'), JSON.stringify({ results, errors, failures, sourceChangedDuringRun }, null, 2))
  assert.deepEqual(failures, [])
  console.log(JSON.stringify({ out, passed: true, matrixCases: results.length, sourceChangedDuringRun }))
} catch (error) {
  writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ stage, error: error.message, results, errors, failures }, null, 2))
  await page?.screenshot({ path: path.join(out, 'failure.png') })
  console.error(`Evidence: ${out}; stage: ${stage}`)
  throw error
} finally {
  await browser?.close()
  await server.close()
}
