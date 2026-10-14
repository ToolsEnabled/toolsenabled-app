// T154. The qualification context is compared to the cut's real build inputs
// BEFORE the build worktree is created and before `npm run dist`.
//
// These call the exported predicate with values and assert what it DOES: which
// field it names, and that it names both the value it found and the value the
// cut derived. They deliberately do not pin the sentence around those values --
// a better message must not fail this suite.
//
// The reason this check exists as a separate lexical comparison, rather than as
// an earlier call to readQualificationContext(), is asserted here too: the
// expected stage root does not exist yet at the moment the check runs, and an
// lstat-based check therefore cannot answer the question at that point.

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { assertQualificationContextLocations } from '../release-packager/cut-release-candidate.mjs'

const APP = path.join(os.tmpdir(), 'w54-build-dir')
const STAGE = path.join(APP, 'release', 'win-unpacked')
const HARNESS = path.join(os.tmpdir(), 'w54-harness')
const EVIDENCE = path.join(os.tmpdir(), 'w54-evidence')
const ENGINE = path.join(os.tmpdir(), 'w54-engine')

function expected(overrides = {}) {
  return {
    sourceRoots: { app: APP },
    stageRoot: STAGE,
    harnessRoot: HARNESS,
    evidenceRoot: EVIDENCE,
    ...overrides,
  }
}

function context(overrides = {}) {
  return {
    sourceRoots: { app: APP, engine: ENGINE },
    stageRoot: STAGE,
    harnessRoot: HARNESS,
    evidenceRoot: EVIDENCE,
    ...overrides,
  }
}

// Serve the context from memory: the point of this check is that it needs no
// directory to exist, so a test that had to create them would hide the defect.
function reading(value) {
  return async () => (typeof value === 'string' ? value : JSON.stringify(value))
}

async function refusal(contextValue, expectedValue = expected()) {
  const error = await assertQualificationContextLocations('context.json', expectedValue, { read: reading(contextValue) })
    .then(() => null, (thrown) => thrown)
  assert.ok(error instanceof Error, 'a mismatched qualification context must refuse, not return')
  return error.message
}

test('a context that names every real build input is accepted', async () => {
  assert.equal(
    await assertQualificationContextLocations('context.json', expected(), { read: reading(context()) }),
    true,
  )
})

test('the check does not require the roots it compares to exist yet', async () => {
  // This is the whole reason the comparison is repeated instead of moved: at
  // the point it runs, <build-dir>/release/win-unpacked has not been created.
  assert.equal(existsSync(STAGE), false, 'this fixture stage root must not exist for the assertion below to mean anything')
  assert.equal(
    await assertQualificationContextLocations('context.json', expected(), { read: reading(context()) }),
    true,
  )
})

test('a wrong harnessRoot refuses and names the field, the value found and the value expected', async () => {
  const wrong = path.join(HARNESS, 'tools')
  const message = await refusal(context({ harnessRoot: wrong }))
  assert.match(message, /harnessRoot/)
  assert.ok(message.includes(wrong), 'the refusal must quote the value the context file carries')
  assert.ok(message.includes(HARNESS), 'the refusal must quote the value this cut derived')
})

test('a wrong sourceRoots.app refuses and names that field, not a generic one', async () => {
  const wrong = path.join(os.tmpdir(), 'w54-some-other-landing')
  const message = await refusal(context({ sourceRoots: { app: wrong, engine: ENGINE } }))
  assert.match(message, /sourceRoots\.app/)
  assert.ok(message.includes(wrong))
  assert.ok(message.includes(APP))
})

test('a wrong stageRoot refuses -- naming the durable staging root is not the unpacked stage', async () => {
  const wrong = path.join(os.tmpdir(), 'w54-stage-20260916')
  const message = await refusal(context({ stageRoot: wrong }))
  assert.match(message, /stageRoot/)
  assert.ok(message.includes(wrong))
  assert.ok(message.includes(STAGE))
})

test('a wrong evidenceRoot refuses', async () => {
  const wrong = path.join(os.tmpdir(), 'w54-other-evidence')
  const message = await refusal(context({ evidenceRoot: wrong }))
  assert.match(message, /evidenceRoot/)
  assert.ok(message.includes(wrong))
  assert.ok(message.includes(EVIDENCE))
})

test('an absent field refuses by name rather than passing as undefined', async () => {
  const without = context()
  delete without.harnessRoot
  const message = await refusal(without)
  assert.match(message, /harnessRoot/)
  assert.ok(message.includes(HARNESS), 'the refusal must still say what was expected')
})

test('a differently spelled but equivalent path is accepted, because the predicate compares paths', async () => {
  assert.equal(
    await assertQualificationContextLocations('context.json', expected(), {
      read: reading(context({ harnessRoot: path.join(HARNESS, 'unused', '..') })),
    }),
    true,
  )
})

test('a context that is not JSON refuses without claiming the locations agree', async () => {
  const message = await refusal('this is not json')
  assert.ok(!/agree/i.test(message))
  assert.match(message, /context\.json/)
})

test('a context that is a JSON array refuses', async () => {
  const message = await refusal([APP, STAGE])
  assert.match(message, /context\.json/)
})

test('a relative derived location refuses rather than comparing something the late check would reject', async () => {
  const message = await refusal(context(), expected({ harnessRoot: path.join('.', 'relative-harness') }))
  assert.match(message, /harnessRoot/)
})

test('the check reads the file it is given, from disk, not a caller-supplied object', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'w54-t154-'))
  const file = path.join(dir, 'qualification-context.json')
  await writeFile(file, JSON.stringify(context(), null, 2))
  assert.equal(await assertQualificationContextLocations(file, expected()), true)

  await writeFile(file, JSON.stringify(context({ harnessRoot: path.join(HARNESS, 'tools') }), null, 2))
  await assert.rejects(() => assertQualificationContextLocations(file, expected()), /harnessRoot/)
})
