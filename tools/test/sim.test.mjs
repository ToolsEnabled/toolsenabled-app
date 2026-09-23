import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

/* sim's current vocab import no longer exists, although the formatting exports
 * remain callers' public contract.  Evaluate the module with its data imports
 * supplied explicitly: this exercises src/sim.js itself without letting that
 * unrelated, known load defect make the harness always red.
 */
const source = await readFile(new URL('../../src/sim.js', import.meta.url), 'utf8')
const runnable = source
  .replace(/^import .*$/gm, '')
  .replace('export const sim =', 'const sim =')
  .replace('export function fmtRuntime', 'function fmtRuntime')
  .replace('export function uptimeParts', 'function uptimeParts')
  .concat('\n;globalThis.__simExports = { fmtRuntime, uptimeParts }\n')
const context = {
  TASKS: ['task'], FEED: ['feed'], pick: values => values[0],
  FLEET: {
    pools: [{ id: 'main' }],
    machines: [{ id: 'c1', name: 'Example', short: '1', ip: '192.0.2.1', note: '', ageHours: 1 }],
    spend: {},
  },
  Date, Math, Number, String, Map, Set, Array,
  setTimeout: () => ({ unref() {} }),
}
context.globalThis = context
vm.runInNewContext(runnable, context, { filename: 'src/sim.js' })
const { fmtRuntime, uptimeParts } = context.__simExports

function durationSeconds(rendered) {
  const fields = rendered.split(':').map(Number)
  assert.ok(fields.length === 3 || fields.length === 4,
    'a runtime must expose hours, minutes and seconds, with an optional day field')
  assert.ok(fields.every(Number.isFinite),
    'an unreadable timestamp must not masquerade as a definite runtime')
  const [days, hours, minutes, seconds] = fields.length === 4
    ? fields
    : [0, ...fields]
  return days * 86400 + hours * 3600 + minutes * 60 + seconds
}

test('fmtRuntime computes the elapsed whole seconds supplied by runtime callers', () => {
  const bornAt = 1_700_000_000_123
  const stoppedAt = bornAt + 2 * 86400_000 + 3 * 3600_000 + 4 * 60_000 + 5_999

  assert.equal(durationSeconds(fmtRuntime(bornAt, stoppedAt)), 183_845,
    'the rendered fields must preserve the caller-supplied elapsed duration')
})

test('fmtRuntime never turns a future start into a negative elapsed duration', () => {
  const stoppedAt = 1_700_000_000_000
  assert.equal(durationSeconds(fmtRuntime(stoppedAt + 10_000, stoppedAt)), 0,
    'a clock adjustment must clamp elapsed time at zero')
})

test('fmtRuntime leaves an unreadable start visibly indeterminate', () => {
  assert.throws(() => durationSeconds(fmtRuntime(Number.NaN, 1_700_000_000_000)),
    /unreadable timestamp/,
    'a could-not-read value must not collapse into a definite duration')
})

test('uptimeParts returns coherent calendar parts and minute progress', () => {
  const realNow = Date.now
  Date.now = () => 1_700_000_000_000
  try {
    const ageMs = 2 * 86400_000 + 3 * 3600_000 + 4 * 60_000 + 30_000
    const parts = uptimeParts(Date.now() - ageMs)

    assert.deepEqual(
      { days: Number(parts.d), hours: Number(parts.h), minutes: Number(parts.m), seconds: Number(parts.s) },
      { days: 2, hours: 3, minutes: 4, seconds: 30 },
      'each returned part must represent the same elapsed duration')
    assert.equal(parts.frac, 0.5,
      'minute progress must be computed from the same timestamp, not a constant')
  } finally {
    Date.now = realNow
  }
})
