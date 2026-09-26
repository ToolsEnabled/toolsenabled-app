'use strict'

const { performance } = require('node:perf_hooks')
const MAX_CAP_MS = 24 * 60 * 60 * 1000
const fail = () => { throw Object.assign(new Error('The selected tree parent or bounded work changed before admission.'), { code: 'MC_TREE_BOUNDED_WORK_REFUSED' }) }
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

function parseBoundedWork(value) {
  const keys = ['computerId', 'treeId', 'parentNodeId', 'parentSessionId', 'capMs']
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))
      || !keys.slice(0, 4).every(key => id(value[key]))
      || !Number.isSafeInteger(value.capMs) || value.capMs < 1000 || value.capMs > MAX_CAP_MS) fail()
  return Object.freeze(Object.fromEntries(keys.map(key => [key, value[key]])))
}

// Owner work uses the saved graph and authenticated live parent. It never
// issues an agent delegation token or translates a session into a legacy lane.
function createBoundedTreeAuthority({ readParent, readTree, resolveProfile, defaultCwd,
  now = () => performance.now(), wallNow = () => Date.now() }) {
  return Object.freeze({
    begin(request, owner) {
      const work = parseBoundedWork(request.boundedWork)
      if (!owner || request.delegationPermit || request.resumeThreadId || request.replacesSessionId
          || request.accountRecovery || !id(request.sessionId) || !id(request.requestKeys?.threadId)
          || request.agentId !== request.requestKeys.threadId) fail()
      const nodeId = request.requestKeys.threadId
      const startedAt = wallNow(), expires = now() + work.capMs
      let cancelled = false
      function snapshot() {
        try {
          const parent = readParent(work.parentSessionId)
          const graph = readTree(work.computerId)
          if (!parent || parent.owner !== owner || parent.sessionId !== work.parentSessionId
              || parent.nodeId !== work.parentNodeId || !Array.isArray(parent.treeAnchors)
              || !parent.selfName || request.treeIdentity?.managerName !== parent.selfName
              || parent.treeAnchors.at(-1) !== parent.nodeId || parent.treeAnchors.length >= 16
              || !graph || graph.computerId !== work.computerId || !Array.isArray(graph.nodes) || !Array.isArray(graph.trees)) fail()
          const nodes = graph.nodes.filter(node => node?.id === nodeId)
          const parents = graph.nodes.filter(node => node?.id === work.parentNodeId)
          const trees = graph.trees.filter(tree => tree?.id === work.treeId)
          if (nodes.length !== 1 || parents.length !== 1 || trees.length !== 1) fail()
          const child = nodes[0], savedParent = parents[0], tree = trees[0]
          if (child.id === savedParent.id || child.treeId !== work.treeId || savedParent.treeId !== work.treeId
              || child.parentId !== savedParent.id || savedParent.sessionId !== work.parentSessionId
              || child.sessionId && child.sessionId !== request.sessionId
              || child.tier !== request.tier || (child.role || 'worker') !== request.role?.id) fail()
          const ancestry = []
          let current = child
          while (current) {
            if (ancestry.includes(current.id) || current.treeId !== work.treeId || ancestry.length >= 16) fail()
            ancestry.unshift(current.id)
            if (!current.parentId) break
            const ancestors = graph.nodes.filter(node => node?.id === current.parentId)
            if (ancestors.length !== 1) fail()
            current = ancestors[0]
          }
          if (!same(ancestry, [...parent.treeAnchors, nodeId]) || !same(ancestry, request.requestKeys.treeAnchors)) fail()
          const profileId = tree.profileId || null
          const cwd = profileId ? resolveProfile(profileId) : defaultCwd()
          if (!cwd || cwd !== request.cwd || cwd !== parent.cwd) fail()
          return { parent, profileId, nodeId, treeId: work.treeId, parentId: child.parentId,
            role: child.role || 'worker', tier: child.tier, cwd }
        } catch { fail() }
      }
      const captured = JSON.parse(JSON.stringify(snapshot()))
      const details = Object.freeze({ action: 'tree.dispatch', ...work, nodeId,
        sessionId: request.sessionId, agentId: request.agentId, startedAt, deadlineAt: startedAt + work.capMs })
      return Object.freeze({
        details,
        remainingMs: () => Math.max(0, expires - now()),
        assertStart() { if (cancelled || now() >= expires || !same(snapshot(), captured)) fail() },
        cancel() { cancelled = true },
      })
    },
  })
}

module.exports = Object.freeze({ MAX_CAP_MS, parseBoundedWork, createBoundedTreeAuthority })
