/* c4 review (1.0.48 candidate 4): Stop pressed while a send WAITS for another
 * agent's transcript admission (B31's 30 s wait). The waiting send has
 * dispatched nothing, so Stop must be able to cancel it; today the host answers
 * AGENT_TURN_NONE ("nothing running") and then sends the message anyway once
 * the admission frees. Real agent host + main.cjs's own reservation hook + the
 * real node transcript store, as tools/test/b31-team-member-brief-admission.test.mjs.
 *
 *   node --test --import=./tools/test/lib/isolate-native-state-root.mjs tools/test/c4r-stop-while-send-waits.test.mjs
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

test('c4r: Stop on a send that is still waiting for the admission cancels it; it is never dispatched afterwards', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'te-c4r-'))
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
  for (const [sessionId, nodeId] of [['holder', 'holder'], ['waiter', 'waiter']]) {
    const binding = { sessionId, computerId: 'this-computer', nodeId }
    bindings.set(sessionId, binding); capture.bind(binding)
  }
  const ack = Promise.withResolvers(), entered = Promise.withResolvers()
  const dispatched = []
  t.mock.method(engine, 'startCodexSession', async options => ({
    threadId: 'thread-' + options.sessionId, close() {}, adapter: {
      sendTurn(request) {
        dispatched.push(request.text.startsWith('Holder') ? 'holder' : 'waiter')
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
  for (const sessionId of ['holder', 'waiter']) await host.startSession({ sessionId })
  t.after(async () => { ack.resolve({ turnId: 'turn-1' }); await host.closeAll().catch(() => {}); await journal.close(); await fs.rm(directory, { recursive: true, force: true }) })

  const first = host.sendTurn({ sessionId: 'holder', text: 'Holder brief.', origin: 'person' })
  await entered.promise
  const second = host.sendTurn({ sessionId: 'waiter', text: 'Waiter message.', origin: 'person' })
    .then(value => ({ ok: true, value }), error => ({ ok: false, code: error?.code }))
  await pause(50)
  assert.deepEqual(dispatched, ['holder'], 'the waiter is waiting, nothing of it dispatched')

  // The person presses Stop on the waiting agent (its tab shows "Working" and a Halt button).
  const stopped = await host.interrupt({ sessionId: 'waiter' }).then(value => ({ ok: true, value }), error => ({ ok: false, code: error?.code }))
  assert.equal(stopped.ok, true, `Stop on a waiting send was refused: ${stopped.code}`)
  assert.equal(stopped.value.sendCancelled, true, 'Stop says it cancelled a send, not a turn')

  // Stop ends the wait itself: the stopped send answers while the other
  // agent's save is still held, not when that save ends (up to 30 s later).
  const early = await Promise.race([second, pause(300).then(() => 'still waiting')])
  assert.equal(early !== 'still waiting', true,
    'Stop did not end the wait: the draft comes back only when the other save ends')

  ack.resolve({ turnId: 'turn-1' })
  await first
  const answer = await second
  await pause(50)
  assert.deepEqual(dispatched, ['holder'], 'the message the person stopped must never reach the provider')
  assert.equal(answer.ok, false, 'the stopped send answers as not sent')
  assert.equal(answer.code, 'MC_TRANSCRIPT_SEND_STOPPED', 'its own not-sent code, not AGENT_STOP_PENDING')

  // Nothing of Stop is left behind: the next message to the same agent goes.
  const next = await host.sendTurn({ sessionId: 'waiter', text: 'Waiter again.', origin: 'person' })
  assert.equal(typeof next.turnId, 'string')
  assert.deepEqual(dispatched, ['holder', 'waiter'])
  assert.equal(store.getStorageStatus().pendingTurns, 0)
})
