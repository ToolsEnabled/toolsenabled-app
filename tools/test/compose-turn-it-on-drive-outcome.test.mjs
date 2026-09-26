import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const driverSource = readFileSync(new URL('../compose-turn-it-on-drive.mjs', import.meta.url), 'utf8')
const functionSource = driverSource.match(/const READ_OUTCOME_FN = `([\s\S]*?)`\n\nasync function spot/)?.[1]
assert.ok(functionSource, 'the test must exercise READ_OUTCOME_FN from the driver itself')

function readerFor(values) {
  let reads = 0
  const context = {
    localStorage: { getItem: () => values[Math.min(reads++, values.length - 1)] },
    document: { querySelector: () => null },
  }
  return { read: vm.runInNewContext(`(${functionSource})`, context), reads: () => reads }
}

test('an unreadable outcome is not reported as an absent node or latched', () => {
  const subject = readerFor(['{not-json', JSON.stringify({ nodes: [{ status: 'running', sessionId: 's1' }] })])

  const unreadable = subject.read()
  assert.equal(unreadable.error.code, 'OUTCOME_UNREADABLE')
  assert.match(unreadable.error.message, /does not claim that no node was created/i)

  const retry = subject.read()
  assert.equal(retry.error, null, 'a could-not-tell result must not be cached or latched')
  assert.equal(retry.node.hasSession, true)
  assert.equal(subject.reads(), 2)
})

test('control: a genuinely absent storage value remains an absent node', () => {
  const subject = readerFor([null])
  const absent = subject.read()
  assert.equal(absent.node, null)
  assert.equal(absent.status, null)
  assert.equal(absent.error, null)
  assert.equal(subject.reads(), 1)
})
