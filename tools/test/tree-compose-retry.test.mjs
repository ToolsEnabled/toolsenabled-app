import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { fleetTreesStorageKey } from '../../src/fleet-trees.js'
register('./helpers/css-stub-loader.mjs', import.meta.url)
const { installWorld, fleetFetch, seedTreeNode, mountView, settle } = await import('./lib/tree-command-real-mount.mjs')

let serial = 0
async function mount(t, { sendFails = false, workspace = false, child = false, rootRole = false } = {}) {
  const computerId = `compose-retry-${++serial}`
  const world = await installWorld(fleetFetch({ computerId }), { asyncFrames: true })
  const priorOrg = Object.getOwnPropertyDescriptor(globalThis, 'mcOrg')
  world.storage.setItem('mc.write.agent-session', 'enabled')
  world.storage.setItem('mc.set.tree_style', 'boxes')
  window.mcSetup = { workspaceState: async () => ({ ok: true, available: true, chosen: true, roots: ['/fixture/setup'] }) }
  world.bridge.profiles = async () => ({ ok: true, profiles: [{ id: 'fixture-folder', name: 'Fixture folder', cwd: '/fixture/named' }] })
  world.bridge.startableTiers = async () => ({ ok: true, tiers: ['luna', 'grok'] })
  world.bridge.confinement = async () => ({ ok: true, tier: 'guided', sandbox: 'read-only', approvalPolicy: 'never', isolated: true, recorded: true })
  const starts = [], sends = []
  world.bridge.start = async request => {
    starts.push(request)
    return starts.length === 1 && !sendFails ? { ok: false } : { ok: true, sessionId: `compose-session-${serial}`, threadId: 'fixture-thread' }
  }
  world.bridge.send = async request => { sends.push(request); return sendFails ? { ok: false } : { turnId: 'fixture-turn' } }
  const org = { revision: 1, source: 'overlay', agents: rootRole ? [{ id: 'controller', role: 'controller', provider: 'none', enabled: true }] : [], edges: [] }
  const roles = [{ id: 'worker', name: 'Worker', revision: 1, capabilities: {} }, { id: 'builder', name: 'Builder', revision: 1, capabilities: {} },
    ...(rootRole ? [{ id: 'controller', name: 'Controller', revision: 1, capabilities: { orgRoot: true } }] : [])]
  globalThis.mcOrg = window.mcOrg = {
    read: async () => ({ ok: true, org, roles }),
    ensureSeat: async request => {
      org.revision++
      const existing = org.agents.find(agent => agent.id === request.id)
      if (existing) {
        assert.equal(existing.role, request.role)
        if (request.adoptProvider === true) existing.provider = request.provider
      } else org.agents.push({ id: request.id, role: request.role, provider: request.provider, enabled: true })
      return { ok: true, org }
    },
  }
  const parentId = child ? `parent-${serial}` : null
  if (child) seedTreeNode(world.storage, { computerId, nodeId: parentId, status: 'draft', treeId: 'saved-parent-tree' })
  let view, host, surface
  const subjects = []
  if (workspace) {
    const { computersView } = await import('../../src/views/computers.js')
    view = computersView({ initialComputer: computerId, navigate() {}, chatWorkspace: true })
    document.body.appendChild(view.el)
    await view.chatWorkspace.ready
    await settle()
    host = document.createElement('div')
    document.body.appendChild(host)
  } else {
    view = await mountView(world, { computerId })
    host = view.el
  }
  t.after(() => { surface?.dispose(); view.destroy(); if (workspace) host.remove(); if (priorOrg) Object.defineProperty(globalThis, 'mcOrg', priorOrg); else delete globalThis.mcOrg; world.restore() })
  const open = async () => {
    if (workspace) {
      surface?.dispose()
      surface = await view.chatWorkspace.newChat(host, { onSubjectCreated: subject => subjects.push(subject) })
    } else if (child) {
      const slot = view.el.querySelectorAll('.static-tree-node').find(node => node.dataset.agentId === parentId)?.querySelector('.tree-box-add-agent')
      assert.ok(slot)
      slot.dispatch('click')
    } else {
      view.el.querySelector('.tree-chat-add').dispatch('click')
      view.el.querySelector('.tree-new-tree').dispatch('click')
    }
    await settle(6)
    const role = host.querySelector('[data-compose-field="role"]')
    assert.ok(role)
    role.value = rootRole ? 'controller' : 'worker'; role.dispatch('change')
    const tier = host.querySelector('[data-compose-field="tier"]')
    tier.value = 'grok'; tier.dispatch('change')
  }
  const edit = text => {
    const input = host.querySelector('[data-compose-field="message"]')
    assert.ok(input)
    input.value = text; input.dispatch('input')
  }
  const press = async (action = 'start') => {
    const button = host.querySelector(`[data-compose-action="${action}"]`)
    assert.ok(button)
    button.dispatch('click')
    await settle(20)
  }
  const saved = () => JSON.parse(world.storage.getItem(fleetTreesStorageKey(computerId)))
  await open(); edit('One bounded task')
  return { view, host, world, computerId, parentId, subjects, starts, sends, open, edit, press, saved }
}

test('page-2 header creates separate trees without a second canvas creation button', async t => {
  const f = await mount(t)
  const lower = () => f.view.el.querySelectorAll('.tree-empty-node[data-empty-kind="new-tree"]')
  assert.equal(lower().length, 0)
  assert.equal(f.view.el.querySelectorAll('.tree-chat-add').length, 1)
  await f.press('set')
  const first = f.saved()
  assert.equal(first.trees.length, 1)
  assert.equal(first.nodes.length, 1)
  assert.equal(first.nodes[0].parentId, null)
  assert.equal(first.nodes[0].message, 'One bounded task')
  assert.equal(lower().length, 0)
  await f.open()
  f.edit('Another separate tree from the header')
  await f.press('set')
  const after = f.saved()
  assert.equal(after.trees.length, 2)
  assert.equal(after.nodes.length, 2)
  assert.equal(new Set(after.nodes.map(node => node.treeId)).size, 2)
  assert.equal(after.nodes.filter(node => node.parentId === null).length, 2)
  assert.equal(after.nodes.find(node => node.id === first.nodes[0].id).message, first.nodes[0].message)
  assert.equal(lower().length, 0)
  assert.equal(f.starts.length, 0, 'Set creates drafts without starting provider sessions')
})

test('mounted compose retries a refused first start on its original node and tree, using the edited brief', async t => {
  const f = await mount(t)
  await f.press()
  assert.equal(f.starts.length, 1)
  const before = f.saved()
  assert.equal(before.nodes.length, 1)
  assert.equal(before.nodes[0].status, 'failed')
  assert.equal(before.nodes[0].sessionId, null)
  f.edit('Edited retry task')
  await f.press()
  const after = f.saved()
  assert.equal(after.nodes.length, 1, 'Retry must not create a second agent')
  assert.equal(after.trees.length, 1, 'Retry must not create a second tree')
  assert.equal(after.nodes[0].id, before.nodes[0].id)
  assert.equal(after.nodes[0].treeId, before.nodes[0].treeId)
  assert.equal(after.nodes[0].message, 'Edited retry task')
  assert.equal(f.starts.length, 2)
  assert.equal(f.starts[1].roleBinding.agentId, f.starts[0].roleBinding.agentId)
  assert.equal(f.sends.length, 1)
  assert.match(f.sends[0].text, /Edited retry task/)
})

test('mounted compose Set after a refused first start saves the edited existing draft without another launch', async t => {
  const f = await mount(t)
  await f.press()
  const before = f.saved().nodes[0]
  f.edit('Keep this corrected task for later')
  await f.press('set')
  const after = f.saved()
  assert.equal(after.nodes.length, 1)
  assert.equal(after.nodes[0].id, before.id)
  assert.equal(after.nodes[0].status, 'draft')
  assert.equal(after.nodes[0].message, 'Keep this corrected task for later')
  assert.equal(f.starts.length, 1)
})

test('mounted compose cannot spawn a replacement when the first message failed on an attached session', async t => {
  const f = await mount(t, { sendFails: true })
  await f.press()
  const before = f.saved().nodes[0]
  assert.ok(before.sessionId)
  await f.press()
  assert.equal(f.saved().nodes.length, 1)
  assert.equal(f.saved().nodes[0].id, before.id)
  assert.equal(f.saved().nodes[0].sessionId, before.sessionId)
  assert.equal(f.starts.length, 1, 'An existing session must not be replaced by the compose form')
  assert.equal(f.sends.length, 1)
})

test('the shared workspace new-chat form retries the same saved identity', async t => {
  const f = await mount(t, { workspace: true })
  await f.press()
  const before = f.saved().nodes[0]
  f.edit('Corrected workspace task')
  await f.press()
  assert.equal(f.saved().nodes.length, 1)
  assert.equal(f.saved().nodes[0].id, before.id)
  assert.equal(f.saved().nodes[0].message, 'Corrected workspace task')
  assert.equal(f.starts.length, 2)
  assert.deepEqual([...new Set(f.subjects.map(subject => subject.agentId))], [before.id])
})

test('a child retry preserves its parent, tree and sibling count', async t => {
  const f = await mount(t, { child: true })
  await f.press()
  const before = f.saved()
  const child = before.nodes.find(node => node.id !== f.parentId)
  assert.equal(child.status, 'failed')
  await f.press()
  const after = f.saved()
  assert.equal(after.nodes.length, 2)
  assert.equal(after.trees.length, 1)
  const retried = after.nodes.find(node => node.id === child.id)
  assert.equal(retried.parentId, f.parentId)
  assert.equal(retried.treeId, child.treeId)
  assert.deepEqual(after.nodes.find(node => node.id === f.parentId), before.nodes.find(node => node.id === f.parentId))
})

test('clearing the failed root form folder updates the original tree before retry', async t => {
  const f = await mount(t)
  const folder = f.host.querySelector('[data-compose-field="profile"]')
  folder.value = 'fixture-folder'; folder.dispatch('change')
  await f.press()
  assert.equal(f.saved().trees[0].profileId, 'fixture-folder')
  folder.value = ''; folder.dispatch('change')
  await f.press()
  assert.equal(f.saved().trees.length, 1)
  assert.equal(f.saved().trees[0].profileId, null)
  assert.equal(f.starts[0].profileId, 'fixture-folder')
  assert.equal(f.starts[1].profileId, undefined)
})

test('revoking Start after failure prevents a launch but Set still saves that same draft', async t => {
  const f = await mount(t)
  await f.press()
  const before = f.saved().nodes[0]
  f.world.storage.setItem('mc.write.agent-session', 'disabled')
  await f.press()
  assert.equal(f.starts.length, 1)
  assert.equal(f.saved().nodes.length, 1)
  f.edit('Keep my work while starts are disabled')
  await f.press('set')
  assert.equal(f.saved().nodes[0].id, before.id)
  assert.equal(f.saved().nodes[0].status, 'draft')
  assert.equal(f.saved().nodes[0].message, 'Keep my work while starts are disabled')
  assert.equal(f.starts.length, 1)
})

test('a failed retry save never launches or creates another node, and a later save can retry', async t => {
  const f = await mount(t)
  await f.press()
  const before = f.saved()
  const save = f.world.storage.setItem
  f.world.storage.setItem = (key, value) => { if (key === fleetTreesStorageKey(f.computerId)) throw new Error('fixture quota'); return save(key, value) }
  await f.press()
  assert.equal(f.starts.length, 1)
  assert.deepEqual(f.saved(), before)
  f.world.storage.setItem = save
  await f.press()
  assert.equal(f.starts.length, 2)
  assert.equal(f.saved().nodes.length, 1)
  assert.equal(f.saved().nodes[0].id, before.nodes[0].id)
})

test('a cancelled failed form and a newly opened form create distinct intended agents', async t => {
  const f = await mount(t)
  await f.press()
  const first = f.saved().nodes[0]
  await f.press('cancel')
  await f.open()
  f.edit('A deliberately new task')
  await f.press('set')
  const after = f.saved()
  assert.equal(after.nodes.length, 2)
  assert.equal(after.trees.length, 2)
  assert.deepEqual(after.nodes.find(node => node.id === first.id), first)
  assert.equal(after.nodes.find(node => node.id !== first.id).message, 'A deliberately new task')
  assert.equal(f.starts.length, 1)
})

for (const field of ['role', 'tier']) for (const action of ['start', 'set']) {
  test(`a declared first-start identity rejects changed ${field} on ${action} without losing the typed brief`, async t => {
    const f = await mount(t)
    await f.press()
    const before = f.saved().nodes[0]
    const control = f.host.querySelector(`[data-compose-field="${field}"]`)
    control.value = field === 'role' ? 'builder' : 'luna'; control.dispatch('change')
    f.edit('Keep this new typed brief')
    await f.press(action)
    assert.equal(f.starts.length, 1)
    assert.equal(f.saved().nodes.length, 1)
    assert.equal(f.saved().nodes[0].id, before.id)
    assert.equal(f.saved().nodes[0].role, before.role)
    assert.equal(f.saved().nodes[0].tier, before.tier)
    assert.equal(f.host.querySelector('[data-compose-field="message"]').value, 'Keep this new typed brief')
    assert.match(f.host.querySelector('[data-compose-notice="panel"]').textContent, /saved role and provider|original agent/i)
  })
}

test('replacing a form during retry authority refresh leaves its old failed node untouched', async t => {
  const f = await mount(t)
  await f.press()
  const before = f.saved().nodes[0]
  const read = window.mcOrg.read
  let release
  window.mcOrg.read = async () => { await new Promise(resolve => { release = resolve }); return read() }
  await f.press()
  assert.equal(typeof release, 'function', 'The actual retry must wait for current role authority')
  await f.open()
  f.edit('A new intentional form')
  await f.press('set')
  window.mcOrg.read = read
  release()
  await settle(20)
  assert.equal(f.starts.length, 1)
  assert.equal(f.saved().nodes.length, 2)
  assert.deepEqual(f.saved().nodes.find(node => node.id === before.id), before)
})

test('an initial root-role Start may adopt its native provider before a retained retry', async t => {
  const f = await mount(t, { rootRole: true })
  await f.press()
  assert.equal(f.starts.length, 1)
  assert.equal(f.starts[0].roleBinding.agentId, 'controller')
  const before = f.saved().nodes[0]
  assert.equal(before.status, 'failed')
  await f.press()
  assert.equal(f.starts.length, 2)
  assert.equal(f.saved().nodes.length, 1)
  assert.equal(f.saved().nodes[0].id, before.id)
})
