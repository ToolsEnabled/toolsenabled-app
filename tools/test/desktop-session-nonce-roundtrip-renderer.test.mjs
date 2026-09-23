// The same-session round trip the paired phone performs, from the browser's
// side, against a stub computer that keeps one transcript and one event
// channel the way the frozen interface describes: the computer starts sending
// a session's events when the browser reads or sends to it, announces each
// accepted person message as person_turn before the send answer returns, and
// saves a reply while it is still being written.

import assert from 'node:assert/strict'
import test from 'node:test'
import { installDomStandIn } from './lib/dom-stand-in.mjs'

const { document, restore } = installDomStandIn(globalThis)
globalThis.localStorage = { getItem: () => null, setItem: () => assert.fail('nothing is stored'), removeItem: () => {} }
test.after(() => restore())

const { buildChat } = await import('../../src/components.js')
const { mountDesktopSessionChat, readDesktopSessionList } = await import('../../src/desktop-sessions.js')

const SID = 'desktop-nonce-session'
const tick = (turns = 16) => (async () => { for (let i = 0; i < turns; i += 1) await new Promise(resolve => setTimeout(resolve, 0)) })()
const refusal = code => Object.assign(new Error(code), { code })

function stubComputer() {
  const saved = []
  const listeners = new Set()
  const received = []
  const state = { watched: false, mayWrite: true, connected: true, turn: 0 }
  const emit = event => { if (state.watched) for (const listener of [...listeners]) listener({ sessionId: SID, event }) }
  const entry = (who, text, turnId) => ({ id: `${who}:${SID}:${turnId}`, who, text, at: Date.now(), turnId, context: null, clipped: false })
  const person = (text, via) => {
    const turnId = `turn-${++state.turn}`
    saved.push(entry('you', text, turnId))
    emit({ type: 'person_turn', via, text, turnId, at: Date.now() })
    return turnId
  }
  const reply = async (turnId, text) => {
    const half = Math.ceil(text.length / 2)
    emit({ type: 'assistant_text_delta', turnId, text: text.slice(0, half) })
    const partial = entry('agent', text.slice(0, half), turnId)
    saved.push(partial)
    await tick(2)
    emit({ type: 'assistant_text_delta', turnId, text: text.slice(half) })
    partial.text = text
    emit({ type: 'turn_completed', turnId, status: 'completed' })
  }
  const bridge = Object.freeze({
    list: async () => {
      if (!state.connected) throw refusal('MC_AGENT_CONNECTION_CLOSED')
      return { ok: true, mayWrite: state.mayWrite, truncated: false, sessions: [{ sessionId: SID, agentId: 'writer', nodeId: 'n-writer', name: 'Writer', provider: 'codex', tier: 'luna', busy: false, turnsCompleted: 1, lastTurnStatus: 'completed', transcript: true, openable: true, refusal: null }] }
    },
    transcript: async ({ sessionId, limit = 30 }) => {
      if (!state.connected) throw refusal('MC_AGENT_CONNECTION_CLOSED')
      state.watched = true
      return { ok: true, sessionId, bound: true, entries: saved.slice(-limit).map(item => ({ ...item })), before: null }
    },
    send: async ({ sessionId, text, ...rest }) => {
      assert.deepEqual(Object.keys(rest), [], 'only the session and the words are sent')
      if (!state.connected) throw refusal('MC_AGENT_CONNECTION_CLOSED')
      if (!state.mayWrite) throw refusal('MC_AGENT_PRINCIPAL_READ_ONLY')
      received.push(text)
      state.watched = true
      const turnId = person(text, 'remote')
      return { ok: true, sessionId, turnId }
    },
  })
  return {
    bridge, received, state, saved,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    windowTypes: text => person(text, 'desktop'),
    reply,
  }
}

async function openOnPhone(computer) {
  const list = readDesktopSessionList(await computer.bridge.list())
  const row = list.rows.find(entry => entry.sessionId === SID)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const chat = mountDesktopSessionChat({
    host, row, mayWrite: list.mayWrite, bridge: computer.bridge, subscribe: computer.subscribe, buildChat,
    title: row.name, scheduleFrame: callback => setTimeout(callback, 0), cancelFrame: clearTimeout,
  })
  await chat.ready
  return { host, chat }
}

const said = (host, side) => host.querySelectorAll('.msg')
  .filter(message => message.classList.contains(side))
  .map(message => message.querySelector('.chat-msg-text')?.textContent ?? '')
const count = (values, text) => values.filter(value => value === text).length

test('prior message, phone send, streamed reply, desktop-typed message, and a reload all agree', async () => {
  const computer = stubComputer()
  const prior = computer.windowTypes('NONCE_0')
  await computer.reply(prior, 'NONCE_0_REPLY')

  const phone = await openOnPhone(computer)
  assert.deepEqual(said(phone.host, 'me'), ['NONCE_0'])
  assert.deepEqual(said(phone.host, 'them'), ['NONCE_0_REPLY'])

  phone.host.querySelector('.chat-input input').value = 'NONCE_A'
  phone.host.querySelector('.chat-send').dispatch('click', { detail: 1 })
  await tick()
  assert.deepEqual(computer.received, ['NONCE_A'], 'the computer receives exactly the words')
  const sentTurn = computer.saved.at(-1).turnId
  await computer.reply(sentTurn, 'NONCE_B')
  await tick()
  await phone.chat.reconciled
  assert.equal(count(said(phone.host, 'me'), 'NONCE_A'), 1)
  assert.equal(count(said(phone.host, 'them'), 'NONCE_B'), 1)

  computer.windowTypes('NONCE_C')
  await tick()
  assert.equal(count(said(phone.host, 'me'), 'NONCE_C'), 1)

  phone.chat.dispose()
  const reloaded = await openOnPhone(computer)
  assert.deepEqual(said(reloaded.host, 'me'), ['NONCE_0', 'NONCE_A', 'NONCE_C'])
  assert.deepEqual(said(reloaded.host, 'them'), ['NONCE_0_REPLY', 'NONCE_B'])
  assert.deepEqual(computer.saved.filter(item => item.who === 'you').map(item => item.text), ['NONCE_0', 'NONCE_A', 'NONCE_C'], 'both screens read one transcript')
  reloaded.chat.dispose()
})

test('with sending switched off at the computer, nothing reaches it and the words stay', async () => {
  const computer = stubComputer()
  const phone = await openOnPhone(computer)
  computer.state.mayWrite = false
  phone.host.querySelector('.chat-input input').value = 'NONCE_BLOCKED'
  phone.host.querySelector('.chat-send').dispatch('click', { detail: 1 })
  await tick()
  assert.deepEqual(computer.received, [])
  assert.equal(phone.host.querySelector('.chat-input input').value, 'NONCE_BLOCKED')
  assert.equal(count(said(phone.host, 'me'), 'NONCE_BLOCKED'), 0)
  phone.chat.dispose()
})

test('after the connection is revoked, reopening shows the refusal and no conversation', async () => {
  const computer = stubComputer()
  computer.windowTypes('NONCE_SECRET_BEFORE_REVOKE')
  computer.state.connected = false
  const row = { sessionId: SID, agentId: 'writer', nodeId: null, name: 'Writer', provider: null, tier: null, busy: null, turnsCompleted: 0, lastTurnStatus: null, transcript: true, openable: true, refusal: null }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const chat = mountDesktopSessionChat({ host, row, bridge: computer.bridge, subscribe: computer.subscribe, buildChat, title: 'Writer' })
  await chat.ready
  assert.equal(host.dataset.refusalCode, 'MC_AGENT_CONNECTION_CLOSED')
  assert.equal(host.textContent.includes('NONCE_SECRET_BEFORE_REVOKE'), false)
  assert.equal(host.querySelector('.chat-input input').disabled, true)
  chat.dispose()
})
