/* THE OWNER'S RULE FOR WHO MAY REMOVE A CIRCLE, IN ONE CALLABLE PLACE.
 *
 * Verbatim, 2026-09-03: "agents that were spawned by agents AND who the user
 * hasnt prompted - THEY can be removed by parent agents. AGENTS that a user
 * prompts even if created by another agent can remain".
 *
 * The rule turns on three facts, and NOT ONE OF THEM IS THE CALLER'S TO CLAIM:
 *
 *   who made the circle      `createdByAgent`, written by create-and-start-node
 *                            at the moment an assistant makes one.
 *   whether the person ever  `promptedByPerson`, written the first time the
 *   spoke to it              person's own typed words are routed to it, and
 *                            never unset.
 *   where the asker stands   resolved from the LIVE SESSION the application
 *                            itself bound, exactly as executeCreateAndStartNode
 *                            resolves a spawn's parent ("THE PARENT IS RESOLVED
 *                            FROM THE SESSION, NEVER NAMED BY THE CALLER").
 *
 * WHY THIS IS A MODULE RATHER THAN A BRANCH IN THE VIEW. It shipped as four
 * inline `if`s inside computersView's runTreeNodeCommand, a closure no test can
 * construct, and the suite that came with it therefore asserted a truth table
 * written in the TEST FILE:
 *
 *     const removable = node => node.createdByAgent === true && node.promptedByPerson !== true
 *
 * That assertion cannot go red when the rule breaks, because it never calls the
 * rule. Everything here is reachable from `node --test` with plain values, so
 * the four combinations are exercised against the code that actually decides.
 *
 * A REFUSAL HERE IS THE RULE WORKING, NOT A FAILURE, so each one names itself
 * and carries a reason a person can read. The sentences live beside the codes
 * in shell/tree-command-refusal-sentences.cjs, because the process that speaks
 * them to the asking assistant is the main process, not this renderer; the
 * suite pins every code here to a sentence there so the two cannot drift.
 */

import { parseSlashCommand } from './slash-commands.js'

/* Deep enough for any tree the store will build: FLEET_TREE_LIMITS.maxChainSteps
   is the store's own cap on an ancestor chain, and this walk answers the same
   question the store's ancestorChainIsSound() asks. Bounded rather than
   trusting termination, because a cycle in a hand-edited record would otherwise
   hang the renderer -- and tree-nodes.json has been hand-edited before. */
export const REMOVAL_CHAIN_STEPS = 64

export const REMOVAL_REFUSALS = Object.freeze({
  /* "could not look" -- the asking circle could not be placed on this tree at
     all. Kept separate from NOT_BELOW_CALLER on purpose: not knowing where the
     asker stands and knowing it stands elsewhere are different answers, and
     merging them would hide a binding failure behind a rule. */
  callerUnknown: 'MC_TREE_COMMAND_REMOVE_CALLER_UNKNOWN',
  notBelowCaller: 'MC_TREE_COMMAND_REMOVE_NOT_BELOW_CALLER',
  personSpoke: 'MC_TREE_COMMAND_REMOVE_PERSON_SPOKE',
  notAgentMade: 'MC_TREE_COMMAND_REMOVE_NOT_AGENT_MADE',
  storeRefused: 'MC_TREE_COMMAND_REMOVE_REFUSED',
  unavailable: 'MC_TREE_COMMAND_REMOVE_UNAVAILABLE',
})

/**
 * IS THIS TYPED LINE THE PERSON PROMPTING THE AGENT?
 *
 * The console's own vocabulary is not a prompt. `/interrupt` stops a turn,
 * `/goal` records a build-queue item, `/Request` files a standing rule, `/help`
 * answers itself -- all of those drive the PRODUCT, and none of them is the
 * person speaking to the assistant. `/queue <words>` is: the words go to the
 * model, just later.
 *
 * The direction of the doubt is deliberate. Marking a circle prompted only
 * makes it HARDER to remove, so a line this answers `true` about too readily
 * costs an assistant a tidy-up; a line it answers `false` about too readily
 * loses work the person did. The second is the one the owner's rule exists to
 * prevent, so anything that carries the person's words to the model counts.
 */
export function personTurnPromptsCircle(text) {
  if (typeof text !== 'string' || text.trim() === '') return false
  const slash = parseSlashCommand(text)
  if (!slash) return true
  if (slash.kind === 'cloud') return !slash.sentence
  return slash.kind === 'action' && slash.action === 'queue' && typeof slash.rest === 'string' && slash.rest.trim() !== ''
}

/**
 * ONE DOOR FOR "THE PERSON TYPED THIS AT THIS CIRCLE".
 *
 * Every composer in the Computers view calls this with the raw line, before
 * deciding what to do with it, so that the fact is recorded on every route the
 * words can take -- straight to the engine, into the queue behind a working
 * turn, or into the queue a dead session's recovery refills. It shipped
 * recorded on ONE of those routes, the live send, which is the only route a
 * typed line takes when the circle happens to be idle.
 *
 * Nothing an assistant can call reaches this function: an assistant's own
 * delivery is executeSendToBoundNode, which does not and must not mark.
 */
export function notePersonSpokeTo(treeStore, node, text) {
  if (!treeStore || !node || typeof treeStore.markPromptedByPerson !== 'function') return false
  if (!personTurnPromptsCircle(text)) return false
  return treeStore.markPromptedByPerson(node.id).ok === true
}

/**
 * Is `nodeId` below `callerNodeId` on the tree? Walks parents from the named
 * circle upward, so the answer is "the asker is somewhere above it", which is
 * the shape of the owner's sentence: a circle is removed BY THE ONE ABOVE IT.
 * A circle is never below itself, so a circle cannot ask for its own removal.
 */
export function circleIsBelow(readNode, nodeId, callerNodeId, { maxSteps = REMOVAL_CHAIN_STEPS } = {}) {
  if (typeof readNode !== 'function' || !nodeId || !callerNodeId || nodeId === callerNodeId) return false
  let current = readNode(nodeId)
  for (let step = 0; step < maxSteps; step += 1) {
    if (!current || current.parentId == null) return false
    if (current.parentId === callerNodeId) return true
    current = readNode(current.parentId)
  }
  return false
}

/* THE SAME PLACEMENT QUESTION, ASKED FOR A STOP OR A RESTART.
 *
 * Owner, 2026-09-03: "THE AGENTS NEED TO BE ABLE TO DELETE AND START AND
 * RESTART AGENTS UNDER THEM". Three verbs, one word: UNDER. executeRemoveNode
 * below has always read where the asker stands from the session the
 * application bound and refused a circle that is not below it; the stop and
 * restart routes in the view read nothing of the kind when they shipped, so an
 * assistant could name ANY circle on the tree -- a sibling, its own manager,
 * the person's root -- and the view closed or wiped it.
 *
 * These codes are their own rather than the REMOVE_* pair because the sentence
 * spoken for a refusal names the errand, and "it is not yours to remove" is the
 * wrong sentence for a stop. */
export const LIFECYCLE_REFUSALS = Object.freeze({
  callerUnknown: 'MC_TREE_COMMAND_CALLER_UNKNOWN',
  notBelowCaller: 'MC_TREE_COMMAND_NOT_BELOW_CALLER',
})

/**
 * Where the asking circle stands, as a refusal or as nothing to refuse.
 *
 * Returns null when the named circle is below the asker -- or when the command
 * names no session at all, which is the person's own errand (the file-spool
 * coordinator's fresh-start-existing-node never carries one, and an assistant's
 * dispatch always does; see shell/main.cjs dispatchTreeSpawn). The asker is
 * resolved from `sessionNodeIds`, the application's own binding, never from
 * anything the request claims.
 */
export function callerCircleRefusal({ command, node, treeStore, sessionNodeIds, maxSteps = REMOVAL_CHAIN_STEPS } = {}) {
  const refused = code => ({ ok: false, code, nodeId: (node && node.id) || (command && command.nodeId) || null, sessionId: null, threadId: null })
  const parentSessionId = command && typeof command.parentSessionId === 'string' && command.parentSessionId ? command.parentSessionId : null
  if (!parentSessionId) return null
  if (!node || !treeStore || !sessionNodeIds || typeof sessionNodeIds.get !== 'function') {
    return refused(LIFECYCLE_REFUSALS.callerUnknown)
  }
  const callerNodeId = sessionNodeIds.get(parentSessionId) || null
  if (!callerNodeId) return refused(LIFECYCLE_REFUSALS.callerUnknown)
  if (!circleIsBelow(id => treeStore.getNode(id), node.id, callerNodeId, { maxSteps })) {
    return refused(LIFECYCLE_REFUSALS.notBelowCaller)
  }
  return null
}

/**
 * ONE ASSISTANT ASKS FOR ONE CIRCLE TO BE REMOVED.
 *
 * The caller supplies the view's own stores and the view's own removal --
 * `removeCircle` is performNodeRemoval, the function the person's own Remove
 * press calls, so a circle removed by its manager and one removed by hand end
 * the same way and the store stays the gate for everything this rule does not
 * decide (a live agent, a circle with agents under it).
 *
 * Returns the tree-node-command result shape the broker publishes.
 */
export async function executeRemoveNode({
  command,
  node,
  treeStore,
  sessionNodeIds,
  removeCircle,
  maxSteps = REMOVAL_CHAIN_STEPS,
} = {}) {
  const refused = code => ({ ok: false, code, nodeId: (node && node.id) || (command && command.nodeId) || null, sessionId: null, threadId: null })

  if (!command || !node || !treeStore || !sessionNodeIds || typeof removeCircle !== 'function') {
    return refused(REMOVAL_REFUSALS.unavailable)
  }

  /* WHERE THE ASKER STANDS, read from the session the application bound to a
     circle -- never from anything the request carries. Without this an
     assistant could name ANY circle on the tree: a sibling, a circle in another
     manager's branch, or the one above it. The owner's sentence is "removed by
     parent agents", and this is the half of it that was never checked. */
  const callerNodeId = sessionNodeIds.get(command.parentSessionId) || null
  if (!callerNodeId) return refused(REMOVAL_REFUSALS.callerUnknown)
  if (!circleIsBelow(id => treeStore.getNode(id), node.id, callerNodeId, { maxSteps })) {
    return refused(REMOVAL_REFUSALS.notBelowCaller)
  }

  /* Read from the store rather than from the node the caller's lookup handed
     in, so the facts are the current ones: a person who typed to this circle
     while the request was in the broker's queue still keeps it. */
  const live = treeStore.getNode(node.id) || node
  if (live.promptedByPerson === true) return refused(REMOVAL_REFUSALS.personSpoke)
  if (live.createdByAgent !== true) return refused(REMOVAL_REFUSALS.notAgentMade)

  const removed = await removeCircle(live)
  return removed === true
    ? { ok: true, code: null, nodeId: live.id, sessionId: null, threadId: null }
    : refused(REMOVAL_REFUSALS.storeRefused)
}
