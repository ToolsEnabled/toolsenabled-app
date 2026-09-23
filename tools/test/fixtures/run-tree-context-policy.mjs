import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

// Real graph, toolbar, settings policy and chat components. Every agent,
// bridge and conversation belongs to the isolated browser fixture.
const root = fileURLToPath(new URL('../../../', import.meta.url))
const out = process.env.TREE_CONTEXT_EVIDENCE || path.resolve(root, '../context-proof/browser')
mkdirSync(out, { recursive: true })
const files = ['src/tree-graph.js', 'src/tree-context-cards.js', 'src/tree-context-settings.js', 'src/tree-workspace.css', 'src/tree-card-density.css', 'src/tree-toolbar.js']
const hashes = () => Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')]))
const before = hashes(), errors = [], checks = []
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const server = await createServer({ root, configFile: false, cacheDir: path.join(out, 'vite-cache'), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null, fs: { allow: [root, realpathSync(path.join(root, 'node_modules'))] } } })
let browser, failure
try {
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 2200, height: 1500 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    if (localStorage.getItem('fixture-policy-initialized')) return
    localStorage.setItem('fixture-policy-initialized', 'true')
    localStorage.setItem('mc.set.tree_context_size', 'large')
    const key = tree => JSON.stringify(['tree-interactions-circles', tree])
    localStorage.setItem('mc.tree.context-cards.v1', JSON.stringify({ version: 1, defaultSize: 'medium',
      trees: { [key('alpha')]: 'mini', [key('beta')]: 'large', [key('gamma')]: 'off', [key('parked-tree')]: 'small' } }))
  })
  await page.goto(`${origin}/tools/test/fixtures/tree-interactions.html?style=circles`)
  await page.waitForFunction(() => window.graph?.treeWindows)
  await page.evaluate(async () => {
    window.policy = await import('/src/tree-context-cards.js')
    window.key = tree => policy.treeContextKey(fixture.computer.id, tree)
    window.setPolicy = change => policy.updateTreeContextCards(change)
    graph.treeWindows.choose(graph.treeWindows.windows[0], ['alpha', 'beta', 'gamma'])
    graph.contextFeed = () => ({ current: 'Reviewing the current change', task: 'Inspect the card policy and preserve the mounted conversation.',
      previous: 'asked: Inspect the card policy and preserve the mounted conversation.', tool: 'Reading the selected agent context',
      chat: 'The saved profile is applied to this tree. Its conversation and context remain available.' })
    graph.refresh()
    await document.fonts.ready
  })
  await page.waitForTimeout(180)
  const readCards = () => page.evaluate(() => [...graph.nodes.values()].filter(record => record.chip).map(record => {
    const r = record.chip.getBoundingClientRect()
    return { id: record.id, size: record.chip.dataset.contextSize, visible: record.chip.classList.contains('screen-chip-visible'),
      width: r.width, height: r.height, padding: getComputedStyle(record.chip).paddingLeft,
      task: !!record.chip.querySelector('.cl-task'), roleVisible: !!record.chip.querySelector('.chip-role')?.checkVisibility({ checkVisibilityCSS: true }) }
  }))
  let cards = await readCards()
  assert.equal(await page.evaluate(() => graph.cardSize), 'medium', 'canonical default wins over legacy global size')
  // The saved Mini override renders as Mini without rewriting other trees.
  for (const [prefix, size, dimensions] of [['alpha', 'mini', [224, 88]], ['beta', 'large', [380, 220]]]) {
    const visible = cards.filter(card => card.id.startsWith(prefix) && card.visible)
    assert.ok(visible.length, `${prefix} has a visible ${size} card`)
    for (const card of visible) {
      assert.equal(card.size, size)
      assert.deepEqual([card.width, card.height], dimensions)
      assert.equal(card.task, false, 'the latest context replaces the redundant task section')
      assert.equal(card.roleVisible, size !== 'mini', 'density CSS follows each card')
    }
  }
  assert.ok(cards.filter(card => card.id.startsWith('gamma')).every(card => !card.visible), 'Off retains nodes while hiding their detached cards')
  assert.equal(await page.locator('.tree-context-control:visible').count(), 0, 'tabbed tree retains one toolbar')
  for (const theme of ['black', 'white']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
    await page.screenshot({ path: path.join(out, `${theme}-mixed.png`) })
  }
  checks.push({ name: 'saved-mixed-profiles', cards })

  const geometry = () => page.evaluate(() => ({ zoom: graph.zoom, x: graph.panX, y: graph.panY,
    nodes: [...graph.nodes].map(([id, record]) => [id, record.x, record.y]) }))
  const original = await geometry()
  await page.evaluate(() => setPolicy({ defaultSize: 'small' }))
  assert.deepEqual(await geometry(), original, 'default change cannot distort the circle hierarchy or camera')
  await page.locator('.tree-card-size-select').selectOption('large')
  assert.deepEqual(await geometry(), original, 'toolbar resize does not relayout circle hierarchy')
  assert.deepEqual(await page.evaluate(() => policy.readTreeContextCards().record), await page.evaluate(() => ({ version: 1, defaultSize: 'large',
    trees: { [key('alpha')]: 'large', [key('beta')]: 'large', [key('gamma')]: 'large', [key('parked-tree')]: 'small' } })))
  checks.push({ name: 'toolbar-resolves-overrides-without-camera-change', passed: true })

  await page.evaluate(() => { setPolicy({ treeKeys: [key('alpha'), key('gamma')], size: 'off' }); setPolicy({ treeKeys: [key('beta')], size: 'small' }) })
  await page.locator('.tree-cards-toggle:visible').click()
  assert.equal(await page.evaluate(() => graph.circleCards), false)
  await page.locator('.tree-cards-toggle:visible').click()
  assert.deepEqual(await page.evaluate(() => policy.readTreeContextCards().record.trees), await page.evaluate(() => ({ [key('alpha')]: 'large', [key('beta')]: 'small', [key('gamma')]: 'large', [key('parked-tree')]: 'small' })))
  checks.push({ name: 'cards-on-restores-off-without-erasing-other-size', passed: true })

  await page.evaluate(() => graph.treeWindows.choose(graph.treeWindows.windows[0], 'alpha'))
  await page.waitForTimeout(180)
  const card = page.locator('.static-tree-chip.screen-chip-visible').first()
  const id = await card.getAttribute('data-agent-id')
  await card.click()
  await page.waitForFunction(() => graph.workspace.mode === 'chat')
  const input = page.locator(`.tree-conversation[data-agent-id="${id}"] .chat-input input`)
  await input.fill('Unsent draft survives per-tree settings changes.')
  await page.evaluate(id => { window.savedInput = document.querySelector(`.tree-conversation[data-agent-id="${id}"] .chat-input input`); window.savedPanel = graph.nodes.get(id).chatPanel; setPolicy({ treeKeys: [key('alpha')], size: 'off' }) }, id)
  assert.equal(await page.evaluate(id => savedPanel === graph.nodes.get(id).chatPanel && savedInput === document.querySelector(`.tree-conversation[data-agent-id="${id}"] .chat-input input`), id), true)
  assert.equal(await input.inputValue(), 'Unsent draft survives per-tree settings changes.')
  await page.locator('.tree-preview-close').click()
  await page.waitForTimeout(180)
  assert.equal(await page.locator('.static-tree-chip.screen-chip-visible').count(), 0)
  assert.equal(await page.locator('.tree-cards-toggle:visible').getAttribute('aria-pressed'), 'false')
  await page.locator('.tree-cards-toggle:visible').click()
  await page.locator(`.static-tree-chip.screen-chip-visible[data-agent-id="${id}"]`).click()
  assert.equal(await input.inputValue(), 'Unsent draft survives per-tree settings changes.')
  await page.locator('.tree-preview-close').click()
  checks.push({ name: 'policy-off-preserves-mounted-chat-and-draft', passed: true })

  await page.locator('.tree-shape-select').selectOption('boxes')
  await page.evaluate(() => { graph.treeWindows.add('beta'); setPolicy({ defaultSize: 'small' }) })
  assert.deepEqual(await page.evaluate(() => graph.treeWindows.windows.map(frame => ({ size: frame.graph.cardSize,
    width: frame.graph._boxSize().width, height: frame.graph._boxSize().height }))), [
    { size: 'small', width: 288, height: 160 }, { size: 'small', width: 288, height: 160 },
  ])
  await page.evaluate(() => setPolicy({ defaultSize: 'off' }))
  assert.deepEqual(await page.evaluate(() => graph.treeWindows.windows.map(frame => frame.graph.cardSize)), ['small', 'small'], 'Off never hides or resizes agent boxes')
  assert.ok(await page.locator('.tree-agent-box:visible').count())
  assert.equal(await page.locator('.tree-card-size-select').inputValue(), 'small')
  await page.screenshot({ path: path.join(out, 'boxes-off-policy.png') })
  checks.push({ name: 'settings-size-updates-split-boxes-off-keeps-agents', passed: true })

  await page.evaluate(() => setPolicy({ defaultSize: 'small' }))
  await page.reload()
  await page.waitForFunction(() => window.graph?.treeWindows)
  assert.equal(await page.evaluate(() => graph.cardSize), 'small', 'canonical default reopens despite stale legacy key')
  checks.push({ name: 'canonical-default-reopens', passed: true })
  await page.evaluate(() => {
    window.savedPolicyBytes = localStorage.getItem('mc.tree.context-cards.v1')
    localStorage.setItem('mc.tree.context-cards.v1', '{broken')
    window.dispatchEvent(new StorageEvent('storage', { key: 'mc.tree.context-cards.v1' }))
  })
  await page.locator('.tree-card-size-select').selectOption('large')
  assert.equal(await page.evaluate(() => graph.cardSize), 'small', 'a refused write leaves the active box size intact')
  assert.equal(await page.locator('.tree-card-size-select').inputValue(), 'small')
  assert.equal(await page.evaluate(() => localStorage.getItem('mc.tree.context-cards.v1')), '{broken', 'a failed save never overwrites unreadable policy')
  assert.match(await page.evaluate(() => graph.contextCardNotice.textContent), /could not be read/)
  await page.evaluate(() => {
    localStorage.setItem('mc.tree.context-cards.v1', savedPolicyBytes)
    window.dispatchEvent(new StorageEvent('storage', { key: 'mc.tree.context-cards.v1' }))
  })
  assert.equal(await page.evaluate(() => graph.contextCardNotice.textContent), '', 'recovering readable policy clears its stale refusal')
  checks.push({ name: 'failed-policy-write-preserves-active-view-and-saved-bytes', passed: true })
  await page.evaluate(() => graph.destroy())
  assert.equal(await page.evaluate(() => fixture.subscribers.size), 0)
  assert.deepEqual(errors, [])
} catch (error) { failure = error.stack || String(error) }
finally {
  const after = hashes()
  writeFileSync(path.join(out, 'evidence.json'), JSON.stringify({ passed: !failure, failure, checks, errors,
    sourceUnchanged: JSON.stringify(before) === JSON.stringify(after), sourceBefore: before, sourceAfter: after }, null, 2))
  await browser?.close()
  await server.close()
}
if (failure) throw new Error(failure)
console.log(JSON.stringify({ passed: true, checks: checks.length, evidence: path.join(out, 'evidence.json') }))
