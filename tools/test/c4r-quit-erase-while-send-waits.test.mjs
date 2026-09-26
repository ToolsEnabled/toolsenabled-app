/* c4 review, round 2 (1.0.48 candidate 4): quit or privacy erase while a send
 * WAITS for another agent's message to be saved (B31's up-to-30 s admission
 * wait). Not checked by the first review; read from the code: the waiting send
 * is invisible to closeAll (it is not in transcriptAdmissions until it has its
 * reservation), so closeAll returned with it still waiting. The moment the
 * holder's admission was released the waiter woke, reserved a turn in the
 * transcript store and its recovery journal, and so wrote into storage that the
 * quit had just shut down or the erase had just emptied.
 *
 * Both quit (closeAgentSessionsForQuit) and erase (mc-reset:erase) close the
 * agent host first. So closeAll must cancel every waiting send and wait until
 * each has left the transcript store; the waiting message is never sent, and
 * nothing is written after the erase.
 *
 * Real agent host + main.cjs's own reservation hook + the real node transcript
 * store (its quit shutdown with delete-on-exit, i.e. the privacy erase) and
 * recovery journal.
 *
 *   node --test --import=./tools/test/lib/isolate-native-state-root.mjs tools/test/c4r-quit-erase-while-send-waits.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import test from 'node:test'

const { createAgentHost } = await import('../../shell/agent-host.cjs')
const require = createRequire(import.meta.url)
const { createNodeTranscriptStore } = require('../../shell/node-transcript-store.cjs')
const { createNodeTranscriptCapture } = require('../../shell/node-transcript-capture.cjs')
const { createTranscriptRecoveryJournal } = require('../../shell/transcript-recovery-journal.cjs')
const enginePath = path.resolve(import.meta.dirname, 'fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const engine = require(enginePath)
const mainSource = await fs.readFile(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

function mainReservationHook(context) {
  const begin = mainSource.indexOf('    reserveTranscriptTurn: async request => {')
  const end = mainSource.indexOf('    providerSignIn:', begin)
  assert.ok(begin >= 0 && end > begin)
  return vm.runInNewContext('({' + mainSource.slice(begin, end) + '})', context).reserveTranscriptTurn
}

async function tree(root) {
  const out = []
  async function walk(dir) {
    let names
    try { names = await fs.readdir(dir, { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return; throw error }
    for (const entry of names) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { out.push(path.relative(root, full) + '/'); await walk(full) }
      else { const stat = await fs.stat(full); out.push(`${path.relative(root, full)} ${stat.size} ${stat.mtimeMs}`) }
    }
  }
  await walk(root)
  return out.sort()
}

async function rig(t, { io = fs } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'te-c4r-quit-'))
  const journal = createTranscriptRecoveryJournal({ directory: path.join(directory, 'recovery'), capacityBytes: 8 * 1024 * 1024 })
  await journal.ready
  const store = createNodeTranscriptStore({ directory, io, recoveryJournal: journal, settings: { deleteNodesOnExit: true } })
  const bindings = new Map()
  const reserve = mainReservationHook({
    assertConversationWritable: () => store.assertWritable(),
    transcriptCapture: { bindingFor: sessionId => bindings.get(sessionId) || null },
    nodeTranscripts: store,
  })
  const capture = createNodeTranscriptCapture({ store })
  for (const sessionId of ['holder', 'waiter']) {
    const binding = { sessionId, computerId: 'this-computer', nodeId: sessionId }
    bindings.set(sessionId, binding); capture.bind(binding)
  }
  const entered = Promise.withResolvers()
  const dispatched = []
  let acceptHolder = null
  t.mock.method(engine, 'startCodexSession', async () => {
    let running = null
    return {
      threadId: 'thread-' + Math.random().toString(16).slice(2),
      // As the Claude CLI adapter does, closing the process rejects its running turn.
      close() { running?.(Object.assign(new Error('closed'), { code: 'CLAUDE_CLI_CLOSED' })) },
      adapter: {
        sendTurn(request) {
          dispatched.push(request.text.split(' ')[0])
          if (dispatched.length === 1) { entered.resolve(); return new Promise((resolve, reject) => { running = reject; acceptHolder = resolve }) }
          return { turnId: 'turn-' + dispatched.length }
        },
        async interrupt() {}, answerApproval() {},
      },
    }
  })
  const host = createAgentHost({ enginePath, defaultCwd: directory, profileRoot: path.parse(directory).root,
    freeMemory: () => 64 * 1024 ** 3,
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
    assertTranscriptWritable: () => store.assertWritable(),
    reserveTranscriptTurn: reserve,
  })
  host.onAcceptedPrompt(request => capture.recordAcceptedTranscriptSend(request))
  for (const sessionId of ['holder', 'waiter']) await host.startSession({ sessionId })
  t.after(async () => { await host.closeAll().catch(() => {}); await journal.close().catch(() => {}); await fs.rm(directory, { recursive: true, force: true }) })
  const holding = host.sendTurn({ sessionId: 'holder', text: 'holder brief.', origin: 'person' }).catch(error => ({ code: error?.code }))
  await entered.promise
  let settled = null
  const waiting = host.sendTurn({ sessionId: 'waiter', text: 'waiter message.', origin: 'person' })
    .then(value => ({ ok: true, value }), error => ({ ok: false, code: error?.code }))
    .then(answer => { settled = answer; return answer })
  await pause(50)
  assert.deepEqual(dispatched, ['holder'], 'the waiter is waiting; nothing of it dispatched')
  return { directory, store, journal, capture, host, dispatched, holding, waiting, settled: () => settled, acceptHolder: value => acceptHolder(value) }
}

test('c4r: quit closes the host with a send waiting; the send is cancelled before closeAll returns and never sent', async t => {
  const r = await rig(t)
  const closing = r.host.closeAll().then(() => 'closed', error => 'close refused: ' + error?.message)
  const closed = await Promise.race([closing, pause(3000).then(() => 'still closing')])
  assert.equal(closed, 'closed')
  assert.notEqual(r.settled(), null, 'THE DEFECT: closeAll returned while a send was still waiting to reserve')
  assert.equal(r.settled().ok, false)
  assert.equal(r.settled().code, 'MC_TRANSCRIPT_SEND_STOPPED')
  // The holder's dispatched turn records its unconfirmed delivery as it releases.
  await r.holding
  assert.equal(r.store.getStorageStatus().pendingTurns, 0, 'no turn admission is left for the quit to trip on')
  await pause(100)
  assert.deepEqual(r.dispatched, ['holder'], 'the waiting message never reached the provider')
})

test('c4r: nothing is written into conversation storage once the host has closed, nor after the erase that follows', async t => {
  const r = await rig(t)
  await r.host.closeAll()
  // Quit and erase go on from here. Every send has settled: the waiter was
  // cancelled, and the holder's dispatched turn has recorded its unconfirmed
  // delivery and released its admission.
  const afterClose = await tree(r.directory)
  await pause(300)
  assert.deepEqual(await tree(r.directory), afterClose, 'THE DEFECT: a send wrote into conversation storage after the host closed')
  assert.equal(r.store.getStorageStatus().pendingTurns, 0)
  // The quit's own storage close; delete-on-exit is the privacy erase.
  const shut = await r.store.shutdown().then(value => value, error => ({ ok: false, message: error?.message }))
  assert.equal(shut.ok, true, `the store could not close: ${shut.message}`)
  assert.equal(shut.deleted, true, 'the conversation store was erased')
  const afterErase = await tree(r.directory)
  await pause(300)
  assert.deepEqual(await tree(r.directory), afterErase, 'nothing was written after the erase')
  assert.deepEqual(r.dispatched, ['holder'], 'the waiting message was never sent')
  assert.equal(r.settled().code, 'MC_TRANSCRIPT_SEND_STOPPED')
})

/* The other case the first review did not check: the disk fills while a send
   waits. The holder's accepted words cannot be saved, so its admission is kept
   (the store holds it for Retry saving) and would never be released. The store
   wakes waiters on a storage failure, and the hook now waits in ONE call to its
   deadline, so this pins that the failure -- not the 30 s deadline -- ends the
   wait: the waiter is refused as not sent, at once, and is never dispatched. */
test('c4r: a full disk while a send waits refuses the waiting send at once, as not sent', async t => {
  let full = false
  const io = { ...fs, writeFile: (...args) => full
    ? Promise.reject(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }))
    : fs.writeFile(...args) }
  const r = await rig(t, { io })
  full = true
  const started = Date.now()
  r.acceptHolder({ turnId: 'turn-1' })
  const answer = await Promise.race([r.waiting, pause(5000).then(() => ({ ok: null }))])
  assert.equal(answer.ok, false, 'the waiting send was still waiting after 5 s')
  assert.equal(answer.code, 'MC_TRANSCRIPT_DISK_FULL')
  assert.ok(Date.now() - started < 5000)
  assert.deepEqual(r.dispatched, ['holder'], 'the waiting message was never sent')
  // Space is freed and saving is retried, so the holder's accepted words land and the host can close.
  full = false
  // As main's retryConversationStorage does: the store, then the capture.
  const retried = await r.store.retry()
  assert.equal(retried.durable, true)
  await r.capture.retry?.({ durable: true })
  await r.holding
})

/* The narrow edge of the same rule: the reservation lands at the moment the
   close cancels it (a hook that does not answer the signal, or a claim made
   just before the abort). The host refuses the send and releases that claim --
   a write -- and closeAll must not return before the release has finished. */
test('c4r: a reservation that lands as the close cancels it is released before closeAll returns', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'te-c4r-edge-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const dispatched = [], releases = []
  let land = null
  t.mock.method(engine, 'startCodexSession', async () => ({
    threadId: 'thread-edge', close() {},
    adapter: { sendTurn(request) { dispatched.push(request.text); return { turnId: 'turn-edge' } }, async interrupt() {}, answerApproval() {} },
  }))
  const host = createAgentHost({ enginePath, defaultCwd: directory, profileRoot: path.parse(directory).root,
    freeMemory: () => 64 * 1024 ** 3,
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
    // Ignores the signal on purpose: it answers only when the test lets it.
    reserveTranscriptTurn: () => new Promise(resolve => { land = () => resolve({ reservationId: 'edge', reservedBytes: 1,
      release: async () => { releases.push('release'); await pause(100); releases.push('released'); return { ok: true } } }) }),
  })
  await host.startSession({ sessionId: 'edge' })
  const sending = host.sendTurn({ sessionId: 'edge', text: 'edge message.', origin: 'person' }).then(() => ({ ok: true }), error => ({ ok: false, code: error?.code }))
  await pause(20)
  let closedAt = null
  const closing = host.closeAll().then(() => { closedAt = [...releases] })
  await pause(20)
  land()
  await closing
  assert.deepEqual(closedAt, ['release', 'released'], 'closeAll returned before the cancelled send released its claim')
  assert.deepEqual(await sending, { ok: false, code: 'MC_TRANSCRIPT_SEND_STOPPED' })
  assert.deepEqual(dispatched, [])
})
