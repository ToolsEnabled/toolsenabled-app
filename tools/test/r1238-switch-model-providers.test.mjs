// WHICH PROVIDERS A RUNNING CONVERSATION MAY BE CONTINUED ON, AND THE LAST
// PROVIDER NAME THAT WAS WRONG ABOUT IT.
//
// OWNER REQUEST R1238 (2026-09-19): "why cant i choose to switch models between
// codex or claude or local or grok or gemini mid session. this was built. why
// does the button hide now it needs to work dude there is no reason this doesnt
// work."
//
// THE DEFECT, measured on this payload 2026-09-19. sessionModelChoices() ended
// its continuation test with `tier.provider !== 'local'`, guarded by a comment
// in the same file claiming "`local` has no interactive runner in this copy at
// all -- the shell refuses it at start (resolveStartTier)". Every clause of that
// claim was false here:
//
//   capability/src/lib/agent-engine/local-node-process.js exports BOTH
//     startLocalSession and resumeLocalSession
//   shell/agent-host.cjs START_TIERS carries  local: { provider: 'local', ... }
//   shell/agent-host.cjs resolveStartTier()  "if (row.provider === 'local' &&
//     localEngine) return row"
//
// So the row was not refused for a reason; it was removed by a name, on a build
// that ships the runner. local's one REAL limit is the narrow one it shares with
// Claude: local-node-adapter.js sendTurn() destructures { threadId, text,
// images }, so no model can be taken IN PLACE mid-thread -- which makes it a
// continuation target, exactly like Claude, not a refusal.
//
// WHAT THESE ASSERTIONS PIN. Startability is asked of the shell and never
// asserted from a provider name, and the reading is used in ONE direction only:
// it may add a row, and an unanswered probe may never take one away. That second
// half is not hypothetical -- gating on the pre-answer value deleted the working
// "Continue on Opus · Claude" row, because the pre-answer value is
// TREE_DEFAULT_STARTABLE_TIERS, the four Codex tiers.
import test from 'node:test'
import assert from 'node:assert/strict'

import { sessionModelChoices } from '../../src/fleet-tree-copy.js'
import { LAUNCH_TIERS } from '../../src/orchestration-controls.js'

const EVERY_TIER = LAUNCH_TIERS.map(tier => tier.id)
const rowFor = (rows, id) => rows.find(row => row.id === id) || null
const providerTier = provider => LAUNCH_TIERS.find(tier => tier.provider === provider).id

/* The five providers the owner named, each by a tier that really carries it. */
const LOCAL = providerTier('local')
const GEMINI = providerTier('gemini')
const GROK = providerTier('grok')

test('a shell that starts every provider offers every provider as a continuation', () => {
  const rows = sessionModelChoices('astra', { startable: EVERY_TIER, answered: true })
  for (const [name, id] of [['local', LOCAL], ['gemini', GEMINI], ['grok', GROK], ['claude', 'claude-opus']]) {
    const row = rowFor(rows, id)
    assert.ok(row, `${name} has no row at all`)
    assert.equal(row.continuation, true, `${name} (${id}) is not offered as a continuation`)
    assert.ok(row.continuationHint, `${name} is a continuation with nothing said about what it costs`)
  }
})

test('local is a continuation and never an in-place switch', () => {
  /* Both halves matter. Offering local is the fix; offering it as an in-place
     switch would be the silent no-op this menu exists to prevent, because the
     local adapter's sendTurn() never reads a per-turn model. */
  const row = rowFor(sessionModelChoices('astra', { startable: EVERY_TIER, answered: true }), LOCAL)
  assert.equal(row.continuation, true)
  assert.equal(row.enabled, false)
})

test('the refusal a person reads is never the old missing-runner claim', () => {
  const everywhere = [
    ...sessionModelChoices('astra', { startable: EVERY_TIER, answered: true }),
    ...sessionModelChoices('astra', { startable: ['astra'], answered: true }),
    ...sessionModelChoices('astra'),
  ].map(row => row.disabledHint).filter(Boolean)
  for (const sentence of everywhere) {
    assert.ok(!/interactive runner/i.test(sentence),
      `a row still claims a missing interactive runner: ${sentence}`)
  }
})

test('a shell that starts only Codex refuses the rest by saying so, and says it about the build', () => {
  const rows = sessionModelChoices('astra', { startable: ['astra', 'luna', 'terra', 'sol'], answered: true })
  const opus = rowFor(rows, 'claude-opus')
  assert.equal(opus.continuation, false)
  assert.match(opus.disabledHint, /cannot start/i)
})

test('an UNANSWERED probe never subtracts a row that worked before it was asked', () => {
  /* The regression this catches by value: `startable` carrying the pre-answer
     default with `answered:false` must behave exactly like no argument at all.
     t158-cross-provider-model-switch caught this as a missing
     "Continue on Opus · Claude" row. */
  const preAnswer = sessionModelChoices('claude-sonnet', { startable: ['astra', 'luna', 'terra', 'sol'], answered: false })
  const neverAsked = sessionModelChoices('claude-sonnet')
  assert.equal(rowFor(preAnswer, 'claude-opus').continuation, true)
  assert.deepEqual(
    preAnswer.map(row => [row.id, row.enabled, row.continuation]),
    neverAsked.map(row => [row.id, row.enabled, row.continuation]),
  )
})

test('the row for the model it already runs on states the fact, not a startability verdict', () => {
  const rows = sessionModelChoices('claude-opus', { startable: EVERY_TIER, answered: true })
  const own = rowFor(rows, 'claude-opus')
  assert.equal(own.continuation, false)
  assert.match(own.disabledHint, /running on/i)
})

test('every tier still gets a row, whatever the shell answered', () => {
  /* The menu's own standing rule: a model a person cannot pick is shown with
     the reason, never dropped. An absent row reads as a product that lacks the
     feature -- which is the complaint R1238 opens with. */
  for (const answer of [{ startable: EVERY_TIER, answered: true }, { startable: [], answered: true }, undefined]) {
    const rows = sessionModelChoices('astra', answer)
    assert.equal(rows.length, LAUNCH_TIERS.length)
    for (const row of rows) {
      assert.ok(row.enabled || row.continuation || row.disabledHint,
        `${row.id} is neither usable nor explained`)
    }
  }
})
