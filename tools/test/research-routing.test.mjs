import test from 'node:test'
import assert from 'node:assert/strict'
import { compilePrompt } from '../../src/benchmark/prompts.mjs'
import { exampleSnippetLibrary } from '../../src/research-examples.mjs'
import { ROUTING_TESTS, compositionDepth, createRoutingDraft, decisionDepth, describeRoute, expandComposition, routeRow, routedTasks, routingPreview, validateRouting } from '../../src/research-routing.mjs'

const catalog = exampleSnippetLibrary().catalog

/* PROMPT B. Three levels of composition-inside-composition, built out of the
   owner's own LeanBench material: their strategy slot inside their STATE-GATED
   template inside their donor task. Every name here is typed by the person; the parts
   underneath are their snippets. Nothing is a slot name, a category or a
   condition the software chose. */
const strategyA = {
  use: 'lb-strategy-slot',
  params: { slot_number: 1, strategy_name: 'A', ticker: 'SPY' },
  slots: {
    reason_to_buy: { use: 'lb-a-reason-to-buy' }, buy_details: { use: 'lb-a-buy-details' },
    reason_to_sell: { use: 'lb-a-reason-to-sell' }, sell_details: { use: 'lb-a-sell-details' },
  },
}
const nested = () => ({
  version: 1,
  fields: ['subject', 'reviewers'],
  compositions: [
    { name: 'whole-task', node: { use: 'lb-t1v0-task', slots: {
      fixed_setup: { use: 'lb-fixed-setup' }, semantics_contract: { use: 'lb-semantics-contract' },
      strategy_system: { composition: 'gated-strategy' } } } },
    { name: 'gated-strategy', node: { use: 'lb-state-gated-template', slots: { inside: { composition: 'strategy-a' } } } },
    { name: 'strategy-a', node: structuredClone(strategyA) },
    { name: 'ref-impl', node: { use: 'lb-ref-impl-prompt-v2' } },
  ],
  rules: [],
  otherwise: { composition: 'ref-impl' },
  rows: [{ id: 'row-1', values: {} }],
})

test('a composition holds another composition, which holds another, to any depth', () => {
  const draft = nested()
  assert.equal(compositionDepth('whole-task', draft), 4, 'three named compositions deep, plus the snippets they bottom out in')
  assert.equal(compositionDepth('strategy-a', draft), 2)
  assert.equal(compositionDepth('ref-impl', draft), 1)
  const expanded = expandComposition('whole-task', draft)
  assert.equal(expanded.use, 'lb-t1v0-task')
  assert.equal(expanded.slots.strategy_system.use, 'lb-state-gated-template', 'a composition reference resolves to the tree it names')
  assert.equal(expanded.slots.strategy_system.slots.inside.use, 'lb-strategy-slot')
  assert.equal(expanded.slots.strategy_system.slots.inside.slots.sell_details.use, 'lb-a-sell-details')
  assert.deepEqual(expanded.slots.strategy_system.slots.inside.params, { slot_number: 1, strategy_name: 'A', ticker: 'SPY' },
    'local values survive expansion')
})

test('a composition nested three deep compiles into one real prompt', async () => {
  const compiled = await compilePrompt(catalog, expandComposition('whole-task', nested()))
  assert.ok(compiled.text.includes('Write a complete QuantConnect LEAN algorithm'), 'the outer composition contributed its own wording')
  assert.ok(compiled.text.includes('STATE-GATED template'), 'the composition one level down contributed its wording')
  assert.ok(compiled.text.includes('SPY’s close crosses above its 100-day simple moving average.')
    || compiled.text.includes("SPY's close crosses above its 100-day simple moving average."), 'and the atoms at the bottom are there')
  // compilePrompt counts edges from the root, so three nestings below the root
  // report as depth 3 over four levels of nodes.
  assert.equal(compiled.depth, 3, 'three compositions nested inside one another compile as three levels below the root')
  assert.equal(compiled.nodeCount, 9)
})

test('the same composition may be used twice without being called a loop', () => {
  const draft = nested()
  draft.compositions.push({ name: 'twice', node: { use: 'lb-parallel-template', slots: { slot_1: { composition: 'ref-impl' }, slot_2: { composition: 'ref-impl' } } } })
  assert.equal(compositionDepth('twice', draft), 2)
})

test('a composition that contains itself is refused by the names that form the loop', () => {
  const draft = nested()
  draft.compositions.push({ name: 'ouroboros', node: { use: 'lb-race-template', slots: { inside: { composition: 'ouroboros' } } } })
  assert.throws(() => validateRouting(draft, { catalog }), error => {
    assert.match(error.message, /ouroboros/)
    assert.match(error.message, /contain each other/)
    return true
  })
})

test('routing chooses among compositions on the person’s own fields, first match first', () => {
  const draft = nested()
  draft.rules = [
    { tests: [{ field: 'subject', test: 'is', value: 'geology' }], composition: 'ref-impl' },
    { tests: [{ field: 'reviewers', test: 'at-least', value: '2' }, { field: 'subject', test: 'contains', value: 'chem' }], composition: 'whole-task' },
  ]
  const decided = values => { const answer = routeRow(draft, values); return { composition: answer.composition, rule: answer.rule } }
  assert.deepEqual(decided({ subject: 'geology', reviewers: '9' }), { composition: 'ref-impl', rule: 1 })
  assert.deepEqual(decided({ subject: 'chemistry', reviewers: '2' }), { composition: 'whole-task', rule: 2 })
  assert.deepEqual(decided({ subject: 'chemistry', reviewers: '1' }), { composition: 'ref-impl', rule: null }, 'no rule matches, so the declared fallback answers')
})

test('a row that matches nothing with no fallback refuses by name instead of choosing quietly', () => {
  const draft = nested()
  draft.otherwise = null
  draft.rules = [{ tests: [{ field: 'subject', test: 'is', value: 'geology' }], then: { composition: 'ref-impl' } }]
  assert.throws(() => routeRow(draft, { subject: 'chemistry' }, { label: 'Row row-9' }), error => {
    assert.match(error.message, /row-9/)
    assert.match(error.message, /nothing is chosen there for when none do/)
    return true
  })
})

test('a numeric comparison against something that is not a number says so', () => {
  const draft = nested()
  draft.rules = [{ tests: [{ field: 'reviewers', test: 'at-least', value: '2' }], composition: 'ref-impl' }]
  assert.throws(() => routeRow(draft, { reviewers: 'several' }), /several, which is not a number/)
  assert.throws(() => routeRow(draft, { reviewers: '' }), /empty, which is not a number/)
  assert.equal(routeRow(draft, { reviewers: '2' }).composition, 'ref-impl')
})

test('generated tasks are ordinary tasks carrying the person’s own fields as variables', async () => {
  const draft = nested()
  draft.rules = [{ tests: [{ field: 'subject', test: 'one-of', value: 'chemistry\ngeology' }], composition: 'whole-task' }]
  draft.rows = [
    { id: 'chem-1', values: { subject: 'chemistry', reviewers: '2' } },
    { id: 'other-1', values: { subject: 'linguistics', reviewers: '1' } },
  ]
  const tasks = routedTasks(draft, { catalog })
  assert.deepEqual(tasks.map(task => task.id), ['chem-1', 'other-1'])
  assert.deepEqual(tasks[0].variables, { subject: 'chemistry', reviewers: '2' }, 'the words routed on are the words the prompt can quote')
  assert.equal(tasks[0].root.slots.strategy_system.slots.inside.use, 'lb-strategy-slot')
  assert.equal(tasks[1].root.use, 'lb-ref-impl-prompt-v2', 'the fallback composition answered the second row')
  assert.equal(tasks[0].split, 'development')
  // The generated root is a plain reference tree the ordinary compiler accepts.
  assert.ok((await compilePrompt(catalog, tasks[0].root, { variables: tasks[0].variables })).text.length > 0)
})

test('a routing draft refuses a rule with no test rather than silently matching everything', () => {
  const draft = nested()
  draft.rules = [{ tests: [], composition: 'ref-impl' }]
  assert.throws(() => validateRouting(draft, { catalog }), /would match every row/)
})

test('routing names an unusable field, composition, identifier or snippet instead of guessing', () => {
  const base = nested()
  assert.throws(() => validateRouting({ ...base, rules: [{ tests: [{ field: 'budget', test: 'is', value: 'x' }], composition: 'ref-impl' }] }, { catalog }), /budget is not one of your fields/)
  assert.throws(() => validateRouting({ ...base, rules: [{ tests: [{ field: 'subject', test: 'is', value: 'x' }], composition: 'absent' }] }, { catalog }), /absent is not one/)
  assert.throws(() => validateRouting({ ...base, otherwise: { composition: 'absent' } }, { catalog }), /absent is not one/)
  assert.throws(() => validateRouting({ ...base, rows: [{ id: 'Row One', values: {} }] }, { catalog }), /lowercase identifier/)
  assert.throws(() => validateRouting({ ...base, compositions: [...base.compositions, { name: 'typo', node: { use: 'not-in-this-draft' } }] }, { catalog }), /no snippet with the identifier not-in-this-draft/)
  assert.throws(() => validateRouting({ ...base, compositions: [...base.compositions, { name: 'ref-impl', node: { use: 'example-unstated' } }] }, { catalog }), /both named ref-impl/)
})

// The software supplies comparisons. It supplies no field, no value, no
// category and no composition name: a new draft starts with none of them.
test('a new routing draft supplies no field, rule or category of its own', () => {
  const draft = createRoutingDraft({ id: 'my-first-task', root: { use: 'lb-ref-impl-prompt-v2' } })
  assert.deepEqual(draft.fields, [], 'the person names their own fields')
  assert.deepEqual(draft.rules, [], 'the person writes their own rules')
  assert.deepEqual(draft.compositions.map(item => item.name), ['my-first-task'], 'the only name present is the one the person already gave their task')
  assert.deepEqual(draft.otherwise, { composition: 'my-first-task' }, 'the fallback is an outcome, so it can name a set of rules instead')
  assert.deepEqual(ROUTING_TESTS.map(item => item.id), ['is', 'is-not', 'contains', 'one-of', 'at-least', 'at-most', 'present', 'absent'],
    'every offered test compares two values and names no subject matter')
})

test('the preview reports each row’s decision, and reports a refusal as a refusal', () => {
  const draft = nested()
  draft.otherwise = null
  draft.rules = [{ tests: [{ field: 'subject', test: 'is', value: 'chemistry' }], then: { composition: 'whole-task' } }]
  draft.rows = [{ id: 'a', values: { subject: 'chemistry' } }, { id: 'b', values: { subject: 'geology' } }]
  const preview = routingPreview(draft, { catalog })
  assert.equal(preview[0].id, 'a')
  assert.equal(preview[0].composition, 'whole-task')
  assert.equal(preview[0].rule, 1)
  assert.equal(preview[0].depth, 4)
  assert.equal(preview[0].error, '')
  assert.equal(preview[0].route, 'rule 1', 'one level, so the route is the rung that answered')
  assert.equal(preview[1].composition, '')
  assert.match(preview[1].error, /matches none of the 1 rule/)
})

/* PROMPT B. THE COMPILER CARRIES NO ROLE NAMES, and a place may name a set of
   roles rather than choosing between one role and anything at all. Both of
   these exist because the owner's own material says "details" where the four
   names this product shipped said "process": a compiler that knows any role
   name knows one domain, and a slot that can only say "exactly this" or
   "anything" cannot express a template that holds a strategy or another
   template. */
test('the compiler exports no set of role names for a catalog to match', async () => {
  const compiler = await import('../../src/benchmark/prompts.mjs')
  assert.equal(compiler.ROLES, undefined, 'there is no list of roles in the compiler to conform to')
  for (const [name, value] of Object.entries(compiler)) {
    const words = Array.isArray(value) ? value : []
    assert.equal(words.some(word => /buy|sell|entry|exit/i.test(String(word))), false, `${name} carries no domain vocabulary`)
  }
})

test('roles are whatever a catalog declares: any names, any number', async () => {
  // A catalog in somebody else's words entirely, with three parts rather than
  // four, compiles exactly as the shipped example does.
  const catalog = [
    { id: 'opening', version: '1', kind: 'atom', role: 'ouverture', text: 'Open the piece.' },
    { id: 'middle', version: '1', kind: 'atom', role: 'développement', text: 'Develop it.' },
    { id: 'close', version: '1', kind: 'atom', role: '終わり', text: 'End it.' },
    { id: 'piece', version: '1', kind: 'template', role: 'node', text: '{{slot:a}} {{slot:b}} {{slot:c}}',
      slots: { a: 'ouverture', b: 'développement', c: '終わり' }, slotOrder: ['a', 'b', 'c'] },
  ]
  const compiled = await compilePrompt(catalog, { use: 'piece', slots: { a: { use: 'opening' }, b: { use: 'middle' }, c: { use: 'close' } } })
  assert.equal(compiled.text, 'Open the piece. Develop it. End it.')
  assert.equal(compiled.nodeCount, 4)
  await assert.rejects(compilePrompt(catalog, { use: 'piece', slots: { a: { use: 'close' }, b: { use: 'middle' }, c: { use: 'close' } } }),
    /has role 終わり, and this place accepts ouverture/, 'and a place still refuses what it does not accept, in the catalog’s own words')
})

test('a place can name a set of roles, so nesting does not have to mean anything goes', async () => {
  const catalog = [
    { id: 'leaf', version: '1', kind: 'atom', role: 'strategy', text: 'A leaf.' },
    { id: 'other', version: '1', kind: 'atom', role: 'unrelated', text: 'Not for this place.' },
    { id: 'gate', version: '1', kind: 'template', role: 'node', text: 'Gate: {{slot:inside}}', slots: { inside: ['strategy', 'node'] } },
  ]
  // A strategy fits, and so does another gate, because the place names both.
  assert.match((await compilePrompt(catalog, { use: 'gate', slots: { inside: { use: 'leaf' } } })).text, /Gate: A leaf\./)
  const nestedGate = await compilePrompt(catalog, { use: 'gate', slots: { inside: { use: 'gate', slots: { inside: { use: 'leaf' } } } } })
  assert.match(nestedGate.text, /Gate: Gate: A leaf\./)
  assert.equal(nestedGate.depth, 2)
  // And what the place does not name is still refused, which a wildcard could not do.
  await assert.rejects(compilePrompt(catalog, { use: 'gate', slots: { inside: { use: 'other' } } }),
    /has role unrelated, and this place accepts strategy or node/)
})

test('the owner’s own templates name what they accept rather than accepting anything', () => {
  const byId = new Map(catalog.map(bundle => [bundle.id, bundle]))
  for (const id of ['lb-state-gated-template', 'lb-event-gated-template', 'lb-race-template', 'lb-sequence-template']) {
    assert.deepEqual(byId.get(id).slots.inside, ['strategy', 'node'], `${id} takes a strategy or another template`)
  }
  assert.deepEqual(byId.get('lb-t1v0-task').slots.strategy_system, ['strategy', 'node'])
  const wildcards = catalog.flatMap(bundle => Object.values(bundle.slots || {})).flatMap(role => (Array.isArray(role) ? role : [role]))
  assert.equal(wildcards.includes('*'), false, 'nothing in their material has to fall back on accepting anything')
})

/* PROMPT C. THE DECISION LAYER NESTS, exactly as the content layer does. The
   owner asked for it in as many words: "i think they were supposed to nest
   right? i mean why not." */
const decisionDraft = () => ({
  version: 1,
  fields: ['situation', 'size'],
  compositions: [{ name: 'small', node: { use: 'lb-ref-impl-prompt-v1' } }, { name: 'big', node: { use: 'lb-ref-impl-prompt-v2' } }],
  decisions: [
    { name: 'how-big', rules: [{ tests: [{ field: 'size', test: 'is', value: 'large' }], then: { decision: 'how-urgent' } }], otherwise: { composition: 'small' } },
    { name: 'how-urgent', rules: [{ tests: [{ field: 'situation', test: 'is', value: 'urgent' }], then: { composition: 'big' } }], otherwise: { composition: 'small' } },
  ],
  rules: [{ tests: [{ field: 'situation', test: 'present' }], then: { decision: 'how-big' } }],
  otherwise: { composition: 'small' },
  rows: [{ id: 'row-1', values: { situation: 'urgent', size: 'large' } }],
})

test('a rung can choose another set of rules, and that set is asked the same way', () => {
  const draft = decisionDraft()
  validateRouting(draft, { catalog })
  const answer = routeRow(draft, { situation: 'urgent', size: 'large' })
  assert.equal(answer.composition, 'big')
  assert.deepEqual(answer.path.map(step => [step.decision, step.rule]), [['', 1], ['how-big', 1], ['how-urgent', 1]],
    'three levels, and every rung that answered is reported')
  assert.equal(describeRoute(answer.path), 'rule 1 → the rules named how-big: rule 1 → the rules named how-urgent: rule 1')
})

test('the fallback applies at every level, not only the outermost', () => {
  const draft = decisionDraft()
  const answer = routeRow(draft, { situation: 'calm', size: 'large' })
  assert.equal(answer.composition, 'small', 'the innermost set answered with its own fallback')
  assert.deepEqual(answer.path.map(step => step.rule), [1, 1, null])
  assert.match(describeRoute(answer.path), /how-urgent: otherwise$/)
})

test('a level with nothing to answer with refuses there, naming that level', () => {
  const draft = decisionDraft()
  draft.decisions[1].otherwise = null
  assert.throws(() => routeRow(draft, { situation: 'calm', size: 'large' }, { label: 'Row row-9' }), error => {
    assert.match(error.message, /row-9/)
    assert.match(error.message, /the rules named how-urgent/, 'the level that could not answer is named')
    assert.match(error.message, /nothing is chosen there for when none do/)
    return true
  })
})

test('depth is reported at every level and never limited', () => {
  const draft = decisionDraft()
  assert.equal(decisionDepth('', draft), 3, 'the outermost set plus the two below it')
  assert.equal(decisionDepth('how-big', draft), 2)
  assert.equal(decisionDepth('how-urgent', draft), 1)
  // Arbitrarily large is the owner's model, so a long chain is a number, not a refusal.
  let previous = 'how-urgent'
  for (let level = 0; level < 200; level += 1) {
    const name = `level-${level}`
    draft.decisions.push({ name, rules: [{ tests: [{ field: 'situation', test: 'present' }], then: { decision: previous } }], otherwise: { composition: 'small' } })
    previous = name
  }
  draft.rules[0].then = { decision: previous }
  validateRouting(draft, { catalog })
  assert.equal(decisionDepth('', draft), 202, 'two hundred levels deep is a reported number, not a ceiling')
  assert.equal(routeRow(draft, { situation: 'urgent', size: 'large' }).composition, 'big')
})

test('a loop between sets of rules is refused by the names that form it', () => {
  const draft = decisionDraft()
  draft.decisions[1].rules[0].then = { decision: 'how-big' }
  assert.throws(() => validateRouting(draft, { catalog }), error => {
    assert.match(error.message, /contain each other/)
    assert.match(error.message, /how-big/)
    assert.match(error.message, /how-urgent/)
    return true
  })
})

test('a rung pointing at a set that does not exist says so rather than guessing', () => {
  const draft = decisionDraft()
  draft.rules[0].then = { decision: 'never-made' }
  assert.throws(() => validateRouting(draft, { catalog }), /never-made is not one of your sets of rules/)
})

test('a draft written before rule sets existed still means what it said', () => {
  // The older shape named a composition directly on the rule and on otherwise.
  const draft = {
    version: 1, fields: ['situation'],
    compositions: [{ name: 'small', node: { use: 'lb-ref-impl-prompt-v1' } }, { name: 'big', node: { use: 'lb-ref-impl-prompt-v2' } }],
    rules: [{ tests: [{ field: 'situation', test: 'is', value: 'urgent' }], composition: 'big' }],
    otherwise: 'small',
    rows: [{ id: 'row-1', values: { situation: 'urgent' } }],
  }
  validateRouting(draft, { catalog })
  assert.equal(routeRow(draft, { situation: 'urgent' }).composition, 'big')
  assert.equal(routeRow(draft, { situation: 'calm' }).composition, 'small')
})
