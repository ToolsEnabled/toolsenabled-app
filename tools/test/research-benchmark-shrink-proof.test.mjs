import assert from 'node:assert/strict'
import test from 'node:test'
import { assertSequenceShrink, shrinkSequence } from '../../src/benchmark/shrinking.mjs'

const input = { fixed: { version: 7 }, items: ['noise', 'a', 'b', 'noise'] }
const policy = { sequencePath: ['items'], maxEvaluations: 32 }
const preserves = candidate => candidate.items.includes('a') && candidate.items.includes('b')
const proof = await shrinkSequence(input, { path: policy.sequencePath, maxEvaluations: policy.maxEvaluations,
  preserves: async candidate => ({ preserved: preserves(candidate), evidence: { observedInput: candidate } }) })
const verify = (row, candidate) => {
  assert.deepEqual(row.evidence.observedInput, candidate)
  return preserves(candidate)
}
const renumber = result => {
  result.attempts.forEach((row, index) => { row.evaluation = index + 1 })
  result.evaluations = result.attempts.length
}

test('a shrink certificate reconstructs every candidate and independently checks its retained outcomes', () => {
  const seen = []
  assert.equal(assertSequenceShrink(input, policy, proof, (row, candidate) => {
    seen.push({ evaluation: row.evaluation, candidate })
    return verify(row, candidate)
  }), proof)
  assert.equal(seen.length, proof.attempts.length)
  assert.deepEqual(seen[0].candidate, input)
  assert.deepEqual(proof.input, { fixed: { version: 7 }, items: ['a', 'b'] })
  assert.deepEqual(input.items, ['noise', 'a', 'b', 'noise'])
  assert.ok(seen.every(row => row.candidate !== input && row.candidate.fixed !== input.fixed))
})

test('the original contradictory deletion-minimal counterexample is rejected', () => {
  const result = { ...structuredClone(proof), originalLength: 987, finalLength: 123, keptIndices: [999],
    input: { offset: 5000, sequence: ['not in original'] }, evaluations: 0, exhausted: true, oneMinimal: true, attempts: [] }
  assert.throws(() => assertSequenceShrink(input, policy, result, verify), /subsequence/)
})

test('frozen policy, lengths, retained indices and non-sequence input fields cannot change', () => {
  for (const change of [
    result => { result.format = 'other' }, result => { result.version = 2 },
    result => { result.path = [] }, result => { result.maxEvaluations++ },
    result => { result.originalLength++ }, result => { result.finalLength++ },
    result => { result.keptIndices = [1, 1] }, result => { result.keptIndices = [2, 1] },
    result => { result.keptIndices = [-1, 2] }, result => { result.keptIndices = [1, 4] },
    result => { result.keptIndices = [1, 2.5] }, result => { result.input.items[0] = 'invented' },
    result => { result.input.fixed.version++ }, result => { result.status = 'unavailable' },
  ]) {
    const result = structuredClone(proof); change(result)
    assert.throws(() => assertSequenceShrink(input, policy, result, verify))
  }
  assert.throws(() => assertSequenceShrink(input, { ...policy, maxEvaluations: 0 }, proof, verify), /budget/)
})

test('attempts have bounded contiguous numbering, unique candidates and shaped digests', () => {
  for (const change of [
    result => { result.evaluations++ }, result => { result.attempts[0].evaluation = 2 },
    result => { result.attempts[0].inputSha256 = 'not a digest' },
    result => { result.attempts[0].keptIndices = [0, 0] },
    result => { result.attempts.push({ ...result.attempts[0] }); renumber(result) },
    result => { result.attempts[0].preserved = 'true' },
    result => { result.attempts[0].error = 'Unavailable while claimed true' },
    result => { result.attempts = []; renumber(result) },
  ]) {
    const result = structuredClone(proof); change(result)
    assert.throws(() => assertSequenceShrink(input, policy, result, verify))
  }
  const tooMany = structuredClone(proof)
  while (tooMany.attempts.length <= policy.maxEvaluations) tooMany.attempts.push(structuredClone(proof.attempts[0]))
  renumber(tooMany)
  assert.throws(() => assertSequenceShrink(input, policy, tooMany, verify), /bounded count/)
})

test('minimality requires original, retained and every single-deletion outcome', () => {
  const keptKey = proof.keptIndices.join(',')
  const neighborKeys = proof.keptIndices.map((_, index) => proof.keptIndices.filter((_, position) => position !== index).join(','))
  for (const removedKey of [proof.attempts[0].keptIndices.join(','), keptKey, ...neighborKeys]) {
    const result = structuredClone(proof)
    result.attempts = result.attempts.filter(row => row.keptIndices.join(',') !== removedKey); renumber(result)
    assert.throws(() => assertSequenceShrink(input, policy, result, verify))
  }
  for (const flag of ['exhausted', 'oneMinimal']) {
    const result = structuredClone(proof); result[flag] = !result[flag]
    assert.throws(() => assertSequenceShrink(input, policy, result, verify), /minimality/)
  }
  const unknown = structuredClone(proof)
  const neighbor = unknown.attempts.find(row => neighborKeys.includes(row.keptIndices.join(',')))
  neighbor.preserved = null; neighbor.error = 'Independent execution unavailable'
  assert.throws(() => assertSequenceShrink(input, policy, unknown, (row, candidate) => row.error ? null : verify(row, candidate)), /every retained-element deletion/i)
})

test('reported preservation and minimality cannot replace the independent synchronous verifier', () => {
  const result = structuredClone(proof)
  result.attempts.find(row => row.preserved === false).preserved = true
  assert.throws(() => assertSequenceShrink(input, policy, result, verify), /independently verified execution/)
  assert.throws(() => assertSequenceShrink(input, policy, proof), /independent attempt verifier/)
  assert.throws(() => assertSequenceShrink(input, policy, proof, () => undefined), /independently verified execution/)
  assert.throws(() => assertSequenceShrink(input, policy, proof, async () => true), /independently verified execution/)
  const changedEvidence = structuredClone(proof)
  changedEvidence.attempts[0].evidence.observedInput.items = []
  assert.throws(() => assertSequenceShrink(input, policy, changedEvidence, verify))
})

test('root sequences and an empty retained witness have valid bounded certificates', async () => {
  const original = [1, 2], frozen = { sequencePath: [], maxEvaluations: 8 }
  const result = await shrinkSequence(original, { path: [], maxEvaluations: 8, preserves: async () => true })
  assert.deepEqual(result.input, []); assert.deepEqual(result.keptIndices, [])
  assert.equal(assertSequenceShrink(original, frozen, result, () => true), result)
  const empty = await shrinkSequence([], { path: [], maxEvaluations: 8, preserves: async () => true })
  assert.equal(empty.attempts.length, 1)
  assert.equal(assertSequenceShrink([], frozen, empty, () => true), empty)
})

test('optional evaluator evidence is retained only when provided and copied at evaluation time', async () => {
  const payload = { reference: { observation: 'original' } }
  const plain = await shrinkSequence([1], { path: [], preserves: async () => true })
  const explicit = await shrinkSequence([1], { path: [], preserves: async () => ({ preserved: true }) })
  assert.deepEqual(explicit, plain)
  assert.ok(plain.attempts.every(row => !Object.hasOwn(row, 'evidence')))
  const retained = await shrinkSequence([1], { path: [], preserves: async () => ({ preserved: true, evidence: payload }) })
  payload.reference.observation = 'later change'
  assert.ok(retained.attempts.every(row => row.evidence.reference.observation === 'original'))
})
