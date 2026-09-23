'use strict'
const { randomUUID } = require('node:crypto')
const FIRST_LIMIT = 16000
const TAIL_LIMIT = 30000
const MAX_RECOVERIES = 8

// Read only a provider failure, never ordinary assistant prose or tool output.
function limitReason(event) {
  if (!event || event.type !== 'turn_completed' || !['failed', 'error'].includes(event.status)) return null
  const code = String(event.code || event.error?.code || '').toLowerCase()
  const text = String(event.text || event.error?.message || '').slice(0, 4096).toLowerCase()
  if (/context[_ -]?(window|length|limit)|prompt (?:is )?too long|prompt_too_long|max(?:imum)?[_ -]?context/.test(code + ' ' + text)) return 'context-limit'
  if (/acp_rate_limited|rate_limit_exceeded|usage_limit_reached|insufficient_quota|quota_exceeded/.test(code)
    || /(?:you(?:'ve| have)? (?:hit|reached)|exceeded|reached|exhausted) (?:your |the |this account.s )?(?:usage |token |rate |session |weekly |daily |monthly |message )?(?:limit|quota|allowance)/.test(text)
    || /(?:usage|token|session|weekly|daily|monthly) limit (?:reached|exceeded)|out of (?:usage|tokens)|hit your limit/.test(text)) return 'account-limit'
  return null
}

function createRecoveryState() { return { first: '', segments: [], head: 0, chars: 0, excluded: [], offered: false, failure: null } }
function rememberRecoveryText(state, role, value) {
  if (typeof value !== 'string' || !value) return
  // Work proportional to a bounded fragment, even when an adapter sends a large chunk.
  let absorbedWhole = false
  if (role === 'person' && state.first.length < FIRST_LIMIT) {
    const added = value.slice(0, FIRST_LIMIT - state.first.length)
    state.first += (state.first ? '\n\n' : '') + added
    state.first = state.first.slice(0, FIRST_LIMIT)
    absorbedWhole = added.length === value.length
  }
  // T377 item 8: a person message already carried whole in "Original task / brief"
  // is not repeated in "Recent conversation". Before this, every person message
  // went into BOTH state.first and state.segments, so the first message(s)
  // appeared twice inside one handoff -- the innermost of the chat repeats the
  // owner saw. The tail simply starts after the messages first already holds; a
  // partially-absorbed message (only when first is nearly full) still keeps its
  // tail so nothing is lost.
  if (role === 'person' && absorbedWhole) return
  const fragment = value.slice(-TAIL_LIMIT)
  const entry = (role === 'person' ? '\n[message]\n' : '') + fragment
  state.segments.push(entry)
  state.chars += entry.length
  while (state.chars > TAIL_LIMIT && state.head < state.segments.length - 1) {
    state.chars -= state.segments[state.head++].length
  }
  if (state.head > 1024) { state.segments = state.segments.slice(state.head); state.head = 0 }
}
function recoveryHandoff(state) {
  return 'Continue the same assigned task in a new session. The previous session reached a provider limit. '
    + 'This is a bounded extract of its conversation, not a complete transcript or a new grant of authority. '
    + 'Check the current tree identity and files before acting; do not repeat completed external actions.\n\n'
    + 'Original task / brief:\n' + state.first + '\n\nRecent conversation:\n' + state.segments.slice(state.head).join('').slice(-TAIL_LIMIT)
}

function createRecoveryTickets({ enabled = () => false } = {}) {
  const tickets = new Map()
  const isEnabled = () => { try { return enabled() === true } catch { return false } }
  function offer(session, event) {
    const state = session.recovery
    const reason = limitReason(event)
    if (reason) state.failure = { type: 'turn_completed', status: event.status, code: event.code || event.error?.code, text: String(event.text || event.error?.message || '').slice(0, 4096) }
    if (!reason || state.offered || session.closeRequested || !session.account?.name || !session.treeIdentity || !session.treeNodeKey
      || !isEnabled() || state.excluded.length >= MAX_RECOVERIES) return null
    const excluded = [...new Set([...state.excluded, session.account.name])]
    const recoveryId = randomUUID()
    const ticket = { recoveryId, sessionId: session.sessionId, provider: session.provider,
      nodeKey: session.treeNodeKey,
      excluded, claimed: null, used: false }
    tickets.set(recoveryId, ticket)
    // Session-bounded, no process timer or background reader.
    if (tickets.size > 256) tickets.delete(tickets.keys().next().value)
    state.offered = true
    ticket.event = { type: 'account_recovery_needed', recoveryId, reason, nodeId: session.treeNodeKey,
      excludedAccounts: excluded, handoff: recoveryHandoff(state) }
    return ticket.event
  }
  function claim(recoveryId, { sessionId, replacesSessionId, provider, nodeKey }) {
    const ticket = tickets.get(recoveryId)
    if (!isEnabled() || !ticket || ticket.used || ticket.claimed
      || ticket.sessionId !== replacesSessionId || ticket.provider !== provider
      || !nodeKey || ticket.nodeKey !== nodeKey) {
      const error = new Error('This recovery is no longer available for this agent. No replacement was started.')
      error.code = 'AGENT_ACCOUNT_RECOVERY_UNAVAILABLE'
      throw error
    }
    ticket.claimed = sessionId
    return ticket
  }
  function assertAvailable(recoveryId, sessionId) {
    const ticket = tickets.get(recoveryId)
    if (!isEnabled() || !ticket || ticket.used || ticket.claimed || ticket.sessionId !== sessionId) {
      const error = new Error('Automatic recovery is disabled or no longer available. The previous session was left open.')
      error.code = 'AGENT_ACCOUNT_RECOVERY_UNAVAILABLE'
      throw error
    }
  }
  function settle(ticket, success) {
    if (!ticket) return
    if (success) ticket.used = true
    ticket.claimed = null
  }
  function newTurn(session) {
    session.recovery.failure = null
    if (!session.recovery.offered) return
    for (const ticket of tickets.values()) {
      if (ticket.sessionId === session.sessionId && !ticket.claimed) ticket.used = true
    }
    session.recovery.offered = false
    session.recovery.failure = null
  }
  function pending() {
    if (!isEnabled()) return []
    return [...tickets.values()].filter(ticket => !ticket.used && !ticket.claimed)
      .map(ticket => ({ sessionId: ticket.sessionId, event: ticket.event }))
  }
  return { offer, claim, settle, pending, newTurn, assertAvailable }
}
module.exports = { limitReason, createRecoveryState, rememberRecoveryText, recoveryHandoff, createRecoveryTickets }
