import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { TREE_CONTEXT_SIZES } from '../../../src/tree-box-layout.js'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const requested = process.env.TREE_CARD_EVIDENCE
const out = requested && !existsSync(requested) ? requested : mkdtempSync(requested ? `${requested}-` : path.join(tmpdir(), 'tree-circle-cards-'))
mkdirSync(out, { recursive: true })
const sources = ['src/tree-graph.js', 'src/tree-graph.css', 'src/tree-workspace.css', 'src/tree-card-density.css', 'src/tree-workspace.js', 'src/tree-windows.js', 'tools/test/fixtures/tree-interactions.mjs']
const hashes = () => Object.fromEntries(sources.map(name => [name, createHash('sha256').update(readFileSync(path.join(root, name))).digest('hex')]))
const before = hashes(), results = [], errors = []
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const server = await createServer({ root, configFile: false, cacheDir: path.join(out, 'vite-cache'), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null, fs: { allow: [root, realpathSync(path.join(root, 'node_modules'))] } } })
let browser, page
try {
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, reducedMotion: 'reduce' })
  page = await context.newPage()
  page.setDefaultTimeout(8000)
  page.on('pageerror', error => errors.push({ message: error.message }))
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  await page.goto(`${origin}/tools/test/fixtures/tree-interactions.html?style=circles`)
  await page.waitForFunction(() => window.graph?.treeWindows)
  await page.evaluate(() => document.fonts.ready)
  await page.evaluate(() => {
    graph.treeWindows.choose(graph.treeWindows.windows[0], 'alpha')
    fixture.nodes[0].name = 'Controller'
    fixture.nodes[1].name = 'Builder — workspace navigation'
    fixture.nodes[2].name = 'Reviewer'
    fixture.nodes.forEach(agent => { agent.bornAt = 1000; agent.stoppedAt = 1061000 })
    window.cardBrief = 'Keep the tree controls predictable on laptops. Review how the selected branch stays in view during zoom, then check the conversation tabs and preserve any draft when returning to the canvas. Record the behavior at each card size and report concrete issues with the source of the problem.'
    window.cardUpdate = 'The branch remains centered and the conversation keeps its draft. I am checking the smaller card sizes now, including long agent names, tool output, and the final readable line at the bottom of each preview.'
    window.cardCase = 'rich'
    graph.contextFeed = () => cardCase === 'brief'
      ? { current: 'Ready for review', task: cardBrief, previous: `asked: ${cardBrief}`, tasks: 4, failRate: 0, model: 'GPT-6' }
      : { current: 'Checking the workspace', task: cardBrief, previous: `asked: ${cardBrief}`, tool: 'Reading src/tree-workspace.js and checking the mounted chat', chat: cardUpdate, tasks: 4, failRate: 0, model: 'GPT-6' }
    graph.refresh()
  })
  for (const theme of ['black', 'white']) for (const size of ['mini', 'small', 'medium', 'large']) {
    await page.evaluate(({ theme, size }) => { document.documentElement.dataset.theme = theme; graph.setCardSize(size) }, { theme, size })
    await page.waitForTimeout(220)
    const card = page.locator('.static-tree-chip.screen-chip-visible').first()
    await card.waitFor()
    for (const scenario of ['rich', 'brief']) {
      await page.evaluate(scenario => { cardCase = scenario; graph.refresh() }, scenario)
      await page.waitForTimeout(50)
      const layout = await card.evaluate(chip => {
        const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height } }
        const visible = element => !!element.getClientRects().length && getComputedStyle(element).display !== 'none'
        const activity = chip.querySelector('.chip-preview-activity')
        return { card: rect(chip), compact: chip.hasAttribute('data-compact-context'), activity: rect(activity),
          rows: [...activity.children].filter(visible).map(element => ({ text: element.textContent, ...rect(element) })),
          lines: [...chip.querySelectorAll('.chip-context-text')].filter(visible).map(element => ({ text: element.textContent, lineHeight: parseFloat(getComputedStyle(element).lineHeight), ...rect(element) })),
          name: rect(chip.querySelector('.cl-name b')), runtime: rect(chip.querySelector('.chip-runtime')),
          braces: [...chip.querySelectorAll('.monitor-brace')].map(rect),
          preview: rect(chip.querySelector('.chip-preview')), role: chip.querySelector('.chip-role').textContent,
          text: chip.innerText, taskCount: chip.querySelectorAll('.cl-task').length,
          messageCount: chip.querySelectorAll('.cl-chat,.cl-previous').length,
          headerAction: chip.querySelector('.chip-preview-header .chip-latest-action')?.textContent || '',
        }
      })
      const failures = []
      const check = (pass, message) => { if (!pass) failures.push(message) }
      const dimensions = [TREE_CONTEXT_SIZES[size].card.width, TREE_CONTEXT_SIZES[size].card.height]
      check(layout.card.width === dimensions[0], 'fixed card width is preserved')
      check(layout.card.height === (layout.compact ? Math.min(240, dimensions[1]) : dimensions[1]), 'fixed card height is preserved')
      check(layout.name.right <= layout.runtime.x + .5, 'name and clock do not overlap')
      check(layout.preview.x - layout.braces[0].right >= 6, 'left brace has a clear inner gutter')
      check(layout.braces[1].x - layout.preview.right >= 6, 'right brace has a clear inner gutter')
      for (const row of layout.rows) check(row.bottom <= layout.activity.bottom + .5, 'every context section fits inside the body')
      for (const line of layout.lines) {
        check(line.bottom <= layout.activity.bottom + .5, 'visible context ends on a complete line')
        check(Math.abs(line.height / line.lineHeight - Math.round(line.height / line.lineHeight)) < .06, 'line clamps never leave a partial line')
      }
      if (size === 'large' && scenario === 'brief') {
        check(layout.taskCount === 0 && layout.messageCount === 1, 'the original brief appears once as fallback context')
      }
      if (size === 'large' && scenario === 'rich') {
        check(layout.taskCount === 0 && layout.messageCount === 1, 'the latest update replaces the redundant task section')
        check(layout.headerAction.startsWith('Reading src/tree-workspace.js'), 'the latest actual action appears in the header')
        check(!layout.text.includes('Latest action') && !layout.text.includes('Latest update') && !layout.text.includes('Open side chat'), 'redundant heading and instruction rows stay absent')
      }
      results.push({ theme, size, scenario, passed: failures.length === 0, failures, layout })
      await card.screenshot({ path: path.join(out, `${theme}-${size}-${scenario}.png`) })
      if (size === 'large' && scenario === 'rich') await page.screenshot({ path: path.join(out, `${theme}-canvas.png`) })
    }
  }
  // A card refresh while its conversation is mounted must update just the
  // preview. The chat input, subscription and unsent draft keep their owner.
  await page.evaluate(() => { cardCase = 'rich'; graph.refresh(); graph._viewSteered = true })
  const id = await page.locator('.static-tree-chip.screen-chip-visible').first().getAttribute('data-agent-id')
  const card = page.locator(`.static-tree-chip.screen-chip-visible[data-agent-id="${id}"]`)
  const geometry = await card.boundingBox()
  const camera = await page.evaluate(() => ({ zoom: graph.zoom, panX: graph.panX, panY: graph.panY }))
  await card.locator('.chip-context-text').first().click()
  await page.waitForFunction(id => graph.workspace.mode === 'chat' && graph.activeChatId === id, id)
  const input = page.locator(`.tree-conversation[data-agent-id="${id}"] .chat-input input`)
  await input.fill('Keep this unsent draft while I inspect the circle card.')
  await page.evaluate(id => {
    window.savedCardChatInput = document.querySelector(`.tree-conversation[data-agent-id="${id}"] .chat-input input`)
    window.savedCardChatPanel = graph.nodes.get(id).chatPanel
    window.savedCardSubscriptions = fixture.subscribers.size
    cardUpdate += ' Context refresh completed.'
    fixture.nodes.find(agent => agent.id === id).declaredRole = 'reviewer'
    graph.refresh()
  }, id)
  assert.equal(await page.evaluate(id => savedCardChatInput === document.querySelector(`.tree-conversation[data-agent-id="${id}"] .chat-input input`), id), true)
  assert.equal(await page.evaluate(id => savedCardChatPanel === graph.nodes.get(id).chatPanel && savedCardSubscriptions === fixture.subscribers.size, id), true)
  assert.equal(await input.inputValue(), 'Keep this unsent draft while I inspect the circle card.')
  await page.locator('.tree-preview-close').click()
  await page.waitForTimeout(450)
  assert.deepEqual(await page.evaluate(() => ({ zoom: graph.zoom, panX: graph.panX, panY: graph.panY })), camera)
  assert.deepEqual(await card.boundingBox(), geometry, 'returning to the tree preserves the card and brace footprint')
  assert.equal(await card.locator('.chip-role').textContent(), 'Reviewer', 'declared role changes invalidate the preview cache')
  await card.click()
  assert.equal(await input.inputValue(), 'Keep this unsent draft while I inspect the circle card.')
  assert.deepEqual(await page.evaluate(() => fixture.controls), [], 'the whole context card opens its full chat without opening a side panel')
  results.push({ name: 'mounted-chat-continuity', passed: true, camera, geometry })
  await page.evaluate(() => graph.destroy())
  assert.equal(await page.evaluate(() => fixture.subscribers.size), 0)
  assert.equal(await page.locator('.static-tree-chip,.monitor-brace').count(), 0)
  assert.deepEqual(errors, [])
  assert.ok(results.every(result => result.passed), results.filter(result => !result.passed).map(result => `${result.theme}/${result.size}/${result.scenario}: ${result.failures.join(', ')}`).join('\n'))
} catch (error) {
  errors.push({ message: error.message, stack: error.stack })
  await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  const after = hashes()
  writeFileSync(path.join(out, 'evidence.json'), JSON.stringify({ results, errors, before, after, sourceChangedDuringRun: JSON.stringify(before) !== JSON.stringify(after) }, null, 2))
  await browser?.close()
  await server.close()
  console.log(JSON.stringify({ out, cases: results.length, failed: results.filter(result => !result.passed).map(({ theme, size, scenario, failures }) => ({ theme, size, scenario, failures })), errors }))
}
