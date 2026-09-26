import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  createTerminateController,
  terminateTargetAvailability,
  verifiedTerminateReceipt,
} from '../../src/mission-bridge.js'

const TARGET = Object.freeze({
  agentId: 'codex-manager-seat-1',
  runId: 'aaaaaaaa-bbbb-1111',
  pid: 41001,
  status: 'running',
  recordRevision: 7,
  startedAt: 1_786_030_001_000,
  lastHeartbeat: 1_786_030_001_500,
})

function deferred() {
  let resolve
  const promise = new Promise(accept => { resolve = accept })
  return { promise, resolve }
}

function exactSuccess(body, overrides = {}) {
  return {
    ok: true,
    receipt: {
      action: 'terminate',
      idempotencyKey: body.idempotencyKey,
      actor: 'coordinator-sol',
      agentId: body.agentId,
      runId: body.expectedRunId,
      pid: body.expectedPid,
      terminalStatus: 'finished',
      exitCode: 0,
      verifiedGone: true,
      verifiedGoneAt: '2026-08-06T20:00:00.000Z',
      terminalAt: 1_786_032_000_000,
      auditSequence: 44,
      auditEventHash: 'a'.repeat(64),
      ...overrides,
    },
  }
}

function controller(overrides = {}) {
  const states = []
  const posts = []
  let keyCount = 0
  const value = createTerminateController({
    live: true,
    selectedAgentId: TARGET.agentId,
    controlTarget: TARGET,
    createIdempotencyKey: () => {
      keyCount += 1
      return `terminate-intent-${keyCount}`
    },
    postAction: async (action, body) => {
      posts.push({ action, body })
      return exactSuccess(body)
    },
    onState: state => states.push(state),
    ...overrides,
  })
  return { value, states, posts, keyCount: () => keyCount }
}

test('agent source has four truthful controls and no generic armed handler', () => {
  const agentSource = readFileSync(new URL('../../src/views/agent.js', import.meta.url), 'utf8')
  const bridgeSource = readFileSync(new URL('../../src/mission-bridge.js', import.meta.url), 'utf8')

  assert.doesNotMatch(agentSource, /\barmed\b/i)
  assert.match(agentSource, /<div class="ctl-btn ctl-declared-state" data-control="declared-state"/)
  /* THESE TWO LABELS SAID SOMETHING THAT HAD STOPPED BEING TRUE.
   *
   * They read "Pause unavailable: no bridge action exists" and this test
   * required that shape. Both halves had gone wrong. "No bridge action exists"
   * names a mechanism a person has never been shown; and it is no longer the
   * reason -- src/agent-session-controls.js steers both controls against a
   * session this app owns, so whether they are available is decided there, not
   * by the absence of a bridge action. A label left behind by a repair, pinned
   * by a test, is how a stale sentence survives.
   *
   * What the test is FOR is unchanged: the two controls must ship disabled and
   * must carry a spoken label rather than nothing, because a screen reader
   * meeting a nameless disabled button gets the word "button". So the shape is
   * asserted and the sentence is not. Both are rewritten on the first paint by
   * renderSessionControl(); this is what is there in the instant before that. */
  assert.match(agentSource, /data-control="pause" disabled aria-label="Pause\. [^"]+"/)
  assert.match(agentSource, /data-control="respawn" disabled aria-label="Respawn\. [^"]+"/)
  /* And the mechanism name may not come back into either of them. */
  assert.doesNotMatch(agentSource, /aria-label="(Pause|Respawn)[^"]*bridge[^"]*"/i)
  assert.match(agentSource, /controlTarget: declaredAgent\.controlTarget/)
  assert.match(bridgeSource, /terminate: '\/v1\/actions\/terminate'/)
  assert.match(bridgeSource, /terminate: 120_000/)
})

test('no target, non-running target, and mismatched target disable terminate honestly', () => {
  const noTarget = terminateTargetAvailability({ live: true, selectedAgentId: TARGET.agentId, controlTarget: null })
  assert.equal(noTarget.enabled, false)
  assert.match(noTarget.reason, /no observed control target/i)

  const stopped = terminateTargetAvailability({
    live: true,
    selectedAgentId: TARGET.agentId,
    controlTarget: { ...TARGET, status: 'finished' },
  })
  assert.equal(stopped.enabled, false)
  assert.match(stopped.reason, /finished, not running/i)

  const mismatched = terminateTargetAvailability({
    live: true,
    selectedAgentId: 'another-agent',
    controlTarget: TARGET,
  })
  assert.equal(mismatched.enabled, false)
  assert.match(mismatched.reason, /does not match/i)
})

test('one click asks a question and confirmation posts one exact body while pending is not success', async () => {
  const pending = deferred()
  const posts = []
  let keys = 0
  const states = []
  const value = createTerminateController({
    live: true,
    selectedAgentId: TARGET.agentId,
    controlTarget: TARGET,
    createIdempotencyKey: () => { keys += 1; return 'terminate-intent-exact' },
    postAction: (action, body) => { posts.push({ action, body }); return pending.promise },
    onState: state => states.push(state),
  })

  await value.click()
  assert.equal(posts.length, 0)
  assert.equal(value.getState().phase, 'confirm')
  assert.match(value.getState().message, /\?/)
  assert.equal(JSON.stringify(value.getState()).toLowerCase().includes('armed'), false)

  const inFlight = value.click()
  assert.equal(posts.length, 1)
  assert.equal(keys, 1)
  assert.deepEqual(posts[0], {
    action: 'terminate',
    body: {
      idempotencyKey: 'terminate-intent-exact',
      agentId: TARGET.agentId,
      expectedRunId: TARGET.runId,
      expectedPid: TARGET.pid,
    },
  })
  assert.equal(value.getState().phase, 'pending')
  assert.equal(value.getState().enabled, false)
  assert.match(value.getState().message, /No stop has been confirmed/)
  await value.click()
  assert.equal(posts.length, 1)
  assert.equal(keys, 1)

  pending.resolve(exactSuccess(posts[0].body))
  await inFlight
  assert.equal(value.getState().phase, 'success')
  assert.match(value.getState().message, /Termination verified/)
  assert.ok(states.some(state => state.phase === 'pending'))
})

test('mismatched and incomplete receipts are rejected and retry reuses the same intent key', async () => {
  for (const invalidReceipt of [
    body => exactSuccess(body, { runId: 'ffffffff-ffff-ffff' }),
    body => {
      const result = exactSuccess(body)
      delete result.receipt.exitCode
      return result
    },
  ]) {
    const posts = []
    let keys = 0
    const value = createTerminateController({
      live: true,
      selectedAgentId: TARGET.agentId,
      controlTarget: TARGET,
      createIdempotencyKey: () => { keys += 1; return `same-intent-${keys}` },
      postAction: async (action, body) => {
        posts.push({ action, body })
        return posts.length === 1 ? invalidReceipt(body) : exactSuccess(body)
      },
    })

    await value.click()
    await value.click()
    assert.equal(value.getState().phase, 'retry')
    /* [B6] was `assert.match(..., /BRIDGE_TERMINATE_RECEIPT_INVALID/)` -- the
       identifier is now on the state rather than in the sentence. */
    assert.equal(value.getState().code, 'BRIDGE_TERMINATE_RECEIPT_INVALID')
    assert.doesNotMatch(value.getState().message, /[A-Z][A-Z0-9]*(_[A-Z0-9]+)+/,
      `a bare identifier reached the terminate control: ${value.getState().message}`)
    assert.match(value.getState().message, /No stop has been confirmed/)
    assert.equal(keys, 1)

    await value.click()
    assert.equal(posts.length, 2)
    assert.strictEqual(posts[1].body, posts[0].body)
    assert.equal(posts[1].body.idempotencyKey, 'same-intent-1')
    assert.equal(keys, 1)
    assert.equal(value.getState().phase, 'success')
  }
})

test('only a complete exact durable receipt validates', () => {
  const body = {
    idempotencyKey: 'receipt-check',
    agentId: TARGET.agentId,
    expectedRunId: TARGET.runId,
    expectedPid: TARGET.pid,
  }
  assert.equal(verifiedTerminateReceipt(exactSuccess(body), body), true)
  assert.equal(verifiedTerminateReceipt(exactSuccess(body, { verifiedGone: false }), body), false)
  assert.equal(verifiedTerminateReceipt(exactSuccess(body, { terminalStatus: 'running' }), body), false)
  assert.equal(verifiedTerminateReceipt(exactSuccess(body, { pid: TARGET.pid + 1 }), body), false)
})

test('typed bridge refusal is visible and stale target is not retryable', async () => {
  const states = []
  const value = createTerminateController({
    live: true,
    selectedAgentId: TARGET.agentId,
    controlTarget: TARGET,
    createIdempotencyKey: () => 'typed-refusal-intent',
    postAction: async () => ({
      ok: false,
      code: 'BRIDGE_TERMINATE_STALE_PID',
      reason: 'The target PID no longer matches the fenced request.',
    }),
    onState: state => states.push(state),
  })

  await value.click()
  await value.click()
  assert.equal(value.getState().phase, 'refused')
  assert.equal(value.getState().enabled, false)
  /* [B6] The refusal is still TYPED -- that is what this test is named for --
     it is just typed on the state object instead of in the person's sentence. */
  assert.equal(value.getState().code, 'BRIDGE_TERMINATE_STALE_PID')
  assert.doesNotMatch(value.getState().message, /[A-Z][A-Z0-9]*(_[A-Z0-9]+)+/,
    `a bare identifier reached the terminate control: ${value.getState().message}`)
  assert.match(value.getState().message, /The target PID no longer matches the fenced request/,
    'the engine’s own sentence must survive verbatim')
  assert.match(value.getState().message, /No stop has been confirmed/)
  assert.match(value.getState().message, /Refresh this page/, 'a refusal must say what to do next')
  assert.equal(states.at(-1).message, value.getState().message)
})

test('simulated mode is inert and never posts', async () => {
  let posts = 0
  const value = createTerminateController({
    live: false,
    selectedAgentId: TARGET.agentId,
    controlTarget: TARGET,
    postAction: async () => { posts += 1; return exactSuccess({}) },
  })

  await value.click()
  await value.click()
  assert.equal(posts, 0)
  assert.equal(value.getState().phase, 'unavailable')
  assert.match(value.getState().message, /simulated mode/i)
})

test('an abandoned view ignores a late terminate result', async () => {
  const pending = deferred()
  const states = []
  const { value } = controller({
    postAction: () => pending.promise,
    onState: state => states.push(state),
  })

  await value.click()
  const inFlight = value.click()
  const countAtDestroy = states.length
  value.destroy()
  pending.resolve(exactSuccess({
    idempotencyKey: 'terminate-intent-1',
    agentId: TARGET.agentId,
    expectedRunId: TARGET.runId,
    expectedPid: TARGET.pid,
  }))
  await inFlight
  assert.equal(states.length, countAtDestroy)
  assert.equal(value.getState().phase, 'pending')
})

const basicTerminateAudit = target => ({ ok: true, disposition: 'not-required', required: false, recorded: false,
  durable: false, anchored: false, signed: false, sequence: null, eventId: null, eventHash: null,
  action: 'mission.bridge.terminate.completed', target })
function basicTerminateSuccess(body, overrides = {}) {
  const result = exactSuccess(body, overrides)
  delete result.receipt.auditSequence
  delete result.receipt.auditEventHash
  result.receipt.audit = basicTerminateAudit(body.idempotencyKey)
  return result
}
test('Basic termination confirms exact process completion and refuses incomplete or wrong-target success', async () => {
  const body = { idempotencyKey: 'basic-stop', agentId: TARGET.agentId, expectedRunId: TARGET.runId, expectedPid: TARGET.pid }
  assert.equal(verifiedTerminateReceipt(basicTerminateSuccess(body), body), true)
  for (const bad of [{ pid: TARGET.pid + 1 }, { runId: 'other' }, { agentId: 'other' }, { idempotencyKey: 'other' },
    { verifiedGone: false }, { terminalStatus: 'running' }, { exitCode: undefined }, { terminalAt: null }, { verifiedGoneAt: 'bad' }]) {
    assert.equal(Boolean(verifiedTerminateReceipt(basicTerminateSuccess(body, bad), body)), false)
  }
  const reply = basicTerminateSuccess(body)
  reply.receipt.audit.target = 'other'
  assert.equal(Boolean(verifiedTerminateReceipt(reply, body)), false)
  assert.equal(Boolean(verifiedTerminateReceipt({ ok: true }, body)), false)
  const f = controller({ postAction: async (_action, request) => basicTerminateSuccess(request) })
  await f.value.click(); await f.value.click()
  assert.equal(f.value.getState().phase, 'success')
  assert.match(f.value.getState().message, /PID 41001 is gone/)
})
