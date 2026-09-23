import { countNoun } from './tree-scope.js'
// A person's confirmed branch removal composes the existing single-agent
// removal path. The store and agent-command API keep their leaf-only contract.
const CHANGED = 'This branch changed after the removal preview. Review it and confirm again.'
const liveRefusal = node => node?.sessionId && ['starting', 'running'].includes(node.status) ? 'Stop the active agents in this branch first.' : null

function readBranch(store, rootId) {
  const root = store?.getNode(rootId)
  if (!root) return { ok: false, problems: ['That agent is no longer in this tree.'] }
  const records = [], order = [], seen = new Set(), pending = [{ id: rootId, exit: false }]
  while (pending.length) {
    const item = pending.pop()
    if (item.exit) { order.push(item.id); continue }
    const node = store.getNode(item.id)
    if (!node || seen.has(item.id) || node.treeId !== root.treeId) return { ok: false, problems: [CHANGED] }
    seen.add(item.id)
    records.push(Object.freeze({ id: node.id, signature: JSON.stringify(node) }))
    pending.push({ id: node.id, exit: true })
    const children = store.childrenOf(node.id)
    for (let index = children.length - 1; index >= 0; index--) {
      if (children[index].parentId !== node.id) return { ok: false, problems: [CHANGED] }
      pending.push({ id: children[index].id, exit: false })
    }
  }
  return { ok: true, rootId, count: records.length, records, order, problems: [] }
}

export function planNodeRemoval(store, rootId, { blocked = liveRefusal } = {}) {
  const plan = readBranch(store, rootId)
  if (!plan.ok) return Object.freeze(plan)
  for (const { id } of plan.records) {
    const reason = blocked(store.getNode(id))
    if (reason) return Object.freeze({ ...plan, ok: false, problems: [reason] })
  }
  return Object.freeze({ ...plan, records: Object.freeze(plan.records), order: Object.freeze(plan.order) })
}

export function checkNodeRemoval(plan, store, { removed = new Set(), blocked = liveRefusal, isCurrent = () => true } = {}) {
  if (!plan?.ok) return { ok: false, problems: plan?.problems || [CHANGED] }
  if (!isCurrent()) return { ok: false, problems: [CHANGED] }
  const current = readBranch(store, plan.rootId)
  if (!current.ok) return current
  const expected = new Map(plan.records.filter(record => !removed.has(record.id)).map(record => [record.id, record.signature]))
  if (current.records.length !== expected.size || current.records.some(record => expected.get(record.id) !== record.signature)) {
    return { ok: false, problems: [CHANGED] }
  }
  for (const { id } of current.records) {
    const reason = blocked(store.getNode(id))
    if (reason) return { ok: false, problems: [reason] }
  }
  return { ok: true, problems: [] }
}

export async function runNodeRemoval(plan, { store, remove, blocked = liveRefusal, isCurrent = () => true }) {
  const removed = new Set()
  const check = () => checkNodeRemoval(plan, store, { removed, blocked, isCurrent })
  const finish = (ok, problems = []) => ({ ok, problems, removed: [...removed],
    kept: (plan?.order || []).filter(id => !removed.has(id)) })
  for (const id of plan?.order || []) {
    const allowed = check()
    if (!allowed.ok) return finish(false, allowed.problems)
    let outcome
    try { outcome = await remove(store.getNode(id), () => check().ok) }
    catch (error) {
      if (!store.getNode(id)) removed.add(id)
      return finish(false, [error?.message || 'The agent could not be removed.'])
    }
    if (outcome !== true && outcome?.ok !== true) {
      if (!store.getNode(id)) removed.add(id)
      return finish(false, outcome?.problems || ['The agent could not be removed.'])
    }
    if (store.getNode(id)) return finish(false, ['The agent is still in the tree. No further agents were removed.'])
    removed.add(id)
  }
  return finish(!!plan?.ok, plan?.problems || [])
}

export function branchRemovalConfirmation(name, count) {
  const below = count - 1 === 1 ? 'the 1 agent' : `all ${countNoun(count - 1, 'agent')}`
  return `This removes ${name} and ${below} below it (${countNoun(count, 'agent')} total), including their saved conversations here. The signed run records are kept.`
}
