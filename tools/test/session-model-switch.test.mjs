// WHAT A RUNNING CONVERSATION MAY BE SWITCHED TO, AND WHY THE OLD ANSWER LIED.
//
// The "Switch model" rows on a running session (src/views/computers.js
// modelRows()) labelled every Claude row "Claude — cannot start here yet" and
// enabled a row only when `tier.provider === 'codex'`. Both were written when
// Codex was the only engine in the payload. Measured 2026-08-20 against the
// shipped build -- shell/agent-host.cjs startableTiers() constructed over
// release/win-unpacked/resources/capability:
//
//   {"ok":true,"tiers":["luna","terra","sol","claude-fable","claude-sonnet","claude-opus"]}
//
// So "cannot start here yet" is false about this product, on a row that is not
// asking about starting at all: these rows write a PER-TURN model override that
// rides on bridge.send({sessionId, text, model}).
//
// THE PART THAT IS NOT A WORDING BUG. shell/agent-host.cjs narrowTurnOptions()
// gates on the TARGET tier's provider and never on the SESSION's, so on a
// build that starts Claude the one combination it permits for a Claude
// conversation is the cross-provider one -- `gpt-5.6-luna` offered to a Claude
// thread. It would not even fail loudly: claude-cli-adapter.js sendTurn()
// destructures `{ threadId, text, images }` and drops `options` on the floor
// (validateSendTurnRequest does return it), and the model is bound once at
// spawn as `--model` in claudeArgs(). The person would be told "Messages run on
// gpt-5.6-luna" and the turn would run on Claude.
//
// So the rule these assertions pin is: a row is switchable only when it stays
// inside the SESSION'S OWN provider, and only for a provider whose adapter
// really reads a per-turn model. Codex does. Claude does not -- its model is
// fixed at start -- and that is a property of the engine, not a missing
// feature to be papered over with an enabled row that silently does nothing.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LAUNCH_TIERS } from '../../src/orchestration-controls.js'
import { sessionModelChoices } from '../../src/fleet-tree-copy.js'

const byId = (rows, id) => rows.find(row => row.id === id)

test('a Codex conversation may switch between Codex models', () => {
  const rows = sessionModelChoices('luna')
  for (const id of ['luna', 'terra', 'sol']) {
    const row = byId(rows, id)
    assert.ok(row, `${id} row is missing`)
    assert.equal(row.enabled, true, `${id} should be switchable from a Codex conversation`)
    assert.equal(row.disabledHint, '', `${id} should carry no refusal`)
  }
})

// T137: a model switch, including across providers, continues in a fresh
// session with the context handed over. So the rows the thread cannot switch to IN PLACE
// are no longer refusals: each is offered as a CONTINUATION -- a fresh session
// on that tier, started from the same handoff "Continue on another account"
// sends. `enabled` keeps its old meaning (a real per-turn override) and
// `continuation` is the new door. The assertions below pin both.

test('a Codex conversation is offered Claude models as continuations, never as in-place switches', () => {
  const rows = sessionModelChoices('luna')
  for (const id of ['claude-fable', 'claude-sonnet', 'claude-opus']) {
    const row = byId(rows, id)
    assert.ok(row, `${id} row is missing`)
    assert.equal(row.enabled, false, `${id} is not a per-turn switch from a Codex conversation`)
    assert.equal(row.continuation, true, `${id} must be reachable by continuing the conversation on it`)
    assert.equal(row.disabledHint, '', `${id} carries no refusal once it is a continuation`)
    assert.match(row.continuationHint, /fresh session/i, `${id} must say a fresh session starts: ${row.continuationHint}`)
    assert.match(row.continuationHint, /handoff/i, `${id} must say the conversation travels by handoff: ${row.continuationHint}`)
    assert.match(row.continuationHint, /Codex session ends/, `${id} must say which session ends: ${row.continuationHint}`)
    assert.ok(!/cannot start/i.test(row.continuationHint) && !/no launcher/i.test(row.continuationHint),
      `${id} must not claim Claude cannot start here: ${row.continuationHint}`)
  }
})

test('a Claude conversation is offered Codex models as continuations — the upside-down case is now a door', () => {
  const rows = sessionModelChoices('claude-sonnet')
  for (const id of ['luna', 'terra', 'sol']) {
    const row = byId(rows, id)
    assert.ok(row, `${id} row is missing`)
    assert.equal(row.enabled, false, `${id} is not a per-turn switch on a Claude conversation`)
    assert.equal(row.continuation, true, `${id} must be reachable by continuing the conversation on it`)
    assert.match(row.continuationHint, /Claude session ends/, `${id} must name the session that ends: ${row.continuationHint}`)
  }
})

test('a Claude conversation cannot switch model in place, so its other Claude models are continuations and its own model is a fact', () => {
  const rows = sessionModelChoices('claude-sonnet')
  for (const id of ['claude-fable', 'claude-opus']) {
    const row = byId(rows, id)
    assert.ok(row, `${id} row is missing`)
    assert.equal(row.enabled, false, `${id} is not switchable in place: claudeArgs() binds --model once at spawn`)
    assert.equal(row.continuation, true, `${id} is reached by a fresh session with the handoff`)
  }
  const own = byId(rows, 'claude-sonnet')
  assert.equal(own.enabled, false)
  assert.equal(own.continuation, false, 'a conversation is not continued onto the tier it already runs on')
  assert.match(own.disabledHint, /running on .*Sonnet.* now/, `the own row states the fact: ${own.disabledHint}`)
})

test('a Codex conversation is not offered its own provider as continuations: those rows switch in place', () => {
  const rows = sessionModelChoices('luna')
  for (const id of ['luna', 'terra', 'sol']) {
    const row = byId(rows, id)
    assert.equal(row.enabled, true, `${id} switches in place`)
    assert.equal(row.continuation, false, `${id} needs no fresh session`)
    assert.equal(row.continuationHint, '')
  }
})

test('an unrecorded tier is pessimistic rather than guessing a provider', () => {
  for (const tier of [null, undefined, '', 'not-a-tier']) {
    const rows = sessionModelChoices(tier)
    assert.ok(rows.length > 0, 'rows are still drawn so the menu is never empty')
    assert.equal(rows.some(row => row.enabled), false, `an unknown tier (${String(tier)}) must enable nothing`)
    assert.equal(rows.some(row => row.continuation), false, `an unknown tier (${String(tier)}) cannot be continued from: nothing says what it was`)
    assert.ok(rows.every(row => row.disabledHint.length > 0), 'every row says why')
  }
})

test('every launchable tier gets a row, so the menu never hides a model that exists', () => {
  const rows = sessionModelChoices('luna')
  assert.equal(rows.length, LAUNCH_TIERS.length)
  for (const tier of LAUNCH_TIERS) {
    const row = byId(rows, tier.id)
    assert.ok(row, `${tier.id} is missing from the menu`)
    assert.equal(row.model, tier.model)
    assert.ok(row.label.includes(tier.label), `${tier.id} label should name the tier: ${row.label}`)
  }
})

test('the local tier is refused for the reason that is actually true of it', () => {
  const row = byId(sessionModelChoices('luna'), 'local')
  assert.equal(row.enabled, false)
  assert.equal(row.continuation, false, 'local has no interactive runner in this copy, so no conversation is continued onto it')
  assert.ok(row.disabledHint.length > 0, 'local must say why')
})

/* PROVIDER, THEN MODEL (1.0.48). The Switch model menu asks for a provider
   first and then draws that provider's rows. The filter must narrow and never
   decide: each row it returns is the row the full list draws, and together the
   providers still draw every tier. */
test('a provider narrows the rows to that provider, each exactly as the full list draws it', () => {
  const providers = [...new Set(LAUNCH_TIERS.map(tier => tier.provider))]
  for (const session of ['luna', 'claude-sonnet', 'not-a-tier']) {
    const all = sessionModelChoices(session)
    const union = []
    for (const provider of providers) {
      const rows = sessionModelChoices(session, { provider })
      assert.deepEqual(rows.map(row => row.id), LAUNCH_TIERS.filter(tier => tier.provider === provider).map(tier => tier.id),
        `${session}/${provider}: that provider's rows, in table order, and no other provider's`)
      for (const row of rows) {
        assert.equal(row.provider, provider)
        assert.deepEqual(row, byId(all, row.id), `${session}/${row.id}: the narrowed row is the full list's row`)
      }
      union.push(...rows.map(row => row.id))
    }
    assert.deepEqual(union, LAUNCH_TIERS.map(tier => tier.id), `${session}: the providers together draw every tier`)
  }
})

test('Opus 5 and Sonnet 5 are on the Claude stage of a running conversation, as continuations', () => {
  for (const session of ['claude-sonnet', 'astra']) {
    const claude = sessionModelChoices(session, { provider: 'claude' })
    for (const [id, label] of [['claude-opus-5', 'Opus 5 · Claude'], ['claude-sonnet-5', 'Sonnet 5 · Claude']]) {
      const row = byId(claude, id)
      assert.ok(row, `${session}: ${id} is on the Claude stage`)
      assert.equal(row.label, label)
      assert.equal(row.continuation, true, `${session}: ${id} is reached by continuing the conversation on it`)
    }
  }
})
