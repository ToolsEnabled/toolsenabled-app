/* THE SECOND HALF OF A CLEAN REPLACEMENT: THE ADDRESS, NEVER THE OLD ASK.
 *
 * executeFreshStartExistingNode (fresh-start-existing-node.js) binds a clean
 * session and deliberately sends nothing -- its own header says so, and
 * tools/test/tree-node-command-wiring.test.mjs enforces it by refusing any
 * `bridge.send(` in that file. Nothing else ever called the caller's own
 * ordinary send API for a clean replacement either, so a circle restarted by
 * an assistant (agent.restart) registered under its name and was then told
 * nothing: neither registerTreeSession (no "Tree address:" line was ever
 * sent) nor adoptTreeAddressFromThread (a fresh restart mints a new thread,
 * so findByThreadId matches nothing) ever fired, and the circle stayed
 * unaddressable forever.
 *
 * THIS DOES NOT RESEND THE NODE'S ORIGINAL MESSAGE, ON PURPOSE. A restart of
 * an EXISTING node is a clean slate by design -- see the "cleared" status
 * note in fleet-tree-copy.js, "Started over. It remembers nothing from
 * before -- say what you want from the message box or the queue" -- and
 * tools/test/session-console-history.test.mjs pins the reason in words:
 * "clear re-sends the brief -- re-running the original ask uninvited could
 * redo real work". A draft's own first start is not this: the person is
 * asking for that job to run for the first time. A restart of a node that
 * already ran once is not that; resending its saved node.message would repeat
 * whatever it already asked for -- which, unlike an address line, may not be
 * safe to repeat -- so this composes and sends only the tree address (plus
 * whatever nodeManagerContext says about its reports), through the SAME
 * ordinary send API a typed message already uses and
 * tools/test/tree-node-command-fresh-start-behavior.test.mjs already drives
 * (executeSendToBoundNode, send-to-bound-node.js). The role introduction
 * needs no separate send: shell/agent-host.cjs appends
 * session.pendingRoleIntroduction to the first turn on ANY session started
 * with a roleBinding, which executeFreshStartExistingNode already supplies.
 */

import { composeNodeBrief } from './tree-node-brief.js'
import { executeSendToBoundNode } from './send-to-bound-node.js'

export async function executeFreshStartBriefSend({
  node,
  sessionId,
  selfName,
  parentName = null,
  childNames = [],
  bridge,
  sessionNodeIds,
  sessionThreadIds,
  appendTranscript,
  appendTurnLog,
  treeStore = null,
  refreshTree = () => {},
  refusalCodeFromError = () => null,
  refusalCodeFromResult = () => null,
} = {}) {
  /* No `message` parameter exists here, on purpose: see the header. A caller
     that wants to repeat a node's original ask has to type it again. */
  const text = composeNodeBrief({ message: '', selfName, parentName, childNames })
  return executeSendToBoundNode({
    command: {
      action: 'send-to-bound-node',
      nodeId: node?.id ?? null,
      expectedSessionId: sessionId,
      message: text,
    },
    node: { ...node, sessionId },
    bridge,
    sessionNodeIds,
    sessionThreadIds,
    appendTranscript,
    appendTurnLog,
    treeStore,
    refreshTree,
    refusalCodeFromError,
    refusalCodeFromResult,
  })
}
