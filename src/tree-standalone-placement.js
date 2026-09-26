// The workspace owns the tab; the injected computer callback owns adoption.
// This adapter never creates a session, disposes a composer, or writes a tree.
export async function placeStandaloneAgent(graph, record, parentId = null) {
  const refuse = sentence => ({ ok: false, sentence })
  const current = () => !graph?._destroyed && graph?.workspace?.standalone.get(record?.id) === record && record?.chatOpen
  if (!current() || !record.standalone) return refuse('This standalone chat is no longer open.')
  if (record.treeNodeId) return refuse('This agent is already on a tree.')
  if (record.placementPending) return refuse('This agent is already being added to a tree.')
  if (graph.editMode || graph._linkMode) return refuse('Finish editing or linking before adding this agent.')
  if (parentId !== null && !graph.computer?.agents?.some(agent => agent.id === parentId && !agent.treeScope?.group)) {
    return refuse('That parent agent is no longer available. Choose another destination.')
  }
  if (typeof graph.onPlaceStandalone !== 'function') return refuse('This copy of ToolsEnabled cannot add a standalone agent to a tree. Update ToolsEnabled and try again.')
  record.placementPending = true
  try {
    const result = await graph.onPlaceStandalone({ record, parentId, computerId: graph.computer.id })
    if (!current()) return refuse('The chat view closed before placement finished.')
    if (result?.ok !== true) return refuse(result?.sentence || result?.reason || 'The agent could not be added to the tree.')
    if (typeof result.nodeId !== 'string' || !result.nodeId.trim()) return refuse('The tree did not return an agent reference. Placement could not be confirmed.')
    record.treeNodeId = result.nodeId
    return { ...result, sentence: result.sentence || `${record.agent.name} was added to the tree.` }
  } catch (error) {
    return refuse(error?.message || 'The agent could not be added to the tree.')
  } finally { record.placementPending = false }
}
