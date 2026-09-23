import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { parseAst } from 'rollup/parseAst'
import { SOURCE_MANIFESTS } from '../lib/adapters/source-suite-manifests.mjs'

const source = readFileSync(new URL('../page2-qa.cjs', import.meta.url), 'utf8')
const tree = parseAst(source)
/* READ THE DRIVER'S OWN COUNT, DO NOT RESTATE IT.
   This file's whole job is to notice when tools/page2-qa.cjs has drifted from the
   product, and it supplied its own literal 5 to every assertion it evaluated --
   so when the driver's EXPECTED_EXAMPLE_TREE_NODES went stale (twice: nine, then
   five, against a canvas that draws four) every test here stayed green over a
   driver that could not finish a run. Taking the number from the source makes the
   fixtures move with it, and the assertion below makes a silent edit visible. */
const EXPECTED_EXAMPLE_TREE_NODES = Number(
  /^const EXPECTED_EXAMPLE_TREE_NODES = (\d+)$/m.exec(source)?.[1])
test('the driver still declares one example tree-node count, and these fixtures are built from it', () => {
  assert.equal(Number.isInteger(EXPECTED_EXAMPLE_TREE_NODES) && EXPECTED_EXAMPLE_TREE_NODES > 0, true,
    'mutation `compute the expected node count instead of declaring it` survived: expected one readable literal')
  assert.equal(EXPECTED_EXAMPLE_TREE_NODES, 4,
    'mutation `change the example board shape without measuring the canvas` survived: the drive measured four drawn nodes on 2026-09-11 (11 simulated + 1 refused-start seeded in the store, one drawn level with drill-in)')
})
function nodes(root, predicate) {
  const found = []
  function walk(node) {
    if (!node || typeof node !== 'object') return
    if (predicate(node)) found.push(node)
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk)
      else if (value && typeof value === 'object') walk(value)
    }
  }
  walk(root)
  return found
}
function assertion(name, context) {
  const calls = nodes(tree, node => node.type === 'CallExpression' && node.callee?.name === 'check'
    && node.arguments[0]?.value === name)
  assert.equal(calls.length, 1)
  const expression = calls[0].arguments[1]
  return vm.runInNewContext(source.slice(expression.start, expression.end), context)
}

const boxName = 'Box cards retain the current 4px header rim, 2px side rim, shaded header and depth'
const box = () => ({ boxed: true, top: '4px', side: '2px', fill: 'linear-gradient(red, white)', shadow: 'rgb(0, 0, 0) 0px 3px 0px' })

test('the actual Box assertion pins every drawn card, not the older circle treatment', () => {
  const all = () => ({ nodes: Array.from({ length: EXPECTED_EXAMPLE_TREE_NODES }, box) })
  assert.equal(assertion(boxName, { boxes: all(), EXPECTED_EXAMPLE_TREE_NODES }), true)
  for (const change of [{ boxed: false }, { top: '1px' }, { side: '0px' }, { fill: 'none' }, { shadow: 'none' }]) {
    const wrong = all()
    Object.assign(wrong.nodes.at(-1), change)
    assert.equal(assertion(boxName, { boxes: wrong, EXPECTED_EXAMPLE_TREE_NODES }), false, JSON.stringify(change))
  }
  assert.equal(assertion(boxName, { boxes: { nodes: [box()] }, EXPECTED_EXAMPLE_TREE_NODES }), false)
})

/* THE RIM IS AUTHORED AS A SCALING PROPERTY NOW, NOT AS A px LITERAL.
   b9074f5e made the node rule declare --circle-stroke: clamp(0.85px, ...) and set
   its border from it, so the drive's old `authoredBorderWidth === '1.5px'` read
   null and reported "flat node material" FAILED against a rim the product draws
   deliberately (measured 2026-09-11: borderWidth 1px, authoredBorderWidth null,
   physicalBorderWidth 1). The replacement is stricter, not looser: the shorthand
   is pinned exactly, the clamp's floor is pinned so nobody can shrink the ring to
   nothing, and the absence of a px literal is itself asserted so a future hardcode
   is caught rather than silently accepted. */
test('the actual Circle material assertion pins the scaling rim and stays strict', () => {
  const material = { backgroundImage: 'none', authoredBorderWidth: null,
    authoredNodeBorder: 'var(--circle-stroke) solid var(--rc)', authoredStrokeFloor: '.85',
    physicalBorderWidth: 1, boxShadow: 'none', backdrop: 'none' }
  assert.equal(assertion('flat node material', { initial: { material } }), true)
  for (const change of [{ backgroundImage: 'linear-gradient(red, white)' },
    { authoredBorderWidth: '1.5px' }, { authoredNodeBorder: '1.5px solid var(--rc)' },
    { authoredNodeBorder: '' }, { authoredNodeBorder: 'var(--circle-stroke) solid red' },
    { authoredStrokeFloor: null }, { authoredStrokeFloor: '0.4' },
    { physicalBorderWidth: 0 }, { boxShadow: '0 3px black' }, { backdrop: 'blur(4px)' }]) {
    assert.equal(assertion('flat node material', { initial: { material: { ...material, ...change } } }), false,
      JSON.stringify(change))
  }
})

test('the current overview assertion requires Research, roles, record and account to remain discoverable', () => {
  const initial = { researchSlot: true, disclosures: [
    { id: 'research', title: 'Research filing' }, { id: 'configuration', title: 'Organisation & roles' },
    { id: 'record', title: 'Computer record & services' }, { id: 'account', title: 'Account connection' },
  ] }
  const name = 'overview retains Research, organisation, record and account disclosures'
  assert.equal(assertion(name, { initial }), true)
  assert.equal(assertion(name, { initial: { ...initial, researchSlot: false } }), false)
  for (let index = 0; index < initial.disclosures.length; index += 1) {
    assert.equal(assertion(name, { initial: { ...initial, disclosures: initial.disclosures.filter((_, at) => at !== index) } }), false)
  }
})

function pointerFixture({ occluded = false, disabled = false, outside = false } = {}) {
  let time = 0
  const element = { disabled, className: 'qa-target', contains: hit => hit === element,
    getBoundingClientRect: () => ({ x: outside ? 1200 : 50, y: 20, width: 80, height: 44 }) }
  const dom = { document: { querySelector: () => element, elementFromPoint: () => occluded ? { className: 'occluder' } : element },
    getComputedStyle: () => ({ pointerEvents: 'auto' }), innerWidth: 1000, innerHeight: 700 }
  const fn = tree.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'pressVisibleControl')
  const press = vm.runInNewContext(`(${source.slice(fn.start, fn.end)})`, {
    Date: { now: () => { time += 1000; return time } }, delay: async () => {},
    check(name, pass) { assert.ok(pass, name) },
  })
  const events = []
  const webContents = { async executeJavaScript(expression) { return vm.runInNewContext(expression, dom) },
    sendInputEvent(event) { events.push(JSON.parse(JSON.stringify(event))) } }
  return { press, webContents, events }
}

test('the actual pointer helper requires hit testing and sends native pointer events to the measured center', async () => {
  const f = pointerFixture()
  await f.press(f.webContents, '.qa-target', 2)
  assert.deepEqual(f.events, [
    { type: 'mouseMove', x: 90, y: 42 },
    { type: 'mouseDown', x: 90, y: 42, button: 'left', clickCount: 2 },
    { type: 'mouseUp', x: 90, y: 42, button: 'left', clickCount: 2 },
  ])
})

for (const condition of ['occluded', 'disabled', 'outside']) {
  test(`the actual pointer helper refuses ${condition} targets without sending input`, async () => {
    const f = pointerFixture({ [condition]: true })
    await assert.rejects(f.press(f.webContents, '.qa-target'), /visible pointer reaches/)
    assert.deepEqual(f.events, [])
  })
}

test('shape and guide interactions use shipped controls without calling private graph setters or deleting guide state', () => {
  assert.match(source, /pressVisibleControl\(webContents, '\.first-use-layer:not\(\[hidden\]\) \.first-use-quiet'\)/)
  assert.match(source, /pressVisibleControl\(webContents, '\.first-use-layer:not\(\[hidden\]\) \.first-use-close'\)/)
  assert.match(source, /pressVisibleControl\(webContents, '\.tree-preview-close'\)/)
  assert.match(source, /chooseShape\(webContents, 'boxes'\)/)
  assert.match(source, /chooseShape\(webContents, 'circles'\)/)
  assert.match(source, /shape === 'circles' \? 'Home' : 'End', 'Return'/)
  assert.doesNotMatch(source, /\.setNodeStyle\(/)
  assert.doesNotMatch(source, /first-use[^\n]*\.remove\(\)/)
  assert.doesNotMatch(source, /\.tree-conversation \.chat-close/)
})

test('the current-layout regression belongs to the required source census', () => {
  const rows = SOURCE_MANIFESTS.app.inventory.filter(row => row.file === 'tools/test/page2-qa-current-layout.test.mjs')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].reason, null)
})

test('the example side rail cannot claim that the displayed agent belongs to the owner', () => {
  const title = 'the tree rail labels the example channel honestly'
  const status = 'the deterministic sample node is honestly not running'
  assert.equal(assertion(title, { singleClick: { railTitle: 'Example agent' } }), true)
  assert.equal(assertion(title, { singleClick: { railTitle: 'Agent in your tree' } }), false)
  assert.equal(assertion(status, { singleClick: { chatSubtitle: 'Example agent · not running' } }), true)
  assert.equal(assertion(status, { singleClick: { chatSubtitle: 'your agent · not running' } }), false)
})

test('the dense forest assertion requires all 32 fixture agents, actual folding and a labelled branch', () => {
  const name = 'the dense 32-agent forest keeps an explicit labelled branch control'
  const state = { agents: 32, folded: true, branchLabel: 'Explore Manager branch' }
  assert.equal(assertion(name, { drillId: 'manager', drill: { state } }), true)
  assert.equal(assertion(name, { drillId: null, drill: { state } }), false)
  for (const change of [{ agents: 12 }, { agents: 31 }, { folded: false }, { branchLabel: '' }, { branchLabel: 'Manager' }]) {
    assert.equal(assertion(name, { drillId: 'manager', drill: { state: { ...state, ...change } } }), false)
  }
  assert.match(source, /const agents = \[\.\.\.graph\.computer\.agents\]/)
  assert.match(source, /graph\.computer = \{ \.\.\.graph\.computer, agents \}/)
  assert.doesNotMatch(source, /graph\.computer\.agents\.push\(/)
})

test('Boxes capture waits for the real view opacity and entry animations, not a style override', () => {
  const capture = source.indexOf("path.join(outputDir, 'boxes-tan-1600x900.png')")
  const barrier = source.lastIndexOf('await waitFor(webContents,', capture)
  const code = source.slice(barrier, capture)
  const shown = source.lastIndexOf('window.showInactive()', capture)
  assert.ok(shown >= 0 && shown < barrier)
  assert.equal(source.slice(shown, capture).includes('window.hide()'), false)
  assert.match(code, /getComputedStyle\(view\)\.opacity === '1'/)
  assert.match(code, /document\.getAnimations\(\)/)
  assert.match(code, /animation\.playState === 'running' \|\| animation\.pending === true/)
  assert.match(code, /requestAnimationFrame\(\(\) => requestAnimationFrame\(/)
  assert.doesNotMatch(code, /\.style\s*[.=]/)
})

test('the directly assigned agent route is not reported as a clicked Page 2 action', () => {
  assert.match(source, /check\('direct agent route seam lands on a mounted agent detail \(not a Page 2 button proof\)'/)
  assert.doesNotMatch(source, /check\('page 2 "Open full view"/)
})

test('the on-glass example roster assertion rejects a real-running claim on any sample card', () => {
  const name = 'example roster durations are labelled as examples, never as real running sessions'
  const card = () => ({ state: 'example', note: 'example time', dialRunning: 'false',
    label: 'Sample, example agent, no real session', status: 'Configured to use codex' })
  const read = cards => assertion(name, { exampleRoster: { cards }, EXPECTED_EXAMPLE_TREE_NODES })
  assert.equal(read(Array.from({ length: EXPECTED_EXAMPLE_TREE_NODES }, card)), true)
  for (const change of [{ state: 'running' }, { note: 'running' }, { dialRunning: 'true' },
    { label: 'running for one hour' }, { status: 'On record as enabled, running on codex' }]) {
    const cards = Array.from({ length: EXPECTED_EXAMPLE_TREE_NODES }, card)
    Object.assign(cards.at(-1), change)
    assert.equal(read(cards), false)
  }
  assert.equal(read([]), false)
})
