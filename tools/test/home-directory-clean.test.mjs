// GUARD: a test run must not create ANY entry in the OS account home.
//
// 5,000+ retained `~/te-source-fixture-XXXXXX` directories accumulated because
// tools/test/lib/isolate-native-state-root.mjs minted one per strict test-FILE
// process directly in the profile root (tools/test/lib/source-fixture-root.mjs's
// prepareRetainedSourceFixture) and, in strict mode, registered no removal --
// not on success and not on the failure path, where the preload can still throw
// AFTER the fixture exists (canonical-root.mjs:104 when MC_CANONICAL_ROOT is
// absent). This guard fails if a single new name appears in the real home.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { SOURCE_FIXTURE_PARENT, sourceFixtureParent } from './lib/source-fixture-root.mjs'

const APP_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const PRELOAD = fileURLToPath(new URL('./lib/isolate-native-state-root.mjs', import.meta.url))
const HELPER = fileURLToPath(new URL('./lib/source-fixture-root.mjs', import.meta.url))
const HOME = os.userInfo().homedir
const homeNames = () => new Set(fs.readdirSync(HOME).map(String))

function scratch(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* scratch */ } })
  return dir
}

// A strict test-FILE process, exactly as npm run test:data spawns one.
function strictPreloadChild(t, extraEnv = {}) {
  const dir = scratch(t, 'te-home-guard-')
  const probe = path.join(dir, 'probe.test.mjs')
  fs.writeFileSync(probe, "import test from 'node:test'\ntest('probe', () => {})\n")
  // node --test marks its file processes with NODE_TEST_CONTEXT; a nested
  // `node --test` that inherits it runs no files and never loads --import.
  const env = { ...process.env, TOOLSENABLED_TEST_STRICT: '1', ...extraEnv }
  delete env.NODE_TEST_CONTEXT
  return spawnSync(process.execPath, ['--test', '--import=' + PRELOAD, probe], {
    encoding: 'utf8', cwd: APP_ROOT, env,
  })
}

// Mints one retained source fixture in its own process and reports it, so the
// assertions do not depend on an engine root being measured for this run.
function fixtureChild(t, extraEnv = {}) {
  const dir = scratch(t, 'te-home-guard-mint-')
  const runner = path.join(dir, 'mint.mjs')
  fs.writeFileSync(runner, [
    "import fs from 'node:fs'",
    "const m = await import(" + JSON.stringify(HELPER) + ")",
    'const { root, environment } = m.prepareRetainedSourceFixture()',
    "fs.mkdirSync(root + '/local-app-data', { recursive: true })",
    "console.log('MINTED ' + JSON.stringify({ root, environment }))",
    "console.log('ALIVE_DURING_RUN ' + fs.existsSync(root))",
    '',
  ].join('\n'))
  const result = spawnSync(process.execPath, [runner], {
    encoding: 'utf8', cwd: APP_ROOT, env: { ...process.env, ...extraEnv },
  })
  const line = result.stdout.split('\n').find(l => l.startsWith('MINTED '))
  assert.ok(line, 'the fixture helper reported nothing: ' + result.stderr)
  return { result, ...JSON.parse(line.slice('MINTED '.length)) }
}

test('a strict test-file process adds nothing to the account home', t => {
  const before = homeNames()
  const ok = strictPreloadChild(t, process.env.MC_CANONICAL_ROOT ? {} : {})
  const added = [...homeNames()].filter(name => !before.has(name)).sort()
  assert.deepEqual(added, [], 'a strict test-file run added ' + added.length +
    ' entrie(s) to ' + HOME + ': ' + added.join(', '))
  assert.match(ok.stdout + ok.stderr, /RETAINED_SOURCE_FIXTURE|MC_CANONICAL_ROOT/, 'the strict child never ran the preload')
})

test('a strict process that FAILS after minting its fixture adds nothing to the account home', t => {
  // The preload throws in canonical-root.mjs once MC_CANONICAL_ROOT is removed,
  // which is after the fixture directory already exists. Cleanup must still run.
  const before = homeNames()
  const env = { ...process.env }
  delete env.MC_CANONICAL_ROOT
  delete env.NODE_TEST_CONTEXT
  const dir = scratch(t, 'te-home-guard-fail-')
  const probe = path.join(dir, 'probe.test.mjs')
  fs.writeFileSync(probe, "import test from 'node:test'\ntest('probe', () => {})\n")
  const failed = spawnSync(process.execPath, ['--test', '--import=' + PRELOAD, probe], {
    encoding: 'utf8', cwd: APP_ROOT, env: { ...env, TOOLSENABLED_TEST_STRICT: '1' },
  })
  assert.match(failed.stdout + failed.stderr, /MC_CANONICAL_ROOT/, 'the strict child never reached the preload failure')
  const added = [...homeNames()].filter(name => !before.has(name)).sort()
  assert.deepEqual(added, [], 'a FAILED strict run left ' + added.join(', ') + ' in ' + HOME)
})

test('a retained fixture lives under the fixture parent, not the account home, and is removed at exit', t => {
  const parent = sourceFixtureParent()
  const before = homeNames()
  const minted = fixtureChild(t)
  assert.equal(path.dirname(minted.root), parent,
    'the fixture root must be a direct child of the fixture parent')
  assert.notEqual(path.dirname(minted.root), HOME,
    'the fixture root must not be a direct child of the account home')
  assert.match(path.basename(minted.root), /^te-source-fixture-[A-Za-z0-9]{6}$/,
    'the retained path shape the gate adapters parse must not change')
  assert.equal(minted.environment.TMPDIR, minted.root, 'the fixture must still own TMPDIR for the run')
  assert.equal(minted.environment.TOOLSENABLED_TEST_RETAIN_FIXTURES, '1',
    'the within-run retention contract must be preserved')
  assert.match(minted.result.stdout, /ALIVE_DURING_RUN true/,
    'the fixture must survive for the lifetime of the run that owns it')
  assert.equal(fs.existsSync(minted.root), false,
    'the fixture was not removed when its run ended')
  assert.deepEqual([...homeNames()].filter(n => !before.has(n)).sort(), [])
})

test('a caller-supplied fixture parent is honoured and left clean', t => {
  const supplied = scratch(t, 'te-home-guard-parent-')
  const before = homeNames()
  const minted = fixtureChild(t, { [SOURCE_FIXTURE_PARENT]: supplied })
  assert.equal(path.dirname(minted.root), fs.realpathSync.native(supplied))
  assert.deepEqual(fs.readdirSync(supplied).map(String), [],
    'the caller-supplied fixture parent was left dirty')
  assert.deepEqual([...homeNames()].filter(n => !before.has(n)).sort(), [],
    'a caller-supplied parent still leaked into ' + HOME)
})

test('an explicit keep request still keeps the fixture, outside the account home', t => {
  const supplied = scratch(t, 'te-home-guard-keep-')
  const before = homeNames()
  const minted = fixtureChild(t, {
    [SOURCE_FIXTURE_PARENT]: supplied, TOOLSENABLED_TEST_SOURCE_FIXTURE_KEEP: '1',
  })
  assert.equal(fs.existsSync(minted.root), true, 'an explicit keep request must retain the fixture')
  assert.deepEqual([...homeNames()].filter(n => !before.has(n)).sort(), [])
})
