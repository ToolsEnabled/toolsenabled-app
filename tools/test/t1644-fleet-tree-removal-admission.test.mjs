/* T1644: the durable preferences boundary must not be a second saved-tree
   deletion path. These fixtures are synthetic, retained, and isolated. The
   suite never opens a live profile or asks the product to release a seat. */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import Module, { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
// The pinned baseline is a commit from the history that preceded this fix; a
// checkout without that history skips the comparison by name.
const PINNED_BASELINE = process.env.T1644_RENDERER_PREFS_BASELINE_REF || '0000000'
const BASELINE_REQUESTED = process.env.T1644_RENDERER_PREFS_BASELINE === '1'
const BASELINE_AVAILABLE = BASELINE_REQUESTED
  && spawnSync('git', ['cat-file', '-e', `${PINNED_BASELINE}^{commit}`], { cwd: ROOT }).status === 0
const USE_PINNED_BASELINE = BASELINE_REQUESTED && BASELINE_AVAILABLE
if (BASELINE_REQUESTED && !BASELINE_AVAILABLE)
  test('the pinned baseline comparison', t => t.skip(`baseline ref ${PINNED_BASELINE} is not in this checkout`))

/* The baseline is opt-in so the normal invocation exercises the checked-out
   product. The comparison invocation extracts exactly the pinned CJS source,
   like the existing loop suites do; it does not change the worktree. */
function rendererPrefsModule() {
  if (!USE_PINNED_BASELINE) return require_('../../shell/renderer-prefs.cjs')
  const filename = path.join(ROOT, 'shell', 'renderer-prefs.cjs')
  const source = execFileSync('git', ['show', `${PINNED_BASELINE}:shell/renderer-prefs.cjs`], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  const compiled = new Module(filename, null)
  compiled.filename = filename
  compiled.paths = Module._nodeModulePaths(path.dirname(filename))
  compiled._compile(source, filename)
  return compiled.exports
}

const {
  createRendererPrefs,
  RECORD_FILE,
  RENDERER_FLEET_FILE,
} = rendererPrefsModule()

const TREE_KEY = 'mc.fleet.trees.v1:t1644-fixture-computer'
const ORDINARY_KEY = 'mc.theme'
const FIXTURE_PREFIX = 'te-t1644-fleet-removal-'

function countingFs(unreadableFleetFile = null) {
  const calls = []
  const io = Object.create(fs)
  for (const name of ['mkdirSync', 'openSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'renameSync', 'unlinkSync']) {
    io[name] = (...args) => {
      calls.push(name)
      return fs[name](...args)
    }
  }
  io.readFileSync = (target, ...args) => {
    if (unreadableFleetFile && path.resolve(String(target)) === path.resolve(unreadableFleetFile)) {
      throw Object.assign(new Error('synthetic unreadable fleet fixture'), { code: 'EACCES' })
    }
    return fs.readFileSync(target, ...args)
  }
  return { io, calls }
}

function fixture(label, { fleetText, unreadableFleet = false, validateTreeRemoval = null } = {}) {
  /* Intentionally retained: the runner/census owns fixture retention. */
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${FIXTURE_PREFIX}${label}-`))
  const fleetFile = path.join(directory, RENDERER_FLEET_FILE)
  if (fleetText !== undefined) fs.writeFileSync(fleetFile, fleetText, 'utf8')
  const counted = countingFs(unreadableFleet ? fleetFile : null)
  const prefs = createRendererPrefs({ directory, fs: counted.io, path, randomUUID, validateTreeRemoval })
  return {
    directory,
    file: path.join(directory, RECORD_FILE),
    fleetFile,
    prefs,
    calls: counted.calls,
  }
}

function retainedNames(directory) {
  return fs.readdirSync(directory).sort()
}

function retainedText(file) {
  return fs.readFileSync(file, 'utf8')
}

function savedTreeValue() {
  return JSON.stringify({
    version: 1,
    computerId: 't1644-fixture-computer',
    trees: [{ id: 't1644-fixture-tree', name: null, createdAt: 'a', updatedAt: 'a' }],
    nodes: [
      {
        id: 't1644-fixture-parent', treeId: 't1644-fixture-tree', parentId: null,
        role: 'planner', message: 'fixture parent', status: 'draft', statusNote: '', sessionId: null,
        createdAt: 'a', updatedAt: 'a',
      },
      {
        id: 't1644-fixture-node', treeId: 't1644-fixture-tree', parentId: 't1644-fixture-parent',
        role: 'worker', message: 'fixture child', status: 'finished', statusNote: '', sessionId: null,
        createdAt: 'a', updatedAt: 'a',
      },
    ],
  })
}

function fleetEnvelope() {
  return JSON.stringify({ storageVersion: 1, values: { [TREE_KEY]: savedTreeValue() } }) + '\n'
}

function seedTree(f) {
  const value = savedTreeValue()
  assert.equal(f.prefs.set(ORDINARY_KEY, 'black').ok, true)
  assert.equal(f.prefs.set(TREE_KEY, value).ok, true)
  assert.equal(f.prefs.flushFleetDocumentsSync().ok, true)
  return value
}

function assertRefusal(answer, context) {
  assert.equal(answer?.ok, false, `${context}: a saved-tree mutation must refuse`)
  const reason = answer?.error?.message ?? answer?.reason ?? answer?.message
  assert.equal(typeof reason, 'string', `${context}: refusal must explain why the saved tree was kept`)
  assert.match(reason, /saved|tree|topolog|handoff|read|unknown|retain|damaged/i,
    `${context}: refusal must identify the saved-tree or authority problem`)
}

test('a nonempty saved tree is refused before backup, persistence, or deletion without admission', () => {
  const f = fixture('single')
  const value = seedTree(f)
  const beforeFleet = retainedText(f.fleetFile)
  const beforePrefs = retainedText(f.file)
  const beforeNames = retainedNames(f.directory)
  f.calls.length = 0

  const answer = f.prefs.remove(TREE_KEY)

  assertRefusal(answer, 'single tree removal')
  assert.equal(retainedText(f.fleetFile), beforeFleet, 'refusal must retain the fleet bytes')
  assert.equal(retainedText(f.file), beforePrefs, 'refusal must retain ordinary preference bytes')
  assert.deepEqual(retainedNames(f.directory), beforeNames, 'refusal must take no backup or temporary file')
  assert.equal(f.prefs.snapshot().values[TREE_KEY], value, 'refusal must retain the in-memory tree')
  assert.deepEqual(f.calls, [], 'refusal must precede every filesystem mutation')
})

test('malformed fleet bytes are unknown, not an empty tree eligible for removal', () => {
  const malformed = '{ malformed fleet fixture'
  const f = fixture('malformed', { fleetText: malformed })
  const beforeNames = retainedNames(f.directory)

  const answer = f.prefs.remove(TREE_KEY)

  assertRefusal(answer, 'malformed fleet removal')
  assert.equal(retainedText(f.fleetFile), malformed, 'malformed bytes must remain available for recovery')
  assert.deepEqual(retainedNames(f.directory), beforeNames, 'unknown state must not create a replacement or backup')
})

test('an unreadable fleet file is unknown, not an absent tree eligible for removal', () => {
  let callbackCalls = 0
  const f = fixture('unreadable', {
    fleetText: fleetEnvelope(),
    unreadableFleet: true,
    validateTreeRemoval: () => { callbackCalls += 1; return { ok: true } },
  })
  const beforeFleet = retainedText(f.fleetFile)
  const beforeNames = retainedNames(f.directory)

  const answer = f.prefs.remove(TREE_KEY)

  assertRefusal(answer, 'unreadable fleet removal')
  assert.equal(retainedText(f.fleetFile), beforeFleet, 'unreadable bytes must remain available for recovery')
  assert.deepEqual(retainedNames(f.directory), beforeNames, 'unknown state must not create a replacement or backup')
  assert.deepEqual(f.calls, [], 'unreadable refusal must precede every filesystem mutation')
  assert.equal(callbackCalls, 0, 'damaged storage must refuse before an approving removal callback')
})

test('removeMany refuses malformed and unreadable fleet state before deleting an ordinary key', () => {
  const cases = [
    ['malformed-bulk', { fleetText: '{ malformed fleet fixture' }],
    ['unreadable-bulk', { fleetText: fleetEnvelope(), unreadableFleet: true }],
  ]
  for (const [label, options] of cases) {
    const f = fixture(label, options)
    assert.equal(f.prefs.set(ORDINARY_KEY, 'black').ok, true)
    const beforeFleet = retainedText(f.fleetFile)
    const beforePrefs = retainedText(f.file)
    const beforeNames = retainedNames(f.directory)
    f.calls.length = 0

    const answer = f.prefs.removeMany([ORDINARY_KEY, TREE_KEY])

    assertRefusal(answer, `${label} mixed removal`)
    assert.equal(retainedText(f.fleetFile), beforeFleet, `${label}: fleet bytes must remain unchanged`)
    assert.equal(retainedText(f.file), beforePrefs, `${label}: ordinary bytes must remain unchanged`)
    assert.deepEqual(retainedNames(f.directory), beforeNames, `${label}: refusal must take no backup or temporary file`)
    assert.deepEqual(f.calls, [], `${label}: refusal must precede every filesystem mutation`)
  }
})

test('mixed ordinary and fleet removeMany refuses atomically before backup, persist, or delete', () => {
  const f = fixture('mixed')
  const value = seedTree(f)
  const beforeFleet = retainedText(f.fleetFile)
  const beforePrefs = retainedText(f.file)
  const beforeNames = retainedNames(f.directory)
  f.calls.length = 0

  const answer = f.prefs.removeMany([ORDINARY_KEY, TREE_KEY])

  assertRefusal(answer, 'mixed removal')
  assert.equal(retainedText(f.fleetFile), beforeFleet, 'atomic refusal must retain fleet bytes')
  assert.equal(retainedText(f.file), beforePrefs, 'atomic refusal must retain ordinary bytes')
  assert.deepEqual(retainedNames(f.directory), beforeNames, 'atomic refusal must take no backup or temporary file')
  assert.equal(f.prefs.snapshot().values[ORDINARY_KEY], 'black', 'ordinary preference must not be partially removed')
  assert.equal(f.prefs.snapshot().values[TREE_KEY], value, 'fleet tree must not be partially removed')
  assert.deepEqual(f.calls, [], 'mixed refusal must precede every filesystem mutation')
})

test('ordinary preference removal remains available without a fleet-tree admission', () => {
  const f = fixture('ordinary')
  assert.equal(f.prefs.set(ORDINARY_KEY, 'black').ok, true)
  assert.equal(f.prefs.remove(ORDINARY_KEY).ok, true)
  assert.equal(Object.hasOwn(f.prefs.snapshot().values, ORDINARY_KEY), false)

  assert.equal(f.prefs.set('mc.text', 'retained control').ok, true)
  assert.equal(f.prefs.removeMany(['mc.text']).ok, true)
  assert.equal(Object.hasOwn(f.prefs.snapshot().values, 'mc.text'), false)
})
