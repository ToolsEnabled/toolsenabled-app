import { layoutTree, TREE_LABEL_STACK } from './tree-layout.js'
import { layoutBoxTree, treeBoxSize } from './tree-box-layout.js'

// Box text is compensated by the renderer as cards scale down. Geometry can
// therefore use more of the canvas without forcing an early subtree fold.
const READABLE_SCALE = Object.freeze({ boxes: 0.72, circles: 0.70 })
const VIEW_PADDING = 10
const FRONTIER_LIMIT = 80
const PROJECTION_WORK_LIMIT = 160

function prospectiveFit(scope, agents, nodeStyle, W, H, contextSize) {
  if (!agents.length) return 1
  const visible = new Map(agents.map(agent => [agent.id, agent]))
  const nodes = agents.map(agent => {
    // Keep a projected group's synthetic parent. Other hierarchy comes from
    // the full scope, including declared edges and its cycle repair.
    const projectedParent = visible.get(agent.parentId)
    const parentId = agent.treeScope?.group || projectedParent?.treeScope?.group
      ? agent.parentId : scope.parents.get(agent.id)
    return { ...agent, parentId: visible.has(parentId) ? parentId : null }
  })
  const box = treeBoxSize(contextSize)
  const layout = nodeStyle === 'boxes'
    ? layoutBoxTree({ nodes, W, H, contextSize })
    : layoutTree({ nodes, W, H, spacious: true })
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity
  for (const [id, point] of layout.slots) {
    let halfWidth, above, below
    if (nodeStyle === 'boxes') {
      halfWidth = box.width / 2
      above = below = box.height / 2
    } else {
      const radius = layout.radii.get(id)
      const labelWidth = Math.min(radius * 2 + 118, layout.labels.get(id)?.maxWidth || Infinity)
      halfWidth = Math.max(radius, labelWidth / 2)
      above = radius
      below = radius + 7 + TREE_LABEL_STACK
    }
    left = Math.min(left, point.x - halfWidth)
    right = Math.max(right, point.x + halfWidth)
    top = Math.min(top, point.y - above)
    bottom = Math.max(bottom, point.y + below)
  }
  if (!Number.isFinite(left) || right <= left || bottom <= top) return 1
  return Math.min(Math.max(0, W - VIEW_PADDING * 2) / (right - left),
    Math.max(0, H - VIEW_PADDING * 2) / (bottom - top))
}

function describeFrontier(scope, agents, rootId) {
  const shown = new Set(agents.map(agent => agent.id))
  const parents = new Set(agents.map(agent => agent.parentId).filter(Boolean))
  return agents.map(agent => {
    const hidden = scope.branch(agent.id).filter(id => !shown.has(id)).length
    return { ...agent, tierRank: undefined, treeScope: {
      group: !!agent.treeScope?.group, summary: scope.summary(agent.id), hidden,
      // An open parent delegates further exploration to its visible frontier.
      expandable: hidden > 0 && !parents.has(agent.id) && agent.id !== rootId,
    } }
  })
}

// A box should keep actual agent names in view before spending every slot on
// anonymous groups. Reserve one overflow branch and show the other children
// directly. The overflow still refers to the complete authoritative subtrees.
function boxFrontier(scope, rootId, full, fanout) {
  const ids = new Set(full.map(agent => agent.id))
  const heads = (scope.children.get(null) || []).filter(id => ids.has(id))
  const headId = rootId || (heads.length === 1 ? heads[0] : null)
  const head = headId ? scope.agent(headId) : null
  const members = head?.treeScope?.group ? scope.groups.get(headId).memberIds
    : head ? scope.children.get(headId) || [] : heads
  if (members.length <= fanout) return null
  const children = members.slice(0, fanout - 1).map(id => ({ ...scope.byId.get(id), parentId: headId }))
  children.push(scope.group(headId, members.slice(fanout - 1)))
  return describeFrontier(scope, [...(head ? [head] : []), ...children], rootId)
}

function fillReadableFrontier(scope, initial, options) {
  const { rootId, nodeStyle, W, H, contextSize, minScale, threshold, fitScale } = options
  let agents = describeFrontier(scope, initial, rootId), work = 0
  const fit = candidate => prospectiveFit(scope, candidate, nodeStyle, W, H, contextSize)
  while (agents.length < FRONTIER_LIMIT && work < PROJECTION_WORK_LIMIT) {
    const parents = new Set(agents.map(agent => agent.parentId).filter(Boolean))
    let best = null
    for (const [order, agent] of agents.entries()) {
      if (!agent.treeScope.hidden || parents.has(agent.id) || work >= PROJECTION_WORK_LIMIT) continue
      const group = scope.groups.get(agent.id)
      const memberIds = group ? group.memberIds : scope.children.get(agent.id) || []
      const merge = children => {
        const parentId = group ? agent.parentId : agent.id
        const replacements = children.filter(child => child.id !== agent.id)
          .map(child => ({ ...child, parentId }))
        const newIds = new Set(replacements.map(child => child.id))
        const candidate = agents.filter(existing => !newIds.has(existing.id) && (!group || existing.id !== agent.id))
        const index = group ? order : candidate.findIndex(existing => existing.id === agent.id) + 1
        candidate.splice(index, 0, ...replacements)
        return candidate
      }
      const evaluate = children => {
        if (!children.length || work >= PROJECTION_WORK_LIMIT) return null
        const candidate = merge(children)
        if (candidate.length > FRONTIER_LIMIT) return null
        work++
        const candidateFit = fit(candidate)
        if (candidateFit + 1e-9 < minScale) return null
        const described = describeFrontier(scope, candidate, rootId)
        // Progressive expansion must not bypass the full-view hysteresis.
        if (!described.some(node => node.treeScope.hidden) && fitScale < threshold) return null
        return { agents: described, fit: candidateFit, order,
          cost: candidate.length - agents.length,
          realGain: children.filter(child => !child.treeScope?.group).length }
      }
      // Showing actual names outranks introducing a group for readable siblings.
      let expansion = memberIds.length <= FRONTIER_LIMIT
        ? evaluate(memberIds.map(id => scope.byId.get(id)).filter(Boolean)) : null
      if (!expansion && nodeStyle === 'boxes') for (let shown = Math.min(4, memberIds.length - 2); shown >= 1; shown--) {
        expansion = evaluate([
          ...memberIds.slice(0, shown).map(id => scope.byId.get(id)).filter(Boolean),
          scope.group(group ? agent.parentId : agent.id, memberIds.slice(shown)),
        ])
        if (expansion) break
      }
      if (!expansion) for (let fanout = 5; fanout >= 2; fanout--) {
        const children = scope.project(agent.id, { collapseAt: 0, detailLimit: 0, branchesPerLevel: fanout })
          .filter(child => child.id !== agent.id)
        expansion = evaluate(children)
        if (expansion) break
      }
      if (!expansion) continue
      if (!best || Number(expansion.realGain > 0) > Number(best.realGain > 0)
        || (Number(expansion.realGain > 0) === Number(best.realGain > 0)
          && (expansion.cost < best.cost || (expansion.cost === best.cost
            && (expansion.fit > best.fit || (expansion.fit === best.fit && expansion.order < best.order)))))) best = expansion
    }
    if (!best) break
    agents = best.agents
  }
  return agents
}

// Fit the prospective complete branch, never the already-folded result. That
// keeps newly freed space from immediately undoing the fold. The caller owns
// gesture settling and caches previousFolded separately for each tree view.
export function chooseTreeProjection({
  scope, rootId = null, rootIds = null, nodeStyle = 'boxes', W = 800, H = 600, previousFolded, contextSize = 'medium',
}) {
  W = Number.isFinite(W) ? Math.max(0, W) : 800
  H = Number.isFinite(H) ? Math.max(0, H) : 600
  nodeStyle = nodeStyle === 'circles' ? 'circles' : 'boxes'
  const full = scope.project(rootId, { collapse: false, rootIds })
  const minScale = READABLE_SCALE[nodeStyle]
  const fitScale = prospectiveFit(scope, full, nodeStyle, W, H, contextSize)
  const threshold = minScale * (previousFolded === true ? 1.1 : previousFolded === false ? 0.9 : 1)
  if (!full.length || fitScale >= threshold) {
    return { agents: full, folded: false, fitScale, minScale, branchesPerLevel: null }
  }
  let agents = full, branchesPerLevel = 2
  for (let fanout = 5; fanout >= 2; fanout--) {
    agents = scope.project(rootId, { rootIds, collapseAt: 0, detailLimit: 0, branchesPerLevel: fanout })
    branchesPerLevel = fanout
    if (nodeStyle === 'boxes') {
      const mixed = boxFrontier(scope, rootId, full, fanout)
      if (mixed && prospectiveFit(scope, mixed, nodeStyle, W, H, contextSize) >= minScale) {
        agents = mixed
        break
      }
      if (mixed && fanout > 2) continue
    }
    if (prospectiveFit(scope, agents, nodeStyle, W, H, contextSize) >= minScale) break
  }
  agents = fillReadableFrontier(scope, agents, { rootId, nodeStyle, W, H, contextSize, minScale, threshold, fitScale })
  const folded = agents.some(agent => agent.treeScope?.hidden > 0)
  return { agents, folded, fitScale, minScale, branchesPerLevel: folded ? branchesPerLevel : null }
}
