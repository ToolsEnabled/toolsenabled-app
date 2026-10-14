import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mainModelParsers } from './native-model-test-support.mjs'
import { OTHER_MODEL_LABEL, MODEL_NEXT_START } from '../../src/model-picker.js'
import { PALETTE_PANEL, RESUME_PANEL } from '../../src/fleet-tree-copy.js'
import { LAUNCH_TIERS } from '../../src/orchestration-controls.js'
import { payloadSkip, runningCircle, waitFor, openProviderStage, startedRequests, settle, sharedBridge } from './lib/t158-switch-model-harness.mjs'

beforeEach(() => { sharedBridge.startableTiers = async () => ({ ok: true, tiers: LAUNCH_TIERS.map(row => row.id) }) })
afterEach(() => { delete sharedBridge.startableTiers })
const raw = ' vendor/model:2026-10 '
async function enterOther(ctx, provider) {
  const chat = ctx.liveChat()
  chat.openActions()
  chat.querySelectorAll('.chat-actions-row').find(row => row.children?.[0]?.textContent === 'Switch model').dispatch('click')
  await openProviderStage(ctx.liveChat(), provider)
  const other = ctx.liveChat().querySelectorAll('.chat-actions-row').find(row => row.children?.[0]?.textContent === OTHER_MODEL_LABEL)
  assert.ok(other)
  assert.notEqual(other.getAttribute('aria-disabled'), 'true')
  other.dispatch('click')
  await waitFor(() => Boolean(ctx.liveChat().querySelector('[data-model-field="model"]')), 'the custom model input')
  return ctx.liveChat().querySelector('[data-model-field="model"]')
}
function useModel(ctx, input, model) {
  input.value = model
  input.dispatch('input')
  ctx.liveChat().querySelectorAll('button').find(button => button.textContent === 'Use this model').dispatch('click')
}
async function action(ctx, label) {
  ctx.liveChat().openActions()
  const row = ctx.liveChat().querySelectorAll('.chat-actions-row').find(row => row.children?.[0]?.textContent === label)
  assert.ok(row, 'action is offered: ' + label)
  assert.notEqual(row.getAttribute('aria-disabled'), 'true', row.textContent)
  row.dispatch('click')
  await settle(8)
}

test('non-Codex Switch model explains next start, retains the live model and restarts with the exact saved name',
  { skip: payloadSkip }, async t => {
  const ctx = await runningCircle(t, { initialThreadId: 'fixture-thread', replacementStart: async (_, sessionId) => ({ ok: true, sessionId, threadId: 'fixture-thread' }) })
  const input = await enterOther(ctx, 'Claude')
  assert.ok(ctx.liveChat().textContent.includes(MODEL_NEXT_START))
  useModel(ctx, input, raw)
  await waitFor(() => ctx.readNode().nextModelChoice?.model === raw, 'the next-start choice to be stored')
  assert.equal(ctx.readNode().tier, 'claude-sonnet')
  assert.equal(ctx.readNode().model, undefined)
  assert.equal(startedRequests(ctx).length, 0)
  assert.ok(ctx.liveChat().querySelector('[data-chat-chip="model"]').textContent.includes(raw))
  assert.ok(ctx.liveChat().textContent.includes(MODEL_NEXT_START))
  const composer = ctx.liveChat().querySelector('.chat-input textarea')
  composer.value = 'Continue on the current session.'
  ctx.liveChat().querySelector('.chat-send').dispatch('click')
  await waitFor(() => ctx.calls.some(call => call.call === 'send'), 'the current session message')
  assert.equal(ctx.calls.find(call => call.call === 'send').request.model, undefined)
  ctx.emit({ sessionId: ctx.OLD_SESSION, event: { type: 'turn_completed', status: 'completed', turnId: 'fixture-complete' } })
  await waitFor(() => ctx.readNode().status === 'finished', 'the session to be idle')
  await action(ctx, PALETTE_PANEL.stop)
  await waitFor(() => ctx.readNode().statusNote === 'Stopped by you.', 'the session to stop')
  await action(ctx, RESUME_PANEL.action)
  await waitFor(() => startedRequests(ctx).length === 1, 'the next start to reach the host')
  assert.equal(startedRequests(ctx)[0].request.tier, 'claude-opus')
  assert.equal(startedRequests(ctx)[0].request.model, raw)
  assert.equal(mainModelParsers().parseAgentStart(startedRequests(ctx)[0].request).model, raw)
  await waitFor(() => ctx.readNode().sessionId === ctx.NEW_SESSION, 'the restarted session to attach')
  assert.equal(ctx.readNode().model, raw)
  assert.equal(ctx.readNode().nextModelChoice, null)
  assert.equal(ctx.liveChat().querySelector('[data-chat-chip="model"]').textContent, raw)
})

test('Codex Switch model sends the exact name on the next turn and stores it for restart',
  { skip: payloadSkip }, async t => {
  const ctx = await runningCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId }) }, { fromTier: 'astra', provider: 'codex' })
  useModel(ctx, await enterOther(ctx, 'Codex'), raw)
  await waitFor(() => ctx.readNode().nextModelChoice?.model === raw, 'the Codex restart preference')
  assert.equal(ctx.readNode().nextModelChoice.tier, 'astra')
  assert.equal(ctx.liveChat().querySelector('[data-chat-chip="model"]').textContent, 'Next: ' + raw)
  const composer = ctx.liveChat().querySelector('.chat-input textarea')
  composer.value = 'Use my chosen model.'
  ctx.liveChat().querySelector('.chat-send').dispatch('click')
  await waitFor(() => ctx.calls.some(call => call.call === 'send'), 'the next turn')
  assert.equal(ctx.calls.find(call => call.call === 'send').request.model, raw)
  assert.equal(mainModelParsers().parseAgentSend(ctx.calls.find(call => call.call === 'send').request).model, raw)
})

test('Switch model refuses invalid names before saving, starting, or sending',
  { skip: payloadSkip }, async t => {
  const ctx = await runningCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId }) })
  const input = await enterOther(ctx, 'Claude')
  for (const model of ['', '  ', 'model\nname', 'model\x7f', 'x'.repeat(2049)]) {
    useModel(ctx, input, model)
    await settle(2)
    assert.equal(input.getAttribute('aria-invalid'), 'true')
    assert.equal(ctx.readNode().nextModelChoice, undefined)
    assert.equal(ctx.calls.length, 0)
    assert.equal(document.activeElement, input)
  }
})

test('Other model names an unavailable provider and cannot save a choice for it',
  { skip: payloadSkip }, async t => {
  sharedBridge.startableTiers = async () => ({ ok: true, tiers: ['astra'] })
  const ctx = await runningCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId }) }, { fromTier: 'astra', provider: 'codex' })
  ctx.liveChat().openActions('model')
  await openProviderStage(ctx.liveChat(), 'Claude')
  const other = ctx.liveChat().querySelectorAll('.chat-actions-row').find(row => row.children?.[0]?.textContent === OTHER_MODEL_LABEL)
  assert.ok(other)
  assert.equal(other.getAttribute('aria-disabled'), 'true')
  assert.ok(other.textContent.includes('cannot start'))
  other.dispatch('click')
  await settle(4)
  assert.equal(ctx.liveChat().querySelector('[data-model-field="model"]'), null)
  assert.equal(ctx.readNode().nextModelChoice, undefined)
  assert.deepEqual(ctx.calls, [])
})
