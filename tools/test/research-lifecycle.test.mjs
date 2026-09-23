/* The lifecycle machine, driven by policies written in the shared language.
 *
 * The operators below are ordinary content, declared here the way a person
 * would write them. Nothing in the module under test knows their names, and the
 * last test in this file deletes all five and shows the machine still runs.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { describeTrace, runLifecycle, validateComposition, validatePolicy } from '../../src/research-lifecycle.mjs'

// ---- the five, in the language --------------------------------------------
const ALL_DONE = [{ term: 'children', quantifier: 'every', is: 'done' }]
const ANY_DONE = [{ term: 'children', quantifier: 'any', is: 'done' }]

const PARALLEL = { mayAct: [{ term: 'always' }], done: ALL_DONE }
const RACE = {
  mayAct: [{ term: 'reason', holds: true }, { term: 'siblings', scope: 'all', quantifier: 'none', is: 'active' }],
  done: ANY_DONE,
}
const SEQUENCE = {
  mayAct: [{ term: 'state', test: 'is-not', is: 'done' }, { term: 'siblings', scope: 'earlier', quantifier: 'every', is: 'done' }],
  done: ALL_DONE,
}
const STATE_GATED = {
  mayAct: [{ field: 'gate', test: 'is', value: 'open' }],
  done: ALL_DONE,
  reset: [{ field: 'gate', test: 'is-not', value: 'open' }],
}
const EVENT_GATED = {
  mayAct: [{ term: 'since', of: [{ field: 'event', test: 'is', value: 'yes' }], test: 'at-most', value: '2' }],
  done: ALL_DONE,
  reset: [{ term: 'since', of: [{ field: 'event', test: 'is', value: 'yes' }], test: 'at-least', value: '3' }],
}

const leaves = (...names) => names.map(path => ({ path }))
const holder = (policy, children, path = 'root') => ({ path, policy, children })
const step = (extra = {}) => ({ values: {}, reasons: {}, finished: {}, ...extra })

// ---- the machine ----------------------------------------------------------

test('a container with no policy is refused by its own path, not treated as one', () => {
  /* A silent default is how a fixed operator set creeps back in: if a container
     with nothing written on it behaved like one of the five, that one would be
     built in and deleting it would not be possible. */
  assert.throws(() => validateComposition({ path: 'root', children: leaves('a') }),
    /The container at root: choose a policy/)
  assert.throws(() => validatePolicy({ mayAct: [{ term: 'always' }] }, { where: 'The container at root' }),
    /does not say when it is finished/, 'a container that cannot report done cannot nest')
  assert.throws(() => validatePolicy({ done: ALL_DONE }, { where: 'The container at root' }),
    /does not say which of its children may act/)
})

test('a policy may only read what is readable while the work is running', () => {
  // The moment rule from the condition core, reaching a container's policy.
  validatePolicy(PARALLEL)
  assert.throws(() => validatePolicy({ mayAct: [{ term: 'always' }], done: [{ field: 'x', test: 'is', value: '1' }] },
    { where: 'The container at root', fields: new Set(['y']) }), /x is not one of your fields/)
})

test('the same run twice is the same trace', () => {
  const steps = [step({ reasons: { a: true, b: true } }), step({ reasons: { a: true, b: true }, finished: { a: true } })]
  const once = runLifecycle(holder(RACE, leaves('a', 'b')), steps)
  const twice = runLifecycle(holder(RACE, leaves('a', 'b')), steps)
  assert.deepEqual(once.trace, twice.trace)
  assert.deepEqual(once.states, twice.states)
})

// ---- the operators, run ---------------------------------------------------

test('every child may act, always', () => {
  const run = runLifecycle(holder(PARALLEL, leaves('a', 'b', 'c')), [step()])
  assert.deepEqual(run.trace[0].acted, ['a', 'b', 'c'])
  assert.equal(run.states.root, 'active', 'the composition itself is running; nothing grants it a turn')
})

test('a race gives the step to one child even when two could claim it', () => {
  /* THE ONE THAT MATTERS. Both children's reasons hold on the same step. The
     children are asked in slot order and each answer is applied before the next
     child is asked, so the second sees a sibling already active. Asked against
     one frozen picture, both would claim the same exclusive turn. */
  const run = runLifecycle(holder(RACE, leaves('a', 'b')), [step({ reasons: { a: true, b: true } })])
  assert.deepEqual(run.trace[0].acted, ['a'], 'slot order is the tiebreak')
  assert.equal(run.trace[0].mayAct.b, false, 'and the loser is told why: a sibling is already active')
  assert.deepEqual(run.states, { root: 'active', a: 'active', b: 'idle' })
})

test('a race stays claimed until its winner finishes, then the container is done', () => {
  const run = runLifecycle(holder(RACE, leaves('a', 'b')), [
    step({ reasons: { a: true, b: true } }),
    step({ reasons: { a: false, b: true } }),
    step({ reasons: { a: false, b: true }, finished: { a: true } }),
  ])
  assert.deepEqual(run.trace[1].acted, [], 'b is still shut out while a is active')
  assert.deepEqual(run.trace[2].finished, ['a', 'root'],
    'the winner finishing finishes the race that held it, in the same step')
  assert.equal(run.states.b, 'idle', 'the child that never claimed it never started')
})

test('a sequence advances one child per step and never runs two at once', () => {
  const run = runLifecycle(holder(SEQUENCE, leaves('a', 'b', 'c')), [
    step(),
    step({ finished: { a: true } }),
    step(),
    step({ finished: { b: true } }),
    step(),
  ])
  assert.deepEqual(run.trace.map(record => record.acted), [['a'], [], ['b'], [], ['c']])
  /* Acting before finishing is what keeps a step a step: a child that finishes
     on one step hands over on the next, rather than the whole sequence running
     inside a single moment. */
  assert.deepEqual(run.trace[1].finished, ['a'])
  assert.equal(run.states.c, 'active')
})

test('a gate lets its children act while it holds and puts them back when it stops', () => {
  const run = runLifecycle(holder(STATE_GATED, leaves('a', 'b')), [
    step({ values: { gate: 'open' } }),
    step({ values: { gate: 'shut' } }),
    step({ values: { gate: 'open' } }),
  ])
  assert.deepEqual(run.trace[0].acted, ['a', 'b'])
  assert.deepEqual(run.trace[1].reset[0].put, ['a', 'b'], 'the gate closing puts back what it holds')
  assert.deepEqual(run.trace[1].states, { root: 'active', a: 'idle', b: 'idle' },
    'what the gate holds goes back; the gate itself is still running')
  assert.deepEqual(run.trace[2].acted, ['a', 'b'], 'and they start again when it reopens')
})

test('a reset reaches everything inside, including what a nested container holds', () => {
  // A gate closing over a container does not stop at that container's edge.
  const inner = holder(PARALLEL, leaves('x', 'y'), 'inner')
  const run = runLifecycle(holder(STATE_GATED, [inner], 'root'), [
    step({ values: { gate: 'open' } }),
    step({ values: { gate: 'shut' } }),
  ])
  assert.deepEqual(run.trace[0].acted, ['inner', 'x', 'y'])
  assert.deepEqual(run.trace[1].reset[0].put, ['inner', 'x', 'y'])
  assert.deepEqual(run.trace[1].states, { root: 'active', inner: 'idle', x: 'idle', y: 'idle' })
})

test('an event gate opens the step the event arrives and closes when the window runs out', () => {
  const run = runLifecycle(holder(EVENT_GATED, leaves('a')), [
    step({ values: { event: 'no' } }),
    step({ values: { event: 'yes' } }),
    step({ values: { event: 'yes' } }),
    step({ values: { event: 'yes' } }),
    step({ values: { event: 'yes' } }),
  ])
  assert.deepEqual(run.trace.map(record => record.mayAct.a), [false, true, true, true, false],
    'true today and false yesterday opens it; three steps later the window is out')
  assert.deepEqual(run.trace[1].acted, ['a'])
  assert.deepEqual(run.trace[4].reset[0].put, ['a'], 'and the window running out puts it back')
})

test('an event gate re-arms when the event goes away and comes back', () => {
  const run = runLifecycle(holder(EVENT_GATED, leaves('a')), [
    step({ values: { event: 'yes' } }),
    step({ values: { event: 'no' } }),
    step({ values: { event: 'yes' } }),
  ])
  assert.deepEqual(run.trace.map(record => record.mayAct.a), [true, false, true],
    'the count starts again, so the window is not spent by a run that ended')
})

// ---- nesting --------------------------------------------------------------

test('a container reports done to its parent as an ordinary child state', () => {
  /* The whole of nesting: the outer policy asks the same question of the inner
     container that it asks of a leaf, and the inner one answers in the same
     three words. This is what a missing completion clause would have broken. */
  const inner = holder(SEQUENCE, leaves('x', 'y'), 'inner')
  const root = holder(SEQUENCE, [inner, { path: 'after' }], 'root')
  const run = runLifecycle(root, [
    step(),
    step({ finished: { x: true } }),
    step(),
    step({ finished: { y: true } }),
    step(),
  ])
  assert.deepEqual(run.trace[0].acted, ['inner', 'x'], 'starting a container starts what it holds')
  assert.equal(run.trace[3].states.inner, 'done', 'its last child finishing finishes it')
  assert.deepEqual(run.trace[4].acted, ['after'], 'and only then does the child after it get its turn')
})

test('a child of a container that is not acting does not act', () => {
  const inner = holder(PARALLEL, leaves('x'), 'inner')
  const run = runLifecycle(holder(STATE_GATED, [inner], 'root'), [step({ values: { gate: 'shut' } })])
  assert.deepEqual(run.trace[0].acted, [])
  assert.equal(run.trace[0].mayAct.x, undefined, 'it was never even asked')
})

// ---- the trace is the answer key ------------------------------------------

test('the trace says what the correct behaviour was, not only that it happened', () => {
  const run = runLifecycle(holder(SEQUENCE, leaves('a', 'b')), [step(), step({ finished: { a: true } }), step()])
  assert.equal(describeTrace(run.trace),
    ['step 1: acted a', 'step 2: nothing acted; finished a', 'step 3: acted b'].join('\n'))
  // And every step carries the verdict for every child it asked, so a
  // disagreement can be traced to the rung that produced it.
  assert.deepEqual(run.trace[0].mayAct, { a: true, b: false })
  assert.deepEqual(run.trace[2].mayAct, { a: false, b: true })
  assert.deepEqual(run.trace[2].states, { root: 'active', a: 'done', b: 'active' })
})

test('a composition reports itself finished once everything it holds has', () => {
  const run = runLifecycle(holder(PARALLEL, leaves('a', 'b')), [
    step(),
    step({ finished: { a: true } }),
    step({ finished: { b: true } }),
  ])
  assert.equal(run.trace[1].states.root, 'active', 'one of the two is still going')
  assert.deepEqual(run.trace[2].finished, ['b', 'root'], 'the innermost finishes first, then what held it')
  assert.equal(run.states.root, 'done')
})

test('a node may carry its own reason instead of being told one', () => {
  const own = { path: 'a', reason: [{ field: 'want', test: 'is', value: 'yes' }] }
  const run = runLifecycle(holder(RACE, [own, { path: 'b' }]), [
    step({ values: { want: 'no' }, reasons: { b: false } }),
    step({ values: { want: 'yes' }, reasons: { b: false } }),
  ])
  assert.deepEqual(run.trace.map(record => record.acted), [[], ['a']])
})

test('a node whose own reason asks about itself is refused by name rather than looping', () => {
  const loop = { path: 'a', reason: [{ term: 'reason', holds: true }] }
  assert.throws(() => runLifecycle(holder(RACE, [loop, { path: 'b' }]), [step()]),
    /a, its own reason.*own reason/s)
})

// ---- the deletion gate ----------------------------------------------------

test('delete all five and the machine still runs, with nothing to run them with', () => {
  /* The acceptance gate for the defaults, proved at the layer that would have
     to cheat for it to fail. Nothing above is known to the module: a
     composition whose policies have all been deleted refuses because there is
     no policy, not because a particular operator is missing. */
  assert.throws(() => runLifecycle({ path: 'root', children: leaves('a', 'b') }, [step()]),
    /The container at root: choose a policy saying which of its children may act. A container with no policy cannot be asked./)
  // A person's own sixth operator, owing nothing to any of the five, runs.
  const backwards = {
    mayAct: [{ term: 'state', test: 'is-not', is: 'done' }, { term: 'siblings', scope: 'later', quantifier: 'every', is: 'done' }],
    done: ALL_DONE,
  }
  const run = runLifecycle(holder(backwards, leaves('a', 'b', 'c')), [step(), step({ finished: { c: true } }), step()])
  assert.deepEqual(run.trace.map(record => record.acted), [['c'], [], ['b']],
    'a sequence running backwards is none of the five, and the machine had no opinion about it')
})

test('no renderer module carries a control byte in its source', () => {
  /* A stray NUL reads as ordinary source to the language, the suites and every
     checker, and only turns up at delivery, where it makes the file diff as
     binary and its patch impossible to apply or reverse. It has happened twice
     in this lane. Write such a byte as an escape; this is the guard that says
     so before it leaves. */
  const dir = new URL('../../src/', import.meta.url)
  const offenders = readdirSync(dir)
    .filter(name => name.endsWith('.js') || name.endsWith('.mjs'))
    .filter(name => readFileSync(new URL(name, dir), 'latin1').includes('\u0000'))
  assert.deepEqual(offenders, [], 'these hold a literal control byte and must use an escape instead')
})
