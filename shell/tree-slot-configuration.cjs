'use strict'

const CONFIGURATION_ACTIONS = Object.freeze(['set-node-model', 'set-node-effort', 'set-node-account', 'set-node-provider', 'set-node-role'])
function createTreeSlotConfigurationAuthority({ readParent, readForest, readSessionOwner } = {}) {
  if ([readParent, readForest, readSessionOwner].some(fn => typeof fn !== 'function')) throw new TypeError('Managed-slot configuration needs current parent and saved tree authority.')
  const refuse = reason => { throw Object.assign(new Error(reason), { code: 'TREE_CONFIGURATION_REFUSED' }) }
  function admit(request) {
    if (!CONFIGURATION_ACTIONS.includes(request?.action)) refuse('That slot configuration action is not supported.')
    if (typeof request.choice !== 'string' || !request.choice.trim() || request.choice.length > 200 || /[\u0000-\u001f\u007f]/.test(request.choice)) refuse('Choose a valid slot configuration value.')
    const parent = readParent(request.parentSessionId)
    if (!parent?.nodeId || !parent.owner || parent.permissionSession?.origin !== 'local') refuse('The managing session is no longer bound to this local tree.')
    // The existing normal switch path cannot mint a confined replacement permit.
    // Keep this explicit refusal until that existing authority supports the action.
    if (parent.permissionSession.tier !== 'full') refuse('This permission level does not support managed-slot reconfiguration through the current switch path.')
    const forest = readForest(request.computerId)
    const byId = new Map(forest.nodes.map(node => [node.id, node]))
    const savedParent = byId.get(parent.nodeId), target = byId.get(request.nodeId)
    if (!savedParent || savedParent.sessionId !== request.parentSessionId || savedParent.treeId !== parent.treeId
        || !target || target.treeId !== savedParent.treeId || target.id === parent.nodeId) {
      refuse('Choose a descendant slot in the managing agent’s current tree.')
    }
    let ancestor = byId.get(target.parentId), managed = false
    const seen = new Set()
    while (ancestor && !seen.has(ancestor.id)) {
      if (ancestor.id === parent.nodeId) { managed = true; break }
      seen.add(ancestor.id); ancestor = byId.get(ancestor.parentId)
    }
    if (!managed) refuse('Sibling and ancestor slots are outside this agent’s managed scope.')
    if (request.expectedSessionId != null && request.expectedSessionId !== target.sessionId) refuse('The target slot changed session. Read its current identity before trying again.')
    const currentOwner = target.sessionId ? readSessionOwner(target.sessionId) : null
    if (currentOwner !== null && currentOwner !== parent.owner) refuse('The target session belongs to a different owner.')
    return Object.freeze({ treeId: target.treeId, nodeId: target.id, parentNodeId: parent.nodeId,
      expectedSessionId: target.sessionId ?? null })
  }
  return Object.freeze({ admit })
}
module.exports = { CONFIGURATION_ACTIONS, createTreeSlotConfigurationAuthority }
