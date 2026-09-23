/* STANDALONE CHAT MUST OFFER THE SAME ACTIONABLE APPROVAL THE TREE CHAT DOES.
 *
 * THE DEFECT. mountAgentSessionSurface() already turns an approval_request into
 * an action row through createActionBuffer, but it never called buildChat's
 * showApproval/resolveApproval door and never answered through
 * bridge.answerApproval. Other tool modes and providers still raise the
 * canonical packet; ToolsEnabled-only DEV05 hid that because it never asked.
 * A waiting row without a pressable choice is not an approval.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { sessionActivityEvent } from '../../src/agent-session-events.js'
import { APPROVAL_PANEL, approvalDecisionWord } from '../../src/fleet-tree-copy.js'
import { sessionApprovalSummary } from '../../src/agent-session.js'

const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(resolve => setTimeout(resolve, 0)) }

const CANONICAL_OPTIONS = [
  { optionId: 'always-allow', name: 'always allow', kind: 'allow_always' },
  { optionId: 'allow-once', name: 'allow once', kind: 'allow_once' },
  { optionId: 'reject-once', name: 'reject once', kind: 'reject_once' },
]

function approvalPacket(sessionId, turnId = 'turn-1', approvalId = 'acp:permission:turn:1') {
  return {
    sessionId,
    event: {
      type: 'approval_request',
      turnId,
      approval: {
        approvalId,
        kind: 'tool_permission',
        availableDecisions: CANONICAL_OPTIONS,
        details: { toolCall: { title: 'host.list_processes' } },
      },
    },
  }
}

function environment(t) {
  const { document, restore } = installDomStandIn(globalThis)
  const store = new Map([['mc.write.agent-session', 'enabled']])
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  globalThis.localStorage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)) },
    removeItem: key => { store.delete(key) },
  }
  const listeners = new Set()
  const calls = []
  let answer
  const bridge = {
    availability: async () => ({ ok: true }),
    confinement: async () => ({ ok: true, tier: 'standard' }),
    onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    start: async value => { calls.push(['start', value]); return { sessionId: value.sessionId } },
    send: async value => { calls.push(['send', value]); return { turnId: `turn-${calls.filter(([kind]) => kind === 'send').length}` } },
    interrupt: async value => { calls.push(['interrupt', value]); return { ok: true } },
    close: async value => { calls.push(['close', value]); return { ok: true } },
    answerApproval: value => {
      calls.push(['answerApproval', value])
      return new Promise(resolve => { answer = resolve })
    },
  }
  t.after(() => {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
    else delete globalThis.localStorage
    restore()
  })
  return {
    document, bridge, calls, listeners,
    emit: packet => { for (const listener of listeners) listener(packet) },
    resolveAnswer: value => { const settleAnswer = answer; answer = null; settleAnswer?.(value) },
  }
}

async function mountLive(t, env) {
  let control = null
  const { mountAgentSessionSurface } = await import('../../src/agent-session.js')
  const root = env.document.createElement('div')
  env.document.body.appendChild(root)
  const dispose = mountAgentSessionSurface(root, {
    live: true,
    agentId: 'standalone-approval',
    bridge: env.bridge,
    chatComposer: true,
    chatTitle: 'Standalone',
    publishSession: false,
    onController: next => { control = next },
  })
  t.after(() => { try { dispose?.() } catch { /* already gone */ } })
  await settle(12)
  assert.ok(control, 'the maintained session mount must publish its controller')
  const started = await control.send('look around')
  assert.equal(started.ok, true, started.code || 'start')
  return { root, control, dispose, sessionId: started.sessionId, turnId: started.turnId }
}

function approvalButtons(root) {
  return [...(root.querySelectorAll('[data-chat-approval]') || [])]
}

test('sessionApprovalSummary names a tool permission from the canonical activity fields', () => {
  const activity = sessionActivityEvent(approvalPacket('session-a'), 'session-a')
  assert.equal(activity.kind, 'approval')
  assert.equal(activity.approvalId, 'acp:permission:turn:1')
  assert.match(sessionApprovalSummary(activity), /host\.list_processes/)
})

test('the maintained session mount offers a pressable approval from the canonical packet', async t => {
  const env = environment(t)
  const panel = await mountLive(t, env)
  env.emit(approvalPacket(panel.sessionId, panel.turnId))
  await settle()
  const buttons = approvalButtons(panel.root)
  assert.ok(buttons.length >= 2, 'the approval must be a pressable chat card, not only an action row')
  assert.deepEqual(buttons.map(button => button.getAttribute('data-chat-approval')),
    ['always-allow', 'allow-once', 'reject-once'])
  assert.deepEqual(buttons.map(button => button.textContent),
    CANONICAL_OPTIONS.map(option => approvalDecisionWord(option.optionId, { [option.optionId]: option.kind })))
  assert.equal(env.calls.filter(([kind]) => kind === 'answerApproval').length, 0,
    'showing the card must not invent an answer')
})

for (const refusal of [null, { ok: false, error: { message: 'Permission answer refused' } }]) test(`an unconfirmed answer stays retryable: ${refusal === null ? 'missing' : 'explicit refusal'}`, async t => {
  const env = environment(t)
  const panel = await mountLive(t, env)
  env.emit(approvalPacket(panel.sessionId, panel.turnId))
  await settle()
  approvalButtons(panel.root).find(button => button.getAttribute('data-chat-approval') === 'allow-once').dispatch('click')
  await settle()
  assert.equal(env.calls.at(-1)[0], 'answerApproval')
  assert.deepEqual(env.calls.at(-1)[1], {
    sessionId: panel.sessionId,
    approvalId: 'acp:permission:turn:1',
    decision: 'allow-once',
  })
  env.resolveAnswer(refusal)
  await settle(12)
  let buttons = approvalButtons(panel.root)
  assert.ok(buttons.length >= 2, 'an answer that did not land must remain pressable')
  assert.equal(buttons.every(button => button.disabled), false)
  buttons.find(button => button.getAttribute('data-chat-approval') === 'reject-once').dispatch('click')
  await settle()
  env.resolveAnswer({ ok: true })
  await settle(12)
  buttons = approvalButtons(panel.root)
  assert.equal(buttons.length, 0, 'a confirmed answer must remove the clickable card')
  assert.ok(String(panel.root.textContent).includes(APPROVAL_PANEL.refused))
})

test('a late answer refines its original transcript row without replacing the next turn approval', async t => {
  const env = environment(t)
  const panel = await mountLive(t, env)
  env.emit(approvalPacket(panel.sessionId, panel.turnId, 'reused-permission'))
  await settle()
  approvalButtons(panel.root).find(button => button.getAttribute('data-chat-approval') === 'reject-once').dispatch('click')
  await settle()
  env.emit({ sessionId: panel.sessionId, event: { type: 'turn_completed', turnId: panel.turnId, status: 'cancelled' } })
  await settle()
  assert.equal(panel.control.snapshot().transcript.filter(row => row.who === 'action')[0].stateKey, 'closed', 'an ended turn must not retain waiting history')
  const next = await panel.control.send('next request')
  env.emit(approvalPacket(panel.sessionId, next.turnId, 'reused-permission'))
  await settle()
  env.resolveAnswer({ ok: true })
  await settle()
  const actions = panel.control.snapshot().transcript.filter(row => row.who === 'action')
  assert.equal(actions.length, 2)
  assert.notEqual(actions[0].id, actions[1].id)
  assert.deepEqual(actions.map(row => row.stateKey), ['refused', 'waiting'])
  assert.ok(approvalButtons(panel.root).length >= 2)
  assert.equal(approvalButtons(panel.root).some(button => button.disabled), false)
})

test('completion before the answer ack must not leave a clickable stale permission', async t => {
  const env = environment(t)
  const panel = await mountLive(t, env)
  env.emit(approvalPacket(panel.sessionId, panel.turnId))
  await settle()
  approvalButtons(panel.root).find(button => button.getAttribute('data-chat-approval') === 'allow-once').dispatch('click')
  await settle()
  env.emit({ sessionId: panel.sessionId, event: { type: 'turn_completed', turnId: panel.turnId, status: 'completed' } })
  await settle()
  assert.equal(approvalButtons(panel.root).length, 0, 'completion must take the clickable card down before the engine acks')
  env.resolveAnswer({ ok: true })
  await settle(12)
  assert.equal(approvalButtons(panel.root).length, 0, 'a late confirmed ack must not restore the card')
})

test('Stop and a subsequent turn must not retain the previous permission', async t => {
  const env = environment(t)
  const panel = await mountLive(t, env)
  env.emit(approvalPacket(panel.sessionId, panel.turnId))
  await settle()
  assert.ok(approvalButtons(panel.root).length >= 2)
  const stopped = await panel.control.pause()
  assert.equal(stopped.ok, true, stopped.code || 'pause')
  await settle()
  assert.equal(approvalButtons(panel.root).length, 0, 'Stop must not leave a clickable stale permission')
  assert.ok(env.calls.some(([kind]) => kind === 'interrupt'))
  const next = await panel.control.send('next turn')
  assert.equal(next.ok, true, next.code || 'next')
  await settle()
  assert.equal(approvalButtons(panel.root).length, 0, 'the next turn must not inherit the previous card')
  env.emit(approvalPacket(panel.sessionId, next.turnId, 'acp:permission:turn:2'))
  await settle()
  const buttons = approvalButtons(panel.root)
  assert.deepEqual(buttons.map(button => button.getAttribute('data-chat-approval')),
    ['always-allow', 'allow-once', 'reject-once'])
})

test('dispose and chat replacement must not keep a pressable permission', async t => {
  const env = environment(t)
  const panel = await mountLive(t, env)
  env.emit(approvalPacket(panel.sessionId, panel.turnId))
  await settle()
  assert.ok(approvalButtons(panel.root).length >= 2)
  panel.dispose()
  await settle()
  assert.equal(approvalButtons(panel.root).length, 0, 'disposing the session must drop the clickable card')
})
