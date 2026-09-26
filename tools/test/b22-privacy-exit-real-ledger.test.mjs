/* B22: "Delete agent nodes when the app exits" against the REAL task Ledger.
 * Real shell/node-privacy-cleanup.cjs + shell/task-assignment-authority.cjs +
 * the engine's registered task Ledger writer + main.cjs's OWN
 * readTaskLedgerCoordinatorIdentity (evaluated from the main.cjs source, one
 * evaluation per simulated app process, so each gets its own
 * app-<pid>-<uuid> host session). getTaskLedgerWriter's
 * re-register-on-identity-change, prepareAndCommitOwnerGone and the quit
 * order nodeTranscripts.shutdown({deleteNodes: prepare}) -> complete() are
 * copied from main.cjs.
 * Run: T1630_ENGINE_ROOT=<engine checkout> node --test tools/test/b22-privacy-exit-real-ledger.test.mjs */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const canonicalRoot = process.env.MC_CANONICAL_ROOT
const ENGINE = process.env.T1630_ENGINE_ROOT
  || process.env.TOOLSENABLED_TEST_ENGINE_ROOT
  || (canonicalRoot
    && (fs.existsSync(path.join(canonicalRoot, 'src', 'lib', 'owner-request-store.js'))
      ? canonicalRoot
      : path.join(canonicalRoot, 'engine')))
if (!ENGINE) throw new Error('T1630_ENGINE_ROOT is required for the B22 real-Ledger fixture.')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'b22-judge-'))
process.env.TOOLSENABLED_STATE_ROOT = path.join(scratch, 'state-root')
fs.mkdirSync(process.env.TOOLSENABLED_STATE_ROOT, { recursive: true })
const store = require(path.join(ENGINE, 'src', 'lib', 'owner-request-store.js'))
const { createTaskTopologyAdmission } = require('../../shell/task-assignment-authority.cjs')
const { createNodePrivacyCleanup, PENDING_KEY } = require('../../shell/node-privacy-cleanup.cjs')
const FLEET = 'mc.fleet.trees.v1:this-computer'
const mainSource = fs.readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
const RESET_KEY = 'mc.reset.owner-gone.pending.v1'
const resetStart = mainSource.indexOf('const FULL_RESET_OWNER_GONE_KEY')
const resetEnd = mainSource.indexOf('function rememberTaskHandoffContext')
if (resetStart < 0 || resetEnd < resetStart) throw new Error('main.cjs full-reset owner-gone block not found')
/* One app process's full-reset (Erase) owner-gone helpers, from main.cjs itself. */
function mainResetHelpers(getTaskTopologyAdmission, rendererPrefs) {
  return new Function('getTaskTopologyAdmission', 'rendererPrefs', 'randomUUID',
    `${mainSource.slice(resetStart, resetEnd)}\nreturn { prepareFullResetOwnerGone, recoverFullResetOwnerGone }`)(getTaskTopologyAdmission, rendererPrefs, crypto.randomUUID)
}
const identityStart = mainSource.indexOf('const TASK_LEDGER_HOST_SESSION_ID')
const identityEnd = mainSource.indexOf('function readCompleteSavedFleet(')
if (identityStart < 0 || identityEnd < identityStart) throw new Error('main.cjs coordinator identity block not found')
/* One app process's readTaskLedgerCoordinatorIdentity, from main.cjs itself. */
function mainIdentityReader(readOrgRevision) {
  const agentOrgRecord = { read: () => ({ ok: true, org: { revision: readOrgRevision() } }) }
  return new Function('randomUUID', 'process', 'agentOrgRecord',
    `${mainSource.slice(identityStart, identityEnd)}\nreturn readTaskLedgerCoordinatorIdentity`)(crypto.randomUUID, process, agentOrgRecord)
}

function profile({ orgRevision = 4, fleet = true, tasks = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(scratch, 'profile-'))
  const opts = { rootPath: (...p) => path.join(root, ...p), needsApproval: false, loadSettings: () => ({ values: {} }) }
  const prefs = {}
  store.ensureLedger(opts)
  if (fleet) prefs[FLEET] = JSON.stringify({ computerId: 'this-computer', trees: [{ id: 'tree-1' }], nodes: [{ id: 'node-2', treeId: 'tree-1', parentId: null }] })
  for (let i = 0; i < tasks; i++) store.fileTask({ scope: 'tree', key: 'node-2', words: `task ${i}`, filedBy: 'person' }, opts)
  return { opts, disk: { orgRevision, transcripts: 3, prefs } }
}
const ledgerOps = p => JSON.parse(fs.readFileSync(p.opts.rootPath('reports', 'OWNER-REQUEST-LEDGER.json'), 'utf8')).handoffOperations || []

/* One app process: its own TASK_LEDGER_HOST_SESSION_ID, writer and admission. */
function appSession(p, { killAfterLedgerCommit = false, killAfterFinalize = false, killAfterLedgerPrepare = false } = {}) {
  const identity = mainIdentityReader(() => p.disk.orgRevision)
  let writer = null, registration = null, key = null
  const getTaskLedgerWriter = (input = {}) => {   // main.cjs getTaskLedgerWriter
    let coordinatorIdentity
    try { coordinatorIdentity = identity(input) } catch { return null }
    const k = JSON.stringify(coordinatorIdentity)
    if (writer && key === k) return writer
    if (registration) store.revokeTaskLedgerWriter(registration, 'COORDINATOR_IDENTITY_CHANGED')
    registration = store.registerTaskLedgerWriter({ options: { ...p.opts, taskLedgerOptions: { coordinatorIdentity } },
      principal: 'native-removal-service', resolveAuthority() { throw new Error('not a node removal') } })
    writer = store.taskLedgerWriter(registration); key = k
    return writer
  }
  const admission = createTaskTopologyAdmission({
    getTaskWriter: getTaskLedgerWriter, readForest: () => { throw new Error('unused') },
    readAllForests: () => ({ ok: true, complete: true, forests: Object.keys(p.disk.prefs).filter(k => k.startsWith('mc.fleet.trees.v1:')).map(k => ({ ...JSON.parse(p.disk.prefs[k]), complete: true })) }),
    parseForest: v => JSON.parse(v), principal: 'native-removal-service', readCoordinatorIdentity: identity,
  })
  const prefs = {
    snapshot: () => ({ ok: true, values: { ...p.disk.prefs } }),
    set: (k, v) => { p.disk.prefs[k] = v; return { ok: true } },
    remove: k => { if (killAfterFinalize) throw Object.assign(new Error('process killed'), { killed: true }); delete p.disk.prefs[k]; return { ok: true } },
    prepareNodePrivacyCleanup: () => {
      if (killAfterLedgerCommit) throw Object.assign(new Error('process killed'), { killed: true })
      delete p.disk.prefs[FLEET]; return { ok: true }
    },
    confirmNodePrivacyCleanup: () => ({ ok: true, durable: true, sourceBytesAbsent: !(FLEET in p.disk.prefs) }),
  }
  const cleanup = createNodePrivacyCleanup({
    prefs,
    org: { resetOrg: () => { p.disk.orgRevision = 1; return { ok: true } } },   // resetToBaseline -> baseline revision 1
    transcripts: { clearForPrivacy: async () => { p.disk.transcripts = 0 } },
    ownerGone: marker => {
      admission.prepareAllNodeOwnerGone(marker)
      if (killAfterLedgerPrepare) throw Object.assign(new Error('process killed'), { killed: true })
      return admission.commitAllNodeOwnerGone(marker)
    },
    finalizeOwnerGone: input => admission.finalizeAllNodeOwnerGone(input),
  })
  const reset = mainResetHelpers(() => admission, prefs)
  return {
    reset,
    recover: () => cleanup.recover(),
    held: () => (typeof cleanup.heldCleanup === 'function' ? cleanup.heldCleanup() : undefined),
    // closeAgentSessionsForQuit with deleteNodesOnExit off: shutdown skips prepare().
    async quitSettingOff() { cleanup.complete() },
    // main.cjs startup chain: the full-reset recovery, then the privacy recovery.
    async startup() {
      const erase = await reset.recoverFullResetOwnerGone()
      const privacy = await cleanup.recover()
      return { erase, privacy }
    },
    async quit() {   // closeAgentSessionsForQuit with deleteNodesOnExit on
      cleanup.prepare()
      p.disk.transcripts = 0
      cleanup.complete()
    },
  }
}

test('B22-1 delete-on-exit quit finishes against real Ledger receipts (edited org, revision 4)', async () => {
  const p = profile({ orgRevision: 4 })
  await appSession(p).quit()
  assert.equal(p.disk.prefs[PENDING_KEY], undefined)
  assert.equal(p.disk.prefs[FLEET], undefined)
  assert.equal(p.disk.orgRevision, 1)
  assert.deepEqual(ledgerOps(p).map(op => op.phase), ['finalized'])
  await appSession(p).recover()
})

test('B22-2 minimal repro: fresh profile, no fleet, org never edited; quit then relaunch', async () => {
  const p = profile({ orgRevision: 1, fleet: false })
  await appSession(p).quit()
  assert.deepEqual(ledgerOps(p).map(op => op.phase), ['finalized'])
  await appSession(p).recover()
})

/* The hand-test profile f3: the quit's Ledger commit landed (session 1), then
   the quit threw before any delete, leaving the marker and a committed op. */
async function strandedLikeF3() {
  const p = profile({ orgRevision: 4 })
  await assert.rejects(appSession(p, { killAfterLedgerCommit: true }).quit(), /killed|could not finish/)
  assert.deepEqual(ledgerOps(p).map(op => [op.phase, op.taskCount]), [['committed', 0]])
  return p
}

test('B22-3 a cleanup committed by an earlier app session does not reject the next startup and deletes nothing', async () => {
  const p = await strandedLikeF3()
  const result = await appSession(p).recover()
  assert.equal(result?.held, true)
  assert.ok(p.disk.prefs[PENDING_KEY])
  assert.ok(p.disk.prefs[FLEET])
  assert.equal(p.disk.transcripts, 3)
  assert.deepEqual(ledgerOps(p).map(op => op.phase), ['committed'])
})

test('B22-4 a bricked profile upgraded to the fix: held launch, then the next quit deletes under a new operation', async () => {
  const p = await strandedLikeF3()
  const session = appSession(p)
  assert.equal((await session.recover())?.held, true)
  await session.quit()
  assert.equal(p.disk.prefs[PENDING_KEY], undefined)
  assert.equal(p.disk.prefs[FLEET], undefined)
  assert.deepEqual(ledgerOps(p).map(op => op.phase), ['committed', 'finalized'])
  await appSession(p).recover()
  // What stays for the engine: the stranded earlier-session barrier still holds filing.
  assert.throws(() => store.fileTask({ scope: 'global', key: null, words: 'probe', filedBy: 'person' }, p.opts), /held while all-node privacy-exit/)
})

test('B22-5 a quit killed after the Ledger commit (with tasks) holds the next launch instead of rejecting it', async () => {
  const p = profile({ orgRevision: 4, tasks: 2 })
  await assert.rejects(appSession(p, { killAfterLedgerCommit: true }).quit(), /killed|could not finish/)
  assert.deepEqual(ledgerOps(p).map(op => [op.phase, op.taskCount]), [['committed', 2]])
  const session = appSession(p)
  assert.equal((await session.recover())?.held, true)
  assert.ok(p.disk.prefs[FLEET])
  await session.quit()
  assert.deepEqual(ledgerOps(p).map(op => op.phase), ['committed', 'finalized'])
  assert.equal(p.disk.prefs[FLEET], undefined)
})

test('B22-6 a quit killed after finalize, before the marker is cleared, does not reject the next launch', async () => {
  const p = profile({ orgRevision: 4 })
  await assert.rejects(appSession(p, { killAfterFinalize: true }).quit(), /killed/)
  assert.deepEqual(ledgerOps(p).map(op => op.phase), ['finalized'])
  const result = await appSession(p).recover()
  assert.ok(result === undefined || result?.ok === true || result?.held === true)
})

test('B22-7 with the setting off, a held operation is not retried at every quit; turning it on deletes at the next quit', async () => {
  const p = await strandedLikeF3()
  const [stranded] = ledgerOps(p).map(op => op.operationId)
  const second = appSession(p)
  assert.equal((await second.recover())?.held, true)
  assert.deepEqual(second.held(), { operationId: stranded, code: 'T_LEDGER_WRITER_POLICY_DENIED' })
  await second.quitSettingOff()
  assert.equal(JSON.parse(p.disk.prefs[PENDING_KEY]).operationId, stranded, 'the held marker stays')
  assert.ok(p.disk.prefs[FLEET])
  assert.deepEqual(ledgerOps(p).map(op => op.phase), ['committed'])
  const third = appSession(p)
  assert.equal((await third.recover())?.held, true)
  await third.quit()
  assert.equal(p.disk.prefs[PENDING_KEY], undefined)
  assert.equal(p.disk.prefs[FLEET], undefined)
  // c5: the quit finished a NEW operation; the stranded one is still unfinished in the Ledger (B22-9).
  assert.deepEqual(ledgerOps(p).map(op => [op.operationId === stranded, op.phase]), [[true, 'committed'], [false, 'finalized']])
  assert.deepEqual(third.held(), { operationId: stranded, code: 'T_LEDGER_WRITER_POLICY_DENIED', kept: true },
    'the earlier operation is still unfinished, so it is still reported, as kept (the close itself finished)')
})

/* c5 (adversarial check of the candidate 4 soak): the next close after a held launch deletes under
   a NEW operation, finalizes it and removed the only marker naming the earlier one. The earlier
   operation stays committed in the Ledger, which keeps task filing held for good -- and with its
   marker gone, nothing said so any more: the Settings note went away at that close and never came
   back. A later process cannot continue the earlier operation (the Ledger binds it to the session
   that prepared it), so until the engine has a takeover path it is kept on record and reported. */
test('B22-9 a held operation stays reported after the next close finishes a new one, and at every later launch', async () => {
  const p = await strandedLikeF3()
  const [stranded] = ledgerOps(p).map(op => op.operationId)
  const second = appSession(p)
  assert.equal((await second.recover())?.held, true)
  await second.quit()
  assert.equal(p.disk.prefs[FLEET], undefined, 'the close deleted the saved nodes')
  assert.deepEqual(ledgerOps(p).map(op => [op.operationId === stranded, op.phase]), [[true, 'committed'], [false, 'finalized']],
    'fixture premise: the close finished a new operation and the earlier one is still unfinished')
  assert.equal(second.held()?.operationId, stranded,
    'THE DEFECT: the close cleared the hold while the earlier operation is still unfinished')
  for (let launch = 0; launch < 2; launch++) {
    const later = appSession(p)
    const recovered = await later.recover()
    assert.equal(recovered?.held, true, 'THE DEFECT: a later launch no longer reports the unfinished operation')
    assert.equal(recovered.operationId, stranded)
    assert.equal(later.held()?.operationId, stranded, 'the Settings note has nothing to say')
    assert.equal(later.held()?.kept, true, 'the Settings note is the kept one: the last close finished')
    await later.quit()
    assert.equal(later.held()?.operationId, stranded)
  }
  // Why it must stay said: the engine still holds task filing on it.
  assert.throws(() => store.fileTask({ scope: 'global', key: null, words: 'probe', filedBy: 'person' }, p.opts), /held while all-node privacy-exit/)
})

test('B22-8 a quit killed between the Ledger prepare and commit (with tasks) is held at every launch, and the hold is reported', async () => {
  const p = profile({ orgRevision: 4, tasks: 2 })
  await assert.rejects(appSession(p, { killAfterLedgerPrepare: true }).quit(), /killed/)
  for (let launch = 0; launch < 2; launch++) {
    const session = appSession(p)
    assert.equal((await session.recover())?.held, true)
    assert.ok(session.held()?.operationId, 'the host can tell the person')
    // The engine keeps the stranded prepared operation's hold on the tasks.
    await assert.rejects(session.quit(), error => error.code === 'T_LEDGER_OWNER_GONE_CLEANUP_SOURCE_PENDING')
    assert.ok(p.disk.prefs[FLEET], 'nothing was deleted')
  }
})

/* The Erase (full reset) sibling of B22. Erase commits its "Task ownership"
   step and then keeps the marker when a later step fails ("Restart ToolsEnabled
   before retrying"). The restart must not be refused over that operation, and
   the retried Erase must be able to commit. */
const resetMarker = p => (p.disk.prefs[RESET_KEY] ? JSON.parse(p.disk.prefs[RESET_KEY]).operationId : null)

async function erasedPartway() {
  const p = profile({ orgRevision: 4, tasks: 2 })
  const first = appSession(p).reset.prepareFullResetOwnerGone()
  assert.equal(first.receipt.phase, 'committed')
  assert.equal(resetMarker(p), first.marker.operationId)
  return { p, operationId: first.marker.operationId }
}

test('B22-R1 an Erase that failed after its Task ownership step does not reject the next startup', async () => {
  const { p, operationId } = await erasedPartway()
  const { erase } = await appSession(p).startup()
  assert.equal(erase?.held, true)
  assert.equal(erase.operationId, operationId)
  assert.equal(resetMarker(p), operationId, 'the marker is kept')
  assert.deepEqual(ledgerOps(p).map(op => [op.mode, op.phase]), [['full-reset', 'committed']], 'the Ledger barrier is kept')
  assert.ok(p.disk.prefs[FLEET], 'the held launch deletes nothing')
})

test('B22-R2 a retried Erase in the next session commits under a fresh operation', async () => {
  const { p, operationId } = await erasedPartway()
  const session = appSession(p)
  await session.startup()
  const retried = session.reset.prepareFullResetOwnerGone()
  assert.equal(retried.receipt.phase, 'committed')
  assert.notEqual(retried.marker.operationId, operationId)
  assert.equal(resetMarker(p), retried.marker.operationId)
  assert.deepEqual(ledgerOps(p).map(op => [op.operationId, op.phase]), [[operationId, 'committed'], [retried.marker.operationId, 'committed']])
})

test('B22-R3 an Erase retried in the same session continues its own operation', async () => {
  const p = profile({ orgRevision: 4 })
  const session = appSession(p)
  const first = session.reset.prepareFullResetOwnerGone()
  const again = session.reset.prepareFullResetOwnerGone()
  assert.equal(again.marker.operationId, first.marker.operationId)
  assert.deepEqual(ledgerOps(p).map(op => op.phase), ['committed'])
})

test('B22-R4 an Erase marker that never reached the Ledger is committed at startup and continued by that session', async () => {
  const p = profile({ orgRevision: 4 })
  p.disk.prefs[RESET_KEY] = JSON.stringify({ operationId: 'reset-never-reached', mode: 'full-reset', reason: 'full reset' })
  const session = appSession(p)
  const { erase } = await session.startup()
  assert.equal(erase?.phase, 'committed')
  const retried = session.reset.prepareFullResetOwnerGone()
  assert.equal(retried.marker.operationId, 'reset-never-reached')
  assert.deepEqual(ledgerOps(p).map(op => op.phase), ['committed'])
})

test('B22-R5 an Erase refused by a stranded privacy operation (killed between Ledger prepare and commit) does not reject the restart', async () => {
  const p = profile({ orgRevision: 4, tasks: 2 })
  await assert.rejects(appSession(p, { killAfterLedgerPrepare: true }).quit(), /killed/)
  assert.deepEqual(ledgerOps(p).map(op => [op.mode, op.phase]), [['privacy-exit', 'prepared']])
  const second = appSession(p)
  assert.equal((await second.startup()).privacy?.held, true)
  // The engine keeps the stranded prepared operation's hold on the tasks.
  assert.throws(() => second.reset.prepareFullResetOwnerGone(), error => error.code === 'T_LEDGER_OWNER_GONE_CLEANUP_SOURCE_PENDING')
  assert.ok(resetMarker(p))
  const { erase, privacy } = await appSession(p).startup()
  assert.equal(erase?.held, true)
  assert.equal(erase.code, 'T_LEDGER_OWNER_GONE_CLEANUP_SOURCE_PENDING')
  assert.equal(privacy?.held, true)
})
