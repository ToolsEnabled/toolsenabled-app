import assert from 'node:assert/strict'
import test from 'node:test'
import { createTurnInterrupts } from '../../src/turn-interrupts.js'
import { turnCompletionWords } from '../../src/fleet-tree-copy.js'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('completion before interrupt acceptance waits and leaves queued work waiting', async () => {
  const interrupts = createTurnInterrupts()
  const host = deferred()
  const queued = ['next message']
  const request = interrupts.request('session', 'turn', () => host.promise)
  let outcome = 'running'
  const completion = (async () => {
    await interrupts.pending('session', 'turn')
    const userStopped = interrupts.consume('session', 'turn')
    outcome = userStopped ? 'interrupted' : 'turn-failed'
    if (!userStopped) queued.shift()
  })()
  await Promise.resolve()
  assert.equal(outcome, 'running')
  host.resolve({ ok: true })
  await Promise.all([request, completion])
  assert.equal(outcome, 'interrupted')
  assert.deepEqual(queued, ['next message'])
  assert.equal(interrupts.consume('session', 'next-turn'), false)
})

test('a refused interrupt releases the completion without misreporting a user stop', async () => {
  const interrupts = createTurnInterrupts()
  const host = deferred()
  const request = interrupts.request('session', 'turn', () => host.promise)
  const refusal = assert.rejects(request, /AGENT_SESSION_ENDED/)
  const completion = interrupts.pending('session', 'turn')
  host.reject(new Error('AGENT_SESSION_ENDED'))
  await Promise.all([refusal, completion])
  assert.equal(interrupts.consume('session', 'turn'), false)
})

test('accepted interrupt before completion is consumed once for the named turn', async () => {
  const interrupts = createTurnInterrupts()
  await interrupts.request('session', 'turn', async () => ({ ok: true }))
  assert.equal(interrupts.pending('session', 'turn'), null)
  assert.equal(interrupts.consume('session', 'turn'), true)
  assert.equal(interrupts.consume('session', 'turn'), false)
})

test('overlapping Stop doors share the host request and do not stop a newer turn', async () => {
  const interrupts = createTurnInterrupts()
  const host = deferred()
  let calls = 0
  const interrupt = () => { calls += 1; return host.promise }
  const first = interrupts.request('session', 'first', interrupt)
  const second = interrupts.request('session', 'first', interrupt)
  assert.ok(first === second)
  assert.equal(interrupts.pending('session', 'newer'), null)
  host.resolve({ ok: true })
  await first
  assert.equal(calls, 1)
  assert.equal(interrupts.consume('session', 'newer'), false)
})

test('retiring a session while Stop is pending cannot leave an accepted stop behind', async () => {
  const interrupts = createTurnInterrupts()
  const host = deferred()
  const request = interrupts.request('session', 'turn', () => host.promise)
  interrupts.forget('session')
  host.resolve({ ok: true })
  await request
  assert.equal(interrupts.consume('session', 'turn'), false)
})

test('a turn first named by its early completion cannot mark a later turn stopped', async () => {
  const interrupts = createTurnInterrupts()
  const host = deferred()
  const request = interrupts.request('session', null, () => host.promise)
  const completion = interrupts.pending('session', 'first')
  host.resolve({ ok: true })
  await Promise.all([request, completion])
  assert.equal(interrupts.consume('session', 'later'), false)
})

test('intentional interruption preserves actual words and does not invent an empty-turn failure', () => {
  assert.equal(turnCompletionWords({ succeeded: false, userStopped: true }), 'Interrupted.')
  assert.equal(turnCompletionWords({ succeeded: false, userStopped: true, spoken: 'Partial answer', engineSentence: 'Interrupted' }), 'Partial answer')
  assert.match(turnCompletionWords({ succeeded: false }), /finished without any words back/)
  assert.match(turnCompletionWords({ succeeded: false, engineSentence: 'Provider unavailable' }), /Provider unavailable/)
})

test('the host acknowledgement supplies a turn identity when Stop preceded the first named event', async () => {
  const interrupts = createTurnInterrupts()
  await interrupts.request('session', null, async () => ({ sessionId: 'session', turnId: 'stopped-turn' }))
  assert.equal(interrupts.consume('session', 'later-turn'), false)
})

test('unproven Stop keeps the terminal event and queue held until the cleanup retry succeeds', async () => {
  const interrupts = createTurnInterrupts()
  const failed = interrupts.request('session', 'turn', async () => {
    throw Object.assign(new Error('Stop cleanup remains unproven'), { code: 'AGENT_STOP_PENDING' })
  })
  let terminal = false
  const completion = interrupts.pending('session', 'turn').then(() => { terminal = true })
  await assert.rejects(failed, { code: 'AGENT_STOP_PENDING' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(terminal, false)
  assert.equal(interrupts.pending('session', 'other-turn'), null)
  await interrupts.request('session', 'turn', async () => ({ turnId: 'turn' }))
  await completion
  assert.equal(interrupts.consume('session', 'turn'), true)
})

test('closing a session releases a held cleanup completion without creating an accepted Stop', async () => {
  const interrupts = createTurnInterrupts()
  await assert.rejects(interrupts.request('session', 'turn', async () => { throw new Error('IPC: AGENT_STOP_PENDING') }))
  const completion = interrupts.pending('session', 'turn')
  assert.ok(completion)
  interrupts.forget('session')
  await completion
  assert.equal(interrupts.consume('session', 'turn'), false)
})
