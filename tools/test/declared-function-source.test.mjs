import assert from 'node:assert/strict'
import { test } from 'node:test'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'

test('extracts the complete real declaration without prescribing its parameters', () => {
  const source = [
    'const before = 1',
    '  function selected(id, { value = { answer: 7 } } = {}) {',
    '    /* } premature close */',
    '    const label = `item } ${id}`',
    "    const brace = /}/.test('}')",
    '    return { label, answer: value.answer, brace }',
    '  }',
    "throw new Error('must not be included')",
  ].join('\n')
  const extracted = declaredFunctionSource(source, 'selected')
  const selected = new Function(`return (${extracted})`)()
  assert.deepEqual(selected('one'), { label: 'item } one', answer: 7, brace: true })
  assert.deepEqual(selected('two', { value: { answer: 9 } }).answer, 9)
})

test('preserves async declarations and multiline default parameters without executing them', async () => {
  const source = 'async function selected(\n value = (() => { throw new Error("default") })()\n) { return value }'
  const selected = new Function(`return (${declaredFunctionSource(source, 'selected')})`)()
  assert.equal(await selected(3), 3)
  await assert.rejects(selected(), /default/)
})

test('refuses absent, duplicate and incomplete declarations', () => {
  assert.throws(() => declaredFunctionSource('function another() {}', 'selected'), /found 0/)
  assert.throws(() => declaredFunctionSource('function selected() {}\nfunction selected() {}', 'selected'), /found 2/)
  assert.throws(() => declaredFunctionSource('function selected({ value = {} } = {}) {', 'selected'), /No complete/)
  assert.throws(() => declaredFunctionSource('', 'bad()'), /Invalid function name/)
})
