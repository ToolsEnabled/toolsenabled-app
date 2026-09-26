import test from 'node:test'
import assert from 'node:assert/strict'
import { canonical, compilePrompt } from '../../src/benchmark/prompts.mjs'
import { compositionSemantics, compositionRequirements, renderComposition, validateComposition } from '../../src/benchmark/composition.mjs'
import { compileTask } from '../../src/benchmark/tasks.mjs'
import { informationFixture } from './fixtures/research-benchmark-information.mjs'

const library = () => [
  { id: 'text', version: '1', kind: 'atom', role: 'node', text: 'α{{value}}', parameters: { value: 'L😀' }, semantics: { kind: 'literal', value: '{{value}}' }, dependencies: [] },
  { id: 'pair', version: '1', kind: 'template', text: 'start [{{slot:later}}] / {{slot:earlier}} / {{slot:later}}',
    slots: { earlier: 'node', later: 'node' }, slotOrder: ['earlier', 'later'], semantics: { kind: 'sequence' }, dependencies: [] },
]
const tree = () => ({ use: 'pair', slots: { earlier: { use: 'text', params: { value: '{{slot:later}}' } }, later: { use: 'text' } } })

test('one serialized representation independently produces literal-safe prose, structural ordering and exact requirement occurrences', async () => {
  const catalog = library(), compiled = await compilePrompt(catalog, tree())
  const ir = JSON.parse(canonical(compiled.composition))
  catalog[0].text = 'Changed outside the compiled representation'
  const rendered = renderComposition(ir), semantic = compositionSemantics(ir), checklist = compositionRequirements(ir)
  assert.equal(rendered.text, 'start [αL😀] / α{{slot:later}} / αL😀')
  assert.deepEqual(semantic.childOrder, ['earlier', 'later'], 'Semantic order is independent of prose placement and repetition')
  assert.equal(semantic.children.earlier.value, '{{slot:later}}', 'Parameter text cannot become a structural slot')
  assert.equal(semantic.children.later.value, 'L😀')
  assert.deepEqual(rendered.sourceMap.map(row => row.path), ['root', 'root/later', 'root/earlier', 'root/later'])
  assert.deepEqual(rendered.sourceMap.slice(1).map(row => rendered.text.slice(row.start, row.end)), ['αL😀', 'α{{slot:later}}', 'αL😀'])
  assert.equal(rendered.sourceMapUnit, 'UTF-16 code units'); assert.equal(rendered.depth, 1)
  assert.equal(checklist.length, 3); assert.equal(checklist[0].requirement, 'start [[child requirements]] / [child requirements] / [child requirements]')
  assert.deepEqual(rendered.text, compiled.text); assert.deepEqual(semantic, compiled.semantic); assert.deepEqual(checklist, compiled.checklist)
  semantic.children.later.value = 'outside mutation'
  assert.equal(compositionSemantics(ir).children.later.value, 'L😀')
})

test('withholding removes a prose occurrence while preserving the declared semantic requirement and source bindings', async () => {
  const compiled = await compilePrompt(library(), tree(), { withheldPaths: ['root/later'] })
  const ir = JSON.parse(canonical(compiled.composition)), rendered = renderComposition(ir)
  assert.equal(rendered.text, 'start [] / α{{slot:later}} / ')
  assert.equal(compositionSemantics(ir).children.later.value, 'L😀')
  assert.equal(compositionRequirements(ir).find(row => row.path === 'root/later').disclosed, false)
  assert.equal(rendered.sourceMap.filter(row => row.path === 'root/later' && row.start === row.end).length, 2)
  const source = ir.nodes.find(row => row.path === 'root/later')
  assert.match(source.bundle.sha256, /^[a-f0-9]{64}$/); assert.match(source.bundle.rootSha256, /^[a-f0-9]{64}$/)
})

test('corrupt normalized graphs cannot move children, omit requirements, invent ports, override namespaces or change evaluation order implicitly', async () => {
  const { composition } = await compilePrompt(library(), tree())
  for (const mutate of [
    ir => { ir.nodes[0].ports[0].path = 'root/later' },
    ir => { ir.nodes[1].parentPath = 'root/later' },
    ir => { ir.nodes[1].role = 'foreign' },
    ir => { ir.nodes[1].semantic.path = 'root/later' },
    ir => { ir.nodes[1].bundle.sha256 = 'missing' },
    ir => { ir.nodes[0].fragments = ir.nodes[0].fragments.filter(row => row.kind !== 'slot' || row.name !== 'earlier') },
    ir => { ir.nodes[0].fragments.push({ kind: 'slot', name: 'unknown' }) },
    ir => { ir.nodes[0].disclosed = false },
    ir => { ir.nodes.push(structuredClone(ir.nodes[1])) },
    ir => { [ir.nodes[1], ir.nodes[2]] = [ir.nodes[2], ir.nodes[1]] },
  ]) {
    const changed = structuredClone(composition); mutate(changed)
    assert.throws(() => validateComposition(changed), undefined, mutate.toString())
  }
})

test('literal growth and repeated-slot expansion refuse before exceeding the frozen budgets', async () => {
  const { composition } = await compilePrompt(library(), tree())
  const oversized = structuredClone(composition)
  oversized.nodes[1].fragments = [{ kind: 'text', value: 'X'.repeat(2 * 1024 * 1024 + 1) }]
  assert.throws(() => renderComposition(oversized), /text budget/)
  const catalog = [{ id: 'leaf', version: '1', kind: 'atom', text: 'X', semantics: { kind: 'literal' } },
    { id: 'repeat', version: '1', kind: 'template', text: '{{slot:child}}'.repeat(32), slots: { child: 'node' }, semantics: { kind: 'repeat' } }]
  let root = { use: 'leaf' }
  for (let index = 0; index < 4; index++) root = { use: 'repeat', slots: { child: root } }
  await assert.rejects(compilePrompt(catalog, root), /source-map budget/)
})

test('response appendices belong to the same IR as the prompt body and every admissible reading', async () => {
  const spec = informationFixture(); spec.tasks[0].information.responseMode = 'tagged-json'
  const task = await compileTask(spec, spec.tasks[0])
  for (const { compiled } of [task, ...task.interpretations]) {
    assert.equal(renderComposition(compiled.composition).text, compiled.text)
    assert.deepEqual(compositionRequirements(compiled.composition), compiled.checklist)
    assert.equal(compiled.composition.appendices[0].id, 'response-envelope')
    assert.match(compiled.composition.appendices[0].text, /Response format/)
    const range = compiled.sourceMap.at(-1)
    assert.equal(compiled.text.slice(range.start, range.end), compiled.composition.appendices[0].text)
    const corrupt = structuredClone(compiled.composition)
    corrupt.appendices.push(structuredClone(corrupt.appendices[0]))
    assert.throws(() => validateComposition(corrupt), /distinct bounded identities/)
  }
})

test('equivalent object insertion orders produce byte-identical stored IR', async () => {
  const first = library(), second = structuredClone(first)
  first[0].parameters = { value: 'same', extra: 1 }; second[0].parameters = { extra: 1, value: 'same' }
  second[0].semantics = { value: '{{value}}', kind: 'literal' }
  const a = await compilePrompt(first, tree()), b = await compilePrompt(second, tree())
  assert.equal(JSON.stringify(a.composition, null, 2), JSON.stringify(b.composition, null, 2))
})
