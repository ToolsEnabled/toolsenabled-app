import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { SOURCE_MANIFESTS } from '../lib/adapters/source-suite-manifests.mjs'
import { inspectSourceSuite } from '../lib/adapters/source-suites.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const required = [
  'tools/test/chat-rail-live-replay.test.mjs',
  'tools/test/surface-tests-browser-lifecycle.test.mjs',
  'tools/test/surface-tests-journeys.test.mjs',
  'tools/test/chat-reply-user-paths.test.mjs',
  'tools/test/surface-tests-user-path-evidence.test.mjs',
  'tools/test/surface-tests-release-census.test.mjs',
  'tools/test/surface-tests-cli-contract.test.mjs',
  'tools/test/surface-tests-identity-currentness.test.mjs',
  'tools/test/surface-tests-mobile-fra-journeys.test.mjs',
  'tools/test/surface-tests-result-integrity.test.mjs',
]
const selection = inspectSourceSuite('app', { sourceRoots: { app: root } })

for (const file of required) {
  test('release selection requires the executable reply-path suite: ' + path.basename(file), () => {
    assert.deepEqual(SOURCE_MANIFESTS.app.inventory.filter(row => row.file === file),
      [{ file, reason: null }], 'a runnable regression is required, never excluded as an imported helper')
    assert.equal(selection.discovered.filter(found => found === file).length, 1)
    assert.equal(selection.files.filter(found => found === file).length, 1)
    assert.equal(selection.exclusions.some(row => row.file === file), false)
    assert.equal(selection.obligations.some(row => row.id === 'unreconciled-tests' && row.files.includes(file)), false)
  })
}

test('the actual default source-test invocation reaches every registered path suite', () => {
  const { scripts } = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  /* Since an earlier commit the default leaf is tools/run-data-tests.mjs: it keeps the
     package glob visible, expands it itself and hands every selected suite to
     node:test's run() (the T542 source only through its two wrappers). The
     runner's own --print-selection is asked what the default invocation runs. */
  const leaf = scripts['test:data'].split('&&').map(command => command.trim()).find(command => command.startsWith('node tools/run-data-tests.mjs '))
  assert.ok(leaf, 'default source testing must invoke the Node test runner')
  const args = leaf.split(/\s+/).slice(2)
  const pattern = args.find(token => token === 'tools/test/*.test.mjs')
  assert.ok(pattern, 'use the existing default test:data glob, not a new alternate runner')
  const { selected } = JSON.parse(execFileSync(process.execPath, ['tools/run-data-tests.mjs', '--print-selection', ...args],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
  for (const file of required) assert.equal(selected.filter(found => found === file).length, 1, file + ' must be reached by the actual default glob')
})

test('unrelated missing census entries remain explicit execution obligations', () => {
  const expected = new Set(SOURCE_MANIFESTS.app.inventory.map(row => row.file))
  const remaining = selection.discovered.filter(file => !expected.has(file))
  const obligations = selection.obligations.filter(row => row.id === 'unreconciled-tests')
  assert.deepEqual(obligations.flatMap(row => row.files), remaining)
  if (remaining.length) assert.equal(selection.complete, false)
})
