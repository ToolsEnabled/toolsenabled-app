// Account selectors are names, never paths or credentials. Invalid saved data
// stays unavailable so a later start cannot silently use the global preference.
export function normalizeSlotAccountChoice(value) {
  if (value == null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !['codex', 'claude', 'gemini', 'grok'].includes(value.provider)
      || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 120
      || /[\u0000-\u001f\u007f]/.test(value.name)) return Object.freeze({ unavailable: true })
  return Object.freeze({ provider: value.provider, name: value.name })
}
export function slotAccountStartOptions(node, provider) {
  const choice = normalizeSlotAccountChoice(node?.accountChoice)
  if (!choice) return { ok: true, options: {} }
  if (choice.unavailable || choice.provider !== provider) return {
    ok: false, code: 'TREE_ACCOUNT_CHOICE_UNAVAILABLE',
    reason: 'The saved slot account does not match this provider. Choose its account again before starting.',
  }
  return { ok: true, options: { treeAccount: choice.name } }
}
