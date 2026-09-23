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
     two different things and the product needs both: measured at 88bc31ae,
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
  const answer = graph.standaloneAgent.roleBindingFor(seat)

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
