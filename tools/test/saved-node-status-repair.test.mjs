import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const repair = require('../../shell/saved-node-status-repair.cjs')

const sourceRoot = fs.realpathSync(fileURLToPath(new URL('../../', import.meta.url)))
const currentFixture = path.join(sourceRoot, 'test', 'fixtures', 'saved-node-status-repair-current13.json')
const snapshotFixture = path.join(sourceRoot, 'test', 'fixtures', 'saved-node-status-repair-snapshot13.json')
const key = 'mc.fleet.trees.v1:synthetic-computer'
const now = '2026-09-21T20:00:00.000Z'
const later = '2026-09-21T20:11:00.000Z'
const targets = Array.from({ length: 13 }, (_, index) => 'node-' + String(index + 1).padStart(3, '0') + '-synthetic')

function samePath(left, right) {
  return path.relative(left, right) === '' && path.relative(right, left) === ''
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith('..' + path.sep)
    && !path.isAbsolute(relative)
  )
}

function gitMarkerPresent(directory, label) {
  const marker = path.join(directory, '.git')
  try {
    fs.lstatSync(marker)
    return true
  } catch (error) {
    if (error && error.code === 'ENOENT') return false
    throw new Error(label + '_REFUSED_GIT_MARKER_UNREADABLE: ' + marker + ' (' + (error.code || 'lstat failed') + ')')
  }
}

function canonicalExternalDirectory(input, label) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) {
    throw new Error(label + '_REFUSED_NOT_ABSOLUTE: an explicit fixture parent must be absolute')
  }
  const resolved = path.resolve(input)
  const root = path.parse(resolved).root
  let cursor = resolved
  for (;;) {
    let info
    try {
      info = fs.lstatSync(cursor)
    } catch (error) {
      throw new Error(label + '_REFUSED_UNREADABLE_ANCESTOR: ' + cursor + ' (' + (error.code || 'stat failed') + ')')
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(label + '_REFUSED_LINKED_ANCESTOR: ' + cursor + ' must be an ordinary directory')
    }
    if (path.basename(cursor) === '.git' || gitMarkerPresent(cursor, label)) {
      throw new Error(label + '_REFUSED_GIT_ANCESTOR: ' + cursor)
    }
    if (samePath(cursor, root)) break
    const parent = path.dirname(cursor)
    if (samePath(parent, cursor)) break
    cursor = parent
  }
  const canonical = fs.realpathSync(resolved)
  const finalInfo = fs.statSync(canonical)
  if (!finalInfo.isDirectory()) {
    throw new Error(label + '_REFUSED_NOT_DIRECTORY: ' + canonical)
  }
  return canonical
}

function canonicalSourceDirectory(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) {
    throw new Error('SOURCE_ROOT_REFUSED_NOT_ABSOLUTE: source root must be absolute')
  }
  const canonical = fs.realpathSync(path.resolve(input))
  const info = fs.statSync(canonical)
  if (!info.isDirectory()) {
    throw new Error('SOURCE_ROOT_REFUSED_NOT_DIRECTORY: ' + canonical)
  }
  return canonical
}

function selectFixtureParent({
  env = {},
  strict = false,
  tempDirectory = os.tmpdir(),
  sourceDirectory = sourceRoot,
} = {}) {
  const values = env && typeof env === 'object' ? env : {}
  const source = canonicalSourceDirectory(sourceDirectory)
  const hasConfigured = Object.prototype.hasOwnProperty.call(values, 'T1164_FIXTURE_ROOT')
  const configured = hasConfigured ? values.T1164_FIXTURE_ROOT : undefined
  let defaultParent = null
  if (strict || configured === undefined) {
    defaultParent = canonicalExternalDirectory(tempDirectory, 'OS_TMPDIR')
  }
  if (strict) {
    for (const name of ['TMPDIR', 'TEMP', 'TMP']) {
      const value = values[name]
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error('T1164_STRICT_TEMP_BINDING_REFUSED: ' + name + ' is unset')
      }
      const canonical = canonicalExternalDirectory(value, name)
      if (!samePath(canonical, defaultParent)) {
        throw new Error('T1164_STRICT_TEMP_BINDING_REFUSED: ' + name + ' is not the current os.tmpdir leaf')
      }
    }
  }
  const parent = configured === undefined
    ? defaultParent
    : canonicalExternalDirectory(configured, 'T1164_FIXTURE_ROOT')
  if (strict && configured !== undefined && !isWithin(defaultParent, parent)) {
    throw new Error('T1164_FIXTURE_ROOT_REFUSED_OUTSIDE_STRICT_TEMP: explicit parent is outside the current os.tmpdir leaf')
  }
  if (isWithin(source, parent)) {
    throw new Error('T1164_FIXTURE_ROOT_REFUSED_SOURCE_CONTAINMENT: selected canonical parent is inside the source tree')
  }
  return {
    parent,
    strictTemp: defaultParent,
    explicit: configured !== undefined,
    strict,
    sourceDirectory: source,
  }
}

function createRetainedRunRoot(values = {}) {
  const selection = selectFixtureParent(values)
  const candidate = fs.mkdtempSync(path.join(selection.parent, 'saved-node-status-repair-suite-'))
  const candidateInfo = fs.lstatSync(candidate)
  if (!candidateInfo.isDirectory() || candidateInfo.isSymbolicLink()) {
    throw new Error('T1164_RUN_ROOT_REFUSED_NOT_ORDINARY: mkdtemp did not produce an ordinary directory')
  }
  const runRoot = fs.realpathSync(candidate)
  if (!isWithin(selection.parent, runRoot)) {
    throw new Error('T1164_RUN_ROOT_REFUSED_ESCAPE: retained run root escaped the selected parent')
  }
  if (isWithin(selection.sourceDirectory, runRoot)) {
    throw new Error('T1164_RUN_ROOT_REFUSED_SOURCE_CONTAINMENT: retained run root is inside the source tree')
  }
  return {
    ...selection,
    runRoot,
    diagnostic: {
      selectedParent: selection.parent,
      runRoot,
      sourceRoot: selection.sourceDirectory,
      strict: selection.strict,
      explicit: selection.explicit,
    },
  }
}

const retained = createRetainedRunRoot({
  env: process.env,
  strict: process.env.TOOLSENABLED_TEST_STRICT === '1',
  tempDirectory: os.tmpdir(),
  sourceDirectory: sourceRoot,
})

function fixture(caseName) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(retained.runRoot, caseName + '-')))
  const storePath = path.join(root, 'renderer-fleet-documents.json')
  const snapshotPath = path.join(root, 'saved-snapshot.json')
  fs.copyFileSync(currentFixture, storePath)
  fs.copyFileSync(snapshotFixture, snapshotPath)
  return {
    root,
    storePath,
    snapshotPath,
    originalText: fs.readFileSync(storePath, 'utf8'),
  }
}

function prepare(f, extra = {}) {
  return repair.prepareRepair({
    storePath: f.storePath,
    snapshotPath: f.snapshotPath,
    now,
    freshnessCheck: () => true,
    ...extra,
  })
}

function commitFor(storePath, calls) {
  return ({ expectedText, replacementText }) => {
    calls.push({ expectedText, replacementText })
    assert.equal(fs.readFileSync(storePath, 'utf8'), expectedText)
    fs.writeFileSync(storePath, replacementText)
    const descriptor = fs.openSync(storePath, 'r')
    try {
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    return { ok: true }
  }
}

function inner(filePath) {
  return JSON.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')).values[key])
}

function mutateSnapshotIdentity(f) {
  const outer = JSON.parse(fs.readFileSync(f.snapshotPath, 'utf8'))
  const tree = JSON.parse(outer.values[key])
  tree.nodes[0].sessionId = 'different-session'
  outer.values[key] = JSON.stringify(tree)
  fs.writeFileSync(f.snapshotPath, JSON.stringify(outer))
}

function assertRestored(f) {
  const outer = JSON.parse(fs.readFileSync(f.storePath, 'utf8'))
  const tree = JSON.parse(outer.values[key])
  assert.equal(outer.marker, 'retain-outer-field')
  for (const [index, node] of tree.nodes.entries()) {
    assert.equal(node.status, 'finished')
    assert.equal(node.title, 'retained-' + (index + 1))
    assert.deepEqual(node.bytes, { keep: 'field-' + (index + 1) })
    assert.equal(node.sessionId, 'session-synthetic-' + (index + 1))
    assert.equal(node.lastTurnId, 'turn-synthetic-' + (index + 1))
    if (index < 12) assert.equal(node.statusNote, 'finished-' + (index + 1))
    else assert.equal(Object.hasOwn(node, 'statusNote'), false)
  }
}

function selectionDirectory(prefix, parent = retained.runRoot) {
  return fs.realpathSync(fs.mkdtempSync(path.join(parent, prefix + '-')))
}

test('retained fixture root reports its selected parent and source binding', (t) => {
  assert.ok(isWithin(retained.parent, retained.runRoot))
  assert.equal(isWithin(sourceRoot, retained.runRoot), false)
  assert.deepEqual(Object.keys(retained.diagnostic).sort(), [
    'explicit',
    'runRoot',
    'selectedParent',
    'sourceRoot',
    'strict',
  ])
  assert.equal(retained.diagnostic.runRoot, retained.runRoot)
  assert.equal(retained.diagnostic.selectedParent, retained.parent)
  assert.equal(retained.diagnostic.sourceRoot, sourceRoot)
  assert.equal(retained.diagnostic.strict, retained.strict)
  assert.equal(retained.diagnostic.explicit, retained.explicit)
  if (retained.strict) assert.ok(isWithin(retained.strictTemp, retained.parent))
  else if (retained.explicit) assert.equal(retained.strictTemp, null)
  else assert.ok(samePath(retained.strictTemp, retained.parent))
  t.diagnostic('RETAINED_SAVED_STATUS_FIXTURE ' + JSON.stringify(retained.diagnostic))
})

test('value-driven strict selection accepts the current leaf and an in-leaf override', () => {
  const strictLeaf = selectionDirectory('strict-selection-leaf')
  const strictEnv = { TMPDIR: strictLeaf, TEMP: strictLeaf, TMP: strictLeaf }
  const defaultSelection = selectFixtureParent({
    env: strictEnv,
    strict: true,
    tempDirectory: strictLeaf,
    sourceDirectory: sourceRoot,
  })
  assert.ok(samePath(defaultSelection.parent, strictLeaf))
  assert.equal(defaultSelection.explicit, false)
  assert.equal(defaultSelection.strict, true)

  const inLeaf = selectionDirectory('strict-selection-override', strictLeaf)
  const overrideSelection = selectFixtureParent({
    env: { ...strictEnv, T1164_FIXTURE_ROOT: inLeaf },
    strict: true,
    tempDirectory: strictLeaf,
    sourceDirectory: sourceRoot,
  })
  assert.ok(samePath(overrideSelection.parent, inLeaf))
  assert.equal(overrideSelection.explicit, true)
  assert.ok(isWithin(strictLeaf, overrideSelection.parent))
})

test('value-driven strict selection refuses an outside-leaf override', () => {
  const strictLeaf = selectionDirectory('strict-outside-leaf')
  const strictEnv = { TMPDIR: strictLeaf, TEMP: strictLeaf, TMP: strictLeaf }
  const outsideLeaf = retained.runRoot
  assert.equal(isWithin(strictLeaf, outsideLeaf), false)
  assert.throws(
    () => selectFixtureParent({
      env: { ...strictEnv, T1164_FIXTURE_ROOT: outsideLeaf },
      strict: true,
      tempDirectory: strictLeaf,
      sourceDirectory: sourceRoot,
    }),
    /T1164_FIXTURE_ROOT_REFUSED_OUTSIDE_STRICT_TEMP/,
  )
})

test('value-driven strict selection refuses mismatched temp bindings', () => {
  const strictLeaf = selectionDirectory('strict-binding-leaf')
  const otherLeaf = selectionDirectory('strict-binding-other')
  const before = fs.readdirSync(strictLeaf)
  for (const name of ['TMPDIR', 'TEMP', 'TMP']) {
    assert.throws(
      () => selectFixtureParent({
        env: { TMPDIR: strictLeaf, TEMP: strictLeaf, TMP: strictLeaf, [name]: otherLeaf },
        strict: true,
        tempDirectory: strictLeaf,
        sourceDirectory: sourceRoot,
      }),
      /T1164_STRICT_TEMP_BINDING_REFUSED/,
    )
  }
  assert.deepEqual(fs.readdirSync(strictLeaf), before)
})

test('value-driven ordinary selection accepts default and override without touching an unused default', () => {
  const ordinaryDefault = selectionDirectory('ordinary-selection-default')
  const ordinaryOverride = selectionDirectory('ordinary-selection-override')
  const defaultSelection = selectFixtureParent({
    env: {},
    strict: false,
    tempDirectory: ordinaryDefault,
    sourceDirectory: sourceRoot,
  })
  assert.ok(samePath(defaultSelection.parent, ordinaryDefault))
  assert.equal(defaultSelection.explicit, false)
  assert.equal(defaultSelection.strictTemp, ordinaryDefault)

  const overrideSelection = selectFixtureParent({
    env: { T1164_FIXTURE_ROOT: ordinaryOverride },
    strict: false,
    tempDirectory: path.join(retained.runRoot, 'unused-default-does-not-exist'),
    sourceDirectory: sourceRoot,
  })
  assert.ok(samePath(overrideSelection.parent, ordinaryOverride))
  assert.equal(overrideSelection.explicit, true)
  assert.equal(overrideSelection.strictTemp, null)
})

test('source-contained parent is refused before retained-root allocation', () => {
  const syntheticSource = selectionDirectory('synthetic-source-boundary')
  const selectedInsideSource = selectionDirectory('inside-source-parent', syntheticSource)
  const ordinaryDefault = selectionDirectory('source-check-default')
  const before = fs.readdirSync(selectedInsideSource)
  assert.throws(
    () => createRetainedRunRoot({
      env: { T1164_FIXTURE_ROOT: selectedInsideSource },
      strict: false,
      tempDirectory: ordinaryDefault,
      sourceDirectory: syntheticSource,
    }),
    /T1164_FIXTURE_ROOT_REFUSED_SOURCE_CONTAINMENT/,
  )
  assert.deepEqual(fs.readdirSync(selectedInsideSource), before)
})

test('lstat-based marker validation refuses a dangling .git link', (t) => {
  const markerRoot = selectionDirectory('dangling-git-marker')
  const marker = path.join(markerRoot, '.git')
  try {
    fs.symlinkSync(path.join(markerRoot, 'missing-git-target'), marker, 'file')
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL'].includes(error.code)) {
      t.skip('DANGLING_GIT_MARKER_SETUP_REFUSED: ' + error.code)
      return
    }
    throw error
  }
  assert.throws(
    () => canonicalExternalDirectory(markerRoot, 'DANGLING_GIT'),
    /DANGLING_GIT_REFUSED_GIT_ANCESTOR/,
  )
})

test('restores all matching nodes and verifies the durable backup and phases', async () => {
  const f = fixture('restore-all')
  const phases = []
  const preview = await prepare(f, {
    freshnessCheck: (input) => {
      phases.push(input.phase)
      return true
    },
  })
  assert.equal(preview.ok, true)
  assert.equal(preview.plan.changes.length, 13)
  assert.deepEqual(preview.plan.skipped, [])
  assert.match(preview.plan.backupPath, /[.]repair-backup-/)
  assert.equal(fs.readFileSync(preview.plan.backupPath, 'utf8'), f.originalText)
  const calls = []
  const confirmed = await repair.confirmRepair({
    previewToken: preview.previewToken,
    now,
    confirmNative: (input) => {
      assert.equal(input.snapshotPath, f.snapshotPath)
      return true
    },
    freshnessCheck: (input) => {
      phases.push(input.phase)
      return true
    },
    commitReplacement: commitFor(f.storePath, calls),
  })
  assert.equal(confirmed.ok, true)
  assert.equal(confirmed.restoredNodeIds.length, 13)
  assert.deepEqual(Object.keys(calls[0]).sort(), ['expectedText', 'replacementText'])
  assertRestored(f)
  assert.ok(phases.includes('backup'))
  assert.ok(phases.includes('stage'))
  assert.ok(phases.includes('commit'))
  assert.ok(fs.readdirSync(f.root).some((name) => name.includes('.repair-stage-')))
})

test('refuses repair when synchronous commit is unavailable', async () => {
  const f = fixture('commit-unavailable')
  const preview = await prepare(f)
  const result = await repair.confirmRepair({
    previewToken: preview.previewToken,
    now,
    confirmNative: () => true,
    freshnessCheck: () => true,
  })
  assert.equal(result.code, 'SYNCHRONOUS_COMMIT_REFUSED_UNAVAILABLE')
})

test('requires explicit owner action for startup repair', async () => {
  const f = fixture('startup-refused')
  const result = await prepare(f, { trigger: 'startup' })
  assert.equal(result.code, 'EXPLICIT_ACTION_REQUIRED')
})

test('refuses native approval without changing source bytes', async () => {
  const f = fixture('native-refused')
  const preview = await prepare(f)
  const calls = []
  const result = await repair.confirmRepair({
    previewToken: preview.previewToken,
    now,
    confirmNative: () => ({ ok: true }),
    freshnessCheck: () => true,
    commitReplacement: commitFor(f.storePath, calls),
  })
  assert.equal(result.code, 'NATIVE_CONFIRM_REFUSED')
  assert.equal(calls.length, 0)
  assert.equal(fs.readFileSync(f.storePath, 'utf8'), f.originalText)
})

test('refuses at stage freshness before any commit and preserves source bytes', async () => {
  const f = fixture('stage-freshness-refused')
  const preview = await prepare(f)
  const calls = []
  const result = await repair.confirmRepair({
    previewToken: preview.previewToken,
    now,
    confirmNative: () => true,
    freshnessCheck: (input) => input.phase !== 'stage',
    commitReplacement: commitFor(f.storePath, calls),
  })
  assert.equal(result.code, 'FRESHNESS_REFUSED')
  assert.equal(calls.length, 0)
  assert.equal(fs.readFileSync(f.storePath, 'utf8'), f.originalText)
})

test('surfaces synchronous main-side commit refusal without hiding its code', async () => {
  const f = fixture('commit-refused')
  const preview = await prepare(f)
  let keys
  const result = await repair.confirmRepair({
    previewToken: preview.previewToken,
    now,
    confirmNative: () => true,
    freshnessCheck: () => true,
    commitReplacement: (input) => {
      keys = Object.keys(input).sort()
      return { ok: false, error: { code: 'MC_PREFS_DAMAGED', message: 'synthetic cache is damaged' } }
    },
  })
  assert.equal(result.code, 'MC_PREFS_DAMAGED')
  assert.equal(result.reason, 'synthetic cache is damaged')
  assert.deepEqual(keys, ['expectedText', 'replacementText'])
})

test('skips mismatched identity while repairing remaining matching nodes', async () => {
  const f = fixture('identity-skip')
  mutateSnapshotIdentity(f)
  const preview = await prepare(f)
  assert.equal(preview.plan.changes.length, 12)
  assert.deepEqual(preview.plan.skipped[0], {
    valueKey: key,
    nodeId: targets[0],
    reason: 'SESSION_OR_TURN_ID_MISMATCH',
  })
  const calls = []
  const result = await repair.confirmRepair({
    previewToken: preview.previewToken,
    now,
    confirmNative: () => true,
    freshnessCheck: () => true,
    commitReplacement: commitFor(f.storePath, calls),
  })
  assert.equal(result.ok, true)
  assert.equal(inner(f.storePath).nodes[0].status, 'turn-failed')
  assert.equal(inner(f.storePath).nodes[1].status, 'finished')
  assert.equal(calls.length, 1)
})

test('expires an owner preview before confirmation after its ten-minute TTL', async () => {
  const f = fixture('preview-expired')
  const preview = await prepare(f)
  const result = await repair.confirmRepair({
    previewToken: preview.previewToken,
    now: later,
    confirmNative: () => true,
    freshnessCheck: () => true,
    commitReplacement: commitFor(f.storePath, []),
  })
  assert.equal(result.code, 'PREVIEW_EXPIRED')
})

test('refuses empty and unreadable stores with named readiness codes', async () => {
  const f = fixture('unreadable')
  fs.writeFileSync(f.storePath, '')
  assert.equal((await prepare(f)).code, 'STORE_EMPTY')
  const missingRoot = fs.realpathSync(fs.mkdtempSync(path.join(retained.runRoot, 'missing-store-')))
  const missing = {
    storePath: path.join(missingRoot, 'missing.json'),
    snapshotPath: path.join(missingRoot, 'snapshot.json'),
  }
  fs.copyFileSync(snapshotFixture, missing.snapshotPath)
  assert.equal((await prepare(missing)).code, 'STORE_UNREADABLE')
})

test('refuses backup-copy and backup-fsync failures before mutation', async () => {
  const f = fixture('backup-failures')
  const api = {
    readFile: (...args) => fsp.readFile(...args),
    stat: (...args) => fsp.stat(...args),
    mkdir: (...args) => fsp.mkdir(...args),
    copyFile: async () => {
      throw new Error('backup')
    },
    writeFile: (...args) => fsp.writeFile(...args),
    rename: (...args) => fsp.rename(...args),
    open: (...args) => fsp.open(...args),
  }
  assert.equal((await prepare(f, { fs: api })).code, 'BACKUP_FAILED')
  assert.equal(fs.readFileSync(f.storePath, 'utf8'), f.originalText)

  const durable = {
    ...api,
    copyFile: (...args) => fsp.copyFile(...args),
    open: async () => {
      throw new Error('fsync')
    },
  }
  assert.equal((await prepare(f, { fs: durable })).code, 'DURABILITY_FAILED')
  assert.equal(fs.readFileSync(f.storePath, 'utf8'), f.originalText)
})

test('enforces target bounds and reports missing seat ownership', async () => {
  const f = fixture('target-bounds')
  const oversized = Array.from(
    { length: repair.MAX_TARGETS + 1 },
    (_, index) => 'node-' + index,
  )
  assert.equal((await prepare(f, { targetIds: oversized })).code, 'TARGET_BOUND_EXCEEDED')
  const seatPlan = repair.planSeatRepair({
    nodeIds: ['node-001-synthetic', 'node-002-synthetic'],
    seats: [
      { seatId: 'node-001-seat', nodeId: 'node-001-synthetic' },
      { seatId: 'node-999-seat', nodeId: 'node-999-synthetic' },
    ],
  })
  assert.deepEqual(seatPlan.releaseCandidates, ['node-999-seat'])
  assert.deepEqual(seatPlan.missingSeatNodeIds, ['node-002-synthetic'])
  assert.deepEqual(seatPlan.grants, [])
  assert.deepEqual(seatPlan.authorityChanges, [])
  assert.equal(seatPlan.refusal, 'MISSING_RELEASED_SEAT_OWNER_ASSIGNMENT_REQUIRED')
})

test('rolls back exact original bytes and consumes the rollback preview', async () => {
  const f = fixture('rollback')
  const preview = await prepare(f)
  const repairCalls = []
  assert.equal((await repair.confirmRepair({
    previewToken: preview.previewToken,
    now,
    confirmNative: () => true,
    freshnessCheck: () => true,
    commitReplacement: commitFor(f.storePath, repairCalls),
  })).ok, true)

  const rollbackPreview = await repair.prepareRollback({
    storePath: f.storePath,
    restorePath: preview.plan.backupPath,
    now,
    freshnessCheck: () => true,
  })
  assert.equal(rollbackPreview.ok, true)
  const rollbackCalls = []
  const confirmed = await repair.confirmRollback({
    previewToken: rollbackPreview.previewToken,
    now,
    confirmNative: () => true,
    freshnessCheck: () => true,
    commitReplacement: commitFor(f.storePath, rollbackCalls),
  })
  assert.equal(confirmed.ok, true)
  assert.equal(confirmed.postWriteVerified, true)
  assert.equal(fs.readFileSync(f.storePath, 'utf8'), f.originalText)
  assert.equal(rollbackCalls.length, 1)
  assert.equal((await repair.confirmRollback({
    previewToken: rollbackPreview.previewToken,
    now,
    confirmNative: () => true,
    freshnessCheck: () => true,
    commitReplacement: commitFor(f.storePath, []),
  })).code, 'PREVIEW_CONSUMED')
})

test('refuses a tampered completed backup before native admission or commit', async () => {
  const f = fixture('backup-scope-mismatch')
  const preview = await prepare(f)
  fs.appendFileSync(preview.plan.backupPath, 'tampered')
  let nativeCalls = 0
  let commitCalls = 0
  const result = await repair.confirmRepair({
    previewToken: preview.previewToken,
    now,
    confirmNative: () => {
      nativeCalls += 1
      return true
    },
    freshnessCheck: () => true,
    commitReplacement: () => {
      commitCalls += 1
      return { ok: true }
    },
  })
  assert.equal(result.code, 'BACKUP_SCOPE_MISMATCH')
  assert.equal(nativeCalls, 0)
  assert.equal(commitCalls, 0)
  assert.equal(fs.readFileSync(f.storePath, 'utf8'), f.originalText)
})
