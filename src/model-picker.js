import { LAUNCH_TIERS, launchTier, offeredEffort, tierDefaultEffort } from './orchestration-controls.js'

export const OTHER_MODEL_VALUE = '__other_model__'
export const OTHER_MODEL_LABEL = 'Other model…'
export const MODEL_NAME_LABEL = 'Model name'
export const MAX_MODEL_ID_LENGTH = 2048
export const MODEL_NAME_HELP = 'Enter the model name your provider offers. It is sent exactly as typed.'
export const MODEL_NEXT_START = 'The running session keeps its model. Your choice takes effect when this agent is started again.'

// Match the engine's validateNativeModelId. Whitespace is inspected, never removed.
export function modelIdProblem(value) {
  if (typeof value !== 'string' || !value.trim()) return 'Enter a model name before continuing.'
  if (value.length > MAX_MODEL_ID_LENGTH) return 'Keep the model name to 2048 characters or fewer.'
  if (/[\u0000-\u001f\u007f]/.test(value)) return 'Use a single-line model name without control characters.'
  return ''
}

export function validateModelId(value) {
  const sentence = modelIdProblem(value)
  if (sentence) throw Object.assign(new Error(sentence), { code: 'AGENT_MODEL_INVALID' })
  return value
}

// Use the native provider's default launcher, including Gemini's native CLI.
const CUSTOM_PROVIDER_TIERS = Object.freeze({
  codex: 'astra', claude: 'claude-opus', gemini: 'gemini', grok: 'grok', local: 'local',
})
export const customModelTier = provider => CUSTOM_PROVIDER_TIERS[provider] || null

export function modelEffortRow(tierId, model = null) {
  const base = launchTier(tierId)
  return model == null ? base : LAUNCH_TIERS.find(row => row.provider === base?.provider
    && !row.client && (row.model === model || row.cliModel === model))
    || (base ? { ...base, client: null, efforts: undefined } : null)
}

export function modelChoiceEffort(tierId, model, effort) {
  const row = modelEffortRow(tierId, model)
  return offeredEffort(row, effort) || tierDefaultEffort(row) || null
}

export function modelChoiceLabel(choice, fallback = '') {
  return typeof choice?.model === 'string' ? choice.model : fallback
}

export function customModelAction({ provider, value = '', hint = MODEL_NAME_HELP, enabled = true, disabledHint = null, submit } = {}) {
  return {
    id: `model-other-${provider}`, label: OTHER_MODEL_LABEL, hint, enabled, disabledHint,
    run: ctx => ctx.modelInput({ value, hint, submit: (model, inputCtx) => submit(validateModelId(model), inputCtx) }),
  }
}

export function nextModelChoiceProblem(choice) {
  if (!choice || typeof choice !== 'object' || !launchTier(choice.tier)) return 'Choose a provider for this model.'
  return modelIdProblem(choice.model)
}

export function createModelNameField(doc, { attribute = 'data-model-field', className = '', value = '' } = {}) {
  const field = doc.createElement('label')
  field.className = className
  const words = doc.createElement('span')
  words.textContent = MODEL_NAME_LABEL
  const input = doc.createElement('input')
  input.type = 'text'
  input.setAttribute('type', 'text')
  input.setAttribute(attribute, 'model')
  input.setAttribute('aria-label', MODEL_NAME_LABEL)
  input.setAttribute('autocomplete', 'off')
  input.setAttribute('spellcheck', 'false')
  input.value = value
  field.appendChild(words)
  field.appendChild(input)
  return { field, input }
}
