import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { fleetFetch, installWorld, seedTreeNode, settle } from './lib/tree-command-real-mount.mjs'

register('./helpers/css-stub-loader.mjs', import.meta.url)
const { homeView } = await import('../../src/views/home.js')
const { mountFirstUseGuidance } = await import('../../src/first-use-guidance.js')
const { resolveDataSource, setExampleMode, currentDataSource } = await import('../../src/data-source.js')
const { THIS_COMPUTER_ID, THIS_COMPUTER_LABEL } = await import('../../src/declared-fleet.js')
const { fleetTreesStorageKey } = await import('../../src/fleet-trees.js')
const { isSampleFleet } = await import('../../src/fleet-profile.js')

// Real Home -> layout -> workspace -> Computers compose; bridge calls are inert.
// Geometry models visibility only: this suite is not browser/physical acceptance.
async function fixture(t, { source = 'local' } = {}) {
  const world = await installWorld(fleetFetch())
  const held = [], views = new Set(), guides = new Set(), guideHosts = new Set()
  const replace = (object, key, descriptor) => {
    const previous = Object.getOwnPropertyDescriptor(object, key)
    held.push(() => previous ? Object.defineProperty(object, key, previous) : delete object[key])
    Object.defineProperty(object, key, { configurable: true, ...descriptor })
  }
  t.after(async () => {
    for (const guide of guides) guide.destroy()
    for (const host of guideHosts) host.remove()
    for (const view of views) { view.destroy(); view.el.remove() }
    await settle(8)
    for (const restore of held.reverse()) restore()
    world.restore()
  })
  globalThis.requestAnimationFrame = () => 1
  globalThis.cancelAnimationFrame = () => {}
  const proto = Object.getPrototypeOf(document.createElement('div'))
  // Reflect the browser hidden property in attributes, so the production guide's
  // closest('[hidden]') and rect checks see actual ancestor visibility.
  replace(proto, 'hidden', {
    get() { return this.attributes.has('hidden') },
    set(value) { if (value) this.attributes.set('hidden', ''); else this.attributes.delete('hidden') },
  })
  const exposed = element => {
    for (let node = element; node; node = node.parentNode) {
      if (node.hidden || node.getAttribute?.('aria-hidden') === 'true' || node.style?.display === 'none') return false
    }
    return element.isConnected
  }
  replace(proto, 'getClientRects', { value() { return exposed(this) ? [this.getBoundingClientRect()] : [] } })
  replace(proto, 'getBoundingClientRect', { value() {
    return this.classList.contains('first-use-layer')
      ? { x: 0, y: 0, left: 0, top: 0, right: 1280, bottom: 800, width: 1280, height: 800 }
      : { x: 40, y: 100, left: 40, top: 100, right: 400, bottom: 250, width: 360, height: 150 }
  } })
  replace(proto, 'setSelectionRange', { value(start, end) { this.selectionStart = start; this.selectionEnd = end } })
  replace(globalThis, 'getComputedStyle', { value: element => ({
    display: element.style?.display || 'block', visibility: element.style?.visibility || 'visible', opacity: '1',
  }) })
  const account = { current: async () => ({ signedIn: true, account: { id: 'a'.repeat(32) }, session: { issuedAtMs: 100 } }) }
  replace(globalThis, 'mcAccount', { value: account, writable: true })
  window.mcAccount = account
  const effects = { start: 0, send: 0 }
  world.bridge.start = async () => { effects.start++; return { ok: false, code: 'FIXTURE_START_REFUSED' } }
  world.bridge.send = async () => { effects.send++; return { ok: false, code: 'FIXTURE_SEND_REFUSED' } }
  world.bridge.history = async () => ({ ok: true, entries: [], total: 0, verified: true })
  replace(globalThis, 'mcAgent', { value: world.bridge, writable: true })
  world.storage.setItem('mc.write.agent-session', 'disabled')
  if (source === 'relay') {
    const remoteShell = { getBridgeTransport: async () => null }
    window.mcShell = remoteShell
    globalThis.mcShell = remoteShell
  }
  setExampleMode(source === 'mock')
  await resolveDataSource({ reask: true })
  assert.equal(currentDataSource(), source, 'fixture source must resolve before mounting Home')
  assert.equal(isSampleFleet(), true, 'no owner fleet profile participates in this fixture')
  location.hash = '#/home'
  async function mount() {
    const view = homeView()
    views.add(view); document.body.appendChild(view.el)
    await settle(16)
    return view
  }
  async function open(view) {
    view ||= await mount()
    view.el.querySelector('[data-chat-expand]').click()
    await settle(16)
    assert.equal(view.el.querySelector('[data-chat-takeover]').hidden, false)
    return view
  }
  function guide(view) {
    const entryHost = document.createElement('div'); document.body.appendChild(entryHost); guideHosts.add(entryHost)
    const storage = { getItem: () => JSON.stringify({ version: 1, quiet: true, seen: {} }), setItem() {} }
    const controller = mountFirstUseGuidance({ entryHost, storage })
    guides.add(controller)
    const layer = document.querySelector('.first-use-layer')
    layer.clientWidth = 1280; layer.clientHeight = 800
    controller.visit('home', view.el)
    entryHost.querySelector('#page-guide').click()
    return { layer, next: () => layer.querySelector('.first-use-next').click() }
  }
  return { world, mount, open, guide, effects, exposed }
}

function options(view) { return [...view.el.querySelectorAll('[data-chat-subject] option')] }
function choose(view, value) {
  const picker = view.el.querySelector('[data-chat-subject]')
  assert.ok(options(view).some(option => option.value === value), 'requested subject is offered')
  picker.value = value; picker.dispatch('change')
}
async function until(read, message) {
  // Bound: 500 event-loop turns, matching the existing real Home route fixture.
  for (let turn = 0; turn < 500; turn++) {
    const result = read()
    if (result) return result
    await settle(1)
  }
  assert.fail(message)
}

test('fresh local Home opens New chat and Set saves one draft without starting or sending', async t => {
  const f = await fixture(t)
  const key = fleetTreesStorageKey(THIS_COMPUTER_ID)
  assert.equal(f.world.storage.getItem(key), null, 'fresh fixture has no saved tree')
  const view = await f.open()
  const local = options(view).find(option => option.value === `computer:${THIS_COMPUTER_ID}`)
  assert.ok(local, 'installed local computer is selectable without a saved tree')
  assert.equal(local.textContent, THIS_COMPUTER_LABEL)
  const add = view.el.querySelector('[data-chat-new]')
  assert.equal(add.disabled, false)
  add.click()
  const field = await until(() => view.el.querySelector('[data-compose-field="message"]'), 'real Computers compose must mount')
  field.value = 'Keep this first task as a draft'; field.dispatch('input')
  const set = view.el.querySelector('[data-compose-action="set"]')
  assert.equal(set.disabled, false)
  assert.equal(view.el.querySelector('[data-compose-action="start"]').disabled, true, 'saved start-off preference stays authoritative')
  set.click()
  const saved = await until(() => {
    const value = JSON.parse(f.world.storage.getItem(key) || 'null')
    return value?.nodes?.length ? value : null
  }, 'Set must persist through the real tree store')
  assert.equal(saved.computerId, THIS_COMPUTER_ID)
  assert.equal(saved.nodes.length, 1)
  assert.equal(saved.nodes[0].message, 'Keep this first task as a draft')
  assert.equal(saved.nodes[0].status, 'draft')
  assert.ok(!saved.nodes[0].sessionId)
  assert.equal(saved.trees.length, 1)
  assert.deepEqual(f.effects, { start: 0, send: 0 })
})

// T1352: the window of a set agent that never started showed only that it is
// not running; Start was reachable only inside Commands.
test('a set agent window offers Start in the window, or says why it cannot start yet', async t => {
  const f = await fixture(t)
  const view = await f.open()
  view.el.querySelector('[data-chat-new]').click()
  const field = await until(() => view.el.querySelector('[data-compose-field="message"]'), 'real Computers compose must mount')
  field.value = 'A task to start later'; field.dispatch('input')
  view.el.querySelector('[data-compose-action="set"]').click()
  const start = await until(() => view.el.querySelector('[data-workspace-start]'), 'the set agent window offers Start')
  assert.equal(start.textContent, 'Start this agent')
  const line = start.parentNode.querySelector('p')
  // This fixture keeps starting agents switched off, so the window says why.
  assert.equal(start.disabled, true)
  assert.ok(line.textContent.length > 0 && !/Start it here/.test(line.textContent), `the reason is shown: ${line.textContent}`)
  assert.deepEqual(f.effects, { start: 0, send: 0 })
})

test('saved local identities display a human computer name in Open picker, pane tab and window title', async t => {
  const f = await fixture(t)
  seedTreeNode(f.world.storage, { nodeId: 'home-naming-node', status: 'draft' })
  const key = fleetTreesStorageKey(THIS_COMPUTER_ID)
  const before = JSON.parse(f.world.storage.getItem(key))
  const view = await f.open()
  const local = options(view).find(option => option.value === `computer:${THIS_COMPUTER_ID}`)
  assert.equal(local?.textContent, THIS_COMPUTER_LABEL)
  const agent = options(view).find(option => option.value === `agent:${THIS_COMPUTER_ID}:home-naming-node`)
  assert.ok(agent?.textContent.includes(THIS_COMPUTER_LABEL))
  choose(view, local.value); await settle(8)
  assert.ok([...view.el.querySelectorAll('.home-chat-pane-title')].some(node => node.textContent === THIS_COMPUTER_LABEL))
  assert.ok([...view.el.querySelectorAll('[data-pane-tab]')].some(node => node.textContent.endsWith(THIS_COMPUTER_LABEL)))
  choose(view, agent.value); await settle(8)
  assert.ok([...view.el.querySelectorAll('.home-chat-pane-title')].some(node => node.textContent === agent.textContent))
  assert.equal(view.el.querySelector('.home-chat-pane-tabs').hidden, false)
  assert.ok([...view.el.querySelectorAll('[data-pane-tab]')].some(node => node.textContent.endsWith(agent.textContent)))
  assert.ok(!agent.textContent.includes(THIS_COMPUTER_ID), 'canonical key stays out of the agent display label')
  view.el.querySelector('[data-chat-commands]').click()
  assert.ok([...view.el.querySelectorAll('.home-chat-command-label')].some(node => node.textContent === `Focus ${THIS_COMPUTER_LABEL}`))
  const after = JSON.parse(f.world.storage.getItem(key))
  assert.equal(after.computerId, before.computerId)
  assert.deepEqual(after.nodes.map(node => node.id), before.nodes.map(node => node.id))
  assert.deepEqual(after.trees.map(tree => tree.id), before.trees.map(tree => tree.id))
})

// T1537: three agents each set in a new, unnamed tree were listed in the Open
// picker as 'tree-1-6a83ca13-...' and a chosen tree's window was titled by
// that id. Trees are named the way Computers names them.
test('unnamed trees are named the way Computers names them in the Open picker, pane tab and window title', async t => {
  const f = await fixture(t)
  const stamp = '2026-09-22T00:00:00.000Z'
  const tree = (id, name = null) => ({ id, name, createdAt: stamp, updatedAt: stamp, profileId: null })
  const node = (id, treeId, message = '') => ({ id, treeId, status: 'draft', createdAt: stamp, updatedAt: stamp, role: 'builder', message, statusNote: '', sessionId: null, parentId: null })
  f.world.storage.setItem(fleetTreesStorageKey(THIS_COMPUTER_ID), JSON.stringify({ version: 1, computerId: THIS_COMPUTER_ID,
    trees: [tree('tree-1-6a83ca13-23c4-4b8d'), tree('tree-1-2e7ae088-27a3-4c84'), tree('tree-1-c29b3818-1677-4c07', 'Release notes'), tree('tree-1-9f0e7d6c-5b4a-4938')],
    nodes: [node('node-a', 'tree-1-6a83ca13-23c4-4b8d'), node('node-b', 'tree-1-2e7ae088-27a3-4c84'), node('node-c', 'tree-1-c29b3818-1677-4c07'),
      node('node-d', 'tree-1-9f0e7d6c-5b4a-4938', 'Tidy the downloads folder\nthen report')] }))
  const view = await f.open()
  const trees = options(view).filter(option => option.value.startsWith(`tree:${THIS_COMPUTER_ID}:`))
  assert.deepEqual(trees.map(option => option.textContent), ['Tree 1', 'Tree 2', 'Release notes', 'Tidy the downloads folder'])
  for (const option of options(view)) assert.doesNotMatch(option.textContent, /tree-1-/, 'no internal tree id is listed')
  choose(view, trees[1].value); await settle(8)
  assert.ok([...view.el.querySelectorAll('.home-chat-pane-title')].some(title => title.textContent === 'Tree 2'))
  assert.ok([...view.el.querySelectorAll('[data-pane-tab]')].some(tab => tab.textContent.endsWith('Tree 2')))
  for (const title of view.el.querySelectorAll('.home-chat-pane-title, [data-pane-tab]')) assert.doesNotMatch(title.textContent, /tree-1-/)
  assert.deepEqual(f.effects, { start: 0, send: 0 })
})

test('empty Everything states the empty result while an empty computer still offers Everything', async t => {
  const f = await fixture(t)
  const view = await f.open()
  choose(view, 'everything'); await settle(8)
  const note = view.el.querySelector('.home-scope-empty')
  assert.equal(note.hidden, false)
  assert.equal(note.textContent, 'No recorded runs yet.')
  choose(view, `computer:${THIS_COMPUTER_ID}`); await settle(8)
  assert.equal(note.hidden, false)
  assert.match(note.textContent, /Choose Everything/)
})

test('an empty relay Home does not acquire a synthetic local New chat destination', async t => {
  const f = await fixture(t, { source: 'relay' })
  const view = await f.open()
  assert.ok(!options(view).some(option => option.value === `computer:${THIS_COMPUTER_ID}`))
  assert.equal(view.el.querySelector('[data-chat-new]').disabled, true)
  assert.deepEqual(f.effects, { start: 0, send: 0 })
})

test('a saved remote computer keeps its own identity and remains the offered New chat destination', async t => {
  const f = await fixture(t, { source: 'relay' })
  const remote = 'fixture-remote-computer'
  seedTreeNode(f.world.storage, { computerId: remote, nodeId: 'remote-node', status: 'draft' })
  const view = await f.open()
  assert.ok(options(view).some(option => option.value === `computer:${remote}`))
  assert.ok(!options(view).some(option => option.value === `computer:${THIS_COMPUTER_ID}`))
  assert.equal(view.el.querySelector('[data-chat-new]').disabled, false)
  assert.equal(f.world.storage.getItem(fleetTreesStorageKey(THIS_COMPUTER_ID)), null)
})

test('example Full view keeps New chat read-only and creates no local tree', async t => {
  const f = await fixture(t, { source: 'mock' })
  const view = await f.open()
  const add = view.el.querySelector('[data-chat-new]')
  assert.equal(add.disabled, true)
  add.click(); await settle(8)
  assert.equal(view.el.querySelector('[data-compose-field="message"]'), null)
  assert.equal(f.world.storage.getItem(fleetTreesStorageKey(THIS_COMPUTER_ID)), null)
  assert.deepEqual(f.effects, { start: 0, send: 0 })
})

for (const source of ['local', 'mock']) {
  test(`default ${source} Home guide highlights assistant, tree and next-action content without opening Full view`, async t => {
    const f = await fixture(t, { source })
    const view = await f.mount()
    const guide = f.guide(view)
    const conceptSteps = new Map([[1, 'What an assistant is'], [4, 'What a tree is'], [12, 'Decide what happens next']])
    for (let step = 1; step <= 12; step++) {
      guide.next()
      const note = guide.layer.querySelector('.first-use-availability')
      const highlight = guide.layer.querySelector('.first-use-highlight')
      if (conceptSteps.has(step)) {
        assert.equal(guide.layer.querySelector('h2').textContent, conceptSteps.get(step))
        assert.equal(note.hidden, true, `step ${step} has a visible target`)
        assert.equal(highlight.hidden, false, `step ${step} highlights that target`)
        assert.ok(Number.parseFloat(highlight.style.width) > 0)
        assert.ok(Number.parseFloat(highlight.style.height) > 0)
      }
      if (source === 'mock' && (step === 9 || step === 10)) {
        assert.equal(note.hidden, false)
        assert.match(note.textContent, /example/i, 'example message limitation stays explicit')
        assert.equal(highlight.hidden, true)
      }
    }
    assert.equal(view.el.querySelector('[data-chat-takeover]').hidden, true)
    assert.deepEqual(f.effects, { start: 0, send: 0 })
  })
}
