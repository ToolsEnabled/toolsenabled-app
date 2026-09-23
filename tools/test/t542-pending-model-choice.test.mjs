// T731 / T542: recovered B6 and Manager 2 pending-choice behaviors, driven
// through the mounted current view. Prior backend/F1 receipt controls remain
// in their existing suites; this file qualifies the changed UI paths.
import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
register('./lib/t542-runtime-store-loader.mjs', import.meta.url)
import {
  payloadSkip, FROM_TIER, TO_TIER, CROSS_ROW, SAME_ROW,
  runningCircle, busyCircle, sharedBridge, sharedOrgWindow, liveCase, waitFor, pressContinueRow, startedRequests,
} from './lib/t158-switch-model-harness.mjs'

async function settleTurns() {
  for (let attempt = 0; attempt < 60; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5))
}


function liveTreeState(ctx) {
  const state = globalThis[Symbol.for('toolsenabled.test.t542.runtime-stores')]?.get(ctx.COMPUTER_ID)
  assert.ok(state?.store, 'the mounted production store is captured')
  return state
}
async function replaceLiveSession(ctx, { sessionId, tier, effort, status = 'running', note = 'Newer owner work', recreate = false }) {
  const { store, ownedSessions } = liveTreeState(ctx)
  const before = store.getNode(ctx.NODE_ID)
  assert.ok(before)
  if (recreate) {
    assert.equal(store.setNodeStatus(before.id, 'finished').ok, true)
    assert.equal(store.detachSession(before.id).ok, true)
    assert.equal(store.removeNode(before.id).ok, true)
    const added = store.addNode({ reservedNodeId: before.id, role: before.role, message: before.message,
      tier: tier ?? before.tier, effort: effort ?? before.effort })
    assert.equal(added.ok, true, added.problems?.join('; '))
    assert.notEqual(added.node.createdAt, before.createdAt, 'the real store creates a new incarnation')
  }
  ownedSessions.set(sessionId, before.id)
  assert.equal(store.setNodeLaunchPreferences(before.id, { tier, effort }).ok, true)
  assert.equal(store.attachSession(before.id, sessionId).ok, true)
  assert.equal(store.setNodeStatus(before.id, status, { note }).ok, true)
  await settleTurns()
  assert.equal(store.getNode(before.id).sessionId, sessionId, 'live model has the new binding')
  assert.equal(ctx.readNode().sessionId, sessionId, 'saved and live binding agree')
}

/* FIND THE ROW BY ITS DESTINATION, NOT BY ITS SENTENCE. The rows above match
   the full "Continue on X" phrase, which is right for them because that phrase
   is the idle behaviour they pin. These two must survive the wording changing,
   because the whole point is that the mid-turn wording is NOT settled yet --
   M2 may well label a pending choice differently. Matching the tier's own
   label ("GPT-6-Astra ... Codex") finds the person's row under any phrasing,
   so a rename produces a judged assertion instead of a timeout that says
   nothing about the behaviour. Derived from the shared constants rather than
   retyped, so it cannot drift from them. */
const CROSS_TARGET = CROSS_ROW.replace('Continue on ', '')
const SAME_TARGET = SAME_ROW.replace('Continue on ', '')
const rowFor = (chat, target) => chat.querySelectorAll('.chat-actions-row').find(row => row.textContent.includes(target))

test('a mid-turn choice is taken, nothing is applied or stopped while the turn runs, and it applies once on the chosen tier at the boundary',
  { skip: payloadSkip }, async t => {
  const ctx = await busyCircle(t, { replacementStart: async (request, newSession) => ({ ok: true, sessionId: newSession }) })

  const chat = ctx.liveChat()
  chat.openActions()
  chat.querySelectorAll('.chat-actions-row').find(row => /Switch model/.test(row.textContent)).dispatch('click')
  await waitFor(() => ctx.liveChat().querySelectorAll('.chat-actions-row').some(row => row.textContent.includes(CROSS_TARGET)),
    'the model stage to open on a mid-turn circle')

  const cross = rowFor(ctx.liveChat(), CROSS_TARGET)
  assert.notEqual(cross.getAttribute('aria-disabled'), 'true',
    'the choice is SELECTABLE while the agent works -- this is the assertion that fails today')
  cross.dispatch('click')
  await settleTurns()

  /* HELD, NOT APPLIED, AND THE TURN UNHARMED. */
  assert.equal(startedRequests(ctx).length, 0, 'nothing is started while the turn is still running')
  assert.equal(ctx.calls.filter(entry => entry.call === 'interrupt').length, 0,
    'and the running turn is NOT stopped -- a pending choice must never end the work the person is waiting on')
  assert.equal(ctx.readNode().status, 'running', 'the turn the person is waiting on is still running')

  /* APPLIED ONCE, AT THE BOUNDARY THE TURN REACHES BY ITSELF. */
  ctx.emit({ sessionId: ctx.OLD_SESSION, event: { type: 'turn_completed', status: 'completed', turnId: 'turn-busy' } })
  await waitFor(() => startedRequests(ctx).length === 1, 'the held choice to be applied once the turn ends on its own')
  assert.equal(startedRequests(ctx)[0].request.tier, TO_TIER, 'and applied on the tier the person actually chose')
})
async function chooseBusyModel(ctx, label = CROSS_ROW) {
  await pressContinueRow(ctx, label)
  assert.match(ctx.liveChat().querySelector('.chat-chip-model').textContent, /Pending:/,
    'the current model remains visible beside the pending choice')
}
const completeBusy = ctx => ctx.emit({ sessionId: ctx.OLD_SESSION,
  event: { type: 'turn_completed', status: 'completed', turnId: 'turn-busy' } })

test('pending model is displayed, latest selection wins, duplicate completion applies exactly once', { skip: payloadSkip }, async t => {
  const ctx = await busyCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId }) })
  await chooseBusyModel(ctx)
  await chooseBusyModel(ctx, SAME_ROW)
  assert.match(ctx.liveChat().querySelector('.chat-chip-model').textContent, /Sonnet.*Pending:.*Opus/)
  assert.equal(startedRequests(ctx).length, 0)
  completeBusy(ctx); completeBusy(ctx)
  await waitFor(() => ctx.readNode().sessionId === ctx.NEW_SESSION, 'the chosen successor')
  await settleTurns()
  assert.equal(startedRequests(ctx).length, 1)
  assert.equal(startedRequests(ctx)[0].request.tier, 'claude-opus')
  assert.equal(ctx.calls.filter(x => x.call === 'interrupt').length, 0)
  assert.doesNotMatch(ctx.liveChat().querySelector('.chat-chip-model').textContent, /Pending:/)
})

test('keeping the current model cancels the pending selection without stopping the turn', { skip: payloadSkip }, async t => {
  const ctx = await busyCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId }) })
  await chooseBusyModel(ctx)
  const chat = ctx.liveChat()
  const keep = chat.querySelectorAll('.chat-actions-row').find(row => /Keep/.test(row.textContent))
  assert.ok(keep); keep.dispatch('click')
  completeBusy(ctx); await settleTurns()
  assert.equal(startedRequests(ctx).length, 0)
  assert.equal(ctx.calls.filter(x => x.call === 'interrupt').length, 0)
  assert.doesNotMatch(ctx.liveChat().querySelector('.chat-chip-model').textContent, /Pending:/)
})

test('explicit Halt cancels pending model even when a successful completion races the interrupt', { skip: payloadSkip }, async t => {
  const ctx = await busyCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId }) })
  await chooseBusyModel(ctx)
  const stop = ctx.liveChat().querySelector('.chat-chip-halt')
  assert.ok(stop, 'actual composer Halt exists'); stop.dispatch('click')
  await waitFor(() => ctx.calls.some(x => x.call === 'interrupt'), 'explicit interrupt')
  completeBusy(ctx); await settleTurns()
  assert.equal(startedRequests(ctx).length, 0)
  assert.doesNotMatch(ctx.liveChat().querySelector('.chat-chip-model').textContent, /Pending:/)
})

test('replaced session cancels a pending model and ignores the predecessor completion', { skip: payloadSkip }, async t => {
  const ctx = await busyCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId }) })
  await chooseBusyModel(ctx)
  await replaceLiveSession(ctx, { sessionId: 'externally-replaced' })
  completeBusy(ctx); await settleTurns()
  assert.equal(startedRequests(ctx).length, 0)
})

test('view disposal invalidates the pending model without starting or interrupting', { skip: payloadSkip }, async t => {
  const ctx = await busyCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId }) })
  await chooseBusyModel(ctx); ctx.view.destroy(); completeBusy(ctx); await settleTurns()
  assert.equal(startedRequests(ctx).length, 0)
  assert.equal(ctx.calls.filter(x => x.call === 'interrupt').length, 0)
})

test('refused pending replacement retains the current model and does not retry on duplicate boundary', { skip: payloadSkip }, async t => {
  const ctx = await busyCircle(t, { replacementStart: async () => ({ ok: false, code: 'MODEL_REFUSED', reason: 'Fixture refuses this model.' }) })
  await chooseBusyModel(ctx); completeBusy(ctx)
  await waitFor(() => startedRequests(ctx).length === 1, 'refused replacement attempt')
  await settleTurns(); completeBusy(ctx); await settleTurns()
  assert.equal(startedRequests(ctx).length, 1)
  assert.equal(ctx.readNode().sessionId, ctx.OLD_SESSION)
  assert.equal(ctx.readNode().tier, FROM_TIER)
  assert.equal(ctx.calls.filter(x => x.call === 'close').length, 0)
})

test('dialog asks fresh startable catalog and honors authoritative empty after a previous positive answer', { skip: payloadSkip }, async t => {
  let reply = { ok: true, tiers: [FROM_TIER, TO_TIER] }, probes = 0
  sharedBridge.startableTiers = async () => { probes++; return reply }
  t.after(() => { delete sharedBridge.startableTiers })
  const ctx = await busyCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId }) })
  const open = async () => {
    const chat = ctx.liveChat(); chat.openActions()
    const row = chat.querySelectorAll('.chat-actions-row').find(row => /Switch and continue/.test(row.textContent))
    assert.ok(row); assert.notEqual(row.getAttribute('aria-disabled'), 'true'); row.dispatch('click')
    await waitFor(() => document.body.querySelector('.switch-continue'), 'actual dialog')
    return document.body.querySelector('.switch-continue')
  }
  let dialog = await open()
  assert.equal(dialog.querySelectorAll('[data-switch-model]').find(row => row.value === TO_TIER).disabled, false)
  dialog.querySelector('[data-switch-cancel]').dispatch('click')
  const before = probes; reply = { ok: true, tiers: [] }
  dialog = await open()
  assert.ok(probes > before, 'second opening awaits a new host catalog')
  assert.equal(dialog.querySelectorAll('[data-switch-model]').find(row => row.value === TO_TIER).disabled, true)
  assert.equal(startedRequests(ctx).length, 0)
  dialog.querySelector('[data-switch-cancel]').dispatch('click')
  reply = { ok: false, error: { code: 'CATALOG_REFUSED' } }
  ctx.liveChat().openActions()
  ctx.liveChat().querySelectorAll('.chat-actions-row').find(row => /Switch and continue/.test(row.textContent)).dispatch('click')
  await waitFor(() => probes >= before + 4, 'bounded failed catalog attempts')
  await settleTurns()
  assert.equal(Boolean(document.body.querySelector('.switch-continue')), false, 'failed refresh never reuses prior authority')
  assert.equal(startedRequests(ctx).length, 0)
})

test('native per-turn model stays pending until completion then the queued message uses it once', { skip: payloadSkip }, async t => {
  const ctx = await busyCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId }) },
    { fromTier: 'astra', provider: 'codex' })
  const chat = ctx.liveChat(); chat.openActions()
  chat.querySelectorAll('.chat-actions-row').find(row => /Switch model/.test(row.textContent)).dispatch('click')
  await waitFor(() => chat.querySelectorAll('.chat-actions-row').some(row => /Luna/.test(row.textContent)), 'native model stage')
  const target = chat.querySelectorAll('.chat-actions-row').find(row => /Luna/.test(row.textContent))
  assert.ok(target); assert.notEqual(target.getAttribute('aria-disabled'), 'true'); target.dispatch('click')
  await waitFor(() => /Pending:/.test(ctx.liveChat().querySelector('.chat-chip-model').textContent), 'native pending display')
  assert.match(ctx.liveChat().querySelector('.chat-chip-model').textContent, /Astra.*Pending:.*Luna/)
  const input = ctx.liveChat().querySelector('.chat-input input')
  input.value = 'next exact message'
  ctx.liveChat().querySelector('.chat-send').dispatch('click')
  await settleTurns()
  assert.equal(ctx.calls.filter(x => x.call === 'send').length, 0)
  completeBusy(ctx)
  await waitFor(() => ctx.calls.some(x => x.call === 'send'), 'queued message on chosen native model')
  assert.equal(ctx.calls.filter(x => x.call === 'send').length, 1)
  assert.equal(ctx.calls.find(x => x.call === 'send').request.model, 'gpt-5.6-luna')
  assert.equal(ctx.calls.find(x => x.call === 'send').request.text, 'next exact message')
  assert.equal(startedRequests(ctx).length, 0)
  assert.equal(ctx.calls.filter(x => x.call === 'interrupt').length, 0)
  assert.doesNotMatch(ctx.liveChat().querySelector('.chat-chip-model').textContent, /Pending:/)
})

test('Stop during pending seat await fences the continuation before host start', { skip: payloadSkip }, async t => {
  const ctx = await busyCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId }) })
  await chooseBusyModel(ctx)
  const original = sharedOrgWindow.ensureSeat
  let release, reached = false
  const gate = new Promise(resolve => { release = resolve })
  sharedOrgWindow.ensureSeat = async request => { reached = true; await gate; return original(request) }
  t.after(() => { release(); sharedOrgWindow.ensureSeat = original })
  completeBusy(ctx)
  await waitFor(() => reached, 'real continuation to await seat')
  const chat = ctx.liveChat(); chat.openActions()
  const stop = chat.querySelectorAll('.chat-actions-row').find(row => /Stop this agent/.test(row.textContent))
  assert.ok(stop); stop.dispatch('click')
  await waitFor(() => ctx.calls.some(x => x.call === 'close'), 'actual Stop')
  release(); await settleTurns()
  assert.equal(startedRequests(ctx).length, 0)
})

test('cancelling pending choice during seat await keeps the live predecessor and starts nothing', { skip: payloadSkip }, async t => {
  const ctx = await busyCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId }) })
  await chooseBusyModel(ctx)
  const original = sharedOrgWindow.ensureSeat
  let release, reached = false
  const gate = new Promise(resolve => { release = resolve })
  sharedOrgWindow.ensureSeat = async request => { reached = true; await gate; return original(request) }
  t.after(() => { release(); sharedOrgWindow.ensureSeat = original })
  completeBusy(ctx)
  await waitFor(() => reached, 'pending continuation seat await')
  const chat = ctx.liveChat(); chat.openActions(); chat.querySelectorAll('.chat-actions-row').find(row => /Switch model/.test(row.textContent)).dispatch('click')
  await waitFor(() => chat.querySelectorAll('.chat-actions-row').some(row => /Keep the tier/.test(row.textContent)), 'keep current model')
  chat.querySelectorAll('.chat-actions-row').find(row => /Keep the tier/.test(row.textContent)).dispatch('click')
  await waitFor(() => !/Pending:/.test(ctx.liveChat().querySelector('.chat-chip-model').textContent), 'pending cancelled')
  release(); await settleTurns()
  assert.equal(startedRequests(ctx).length, 0)
  assert.equal(ctx.readNode().sessionId, ctx.OLD_SESSION)
  assert.equal(ctx.calls.filter(x => x.call === 'close' || x.call === 'interrupt').length, 0)
})

test('busy dialog model choice stays pending then continues once on the selected tier', { skip: payloadSkip }, async t => {
  sharedBridge.startableTiers = async () => ({ ok: true, tiers: [FROM_TIER, 'claude-opus'] })
  t.after(() => { delete sharedBridge.startableTiers })
  const ctx = await busyCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId }) })
  const chat = ctx.liveChat(); chat.openActions()
  chat.querySelectorAll('.chat-actions-row').find(row => /Switch and continue/.test(row.textContent)).dispatch('click')
  await waitFor(() => document.body.querySelector('.switch-continue'), 'busy model dialog')
  const dialog = document.body.querySelector('.switch-continue')
  const target = dialog.querySelectorAll('[data-switch-model]').find(row => row.value === 'claude-opus')
  assert.equal(target.disabled, false); target.checked = true; target.dispatch('change')
  dialog.querySelector('[data-switch-continue]').dispatch('click')
  await waitFor(() => /Pending:/.test(ctx.liveChat().querySelector('.chat-chip-model').textContent), 'dialog pending state')
  assert.equal(startedRequests(ctx).length, 0)
  assert.equal(ctx.calls.filter(x => x.call === 'interrupt').length, 0)
  completeBusy(ctx)
  await waitFor(() => ctx.readNode().sessionId === ctx.NEW_SESSION, 'dialog continuation')
  await settleTurns()
  assert.equal(startedRequests(ctx).length, 1)
  assert.equal(startedRequests(ctx)[0].request.tier, 'claude-opus')
})

async function pickBusyDialog(ctx, { account, effort, tier } = {}) {
  const chat = ctx.liveChat(); chat.openActions()
  chat.querySelectorAll('.chat-actions-row').find(row => /Switch and continue/.test(row.textContent)).dispatch('click')
  await waitFor(() => document.body.querySelector('.switch-continue'), 'actual dialog')
  const dialog = document.body.querySelector('.switch-continue')
  for (const [selector, value] of [['[data-switch-account]', account], ['[data-switch-effort]', effort], ['[data-switch-model]', tier]]) {
    if (!value) continue
    const row = dialog.querySelectorAll(selector).find(input => input.value === value)
    assert.ok(row, 'requested choice is offered'); row.checked = true; row.dispatch('change')
  }
  dialog.querySelector('[data-switch-continue]').dispatch('click')
  await waitFor(() => /Pending:/.test(ctx.liveChat().querySelector('.chat-chip-model').textContent), 'pending dialog choice')
}
async function cancelAtSeat(ctx, t) {
  const original = sharedOrgWindow.ensureSeat
  let release, reached = false
  const gate = new Promise(resolve => { release = resolve })
  sharedOrgWindow.ensureSeat = async request => { reached = true; await gate; return original(request) }
  t.after(() => { release(); sharedOrgWindow.ensureSeat = original })
  completeBusy(ctx)
  await waitFor(() => reached, 'dialog continuation at seat')
  const chat = ctx.liveChat(); chat.openActions()
  chat.querySelectorAll('.chat-actions-row').find(row => /Switch model/.test(row.textContent)).dispatch('click')
  await waitFor(() => chat.querySelectorAll('.chat-actions-row').some(row => /Keep the tier/.test(row.textContent)), 'keep current')
  chat.querySelectorAll('.chat-actions-row').find(row => /Keep the tier/.test(row.textContent)).dispatch('click')
  await waitFor(() => !/Pending:/.test(ctx.liveChat().querySelector('.chat-chip-model').textContent), 'cancel visible')
  release(); await settleTurns()
}
async function prepareChangedSeat(ctx, t) {
  // The real seat update completes after its pending model choice was cancelled.
  // This leaves the still-live predecessor requiring a seat refresh next time.
  await chooseBusyModel(ctx)
  await cancelAtSeat(ctx, t)
  assert.equal(startedRequests(ctx).length, 0)
  const seat = ctx.org.read().org.agents.find(row => row.id === ctx.NODE_ID)
  assert.equal(seat.provider, 'codex')
  assert.equal(ctx.readNode().tier, FROM_TIER, 'cancelled choice never claims the target tier')
  assert.equal(ctx.readNode().sessionId, ctx.OLD_SESSION, 'predecessor remains bound')
  sharedOrgWindow.ensureSeat = async request => liveCase.org.ensureSeat(request)
  const input = ctx.liveChat().querySelector('.chat-input input')
  input.value = 'another current turn'
  ctx.liveChat().querySelector('.chat-send').dispatch('click')
  await waitFor(() => ctx.readNode().status === 'running', 'second real turn')
  const sent = ctx.calls.filter(row => row.call === 'send')
  assert.equal(sent.length, 1, 'one deliberate send after cancelled seat adoption')
  assert.equal(sent[0].sessionId, ctx.OLD_SESSION)
  assert.equal(sent[0].request.text, 'another current turn')
  ctx.calls.length = 0
}
test('pending account-only choice cancelled during seat never starts a replacement', { skip: payloadSkip }, async t => {
  sharedBridge.startableTiers = async () => ({ ok: true, tiers: [FROM_TIER, TO_TIER] })
  t.after(() => { delete sharedBridge.startableTiers })
  const ctx = await busyCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId }) }, { initialAccount: 'primary' })
  const providers = { accounts: async () => ({ ok: true, accounts: [
    { name: 'primary', provider: 'claude', signedIn: true }, { name: 'backup', provider: 'claude', signedIn: true }] }),
    accountSwitch: async () => ({ ok: true, switched: true }) }
  window.mcProviders = globalThis.mcProviders = providers
  t.after(() => { delete globalThis.mcProviders })
  await prepareChangedSeat(ctx, t)
  await pickBusyDialog(ctx, { account: 'backup' })
  await cancelAtSeat(ctx, t)
  assert.equal(startedRequests(ctx).length, 0)
  assert.equal(ctx.readNode().sessionId, ctx.OLD_SESSION)
})
test('pending effort-only choice cancelled during seat never resumes or replaces', { skip: payloadSkip }, async t => {
  sharedBridge.startableTiers = async () => ({ ok: true, tiers: [FROM_TIER, TO_TIER] })
  t.after(() => { delete sharedBridge.startableTiers })
  const ctx = await busyCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId }) })
  await prepareChangedSeat(ctx, t)
  await pickBusyDialog(ctx, { effort: 'high' })
  await cancelAtSeat(ctx, t)
  assert.equal(startedRequests(ctx).length, 0)
  assert.equal(ctx.readNode().sessionId, ctx.OLD_SESSION)
})
test('a newer choice while the prior choice awaits seat applies once without another boundary', { skip: payloadSkip }, async t => {
  const ctx = await busyCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId }) })
  await chooseBusyModel(ctx)
  const original = sharedOrgWindow.ensureSeat
  let release, reached = false
  const gate = new Promise(resolve => { release = resolve })
  sharedOrgWindow.ensureSeat = async request => { reached = true; await gate; return original(request) }
  t.after(() => { release(); sharedOrgWindow.ensureSeat = original })
  completeBusy(ctx); await waitFor(() => reached, 'first pending seat')
  await pressContinueRow(ctx, SAME_ROW)
  assert.match(ctx.liveChat().querySelector('.chat-chip-model').textContent, /Pending:.*Opus/)
  release()
  await waitFor(() => ctx.readNode().sessionId === ctx.NEW_SESSION, 'latest choice without a second completion')
  await settleTurns()
  assert.equal(startedRequests(ctx).length, 1)
  assert.equal(startedRequests(ctx)[0].request.tier, 'claude-opus')
})

test('pending current-tier effort applies once after completion and sends no interrupt', { skip: payloadSkip }, async t => {
  sharedBridge.startableTiers = async () => ({ ok: true, tiers: [FROM_TIER] })
  t.after(() => { delete sharedBridge.startableTiers })
  const ctx = await busyCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId }) })
  await pickBusyDialog(ctx, { effort: 'high' })
  assert.equal(startedRequests(ctx).length, 0)
  completeBusy(ctx)
  await waitFor(() => ctx.readNode().sessionId === ctx.NEW_SESSION, 'effort at boundary')
  await settleTurns()
  assert.equal(startedRequests(ctx).length, 1)
  assert.equal(startedRequests(ctx)[0].request.tier, FROM_TIER)
  assert.equal(startedRequests(ctx)[0].request.effort, 'high')
  assert.equal(ctx.calls.filter(row => row.call === 'interrupt').length, 0)
})

test('already queued owner message has a visible safe hold after Keep cancels held seat adoption', { skip: payloadSkip }, async t => {
  const { list } = await import('../../src/session-outbox.js')
  const ctx = await busyCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId }) })
  await chooseBusyModel(ctx)
  ctx.liveChat().querySelector('.chat-input input').value = 'queued before Keep boundary'
  ctx.liveChat().querySelector('.chat-send').dispatch('click')
  await waitFor(() => list(ctx.OLD_SESSION).length === 1, 'owner message queued before boundary')
  await cancelAtSeat(ctx, t)
  assert.equal(startedRequests(ctx).length, 0)
  assert.equal(ctx.calls.filter(row => row.call === 'send').length, 0, 'mismatched adopted seat must not blindly drain')
  assert.equal(ctx.org.read().org.agents.find(row => row.id === ctx.NODE_ID).provider, 'codex')
  assert.equal(ctx.readNode().tier, FROM_TIER)
  assert.deepEqual(list(ctx.OLD_SESSION).map(row => row.text), ['queued before Keep boundary'])
  assert.match(String(ctx.readNode().statusNote || '') + ' ' + list(ctx.OLD_SESSION).map(row => row.heldReason || '').join(' '),
    /held|paused|waiting|reconcil/i, 'retained queue has an explicit visible reason after cancellation')
})

test('already queued owner message drains once after newer native choice replaces held seat choice', { skip: payloadSkip }, async t => {
  const { list } = await import('../../src/session-outbox.js')
  const ctx = await busyCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId }) },
    { fromTier: 'astra', provider: 'codex' })
  await pressContinueRow(ctx, 'Continue on Sonnet · Claude')
  ctx.liveChat().querySelector('.chat-input input').value = 'queued before native replacement'
  ctx.liveChat().querySelector('.chat-send').dispatch('click')
  await waitFor(() => list(ctx.OLD_SESSION).length === 1, 'queued owner intent')
  const original = sharedOrgWindow.ensureSeat
  let release, reached = false
  const gate = new Promise(resolve => { release = resolve })
  sharedOrgWindow.ensureSeat = async request => { reached = true; await gate; return original(request) }
  t.after(() => { release(); sharedOrgWindow.ensureSeat = original })
  completeBusy(ctx); await waitFor(() => reached, 'cross-provider choice at seat')
  const chat = ctx.liveChat(); chat.openActions()
  chat.querySelectorAll('.chat-actions-row').find(row => /Switch model/.test(row.textContent)).dispatch('click')
  await waitFor(() => chat.querySelectorAll('.chat-actions-row').some(row => /Luna/.test(row.textContent)), 'new native choice')
  chat.querySelectorAll('.chat-actions-row').find(row => /Luna/.test(row.textContent)).dispatch('click')
  release(); await settleTurns()
  const sent = ctx.calls.filter(row => row.call === 'send')
  assert.equal(startedRequests(ctx).length, 0)
  if (sent.length) {
    assert.equal(ctx.org.read().org.agents.find(row => row.id === ctx.NODE_ID).provider, 'codex', 'drain requires reconciled seat')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].request.text, 'queued before native replacement')
    assert.equal(sent[0].request.model, 'gpt-5.6-luna')
    assert.equal(list(ctx.OLD_SESSION).length, 0)
  } else {
    assert.deepEqual(list(ctx.OLD_SESSION).map(row => row.text), ['queued before native replacement'])
    assert.match(String(ctx.readNode().statusNote || '') + ' ' + list(ctx.OLD_SESSION).map(row => row.heldReason || '').join(' '),
      /held|paused|waiting|reconcil/i, 'a deferred drain must name its hold')
  }
})

for (const action of ['Keep', 'newer', 'Stop', 'replacement']) {
  test('pending continuation held in actual handoff read honors ' + action, { skip: payloadSkip }, async t => {
    let armed = false, reached = false, release
    const gate = new Promise(resolve => { release = resolve })
    t.after(() => release())
    const ctx = await busyCircle(t, {
      replacementStart: async (_, sessionId) => ({ ok: true, sessionId }),
      configureWindow(win) {
        win.mcRecovery = {
          async get() { if (armed) { reached = true; await gate } return { ok: true, authoritative: true, record: null } },
          async save() { return { ok: true } },
        }
      },
    })
    await chooseBusyModel(ctx); armed = true; completeBusy(ctx)
    await waitFor(() => reached, 'real coordinator after seat at handoff read')
    assert.equal(ctx.org.read().org.agents.find(row => row.id === ctx.NODE_ID).provider, 'codex')
    assert.equal(startedRequests(ctx).length, 0)
    if (action === 'replacement') {
      await replaceLiveSession(ctx, { sessionId: 'externally-replaced-during-handoff' })
    } else if (action === 'Stop') {
      const chat = ctx.liveChat(); chat.openActions()
      chat.querySelectorAll('.chat-actions-row').find(row => /Stop this agent/.test(row.textContent)).dispatch('click')
      await waitFor(() => ctx.calls.some(row => row.call === 'close'), 'explicit Stop')
    } else if (action === 'newer') {
      await pressContinueRow(ctx, SAME_ROW)
    } else {
      const chat = ctx.liveChat(); chat.openActions()
      chat.querySelectorAll('.chat-actions-row').find(row => /Switch model/.test(row.textContent)).dispatch('click')
      await waitFor(() => chat.querySelectorAll('.chat-actions-row').some(row => /Keep the tier/.test(row.textContent)), 'Keep row')
      chat.querySelectorAll('.chat-actions-row').find(row => /Keep the tier/.test(row.textContent)).dispatch('click')
    }
    armed = false; release(); await settleTurns()
    if (action === 'newer') {
      await waitFor(() => startedRequests(ctx).length === 1, 'only the newer continuation')
      assert.equal(startedRequests(ctx)[0].request.tier, 'claude-opus')
    } else {
      assert.equal(startedRequests(ctx).length, 0, 'cancelled choice never invokes host start after read')
      assert.equal(ctx.calls.filter(row => row.call === 'send').length, 0, 'cancelled choice never dispatches a handoff')
    }
  })
}

for (const busy of [false, true]) {
  test('displayed resume sends no handoff for ' + (busy ? 'pending' : 'idle') + ' same-account model choice', { skip: payloadSkip }, async t => {
    sharedBridge.startableTiers = async () => ({ ok: true, tiers: [FROM_TIER, 'claude-opus'] })
    t.after(() => { delete sharedBridge.startableTiers })
    const ctx = await (busy ? busyCircle : runningCircle)(t, {
      initialThreadId: 'fixture-established-thread',
      replacementStart: async (_, sessionId) => ({ ok: true, sessionId, threadId: 'fixture-established-thread', account: 'primary', resumed: { turns: [], turnCount: 1 } }),
    }, { initialAccount: 'primary' })
    window.mcProviders = globalThis.mcProviders = { accounts: async () => ({ ok: true, accounts: [{ name: 'primary', provider: 'claude', signedIn: true }] }) }
    t.after(() => { delete globalThis.mcProviders })
    const chat = ctx.liveChat(); chat.openActions()
    chat.querySelectorAll('.chat-actions-row').find(row => /Switch and continue/.test(row.textContent)).dispatch('click')
    await waitFor(() => document.body.querySelector('.switch-continue'), 'actual route dialog')
    const dialog = document.body.querySelector('.switch-continue')
    const target = dialog.querySelectorAll('[data-switch-model]').find(row => row.value === 'claude-opus')
    assert.ok(target); target.checked = true; target.dispatch('change')
    assert.match(dialog.textContent, /resume|nothing is re-sent/i, 'person is offered a native resume')
    dialog.querySelector('[data-switch-continue]').dispatch('click')
    if (busy) {
      await waitFor(() => /Pending:/.test(ctx.liveChat().querySelector('.chat-chip-model').textContent), 'pending native choice')
      assert.equal(startedRequests(ctx).length, 0); completeBusy(ctx)
    }
    await waitFor(() => ctx.readNode().sessionId === ctx.NEW_SESSION, 'native resumed address')
    await settleTurns()
    assert.equal(startedRequests(ctx).length, 1)
    assert.equal(startedRequests(ctx)[0].request.resumeThreadId, 'fixture-established-thread')
    assert.equal(startedRequests(ctx)[0].request.tier, 'claude-opus')
    assert.equal(ctx.calls.filter(row => row.call === 'send').length, 0, 'displayed resume never resends transcript/brief')
  })
}

async function keepCurrentDuringAwait(ctx) {
  const chat = ctx.liveChat(); chat.openActions()
  chat.querySelectorAll('.chat-actions-row').find(row => /Switch model/.test(row.textContent)).dispatch('click')
  await waitFor(() => chat.querySelectorAll('.chat-actions-row').some(row => /Keep the tier/.test(row.textContent)), 'Keep during await')
  chat.querySelectorAll('.chat-actions-row').find(row => /Keep the tier/.test(row.textContent)).dispatch('click')
}
for (const failure of ['generic', 'provider-limit']) {
  test('cancelled pending native resume never falls back after delayed ' + failure, { skip: payloadSkip }, async t => {
    let reached = false, release, accountsReached = false
    const gate = new Promise(resolve => { release = resolve })
    t.after(() => release())
    sharedBridge.startableTiers = async () => ({ ok: true, tiers: [FROM_TIER] })
    t.after(() => { delete sharedBridge.startableTiers; delete globalThis.mcProviders })
    const ctx = await busyCircle(t, {
      initialThreadId: 'fixture-native-cancel-thread',
      replacementStart: async request => {
        reached = true
        if (failure === 'generic') await gate
        throw Object.assign(new Error('fixture native admission refusal'), {
          code: failure === 'generic' ? 'FIXTURE_START_UNKNOWN' : 'AGENT_RESUME_ACCOUNT_LIMIT',
          exhaustedBy: 'provider',
          ...(failure === 'provider-limit' ? { startOutcome: { requestSessionId: request.sessionId, admission: 'not-admitted', cleanup: 'not-required', custody: 'none' } } : {}),
        })
      },
    }, { initialAccount: 'primary' })
    window.mcProviders = globalThis.mcProviders = {
      accounts: async () => {
        if (reached && failure === 'provider-limit') { accountsReached = true; await gate }
        return { ok: true, accounts: [{ name: 'primary', provider: 'claude', signedIn: true }], policy: { autoRecoverOnLimit: true } }
      },
    }
    await pickBusyDialog(ctx, { effort: 'high' })
    completeBusy(ctx); await waitFor(() => reached, 'native start entered')
    if (failure === 'provider-limit') await waitFor(() => accountsReached, 'keep-trying consent await')
    await keepCurrentDuringAwait(ctx)
    release(); await settleTurns()
    assert.equal(startedRequests(ctx).length, 1, 'only original native attempt; no fallback or account restart')
    assert.equal(ctx.calls.filter(row => row.call === 'send').length, 0, 'unknown/cancelled admission never sends a seed')
    assert.equal(ctx.readNode().sessionId, ctx.OLD_SESSION, 'unconfirmed successor never replaces predecessor identity')
  })
}

for (const action of ['Keep', 'Stop']) for (const cleanup of ['confirmed', 'matching-id-no-ok', 'missing-id', 'wrong-id', 'refused', 'unknown']) {
  test('late native success after ' + action + ' retains successor custody with cleanup ' + cleanup, { skip: payloadSkip }, async t => {
    let reached = false, release
    const gate = new Promise(resolve => { release = resolve })
    t.after(() => release())
    sharedBridge.startableTiers = async () => ({ ok: true, tiers: [FROM_TIER] })
    t.after(() => { delete sharedBridge.startableTiers })
    const ctx = await busyCircle(t, {
      initialThreadId: 'fixture-late-success-thread',
      replacementStart: async (_, sessionId) => {
        reached = true; await gate
        return { ok: true, sessionId, threadId: 'fixture-late-success-thread', resumed: { turns: [], turnCount: 1 } }
      },
    })
    const close = liveCase.close
    liveCase.close = async request => {
      if (request.sessionId !== ctx.NEW_SESSION || cleanup === 'confirmed') return close(request)
      ctx.calls.push({ call: 'close', sessionId: request.sessionId, request })
      if (cleanup === 'unknown') throw Object.assign(new Error('fixture cleanup outcome unknown'), { code: 'EPIPE' })
      if (cleanup === 'matching-id-no-ok') return { sessionId: request.sessionId, closed: true }
      if (cleanup === 'missing-id') return { closed: true }
      if (cleanup === 'wrong-id') return { sessionId: ctx.OLD_SESSION, closed: true }
      return { ok: false, sessionId: request.sessionId, closed: true, code: 'FIXTURE_CLEANUP_REFUSED' }
    }
    await pickBusyDialog(ctx, { effort: 'high' })
    completeBusy(ctx); await waitFor(() => reached, 'native start in flight')
    if (action === 'Keep') await keepCurrentDuringAwait(ctx)
    else {
      const chat = ctx.liveChat(); chat.openActions()
      chat.querySelectorAll('.chat-actions-row').find(row => /Stop this agent/.test(row.textContent)).dispatch('click')
      await waitFor(() => ctx.calls.some(row => row.call === 'close' && row.sessionId === ctx.OLD_SESSION), 'explicit predecessor Stop')
    }
    const cancelled = ctx.readNode()
    release(); await settleTurns()
    assert.equal(startedRequests(ctx).length, 1, 'only the originally admitted native start')
    assert.equal(ctx.calls.filter(row => row.call === 'send').length, 0, 'cancelled native success never dispatches')
    const cleanupCalls = ctx.calls.filter(row => row.call === 'close' && row.sessionId === ctx.NEW_SESSION)
    assert.equal(cleanupCalls.length, 1, 'the exact late successor receives one cleanup attempt')
    const after = ctx.readNode()
    if (cleanup === 'confirmed' || cleanup === 'matching-id-no-ok') {
      assert.notEqual(after.sessionId, ctx.NEW_SESSION, 'confirmed closed successor is not painted current')
      assert.equal(after.statusNote, cancelled.statusNote, 'late success does not replace cancellation status with applied')
    } else {
      // A cancelled successor must remain reachable without becoming the
      // current/applied conversation or overwriting a person's Stop.
      for (const key of ['sessionId', 'status', 'statusNote', 'tier', 'effort'])
        assert.equal(after[key], cancelled[key], 'late cleanup preserves cancelled ' + key)
      const chat = ctx.liveChat(); chat.openActions()
      const retained = chat.querySelectorAll('.chat-actions-row').find(row => /clean.*earlier session/i.test(row.textContent))
      assert.ok(retained, 'unconfirmed successor has an explicit reachable cleanup action')
      liveCase.close = async request => {
        ctx.calls.push({ call: 'close', sessionId: request.sessionId, request })
        return { sessionId: request.sessionId, closed: true }
      }
      retained.dispatch('click'); await settleTurns()
      assert.equal(ctx.calls.filter(row => row.call === 'close' && row.sessionId === ctx.NEW_SESSION).length, 2)
      assert.equal(ctx.readNode().sessionId, cancelled.sessionId, 'cleanup cannot adopt the cancelled provider')
    }
    assert.doesNotMatch(ctx.liveChat().querySelector('.chat-chip-model').textContent, /Pending:/)
  })
}

test('pending cross-provider choice completes its admitted handoff exactly once', { skip: payloadSkip }, async t => {
  const ctx = await busyCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId }) })
  await chooseBusyModel(ctx); completeBusy(ctx)
  await waitFor(() => startedRequests(ctx).length === 1, 'replacement admitted')
  await settleTurns()
  const sent = ctx.calls.filter(row => row.call === 'send')
  assert.equal(sent.length, 1, 'valid owned successor receives the complete handoff')
  assert.equal(sent[0].sessionId, ctx.NEW_SESSION)
  assert.equal(sent[0].channel, 'automatic', 'handoff uses tracked automatic envelope')
  assert.match(sent[0].request.text, /Previous model: Sonnet.*New model: GPT-6-Astra/s)
  assert.equal(ctx.calls.filter(row => row.call === 'close' && row.sessionId === ctx.NEW_SESSION).length, 0, 'own attachment does not cancel successor')
  assert.equal(ctx.readNode().sessionId, ctx.NEW_SESSION)
  assert.equal(ctx.readNode().tier, TO_TIER)
  assert.doesNotMatch(ctx.liveChat().querySelector('.chat-chip-model').textContent, /Pending:/)
})

test('changed-tier pending resume cancelled before uncreated refusal preserves current preferences and status', { skip: payloadSkip }, async t => {
  let reached = false, release
  const gate = new Promise(resolve => { release = resolve }); t.after(() => release())
  sharedBridge.startableTiers = async () => ({ ok: true, tiers: [FROM_TIER, 'claude-opus'] })
  t.after(() => { delete sharedBridge.startableTiers })
  const ctx = await busyCircle(t, {
    initialThreadId: 'fixture-preference-thread',
    replacementStart: async () => { reached = true; await gate; return { ok: false, code: 'FIXTURE_NOT_STARTED' } },
  })
  const before = ctx.readNode()
  await pickBusyDialog(ctx, { tier: 'claude-opus', effort: 'high' })
  completeBusy(ctx); await waitFor(() => reached, 'changed model start awaits')
  assert.equal(ctx.readNode().tier, before.tier, 'pending admission has not changed durable current model')
  await keepCurrentDuringAwait(ctx)
  const cancelled = ctx.readNode()
  release(); await settleTurns()
  const after = ctx.readNode()
  assert.equal(after.sessionId, ctx.OLD_SESSION)
  assert.equal(after.tier, before.tier)
  assert.equal(after.effort, before.effort)
  assert.equal(after.statusNote, cancelled.statusNote, 'old refusal cannot overwrite newer cancellation status')
  assert.equal(startedRequests(ctx).length, 1)
  assert.equal(ctx.calls.filter(row => row.call === 'send').length, 0)
})

for (const cleanup of ['refused', 'unknown']) {
  test('newer pending choice survives older native success with cleanup ' + cleanup, { skip: payloadSkip }, async t => {
    let admitted = false, releaseStart, closeReached = false, releaseClose
    const startGate = new Promise(resolve => { releaseStart = resolve })
    const closeGate = new Promise(resolve => { releaseClose = resolve })
    t.after(() => { releaseStart(); releaseClose() })
    sharedBridge.startableTiers = async () => ({ ok: true, tiers: [FROM_TIER, 'claude-opus'] })
    t.after(() => { delete sharedBridge.startableTiers })
    let starts = 0
    const ctx = await busyCircle(t, {
      initialThreadId: 'fixture-newer-choice-thread',
      replacementStart: async (_, sessionId) => {
        starts += 1
        if (starts === 1) { admitted = true; await startGate }
        return { ok: true, sessionId: starts === 1 ? sessionId : 'fixture-latest-successor',
          threadId: 'fixture-newer-choice-thread', resumed: { turns: [], turnCount: 1 } }
      },
    })
    const close = liveCase.close
    liveCase.close = async request => {
      if (request.sessionId !== ctx.NEW_SESSION) return close(request)
      ctx.calls.push({ call: 'close', sessionId: request.sessionId, request })
      closeReached = true; await closeGate
      if (cleanup === 'unknown') throw new Error('fixture close acknowledgement unknown')
      return { ok: false, code: 'FIXTURE_CLEANUP_REFUSED' }
    }
    await pickBusyDialog(ctx, { effort: 'high' })
    completeBusy(ctx); await waitFor(() => admitted, 'first native admission held')
    await pickBusyDialog(ctx, { tier: 'claude-opus', effort: 'low' })
    releaseStart(); await waitFor(() => closeReached, 'old successor cleanup held')
    assert.equal(ctx.readNode().sessionId, ctx.OLD_SESSION, 'old successor does not claim the newer choice')
    assert.match(ctx.liveChat().querySelector('.chat-chip-model').textContent, /Pending:.*Opus/)
    releaseClose()
    await waitFor(() => startedRequests(ctx).length === 2, 'newer pending choice is not stranded')
    await settleTurns()
    assert.equal(ctx.calls.filter(row => row.call === 'close' && row.sessionId === ctx.NEW_SESSION).length, 1)
    assert.equal(ctx.calls.filter(row => row.call === 'send').length, 0, 'both displayed native resumes send no handoff')
    assert.equal(ctx.readNode().sessionId, 'fixture-latest-successor')
    assert.equal(ctx.readNode().tier, 'claude-opus')
    assert.equal(ctx.readNode().effort, 'low')
  })
}

test('retiring a cancelled successor does not erase current-session activity', { skip: payloadSkip }, async t => {
  let started = false, releaseStart, closing = false, releaseClose
  const startGate = new Promise(resolve => { releaseStart = resolve })
  const closeGate = new Promise(resolve => { releaseClose = resolve })
  t.after(() => { releaseStart(); releaseClose() })
  sharedBridge.startableTiers = async () => ({ ok: true, tiers: [FROM_TIER] })
  t.after(() => { delete sharedBridge.startableTiers })
  const ctx = await busyCircle(t, {
    initialThreadId: 'fixture-activity-thread',
    replacementStart: async (_, sessionId) => {
      started = true; await startGate
      return { ok: true, sessionId, threadId: 'fixture-activity-thread', resumed: { turns: [], turnCount: 1 } }
    },
  })
  const close = liveCase.close
  liveCase.close = async request => {
    if (request.sessionId !== ctx.NEW_SESSION) return close(request)
    ctx.calls.push({ call: 'close', sessionId: request.sessionId, request })
    closing = true; await closeGate
    return { sessionId: request.sessionId, closed: true }
  }
  await pickBusyDialog(ctx, { effort: 'high' })
  completeBusy(ctx); await waitFor(() => started, 'native admission held')
  await keepCurrentDuringAwait(ctx); releaseStart()
  await waitFor(() => closing, 'successor cleanup held')
  ctx.emit({ sessionId: ctx.OLD_SESSION, event: { type: 'tool_call', turnId: 'current-activity-turn',
    toolCallId: 'current-activity-call', tool: 'shell', payload: { command: 'fixture-current-activity' } } })
  await settleTurns()
  const activity = ctx.view.el.querySelector('[data-tree-activity]')
  assert.ok(activity, 'actual rail exposes current activity')
  assert.match(activity.textContent, /fixture-current-activity/)
  const before = activity.textContent
  releaseClose(); await settleTurns()
  assert.equal(ctx.readNode().sessionId, ctx.OLD_SESSION)
  assert.equal(ctx.view.el.querySelector('[data-tree-activity]').textContent, before,
    'closing a different session cannot retire current activity')
  assert.equal(startedRequests(ctx).length, 1)
  assert.equal(ctx.calls.filter(row => row.call === 'send').length, 0)
})

for (const timing of ['before cleanup', 'during close', 'recreated before cleanup', 'recreated during explicit cleanup']) for (const reply of ['refused', 'missing-id', 'unknown']) {
  test('origin cleanup preserves newer same-node state ' + timing + ' with ' + reply, { skip: payloadSkip }, async t => {
    let startReached = false, releaseStart, closeReached = false, releaseClose, retryCleanup = false, actionReached = false, releaseAction
    const startGate = new Promise(resolve => { releaseStart = resolve })
    const closeGate = new Promise(resolve => { releaseClose = resolve })
    const actionGate = new Promise(resolve => { releaseAction = resolve })
    t.after(() => { releaseStart(); releaseClose(); releaseAction() })
    const ctx = await busyCircle(t, { replacementStart: async (_, sessionId) => {
      startReached = true; await startGate; return { ok: true, sessionId }
    } })
    const ordinaryClose = liveCase.close
    liveCase.close = async request => {
      if (request.sessionId !== ctx.NEW_SESSION) return ordinaryClose(request)
      ctx.calls.push({ call: 'close', sessionId: request.sessionId, request })
      if (retryCleanup) { actionReached = true; if (timing === 'recreated during explicit cleanup') await actionGate; return { sessionId: request.sessionId, closed: true } }
      closeReached = true; await closeGate
      if (reply === 'unknown') throw new Error('fixture old cleanup unknown')
      if (reply === 'missing-id') return { closed: true }
      return { ok: false, sessionId: request.sessionId, closed: true }
    }
    await chooseBusyModel(ctx); completeBusy(ctx)
    await waitFor(() => startReached, 'originating recovery admission awaits')
    await keepCurrentDuringAwait(ctx)
    const newerId = 'fixture-newer-owned-session'
    const replaceSavedSession = async () => {
      await replaceLiveSession(ctx, { sessionId: newerId, tier: TO_TIER, effort: 'low',
        recreate: timing === 'recreated before cleanup' })
    }
    if (timing !== 'during close') await replaceSavedSession()
    releaseStart(); await waitFor(() => closeReached, 'exact old successor cleanup awaits')
    if (timing === 'during close') await replaceSavedSession()
    const expected = ctx.readNode()
    releaseClose(); await settleTurns()
    const after = ctx.readNode()
    for (const key of ['sessionId', 'status', 'statusNote', 'tier', 'effort'])
      assert.equal(after[key], expected[key], 'old cleanup preserves newer ' + key)
    assert.equal(ctx.calls.filter(row => row.call === 'send').length, 0, 'no handoff or replay into newer session')
    assert.equal(ctx.calls.filter(row => row.call === 'close' && row.sessionId === newerId).length, 0)
    const chat = ctx.liveChat(); chat.openActions()
    const cleanup = chat.querySelectorAll('.chat-actions-row').find(row => /clean.*earlier session/i.test(row.textContent))
    assert.ok(cleanup, 'detached old obligation has an actionable cleanup control')
    retryCleanup = true; cleanup.dispatch('click')
    if (timing === 'recreated during explicit cleanup') {
      await waitFor(() => actionReached, 'explicit detached cleanup acknowledgement held')
      await replaceLiveSession(ctx, { sessionId: ctx.NEW_SESSION, effort: 'medium',
        note: 'Recreated owner work', recreate: true })
      ctx.emit({ sessionId: ctx.NEW_SESSION, event: { type: 'tool_call', turnId: 'recreated-active',
        toolCallId: 'recreated-active-call', tool: 'shell', payload: { command: 'fixture-recreated-activity' } } })
      await settleTurns()
      const expected = ctx.readNode()
      const activity = ctx.view.el.querySelector('[data-tree-activity]')?.textContent
      assert.match(activity || '', /fixture-recreated-activity/, 'new incarnation activity is routed')
      releaseAction(); await settleTurns()
      for (const key of ['createdAt','sessionId','status','statusNote','tier','effort'])
        assert.equal(ctx.readNode()[key], expected[key], 'explicit old close preserves recreated ' + key)
      assert.equal(ctx.view.el.querySelector('[data-tree-activity]')?.textContent, activity)
      ctx.emit({ sessionId: ctx.NEW_SESSION, event: { type: 'tool_call', turnId: 'recreated-active',
        toolCallId: 'recreated-after-cleanup-call', tool: 'shell', payload: { command: 'fixture-recreated-activity-after-cleanup' } } })
      await waitFor(() => ctx.view.el.querySelector('[data-tree-activity]')?.textContent.includes('fixture-recreated-activity-after-cleanup'),
        'the recreated session still receives later activity after the old cleanup acknowledgement')
    }
    await settleTurns()
    assert.equal(ctx.calls.filter(row => row.call === 'close' && row.sessionId === ctx.NEW_SESSION).length, 2,
      'explicit cleanup retry targets only the old successor')
    assert.equal(ctx.calls.filter(row => row.call === 'close' && row.sessionId === newerId).length, 0)
    assert.equal(ctx.readNode().sessionId, timing === 'recreated during explicit cleanup' ? ctx.NEW_SESSION : newerId)
    assert.equal(startedRequests(ctx).length, 1)
  })
}

for (const receipt of ['not-admitted', 'cleaned']) {
  test('released native custody does not override cancelled owner choice: ' + receipt, { skip: payloadSkip }, async t => {
    let reached = false, release
    const gate = new Promise(resolve => { release = resolve }); t.after(() => release())
    sharedBridge.startableTiers = async () => ({ ok: true, tiers: [FROM_TIER] })
    t.after(() => { delete sharedBridge.startableTiers })
    const ctx = await busyCircle(t, {
      initialThreadId: 'fixture-cancelled-outcome-thread',
      replacementStart: async request => { reached = true; await gate; return { ok: false, code: 'CLAUDE_INITIALIZE_REFUSED',
        startOutcome: { requestSessionId: request.sessionId, admission: receipt === 'not-admitted' ? 'not-admitted' : 'unknown',
          cleanup: receipt === 'not-admitted' ? 'not-required' : 'confirmed', custody: 'none' } } },
    })
    await pickBusyDialog(ctx, { effort: 'high' }); completeBusy(ctx)
    await waitFor(() => reached, 'native outcome held')
    await keepCurrentDuringAwait(ctx); release(); await settleTurns()
    assert.equal(startedRequests(ctx).length, 1, 'cancelled choice never falls back')
    assert.equal(ctx.calls.filter(row => row.call === 'send').length, 0)
  })
}

for (const outcome of ['missing','pending']) for (const action of ['Keep','Stop','newer-node']) {
  test('uncertain native custody after ' + action + ' preserves current publication: ' + outcome, { skip: payloadSkip }, async t => {
    let reached = false, release, requestedId
    const gate = new Promise(resolve => { release = resolve }); t.after(() => release())
    sharedBridge.startableTiers = async () => ({ ok: true, tiers: [FROM_TIER] })
    t.after(() => { delete sharedBridge.startableTiers })
    const ctx = await busyCircle(t, { initialThreadId: 'fixture-uncertain-origin',
      replacementStart: async request => { requestedId = request.sessionId; reached = true; await gate
        return { ok: false, code: 'CLAUDE_INITIALIZE_REFUSED', ...(outcome === 'pending' ? {
          startOutcome: { requestSessionId: request.sessionId, admission:'unknown',cleanup:'pending',custody:'cleanup-pending' } } : {}) } },
    })
    await pickBusyDialog(ctx, { effort:'high' }); completeBusy(ctx)
    await waitFor(() => reached, 'native uncertain receipt held')
    if (action === 'Keep') await keepCurrentDuringAwait(ctx)
    else if (action === 'Stop') {
      const chat=ctx.liveChat(); chat.openActions()
      chat.querySelectorAll('.chat-actions-row').find(row=>/Stop this agent/.test(row.textContent)).dispatch('click')
      await waitFor(()=>ctx.calls.some(row=>row.call==='close' && row.sessionId===ctx.OLD_SESSION),'Stop settles')
      await settleTurns()
    } else {
      await replaceLiveSession(ctx, { sessionId: 'fixture-newer-native', effort: 'low',
        note: 'Newer work retained', recreate: true })
    }
    const before=ctx.readNode(); release();await settleTurns()
    for(const key of ['createdAt','sessionId','status','statusNote','tier','effort'])
      assert.equal(ctx.readNode()[key],before[key],'stale uncertain refusal preserves '+key)
    assert.equal(startedRequests(ctx).length,1);assert.equal(ctx.calls.filter(row=>row.call==='send').length,0)
    const chat=ctx.liveChat();chat.openActions()
    const cleanup=chat.querySelectorAll('.chat-actions-row').find(row=>/clean.*earlier session/i.test(row.textContent))
    assert.ok(cleanup,'uncertain exact request remains actionable')
    cleanup.dispatch('click');await settleTurns()
    assert.equal(ctx.calls.filter(row=>row.call==='close' && row.sessionId===requestedId).length,1)
    assert.equal(ctx.readNode().sessionId,before.sessionId)
  })
}
for(const attribution of ['provider','configured','unknown','reason-only']) {
  test('returned account refusal respects actual attribution: '+attribution,{skip:payloadSkip},async t=>{
    let starts=0
    sharedBridge.startableTiers=async()=>({ok:true,tiers:[FROM_TIER]})
    t.after(()=>{delete sharedBridge.startableTiers;delete globalThis.mcProviders})
    const ctx=await busyCircle(t,{initialThreadId:'fixture-returned-limit',
      replacementStart:async(request,sessionId)=>{
        starts++;if(starts>1)return{ok:true,sessionId}
        return{ok:false,code:'AGENT_RESUME_ACCOUNT_LIMIT',
          ...(attribution==='reason-only'?{reason:'ATTRIBUTED_TO_PROVIDER'}:attribution==='unknown'?{}:{exhaustedBy:attribution}),
          startOutcome:{requestSessionId:request.sessionId,admission:'not-admitted',cleanup:'not-required',custody:'none'}}
      }},{initialAccount:'primary'})
    window.mcProviders=globalThis.mcProviders={accounts:async()=>({ok:true,
      accounts:[{name:'primary',provider:'claude',signedIn:true},{name:'backup',provider:'claude',signedIn:true}],
      policy:{autoRecoverOnLimit:true}})}
    await pickBusyDialog(ctx,{effort:'high'});completeBusy(ctx)
    await waitFor(()=>starts>0,'returned refusal');await settleTurns()
    assert.equal(startedRequests(ctx).length,attribution==='provider'?2:1,
      'only trusted provider attribution can enter opted-in account continuation')
    if(attribution!=='provider')assert.equal(ctx.calls.filter(row=>row.call==='send').length,0)
  })
}

test('returned provider account refusal cannot continue after Keep',{skip:payloadSkip},async t=>{
  let reached=false,release
  const gate=new Promise(resolve=>{release=resolve});t.after(()=>release())
  sharedBridge.startableTiers=async()=>({ok:true,tiers:[FROM_TIER]})
  t.after(()=>{delete sharedBridge.startableTiers;delete globalThis.mcProviders})
  const ctx=await busyCircle(t,{initialThreadId:'fixture-returned-cancel',
    replacementStart:async request=>{reached=true;await gate;return{ok:false,code:'AGENT_RESUME_ACCOUNT_LIMIT',exhaustedBy:'provider',
      startOutcome:{requestSessionId:request.sessionId,admission:'not-admitted',cleanup:'not-required',custody:'none'}}}
  },{initialAccount:'primary'})
  window.mcProviders=globalThis.mcProviders={accounts:async()=>({ok:true,
    accounts:[{name:'primary',provider:'claude',signedIn:true},{name:'backup',provider:'claude',signedIn:true}],
    policy:{autoRecoverOnLimit:true}})}
  await pickBusyDialog(ctx,{effort:'high'});completeBusy(ctx)
  await waitFor(()=>reached,'returned account refusal held');await keepCurrentDuringAwait(ctx)
  const before=ctx.readNode();release();await settleTurns()
  assert.equal(startedRequests(ctx).length,1);assert.equal(ctx.calls.filter(row=>row.call==='send').length,0)
  assert.equal(ctx.readNode().sessionId,before.sessionId);assert.equal(ctx.readNode().statusNote,before.statusNote)
})

for (const shape of ['thrown', 'returned']) {
  test('provider-limit ' + shape + ' completes tracked handoff and binds successor thread', { skip: payloadSkip }, async t => {
    let starts = 0
    sharedBridge.startableTiers = async () => ({ ok: true, tiers: [FROM_TIER] })
    t.after(() => { delete sharedBridge.startableTiers; delete globalThis.mcProviders })
    const ctx = await busyCircle(t, {
      initialThreadId: 'fixture-provider-origin',
      replacementStart: async (request, sessionId) => {
        if (++starts > 1) return { ok: true, sessionId, account: 'backup' }
        const refusal = { ok: false, code: 'AGENT_RESUME_ACCOUNT_LIMIT', exhaustedBy: 'provider',
          startOutcome: { requestSessionId: request.sessionId, admission: 'not-admitted', cleanup: 'not-required', custody: 'none' } }
        if (shape === 'thrown') throw Object.assign(new Error(refusal.code), refusal)
        return refusal
      },
      automaticDelivery: async () => ({ ok: true, deliveryDisposition: 'accepted',
        result: { ok: true, threadId: 'fixture-completed-provider-thread', turnId: 'fixture-completed-provider-turn' } }),
    }, { initialAccount: 'primary' })
    window.mcProviders = globalThis.mcProviders = { accounts: async () => ({ ok: true,
      accounts: [{ name: 'primary', provider: 'claude', signedIn: true }, { name: 'backup', provider: 'claude', signedIn: true }],
      policy: { autoRecoverOnLimit: true } }) }
    await pickBusyDialog(ctx, { effort: 'high' }); completeBusy(ctx)
    const { createTranscriptStore } = await import('../../src/session-transcript-store.js')
    const transcripts = createTranscriptStore({ computerId: ctx.COMPUTER_ID,
      storage: { read: key => JSON.parse(ctx.world.storage.getItem(key) || 'null'), write: (key, value) => ctx.world.storage.setItem(key, JSON.stringify(value)) } })
    await waitFor(() => transcripts.get(ctx.NODE_ID)?.threadId === 'fixture-completed-provider-thread', 'completed handoff thread binding')
    await settleTurns()
    assert.equal(startedRequests(ctx).length, 2)
    assert.equal(ctx.readNode().sessionId, ctx.NEW_SESSION)
    const deliveries = ctx.calls.filter(row => row.call === 'send')
    assert.equal(deliveries.length, 1)
    assert.equal(deliveries[0].channel, 'automatic')
    assert.equal(deliveries[0].sessionId, ctx.NEW_SESSION)
    assert.ok(deliveries[0].request.text, 'handoff has actual transcript content')
    assert.equal(ctx.calls.filter(row => row.call === 'close' && row.sessionId === ctx.NEW_SESSION).length, 0)
  })
}

for (const action of ['current', 'Keep', 'Stop', 'newer']) {
  test('own transcript fallback first-send refusal publishes only to current owner: ' + action, { skip: payloadSkip }, async t => {
    let starts = 0, sending = false, release
    const gate = new Promise(resolve => { release = resolve }); t.after(() => release())
    sharedBridge.startableTiers = async () => ({ ok: true, tiers: [FROM_TIER] })
    t.after(() => { delete sharedBridge.startableTiers })
    const ctx = await busyCircle(t, { initialThreadId: 'fixture-fallback-origin',
      replacementStart: async (request, sessionId) => ++starts === 1
        ? { ok: false, code: 'CLAUDE_INITIALIZE_REFUSED',
            startOutcome: { requestSessionId: request.sessionId, admission: 'not-admitted', cleanup: 'not-required', custody: 'none' } }
        : { ok: true, sessionId } })
    liveCase.sendAutomatic = async request => {
      ctx.calls.push({ call: 'send', channel: 'automatic', sessionId: request.sessionId, request })
      sending = true; await gate
      return { ok: false, code: 'AGENT_TURN_ALREADY_RUNNING', deliveryDisposition: 'not-sent' }
    }
    await pickBusyDialog(ctx, { effort: 'high' }); completeBusy(ctx)
    await waitFor(() => sending, 'fallback attached before first send settles')
    assert.equal(ctx.readNode().sessionId, ctx.NEW_SESSION)
    if (action === 'Keep') await keepCurrentDuringAwait(ctx)
    if (action === 'Stop') {
      const chat = ctx.liveChat(); chat.openActions()
      chat.querySelectorAll('.chat-actions-row').find(row => /Stop this agent/.test(row.textContent)).dispatch('click')
      await waitFor(() => ctx.calls.some(row => row.call === 'close' && row.sessionId === ctx.NEW_SESSION), 'Stop successor')
      await settleTurns()
    }
    if (action === 'newer') {
      await replaceLiveSession(ctx, { sessionId: 'fixture-newer-after-fallback', effort: 'low', note: 'Newer work' })
    }
    const before = ctx.readNode()
    release(); await settleTurns()
    if (action === 'current') {
      assert.equal(ctx.readNode().status, 'failed', 'own attached nonterminal refusal is visible')
      assert.ok(ctx.readNode().statusNote, 'refusal has a visible explanation')
      assert.equal(ctx.readNode().sessionId, ctx.NEW_SESSION, 'admitted successor remains owned')
    } else for (const key of ['createdAt', 'sessionId', 'status', 'statusNote', 'tier', 'effort'])
      assert.equal(ctx.readNode()[key], before[key], 'late refusal preserves current ' + key)
    assert.equal(startedRequests(ctx).length, 2)
    assert.equal(ctx.calls.filter(row => row.call === 'send').length, 1, 'no refusal replay')
  })
}

for (const action of ['Keep', 'Stop', 'newer']) for (const outcome of ['confirmed', 'missing-id', 'wrong-id', 'refused', 'unknown', 'not-admitted', 'admission-unknown']) {
  test('cancel before fallback open retains exact custody: ' + action + '/' + outcome, { skip: payloadSkip }, async t => {
    let starts = 0, reached = false, release, fallbackRequestId
    const gate = new Promise(resolve => { release = resolve }); t.after(() => release())
    sharedBridge.startableTiers = async () => ({ ok: true, tiers: [FROM_TIER] })
    t.after(() => { delete sharedBridge.startableTiers })
    const ctx = await busyCircle(t, { initialThreadId: 'fixture-pre-open-origin',
      replacementStart: async (request, sessionId) => {
        if (++starts === 1) return { ok: false, code: 'CLAUDE_INITIALIZE_REFUSED',
          startOutcome: { requestSessionId: request.sessionId, admission: 'not-admitted', cleanup: 'not-required', custody: 'none' } }
        fallbackRequestId = request.sessionId; reached = true; await gate
        if (outcome === 'not-admitted') return { ok: false, code: 'CLAUDE_INITIALIZE_REFUSED',
          startOutcome: { requestSessionId: request.sessionId, admission: 'not-admitted', cleanup: 'not-required', custody: 'none' } }
        if (outcome === 'admission-unknown') return { ok: false, code: 'CLAUDE_INITIALIZE_REFUSED',
          startOutcome: { requestSessionId: request.sessionId, admission: 'unknown', cleanup: 'pending', custody: 'cleanup-pending' } }
        return { ok: true, sessionId }
      } })
    const ordinaryClose = liveCase.close
    liveCase.close = async request => {
      if (request.sessionId !== ctx.NEW_SESSION) return ordinaryClose(request)
      ctx.calls.push({ call: 'close', sessionId: request.sessionId, request })
      if (outcome === 'unknown') throw new Error('fixture close outcome unknown')
      if (outcome === 'missing-id') return { closed: true }
      if (outcome === 'wrong-id') return { closed: true, sessionId: 'unrelated-close' }
      if (outcome === 'refused') return { ok: false, closed: true, sessionId: request.sessionId }
      return { closed: true, sessionId: request.sessionId }
    }
    await pickBusyDialog(ctx, { effort: 'high' }); completeBusy(ctx)
    await waitFor(() => reached, 'actual fallback start response held')
    if (action === 'Keep') await keepCurrentDuringAwait(ctx)
    if (action === 'Stop') {
      const chat = ctx.liveChat(); chat.openActions()
      chat.querySelectorAll('.chat-actions-row').find(row => /Stop this agent/.test(row.textContent)).dispatch('click')
      await waitFor(() => ctx.calls.some(row => row.call === 'close' && row.sessionId === ctx.OLD_SESSION), 'Stop predecessor')
      await settleTurns()
    }
    if (action === 'newer') {
      await replaceLiveSession(ctx, { sessionId: 'fixture-pre-open-newer', tier: TO_TIER, effort: 'low', note: 'Newer active choice' })
    }
    const before = ctx.readNode()
    release(); await settleTurns()
    for (const key of ['createdAt', 'sessionId', 'status', 'statusNote', 'tier', 'effort'])
      assert.equal(ctx.readNode()[key], before[key], 'late fallback preserves ' + key)
    assert.equal(startedRequests(ctx).length, 2, 'no new admission retry')
    assert.equal(ctx.calls.filter(row => row.call === 'send').length, 0, 'cancelled fallback never sends its opening task')
    const admitted = !['not-admitted', 'admission-unknown'].includes(outcome)
    assert.equal(ctx.calls.filter(row => row.call === 'close' && row.sessionId === ctx.NEW_SESSION).length, admitted ? 1 : 0)
    const chat = ctx.liveChat(); chat.openActions()
    const cleanup = chat.querySelectorAll('.chat-actions-row').find(row => /clean.*earlier session/i.test(row.textContent))
    if (outcome === 'confirmed' || outcome === 'not-admitted') assert.equal(cleanup, undefined, 'released custody has no stale cleanup obligation')
    else {
      assert.ok(cleanup, 'exact unresolved obligation remains actionable')
      const cleanupId = outcome === 'admission-unknown' ? fallbackRequestId : ctx.NEW_SESSION
      liveCase.close = async request => {
        ctx.calls.push({ call: 'close', sessionId: request.sessionId, request })
        return { closed: true, sessionId: request.sessionId }
      }
      const count = ctx.calls.filter(row => row.call === 'close' && row.sessionId === cleanupId).length
      cleanup.dispatch('click'); await settleTurns()
      assert.equal(ctx.calls.filter(row => row.call === 'close' && row.sessionId === cleanupId).length, count + 1)
      assert.equal(ctx.readNode().sessionId, before.sessionId)
    }
  })
}

for (const action of ['Keep', 'Stop', 'newer']) {
  test('accepted fallback opening send cannot publish obsolete success: ' + action, { skip: payloadSkip }, async t => {
    let starts = 0, sending = false, release
    const gate = new Promise(resolve => { release = resolve }); t.after(() => release())
    sharedBridge.startableTiers = async () => ({ ok: true, tiers: [FROM_TIER] })
    t.after(() => { delete sharedBridge.startableTiers })
    const ctx = await busyCircle(t, { initialThreadId: 'fixture-accepted-origin',
      replacementStart: async (request, sessionId) => ++starts === 1
        ? { ok: false, code: 'CLAUDE_INITIALIZE_REFUSED',
            startOutcome: { requestSessionId: request.sessionId, admission: 'not-admitted', cleanup: 'not-required', custody: 'none' } }
        : { ok: true, sessionId } })
    liveCase.sendAutomatic = async request => {
      ctx.calls.push({ call: 'send', channel: 'automatic', sessionId: request.sessionId, request })
      sending = true; await gate
      return { ok: true, result: { ok: true, turnId: 'fixture-accepted-opening' }, deliveryDisposition: 'accepted' }
    }
    await pickBusyDialog(ctx, { effort: 'high' }); completeBusy(ctx)
    await waitFor(() => sending, 'opening send held after own attachment')
    if (action === 'Keep') await keepCurrentDuringAwait(ctx)
    if (action === 'Stop') {
      liveCase.close = async request => {
        ctx.calls.push({ call: 'close', sessionId: request.sessionId, request })
        return { ok: false, sessionId: request.sessionId, closed: false }
      }
      const chat = ctx.liveChat(); chat.openActions()
      chat.querySelectorAll('.chat-actions-row').find(row => /Stop this agent/.test(row.textContent)).dispatch('click')
      await waitFor(() => ctx.calls.some(row => row.call === 'close' && row.sessionId === ctx.NEW_SESSION), 'unconfirmed Stop')
      await settleTurns()
    }
    if (action === 'newer') {
      await replaceLiveSession(ctx, { sessionId: 'fixture-accepted-newer', tier: TO_TIER, effort: 'low', note: 'Newer active work' })
    }
    const before = ctx.readNode()
    ctx.emit({ sessionId: before.sessionId, event: { type: 'tool_call', turnId: 'accepted-current-activity',
      toolCallId: 'accepted-current-call', tool: 'shell', payload: { command: 'fixture-accepted-current-activity' } } })
    await settleTurns()
    const activity = ctx.view.el.querySelector('[data-tree-activity]')?.textContent
    release(); await settleTurns()
    for (const key of ['createdAt', 'sessionId', 'status', 'statusNote', 'tier', 'effort'])
      assert.equal(ctx.readNode()[key], before[key], 'accepted old send preserves current ' + key)
    assert.equal(ctx.view.el.querySelector('[data-tree-activity]')?.textContent, activity, 'accepted old tail cannot erase current activity')
    assert.equal(startedRequests(ctx).length, 2)
    assert.equal(ctx.calls.filter(row => row.call === 'send').length, 1, 'accepted delivery never replays or drains a newer queue')
    if (action === 'newer') {
      const chat = ctx.liveChat(); chat.openActions()
      assert.ok(chat.querySelectorAll('.chat-actions-row').find(row => /clean.*earlier session/i.test(row.textContent)),
        'accepted old successor remains actionable independently of newer attachment')
      const { list } = await import('../../src/session-outbox.js')
      const oldQueue = list(ctx.NEW_SESSION).map(row => ({ id: row.id, text: row.text }))
      const currentNode = ctx.readNode()
      const currentActivity = ctx.view.el.querySelector('[data-tree-activity]')?.textContent
      ctx.emit({ sessionId: ctx.NEW_SESSION, event: { type: 'text_delta', turnId: 'detached-late-turn', text: 'obsolete detached answer' } })
      ctx.emit({ sessionId: ctx.NEW_SESSION, event: { type: 'tool_call', turnId: 'detached-late-turn',
        toolCallId: 'detached-late-tool', tool: 'shell', payload: { command: 'obsolete detached activity' } } })
      ctx.emit({ sessionId: ctx.NEW_SESSION, event: { type: 'turn_completed', status: 'completed', turnId: 'detached-late-turn' } })
      await settleTurns()
      for (const key of ['createdAt', 'sessionId', 'status', 'statusNote', 'tier', 'effort', 'reply'])
        assert.equal(ctx.readNode()[key], currentNode[key], 'later detached event preserves ' + key)
      assert.equal(ctx.view.el.querySelector('[data-tree-activity]')?.textContent, currentActivity)
      assert.deepEqual(list(ctx.NEW_SESSION).map(row => ({ id: row.id, text: row.text })), oldQueue)
      assert.equal(ctx.calls.filter(row => row.call === 'send').length, 1)

    } else assert.equal(ctx.readNode().sessionId, ctx.NEW_SESSION, 'accepted successor remains owned')
  })
}

test('queued owner message survives stale accepted fallback settlement without wrapper drain', { skip: payloadSkip }, async t => {
  const { list } = await import('../../src/session-outbox.js')
  const queuedText = 'Keep this exact queued message: first → second.'
  let starts = 0, sending = false, release
  const gate = new Promise(resolve => { release = resolve }); t.after(() => release())
  sharedBridge.startableTiers = async () => ({ ok: true, tiers: [FROM_TIER] })
  t.after(() => { delete sharedBridge.startableTiers })
  const ctx = await busyCircle(t, { initialThreadId: 'fixture-queued-accepted-origin',
    replacementStart: async (request, sessionId) => ++starts === 1
      ? { ok: false, code: 'CLAUDE_INITIALIZE_REFUSED',
          startOutcome: { requestSessionId: request.sessionId, admission: 'not-admitted', cleanup: 'not-required', custody: 'none' } }
      : { ok: true, sessionId } })
  liveCase.sendAutomatic = async request => {
    ctx.calls.push({ call: 'send', channel: 'automatic', sessionId: request.sessionId, request })
    sending = true; await gate
    return { ok: true, result: { ok: true, turnId: 'fixture-queued-accepted-turn' }, deliveryDisposition: 'accepted' }
  }
  await pickBusyDialog(ctx, { effort: 'high' }); completeBusy(ctx)
  await waitFor(() => sending, 'fallback opening send held')
  assert.equal(ctx.readNode().sessionId, ctx.NEW_SESSION)
  const chat = ctx.liveChat()
  chat.querySelector('.chat-input input').value = queuedText
  chat.querySelector('.chat-send').dispatch('click')
  await waitFor(() => list(ctx.NEW_SESSION).length === 1, 'actual composer submission queued behind held opening send')
  const queuedId = list(ctx.NEW_SESSION)[0].id
  assert.equal(list(ctx.NEW_SESSION)[0].text, queuedText)
  // The actual turn boundary arrives while the model application still awaits ACK.
  // That pending application holds the queue; after Keep the wrapper otherwise sees an idle session.
  ctx.emit({ sessionId: ctx.NEW_SESSION, event: { type: 'turn_completed',
    status: 'completed', turnId: 'fixture-queued-accepted-turn' } })
  await waitFor(() => ctx.readNode().status === 'finished', 'successor idle before opening acknowledgement')
  assert.equal(ctx.calls.filter(row => row.call === 'send').length, 1)
  await keepCurrentDuringAwait(ctx)
  const before = ctx.readNode()
  release(); await settleTurns()
  for (const key of ['createdAt', 'sessionId', 'status', 'statusNote', 'tier', 'effort'])
    assert.equal(ctx.readNode()[key], before[key], 'stale accepted tail preserves ' + key)
  assert.deepEqual(list(ctx.NEW_SESSION).map(row => ({ id: row.id, text: row.text })),
    [{ id: queuedId, text: queuedText }], 'exact submitted intent remains queued in place')
  assert.equal(startedRequests(ctx).length, 2)
  assert.equal(ctx.calls.filter(row => row.call === 'send').length, 1, 'stale wrapper must not drain the real waiting message')
  const row = ctx.liveChat().querySelectorAll('.chat-queue-row').find(row => row.querySelector('.chat-queue-text')?.textContent.startsWith(queuedText))
  assert.ok(row, 'retained owner message remains visible')
  const next = row.querySelector('.chat-queue-next')
  assert.ok(next && !next.disabled, 'retained owner message remains actionable')
  next.dispatch('click'); await settleTurns()
  assert.deepEqual(list(ctx.NEW_SESSION).map(row => ({ id: row.id, text: row.text })),
    [{ id: queuedId, text: queuedText }], 'Send next preserves exact waiting intent')
  assert.equal(ctx.calls.filter(row => row.call === 'send').length, 1, 'reordering the retained row does not replay the opening send')
})

for (const delivery of ['accepted', 'refused', 'unknown']) for (const incarnation of ['replacement', 'recreated'])
test('dead-send recovery stale ' + delivery + ' settles original intent without draining newer queue: ' + incarnation, { skip: payloadSkip }, async t => {
  const { list } = await import('../../src/session-outbox.js')
  let starts = 0, opening = false, release, refusedOriginal = false
  const gate = new Promise(resolve => { release = resolve }); t.after(() => release())
  const ctx = await runningCircle(t, { initialThreadId: 'fixture-dead-send-origin',
    replacementStart: async (request, sessionId) => ++starts === 1
      ? { ok: false, code: 'CLAUDE_INITIALIZE_REFUSED',
          startOutcome: { requestSessionId: request.sessionId, admission: 'not-admitted', cleanup: 'not-required', custody: 'none' } }
      : { ok: true, sessionId } })
  liveCase.send = async request => {
    ctx.calls.push({ call: 'send', sessionId: request.sessionId, request })
    if (!refusedOriginal && request.sessionId === ctx.OLD_SESSION) {
      refusedOriginal = true
      throw Object.assign(new Error('MC_AGENT_UNKNOWN_SESSION'), { code: 'MC_AGENT_UNKNOWN_SESSION', deliveryDisposition: 'not-sent' })
    }
    opening = true; await gate
    if (delivery !== 'accepted') throw Object.assign(new Error('controlled old-send outcome'), { code: delivery === 'refused' ? 'PROVIDER_SEND_REFUSED' : 'AGENT_SEND_FAILED' })
    return { ok: true, turnId: 'fixture-dead-opening-accepted', deliveryDisposition: 'accepted' }
  }
  const originalText = 'original submitted dead-session message'
  ctx.liveChat().querySelector('.chat-input input').value = originalText
  ctx.liveChat().querySelector('.chat-send').dispatch('click')
  await waitFor(() => opening, 'actual dead-send recovery fallback opening send held')
  assert.equal(ctx.readNode().sessionId, ctx.NEW_SESSION)
  const originalQueue = list(ctx.NEW_SESSION).map(row => ({ id: row.id, text: row.text }))
  assert.deepEqual(originalQueue, [], 'the original intent is checked out for its first provider send')
  const first = ctx.calls.filter(row => row.call === 'send' && row.sessionId === ctx.NEW_SESSION)
  assert.equal(first.length, 1)
  assert.equal(first[0].request.text, originalText, 'person intent, not an autonomous history turn, is first')
  assert.ok(startedRequests(ctx).at(-1).request.historyHandoff, 'history travels with that first intent')
  // Reattach the owned session through the mounted store's production API.
  const replace = status => replaceLiveSession(ctx, { sessionId: ctx.OLD_SESSION,
    status, note: 'Newer owner session', effort: 'low' })
  await replaceLiveSession(ctx, { sessionId: ctx.OLD_SESSION, status: 'running', note: 'Newer owner session', effort: 'low', recreate: incarnation === 'recreated' })
  const newerText = 'newer waiting owner message'
  ctx.liveChat().querySelector('.chat-input input').value = newerText
  ctx.liveChat().querySelector('.chat-send').dispatch('click')
  await waitFor(() => list(ctx.OLD_SESSION).length === 1, 'newer real composer message waits')
  const newerQueue = list(ctx.OLD_SESSION).map(row => ({ id: row.id, text: row.text }))
  await replace('finished')
  const before = ctx.readNode()
  const visibleStatus = ctx.view.el.querySelector('.org-status').textContent
  release(); await settleTurns()
  const settledOriginal = list(ctx.NEW_SESSION)
  if (delivery === 'accepted') assert.deepEqual(settledOriginal, [], 'known accepted original cannot become retryable')
  else {
    assert.equal(settledOriginal.length, 1)
    assert.equal(settledOriginal[0].text, originalText)
    assert.equal(settledOriginal[0].deliveryUnconfirmed, true, 'dispatched rejection retains unknown custody')
  }
  assert.equal(ctx.view.el.querySelector('.org-status').textContent, visibleStatus, 'old outcome cannot replace the current visible status')
  assert.deepEqual(list(ctx.OLD_SESSION).map(row => ({ id: row.id, text: row.text })), newerQueue)
  for (const key of ['createdAt', 'sessionId', 'status', 'statusNote', 'tier', 'effort'])
    assert.equal(ctx.readNode()[key], before[key], 'stale dead-send completion preserves ' + key)
  assert.equal(startedRequests(ctx).length, 2)
  assert.equal(ctx.calls.filter(row => row.call === 'send').length, 2, 'only original refusal and accepted opening attempt')
  assert.equal(ctx.calls.filter(row => row.call === 'send' && row.request.text === newerText).length, 0)
  const row = ctx.liveChat().querySelectorAll('.chat-queue-row').find(row => row.querySelector('.chat-queue-text')?.textContent.startsWith(newerText))
  assert.ok(row?.querySelector('.chat-queue-next'), 'newer queued message remains actionable')
  // Late detached completion cannot take the original held message either.
  ctx.emit({ sessionId: ctx.NEW_SESSION, event: { type: 'turn_completed', status: 'completed', turnId: 'fixture-dead-opening-accepted' } })
  await settleTurns()
  assert.deepEqual(list(ctx.NEW_SESSION), settledOriginal)
  assert.deepEqual(list(ctx.OLD_SESSION).map(row => ({ id: row.id, text: row.text })), newerQueue)
  assert.equal(ctx.calls.filter(row => row.call === 'send').length, 2)
})


for (const decision of ['apply', 'cancel']) {
  test('T731 pending provider ' + decision + ' preserves unsubmitted draft, ordered images and queued identities', { skip: payloadSkip }, async t => {
    const outbox = await import('../../src/session-outbox.js')
    const ctx = await busyCircle(t, { replacementStart: async (_, sessionId) => ({ ok: true, sessionId }) })
    const chat = ctx.liveChat()
    for (const text of ['Queued first.', 'Queued second.']) {
      chat.importDraft({ text, attachments: [] })
      chat.querySelector('.chat-send').dispatch('click')
    }
    await waitFor(() => outbox.list(ctx.OLD_SESSION).length === 2, 'two submitted queued messages')
    const queued = outbox.list(ctx.OLD_SESSION).map(row => ({ id: row.id, text: row.text }))
    const draft = { text: '  Unsubmitted exact draft.\\nKeep whitespace.  ',
      attachments: [{ path: 'fixture-first-image.png' }, { path: 'fixture-second-image.png' }] }
    ctx.liveChat().importDraft(draft)
    await chooseBusyModel(ctx)
    assert.equal(ctx.calls.filter(row => row.call === 'interrupt' || row.call === 'close' || row.call === 'start').length, 0)
    assert.equal(ctx.liveChat().exportDraft().text, draft.text)
    assert.deepEqual(ctx.liveChat().exportDraft().attachments, draft.attachments)
    if (decision === 'cancel') await keepCurrentDuringAwait(ctx)
    if (decision === 'apply') {
      completeBusy(ctx)
      await waitFor(() => ctx.readNode().sessionId === ctx.NEW_SESSION, 'confirmed successor')
      await waitFor(() => ctx.calls.filter(row => row.call === 'send').length === 1, 'one handoff')
    }
    await settleTurns()
    const sessionId = decision === 'apply' ? ctx.NEW_SESSION : ctx.OLD_SESSION
    assert.deepEqual(outbox.list(sessionId).map(row => ({ id: row.id, text: row.text })), queued)
    assert.equal(ctx.liveChat().exportDraft().text, draft.text)
    assert.deepEqual(ctx.liveChat().exportDraft().attachments, draft.attachments)
    assert.equal(ctx.calls.filter(row => row.call === 'interrupt').length, 0, 'the pending choice never implicitly Stops')
    if (decision === 'cancel') {
      assert.equal(startedRequests(ctx).length, 0)
      assert.equal(ctx.calls.filter(row => row.call === 'send' || row.call === 'close').length, 0)
      assert.equal(ctx.readNode().status, 'running')
    } else {
      assert.equal(ctx.readNode().tier, TO_TIER)
      assert.equal(startedRequests(ctx).length, 1)
      assert.equal(ctx.calls.filter(row => row.call === 'send').length, 1, 'draft and queued text are not replayed with the handoff')
    }
    assert.doesNotMatch(ctx.liveChat().querySelector('.chat-chip-model').textContent, /Pending:/)
  })
}

for (const outcome of ['accepted', 'refused']) {
  test('idle model choice publishes applied model only after provider acceptance: ' + outcome,
    { skip: payloadSkip }, async t => {
    let reached = false, release
    const gate = new Promise(resolve => { release = resolve })
    t.after(() => release())
    sharedBridge.startableTiers = async () => ({ ok: true, tiers: [FROM_TIER, 'claude-opus'] })
    t.after(() => { delete sharedBridge.startableTiers; delete globalThis.mcProviders })
    const ctx = await runningCircle(t, {
      initialThreadId: 'fixture-idle-applied-thread',
      replacementStart: async (request, sessionId) => {
        reached = true; await gate
        if (outcome === 'refused') return { ok: false, code: 'AGENT_RESUME_ACCOUNT_UNAVAILABLE',
          startOutcome: { requestSessionId: request.sessionId, admission: 'not-admitted', cleanup: 'not-required', custody: 'none' } }
        return { ok: true, sessionId, threadId: 'fixture-idle-applied-thread',
          account: 'primary', resumed: { turns: [], turnCount: 1 } }
      },
    }, { initialAccount: 'primary' })
    window.mcProviders = globalThis.mcProviders = { accounts: async () => ({ ok: true,
      accounts: [{ name: 'primary', provider: 'claude', signedIn: true }] }) }
    const before = ctx.readNode()
    const chat = ctx.liveChat(); chat.openActions()
    chat.querySelectorAll('.chat-actions-row').find(row => /Switch and continue/.test(row.textContent)).dispatch('click')
    await waitFor(() => document.body.querySelector('.switch-continue'), 'idle model chooser')
    const dialog = document.body.querySelector('.switch-continue')
    const target = dialog.querySelectorAll('[data-switch-model]').find(row => row.value === 'claude-opus')
    assert.ok(target); target.checked = true; target.dispatch('change')
    dialog.querySelector('[data-switch-continue]').dispatch('click')
    await waitFor(() => reached, 'provider admission held')
    assert.equal(startedRequests(ctx)[0].request.tier, 'claude-opus', 'requested model reaches the provider')
    assert.equal(ctx.readNode().sessionId, before.sessionId)
    assert.equal(ctx.readNode().tier, before.tier, 'a pending request is not an applied model')
    assert.equal(ctx.readNode().effort, before.effort, 'pending preference is not published as current')
    assert.match(ctx.liveChat().querySelector('.chat-chip-model').textContent, /Sonnet/)
    release(); await settleTurns()
    assert.equal(startedRequests(ctx).length, 1)
    assert.equal(ctx.calls.filter(row => row.call === 'send').length, 0, 'native resume does not replay the transcript')
    if (outcome === 'accepted') {
      assert.equal(ctx.readNode().sessionId, ctx.NEW_SESSION)
      assert.equal(ctx.readNode().tier, 'claude-opus')
      assert.match(ctx.liveChat().querySelector('.chat-chip-model').textContent, /Opus/)
    } else {
      assert.equal(ctx.readNode().sessionId, before.sessionId)
      assert.equal(ctx.readNode().tier, before.tier, 'a refused model never becomes the applied value')
      assert.match(ctx.liveChat().querySelector('.chat-chip-model').textContent, /Sonnet/)
    }
  })
}
