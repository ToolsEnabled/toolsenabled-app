/* THE SHIP CHAIN MUST BE ABLE TO BUILD A TREE THAT HAS NEVER BEEN BUILT.
 *
 * THE DEFECT. `npm run dist` runs tools/launch-readiness-sync-packed-payload.mjs
 * before electron-builder. `release/` is gitignored, so a checkout that has
 * never built has no packed payload at all -- and the sync refused with exit 2,
 * taking the whole chain down. That is not a corner case: it is every fresh
 * clone, and it is EVERY RELEASE, because
 * tools/release-packager/cut-release-candidate.mjs deliberately builds in a
 * throwaway `git worktree add --detach` checkout and then runs `npm run dist`
 * inside it. docs/REPRODUCIBLE-BUILD.md calls that "the one command". Measured
 * 2026-08-11 in a detached worktree cut from app HEAD 9723d2e9fe2f:
 *
 *   @@STEP sync-packed-payload EXIT=2
 *   Payload sync refused: the packed payload does not exist at
 *   ...\release\win-unpacked\resources\capability. Refusing: an absent payload
 *   is not an empty one.
 *
 * WHY THE FIX IS NARROW, AND WHAT THESE TESTS ARE REALLY GUARDING. The refusal
 * is CORRECT for the staged side: an absent or empty staged payload would turn
 * "delete every packed file not in the staged set" into "delete the shipped
 * payload" and report a triumphant sync. This codebase's recurring defect is
 * absence read as consent, so widening an absence check is exactly the change
 * that must not be made carelessly. Only the PACKED side, and only when it is
 * genuinely ABSENT, is excused -- there is nothing there to prune.
 *
 * So the cases below test ABSENCE BEFORE PRESENCE, and most of them assert that
 * a refusal SURVIVED the fix. If someone later "simplifies" the guard, the
 * staged-absent and staged-empty cases go red naming the payload that would
 * have been deleted.
 *
 * Behavioural, not textual: every case spawns the real script against real
 * directories and asserts on its real exit code and the files on disk
 * afterwards. Exit codes are read from spawnSync().status directly, never
 * through a pipe.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = path.join(REPO_ROOT, 'tools', 'launch-readiness-sync-packed-payload.mjs')

function run(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    cwd: REPO_ROOT,
  })
  return { code: result.status, out: `${result.stdout || ''}${result.stderr || ''}` }
}

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'payload-sync-'))
}

function writeFile(root, relative, contents) {
  const full = path.join(root, relative.split('/').join(path.sep))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents)
  return full
}

/* A staged payload with real content, used by every case that needs the staged
   side to be valid. */
function seedStaged(root) {
  writeFile(root, 'PAYLOAD.json', '{"bridgeEntrypoint":"src/index.js"}')
  writeFile(root, 'src/index.js', 'module.exports = 1\n')
  writeFile(root, 'src/lib/deep.js', 'module.exports = 2\n')
  return root
}

// --------------------------------------------------------------------------
// THE ABSENCE CASES FIRST.

test('FIRST BUILD: an absent packed payload is a no-op, not a refusal', () => {
  const dir = scratch()
  try {
    const staged = seedStaged(path.join(dir, 'capability'))
    const packed = path.join(dir, 'release', 'win-unpacked', 'resources', 'capability')
    assert.ok(!fs.existsSync(packed), 'precondition: the packed payload must not exist')

    const { code, out } = run(['--staged', staged, '--packed', packed])

    assert.equal(code, 0, `a first build must not fail the ship chain. Output:\n${out}`)
    assert.match(out, /first[- ]build/i, 'the run must say plainly that this is a first build')
    // A no-op means a no-op: it must not fabricate the artifact directory.
    assert.ok(!fs.existsSync(packed), 'the sync must not create the packed payload; electron-builder does that')
    // And it must not have touched the staged side either.
    assert.equal(fs.readFileSync(path.join(staged, 'src/index.js'), 'utf8'), 'module.exports = 1\n')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('--check still REFUSES an absent packed payload (a check over nothing is not a pass)', () => {
  const dir = scratch()
  try {
    const staged = seedStaged(path.join(dir, 'capability'))
    const packed = path.join(dir, 'release', 'win-unpacked', 'resources', 'capability')

    const { code, out } = run(['--staged', staged, '--packed', packed, '--check'])

    assert.equal(code, 2, `--check asserts something ABOUT an artifact; an absent one cannot satisfy it. Output:\n${out}`)
    assert.match(out, /(?:absent|does not exist|missing)/i, 'the refusal must name the absence')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a packed payload that EXISTS but is EMPTY is still a refusal (absent != empty)', () => {
  const dir = scratch()
  try {
    const staged = seedStaged(path.join(dir, 'capability'))
    const packed = path.join(dir, 'release', 'win-unpacked', 'resources', 'capability')
    fs.mkdirSync(packed, { recursive: true })

    const { code, out } = run(['--staged', staged, '--packed', packed])

    assert.equal(code, 2, `a half-built or half-deleted artifact must not be waved through. Output:\n${out}`)
    assert.match(out, /(?:contains no files|empty|holds no files)/i, 'the refusal must name the empty directory')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an ABSENT staged payload still refuses, and deletes nothing (the defect this guard exists for)', () => {
  const dir = scratch()
  try {
    const staged = path.join(dir, 'capability') // never created
    const packed = path.join(dir, 'release', 'win-unpacked', 'resources', 'capability')
    writeFile(packed, 'src/index.js', 'the shipped payload\n')
    writeFile(packed, 'PAYLOAD.json', '{}')

    const { code, out } = run(['--staged', staged, '--packed', packed])

    assert.equal(code, 2, `an absent staged payload must never authorise deleting the packed one. Output:\n${out}`)
    assert.equal(
      fs.readFileSync(path.join(packed, 'src/index.js'), 'utf8'),
      'the shipped payload\n',
      'the packed payload must be untouched -- this is the file an absence-as-consent bug would delete',
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an EMPTY staged payload still refuses, and deletes nothing', () => {
  const dir = scratch()
  try {
    const staged = path.join(dir, 'capability')
    fs.mkdirSync(staged, { recursive: true })
    const packed = path.join(dir, 'release', 'win-unpacked', 'resources', 'capability')
    writeFile(packed, 'src/index.js', 'the shipped payload\n')

    const { code, out } = run(['--staged', staged, '--packed', packed])

    assert.equal(code, 2, `an empty staged payload must never authorise deleting the packed one. Output:\n${out}`)
    assert.ok(fs.existsSync(path.join(packed, 'src/index.js')), 'the packed payload must be untouched')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// --------------------------------------------------------------------------
// THEN THE PRESENCE CASE: the tool's real job must still work.

test('a real sync still prunes stale files and writes missing ones', () => {
  const dir = scratch()
  try {
    const staged = seedStaged(path.join(dir, 'capability'))
    const packed = path.join(dir, 'release', 'win-unpacked', 'resources', 'capability')
    // The artifact carries a file the closure no longer has, is missing one it
    // does have, and disagrees on the bytes of a third.
    writeFile(packed, 'src/excluded-forever.js', 'this must be pruned\n')
    writeFile(packed, 'PAYLOAD.json', '{"stale":true}')
    writeFile(packed, 'src/index.js', 'module.exports = 1\n')

    const { code, out } = run(['--staged', staged, '--packed', packed])

    assert.equal(code, 0, `the sync must succeed. Output:\n${out}`)
    assert.ok(!fs.existsSync(path.join(packed, 'src', 'excluded-forever.js')), 'the stale file must be pruned')
    assert.equal(fs.readFileSync(path.join(packed, 'src/lib/deep.js'), 'utf8'), 'module.exports = 2\n', 'the missing nested file must be written')
    assert.equal(fs.readFileSync(path.join(packed, 'PAYLOAD.json'), 'utf8'), '{"bridgeEntrypoint":"src/index.js"}', 'differing bytes must be replaced')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
