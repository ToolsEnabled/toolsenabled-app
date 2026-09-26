'use strict'
const { randomInt, randomUUID, createHash } = require('node:crypto')
const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
const cleanSpeech = text => String(text || '').toLowerCase().replace(/[.,!?]/g, '').replace(/\s+/g, ' ').trim()
const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']
function confirmationDigits(text) {
  const words = cleanSpeech(text).replace(/^confirm action /, '')
  const tokens = words.split(' ')
  if (!tokens.every(word => /^\d+$/.test(word) || DIGITS.includes(word))) return null
  const digits = tokens.map(word => /^\d+$/.test(word) ? word : DIGITS.indexOf(word)).join('')
  return /^\d{4}$/.test(digits) ? digits : null
}

// One explicit local owner delegation. No persisted switch, background monitor,
// model permission grants, shell commands or role-name conditionals live here.
function createAccessibilityHost({
  sessions, readBinding, permissionLevel, isDirectUserTurn, planAction, inspect,
  emit = () => {}, announce = () => {}, interruptAgent = () => {},
  audit, now = Date.now, makeId = randomUUID, makeCode = () => String(randomInt(1000, 10000)),
  platform = process.platform,
}) {
  if (typeof audit !== 'function') throw new TypeError('Accessibility requires an audit writer.')
  let mode = null, pending = null, last = null, busy = false, expiry = null, enabling = null, revocation = 0
  const seenVoice = new Set()
  const desktopSupported = platform === 'win32'
  const defaultScope = desktopSupported ? 'desktop' : 'application'
  const desktopUnavailable = 'Desktop accessibility is currently available only on Windows. Choose ToolsEnabled screens on this computer.'
  function scopes() {
    return [
      { id: 'application', label: 'ToolsEnabled screens', supported: true, reason: null },
      { id: 'desktop', label: 'Windows desktop', supported: desktopSupported, reason: desktopSupported ? null : desktopUnavailable },
    ]
  }
  function owned(owner, sessionId) {
    const session = sessions.get(sessionId)
    if (!session || session.owner !== owner || session.ownerKind !== 'window'
        || session.ended || session.state === 'ended' || owner?.isDestroyed?.()) {
      fail('ACCESSIBILITY_OWNER_REQUIRED', 'Choose a live agent in this local application window.')
    }
    return session
  }
  function binding(owner, sessionId) {
    const session = owned(owner, sessionId)
    const current = readBinding(session.agentId)
    if (!current || current.enabled !== true || typeof current.roleId !== 'string' || !Number.isSafeInteger(current.revision)) {
      fail('ACCESSIBILITY_ROLE_UNAVAILABLE', 'The current role could not be checked.')
    }
    return { ...current, agentId: session.agentId, key: JSON.stringify([session.agentId, current.roleId, current.revision]) }
  }
  function scopeAllowed(scope) {
    if (!['application', 'desktop'].includes(scope)) fail('ACCESSIBILITY_SCOPE_INVALID', 'Choose application or desktop control.')
    if (scope === 'desktop' && !desktopSupported) fail('ACCESSIBILITY_SCOPE_UNSUPPORTED', desktopUnavailable)
    const level = permissionLevel()
    if (scope === 'desktop' ? level !== 'unrestricted' : !['standard', 'unrestricted'].includes(level)) {
      fail('ACCESSIBILITY_PERMISSION_REQUIRED', scope === 'desktop'
        ? 'Desktop Accessibility requires Unrestricted permissions in this application instance. Nothing was enabled.'
        : 'Application actions require Standard or Unrestricted permissions. Nothing was enabled.')
    }
  }
  function state(owner, { agent = false } = {}) {
    const visible = mode?.owner === owner ? mode : null
    const request = pending?.owner === owner && pending.expiresAt > now() ? pending : null
    return {
      enabled: Boolean(visible), sessionId: visible?.sessionId || null, scope: visible?.scope || null, busy: busy || Boolean(enabling),
      permissionLevel: permissionLevel(),
      scopes: scopes(),
      pending: request ? { requestId: request.id, kind: request.kind, summary: request.summary,
        expiresAt: request.expiresAt, ...(agent ? {} : { confirmationCode: request.code }) } : null,
      last: last?.owner === owner ? { status: last.status, message: last.message } : null,
    }
  }
  function publish(owner, speech) {
    emit(owner, state(owner))
    const sessionId = pending?.sessionId || mode?.sessionId || last?.sessionId
    if (speech) void Promise.resolve().then(() => announce(owner, sessionId, speech)).catch(() => {})
  }
  function forgetPending() { clearTimeout(expiry); expiry = null; pending = null }
  function stage(request) {
    if (pending) fail('ACCESSIBILITY_CONFIRMATION_PENDING', 'Confirm or reject the pending request first.')
    pending = { ...request, id: makeId(), code: makeCode(), expiresAt: now() + 60000 }
    const current = pending
    expiry = setTimeout(() => {
      if (pending !== current) return
      forgetPending()
      last = { owner: current.owner, sessionId: current.sessionId, status: 'expired', message: 'Confirmation expired. Nothing was done.' }
      publish(current.owner)
    }, 60000)
    expiry.unref?.()
    publish(request.owner, request.summary + '. Your four-digit confirmation code is ' + [...pending.code].map(digit => DIGITS[Number(digit)]).join(' ') + '. This is not an account password. Say the words confirm action followed by that code. Or say reject action.')
    return { requestId: pending.id, status: 'awaiting-user-confirmation', summary: pending.summary, expiresAt: pending.expiresAt }
  }
  function prepareEnable(owner, { sessionId, scope = defaultScope } = {}) {
    if (mode || busy || enabling) fail('ACCESSIBILITY_ALREADY_ACTIVE', 'Stop the current Accessibility session first.')
    scopeAllowed(scope)
    const current = binding(owner, sessionId)
    const functions = current.functions
    if (Array.isArray(functions) && !functions.includes('accessibility.propose')) {
      fail('ACCESSIBILITY_FUNCTION_NOT_ASSIGNED', 'Assign accessibility.propose in this agent\'s role sheet, then restart the agent.')
    }
    return stage({ kind: 'enable', owner, sessionId, scope, bindingKey: current.key,
      summary: 'Enable ' + (scope === 'desktop' ? 'desktop' : 'application') + ' Accessibility for this agent until you stop it or close this window. Each action still needs a separate confirmation. Nearby voices can be heard by the microphone' })
  }
  function requireMode(principal) {
    const current = mode
    if (!current || current.sessionId !== principal?.sessionId || current.controller.signal.aborted) {
      fail('ACCESSIBILITY_OFF', 'Accessibility is off for this agent. The person must explicitly enable it.')
    }
    const role = binding(current.owner, current.sessionId)
    if (role.key !== current.bindingKey || principal.agentId !== role.agentId
        || principal.roleId !== role.roleId || principal.expectedRoleRevision !== role.revision) {
      disable(current.owner, 'The agent or role changed. Enable Accessibility again after restarting the agent.')
      fail('ACCESSIBILITY_ROLE_CHANGED', 'The saved role changed; this control session was revoked.')
    }
    scopeAllowed(current.scope)
    return current
  }
  async function propose(principal, input) {
    const current = requireMode(principal)
    if (busy || pending) fail('ACCESSIBILITY_CONFIRMATION_PENDING', 'Finish or reject the current action first.')
    if (!isDirectUserTurn(current.sessionId)) fail('ACCESSIBILITY_DIRECT_REQUEST_REQUIRED', 'Actions must originate in a direct user request.')
    const planned = await planAction(input, current, principal)
    if (mode !== current || current.controller.signal.aborted || !isDirectUserTurn(current.sessionId)) {
      fail('ACCESSIBILITY_REQUEST_EXPIRED', 'The direct request ended or control was stopped before the proposal was ready.')
    }
    requireMode(principal)
    if (!planned || typeof planned.execute !== 'function' || typeof planned.summary !== 'string' || planned.summary.length > 3000) {
      fail('ACCESSIBILITY_PLAN_INVALID', 'The requested action could not be described safely.')
    }
    return stage({ kind: 'action', owner: current.owner, sessionId: current.sessionId,
      scope: current.scope, bindingKey: current.bindingKey, summary: planned.summary,
      execute: planned.execute, actionKind: planned.kind, principal, mode: current })
  }
  async function confirm(owner, { requestId, code } = {}) {
    const request = pending
    if (!request || request.owner !== owner || request.id !== requestId || request.code !== code || request.expiresAt <= now()) {
      fail('ACCESSIBILITY_CONFIRMATION_INVALID', 'This confirmation is missing, expired or does not match the pending action.')
    }
    // Consume before any await. Replays, double clicks and repeated speech can
    // never execute this request twice.
    forgetPending()
    if (binding(owner, request.sessionId).key !== request.bindingKey) {
      fail('ACCESSIBILITY_ROLE_CHANGED', 'The role changed before confirmation. Nothing was done.')
    }
    scopeAllowed(request.scope)
    if (request.kind === 'enable') {
      const epoch = revocation
      enabling = request
      try {
        await audit({ event: 'enable-confirmed', requestId: request.id, sessionId: request.sessionId, scope: request.scope })
        if (epoch !== revocation || owner.isDestroyed?.()) return { status: 'canceled' }
        if (binding(owner, request.sessionId).key !== request.bindingKey) fail('ACCESSIBILITY_ROLE_CHANGED', 'The role changed before enabling.')
        scopeAllowed(request.scope)
        mode = { owner, sessionId: request.sessionId, scope: request.scope,
          bindingKey: request.bindingKey, controller: new AbortController() }
        last = { owner, sessionId: request.sessionId, status: 'enabled', message: 'Accessibility is on. Say stop accessibility to revoke control.' }
        publish(owner, last.message)
        return { status: 'enabled' }
      } finally { if (enabling === request) enabling = null; publish(owner) }
    }
    const current = requireMode(request.principal)
    if (current !== request.mode) fail('ACCESSIBILITY_REQUEST_EXPIRED', 'This action belonged to an earlier control session.')
    busy = true
    publish(owner)
    try {
      await audit({ event: 'action-authorized', requestId: request.id, sessionId: request.sessionId,
        kind: request.actionKind, previewHash: createHash('sha256').update(request.summary).digest('hex') })
      if (mode !== current || current.controller.signal.aborted) return { status: 'canceled' }
      requireMode(request.principal)
      const result = await request.execute(current.controller.signal)
      const status = result?.status === 'completed' ? 'completed' : 'unknown'
      last = { owner, sessionId: request.sessionId, status,
        message: status === 'completed' ? 'The confirmed action completed.' : 'The result is uncertain. Inspect the target before trying again.' }
      await audit({ event: 'action-result', requestId: request.id, sessionId: request.sessionId, status })
      return { status, result }
    } catch (error) {
      last = { owner, sessionId: request.sessionId, status: 'failed',
        message: current.controller.signal.aborted ? 'Control was stopped. Inspect the target; an action already delivered may have applied.'
          : (error?.message || 'The action failed. Inspect the target before retrying.') }
      throw error
    } finally {
      busy = false
      publish(owner, last?.message)
    }
  }
  function reject(owner) {
    if (!pending || pending.owner !== owner) return { rejected: false }
    const sessionId = pending.sessionId
    forgetPending()
    last = { owner, sessionId, status: 'rejected', message: 'Action rejected. Nothing was done.' }
    publish(owner, last.message)
    return { rejected: true }
  }
  function disable(owner, message = 'Accessibility is off. Pending control was revoked.') {
    if ((mode && mode.owner !== owner) || (pending && pending.owner !== owner) || (enabling && enabling.owner !== owner)) {
      fail('ACCESSIBILITY_OTHER_WINDOW', 'This control session belongs to another local window.')
    }
    const sessionId = mode?.sessionId || pending?.sessionId || enabling?.sessionId
    revocation += 1
    mode?.controller.abort()
    mode = null
    if (pending) pending.canceled = true
    forgetPending()
    last = { owner, sessionId, status: 'off', message }
    publish(owner, message)
    if (sessionId) void Promise.resolve(interruptAgent(sessionId)).catch(() => {})
    return { enabled: false }
  }
  function onVoice(owner, packet) {
    if (!packet || !['transcript.partial', 'transcript.final'].includes(packet.type)) return false
    const text = cleanSpeech(packet.text)
    if (text === 'stop accessibility' || text === 'disable accessibility') {
      if ((!mode || mode.owner === owner) && (!pending || pending.owner === owner) && (!enabling || enabling.owner === owner)) disable(owner)
      return true
    }
    if (packet.type !== 'transcript.final') return false
    const key = JSON.stringify([packet.sessionId, packet.generation, packet.utteranceId || packet.sequence])
    if (seenVoice.has(key)) return true
    // A bare code (or "the key is ...") is not consent. Keep it out of the
    // model conversation while a matching owner request is pending, and give
    // mechanical guidance without echoing the supplied value. Exact command
    // wording remains required so our own spoken code cannot authorize itself.
    const matchingPrompt = pending?.owner === owner && pending.sessionId === packet.targetAgentId
    const tagged = /^(?:(?:the|my) )?(?:code|key|password)(?: is)? /.test(text)
    const password = /^(?:(?:the|my) )?password(?: is)? /.test(text)
    const digits = confirmationDigits(text.replace(/^(?:(?:the|my) )?(?:code|key|password)(?: is)? /, ''))
    // Keep explicitly named passwords/codes local even after a preview expires.
    // Unrelated numbers (years, quantities) outside a prompt remain normal input.
    const bareCode = !text.startsWith('confirm action')
      && ((matchingPrompt && (digits !== null || tagged)) || password || (tagged && digits !== null))
    const handled = text === 'enable accessibility' || text === 'enable desktop accessibility'
      || text === 'enable application accessibility' || text === 'reject action' || text === 'confirm action'
      || text.startsWith('confirm action ') || bareCode
    if (!handled) return false
    seenVoice.add(key)
    if (seenVoice.size > 256) seenVoice.delete(seenVoice.values().next().value)
    try {
      if (bareCode || text === 'confirm action') {
        last = { owner, sessionId: packet.targetAgentId, status: 'awaiting-confirmation',
          message: matchingPrompt
            ? 'Nothing was approved. Say the words confirm action followed by all four digits of the current code. Or say reject action.'
            : 'Nothing was approved or sent to the agent. There is no matching confirmation. Request the action again. Do not say an account password.' }
        publish(owner, last.message)
      } else if (text.startsWith('enable ')) prepareEnable(owner, { sessionId: packet.targetAgentId,
        scope: text === 'enable application accessibility' ? 'application' : text === 'enable desktop accessibility' ? 'desktop' : defaultScope })
      else if (text === 'reject action') reject(owner)
      else {
        if (!pending || pending.sessionId !== packet.targetAgentId) fail('ACCESSIBILITY_CONFIRMATION_INVALID', 'There is no matching confirmation for this voice contact.')
        const code = confirmationDigits(text)
        void confirm(owner, { requestId: pending.id, code }).catch(error => {
          last = { owner, sessionId: packet.targetAgentId, status: 'refused', message: error.message }
          publish(owner, error.message)
        })
      }
    } catch (error) {
      last = { owner, sessionId: packet.targetAgentId, status: 'refused', message: error.message }
      publish(owner, error.message)
    }
    return true
  }
  return {
    state, prepareEnable, confirm, reject, disable, onVoice, propose,
    status(principal) {
      const session = sessions.get(principal?.sessionId)
      if (!session || session.agentId !== principal.agentId || session.ownerKind !== 'window' || session.ended) return { enabled: false }
      const value = state(session.owner, { agent: true })
      if (value.sessionId !== principal.sessionId && pending?.sessionId !== principal.sessionId) return { enabled: false, permissionLevel: value.permissionLevel, scopes: value.scopes }
      return value
    },
    async inspect(principal, input) {
      const current = requireMode(principal)
      const result = await inspect(input, current, principal)
      if (requireMode(principal) !== current) fail('ACCESSIBILITY_REQUEST_EXPIRED', 'The control session changed.')
      return result
    },
    revokeSession(sessionId) {
      const current = [mode, pending, enabling].find(value => value?.sessionId === sessionId)
      if (current) disable(current.owner, 'The agent session ended. Accessibility is off.')
    },
    close(owner) { if (mode?.owner === owner || pending?.owner === owner || enabling?.owner === owner) disable(owner) },
  }
}
module.exports = { createAccessibilityHost, confirmationDigits }
