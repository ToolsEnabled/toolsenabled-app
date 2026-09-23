/* THIS COMPUTER, AND WHY ITS TREE IS EMPTY UNTIL THE PERSON STARTS SOMETHING.
 *
 * THE FIRST DEFECT THIS EXISTS TO CLOSE, measured on the packaged build with a
 * fresh profile (release/win-unpacked, isolated LOCALAPPDATA/USERPROFILE,
 * permission level `standard`):
 *
 *     /data/fleet.json    ok:false  "No local agent fleet host detected on this machine."
 *     /data/agents.json   ok:false  same reason
 *     window.mcOrg.read() ok:true   source "baseline", 1 declared agent, 9 roles
 *     .static-tree-node on the computers page: 0
 *
 * Both projections are BUILD-TIME files. tools/gen-fleet.mjs reads the engine's
 * own config and presence state at package time, and on any machine that is not
 * the developer's there is nothing to read, so the shipped answer is `ok:false`
 * — permanently, on every customer install, forever. The computers page treated
 * that one file as the only possible answer to "which computers exist", so it
 * drew nothing and said the machine had no fleet host.
 *
 * Meanwhile the same page had already read, in the same `Promise.all`, a live
 * per-machine description of the organisation this copy declares — the one the
 * page's own hierarchy drag and role menu WRITE to — and used it only to render
 * a role library. The absence of the OBSERVED source was read as the absence of
 * every source. That is this project's recurring shape wearing a different hat:
 * nothing specified, so nothing exists.
 *
 * THE SECOND DEFECT, WHICH IS THE FIRST REPAIR TAKEN ONE STEP TOO FAR.
 *
 * That repair was right about the SOURCE and wrong about what to draw from it.
 * It drew every declared agent as a node, and at the time that was one node — a
 * controller — so the difference between "declared" and "running" was easy to
 * miss. Then capability-defaults/config/agent-org.json grew to eight seats, and
 * it grew for a reason that has nothing to do with the tree: the bridge resolves
 * a dispatch by finding a DECLARED agent whose provider matches the requested
 * tier, and with only a controller declared, every dispatch on every packaged
 * install refused with BRIDGE_AGENT_DECLARATION_MISSING. A packaged copy could
 * not start anything at all. Those eight seats are what makes starting possible.
 *
 * So a person who installed this product and had never pressed anything opened
 * the fleet page and found eight agents with their own names, their own roles
 * and their own pages, arranged under a controller. Nothing was running. The
 * owner named the rule this breaks: "the node tree should be empty unless a user
 * has started a session".
 *
 * DECLARED IS CAPACITY. OBSERVED IS THE TREE. That distinction is not invented
 * here — this product already draws it in words on every surface that touches
 * a declared agent, and the shipped organisation file states it about itself
 * ("A seat is a DECLARATION, not a claim about the customer's machine"). What
 * was missing is that the GRAPH did not obey what the words promised. A tree is
 * the one surface a person reads as "what is going on right now", because that
 * is what a picture of running things means everywhere else they have seen one.
 * No caption survives contact with eight circles.
 *
 * So the split is now structural rather than editorial:
 *
 *   declaredCapacity()   what this computer COULD run. Every seat, untouched,
 *                        for the surfaces that need it — the dispatcher, the
 *                        role library, the org editor, and any sentence that
 *                        wants to say how much room this machine has. Nothing
 *                        was deleted and nothing moved.
 *   declaredFleetData()  what the person HAS started, as a tree. Empty until
 *                        they start something, which on a fresh computer is
 *                        every time.
 *
 * WHAT THE EMPTINESS SAYS IS NOT WRITTEN HERE, and deliberately not. An empty
 * tree is the first screen most people ever read on this page, and it already
 * has an owner: src/fleet-tree-copy.js holds EMPTY_TREE — "Nothing has run on
 * this computer yet" — along with the words on the pressable slot itself, and
 * the view reads them from there. A second wording composed in this file would
 * let one condition be described two ways by two modules that cannot see each
 * other, which is the defect src/local-activity.js was extracted to end. This
 * module owns whether the tree is empty. That module owns what empty says.
 *
 * WHAT THIS MODULE IS AND IS NOT. It is a pure adapter: it reshapes an
 * organisation record into the two projection shapes the views already consume,
 * so both surfaces keep exactly one renderer and exactly one set of edit rules.
 * It INVENTS NOTHING. No runtime, no task count, no failure rate, no service is
 * synthesised — every field the organisation does not carry is simply absent,
 * and the views already print "not provided by fleet projection" for those.
 * A declared agent is a configured agent, never an observed one, and nothing
 * here may make it look like one.
 *
 * IT IS ALSO STILL PURE, and that is why the started sessions arrive as an
 * ARGUMENT rather than being read from src/agent-session-registry.js here. That
 * registry is a live singleton; reaching into it from this file would make the
 * same input produce two different trees depending on when it was called, and
 * every decision below is proven by calling these functions with a value. The
 * caller holds the live half and hands it over.
 */

/* The identity of the machine the app is running on. It is a route segment
   (`#/agent/<computer>/<agent>`), so it has to be stable across launches or a
   bookmark to a drill-in would rot; and it must not be derived from the host
   name, which would put an owner-identifying string into a URL and into every
   screenshot of one. */
export const THIS_COMPUTER_ID = 'this-computer'
export const THIS_COMPUTER_LABEL = 'The computer you are driving'

const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** The declared agents of an organisation record, or [] when there are none. */
function declaredAgents(org) {
  if (!isRecord(org) || !Array.isArray(org.agents)) return []
  return org.agents.filter(agent => isRecord(agent) && typeof agent.id === 'string' && agent.id.length > 0)
}

/** The management edges, in the projection's own edge vocabulary. */
function declaredEdges(org, present) {
  if (!isRecord(org) || !Array.isArray(org.relationships)) return []
  return org.relationships
    .filter(relation => isRecord(relation)
      && relation.type === 'manages'
      && present.has(relation.from)
      && present.has(relation.to))
    .map(relation => ({ from: relation.from, to: relation.to, type: 'manages', sourceKind: 'declared' }))
}

/** One seat, in the shape every surface below reads it in. */
const seatOf = agent => ({
  id: agent.id,
  displayName: typeof agent.displayName === 'string' && agent.displayName ? agent.displayName : agent.id,
  role: agent.role,
  provider: agent.provider,
  enabled: agent.enabled !== false,
})

/**
 * WHAT THIS COMPUTER COULD RUN. The declared organisation, unreduced.
 *
 * This is the half that must NOT change when the tree empties, and it is a
 * named export rather than an internal detail because several things depend on
 * exactly these seats existing: a dispatch resolves the tier it was asked for
 * against a declared agent and refuses without one; termination authorises
 * through the declared management graph; the org editor writes to it; and the
 * empty state below counts it in order to say, truthfully, how much room this
 * computer has. Deleting a seat to empty the tree would have emptied the tree by
 * breaking the product, which is the kind of fix that passes a screenshot review
 * and fails on the first person who presses start.
 *
 * `ready` counts the seats declared ENABLED, and it is separate from `total`
 * because the two answer different questions. The lane resolver matches on id
 * and provider and never reads `enabled`, so a disabled seat is still a seat the
 * dispatcher can pick and then die on; a person, on the other hand, wants to
 * know how many are actually available to them.
 */
export function declaredCapacity(org) {
  const seats = declaredAgents(org).map(seatOf)
  return {
    total: seats.length,
    ready: seats.filter(seat => seat.enabled).length,
    seats,
  }
}

/**
 * The sessions a caller says have STARTED on this computer, keyed by agent.
 *
 * Two accepted shapes, and neither is loose typing for its own sake: an ARRAY,
 * which is what a list of runs is, and a SINGLE RECORD, which is exactly what
 * `readLiveSession()` in src/agent-session-registry.js returns. Anything else —
 * including a record with no agent id — contributes nothing, because a session
 * that cannot name whose it is cannot be drawn as a node without guessing, and
 * a guessed node is indistinguishable on screen from a measured one.
 *
 * FIRST ENTRY WINS, so a caller holding several starts for one agent draws one
 * node for it rather than two circles wearing the same name. Which one it hands
 * over first is the caller's decision, because the caller is the only one that
 * knows whether it is showing the live session or the whole history.
 */
function startedByAgent(started) {
  const entries = Array.isArray(started) ? started : (isRecord(started) ? [started] : [])
  const byAgent = new Map()
  for (const entry of entries) {
    if (!isRecord(entry)) continue
    const agentId = typeof entry.agentId === 'string' && entry.agentId.length > 0 ? entry.agentId : null
    if (!agentId || byAgent.has(agentId)) continue
    byAgent.set(agentId, entry)
  }
  return byAgent
}

/**
 * The fleet projection's `data` shape: this computer, and the agents on it that
 * have actually been started.
 *
 * `started` is the evidence, and its ABSENCE IS THE ORDINARY CASE rather than a
 * missing argument. A fresh computer has started nothing, so the tree is empty,
 * so the graph draws its own offer to start one — src/tree-graph.js already
 * places a single pressable slot dead centre when there are no agents, and
 * src/fleet-tree-copy.js writes the words that go around it. Nothing here
 * reports a failure, because nothing has failed: a person who has not started an
 * agent has an empty tree for the same reason a new notebook has blank pages.
 *
 * A STARTED SESSION IS DRAWN ONLY WHERE ITS SEAT IS STILL DECLARED. That is not
 * tidiness. The drill-in behind every node resolves from declaredAgentsData()
 * below, which reads the declaration, so a node for an undeclared agent would be
 * a door drawn on a wall — the exact defect the first repair above was written
 * to remove, one screen further along. In practice the case barely arises: the
 * bridge will not start a session for an agent this copy does not declare. It is
 * handled anyway, because "barely arises" is where a person meets it alone.
 *
 * Returns null when there is nothing to draw AT ALL, and NULL IS STILL THE
 * IMPORTANT HALF: a caller must be able to tell "this copy declares an
 * organisation" from "it declares none". An organisation with no seats is a copy
 * with nowhere to put an agent — a plain browser with no store behind it, or a
 * store that refused — and offering to start one there would be an offer that
 * cannot be honoured. A copy WITH seats and nothing started is a different
 * answer, and it is the empty tree.
 */
export function declaredFleetData(org, started = null) {
  const seats = declaredAgents(org)
  if (!seats.length) return null
  const sessions = startedByAgent(started)
  /* Declared order, not session order. The drill-in list, the role library and
     this graph all read the same record, and a node set that reshuffles itself
     every time a session is published would move a person's own agents around
     underneath their pointer for reasons they cannot see. */
  const running = seats.filter(agent => sessions.has(agent.id))
  const present = new Set(running.map(agent => agent.id))
  return {
    computers: [{
      id: THIS_COMPUTER_ID,
      label: THIS_COMPUTER_LABEL,
      /* Empty on purpose. Services are things a fleet host REPORTS, and there is
         no fleet host here; the rail already prints "No services declared by
         fleet projection" for this case rather than inventing one. */
      services: [],
      sourceKind: 'declared',
    }],
    graph: {
      nodes: running.map(agent => {
        const session = sessions.get(agent.id)
        const node = {
          id: agent.id,
          label: typeof agent.displayName === 'string' && agent.displayName ? agent.displayName : agent.id,
          role: agent.role,
          provider: agent.provider,
          /* A session is running under this seat, so the seat is drawn as
             enabled even if the declaration says otherwise. The alternative is
             a node greyed out as unavailable while its child process writes to
             the transcript beside it. */
          enabled: true,
          /* bornAt is the ONE measured field, and it is present only when the
             caller measured it. tasksDone / failRate / stoppedAt are still
             DELIBERATELY ABSENT: this module has no reading for them, and
             projectedComputer() turns a missing one into null with the reason
             "not provided by fleet projection" printed beside it. A zero would
             be read as "ran and did nothing", which is a claim. */
        }
        if (typeof session.sessionId === 'string' && session.sessionId) node.sessionId = session.sessionId
        if (Number.isSafeInteger(session.startedAtMs) && session.startedAtMs >= 0) {
          node.bornAt = session.startedAtMs
        }
        /* Who started it, in the projection's own two words, and only when the
           caller says. The cards read `origin` to print "owner-started" or
           "self-started"; an unstated origin prints neither rather than
           crediting the person with a run they did not ask for. */
        if (session.origin === 'user' || session.origin === 'self') node.origin = session.origin
        return node
      }),
      edges: declaredEdges(org, present),
      revision: Number.isSafeInteger(org?.revision) ? org.revision : null,
    },
  }
}

/**
 * The agents projection's `data` shape, built from the same record, so the
 * drill-in resolves from the same source the graph was drawn from.
 *
 * IT STILL CARRIES EVERY DECLARED SEAT, including the ones the graph is not
 * drawing, and that is deliberate. This is the CAPACITY surface: `#/agent/...`
 * is a real route that a bookmark, a restored window or the org editor can land
 * on for a seat that has never run, and the page behind it is written for
 * exactly that — it prints the declared role and the declared state and says
 * they are declared. Trimming this to the running set would turn every one of
 * those routes into "This agent is not on record here", which is false: it is on
 * record, it is simply not running.
 */
export function declaredAgentsData(org) {
  const agents = declaredAgents(org)
  if (!agents.length) return null
  const present = new Set(agents.map(agent => agent.id))
  return {
    revision: Number.isSafeInteger(org?.revision) ? org.revision : 1,
    declared: agents.map(seatOf),
    relationships: (Array.isArray(org?.relationships) ? org.relationships : [])
      .filter(relation => isRecord(relation) && present.has(relation.from) && present.has(relation.to))
      .map(relation => ({ from: relation.from, to: relation.to, type: relation.type })),
    /* The observed half is genuinely unavailable, and says so in the projection's
       own vocabulary. src/views/agent.js reads `observedSessions.ok` to decide
       between "unmapped" and "unavailable"; claiming ok here would have the page
       report that sessions were observed and simply not matched. */
    observedSessions: { ok: false, reason: 'No agent fleet host detected on the computer you are driving.' },
  }
}
