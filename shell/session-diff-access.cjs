'use strict'

const { createDiffFiles, diffAnswer } = require('./diff-file.cjs')
const { readDesktopTreeSnapshot } = require('./desktop-tree-snapshot.cjs')
const TREE_KEY = 'mc.fleet.trees.v1:this-computer'
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 128
  && /^[a-z0-9][a-z0-9._:/-]*$/i.test(value)
const unavailable = () => ({ ok: false, code: 'MC_DIFF_SESSION_SCOPE_UNAVAILABLE' })

// Session history supplies a requested file, never a directory grant. Native
// ownership and the currently registered profile provide that separately.
function createSessionDiffAccess({ fs, path, sessions, readDefault, stampDefault, writeDefault, readPreferences,
  resolveProfile, assertPath, captureCeiling, intersectCeiling }) {
  const retained = new Map(), revoked = new Set()
  let savedFallbackEnabled = true
  const same = (left, right) => path.relative(left, right) === ''
  const ownerAlive = owner => owner && typeof owner.isDestroyed === 'function' && !owner.isDestroyed()
  function limit() {
    while (retained.size > 1024) retained.delete(retained.keys().next().value)
    // Evicting an explicit revocation must never re-enable its saved grant.
    if (revoked.size > 4096) {
      savedFallbackEnabled = false
      while (revoked.size > 4096) revoked.delete(revoked.values().next().value)
    }
  }
  function capture(owner, sessionId, profileId, cwd, session = null, nodeId = null) {
    const root = assertPath(cwd)
    const current = assertPath(resolveProfile(profileId))
    if (!same(root, current)) throw Error('Profile changed')
    return { owner, sessionId, profileId, root, session, nodeId,
      ceiling: captureCeiling([root]), naturalExit: false, openedFiles: new Set() }
  }
  function remember(sessionId, session) {
    if (!validId(sessionId) || !session?.started || !ownerAlive(session.owner)
        || session.ownerKind !== 'window' || !validId(session.profileId)
        || typeof session.cwd !== 'string' || retained.has(sessionId) || revoked.has(sessionId)) return
    try {
      const scope = capture(session.owner, sessionId, session.profileId, session.cwd, session, session.treeNodeId || null)
      retained.set(sessionId, scope)
      limit()
    } catch { /* A refused read grant must not interrupt a provider event. */ }
  }
  function ended(sessionId, session, reason) {
    const held = retained.get(sessionId)
    if (reason === 'exited') {
      if (held?.session === session) held.naturalExit = true
      return
    }
    if (!held || held.session === session) retained.delete(sessionId)
    revoked.add(sessionId)
    limit()
  }
  function savedBinding(sessionId) {
    const preferences = readPreferences()
    const forest = readDesktopTreeSnapshot(preferences)
    const node = forest.nodes.find(entry => entry.sessionId === sessionId)
    if (!node) return null
    // The shared validator proves the entire forest before this private field
    // is read. The remote tree projection intentionally omits profile IDs.
    const raw = JSON.parse(preferences.values[TREE_KEY])
    const tree = raw.trees.find(entry => entry.id === node.treeId)
    if (!validId(tree?.profileId)) return null
    return { nodeId: node.id, treeId: node.treeId, profileId: tree.profileId }
  }
  function validate(scope, owner) {
    if (scope.owner !== owner || !ownerAlive(owner)) throw Error('Owner changed')
    const active = sessions.get(scope.sessionId)
    if (active && active !== scope.session) throw Error('Session replaced')
    if (scope.session && !active && !scope.naturalExit) throw Error('Session disposed')
    if (scope.nodeId) {
      const binding = savedBinding(scope.sessionId)
      if (!binding || binding.nodeId !== scope.nodeId || binding.profileId !== scope.profileId) throw Error('Tree changed')
      for (const [id, session] of sessions) {
        if (id !== scope.sessionId && session.owner === owner && session.treeNodeId === scope.nodeId) throw Error('Node replaced')
      }
    }
    const root = assertPath(resolveProfile(scope.profileId))
    if (!same(root, scope.root)) throw Error('Profile changed')
    const current = intersectCeiling(scope.ceiling, [root])
    if (current.length !== 1 || !same(current[0], scope.ceiling[0].canonical)) throw Error('Folder changed')
    return current[0]
  }
  function read(owner, request) {
    const candidate = request?.path
    try {
      // Apply the common account fence before any disk path supplied on IPC.
      if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return diffAnswer('MC_DIFF_HANDLER_FAILED', () => readDefault(candidate))
      const checked = assertPath(candidate)
      // Reader failures are not scope failures. Keep this catch inside the
      // account/session validation boundary so only the reader gets this code.
      const ordinary = diffAnswer('MC_DIFF_HANDLER_FAILED', () => readDefault(checked))
      if (ordinary.ok || ordinary.code !== 'MC_DIFF_OUTSIDE_WORKSPACE') return ordinary
      const sessionId = request?.sessionId
      if (!validId(sessionId) || revoked.has(sessionId) || !ownerAlive(owner)) return unavailable()
      let scope = retained.get(sessionId)
      if (!scope) {
        const active = sessions.get(sessionId)
        if (active) {
          if (active.owner !== owner || active.ownerKind !== 'window') return unavailable()
          remember(sessionId, active)
          scope = retained.get(sessionId)
          if (!scope) return unavailable()
        } else {
          if (!savedFallbackEnabled) return unavailable()
          // After an app reload, the saved native node and its still-registered
          // profile are independent current review authority. No old process
          // or history-supplied path is treated as a surviving grant.
          const binding = savedBinding(sessionId)
          if (!binding) return unavailable()
          scope = capture(owner, sessionId, binding.profileId, resolveProfile(binding.profileId), null, binding.nodeId)
          retained.set(sessionId, scope)
          limit()
        }
      }
      validate(scope, owner)
      const files = createDiffFiles({ fs, path, workspaceRoots: () => [validate(scope, owner)] })
      const result = diffAnswer('MC_DIFF_HANDLER_FAILED', () => files.readChange(checked))
      validate(scope, owner)
      if (result.ok) {
        scope.openedFiles.add(result.path)
        if (scope.openedFiles.size > 1024) scope.openedFiles.delete(scope.openedFiles.values().next().value)
      }
      return result.ok ? { ...result, readOnly: false, readScope: 'registered-session-folder' } : result
    } catch { return unavailable() }
  }
  // A recorded path is never a write grant. The file must first have been
  // opened by this window, and its native session/profile/root must still match.
  function edit(owner, request, operation) {
    try {
      if (typeof request?.path !== 'string' || !path.isAbsolute(request.path)) return unavailable()
      const checked = assertPath(request.path)
      const defaultAction = operation === 'write' ? writeDefault : stampDefault
      const ordinary = operation === 'stamp'
        ? diffAnswer('MC_DIFF_HANDLER_FAILED', () => defaultAction?.(checked, request.text))
        : defaultAction?.(checked, request.text)
      if (ordinary && (ordinary.ok || ordinary.code !== 'MC_DIFF_OUTSIDE_WORKSPACE')) return ordinary
      if (!validId(request.sessionId) || revoked.has(request.sessionId)) return unavailable()
      const scope = retained.get(request.sessionId)
      if (!scope || !scope.openedFiles.has(checked)) return unavailable()
      validate(scope, owner)
      const files = createDiffFiles({ fs, path, workspaceRoots: () => [validate(scope, owner)] })
      return operation === 'stamp'
        ? diffAnswer('MC_DIFF_HANDLER_FAILED', () => files.stamp(checked))
        : files[operation](checked, request.text)
    } catch { return unavailable() }
  }
  return Object.freeze({ remember, ended, read,
    stamp: (owner, request) => edit(owner, request, 'stamp'),
    write: (owner, request) => edit(owner, request, 'write') })
}

module.exports = { createSessionDiffAccess }
