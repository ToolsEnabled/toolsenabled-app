import assert from 'node:assert/strict'
import test from 'node:test'
import { approveBundle, catalogRoots, compilePrompt, createReviewRecord, reviewStatus } from '../../src/benchmark/prompts.mjs'
import { freezeStudy } from '../../src/benchmark/study.mjs'
import { leanStarter } from '../../src/benchmark/lean.mjs'

const catalog = () => [
  { id: 'rule', version: '1', kind: 'atom', text: 'Return {{value}}.', parameters: { value: 2 }, parameterSchema: { value: { type: 'integer', minimum: 1, maximum: 3 } }, dependencies: ['shared'] },
  { id: 'shared', version: '1', kind: 'atom', text: 'Shared rule.', dependencies: ['primitive'] },
  { id: 'primitive', version: '1', kind: 'atom', text: 'Primitive.', hooks: { evaluation: 'primitive-v1' } },
]
async function reviewAll(bundles) { return Promise.all(bundles.map(bundle => createReviewRecord(bundles, bundle.id, 'SYNTHETIC CANONICAL FIXTURE ONLY'))) }

test('shared freeze rejects a wrong LEAN oracle even with current synthetic bundle reviews', async () => {
  const spec = leanStarter()
  spec.reviews = await reviewAll(spec.catalog)
  await freezeStudy(spec)
  spec.tasks[0].expected = []
  await assert.rejects(freezeStudy(spec), /expected trace disagrees/)
})

test('semantic dependency edits invalidate every transitive review and reapproving only the primitive is insufficient', async () => {
  const bundles = catalog(), reviews = await reviewAll(bundles)
  const before = await compilePrompt(bundles, { use: 'rule' }, { reviews, requireReview: true })
  assert.deepEqual(before.bundles.map(row => row.id), ['primitive', 'rule', 'shared'])
  bundles[2].hooks.evaluation = 'primitive-v2'
  for (const bundle of bundles) assert.equal((await reviewStatus(bundle, { catalog: bundles, reviews })).approved, false)
  reviews.push(await createReviewRecord(bundles, 'primitive', 'SYNTHETIC CANONICAL FIXTURE ONLY'))
  await assert.rejects(compilePrompt(bundles, { use: 'rule' }, { reviews, requireReview: true }), /rule needs review/)
  reviews.push(...await reviewAll(bundles))
  const after = await compilePrompt(bundles, { use: 'rule' }, { reviews, requireReview: true })
  assert.notEqual(before.checklist[0].rootSha256, after.checklist[0].rootSha256)
  assert.equal(after.text, before.text)
})

test('dependency reviews are separately required, and a rejection supersedes approval without editing semantic content', async () => {
  const bundles = catalog(), roots = await catalogRoots(bundles)
  const reviews = [await createReviewRecord(bundles, 'rule', 'SYNTHETIC CANONICAL FIXTURE ONLY')]
  await assert.rejects(compilePrompt(bundles, { use: 'rule' }, { reviews, requireReview: true }), /shared needs review/)
  reviews.push(...await reviewAll(bundles))
  reviews.push(await createReviewRecord(bundles, 'rule', 'SYNTHETIC CANONICAL FIXTURE ONLY', { decision: 'rejected' }))
  await assert.rejects(compilePrompt(bundles, { use: 'rule' }, { reviews, requireReview: true }), /rule needs review/)
  assert.deepEqual(await catalogRoots(bundles), roots)
  assert.ok(bundles.every(bundle => !bundle.review))
})

test('missing and cyclic dependencies cannot silently escape the compiler', async () => {
  const missing = catalog(); missing.pop()
  await assert.rejects(compilePrompt(missing, { use: 'rule' }), /Missing semantic dependency/)
  const cycle = catalog(); cycle[2].dependencies = ['rule']
  await assert.rejects(compilePrompt(cycle, { use: 'rule' }), /Cyclic semantic dependency/)
  const duplicate = catalog(); duplicate[0].dependencies = ['shared', 'shared']
  await assert.rejects(compilePrompt(duplicate, { use: 'rule' }), /distinct bundle identifiers/)
})

test('explicit parameter domains reject type, boundary, undeclared and omitted values before rendering', async () => {
  for (const value of [0, 4, 2.5, '2']) await assert.rejects(compilePrompt(catalog(), { use: 'rule', params: { value } }), /value/)
  for (const value of [1, 3]) assert.equal((await compilePrompt(catalog(), { use: 'rule', params: { value } })).text, `Return ${value}.`)
  await assert.rejects(compilePrompt(catalog(), { use: 'rule', params: { invented: 2 } }), /undeclared parameter/)
  const missing = catalog(); delete missing[0].parameters.value
  await assert.rejects(compilePrompt(missing, { use: 'rule' }), /missing parameter value/)
  const unsupported = catalog(); unsupported[0].parameterSchema.value.multipleOf = 2
  await assert.rejects(compilePrompt(unsupported, { use: 'rule' }), /unsupported parameter constraint/)
  await assert.rejects(compilePrompt(catalog(), { use: 'rule', params: [] }), /parameters must be an object/)
})

test('source maps locate repeated child occurrences and Unicode without interpreting inserted tokens', async () => {
  const bundles = [
    { id: 'wrap', version: '1', kind: 'template', text: 'α {{slot:child}} / {{slot:child}} 🧪', slots: { child: 'node' } },
    { id: 'leaf', version: '1', kind: 'atom', text: '{{content}}', parameters: { content: '🧪 {{slot:child}}' } },
  ]
  const compiled = await compilePrompt(bundles, { use: 'wrap', slots: { child: { use: 'leaf' } } })
  assert.equal(compiled.sourceMapUnit, 'UTF-16 code units')
  const ranges = compiled.sourceMap.filter(row => row.path === 'root/child')
  assert.equal(ranges.length, 2)
  assert.ok(ranges[0].end < ranges[1].start)
  for (const range of ranges) {
    assert.equal(compiled.text.slice(range.start, range.end), '🧪 {{slot:child}}')
    assert.equal(range.requirementId, compiled.checklist.find(row => row.path === 'root/child').requirementId)
  }
})

test('recursive repeated wording has an explicit output budget', async () => {
  const bundles = [
    { id: 'double', version: '1', kind: 'template', text: '{{slot:child}}{{slot:child}}', slots: { child: 'node' } },
    { id: 'leaf', version: '1', kind: 'atom', text: 'x'.repeat(90000) },
  ]
  let root = { use: 'leaf' }
  for (let i = 0; i < 6; i++) root = { use: 'double', slots: { child: root } }
  await assert.rejects(compilePrompt(bundles, root), /text budget/)
})

test('legacy self-contained bundle reviews remain valid, but dependency reviews cannot omit their catalog', async () => {
  const bundle = { id: 'one', version: '1', kind: 'atom', text: 'One.' }
  assert.equal((await reviewStatus(await approveBundle(bundle, 'SYNTHETIC FIXTURE ONLY'))).approved, true)
  await assert.rejects(approveBundle(catalog()[0], 'SYNTHETIC FIXTURE ONLY'), /Missing semantic dependency/)
})
