import test from 'node:test'
import assert from 'node:assert/strict'
import { canonical } from '../../src/benchmark/prompts.mjs'
import { compileTask } from '../../src/benchmark/tasks.mjs'
import { leanStarter } from '../../src/benchmark/lean.mjs'
import { operationalStarter } from '../../src/benchmark/trading-catalog.mjs'
import { developmentDraft } from './fixtures/research-benchmark-development.mjs'
import { leanInformationFixture } from './fixtures/research-benchmark-information.mjs'

const compile = (spec, task = spec.tasks[0]) => compileTask(spec, task, { requireReview: false, requireTaskReview: false })
// Golden prompt identities were read by portable compilation from sealed
// preparation-stage 9b7eaf38343c54c4a874736154c8d6e19946d3b4. No interpreter,
// native engine, provider or candidate was executed to obtain them.
const legacyHashes = {
  synchronous: '0a5db1edf39adc329d6cf0067d4423104369be2a5755d4e71367dd9d57419189',
  operational: 'f81656eb8ff3c3d5b91c84cd238c92150cc5a89b952895e93494969dfe1342a4',
}
const specimens = async () => [['synchronous', leanStarter()], ['operational', await operationalStarter()]]

test('schema-1 semantic starter prompts keep their exact historical bytes despite the new endpoint contract', async () => {
  for (const [kind, spec] of await specimens()) {
    assert.equal(spec.schemaVersion, 1)
    const task = await compile(spec)
    assert.equal(task.compiled.promptSha256, legacyHashes[kind])
    assert.match(task.compiled.text, /Python source/)
    assert.doesNotMatch(task.compiled.text, /Semantic answer contract/)
  }
})

test('schema-2 JSON grading requests the complete semantic observation and never instructs submission of Python', async () => {
  for (const [kind, legacy] of await specimens()) {
    const spec = developmentDraft(legacy), task = await compile(spec), prompt = task.compiled.text
    assert.equal(spec.protocol.grading.kind, 'json')
    assert.match(prompt, /Return only the complete JSON observation value/)
    assert.match(prompt, /does not execute a submitted program or establish a native engine result/)
    assert.doesNotMatch(prompt, /Return only Python source|Place the Python source|Implement class FrozenBenchmark/)
    assert.equal(prompt.includes(canonical(task.expected)), false, 'The prompt must describe the response contract without providing the private expected observation.')
    if (kind === 'synchronous') {
      assert.match(prompt, /ordered JSON fill array/)
      for (const field of ['bar', 'path', 'symbol', 'quantity', 'priceCents', 'reason']) assert.ok(prompt.includes(field))
    } else {
      for (const field of ['lean-operational-observation', 'orders', 'events', 'lots', 'cashFromFillsCents', 'positionsFromFills', 'feesCents', 'equityCents']) assert.ok(prompt.includes(field))
      assert.match(prompt, /Operational constitution:/)
      assert.match(prompt, /Execution and lifecycle policy:/)
    }
    assert.notEqual(task.compiled.promptSha256, legacyHashes[kind])
  }
})

test('information treatments place JSON semantic observations in the answer envelope while keeping private readings out of the public prompt', async () => {
  const spec = developmentDraft(leanInformationFixture()); spec.tasks[0].information.responseMode = 'tagged-json'
  const task = await compile(spec)
  assert.match(task.compiled.text, /Place the complete JSON observation in the answer field/)
  assert.doesNotMatch(task.compiled.text, /Place the Python source|Return only Python source|Implement class FrozenBenchmark/)
  assert.equal(task.interpretations.length, 2)
  assert.ok(task.interpretations.every(reading => !task.compiled.text.includes(canonical(reading.expected))))
})

test('native candidate grading still requests Python under its separate execution contract', async () => {
  for (const [, legacy] of await specimens()) {
    const spec = developmentDraft(legacy); spec.protocol.grading = { kind: 'lean-python', executionTimeoutMs: 5000 }
    const task = await compile(spec)
    assert.match(task.compiled.text, /Python source/)
    assert.doesNotMatch(task.compiled.text, /Semantic answer contract/)
  }
})
