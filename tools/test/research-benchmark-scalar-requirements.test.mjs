import test from 'node:test'
import assert from 'node:assert/strict'
import { catalogMap, compilePrompt } from '../../src/benchmark/prompts.mjs'
import { compositionSemantics, compositionRequirements, renderComposition } from '../../src/benchmark/composition.mjs'
import { genericStarter } from '../../src/benchmark/starters.mjs'
import { freezeStudy, verifyProject } from '../../src/benchmark/study.mjs'

const literal = (explicit = false) => ({ id: 'literal', version: '1', kind: 'atom',
  text: '{{value}}', ...(explicit ? { requirement: '{{value}}' } : {}),
  semantics: { kind: 'literal', value: '{{value}}', nested: ['{{value}}', { value: '{{value}}' }] } })

test('exact numeric, boolean and string placeholders render textual requirements without changing semantic types', async t => {
  for (const explicit of [false, true]) for (const value of [7, 0, true, false, '7']) {
    await t.test((explicit ? 'explicit' : 'fallback') + ' ' + typeof value + ' ' + value, async () => {
      const catalog = [literal(explicit)]; assert.equal(catalogMap(catalog).size, 1)
      const compiled = await compilePrompt(catalog, { use: 'literal', params: { value } })
      const ir = JSON.parse(JSON.stringify(compiled.composition))
      assert.equal(compiled.text, String(value))
      assert.equal(compiled.checklist[0].requirement, String(value))
      assert.equal(typeof ir.nodes[0].requirement, 'string')
      assert.equal(ir.nodes[0].parameters.value, value)
      assert.equal(compiled.semantic.value, value)
      assert.equal(typeof compiled.semantic.value, typeof value)
      assert.deepEqual(compiled.semantic.nested, [value, { value }])
      assert.equal(renderComposition(ir).text, String(value))
      assert.deepEqual(compositionRequirements(ir), compiled.checklist)
      assert.deepEqual(compositionSemantics(ir), compiled.semantic)
    })
  }
})

test('withheld boolean and nested template requirements retain text, semantics and single-pass substitution', async () => {
  const catalog = [literal(), { id: 'wrapper', version: '1', kind: 'template',
    text: '{{slot:child}}', requirement: '{{enabled}}', slots: { child: 'node' },
    semantics: { kind: 'wrapper', enabled: '{{enabled}}' } }]
  const root = { use: 'wrapper', params: { enabled: false }, slots: { child: { use: 'literal', params: { value: true } } } }
  const compiled = await compilePrompt(catalog, root, { withheldPaths: ['root/child'] })
  assert.equal(compiled.text, '')
  assert.equal(compiled.checklist[0].requirement, 'false')
  assert.equal(compiled.checklist[1].requirement, 'true')
  assert.equal(compiled.checklist[1].disclosed, false)
  assert.equal(compiled.semantic.enabled, false)
  assert.equal(compiled.semantic.children.child.value, true)
  const text = '{{slot:child}} {{missing}}'
  const inserted = await compilePrompt([literal()], { use: 'literal', params: { value: text } })
  assert.equal(inserted.text, text); assert.equal(inserted.checklist[0].requirement, text)
  assert.equal(inserted.semantic.value, text)
})

test('a 64-case numeric literal corpus freezes and reconstructs without changing declared answers', async () => {
  const spec = genericStarter(); spec.catalog = [literal()]
  spec.tasks = Array.from({ length: 64 }, (_, value) => ({ id: 'number-' + value,
    root: { use: 'literal', params: { value } }, input: null, expected: String(value), split: 'development' }))
  spec.conditions[0].adapter.responses = Object.fromEntries(spec.tasks.map(task => [task.id, task.expected]))
  const original = structuredClone(spec), project = await freezeStudy(spec)
  assert.equal(project.tasks.length, 64); assert.equal(project.schedule.length, 64)
  for (let value = 0; value < 64; value++) {
    const task = project.tasks[value]
    assert.equal(task.expected, original.tasks[value].expected)
    assert.equal(task.compiled.text, String(value))
    assert.equal(task.compiled.checklist[0].requirement, String(value))
    assert.equal(task.compiled.semantic.value, value)
  }
  assert.deepEqual(spec, original)
  await verifyProject(project)
})
