/* THE COMPUTER A CUSTOMER CAN ACTUALLY SEE, AND THE TREE THEY HAVE NOT FILLED YET.
 *
 * Measured on the packaged build with a fresh profile before this adapter
 * existed: /data/fleet.json ok:false, /data/agents.json ok:false,
 * window.mcOrg.read() ok:true with one declared agent — and zero nodes on the
 * fleet page. Both projections are build-time files; they ship `ok:false` on
 * every install and can never say anything else. The organisation record is the
 * only per-machine source either surface has, and it was read and discarded.
 *
 * WHAT THIS SUITE NOW HOLDS THAT IT DID NOT, and it is the opposite of what it
 * used to. It pinned that a fresh install DRAWS every declared agent, which was
 * a fair reading when the shipped default declared one controller and is a
 * defect now that it declares eight seats: a person who has started nothing
 * opened the page and found eight agents they did not create. The owner's rule
 * is "the node tree should be empty unless a user has started a session". So
 * the properties that suite was protecting — a seat for every engine a dispatch
 * can ask for, a manager for every seat — are still asserted here, against
 * CAPACITY, where they were always facts about the declaration rather than
 * about the graph.
 *
 * The packaged proof is tools/agent-route-reachability.mjs, which drives a real
 * window by clicking. This suite pins the decisions that harness cannot reach
 * from inside a packaged app — above all the EMPTY cases, because "nothing has
 * been started here" is the state every fresh computer opens in, and a state
 * nothing asserts is a state that quietly rots.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  declaredAgentsData, declaredCapacity, declaredFleetData,
  THIS_COMPUTER_ID, THIS_COMPUTER_LABEL,
} from '../../src/declared-fleet.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/* THE ORGANISATION A FRESH INSTALL ACTUALLY HOLDS — READ, NOT REMEMBERED.
 *
 * This fixture used to be a literal, annotated "measured from window.mcOrg.read()
 * in a packaged window with an isolated LOCALAPPDATA": one controller, no
 * relationships. That measurement was true when it was taken and is now false.
 * capability-defaults/config/agent-org.json is the file the build stages in
 * place of the builder's own organisation, and it declares a controller plus
 * the codex and claude seats a dispatch resolves against; before that, EVERY
 * dispatch on EVERY packaged install refused because no agent was declared for
 * any tier.
 *
 * So the fixture is now READ from that file rather than restated next to it. A
 * copy of a shipped default in a suite is a second declaration of it, and the
 * copy is the one nobody updates — this suite went on asserting a one-agent
 * fresh install for as long as it took somebody to notice. Reading the file
 * means the shipped default and the thing this suite calls "a fresh install"
 * cannot drift apart again, and it means the assertions below have to be about
 * PROPERTIES rather than about a count somebody typed. */
const SHIPPED_DEFAULT_ORG = JSON.parse(
  readFileSync(path.join(REPO, 'capability-defaults', 'config', 'agent-org.json'), 'utf8'),
)

/* The record shape the fleet page is handed, which is what the org store hands
   it: the declaration plus the revision and provenance the store adds. */
const FRESH_INSTALL_ORG = Object.freeze({
  revision: SHIPPED_DEFAULT_ORG.revision,
  source: 'baseline',
  agents: SHIPPED_DEFAULT_ORG.agents,
  relationships: SHIPPED_DEFAULT_ORG.relationships,
})

const TWO_AGENT_ORG = Object.freeze({
  revision: 4,
  source: 'overlay',
  agents: [
    { id: 'controller', displayName: 'Controller', role: 'controller', provider: 'none', enabled: true },
    { id: 'helper-1', displayName: 'Helper', role: 'manager', provider: 'codex', enabled: false },
  ],
  relationships: [{ from: 'controller', to: 'helper-1', type: 'manages' }],
})

/* What a caller hands over once a person has pressed start. The field names are
   src/agent-session-registry.js's, because that is the record a live session is
   published as and this adapter must take it without a translation layer in
   between. */
const started = (agentId, extra = {}) => ({ agentId, sessionId: `s-${agentId}`, phase: 'open', ...extra })

test('the shipped organisation is neutral and reserves four Claude worker seats', () => {
  const controllers = SHIPPED_DEFAULT_ORG.agents.filter((agent) => agent.enabled && agent.role === 'controller')
  assert.equal(controllers.length, 1)
  assert.deepEqual(
    { id: controllers[0].id, provider: controllers[0].provider },
    { id: 'controller', provider: 'none' },
    'a persistent default must not choose one authenticated client family as controller',
  )
  assert.deepEqual(
    SHIPPED_DEFAULT_ORG.agents.filter((agent) => agent.provider === 'claude').map((agent) => agent.id),
    ['claude-1', 'claude-2', 'claude-3', 'claude-4'],
  )
  for (const actor of ['codex', 'claude', 'gemini']) {
    assert.equal(SHIPPED_DEFAULT_ORG.agents.some((agent) => agent.id === actor), false,
      `transport principal ${actor} was persisted into the neutral org`)
  }
  const managed = new Set(SHIPPED_DEFAULT_ORG.relationships
    .filter((relationship) => relationship.type === 'manages' && relationship.from === 'controller')
    .map((relationship) => relationship.to))
  assert.deepEqual(
    [...managed],
    SHIPPED_DEFAULT_ORG.agents.filter((agent) => agent.role !== 'controller').map((agent) => agent.id),
    'every worker seat must remain reachable from the neutral controller',
  )
})

test('a fresh computer draws an empty tree, not the seats it declares', () => {
  /* THE OWNER'S RULE, AND THE ONE ASSERTION THIS FILE EXISTS FOR:
     "the node tree should be empty unless a user has started a session".
     The machine still appears — the page needs somewhere to put the offer to
     start one — and there is not a single agent on it. */
  const data = declaredFleetData(FRESH_INSTALL_ORG)
  assert.ok(data, 'the machine itself must still appear, or there is nowhere to start an agent')
  assert.equal(data.computers.length, 1)
  assert.equal(data.computers[0].id, THIS_COMPUTER_ID)
  assert.equal(data.computers[0].label, THIS_COMPUTER_LABEL)
  assert.deepEqual(data.graph.nodes, [], 'a person who has started nothing must see no agents')
  assert.deepEqual(data.graph.edges, [], 'an edge between agents nobody can see is a line to nowhere')
})

test('the seats a fresh install declares survive as capacity', () => {
  /* THE HALF THAT MUST NOT HAVE BEEN THROWN AWAY. Emptying the tree by deleting
     the declaration would empty it by breaking dispatch, which is the repair
     that landed the same day this one did. Every declared seat is still here,
     in declared order, with everything the dispatcher reads. */
  const capacity = declaredCapacity(FRESH_INSTALL_ORG)
  assert.deepEqual(
    capacity.seats.map(seat => seat.id),
    SHIPPED_DEFAULT_ORG.agents.map(agent => agent.id),
  )
  assert.equal(capacity.total, SHIPPED_DEFAULT_ORG.agents.length)
  assert.equal(capacity.ready, SHIPPED_DEFAULT_ORG.agents.filter(agent => agent.enabled !== false).length)
  const controller = capacity.seats.find(seat => seat.role === 'controller')
  assert.ok(controller, 'the agent that acts on this window\'s behalf must still be declared')
  const declaredController = SHIPPED_DEFAULT_ORG.agents.find(agent => agent.role === 'controller')
  assert.equal(
    controller.displayName,
    declaredController.displayName,
    'capacity must preserve the controller name from the shipped declaration',
  )
})

test('a fresh install declares an agent for each engine a dispatch can ask for', () => {
  /* THE PROPERTY THE ONE-AGENT DEFAULT COULD NOT HAVE HELD. The mission bridge
     resolves a dispatch by finding a declared agent whose provider matches the
     requested tier's, so a default declaring the controller alone made every
     tier undispatchable on every install. This suite cannot POST a dispatch —
     tools/agent-dispatch-packaged-qa.mjs does that against a real bridge — but
     it can hold the half the bridge reads. It reads the DECLARATION, which is
     why this assertion moved off the graph and did not weaken when it moved. */
  const providers = new Set(declaredCapacity(FRESH_INSTALL_ORG).seats
    .filter(seat => seat.enabled)
    .map(seat => seat.provider))
  for (const provider of ['codex', 'claude']) {
    assert.ok(providers.has(provider), `a fresh install declares no enabled ${provider} agent, so every ${provider} tier refuses`)
  }
})

test('every agent a fresh install declares is reachable from the controller', () => {
  /* Not decoration. An agent with no management edge survives the lane resolver
     (it falls back to the enabled controller) and then becomes UN-TERMINABLE,
     because termination authorises through the declared management graph. The
     shipped default states this rule about itself; this is where it is checked.
     Read from the declared relationships rather than from the drawn edges,
     because an empty tree has no drawn edges and the rule is about the
     declaration either way. */
  const declared = declaredAgentsData(FRESH_INSTALL_ORG)
  const managed = new Set(declared.relationships.filter(edge => edge.type === 'manages').map(edge => edge.to))
  for (const seat of declared.declared) {
    if (seat.role === 'controller') continue
    assert.ok(managed.has(seat.id), `${seat.id} is declared with no manager, so nothing can stop it`)
  }
})

test('the computer id is a stable route segment and carries no machine identity', () => {
  /* It is the middle segment of #/agent/<computer>/<agent>, so a host name here
     would rot every bookmark on rename AND put an owner-identifying string into
     every screenshot of a URL. */
  assert.match(THIS_COMPUTER_ID, /^[a-z][a-z0-9-]*$/)
  const first = declaredFleetData(FRESH_INSTALL_ORG).computers[0].id
  const second = declaredFleetData(TWO_AGENT_ORG, [started('controller')]).computers[0].id
  assert.equal(first, second, 'the id must not vary with the organisation it was built from')
})

test('a started session puts exactly its own agent on the tree', () => {
  const data = declaredFleetData(TWO_AGENT_ORG, [started('helper-1')])
  assert.deepEqual(data.graph.nodes.map(node => node.id), ['helper-1'])
  /* The seat's declared identity travels with it. The node is drawn because a
     session was observed, and it is LABELLED from the declaration, so the
     person reads the name they gave it rather than the id underneath. */
  const [node] = data.graph.nodes
  assert.equal(node.label, 'Helper')
  assert.equal(node.role, 'manager')
  assert.equal(node.provider, 'codex')
  /* Declared disabled, observed running. A node greyed out as unavailable while
     its own transcript scrolls beside it is the contradiction this chooses
     against; the session is the more recent fact. */
  assert.equal(node.enabled, true, 'an observed running session must override a disabled seat declaration')
})

test('one agent started twice is one node, and the caller decides which start', () => {
  const data = declaredFleetData(TWO_AGENT_ORG, [
    started('helper-1', { startedAtMs: 4_000 }),
    started('helper-1', { startedAtMs: 9_000 }),
  ])
  assert.equal(data.graph.nodes.length, 1)
  assert.equal(data.graph.nodes[0].bornAt, 4_000, 'the first record handed over is the one drawn')
})

test('a live session record is taken as handed over, not only a list', () => {
  /* readLiveSession() in src/agent-session-registry.js returns ONE record, and a
     caller should not have to wrap it to be understood. */
  const data = declaredFleetData(TWO_AGENT_ORG, { agentId: 'controller', sessionId: 'live-1', phase: 'working' })
  assert.deepEqual(data.graph.nodes.map(node => node.id), ['controller'])
})

test('nothing that was not observed is reported as observed', () => {
  const [node] = declaredFleetData(TWO_AGENT_ORG, [started('helper-1')]).graph.nodes
  /* A session that was observed to START says when it started and nothing else.
     A zero in any of these would be read as "ran and did nothing", which is the
     hollow-metric defect this project has already been bitten by; the field must
     be ABSENT so the view prints its own "not provided by fleet projection". */
  for (const field of ['bornAt', 'stoppedAt', 'tasksDone', 'failRate', 'origin']) {
    assert.equal(Object.hasOwn(node, field), false, `${field} must not be synthesised`)
  }
  assert.deepEqual(declaredFleetData(TWO_AGENT_ORG, [started('controller')]).computers[0].services, [])
  const observedSessions = declaredAgentsData(TWO_AGENT_ORG).observedSessions
  assert.equal(observedSessions.ok, false)
  assert.equal(
    typeof observedSessions.reason === 'string' && observedSessions.reason.trim().length > 0,
    true,
    'an unavailable observed-session projection must explain why it is unavailable',
  )
})

test('machine copy names the driven computer for a browser reader', () => {
  assert.equal(THIS_COMPUTER_LABEL, 'The computer you are driving')
})

test('a measurement the caller made travels, and a value it did not make does not', () => {
  const [measured] = declaredFleetData(TWO_AGENT_ORG, [
    started('helper-1', { startedAtMs: 1_700_000_000_000, origin: 'user' }),
  ]).graph.nodes
  assert.equal(measured.bornAt, 1_700_000_000_000)
  assert.equal(measured.origin, 'user')
  /* Junk in these fields is an absence with a different spelling, and a card
     that printed it would be reporting a runtime nobody timed. */
  const [guessed] = declaredFleetData(TWO_AGENT_ORG, [
    started('helper-1', { startedAtMs: 'a while ago', origin: 'somebody' }),
  ]).graph.nodes
  assert.equal(Object.hasOwn(guessed, 'bornAt'), false)
  assert.equal(Object.hasOwn(guessed, 'origin'), false)
})

test('the management edges between started agents are drawn, and no others', () => {
  const both = declaredFleetData(TWO_AGENT_ORG, [started('controller'), started('helper-1')])
  assert.deepEqual(both.graph.edges, [
    { from: 'controller', to: 'helper-1', type: 'manages', sourceKind: 'declared' },
  ])
  /* Half a pair started means no edge: a line from a circle that is not on the
     canvas points at nothing, and the person reads it as a missing node. */
  const one = declaredFleetData(TWO_AGENT_ORG, [started('helper-1')])
  assert.deepEqual(one.graph.edges, [])
})

test('an edge to an agent that is not declared is dropped, not drawn', () => {
  const data = declaredFleetData({
    ...TWO_AGENT_ORG,
    relationships: [
      { from: 'controller', to: 'helper-1', type: 'manages' },
      { from: 'controller', to: 'ghost', type: 'manages' },
    ],
  }, [started('controller'), started('helper-1')])
  assert.equal(data.graph.edges.length, 1)
  assert.equal(data.graph.edges[0].to, 'helper-1')
})

test('a session for an agent this copy does not declare is not drawn', () => {
  /* The drill-in behind a node resolves from the declaration, so a node for an
     undeclared agent is a door drawn on a wall. The bridge will not start one
     of these; it is handled because "barely arises" is where a person meets it
     alone. */
  const data = declaredFleetData(TWO_AGENT_ORG, [started('ghost'), started('helper-1')])
  assert.deepEqual(data.graph.nodes.map(node => node.id), ['helper-1'])
})

test('a session with nothing usable in it draws nothing', () => {
  for (const nonsense of [[], [null], [{}], [{ agentId: '' }], ['helper-1'], 0, 'helper-1', true]) {
    const data = declaredFleetData(TWO_AGENT_ORG, nonsense)
    assert.deepEqual(data.graph.nodes, [], `${JSON.stringify(nonsense)} must not put an agent on the tree`)
  }
})

test('no organisation means no computer, so the empty state stays reachable', () => {
  /* THE HALF THAT MAKES THIS SAFE. A plain browser has no organisation store,
     and a copy with nothing declared has nowhere to put an agent. Returning a
     computer there would offer to start something that cannot be started —
     which is the same dead end as the blank page, one press further along. */
  for (const nothing of [null, undefined, {}, { agents: [] }, { agents: null }, { agents: [{}] }, { agents: [{ id: '' }] }]) {
    assert.equal(declaredFleetData(nothing), null, `${JSON.stringify(nothing)} must not produce a computer`)
    assert.equal(declaredFleetData(nothing, [started('controller')]), null, 'a session cannot conjure an organisation')
    assert.equal(declaredAgentsData(nothing), null, `${JSON.stringify(nothing)} must not produce an agent projection`)
    assert.equal(declaredCapacity(nothing).total, 0)
    assert.deepEqual(declaredCapacity(nothing).seats, [])
  }
})

test('the drill-in resolves every seat, including the ones the tree is not drawing', () => {
  /* A node that opens onto "Agent projection unavailable" is a door drawn on a
     wall, and so is an org editor row that opens onto one. #/agent/... is a real
     route for a seat that has never run, and the page behind it is written to
     say "declared" — so this projection carries the whole declaration while the
     graph carries only what started. */
  const agents = declaredAgentsData(FRESH_INSTALL_ORG)
  const resolvable = new Set(agents.declared.map(agent => agent.id))
  for (const seat of declaredCapacity(FRESH_INSTALL_ORG).seats) {
    assert.ok(resolvable.has(seat.id), `${seat.id} is declared but cannot be opened`)
  }
  const graph = declaredFleetData(TWO_AGENT_ORG, [started('helper-1')])
  for (const node of graph.graph.nodes) {
    assert.ok(new Set(declaredAgentsData(TWO_AGENT_ORG).declared.map(agent => agent.id)).has(node.id),
      `${node.id} is drawn but cannot be opened`)
  }
  assert.equal(declaredAgentsData(TWO_AGENT_ORG).revision, 4)
})
