// In-progress walkthrough records are drafts. Only Finish or Settings Save
// writes the runtime policies, and each response must acknowledge persistence.

export const SETUP_APPROVAL_CHOICES = Object.freeze({
  stop: 'Stop and wait for me',
  'other-work': 'Switch to other work',
  judgement: 'Decide for itself',
})

export async function applySetupIntentChanges(previous, next, scope = globalThis) {
  const native = Boolean(scope.mcSetup || scope.mcPrefs?.available)
  async function write(field, label, invoke) {
    if (previous && previous[field] === next[field]) return
    if (!invoke) {
      if (native) throw new Error(`${label} cannot be saved by this installed copy. Update ToolsEnabled and try again.`)
      return
    }
    const result = await invoke()
    if (result?.ok === true) return
    throw new Error(result?.reason || result?.error?.message || result?.message || `${label} could not be saved.`)
  }
  if (!Object.hasOwn(SETUP_APPROVAL_CHOICES, next?.approvals)) throw new Error('Choose how an assistant handles a ToolsEnabled permission question.')
  if (!['none', 'ask', 'all-detected'].includes(next?.ideImport)) throw new Error('Choose how editor sessions are offered or included.')
  await write('approvals', 'Permission question behavior', typeof scope.mcSettings?.set === 'function'
    ? () => scope.mcSettings.set('agent.blocked_question', SETUP_APPROVAL_CHOICES[next.approvals]) : null)
  await write('ideImport', 'Editor session import behavior', typeof scope.mcSetup?.setEditorImportPolicy === 'function'
    ? () => scope.mcSetup.setEditorImportPolicy(next.ideImport) : null)
  return { ok: true }
}
