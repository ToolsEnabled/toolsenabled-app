// The Computers page on a browser driving a computer over the relay, with a
// stubbed window.mcDesktopSessions: the listed conversations reach the tree and
// the other-conversations list, a node opens the live conversation, and a
// data-source fence closes it, drops late answers and keeps no draft.

import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
register('./helpers/css-stub-loader.mjs', import.meta.url)
const { installWorld, mountView, settle } = await import('./lib/tree-command-real-mount.mjs')
const { setBridgeTransport } = await import('../../src/mission-bridge.js')
const { DATA_SOURCE_EVENT, setExampleMode } = await import('../../src/data-source.js')

const WRITER = 'desk-writer-session'
const LOOSE = 'desk-loose-session'

function rows() {
  return [
    { sessionId: WRITER, agentId: 'writer', nodeId: 'n-1', name: 'Writer', provider: 'codex', tier: 'luna', busy: false, turnsCompleted: 1, lastTurnStatus: 'completed', transcript: true, openable: true, refusal: null },
    { sessionId: LOOSE, agentId: null, nodeId: null, name: 'Old helper', provider: 'codex', tier: 'luna', busy: false, turnsCompleted: 4, lastTurnStatus: 'completed', transcript: true, openable: false, refusal: 'MC_AGENT_REMOTE_SESSION_PREVIOUS_CONNECTION' },
  ]
}

async function relayWorld(t, { list }) {
  /* A website serves no fleet record, so the page draws the declared
     organisation and the listed conversations started under it. */
  const computerId = 'this-computer'
  const world = await installWorld({ fetch: async () => ({ ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) }) })
  globalThis.requestAnimationFrame = callback => setTimeout(() => callback(Date.now()), 0)
  globalThis.cancelAnimationFrame = timer => clearTimeout(timer)
  document.createTextNode = text => {
    const node = document.createElement('span')
    node.textContent = text
    Object.defineProperty(node, 'data', { get: () => node.textContent, set: value => { node.textContent = value } })
    return node
  }
  delete window.mcShell.getBridgeProof
  setBridgeTransport(async () => ({ ok: false, reason: 'The fleet record is not provided in this fixture.' }))
  world.storage.setItem('mc.set.tree_style', 'boxes')
  const listeners = new Set()
  world.bridge.onEvent = listener => { listeners.add(listener); return () => listeners.delete(listener) }
  world.bridge.profiles = async () => ({ ok: true, profiles: [] })
  const org = { revision: 1, source: 'overlay', agents: [{ id: 'writer', displayName: 'Writer', role: 'builder', provider: 'codex', enabled: true }], relationships: [] }
  const priorOrg = Object.getOwnPropertyDescriptor(globalThis, 'mcOrg')
  globalThis.mcOrg = window.mcOrg = { read: async () => ({ ok: true, org, roles: [{ id: 'builder', name: 'Builder', revision: 1, capabilities: {} }] }) }
  const calls = []
  window.mcDesktopSessions = Object.freeze({
    list: async () => { calls.push(['list']); return list() },
    transcript: async request => {
      calls.push(['transcript', request.sessionId])
      return { ok: true, sessionId: request.sessionId, bound: true, before: null, entries: [
        { id: `you:${request.sessionId}:t1`, who: 'you', text: 'Earlier question from the desk', at: 1, turnId: 't1', context: null, clipped: false },
        { id: `agent:${request.sessionId}:t1`, who: 'agent', text: 'Earlier answer on the desk', at: 2, turnId: 't1', context: null, clipped: false },
      ] }
    },
    send: async request => { calls.push(['send', request.text]); return { ok: true, sessionId: request.sessionId, turnId: 't2' } },
  })
  const realNow = Date.now
  let offset = 0
  Date.now = () => realNow() + offset
  const view = await mountView(world, { computerId })
  t.after(() => {
    view.destroy()
    Date.now = realNow
    delete window.mcDesktopSessions
    setBridgeTransport(null)
    if (priorOrg) Object.defineProperty(globalThis, 'mcOrg', priorOrg); else delete globalThis.mcOrg
    world.restore()
  })
  return {
    view, world, calls,
    later: ms => { offset += ms },
    openWriter: async () => {
      let node = null
      const deadline = performance.now() + 2000
      do {
        node = view.el.querySelectorAll('.static-tree-node').find(entry => entry.dataset.agentId === 'writer')
        if (node) break
        await settle(5)
      } while (performance.now() < deadline)
      assert.ok(node, 'the listed conversation is drawn as its declared agent: ' + JSON.stringify({
        nodes: view.el.querySelectorAll('.static-tree-node').map(entry => ({ ...entry.dataset })),
        status: view.el.querySelector('.org-status')?.textContent,
        empty: view.el.querySelector('.graph-empty')?.textContent,
        calls,
      }))
      node.dispatch('keydown', { key: 'Enter', shiftKey: true })
      await settle(20)
      return view.el.querySelector('.board-chat-box')
    },
  }
}

const texts = (root, side) => root.querySelectorAll('.msg').filter(message => message.classList.contains(side)).map(message => message.querySelector('.chat-msg-text')?.textContent ?? '')

test('listed conversations reach the tree and the other list, and a node opens the live conversation', async t => {
  const f = await relayWorld(t, { list: async () => ({ ok: true, mayWrite: true, truncated: false, sessions: rows() }) })
  await settle(40)
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'list').length, 1)
  const others = f.view.el.querySelector('[data-desktop-sessions]')
  assert.ok(others && !others.hidden, 'the other conversations are offered')
  assert.match(others.textContent, /Old helper/)
  assert.match(others.textContent, /Open it at the computer/)
  const box = await f.openWriter()
  assert.ok(box.querySelector('[data-desktop-chat]'), 'the rail mounts the desktop conversation')
  const rail = f.view.el.querySelector('[data-desktop-session-rail]')
  assert.ok(rail, 'a listed conversation opens the conversation rail')
  assert.equal(f.view.el.querySelector('.ctl-page [data-a="open"]'), null, 'no full-chat control for a fleet record')
  assert.match(f.view.el.querySelector('.ctl-page').textContent, /Conversation on your computer/)
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'transcript'), [['transcript', WRITER]])
  assert.deepEqual(texts(box, 'me'), ['Earlier question from the desk'])
  assert.deepEqual(texts(box, 'them'), ['Earlier answer on the desk'])
})

test('a fence closes the conversation, and a draft typed before it never comes back for the same session id', async t => {
  const f = await relayWorld(t, { list: async () => ({ ok: true, mayWrite: true, truncated: false, sessions: rows() }) })
  await settle(40)
  let box = await f.openWriter()
  box.querySelector('.chat-input input').value = 'DRAFT_UNDER_COMPUTER_A'
  window.dispatchEvent(new CustomEvent(DATA_SOURCE_EVENT, { detail: { why: 'machine-chosen' } }))
  await settle(20)
  assert.match(box.textContent, /connection to your computer changed/)
  assert.equal(box.querySelector('[data-desktop-chat]'), null)
  await settle(40)
  assert.equal(f.calls.filter(([kind]) => kind === 'list').length, 2, 'the fence allows one immediate list read')
  box = await f.openWriter()
  assert.ok(box.querySelector('[data-desktop-chat]'))
  assert.equal(box.querySelector('.chat-input input').value, '', 'no draft crosses the fence')
})

test('a gap in the event stream keeps the conversation and its draft, and reads the transcript again', async t => {
  const f = await relayWorld(t, { list: async () => ({ ok: true, mayWrite: true, truncated: false, sessions: rows() }) })
  await settle(40)
  const box = await f.openWriter()
  const chat = box.querySelector('[data-desktop-chat]')
  box.querySelector('.chat-input input').value = 'DRAFT_KEPT_ACROSS_GAP'
  const readsBefore = f.calls.filter(([kind]) => kind === 'transcript').length
  window.dispatchEvent(new CustomEvent(DATA_SOURCE_EVENT, { detail: { why: 'agent-events-gap' } }))
  await settle(40)
  assert.equal(box.querySelector('[data-desktop-chat]'), chat, 'the same conversation stays mounted')
  assert.equal(box.querySelector('.chat-input input').value, 'DRAFT_KEPT_ACROSS_GAP')
  assert.equal(f.calls.filter(([kind]) => kind === 'transcript').length, readsBefore + 1, 'one catch-up read')
  assert.equal(f.calls.filter(([kind]) => kind === 'list').length, 1, 'a gap is not a fence')
})

test('a list answer that arrives after the fence is dropped', async t => {
  let release = null
  let first = true
  const f = await relayWorld(t, { list: () => {
    if (!first) return new Promise(() => {})
    first = false
    return new Promise(resolve => { release = resolve })
  } })
  await settle(20)
  assert.ok(release, 'the list was asked for')
  window.dispatchEvent(new CustomEvent(DATA_SOURCE_EVENT, { detail: { why: 'signed-out' } }))
  await settle(10)
  release({ ok: true, mayWrite: true, truncated: false, sessions: rows() })
  await settle(30)
  const others = f.view.el.querySelector('[data-desktop-sessions]')
  assert.ok(!others || others.hidden, 'nothing from the old answer is offered')
  assert.equal(f.view.el.querySelectorAll('.static-tree-node').some(entry => entry.dataset.agentId === 'writer'), false)
})

/* T296. The host re-announces on a signed-in instance -- a token refresh, an
   account re-check -- and the verdict it resolves to is the one the page
   already had. Before the fence was split, that announcement closed the open
   conversation and cleared the draft in it, which is what the owner reported
   as the page occasionally refreshing itself. The two announcements that DO
   change something are covered above (machine-chosen) and below (a verdict
   that moves); this is the one that changes nothing and must cost nothing. */
test('an announcement that changes neither the verdict nor the driving computer keeps the conversation and its draft', async t => {
  const f = await relayWorld(t, { list: async () => ({ ok: true, mayWrite: true, truncated: false, sessions: rows() }) })
  await settle(40)
  const box = await f.openWriter()
  const chat = box.querySelector('[data-desktop-chat]')
  box.querySelector('.chat-input input').value = 'DRAFT_ACROSS_A_RE_ANNOUNCE'
  window.dispatchEvent(new CustomEvent(DATA_SOURCE_EVENT, { detail: { why: 'host' } }))
  await settle(40)
  /* Identity compared through a boolean on purpose. assert.equal on two DOM
     nodes builds a diff of both object graphs when they differ, which on this
     stand-in exhausts the heap and turns a one-line failure into a 100-second
     out-of-memory crash -- the failure stops being readable exactly when it
     matters. The assertion is the same; only the reporting is survivable. */
  assert.ok(box.querySelector('[data-desktop-chat]') === chat, 'the same conversation stays mounted')
  assert.equal(box.querySelector('.chat-input input').value, 'DRAFT_ACROSS_A_RE_ANNOUNCE', 'the draft survives a re-announce')
  assert.doesNotMatch(box.textContent, /connection to your computer changed/)
})

/* The other half of the same rule, so neither can be made green by giving up
   the other: a verdict that really moves still takes the conversation. */
test('an announcement that moves the verdict still closes the conversation', async t => {
  /* Registered BEFORE the world exists so it runs BEFORE the world is taken
     away: after hooks run in the order they were added, and asking
     data-source.js to write the preference once relayWorld has restored the
     fixture's storage refuses DATA_SOURCE_READ_UNAVAILABLE by name. */
  t.after(() => setExampleMode(false))
  const f = await relayWorld(t, { list: async () => ({ ok: true, mayWrite: true, truncated: false, sessions: rows() }) })
  await settle(40)
  const box = await f.openWriter()
  box.querySelector('.chat-input input').value = 'DRAFT_UNDER_THE_RELAY'
  /* Leaving for the example is a real change of world: the page resolves to
     'mock' on the re-ask, which is not the 'relay' it was mounted under. */
  setExampleMode(true)
  window.dispatchEvent(new CustomEvent(DATA_SOURCE_EVENT, { detail: { why: 'example-toggle' } }))
  await settle(40)
  assert.equal(box.querySelector('[data-desktop-chat]'), null, 'the conversation is closed by a real change')
})
