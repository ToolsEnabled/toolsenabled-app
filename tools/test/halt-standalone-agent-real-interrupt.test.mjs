/* T303 (Controller, owner-confirmed, 2026-09-17): Halt/Send now do nothing.
 * Worker 82's ground-truth measurement narrowed it: the TREE chat works
 * (Halt stopped a turn in ~2s); the failure is the STANDALONE (+) chat,
 * which had NO stop control at all on the owner's stale build. This file
 * checks the CURRENT tip through the REAL entry point a person actually
 * opens -- src/tree-standalone-agent.js's `mountStandaloneAgent`, not
 * `mountAgentSessionSurface` called bare (which never receives the
 * `chatChips` config the standalone surface supplies, and so never renders
 * the chips row at all -- a gap in a first draft of this file, not in the
 * product, caught by using the same harness pattern
 * tools/test/tree-standalone-agent.test.mjs already presses buttons through).
 *
 * tools/test/agent-session-standalone-approvals.test.mjs already proves
 * `control.pause()` reaches `bridge.interrupt` -- but it calls
 * `panel.control.pause()` directly, never a real DOM click on a rendered
 * button. That is the T158-shaped gap: the programmatic door was tested, the
 * button was not.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { mountStandaloneAgent } from '../../src/tree-standalone-agent.js'
import { resetLiveSessionForTest } from '../../src/agent-session-registry.js'

const settle = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise(resolve => setTimeout(resolve, 0)) }

function environment(t) {
  const { document, restore } = installDomStandIn()
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map([['mc.write.agent-session', 'enabled']])
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) }
  const calls = [], listeners = new Set(), mounts = []
  const bridge = {
    availability: async () => ({ ok: true }),
    confinement: async () => ({ ok: true, tier: 'standard' }),
    onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    start: async value => { calls.push(['start', value]); return { sessionId: value.sessionId } },
    send: async value => { calls.push(['send', value]); return { turnId: `turn-${calls.filter(([kind]) => kind === 'send').length}` } },
    interrupt: async value => { calls.push(['interrupt', value]); return { ok: true } },
    close: async value => { calls.push(['close', value]); return { closed: true } },
  }
  const mount = (id, options = {}) => {
    const host = document.createElement('div'); document.body.appendChild(host)
    const adapter = mountStandaloneAgent(host, { id, name: id, live: true, bridge, ...options })
    mounts.push(adapter)
    return { host, adapter, chat: () => host.querySelector('[data-chat-panel]'), input: () => host.querySelector('.chat-input input') }
  }
  const emit = (sessionId, event) => { for (const listener of listeners) listener({ sessionId, event }) }
  t.after(async () => {
    for (const adapter of mounts) adapter.dispose()
    await settle()
    resetLiveSessionForTest()
    if (storage) Object.defineProperty(globalThis, 'localStorage', storage); else delete globalThis.localStorage
    restore()
  })
  return { document, bridge, calls, listeners, mount, emit }
}

async function send(panel, text) {
  panel.input().value = text
  panel.input().dispatch('input')
  panel.chat().querySelector('.chat-send').click()
  await settle()
}

async function waitFor(predicate, label, tries = 200) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (predicate()) return
    await settle(1)
  }
  assert.fail(`timed out waiting for: ${label}`)
}

const interruptCalls = env => env.calls.filter(([kind]) => kind === 'interrupt')
const sendCalls = env => env.calls.filter(([kind]) => kind === 'send')

test('a real click on the + chat\'s HALT chip reaches bridge.interrupt while its turn is busy', async t => {
  const env = environment(t)
  const panel = env.mount('agent-1', { start: { tier: 'claude-sonnet' } })
  await send(panel, 'A long-running turn.')
  assert.equal(sendCalls(env).length, 1, 'the turn reached the bridge')

  const chat = panel.chat()
  const halt = chat.querySelector('.chat-chip-halt')
  assert.ok(halt, 'the + chat renders a HALT chip')
  await waitFor(() => halt.hidden === false, 'the HALT chip to become visible while the + agent is busy')
  assert.equal(halt.disabled, false, 'the HALT chip is pressable while busy')

  halt.dispatch('click')
  await waitFor(() => interruptCalls(env).length === 1, 'pressing the + chat\'s HALT chip to reach bridge.interrupt')
  assert.equal(interruptCalls(env)[0][1]?.sessionId, sendCalls(env)[0][1]?.sessionId,
    'the interrupt names the session actually running')
})

test('a real click on the + chat\'s working-step Stop control reaches bridge.interrupt and ends the turn', async t => {
  const env = environment(t)
  const panel = env.mount('agent-1', { start: { tier: 'claude-sonnet' } })
  await send(panel, 'Another long-running turn.')
  const sessionId = sendCalls(env)[0][1]?.sessionId

  const stopButton = panel.chat().querySelector('.working-step button')
  assert.ok(stopButton, 'the + chat renders the working-step Stop control while busy')
  stopButton.dispatch('click')
  await waitFor(() => interruptCalls(env).length === 1, 'pressing the working-step Stop control to reach bridge.interrupt')
  assert.equal(interruptCalls(env)[0][1]?.sessionId, sessionId, 'the interrupt names the session actually running')

  env.emit(sessionId, { type: 'turn_completed', turnId: sendCalls(env)[0][1]?.turnId, status: 'interrupted' })
  await waitFor(() => panel.chat().querySelector('.working-step')?.hidden !== false,
    'the busy indicator to clear once the host acknowledges the interrupt, not stay busy forever')
})

test('"Send now" on the + chat steers into a busy turn: it interrupts first, then delivers the new words', async t => {
  const env = environment(t)
  const panel = env.mount('agent-1', { start: { tier: 'claude-sonnet' } })
  await send(panel, 'The first, long-running turn.')
  const sessionId = sendCalls(env)[0][1]?.sessionId

  panel.input().value = 'Steer into this turn now.'
  panel.input().dispatch('input')
  const sendNow = panel.chat().querySelector('.chat-chip-sendnow')
  assert.ok(sendNow, 'the + chat renders a "Send now" control')
  await waitFor(() => sendNow.disabled === false, 'the "Send now" control to become pressable once text is typed')

  sendNow.dispatch('click')
  await waitFor(() => interruptCalls(env).length === 1, '"Send now" to interrupt the running turn before steering into it')
  assert.equal(interruptCalls(env)[0][1]?.sessionId, sessionId, 'the interrupt names the session actually running')

  env.emit(sessionId, { type: 'turn_completed', turnId: sendCalls(env)[0][1]?.turnId, status: 'interrupted' })
  await waitFor(() => sendCalls(env).length === 2, '"Send now" to actually deliver the new turn once the interrupt settles')
  assert.equal(sendCalls(env)[1][1]?.text, 'Steer into this turn now.', 'the steered turn carries the words that were typed')
})
