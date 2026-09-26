/* c5, soak of candidate 4 (3 of 92 delete-on-exit quits): "Delete agent nodes
 * when the app exits" was held after a CLEAN quit, and a held operation keeps
 * task filing held for that profile.
 *
 * The chain, with the real shell modules: prepareNodePrivacyCleanup deletes
 * the saved trees and writes them down at once (flushFleetSync), but the
 * delete had also armed the 250 ms debounced write, which nothing cleared. When
 * it fired it wrote the same bytes again, asynchronously, and while that write
 * ran every read-back was refused -- so a complete() landing in it threw, the
 * Ledger operation stayed committed and the pending marker stayed behind. The
 * quit swallowed the reason. flushFleetDocuments() could also answer
 * `undefined` instead of `{ ok }` while such a write ran.
 *
 *   node --test --import=./tools/test/lib/isolate-native-state-root.mjs tools/test/c5-b22-fleet-flush-privacy-exit.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { parseAst } from 'rollup/parseAst'

const require = createRequire(import.meta.url)
const prefsModule = require('../../shell/renderer-prefs.cjs')
const { createNodePrivacyCleanup, PENDING_KEY } = require('../../shell/node-privacy-cleanup.cjs')
const { createAppShutdownCoordinator } = require('../../shell/research-shutdown.cjs')
const mainSource = fs.readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const TREE = 'mc.fleet.trees.v1:computer-1'

/* The real fs, except that an fsync on the asynchronous path takes `slowMs`
   (a loaded disk, as in the soak). The synchronous path is untouched. */
function slowSyncFs(slowMs) {
  const promises = Object.create(fs.promises)
  promises.open = async (...args) => {
    const handle = await fs.promises.open(...args)
    const sync = handle.sync.bind(handle)
    handle.sync = async () => { await pause(slowMs); return sync() }
    return handle
  }
  return Object.create(fs, { promises: { value: promises } })
}

function savedTrees(t, { slowMs = 400 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'c5-b22-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, prefsModule.RENDERER_FLEET_FILE),
    JSON.stringify({ storageVersion: 1, values: { [TREE]: JSON.stringify({ nodes: [{ id: 'n1' }] }) } }) + '\n')
  const prefs = createPrefs(directory, slowMs)
  return { directory, prefs }
}
function createPrefs(directory, slowMs) {
  return prefsModule.createRendererPrefs({ directory, fs: slowSyncFs(slowMs), path, randomUUID })
}

function privacyCleanup(prefs) {
  const ledger = { phase: null }
  const cleanup = createNodePrivacyCleanup({
    prefs,
    org: { resetOrg: () => ({ ok: true }) },
    transcripts: { clearForPrivacy: async () => {} },
    ownerGone: marker => { ledger.phase = 'committed'; return { durable: true, operationId: marker.operationId, phase: 'committed' } },
    finalizeOwnerGone: input => { ledger.phase = 'finalized'; return { durable: true, operationId: input.operationId, phase: 'finalized' } },
  })
  return { cleanup, ledger }
}

test('c5 B22: the privacy cleanup finishes when complete() lands after the delete\'s debounce would have fired', async t => {
  const { prefs } = savedTrees(t)
  const { cleanup, ledger } = privacyCleanup(prefs)
  cleanup.prepare() // the quit's deleteNodes(): Ledger commit, then the trees are deleted and written down
  assert.equal(ledger.phase, 'committed', 'fixture premise: the Ledger committed the operation')
  // Between prepare and complete the quit removes the handoffs and the transcripts: a
  // gap that, on a loaded disk, ends after FLEET_FLUSH_DEBOUNCE_MS (250 ms).
  await pause(prefsModule.FLEET_FLUSH_DEBOUNCE_MS + 50)
  let threw = null
  try { cleanup.complete() } catch (error) { threw = error }
  assert.equal(threw, null, `THE DEFECT: complete() refused a clean cleanup (${threw?.message})`)
  assert.equal(ledger.phase, 'finalized', 'the Ledger operation was left committed, so task filing stays held')
  assert.equal(prefs.snapshot().values[PENDING_KEY], undefined, 'the pending marker was left behind, so the next launch holds it')
  assert.equal(prefs.confirmNodePrivacyCleanup().ok, true)
  await prefs.flushFleetDocuments()
})

test('c5 B22: a synchronous flush leaves no debounced write behind for the same bytes', async t => {
  const { prefs } = savedTrees(t)
  assert.equal(prefs.prepareNodePrivacyCleanup().ok, true)
  await pause(prefsModule.FLEET_FLUSH_DEBOUNCE_MS + 50)
  assert.equal(prefs.confirmNodePrivacyCleanup().ok, true,
    'a write of bytes already on disk started after the synchronous flush and blocked the read-back')
})

test('c5 B22: flushFleetDocuments() answers { ok } even while an earlier write of the same bytes is still running', async t => {
  const { prefs } = savedTrees(t)
  assert.equal(prefs.set(TREE, JSON.stringify({ nodes: [{ id: 'n2' }] })).ok, true)
  const first = prefs.flushFleetDocuments() // an asynchronous write, held in its slow fsync
  assert.equal(prefs.flushFleetDocumentsSync().ok, true) // the same revision, written down at once
  const answer = await prefs.flushFleetDocuments()
  assert.equal(answer !== null && typeof answer === 'object', true, `THE DEFECT: the flush answered ${answer}, and the quit reads answer.ok`)
  assert.equal(answer.ok, true)
  // It answered only once the earlier write had ended: the read-back now meets
  // bytes at rest and refuses for what they hold, not for a write still running.
  assert.match(prefs.confirmNodePrivacyCleanup().error?.message || '', /still contains saved node bytes/,
    'flushFleetDocuments() answered while an earlier fleet write was still running')
  assert.equal((await first).ok, true)
  assert.equal(prefs.confirmNodePrivacyCleanup().ok, false, 'fixture premise: the tree is still saved, so a privacy read-back is refused')
})

/* c5 review: A WRITE ALREADY RUNNING WHEN THE CLEANUP FLUSHES RENAMES OLDER
   BYTES OVER THE CLEANED FILE. A tree saved during the quit arms the debounced
   write; it fires and captures the bytes WITH the tree, then sits in its fsync.
   prepare() deletes the trees and writes the cleaned file at once. The older
   write's rename then lands on top of it, and it used to record the newer
   revision as written, so flushFleetDocuments() answered ok with the deleted
   tree back on disk: complete() refused, the operation was held, and the next
   launch loaded the deleted tree. */
test('c5 B22: a fleet write running when the privacy cleanup flushes cannot put the deleted trees back', async t => {
  const { directory, prefs } = savedTrees(t, { slowMs: 120 })
  const { cleanup, ledger } = privacyCleanup(prefs)
  assert.equal(prefs.set(TREE, JSON.stringify({ nodes: [{ id: 'n1' }, { id: 'n2' }] })).ok, true) // a tree save during the quit
  await pause(prefsModule.FLEET_FLUSH_DEBOUNCE_MS + 20) // its debounced write is now in its fsync
  cleanup.prepare()
  assert.equal((await prefs.flushFleetDocuments()).ok, true)
  const disk = JSON.parse(fs.readFileSync(path.join(directory, prefsModule.RENDERER_FLEET_FILE), 'utf8'))
  assert.equal(TREE in disk.values, false, 'THE DEFECT: the older write renamed the deleted tree back over the cleaned file')
  let threw = null
  try { cleanup.complete() } catch (error) { threw = error }
  assert.equal(threw, null, `complete() refused (${threw?.message})`)
  assert.equal(ledger.phase, 'finalized')
})

test('c5 B22: the quit waits for any fleet write still running before it finishes the privacy cleanup', async () => {
  const statements = parseAst(mainSource).body
  const found = statements.filter(node => node.type === 'FunctionDeclaration' && node.id?.name === 'closeAgentSessionsForQuit')
  assert.equal(found.length, 1, 'main.cjs has one closeAgentSessionsForQuit')
  const events = []
  let writing = null
  const context = {
    nodeRecovery: { stop: async () => {} },
    agentSessions: new Map(),
    recordSessionEnd() {},
    agentHost: { closeAll: async () => {} },
    transcriptCapture: { sealForShutdown: () => null, shutdown: async () => {} },
    usageRecorder: null,
    rendererPrefs: {
      flushFleetDocuments() {
        events.push('fleet-flush')
        return writing ? writing.then(() => { events.push('fleet-flush-settled'); return { ok: true } }) : Promise.resolve({ ok: true })
      },
    },
    nodeTranscripts: {
      async shutdown({ deleteNodes }) {
        await deleteNodes()
        // The delete's own write is still running when the transcript store closes.
        writing = pause(30)
        events.push('node-transcripts-closed')
      },
    },
    nodePrivacyCleanup: {
      prepare() { events.push('prepare') },
      async clearRecoveryHandoffs() {},
      complete() { events.push('complete') },
    },
  }
  const closeAgentSessionsForQuit = runInNewContext('(' + mainSource.slice(found[0].start, found[0].end) + ')', context)
  await closeAgentSessionsForQuit()
  assert.deepEqual(events.slice(events.indexOf('node-transcripts-closed')),
    ['node-transcripts-closed', 'fleet-flush', 'fleet-flush-settled', 'complete'],
    'THE DEFECT: complete() read the fleet file back while a write of it was still running')
})

test('c5 B22: when closing the agents fails, the quit says why in the log', async () => {
  const logged = []
  const original = console.error
  console.error = (...args) => { logged.push(args.join(' ')) }
  let done
  try {
    const coordinator = createAppShutdownCoordinator({
      quit() {},
      closeAgents: async () => { throw Object.assign(new Error('The privacy cleanup fleet bytes are not in a confirmed durable state.'), { code: 'MC_TREE_READBACK_UNCONFIRMED' }) },
      onComplete(result) { done = result },
      schedule: callback => callback, unschedule() {},
    })
    coordinator.beforeQuit({ preventDefault() {} })
    for (let turn = 0; turn < 20 && !done; turn += 1) await Promise.resolve()
  } finally {
    console.error = original
  }
  assert.equal(done?.agents, 'unknown', 'fixture premise: the closure is unconfirmed')
  assert.equal(logged.some(line => /MC_TREE_READBACK_UNCONFIRMED/.test(line) && /not in a confirmed durable state/.test(line)), true,
    `THE DEFECT: the reason the agents could not be closed was swallowed (logged: ${JSON.stringify(logged)})`)
})
