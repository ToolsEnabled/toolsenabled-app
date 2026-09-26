import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '../..')
const { createAgentHost } = require(path.join(root, 'shell/agent-host.cjs'))
const sessionGoal = require(path.join(root, 'shell/session-goal.cjs'))
const enginePath = path.join(root, 'tools/test/fixtures/confined-engine/src/lib/agent-engine/codex-process.js')
const engine = require(enginePath)
const claude = require(path.join(path.dirname(enginePath), 'claude-cli-process.js'))
const flush = async () => { await new Promise(setImmediate); await new Promise(setImmediate) }
const refusal = () => Object.assign(new Error('test provider refused send'), { code: 'PROVIDER_SEND_REFUSED' })

async function setup(t, tier) {
  let clock = 1000000, emit, held = false, refuseBeforeDispatch = false, turn = 0, timerFailure = null
  const requests = [], pending = [], polls = new Set()
  const adapter = {
    transport: { child: Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }) },
    sendTurn: request => {
      requests.push(request)
      if (refuseBeforeDispatch) throw refusal()
      const turnId = 'turn-' + (++turn)
      if (held) return new Promise((resolve, reject) => pending.push({ resolve, reject, turnId }))
      return { turnId }
    },
    interrupt: async () => {}, answerApproval() {},
  }
  const start = async options => { emit = options.onEvent; return { threadId: 'thread', adapter, close() {} } }
  t.mock.method(engine, 'startCodexSession', start)
  t.mock.method(claude, 'startClaudeSession', start)
  const host = createAgentHost({
    enginePath, defaultCwd: root, profileRoot: root, freeMemory: () => 64 * 1024 ** 3,
    confinementPlanner: () => ({ ok: true, tier: 'unrestricted', isolated: false, threadOptions: {}, env: {} }),
    now: () => clock,
    goalPollTimer: {
      set: fn => {
        if (timerFailure === 'set') throw Object.assign(new Error('test timer setup failure'), { code: 'TEST_TIMER_FAILURE' })
        polls.add(fn)
        return { unref() { if (timerFailure === 'unref') throw Object.assign(new Error('test timer unref failure'), { code: 'TEST_TIMER_FAILURE' }) } }
      },
      clear: () => polls.clear(),
    },
  })
  const sessionId = 'goal-regression'
  const startSession = () => host.startSession({ sessionId, tier })
  await startSession()
  t.after(() => host.closeAll())
  return {
    host, requests, pending, startSession,
    failTimer(value) { timerFailure = value },
    hold(value = true) { held = value },
    refuse(value = true) { refuseBeforeDispatch = value },
    announceAccepted() { emit({ type: 'assistant_text_delta', text: 'accepted', turnId: 'turn-' + turn }) },
    set(objective = 'original objective') { return host.setGoal({ sessionId, objective }) },
    read() { return host.readGoal({ sessionId }).goal },
    clear() { return host.clearGoal({ sessionId }) },
    stop() { return host.interrupt({ sessionId }) },
    close() { return host.closeSession({ sessionId }) },
    send() { return host.sendTurn({ sessionId, text: 'existing user turn' }) },
    complete() { emit({ type: 'assistant_text_delta', text: 'working', turnId: 'turn-' + turn }); emit({ type: 'turn_completed', status: 'completed', turnId: 'turn-' + turn }) },
    block() { emit({ type: 'assistant_text_delta', text: 'I need a decision.\n\n' + sessionGoal.GOAL_BLOCKED_MARKER, turnId: 'turn-' + turn }); emit({ type: 'turn_completed', status: 'completed', turnId: 'turn-' + turn }) },
    async poll() { clock += 6000; for (const fn of polls) fn(); await flush() },
  }
}

for (const tier of ['luna', 'claude-sonnet']) {

  for (const failure of ['set', 'unref']) test(tier + ': goal timer ' + failure + ' failure cannot leave an active unsent goal', async t => {
    const f = await setup(t, tier)
    f.failTimer(failure)
    await assert.rejects(f.set('timer failure objective'), { code: 'TEST_TIMER_FAILURE' })
    await f.poll()
    console.log(JSON.stringify({ scenario: 'timer-' + failure, tier, goal: f.read(), sends: f.requests.length }))
    assert.equal(f.requests.length, 0, 'failed setup must not send autonomously')
    assert.notEqual(f.read()?.status, 'active', 'failed setup must not advertise an active goal')
    f.failTimer(null)
    await f.set('recovered objective')
    assert.equal(f.requests.length, 1, 'a new explicit goal must recover after timer failure')
  })

  for (const action of ['clear', 'new goal']) test(tier + ': initial send acknowledgement after ' + action + ' cannot confirm the old objective', async t => {
    const f = await setup(t, tier)
    const original = 'superseded objective'
    f.hold()
    const setting = f.set(original)
    await flush()
    assert.equal(f.pending.length, 1)
    if (action === 'clear') f.clear()
    else await f.set('newer objective')
    const expected = f.read()
    f.pending.shift().resolve({ turnId: 'accepted-old-turn' })
    const result = await setting
    console.log(JSON.stringify({ scenario: 'ack-after-' + action, tier, result }))
    assert.deepEqual(result.goal, expected)
    assert.equal(result.sentence.includes(original), false, 'response must not confirm an objective the person superseded')
    if (action === 'new goal') assert.equal(result.sentence.includes(expected.objective), true)
  })

  test(tier + ': poll on published goal cannot steal the initial send', async t => {
    const f = await setup(t, tier)
    await f.set('warmup')
    f.complete()
    f.clear()
    await f.poll()
    let observed = false
    f.host.onEvent(({ event }) => {
      if (!observed && event.type === 'session_goal_changed' && event.goal?.status === 'active') {
        observed = true
        void f.poll()
      }
    })
    await f.set()
    await flush()
    assert.equal(observed, true)
    assert.equal(f.requests.length, 2)
    assert.equal(f.read().continuations, 0, 'the initial person turn is not an autonomous continuation')
  })
  test(tier + ': initial refusal preserves objective, pauses, and never retries', async t => {
    const f = await setup(t, tier)
    f.hold()
    const result = assert.rejects(f.set(), { code: 'PROVIDER_SEND_REFUSED' })
    await flush()
    assert.equal(f.pending.length, 1)
    await f.poll()
    assert.equal(f.requests.length, 1, 'poll cannot overlap a pending initial send')
    f.pending.shift().reject(refusal())
    await result
    assert.equal(f.read().status, 'paused')
    assert.equal(f.read().objective, 'original objective')
    assert.equal(f.read().continuations, 0)
    for (let i = 0; i < 3; i++) await f.poll()
    assert.equal(f.requests.length, 1)
  })

  for (const busy of [false, true]) test(tier + ': ' + (busy ? 'busy' : 'accepted') + ' goal continues only after completion', async t => {
    const f = await setup(t, tier)
    if (busy) await f.send()
    const result = await f.set()
    assert.equal(result.goal.status, 'active')
    await f.poll()
    assert.equal(f.requests.length, 1)
    f.complete()
    await f.poll()
    assert.equal(f.requests.length, 2)
    assert.equal(f.read().continuations, 1)
  })

  for (const phase of ['initial', 'continuation']) test(tier + ': late ' + phase + ' provider rejection cannot undo a terminally settled Stop', async t => {
    const f = await setup(t, tier)
    let setting
    if (phase === 'continuation') { await f.set(); f.complete(); f.hold(); await f.poll() }
    else { f.hold(); setting = f.set(); await flush() }
    const sending = f.pending.shift()
    assert.ok(sending)
    f.announceAccepted()
    await flush()
    if (setting) await setting
    const stopping = f.stop()
    await flush()
    assert.equal(f.host.sessionActivity('goal-regression').busy, true, 'interrupt request alone cannot finish Stop')
    f.complete()
    await stopping
    assert.equal(f.host.sessionActivity('goal-regression').busy, false, 'matching terminal and cleanup settle Stop')
    const paused = f.read(), attempts = f.requests.length
    sending.reject(refusal())
    await flush(); await f.poll()
    assert.deepEqual(f.read(), paused)
    assert.equal(paused.status, 'paused')
    assert.equal(f.requests.length, attempts, 'late failure never reactivates the stopped goal')
  })

  for (const phase of ['initial', 'continuation']) {
    for (const action of ['clear', 'Stop', 'new goal', 'session replacement']) {
      test(tier + ': late ' + phase + ' refusal cannot undo ' + action, async t => {
        const f = await setup(t, tier)
        let outcome
        if (phase === 'continuation') { await f.set(); f.complete(); f.hold(); await f.poll() }
        else { f.hold(); outcome = assert.rejects(f.set(), { code: 'PROVIDER_SEND_REFUSED' }); await flush() }
        assert.equal(f.pending.length, 1)
        const sending = f.pending.shift()
        let stopping
        if (action === 'clear') f.clear()
        if (action === 'Stop') stopping = assert.rejects(f.stop(), { code: 'AGENT_STOP_PENDING' })
        if (action === 'new goal') await f.set('replacement objective')
        if (action === 'session replacement') {
          await f.close()
          f.hold(false)
          await f.startSession()
          await f.set('replacement session objective')
        }
        const expected = f.read()
        const attempts = f.requests.length
        sending.reject(refusal())
        if (outcome) await outcome
        if (stopping) {
          await stopping
          assert.equal(f.read().status, 'paused')
          // This fixture dispatched a send, then rejected it without a turn
          // identity or terminal event. Unknown delivery cannot prove Stop.
          await assert.rejects(f.stop(), { code: 'AGENT_STOP_PENDING' })
          assert.equal(f.host.sessionActivity('goal-regression').busy, true)
        }
        await flush()
        assert.deepEqual(f.read(), expected, 'late refusal must preserve the newer goal state')
        if (action === 'new goal') {
          assert.equal(f.read().status, 'active')
          f.hold(false)
          await f.poll()
          assert.equal(f.requests.length, attempts + 1, 'replacement goal remains actionable')
        } else {
          await f.poll()
          assert.equal(f.requests.length, attempts, 'cleared/stopped or busy replacement must not retry')
        }
      })
    }
  }
}

test('an undispatched refusal leaves an active goal running, while dispatched unknown delivery pauses autonomy', async t => {
  const f = await setup(t, 'luna')
  await f.set('finish the job')
  f.complete()

  f.refuse(true)
  await assert.rejects(f.host.sendTurn({ sessionId: 'goal-regression', text: 'owner message', origin: 'person' }), { code: 'PROVIDER_SEND_REFUSED' })
  assert.equal(f.read().status, 'paused', 'an invoked adapter cannot prove non-delivery merely by throwing synchronously')

  f.refuse(false)
  f.hold(true)
  const unknown = f.host.sendTurn({ sessionId: 'goal-regression', text: 'owner message after dispatch', origin: 'person' })
  await flush()
  assert.equal(f.pending.length, 1)
  const pending = f.pending.shift()
  pending.reject(refusal())
  await assert.rejects(unknown, { code: 'PROVIDER_SEND_REFUSED' })
  assert.equal(f.read().status, 'paused', 'unknown delivery holds autonomous continuation')
  const attempts = f.requests.length
  await f.poll()
  assert.equal(f.requests.length, attempts, 'the paused goal does not send another possibly-duplicate turn')
})

test('accepted-then-failure pauses only the same active goal and automatic sends never resume a paused goal', async t => {
  const f = await setup(t, 'luna')
  await f.set('preserve the goal')
  f.complete()
  f.hold(true)
  const acceptedThenFails = f.host.sendTurn({ sessionId: 'goal-regression', text: 'provider started this', origin: 'person' })
  await flush()
  assert.equal(f.pending.length, 1)
  f.announceAccepted()
  const accepted = await acceptedThenFails
  assert.equal(accepted.sessionId, 'goal-regression')
  assert.equal(f.read().status, 'active')
  f.pending.shift().reject(refusal())
  await flush()
  assert.equal(f.read().status, 'paused', 'a late provider failure creates the same delivery hold')

  await assert.rejects(f.stop(), { code: 'AGENT_TURN_NONE' })
  assert.equal(f.read().status, 'paused')
  f.hold(false)
  const automatic = await f.host.sendTurn({ sessionId: 'goal-regression', text: 'automatic escalation notice', origin: 'automatic' })
  assert.equal(automatic.sessionId, 'goal-regression')
  assert.equal(f.read().status, 'paused', 'automatic recovery cannot impersonate a person resume')
})

test('a late dispatched failure cannot pause a cleared or replacement goal', async t => {
  for (const action of ['clear', 'new goal']) {
    const f = await setup(t, 'luna')
    await f.set('old objective')
    f.complete()
    f.hold(true)
    const late = f.host.sendTurn({ sessionId: 'goal-regression', text: 'old in-flight turn', origin: 'person' })
    await flush()
    assert.equal(f.pending.length, 1)
    if (action === 'clear') f.clear()
    else await f.set('new objective')
    const expected = f.read()
    f.pending.shift().reject(refusal())
    await assert.rejects(late, { code: 'PROVIDER_SEND_REFUSED' })
    await flush()
    assert.deepEqual(f.read(), expected, action + ' state survives the stale callback')
  }
})

test('a fresh person resume of paused or blocked goal cannot stay autonomous after unknown delivery', async t => {
  for (const priorStatus of ['paused', 'blocked']) {
    const f = await setup(t, 'luna')
    if (priorStatus === 'paused') {
      f.hold()
      const initial = f.set('resume safely after uncertainty')
      await flush()
      assert.equal(f.pending.length, 1)
      f.pending.shift().reject(refusal())
      await assert.rejects(initial, { code: 'PROVIDER_SEND_REFUSED' })
    } else {
      await f.set('resume safely after a provider block')
      f.block()
      await flush()
    }
    assert.equal(f.read().status, priorStatus)

    f.hold(true)
    const resumed = f.host.sendTurn({
      sessionId: 'goal-regression',
      text: 'person explicitly resumed the goal',
      origin: 'person',
    })
    await flush()
    assert.equal(f.pending.length, 1)
    f.announceAccepted()
    const accepted = await resumed
    assert.equal(accepted.sessionId, 'goal-regression')
    f.pending.shift().reject(refusal())
    await flush()

    const finalGoal = f.read()
    assert.notEqual(finalGoal.status, 'active', priorStatus + ' resume must not remain autonomous after unknown delivery')
    const attempts = f.requests.length
    await f.poll()
    assert.equal(f.requests.length, attempts, priorStatus + ' resume must not poll another turn')
  }
})
