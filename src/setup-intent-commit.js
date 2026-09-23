// In-progress walkthrough records are drafts. Only Finish or Settings Save
// writes the runtime policies, and each response must acknowledge persistence.
import { readStoredProfile, writeStoredProfile } from './setup-profile.js'

export const SETUP_APPROVAL_CHOICES = Object.freeze({
  stop: 'Stop and wait for me',
  'other-work': 'Switch to other work',
  judgement: 'Decide for itself',
})

export async function applySetupIntentChanges(previous, next, scope = globalThis) {
  const deferred = []
  const native = Boolean(scope.mcSetup || scope.mcPrefs?.available)
  async function write(field, label, invoke) {
    if (previous && previous[field] === next[field]) return
    if (!invoke) {
      if (native) throw new Error(`${label} cannot be saved by this installed copy. Update ToolsEnabled and try again.`)
      return
    }
    const result = await invoke()
    if (result?.ok === true) return
    const code = result?.code || result?.error?.code
    if (field === 'failover' && code === 'ACCOUNT_REGISTRY_ABSENT') {
      deferred.push('There are no provider accounts to switch between yet. Your answer is applied when the first one is added.')
      return
    }
    throw new Error(result?.reason || result?.error?.message || result?.message || `${label} could not be saved.`)
  }
  if (!Object.hasOwn(SETUP_APPROVAL_CHOICES, next?.approvals)) throw new Error('Choose how an assistant handles a ToolsEnabled permission question.')
  if (!['none', 'ask', 'all-detected'].includes(next?.ideImport)) throw new Error('Choose how editor sessions are offered or included.')
  if (!['manual', 'auto'].includes(next?.failover)) throw new Error('Choose how account switching works.')
  await write('approvals', 'Permission question behavior', typeof scope.mcSettings?.set === 'function'
    ? () => scope.mcSettings.set('agent.blocked_question', SETUP_APPROVAL_CHOICES[next.approvals]) : null)
  await write('ideImport', 'Editor session import behavior', typeof scope.mcSetup?.setEditorImportPolicy === 'function'
    ? () => scope.mcSetup.setEditorImportPolicy(next.ideImport) : null)
  await write('failover', 'Account switching behavior', typeof scope.mcProviders?.accountPolicy === 'function'
    ? () => scope.mcProviders.accountPolicy({ selectionMode: next.failover === 'auto' ? 'priority' : 'manual' }) : null)
  return { ok: true, deferred }
}

/* THE ANSWER THAT WAITED FOR AN ACCOUNT IS APPLIED WHEN THE FIRST ONE ARRIVES
 * (T1582).
 *
 * On a fresh install there is no account list, so the switching answer
 * cannot be written (shell/account-registry.cjs refuses ACCOUNT_REGISTRY_ABSENT
 * rather than create a list with nothing in it) and setup stores the deferral
 * beside the answers. Nothing ever applied it: the first account arrived with
 * the registry default, automatic switching, so "Stop and let me switch" was
 * dropped without a word. Every add in this app (the Accounts menu's two adds
 * and Settings > This computer) now calls this after the add succeeds.
 *
 * It writes only while the list's rule is still unrecorded. A rule somebody
 * already chose in the Accounts menu outranks an older setup answer, so then
 * the deferral is simply retired. Every other outcome (no deferral, no
 * accounts yet, an unreadable list, a refused write) leaves it waiting and
 * changes nothing. */
export async function applyDeferredAccountPolicy(scope = globalThis) {
  let stored
  try { stored = readStoredProfile(scope) } catch { return { applied: false } }
  if (!stored?.accountPolicyDeferred) return { applied: false }
  const failover = stored.answers?.failover
  const providers = scope?.mcProviders
  if (!['manual', 'auto'].includes(failover)
    || typeof providers?.accounts !== 'function' || typeof providers?.accountPolicy !== 'function') return { applied: false }
  let list
  try { list = await providers.accounts() } catch { return { applied: false } }
  const policy = list?.ok === true && list.policy?.ok === true ? list.policy.policy : null
  if (!Array.isArray(list?.accounts) || list.accounts.length === 0 || !policy) return { applied: false }
  const apply = policy.recorded !== true
  if (apply) {
    let result
    try { result = await providers.accountPolicy({ selectionMode: failover === 'auto' ? 'priority' : 'manual' }) } catch { return { applied: false } }
    if (result?.ok !== true) return { applied: false }
  }
  writeStoredProfile({ ...stored, accountPolicyDeferred: null }, scope)
  return { applied: apply, failover }
}
