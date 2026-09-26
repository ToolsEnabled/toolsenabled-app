/* c4 second review (1.0.48 candidate 4), correctness D1: a tree Halt that
 * cancelled a send still WAITING to be saved (B31's up-to-30 s admission wait)
 * stopped no turn. The host answers { turnId: null, sendCancelled: true }. The
 * tree passes sessionOpenTurns.get(sessionId), which is undefined because no
 * turn opened, so turnInterrupts stored accepted = null -- and consume() reads
 * null as "any turn". The person's NEXT real turn was then read as "stopped by
 * you": a failed turn showed "Stopped" instead of the engine's sentence, the
 * queue behind it was not drained and a pending model choice was cancelled.
 *
 *   node --test --import=./tools/test/lib/isolate-native-state-root.mjs tools/test/c4r2-halt-waiting-send-next-turn.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createTurnInterrupts } from '../../src/turn-interrupts.js'
import { payloadSkip, runningCircle, waitFor, liveCase, settle } from './lib/t158-switch-model-harness.mjs'

test('c4r2 D1: a Halt that cancelled a waiting send leaves no stop marker for the next real turn', async () => {
  const interrupts = createTurnInterrupts()
  const answer = await interrupts.request('s1', undefined,
    async () => ({ sessionId: 's1', turnId: null, sendCancelled: true, goalPaused: false }))
  assert.equal(answer.sendCancelled, true)
  assert.equal(interrupts.consume('s1', 'turn-real-next'), false,
    'the next real turn was read as stopped by the person')
})

test('c4r2 D1: a Halt that stopped a running turn still marks that turn (guard)', async () => {
  const interrupts = createTurnInterrupts()
  await interrupts.request('s1', 'turn-1', async () => ({ sessionId: 's1', turnId: 'turn-1' }))
  assert.equal(interrupts.consume('s1', 'turn-1'), true)
})

test('c4r2 D1: tree /interrupt on a waiting send, then the resent turn fails: the circle reads turn-failed, not stopped', { skip: payloadSkip }, async t => {
  const ctx = await runningCircle(t, { replacementStart: async () => { throw new Error('unused') } })
  let rejectWaiting
  const sends = []
  liveCase.send = request => {
    ctx.calls.push({ call: 'send', sessionId: request?.sessionId, request })
    sends.push(request.text)
    if (sends.length === 1) return new Promise((_, reject) => { rejectWaiting = reject })
    return Promise.resolve({ ok: true, turnId: 'turn-next' })
  }
  // The host's answer to Halt on a waiting send (shell/agent-host.cjs interrupt()).
  liveCase.interrupt = async request => {
    ctx.calls.push({ call: 'interrupt', sessionId: request?.sessionId, request })
    queueMicrotask(() => rejectWaiting(new Error('MC_TRANSCRIPT_SEND_STOPPED')))
    return { sessionId: request.sessionId, turnId: null, sendCancelled: true, goalPaused: false }
  }
  let chat = ctx.liveChat()
  chat.querySelector('.chat-input textarea').value = 'Waiting message.'
  chat.querySelector('.chat-send').dispatch('click')
  await waitFor(() => sends.length === 1, 'the send to reach the bridge')
  await settle(6)
  chat = ctx.liveChat()
  chat.querySelector('.chat-input textarea').value = '/interrupt'
  chat.querySelector('.chat-send').dispatch('click')
  await waitFor(() => ctx.calls.some(c => c.call === 'interrupt'), 'Halt to reach the host')
  await settle(10)
  chat = ctx.liveChat()
  chat.querySelector('.chat-input textarea').value = 'Second message.'
  chat.querySelector('.chat-send').dispatch('click')
  await waitFor(() => sends.length === 2, 'the resend to reach the bridge')
  await waitFor(() => ctx.readNode().status === 'running', 'the next turn to run')
  ctx.emit({ sessionId: ctx.OLD_SESSION, event: { type: 'turn_completed', status: 'failed', turnId: 'turn-next', text: 'You have hit your session limit.' } })
  await waitFor(() => ctx.readNode().status !== 'running', 'the next turn to end')
  assert.equal(ctx.readNode().status === 'turn-failed', true,
    `the resent turn failed; it read "${ctx.readNode().status}" (stopped by the person) instead`)
})
