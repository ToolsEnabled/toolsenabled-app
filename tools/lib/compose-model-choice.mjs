/* PROVIDER, THEN MODEL, THE WAY A PERSON PICKS THEM (1.0.48).
 *
 * Owner decision: every model a provider offers is selectable, chosen as
 * provider first, then model. Since then the start
 * panel draws two menus on one row: Provider ([data-compose-field="provider"])
 * and Model ([data-compose-field="tier"]). The Model menu holds ONE provider's
 * rows at a time, and a provider change lands it on that provider's default
 * (Codex astra, Claude the moving `claude-opus`). So a drive that walked the
 * Model menu from astra to `claude-sonnet` with ArrowDown can no longer reach
 * it: the row is not in the menu until Claude is the provider, and once it is,
 * the menu sits on `claude-opus`, BELOW `claude-sonnet`.
 *
 * This module holds only the order of the two picks. The keyboard gesture
 * stays each drive's own (its press, its Escape, its arrow keys), handed in as
 * `choose(selector, value)`, which must answer `{ ok, why? }` and must walk
 * from the top of the menu (Home first) rather than from wherever the menu
 * happens to sit. Nothing here writes a value or raises an event: every change
 * a drive makes is still a real keystroke.
 *
 * The provider of a model is read off the product's own table, never retyped
 * here, so a row added to a provider is found under it without editing this. */
import { LAUNCH_TIERS } from '../../src/orchestration-controls.js'

export const COMPOSE_PROVIDER = '[data-compose-field="provider"]'
export const COMPOSE_MODEL = '[data-compose-field="tier"]'

/** The provider key a model row runs on ('codex', 'claude', ...), or null for an id the table does not know. */
export function providerOfModel(modelId) {
  return LAUNCH_TIERS.find(row => row.id === modelId)?.provider || null
}

/**
 * Choose the provider, then the model, with the drive's own gesture.
 *
 * Answers the model pick's own result with `provider` added, so a caller that
 * read `.ok`, `.label`, `.presses` or `.after` off its chooser still can. A
 * provider that cannot be reached stops there and says so: the model is never
 * walked under a provider the drive did not get to.
 */
export async function chooseProviderThenModel(choose, modelId, {
  provider = providerOfModel(modelId),
  providerField = COMPOSE_PROVIDER,
  modelField = COMPOSE_MODEL,
} = {}) {
  if (typeof choose !== 'function') throw new TypeError('chooseProviderThenModel needs the drive\'s own choose(selector, value)')
  if (!provider) {
    return { ok: false, stage: 'provider', provider: null, why: `no provider in the product's table runs the model ${JSON.stringify(modelId)}` }
  }
  const onProvider = await choose(providerField, provider)
  if (onProvider?.ok !== true) {
    return { ...(onProvider || {}), ok: false, stage: 'provider', provider, why: `provider ${provider}: ${onProvider?.why || 'the menu never reached it'}` }
  }
  const onModel = await choose(modelField, modelId)
  if (onModel?.ok !== true) {
    return { ...(onModel || {}), ok: false, stage: 'model', provider, why: `model ${modelId} under ${provider}: ${onModel?.why || 'the menu never reached it'}` }
  }
  return { ...onModel, ok: true, stage: 'model', provider }
}
