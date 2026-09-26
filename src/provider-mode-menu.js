import { refusalCode, unavailableReason } from './agent-availability-copy.js'

// Provider modes are session capabilities, independent of permission tiers.
const SESSION_NOT_OPEN = 'This session is no longer open, so it has no provider mode to read or change. Start the agent again, then reopen Provider mode.'
function unavailableMessage(result) {
  if (!result.availableModes.length) return 'This provider session does not support mode switching.'
  if (result.code === 'CODEX_MODE_RESUMED_SETTINGS_UNAVAILABLE') {
    return "This resumed session's settings are unavailable. Its mode cannot change while preserving its model and instructions."
  }
  if (result.code === 'CODEX_MODE_SETTINGS_REQUIRED') {
    return "This session's settings are unavailable. Its mode cannot change while preserving its model and instructions."
  }
  return 'The provider offers these modes, but they cannot be applied to this session.'
}

/* UNAVAILABLE_TEXT IS A FRAGMENT TABLE, AND THIS MENU SAYS ITS SENTENCE ALONE.
   Its neighbours read "the agent has not finished stopping...", "there was
   nothing running to stop...", and every other caller either picks one of the
   few whole-sentence entries (fleet-tree-copy.js:1319), supplies the lead-in
   ("An agent cannot start on this computer yet: ...", setup-review-readiness.js:68)
   or capitalises and closes it (fleet-tree-copy.js:2449). This menu prints the
   result on its own -- through ctx.say() and again as the state row's own
   label and disabledHint below -- beside "Choose a mode advertised by this
   provider." and "Provider mode applied: ...", while the Home reader already
   capitalises the same two codes (local-activity.js ENGINE_REASON). So the one
   table entry is reused -- never copied again -- and given the shape the
   surface needs. Same terminator class as endSentence() in fleet-tree-copy.js,
   the join that already does this for the third surface, so an entry ending in
   an ellipsis is not given a second stop. */
const modeRefusalSentence = code => {
  const reason = unavailableReason(code)
  const sentence = reason.charAt(0).toUpperCase() + reason.slice(1)
  return /[.!?…]$/.test(sentence) ? sentence : `${sentence}.`
}

export function createProviderModeMenu({ sessionId, bridge, isCurrent = () => true, blockingReason = () => '', subscribe = null }) {
  let disposed = false
  let unsubscribe = null
  let refreshQueued = false
  let observation = 0
  let accepted = null
  let pending = false
  let needsRead = false
  let refusal = ''
  let message = 'Reading provider modes...'
  let operation = 0
  const current = () => !disposed && isCurrent() === true
  const valid = value => value && value.sessionId === sessionId
    && typeof value.provider === 'string' && typeof value.supported === 'boolean'
    && typeof value.pending === 'boolean' && Array.isArray(value.availableModes)
    && value.availableModes.every(mode => mode && typeof mode.id === 'string' && mode.id.length > 0)
    && new Set(value.availableModes.map(mode => mode.id)).size === value.availableModes.length
    && (value.currentModeId === null || typeof value.currentModeId === 'string')
    && (!value.supported || value.currentModeId === null || value.availableModes.some(mode => mode.id === value.currentModeId))
  const failure = error => {
    const code = refusalCode(error)
    if (code === 'AGENT_MODE_UNAVAILABLE' || code === 'AGENT_MODE_SELECTION_UNCONFIRMED') return modeRefusalSentence(code)
    // A restored agent has no open session. The IPC layer wraps the host's code
    // in "Error invoking remote method ..."; say what it means instead.
    if (code === 'MC_AGENT_UNKNOWN_SESSION' || code === 'MC_AGENT_SESSION_ENDED') return SESSION_NOT_OPEN
    return error?.message || error?.code || 'Provider mode request failed. Refresh provider modes to read the current state.'
  }
  const modeStatus = (result, selected = false) => {
    if (!result.supported) return unavailableMessage(result)
    if (result.pending) return 'A provider mode change is pending confirmation.'
    const mode = result.availableModes.find(mode => mode.id === result.currentModeId)
    if (!mode) return 'The provider has not reported a current mode. Choose a mode advertised by this provider.'
    const name = mode.name || mode.id
    if (result.appliesOn === 'next-turn') return `Provider mode selected: ${name}. Applies on the next turn.`
    if (result.appliesOn === 'subsequent-turns') return `Provider mode selected: ${name}. Applies to subsequent turns.`
    if (result.appliesOn) return `Provider mode confirmed: ${name}. Its application timing is not available.`
    return selected ? `Provider mode applied: ${name}` : `Current provider mode: ${name}.`
  }
  const tell = ctx => { if (current()) { ctx.say(message); if (current()) ctx.refresh?.() } }
  async function read(ctx, { automatic = false } = {}) {
    if (!current() || pending) return
    if (!sessionId) { message = 'Start a session to read its provider modes.'; tell(ctx); return }
    if (typeof bridge?.modes !== 'function') { message = 'Provider mode controls are unavailable in this build. Open a complete ToolsEnabled build to use them.'; tell(ctx); return }
    const serial = ++operation
    const observed = observation
    refreshQueued = false
    pending = true
    message = automatic && refusal ? refusal : 'Reading provider modes...'
    tell(ctx)
    if (!current()) return
    try {
      const result = await bridge.modes({ sessionId })
      if (!current() || serial !== operation) return
      if (observed !== observation) return
      if (!valid(result)) throw new Error('The host returned an unconfirmed provider mode state.')
      accepted = result
      // An event refresh can report current authority, but it cannot dismiss
      // the person's failed change or silently enable another attempt.
      if (!automatic) refusal = ''
      needsRead = Boolean(refusal)
      message = refusal || modeStatus(result)
    } catch (error) {
      if (!current() || serial !== operation || observed !== observation) return
      needsRead = true
      refusal = automatic && refusal ? refusal : failure(error)
      message = refusal
    } finally {
      if (current() && serial === operation) {
        pending = false
        tell(ctx)
        if (current() && refreshQueued) void read(ctx, { automatic })
      }
    }
  }
  async function select(modeId, ctx) {
    if (!current() || pending || needsRead || accepted?.pending) return
    const reason = blockingReason()
    if (reason) { message = reason; tell(ctx); return }
    if (!accepted?.supported || !accepted.availableModes.some(mode => mode.id === modeId)) return
    if (typeof bridge?.setMode !== 'function') { message = 'Changing provider mode is unavailable in this build. Open a complete ToolsEnabled build to change it.'; tell(ctx); return }
    const serial = ++operation
    pending = true
    message = 'Waiting for provider mode confirmation...'
    tell(ctx)
    if (!current()) return
    try {
      const result = await bridge.setMode({ sessionId, modeId })
      if (!current() || serial !== operation) return
      if (!valid(result) || result.provider !== accepted.provider || result.applied !== true
          || result.pending || result.currentModeId !== modeId) {
        throw new Error('The provider did not confirm this mode change. Read its current state before retrying.')
      }
      accepted = result
      refusal = ''
      message = modeStatus(result, true)
    } catch (error) {
      if (!current() || serial !== operation) return
      needsRead = true
      refusal = failure(error)
      message = refusal
    } finally {
      if (current() && serial === operation) {
        pending = false
        tell(ctx)
        if (current() && refreshQueued) void read(ctx, { automatic: true })
      }
    }
  }
  function rows() {
    const stale = !current()
    const reason = stale ? 'This session changed. Reopen provider modes.' : blockingReason()
    return [
      { id: 'provider-mode-state', label: message, enabled: false, disabledHint: message },
      ...(accepted ? accepted.availableModes.map(mode => ({
        id: 'provider-mode-' + mode.id, label: mode.name || mode.id, hint: mode.description || '',
        current: accepted.currentModeId === mode.id,
        enabled: accepted.supported && !stale && !pending && !needsRead && !accepted.pending && !reason && typeof bridge?.setMode === 'function',
        disabledHint: reason || (!accepted.supported ? unavailableMessage(accepted) : '') || (needsRead ? 'Refresh provider modes before another change.' : '') || (pending || accepted.pending ? 'Waiting for provider confirmation.' : 'Changing provider mode is unavailable in this build. Open a complete ToolsEnabled build to change it.'),
        run: ctx => select(mode.id, ctx),
      })) : []),
      { id: 'provider-mode-refresh', label: 'Refresh provider modes', enabled: !stale && !pending,
        disabledHint: stale ? 'This session changed.' : 'Waiting for the current request.', run: read },
    ]
  }
  function dispose() {
    disposed = true
    operation++
    unsubscribe?.()
    unsubscribe = null
  }
  return { rows, dispose, open: ctx => {
    if (!current()) return
    ctx.show(rows, { title: 'Provider mode' })
    ctx.onClose?.(dispose)
    if (typeof subscribe === 'function' && !unsubscribe) {
      unsubscribe = subscribe(packet => {
        if (!current() || packet?.sessionId !== sessionId || packet.event?.type !== 'session_mode_changed') return
        observation++
        refreshQueued = true
        if (!pending) void read(ctx, { automatic: true })
      })
    }
    return read(ctx)
  } }
}
