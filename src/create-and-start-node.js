/* Pure orchestration seam for "an assistant on the tree hands work to a new
 * circle beside it".
 *
 * The Computers view supplies its real stores, its role and tier tables, and
 * its own start. Keeping the ORDER here makes the properties executable in Node
 * tests: a parent that is not bound or not running cannot become a parent; an
 * unknown role or tier is refused before anything is drawn; the store's own
 * placement rules (how many children a circle may have, how deep a tree goes)
 * are the ones that answer, in the store's own words; the circle appears on the
 * canvas BEFORE its session is started, so a slow start is watched rather than
 * waited for in the dark; and a start that fails leaves the circle standing in
 * its failed state where the person can read why.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO is start the session itself. It calls
 * the view's own `startDraftNode`, the same function the person's own Start
 * button calls. That is the whole point: a circle made by an assistant and a
 * circle made by hand go through one launch path, so the seat, the role
 * binding, the model, the tree-address line and the transcript wiring cannot
 * drift apart between the two. Reimplementing the launch here would be a second
 * copy of the most load-bearing sequence in the product.
 */

const nothing = () => {}

/* The statuses a circle must be in to hand work down. A draft has never run and
   has no session to attribute the request to; a finished or failed circle is
   not there to receive the answer. */
const PARENT_ALIVE = Object.freeze(['starting', 'running'])

/* The providers whose launcher carries a chosen thinking depth through to the
   program it starts, read off shell/agent-host.cjs's three adjacent branches:
   codex emits `-c model_reasoning_effort=<effort>`, claude puts `{ effort }`
   on its threadOptions, and the acp/antigravity lane (gemini, grok) does the
   same. `local` is in none of them.

   THIS IS A LIST OF PROVIDERS, NOT OF DEPTHS. Which depths each one accepts
   belongs to that provider's own launcher and to the engine's agent.spawn,
   which already refused an unsupported one before this file is reached. */
export const PROVIDERS_WITH_A_THINKING_DEPTH = new Set(['codex', 'claude', 'gemini', 'grok'])

/* BUT THE CARD IS NOT THE ONLY EVIDENCE, AND IT IS NOT THE BEST EVIDENCE.
 *
 * MEASURED 2026-09-03 on the owner's own fleet: all nine circles -- the
 * Controller, three managers, five workers -- read `finished` on the tree
 * while their sessions were heartbeating and their agents were working. Eight
 * spawns were refused MC_TREE_SPAWN_PARENT_NOT_RUNNING across twenty-three
 * minutes, and the Controller reported "delegation is currently impossible".
 *
 * The status field is the VIEW's bookkeeping. It is set to `running` when the
 * person's own send resolves and to `finished` on every turn completion, and a
 * turn started by the shell's tree pump completes without anything setting it
 * back. So a circle that answers a message from another circle -- which is
 * most of what a tree does -- ends every turn marked finished.
 *
 * A SESSION THAT IS ASKING IS RUNNING. That is not an inference, it is the
 * request itself: the parent session id is resolved by the application from
 * the live call and is never claimed by the caller (see below), so a bound
 * session issuing this command is alive by construction. Where the card and
 * the call disagree, the call is the fact.
 *
 * This widens nothing. A draft circle has never run and has no session bound,
 * so it still cannot be a parent; a genuinely finished circle's session is
 * gone and cannot issue anything. The only case this admits is the one the
 * measurement found: a working circle wearing a stale label. */
function parentIsAlive(parent, command) {
  if (PARENT_ALIVE.includes(parent.status)) return true
  return typeof parent.sessionId === 'string'
    && parent.sessionId !== ''
    && parent.sessionId === command.parentSessionId
}

export async function executeCreateAndStartNode({
  command,
  treeStore,
  sessionNodeIds,
  sessionThreadIds = null,
  roleRecordFor = () => null,
  launchTiers = [],
  startDraftNode,
  /* NO NAMER, NO NAME -- and never the id in its place. `displayName` below is
     spoken back to the assistant that asked for the circle and lands in a
     transcript a person reads, so this default decides what they read when the
     seam is missing. It used to answer `node.id`, which would put
     node-2-6c518599-05aa-4c77-a154-cefe49b278ed into that sentence under the
     heading "the name the person sees on the circle" -- a name nobody sees and
     nobody can say. `null` is the field's own word for "not named", the same
     one an empty name already produces one line below. */
  treeNodeName = () => null,
  refreshTree = nothing,
  noteStoreRefusal = nothing,
} = {}) {
  /* A REFUSAL CARRIES ITS SENTENCE WHEN IT HAS ONE. The store's placement
     refusal and the start's own refusal were both written for a person, shown
     on the org-status line, and then dropped from this result: the assistant
     that asked read only MC_TREE_SPAWN_PLACE_REFUSED or
     MC_TREE_COMMAND_START_FAILED. `reason` rides beside the code; the code is
     unchanged for everything that reads codes. */
  const refused = (code, nodeId = null, reason = null) => ({
    ok: false,
    code,
    nodeId,
    sessionId: null,
    threadId: null,
    ...(typeof reason === 'string' && reason.trim() ? { reason: reason.trim() } : {}),
  })

  if (!command || !treeStore || !sessionNodeIds || typeof startDraftNode !== 'function') {
    return refused('MC_TREE_SPAWN_TREE_NOT_OPEN')
  }

  /* THE PARENT IS RESOLVED FROM THE SESSION, NEVER NAMED BY THE CALLER. The
     assistant asking supplies no node id and could not be trusted with one: the
     only thing it can prove is which session it is, and the view already knows
     which circle that session belongs to. */
  const parentNodeId = sessionNodeIds.get(command.parentSessionId)
  if (!parentNodeId) return refused('MC_TREE_SPAWN_PARENT_NOT_BOUND')
  const parent = treeStore.getNode(parentNodeId)
  if (!parent) return refused('MC_TREE_SPAWN_PARENT_NOT_BOUND')
  if (!parentIsAlive(parent, command)) return refused('MC_TREE_SPAWN_PARENT_NOT_RUNNING', parentNodeId)

  /* The visible composer deliberately permits no role. Preserve that honest
     empty choice through the tree store; computers.js gives the started
     session a bounded Worker identity for transport without changing the
     node's role field. A non-empty role still must be present in the
     authoritative Role library. */
  if (command.role && !roleRecordFor(command.role)) return refused('MC_TREE_SPAWN_ROLE_UNKNOWN', parentNodeId)
  const tierRow = launchTiers.find(tier => tier && tier.id === command.tier)
  if (!tierRow) return refused('MC_TREE_SPAWN_TIER_UNKNOWN', parentNodeId)

  /* THE ASKING ASSISTANT'S THREE CHOICES ARE CHECKED AGAINST THIS COMPUTER'S
     OWN TIER TABLE, not taken on its word.
   *
     The engine's agent.spawn already refused an effort, provider or model that
     contradicts the tier -- but it checked against ITS table (the capability
     payload's src/lib/mission-bridge/actions.js TIERS) and what actually
     starts here is decided by THIS one (src/orchestration-controls.js
     LAUNCH_TIERS, handed in as launchTiers). Two tables that are supposed to
     agree are exactly the pair that can stop agreeing across a version skew,
     and the direction that costs the person money is this one: a confirmation
     the engine accepted against a stale row, applied here to a tier that has
     since moved to another provider or model.
   *
     So each is re-checked where the launch happens, and a disagreement refuses
     before a circle is drawn rather than starting something the caller did not
     name.
   *
     DEPTH FIRST, because it is the one a caller really chose -- and it is
     keyed on the PROVIDER, never on the row's own `effort` column. That column
     is the tier's DEFAULT depth, not its allowed set: every claude row reads
     null and Claude takes `--effort` perfectly well (shell/agent-host.cjs
     `...(useClaude && sessionEffort ? { effort: sessionEffort } : {})`, whose
     comment says "not because Claude has no notion of effort -- it has
     --effort"). Keying on the column would refuse the product's most common
     spawn.

     WHICH PROVIDERS CARRY A DEPTH THROUGH AT ALL is the honest question a gate
     here can answer, and shell/agent-host.cjs answers it in three adjacent
     branches: codex gets `-c model_reasoning_effort=`, claude gets
     `{ effort }` on its threadOptions, and acp/antigravity (gemini, grok) get
     the same. `local` appears in none of them and has no reasoning-depth
     switch anywhere in the engine's local-node modules.

     WHICH VALUES each of those accepts is NOT decided here. The engine's
     agent.spawn refuses a depth the chosen provider's launcher would not take,
     before a circle is drawn; the launcher itself refuses again. A third list
     in this file could only drift. */
  if (command.effort && !PROVIDERS_WITH_A_THINKING_DEPTH.has(tierRow.provider)) {
    return refused('MC_TREE_SPAWN_TIER_REFUSED', parentNodeId,
      `That agent asked to think at “${command.effort}”, but “${command.tier}” has no thinking-depth setting. `
      + 'Nothing was started. Ask for a model that offers one, or leave the depth out.')
  }
  if (command.provider && command.provider !== tierRow.provider) {
    return refused('MC_TREE_SPAWN_TIER_REFUSED', parentNodeId,
      `That agent asked for provider “${command.provider}”, but the model “${command.tier}” runs ${tierRow.provider}. `
      + 'Nothing was started. Ask for that provider’s own model, or leave the provider out and let the model choice decide.')
  }
  if (command.model && ![tierRow.model, tierRow.cliModel].includes(command.model)) {
    const known = [tierRow.model, tierRow.cliModel].filter(value => typeof value === 'string' && value !== '')
    return refused('MC_TREE_SPAWN_TIER_REFUSED', parentNodeId,
      `That agent asked for model “${command.model}”, but “${command.tier}” is ${known.length > 0 ? known.join(' / ') : 'a model this computer resolves at launch'}. `
      + 'Nothing was started. Ask for the model choice that runs it, or leave the model out.')
  }

  /* THE STORE'S OWN PLACEMENT RULES ANSWER. How many circles may hang off one,
     how deep a tree may go, how many a computer may hold: all of that already
     has one owner, and it refuses in a sentence written for a person. Passing
     that sentence through instead of inventing one is what lets the person read
     the same words whether they pressed + or an assistant did. */
  let added
  try {
    /* MADE BY AN ASSISTANT, recorded here because here is where it is true.
       The owner's removal rule reads it later; nothing on the removal path
       gets to claim it. */
    added = treeStore.addNode({
      madeByAgent: true,
      ...(command.reservedNodeId ? { reservedNodeId: command.reservedNodeId } : {}),
      parentId: parentNodeId,
      role: command.role,
      message: command.brief,
      tier: command.tier,
      /* THE DEPTH THE ASKING ASSISTANT CHOSE, ON THE NODE. This was a hard
         `''`, so a circle an assistant made could never carry one: the start
         below then read `node.effort` as empty and fell back to the tier
         default, which is why "spawn me a worker at max" produced a worker at
         medium and said nothing. `''` remains the honest empty when nothing
         was chosen -- it is the field's own word for "not set", and
         draftStartEffort falls through it to the tier default.

         ON THE NODE **AND** IN THE START BELOW, deliberately both. The node
         field is what a later Start from the tree reads (there is no panel
         then to carry an override); the start option is what this immediate
         start uses. Writing only one of them would make the choice hold for
         exactly one of the two ways this circle can be started. */
      effort: command.effort || '',
    })
  } catch (error) {
    const problem = error?.message || String(error)
    noteStoreRefusal(problem)
    return refused('MC_TREE_SPAWN_PLACE_REFUSED', parentNodeId, problem)
  }
  if (!added || added.ok !== true || !added.node || !added.node.id) {
    const problem = (added && Array.isArray(added.problems) ? added.problems[0] : null)
      || 'That circle could not be added to this tree.'
    noteStoreRefusal(problem)
    return refused('MC_TREE_SPAWN_PLACE_REFUSED', parentNodeId, problem)
  }
  const node = added.node
  if (command.reservedNodeId && node.id !== command.reservedNodeId) {
    return refused('TREE_DELEGATION_REFUSED', node.id, 'The new circle does not match its reserved identity.')
  }

  /* On the canvas before the start, exactly as the person's own compose panel
     does it: a circle that takes twenty seconds to come up is a circle the
     person can see coming up. */
  refreshTree()

  let started
  try {
    started = await startDraftNode(node, { effort: command.effort || null, closePanel: false,
      ...(command.requestId && command.expiresAt
        ? { treeCommand: { requestId: command.requestId, expiresAt: command.expiresAt } } : {}),
      ...(command.delegationToken ? { delegationToken: command.delegationToken } : {}),
      ...(command.research ? { research: command.research } : {}) })
  } catch (error) {
    return refused('MC_TREE_COMMAND_START_FAILED', node.id, error?.message || String(error))
  }
  /* A parent must never be told that it successfully created a circle which is
     unable to become the parent of work of its own. startDraftNode now refuses
     before opening such a session; this guard makes that product rule hold if a
     stale or future launcher ever returns the retired anonymous-success shape. */
  if (started?.anonymous === true) {
    return refused(
      'MC_TREE_COMMAND_START_FAILED',
      node.id,
      typeof started.reason === 'string' && started.reason.trim()
        ? started.reason
        : 'That circle was not given a declared identity, so it was not started.',
    )
  }
  if (!started || started.ok !== true) {
    /* startDraftNode has already put the circle into its failed state with the
       reason as its note, and left it on screen. That is the right outcome and
       it is not undone here: the person can read what happened, and an assistant
       that asked for a circle gets told the start failed -- in the same
       sentence the person was shown, which startDraftNode returns as
       `message`. */
    return refused('MC_TREE_COMMAND_START_FAILED', node.id, started && typeof started.message === 'string' ? started.message : null)
  }

  const live = treeStore.getNode(node.id) || node
  const sessionId = live.sessionId || started.sessionId || null
  const threadId = (sessionThreadIds && sessionId ? sessionThreadIds.get(sessionId) : null) || started.threadId || null
  const result = {
    ok: true,
    code: null,
    nodeId: node.id,
    sessionId,
    threadId,
    /* The name the person sees on the circle. The assistant that asked for it
       cannot work this out: its own brief listed the children it had when IT
       started, which was before this one existed. */
    displayName: treeNodeName(live) || null,
    ...(Object.prototype.hasOwnProperty.call(started, 'launchSettings') ? { launchSettings: started.launchSettings } : {}),
  }
  return result
}
