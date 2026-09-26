/* THE PAGE ACTUALLY HANDS DOWN WHAT MAKES A SOLO AGENT SOMEBODY.
 *
 * tree-standalone-agent.test.mjs proves the far end: given a seat and a
 * binder, the start carries the seat's roleBinding, and the App permissions
 * roster can then name the agent and computer control can be granted to it.
 * Both of those cases supply their own binder, so both stay green if
 * src/views/computers.js quietly stops passing one -- the wire would be
 * intact and nothing would be travelling down it.
 *
 * So this mounts the REAL Computers view and asks the object it actually
 * builds. It asserts the two things that make the injection real: that a
 * binder is offered at all, and that what it answers is this page's own
 * roleBindingForStart rather than a placeholder -- which is measured by its
 * refusal being a NAMED one from that function's own vocabulary, for a seat
 * the Role library has never heard of.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { fleetFetch, installWorld, settle, COMPUTER_ID } from './lib/tree-command-real-mount.mjs'
register('./helpers/css-stub-loader.mjs', import.meta.url)

async function mountRealComputersView(t) {
  const world = await installWorld(fleetFetch(), { asyncFrames: true })
  let view = null
  t.after(() => { try { view?.destroy() } finally { world.restore() } })
  const { computersView } = await import('../../src/views/computers.js')
  view = computersView({ initialComputer: COMPUTER_ID, navigate: () => {} })
  document.body.appendChild(view.el)
  await settle()
  const graph = globalThis.window?.__mcGraph
  assert.ok(graph, 'the real Computers view did not publish its graph, so this case measures nothing')
  return { view, graph }
}

test('the Computers view hands the solo surface a seat declarer and a seat binder', async t => {
  const { graph } = await mountRealComputersView(t)
  const injection = graph.standaloneAgent
  assert.ok(injection, 'the solo surface is given no host injection at all')

  /* Declaring the seat is what puts a solo agent in the org record. */
  assert.equal(typeof injection.declareSeat, 'function',
    'without a declarer the roster shows a raw session id, which is the complaint this closes')
  /* Binding it is what tells the host WHICH agent the session is. These are
     two different things and the product needs both: measured at an earlier commit,
     treeIdentity carries selfName and managerName only, so roleBinding is the
     single route by which an agentId reaches shell/main.cjs. */
  assert.equal(typeof injection.roleBindingFor, 'function',
    'THE DEFECT: the page declares a seat and then never tells the host the session belongs to it')
  /* And the chat it serves is this page's own, which is what "reuse the chat
     surface" meant. Kept here because all three arrive together or the solo
     agent is a different kind of thing from a tree agent again. */
  assert.equal(typeof injection.chatConfigFor, 'function')
})

test('the binder is this page own role binding, not a stand-in that always agrees', async t => {
  const { graph } = await mountRealComputersView(t)
  const seat = { id: 'standalone-never-declared', name: 'Agent 1', role: 'worker', tier: 'astra' }
  const answer = await graph.standaloneAgent.roleBindingFor(seat)

  assert.ok(answer && typeof answer === 'object', 'the binder answered nothing')
  assert.equal(typeof answer.ok, 'boolean', 'a binder must give a verdict, not a value that is merely truthy')
  if (answer.ok) {
    /* If this page could bind it, the binding has to name THIS seat and carry
       the two revisions the host checks. A binding without them is refused
       AGENT_ROLE_BINDING_INVALID and the person is told nothing useful. */
    assert.equal(answer.binding.agentId, seat.id, 'a binding that names another agent is worse than none')
    assert.equal(Number.isSafeInteger(answer.binding.expectedOrgRevision), true)
    assert.equal(Number.isSafeInteger(answer.binding.expectedRoleRevision), true)
  } else {
    /* A refusal is the ordinary answer for a seat this Role library has never
       been told about, and it must be a NAMED one. A bare false, or a code
       from nowhere, would mean the injection is a placeholder rather than the
       page's own roleBindingForStart. */
    assert.match(answer.code, /^MC_TREE_IDENTITY_/,
      'the refusal did not come from this page own identity vocabulary, so the binder is a stand-in')
    assert.equal(typeof answer.message === 'string' && answer.message.length > 0, true,
      'a refusal that cannot be said out loud leaves the person with nothing')
  }
})

/* B6 (found by hand on the installed 1.0.46, 2026-09-25): a Computers view that outlived its page
   minted role bindings from the org copy it mounted with (revision 3 while the host was at 12), so
   the host refused every standalone start MC_AGENT_ROLE_STALE. The binder must mint from the org as
   the host has it NOW. */
test('B6: the binder mints from the host org as it is now, not the copy the page mounted with', async t => {
  const world = await installWorld(fleetFetch(), { asyncFrames: true })
  let view = null
  t.after(() => { try { view?.destroy() } finally { world.restore() } })
  let revision = 3
  const seatId = 'standalone-b6-seat'
  const read = async () => ({
    ok: true,
    org: { revision, agents: [{ id: seatId, role: 'worker', enabled: true, provider: 'codex', displayName: 'Agent 1' }] },
    roles: [{ id: 'worker', name: 'Worker', revision: 0, directions: '', capabilities: {} }],
  })
  globalThis.mcOrg = globalThis.window.mcOrg = { read }
  const { computersView } = await import('../../src/views/computers.js')
  view = computersView({ initialComputer: COMPUTER_ID, navigate: () => {} })
  document.body.appendChild(view.el)
  await settle()
  const graph = globalThis.window?.__mcGraph
  assert.ok(graph?.standaloneAgent?.roleBindingFor, 'the real Computers view published no binder')

  revision = 12 // the host moved on after the page read its copy (seats declared, a sweep, another window)
  const answer = await graph.standaloneAgent.roleBindingFor({ id: seatId, name: 'Agent 1', role: 'worker', tier: 'astra' })
  assert.equal(answer?.ok, true, `the binder refused: ${JSON.stringify(answer)}`)
  assert.equal(answer.binding.agentId, seatId)
  assert.equal(answer.binding.expectedOrgRevision, 12, 'the binding carries the revision the page mounted with, which the host refuses as stale')
})

/* B4 step 9 (1.0.48): the seat is declared for the program the tab OPENED on. The host takes the
   binding's provider from the seat (shell/agent-org-record.cjs) and refuses a start whose session
   runs on another one (shell/agent-host.cjs, AGENT_ROLE_BINDING_INVALID). So a tab switched from
   Sonnet to a Codex program -- or one reopened after a restart on a program that changed -- was
   refused at its next send. The send must re-declare the seat for the program it actually starts
   on, and only then mint the binding, from the organisation that re-declaration left behind. */
function mutableOrg(seatId) {
  const org = { revision: 4, agents: [] }
  const ensured = []
  const read = async () => ({ ok: true, org: structuredClone(org),
    roles: [{ id: 'worker', name: 'Worker', revision: 2, directions: '', capabilities: {} }] })
  const ensureSeat = async request => {
    ensured.push(structuredClone(request))
    if (request.expectedRevision !== org.revision) return { ok: false, code: 'ORG_REVISION_CONFLICT', reason: 'stale' }
    const existing = org.agents.find(agent => agent.id === request.id)
    if (existing) Object.assign(existing, { provider: request.provider ?? existing.provider, role: request.role, enabled: true })
    else org.agents.push({ id: request.id, role: request.role, enabled: true, provider: request.provider ?? 'claude', displayName: request.displayName })
    org.revision += 1
    return { ok: true, org: structuredClone(org) }
  }
  return { org, ensured, read, ensureSeat, seatId }
}

test('B4: the binder re-declares the seat for the program being started, then mints from the org that left', async t => {
  const world = await installWorld(fleetFetch(), { asyncFrames: true })
  let view = null
  t.after(() => { try { view?.destroy() } finally { world.restore() } })
  const seatId = 'standalone-b4-program-seat'
  const org = mutableOrg(seatId)
  org.org.agents.push({ id: seatId, role: 'worker', enabled: true, provider: 'claude', displayName: 'Agent 1' })
  globalThis.mcOrg = globalThis.window.mcOrg = { read: org.read, ensureSeat: org.ensureSeat }
  const { computersView } = await import('../../src/views/computers.js')
  view = computersView({ initialComputer: COMPUTER_ID, navigate: () => {} })
  document.body.appendChild(view.el)
  await settle()
  const graph = globalThis.window?.__mcGraph
  assert.ok(graph?.standaloneAgent?.roleBindingFor, 'the real Computers view published no binder')
  const seat = { id: seatId, name: 'Agent 1', role: 'worker', tier: 'claude-sonnet' }

  // Same provider as the seat already has: nothing to write, the binding is minted as before.
  const same = await graph.standaloneAgent.roleBindingFor(seat, { tier: 'claude-opus' })
  assert.equal(same?.ok, true, `the binder refused: ${JSON.stringify(same)}`)
  assert.equal(org.ensured.length, 0, 'a seat already on this provider was written again')

  // Another provider: the seat is re-declared for it before the binding is minted.
  const other = await graph.standaloneAgent.roleBindingFor(seat, { tier: 'luna' })
  assert.equal(org.ensured.length, 1, 'THE DEFECT: the seat still names the program the tab opened on, so the host refuses this start')
  assert.equal(org.ensured[0].id, seatId)
  assert.equal(org.ensured[0].provider, 'codex')
  assert.equal(org.ensured[0].adoptProvider, true, 'without adoption the store keeps the old provider')
  assert.equal(other?.ok, true, `the binder refused: ${JSON.stringify(other)}`)
  assert.equal(other.binding.agentId, seatId)
  assert.equal(other.binding.expectedOrgRevision, org.org.revision, 'the binding pins the revision from before the seat was re-declared')
})

test('B4: a New agent tab switched to another program re-declares its seat at the send, before the start', async t => {
  const world = await installWorld(fleetFetch(), { asyncFrames: true })
  let view = null
  t.after(() => { try { view?.destroy() } finally { world.restore() } })
  const org = mutableOrg(null)
  globalThis.mcOrg = globalThis.window.mcOrg = { read: org.read, ensureSeat: org.ensureSeat }
  const order = []
  const listeners = new Set()
  Object.assign(world.bridge, {
    availability: async () => ({ ok: true }),
    confinement: async () => ({ ok: true, tier: 'standard' }),
    onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    ownerContext: async () => ({ version: 1, ownerId: 'b4-owner', currentEpoch: 'b4-epoch', kind: 'local' }),
    onOwnerContextChanged: () => () => {},
    start: async value => { order.push(['start', value]); return { sessionId: value.sessionId } },
    send: async value => { order.push(['send', value]); return { turnId: `${value.sessionId}:turn-1` } },
    interrupt: async () => ({ ok: true }),
  })
  const ensureSeat = org.ensureSeat
  globalThis.window.mcOrg.ensureSeat = async request => { order.push(['ensure', request.provider]); return ensureSeat(request) }
  const { computersView } = await import('../../src/views/computers.js')
  view = computersView({ initialComputer: COMPUTER_ID, navigate: () => {} })
  document.body.appendChild(view.el)
  await settle()
  const graph = globalThis.window?.__mcGraph
  assert.ok(graph?.workspace, 'the real Computers view published no workspace')
  await graph.workspace.openStandalone({ tier: 'claude-sonnet', effort: null })
  await settle()
  const [record] = [...graph.workspace.standalone.values()]
  assert.equal(Boolean(record), true, 'fixture premise: the New agent tab opened')
  assert.deepEqual(order.map(([kind, value]) => [kind, value]).filter(([kind]) => kind === 'ensure'), [['ensure', 'claude']],
    'fixture premise: the seat was declared on the program the tab opened on')
  assert.equal(record.session.chooseStart({ tier: 'luna' }).ok, true)
  const input = record.chatPanel.querySelector('.chat-input textarea')
  input.value = 'hello'
  input.dispatch('input')
  record.chatPanel.querySelector('[data-chat-panel] .chat-send').click()
  await settle()
  const start = order.findIndex(([kind]) => kind === 'start')
  assert.notEqual(start, -1, 'fixture premise: the send started a session')
  const redeclared = order.findIndex(([kind, provider]) => kind === 'ensure' && provider === 'codex')
  assert.notEqual(redeclared, -1, 'THE DEFECT: the seat was never re-declared for the program the start runs on')
  assert.equal(redeclared < start, true, 'the seat must be re-declared before the start')
  const started = order[start][1]
  assert.equal(started.tier, 'luna')
  assert.equal(started.roleBinding?.agentId, record.id)
  assert.equal(started.roleBinding?.expectedOrgRevision, org.org.revision, 'the start carries a binding minted before the seat changed')
})

/* B4 review (1.0.48), D13. Each agent-tab start read the organisation twice: the binder's own
   re-read (B6) and ensureSeatForNode's. readOrg shares no read in flight, and each one also redraws
   the tree names and edit availability. One read is enough -- and it must still be the one a view
   that has gone away adopts (B6). */
test('B4: a start that re-declares the seat reads the organisation once, and a gone view still mints from it', async t => {
  const world = await installWorld(fleetFetch(), { asyncFrames: true })
  let view = null
  t.after(() => { try { view?.destroy() } finally { world.restore() } })
  const seatId = 'standalone-b4-one-read'
  const org = mutableOrg(seatId)
  org.org.agents.push({ id: seatId, role: 'worker', enabled: true, provider: 'codex', displayName: 'Agent 1' })
  let reads = 0
  globalThis.mcOrg = globalThis.window.mcOrg = { read: async () => { reads++; return org.read() }, ensureSeat: org.ensureSeat }
  const { computersView } = await import('../../src/views/computers.js')
  view = computersView({ initialComputer: COMPUTER_ID, navigate: () => {} })
  document.body.appendChild(view.el)
  await settle()
  const graph = globalThis.window?.__mcGraph
  assert.ok(graph?.standaloneAgent?.roleBindingFor, 'the real Computers view published no binder')
  const seat = { id: seatId, name: 'Agent 1', role: 'worker', tier: 'astra' }

  reads = 0
  const same = await graph.standaloneAgent.roleBindingFor(seat, { tier: 'astra' })
  assert.equal(same?.ok, true, `the binder refused: ${JSON.stringify(same)}`)
  assert.equal(reads, 1, `THE DEFECT: one start read the organisation ${reads} times`)

  // The page is left; the host moves on; the tab it made still starts.
  view.destroy(); view.el.remove(); view = null
  org.org.revision = 21
  reads = 0
  const later = await graph.standaloneAgent.roleBindingFor(seat, { tier: 'astra' })
  assert.equal(later?.ok, true, `the binder refused after the page went away: ${JSON.stringify(later)}`)
  assert.equal(later.binding.expectedOrgRevision, 21, 'a gone view minted from the organisation it mounted with (B6)')
  assert.equal(reads, 1)
})
