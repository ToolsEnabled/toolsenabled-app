'use strict'

const RECOVERY_PREFIX = 'mc.action-permissions.recovery.'
const recoveryKey = key => typeof key === 'string' && key.startsWith(RECOVERY_PREFIX) && /^[a-zA-Z0-9_-]{1,100}$/.test(key.slice(RECOVERY_PREFIX.length))
const refuse = (code, message) => { throw Object.assign(new Error(message), { code }) }

// Reuses the renderer preference record; drafts never reach this host. The
// module loaded from the selected engine is the single policy parser.
function createActionPermissionProfileHost({ prefs, policy, sessions, getAgentHost, readWorkingProfile }) {
  const readWorkingProfileReceipt = typeof readWorkingProfile === 'function' ? readWorkingProfile : () => null
  function readSnapshot() {
    const snapshot = prefs.snapshot()
    if (snapshot?.ok !== true || snapshot.damaged) refuse('ACTION_PERMISSION_PROFILE_UNAVAILABLE', 'Saved permission settings are unavailable. No permission settings were changed.')
    return snapshot
  }
  const savedValue = snapshot => snapshot.values?.[policy.SETTINGS_KEY] ?? null
  const readSaved = () => savedValue(readSnapshot())
  function requireExpected(snapshot, expectedValue) {
    if ((expectedValue !== null && typeof expectedValue !== 'string') || savedValue(snapshot) !== expectedValue) {
      refuse('ACTION_PERMISSION_PROFILE_CHANGED', 'Saved permission profiles changed. Reopen Settings before trying again.')
    }
  }
  function preserve(key, raw) {
    if (!recoveryKey(key) || typeof raw !== 'string') refuse('ACTION_PERMISSION_PROFILE_RECOVERY_REQUIRED', 'A valid permission recovery copy is required.')
    const snapshot = readSnapshot()
    requireExpected(snapshot, raw)
    const previous = snapshot.values?.[key]
    if (previous !== undefined && previous !== raw) refuse('ACTION_PERMISSION_PROFILE_RECOVERY_CONFLICT', 'The permission recovery copy already holds another record. No permission settings were changed.')
    if (previous === undefined) {
      const result = prefs.set(key, raw)
      if (result?.ok !== true) return result?.ok === false ? result : { ok: false, error: { code: 'ACTION_PERMISSION_PROFILE_RECOVERY_REQUIRED', message: 'The original permission profiles could not be preserved.' } }
    }
    const verified = readSnapshot()
    requireExpected(verified, raw)
    if (verified.values?.[key] !== raw) refuse('ACTION_PERMISSION_PROFILE_RECOVERY_REQUIRED', 'The original permission profiles could not be verified in the recovery copy.')
    return { ok: true, unchanged: previous === raw }
  }
  function save(value, options = {}) {
    const canonical = JSON.stringify(policy.normalize(value))
    const snapshot = readSnapshot()
    if (Object.hasOwn(options, 'expectedValue')) requireExpected(snapshot, options.expectedValue)
    let invalid = false
    try { policy.normalize(savedValue(snapshot)) }
    catch (error) {
      if (error?.code !== 'ACTION_PERMISSION_PROFILE_INVALID') throw error
      invalid = true
    }
    if (invalid && (!Object.hasOwn(options, 'expectedValue') || !Object.entries(snapshot.values || {}).some(([key, raw]) => recoveryKey(key) && raw === savedValue(snapshot)))) {
      refuse('ACTION_PERMISSION_PROFILE_RECOVERY_REQUIRED', 'Preserve the original permission profiles before resetting them. No permission settings were changed.')
    }
    const result = prefs.set(policy.SETTINGS_KEY, canonical)
    return result?.ok === true ? { ...result, value: canonical } : result
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
    save, preserve,
  }
}
module.exports = { createActionPermissionProfileHost }
