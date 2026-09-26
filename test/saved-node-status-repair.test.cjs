'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const repair = require('../shell/saved-node-status-repair.cjs')
const currentFixture = path.join(__dirname, 'fixtures', 'saved-node-status-repair-current13.json')
const snapshotFixture = path.join(__dirname, 'fixtures', 'saved-node-status-repair-snapshot13.json')
const key = 'mc.fleet.trees.v1:synthetic-computer'
const now = '2026-09-21T20:00:00.000Z'
const later = '2026-09-21T20:11:00.000Z'
const targets = Array.from({ length: 13 }, (_, i) => 'node-' + String(i + 1).padStart(3, '0') + '-synthetic')
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-node-status-repair-retained-'))
  const storePath = path.join(root, 'renderer-fleet-documents.json')
  const snapshotPath = path.join(root, 'saved-snapshot.json')
  fs.copyFileSync(currentFixture, storePath); fs.copyFileSync(snapshotFixture, snapshotPath)
  return { root, storePath, snapshotPath, originalText: fs.readFileSync(storePath, 'utf8') }
}
function prepare(f, extra = {}) { return repair.prepareRepair({ storePath: f.storePath, snapshotPath: f.snapshotPath, now, freshnessCheck: () => true, ...extra }) }
function commitFor(storePath, calls) {
  return ({ expectedText, replacementText }) => {
    calls.push({ expectedText, replacementText }); assert.equal(fs.readFileSync(storePath, 'utf8'), expectedText)
    fs.writeFileSync(storePath, replacementText); const fd = fs.openSync(storePath, 'r')
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }; return { ok: true }
  }
}
function inner(filePath) { return JSON.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')).values[key]) }
function mutateSnapshotIdentity(f) {
  const outer = JSON.parse(fs.readFileSync(f.snapshotPath, 'utf8')); const tree = JSON.parse(outer.values[key])
  tree.nodes[0].sessionId = 'different-session'; outer.values[key] = JSON.stringify(tree); fs.writeFileSync(f.snapshotPath, JSON.stringify(outer))
}
function assertRestored(f) {
  const outer = JSON.parse(fs.readFileSync(f.storePath, 'utf8')); const tree = JSON.parse(outer.values[key])
  assert.equal(outer.marker, 'retain-outer-field')
  for (const [i, node] of tree.nodes.entries()) {
    assert.equal(node.status, 'finished'); assert.equal(node.title, 'retained-' + (i + 1)); assert.deepEqual(node.bytes, { keep: 'field-' + (i + 1) })
    assert.equal(node.sessionId, 'session-synthetic-' + (i + 1)); assert.equal(node.lastTurnId, 'turn-synthetic-' + (i + 1))
    if (i < 12) assert.equal(node.statusNote, 'finished-' + (i + 1)); else assert.equal(Object.hasOwn(node, 'statusNote'), false)
  }
}
async function main() {
  {
    const f = fixture(); const phases = []; const p = await prepare(f, { freshnessCheck: (x) => { phases.push(x.phase); return true } })
    assert.equal(p.ok, true); assert.equal(p.plan.changes.length, 13); assert.deepEqual(p.plan.skipped, [])
    assert.match(p.plan.backupPath, /[.]repair-backup-/); assert.equal(fs.readFileSync(p.plan.backupPath, 'utf8'), f.originalText)
    const calls = []; const c = await repair.confirmRepair({ previewToken: p.previewToken, now, confirmNative: (x) => { assert.equal(x.snapshotPath, f.snapshotPath); return true }, freshnessCheck: (x) => { phases.push(x.phase); return true }, commitReplacement: commitFor(f.storePath, calls) })
    assert.equal(c.ok, true); assert.equal(c.restoredNodeIds.length, 13); assert.deepEqual(Object.keys(calls[0]).sort(), ['expectedText', 'replacementText']); assertRestored(f)
    assert.ok(phases.includes('backup')); assert.ok(phases.includes('stage')); assert.ok(phases.includes('commit')); assert.ok(fs.readdirSync(f.root).some((name) => name.includes('.repair-stage-')))
  }
  {
    const f = fixture(); const p = await prepare(f); const r = await repair.confirmRepair({ previewToken: p.previewToken, now, confirmNative: () => true, freshnessCheck: () => true })
    assert.equal(r.code, 'SYNCHRONOUS_COMMIT_REFUSED_UNAVAILABLE')
  }
  {
    const f = fixture(); const r = await prepare(f, { trigger: 'startup' }); assert.equal(r.code, 'EXPLICIT_ACTION_REQUIRED')
  }
  {
    const f = fixture(); const p = await prepare(f); const r = await repair.confirmRepair({ previewToken: p.previewToken, now, confirmNative: () => ({ ok: true }), freshnessCheck: () => true, commitReplacement: commitFor(f.storePath, []) })
    assert.equal(r.code, 'NATIVE_CONFIRM_REFUSED'); assert.equal(fs.readFileSync(f.storePath, 'utf8'), f.originalText)
  }
  {
    const f = fixture(); const p = await prepare(f); const r = await repair.confirmRepair({ previewToken: p.previewToken, now, confirmNative: () => true, freshnessCheck: (x) => x.phase !== 'stage', commitReplacement: commitFor(f.storePath, []) })
    assert.equal(r.code, 'FRESHNESS_REFUSED'); assert.equal(fs.readFileSync(f.storePath, 'utf8'), f.originalText)
  }
  {
    const f = fixture(); const p = await prepare(f); let keys
    const r = await repair.confirmRepair({ previewToken: p.previewToken, now, confirmNative: () => true, freshnessCheck: () => true, commitReplacement: (x) => { keys = Object.keys(x).sort(); return { ok: false, error: { code: 'MC_PREFS_DAMAGED', message: 'synthetic cache is damaged' } } } })
    assert.equal(r.code, 'MC_PREFS_DAMAGED'); assert.equal(r.reason, 'synthetic cache is damaged'); assert.deepEqual(keys, ['expectedText', 'replacementText'])
  }
  {
    const f = fixture(); mutateSnapshotIdentity(f); const p = await prepare(f)
    assert.equal(p.plan.changes.length, 12); assert.deepEqual(p.plan.skipped[0], { valueKey: key, nodeId: targets[0], reason: 'SESSION_OR_TURN_ID_MISMATCH' })
    const r = await repair.confirmRepair({ previewToken: p.previewToken, now, confirmNative: () => true, freshnessCheck: () => true, commitReplacement: commitFor(f.storePath, []) })
    assert.equal(r.ok, true); assert.equal(inner(f.storePath).nodes[0].status, 'turn-failed'); assert.equal(inner(f.storePath).nodes[1].status, 'finished')
  }
  {
    const f = fixture(); const p = await prepare(f); const r = await repair.confirmRepair({ previewToken: p.previewToken, now: later, confirmNative: () => true, freshnessCheck: () => true, commitReplacement: commitFor(f.storePath, []) })
    assert.equal(r.code, 'PREVIEW_EXPIRED')
  }
  {
    const f = fixture(); fs.writeFileSync(f.storePath, ''); assert.equal((await prepare(f)).code, 'STORE_EMPTY')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-node-status-repair-unreadable-')); const missing = { storePath: path.join(root, 'missing.json'), snapshotPath: path.join(root, 'snapshot.json') }; fs.copyFileSync(snapshotFixture, missing.snapshotPath)
    assert.equal((await prepare(missing)).code, 'STORE_UNREADABLE')
  }
  {
    const f = fixture(); const api = { readFile: (...x) => fsp.readFile(...x), stat: (...x) => fsp.stat(...x), mkdir: (...x) => fsp.mkdir(...x), copyFile: async () => { throw Error('backup') }, writeFile: (...x) => fsp.writeFile(...x), rename: (...x) => fsp.rename(...x), open: (...x) => fsp.open(...x) }
    assert.equal((await prepare(f, { fs: api })).code, 'BACKUP_FAILED')
    const durable = { ...api, copyFile: (...x) => fsp.copyFile(...x), open: async () => { throw Error('fsync') } }
    assert.equal((await prepare(f, { fs: durable })).code, 'DURABILITY_FAILED')
  }
  {
    const f = fixture(); assert.equal((await prepare(f, { targetIds: Array.from({ length: repair.MAX_TARGETS + 1 }, (_, i) => 'node-' + i) })).code, 'TARGET_BOUND_EXCEEDED')
    const s = repair.planSeatRepair({ nodeIds: ['node-001-synthetic', 'node-002-synthetic'], seats: [{ seatId: 'node-001-seat', nodeId: 'node-001-synthetic' }, { seatId: 'node-999-seat', nodeId: 'node-999-synthetic' }] })
    assert.deepEqual(s.releaseCandidates, ['node-999-seat']); assert.deepEqual(s.missingSeatNodeIds, ['node-002-synthetic']); assert.deepEqual(s.grants, []); assert.deepEqual(s.authorityChanges, []); assert.equal(s.refusal, 'MISSING_RELEASED_SEAT_OWNER_ASSIGNMENT_REQUIRED')
  }
  {
    const f = fixture(); const p = await prepare(f); assert.equal((await repair.confirmRepair({ previewToken: p.previewToken, now, confirmNative: () => true, freshnessCheck: () => true, commitReplacement: commitFor(f.storePath, []) })).ok, true)
    const rb = await repair.prepareRollback({ storePath: f.storePath, restorePath: p.plan.backupPath, now, freshnessCheck: () => true }); assert.equal(rb.ok, true)
    assert.equal((await repair.confirmRollback({ previewToken: rb.previewToken, now, confirmNative: () => true, freshnessCheck: () => true, commitReplacement: commitFor(f.storePath, []) })).ok, true)
    assert.equal(fs.readFileSync(f.storePath, 'utf8'), f.originalText)
    assert.equal((await repair.confirmRollback({ previewToken: rb.previewToken, now, confirmNative: () => true, freshnessCheck: () => true, commitReplacement: commitFor(f.storePath, []) })).code, 'PREVIEW_CONSUMED')
  }
  console.log('saved-node-status-repair: PASS retained synthetic fixtures under /tmp; no cleanup performed')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
