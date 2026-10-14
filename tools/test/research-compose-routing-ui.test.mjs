import { useArithmeticExample } from './lib/benchmark-example.mjs'
// The Compose tasks surface, driven the way a person drives it: example
// snippets present on opening, compositions nested inside compositions by
// name, and a routing rule stated over fields the person invented.
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { webcrypto } from 'node:crypto'
import test, { afterEach, beforeEach } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { genericStarter } from '../../src/benchmark/starters.mjs'
import { EXAMPLE_SNIPPET_IDS, exampleSnippetLibrary } from '../../src/research-examples.mjs'

register('./css-loader.mjs', import.meta.url)
const { createBenchmarkBuilder } = await import('../../src/research-benchmark.js')
const A = 'rp-' + 'a'.repeat(36)
const views = []
let installed, fixture, cryptoDescriptor
const pause = () => new Promise(resolve => setTimeout(resolve, 5))
async function until(predicate) {
  for (let i = 0; i < 400; i++) { if (predicate()) return; await pause() }
  assert.fail('the benchmark UI did not settle')
}
const f = (view, name) => view.el.querySelector(`[data-bench-${name}]`)
const idle = view => until(() => view.el.getAttribute('aria-busy') === 'false')
async function click(view, name) { assert.equal(f(view, name).disabled, false, `${name} is available`); f(view, name).click(); await idle(view) }
function fill(view, name, value) { const input = f(view, name); input.value = value; input.dispatch('input') }

// The routing editor's own controls, addressed the way the markup addresses
// them: attribute name, then the value that identifies which one.
const r = (view, name, value = '') => view.el.querySelectorAll(`[data-routing-${name}]`).find(node => node.getAttribute(`data-routing-${name}`) === value)
async function press(view, name, value = '') { const button = r(view, name, value); assert.ok(button, `${name}=${value} is on the page`); button.click(); await pause() }
async function set(view, name, value, next) { const input = r(view, name, value); assert.ok(input, `${name}=${value} is on the page`); input.value = next; input.dispatch('change'); await pause() }
async function addComposition(view) {
  view.el.querySelector('[data-bench-tab="nesting"]').click()
  view.el.querySelector('[data-nest-from-snippets]').click(); await pause()
}

async function mount() {
  const view = createBenchmarkBuilder({ account: fixture.account, loadSources: async () => ({}), download: () => {} })
  views.push(view); document.body.append(view.el)
  await view.setContext(A, 'live')
  await useArithmeticExample(view, { examples: true })
  await until(() => f(view, 'preview-meta').textContent.includes('components'))
  return view
}

beforeEach(() => {
  installed = installDomStandIn(globalThis)
  cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  fixture = { values: new Map() }
  fixture.account = {
    async getSetting(key) { return { ok: true, value: fixture.values.get(key) ?? null } },
    async putSetting(key, value) { fixture.values.set(key, value); return { ok: true } },
  }
})
afterEach(async () => {
  for (const view of views.splice(0)) { view.destroy(); view.el.remove() }
  await pause()
  if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor)
  installed?.restore()
})

test('explicitly imported example snippets supply the categories the strip shows', async () => {
  const view = await mount()
  const chips = () => view.el.querySelectorAll('[data-bench-snippet-category]').map(chip => chip.textContent)
  const cards = () => view.el.querySelectorAll('[data-bench-select-snippet]').map(card => card.querySelector('strong').textContent)
  assert.equal(cards().length, genericStarter().catalog.length + EXAMPLE_SNIPPET_IDS.length, 'the examples are in the library after explicit import')
  assert.match(f(view, 'snippet-count').textContent, /example/, 'the count says which of them are examples')
  // Every category shown comes from a label on an example bundle, never from a
  // list in the page: pressing one filters to exactly the snippets carrying it.
  // 2026-09-19: the category pressed here is one of the owner's four kinds,
  // because those are now the only categories the library carries. How many
  // cards it must hold is read from the library rather than typed, so this
  // still checks that the filter is EXACT and not that the number is 6.
  const kind = 'Sell details'
  const inKind = exampleSnippetLibrary().catalog.filter(bundle => bundle.labels.includes(kind)).length
  assert.ok(inKind > 0, 'the library carries that category')
  assert.ok(chips().some(label => label.startsWith(kind)), `categories on the strip: ${chips().join(' | ')}`)
  view.el.querySelectorAll('[data-bench-snippet-category]').find(chip => chip.getAttribute('data-bench-snippet-category') === `label:${kind}`).click()
  await pause()
  assert.equal(cards().length, inKind, `the ${kind} category holds exactly the snippets wearing that label`)
})

test('deleting every example leaves the library the starter produced and the same compiled prompt', async () => {
  const view = await mount()
  const before = f(view, 'prompt').textContent
  for (const id of EXAMPLE_SNIPPET_IDS) {
    const select = f(view, 'bundle')
    const index = select.querySelectorAll('option').findIndex(node => node.textContent.includes(`(${id})`))
    assert.ok(index >= 0, `${id} is still in the library`)
    select.value = String(index); select.dispatch('change'); await idle(view)
    await click(view, 'delete-snippet')
  }
  const remaining = f(view, 'bundle').querySelectorAll('option').map(node => node.textContent)
  assert.equal(remaining.length, genericStarter().catalog.length, 'exactly the starter catalog is left')
  for (const bundle of genericStarter().catalog) assert.ok(remaining.some(label => label.includes(`(${bundle.id})`)), `${bundle.id} survived`)
  await until(() => f(view, 'prompt').textContent === before)
  assert.equal(f(view, 'prompt').textContent, before, 'removing the examples changes nothing about the task')
  assert.equal(f(view, 'snippet-count').textContent.includes('example'), false, 'the library stops claiming examples it no longer has')
})

test('a person nests a composition inside a composition inside a composition and routes on their own field', async () => {
  const view = await mount()
  // No prepare step and no disclosure: the rules are the panel.
  assert.ok(view.el.querySelector('[data-nest-from-snippets]'), 'composition authoring is available in Nesting')

  // Three named compositions, each placed inside the next. Every name here is
  // typed; the page offers none.
  // The bundles nested here are the STARTER's own template and atom. They used
  // to be example snippets (lb-state-gated-template, lb-race-template,
  // lb-ref-impl-prompt-v2); the owner's 2026-09-19 ruling leaves only four
  // kinds of example and no templates among them, and nesting is the product's
  // behaviour rather than the examples', so it is checked on bundles the
  // product ships.
  const levels = [['level3', 'task'], ['level2', 'context'], ['level1', 'context']]
  for (const [index, [name, snippet]] of levels.entries()) {
    await addComposition(view)
    const at = String(index + 1)
    await set(view, 'composition-name', at, name)
    await set(view, 'use', `${at}:`, 'snippet:' + snippet)
    if (snippet !== 'task') await set(view, 'use', `${at}:task`, 'composition:' + levels[index - 1][0])
  }

  await press(view, 'add-field')
  await set(view, 'field', '0', 'topic')
  await press(view, 'add-rule', 'r')
  await set(view, 'outcome', 'r:0', 'composition:level1')
  await press(view, 'add-test', 'r:0')
  await set(view, 'test-field', 'r:0:0', 'topic')
  await set(view, 'test-kind', 'r:0:0', 'is')
  await set(view, 'test-value', 'r:0:0', 'deep')
  await set(view, 'outcome', 'r', 'composition:level3')
  await set(view, 'row-value', '0', 'deep')
  await press(view, 'add-row')

  const editor = f(view, 'routing-editor')
  assert.match(editor.textContent, /3 levels deep/, `the editor reports the resolved depth: ${editor.textContent.slice(0, 400)}`)
  assert.match(editor.textContent, /rule 1/, 'each row says which rule decided')
  assert.match(editor.textContent, /otherwise/, 'and says when the fallback decided instead')

  await click(view, 'apply-routing')
  const tasks = f(view, 'task').querySelectorAll('option').map(node => node.textContent)
  assert.deepEqual(tasks, ['row-1', 'row-2'], 'one ordinary task per row')
  // Wait for the preview of the routed task itself, not for whatever the
  // preview last said about the task this one replaced.
  await until(() => f(view, 'preview-meta').textContent.includes('3 components'))
  assert.match(f(view, 'preview-meta').textContent, /3 components · depth 2/, 'the routed task compiles as three nested levels')
  const task = JSON.parse(f(view, 'task-json').value)
  assert.equal(task.root.slots.task.slots.task.use, 'task', 'the composition references were resolved all the way down')
  assert.deepEqual(task.variables, { topic: 'deep' }, 'the field the rule read travels into the task')

  f(view, 'task').value = '1'; f(view, 'task').dispatch('change'); await idle(view)
  assert.equal(JSON.parse(f(view, 'task-json').value).root.use, 'task', 'the second row took the fallback composition')
})

test('routing refuses a row it cannot place, and names the row', async () => {
  const view = await mount()
  const draft = JSON.parse(f(view, 'routing').value)
  draft.fields = ['topic']
  draft.compositions.push({ name: 'only', node: { use: 'task' } })
  draft.rules = [{ tests: [{ field: 'topic', test: 'is', value: 'chemistry' }], then: { composition: 'only' } }]
  draft.otherwise = null
  draft.rows = [{ id: 'unplaceable', values: { topic: 'geology' } }]
  fill(view, 'routing', JSON.stringify(draft))
  await click(view, 'apply-routing')
  assert.match(f(view, 'status').textContent, /unplaceable/, 'the refusal names the row that could not be placed')
  assert.match(f(view, 'status').textContent, /nothing is chosen there for when none do/)
  assert.deepEqual(f(view, 'task').querySelectorAll('option').map(node => node.textContent), genericStarter().tasks.map(task => task.id),
    'a refused generation leaves the existing tasks exactly as they were')
})

// A template's child places are the person's words. The page ships none, and
// refuses a name the compiler cannot address rather than substituting its own.
test('a new template has no child place until the person names one', async () => {
  const view = await mount()
  await click(view, 'add-template')
  assert.deepEqual(JSON.parse(f(view, 'slots').value), {}, 'a new template arrives with no child place in it')
  assert.equal(f(view, 'wording').value.includes('{{slot:'), false, 'and with no slot name in its wording')

  f(view, 'slot-name').value = 'Preamble'
  await click(view, 'add-slot')
  assert.match(f(view, 'status').textContent, /lowercase/, 'an unusable name is refused by name')
  assert.deepEqual(JSON.parse(f(view, 'slots').value), {}, 'and nothing was added')

  f(view, 'slot-name').value = 'preamble'
  await click(view, 'add-slot')
  assert.deepEqual(JSON.parse(f(view, 'slots').value), { preamble: 'node' })
  assert.match(f(view, 'wording').value, /\{\{slot:preamble\}\}/, 'the place appears in the wording where the person can move it')

  f(view, 'slot-name').value = 'preamble'
  await click(view, 'add-slot')
  assert.match(f(view, 'status').textContent, /already has a child place called preamble/)

  const id = f(view, 'bundle-id').value
  fill(view, 'bundle-title', 'My own wrapper')
  await click(view, 'apply-bundle')

  // Changing the root bundle discards the branch under it, which the tree
  // makes an explicit choice; take it the way the page asks for it.
  const at = (name, path) => view.el.querySelectorAll(`[data-node-${name}]`).find(control => control.getAttribute(`data-node-${name}`) === path)
  at('replacement-mode', '').value = 'replace'
  const root = at('use', '')
  root.value = id; root.dispatch('change'); await idle(view)
  assert.equal(JSON.parse(f(view, 'task-json').value).root.use, id, f(view, 'status').textContent)
  const legends = view.el.querySelectorAll('legend').map(node => node.textContent)
  assert.ok(legends.includes('Preamble'), `the tree names the place with the person's own word: ${legends.join(' | ')}`)
})

/* PROMPT B. A DRAFT RESTORED FROM AN ACCOUNT NEVER GETS THE EXAMPLES, because
   merging them into somebody's saved work would overrule whatever they did to
   it -- including deleting them. So they are offered instead, and pressing the
   offer twice adds nothing the second time. */
test('example snippets can be loaded into a library that does not have them', async () => {
  const view = await mount()
  const ids = () => f(view, 'bundle').querySelectorAll('option').map(node => node.textContent)
  for (const id of EXAMPLE_SNIPPET_IDS) {
    const select = f(view, 'bundle')
    const index = select.querySelectorAll('option').findIndex(node => node.textContent.includes(`(${id})`))
    select.value = String(index); select.dispatch('change'); await idle(view)
    await click(view, 'delete-snippet')
  }
  assert.equal(ids().length, genericStarter().catalog.length, 'the library starts without them')

  await click(view, 'load-examples')
  assert.equal(ids().length, genericStarter().catalog.length + EXAMPLE_SNIPPET_IDS.length)
  for (const id of EXAMPLE_SNIPPET_IDS) assert.ok(ids().some(label => label.includes(`(${id})`)), `${id} is back`)
  assert.match(f(view, 'status').textContent, new RegExp(`${EXAMPLE_SNIPPET_IDS.length} example snippets added`))

  await click(view, 'load-examples')
  assert.equal(ids().length, genericStarter().catalog.length + EXAMPLE_SNIPPET_IDS.length, 'a second press adds nothing')
  assert.match(f(view, 'status').textContent, /already in this library/)

  await click(view, 'undo')
  assert.equal(ids().length, genericStarter().catalog.length, 'and the load is undoable like any other replacement')
})

/* PROMPT B. The owner opened Compose tasks and saw an unchanged page, because
   the routing surface waited behind a prepare button and a JSON disclosure.
   These are the checks that it is the panel now, not an advanced corner of it. */
test('Compose tasks opens with the rules already on the glass', async () => {
  const view = await mount()
  assert.equal(f(view, 'routing-editor').textContent.trim().length > 0, true, 'something is there before any press')
  assert.ok(r(view, 'add-field'), 'fields can be named without a prepare step')
  assert.ok(r(view, 'add-rule', 'r'), 'a rule can be added without a prepare step')
  assert.ok(r(view, 'add-row'), 'a row can be added without a prepare step')
  // Owner, 2026-09-20: compositions are listed and edited once, in the Nesting
  // library and inspector; the rules block draws none of them.
  assert.equal(f(view, 'routing-editor').querySelectorAll('.routing-composition').length, 0, 'the rules block does not draw compositions; the Nesting library and inspector do')
  assert.ok(view.el.querySelector('[data-nest-from-snippets]'), 'Nesting can create a composition without a prepare step')
  assert.equal(view.el.querySelector('[data-bench-prepare-routing]'), null, 'and the prepare step is gone entirely')
  // Seeded from the task already open, not from nothing.
  const draft = JSON.parse(f(view, 'routing').value)
  assert.deepEqual(draft.compositions.map(item => item.name), ['addition-a'])
  assert.deepEqual(draft.fields, [], 'and it still supplies no field of its own')
  assert.deepEqual(draft.rules, [])
})

test('the rules read as an if / else if / otherwise ladder that can be reordered', async () => {
  const view = await mount()
  await press(view, 'add-field')
  await set(view, 'field', '0', 'topic')
  for (const [rule, value] of [[0, 'first'], [1, 'second']]) {
    await press(view, 'add-rule', 'r')
    await press(view, 'add-test', `r:${rule}`)
    await set(view, 'test-field', `r:${rule}:0`, 'topic')
    await set(view, 'test-value', `r:${rule}:0`, value)
  }
  const words = () => f(view, 'routing-editor').textContent.replace(/\s+/g, ' ')
  assert.match(words(), /If/, 'the first rule reads as If')
  assert.match(words(), /Else if/, 'the next reads as Else if')
  assert.match(words(), /Otherwise/, 'and the fallback closes the ladder')
  const valueOf = rule => r(view, 'test-value', `r:${rule}:0`).value
  assert.deepEqual([valueOf(0), valueOf(1)], ['first', 'second'])
  await press(view, 'move-rule-down', 'r:0')
  assert.deepEqual([valueOf(0), valueOf(1)], ['second', 'first'], 'moving a rule down changes what it can take')
  await press(view, 'move-rule-up', 'r:1')
  assert.deepEqual([valueOf(0), valueOf(1)], ['first', 'second'], 'and back again')
})

test('a row says which rule answers it, and the ladder marks that rule', async () => {
  const view = await mount()
  await addComposition(view)
  await set(view, 'composition-name', '1', 'other')
  await set(view, 'use', '1:', 'snippet:lb-ref-impl-prompt-v2')
  await press(view, 'add-field')
  await set(view, 'field', '0', 'topic')
  await press(view, 'add-rule', 'r')
  await set(view, 'outcome', 'r:0', 'composition:other')
  await press(view, 'add-test', 'r:0')
  await set(view, 'test-field', 'r:0:0', 'topic')
  await set(view, 'test-value', 'r:0:0', 'yes')
  await set(view, 'outcome', 'r', 'composition:addition-a')
  await set(view, 'row-value', '0', 'yes')
  await press(view, 'add-row')

  const rules = () => view.el.querySelectorAll('.routing-rule')
  const winners = () => rules().filter(node => node.getAttribute('data-winner') === 'true')
  assert.equal(winners().length, 1, 'exactly one rung is marked at a time')
  assert.match(winners()[0].textContent, /Add another test/, 'and it is a rule rung, not the fallback')
  assert.match(f(view, 'routing-editor').textContent, /rule 1/, 'the row says the same thing in words')

  // The second row matches nothing, so the fallback answers it instead.
  await press(view, 'select-row', '1')
  assert.equal(winners().length, 1)
  assert.match(winners()[0].textContent, /Otherwise/, 'the marked rung moves to the fallback')
})

/* PROMPT B. Copy that points at a control which no longer exists is worse than
   the missing control, because it sends a person hunting for it. Both guards
   below are reachable only by emptying the advanced JSON box, and both name a
   button that is actually on the page — which is what these assert. */
test('the empty-rules guards say what is true and name a control that exists', async () => {
  const named = 'Start these rules again'
  const button = view => view.el.querySelectorAll('button').find(node => node.textContent.trim() === named)

  for (const [action, expected] of [['apply-routing', /no rules here to generate from/], ['capture', /no rules here to copy into/]]) {
    const view = await mount()
    assert.ok(button(view), `${named} is on the page before anything is pressed`)
    fill(view, 'routing', '')
    if (action === 'capture') { r(view, 'capture').click(); await pause() }
    else await click(view, action)
    const said = `${f(view, 'status').textContent} ${f(view, 'routing-status').textContent}`
    assert.match(said, expected, action)
    assert.match(said, new RegExp(named), 'and it names the way out')
    assert.equal(said.includes('Prepare routing'), false, 'never a control that was removed')
    assert.ok(button(view), 'the control it names is still on the page when the message appears')
  }
})

/* PROMPT C. THE DECISION LAYER NESTS THE WAY THE CONTENT LAYER DOES.
   The owner: "i think they were supposed to nest right? i mean why not." So a
   rung chooses either a composition or another set of rules, and that set is
   asked the same way — and it is built with the same gesture, from the same
   select, without learning a second mechanism. */
test('a rung can choose another set of rules, built from the same select', async () => {
  const view = await mount()
  const outcomes = () => r(view, 'outcome', 'r:0').querySelectorAll('option').map(node => node.getAttribute('value'))

  await press(view, 'add-field')
  await set(view, 'field', '0', 'situation')
  await press(view, 'add-rule', 'r')
  assert.ok(outcomes().some(value => value.startsWith('composition:')), 'the select offers compositions')
  assert.ok(outcomes().includes('new-decision'), 'and offers a new set of rules from the same list')

  await set(view, 'outcome', 'r:0', 'new-decision')
  const draft = JSON.parse(f(view, 'routing').value)
  assert.deepEqual(draft.rules[0].then, { decision: 'rules-1' }, 'the rung now points at a set of rules')
  assert.deepEqual(draft.decisions.map(item => item.name), ['rules-1'])
  assert.ok(r(view, 'add-rule', 'd0'), 'and that set has its own ladder, on the glass, in place')
  assert.ok(outcomes().includes('decision:rules-1'), 'an existing set is offered to other rungs too')
})

test('three levels of decision, and a row traces its whole path through them', async () => {
  const view = await mount()
  // Two compositions to land on, so the branches have somewhere to go.
  for (const [at, name] of [['1', 'small'], ['2', 'big']]) {
    await addComposition(view)
    await set(view, 'composition-name', at, name)
    await set(view, 'use', `${at}:`, 'snippet:lb-ref-impl-prompt-v2')
  }
  for (const field of ['situation', 'size']) {
    await press(view, 'add-field')
    await set(view, 'field', String(draftOf(view).fields.length - 1), field)
  }
  // Outermost: if situation is urgent, go to a second set of rules.
  await press(view, 'add-rule', 'r')
  await press(view, 'add-test', 'r:0')
  await set(view, 'test-field', 'r:0:0', 'situation')
  await set(view, 'test-value', 'r:0:0', 'urgent')
  await set(view, 'outcome', 'r:0', 'new-decision')
  await set(view, 'outcome', 'r', 'composition:small')
  // Second: if size is large, go to a third set.
  await press(view, 'add-rule', 'd0')
  await press(view, 'add-test', 'd0:0')
  await set(view, 'test-field', 'd0:0:0', 'size')
  await set(view, 'test-value', 'd0:0:0', 'large')
  await set(view, 'outcome', 'd0:0', 'new-decision')
  await set(view, 'outcome', 'd0', 'composition:small')
  // Third: land on a composition either way.
  await press(view, 'add-rule', 'd1')
  await press(view, 'add-test', 'd1:0')
  await set(view, 'test-field', 'd1:0:0', 'situation')
  await set(view, 'test-value', 'd1:0:0', 'urgent')
  await set(view, 'outcome', 'd1:0', 'composition:big')
  await set(view, 'outcome', 'd1', 'composition:small')

  await set(view, 'row-value', '0', 'urgent')
  const sizeCell = view.el.querySelectorAll('[data-routing-row-field]').find(node => node.getAttribute('data-routing-row-field') === 'size')
  sizeCell.value = 'large'; sizeCell.dispatch('change')

  const editor = () => f(view, 'routing-editor').textContent.replace(/\s+/g, ' ')
  assert.match(editor(), /rules-1/, 'the first nested set is named on the page')
  assert.match(editor(), /rules-2/, 'and so is the second')
  // The row's whole path, level by level, ending at what it landed on.
  assert.match(editor(), /rule 1 → the rules named rules-1: rule 1 → the rules named rules-2: rule 1 → big/,
    `the Uses column traces every rung: ${editor().slice(0, 700)}`)
  const winners = view.el.querySelectorAll('.routing-rule').filter(node => node.getAttribute('data-winner') === 'true')
  assert.equal(winners.length, 3, 'one rung is marked at each of the three levels')
})

test('a loop between sets of rules is refused by the names that form it', async () => {
  const view = await mount()
  const draft = JSON.parse(f(view, 'routing').value)
  draft.fields = ['situation']
  draft.decisions = [
    { name: 'first', rules: [{ tests: [{ field: 'situation', test: 'is', value: 'x' }], then: { decision: 'second' } }], otherwise: null },
    { name: 'second', rules: [{ tests: [{ field: 'situation', test: 'is', value: 'x' }], then: { decision: 'first' } }], otherwise: null },
  ]
  draft.rules = [{ tests: [{ field: 'situation', test: 'is', value: 'x' }], then: { decision: 'first' } }]
  draft.otherwise = null
  fill(view, 'routing', JSON.stringify(draft))
  await click(view, 'apply-routing')
  const said = `${f(view, 'status').textContent} ${f(view, 'routing-status').textContent}`
  assert.match(said, /contain each other/, said)
  assert.match(said, /first/)
  assert.match(said, /second/)
})

test('renaming a set of rules carries the rungs that point at it', async () => {
  const view = await mount()
  await press(view, 'add-field')
  await set(view, 'field', '0', 'situation')
  await press(view, 'add-rule', 'r')
  await set(view, 'outcome', 'r:0', 'new-decision')
  await set(view, 'decision-name', '0', 'urgent-path')
  const draft = draftOf(view)
  assert.deepEqual(draft.decisions.map(item => item.name), ['urgent-path'])
  assert.deepEqual(draft.rules[0].then, { decision: 'urgent-path' }, 'the rung followed the rename instead of breaking')
})

function draftOf(view) { return JSON.parse(f(view, 'routing').value) }

test('a bundled full experiment loads its snippets, named compositions and tasks through the example menu', async () => {
  const { readFile } = await import('node:fs/promises')
  const example = JSON.parse(await readFile(new URL('../../src/data/lean-bench-example-draft.json', import.meta.url), 'utf8'))
  const downloads = []
  const view = createBenchmarkBuilder({
    account: fixture.account, loadSources: async () => ({}),
    download: (name, contents) => downloads.push(JSON.parse(contents)),
  })
  views.push(view); document.body.append(view.el)
  await view.setContext(A, 'live')
  await idle(view)
  assert.equal(f(view, 'task').querySelectorAll('option').length, 0, 'the project starts empty before an example is chosen')
  // Cache the page's persistent controls before the large composition form is
  // rendered: the stand-in's querySelector traverses the whole subtree.
  const controls = Object.fromEntries(['starter', 'use-starter', 'status', 'task', 'routing', 'draft-export', 'undo']
    .map(name => [name, f(view, name)]))
  const tabs = view.el.querySelectorAll('[data-bench-tab]')
  const panels = view.el.querySelectorAll('[data-bench-panel]')
  const pressControl = async name => {
    assert.equal(controls[name].disabled, false, name + ' is available')
    controls[name].click(); await idle(view)
  }
  const exported = async () => { await pressControl('draft-export'); return downloads.at(-1) }
  const original = await exported()
  assert.ok(controls.starter.querySelectorAll('option').some(option =>
    option.getAttribute('value') === 'lean-bench-snippets-and-compositions'), 'the full example is offered by name')
  controls.starter.value = 'lean-bench-snippets-and-compositions'
  await pressControl('use-starter')
  assert.match(controls.status.textContent, /Example draft loaded: Lean Bench/)
  assert.equal(JSON.parse(controls.routing.value).compositions.length, 66)
  assert.equal(controls.task.querySelectorAll('option').length, 41, 'all tasks are offered in the editor')
  const library = panels.find(node => node.dataset.benchPanel === 'library')
  assert.equal(library.querySelectorAll('[data-bench-select-snippet]').length, 74, 'all snippets and templates are visible')
  const categories = library.querySelectorAll('[data-bench-snippet-category]')
    .map(node => node.getAttribute('data-bench-snippet-category'))
    .filter(value => value.startsWith('label:'))
  assert.deepEqual(categories.sort(), ['label:Buy details', 'label:Reason to buy', 'label:Reason to sell', 'label:Sell details'].sort())
  for (const id of ['library', 'compose']) {
    const tab = tabs.find(node => node.dataset.benchTab === id)
    tab.click(); await pause()
    assert.equal(tab.getAttribute('aria-pressed'), 'true')
    assert.equal(panels.find(node => node.dataset.benchPanel === id).hidden, false)
    assert.equal(controls.routing.value, example.editors['data-bench-routing'])
  }
  const loaded = await exported()
  assert.deepEqual(loaded.spec, example.spec)
  assert.deepEqual(loaded.attachments, example.attachments)
  assert.equal(loaded.editors['data-bench-routing'], example.editors['data-bench-routing'])
  assert.equal(loaded.taskIndex, example.taskIndex)
  assert.equal(loaded.bundleIndex, example.bundleIndex)
  assert.deepEqual(loaded.pending, example.pending)
  await pressControl('undo')
  const restored = await exported()
  assert.deepEqual(restored.spec, original.spec, 'undo restores the previous experiment')
  assert.deepEqual(restored.attachments, original.attachments)
  assert.equal(restored.editors['data-bench-routing'], original.editors['data-bench-routing'])
})
