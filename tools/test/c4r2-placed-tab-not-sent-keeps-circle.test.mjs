/* c4 second review (1.0.48 candidate 4): correctness P1 (read from code, proven
 * here) and real window (f) low.
 *
 * A New agent tab added to a tree keeps its tab; the tree follows it through
 * the tab's session events (src/views/computers.js placeStandaloneAgent ->
 * bindSession -> onSessionChange). 'send' sets the circle running; a later
 * 'state' with the phase back to open is read as the turn's end and the circle
 * becomes nodeStatusForTurn(lastTurnStatus). A message that was NOT sent --
 * Halt while it waited for another agent's save, or refused after that 30 s
 * wait -- ran no turn, but the tab published lastTurnStatus null (Halt) or
 * 'failed' (the refusal), so the circle read "turn-failed" for a message that
 * never left. On the tab itself, the person's own Halt left the header in red:
 * "refused - This message was stopped...".
 *
 * The real tab (mountStandaloneAgent) with a real Halt click, placed through its
 * own placement API, and the REAL placed-tab handler from computers.js run over
 * a stand-in tree store.
 *
 *   node --test --import=./tools/test/lib/isolate-native-state-root.mjs tools/test/c4r2-placed-tab-not-sent-keeps-circle.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { mountStandaloneAgent } from '../../src/tree-standalone-agent.js'
import { resetLiveSessionForTest } from '../../src/agent-session-registry.js'
import { nodeStatusForTurn, sessionTurnCancelled } from '../../src/agent-session-events.js'

const COMPUTERS = readFileSync(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const settle = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
async function waitFor(predicate, label, tries = 200) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (predicate()) return
    await settle(1)
  }
  assert.fail(`timed out waiting for: ${label}`)
}

/* computers.js's own placed-tab handler: the onSessionChange method bindSession returns. */
function placedHandler(node, stripped = []) {
  const head = '            onSessionChange(snapshot, event = {}) {'
  const begin = COMPUTERS.indexOf(head)
  const tail = '              repaint()\n            }'
  const end = COMPUTERS.indexOf(tail, begin)
  assert.ok(begin >= 0 && end > begin, 'the placed-tab handler moved')
  const method = COMPUTERS.slice(begin, end + tail.length)
  const store = {
    getNode: id => (id === node.id ? node : null),
    setNodeStatus: (id, status) => { if (id === node.id) node.status = status },
    markPromptedByPerson() {}, setNodeReply() {},
  }
  const holder = {}
  const scope = {
    node, store, currentSession: null,
    standaloneSettledTurns: new Map(), sessionTurnText: new Map(), sessionOpenTurns: new Map(), nodeReplies: new Map(), sessionNodeIds: new Map(),
    // bind() assigns the handler's closure variable `currentSession`, as in computers.js.
    bind: snapshot => holder.handler.setSession(snapshot.sessionId),
    transcriptAppend() {}, persistTranscript() {}, transcripts: null, transcriptStore: null,
    stripPhantomYouLine: (target, sessionId, text) => stripped.push({ nodeId: target.id, sessionId, text }),
    recordTurnActions() {}, deliverTurnReply() {}, repaint() {},
    nodeStatusForTurn, sessionTurnCancelled, TURN_CANCELLED: { note: 'Cancelled.' },
  }
  const names = Object.keys(scope)
  const make = new Function(...names, `return { ${method}, setSession(value) { currentSession = value } }`)
  holder.handler = make(...names.map(name => scope[name]))
  return holder.handler
}

function environment(t, { second }) {
  const { document, restore } = installDomStandIn()
  globalThis.requestAnimationFrame = callback => setTimeout(() => callback(performance.now()), 0)
  globalThis.cancelAnimationFrame = handle => clearTimeout(handle)
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map([['mc.write.agent-session', 'enabled']])
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) }
  const calls = [], listeners = new Set(), mounts = []
  let waitingSend = null
  const owner = { version: 1, ownerId: 'c4r2-fixture-owner', currentEpoch: 'c4r2-fixture-epoch', kind: 'local' }
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
      if (n === 1) return Promise.resolve({ turnId: 'turn-1' })
      if (second === 'wait') return new Promise((resolve, reject) => { waitingSend = { resolve, reject } })
      return Promise.reject(Object.assign(new Error(second), { code: second }))
    },
    interrupt: async value => {
      calls.push(['interrupt', value])
      queueMicrotask(() => waitingSend?.reject(new Error('MC_TRANSCRIPT_SEND_STOPPED')))
      return { sessionId: value.sessionId, turnId: null, sendCancelled: true, goalPaused: false }
    },
    close: async value => { calls.push(['close', value]); return { closed: true } },
  }
  const host = document.createElement('div'); document.body.appendChild(host)
  const adapter = mountStandaloneAgent(host, { id: 'agent-placed', name: 'agent-placed', live: true, bridge, transcript, start: { tier: 'claude-sonnet' } })
  mounts.push(adapter)
  const emit = (sessionId, event) => { for (const listener of listeners) listener({ sessionId, event }) }
  t.after(async () => {
    for (const mounted of mounts) mounted.dispose()
    await settle()
    resetLiveSessionForTest()
    if (storage) Object.defineProperty(globalThis, 'localStorage', storage); else delete globalThis.localStorage
    restore()
  })
  const panel = { chat: () => host.querySelector('[data-chat-panel]'), input: () => host.querySelector('.chat-input textarea'), host }
  return { calls, emit, adapter, panel }
}

async function send(panel, text) {
  panel.input().value = text
  panel.input().dispatch('input')
  panel.chat().querySelector('.chat-send').click()
  await settle()
}

async function placedAfterOneTurn(t, second) {
  const env = environment(t, { second })
  await send(env.panel, 'First turn.')
  const sessionId = env.calls.find(([kind]) => kind === 'send')[1].sessionId
  env.emit(sessionId, { type: 'turn_completed', turnId: 'turn-1', status: 'completed' })
  await settle()
  const node = { id: 'node-placed', status: 'finished', sessionId }
  const stripped = []
  const handler = placedHandler(node, stripped)
  handler.setSession(sessionId)
  assert.equal(env.adapter.beginPlacement().ok, true)
  assert.ok(env.adapter.commitPlacement({ nodeId: node.id, getStartOptions: () => ({ surface: 'fleet-tree' }), onSessionChange: (snapshot, event) => handler.onSessionChange(snapshot, event) }))
  await settle()
  node.status = 'finished'
  return { ...env, node, sessionId, stripped }
}

test('c4r2: Halt on a placed tab\'s waiting message puts its circle back as it was, and the tab does not call it refused', async t => {
  const env = await placedAfterOneTurn(t, 'wait')
  const words = 'Reply with exactly the single word PLUM.'
  await send(env.panel, words)
  assert.equal(env.node.status, 'running', 'the tree reads the send as a running turn')
  const halt = env.panel.chat().querySelector('.chat-chip-halt')
  await waitFor(() => halt && halt.hidden === false && halt.disabled === false, 'Halt while the message waits')
  halt.dispatch('click')
  await waitFor(() => env.calls.some(([kind]) => kind === 'interrupt'), 'Halt reaches the host')
  await waitFor(() => env.panel.input().value === words, 'the draft to come back')
  await settle()
  assert.equal(env.node.status, 'finished', `the circle reads "${env.node.status}" for a message that was never sent`)
  const header = env.panel.host.querySelector('[data-session-status]')?.textContent || ''
  assert.equal(/refused/.test(header), false, `the person's own Halt reads as a refusal: "${header}"`)
  // Correctness gap G4: the tree takes back the "you" line its 'send' wrote (computers.js 'send-not-sent').
  assert.deepEqual(env.stripped, [{ nodeId: env.node.id, sessionId: env.sessionId, text: words }])
})

test('c4r2: a placed tab\'s message refused after the wait for another save puts its circle back as it was', async t => {
  const env = await placedAfterOneTurn(t, 'MC_TRANSCRIPT_ADMISSION_PENDING')
  const words = 'Reply with exactly the single word FIG.'
  await send(env.panel, words)
  await waitFor(() => env.panel.input().value === words, 'the draft to come back')
  await settle()
  assert.equal(env.node.status, 'finished', `the circle reads "${env.node.status}" for a message that was never sent`)
  assert.deepEqual(env.stripped, [{ nodeId: env.node.id, sessionId: env.sessionId, text: words }])
})
