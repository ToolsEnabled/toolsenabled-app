import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { SOURCE_MANIFESTS } from '../lib/adapters/source-suite-manifests.mjs'
import * as source from '../lib/adapters/source-suites.mjs'
import { reconcileSourceCommands } from '../lib/adapters/source-command-plan.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const alias = 'test:surface-runner'
const command = ['node', '--test', 'tools/test/surface-tests-*.test.mjs']
const selection = source.inspectSourceSuite('app', { sourceRoots: { app: root } })

test('actual surface-runner alias matches the fixed source contract', () => {
  assert.equal(selection.aliases[alias], command.join(' '))
  assert.equal(SOURCE_MANIFESTS.app.aliases[alias], selection.aliases[alias])
  assert.equal(selection.obligations.some(row => row.id === 'changed-required-aliases' && row.aliases.includes(alias)), false)
})

test('actual surface-runner command is mapped to all required direct test leaves', () => {
  assert.ok(selection.commandPlan.actions.some(row => row.alias === alias && JSON.stringify(row.command) === JSON.stringify(command)))
  assert.deepEqual(selection.obligations.filter(row => row.alias === alias), [])
  const ownFile = 'tools/test/surface-tests-command-census.test.mjs'
  assert.ok(selection.files.includes(ownFile), 'this regression is a required executable census leaf')
})

const first = 'tools/test/surface-tests-catalog.test.mjs'
const second = 'tools/test/surface-tests-plan.test.mjs'

test('the fixed glob maps only after every actual direct match is selected', () => {
  assert.deepEqual(source.appSurfaceRunnerCoverage([first, second, 'tools/test/unrelated.test.mjs'], [first, second]), [command])
})

test('an omitted or excluded matching suite leaves the command unmapped', () => {
  for (const selected of [[first], [second], []]) {
    const coveredCommands = source.appSurfaceRunnerCoverage([first, second], selected)
    assert.deepEqual(coveredCommands, [])
    const result = reconcileSourceCommands({ aliases: { [alias]: command.join(' ') }, selectedFiles: selected, coveredCommands })
    assert.ok(result.obligations.some(row => row.id === 'unmapped-required-command' && row.alias === alias))
  }
})

test('an empty glob cannot discharge the required command', () => {
  assert.deepEqual(source.appSurfaceRunnerCoverage([], [first]), [])
  assert.deepEqual(source.appSurfaceRunnerCoverage(['tools/test/unrelated.test.mjs'], [first]), [])
})

test('direct glob coverage does not manufacture nested test selection', () => {
  const nested = 'tools/test/nested/surface-tests-hidden.test.mjs'
  assert.deepEqual(source.appSurfaceRunnerCoverage([nested], [nested]), [])
  assert.deepEqual(source.appSurfaceRunnerCoverage([first, nested], [first]), [command])
})

test('changed flags and runner modes retain their own execution obligation', () => {
  for (const altered of [
    'node --test --test-only tools/test/surface-tests-*.test.mjs',
    'node --test tools/test/surface-tests-*.test.mjs --test-name-pattern=smoke',
    'node tools/surface-tests.mjs run',
  ]) {
    const result = reconcileSourceCommands({ aliases: { [alias]: altered }, selectedFiles: [first],
      coveredCommands: source.appSurfaceRunnerCoverage([first], [first]) })
    assert.ok(result.obligations.some(row => row.id === 'unmapped-required-command' && row.alias === alias), altered)
  }
})

test('help-only surface CLI entry is never credited as test execution', () => {
  const result = reconcileSourceCommands({ aliases: { 'test:surfaces': 'node tools/surface-tests.mjs' },
    selectedFiles: [first], coveredCommands: source.appSurfaceRunnerCoverage([first], [first]) })
  assert.deepEqual(result.obligations, [{
    id: 'unmapped-required-command', alias: 'test:surfaces', command: ['node', 'tools/surface-tests.mjs'],
  }])
})

test('retained gate fixture leaf and helper have explicit census ownership', () => {
  const leaf = 'tools/test/retained-gate-fixture-root.test.mjs'
  const helper = 'tools/test/lib/retained-gate-fixture-root.mjs'
  const inventory = SOURCE_MANIFESTS.app.inventory
  assert.deepEqual(inventory.filter(row => row.file === leaf), [{ file: leaf, reason: null }])
  assert.deepEqual(inventory.filter(row => row.file === helper), [{ file: helper, reason: 'imported-fixture-helper' }])
  assert.ok(selection.files.includes(leaf), 'the allocator regression is a required test execution')
  assert.equal(selection.files.includes(helper), false, 'an imported helper is measured without a standalone execution')
  assert.deepEqual(selection.obligations.filter(row =>
    ['missing-tests', 'unreconciled-tests'].includes(row.id)
      && row.files.some(file => file === leaf || file === helper)), [])
})
