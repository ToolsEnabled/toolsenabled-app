/* THE EXAMPLE FLEET'S OWN COMPUTERS AND ORGANISATION.
 *
 * The computers page and the agent drill-in are LIVE renders and nothing else:
 * mountProjection (src/views/computers.js) consumes the fleet projection's
 * `data` shape, declaredAgentProjection (src/views/agent.js) consumes the
 * agents projection's `data` shape, and the separate simulated render that
 * used to stand beside them is being removed. When there is no real host to
 * read — signed-out web, or the desktop example toggle — the same renders are
 * fed THIS record instead, and a badge handled elsewhere is what tells the
 * person it is an example. Same rule as src/sample-activity.js: substitution,
 * not suppression. The honesty rule forbids REAL data in a box badged as an
 * example; it does not require the example to be empty, so the example gets a
 * fleet of its own and the badge stays true because nothing here is anybody's
 * machine.
 *
 * BUILT IN EXACTLY THE SHAPE THE LIVE READERS CONSUME, so the render cannot
 * tell it from a real record. That cuts both ways: fields the shape marks
 * OPTIONAL are omitted where the example's story has no reading for them,
 * rather than zeroed — projectedComputer() turns a missing tasksDone into
 * null and the card prints its honest "not provided" row, and a demonstration
 * that papered over that row would be demonstrating a product that does not
 * exist. One seat (gem-lane-2) deliberately carries NO optional field at all
 * so those rows are always on screen somewhere.
 *
 * ONE SEAT TABLE DRIVES BOTH EXPORTS. The computers page draws the graph and
 * the agent page resolves the drill-in behind every node; if the two were
 * hand-assembled separately they would agree only by coincidence, and the
 * first edit to one would open a door onto a wall. Both functions below read
 * SEATS, so a node and its drill-in cannot disagree about a role, a name, or
 * who manages whom.
 *
 * THE ROSTER IS COPIED, NOT IMPORTED. These are the same agents the rest of
 * the example world already talks about — codex coordinating, claude
 * verifying, luna-02 and terra-01 managing lanes, shadow-mgr watching
 * heartbeats, the gem lanes and terra-02 working — the names src/sample-activity.js
 * and the sample transcripts in src/fleet-profile.js use, so the fleet page
 * and the conversations describe one world. They are copied as small literals
 * rather than imported because the module that owns them as a fleet
 * (src/sim.js) is being deleted, and because fleet-profile.js resolves the
 * OPERATOR'S profile synchronously at module evaluation — importing it would
 * let a person's own loaded profile steer what appears inside a box badged as
 * an example, which is the exact mixing the badge promises does not happen.
 * (src/sim.js, src/vocab.js and src/metrics-charts.js must not be imported
 * here for the same reason: they are on their way out.)
 *
 * ROLES ARE THE PROJECTION'S DECLARED VOCABULARY, the same declared org role
 * strings src/vocab.js's ROLES now carries a colour and label for directly --
 * 'controller', 'coordinator-assistant', 'shadow-manager', 'manager' and
 * 'worker' each keep their own appearance rather than being translated to a
 * legacy bucket (src/views/computers.js used to do that translation; removed
 * once ROLES covered these roles itself, see that file's history).
 *
 * DETERMINISTIC ON PURPOSE, same as sample-activity.js: no Math.random, no
 * persisted state, and every timestamp is derived from the caller's nowMs, so
 * the same instant produces the same record every render. The ago-minutes are
 * uneven on purpose — evenly spaced births look generated, and the gaps are
 * what make the runtime clocks above them mean anything.
 */

const M = 60_000
const iso = ms => new Date(ms).toISOString()

/* One revision for both projections, because they describe one record; the
   rail prints it ("Graph revision 4") and the number only has to be a stable
   small integer. The fleet schema also names a `contentHash` beside it, but no
   render reads one and declaredFleetData() — the live synthesiser this module
   must stay shape-compatible with — does not produce one, so neither does
   this. A hash asserts "this content was fingerprinted", which for a shipped
   example would be a claim with nothing behind it. */
const REVISION = 4

/* The example fleet, one seat per row.
 *
 *   parent          feeds the 'manages' edge list; null is the controller.
 *   agoMinutes      bornAt = nowMs - agoMinutes (absent = never measured,
 *                   and the card says so rather than showing a clock).
 *   stoppedAgoMinutes  a lane that ran and was released; the render requires
 *                   stoppedAt >= bornAt or it discards the pair, so keep the
 *                   stop younger than the birth.
 *   origin          'user' on the seat the owner started, 'self' on lanes a
 *                   manager spawned; UNSTATED elsewhere, because the cards
 *                   print "owner-started"/"self-started" from it and an
 *                   unstated origin honestly prints neither.
 *   tasksDone/failRate  present only where the story has a measurement;
 *                   shadow-mgr watches rather than works, so it has none.
 *
 * gem-lane-2 is the deliberately bare seat: declared, enabled, and never
 * started, so every optional row on its card reads "not provided". gem-lane-3
 * is the released lane — disabled, with both ends of its runtime — which is
 * the story the sample transcript already tells ("lane released — nothing
 * held past the sample wave"). */
const SEATS = Object.freeze([
  Object.freeze({ id: 'codex', role: 'controller', provider: 'codex', enabled: true, parent: null,
    agoMinutes: 1587, origin: 'user', tasksDone: 41, failRate: 2.1 }),
  Object.freeze({ id: 'claude', role: 'coordinator-assistant', provider: 'claude', enabled: true, parent: 'codex',
    agoMinutes: 1104, tasksDone: 33, failRate: 0.8 }),
  Object.freeze({ id: 'shadow-mgr', role: 'shadow-manager', provider: 'codex', enabled: true, parent: 'codex',
    agoMinutes: 909 }),
  Object.freeze({ id: 'terra-01', role: 'manager', provider: 'codex', enabled: true, parent: 'codex',
    agoMinutes: 745, tasksDone: 18, failRate: 5.6 }),
  Object.freeze({ id: 'luna-02', role: 'manager', provider: 'codex', enabled: true, parent: 'codex',
    agoMinutes: 612, tasksDone: 12, failRate: 0 }),
  Object.freeze({ id: 'gem-lane-1', role: 'worker', provider: 'gemini', enabled: true, parent: 'terra-01',
    agoMinutes: 288, origin: 'self', tasksDone: 7, failRate: 6.5 }),
  Object.freeze({ id: 'gem-lane-2', role: 'worker', provider: 'gemini', enabled: true, parent: 'terra-01' }),
  Object.freeze({ id: 'terra-02', role: 'worker', provider: 'local', enabled: true, parent: 'luna-02',
    agoMinutes: 96, origin: 'self', tasksDone: 4 }),
  Object.freeze({ id: 'gem-lane-3', role: 'worker', provider: 'gemini', enabled: false, parent: 'luna-02',
    agoMinutes: 2544, stoppedAgoMinutes: 2194, tasksDone: 9, failRate: 3.2 }),
])

/* ============================================================================
   THE EXAMPLE'S AGENT TREES — what "watch by tree" has to demonstrate (T401).

   Owner: "we have each tree as a single option, then we have ALL TREES but this
   shows just the tip of the tree when its active ... so then people can monitor
   just their top level agents more easily."

   WHY THIS IS DECLARED HERE AND NOT DERIVED. The example fleet already has tree
   SHAPE -- the seat table's `parent` chain is one hierarchy rooted at codex --
   and src/sample-trees.js already builds real fleet-tree records for the
   computers page. Neither gives Home what this feature needs: the seat chain is
   ONE tree, so "one option per tree" would have nothing to choose between, and
   sample-trees.js mints its own node ids, which no Home run carries. So the
   example declares which lanes belong to which tree, over the hierarchy it
   already has.

   SHAPED TO DEMONSTRATE THE FEATURE RATHER THAN TO LOOK TIDY:
     - TWO trees, so the per-tree options are a real choice.
     - ONE of them active and one not, so ALL TREES visibly FILTERS rather than
       just listing everyone. A demo where every tree is active cannot show what
       that option is for.
     - FOUR lanes in no tree at all, which is the real-world case: a run started
       outside the fleet trees keeps a plain name rather than a node id, and it
       must stay reachable under "All agents" rather than vanishing.

   `active` is declared rather than computed because this is a scripted demo --
   the same reason agoMinutes, tasksDone and stoppedAgoMinutes above are
   declared. On a real computer the answer comes from treeStatus() in
   fleet-trees.js, which reads whether any of the tree's agents is running.

   gem-lane-2 is deliberately in no tree AND untouched: it is the seat the
   fleet projection test requires to carry nothing optional at all, so nothing
   here may add a field to it. Membership is a separate table for exactly that
   reason -- no seat record changes shape, so the fleet projection is unmoved. */
const SAMPLE_AGENT_TREES = Object.freeze([
  Object.freeze({ id: 'example-control', name: 'Control lane', active: true,
    members: Object.freeze(['codex', 'claude', 'shadow-mgr']) }),
  Object.freeze({ id: 'example-delivery', name: 'Delivery lane', active: false,
    members: Object.freeze(['terra-01', 'gem-lane-1']) }),
])

/* The tip is the member the others hang from: the one whose parent is null, or
   whose parent is not in this tree. Same rule as the real store's rootOf(),
   which takes the node in the tree with no parent -- read off the seat table
   rather than restated, so a change to the hierarchy cannot leave a tip behind
   that nobody manages. */
function sampleTreeTip(members) {
  const inTree = new Set(members)
  const byId = new Map(SEATS.map(seat => [seat.id, seat]))
  return members.find(id => {
    const parent = byId.get(id)?.parent
    return !parent || !inTree.has(parent)
  }) || members[0] || null
}

/**
 * The example's trees in the shape the Home panel's filter takes
 * (src/home-circle-action.js): membership by the key a run carries, one tip,
 * and whether the tree is active. A tree with no members is not offered.
 */
export function sampleAgentTreeRecords() {
  const known = new Set(SEATS.map(seat => seat.id))
  return SAMPLE_AGENT_TREES
    .map(tree => {
      const members = tree.members.filter(id => known.has(id))
      return { id: tree.id, name: tree.name, active: tree.active, tipKey: sampleTreeTip(members), memberKeys: members }
    })
    .filter(tree => tree.memberKeys.length > 0)
}

/* The management edges follow the seat table's own hierarchy, so they cannot
   name a node that does not exist. sourceKind 'declared' because they are the
   example fleet's organisation chart — the same value declaredEdges() in
   src/declared-fleet.js writes. The one 'reviews' edge is 'observed': terra-01
   re-reviewing the released lane is something the example fleet was SEEN doing
   (its transcript posts the verdict), not something its org chart declares.
   projectedComputer() ignores non-hierarchy edges for layout and the tree
   draws them as the softer relationship line, which is exactly the render
   this edge exists to keep exercised. */
const REVIEW_EDGE = Object.freeze({ from: 'terra-01', to: 'gem-lane-3', type: 'reviews', sourceKind: 'observed' })

const fleetEdges = () => SEATS
  .filter(seat => seat.parent !== null)
  .map(seat => ({ from: seat.parent, to: seat.id, type: 'manages', sourceKind: 'declared' }))
  .concat([{ ...REVIEW_EDGE }])

/**
 * The fleet projection's `data` shape — what mountProjection() consumes:
 * `{ computers, graph: { revision, nodes, edges } }`.
 *
 * TWO COMPUTERS, ONE GRAPH, and that is the projection's own geometry rather
 * than a shortcut: projectedComputer() hands every computer the whole node
 * set, because the graph belongs to the fleet record, not to a machine. So
 * both tabs draw the same organisation, and what the tabs genuinely differ in
 * is what a computer actually owns — its services and its own observation
 * times. The computers carry every field the schema requires of them
 * (observedAt, activeSessions included) even though today's render reads only
 * the services: this record stands in for the real fleet.json, and a mock the
 * schema would reject is a mock one refactor away from being caught lying.
 *
 * Fresh objects on every call, deliberately. projectedComputer() copies edges
 * before its drag control splices them, but nothing downstream promises not
 * to mutate, and a shared frozen array would make the first mutation a crash
 * on a later render instead of here.
 */
export function sampleFleetData(nowMs = Date.now()) {
  return {
    computers: [
      {
        id: 'sample-computer-1',
        label: 'Computer 1',
        sourceKind: 'observed',
        observedAt: iso(nowMs - 14 * M),
        activeSessions: 4,
        services: [
          { id: 'sample-fleet-host', name: 'agent fleet host', state: 'healthy',
            observedAt: iso(nowMs - 14 * M), detail: 'answering on the local lane' },
          { id: 'sample-lease-sweep', name: 'task lease sweeper', state: 'healthy',
            observedAt: iso(nowMs - 31 * M), detail: 'no stale locks in the last sweep' },
          { id: 'sample-audit-chain', name: 'audit chain writer', state: 'stale',
            observedAt: iso(nowMs - 143 * M), detail: 'buffered records awaiting flush' },
        ],
      },
      {
        id: 'sample-computer-2',
        label: 'Computer 2',
        sourceKind: 'observed',
        observedAt: iso(nowMs - 52 * M),
        activeSessions: 3,
        services: [
          { id: 'sample-fleet-host', name: 'agent fleet host', state: 'healthy',
            observedAt: iso(nowMs - 52 * M), detail: 'answering on the local lane' },
          /* One honest unknown: a service the host lists but has no fresh
             reading for. observedAt null is the shape's own word for that,
             and the chip's meta line renders state and detail without it. */
          { id: 'sample-question-queue', name: 'question queue', state: 'unknown',
            observedAt: null, detail: 'no reading this window' },
        ],
      },
    ],
    graph: {
      revision: REVISION,
      nodes: SEATS.map(seat => {
        const node = {
          id: seat.id,
          label: seat.id,
          role: seat.role,
          provider: seat.provider,
          enabled: seat.enabled,
        }
        /* Optionals are attached only where the table has a value. An
           `undefined` property would survive most readers but not all — the
           determinism contract is deep equality, and a key that exists with
           undefined in one serialisation path and is absent in another is
           the kind of drift nobody can see in a screenshot. */
        if (seat.agoMinutes !== undefined) node.bornAt = nowMs - seat.agoMinutes * M
        if (seat.stoppedAgoMinutes !== undefined) node.stoppedAt = nowMs - seat.stoppedAgoMinutes * M
        if (seat.origin !== undefined) node.origin = seat.origin
        if (seat.tasksDone !== undefined) node.tasksDone = seat.tasksDone
        if (seat.failRate !== undefined) node.failRate = seat.failRate
        return node
      }),
      edges: fleetEdges(),
    },
  }
}

/**
 * The agents projection's `data` shape — what declaredAgentProjection()
 * consumes: `{ revision, declared, relationships, observedSessions }` —
 * built from the SAME seat table, so the drill-in behind a node resolves to
 * the agent the node showed.
 *
 * The declared entries carry bornAt/stoppedAt beside the five fields every
 * seat has, because the drill-in genuinely reads them: liveAgentRuntimeSource()
 * in src/views/agent.js derives the runtime clock from the record it is
 * handed, and a drill-in whose clock disagreed with the card the person just
 * clicked would be two renders describing two fleets. tasksDone/failRate/origin
 * are NOT mirrored here — no agent-page reader consumes them from the declared
 * record, and a field nothing reads is a field that drifts unnoticed.
 *
 * Relationships are the same edges as the fleet graph, in the narrower
 * `{from, to, type}` shape declaredAgentsData() emits — sourceKind stays on
 * the fleet side, where the layout sort is the thing that reads it.
 *
 * observedSessions is `ok: true` DELIBERATELY. The example world has a run
 * record of its own (src/sample-activity.js), so sessions were observed;
 * they are simply not matched to seats by name, because session ids are
 * opaque and the projection never guesses a bridge. agent.js reads `ok` to
 * choose between "not matched by name" (true) and "could not be read"
 * (false), and the second sentence would be false here: the example can
 * always read its own record.
 */
export function sampleAgentsData(nowMs = Date.now()) {
  return {
    revision: REVISION,
    declared: SEATS.map(seat => {
      const agent = {
        id: seat.id,
        displayName: seat.id,
        role: seat.role,
        provider: seat.provider,
        enabled: seat.enabled,
      }
      if (seat.agoMinutes !== undefined) agent.bornAt = nowMs - seat.agoMinutes * M
      if (seat.stoppedAgoMinutes !== undefined) agent.stoppedAt = nowMs - seat.stoppedAgoMinutes * M
      return agent
    }),
    relationships: fleetEdges().map(({ from, to, type }) => ({ from, to, type })),
    observedSessions: { ok: true, reason: null },
  }
}
