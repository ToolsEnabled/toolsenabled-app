/* c4 review, round 2 (1.0.48 candidate 4). Halt pressed on a New agent tab while
 * its message WAITED for another agent's message to be saved (B31's up-to-30 s
 * admission wait). The host now cancels that send (shell/agent-host.cjs
 * interrupt: `sendCancelled`), and the send answers MC_TRANSCRIPT_SEND_STOPPED.
 *
 * Seen in the real window with the host half alone: the tab said "the agent has
 * not finished stopping. Retry Halt before sending more work" (false: nothing
 * was running), kept the words as a sent "you" line, and left the box empty.
 * Nothing was sent, so the tab must say so, take the line back and give the
 * draft back -- through the real entry point (mountStandaloneAgent) and a real
 * click on the Halt chip.
 *
 *   node --test --import=./tools/test/lib/isolate-native-state-root.mjs tools/test/c4r-stop-waiting-send-keeps-draft.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { mountStandaloneAgent } from '../../src/tree-standalone-agent.js'
import { resetLiveSessionForTest } from '../../src/agent-session-registry.js'
import { TRANSCRIPT_SEND_REFUSALS } from '../../src/agent-availability-copy.js'
import { sendFailureIsUnconfirmed, sendRefusalSentence } from '../../src/fleet-tree-copy.js'

const settle = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
async function waitFor(predicate, label, tries = 200) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (predicate()) return
    await settle(1)
  }
  assert.fail(`timed out waiting for: ${label}`)
}

function environment(t, { firstSend = null } = {}) {
  const { document, restore } = installDomStandIn()
  globalThis.requestAnimationFrame = callback => setTimeout(() => callback(performance.now()), 0)
  globalThis.cancelAnimationFrame = handle => clearTimeout(handle)
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map([['mc.write.agent-session', 'enabled']])
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) }
  const calls = [], listeners = new Set(), mounts = []
  let waitingSend = null
  const owner = { version: 1, ownerId: 'c4r-fixture-owner', currentEpoch: 'c4r-fixture-epoch', kind: 'local' }
  const transcript = { async bind() { return { ok: true } }, async release() { return { ok: true, released: true } } }
  const bridge = {
    ownerContext: async () => owner,
    onOwnerContextChanged: () => () => {},
    availability: async () => ({ ok: true }),
    confinement: async () => ({ ok: true, tier: 'standard' }),
    onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    start: async value => { calls.push(['start', value]); return { sessionId: value.sessionId } },
    send: value => {
      calls.push(['send', value])
      const n = calls.filter(([kind]) => kind === 'send').length
      if (n === 1 && firstSend) return firstSend()
      if (n === 1) return Promise.resolve({ turnId: 'turn-1' })
      // The second message waits in the host for another agent's admission.
      return new Promise((resolve, reject) => { waitingSend = { resolve, reject } })
    },
    // The host cancelled the waiting send: nothing was running to interrupt.
    interrupt: async value => {
      calls.push(['interrupt', value])
      queueMicrotask(() => waitingSend?.reject(new Error('MC_TRANSCRIPT_SEND_STOPPED')))
      return { sessionId: value.sessionId, turnId: null, sendCancelled: true, goalPaused: false }
    },
    close: async value => { calls.push(['close', value]); return { closed: true } },
  }
  const mount = id => {
    const host = document.createElement('div'); document.body.appendChild(host)
    const adapter = mountStandaloneAgent(host, { id, name: id, live: true, bridge, transcript, start: { tier: 'claude-sonnet' } })
    mounts.push(adapter)
    return { host, adapter, chat: () => host.querySelector('[data-chat-panel]'), input: () => host.querySelector('.chat-input textarea') }
  }
  const emit = (sessionId, event) => { for (const listener of listeners) listener({ sessionId, event }) }
  t.after(async () => {
    for (const adapter of mounts) adapter.dispose()
    await settle()
    resetLiveSessionForTest()
    if (storage) Object.defineProperty(globalThis, 'localStorage', storage); else delete globalThis.localStorage
    restore()
  })
  return { calls, mount, emit }
}

async function send(panel, text) {
  panel.input().value = text
  panel.input().dispatch('input')
  panel.chat().querySelector('.chat-send').click()
  await settle()
}
const rows = (panel, who) => panel.chat().querySelectorAll('.msg').filter(row => row.classList.contains(who)).map(row => row.textContent)

test('c4r: the stopped-before-sent refusal is a not-sent refusal with its own sentence', () => {
  assert.equal(Object.hasOwn(TRANSCRIPT_SEND_REFUSALS, 'MC_TRANSCRIPT_SEND_STOPPED'), true)
  assert.equal(sendFailureIsUnconfirmed('MC_TRANSCRIPT_SEND_STOPPED'), false, 'nothing was dispatched')
  const sentence = sendRefusalSentence('MC_TRANSCRIPT_SEND_STOPPED')
  assert.equal(sentence.includes('was not sent'), true)
  assert.equal(sentence.includes('Your draft is kept'), true)
  assert.equal(/finished stopping/.test(sentence), false)
})

/* c4 second review, real window (h) low: the 30 s refusal said "still saving the previous
   message" when the message being saved was another agent's. One save at a time is held for
   every agent on this computer, so the sentence names no owner. */
test('c4r2: the refusal after the wait for another save does not call that save "the previous message"', () => {
  const sentence = sendRefusalSentence('MC_TRANSCRIPT_ADMISSION_PENDING')
  assert.equal(/previous message/.test(sentence), false, sentence)
  assert.equal(sentence.includes('another message'), true, sentence)
  assert.equal(sentence.includes('was not sent') && sentence.includes('Your draft is kept'), true)
})

test('c4r: Halt on a New agent tab whose message is waiting to be saved gives the draft back and says it was not sent', async t => {
  const env = environment(t)
  const panel = env.mount('agent-1')
  await send(panel, 'First turn.')
  const sessionId = env.calls.find(([kind]) => kind === 'send')[1].sessionId
  env.emit(sessionId, { type: 'turn_completed', turnId: 'turn-1', status: 'completed' })
  await settle()

  const words = 'Please reply with only the word PAPAYA.'
  await send(panel, words)
  assert.equal(env.calls.filter(([kind]) => kind === 'send').length, 2, 'the second message reached the host and waits there')
  const halt = panel.chat().querySelector('.chat-chip-halt')
  await waitFor(() => halt && halt.hidden === false && halt.disabled === false, 'Halt while the message waits')
  halt.dispatch('click')
  await waitFor(() => env.calls.some(([kind]) => kind === 'interrupt'), 'Halt reaches the host')
  await waitFor(() => panel.input().value === words, 'the draft to come back to the box')

  assert.equal(panel.input().value === words, true, 'the words are back in the box')
  assert.equal(rows(panel, 'you').some(text => text.includes('PAPAYA')), false, 'the stopped words are not shown as sent')
  const notes = rows(panel, 'note').join('\n')
  assert.equal(notes.includes('was not sent'), true, 'the tab says the message was not sent')
  assert.equal(/finished stopping/.test(notes), false, 'no "has not finished stopping" for a send that never started')
})

/* The same promise on a tab's FIRST message (the start path): a new agent's
   brief refused after the 30 s wait for another agent's save, or stopped while
   it waited, was never sent -- its sentence says "Your draft is kept". */
for (const code of ['MC_TRANSCRIPT_ADMISSION_PENDING', 'MC_TRANSCRIPT_SEND_STOPPED']) test(`c4r: a New agent tab's first message refused ${code} gives the draft back`, async t => {
  const env = environment(t, { firstSend: () => Promise.reject(new Error(code)) })
  const panel = env.mount('agent-first')
  const words = 'Reply with exactly the single word QUINCE.'
  await send(panel, words)
  await waitFor(() => panel.input().value === words, 'the draft to come back to the box')
  assert.equal(panel.input().value === words, true)
  assert.equal(rows(panel, 'you').some(text => text.includes('QUINCE')), false, 'the refused words are not shown as sent')
  assert.equal(rows(panel, 'note').join('\n').includes('was not sent'), true)
})
