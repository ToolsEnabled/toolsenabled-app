/* The record that outlives the screen.
 *
 * WHAT THIS IS GUARDING. src/ledger-prompt-queue.js submit() used to read
 * `if (destroyed) return` BEFORE it read `result.ok`, so when the owner pressed
 * "Submit decisions" and then pressed the arrow -- which destroys the view
 * instance immediately -- a REFUSED decision was dropped in silence and became
 * indistinguishable from a recorded one. The end-to-end proof of the fix is
 * tools/approvals-decision-outcome-qa.cjs, which drives the real app through
 * that exact journey. This suite guards the store the fix depends on, and in
 * particular its absence cases: this codebase's signature defect is a missing
 * field, an empty string or a falsy default being read as permission.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  APPROVAL_OUTCOME_EVENT,
  clearUndeliveredDecision,
  recordUndeliveredDecision,
  reconcileUndeliveredDecisions,
  resetUndeliveredDecisions,
  undeliveredDecision,
  undeliveredDecisionCount,
  undeliveredDecisions,
} from '../../src/approval-outcomes.js'

const fresh = () => { resetUndeliveredDecisions() }

test('a refused decision is filed and can be read back against its own prompt', () => {
  fresh()
  const entry = recordUndeliveredDecision('batch-1', 'The decision record could not be written.')
  assert.equal(entry.promptId, 'batch-1')
  assert.equal(entry.reason, 'The decision record could not be written.')
  assert.equal(undeliveredDecisionCount(), 1)
  assert.equal(undeliveredDecision('batch-1').reason, 'The decision record could not be written.')
  assert.equal(undeliveredDecision('some-other-batch'), null,
    'a prompt with no failure must read as null, never as a truthy default')
})

test('a confirmed decision clears the failure it replaces', () => {
  fresh()
  recordUndeliveredDecision('batch-1', 'refused')
  assert.equal(clearUndeliveredDecision('batch-1'), true)
  assert.equal(undeliveredDecisionCount(), 0)
  assert.equal(clearUndeliveredDecision('batch-1'), false, 'clearing nothing is not a change')
})

/* --------------------------------------------------------------------------
   ABSENCE. Every one of these is a shape the bridge can genuinely produce.
   -------------------------------------------------------------------------- */

test('a refusal that says nothing still produces a whole sentence', () => {
  for (const missing of [undefined, null, '', '   ', 42, {}, []]) {
    fresh()
    const entry = recordUndeliveredDecision('batch-1', missing)
    assert.ok(entry, `a refusal with reason ${JSON.stringify(missing)} must still be filed`)
    assert.ok(entry.reason.length > 0, 'an empty reason would render as a notice that says nothing')
    assert.match(entry.reason, /[a-z]/i)
    assert.match(entry.reason, /\.$/, 'the stored reason is a sentence, because it is printed inside one')
  }
})

test('an over-long reason is truncated rather than allowed to take over the screen', () => {
  fresh()
  const entry = recordUndeliveredDecision('batch-1', 'x'.repeat(5_000))
  assert.ok(entry.reason.length <= 300)
  assert.match(entry.reason, /…$/)
})

test('a failure that names no prompt is not filed under an empty key', () => {
  fresh()
  for (const id of [undefined, null, '', '   ', 7, {}]) {
    assert.equal(recordUndeliveredDecision(id, 'refused'), null, `filed under ${JSON.stringify(id)}`)
  }
  assert.equal(undeliveredDecisionCount(), 0,
    'an entry no queue reading can ever clear would sit on the home screen forever')
  assert.equal(undeliveredDecision(''), null)
})

test('a reconcile that was never given a queue reading prunes NOTHING', () => {
  /* THE ONE THAT MATTERS. "I could not read what is pending" must never be
     read as "nothing is pending" -- that reading would erase the record of a
     refused decision on the strength of a failed request, which is precisely
     the absence-as-consent shape this codebase keeps producing.

     Mutation proof: inverting the Array.isArray guard in
     reconcileUndeliveredDecisions makes this case throw on undefined and makes
     the genuine-reading cases retain stale entries. Keep both sides of that
     boundary here: merely asserting one input shape would not discriminate the
     guard from a constant return. */
  for (const notAReading of [undefined, null, 'batch-1', 0, false, {}]) {
    fresh()
    recordUndeliveredDecision('batch-1', 'refused')
    assert.equal(reconcileUndeliveredDecisions(notAReading), 1, `pruned on ${JSON.stringify(notAReading)}`)
    assert.equal(undeliveredDecisionCount(), 1)
  }
})

test('a genuine queue reading prunes what is no longer pending and keeps what is', () => {
  fresh()
  recordUndeliveredDecision('batch-1', 'refused')
  recordUndeliveredDecision('batch-2', 'refused')
  assert.equal(reconcileUndeliveredDecisions(['batch-2', 'batch-9']), 1)
  assert.equal(undeliveredDecision('batch-1'), null,
    'a request that left the queue was decided, expired or withdrawn; a failure notice about it is a claim nobody can check')
  assert.ok(undeliveredDecision('batch-2'))
})

test('a genuinely empty queue does prune, because that IS a reading', () => {
  fresh()
  recordUndeliveredDecision('batch-1', 'refused')
  assert.equal(reconcileUndeliveredDecisions([]), 0)
  assert.equal(undeliveredDecisionCount(), 0)
})

test('junk inside a real reading cannot resurrect or invent an entry', () => {
  fresh()
  recordUndeliveredDecision('batch-1', 'refused')
  assert.equal(reconcileUndeliveredDecisions([null, '', undefined, 5]), 0,
    'a list of unusable ids is a reading in which nothing this store holds is pending')
  assert.equal(undeliveredDecisionCount(), 0)
})

test('entries come back newest first, and the store cannot be mutated through them', () => {
  fresh()
  recordUndeliveredDecision('older', 'refused', 1_000)
  recordUndeliveredDecision('newer', 'refused', 2_000)
  const list = undeliveredDecisions()
  assert.deepEqual(list.map(entry => entry.promptId), ['newer', 'older'])
  list.pop()
  assert.equal(undeliveredDecisionCount(), 2, 'the caller got a copy')
  assert.throws(() => { list[0].reason = 'rewritten' }, TypeError)
})

test('a change announces itself, so a screen already mounted does not wait out its poll', () => {
  fresh()
  const seen = []
  const priorWindow = globalThis.window
  globalThis.window = { dispatchEvent: event => { seen.push({ type: event.type, count: event.detail?.count }); return true } }
  try {
    recordUndeliveredDecision('batch-1', 'refused')
    clearUndeliveredDecision('batch-1')
    reconcileUndeliveredDecisions(['batch-1'])   // nothing changed: no event
  } finally {
    if (priorWindow === undefined) delete globalThis.window
    else globalThis.window = priorWindow
  }
  assert.deepEqual(seen, [
    { type: APPROVAL_OUTCOME_EVENT, count: 1 },
    { type: APPROVAL_OUTCOME_EVENT, count: 0 },
  ])
})

/* --------------------------------------------------------------------------
   The ordering the whole fix rests on.
   -------------------------------------------------------------------------- */

test('the approvals screen files the outcome BEFORE it asks whether its view survived', () => {
  /* Asserted on the source because the failure mode is invisible to any test
     that does not destroy the view mid-flight: move `if (destroyed) return`
     back above the result branch and every DOM assertion still passes while a
     refusal is silently dropped again. The end-to-end guard is
     tools/approvals-decision-outcome-qa.cjs. */
  const source = readFileSync(new URL('../../src/ledger-prompt-queue.js', import.meta.url), 'utf8')
  const submit = source.slice(source.indexOf('async function submit('), source.indexOf('async function confirmPresented('))
  assert.ok(submit.length > 0, 'submit() has been renamed or moved; this guard no longer reads it')

  const awaited = submit.indexOf('await decideOwnerPrompt')
  const filed = submit.indexOf('recordUndeliveredDecision')
  const destroyedCheck = submit.indexOf('if (destroyed) return', awaited)
  assert.ok(awaited >= 0 && filed >= 0 && destroyedCheck >= 0)
  assert.ok(filed > awaited, 'the outcome can only be filed once there is an outcome')
  assert.ok(filed < destroyedCheck,
    'the refusal must be recorded before this view asks whether it still exists, or a destroyed view drops it again')

  const success = submit.indexOf('clearUndeliveredDecision')
  assert.ok(success > awaited && success < submit.indexOf('setCardStatus(card, \'Decision recorded.\')'),
    'a confirmed decision must clear its own earlier failure even when the view that confirmed it is gone')
})
