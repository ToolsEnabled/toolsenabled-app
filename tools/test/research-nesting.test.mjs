import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { buildNesting, nestingFormFor, nestingOutline } from '../../src/research-nesting.mjs'
import { expandComposition } from '../../src/research-routing.mjs'
import { compileTask } from '../../src/benchmark/tasks.mjs'

const example = JSON.parse(await readFile(new URL('../../src/data/lean-bench-example-draft.json', import.meta.url), 'utf8'))
const routing = () => JSON.parse(example.editors['data-bench-routing'])
const form = (name, members, mode = 'together') => ({ name, mode, instructions: '', members: members.map(composition => ({ composition, condition: '' })) })
async function compiled(built) {
  return (await compileTask({ ...example.spec, catalog: built.catalog }, { id: 'nested-test', root: expandComposition(built.name, built.draft, { catalog: built.catalog }), input: null, expected: null, split: 'development' }, { requireReview: false, requireTaskReview: false, validateExpected: false })).compiled
}

test('nesting composes three members across families and remains reusable at another level', async () => {
  const original = routing(), before = structuredClone(original)
  const built = buildNesting(original, example.spec.catalog, form('Mixed three', ['T1v0 / Strategy A', 'O1v0 / Strategy', 'BL-08 / Strategy B']))
  assert.equal(built.draft.compositions.at(-1).node.slots.member_2.composition, 'O1v0 / Strategy')
  const result = await compiled(built)
  assert.match(result.text, /Member 3/)
  assert.ok(result.nodeCount > 10)
  assert.deepEqual(original, before)
  assert.equal(example.spec.catalog.length, 74)
  const deeper = buildNesting(built.draft, built.catalog, form('Outer', ['Mixed three', 'O1v0']))
  assert.ok((await compiled(deeper)).depth > result.depth)
  const outline = nestingOutline('Outer', deeper.draft, deeper.catalog)
  assert.match(JSON.stringify(outline), /Mixed three/)
  assert.match(JSON.stringify(outline), /O1v0 \/ Strategy/)
})

test('conditional ordering and authored literal conditions survive compilation and reopening', async () => {
  const input = form('Conditional pair', ['T1v0 / Strategy A', 'O1v0 / Strategy'], 'conditional-first')
  input.instructions = 'Use the declared data only.'
  input.members[0].condition = 'The stock signal holds; quote {{slot:example}} literally.'
  input.members[1].condition = 'The options signal holds.'
  const built = buildNesting(routing(), example.spec.catalog, input)
  const output = (await compiled(built)).text
  assert.match(output, /only the first matching member/)
  assert.match(output, /quote \{\{slot:example\}\} literally/)
  assert.ok(output.indexOf('stock signal') < output.indexOf('options signal'))
  assert.deepEqual(nestingFormFor('Conditional pair', built.draft, built.catalog), { ...input, editing: 'Conditional pair' })
  input.members[1].condition = ''
  assert.throws(() => buildNesting(routing(), example.spec.catalog, input), /Member 2/)
})

test('editing a nesting preserves old task wrappers and rejects missing members or indirect loops', () => {
  const a = buildNesting(routing(), example.spec.catalog, form('Group A', ['T1v0']))
  const b = buildNesting(a.draft, a.catalog, form('Group B', ['Group A']))
  const edit = { ...form('Group A', ['O1v0']), editing: 'Group A' }
  const changed = buildNesting(b.draft, b.catalog, edit)
  assert.deepEqual(changed.catalog.find(item => item.id === a.catalog.at(-1).id), a.catalog.at(-1), 'old generated tasks retain their wrapper')
  assert.notEqual(changed.draft.compositions.find(item => item.name === 'Group A').node.use, a.draft.compositions.find(item => item.name === 'Group A').node.use)
  edit.members[0].composition = 'Group B'
  assert.throws(() => buildNesting(b.draft, b.catalog, edit), /contain each other/)
  assert.throws(() => buildNesting(routing(), example.spec.catalog, form('Missing', ['Not here'])), /existing composition/)
})
