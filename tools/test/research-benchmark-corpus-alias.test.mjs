import assert from 'node:assert/strict'
import test from 'node:test'
import { canonical } from '../../src/benchmark/prompts.mjs'
import { corpusPlanFromTask, generateCorpus } from '../../src/benchmark/corpus.mjs'

const catalog = [
  { id: 'pair', version: '1', kind: 'template', role: 'node', slots: { left: 'node', right: 'node' },
    text: 'Left[{{slot:left}}] Right[{{slot:right}}]', semantics: { kind: 'pair' } },
  { id: 'box', version: '1', kind: 'template', role: 'node', slots: { item: 'node' },
    text: 'Box[{{slot:item}}]', semantics: { kind: 'box' } },
  { id: 'number', version: '1', kind: 'atom', role: 'node', parameters: { n: 1 },
    text: 'Number {{n}}', semantics: { kind: 'number', value: '{{n}}' } },
]
const numbers = result => result.tasks.map(task => [task.root.slots.left.slots.item.params.n, task.root.slots.right.slots.item.params.n])
function freezeGraph(value, seen = new Set()) {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value); Object.values(value).forEach(child => freezeGraph(child, seen)); Object.freeze(value)
  }
  return value
}
function recipe(sharing) {
  const leaf = { use: 'number', params: { n: 1 } }, box = { use: 'box', slots: { item: leaf } }
  const root = { use: 'pair', slots: { left: box,
    right: sharing === 'ancestor' ? box : { use: 'box', slots: { item: leaf } } } }
  const task = { id: 'nested-values', split: 'development', input: null, expected: null, root }
  // This is a construction test, with no score or external oracle claim.
  const plan = corpusPlanFromTask(task)
  plan.families[0].axes = [['left', [1, 2]], ['right', [10, 20]]].map(([side, values]) => ({ id: side,
    choices: values.map(value => ({ id: 'n-' + value, edits: [{ kind: 'parameter', path: [side, 'item'], name: 'n', value }] })) }))
  if (sharing === 'replacement') {
    plan.families[0].task.root = JSON.parse(canonical(root))
    plan.families[0].axes.unshift({ id: 'replace', choices: [{ id: 'nested', edits: [{ kind: 'node', path: [], value: root }] }] })
  }
  return plan
}

for (const [sharing, label] of [
  ['leaf', 'sibling references to the same leaf'],
  ['ancestor', 'sibling references to the same wrapper and descendant'],
  ['replacement', 'shared descendants inside a replacement choice'],
]) test('canonical corpus bytes give the full independent product despite ' + label, async () => {
  const plan = recipe(sharing), detached = JSON.parse(canonical(plan)), source = canonical(plan), originalCatalog = canonical(catalog)
  const retained = sharing === 'replacement' ? plan.families[0].axes[0].choices[0].edits[0].value : plan.families[0].task.root
  assert.equal(retained.slots.left.slots.item, retained.slots.right.slots.item, 'The control really contains a shared object before serialization.')
  if (sharing === 'ancestor') assert.equal(retained.slots.left, retained.slots.right)
  assert.equal(canonical(detached), source)
  freezeGraph(plan); freezeGraph(catalog)

  const sharedResult = await generateCorpus(plan, catalog), serializedResult = await generateCorpus(detached, catalog)
  assert.equal(sharedResult.manifest.recipeSha256, serializedResult.manifest.recipeSha256)
  assert.deepEqual(sharedResult, serializedResult, 'Serialization must not change a corpus manifest or its selected tasks.')
  assert.equal(sharedResult.manifest.candidateCount, 4)
  assert.equal(sharedResult.manifest.selectedCount, 4)
  assert.equal(sharedResult.manifest.status, 'ready')
  assert.ok(sharedResult.manifest.candidates.every(row => row.disposition === 'selected'))
  assert.deepEqual(numbers(sharedResult), [[1, 10], [1, 20], [2, 10], [2, 20]])
  assert.equal(canonical(plan), source); assert.equal(canonical(catalog), originalCatalog)
  assert.equal(retained.slots.left.slots.item.params.n, 1)

  // Separate generated tasks and node paths must remain independently editable.
  sharedResult.tasks[0].root.slots.left.slots.item.params.n = 99
  assert.equal(sharedResult.tasks[0].root.slots.right.slots.item.params.n, 10)
  assert.deepEqual(numbers(sharedResult).slice(1), [[1, 20], [2, 10], [2, 20]])
  assert.equal(canonical(plan), source)
})
