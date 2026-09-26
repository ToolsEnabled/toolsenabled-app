import { nodeIsBusy, sessionEndedWithApp } from './tree-session-liveness.js'

// Use the same session evidence as the canvas. Saved "running" records alone
// cannot establish that an agent is still working after an app restart.
export function overviewNodeState(node, ownedSessions, { example = false, evidence = null, startingNodeIds = null } = {}) {
  // The example is a self-contained record, never a reading of owner sessions.
  if (example && ['starting', 'running'].includes(node.status)) return 'working'
  // This set holds current bridge calls, never restored saved start markers.
  if (startingNodeIds?.has(node.id) || nodeIsBusy(node, ownedSessions, evidence)) return 'working'
  if (sessionEndedWithApp(node, ownedSessions, evidence)
    || ['failed', 'turn-failed', 'interrupted', 'cancelled'].includes(node.status)) return 'review'
  if (node.status === 'draft') return 'draft'
  if (node.status === 'finished') return 'finished'
  return 'unconfirmed'
}

export const OVERVIEW_STATES = Object.freeze([
  { key: 'working', label: 'working' },
  { key: 'review', label: 'need review' },
  { key: 'draft', label: 'not started' },
  { key: 'finished', label: 'turn finished' },
  { key: 'unconfirmed', label: 'status unconfirmed' },
])

export function fleetOverviewSnapshot(store, ownedSessions, options = {}) {
  if (!store) return null
  const totals = { agents: 0, working: 0, review: 0, draft: 0, finished: 0, unconfirmed: 0 }
  const trees = store.listTrees().map(tree => {
    const nodes = store.listNodes(tree.id)
    const counts = { agents: nodes.length, working: 0, review: 0, draft: 0, finished: 0, unconfirmed: 0 }
    for (const node of nodes) counts[overviewNodeState(node, ownedSessions, options)] += 1
    for (const key of Object.keys(totals)) totals[key] += counts[key]
    return { id: tree.id, name: store.treeLabel(tree.id), rootId: store.rootOf(tree.id)?.id ?? null, ...counts }
  })
  return { ...totals, trees }
}
