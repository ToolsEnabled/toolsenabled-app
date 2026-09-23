const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const MIB = 1024 * 1024

export function createTranscriptSettings({ draft, bridge = globalThis.window?.mcTranscripts } = {}) {
  let root, settings = null, notice = '', destroyed = false, loading = false, edits = null
  // A browser copy has no transcript store (T1517): say where the settings are
  // made instead of asking to close and reopen Settings, which cannot help.
  const unsupported = typeof bridge?.getSettings !== 'function' && !onDesktop()
  const current = () => draft.value('transcripts:settings', settings)
  const formValue = () => edits || (current() ? {
    archiveDirectory: current().archiveDirectory,
    quota: String(current().archiveMaxBytes / MIB),
    deleteNodesOnExit: current().deleteNodesOnExit,
  } : null)
  function errors(value = formValue()) {
    if (!value) return { directory: '', quota: '' }
    const quota = Number(value.quota)
    return {
      directory: String(value.archiveDirectory ?? '').trim() ? '' : 'Choose an archive folder.',
      quota: String(value.quota).trim() && Number.isSafeInteger(quota) && quota > 0 && Number.isSafeInteger(quota * MIB)
        ? '' : 'Enter a positive whole-number quota in MiB.',
    }
  }
  function syncValidity() {
    const error = errors()
    for (const [field, selector] of [['directory', '[data-transcript-directory]'], ['quota', '[data-transcript-quota]']]) {
      const input = root?.querySelector(selector)
      input?.setAttribute?.('aria-invalid', String(Boolean(error[field])))
      input?.setCustomValidity?.(error[field])
      const message = root?.querySelector(`[data-transcript-error="${field}"]`)
      if (message) { message.textContent = error[field]; message.hidden = !error[field] }
    }
  }
  function markup() {
    const value = formValue(), error = errors(value)
    return `<section class="settings-section" data-transcript-settings><h2 class="settings-section-title">Transcript archive</h2>
      <p>Active conversation history is uncapped. The archive quota applies only to closed conversations; older closed archives are removed when the quota is reached.</p>
      ${value ? `<article class="settings-row"><div class="settings-copy"><label class="settings-name" for="settings-archive-folder">Archive folder</label><div class="settings-desc">Where closed conversations are stored on this computer.</div></div>
        <div class="settings-field-control"><input id="settings-archive-folder" data-transcript-directory type="text" required aria-invalid="${Boolean(error.directory)}" aria-describedby="settings-archive-folder-error" value="${escape(value.archiveDirectory)}"><button class="ctl-btn" type="button" data-transcript-choose>Choose folder…</button><span id="settings-archive-folder-error" class="settings-desc" data-transcript-error="directory" role="status" ${error.directory ? '' : 'hidden'}>${escape(error.directory)}</span></div></article>
      <label class="settings-row"><span>Closed archive quota (MiB)</span><input data-transcript-quota type="number" min="1" step="1" required aria-invalid="${Boolean(error.quota)}" aria-describedby="settings-archive-quota-error" value="${escape(value.quota)}"><span id="settings-archive-quota-error" class="settings-desc" data-transcript-error="quota" role="status" ${error.quota ? '' : 'hidden'}>${escape(error.quota)}</span></label>
      <label class="settings-row settings-check-row"><span>Delete agent nodes when the app exits</span><input type="checkbox" data-transcript-delete ${value.deleteNodesOnExit ? 'checked' : ''}></label>
      <p>Node deletion is off by default. Save settings to apply changes to the folder, quota, or exit behavior.</p>` : unsupported
        ? '<p>Transcript archive settings are made in the ToolsEnabled desktop app on your computer.</p>'
        : `<p>${notice ? 'Transcript settings could not be loaded.' : 'Reading transcript settings…'}</p>`}
      <p role="status">${escape(notice)}</p></section>`
  }
  const paint = () => {
    const panel = root?.querySelector('[data-transcript-settings]')
    if (panel) { panel.outerHTML = markup(); syncValidity() }
  }
  function stage(next) {
    draft.stage('transcripts:settings', next, async value => {
      if (!value.archiveDirectory.trim() || !Number.isSafeInteger(value.archiveMaxBytes) || !Number.isInteger(value.archiveMaxBytes / MIB) || value.archiveMaxBytes < MIB) throw new Error('Choose an archive folder and a positive whole-number quota in MiB.')
      const result = await bridge.configure(value)
      if (result?.ok === true) { settings = result.transcript || { ...value }; edits = null }
      return result
    })
  }
  function stageForm(value) {
    // Retain raw typing separately: blank input must not repaint as zero, and
    // an invalid draft must never replace the last valid serialized policy.
    edits = value
    const error = errors(value)
    if (error.directory || error.quota) draft.setError('transcripts:settings', error.directory || error.quota)
    else stage({ ...current(), archiveDirectory: value.archiveDirectory, archiveMaxBytes: Number(value.quota) * MIB, deleteNodesOnExit: value.deleteNodesOnExit })
    syncValidity()
  }
  function change(event) {
    if (!settings || !event.target.closest('[data-transcript-settings]')) return
    const value = { ...formValue() }
    if (event.target.matches('[data-transcript-directory]')) value.archiveDirectory = event.target.value
    else if (event.target.matches('[data-transcript-quota]')) value.quota = event.target.value
    else if (event.target.matches('[data-transcript-delete]')) value.deleteNodesOnExit = event.target.checked
    else return
    stageForm(value)
  }
  async function click(event) {
    if (!event.target.closest('[data-transcript-choose]')) return
    try {
      const result = await bridge?.chooseArchiveDirectory?.()
      if (destroyed) return
      if (result?.ok && result.directory && formValue()) stageForm({ ...formValue(), archiveDirectory: result.directory })
      else if (result?.ok !== true) notice = result?.reason || 'The folder chooser is unavailable. Enter the path in Archive folder, then Save settings.'
    } catch (error) { notice = error.message }
    if (!destroyed) paint()
  }
  return {
    markup,
    matches: query => matchesSettingQuery(query, 'transcript history archive graveyard quota folder delete nodes exit privacy'),
    bind(target) { root = target; root.addEventListener('input', change); root.addEventListener('change', change); root.addEventListener('click', click) },
    afterRender() {
      if (loading || unsupported) return
      loading = true
      Promise.resolve().then(() => bridge?.getSettings?.()).then(result => {
        if (destroyed) return
        if (result?.ok) settings = result.transcript
        else notice = result?.reason || 'Transcript settings are unavailable. Close and reopen Settings to try loading them again.'
        paint()
      }).catch(error => { if (!destroyed) { notice = error.message; paint() } })
    },
    destroy() { destroyed = true; root?.removeEventListener('input', change); root?.removeEventListener('change', change); root?.removeEventListener('click', click) },
  }
}
import { matchesSettingQuery } from './product-settings-layout.js'
import { onDesktop } from './data-source.js'
