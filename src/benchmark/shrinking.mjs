// Bounded sequence deletion for diagnostic witnesses. A caller supplies the
// actual property; a shorter input is never evidence merely because it ran.
import { canonical, invariant, object, sha256 } from './prompts.mjs'

export function valueAt(value, path) {
  for (const part of path) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) return { present: false }
    value = value[part]
  }
  return { present: true, value }
}
export function validateValuePath(path) {
  invariant(Array.isArray(path) && path.length <= 32 && path.every(part => typeof part === 'string' && part.length > 0 && part.length <= 256
    && !['__proto__', 'constructor', 'prototype'].includes(part) || Number.isSafeInteger(part) && part >= 0), 'Use a bounded array of literal object keys or array indices.')
}

// Verify the retained deletion certificate against its frozen input and an
// independent outcome verifier. Hash fields are checked for shape here; this
// synchronous function does not recompute digests. The callback must derive
// true, false or null from execution evidence, rather than echo row.preserved.
export function assertSequenceShrink(input, frozenPolicy, result, verifyAttempt) {
  invariant(object(frozenPolicy), 'Supply the frozen shrink policy.')
  const { sequencePath: path, maxEvaluations } = frozenPolicy
  validateValuePath(path)
  invariant(Number.isSafeInteger(maxEvaluations) && maxEvaluations >= 1 && maxEvaluations <= 256
    && typeof verifyAttempt === 'function', 'Declare a bounded shrink budget and an independent attempt verifier.')
  const selected = valueAt(input, path)
  invariant(selected.present && Array.isArray(selected.value) && selected.value.length <= 100000, 'The shrink path must name a bounded input sequence.')
  const sequence = selected.value, originalIndices = sequence.map((_, index) => index)
  invariant(object(result) && result.format === 'benchmark-sequence-shrink' && result.version === 1
    && canonical(result.path) === canonical(path) && result.maxEvaluations === maxEvaluations
    && result.status !== 'unavailable', 'The shrink record differs from its frozen format or policy.')
  const indicesValid = indices => Array.isArray(indices) && indices.length <= sequence.length
    && indices.every((index, position) => Number.isSafeInteger(index) && index >= 0 && index < sequence.length
      && (position === 0 || indices[position - 1] < index))
  const candidate = indices => {
    const retained = indices.map(index => structuredClone(sequence[index]))
    if (path.length === 0) return retained
    const copy = structuredClone(input)
    valueAt(copy, path.slice(0, -1)).value[path.at(-1)] = retained
    return copy
  }
  invariant(result.originalLength === sequence.length && indicesValid(result.keptIndices)
    && result.finalLength === result.keptIndices.length && canonical(result.input) === canonical(candidate(result.keptIndices)),
  'The retained shrink input is not the declared subsequence of the original input.')
  invariant(Array.isArray(result.attempts) && result.attempts.length >= 1 && result.attempts.length <= maxEvaluations
    && result.evaluations === result.attempts.length, 'The shrink evaluation ledger differs from its bounded count.')
  invariant(result.exhausted === false && result.oneMinimal === true, 'The declared witness shrinking did not establish deletion minimality within its budget.')
  const verified = new Map()
  for (let index = 0; index < result.attempts.length; index++) {
    const row = result.attempts[index]
    invariant(object(row) && row.evaluation === index + 1 && indicesValid(row.keptIndices)
      && typeof row.inputSha256 === 'string' && /^[a-f0-9]{64}$/.test(row.inputSha256)
      && [true, false, null].includes(row.preserved)
      && (row.reason === undefined || typeof row.reason === 'string')
      && (row.error === undefined || typeof row.error === 'string' && row.preserved === null),
    'A shrink attempt has invalid indices, numbering, digest shape or outcome.')
    const key = row.keptIndices.join(',')
    invariant(!verified.has(key), 'A shrink candidate was recorded more than once.')
    if (index === 0) invariant(canonical(row.keptIndices) === canonical(originalIndices), 'The shrink ledger must first verify the original input.')
    const preserved = verifyAttempt(row, candidate(row.keptIndices))
    invariant([true, false, null].includes(preserved) && preserved === row.preserved, 'A shrink preservation claim differs from independently verified execution.')
    verified.set(key, preserved)
  }
  invariant(verified.get(originalIndices.join(',')) === true && verified.get(result.keptIndices.join(',')) === true,
    'The original and retained inputs need independently verified diagnostic witnesses.')
  invariant(result.keptIndices.every((_, index) => verified.get(result.keptIndices.slice(0, index).concat(result.keptIndices.slice(index + 1)).join(',')) === false),
    'Every retained-element deletion needs an independently verified false witness result.')
  return result
}

export async function shrinkSequence(input, { path, maxEvaluations = 64, preserves, signal = new AbortController().signal } = {}) {
  validateValuePath(path)
  invariant(Number.isSafeInteger(maxEvaluations) && maxEvaluations >= 1 && maxEvaluations <= 256 && typeof preserves === 'function', 'Declare a bounded shrink budget and a property evaluator.')
  const selected = valueAt(input, path)
  invariant(selected.present && Array.isArray(selected.value) && selected.value.length <= 100000, 'The shrink path must name a bounded input sequence.')
  const sequence = selected.value, originalIndices = sequence.map((_, i) => i), cache = new Map(), attempts = []
  let kept = originalIndices, exhausted = false
  const candidate = indices => {
    if (path.length === 0) return indices.map(index => structuredClone(sequence[index]))
    const copy = structuredClone(input), parent = valueAt(copy, path.slice(0, -1))
    parent.value[path.at(-1)] = indices.map(index => structuredClone(sequence[index]))
    return copy
  }
  const check = async indices => {
    signal.throwIfAborted()
    const key = indices.join(',')
    if (cache.has(key)) return cache.get(key)
    if (attempts.length >= maxEvaluations) { exhausted = true; return null }
    const next = candidate(indices), row = { evaluation: attempts.length + 1, keptIndices: indices, inputSha256: await sha256(canonical(next)) }
    try {
      const result = await preserves(next)
      invariant(typeof result === 'boolean' || object(result) && typeof result.preserved === 'boolean', 'A shrink evaluator must explicitly report whether the witness survives.')
      row.preserved = typeof result === 'boolean' ? result : result.preserved
      if (object(result) && result.reason !== undefined) row.reason = String(result.reason)
      if (object(result) && Object.hasOwn(result, 'evidence')) row.evidence = JSON.parse(canonical(result.evidence))
    } catch (error) {
      signal.throwIfAborted()
      row.preserved = null; row.error = error.message || String(error)
    }
    attempts.push(row); cache.set(key, row.preserved)
    return row.preserved
  }
  invariant(await check(kept) === true, 'The original input does not preserve the declared diagnostic witness.')
  let partitions = 2
  while (kept.length > 0 && !exhausted) {
    const width = Math.max(1, Math.ceil(kept.length / partitions)); let reduced = false
    for (let start = 0; start < kept.length; start += width) {
      const next = kept.slice(0, start).concat(kept.slice(start + width))
      if (await check(next) === true) { kept = next; partitions = Math.max(2, partitions - 1); reduced = true; break }
      if (exhausted) break
    }
    if (reduced) continue
    if (width === 1 || exhausted) break
    partitions = Math.min(kept.length, partitions * 2)
  }
  const oneMinimal = !exhausted && kept.every((_, index) => cache.get(kept.slice(0, index).concat(kept.slice(index + 1)).join(',')) === false)
  return { format: 'benchmark-sequence-shrink', version: 1, path, maxEvaluations, originalLength: sequence.length, finalLength: kept.length,
    keptIndices: kept, input: candidate(kept), evaluations: attempts.length, exhausted, oneMinimal, attempts,
    scope: 'Diagnostic sequence deletions only. Minimality is relative to deleting one retained element and the supplied witness predicate; no new registered test or semantic approval is inferred.' }
}
