// UNRUN. Admitted execution needs one bounded local clone and one Node test child.
// All created files are retained; this test never commits, deletes or launches UI.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { createT842RetainedFixtureRoot } from './lib/t842-retained-fixture-root.mjs'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'

function requiredRoot(name) {
  const value = process.env[name]
  assert.ok(value && path.isAbsolute(value), name + ' must name an admitted absolute directory')
  return ownedFixtureTempRoot({ selected: value })
}
// The clone check needs the root repository's generation tooling (sourceIdentity,
// the check tools/smoke-linux.mjs runs), which an app checkout does not contain.
// The ordinary app runner therefore skips only that case; naming some but not
// all of its inputs is a refusal, never a skip.
const ADMITTED_INPUTS = ['T842_CLEAN_SOURCE_ROOT', 'T842_TOOLING_ROOT', 'T842_ENGINE_ROOT', 'T842_DEPENDENCY_ROOT']
const namedInputs = ADMITTED_INPUTS.filter(name => process.env[name])
assert.ok(namedInputs.length === 0 || namedInputs.length === ADMITTED_INPUTS.length,
  'the native clone check needs all of ' + ADMITTED_INPUTS.join(', ') + '; only ' + namedInputs.join(', ') + ' were given')
const admitted = namedInputs.length === ADMITTED_INPUTS.length
const sourceRoot = admitted ? requiredRoot('T842_CLEAN_SOURCE_ROOT') : null
const toolingRoot = admitted ? requiredRoot('T842_TOOLING_ROOT') : null
const { sourceIdentity } = admitted ? await import(pathToFileURL(
  path.join(toolingRoot, 'tooling', 'live', 'runtime-generation.mjs')).href) : {}
const base = ownedFixtureTempRoot()
const fixture = fs.mkdtempSync(path.join(base, 't842-fixture-root-check-'))
const gitExecutable = process.env.T842_GIT_EXECUTABLE || 'git'
const gitOptions = { gitExecutable }
const engineRoot = admitted ? requiredRoot('T842_ENGINE_ROOT') : null
const cleanEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|SystemRoot|WINDIR|COMSPEC|PATHEXT|LANG|LC_ALL|LC_CTYPE|USERPROFILE|HOMEDRIVE|HOMEPATH|HOME|TEMP|TMP|TMPDIR)$/i.test(key))),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_TERMINAL_PROMPT: '0' }
function child(command, args, options = {}) {
  const { capturePrefix, ...spawnOptions } = options
  const result = spawnSync(command, args, {
    encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
    env: cleanEnv, ...spawnOptions,
  })
  if (capturePrefix) {
    fs.writeFileSync(capturePrefix + '.tap', result.stdout || '', { flag: 'wx' })
    fs.writeFileSync(capturePrefix + '.stderr', result.stderr || '', { flag: 'wx' })
  }
  assert.equal(result.error, undefined, 'child setup or deadline failed: ' + String(result.error))
  assert.equal(result.signal, null, 'child did not exit normally')
  assert.equal(result.status, 0, result.stdout + '\n' + result.stderr)
  return result
}
function inside(parent, target) {
  const relative = path.relative(parent, target)
  return relative === '' || (!relative.startsWith('..' + path.sep)
    && relative !== '..' && !path.isAbsolute(relative))
}

test('retained fixture roots are unique outside source and preserve previous evidence', () => {
  const source = path.join(fixture, 'synthetic-source')
  fs.mkdirSync(source)
  const first = createT842RetainedFixtureRoot({ baseRoot: fixture, sourceRoots: [source] })
  fs.writeFileSync(path.join(first, 'retained.txt'), 'synthetic retained proof', { flag: 'wx' })
  const second = createT842RetainedFixtureRoot({ baseRoot: fixture, sourceRoots: [source] })
  assert.ok(path.isAbsolute(first))
  assert.notEqual(first, second)
  assert.equal(inside(source, first), false)
  assert.equal(inside(source, second), false)
  assert.equal(fs.readFileSync(path.join(first, 'retained.txt'), 'utf8'), 'synthetic retained proof')
})

test('retained fixture roots refuse source-contained and relative inputs before writing', () => {
  const source = path.join(fixture, 'source-refusal')
  fs.mkdirSync(source)
  const before = fs.readdirSync(source)
  assert.throws(() => createT842RetainedFixtureRoot({ baseRoot: source, sourceRoots: [source] }),
    { code: 'T842_FIXTURE_ROOT_IN_SOURCE' })
  assert.deepEqual(fs.readdirSync(source), before)
  assert.throws(() => createT842RetainedFixtureRoot({ baseRoot: 'relative-fixtures', sourceRoots: [source] }),
    /absolute/)
  const checkout = path.join(fixture, 'different-checkout')
  fs.mkdirSync(checkout)
  fs.writeFileSync(path.join(checkout, '.git'), 'synthetic checkout marker', { flag: 'wx' })
  const checkoutBefore = fs.readdirSync(checkout)
  assert.throws(() => createT842RetainedFixtureRoot({ baseRoot: checkout, sourceRoots: [source] }),
    { code: 'T842_FIXTURE_ROOT_IN_CHECKOUT' })
  assert.deepEqual(fs.readdirSync(checkout), checkoutBefore)
})

test('actual native mounted suite leaves generation source clean and smoke still refuses untracked dirt', {
  skip: admitted ? false : 'needs the root tooling clone inputs: ' + ADMITTED_INPUTS.join(', '),
}, () => {
  // Clone only the selected local committed source into this test's fresh root.
  // No source repository, branch or index is modified, and no new commit is made.
  const sourceRef = child(gitExecutable, ['-C', sourceRoot, 'rev-parse', 'HEAD']).stdout.trim()
  const clone = path.join(fixture, 'owned-app')
  child(gitExecutable, ['-c', 'core.hooksPath=', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0',
    'clone', '--quiet', '--local', '--no-hardlinks', '--single-branch', sourceRoot, clone])
  const before = sourceIdentity(fixture, clone, sourceRef, gitOptions)
  // Dependencies are selected separately in the admitted execution plan.
  // The link is ignored by the existing source policy; no new ignore is added.
  const dependencies = requiredRoot('T842_DEPENDENCY_ROOT')
  fs.symlinkSync(dependencies, path.join(clone, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(sourceIdentity(fixture, clone, sourceRef, gitOptions).sha256, before.sha256)
  const temp = path.join(fixture, 'child-temp')
  fs.mkdirSync(temp)
  const environment = { ...cleanEnv, TMPDIR: temp, TEMP: temp, TMP: temp,
    TOOLSENABLED_TEST_STRICT: '1', MC_CANONICAL_ROOT: engineRoot, T842_APP_ROOT: clone,
    T842_COMPONENTS_ROOT: path.join(clone, 'src', 'components.js') }
  // Deliberately exercise the default fixture-root branch, not an override.
  for (const name of Object.keys(environment)) if (/^T842_FIXTURE_ROOT$/i.test(name)) delete environment[name]
  const result = child(process.execPath, [
    '--import', pathToFileURL(path.join(clone, 'tools', 'test', 'lib', 'isolate-native-state-root.mjs')).href,
    '--test', '--test-concurrency=1', '--test-reporter=tap',
    path.join(clone, 'tools', 'test', 't842-native-mounted-composition.test.mjs'),
  ], { cwd: clone, env: environment, capturePrefix: path.join(fixture, 'native-mounted') })
  const tests = Number(/# tests (\d+)(?:\r?\n|$)/.exec(result.stdout)?.[1])
  const passed = Number(/# pass (\d+)(?:\r?\n|$)/.exec(result.stdout)?.[1])
  assert.ok(tests >= 2, 'the complete native suite must execute at least its two existing cases')
  assert.equal(passed, tests)
  assert.match(result.stdout, /# fail 0(?:\r?\n|$)/)
  assert.match(result.stdout, /# skipped 0(?:\r?\n|$)/)
  assert.equal(sourceIdentity(fixture, clone, sourceRef, gitOptions).sha256, before.sha256,
    'successful fixture/test execution must not change or dirty generation source')
  const rows = result.stdout.split(/\r?\n/).filter(line => line.includes('T842_RETAINED_FIXTURE '))
  assert.equal(rows.length, 1)
  const retained = JSON.parse(rows[0].slice(rows[0].indexOf('T842_RETAINED_FIXTURE ') + 'T842_RETAINED_FIXTURE '.length))
  assert.ok(path.isAbsolute(retained.root))
  assert.equal(inside(clone, retained.root), false)
  assert.equal(inside(sourceRoot, retained.root), false)
  assert.ok(fs.statSync(retained.root).isDirectory())
  assert.ok(fs.readdirSync(retained.root).length >= 2, 'both actual suite fixtures remain retained')

  // Negative control is created only in the owned clone, AFTER clean proof.
  // Call the unchanged function used by tools/smoke-linux.mjs.
  const dirt = path.join(clone, 'tools', 'test', 'retained-native-composition-fixtures')
  fs.mkdirSync(dirt)
  fs.writeFileSync(path.join(dirt, 'synthetic-untracked.txt'), 'intentional negative control', { flag: 'wx' })
  assert.throws(() => sourceIdentity(fixture, clone, sourceRef, gitOptions),
    /generation source has uncommitted changes/)
  console.log('T842_SOURCE_CLEAN_PROOF ' + JSON.stringify({
    sourceRef, sourceSha256: before.sha256, retainedRoot: retained.root,
    ownedClone: clone, dirtyNegativeRetained: dirt,
  }))
})
