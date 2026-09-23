import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
register('./helpers/css-stub-loader.mjs', import.meta.url)
const { installWorld, fleetFetch, seedTreeNode, mountView, settle } = await import('./lib/tree-command-real-mount.mjs')

let serial = 0
async function mount(t, { setupFolder = '/fixture/setup-workspace', holdReads = false } = {}) {
  const world = await installWorld(fleetFetch(), { asyncFrames: true })
  const nodeId = `details-node-${++serial}`
  const ledgers = new Map()
  const held = []
  let holding = holdReads
  let filed = 0
  window.mcSetup = { workspaceState: async () => ({ ok: true, available: true, chosen: true, roots: [setupFolder] }) }
  world.bridge.profiles = async () => ({ ok: true, profiles: [{ id: 'named', name: 'Named folder', cwd: '/fixture/named-folder' }] })
  world.bridge.request = async ({ scope, key, words }) => {
    const id = `${scope}:${key || ''}`
    const recordId = `R${++filed}`
    ledgers.set(id, [...(ledgers.get(id) || []), { id: recordId, words }])
    return { ok: true, id: recordId }
  }
  world.bridge.requests = async ({ scope, key }) => {
    const answer = { ok: true, entries: [...(ledgers.get(`${scope}:${key || ''}`) || [])] }
    return holding ? new Promise(resolve => held.push(() => resolve(answer))) : answer
  }
  world.bridge.requestEdit = async () => ({ ok: true })
  world.bridge.requestRemove = async () => ({ ok: true })
  seedTreeNode(world.storage, { nodeId, sessionId: `details-session-${serial}`, status: 'finished' })
  const view = await mountView(world)
  t.after(() => { holding = false; held.splice(0).forEach(release => release()); view.destroy(); world.restore() })
  const circle = view.el.querySelectorAll('.static-tree-node').find(node => node.dataset.agentId === nodeId)
  circle.dispatch('keydown', { key: 'Enter', shiftKey: true })
  await settle(5)
  const profile = view.el.querySelector('[data-tree-profile]')
  Object.defineProperty(profile, 'selectedOptions', { get: () => profile.querySelectorAll('option').filter(option => option.value === profile.value) })
  view.el.querySelector('[data-rail-tab="details"]').dispatch('click')
  const body = view.el.querySelector('[data-requests-body]')
  const card = view.el.querySelectorAll('.static-tree-node').find(node => node.dataset.agentId === nodeId)
  assert.ok(card && card.isConnected && !card.hidden, 'the agent card is mounted on the tree canvas')
  card.dispatch('keydown', { key: 'Enter' })
  await settle(5)
  const chat = view.el.querySelector('.tree-conversation .chat')
  const input = chat?.querySelector('.chat-input input')
  assert.ok(input, 'the real canvas card must have a composer')
  const send = async text => { input.value = text; input.dispatch('input'); chat.querySelector('.chat-send').dispatch('click'); await settle(10) }
  return { view, world, body, send, ledgers, nodeId, releaseReads() { holding = false; held.splice(0).forEach(release => release()) }, stopHolding() { holding = false } }
}

test('a rule filed from a canvas chat refreshes the already-open Details panel', async t => {
  const f = await mount(t)
  assert.match(f.body.textContent, /No rules written/)
  await f.send('/RequestTree Keep work in the selected workspace.')
  assert.match(f.body.textContent, /Keep work in the selected workspace\./)
  assert.doesNotMatch(f.body.textContent, /No rules written/)
  assert.equal(f.view.el.querySelector('[data-rail-body="details"]').hidden, false)
})

test('an older ledger read cannot erase the newly filed rule', async t => {
  const f = await mount(t, { holdReads: true })
  f.stopHolding()
  await f.send('/RequestTree Keep the newer rule visible.')
  assert.match(f.body.textContent, /Keep the newer rule visible\./)
  f.releaseReads()
  await settle(5)
  assert.match(f.body.textContent, /Keep the newer rule visible\./)
})

test('filing another rule does not discard an edit already open in Details', async t => {
  const f = await mount(t)
  await f.send('/RequestTree Keep this rule editable.')
  const edit = f.body.querySelectorAll('button').find(button => button.textContent === 'Edit')
  assert.ok(edit)
  edit.dispatch('click')
  const editor = f.body.querySelector('[data-request-editor]')
  assert.ok(editor)
  editor.value = 'An unsaved correction stays here.'
  await f.send('/RequestTree A second rule arrives from the canvas.')
  // The DOM stand-in does not derive textarea.value from its initial text.
  const retained = f.body.querySelector('[data-request-editor]')
  assert.equal(retained?.value || retained?.textContent, 'An unsaved correction stays here.')
  assert.match(f.body.textContent, /A second rule arrives from the canvas\./)
})

test('Details names the setup folder when the tree has no named profile', async t => {
  const f = await mount(t)
  const profile = f.view.el.querySelector('[data-tree-profile]')
  const option = profile.querySelectorAll('option').find(item => item.value === '')
  assert.match(option.textContent, /\/fixture\/setup-workspace/)
  assert.doesNotMatch(option.textContent, /product’s own workspace/)
})

test('clearing a named tree profile reports the actual setup folder for future starts', async t => {
  const f = await mount(t)
  const profile = f.view.el.querySelector('[data-tree-profile]')
  profile.value = 'named'
  profile.dispatch('change')
  profile.value = ''
  profile.dispatch('change')
  const message = f.view.el.querySelector('[data-tree-profile-out]').textContent
  assert.match(message, /\/fixture\/setup-workspace/)
  assert.doesNotMatch(message, /product’s own workspace/)
})
