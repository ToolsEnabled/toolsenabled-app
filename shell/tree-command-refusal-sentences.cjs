/* WHAT AN ASSISTANT IS TOLD WHEN A TREE COMMAND IS REFUSED.
 *
 * The renderer answers a tree-node command with a CODE and nothing else, and
 * that is deliberate: shell/tree-node-command.cjs pins the renderer result to
 * exactly six keys (`normalizeRendererResult`, "Tree-node command result"), so
 * a result that crosses the file spool cannot carry prose an off-process writer
 * chose. The code is the wire fact.
 *
 * WHAT WAS MISSING WAS THE OTHER HALF. main.cjs turned every refusal into one
 * fixed line -- "The application could not add that assistant to the tree
 * (MC_TREE_COMMAND_REMOVE_PERSON_SPOKE)" -- which is wrong twice over for a
 * lifecycle verb: the errand was a removal, not an add, and the only reason
 * given is an identifier. The engine's own tree tool promises better;
 * src/lib/tool-registry.js says of these refusals "a refusal comes back in the
 * store's own words". This file is those words.
 *
 * They live here rather than beside the rule in src/agent-removal-rule.js
 * because the process that must SAY them is the Electron main process, which is
 * CommonJS and cannot import the renderer's ES modules synchronously. The two
 * halves are pinned together by tools/test/agent-removal-rule.test.mjs, which
 * fails if a code the rule can return has no sentence here.
 *
 * A sentence names what was asked, why the answer is no, and -- where the
 * person can change the answer -- who can. None of them tells anyone to try
 * again: a refusal that is the rule working is not a transient failure.
 */

/* The verb an assistant asked for, said the way a person would say it. Used to
   describe the errand in a refusal, so a stopped circle is never reported as a
   failed spawn. */
const TREE_COMMAND_ERRANDS = Object.freeze({
  'create-and-start-node': 'add that assistant to the tree',
  'fresh-start-existing-node': 'restart that circle',
  'send-to-bound-node': 'deliver that message',
  'stop-node': 'stop that circle',
  'remove-node': 'remove that circle',
  'resume-node': 'resume that circle',
})

const TREE_COMMAND_REFUSAL_SENTENCES = Object.freeze({
  /* The owner's removal rule, 2026-09-03: "agents that were spawned by agents
     AND who the user hasnt prompted - THEY can be removed by parent agents.
     AGENTS that a user prompts even if created by another agent can remain". */
  MC_TREE_COMMAND_REMOVE_PERSON_SPOKE:
    'That circle stays: the person has sent it a message, and a circle the person has spoken to can only be removed by the person.',
  MC_TREE_COMMAND_REMOVE_NOT_AGENT_MADE:
    'That circle stays: the person made it, and only the person removes a circle they made.',
  MC_TREE_COMMAND_REMOVE_NOT_BELOW_CALLER:
    'A circle is removed by one above it. That circle is not below yours on the tree, so it is not yours to remove.',
  MC_TREE_COMMAND_REMOVE_CALLER_UNKNOWN:
    'This session is not bound to a circle on the open tree, so there is no way to tell whether the circle it named is below it.',
  /* The same placement question, asked for a stop or a restart (owner:
     "start and restart agents UNDER them"). Their own codes, because the
     REMOVE_* sentences explain a removal and would explain a stop wrongly. */
  MC_TREE_COMMAND_NOT_BELOW_CALLER:
    'A circle is stopped or restarted by one above it. That circle is not below yours on the tree, so it is not yours to change.',
  MC_TREE_COMMAND_CALLER_UNKNOWN:
    'This session is not bound to a circle on the open tree, so there is no way to tell whether the circle it named is below it, and nothing was changed.',
  /* The store's own two refusals (src/fleet-trees.js NODE_REMOVE_REFUSALS: a
     live agent, and a circle with circles under it) reach the PERSON in the
     store's exact words on the page's status line. Only the fact that the store
     said no crosses to the assistant, so this says which two answers that is
     rather than inventing a third. */
  MC_TREE_COMMAND_REMOVE_REFUSED:
    'The tree kept that circle: a circle that is still working, and a circle with circles under it, are not removed.',
  MC_TREE_COMMAND_REMOVE_UNAVAILABLE:
    'The tree on screen could not answer a removal in this state.',
  /* THE ONE EXCEPTION TO THIS FILE'S OWN RULE, STATED ABOVE: "None of them
   * tells anyone to try again: a refusal that is the rule working is not a
   * transient failure." This is not a refusal the rule intended -- it is a
   * race. runTreeNodeCommand (src/views/computers.js) awaits bootPromise then
   * the bounded projectionReady wait; a view teardown (navigation, a route
   * change) landing inside that window returns this code with nothing having
   * been asked of the store at all. MEASURED, Builder 3, from the signed
   * action log: agent.remove refused this way at 06:54:06Z, then the SAME
   * command succeeded three times in the next 33 seconds; agent.spawn refused
   * it at 07:03:30Z and succeeded at 07:04:25Z on a plain retry. Before this
   * entry existed the code fell through to the generic line -- "The
   * application could not ... (MC_TREE_COMMAND_VIEW_DESTROYED)" -- which
   * upstream readers rendered as an internal error, not as the transient
   * nothing-happened-yet it actually is. */
  MC_TREE_COMMAND_VIEW_DESTROYED:
    'The page this circle is on rebuilt itself while the command was still waiting to be answered, so nothing was done. This is not a refusal -- the same command will very likely work if sent again.',
})

/* THE VIEW'S OWN WORDS, WHEN IT HAD ANY. The renderer now carries a bounded
   `reason` on a refusal (src/main.js, treeNodeCommandReason): the store's
   placement sentence, the start refusal the person was shown, or the message
   of an error that was thrown. It rides only on the generic line below --
   a code with a named sentence keeps that sentence, because those are the
   owner's rules in the owner's words and a reason beside them would say the
   same thing twice. The bound is repeated here rather than trusted, because
   this is the process that puts the string into an Error message. */
const MAX_REASON_CHARS = 600
function boundedReason(reason) {
  if (typeof reason !== 'string') return null
  const text = reason.replace(/\0/g, '').trim()
  if (!text) return null
  return text.length > MAX_REASON_CHARS ? text.slice(0, MAX_REASON_CHARS) : text
}

/** The one line an assistant reads when a tree command comes back refused. */
function treeCommandRefusalSentence(action, code, reason = null) {
  /* OWN PROPERTIES ONLY, exactly like the broker's sibling table
   * (shell/tree-node-command-broker.cjs, treeNodeCommandRefusalSentence) and
   * for the same reason: TREE_COMMAND_REFUSAL_SENTENCES and TREE_COMMAND_ERRANDS
   * are plain objects, so a bare `obj[key]` inherits Object.prototype -- a
   * `code` or `action` of 'toString', 'constructor', 'valueOf', or
   * 'hasOwnProperty' resolves to that BUILT-IN FUNCTION rather than undefined,
   * which is truthy, so it used to be handed back as if it were a real
   * sentence or errand. resolveLocalTreeCommand (shell/main.cjs) passes
   * whichever of the two this function returns straight to `new
   * Error(message)` when rejecting a waiting agent.spawn/.stop/.restart/
   * .remove call, which stringifies a function into
   * "function toString() { [native code] }" -- the caller's own tool error
   * text. Nothing upstream of `code` here is restricted to the MC_TREE_COMMAND_*
   * vocabulary the way the file-spool path's normalizeRendererResult restricts
   * a stored result: the broker's complete() only checks requestId for a LOCAL
   * envelope, so an ordinary renderer reply string reaches this function
   * unfiltered. See tools/test/agent-removal-rule.test.mjs, "a code or action
   * that names something every object inherits is never mistaken for a
   * sentence". */
  const named = typeof code === 'string' && Object.prototype.hasOwnProperty.call(TREE_COMMAND_REFUSAL_SENTENCES, code)
    ? TREE_COMMAND_REFUSAL_SENTENCES[code]
    : null
  if (named) return named
  const errand = typeof action === 'string' && Object.prototype.hasOwnProperty.call(TREE_COMMAND_ERRANDS, action)
    ? TREE_COMMAND_ERRANDS[action]
    : 'carry out that request on the tree'
  const words = boundedReason(reason)
  const line = `The application could not ${errand} (${code || 'MC_TREE_COMMAND_RENDERER_FAILED'}).`
  return words ? `${line} ${words}` : line
}

module.exports = Object.freeze({
  MAX_REASON_CHARS,
  TREE_COMMAND_ERRANDS,
  TREE_COMMAND_REFUSAL_SENTENCES,
  treeCommandRefusalSentence,
})
