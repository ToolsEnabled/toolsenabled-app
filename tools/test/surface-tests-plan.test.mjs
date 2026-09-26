import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { buildPlan, batches, overall } from '../lib/surface-tests/plan.mjs'
import { parseOptions } from '../lib/surface-tests/options.mjs'
import { retainedAppSelection } from '../lib/surface-tests/fixture-policy.mjs'

const appRoot = path.resolve('/canonical/app')
const engineRoot = path.resolve('/canonical/engine')
const out = path.resolve('/canonical/out')
const refs = { '--expect-app': 'a'.repeat(40), '--expect-engine': 'b'.repeat(40) }

function options(args = []) {
  return parseOptions(['run', '--engine', engineRoot, '--out', out, '--fixture-cleanup', 'approved', ...args])
}

test('buildPlan creates source counts and full files containing smoke files', () => {
  const smoke = buildPlan(options(['--profile', 'smoke']), appRoot)
  const full = buildPlan(options(['--profile', 'full']), appRoot)
  assert.equal(smoke.length > 0, true)
  assert.equal(full.length, smoke.length)
  for (const job of smoke) {
    const matching = full.find(candidate => candidate.id === job.id)
    assert.deepEqual(job.files.every(file => matching.files.includes(file)), true)
    assert.equal(job.root, job.id === 'packaging' || matching.kind === 'tap' ? appRoot : engineRoot)
  }
})

test('source jobs use argument vectors and app jobs may batch while engine/UI are serial', () => {
  const plan = buildPlan(options(['--only', 'login,remote-ui,fra-identity']), appRoot)
  const login = plan.find(job => job.id === 'login')
  const fra = plan.find(job => job.id === 'fra-identity')
  assert.deepEqual(login.args.slice(0, 4), ['--test', '--import=./tools/test/lib/isolate-native-state-root.mjs', '--test-reporter=tap', '--test-concurrency=1'])
  assert.equal(login.args.includes('tools/test/hosted-browser-signin.test.mjs'), true)
  assert.deepEqual(fra.args, [])
  assert.equal(fra.strategy, 'inert-files')
  const fullFra = buildPlan(options(['--only', 'fra-identity', '--profile', 'full']), appRoot)[0]
  assert.equal(fullFra.args[0], 'tests/run-isolated.js')
  assert.equal(fullFra.args.includes('--summary'), true)
  assert.equal(login.serial, false)
  assert.equal(fra.serial, true)
  assert.deepEqual(batches(plan, 2).map(batch => batch.map(job => job.id)), [['login', 'remote-ui'], ['fra-identity']])
})

test('cleanup approval is an explicit blocker and approval clears it', () => {
  const refused = buildPlan(parseOptions(['run', '--engine', engineRoot, '--out', out]), appRoot)
  assert.equal(refused.filter(job => /cleanup approval/.test(job.blocked)).length, 6)
  assert.deepEqual(refused.filter(job => !job.blocked).map(job => job.id), ['agents', 'chat', 'chat-replies', 'settings', 'layout', 'fra-identity', 'fra-relay', 'fra-authority'])
  const approved = buildPlan(options(['--only', 'login']), appRoot)
  assert.equal(approved[0].blocked, undefined)
})

test('phone is always blocked and never reported as pass', () => {
  const plan = buildPlan(options(['--surface', 'phone', ...Object.entries(refs).flat()]), appRoot)
  assert.match(plan[0].blocked, /Physical phone/)
  assert.equal(overall([{ status: 'PASS' }, { status: 'BLOCKED' }]), 'BLOCKED')
})

test('browser, hosted and packaged plans expose prerequisite blockers', () => {
  const base = ['--expect-app', refs['--expect-app'], '--expect-engine', refs['--expect-engine']]
  const browser = buildPlan(options(['--surface', 'browser', ...base]), appRoot)
  assert.match(browser[0].blocked, /playwright-root/)
  const hosted = buildPlan(options(['--surface', 'hosted', '--playwright-root', path.resolve('/pw'), ...base]), appRoot)
  assert.match(hosted[0].blocked, /origin/)
  const packaged = buildPlan(options(['--surface', 'packaged', ...base]), appRoot)
  assert.match(packaged[0].blocked, /release/)
  const ready = buildPlan(options(['--surface', 'browser', ...base, '--release', path.resolve('/release'), '--playwright-root', path.resolve('/pw')]), appRoot)
  assert.equal(ready[0].blocked, undefined)
})

test('overall status is FAIL, BLOCKED, PASS with omitted rows blocked', () => {
  assert.equal(overall([]), 'BLOCKED')
  assert.equal(overall([{ status: 'PASS' }, { status: 'FAIL' }]), 'FAIL')
  assert.equal(overall([{ status: 'PASS' }, { status: 'BLOCKED' }]), 'BLOCKED')
  assert.equal(overall([{ status: 'PASS' }, { status: 'PASS' }]), 'PASS')
})

test('retained policy permits only reviewed App files, never expands to new suites or engine files', () => {
  assert.equal(retainedAppSelection('app', ['tools/test/chat-enter-repeat.test.mjs']), true)
  for (const [repo, files] of [
    ['engine', ['tools/test/chat-enter-repeat.test.mjs']],
    ['app', []], ['app', ['tools/test/future-suite.test.mjs']],
    ['app', ['tools/test/quick-settings-storage.test.mjs', 'tools/test/product-settings-batch.test.mjs']],
  ]) assert.equal(retainedAppSelection(repo, files), false)
  const plan = buildPlan(parseOptions(['list', '--profile', 'full', '--only', 'chat,layout,settings']), appRoot)
  assert.deepEqual(plan.filter(job => !job.blocked).map(job => job.id), ['chat', 'layout'])
  assert.match(plan.find(job => job.id === 'settings').blocked, /cleanup approval/)
  assert.equal(plan.find(job => job.id === 'chat').fixturePolicy, 'retained-source-profile')
})
