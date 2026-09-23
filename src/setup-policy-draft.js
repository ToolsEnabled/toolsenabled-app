import { SETUP_APPROVAL_CHOICES } from './setup-intent-commit.js'
import { selectionModeChoice } from './account-switcher-state.js'
import { withDeadline } from './read-deadline.js'

export const SETUP_APPROVAL_DRAFT_KEY = 'product:agent.blocked_question'
export const SETUP_EDITOR_POLICY_KEY = 'setup:editor-policy'
export const SETUP_ACCOUNT_POLICY_KEY = 'setup:account-policy'
export const SETUP_PROFILE_DEPENDENCIES = Object.freeze([SETUP_APPROVAL_DRAFT_KEY, SETUP_EDITOR_POLICY_KEY, SETUP_ACCOUNT_POLICY_KEY])
const approvalIntent = value => Object.keys(SETUP_APPROVAL_CHOICES).find(key => SETUP_APPROVAL_CHOICES[key] === value) || null
const importChoice = value => ['none', 'ask', 'all-detected'].includes(value) ? value : null
const failoverChoice = value => ['manual', 'auto'].includes(value) ? value : null
const failoverOf = policy => policy ? (policy.selectionMode === 'manual' ? 'manual' : 'auto') : null

// The Setup description and the Tool use row edit one canonical draft entry.
// Saved walkthrough answers describe that policy; they never replay a second
// approval write at Save. The profile receipt is ordered after both policies.
export function createSetupPolicyDraft({ draft, productSettings, scope = globalThis }) {
  let canonicalApproval = null, canonicalImport = null, loading = null
  let approvalError = '', importError = ''
  let accountPolicy = null, accountApplicable = false, accountLoading = null
  let accountReadGeneration = 0
  let accountError = 'Reading the saved account-selection policy…'
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
  async function readAccountPolicy() {
    const generation = ++accountReadGeneration
    try {
      if (typeof scope.mcProviders?.accounts !== 'function') throw new Error('unavailable')
      const result = await withDeadline(scope.mcProviders.accounts(), 10_000)
      if (generation !== accountReadGeneration) return
      const policy = result?.ok === true && result.damaged !== true && result.policy?.ok === true
        ? result.policy.policy : null
      if (!Array.isArray(result?.accounts) || !selectionModeChoice(policy?.selectionMode)) throw new Error('unreadable')
      accountPolicy = policy
      accountApplicable = result.accounts.length > 0
      accountError = ''
    } catch {
      if (generation !== accountReadGeneration) return
      accountPolicy = null; accountApplicable = false
      accountError = 'The saved account-selection policy could not be read. Refresh it or open Accounts to check it.'
    }
  }
  function refreshAccounts() {
    if (!accountLoading) accountLoading = readAccountPolicy().finally(() => { accountLoading = null })
    return accountLoading
  }
  async function load({ includeAccounts = true } = {}) {
    const accountRead = includeAccounts ? refreshAccounts() : null
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
    if (accountRead) await accountRead
    return result
  }
  function values(fallback = {}) {
    return {
      approvals: approvalIntent(draft.value(SETUP_APPROVAL_DRAFT_KEY, SETUP_APPROVAL_CHOICES[canonicalApproval])) || canonicalApproval || fallback.approvals,
      ideImport: draft.value(SETUP_EDITOR_POLICY_KEY, canonicalImport || fallback.ideImport),
      // The walkthrough answer is historical. It cannot stand in for the
      // Accounts policy, including while that policy is unavailable.
      failover: draft.value(SETUP_ACCOUNT_POLICY_KEY, failoverOf(accountPolicy)),
    }
  }
  function stageAccountChoice(value) {
    // Choosing automatic again preserves an existing ranking. Each provider's
    // overrides and the rest of the account policy remain owned by Accounts.
    if (!accountApplicable || value === failoverOf(accountPolicy)) draft.unstage(SETUP_ACCOUNT_POLICY_KEY)
    else draft.stage(SETUP_ACCOUNT_POLICY_KEY, value, async next => {
      await readAccountPolicy()
      if (accountError) throw new Error(accountError)
      if (!accountApplicable) throw new Error('Add a provider account in Accounts before changing its selection policy.')
      if (next === failoverOf(accountPolicy)) return { ok: true }
      if (typeof scope.mcProviders?.accountPolicy !== 'function') throw new Error('This installed copy cannot change the account-selection policy. Update ToolsEnabled and try again.')
      const selectionMode = next === 'auto' ? 'priority' : 'manual'
      const result = await scope.mcProviders.accountPolicy({ selectionMode })
      if (result?.ok !== true) throw new Error(result?.reason || result?.error?.message || 'The account-selection policy could not be saved.')
      accountReadGeneration += 1
      accountPolicy = { ...accountPolicy, selectionMode }
      accountError = ''
      return result
    })
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
      const accountChoice = Object.hasOwn(changes, 'failover') ? failoverChoice(changes.failover) : null
      if (Object.hasOwn(changes, 'failover') && !accountChoice) throw new Error('Choose how new sessions select an account.')
      const accountStaged = Boolean(accountChoice && accountPolicy)
      // The same immediate draft rule applies here: a quick second click can
      // revert the first while a native read is still in progress.
      if (accountStaged) stageAccountChoice(accountChoice)
      await load({ includeAccounts: Object.hasOwn(changes, 'failover') })
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
      if (Object.hasOwn(changes, 'failover')) {
        if (accountError) throw new Error(accountError)
        if (!accountStaged) stageAccountChoice(accountChoice)
      }
      draft.setError('setup:policy-read', '')
    } catch (error) { draft.setError('setup:policy-read', error.message); throw error }
  }
  async function committedValues(fallback = {}, { requireAccount = false } = {}) {
    // Called only by the final profile receipt after its dependency writes.
    // Re-read actual native values so an external policy edit is not replaced
    // by a stale walkthrough answer, and a read failure retains the receipt.
    await readApproval()
    const state = await withDeadline(Promise.resolve().then(() => scope.mcSetup?.editorSessionState?.({ policyOnly: true })), 10_000)
    observeEditorState(state)
    if (importError) throw new Error(importError)
    if (requireAccount) await refreshAccounts()
    if (requireAccount && accountError) throw new Error(accountError)
    return { ...fallback, approvals: canonicalApproval, ideImport: canonicalImport,
      failover: failoverOf(accountPolicy) || fallback.failover }
  }
  return Object.freeze({ load, stage, values, committedValues, observeEditorState,
    savedValues: () => ({ approvals: canonicalApproval, ideImport: canonicalImport, failover: failoverOf(accountPolicy) }),
    refreshAccounts,
    accountState: () => ({ known: Boolean(accountPolicy), applicable: accountApplicable,
      writable: typeof scope.mcProviders?.accountPolicy === 'function',
      label: selectionModeChoice(accountPolicy?.selectionMode)?.label || null,
      pending: draft.has(SETUP_ACCOUNT_POLICY_KEY) }),
    error: field => field === 'approvals' ? approvalError : field === 'ideImport' ? importError : field === 'failover' ? accountError : '' })
}
