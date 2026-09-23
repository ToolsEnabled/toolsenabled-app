'use strict'

// Reuses the renderer preference record; drafts never reach this host. The
// module loaded from the selected engine is the single policy parser.
function createActionPermissionProfileHost({ prefs, policy, sessions, getAgentHost, readWorkingProfile }) {
  const readWorkingProfileReceipt = typeof readWorkingProfile === 'function' ? readWorkingProfile : () => null
  function readSaved() {
    const snapshot = prefs.snapshot()
    if (snapshot?.ok !== true || snapshot.damaged) throw new Error('Saved permission settings are unavailable.')
    return snapshot.values?.[policy.SETTINGS_KEY] ?? null
  }
  function readWorkingProfileId() {
    try {
      const receipt = readWorkingProfileReceipt()
      if (typeof receipt === 'string') return receipt
      return receipt && typeof receipt.id === 'string' ? receipt.id : null
    } catch {
      return null
    }
  }
  function isDirectUserTurn(sessionId) {
    const session = sessions.get(sessionId)
    return Boolean(session && !session.ended && getAgentHost()?.isDirectUserTurn(sessionId) === true)
  }
  function hasInheritedUserPermission(sessionId) {
    const session = sessions.get(sessionId)
    if (!session || session.ended) return false
    return (getAgentHost()?.inheritedUserPermissionSessions(sessionId) || []).some(id => {
      const ancestor = sessions.get(id)
      return ancestor && !ancestor.ended && ancestor.owner === session.owner && ancestor.ownerKind === session.ownerKind
    })
  }
  return { readSaved, readWorkingProfile: readWorkingProfileId, isDirectUserTurn, hasInheritedUserPermission,
    read: () => policy.normalize(readSaved()),
    save(value) { return prefs.set(policy.SETTINGS_KEY, JSON.stringify(policy.normalize(value))) },
  }
}
module.exports = { createActionPermissionProfileHost }
