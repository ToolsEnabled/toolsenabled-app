// THE REPLY PAINTED ABOVE THE QUESTION IT ANSWERS, in the real rail chat.
//
// OWNER HAND TEST, LIVE 17b94e08, 2026-09-12, Local Observer
// node-16-8a2ff6c3-2ccf-4a17-9e9c-69b14106daae (evidence
// local-post-cut-success.json):
//
//     Observer (8a2ff6c3)   LOCAL_POST_CUT linux    02:05  1c3f7e96...
//     you                   Use host.exec ...       02:05  1c3f7e96...
//
// Same turn id, same minute, answer first. A reader cannot tell what was asked.
//
// WHY IT HAPPENS. On the tree rail driven below, src/views/computers.js opens
// the reply bubble on the FIRST delta, stamped with that turn
// (broadcastChatSpeech), and paints the person's line only when the shell
// announces person_turn (acceptRemotePersonTurn, broadcastOwnerMessage). A
// fast local turn can complete before that announcement arrives, so the bubble
// is already in the log and the owner line was appended under it. The comment
// on acceptRemotePersonTurn still claims appending "keeps the message above
// its answer"; that is the premise this file refutes. mountDesktopSessionChat
// has the same shape for browser sessions (streamWords and paintPerson).
//
// desktop-person-turn-display.test.mjs already covers the ordinary arrival
// order, person_turn first. This file drives the reversed order the owner hit,
// through the same real page mount and the same real packets.

import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
register('./helpers/css-stub-loader.mjs', import.meta.url)
const { installWorld, fleetFetch, seedTreeNode, mountView, settle } = await import('./lib/tree-command-real-mount.mjs')

const TURN = '1c3f7e96-15f7-40bf-92e4-44cdce4a67a8'
const EARLIER_TURN = 'ca518ea0-95e6-4768-80ff-283afe872c99'
const AT = Date.UTC(2026, 8, 12, 2, 5, 0)

const textOf = message => message.querySelector('.chat-msg-text')?.textContent ?? ''
const stampOf = message => message.querySelector('.turn-stamp')?.textContent ?? ''
const side = message => (message.classList.contains('me') ? 'me' : message.classList.contains('them') ? 'them' : 'other')
/* The rail seats its own context rows above the conversation. They are not part
   of the exchange being ordered, so only spoken rows are read here. */
const spoken = root => root.querySelectorAll('.msg').filter(message => !message.classList.contains('context'))
const rows = root => spoken(root).map(message => `${side(message)}:${textOf(message)}`)

let serial = 0
async function treeWorld(t) {
  const computerId = `late-person-turn-computer-${++serial}`
  const world = await installWorld(fleetFetch({ computerId }))
  globalThis.requestAnimationFrame = callback => setTimeout(() => callback(Date.now()), 0)
  globalThis.cancelAnimationFrame = timer => clearTimeout(timer)
  document.createTextNode = text => {
    const node = document.createElement('span')
    node.textContent = text
    Object.defineProperty(node, 'data', { get: () => node.textContent, set: value => { node.textContent = value } })
    return node
  }
  const nodeId = `late-person-turn-node-${serial}`
  const sessionId = `late-person-turn-session-${serial}`
  const packets = new Set()
  const priorOrg = Object.getOwnPropertyDescriptor(globalThis, 'mcOrg')
  world.storage.setItem('mc.write.agent-session', 'enabled')
  world.storage.setItem('mc.set.tree_style', 'boxes')
  window.mcSetup = { workspaceState: async () => ({ ok: true, available: true, chosen: true, roots: ['/fixture/setup'] }) }
  world.bridge.profiles = async () => ({ ok: true, profiles: [] })
  world.bridge.confinement = async () => ({ ok: true, tier: 'guided', sandbox: 'read-only', approvalPolicy: 'never', isolated: true, recorded: true })
  world.bridge.start = async () => ({ ok: true, sessionId, threadId: 'fixture-thread' })
  world.bridge.send = async () => ({ turnId: 'fixture-turn' })
  world.bridge.onEvent = listener => { packets.add(listener); return () => packets.delete(listener) }
  seedTreeNode(world.storage, { computerId, nodeId, sessionId: null, status: 'finished' })
  const org = { revision: 1, source: 'overlay', agents: [{ id: nodeId, role: 'builder', provider: 'codex', enabled: true }], edges: [] }
  globalThis.mcOrg = window.mcOrg = { read: async () => ({ ok: true, org, roles: [{ id: 'builder', name: 'Builder', revision: 1, capabilities: {} }] }) }
  const view = await mountView(world, { computerId })
  t.after(() => {
    view.destroy()
    if (priorOrg) Object.defineProperty(globalThis, 'mcOrg', priorOrg); else delete globalThis.mcOrg
    world.restore()
  })
  const started = await view.runTreeNodeCommand({ action: 'fresh-start-existing-node', computerId, nodeId })
  assert.equal(started.ok, true, JSON.stringify(started))
  view.el.querySelectorAll('.static-tree-node').find(node => node.dataset.agentId === nodeId).dispatch('keydown', { key: 'Enter', shiftKey: true })
  await settle(6)
  const chat = () => view.el.querySelector('[data-rail-chat-host] .chat')
  assert.ok(chat(), 'the rail chat is mounted')
  return {
    view, chat,
    emit: async event => { await Promise.all([...packets].map(listener => listener({ sessionId, event }))); await settle(3) },
  }
}

test('a completion that beats its own announcement still shows the request above the reply', async t => {
  const f = await treeWorld(t)
  /* The reversed arrival order from the hand test: the fast local turn streams
     and completes, and only then does the shell announce the person's words. */
  await f.emit({ type: 'assistant_text_delta', turnId: TURN, text: 'LOCAL_POST_CUT linux' })
  await f.emit({ type: 'turn_completed', turnId: TURN, status: 'completed' })
  await f.emit({ type: 'person_turn', via: 'remote', text: 'Use host.exec to print the platform', turnId: TURN, at: AT })
  await settle(10)

  assert.deepEqual(rows(f.chat()), [
    'me:Use host.exec to print the platform',
    'them:LOCAL_POST_CUT linux',
  ], 'the answer is still above the question it answers')

  const stamps = spoken(f.chat()).map(stampOf)
  assert.deepEqual(stamps, [TURN, TURN], 'both rows must keep the exact turn id the shell sent')
})

test('a later turn arriving after the hoist is still appended below it', async t => {
  const f = await treeWorld(t)
  await f.emit({ type: 'assistant_text_delta', turnId: TURN, text: 'LOCAL_POST_CUT linux' })
  await f.emit({ type: 'turn_completed', turnId: TURN, status: 'completed' })
  await f.emit({ type: 'person_turn', via: 'remote', text: 'Use host.exec to print the platform', turnId: TURN, at: AT })
  await settle(10)
  /* Placing a row above the tail must not send the NEXT turn anywhere but the
     bottom. Speaker grouping is pinned in chat-owner-line-precedes-its-reply:
     this surface opens a fresh stream per turn and names it either way, so it
     cannot observe that invariant. */
  await f.emit({ type: 'assistant_text_delta', turnId: 'follow-up-turn', text: 'and one more thing' })
  await f.emit({ type: 'turn_completed', turnId: 'follow-up-turn', status: 'completed' })
  await settle(10)

  assert.deepEqual(rows(f.chat()), [
    'me:Use host.exec to print the platform',
    'them:LOCAL_POST_CUT linux',
    'them:and one more thing',
  ])
  assert.deepEqual(spoken(f.chat()).map(stampOf), [TURN, TURN, 'follow-up-turn'],
    'a later turn must not take an earlier turn stamp')
})

test('hoisting one turn leaves an earlier finished turn where it was', async t => {
  const f = await treeWorld(t)
  await f.emit({ type: 'person_turn', via: 'remote', text: 'the earlier request', turnId: EARLIER_TURN, at: AT - 60_000 })
  await f.emit({ type: 'assistant_text_delta', turnId: EARLIER_TURN, text: 'the earlier answer' })
  await f.emit({ type: 'turn_completed', turnId: EARLIER_TURN, status: 'completed' })
  await f.emit({ type: 'assistant_text_delta', turnId: TURN, text: 'LOCAL_POST_CUT linux' })
  await f.emit({ type: 'turn_completed', turnId: TURN, status: 'completed' })
  await f.emit({ type: 'person_turn', via: 'remote', text: 'Use host.exec to print the platform', turnId: TURN, at: AT })
  await settle(10)

  assert.deepEqual(rows(f.chat()), [
    'me:the earlier request',
    'them:the earlier answer',
    'me:Use host.exec to print the platform',
    'them:LOCAL_POST_CUT linux',
  ], 'a turn that was already settled must not be reordered')
})

test('a repeated announcement of the same turn adds nothing and moves nothing', async t => {
  const f = await treeWorld(t)
  await f.emit({ type: 'assistant_text_delta', turnId: TURN, text: 'LOCAL_POST_CUT linux' })
  await f.emit({ type: 'turn_completed', turnId: TURN, status: 'completed' })
  await f.emit({ type: 'person_turn', via: 'remote', text: 'Use host.exec to print the platform', turnId: TURN, at: AT })
  await f.emit({ type: 'person_turn', via: 'remote', text: 'Use host.exec to print the platform', turnId: TURN, at: AT })
  await settle(10)

  assert.deepEqual(rows(f.chat()), [
    'me:Use host.exec to print the platform',
    'them:LOCAL_POST_CUT linux',
  ])
})

test('the request is seated above the tool calls of its own fast turn, not under them', async t => {
  const f = await treeWorld(t)
  /* Measured on this mount: a tool call for the fast turn paints a run at the
     tail before the reply bubble exists, and the run carries no turn stamp. */
  await f.emit({ type: 'tool_call', toolCallId: 'call-1', tool: 'Bash', payload: { command: 'uname -a' }, turnId: TURN })
  await f.emit({ type: 'assistant_text_delta', turnId: TURN, text: 'LOCAL_POST_CUT linux' })
  await f.emit({ type: 'turn_completed', turnId: TURN, status: 'completed' })
  await f.emit({ type: 'person_turn', via: 'remote', text: 'Use host.exec to print the platform', turnId: TURN, at: AT })
  await settle(10)

  const log = f.chat().querySelector('.chat-log')
  const kinds = [...log.children]
    .filter(node => !node.classList.contains('context'))
    .map(node => (node.classList.contains('chat-action') ? 'tool' : side(node)))
  assert.deepEqual(kinds, ['me', 'tool', 'them'],
    'the person asked before the agent ran anything, so the request cannot sit under the tool call')
})
