import { switchChoices } from './switch-and-continue.js'

export const MANAGED_SLOT_ACTIONS = Object.freeze({
  'set-node-model': 'model', 'set-node-effort': 'effort',
  'set-node-account': 'account', 'set-node-provider': 'provider',
  'set-node-role': 'role',
})

// Resolve a requested value against the same lists used by the user's controls.
// This is a plan only: the existing continuation/effort/role paths own applying
// it, and native admission plus the renderer's current-identity check own scope.
export function planManagedSlotChoice({
  action, value, current, tiers = [], accounts = [], roles = [], efforts = [],
  startable = null, answered = false, accountAnswered = false, effortAnswered = false,
} = {}) {
  const refuse = reason => Object.freeze({ ok: false, code: 'TREE_CONFIGURATION_CHOICE_REFUSED', reason })
  const field = Object.hasOwn(MANAGED_SLOT_ACTIONS, action) ? MANAGED_SLOT_ACTIONS[action] : null
  if (!field || typeof value !== 'string' || !value.trim() || value.length > 200
      || /[\u0000-\u001f\u007f]/.test(value)) return refuse('Choose a supported slot configuration value.')
  const tier = tiers.find(row => row?.id === current?.tier)
  if (!current || !tier || tier.provider !== current.provider) return refuse('The applied provider and model could not be established. Read this slot again.')
  const previous = Object.freeze({ tier: current.tier, provider: current.provider,
    effort: current.effort ?? null, account: current.account ?? null, role: current.role ?? '' })
  const choice = { ...previous }
  const rows = switchChoices({ tiers, accounts, currentTier: previous.tier,
    currentEffort: previous.effort, startable, answered })
  if (field === 'model') {
    const found = tiers.filter(row => row?.provider === previous.provider
      && [row.id, row.model, row.cliModel].includes(value))
    if (found.length !== 1) return refuse('Choose one available model on this provider. Change the provider separately.')
    const target = found[0]
    if (target.id !== previous.tier && (!answered || !Array.isArray(startable))) return refuse('The available models have not been confirmed. Try again after the model list loads.')
    const offered = rows.models.find(row => row.id === target.id)
    if (!offered?.available) return refuse(offered?.reason || 'This copy cannot start that model.')
    choice.tier = target.id
  } else if (field === 'provider') {
    if (value !== previous.provider) {
      if (!answered || !Array.isArray(startable)) return refuse('The available providers have not been confirmed. Try again after the model list loads.')
      // A provider-only request uses the first confirmed model in chooser order.
      const target = rows.models.find(row => row.provider === value && row.available)
      if (!target) return refuse('This copy has not reported a startable model for that provider.')
      const declared = tiers.find(row => row.id === target.id)
      choice.tier = target.id
      choice.provider = target.provider
      choice.effort = declared?.effort ?? null
      // Account names are provider-local. A prior provider's account must never
      // accidentally select an identically named account on the new provider.
      choice.account = null
    }
  } else if (field === 'effort') {
    if (value !== previous.effort) {
      if (!effortAnswered) return refuse('The effort choices for this model have not been confirmed.')
      const supported = efforts.some(row => (typeof row === 'string' ? row : row?.id) === value)
      if (!supported) return refuse('This model does not offer that effort choice.')
      choice.effort = value
    }
  } else if (field === 'account') {
    if (previous.provider === 'local') return refuse('Local sessions do not use subscription accounts.')
    if (value !== previous.account) {
      if (!accountAnswered) return refuse('The available accounts could not be confirmed.')
      const found = rows.accounts.filter(row => row.name === value && row.provider === previous.provider)
      if (found.length !== 1) return refuse('Choose one signed-in account for this slot’s provider.')
      choice.account = found[0].name
    }
  } else {
    if (!roles.some(row => row?.id === value)) return refuse('That role is not in the current Role library.')
    choice.role = value
  }
  const changed = Object.keys(previous).some(key => choice[key] !== previous[key])
  return Object.freeze({ ok: true, field, changed, previous, choice: Object.freeze(choice) })
}
