// The reconcile gate must hand pack the commit the binding actually resolved.
//
// R4, 2026-09-24. resolveCapabilitySourceBinding returns the commit as `sourceRef`
// (tools/lib/capability-source-git.mjs). check-payload-boundary-reconciled.mjs read
// `ref` off that binding, which is always `undefined`, and then set
// `TOOLSENABLED_SOURCE_REF: ref` in the child env. Node omits an env key whose value
// is `undefined`, so the gate DELETED a caller-exported TOOLSENABLED_SOURCE_REF and
// pack refused with "the capability source has no exact commit binding" -- the
// documented env-var route could never satisfy pack through this gate.
//
// These tests pin the three facts that made the bug: the binding's key name, Node's
// treatment of an undefined env value, and the env the gate now builds.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { reconcileChildEnvironment } from '../check-payload-boundary-reconciled.mjs'
import { assertCapabilitySourceGitBinding } from '../lib/capability-source-git.mjs'

const COMMIT = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)

test('the child env carries the resolved commit as TOOLSENABLED_SOURCE_REF', () => {
  const env = reconcileChildEnvironment({
    parentEnvironment: { PATH: '/usr/bin' },
    source: '/srv/engine',
    sourceRef: COMMIT,
  })
  assert.equal(env.TOOLSENABLED_SOURCE, '/srv/engine')
  assert.equal(env.TOOLSENABLED_SOURCE_REF, COMMIT)
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.TOOLSENABLED_STATE_ROOT, '')
  assert.equal(env.TOOLSENABLED_VAULT_PATH, '')
})

test('the resolved commit overrides, and never deletes, a caller-exported ref', () => {
  const env = reconcileChildEnvironment({
    parentEnvironment: { TOOLSENABLED_SOURCE_REF: OTHER },
    source: '/srv/engine',
    sourceRef: COMMIT,
  })
  // The key must be present and a real commit. Before the fix this was `undefined`,
  // which Node then dropped, leaving the child with no ref at all.
  assert.equal(typeof env.TOOLSENABLED_SOURCE_REF, 'string')
  assert.equal(env.TOOLSENABLED_SOURCE_REF, COMMIT)
  assert.ok(Object.hasOwn(env, 'TOOLSENABLED_SOURCE_REF'))
})

test('a binding that carries no exact commit refuses by name instead of dropping the key', () => {
  // This is the shape the old code produced: `ref` read off a binding that spells
  // the field `sourceRef`.
  for (const bad of [undefined, null, '', 'HEAD', COMMIT.slice(0, 39)]) {
    assert.throws(
      () => reconcileChildEnvironment({ parentEnvironment: {}, source: '/srv/engine', sourceRef: bad }),
      /exact 40-character commit/,
      `expected a refusal for ${JSON.stringify(bad)}`,
    )
  }
})

test('the binding spells the commit sourceRef, which is why reading `ref` yielded undefined', () => {
  // Read the contract off the real function rather than a copy of it, so a rename
  // of the field breaks this test instead of silently reintroducing the bug.
  const shape = String(assertCapabilitySourceGitBinding)
  assert.match(shape, /sourceRef:/)
  assert.doesNotMatch(shape, /\breturn \{ source: repositoryRoot, ref:/)
})

test('Node drops an env key whose value is undefined, so passing one erases it', () => {
  // The mechanism, proven rather than asserted: this is why the old line was a
  // deletion and not merely a no-op.
  const child = spawnSync(
    process.execPath,
    ['-e', 'process.stdout.write(process.env.TOOLSENABLED_SOURCE_REF === undefined ? "ABSENT" : process.env.TOOLSENABLED_SOURCE_REF)'],
    { env: { ...process.env, TOOLSENABLED_SOURCE_REF: undefined }, encoding: 'utf8' },
  )
  assert.equal(child.status, 0)
  assert.equal(child.stdout, 'ABSENT')
})
