// THE CUT'S WINDOWS TEMP ROOT MUST BE SHORT ENOUGH FOR THE LINUX LAUNCH RULE.
//
// Measured on the 1.0.45 cut of 2026-09-16 (app a41aaf95 / engine e2d443c5):
// six suites went red for the cutter's own path length rather than for anything
// in the product -- home-screen-qa (5055), smoke-linux-sealed (11524, 11525),
// sterile-launch-short-tmpdir (11697, 11698) and sterile-launch (11699).
//
// The cause is not a Windows socket limit; Windows has none, and
// tmpdirBudgetProblem() is right to return null there. It is that
// tools/lib/sterile-launch.cjs shortLinuxTmpdir() evaluates the LINUX launch
// rules on whatever host runs the suite: with no /run/user/<uid> on Windows it
// falls through to os.tmpdir() and throws STERILE_LAUNCH_NO_SHORT_TMPDIR unless
// that is at most 60 bytes. The cutter used to hand out `<scratch>/temp`, which
// measured 83 bytes.
//
// Control, same bytes otherwise, only TEMP/TMP differing:
//   TEMP = the cut's old scratch temp -> sterile-launch-short-tmpdir 6 pass, 2 FAIL
//   TEMP = a 57-byte root             -> sterile-launch-short-tmpdir 8 pass, 0 fail

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  SHORT_LINUX_TMPDIR_MAX_BYTES,
  SHORT_TEMP_BASE,
  createCutScratch,
  createShortWindowsTempRoot,
  machineTempRoot,
  windowsTempRootProblem,
} from '../release-packager/cut-release-candidate.mjs'

test('the Windows temp-root rule is the one sterile-launch.cjs actually enforces', () => {
  assert.equal(SHORT_LINUX_TMPDIR_MAX_BYTES, 60,
    'sterile-launch.cjs shortLinuxTmpdir() accepts an ambient tmpdir of at most 60 bytes')
  assert.equal(windowsTempRootProblem('C:\\t', 'win32'), null, 'a short root is fine')
  assert.equal(windowsTempRootProblem('C:\\' + 'x'.repeat(200), 'linux'), null,
    'the rule is about the Windows temp root; POSIX has its own socket budget')
})

test('a too-long Windows temp root is refused BY NAME with both byte counts, not silently accepted', () => {
  const tooLong = 'C:\\Users\\SomebodyWithAVeryLongAccountName\\AppData\\Local\\Temp\\release-cut-scratch-1.0.45-aBcDeF\\temp'
  const problem = windowsTempRootProblem(tooLong, 'win32')
  assert.ok(problem, 'a 100+ byte root must be refused')
  assert.match(problem, new RegExp(`${Buffer.byteLength(tooLong, 'utf8')} bytes`), 'names what it measured')
  assert.match(problem, /at most 60 bytes/, 'names what it allows')
  assert.match(problem, /sterile-launch\.cjs/, 'names the file whose rule it is enforcing')
})

test('createShortWindowsTempRoot refuses a base it cannot fit, and removes what it made', { skip: process.platform !== 'win32' && 'the Windows temp root is measured on Windows' }, async () => {
  const deepBase = path.join(os.tmpdir(), 'te-cut-probe-base', 'padding-to-make-this-deliberately-long')
  mkdirSync(deepBase, { recursive: true })
  try {
    await assert.rejects(
      createShortWindowsTempRoot({ base: deepBase }),
      /is \d+ bytes; it may be at most 60 bytes/,
      'it must refuse rather than hand back a root that reds six suites',
    )
    // The refusal must not leave its attempt behind.
    assert.deepEqual(readdirSync(deepBase), [], 'the directory it created must be removed before it throws')
  } finally {
    rmSync(path.join(os.tmpdir(), 'te-cut-probe-base'), { recursive: true, force: true })
  }
})

test('createCutScratch hands the dist chain a Windows temp root that satisfies the rule', { skip: process.platform !== 'win32' && 'the Windows temp root is measured on Windows' }, async () => {
  const { scratch, scratchTemp } = await createCutScratch('1.0.45-shorttemp-test')
  try {
    assert.equal(windowsTempRootProblem(scratchTemp, 'win32'), null,
      `the cut's own temp root must satisfy the rule; got ${Buffer.byteLength(scratchTemp, 'utf8')} bytes`)
    assert.ok(Buffer.byteLength(scratchTemp, 'utf8') <= SHORT_LINUX_TMPDIR_MAX_BYTES)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
    rmSync(scratchTemp, { recursive: true, force: true })
  }
})


// THE CUT MUST NOT SPEND THE BUDGET TWICE ON ITSELF.
//
// buildDistChainEnvironment() sets TEMP/TMP/TMPDIR to the cut's own scratchTemp,
// so every suite the dist chain runs sees os.tmpdir() already inside that
// scratch. The 1.0.45 cut of 2026-09-17 derived its base from os.tmpdir() there
// and nested a second te-cut- root inside the first: 72 bytes against the
// 60-byte limit, which refused at dist segment 0 and produced no installer.
// The case above only catches that when the ambient temp happens to be
// redirected, so this one redirects it on purpose.
test('createCutScratch is idempotent under its own dist-chain environment', { skip: process.platform !== 'win32' && 'the Windows temp root is measured on Windows' }, async () => {
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR }
  const outer = await createCutScratch('1.0.45-idempotence-outer')
  try {
    // Exactly what the dist chain is handed.
    process.env.TEMP = outer.scratchTemp
    process.env.TMP = outer.scratchTemp
    process.env.TMPDIR = outer.scratchTemp
    assert.equal(os.tmpdir(), outer.scratchTemp, 'the ambient temp root is now this cut own scratch')

    const inner = await createCutScratch('1.0.45-idempotence-inner')
    try {
      assert.equal(windowsTempRootProblem(inner.scratchTemp, 'win32'), null,
        `a cut running inside a cut must still satisfy the rule; got ${Buffer.byteLength(inner.scratchTemp, 'utf8')} bytes`)
      const nested = path.relative(outer.scratchTemp, inner.scratchTemp)
      assert.ok(nested.startsWith('..') || path.isAbsolute(nested),
        'the inner temp root must not be created inside the outer one')
    } finally {
      rmSync(inner.scratch, { recursive: true, force: true })
      rmSync(inner.scratchTemp, { recursive: true, force: true })
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(outer.scratch, { recursive: true, force: true })
    rmSync(outer.scratchTemp, { recursive: true, force: true })
  }
})

test('machineTempRoot ignores a redirected ambient temp on Windows', () => {
  // The ambient value is no longer consulted at all on Windows: it was the
  // fail-open path Worker 89 found, and inside a cut it IS the cut's scratch.
  assert.equal(
    machineTempRoot({ platform: 'win32', home: os.homedir(), exists: () => true }),
    path.join(path.resolve(os.homedir()), 'AppData', 'Local', 'Temp'),
    'the anchor comes from the account home, never from the rewritten ambient temp')
})

// WORKER 89'S THREE FINDINGS ON machineTempRoot, each with its own mutation.
//
// (a) it returned the AMBIENT directory on every non-win32 platform, and inside
//     a cut the ambient directory is the cut's own scratch, so the nesting was
//     unprevented on Linux (R1226). scratchTemp was never affected there --
//     that one comes from SHORT_TEMP_BASE, a literal -- but createCutScratch
//     puts its STATE directory under this root.
// (b) exists(perUser) ? perUser : ambient was fail-open: the fallback silently
//     reproduced the 72-byte condition and still looked like a temp directory.
// (c) the anchor came from os.homedir()/USERPROFILE with nothing validating it,
//     so a cut launched with a redirected profile would anchor its scratch --
//     and every byte of state the suites write -- outside this account.
test('the Linux anchor is the machine temp root, not the ambient one the cut rewrote', () => {
  assert.equal(machineTempRoot({ platform: 'linux', home: '/home/someone' }), SHORT_TEMP_BASE,
    'POSIX anchors on the same literal createShortTempRoot uses, so a cut inside a cut cannot nest')
  assert.equal(machineTempRoot({ platform: 'darwin', home: '/Users/someone' }), SHORT_TEMP_BASE)
})

test('a missing per-user temp root is refused by name instead of falling back', () => {
  assert.throws(
    () => machineTempRoot({ platform: 'win32', home: os.homedir(), exists: () => false }),
    (error) => {
      assert.match(error.message, /per-user temp root does not exist/, 'names what is missing')
      assert.match(error.message, /the cut's own scratch/, 'says why falling back is not safe')
      return true
    },
  )
  assert.throws(() => machineTempRoot({ platform: 'win32', home: '' }), /cannot locate the running account home directory/,
    'an empty home is refused, not defaulted to the ambient temp')
})

test('an anchor outside the running account is refused before any scratch exists', () => {
  assert.throws(
    () => machineTempRoot({ platform: 'win32', home: path.join('C:', 'Users', 'SomebodyElse'), exists: () => true }),
    (error) => {
      assert.match(error.message, /anchor its scratch outside the account it is running as/, 'names the boundary')
      assert.match(error.message, /SomebodyElse/, 'quotes the redirected profile')
      return true
    },
  )
  // The real account still resolves, so the guard is not simply refusing everything.
  assert.equal(machineTempRoot({ platform: 'win32', home: os.homedir(), exists: () => true }),
    path.join(path.resolve(os.homedir()), 'AppData', 'Local', 'Temp'))
})
