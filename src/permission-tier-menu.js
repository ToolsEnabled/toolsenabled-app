import { TIER_CHOICES, readSetupState, noteTierRecorded } from './setup-state.js'
import { createRiskGate, UNRESTRICTED_RISK_LEAD, UNRESTRICTED_RISK_STATEMENTS,
  UNRESTRICTED_RISK_QUESTION, UNRESTRICTED_CONFIRM_LABEL, UNRESTRICTED_DECLINE_LABEL } from './unrestricted-consent.js'
import { withDeadline } from './read-deadline.js'

// A closed popup must not make an outstanding machine write safe to repeat.
const writes = new WeakMap()
const scopeNote = 'Saved for future starts and resumes on this computer. Running sessions keep their current permissions.'
const riskNote = 'Part of the full-access warning.'
const labelFor = tier => tier ? tier[0].toUpperCase() + tier.slice(1) : 'Not chosen'
function reasonFrom(result, fallback) {
  try { return typeof result?.reason === 'string' && result.reason.trim() ? result.reason : fallback }
  catch { return fallback }
}

export function createPermissionTierMenu({ bridge, isCurrent = () => true, blockingReason = () => '',
  onRecorded = noteTierRecorded, deadlineMs = 10000 }) {
  const risk = createRiskGate({ via: 'settings' })
  let disposed = false
  let pending = false
  let needsRead = true
  let accepted = null
  let message = 'Reading saved permissions…'
  const current = () => !disposed && isCurrent() === true
  const writePending = () => Boolean(bridge && writes.has(bridge))
  const tell = ctx => { if (current()) { ctx.say(message); ctx.refresh?.() } }
  const blocked = () => !current() ? 'This chat changed. Reopen Permission settings.' : blockingReason()
  async function observe() {
    const result = await withDeadline(Promise.resolve().then(() => bridge.tierState()), deadlineMs, 'the permission read')
    const state = readSetupState({ mcSetup: { chooseTier: bridge.chooseTier, bootstrap: result } })
    if (!state.available || !Array.isArray(result?.tiers)) {
      throw new Error(reasonFrom(result, 'The saved permission level could not be read. Refresh before choosing a level.'))
    }
    const choices = TIER_CHOICES.filter(choice => result.tiers.includes(choice.tier))
    if (!choices.length || (state.tier && !choices.some(choice => choice.tier === state.tier))) {
      throw new Error('The host did not confirm its available permission levels.')
    }
    return { ...state, choices }
  }
  function accept(state) {
    accepted = state
    needsRead = false
    if (state.tier) onRecorded(state.tier)
  }
  async function read(ctx) {
    if (!current() || pending) return
    risk.clear()
    const reason = blocked()
    if (reason) { message = reason; tell(ctx); return }
    if (typeof bridge?.tierState !== 'function' || typeof bridge?.chooseTier !== 'function') {
      needsRead = true
      message = 'Permission settings are unavailable in this host. Reopen them after the application is updated.'
      tell(ctx)
      return
    }
    if (writePending()) { message = 'A permission change is still awaiting the host. Wait before refreshing or choosing another level.'; tell(ctx); return }
    pending = true
    tell(ctx)
    try {
      const state = await observe()
      if (!current()) return
      accept(state)
      message = scopeNote
    } catch {
      if (!current()) return
      needsRead = true
      message = 'The saved permission level could not be read. Refresh before choosing a level.'
    } finally { pending = false; tell(ctx) }
  }
  async function save(tier, consent, ctx) {
    if (!current() || pending || needsRead || writePending()) return
    const reason = blocked()
    if (reason) { risk.clear(); message = reason; tell(ctx); return }
    if (!accepted?.choices.some(choice => choice.tier === tier)) return
    pending = true
    message = 'Saving permission settings…'
    tell(ctx)
    let result = null
    let failure = ''
    try {
      // Recheck the record before dispatch; a startup snapshot is never authority.
      const before = await observe()
      if (!current()) return
      const changed = before.tier !== accepted.tier
      accept(before)
      if (changed || !before.choices.some(choice => choice.tier === tier)) {
        message = 'The saved permissions changed. Review the current level and choose again.'
        return
      }
      const latestReason = blocked()
      if (latestReason || writePending()) {
        message = latestReason || 'Another permission change is awaiting the host.'
        return
      }
      const flight = Promise.resolve().then(() => bridge.chooseTier(tier, consent))
      writes.set(bridge, flight)
      const clear = () => { if (writes.get(bridge) === flight) writes.delete(bridge) }
      flight.then(clear, clear)
      try { result = await withDeadline(flight, deadlineMs, 'the permission change') }
      catch { failure = 'The host did not confirm the permission change.' }
      if (!current()) return
      if (result?.ok !== true || result.tier !== tier) {
        failure = reasonFrom(result, failure || 'The host did not confirm the requested permission level.')
      }
      needsRead = true
      if (writePending()) {
        message = failure + ' The request may still finish. Wait, then refresh the saved level.'
        return
      }
      try {
        const after = await observe()
        if (!current()) return
        accept(after)
        if (failure) message = failure + ' Saved level: ' + labelFor(after.tier) + '. ' + scopeNote
        else if (after.tier !== tier) message = 'The saved level differs from the requested level. Review it before choosing again. ' + scopeNote
        else message = 'Saved permission level: ' + labelFor(after.tier) + '.'
          + (result.recorded?.ok === false ? ' Its activity record was not saved.' : '') + ' ' + scopeNote
      } catch {
        if (!current()) return
        message = (failure || 'The host accepted the choice.') + ' Its saved level could not be read back. Refresh before another change.'
      }
    } catch {
      if (current()) {
        needsRead = true
        message = 'The saved permissions could not be verified. Refresh before another change.'
      }
    } finally { pending = false; tell(ctx) }
  }
  function select(tier, ctx) {
    if (!current() || pending || needsRead || writePending()) return
    const reason = blocked()
    if (reason) { message = reason; tell(ctx); return }
    if (tier === accepted?.tier || !accepted?.choices.some(choice => choice.tier === tier)) return
    if (risk.request(tier).ask) { message = UNRESTRICTED_RISK_QUESTION; tell(ctx); return }
    return save(tier, null, ctx)
  }
  // The Actions palette refuses a disabled row that does not say why (controlState), so every
  // read-only row below carries its own sentence.
  function rows() {
    const reason = blocked()
    const busy = pending || writePending()
    const enabled = !reason && !busy && !needsRead
    if (risk.pending) return [
      { id: 'permission-risk-lead', label: UNRESTRICTED_RISK_LEAD, enabled: false, disabledHint: riskNote },
      ...UNRESTRICTED_RISK_STATEMENTS.map((label, index) => ({ id: 'permission-risk-' + index, label, enabled: false, disabledHint: riskNote })),
      { id: 'permission-risk-question', label: UNRESTRICTED_RISK_QUESTION, enabled: false, disabledHint: 'Choose an answer below.' },
      { id: 'permission-decline', label: UNRESTRICTED_DECLINE_LABEL, enabled: !busy, disabledHint: 'Wait for the current request.', run: ctx => {
        risk.decline(); message = 'Full access was not requested. ' + scopeNote; tell(ctx)
      } },
      { id: 'permission-confirm', label: UNRESTRICTED_CONFIRM_LABEL, enabled, disabledHint: reason || 'Wait for the current request.', run: ctx => {
        if (!current() || pending || needsRead || writePending() || blocked() || !risk.pending) return
        const consent = risk.confirm()
        return save('unrestricted', consent, ctx)
      } },
    ]
    return [
      { id: 'permission-state', label: message, enabled: false, disabledHint: message },
      { id: 'permission-saved', label: accepted ? (needsRead ? 'Last verified level: ' : 'Saved level: ') + labelFor(accepted.tier) : 'Saved level: Unverified',
        enabled: false, disabledHint: needsRead ? 'Refresh to read the saved level again.' : 'Choose another level below to change it.' },
      ...(accepted?.choices || []).map(choice => ({
        id: 'permission-' + choice.tier, label: labelFor(choice.tier), hint: choice.detail,
        current: !needsRead && accepted.tier === choice.tier, enabled: enabled && accepted.tier !== choice.tier,
        disabledHint: reason || (busy ? 'Waiting for the host.' : needsRead ? 'Refresh the saved level before another change.' : 'This level is already saved.'),
        run: ctx => select(choice.tier, ctx),
      })),
      { id: 'permission-refresh', label: 'Refresh saved permissions', enabled: current() && !busy,
        disabledHint: reason || 'Waiting for the host.', run: read },
    ]
  }
  function dispose() { disposed = true; risk.clear() }
  return { rows, dispose, open(ctx) {
    if (!current()) return
    ctx.show(rows, { title: 'Permission settings' })
    ctx.onClose?.(dispose)
    return read(ctx)
  } }
}
