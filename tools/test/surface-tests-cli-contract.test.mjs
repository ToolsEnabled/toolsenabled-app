import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { main } from '../surface-tests.mjs'
import { parseOptions } from '../lib/surface-tests/options.mjs'
import { buildPlan } from '../lib/surface-tests/plan.mjs'

const inertRoot = path.join(process.cwd(), `.surface-tests-cli-contract-${process.pid}`)
const appRoot = path.join(inertRoot, 'app')
const engineRoot = path.join(inertRoot, 'engine')
const out = path.join(inertRoot, 'out')

async function invoke(argv, { json = true } = {}) {
  const chunks = []
  const originalWrite = process.stdout.write
  process.stdout.write = chunk => {
    chunks.push(String(chunk))
    return true
  }
  try {
    const code = await main(argv)
    const output = chunks.join('')
    return { code, output: json ? JSON.parse(output) : output }
  } finally {
    process.stdout.write = originalWrite
  }
}

test('the actual developer surface alias dispatches help without starting a surface run', async () => {
  const scripts = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).scripts
  const command = scripts.surfaces.split(' ')
  assert.deepEqual(command, ['node', 'tools/surface-tests.mjs'])
  assert.equal(parseOptions(command.slice(2)).command, 'help')
  const result = await invoke(command.slice(2), { json: false })
  assert.equal(result.code, 0)
  assert.match(result.output, /^Usage: node tools\/surface-tests\.mjs paths\|list\|run/)
  assert.match(result.output, /Required for run; preserves logs and profiles/)
  assert.equal(existsSync(inertRoot), false, 'help must not allocate run output or profiles')
})

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
