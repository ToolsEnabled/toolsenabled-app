import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { main } from '../surface-tests.mjs'
import { parseOptions } from '../lib/surface-tests/options.mjs'
import { buildPlan } from '../lib/surface-tests/plan.mjs'

const inertRoot = path.join(process.cwd(), `.surface-tests-cli-contract-${process.pid}`)
const appRoot = path.join(inertRoot, 'app')
const engineRoot = path.join(inertRoot, 'engine')
const out = path.join(inertRoot, 'out')

async function invoke(argv) {
  const chunks = []
  const originalWrite = process.stdout.write
  process.stdout.write = chunk => {
    chunks.push(String(chunk))
    return true
  }
  try {
    const code = await main(argv)
    return { code, output: JSON.parse(chunks.join('')) }
  } finally {
    process.stdout.write = originalWrite
  }
}

test('parser rejects unknown and duplicate selections', () => {
  assert.throws(() => parseOptions(['list', '--only', 'missing-group']))
  assert.throws(() => parseOptions(['list', '--only', 'login,login']))
  assert.throws(() => parseOptions(['list', '--surface', 'source,source']))
})

test('actual list preserves blocked plan rows without starting run prerequisites', async () => {
  const result = await invoke([
    'list',
    '--surface', 'phone',
    '--engine', engineRoot,
    '--out', out,
  ])
  assert.equal(result.code, 0)
  assert.equal(result.output.plan.length, 1)
  assert.equal(result.output.plan[0].id, 'phone')
  assert.match(result.output.plan[0].blocked, /Physical phone/)
  assert.equal('results' in result.output, false)
})

test('run parser requires engine and output while the plan retains prerequisite blockers', () => {
  assert.throws(() => parseOptions(['run']))

  const browser = buildPlan(parseOptions([
    'run',
    '--engine', engineRoot,
    '--out', out,
    '--surface', 'browser',
    '--fixture-cleanup', 'approved',
  ]), appRoot)
  assert.equal(browser.length, 1)
  assert.ok(browser[0].blocked)

  const chat = buildPlan(parseOptions([
    'run',
    '--engine', engineRoot,
    '--out', out,
    '--only', 'chat',
  ]), appRoot)
  assert.deepEqual(chat.map(job => job.id), ['chat'])
  assert.equal(chat[0].blocked, undefined)
})
