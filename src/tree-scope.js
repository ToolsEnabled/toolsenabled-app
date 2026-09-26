import { hierarchyParents } from './tree-layout.js'
import { overviewNodeState } from './fleet-overview.js'

export const TREE_COLLAPSE_AT = 20
const BRANCHES_PER_LEVEL = 5
const DETAIL_LIMIT = TREE_COLLAPSE_AT

// A view over the complete forest. Groups have their own identity and never
// become agents, sessions, or entries in the saved tree.
export class TreeScope {
  constructor(agents = [], edges = []) {
    this.groups = new Map()
    this.groupKeys = new Map()
    this.nextGroup = 1
    this.update(agents, edges)
  }

  update(agents, edges = []) {
    this.agents = agents
    this.byId = new Map(agents.map(agent => [agent.id, agent]))
    this.parents = hierarchyParents(agents, edges)
    // Malformed input must still have an entry point in the overview.
    const settled = new Set()
    for (const agent of agents) {
      const path = new Set()
      let id = agent.id
      while (id && !settled.has(id)) {
        if (path.has(id)) { this.parents.delete(id); break }
        path.add(id)
        id = this.parents.get(id)
      }
      for (const key of path) settled.add(key)
    }
    this.children = new Map()
    for (const agent of agents) {
      const parent = this.parents.get(agent.id) || null
      if (!this.children.has(parent)) this.children.set(parent, [])
      this.children.get(parent).push(agent.id)
    }
    this.branches = new Map()
    this.summaries = new Map()
    for (const group of this.groups.values()) {
      const parentGroup = this.groups.get(group.parentId)
      group.memberIds = group.memberIds.filter(id => this.byId.has(id) && (parentGroup
        ? parentGroup.memberIds.includes(id)
        : (this.parents.get(id) || null) === group.parentId))
    }
  }

  branch(id) {
    if (this.branches.has(id)) return this.branches.get(id)
    const group = this.groups.get(id)
    const pending = group ? [...group.memberIds] : [id]
    const found = new Set()
    while (pending.length) {
      const next = pending.pop()
      if (found.has(next) || !this.byId.has(next)) continue
      found.add(next)
      pending.push(...(this.children.get(next) || []))
    }
    const result = [...found]
    this.branches.set(id, result)
    return result
  }

  summary(id) {
    if (this.summaries.has(id)) return this.summaries.get(id)
    const ids = this.branch(id)
    const answer = { total: ids.length, working: 0, review: 0, finished: 0 }
    for (const key of ids) {
      const agent = this.byId.get(key)
      // The producer resolves current session evidence once. Saved tree status
      // cannot override that answer; a bare saved node has no live evidence.
      const state = agent.treeActivity ?? (agent.treeNode
        ? overviewNodeState(agent.treeNode, null)
        : overviewNodeState({ status: agent.state === 'spawning' ? 'starting' : agent.state }, null, { example: true }))
      if (state === 'working') answer.working++
      if (state === 'review') answer.review++
      if (state === 'finished') answer.finished++
    }
    this.summaries.set(id, answer)
    return answer
  }

  agent(id) {
    const group = this.groups.get(id)
    if (!group) return this.byId.get(id) || null
    const summary = this.summary(id)
    if (!summary.total) return null
    return {
      id, parentId: group.parentId, name: countNoun(summary.total, 'agent'),
      role: 'default', state: 'group', r: 47,
      treeScope: { group: true, summary, hidden: summary.total, expandable: true },
    }
  }

  ancestry(id) {
    const trail = []
    const seen = new Set()
    while (id && !seen.has(id)) {
      seen.add(id)
      const agent = this.agent(id)
      if (!agent) break
      trail.unshift({ id, name: agent.name })
      id = this.groups.get(id)?.parentId || this.parents.get(id) || null
    }
    return trail
  }

  group(parentId, memberIds) {
    const key = JSON.stringify([parentId, memberIds])
    let id = this.groupKeys.get(key)
    if (!id) {
      id = `@tree-group:${this.nextGroup++}`
      this.groupKeys.set(key, id)
      this.groups.set(id, { parentId, memberIds })
    }
    this.groups.get(id).memberIds = memberIds
    return this.agent(id)
  }

  project(rootId = null, { collapse = true, detailLimit = DETAIL_LIMIT, rootIds = null,
    collapseAt = TREE_COLLAPSE_AT, branchesPerLevel = BRANCHES_PER_LEVEL } = {}) {
    const ids = rootId ? new Set(this.branch(rootId)) : rootIds ? new Set(rootIds.flatMap(id => this.branch(id))) : new Set(this.byId.keys())
    const full = this.agents.filter(agent => ids.has(agent.id))
    const forestRoots = (this.children.get(null) || []).filter(id => ids.has(id))
    const displayRootId = rootId || (forestRoots.length === 1 ? forestRoots[0] : null)
    const root = displayRootId ? this.agent(displayRootId) : null
    if (!collapse || full.length < collapseAt || full.length <= detailLimit) {
      return root?.treeScope?.group
        ? [{ ...root, parentId: null, treeScope: { ...root.treeScope, expandable: false } },
          ...full.map(agent => ({ ...agent, parentId: ids.has(this.parents.get(agent.id)) ? this.parents.get(agent.id) : rootId }))]
        : full
    }

    const memberIds = root?.treeScope?.group
      ? this.groups.get(rootId).memberIds.filter(id => this.byId.has(id))
      : (this.children.get(displayRootId) || []).filter(id => ids.has(id))
    const nodes = root ? [{ ...root, parentId: null }] : []
    const fanout = Math.max(2, Math.floor(branchesPerLevel) || BRANCHES_PER_LEVEL)
    if (memberIds.length > fanout) {
      const chunk = Math.ceil(memberIds.length / fanout)
      for (let i = 0; i < memberIds.length; i += chunk) {
        nodes.push(this.group(displayRootId, memberIds.slice(i, i + chunk)))
      }
    } else {
      for (const id of memberIds) nodes.push({ ...this.byId.get(id), parentId: displayRootId })
    }
    const shown = new Set(nodes.map(agent => agent.id))
    return nodes.map(agent => {
      const summary = this.summary(agent.id)
      const hidden = this.branch(agent.id).filter(id => !shown.has(id)).length
      return {
        ...agent, tierRank: undefined,
        treeScope: { group: !!agent.treeScope?.group, summary, hidden, expandable: agent.id !== displayRootId && hidden > 0 },
      }
    })
  }
}

/* ONE PLURAL RULE FOR EVERY TREE COUNT A PERSON READS (T1239, T1401):
   "1 agent", "0 agents", "2 agents" -- the canvas hints, group cards, branch
   badges, the Explore button's name and the removal sentences all use it. */
export function countNoun(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`
}

export function branchSummaryText(summary) {
  return [
    `${countNoun(summary.total, 'agent')} in this branch`,
    summary.working ? `${summary.working} working` : '',
    summary.review ? `${summary.review} need review` : '',
    summary.finished ? `${summary.finished} finished` : '',
  ].filter(Boolean).join(' · ')
}
