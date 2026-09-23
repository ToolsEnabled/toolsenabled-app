/* The condition language: one language, two moments, no operator inside it.
 *
 * The load-bearing test in this file is the last group. The five operators the
 * owner uses are written out here IN THE LANGUAGE, as ordinary reasons built
 * from the terms below, and nothing in the module under test knows any of their
 * names. If one of them could not be expressed here, it would have to be built
 * in, and the whole design would be wrong.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CONDITION_TERMS, LIFECYCLE, MOMENTS, SIBLING_QUANTIFIERS, SIBLING_SCOPES, VALUE_TESTS,
  describeCondition, describeReason, evaluateCondition, evaluateReason, readCondition, termsForMoment,
  validateCondition, validateReason,
} from '../../src/research-conditions.mjs'

const fields = new Set(['subject', 'reviewers', 'gate', 'event'])
const generation = { moment: MOMENTS.generation, fields }
const runtime = { moment: MOMENTS.runtime, fields }

// ---- the comparisons, carried over unchanged ------------------------------

test('the eight comparisons still compare what they always compared', () => {
  assert.deepEqual(VALUE_TESTS.map(item => item.id),
    ['is', 'is-not', 'contains', 'one-of', 'at-least', 'at-most', 'present', 'absent'])
  const values = { subject: 'chemistry', reviewers: '4' }
  const read = (field, kind, value) => evaluateCondition({ field, test: kind, value }, { values })
  assert.equal(read('subject', 'is', 'chemistry'), true)
  assert.equal(read('subject', 'is-not', 'geology'), true)
  assert.equal(read('subject', 'contains', 'chem'), true)
  assert.equal(read('subject', 'one-of', 'geology\nchemistry'), true)
  assert.equal(read('reviewers', 'at-least', '4'), true)
  assert.equal(read('reviewers', 'at-most', '3'), false)
  assert.equal(read('subject', 'present'), true)
  assert.equal(read('missing', 'absent'), true)
})

test('a condition written before the language had terms still means what it said', () => {
  // Every rule in an existing draft is a field comparison naming no term.
  const old = { field: 'subject', test: 'is', value: 'chemistry' }
  assert.equal(readCondition(old).term, 'field')
  validateCondition(old, generation)
  assert.equal(evaluateCondition(old, { values: { subject: 'chemistry' } }), true)
})

// ---- the moments ----------------------------------------------------------

test('a reason that chooses a prompt may only read what exists when it is chosen', () => {
  const offered = termsForMoment(MOMENTS.generation).map(term => term.id)
  assert.deepEqual(offered, ['always', 'field'], 'the row and nothing else')
  assert.deepEqual(termsForMoment(MOMENTS.runtime).map(term => term.id),
    CONDITION_TERMS.map(term => term.id), 'everything is readable once the work is running')
})

test('a running-moment term inside a generation reason is refused by the name of the term', () => {
  assert.throws(() => validateCondition({ term: 'state', test: 'is', is: 'done' }, generation), error => {
    assert.match(error.message, /this child/, 'the term is named')
    assert.match(error.message, /while the work is running/, 'and the moment it belongs to')
    assert.match(error.message, /when the task is generated/, 'and the moment it was found at')
    return true
  })
  // The same term is ordinary once the work is running.
  validateCondition({ term: 'state', test: 'is', is: 'done' }, runtime)
})

test('a nested reason inside a duration is checked at the same moment as the reason holding it', () => {
  const nested = { term: 'since', of: [{ term: 'state', test: 'is', is: 'active' }], test: 'at-most', value: '3' }
  validateCondition(nested, runtime)
  // A duration is itself a running-moment term, so it is refused before its
  // nested reason is ever reached.
  assert.throws(() => validateCondition(nested, generation), /how long something has been true/)
})

test('the surface cannot offer a term that validation would then refuse', () => {
  for (const moment of [MOMENTS.generation, MOMENTS.runtime]) {
    for (const term of termsForMoment(moment)) {
      const sample = {
        always: { term: 'always' },
        field: { term: 'field', field: 'subject', test: 'present' },
        state: { term: 'state', test: 'is', is: 'done' },
        siblings: { term: 'siblings', scope: 'all', quantifier: 'none', is: 'active' },
        children: { term: 'children', quantifier: 'every', is: 'done' },
        reason: { term: 'reason', holds: true },
        since: { term: 'since', of: [{ term: 'always' }], test: 'at-most', value: '1' },
        ago: { term: 'ago', of: [{ term: 'always' }], test: 'at-most', value: '1' },
      }[term.id]
      // A missing sample names itself. Without this the term is handed to
      // validation as undefined and refused with "choose what this asks
      // about", which is a true sentence about the wrong subject.
      assert.ok(sample, `${term.id} is offered at ${moment} and this test has no sample for it`)
      validateCondition(sample, { moment, fields })
    }
  }
})

// ---- the terms ------------------------------------------------------------

test('a fact a condition asks for and nobody is supplying is refused, not read as no', () => {
  // A condition that quietly answers no is indistinguishable from one that was
  // never asked, which is the failure this refusal exists to prevent.
  assert.throws(() => evaluateCondition({ term: 'state', test: 'is', is: 'done' }, {}), /nothing here is reading one/)
  assert.throws(() => evaluateCondition({ term: 'siblings', scope: 'all', quantifier: 'any', is: 'active' }, {}), /the other children/)
  assert.throws(() => evaluateCondition({ term: 'reason', holds: true }, {}), /own reason/)
  assert.throws(() => evaluateCondition({ term: 'since', of: [{ term: 'always' }], test: 'is', value: '0' }, {}), /how long/)
  assert.throws(() => evaluateCondition({ term: 'ago', of: [{ term: 'always' }], test: 'is', value: '0' }, {}), /how long ago/)
})

test('a child reads its own state, and the negative reads as the negative', () => {
  const facts = { state: 'active' }
  assert.equal(evaluateCondition({ term: 'state', test: 'is', is: 'active' }, facts), true)
  assert.equal(evaluateCondition({ term: 'state', test: 'is', is: 'done' }, facts), false)
  assert.equal(evaluateCondition({ term: 'state', test: 'is-not', is: 'done' }, facts), true)
  assert.deepEqual(LIFECYCLE, ['idle', 'active', 'done'])
})

test('the other children are asked by which of them and how many', () => {
  const children = [{ state: 'done' }, { state: 'active' }, { state: 'idle' }]
  const ask = (scope, quantifier, is, index) =>
    evaluateCondition({ term: 'siblings', scope, quantifier, is }, { siblings: children, index })
  assert.equal(ask('all', 'any', 'active', 0), true, 'one of the others is active')
  assert.equal(ask('all', 'any', 'active', 1), false, 'a child is not its own sibling')
  assert.equal(ask('all', 'none', 'active', 2), false)
  assert.equal(ask('earlier', 'every', 'done', 1), true, 'the one child before it is done')
  assert.equal(ask('earlier', 'every', 'done', 2), false, 'the active one before it is not')
  assert.equal(ask('later', 'any', 'idle', 0), true)
  assert.deepEqual(SIBLING_SCOPES.map(item => item.id), ['all', 'earlier', 'later'])
  assert.deepEqual(SIBLING_QUANTIFIERS.map(item => item.id), ['any', 'none', 'every'])
})

test('a container reads the children it holds, which is not the same relation as siblings', () => {
  /* Siblings are the peers of a subject. A container's completion and reset
     reasons have no subject: they are about what the container holds. Without
     this term a container cannot say when it is done, and a container that
     cannot report done to its parent is a container that cannot nest. */
  const children = [{ state: 'done' }, { state: 'active' }]
  const ask = (quantifier, is) => evaluateCondition({ term: 'children', quantifier, is }, { children })
  assert.equal(ask('every', 'done'), false)
  assert.equal(ask('any', 'done'), true)
  assert.equal(ask('none', 'idle'), true)
  assert.equal(evaluateCondition({ term: 'children', quantifier: 'every', is: 'done' },
    { children: [{ state: 'done' }, { state: 'done' }] }), true)
  // It reads what the subject holds, never the subject's own peers.
  assert.throws(() => evaluateCondition({ term: 'children', quantifier: 'any', is: 'done' },
    { siblings: children, index: 0 }), /the children of this one/)
})

test('a container holding nothing is already done rather than stuck', () => {
  assert.equal(evaluateCondition({ term: 'children', quantifier: 'every', is: 'done' }, { children: [] }), true)
})

test('all of no children holds, which is what lets a sequence begin', () => {
  const children = [{ state: 'idle' }, { state: 'idle' }]
  assert.equal(evaluateCondition({ term: 'siblings', scope: 'earlier', quantifier: 'every', is: 'done' },
    { siblings: children, index: 0 }), true, 'the first child has no earlier sibling that could fail the test')
})

test('a duration is asked of a reason, and zero is the moment it became true', () => {
  const facts = (event, elapsed) => ({ values: { event }, since: () => elapsed })
  const becameTrue = { term: 'since', of: [{ field: 'event', test: 'is', value: 'yes' }], test: 'is', value: '0' }
  assert.equal(evaluateCondition(becameTrue, facts('yes', 0)), true, 'true today and false yesterday is a duration of zero')
  assert.equal(evaluateCondition(becameTrue, facts('yes', 9)), false, 'still true, but no longer the moment it became true')
  /* THE ONE THAT MATTERS. A duration has no answer while its reason is false,
     so a false reason must not read as one that has just become true. Reading
     it as a duration of zero would fire every gate keyed to an arriving event
     on every step where the event was absent. */
  assert.equal(evaluateCondition(becameTrue, facts('no', 0)), false, 'a reason that is false has not just become true')
  assert.equal(evaluateCondition({ ...becameTrue, test: 'at-most', value: '10' }, facts('yes', 9)), true)
  assert.equal(evaluateCondition({ ...becameTrue, test: 'at-least', value: '0' }, facts('no', 0)), false,
    'and it is false for every comparison, not only the ones a number happens to fail')
})

test('how long since a reason was last true is not how long it has been true', () => {
  /* THE OPERATOR THAT COULD NOT BE WRITTEN. An event fires on one step and is
     gone on the next, and a window it opened has to stay open over the steps
     where the reason is false. A duration cannot say that: it has no answer
     while its reason is false, deliberately, so the window shuts on the step
     after it opened. Both clocks are driven here off one history so the
     difference is the terms and not the fixture. */
  const event = [{ term: 'field', field: 'event', test: 'is', value: 'yes' }]
  const history = ['no', 'yes', 'no', 'no', 'no', 'no']
  const read = reason => {
    const first = new Map(), last = new Map()
    return history.map((value, step) => {
      const facts = {
        values: { event: value },
        since: (of, current) => {
          const holds = evaluateReason(of, current)
          if (!holds) first.delete('k'); else if (!first.has('k')) first.set('k', step)
          return first.has('k') ? step - first.get('k') : 0
        },
        ago: (of, current) => {
          if (evaluateReason(of, current)) last.set('k', step)
          return last.has('k') ? step - last.get('k') : null
        },
      }
      return evaluateReason(reason, facts)
    })
  }
  assert.deepEqual(read([{ term: 'since', of: event, test: 'at-most', value: '3' }]),
    [false, true, false, false, false, false],
    'a duration shuts the window on the step after the event stops holding')
  assert.deepEqual(read([{ term: 'ago', of: event, test: 'at-most', value: '3' }]),
    [false, true, true, true, true, false],
    'how long ago it was last true keeps the window open across the steps it is false for')
  // A window nobody ever opened is not one that opened long ago.
  assert.deepEqual(read([{ term: 'ago', of: [{ term: 'field', field: 'event', test: 'is', value: 'never' }], test: 'at-least', value: '0' }]),
    [false, false, false, false, false, false], 'a reason that has never held has no answer here')
})

test('a reason says a last-seen back in words that are not a duration', () => {
  assert.equal(describeCondition({ term: 'ago', of: [{ term: 'always' }], test: 'at-most', value: '3' }),
    'it has been is a number at most 3 since always was last true')
})

// ---- a reason -------------------------------------------------------------

test('a reason holds when every one of its conditions holds, and has no grouping', () => {
  const reason = [{ field: 'subject', test: 'is', value: 'chemistry' }, { field: 'reviewers', test: 'at-least', value: '2' }]
  assert.equal(evaluateReason(reason, { values: { subject: 'chemistry', reviewers: '3' } }), true)
  assert.equal(evaluateReason(reason, { values: { subject: 'chemistry', reviewers: '1' } }), false)
  assert.throws(() => validateReason([], generation), /would hold for everything/)
  assert.throws(() => validateReason('not a list', generation), /a list of conditions/)
})

test('a reason says itself back in the words it was written in', () => {
  assert.equal(describeReason([{ term: 'state', test: 'is-not', is: 'done' },
    { term: 'siblings', scope: 'earlier', quantifier: 'every', is: 'done' }]),
  'this child is not done and of the children before this one, all of them are done')
})

/* ---- the five operators, written in the language --------------------------
 * Nothing under test knows any of these names. Each is an ordinary reason a
 * person could type, and the module would be unchanged if all five were
 * deleted.
 */
const PARALLEL = [{ term: 'always' }]
const RACE = [{ term: 'reason', holds: true }, { term: 'siblings', scope: 'all', quantifier: 'none', is: 'active' }]
const SEQUENCE = [{ term: 'state', test: 'is-not', is: 'done' }, { term: 'siblings', scope: 'earlier', quantifier: 'every', is: 'done' }]
const STATE_GATED = [{ field: 'gate', test: 'is', value: 'open' }]
const STATE_GATED_RESET = [{ field: 'gate', test: 'is-not', value: 'open' }]
/* Written to the sentence it comes from, in lb-event-gated-template: "when its
   event condition BECOMES true ... the template is ARMED for the next m trading
   days starting tomorrow". Starting tomorrow is the at-least; the window length
   is the at-most. This was a duration until it was written out against an event
   that stops holding, which no fixture here had done. */
const EVENT_GATED = [
  { term: 'ago', of: [{ field: 'event', test: 'is', value: 'yes' }], test: 'at-least', value: '1' },
  { term: 'ago', of: [{ field: 'event', test: 'is', value: 'yes' }], test: 'at-most', value: '3' },
]

const mayAct = (policy, children, facts = {}) =>
  children.map((child, index) => evaluateReason(policy, { siblings: children, index, ...child, ...facts }))

test('every child may act, always', () => {
  const children = [{ state: 'idle' }, { state: 'active' }, { state: 'done' }]
  assert.deepEqual(mayAct(PARALLEL, children), [true, true, true])
  validateReason(PARALLEL, runtime)
})

test('a child may act if its own reason holds and none of the others is active', () => {
  validateReason(RACE, runtime)
  const open = [{ state: 'idle', reason: true }, { state: 'idle', reason: true }, { state: 'idle', reason: false }]
  assert.deepEqual(mayAct(RACE, open), [true, true, false], 'slot order is the tiebreak, and the ladder supplies it')
  const claimed = [{ state: 'active', reason: true }, { state: 'idle', reason: true }, { state: 'idle', reason: true }]
  assert.deepEqual(mayAct(RACE, claimed), [true, false, false], 'once one is active the others are shut out')
})

test('a child may act if it is the earliest one that is not done', () => {
  validateReason(SEQUENCE, runtime)
  assert.deepEqual(mayAct(SEQUENCE, [{ state: 'idle' }, { state: 'idle' }, { state: 'idle' }]), [true, false, false])
  assert.deepEqual(mayAct(SEQUENCE, [{ state: 'done' }, { state: 'idle' }, { state: 'idle' }]), [false, true, false])
  assert.deepEqual(mayAct(SEQUENCE, [{ state: 'done' }, { state: 'active' }, { state: 'idle' }]), [false, true, false],
    'the earliest not-done child keeps its turn while it is working')
  assert.deepEqual(mayAct(SEQUENCE, [{ state: 'done' }, { state: 'done' }, { state: 'done' }]), [false, false, false])
})

test('children may act while the gate holds, and the reset fires when it stops', () => {
  validateReason(STATE_GATED, runtime)
  validateReason(STATE_GATED_RESET, runtime)
  const children = [{ state: 'active' }, { state: 'idle' }]
  assert.deepEqual(mayAct(STATE_GATED, children, { values: { gate: 'open' } }), [true, true])
  assert.deepEqual(mayAct(STATE_GATED, children, { values: { gate: 'shut' } }), [false, false])
  // The reset is a reason in the same language, which is why a container needs
  // a clause for it: not being allowed to act is not the same as being reset.
  assert.equal(evaluateReason(STATE_GATED_RESET, { values: { gate: 'shut' } }), true)
  assert.equal(evaluateReason(STATE_GATED_RESET, { values: { gate: 'open' } }), false)
})

test('children may act for a while after the event becomes true, and the event does not stay true', () => {
  validateReason(EVENT_GATED, runtime)
  /* THE FIXTURE IS THE TEST. Holding the event true on every step is what hid
     this: with the event still true the window never has to outlive it, and a
     duration and a last-seen answer identically. The event fires once here. */
  const last = new Map()
  const facts = (event, step) => ({
    values: { event },
    ago: (of, current) => {
      if (evaluateReason(of, current)) last.set('k', step)
      return last.has('k') ? step - last.get('k') : null
    },
  })
  const armed = ['no', 'yes', 'no', 'no', 'no', 'no']
    .map((event, step) => mayAct(EVENT_GATED, [{ state: 'idle' }], facts(event, step))[0])
  assert.deepEqual(armed, [false, false, true, true, true, false],
    'shut before the event, shut on the day it fires, armed for the three days after, shut again')
})

/* The second clause of each operator, in the same language. Written out here
   for the same reason the first clause was: it is the cheapest proof that the
   vocabulary is sufficient, and it is what found the missing term above. */
const ALL_DONE = [{ term: 'children', quantifier: 'every', is: 'done' }]
const ANY_DONE = [{ term: 'children', quantifier: 'any', is: 'done' }]

test('a container knows when it is done, which is what lets it nest', () => {
  validateReason(ALL_DONE, runtime)
  validateReason(ANY_DONE, runtime)
  const done = (reason, states) => evaluateReason(reason, { children: states.map(state => ({ state })) })
  // Parallel and sequence finish when everything they hold has finished.
  assert.equal(done(ALL_DONE, ['done', 'done']), true)
  assert.equal(done(ALL_DONE, ['done', 'active']), false)
  // A race finishes when the one child that claimed it finishes; the others
  // never left idle, so waiting for all of them would hang it forever.
  assert.equal(done(ANY_DONE, ['done', 'idle']), true)
  assert.equal(done(ALL_DONE, ['done', 'idle']), false, 'which is why a race cannot use the other rule')
})

test('a container reports done to its parent as an ordinary child state', () => {
  // The whole of nesting: the parent asks the same question of a container that
  // it asks of a leaf, and gets an answer in the same three words.
  const inner = evaluateReason(ALL_DONE, { children: [{ state: 'done' }, { state: 'done' }] })
  const outer = evaluateReason(ALL_DONE, { children: [{ state: inner ? 'done' : 'active' }, { state: 'done' }] })
  assert.equal(outer, true)
})

test('the language names no operator anywhere in itself', () => {
  // The acceptance gate for the defaults is that deleting all five leaves the
  // software working. That is only possible if none of them is named here.
  const named = JSON.stringify([CONDITION_TERMS, VALUE_TESTS, SIBLING_SCOPES, SIBLING_QUANTIFIERS, LIFECYCLE])
  for (const word of ['parallel', 'race', 'sequence', 'gated', 'gate', 'event']) {
    assert.equal(named.toLowerCase().includes(word), false, `${word} must not be a word this language knows`)
  }
})
