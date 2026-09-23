import assert from 'node:assert/strict'
import test from 'node:test'
import { accountRetryStatus } from '../../src/manual-account-continuation.js'
import { retryWorld } from './helpers/t844-retry-world.mjs'
import { fleetTreesStorageKey } from '../../src/fleet-trees.js'

test('compact retry status omits normal policy prose while preserving persistence warnings', () => {
  const policy = { enabled: true, state: 'working' }
  const before = structuredClone(policy)
  const warning = 'Your retry preference could not be saved.'
  for (const context of [{ busy: true }, { busy: false }]) {
    assert.equal(accountRetryStatus(policy, { ...context, compact: true }), '')
    assert.equal(accountRetryStatus(policy, { ...context, compact: true, warning }), warning)
    assert.ok(accountRetryStatus(policy, context).length > 0, 'the Accounts detail view keeps its explanation')
  }
  const stopped = accountRetryStatus(policy, { stopped: true, compact: true, warning })
  assert.ok(stopped.includes('Stopped by you.'))
  assert.ok(stopped.includes(warning))
  assert.ok(stopped.includes('Resume or send work'))
  assert.equal(accountRetryStatus({ enabled: false }, { compact: true, warning }), warning)
  assert.deepEqual(policy, before, 'presentation never changes the retry policy')
})

test('compact retry status keeps refusal reasons and waiting information', () => {
  const warning = 'The saved policy needs attention.'
  for (const policy of [
    { enabled: true, state: 'starting' },
    { enabled: true, state: 'no-direction' },
    { enabled: true, state: 'paused', reason: 'This account must be signed in again.' },
    { enabled: true, state: 'waiting', nextAttemptAt: 1800000000000, resetAt: 1800000000000 },
    { enabled: true, state: 'waiting', nextAttemptAt: 1800000000000 },
    { enabled: true, state: 'waiting' },
  ]) {
    const brief = accountRetryStatus(policy, { compact: true, warning })
    assert.ok(brief.includes(warning), 'persistence warnings remain visible in ' + policy.state)
    assert.equal(brief, accountRetryStatus(policy, { warning }), 'actionable status is not truncated')
    if (policy.reason) assert.ok(brief.includes(policy.reason))
  }
})

// The world's session reports a completed last turn, so the mounted view shows
// an ordinary finished agent (the view replaces the seeded stop note). The
// stopped variant is a node whose host reports no turn outcome and whose saved
// note is still the person's stop.
async function stoppedRetryWorld(t) {
  const f = await retryWorld(t)
  f.world.bridge.sessionActivity = async () => ({ ok: true, busy: false, closing: false, lastTurnStatus: null, turnsCompleted: 1 })
  const key = fleetTreesStorageKey(f.computerId)
  const saved = JSON.parse(f.world.storage.getItem(key))
  saved.nodes.find(row => row.id === f.nodeId).statusNote = 'Stopped by you.'
  f.world.storage.setItem(key, JSON.stringify(saved))
  await f.mount({ fresh: true })
  const node = JSON.parse(f.world.storage.getItem(key)).nodes.find(row => row.id === f.nodeId)
  assert.equal(node.statusNote, 'Stopped by you.', 'the stopped fixture stays stopped after mounting')
  return f
}

for (const stopped of [false, true]) test('mounted retry policy remains compact and preserves the draft through every selection (' + (stopped ? 'stopped' : 'idle') + ' agent)', async t => {
  const f = stopped ? await stoppedRetryWorld(t) : await retryWorld(t)
  const chat = await f.openChat()
  const select = chat.querySelector('[data-chat-chip="account-retry"]')
  const notice = chat.querySelector('[data-chat-chip="account-retry-status"]')
  const input = chat.querySelector('.chat-input input')
  assert.equal(select.getAttribute('aria-label'), 'Account retry policy')
  assert.equal(notice.getAttribute('role'), 'status')
  assert.equal(notice.getAttribute('aria-live'), 'polite')
  input.value = 'Retained unsent draft'
  input.dispatch('input')
  for (const value of ['keep', 'wait', 'off']) {
    await f.choose(chat, value)
    assert.equal(select.value, value)
    assert.equal(input.value, 'Retained unsent draft')
    assert.equal(chat.querySelector('.chat-input input'), input, 'policy repaint does not remount the composer')
    if (value === 'off' || !stopped) assert.equal(notice.textContent, '', 'the selector already communicates the enabled policy')
    else {
      assert.ok(notice.textContent.includes('Stopped by you.'), 'stopped state remains explicit')
      assert.equal(notice.textContent.includes('Keep trying accounts'), false, 'the selector already communicates the enabled policy')
    }
    const policy = (await f.record()).retryPolicy
    assert.equal(policy.enabled, value !== 'off')
    if (value !== 'off') assert.equal(policy.waitForReset, value === 'wait')
  }
  assert.deepEqual(f.calls.starts, [])
  assert.deepEqual(f.calls.closes, [])
})

test('mounted actionable retry status sits outside the control group and keeps the saved policy', async t => {
  const f = await retryWorld(t)
  let chat = await f.openChat()
  await f.choose(chat, 'keep')
  const record = await f.record()
  Object.assign(record.retryPolicy, {
    state: 'paused', reason: 'Sign in again before another account attempt.',
    autoResumeAt: null, nextAttemptAt: null,
  })
  f.records.set(f.nodeId, structuredClone(record))
  await f.mount({ fresh: true })
  chat = await f.openChat()
  const notice = chat.querySelector('[data-chat-chip="account-retry-status"]')
  assert.ok(notice.textContent.includes(record.retryPolicy.reason))
  assert.equal(chat.querySelector('.chat-chips-left').contains(notice), false, 'notice cannot take width away from the policy controls')
  assert.equal(chat.querySelector('.chat-chips').contains(notice), true, 'the notice remains next to the composer')
  assert.equal(chat.querySelector('[data-chat-chip="account-retry"]').value, 'keep')
  assert.deepEqual((await f.record()).retryPolicy, record.retryPolicy)
  assert.deepEqual(f.calls.starts, [])
  assert.deepEqual(f.calls.closes, [])
})
