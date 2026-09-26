import { matchesSettingQuery } from './product-settings-layout.js'

const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character])

const OPERATIONS = Object.freeze({
  rotate: { flag: 'canRotate', label: 'Rotate signing identity', title: 'Rotate the audit signing identity',
    description: 'Existing activity records will be archived. Future records will start under a new signing identity, with an explicit break in the history. Unrelated credentials remain in the vault.',
    submitLabel: 'Confirm rotation', success: 'A new audit signing identity is ready.' },
  repair: { flag: 'canRepair', label: 'Repair audit signing', title: 'Repair the audit signing identity',
    description: 'Existing activity records will be kept as an unverified archive. A new signed record will start from this point. This does not verify or restore earlier history. Unrelated vault records will be preserved.',
    submitLabel: 'Confirm repair', success: 'Audit signing is repaired. Earlier records remain archived and unverified.' },
  recover: { flag: 'canRecover', label: 'Recover interrupted maintenance', title: 'Recover interrupted audit maintenance',
    description: 'ToolsEnabled will verify which signing identity committed, then finish or roll back the interrupted operation. Archived records remain on this computer.',
    submitLabel: 'Confirm recovery', success: 'Audit recovery completed.' },
})

export function createAuditSettings({ shell = globalThis.window?.mcSettings, confirmation, draft = null, onBusy = () => {} } = {}) {
  let root = null, panel = null, state = null, loading = false, busy = false, destroyed = false, generation = 0, message = ''
  const supported = () => typeof shell?.auditProbe === 'function'
  const canWrite = () => typeof shell?.auditConfirmation === 'function' && typeof shell?.auditRotate === 'function' && typeof confirmation?.confirmAction === 'function'
  const writeBlocked = () => !canWrite() || busy || draft?.saving || draft?.dirty || state?.restartRequired
  function content() {
    const description = !supported() ? 'Open an updated ToolsEnabled desktop app to inspect its audit identity.'
      : loading && !state ? 'Reading the audit identity and recovery status…'
        : state?.reason || (state?.canRecover ? 'Interrupted audit maintenance needs recovery before activity can continue.'
          : state?.canRepair ? 'The current audit identity needs repair before new activity can be signed.'
            : state?.canRotate ? 'The current signing identity is readable. Its activity records can be archived before a new identity starts.' : 'Inspect the current identity before changing it.')
    const archive = state?.lastArchivePath || state?.archiveRoot
    return `<p class="settings-desc">Start a new signing identity for future activity records. Previous records stay in an archive with an explicit break between identities.</p>
      <p class="settings-desc" data-audit-state>${esc(description)}</p>
      ${state?.canRepair ? '<p class="settings-desc">Repair preserves earlier records as an unverified archive. The new identity cannot attest to that history.</p>' : ''}
      ${state?.restartRequired ? '<p class="settings-state">Restart ToolsEnabled before starting new work or changing audit settings.</p>' : ''}
      <p class="settings-desc" data-audit-draft-warning${draft?.dirty ? '' : ' hidden'}>Save or discard pending settings before changing the audit identity.</p>
      ${Number.isSafeInteger(state?.headSequence) ? `<p class="settings-desc">Current record sequence: ${state.headSequence.toLocaleString()}.</p>` : ''}
      <div class="settings-audit-actions">
        <button type="button" class="ctl-btn" data-audit-action="inspect"${!supported() || busy || loading ? ' disabled' : ''}>Inspect audit identity</button>
        ${Object.entries(OPERATIONS).filter(([, operation]) => state?.[operation.flag] === true).map(([id, operation]) => `<button type="button" class="ctl-btn" data-audit-action="${id}"${writeBlocked() ? ' disabled' : ''}>${operation.label}</button>`).join('')}
      </div>
      ${archive ? `<div class="settings-audit-archive"><h3 class="settings-subsection-title">Your data</h3><p class="settings-desc">${state?.lastArchivePath ? 'Previous activity archive' : 'Activity archives are kept here'}:</p><p class="settings-audit-path">${esc(archive)}</p>${typeof shell?.auditRevealArchive === 'function' && state?.lastArchivePath ? `<button type="button" class="ctl-btn" data-audit-action="archive"${busy ? ' disabled' : ''}>Show archive folder</button>` : ''}</div>` : ''}
      <p class="settings-state" role="status" aria-live="polite" data-audit-notice>${esc(message)}</p>`
  }
  function markup() {
    return `<section class="settings-section settings-audit" data-settings-section="Data &amp; Privacy" data-audit-settings><h2 class="settings-section-title">Audit signing identity</h2><div data-audit-body>${content()}</div></section>`
  }
  function paint() {
    if (!panel || destroyed) return
    const focus = panel.contains?.(globalThis.document?.activeElement) ? globalThis.document.activeElement?.dataset?.auditAction : null
    panel.querySelector('[data-audit-body]').innerHTML = content()
    if (focus) panel.querySelector(`[data-audit-action="${focus}"]`)?.focus?.({ preventScroll: true })
  }
  async function inspect({ force = false } = {}) {
    if (!supported() || destroyed || busy || loading && !force) return
    const ticket = ++generation
    loading = true; paint()
    try {
      const result = await shell.auditProbe()
      if (ticket !== generation || destroyed) return
      state = result?.ok ? { ...result, restartRequired: result.restartRequired === true || state?.restartRequired === true }
        : { available: false, restartRequired: result?.restartRequired === true || state?.restartRequired === true, reason: result?.reason || 'The audit identity could not be read. Inspect it again after startup finishes.' }
    } catch (error) {
      if (ticket === generation && !destroyed) state = { available: false, restartRequired: state?.restartRequired === true, reason: error.message || 'The audit identity could not be read.' }
    } finally { if (ticket === generation && !destroyed) { loading = false; paint() } }
  }
  async function execute(operation) {
    if (!Object.hasOwn(OPERATIONS, operation)) return
    const details = OPERATIONS[operation]
    if (destroyed || writeBlocked() || state?.[details.flag] !== true) return
    ++generation; loading = false; busy = true; message = ''; onBusy(true); paint()
    try {
      const challenge = await shell.auditConfirmation({ operation })
      if (destroyed) return
      const code = await confirmation.confirmAction(challenge, {
        title: details.title,
        description: details.description,
        submitLabel: details.submitLabel,
        canceledMessage: 'The audit identity was not changed.',
      })
      if (destroyed) return
      const result = await shell.auditRotate(code)
      if (destroyed) return
      state = { ...state, restartRequired: result?.restartRequired === true || state?.restartRequired === true }
      if (!result?.ok) throw new Error(result?.reason || 'The audit operation did not complete. Inspect the current state before retrying.')
      message = `${details.success}${result.restartRequired ? ' Restart ToolsEnabled before starting new work.' : ''}`
      if (result.archivePath) state = { ...state, lastArchivePath: result.archivePath }
    } catch (error) { if (!destroyed) message = error.message || 'The audit operation did not complete.' }
    finally { busy = false; onBusy(false); if (!destroyed) { paint(); await inspect({ force: true }) } }
  }
  async function click(event) {
    const button = event.target.closest?.('[data-audit-action]')
    if (!button || !panel?.contains(button) || button.disabled) return
    if (button.dataset.auditAction === 'inspect') { message = ''; return inspect({ force: true }) }
    if (button.dataset.auditAction === 'archive') {
      try { const result = await shell.auditRevealArchive({ archivePath: state.lastArchivePath }); if (!result?.ok) throw new Error(result?.reason || 'The archive folder could not be opened.') }
      catch (error) { message = error.message; paint() }
      return
    }
    await execute(button.dataset.auditAction)
  }
  return {
    markup, inspect, execute,
    syncDraft() {
      if (!panel || destroyed) return
      for (const button of panel.querySelectorAll('[data-audit-action]')) {
        if (Object.hasOwn(OPERATIONS, button.dataset.auditAction)) button.disabled = Boolean(writeBlocked())
      }
      const notice = panel.querySelector('[data-audit-draft-warning]')
      if (notice) notice.hidden = !draft?.dirty
    },
    matches: query => matchesSettingQuery(query, 'audit signing identity key rotation recover repair archive history records data privacy'),
    bind(target) { root = target; root.addEventListener('click', click) },
    afterRender(target) { panel = target.querySelector('[data-audit-settings]'); if (panel && !state) void inspect(); else paint() },
    destroy() { destroyed = true; ++generation; root?.removeEventListener('click', click); root = null; panel = null },
  }
}
