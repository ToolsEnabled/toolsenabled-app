import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GROUPS, SURFACES, selectGroups } from '../lib/surface-tests/catalog.mjs'
import { retainedAppSelection } from '../lib/surface-tests/fixture-policy.mjs'
import { parseOptions } from '../lib/surface-tests/options.mjs'
import { canonicalRootForTests } from '../canonical-root.mjs'
import { readCapabilitySourceSetting } from '../lib/capability-source-git.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const throws = (argv, message) => assert.throws(() => parseOptions(argv), new RegExp(message))

test('accepts defaults and selection', () => {
  assert.equal(parseOptions(['help']).profile, 'smoke')
  assert.deepEqual(parseOptions(['list', '--profile', 'full', '--only', 'fra-identity']).only, ['fra-identity'])
  assert.deepEqual(parseOptions(['list', '--surface', 'all']).surfaces, SURFACES)
  assert.deepEqual(selectGroups('full', ['inspector']).map(g => g.id), ['inspector'])
})

test('selects the retained T890 chat-replies source suites in both profiles', () => {
  const expected = [
    'tools/test/chat-final-after-tools.test.mjs',
    'tools/test/chat-rail-live-replay.test.mjs',
    'tools/test/tree-chat-resume-stream.test.mjs',
    'tools/test/chat-whole-output-currentness.test.mjs',
    'tools/test/tree-empty-turn-transcript.test.mjs',
    'tools/test/native-session-reconnect-renderer.test.mjs',
    'tools/test/chat-owner-line-precedes-its-reply.test.mjs',
    'tools/test/session-text-reader.test.mjs',
  ]
  const expectedFull = [...expected, 'tools/test/chat-reply-user-paths.test.mjs']
  const smoke = selectGroups('smoke', ['chat-replies'])[0]
  const full = selectGroups('full', ['chat-replies'])[0]
  assert.equal(smoke.repo, 'app')
  assert.equal(smoke.surface, 'source')
  assert.deepEqual(smoke.files, expected)
  assert.deepEqual(full.files, expectedFull)
  assert.equal(smoke.files.includes('tools/test/chat-reply-user-paths.test.mjs'), false)
  assert.equal(retainedAppSelection('app', smoke.files), true)
  assert.equal(retainedAppSelection('app', full.files), true)
  for (const feature of ['final reply after tools', 'live rail replay', 'native reconnect renderer', 'session text reconciliation', 'completed close/reopen, node switch, mid-tools arrival']) {
    assert.equal(smoke.features.includes(feature), true, `missing chat-replies description: ${feature}`)
  }
})

test('rejects invalid and duplicate options', () => {
  throws(['wat'], 'use help')
  throws(['list', '--nope', 'x'], 'invalid or duplicate option')
  throws(['list', '--profile', 'smoke', '--profile', 'full'], 'invalid or duplicate option')
  throws(['list', '--profile'], 'invalid or duplicate option')
  throws(['list', '--surface', 'source,source'], 'unknown or duplicate surface')
  throws(['list', '--surface', 'unknown'], 'unknown or duplicate surface')
  throws(['list', '--only', 'missing-group'], 'unknown group')
  throws(['list', '--only', 'fra-identity,fra-identity'], 'duplicate')
  throws(['list', '--profile', 'bad'], 'profile must be smoke or full')
})

test('enforces numeric bounds and absolute paths', () => {
  for (const flag of ['jobs', 'budget-ms', 'timeout-ms']) {
    throws(['list', '--' + flag, '0'], 'invalid --' + flag)
    throws(['list', '--' + flag, '1.5'], 'invalid --' + flag)
    throws(['list', '--' + flag, 'not-a-number'], 'invalid --' + flag)
  }
  throws(['list', '--jobs', '3'], 'invalid --jobs')
  throws(['list', '--budget-ms', '7200001'], 'invalid --budget-ms')
  throws(['list', '--timeout-ms', '900001'], 'invalid --timeout-ms')
  for (const flag of ['engine', 'out', 'release', 'playwright-root', 'browsers-path']) {
    throws(['list', '--' + flag, 'relative'], '--' + flag + ' must be absolute')
  }
  assert.equal(parseOptions(['list', '--jobs', '2', '--budget-ms', '1000', '--timeout-ms', '900000']).jobs, 2)
})

test('validates refs, run requirements, origin and release exclusion', () => {
  const ref = 'a'.repeat(40)
  const absolute = path.resolve('engine')
  const parsed = parseOptions(['run', '--engine', absolute, '--out', path.resolve('out'), '--expect-app', ref, '--expect-engine', ref])
  assert.equal(parsed['expect-app'], ref)
  assert.equal(parsed['expect-engine'], ref)
  throws(['run'], 'run requires')
  throws(['run', '--engine', '/engine', '--out', '/out', '--expect-app', 'abc'], 'full commit')
  throws(['list', '--release', '/release', '--origin', 'https://example.test'], 'cannot be mixed')
  for (const origin of ['https://u:p@example.test/', 'https://example.test/path', 'https://example.test/?q=1', 'ftp://example.test/']) {
    throws(['list', '--origin', origin], 'credential-free HTTP')
  }
  assert.equal(parseOptions(['list', '--origin', 'https://example.test/']).origin, 'https://example.test')
})

test('validates mount defaults', () => {
  assert.equal(parseOptions(['list']).mount, '/app/')
  assert.equal(parseOptions(['list', '--mount', '/safe/path/']).mount, '/safe/path/')
  throws(['list', '--mount', 'relative/'], 'absolute slash-terminated')
  throws(['list', '--mount', '/missing-trailing'], 'absolute slash-terminated')
})

test('all catalog files exist and groups have no duplicate files', () => {
  // This is an inventory of SOURCE tests, which the packed engine omits.
  // The builder's explicit paired-source binding remains distinct from
  // MC_CANONICAL_ROOT, which selects runtime modules in packaged checks.
  const source = process.env.TOOLSENABLED_SOURCE || readCapabilitySourceSetting(root)?.path
  const roots = { app: root, engine: source ? path.resolve(source) : canonicalRootForTests({ requireConfigured: true }) }
  const all = []
  for (const group of GROUPS) {
    const smoke = group.smoke
    const files = group.full
    assert.ok(files.length > 0, group.id + ' full is empty')
    assert.equal(new Set(files).size, files.length, group.id + ' full duplicates files')
    for (const file of smoke) assert.ok(files.includes(file), group.id + ' full omits smoke file ' + file)
    for (const file of files) {
      all.push(group.repo + '/' + file)
      assert.equal(fs.existsSync(path.join(roots[group.repo], file)), true, group.id + ': missing ' + file)
    }
  }
  assert.equal(new Set(all).size, all.length, 'catalog files duplicate across groups')
})
