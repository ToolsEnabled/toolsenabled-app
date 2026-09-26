import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  ENGINE_MARKER,
  PROJECT_ROOT,
  STAGED_ENGINE_ROOT,
  candidateRoots,
  canonicalRootForTests,
  discoverCanonicalRoot,
  noteEngineRootOutsideCheckout,
  resetEngineRootWarning,
} from '../canonical-root.mjs'

test('the legacy integration override is explicit and wins without probing elsewhere', () => {
  const env = {
    MC_CANONICAL_ROOT: 'Z:\\selected-engine',
    TOOLSENABLED_SOURCE: 'Z:\\different-engine',
  }
  const probed = []
  const result = discoverCanonicalRoot({
    env,
    setting: { path: 'Z:\\third-engine' },
    probe: path => { probed.push(path); return false },
  })
  assert.equal(result.source, 'env:MC_CANONICAL_ROOT')
  assert.equal(result.root, resolve(env.MC_CANONICAL_ROOT))
  assert.equal(result.found, false)
  assert.deepEqual(probed, [join(result.root, ENGINE_MARKER)])
})

test('release automation source is used when the legacy override is absent', () => {
  const selected = 'Z:\\release-engine'
  const result = discoverCanonicalRoot({
    env: { TOOLSENABLED_SOURCE: selected },
    setting: { path: 'Z:\\owner-engine' },
    probe: path => path === join(resolve(selected), ENGINE_MARKER),
  })
  assert.equal(result.source, 'env:TOOLSENABLED_SOURCE')
  assert.equal(result.root, resolve(selected))
  assert.equal(result.found, true)
})

test('the ignored owner setting is the only implicit integration source', () => {
  const selected = 'Z:\\owner-selected-engine'
  const roots = candidateRoots({ env: {}, setting: { path: selected, ref: null } })
  assert.deepEqual(roots, [{
    source: 'private/capability-source.owner.json',
    root: resolve(selected),
  }])
  const result = discoverCanonicalRoot({
    env: {},
    setting: { path: selected, ref: null },
    probe: path => path === join(resolve(selected), ENGINE_MARKER),
  })
  assert.equal(result.found, true)
})

test('no declaration probes no sibling, Desktop, or historical repository name', () => {
  const probed = []
  const roots = candidateRoots({ env: {}, setting: null })
  const result = discoverCanonicalRoot({
    env: {},
    setting: null,
    probe: path => { probed.push(path); return true },
  })
  assert.deepEqual(roots, [])
  assert.deepEqual(probed, [])
  assert.deepEqual(result, { root: PROJECT_ROOT, source: 'unconfigured', found: false })
})

test('an engine root from another checkout is REPORTED, not refused', () => {
  /* This was a refusal. It is a warning because capability-index-pack-gate needs
     the engine's build tooling, which the packed capability/ layer does not ship:
     refusing anything but the staged layer made that suite unrunnable. */
  const foreign = 'Z:\\some-other-project\\engine'
  const said = []
  resetEngineRootWarning()
  const got = noteEngineRootOutsideCheckout(foreign, 'env:MC_CANONICAL_ROOT', { warn: m => said.push(m) })

  assert.equal(got, foreign, 'the caller must still receive the root it declared')
  assert.equal(said.length, 1)
  assert.ok(said[0].includes(resolve(foreign)), 'the declared root must be named')
  assert.ok(said[0].includes(STAGED_ENGINE_ROOT), 'the staged root must be named')
  assert.ok(said[0].includes(PROJECT_ROOT), 'the app checkout must be named')
})

test('the warning is printed once, not once per suite that asks', () => {
  const said = []
  resetEngineRootWarning()
  for (let i = 0; i < 3; i += 1) {
    noteEngineRootOutsideCheckout('Z:\\other\\engine', 'env:MC_CANONICAL_ROOT', { warn: m => said.push(m) })
  }
  assert.equal(said.length, 1, 'a per-call warning would bury every suite in repeats')
})

test('the staged engine root is never warned about', () => {
  const said = []
  resetEngineRootWarning()
  assert.equal(
    noteEngineRootOutsideCheckout(STAGED_ENGINE_ROOT, 'unconfigured', { warn: m => said.push(m) }),
    STAGED_ENGINE_ROOT)
  assert.deepEqual(said, [])
})

test('the staged engine is accepted, and an unconfigured lookup lands where the suites look', () => {
  /* Suites resolve `MC_CANONICAL_ROOT || join(root, 'capability')`. Unconfigured,
     canonicalRootForTests() must agree with that, not return PROJECT_ROOT. This
     alignment is the half of the guard that survived narrowing: it is what
     repaired agent-host-real-start-cancellation. */
  resetEngineRootWarning()
  assert.equal(canonicalRootForTests({ env: {}, setting: null, probe: () => true }), STAGED_ENGINE_ROOT)
  assert.equal(STAGED_ENGINE_ROOT, join(PROJECT_ROOT, 'capability'))
})

test('the current explicit owner setting resolves when this release workspace provides one', (t) => {
  const roots = candidateRoots()
  if (roots.length === 0) {
    return t.skip('No explicit private capability source is configured in this clone.')
  }
  const result = discoverCanonicalRoot()
  assert.equal(result.found, true,
    `configured engine ${result.root} does not hold ${ENGINE_MARKER}`)
  assert.ok(existsSync(join(result.root, ENGINE_MARKER)))
})

test('source qualification refuses an absent or unusable selected Engine instead of staged fallback', () => {
  const options = { env: { TOOLSENABLED_TEST_STRICT: '1' }, setting: { path: 'owner-engine' }, probe: () => true }
  assert.throws(() => canonicalRootForTests(options), /qualification.*MC_CANONICAL_ROOT/)
  assert.throws(() => canonicalRootForTests({ ...options, env: { ...options.env, MC_CANONICAL_ROOT: 'missing-engine' }, probe: () => false }), /selected Engine.*missing/)
  assert.throws(() => canonicalRootForTests({ env: {}, setting: null, requireConfigured: true }), /configured Engine/)
  assert.equal(canonicalRootForTests({ env: {}, setting: { path: 'selected-engine' }, requireConfigured: true, probe: () => true, warn: () => {} }), resolve('selected-engine'))
})
