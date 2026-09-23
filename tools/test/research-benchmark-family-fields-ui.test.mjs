import assert from 'node:assert/strict'
import test, { afterEach, beforeEach } from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { createCompositionFamilyEditor } from '../../src/research-composition-families.js'
import { createCompositionFieldsEditor } from '../../src/research-composition-fields.js'
import { compositionFieldInventory, createCompositionFieldDraft } from '../../src/benchmark/corpus.mjs'
import { genericStarter } from '../../src/benchmark/starters.mjs'

let installed
const views = [], clone = value => structuredClone(value)
const get = (view, name) => view.el.querySelector('[data-composition-family-fields-' + name + ']')
const local = (view, name) => view.el.querySelector('[data-composition-fields-' + name + ']')
const fill = (view, name, value) => { const input = get(view, name); assert.ok(input, name); assert.equal(input.disabled, false); input.value = value; input.dispatch('input'); return input }
const click = (view, name) => { const button = get(view, name); assert.ok(button, name); assert.equal(button.disabled, false); button.click() }
function mount(context, callbacks = {}) {
  const view = createCompositionFamilyEditor(callbacks); views.push(view); document.body.append(view.el); view.setContext(context); return view
}
function composition(inventory, draft, options = {}) {
  const view = createCompositionFieldsEditor(options); views.push(view); document.body.append(view.el); view.setContext(inventory, draft); return view
}
function fixture() {
  const sourceA = { id: 'source-a', familyId: 'original-a', split: 'development', root: { use: 'source' }, input: { number: 0 }, expected: false }
  const sourceB = { id: 'source-b', familyId: 'original-b', split: 'held-out', root: { use: 'source' }, input: { number: 9 }, expected: true }
  const fields = (source, familyId) => ({ version: 2, taskId: source.id, bindingSha256: 'a'.repeat(64), familyId, split: source.split,
    rationale: 'Retained independent family rationale', seed: 'old unfinished seed', selection: { kind: 'all', limit: 'old limit' }, coverage: { kind: 'none', minimum: 'old quota' },
    expectedPolicy: { kind: 'reuse-base', rationale: 'Explicit family answer policy.' }, occurrences: [{ key: '[]', path: [], axisId: 'node-0001', enabled: true,
      choices: [{ id: 'current', subtree: { kind: 'unfilled' } }] }] })
  return { workspace: { version: 1, rationale: '', seed: '42', selection: { kind: 'all', limit: '512' }, coverage: { kind: 'marginal', minimum: '1' },
    families: [{ sourceTask: sourceA, fields: fields(sourceA, 'generated-a') }, { sourceTask: sourceB, fields: fields(sourceB, 'generated-b') }] },
  sources: [sourceA, sourceB, { id: 'source-c', familyId: 'original-a', split: 'development' }].map(source =>
    ({ taskId: source.id, familyId: source.familyId, split: source.split, label: 'Label for ' + source.id })), selectedTaskId: 'source-a' }
}
beforeEach(() => { installed = installDomStandIn(globalThis) })
afterEach(() => { for (const view of views.splice(0)) { view.destroy(); view.el.remove() } installed.restore() })

test('global ordinary fields retain incomplete text and emit private workspace copies without changing family fields', () => {
  const context = fixture(), original = clone(context), changes = [], view = mount(context, { onChange: workspace => changes.push(workspace) })
  const seed = get(view, 'seed'); seed.focus()
  fill(view, 'seed', '1e')
  assert.equal(get(view, 'seed'), seed); assert.equal(document.activeElement, seed)
  fill(view, 'rationale', 'Explicit combined construction rationale.')
  fill(view, 'selection-kind', 'balanced'); fill(view, 'selection-limit', 'unfinished limit')
  fill(view, 'coverage-kind', 'pairwise'); fill(view, 'coverage-minimum', '')
  const latest = changes.at(-1)
  assert.equal(latest.seed, '1e'); assert.equal(latest.rationale, 'Explicit combined construction rationale.')
  assert.deepEqual(latest.selection, { kind: 'balanced', limit: 'unfinished limit' })
  assert.deepEqual(latest.coverage, { kind: 'pairwise', minimum: '' })
  assert.deepEqual(latest.families, original.workspace.families)
  assert.deepEqual(context, original, 'The caller source capsules and workspace remain untouched.')
  latest.families[0].sourceTask.input.number = 999
  fill(view, 'seed', '7')
  assert.equal(changes.at(-1).families[0].sourceTask.input.number, 0, 'A consumer cannot mutate private component state through a callback value.')
  const remounted = mount({ ...context, workspace: changes.at(-1) })
  assert.equal(get(remounted, 'selection-limit').value, 'unfinished limit')
  assert.equal(get(remounted, 'coverage-minimum').value, '')
  get(remounted, 'seed').focus(); remounted.setContext({ ...context, workspace: changes.at(-1) })
  assert.equal(document.activeElement, get(remounted, 'seed'))
})

test('family selection is view-only and empty or unavailable selections never substitute another family', () => {
  const context = fixture(), changes = [], selected = [], view = mount(context, { onChange: value => changes.push(value), onSelect: id => selected.push(id) })
  assert.match(get(view, 'family').textContent, /generated-a \/ source-a \/ development/)
  assert.match(get(view, 'family').textContent, /generated-b \/ source-b \/ held-out/)
  fill(view, 'family', 'source-b')
  assert.deepEqual(selected, ['source-b']); assert.equal(changes.length, 0)
  view.setContext({ ...context, selectedTaskId: '' })
  assert.equal(get(view, 'family').value, ''); assert.equal(get(view, 'remove').disabled, true)
  view.setContext({ ...context, selectedTaskId: 'missing-selected-family' })
  assert.equal(get(view, 'family').value, 'missing-selected-family')
  assert.match(get(view, 'family').textContent, /missing-selected-family \(unavailable\)/)
  assert.equal(get(view, 'remove').disabled, true)
  fill(view, 'family', '')
  assert.deepEqual(selected, ['source-b']); assert.equal(changes.length, 0)
  view.setContext({ ...context, selectedTaskId: undefined })
  assert.equal(get(view, 'family').value, '', 'Context refresh keeps the explicit empty view selection.')
})

test('an explicit workspace reset clears private source and family selections before another account workspace starts', () => {
  const accountA = fixture(), privateId = 'account-a-private-source', changes = [], selected = [], added = []
  accountA.sources.push({ taskId: privateId, familyId: 'private-family-a', split: 'held-out', label: 'Private source A' })
  const view = mount(accountA, { onChange: value => changes.push(value), onSelect: value => selected.push(value), onAdd: value => added.push(value) })
  fill(view, 'source', privateId)
  view.setContext({ ...accountA, selectedTaskId: undefined })
  assert.equal(get(view, 'source').value, privateId, 'A normal redraw retains the in-progress source selection.')
  assert.equal(get(view, 'family').value, 'source-a')
  view.setContext({ workspace: null, sources: [] })
  const accountB = fixture()
  for (const family of accountB.workspace.families) {
    family.sourceTask.id = 'account-b-' + family.sourceTask.id
    family.fields.taskId = family.sourceTask.id
  }
  accountB.sources = accountB.sources.map(source => ({ ...source, taskId: 'account-b-' + source.taskId }))
  delete accountB.selectedTaskId
  view.setContext(accountB)
  assert.equal(get(view, 'source').value, '')
  assert.equal(get(view, 'family').value, '')
  assert.equal(get(view, 'add').disabled, true); assert.equal(get(view, 'remove').disabled, true)
  assert.ok(!get(view, 'source').children.some(option => option.value === privateId))
  assert.ok(!get(view, 'family').children.some(option => option.value === 'source-a'))
  assert.doesNotMatch(view.el.textContent, /account-a-private-source|Private source A/)
  assert.deepEqual(changes, []); assert.deepEqual(selected, []); assert.deepEqual(added, [])
})

test('add and remove delegate exact IDs without mutating capsules and reject stale buttons and unavailable sources', () => {
  const context = fixture(), adds = [], removes = [], changes = [], view = mount(context, { onAdd: id => adds.push(id), onRemove: id => removes.push(id), onChange: next => changes.push(next) })
  assert.equal(get(view, 'source').value, ''); assert.equal(get(view, 'add').disabled, true)
  assert.deepEqual(get(view, 'source').children.map(option => option.value), ['', 'source-c'])
  fill(view, 'source', 'source-c'); click(view, 'add')
  assert.deepEqual(adds, ['source-c'], 'Another source from original-a remains selectable; root/core owns the same-family rejection.')
  assert.equal(changes.length, 0)
  click(view, 'remove'); assert.deepEqual(removes, ['source-a'])
  const oldAdd = get(view, 'add'), oldRemove = get(view, 'remove'), oldSeed = get(view, 'seed')
  view.setContext({ ...context, sources: [], selectedTaskId: 'source-b' })
  assert.equal(get(view, 'source').value, 'source-c', 'Unavailable source selection remains visible, with no fallback.')
  assert.equal(get(view, 'add').disabled, true)
  oldAdd.click(); oldRemove.click(); oldSeed.value = 'old event'; oldSeed.dispatch('input')
  assert.deepEqual(adds, ['source-c']); assert.deepEqual(removes, ['source-a']); assert.equal(changes.length, 0)
  click(view, 'remove'); assert.deepEqual(removes, ['source-a', 'source-b'])
  assert.equal(get(view, 'family').children.filter(option => option.value).length, 2, 'Root has not applied either requested removal.')
  view.setContext({ ...context, workspace: { ...context.workspace, families: [context.workspace.families[0]] }, selectedTaskId: 'source-b' })
  assert.equal(get(view, 'family').value, 'source-b'); assert.equal(get(view, 'remove').disabled, true)
})

test('missing live source families remain inspectable and stale guidance makes no qualification or population claim', () => {
  const context = fixture(), selected = [], view = mount({ ...context, sources: [] }, { onSelect: id => selected.push(id) })
  assert.match(get(view, 'status').textContent, /2 retained source families/)
  assert.match(get(view, 'status').textContent, /Family grouping is an investigator claim; the primary population and qualification admission are evaluated later/)
  assert.match(get(view, 'source-status').textContent, /Missing live source tasks: source-a, source-b/)
  assert.match(get(view, 'source-status').textContent, /Undo if available or import the original source draft/)
  assert.match(get(view, 'family').textContent, /source task missing; import it before building/)
  fill(view, 'family', 'source-b'); assert.deepEqual(selected, ['source-b'])
  assert.equal(get(view, 'remove').disabled, false)
  assert.equal(get(view, 'add').disabled, true)
  view.setContext({ workspace: null, sources: [], selectedTaskId: '' })
  assert.match(get(view, 'status').textContent, /Start a family workspace/)
  assert.equal(get(view, 'family'), null)
})

test('source metadata stays literal text and private source inputs or expected answers are not rendered', () => {
  const context = fixture(), payload = '<img src=x onerror="run()"><script>run()</script>'
  context.sources[2].label = payload
  context.workspace.families[0].fields.familyId = payload
  context.workspace.families[0].sourceTask.input = { private: 'PRIVATE INPUT SENTINEL' }
  context.workspace.families[0].sourceTask.expected = 'PRIVATE EXPECTED SENTINEL'
  const view = mount(context)
  assert.ok(get(view, 'source').textContent.includes(payload))
  assert.ok(get(view, 'family').textContent.includes(payload))
  assert.equal(view.el.querySelectorAll('img').length, 0); assert.equal(view.el.querySelectorAll('script').length, 0)
  assert.doesNotMatch(view.el.textContent, /PRIVATE INPUT SENTINEL|PRIVATE EXPECTED SENTINEL/)
})

test('disabled and destroyed family editors cannot change workspace or invoke actions', () => {
  const context = fixture(), calls = [], view = mount(context, { onChange: () => calls.push('change'), onSelect: () => calls.push('select'), onAdd: () => calls.push('add'), onRemove: () => calls.push('remove') })
  fill(view, 'source', 'source-c')
  view.setDisabled(true)
  for (const tag of ['input', 'textarea', 'select', 'button']) assert.ok(view.el.querySelectorAll(tag).every(node => node.disabled))
  get(view, 'seed').value = 'bad'; get(view, 'seed').dispatch('input')
  get(view, 'family').value = 'source-b'; get(view, 'family').dispatch('input'); get(view, 'remove').click(); get(view, 'add').click()
  assert.deepEqual(calls, [])
  view.setContext(context); assert.equal(get(view, 'seed').disabled, true)
  view.setDisabled(false); fill(view, 'seed', '0'); assert.deepEqual(calls, ['change'])
  const seed = get(view, 'seed'), remove = get(view, 'remove')
  view.destroy(); seed.value = '1'; seed.dispatch('input'); remove.click(); view.setContext(context)
  assert.deepEqual(calls, ['change']); assert.equal(view.el.children.length, 0)
})

test('shared construction hides only global controls and preserves hidden raw policy while all family and topology fields remain editable', async () => {
  const spec = genericStarter(), inventory = await compositionFieldInventory(spec, spec.tasks[0].id), draft = createCompositionFieldDraft(inventory)
  draft.seed = 'old unfinished seed'; draft.selection = { kind: 'all', limit: 'old limit' }; draft.coverage = { kind: 'pairwise', minimum: 'old quota' }
  const changes = [], ordinary = composition(inventory, draft), shared = composition(inventory, draft, { sharedConstruction: true, onChange: next => changes.push(next) })
  const hidden = ['seed', 'selection-kind', 'selection-limit', 'coverage-kind', 'coverage-minimum']
  for (const name of hidden) { assert.ok(local(ordinary, name), name); assert.equal(local(shared, name), null, name) }
  const getNames = view => new Set(view.el.querySelectorAll('[data-composition-fields-focus]').map(node => node.getAttribute('data-composition-fields-focus')))
  const allNames = getNames(ordinary), sharedNames = getNames(shared)
  assert.deepEqual([...allNames].filter(name => !sharedNames.has(name)).sort(), [...hidden].sort())
  for (const name of ['family', 'split', 'rationale', 'expected-policy', 'expected-rationale', 'occurrence', 'enabled', 'axis-id', 'choice-id', 'choice-kind', 'bundle']) assert.ok(local(shared, name), name)
  assert.match(local(shared, 'shared-construction').textContent, /workspace owns the shared seed, sampling and coverage/)
  const family = local(shared, 'family'); family.value = 'edited-family'; family.dispatch('input')
  assert.equal(changes.at(-1).familyId, 'edited-family')
  assert.equal(changes.at(-1).seed, draft.seed); assert.deepEqual(changes.at(-1).selection, draft.selection); assert.deepEqual(changes.at(-1).coverage, draft.coverage)
  shared.setContext(inventory, changes.at(-1)); assert.equal(local(shared, 'family').value, 'edited-family')
  const raw = { ...draft, selection: 'retained uninterpreted policy text', coverage: null }
  shared.setContext(inventory, raw)
  assert.ok(local(shared, 'occurrence'), 'Workspace mode does not interpret hidden local policy values.')
  assert.deepEqual(shared.getDraft(), raw)
  const choiceKind = local(shared, 'choice-kind'); choiceKind.value = 'subtree'; choiceKind.dispatch('input')
  assert.ok(local(shared, 'node-kind')); assert.equal(shared.getDraft().selection, raw.selection); assert.equal(shared.getDraft().coverage, null)
})
