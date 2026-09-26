/* PROVIDER, THEN MODEL, IN THE RAIL'S START-WORK BOXES (1.0.48).
 *
 * Owner decision: every model a provider offers is selectable, chosen as
 * provider first, then model.
 *
 * The Launch, Team and Loop boxes -- the tree agent's own
 * (views/computers.js nativeBoundedWorkBox) and the dispatch boxes a lane
 * agent gets -- each had ONE menu whose rows read "<Model> · <provider key>"
 * ("Luna · codex"), and a depth menu of every Codex word whatever the model.
 * They now ask for the provider first, then one of that provider's models,
 * then (on the tree boxes) a depth that model takes.
 *
 * THE PROVIDER MENU IS A FILTER, NEVER A FIELD (D1). What a box hands on is
 * still one row id, read from the Model menu, which keeps its old field name
 * and row-id values so drives and a retained plan keep working.
 *
 * THESE HELPERS SET `.value` IN CODE, WHICH RAISES NO EVENT (D12). Each caller
 * therefore re-runs its own checks (its Start button, its argv line, its plan
 * line) after calling them, rather than trusting a change listener to. */
import { EACH_MODEL_DEFAULT_EFFORT, PROVIDER_CHOICES, PROVIDER_WORDS, effortChoicesFor, providerDefaultTier } from './fleet-tree-copy.js'
import { launchTier, offeredEffort } from './orchestration-controls.js'

function menuOption(value, label) {
  const option = document.createElement('option')
  option.value = value
  option.textContent = label
  return option
}

/**
 * "<Model> · <Provider>", the order every model menu in the product reads
 * (tierChoicesFor composes its rows the same way). `withEffort` adds the depth
 * a dispatch row always runs at, which the dispatch Launch box states beside
 * the flags it prints. '' for an id this build does not know, so a caller can
 * say so in words instead of printing the raw key.
 */
export function modelWords(tierOrRow, { withEffort = false } = {}) {
  const row = typeof tierOrRow === 'string' ? launchTier(tierOrRow) : tierOrRow
  if (!row || typeof row.label !== 'string' || !row.label) return ''
  const provider = PROVIDER_WORDS[row.provider]
  /* A model named like its provider is named once ("Local", never
     "Local · Local"): tree-standalone-agent.js fullLabel's rule. */
  const words = provider && provider !== row.label ? `${row.label} · ${provider}` : row.label
  return withEffort && typeof row.effort === 'string' && row.effort ? `${words} · ${row.effort}` : words
}

/** The providers `rows` span, in the Provider menu's order, each with its own rows in table order. */
export function providerGroups(rows) {
  const list = Array.isArray(rows) ? rows.filter(row => row && typeof row.id === 'string') : []
  return PROVIDER_CHOICES
    .map(choice => ({ id: choice.id, label: choice.label, rows: list.filter(row => row.provider === choice.id) }))
    .filter(group => group.rows.length > 0)
}

/**
 * Fill the Provider menu, then the Model menu with that provider's rows only.
 *
 * With `providerId` (the person changed provider) it shows that provider and
 * lands on its default model: Codex GPT-6-Astra, Claude the moving
 * "Opus (latest)", anyone else its first row -- providerDefaultTier, the rule
 * every other start surface uses. Otherwise it shows the provider `tierId`
 * belongs to and lands on `tierId`; an id that is not one of `rows` falls to
 * the first provider's default. Returns the row id now chosen, or ''.
 */
export function showProviderModels(providerSelect, modelSelect, rows, { tierId = null, providerId = null, withEffort = false } = {}) {
  const groups = providerGroups(rows)
  const group = groups.find(entry => entry.id === providerId)
    || groups.find(entry => entry.rows.some(row => row.id === tierId))
    || groups[0]
  providerSelect.replaceChildren(...groups.map(entry => menuOption(entry.id, entry.label)))
  if (!group) {
    modelSelect.replaceChildren()
    return ''
  }
  providerSelect.value = group.id
  modelSelect.replaceChildren(...group.rows.map(row => menuOption(row.id, modelWords(row, { withEffort }))))
  const chosen = !providerId && group.rows.some(row => row.id === tierId)
    ? tierId
    : providerDefaultTier(group.id, group.rows) || group.rows[0].id
  modelSelect.value = chosen
  return chosen
}

/**
 * The depths `tierId` takes, and only those (effortChoicesFor, the list every
 * surface reads): no ultra on GPT-6-Luna, no xhigh on Opus 4.6, only "Model
 * default" on Haiku 4.5. "Model default" is '' and sends no depth.
 *
 * `keep` is a depth the person already chose: kept where this model takes it
 * (a Claude model runs `ultra` as `max`), otherwise the model's own default.
 * `keep === ''` asks for "Model default", which only a model with no depth of
 * its own offers. Leave `keep` out to land on the model's default. Returns the
 * value now chosen.
 *
 * `eachModel` is the Team box's menu: its first row is "Each model's default"
 * ('', in place of "Model default"), and it is where an untouched menu, or a
 * kept depth this model does not take, lands. A Team hands an untouched depth
 * to nobody, so showing the lead's default there showed a depth that did not
 * run (review follow-up V2).
 */
export function showEffortChoices(effortSelect, tierId, keep = undefined, { eachModel = false } = {}) {
  const own = effortChoicesFor(tierId)
  const choices = eachModel ? [EACH_MODEL_DEFAULT_EFFORT, ...own.filter(choice => choice.id !== '')] : own
  effortSelect.replaceChildren(...choices.map(choice => menuOption(choice.id, choice.label)))
  const wanted = keep === '' ? '' : typeof keep === 'string' ? offeredEffort(tierId, keep) || null : null
  const value = choices.some(choice => choice.id === wanted)
    ? wanted
    : eachModel ? '' : (choices.find(choice => choice.isDefault) || choices[0])?.id ?? ''
  effortSelect.value = value
  return value
}

/**
 * The depth one agent of a Team or Loop is started at. The depth menu lists
 * the LEAD's depths, and a member can run another model: a Codex `xhigh` would
 * be refused by Opus 4.6, and any depth by Haiku 4.5. So each start keeps the
 * chosen depth where its own model takes it and otherwise sends none, which
 * leaves that model's own default in charge.
 */
export function startWorkEffort(tierId, effort) {
  return typeof effort === 'string' && effort ? offeredEffort(tierId, effort) || null : effort
}
