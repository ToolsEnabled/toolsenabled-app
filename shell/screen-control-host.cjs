'use strict'
const { randomUUID } = require('node:crypto')
const { shortcutLabel } = require('./screen-control-visuals.cjs')
const { validRecords } = require('./screen-control-permissions.cjs')
const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }

// Active grants stay in memory, tied to a live session and role revision.
// An optional saved choice may admit a later session of the exact same circle.
// The OS stop shortcut is the exclusive desktop
// lease across app processes; keep it until this process has no native writer.
function createScreenControlHost({ sessions, readBinding, readBindingSnapshot = null, permissionLevel, adapter,
  audit, emit = () => {}, indicator, now = Date.now, permissions = null, readIdentity = () => null, readIdentitySnapshot = null }) {
  if (typeof indicator.release !== 'function') throw new TypeError('Screen control needs a desktop lease release operation')
  const grants = new Map(), modes = new Map(), grantIntents = new Map()
  const remembered = new Map(), restoreFlights = new Map()
  let permissionProblem = null, checkingState = false
  const identityKey = value => JSON.stringify(['computerId', 'treeId', 'nodeId', 'nodeCreatedAt', 'agentId', 'roleId'].map(key => value[key]))
  try {
    const saved = permissions?.read() || []
    if (!validRecords(saved)) throw new Error('Remembered computer control is invalid.')
    for (const record of saved) remembered.set(identityKey(record), Object.freeze({ ...record }))
  } catch (error) { permissionProblem = error.message }
  function saveRemembered(next) {
    // Memory is revoked even if durable storage refuses. Never retry or restore
    // old authority in this process after a failed permission write.
    try { permissions.write([...next.values()]); permissionProblem = null }
    catch (error) {
      remembered.clear(); permissionProblem = error.message; grantEpoch += 1
      for (const grant of [...grants.values()]) if (grant.rememberedKey) revokeSession(grant.sessionId)
      throw error
    }
    remembered.clear()
    for (const [key, value] of next) remembered.set(key, value)
    for (const grant of [...grants.values()]) if (grant.rememberedKey && !remembered.has(grant.rememberedKey)) revokeSession(grant.sessionId)
  }
  function forgetRemembered(keys = null) {
    if (!permissions || (!remembered.size && !permissionProblem)) return
    const next = new Map(remembered)
    if (keys === null) next.clear()
    else for (const key of keys) next.delete(key)
    if (next.size !== remembered.size || permissionProblem) saveRemembered(next)
  }
  function identityFor(sessionId, current, label) {
    const identity = readIdentity(current.session, sessionId)
    const record = identity && { ...identity, agentId: current.session.agentId, roleId: current.role.roleId, label }
    return validRecords([record]) ? Object.freeze(record) : null
  }
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
    if (!checkingState && permissionLevel() !== 'unrestricted' && grants.size) {
      checkingState = true
      try {
        // An unavailable prerequisite suspends access, not the user's choice.
        revokeAll(undefined, { forget: false })
      } finally { checkingState = false }
    }
    return { supported: adapter.supported(), unavailableReason: adapter.supported() ? null : adapter.unavailableReason?.(),
      cleanup: cleanupUnconfirmed ? 'unconfirmed' : active || queued ? 'pending' : 'confirmed', permissionLevel: permissionLevel(),
      mode: modes.get(owner) || 'selected', idleReleaseMs,
      remembered: [...remembered.values()].map(record => ({ nodeId: record.nodeId, label: record.label })),
      permissionProblem,
      agents: [...sessions.entries()].filter(([, session]) => session.owner === owner && session.ownerKind === 'window'
        && !session.ended && session.state !== 'ended').map(([sessionId, session]) => {
        let reason = null
        try { eligibleBinding(owner, sessionId, resolveForStatus) } catch (error) { reason = error.message }
        return { sessionId, agentId: session.agentId, nodeId: session.treeNodeId || null, eligible: !reason, reason }
      }),
      grants: [...grants.values()].filter(grant => grant.owner === owner).map(grant => ({
        sessionId: grant.sessionId, agentId: grant.agentId, label: grant.label, grantedAt: grant.grantedAt,
        lifetime: grant.rememberedKey ? 'remember' : 'session',
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
         ask, and the answer was that access was on. Both were right. A
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
    try { current = eligibleBinding(grant.owner, grant.sessionId) }
    catch (error) { revokeSession(grant.sessionId); throw error }
    if (grant.rememberedKey && !remembered.has(grant.rememberedKey)) {
      revokeSession(grant.sessionId)
      fail('SCREEN_ACCESS_CHANGED', 'Remembered computer control was turned off.')
    }
    if (permissionLevel() !== 'unrestricted' || current.session !== grant.session || current.key !== grant.bindingKey
        || principal.kind !== 'agent-session' || principal.agentId !== grant.agentId
        || principal.roleId !== current.role.roleId || principal.expectedRoleRevision !== current.role.revision) {
      revokeSession(grant.sessionId, { forget: current.role.roleId !== grant.roleId })
      fail('SCREEN_ACCESS_CHANGED', 'The agent, role or permission level changed. Screen access was revoked.')
    }
    return grant
  }
  function grant(owner, request, restoring = false) {
    const operation = grantNow(owner, request, restoring)
    pendingGrants.add(operation)
    const finished = operation.finally(() => { pendingGrants.delete(operation); releaseIfIdle() })
    // Shutdown also observes pending admission; never detach an unhandled
    // rejection if its renderer disappears before the answer arrives.
    finished.catch(() => {})
    return finished
  }
  async function grantNow(owner, { sessionIds, mode, labels = {}, lifetime = 'session' } = {}, restoring = false) {
    if (closing) fail('SCREEN_HOST_CLOSING', 'This app is closing; screen access is off.')
    if (cleanupUnconfirmed) fail('SCREEN_INPUT_RELEASE_FAILED', 'Native input cleanup is unconfirmed. This app is retaining desktop ownership.')
    const epoch = grantEpoch
    if (active) fail('SCREEN_ACTION_ACTIVE', 'Wait for the current screen action to finish before changing grants.')
    if (!['session', 'remember'].includes(lifetime)) fail('SCREEN_SELECTION_INVALID', 'Choose temporary access or access until you turn it off.')
    if (lifetime === 'remember' && !permissions) fail('SCREEN_REMEMBER_UNAVAILABLE', 'This app cannot save computer control permission. Use temporary access.')
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
      const label = String(labels?.[sessionId] || current.role.displayName || current.session.agentId).slice(0, 80)
      const identity = lifetime === 'remember' ? identityFor(sessionId, current, label) : null
      if (lifetime === 'remember' && !identity) fail('SCREEN_REMEMBER_IDENTITY_REQUIRED', 'Remembered access needs a saved local tree agent. Use temporary access for this session.')
      const rememberedKey = identity ? identityKey(identity) : null
      if (restoring && !remembered.has(rememberedKey)) fail('SCREEN_ACCESS_CHANGED', 'Remembered computer control was turned off.')
      return { owner, sessionId, session: current.session, agentId: current.session.agentId, bindingKey: current.key, roleId: current.role.roleId,
        label, identity, rememberedKey,
        grantedAt: now(), controller: new AbortController() }
    })
    // A newer explicit allowed set supersedes grants still awaiting admission
    // from an older surface. Keep ownership local to this window; legacy
    // additive calls retain their existing concurrent behavior.
    const intent = mode ? {} : grantIntents.get(owner)
    if (mode) grantIntents.set(owner, intent)
    // The indicator and emergency stop must be usable before any grant exists.
    leaseHeld = true
    /* THIS CALLBACK IS THE EMERGENCY STOP, so what it fails to do matters.
       revokeAll revokes every live grant BEFORE it rethrows, so a throw here
       does not mean screen access continued -- it means the REMEMBERED
       permission could not be cleared, and the person who just pressed stop can
       have that access restored later without being asked again. Swallowed,
       that outcome is indistinguishable from a clean stop, on the one control
       whose whole purpose is to be trusted in a hurry. */
    try {
      await indicator.ready(() => {
        try { revokeAll() }
        catch (error) {
          void Promise.resolve(audit({
            event: 'screen-access-revoke-incomplete',
            reason: error && (error.code || error.message) ? String(error.code || error.message) : 'unknown',
          })).catch(() => {})
        }
      })
    }
    catch (error) { revokeAll(undefined, { forget: false }); throw error }
    await audit({ event: 'screen-access-granted', sessionIds, grantId: randomUUID() })
    if (epoch !== grantEpoch || intent !== grantIntents.get(owner)) fail('SCREEN_ACCESS_CHANGED', 'Screen access changed before this grant completed.')
    if (active) fail('SCREEN_ACTION_ACTIVE', 'Wait for the current screen action to finish before changing grants.')
    for (const entry of selected) {
      const current = eligibleBinding(owner, entry.sessionId)
      if (current.session !== entry.session || current.key !== entry.bindingKey || permissionLevel() !== 'unrestricted') {
        fail('SCREEN_ACCESS_CHANGED', 'The agent or permission level changed before screen access was granted.')
      }
      if (entry.identity && identityKey(identityFor(entry.sessionId, current, entry.label) || {}) !== entry.rememberedKey) {
        fail('SCREEN_ACCESS_CHANGED', 'The saved agent changed before computer control was granted.')
      }
      if (restoring && !remembered.has(entry.rememberedKey)) fail('SCREEN_ACCESS_CHANGED', 'Remembered computer control was turned off.')
    }
    if (!restoring && permissions) {
      const next = new Map(remembered)
      if (mode) next.clear() // An explicit allowed set replaces this profile's saved selection.
      for (const entry of selected) {
        if (entry.identity) next.set(entry.rememberedKey, entry.identity)
        else if (!mode && remembered.size) {
          const current = eligibleBinding(owner, entry.sessionId)
          const identity = identityFor(entry.sessionId, current, entry.label)
          if (identity) next.delete(identityKey(identity))
        }
      }
      if (JSON.stringify([...next]) !== JSON.stringify([...remembered]) || permissionProblem) saveRemembered(next)
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
  function revokeSession(sessionId, { forget = false } = {}) {
    grantEpoch += 1
    const grant = grants.get(sessionId)
    if (!grant) return
    let failed
    if (forget && grant.rememberedKey) { try { forgetRemembered([grant.rememberedKey]) } catch (error) { failed = error } }
    grants.delete(sessionId); grant.controller.abort()
    if (holder?.grant === grant) dropControl()
    if (![...grants.values()].some(value => value.owner === grant.owner)) modes.delete(grant.owner)
    try { renderIndicator() } catch {}
    releaseIfIdle()
    publish(grant.owner)
    void Promise.resolve(audit({ event: 'screen-access-revoked', sessionId })).catch(() => {})
    if (failed) throw failed
  }
  function revokeAll(owner, { forget = true } = {}) {
    grantEpoch += 1
    if (owner) grantIntents.delete(owner)
    else grantIntents.clear()
    let failed
    if (forget) { try { forgetRemembered() } catch (error) { failed = error } }
    for (const grant of [...grants.values()]) if (!owner || grant.owner === owner || (forget && grant.rememberedKey)) revokeSession(grant.sessionId)
    if (failed) throw failed
    return owner ? state(owner) : { grants: [] }
  }
  function revoke(owner, { sessionIds } = {}) {
    if (sessionIds === undefined) return revokeAll(owner)
    if (!Array.isArray(sessionIds) || sessionIds.length > 32) fail('SCREEN_SELECTION_INVALID', 'Select the agents to stop.')
    for (const id of sessionIds) {
      const session = sessions.get(id)
      if (session?.owner !== owner || session.ownerKind !== 'window') continue
      // Stop also cancels remembered restoration before a new grant is ready.
      grantEpoch += 1
      const keys = [...remembered].filter(([, record]) => record.nodeId === session.treeNodeId && record.agentId === session.agentId).map(([key]) => key)
      let failed
      try { forgetRemembered(keys) } catch (error) { failed = error }
      revokeSession(id, { forget: true })
      if (failed) throw failed
    }
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
  async function restore(owner, onlySessionId = null) {
    if (closing || permissionProblem || !remembered.size) return
    if (permissionLevel() !== 'unrestricted') { revokeAll(undefined, { forget: false }); return }
    if (!adapter.supported() || cleanupUnconfirmed || active) return
    // One saved-forest read per poll, not one synchronous read per agent.
    let resolveIdentity
    try { resolveIdentity = (typeof readIdentitySnapshot === 'function' && readIdentitySnapshot()) || readIdentity }
    catch (error) { revokeAll(undefined, { forget: false }); throw error }
    for (const [sessionId, session] of sessions) {
      if (onlySessionId && onlySessionId !== sessionId) continue
      if (session.owner !== owner || session.ownerKind !== 'window' || session.ended || ['ended', 'starting'].includes(session.state)) continue
      // A previous grant is never reused across session/role changes.
      const existing = grants.get(sessionId)
      if (existing && !existing.controller.signal.aborted) {
        try { const current = eligibleBinding(owner, sessionId); if (current.session === existing.session && current.key === existing.bindingKey) continue } catch {}
        revokeSession(sessionId)
      }
      const identity = resolveIdentity(session, sessionId)
      if (!identity) continue
      const matches = [...remembered].filter(([, record]) => ['computerId', 'treeId', 'nodeId', 'nodeCreatedAt', 'agentId'].every(key => record[key] === (key === 'agentId' ? session.agentId : identity[key])))
      if (!matches.length) continue
      let current
      try { current = eligibleBinding(owner, sessionId) }
      catch { continue }
      const accepted = matches.find(([, record]) => record.roleId === current.role.roleId)
      if (!accepted) { forgetRemembered(matches.map(([key]) => key)); continue }
      // A role edit cannot upgrade the old native principal. Wait for an
      // actually admitted current session; the saved choice is not a role lease.
      if (session.agentAuthority?.roleId !== current.role.roleId || session.agentAuthority?.expectedRoleRevision !== current.role.revision) continue
      let pending = restoreFlights.get(sessionId)
      if (!pending) {
        pending = grant(owner, { sessionIds: [sessionId], lifetime: 'remember', labels: { [sessionId]: accepted[1].label } }, true)
        restoreFlights.set(sessionId, pending)
        pending.finally(() => { if (restoreFlights.get(sessionId) === pending) restoreFlights.delete(sessionId) }).catch(() => {})
      }
      await pending
    }
  }
  async function restoreForPrincipal(principal) {
    if (principal?.kind !== 'agent-session') return
    const session = sessions.get(principal.sessionId)
    if (session?.ownerKind !== 'window' || session.agentId !== principal.agentId
        || session.agentAuthority?.roleId !== principal.roleId
        || session.agentAuthority?.expectedRoleRevision !== principal.expectedRoleRevision) return
    await restore(session.owner, principal.sessionId)
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
    revokeAll(undefined, { forget: false })
    await Promise.allSettled([...pendingGrants])
    await tail
    if (cleanupUnconfirmed) fail('SCREEN_INPUT_RELEASE_FAILED', 'Native input cleanup is unconfirmed. Desktop ownership is retained and this app cannot safely quit.')
    releaseIfIdle()
    if (leaseHeld) fail('SCREEN_INPUT_RELEASE_FAILED', 'Desktop ownership could not be released after screen cleanup.')
    return { cleanupConfirmed: true }
  }
  return { state, grant, revoke, revokeAll, revokeSession, close: owner => revokeAll(owner, { forget: false }), status, control, restore, restoreForPrincipal, shutdown }
}
module.exports = { createScreenControlHost }
