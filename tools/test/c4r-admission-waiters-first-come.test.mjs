/* c4 review, low item (1.0.48 candidate 4). Since B31 a send waits (up to 30 s)
 * while another agent's message is being saved. main.cjs's reservation hook
 * woke every second to ask again, and each wake-up put that waiter BEHIND every
 * waiter that arrived in the meantime: the store wakes waiters in the order they
 * started waiting, and a waiter that re-subscribes has just started again. So
 * two agents waiting on one save were served newest first. The hook now waits
 * to its deadline in one call; release and storage failure already wake it.
 *
 * Real agent host + main.cjs's own reservation hook + the real node transcript
 * store and recovery journal, as b31-team-member-brief-admission does.
 *
 *   node --test --import=./tools/test/lib/isolate-native-state-root.mjs tools/test/c4r-admission-waiters-first-come.test.mjs
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

test('c4r: two sends waiting on one save go in the order they started waiting', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'te-c4r-order-'))
  const journal = createTranscriptRecoveryJournal({ directory: path.join(directory, 'recovery'), capacityBytes: 8 * 1024 * 1024 })
  await journal.ready
  const store = createNodeTranscriptStore({ directory, recoveryJournal: journal })
  const bindings = new Map()
  const reserve = mainReservationHook({
    assertConversationWritable: () => store.assertWritable(),
    transcriptCapture: { bindingFor: sessionId => bindings.get(sessionId) || null },
    nodeTranscripts: store,
  })
  const capture = createNodeTranscriptCapture({ store })
  for (const sessionId of ['holder', 'first', 'second']) {
    const binding = { sessionId, computerId: 'this-computer', nodeId: sessionId }
    bindings.set(sessionId, binding); capture.bind(binding)
  }
  const ack = Promise.withResolvers(), entered = Promise.withResolvers()
  const dispatched = []
  t.mock.method(engine, 'startCodexSession', async options => ({
    threadId: 'thread-' + options.sessionId, close() {}, adapter: {
      sendTurn(request) {
        dispatched.push(request.text.split(' ')[0])
        if (dispatched.length === 1) { entered.resolve(); return ack.promise }
        return { turnId: 'turn-' + dispatched.length }
      },
      async interrupt() {}, answerApproval() {},
    },
  }))
  const host = createAgentHost({ enginePath, defaultCwd: directory, profileRoot: path.parse(directory).root,
    freeMemory: () => 64 * 1024 ** 3,
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
    assertTranscriptWritable: () => store.assertWritable(),
    reserveTranscriptTurn: reserve,
  })
  host.onAcceptedPrompt(request => capture.recordAcceptedTranscriptSend(request))
  for (const sessionId of ['holder', 'first', 'second']) await host.startSession({ sessionId })
  t.after(async () => { ack.resolve({ turnId: 'turn-1' }); await host.closeAll().catch(() => {}); await journal.close(); await fs.rm(directory, { recursive: true, force: true }) })

  const holding = host.sendTurn({ sessionId: 'holder', text: 'holder brief.', origin: 'person' })
  await entered.promise
  const first = host.sendTurn({ sessionId: 'first', text: 'first message.', origin: 'person' })
  await pause(500)
  const second = host.sendTurn({ sessionId: 'second', text: 'second message.', origin: 'person' })
  // Past the old one-second wake-up of the first waiter, before any deadline.
  await pause(800)
  assert.deepEqual(dispatched, ['holder'], 'both wait while the holder is being saved')
  ack.resolve({ turnId: 'turn-1' })
  await holding
  await Promise.all([first, second])
  assert.deepEqual(dispatched, ['holder', 'first', 'second'], 'THE DEFECT: the waiter that came later went first')
  assert.equal(store.getStorageStatus().pendingTurns, 0)
})
