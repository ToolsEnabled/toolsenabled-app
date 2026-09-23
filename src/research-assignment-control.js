// The ONE assignment control, used everywhere a session gets filed under a
// project — the computers page rail (one session), its tree tools (a whole
// scope), and the research page's sessions module. One factory so two
// placements can never disagree about what assigning means or say different
// sentences about the same refusal.

import { el } from './components.js'

const esc = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

/**
 * Build the control. `projects` is the readable list (may be empty);
 * `unavailableReason` is the sentence to show instead when the service could
 * not be read — the control then renders disabled WITH the sentence, never as
 * an empty select pretending there are no projects.
 *
 * `onAssign(projectId)` performs the write and resolves to the store's result
 * ({ok, sentence?, pending?}); the control prints the sentence it gets back.
 */
export function createAssignmentControl({
  projects = [],
  unavailableReason = null,
  label = 'File under',
  currentProjectIds = [],
  onAssign,
}) {
  if (unavailableReason) {
    return el(`
      <div class="research-assign-control" data-assign-control data-assign-state="unavailable">
        <p class="research-observed-empty">${esc(`Projects could not be read — ${unavailableReason}`)}</p>
      </div>`)
  }
  if (projects.length === 0) {
    return el(`
      <div class="research-assign-control" data-assign-control data-assign-state="empty">
        <p class="research-observed-empty">No research projects exist yet. Create one on the research page first.</p>
      </div>`)
  }
  const current = new Set(currentProjectIds)
  const root = el(`
    <div class="research-assign-control" data-assign-control data-assign-state="ready">
      <label class="research-popover-row">${esc(label)}
        <select data-assign-select aria-label="${esc(label)}">
          ${projects.map(project => `
            <option value="${esc(project.projectId)}"${current.has(project.projectId) ? ' selected' : ''}>${esc(project.name)}${project.enabled === false ? ' (switched off)' : ''}</option>`).join('')}
        </select>
      </label>
      <button type="button" data-assign-apply>Assign</button>
      <span class="research-queue-form-status" data-assign-status role="status"></span>
    </div>`)
  const select = root.querySelector('[data-assign-select]')
  const apply = root.querySelector('[data-assign-apply]')
  const status = root.querySelector('[data-assign-status]')
  apply.addEventListener('click', async () => {
    apply.disabled = true
    let result = null
    try { result = await onAssign(select.value) }
    catch (error) { result = { ok: false, sentence: error?.message || 'The assignment was not made.' } }
    apply.disabled = false
    if (result?.ok !== true) {
      status.textContent = result?.sentence || 'The assignment was not made.'
      return
    }
    status.textContent = result.alreadyAssigned
      ? 'Already filed under that project.'
      : (result.sentence || 'Filed.')
  })
  return root
}
