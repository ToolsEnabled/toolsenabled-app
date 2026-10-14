import { SETUP_APPROVAL_CHOICES } from './setup-intent-commit.js'
import { withDeadline } from './read-deadline.js'

export const SETUP_APPROVAL_DRAFT_KEY = 'product:agent.blocked_question'
export const SETUP_EDITOR_POLICY_KEY = 'setup:editor-policy'
export const SETUP_PROFILE_DEPENDENCIES = Object.freeze([SETUP_APPROVAL_DRAFT_KEY, SETUP_EDITOR_POLICY_KEY])
const approvalIntent = value => Object.keys(SETUP_APPROVAL_CHOICES).find(key => SETUP_APPROVAL_CHOICES[key] === value) || null
const importChoice = value => ['none', 'ask', 'all-detected'].includes(value) ? value : null

// The Setup description and the Tool use row edit one canonical draft entry.
// Saved walkthrough answers describe that policy; they never replay a second
// approval write at Save. The profile receipt is ordered after both policies.
export function createSetupPolicyDraft({ draft, productSettings, scope = globalThis }) {
  let canonicalApproval = null, canonicalImport = null, loading = null
  let approvalError = '', importError = ''
  function observeEditorState(state) {
    const value = state?.ok === true ? importChoice(state.importPolicy) : null
    if (value) { canonicalImport = value; importError = '' }
    else importError = state?.reason || state?.error?.message || 'The saved editor import policy could not be read.'
  }
  async function readApproval() {
    const result = await withDeadline(Promise.resolve().then(() => scope.mcSettings?.read?.()), 10_000)
    const row = result?.ok === true && Array.isArray(result.rows)
      ? result.rows.find(entry => entry.id === 'agent.blocked_question') : null
    const value = approvalIntent(row?.value)
    if (!value) throw new Error('The saved permission-question policy could not be read.')
    canonicalApproval = value; approvalError = ''
  }


  async function load() {
    if (!loading) loading = (async () => {
      const results = await Promise.allSettled([
        readApproval(),
        withDeadline(Promise.resolve().then(() => productSettings.read()), 10_000),
        typeof scope.mcSetup?.editorSessionState === 'function'
          ? withDeadline(Promise.resolve().then(() => scope.mcSetup.editorSessionState({ policyOnly: true })), 10_000).then(observeEditorState)
          : Promise.reject(new Error('The saved editor import policy could not be read.')),
      ])
      if (results[0].status === 'rejected') approvalError = results[0].reason.message
      if (results[1].status === 'rejected') approvalError ||= results[1].reason.message
      if (results[2].status === 'rejected') importError = results[2].reason.message
      return { ok: !approvalError && !importError }
    })().finally(() => { loading = null })
    const result = await loading
    return result
  }
  function values(fallback = {}) {
    return {
      approvals: approvalIntent(draft.value(SETUP_APPROVAL_DRAFT_KEY, SETUP_APPROVAL_CHOICES[canonicalApproval])) || canonicalApproval || fallback.approvals,
      ideImport: draft.value(SETUP_EDITOR_POLICY_KEY, canonicalImport || fallback.ideImport),
    }
  }

  async function stage(changes) {
    // A click arriving before the native reads complete cannot race Save with
    // an un-staged policy. Validation is cleared only after staging completes.
    draft.setError('setup:policy-read', 'Checking the saved setup policies before staging this change…')
    try {
      // Record the click in the shared key before an asynchronous native read.
      // A later edit in Tool use must stay later, even if this read is slow.
      let approvalStaged = null
      if (Object.hasOwn(changes, 'approvals')) {
        const choice = SETUP_APPROVAL_CHOICES[changes.approvals]
        if (!choice) throw new Error('Choose how the assistant handles a permission question.')
        approvalStaged = Promise.resolve(productSettings.set('agent.blocked_question', choice))
          .then(result => ({ result }), error => ({ error }))
      }
      await load()
      if (Object.hasOwn(changes, 'approvals')) {
        if (approvalError) throw new Error(approvalError)
        const staged = await approvalStaged
        if (staged.error) throw staged.error
        const result = staged.result
        if (result?.ok !== true) throw new Error(result?.reason || 'The permission-question choice could not be staged.')
      }
      if (Object.hasOwn(changes, 'ideImport')) {
        if (importError) throw new Error(importError)
        const value = importChoice(changes.ideImport)
        if (!value) throw new Error('Choose how editor sessions are offered or included.')
        if (value === canonicalImport) draft.unstage(SETUP_EDITOR_POLICY_KEY)
        else draft.stage(SETUP_EDITOR_POLICY_KEY, value, async next => {
          const result = await scope.mcSetup.setEditorImportPolicy(next)
          if (result?.ok !== true) throw new Error(result?.reason || result?.error?.message || 'The editor import policy could not be saved.')
          canonicalImport = next; importError = ''
          return result
        })
      }
      draft.setError('setup:policy-read', '')
    } catch (error) { draft.setError('setup:policy-read', error.message); throw error }
  }
  async function committedValues(fallback = {}) {
    // Called only by the final profile receipt after its dependency writes.
    // Re-read actual native values so an external policy edit is not replaced
    // by a stale walkthrough answer, and a read failure retains the receipt.
    await readApproval()
    const state = await withDeadline(Promise.resolve().then(() => scope.mcSetup?.editorSessionState?.({ policyOnly: true })), 10_000)
    observeEditorState(state)
    if (importError) throw new Error(importError)
    return { ...fallback, approvals: canonicalApproval, ideImport: canonicalImport }
  }
  return Object.freeze({ load, stage, values, committedValues, observeEditorState,
    savedValues: () => ({ approvals: canonicalApproval, ideImport: canonicalImport }),
    error: field => field === 'approvals' ? approvalError : field === 'ideImport' ? importError : '' })
}
