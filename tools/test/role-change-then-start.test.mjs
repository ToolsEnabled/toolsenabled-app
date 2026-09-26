// B13 (users on 1.0.46, reproduced on the installed 1.0.47 candidate 2026-09-25): after a role
// was changed -- in the Role library, another window or by an agent -- no tree agent could start.
// The page's copy of the org and roles was read once when it mounted, so every start minted a
// binding carrying the OLD role revision, and the host refused it ("the organisation or role
// directions changed after this panel was opened. Reload this page..."). This mounts the real
// Computers view, changes the role on the host behind the page's back, and presses Start.
import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
register('./helpers/css-stub-loader.mjs', import.meta.url)
const { installWorld, fleetFetch, mountView, settle } = await import('./lib/tree-command-real-mount.mjs')

test('a tree agent started after its role changed carries the role as it is now', async t => {
  const computerId = 'role-change-then-start'
  const world = await installWorld(fleetFetch({ computerId }), { asyncFrames: true })
  const priorOrg = Object.getOwnPropertyDescriptor(globalThis, 'mcOrg')
  world.storage.setItem('mc.write.agent-session', 'enabled')
  world.storage.setItem('mc.set.tree_style', 'boxes')
  window.mcSetup = { workspaceState: async () => ({ ok: true, available: true, chosen: true, roots: ['/fixture/setup'] }) }
  world.bridge.profiles = async () => ({ ok: true, profiles: [] })
  world.bridge.startableTiers = async () => ({ ok: true, tiers: ['grok'] })
  world.bridge.confinement = async () => ({ ok: true, tier: 'guided', sandbox: 'read-only', approvalPolicy: 'never', isolated: true, recorded: true })
  const starts = []
  world.bridge.start = async request => { starts.push(request); return { ok: true, sessionId: 'role-change-session', threadId: 'fixture-thread' } }
  world.bridge.send = async () => ({ turnId: 'fixture-turn' })
  const org = { revision: 1, source: 'overlay', agents: [], edges: [] }
  const roles = [{ id: 'worker', name: 'Worker', revision: 1, capabilities: {} }]
  globalThis.mcOrg = window.mcOrg = {
    read: async () => ({ ok: true, org: structuredClone(org), roles: structuredClone(roles) }),
    ensureSeat: async request => {
      org.revision++
      if (!org.agents.some(agent => agent.id === request.id)) org.agents.push({ id: request.id, role: request.role, provider: request.provider, enabled: true })
      return { ok: true, org: structuredClone(org) }
    },
  }
  const view = await mountView(world, { computerId })
  t.after(() => { view.destroy(); if (priorOrg) Object.defineProperty(globalThis, 'mcOrg', priorOrg); else delete globalThis.mcOrg; world.restore() })

  // The person edits the Worker role somewhere this page does not hear about.
  roles[0].revision = 2
  org.revision++

  view.el.querySelector('.tree-chat-add').dispatch('click')
  view.el.querySelector('.tree-new-tree').dispatch('click')
  await settle(6)
  const role = view.el.querySelector('[data-compose-field="role"]'); role.value = 'worker'; role.dispatch('change')
  const tier = view.el.querySelector('[data-compose-field="tier"]'); tier.value = 'grok'; tier.dispatch('change')
  const input = view.el.querySelector('[data-compose-field="message"]'); input.value = 'One bounded task'; input.dispatch('input')
  view.el.querySelector('[data-compose-action="start"]').dispatch('click')
  await settle(30)

  assert.equal(starts.length, 1, 'the start reached the host')
  assert.equal(starts[0].roleBinding?.expectedRoleRevision, 2, 'the binding carries the role revision the host holds now, not the one the page mounted with')
  assert.equal(starts[0].roleBinding?.expectedOrgRevision, org.revision, 'and the org revision the host holds now')
})
