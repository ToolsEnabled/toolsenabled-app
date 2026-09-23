/* Policies reaching a real composition.
 *
 * The bridge from a compiled prompt to the lifecycle. The policies below are
 * ordinary bundle content written in the shared language; they are declared in
 * this file rather than shipped, because the defaults are a later step and the
 * point of this one is that the software needs none of them.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { webcrypto } from 'node:crypto'
import { compilePrompt } from '../../src/benchmark/prompts.mjs'
import { validateComposition as validateCompositionIr } from '../../src/benchmark/composition.mjs'
import { containerCount, lifecycleFromComposition, runComposition, runDepth } from '../../src/research-run.mjs'
import { describeTrace, runLifecycle, validatePolicy } from '../../src/research-lifecycle.mjs'
import { genericStarter, newExperimentDraft } from '../../src/benchmark/starters.mjs'
import { importSnippetLibrary } from '../../src/research-snippets.mjs'
import { exampleSnippetLibrary } from '../../src/research-examples.mjs'

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })

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

const atom = (id, extra = {}) => ({ id, version: '1', kind: 'atom', role: 'node', text: `the ${id} part`, parameters: {}, semantics: { kind: 'prompt' }, ...extra })
const template = (id, slots, semantics, extra = {}) => ({
  id, version: '1', kind: 'template', role: 'node', parameters: {},
  text: slots.map(name => `{{slot:${name}}}`).join('\n'),
  slots: Object.fromEntries(slots.map(name => [name, 'node'])), slotOrder: slots,
  semantics: { kind: 'prompt', ...semantics }, ...extra,
})
const step = (extra = {}) => ({ values: {}, reasons: {}, finished: {}, ...extra })

// ---- the bridge -----------------------------------------------------------

test('a policy rides in a bundle’s own semantics and changes nothing about a composition', async () => {
  const catalog = [atom('one'), atom('two'), template('holder', ['first', 'second'], { policy: PARALLEL })]
  const compiled = await compilePrompt(catalog, { use: 'holder', slots: { first: { use: 'one' }, second: { use: 'two' } } })
  // The composition representation is unchanged: the policy travels inside the
  // open semantics object every node already carries.
  validateCompositionIr(compiled.composition)
  const root = compiled.composition.nodes.find(node => node.path === 'root')
  assert.deepEqual(root.semantic.policy, PARALLEL)
  assert.equal(compiled.text, 'the one part\nthe two part', 'and the prompt is the prompt')
})

test('a bundle with no policy still composes; only running one needs it', async () => {
  const catalog = [atom('one'), template('holder', ['first'], {})]
  const compiled = await compilePrompt(catalog, { use: 'holder', slots: { first: { use: 'one' } } })
  assert.equal(compiled.text, 'the one part', 'composing a prompt never needed a policy and still does not')
  assert.throws(() => lifecycleFromComposition(compiled.composition), error => {
    assert.match(error.message, /The container at root uses holder/, 'the place and the bundle are both named')
    assert.match(error.message, /does not say which of its children may act/)
    assert.match(error.message, /Give holder a policy, or take what is inside it out/, 'and it says what to do')
    return true
  })
})

test('a container missing only one clause is refused by the clause it is missing', async () => {
  const catalog = [atom('one'), template('holder', ['first'], { policy: { mayAct: [{ term: 'always' }] } })]
  const compiled = await compilePrompt(catalog, { use: 'holder', slots: { first: { use: 'one' } } })
  assert.throws(() => lifecycleFromComposition(compiled.composition), /does not say when it is finished/)
})

test('an atom is a leaf, and a template holding nothing is a leaf too', async () => {
  const catalog = [atom('one'), { ...template('empty', [], {}), text: 'nothing inside' }, template('holder', ['first', 'second'], { policy: PARALLEL })]
  const compiled = await compilePrompt(catalog, { use: 'holder', slots: { first: { use: 'one' }, second: { use: 'empty' } } })
  const root = lifecycleFromComposition(compiled.composition)
  assert.deepEqual(root.children.map(child => child.path), ['root/first', 'root/second'])
  for (const child of root.children) assert.equal(child.children, undefined, 'neither holds anything, so neither needs a policy')
})

test('children are asked in the slot order the person declared', async () => {
  /* The tiebreak is the order already on the page: the compiler builds a node’s
     places from its bundle’s own declared slot order, and the bridge keeps it. */
  const catalog = [atom('one'), atom('two'), template('holder', ['second', 'first'], { policy: RACE })]
  const compiled = await compilePrompt(catalog, { use: 'holder', slots: { first: { use: 'one' }, second: { use: 'two' } } })
  const root = lifecycleFromComposition(compiled.composition)
  assert.deepEqual(root.children.map(child => child.path), ['root/second', 'root/first'])
  // And that order decides who claims an exclusive turn when both could.
  const run = runComposition(compiled.composition, [step({ reasons: { 'root/second': true, 'root/first': true } })])
  assert.deepEqual(run.trace[0].acted, ['root/second'])
})

test('a policy is content, so a parameter reaches into it', async () => {
  // The compiler already substitutes into semantics, so a gate a person wrote
  // can be set where the template is used rather than where it is defined.
  const gated = template('gate', ['inside'], {
    policy: { mayAct: [{ field: 'level', test: 'at-least', value: '{{threshold}}' }], done: ALL_DONE },
  }, { parameters: { threshold: '10' } })
  const catalog = [atom('one'), gated]
  const compiled = await compilePrompt(catalog, { use: 'gate', params: { threshold: '50' }, slots: { inside: { use: 'one' } } })
  const root = lifecycleFromComposition(compiled.composition)
  assert.equal(root.policy.mayAct[0].value, '50', 'the value used is the one supplied where it was placed')
  const run = runComposition(compiled.composition, [step({ values: { level: '20' } }), step({ values: { level: '60' } })])
  assert.deepEqual(run.trace.map(record => record.acted), [[], ['root/inside']])
})

// ---- their own material ---------------------------------------------------

test('their own nested composition runs, and its trace is the answer key for it', async () => {
  /* Their parallel template holding two strategies, built the way their donor
     prompt builds it. The policies are attached here rather than shipped: the
     structure, the wording and the slot order are all theirs. */
  const spec = newExperimentDraft(genericStarter(), { initializePopulation: true })
  spec.catalog = importSnippetLibrary(exampleSnippetLibrary(), spec.catalog)
  /* THE POLICIES HERE ARE THE TEST'S, NOT A READING OF THEIR MATERIAL. What
     governs their four strategy parts is an open decision in their own draft,
     so nothing here claims to answer it. Two different policies are used at
     the two levels only to show that different ones nest. */
  const policies = { 'lb-parallel-template': PARALLEL, 'lb-strategy-slot': SEQUENCE }
  const catalog = spec.catalog.map(bundle => (policies[bundle.id]
    ? { ...bundle, semantics: { ...(bundle.semantics || { kind: 'prompt' }), policy: policies[bundle.id] } }
    : bundle))

  // Their own structure, built the way their donor prompt builds it.
  const parts = ['reason-to-buy', 'buy-details', 'reason-to-sell', 'sell-details']
  const strategy = (number, name, ticker, tag) => ({
    use: 'lb-strategy-slot',
    params: { slot_number: number, strategy_name: name, ticker },
    slots: Object.fromEntries(parts.map(part => [part.replace(/-/g, '_'), { use: `lb-${tag}-${part}` }])),
  })
  const compiled = await compilePrompt(catalog, {
    use: 'lb-parallel-template',
    slots: { slot_1: strategy(1, 'A', 'SPY', 'a'), slot_2: strategy(2, 'B', 'AAPL', 'b') },
  })
  const root = lifecycleFromComposition(compiled.composition)
  assert.deepEqual(root.children.map(child => child.path), ['root/slot_1', 'root/slot_2'],
    'their own slot order, carried through')
  assert.deepEqual(root.children[0].children.map(child => child.path),
    parts.map(part => `root/slot_1/${part.replace(/-/g, '_')}`), 'and theirs inside that')
  assert.equal(runDepth(root), 3, 'their composition is three levels of running structure')
  assert.equal(containerCount(root), 3, 'the template and the two strategies inside it')

  const run = runComposition(compiled.composition, [
    step(),
    step({ finished: { 'root/slot_1/reason_to_buy': true, 'root/slot_2/reason_to_buy': true } }),
    step(),
  ])
  // Both strategies start together because the outer policy says always; inside
  // each, only the first part acts, because the inner policy says one at a time.
  assert.deepEqual(run.trace[0].acted,
    ['root/slot_1', 'root/slot_1/reason_to_buy', 'root/slot_2', 'root/slot_2/reason_to_buy'],
    'two policies, each governing its own level')
  assert.deepEqual(run.trace[2].acted, ['root/slot_1/buy_details', 'root/slot_2/buy_details'],
    'and each strategy advances on its own')
})

/* ---- the five operators, as library content ------------------------------
 *
 * Their five templates each carry a policy now. THE POINT OF THE GATE BELOW is
 * that this changed nothing about the software: the five are ordinary bundle
 * content, and deleting all five leaves every module working and every prompt
 * composing, with a container that used to have one refused BY NAME rather
 * than quietly run as any of them.
 *
 * Every policy exercised below is READ OFF THE SHIPPED BUNDLE rather than
 * spelled out again here, so no test can pass against a reason nobody ships.
 */
const theirLibrary = () => {
  const spec = newExperimentDraft(genericStarter(), { initializePopulation: true })
  return importSnippetLibrary(exampleSnippetLibrary(), spec.catalog)
}
const theirPolicy = (catalog, id) => {
  const bundle = catalog.find(entry => entry.id === id)
  assert.ok(bundle, id + ' is not in their library')
  assert.ok(bundle.semantics?.policy, id + ' carries no policy')
  return bundle.semantics.policy
}
/* A two-slot container carrying one of their reasons. Three of their five
   templates declare a single `inside` slot, and an order needs two children;
   the reason is still theirs, read from the bundle. */
const asTwoSlots = policy => template('pair', ['first', 'second'], { policy })

const FIVE = ['lb-parallel-template', 'lb-state-gated-template', 'lb-event-gated-template',
  'lb-race-template', 'lb-sequence-template']

test('all five of their templates carry a policy, and each is an ordinary reason', async () => {
  const catalog = theirLibrary()
  for (const id of FIVE) {
    const bundle = catalog.find(entry => entry.id === id)
    /* Validated down the path a run actually takes, which is AFTER the compiler
       has substituted parameters. A window written as {{window}} is not yet a
       number of units, and validation says so -- so checking the raw bundle
       here would assert something no run ever sees. */
    const compiled = await compilePrompt([atom('one'), ...catalog],
      { use: id, slots: Object.fromEntries(bundle.slotOrder.map(name => [name, { use: 'one' }])) })
    const root = lifecycleFromComposition(compiled.composition)
    validatePolicy(root.policy, { where: id })
    assert.ok(root.policy.mayAct.length && root.policy.done.length,
      id + ' says both which of its children may act and when it is finished')
  }
  assert.equal(FIVE.filter(id => theirPolicy(catalog, id).reset).length, 4,
    'the four that put things back say so, and parallel has nothing to put back')
  assert.equal(theirPolicy(catalog, 'lb-parallel-template').reset, undefined)
})

test('a window written where a template is used beats the one where it was defined', async () => {
  const catalog = theirLibrary()
  const compiled = await compilePrompt([atom('one'), ...catalog],
    { use: 'lb-event-gated-template', params: { window: '1', window_over: '2' }, slots: { inside: { use: 'one' } } })
  const run = runComposition(compiled.composition,
    ['false', 'true', 'false', 'false'].map(event => step({ values: { event } })))
  assert.deepEqual(run.trace.map(record => record.mayAct['root/inside']), [false, false, true, false],
    'one armed bar, not the three the bundle was written with')
})

test('the event window outlives the event that opened it', async () => {
  /* Their sentence: armed "for the next m trading days starting tomorrow",
     while the event is true on one bar only. Written as a duration this shuts
     on the bar after it opened, which is what writing the operator out found. */
  const catalog = [atom('one'), ...theirLibrary()]
  const compiled = await compilePrompt(catalog, { use: 'lb-event-gated-template', slots: { inside: { use: 'one' } } })
  const run = runComposition(compiled.composition,
    ['false', 'true', 'false', 'false', 'false', 'false', 'false'].map(event => step({ values: { event } })))
  assert.deepEqual(run.trace.map(record => record.mayAct['root/inside']),
    [false, false, true, true, true, false, false],
    'shut before the event, shut on the bar it fires, armed for the three bars after, shut again')
  assert.deepEqual(run.trace.map(record => record.acted), [[], [], ['root/inside'], [], [], [], []])
  assert.deepEqual(run.trace[5].reset, [{ path: 'root', put: ['root/inside'] }],
    'and when the window expires, what is inside is put back')
})

test('a later edge while armed restarts the window', async () => {
  const catalog = [atom('one'), ...theirLibrary()]
  const compiled = await compilePrompt(catalog, { use: 'lb-event-gated-template', slots: { inside: { use: 'one' } } })
  const run = runComposition(compiled.composition,
    ['true', 'false', 'true', 'false', 'false', 'false', 'false'].map(event => step({ values: { event } })))
  assert.deepEqual(run.trace.map(record => record.mayAct['root/inside']),
    [false, true, false, true, true, true, false],
    'the second edge starts counting again rather than letting the first window run out')
})

test('the gate shuts and everything inside goes back, nesting included', async () => {
  const catalog = [atom('one'), atom('two'), ...theirLibrary()]
  const compiled = await compilePrompt(catalog, {
    use: 'lb-state-gated-template',
    slots: { inside: { use: 'lb-parallel-template', slots: { slot_1: { use: 'one' }, slot_2: { use: 'two' } } } },
  })
  const run = runComposition(compiled.composition, [
    step({ values: { gate: 'true' } }),
    step({ values: { gate: 'true' } }),
    step({ values: { gate: 'false' } }),
  ])
  assert.deepEqual(run.trace[0].acted, ['root/inside', 'root/inside/slot_1', 'root/inside/slot_2'])
  assert.deepEqual(run.trace[2].reset,
    [{ path: 'root', put: ['root/inside', 'root/inside/slot_1', 'root/inside/slot_2'] }],
    'the nested template and what it holds, not only the child of the gate')
  assert.deepEqual(Object.values(run.trace[2].states).filter(state => state !== 'idle'), ['active'],
    'only the gate itself is left standing')
})

test('the first slot whose reason holds claims the race, and the race re-opens after', async () => {
  const catalog = [atom('one'), atom('two'), asTwoSlots(theirPolicy(theirLibrary(), 'lb-race-template'))]
  const compiled = await compilePrompt(catalog, { use: 'pair', slots: { first: { use: 'one' }, second: { use: 'two' } } })
  const both = { 'root/first': true, 'root/second': true }
  const run = runComposition(compiled.composition, [
    step({ reasons: both }),
    step({ reasons: both, finished: { 'root/first': true } }),
    step({ reasons: both }),
  ])
  assert.deepEqual(run.trace[0].acted, ['root/first'], 'slot order is the tiebreak, and only one claims it')
  assert.equal(run.trace[0].mayAct['root/second'], false, 'the other is shut out while ownership lasts')
  assert.deepEqual(run.trace[2].reset, [{ path: 'root', put: ['root/first', 'root/second'] }],
    'the owner closing re-opens the race on the bar after')
  assert.deepEqual(run.trace[2].acted, ['root/first'], 'and it is raced again from the top')
})

test('one slot at a time, and eligibility returns to slot 1 after the last', async () => {
  const catalog = [atom('one'), atom('two'), asTwoSlots(theirPolicy(theirLibrary(), 'lb-sequence-template'))]
  const compiled = await compilePrompt(catalog, { use: 'pair', slots: { first: { use: 'one' }, second: { use: 'two' } } })
  const run = runComposition(compiled.composition, [
    step({ finished: { 'root/first': true } }),
    step({ finished: { 'root/second': true } }),
    step(),
  ])
  assert.deepEqual(run.trace[0].acted, ['root/first'], 'slot 1 begins, because all of no earlier slots are done')
  assert.deepEqual(run.trace[1].acted, ['root/second'], 'and the turn passes only after a full round trip')
  assert.deepEqual(run.trace[2].reset, [{ path: 'root', put: ['root/first', 'root/second'] }])
  assert.deepEqual(run.trace[2].acted, ['root/first'], 'eligibility returns to slot 1')
})

test('the same input twice is the same trace, clocks included', () => {
  /* The determinism check the lane already had covers a race, which carries no
     history between steps. The two clocks DO carry history, so they are the one
     place a second run could inherit something from the first. Both are built
     inside runLifecycle, and this is what says so by calling it twice. */
  const catalog = theirLibrary()
  const policy = theirPolicy(catalog, 'lb-event-gated-template')
  const root = {
    path: 'root',
    policy: JSON.parse(JSON.stringify(policy).replace(/{{window_over}}/g, '4').replace(/{{window}}/g, '3').replace(/{{event_fires}}/g, 'true')),
    children: [{ path: 'root/inside' }],
  }
  const steps = ['false', 'true', 'false', 'false', 'false', 'false']
    .map(event => ({ values: { event } }))
  const once = runLifecycle(root, steps)
  const twice = runLifecycle(root, steps)
  assert.deepEqual(once.trace, twice.trace, 'the answer key does not change between runs')
  assert.deepEqual(once.states, twice.states)
  assert.deepEqual(describeTrace(once.trace), describeTrace(twice.trace))
  // And it is a trace that actually exercised the clock, not an empty one.
  assert.deepEqual(once.trace.map(record => record.mayAct['root/inside']),
    [false, false, true, true, true, false])
})

// ---- the deletion gate ----------------------------------------------------

test('deleting every operator leaves the software working and refuses by name', async () => {
  /* THE ACCEPTANCE GATE FOR SHIPPING THE FIVE. Strip the policy off every
     bundle their library ships and nothing in any module is missing: prompts
     still compose, their wording survives, and a container that had one is
     refused by the bundle to edit rather than falling back to any of the five.
     A built-in default would show up here as a run that still worked. */
  const stripped = theirLibrary().map(bundle => (bundle.semantics?.policy
    ? { ...bundle, semantics: Object.fromEntries(Object.entries(bundle.semantics).filter(([key]) => key !== 'policy')) }
    : bundle))
  assert.equal(stripped.some(bundle => bundle.semantics?.policy), false, 'every operator is gone')

  const compiled = await compilePrompt([atom('one'), ...stripped],
    { use: 'lb-race-template', slots: { inside: { use: 'one' } } })
  const theirWording = stripped.find(bundle => bundle.id === 'lb-race-template').text.split('{{')[0].trim()
  assert.ok(theirWording && compiled.text.includes(theirWording),
    'their prompt still composes with no operator anywhere')

  assert.throws(() => lifecycleFromComposition(compiled.composition), error => {
    assert.match(error.message, /The container at root uses lb-race-template/)
    assert.match(error.message, /does not say which of its children may act/)
    return true
  }, 'refused by name, not run as parallel')

  /* And the same composition with their operator put back does run, so the
     refusal above is the missing content and not a broken module. */
  const whole = await compilePrompt([atom('one'), ...theirLibrary()],
    { use: 'lb-race-template', slots: { inside: { use: 'one' } } })
  assert.equal(runComposition(whole.composition, [step({ reasons: { 'root/inside': true } })]).trace[0].acted.length, 1)
})

test('their templates compose whether or not they carry a policy', async () => {
  const spec = newExperimentDraft(genericStarter(), { initializePopulation: true })
  spec.catalog = importSnippetLibrary(exampleSnippetLibrary(), spec.catalog)
  const parts = ['reason-to-buy', 'buy-details', 'reason-to-sell', 'sell-details']
  const strategy = (number, name, ticker, tag) => ({
    use: 'lb-strategy-slot',
    params: { slot_number: number, strategy_name: name, ticker },
    slots: Object.fromEntries(parts.map(part => [part.replace(/-/g, '_'), { use: `lb-${tag}-${part}` }])),
  })
  const compiled = await compilePrompt(spec.catalog, {
    use: 'lb-parallel-template',
    slots: { slot_1: strategy(1, 'A', 'SPY', 'a'), slot_2: strategy(2, 'B', 'AAPL', 'b') },
  })
  // Read from their own library rather than spelled out here, so this cannot
  // drift from what they actually wrote.
  const theirs = spec.catalog.find(bundle => bundle.id === 'lb-parallel-template').text.split('{{')[0].trim()
  assert.ok(theirs && compiled.text.includes(theirs), 'their wording survives composition unchanged')
})
