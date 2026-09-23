'use strict'
const { randomUUID } = require('node:crypto')
const { shortcutLabel } = require('./screen-control-visuals.cjs')
const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }

// Grants are issued by the local window, held only in memory, and tied to a
// live session and role revision. The OS stop shortcut is the exclusive desktop
// lease across app processes; keep it until this process has no native writer.
function createScreenControlHost({ sessions, readBinding, readBindingSnapshot = null, permissionLevel, adapter,
  audit, emit = () => {}, indicator, now = Date.now }) {
  if (typeof indicator.release !== 'function') throw new TypeError('Screen control needs a desktop lease release operation')
  const grants = new Map(), modes = new Map(), grantIntents = new Map()
  const idleReleaseMs = 60000
  const pendingGrants = new Set()
  let tail = Promise.resolve(), active = null, grantEpoch = 0, queued = 0,
    holder = null, idleTimer = null, activeAction = null,
    leaseHeld = false, releasing = false, cleanupUnconfirmed = false, closing = false
  /* The chord is not a constant: the indicator arms whichever one the platform
     grants, and on Windows the first choice is never granted. Reporting a fixed
     string here would have told every caller to press a key combination this
     machine had refused us. Null while nothing is armed -- "no stop chord is
     held" is a different answer from "the chord is X", and callers must be able
     to tell them apart. */
  function armedStopShortcut() {
    return indicator.stopShortcut?.() ?? null
  }
  /* The SAME armed value, mapped to key caps HERE, where shortcutLabel already
     lives. The grant screen used to hard-code 'Ctrl + Alt + Esc' on every
     platform while Windows arms Control+Alt+Shift+Escape, so it taught a chord
     this build never armed and Windows reserves. Mapping in the renderer would
     be a second copy of the rule, which is how that defect was born. Null when
     nothing is armed, so a caller says 'the Stop all button' instead of naming
     a chord that would do nothing. */
  function armedStopKeys() {
    const armed = armedStopShortcut()
    return armed ? shortcutLabel(armed).split('+') : null
  }
  function releaseIfIdle() {
    if (!leaseHeld || releasing || grants.size || pendingGrants.size || queued || active || cleanupUnconfirmed) return
    releasing = true
    try { indicator.release(); leaseHeld = false }
    finally { releasing = false }
  }
  function binding(owner, sessionId, resolve = readBinding) {
    const session = sessions.get(sessionId)
    if (!session || session.owner !== owner || session.ownerKind !== 'window'
        || session.ended || session.state === 'ended' || owner.isDestroyed?.()) {
      fail('SCREEN_AGENT_UNAVAILABLE', 'Choose a running agent in this local window.')
    }
    const role = resolve(session.agentId)
    if (!role?.enabled || !Number.isSafeInteger(role.revision)) fail('SCREEN_ROLE_UNAVAILABLE', 'The agent role is unavailable.')
    return { session, role, key: JSON.stringify([session.agentId, role.roleId, role.revision]) }
  }
  /* T369: the status poll used to read the org record from disk ONCE PER
     SESSION of the window -- 16 sessions, 16 synchronous reads and parses,
     240-306 ms on the owner's main thread every 10 s with control OFF. One
     status call now takes one snapshot of the org record (readBindingSnapshot,
     supplied by shell/main.cjs) and resolves every session from it; the
     snapshot is taken lazily, so a window with no sessions reads nothing.
     grant() and revoke() keep reading fresh per call: a binding that is about
     to be acted on must not come from a snapshot taken for display. */
  function state(owner) {
    expireControl()
    let resolver = null
    const resolveForStatus = agentId => {
      if (!resolver) resolver = (typeof readBindingSnapshot === 'function' && readBindingSnapshot()) || readBinding
      return resolver(agentId)
    }
    return { supported: adapter.supported(), unavailableReason: adapter.supported() ? null : adapter.unavailableReason?.(),
      cleanup: cleanupUnconfirmed ? 'unconfirmed' : active || queued ? 'pending' : 'confirmed', permissionLevel: permissionLevel(),
      mode: modes.get(owner) || 'selected', idleReleaseMs,
      agents: [...sessions.entries()].filter(([, session]) => session.owner === owner && session.ownerKind === 'window'
        && !session.ended && session.state !== 'ended').map(([sessionId, session]) => {
        let reason = null
        try { eligibleBinding(owner, sessionId, resolveForStatus) } catch (error) { reason = error.message }
        return { sessionId, agentId: session.agentId, eligible: !reason, reason }
      }),
      grants: [...grants.values()].filter(grant => grant.owner === owner).map(grant => ({
        sessionId: grant.sessionId, agentId: grant.agentId, label: grant.label, grantedAt: grant.grantedAt,
      })), activeAgentId: active?.owner === owner ? active.agentId : null,
      holderSessionId: holder?.grant.owner === owner ? holder.grant.sessionId : null,
      holderAgentId: holder?.grant.owner === owner ? holder.grant.agentId : null,
      holderLabel: holder?.grant.owner === owner ? holder.grant.label : null,
      activeAction: active?.owner === owner ? activeAction : null,
      stopShortcut: armedStopShortcut(), stopShortcutKeys: armedStopKeys() }
  }
  function eligibleBinding(owner, sessionId, resolve = readBinding) {
    const current = binding(owner, sessionId, resolve)
    if (Array.isArray(current.role.functions) && !current.role.functions.includes('screen.control')) {
      fail('SCREEN_FUNCTION_NOT_ASSIGNED', 'Add screen.control and screen.status to this agent’s role functions, then restart the agent.')
    }
    return current
  }
  function dropControl() {
    const owner = holder?.grant.owner
    holder = null; clearTimeout(idleTimer); idleTimer = null
    if (owner) { try { renderIndicator() } catch {}; publish(owner) }
  }
  function expireControl() {
    if (holder && !active && !queued && now() >= holder.expiresAt) dropControl()
  }
  function armIdleRelease() {
    clearTimeout(idleTimer); idleTimer = null
    if (!holder || active || queued) return
    holder.expiresAt = now() + idleReleaseMs
    idleTimer = setTimeout(expireControl, idleReleaseMs)
    idleTimer.unref?.()
  }
  function claimControl(grant) {
    expireControl()
    if (holder && holder.grant !== grant) {
      throw Object.assign(new Error('Another agent has computer control. Wait, then call screen.status; take a fresh screenshot when control becomes available.'), {
        code: 'SCREEN_BUSY', retryAfterMs: Math.max(1000, Math.min(5000, holder.expiresAt - now())),
      })
    }
    if (!holder) holder = { grant, expiresAt: now() + idleReleaseMs }
    return holder
  }
  function publish(owner) { emit(owner, state(owner)) }
  function renderIndicator(value) {
    try {
      if (cleanupUnconfirmed && leaseHeld) indicator.show({ label: 'Screen cleanup is unconfirmed' })
      else if (!grants.size && (active || queued) && leaseHeld) indicator.show({ label: 'Finishing screen input cleanup' })
      else if (grants.size) indicator.show(value || (holder
        ? { label: holder.grant.label, agentId: holder.grant.agentId, detail: 'Has computer control', moving: true }
        : { label: 'Computer control ready', detail: `${grants.size} allowed · one agent at a time` }))
      else indicator.hide()
    } catch (error) {
      const owners = new Set([...grants.values()].map(grant => grant.owner))
      grantEpoch += 1
      for (const grant of grants.values()) grant.controller.abort()
      grants.clear()
      holder = null; clearTimeout(idleTimer); idleTimer = null; modes.clear(); grantIntents.clear()
      try { indicator.hide() } catch {}
      for (const owner of owners) publish(owner)
      throw error
    }
  }
  function requireGrant(principal) {
    const grant = grants.get(principal?.sessionId)
    if (!grant || grant.controller.signal.aborted) {
      /* WHICH OF THE TWO IS IT? Grants live in memory keyed by sessionId, so a
         miss here means either the person has granted nothing, or they have
         granted -- and this session is not who they granted it to. Those need
         opposite advice, and saying "screen access is off" for the second one
         tells the person to switch on something already on.

         That is not hypothetical: an agent reported access off, filed a durable
         ask, and the owner answered "its on" (2026-09-15). Both were right. A
         later Settings/Page 2 choice had replaced the allowed set, and a
         session id that changes -- a continuation or account change -- misses
         this map the same way.

         Exclusivity is unchanged; only the sentence is. */
      const session = sessions.get(principal?.sessionId)
      const grantedElsewhere = Boolean(session) && [...grants.values()]
        .some(other => other.owner === session.owner && !other.controller.signal.aborted)
      if (grantedElsewhere) {
        fail('SCREEN_ACCESS_NOT_THIS_SESSION', 'Computer control is on, but it is granted to a different session. Ask the person to grant this agent access on Page 2.')
      }
      fail('SCREEN_ACCESS_OFF', 'Screen access is off. Ask the person to enable Computer control in Settings → App permissions, or grant this agent access on Page 2.')
    }
    let current
    try { current = binding(grant.owner, grant.sessionId) }
    catch (error) { revokeSession(grant.sessionId); throw error }
    if (permissionLevel() !== 'unrestricted' || current.session !== grant.session || current.key !== grant.bindingKey
        || principal.kind !== 'agent-session' || principal.agentId !== grant.agentId
        || principal.roleId !== current.role.roleId || principal.expectedRoleRevision !== current.role.revision) {
      revokeSession(grant.sessionId)
      fail('SCREEN_ACCESS_CHANGED', 'The agent, role or permission level changed. Screen access was revoked.')
    }
    return grant
  }
  function grant(owner, request) {
    const operation = grantNow(owner, request)
    pendingGrants.add(operation)
    const finished = operation.finally(() => { pendingGrants.delete(operation); releaseIfIdle() })
    // Shutdown also observes pending admission; never detach an unhandled
    // rejection if its renderer disappears before the answer arrives.
    finished.catch(() => {})
    return finished
  }
  async function grantNow(owner, { sessionIds, mode, labels = {} } = {}) {
    if (closing) fail('SCREEN_HOST_CLOSING', 'This app is closing; screen access is off.')
    if (cleanupUnconfirmed) fail('SCREEN_INPUT_RELEASE_FAILED', 'Native input cleanup is unconfirmed. This app is retaining desktop ownership.')
    const epoch = grantEpoch
    if (active) fail('SCREEN_ACTION_ACTIVE', 'Wait for the current screen action to finish before changing grants.')
    if (mode !== undefined && !['selected', 'any-running'].includes(mode)) fail('SCREEN_SELECTION_INVALID', 'Choose all running agents or selected agents.')
    if (mode === 'any-running') sessionIds = [...sessions.keys()].filter(id => {
      try { eligibleBinding(owner, id); return true } catch { return false }
    })
    if (!Array.isArray(sessionIds) || sessionIds.length < 1 || sessionIds.length > 32
        || new Set(sessionIds).size !== sessionIds.length) fail('SCREEN_SELECTION_INVALID', 'Select one through 32 running agents.')
    if (permissionLevel() !== 'unrestricted') fail('SCREEN_PERMISSION_REQUIRED', 'Screen takeover requires Unrestricted permissions.')
    if (!adapter.supported()) fail('SCREEN_PLATFORM_UNAVAILABLE', adapter.unavailableReason?.() || 'Screen control requires Windows or a Linux X11 desktop session.')
    const selected = sessionIds.map(sessionId => {
      const current = eligibleBinding(owner, sessionId)
      return { owner, sessionId, session: current.session, agentId: current.session.agentId, bindingKey: current.key,
        label: String(labels?.[sessionId] || current.role.displayName || current.session.agentId).slice(0, 80),
        grantedAt: now(), controller: new AbortController() }
    })
    // A newer explicit allowed set supersedes grants still awaiting admission
    // from an older surface. Keep ownership local to this window; legacy
    // additive calls retain their existing concurrent behavior.
    const intent = mode ? {} : grantIntents.get(owner)
    if (mode) grantIntents.set(owner, intent)
    // The indicator and emergency stop must be usable before any grant exists.
    leaseHeld = true
    try { await indicator.ready(() => revokeAll()) }
    catch (error) { revokeAll(); throw error }
    await audit({ event: 'screen-access-granted', sessionIds, grantId: randomUUID() })
    if (epoch !== grantEpoch || intent !== grantIntents.get(owner)) fail('SCREEN_ACCESS_CHANGED', 'Screen access changed before this grant completed.')
    if (active) fail('SCREEN_ACTION_ACTIVE', 'Wait for the current screen action to finish before changing grants.')
    for (const entry of selected) {
      const current = binding(owner, entry.sessionId)
      if (current.session !== entry.session || current.key !== entry.bindingKey || permissionLevel() !== 'unrestricted') {
        fail('SCREEN_ACCESS_CHANGED', 'The agent or permission level changed before screen access was granted.')
      }
    }
    // An explicit Settings/Page 2 choice replaces the allowed set. Legacy
    // callers without a mode keep their additive grant behavior.
    if (mode) {
      for (const existing of [...grants.values()]) if (existing.owner === owner) revokeSession(existing.sessionId)
      modes.set(owner, mode)
    }
    for (const entry of selected) {
      const previous = grants.get(entry.sessionId)
      previous?.controller.abort()
      if (holder?.grant === previous) dropControl()
      grants.set(entry.sessionId, entry)
    }
    renderIndicator()
    publish(owner)
    return state(owner)
  }
  function revokeSession(sessionId) {
    grantEpoch += 1
    const grant = grants.get(sessionId)
    if (!grant) return
    grants.delete(sessionId); grant.controller.abort()
    if (holder?.grant === grant) dropControl()
    if (![...grants.values()].some(value => value.owner === grant.owner)) modes.delete(grant.owner)
    try { renderIndicator() } catch {}
    releaseIfIdle()
    publish(grant.owner)
    void Promise.resolve(audit({ event: 'screen-access-revoked', sessionId })).catch(() => {})
  }
  function revokeAll(owner) {
    grantEpoch += 1
    if (owner) grantIntents.delete(owner)
    else grantIntents.clear()
    for (const grant of [...grants.values()]) if (!owner || grant.owner === owner) revokeSession(grant.sessionId)
    return owner ? state(owner) : { grants: [] }
  }
  function revoke(owner, { sessionIds } = {}) {
    if (sessionIds === undefined) return revokeAll(owner)
    if (!Array.isArray(sessionIds) || sessionIds.length > 32) fail('SCREEN_SELECTION_INVALID', 'Select the agents to stop.')
    for (const id of sessionIds) if (grants.get(id)?.owner === owner) revokeSession(id)
    return state(owner)
  }
  function status(principal) {
    expireControl()
    let grant
    try { grant = requireGrant(principal) } catch (error) { return { enabled: false, supported: adapter.supported(),
      state: 'off', reason: error.code || 'SCREEN_ACCESS_OFF', nextAction: error.message } }
    const ownsControl = holder?.grant === grant, busy = Boolean(holder && !ownsControl)
    return { enabled: true, agentId: grant.agentId, ...adapter.geometry(),
      state: busy ? 'busy' : ownsControl ? 'controlling' : 'ready', ownsControl, idleReleaseMs,
      retryAfterMs: busy ? Math.max(1000, Math.min(5000, holder.expiresAt - now())) : 0,
      actions: ['acquire', 'screenshot', 'move', 'click', 'drag', 'scroll', 'type', 'key', 'release'],
      nextAction: busy ? 'Another agent has control. Wait before checking screen.status again. Do not send input yet.'
        : 'Call screen.control with action screenshot to acquire control and inspect. Keep dependent actions sequential; use action release when finished.',
      coordinates: 'Use desktop coordinates from the latest screenshot. Screenshot pixels map to its returned bounds.',
      stopShortcut: armedStopShortcut() }
  }
  function control(principal, input) {
    const original = requireGrant(principal)
    const originalInput = Object.freeze({ ...input })
    const management = ['acquire', 'release'].includes(input?.action)
    if (management && Object.keys(input).some(key => key !== 'action')) fail('SCREEN_ACTION_INVALID', 'Acquire and release take only the action field.')
    let action = management ? originalInput : adapter.validate(input)
    if (queued >= 32) fail('SCREEN_QUEUE_FULL', 'Wait for a screen action to finish before sending another.')
    if (action.action === 'release' && holder?.grant !== original) return Promise.resolve({ status: 'completed', action: 'release', released: false, control: status(principal) })
    const turn = claimControl(original)
    clearTimeout(idleTimer); idleTimer = null
    queued += 1
    const execute = tail.then(async () => {
      if (requireGrant(principal) !== original) fail('SCREEN_ACCESS_CHANGED', 'This action belonged to a previous screen grant.')
      if (holder !== turn) fail('SCREEN_CONTROL_CHANGED', 'The previous turn ended. Take a fresh screenshot before continuing.')
      if (management) {
        await audit({ event: 'screen-control-' + action.action, sessionId: original.sessionId })
        if (requireGrant(principal) !== original || holder !== turn) fail('SCREEN_ACCESS_CHANGED', 'Screen access changed before control was updated.')
        if (action.action === 'release') dropControl()
        else { renderIndicator(); publish(original.owner) }
        return { status: 'completed', action: action.action, released: action.action === 'release', control: status(principal) }
      }
      active = original
      activeAction = action.action
      let nativeAttempted = false, nativeCleanupConfirmed = false
      try {
        renderIndicator({ label: original.label, agentId: original.agentId, action: action.action, moving: true })
        publish(original.owner)
        await audit({ event: 'screen-action-intent', sessionId: original.sessionId, action: action.action })
        if (requireGrant(principal) !== original) fail('SCREEN_ACCESS_CHANGED', 'Screen access changed before the action.')
        // Monitor geometry can change while an action waits in the queue.
        action = adapter.validate(originalInput)
        nativeAttempted = action.action !== 'screenshot'
        const result = await adapter.execute(action, original.controller.signal)
        nativeCleanupConfirmed = result?.cleanupConfirmed === true
        if (nativeAttempted && result?.cleanupConfirmed !== true) {
          fail('SCREEN_INPUT_RELEASE_FAILED', 'The native input helper did not confirm cleanup.')
        }
        if (original.controller.signal.aborted) fail('SCREEN_ACTION_INTERRUPTED', 'Screen access was stopped. Inspect the screen before repeating the action.')
        await audit({ event: 'screen-action-result', sessionId: original.sessionId, action: action.action, status: 'completed' })
        // Image delivery is a new disclosure after the awaited completion audit.
        // Completed input remains truthful even when access was subsequently stopped.
        if (action.action === 'screenshot' || result?.__mcpImage) {
          if (original.controller.signal.aborted) fail('SCREEN_ACTION_INTERRUPTED', 'Screen access was stopped before the image could be returned.')
          if (requireGrant(principal) !== original || holder !== turn) fail('SCREEN_ACCESS_CHANGED', 'Screen access changed before the image could be returned.')
        }
        // The action completed, but Stop may have revoked access during its
        // completion audit. Keep completed input truth and report current authority.
        if (result && typeof result === 'object') {
          const current = status(principal)
          result.control = { ...current, ownsControl: current.ownsControl === true,
            nextAction: current.ownsControl
              ? 'Inspect the result before the next action. Call screen.control with action release when finished.'
              : current.nextAction }
        }
        return result
      } catch (error) {
        if (nativeAttempted && !nativeCleanupConfirmed && error.cleanupConfirmed !== true) {
          cleanupUnconfirmed = true
          revokeAll()
        }
        try { await audit({ event: 'screen-action-result', sessionId: original.sessionId, action: action.action, status: 'incomplete' }) } catch {}
        throw error
      } finally {
        active = null; activeAction = null
        try { renderIndicator() } catch {}
        publish(original.owner)
      }
    })
    const result = execute.finally(() => { queued -= 1; armIdleRelease(); releaseIfIdle() }).then(value => {
      // Final indicator/state publication can itself revoke access. Admit a
      // native result only after cleanup, before the next queued action runs.
      if (!management && (action.action === 'screenshot' || value?.__mcpImage)) {
        if (original.controller.signal.aborted) fail('SCREEN_ACTION_INTERRUPTED', 'Screen access was stopped before the result could be returned.')
        if (requireGrant(principal) !== original || holder !== turn) fail('SCREEN_ACCESS_CHANGED', 'Screen access changed before the result could be returned.')
      }
      if (!management && value && typeof value === 'object') {
        const current = status(principal)
        value.control = { ...current, ownsControl: current.ownsControl === true,
          nextAction: current.ownsControl
            ? 'Inspect the result before the next action. Call screen.control with action release when finished.'
            : current.nextAction }
      }
      return value
    })
    tail = result.catch(() => {})
    return result
  }
  async function shutdown() {
    closing = true
    revokeAll()
    await Promise.allSettled([...pendingGrants])
    await tail
    if (cleanupUnconfirmed) fail('SCREEN_INPUT_RELEASE_FAILED', 'Native input cleanup is unconfirmed. Desktop ownership is retained and this app cannot safely quit.')
    releaseIfIdle()
    if (leaseHeld) fail('SCREEN_INPUT_RELEASE_FAILED', 'Desktop ownership could not be released after screen cleanup.')
    return { cleanupConfirmed: true }
  }
  return { state, grant, revoke, revokeAll, revokeSession, close: owner => revokeAll(owner), status, control, shutdown }
}
module.exports = { createScreenControlHost }
