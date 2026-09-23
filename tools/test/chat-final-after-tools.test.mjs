import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { fleetFetch, installWorld, seedTreeNode, settle } from './lib/tree-command-real-mount.mjs'

register('./css-loader.mjs', import.meta.url)

// Exercise the real tree conversation, using only in-memory desktop IPC,
// DOM and storage. This is renderer behavior, not a live provider/UI receipt.
for (const opened of ['before-speech', 'after-speech']) test(`rail opened ${opened} keeps the final reply after fifteen tools`, async t => {
  const computerId = 'final-tools-computer-' + opened, nodeId = 'final-tools-node-' + opened, sessionId = 'final-tools-session-' + opened
  const world = await installWorld(fleetFetch({ computerId }), { asyncFrames: true })
  let view, surface, host
  t.after(() => { surface?.dispose(); view?.destroy(); host?.remove(); delete window.mcTranscripts; world.restore() })
  world.storage.setItem('mc.write.agent-session', 'enabled')
  seedTreeNode(world.storage, { computerId, nodeId, sessionId, status: 'running' })
  const listeners = new Set()
  world.bridge.onEvent = listener => { listeners.add(listener); return () => listeners.delete(listener) }
  world.bridge.models = async () => ({ provider: 'codex', catalogSupported: true, models: [] })
  world.bridge.sessionActivity = async () => ({ ok: true, busy: true, closing: false, lastTurnStatus: null, turnsCompleted: 0 })
  const entries = []
  window.mcTranscripts = {
    list: async () => ({ ok: true, records: [{ computerId, nodeId }] }),
    read: async () => ({ ok: true, entries: [...entries], metadata: { computerId, nodeId }, before: null }),
    append: async () => ({ ok: true }), bind: async () => ({ ok: true }), onError: () => () => {},
  }
  const { computersView } = await import('../../src/views/computers.js')
  view = computersView({ initialComputer: computerId, navigate() {}, chatWorkspace: true })
  document.body.appendChild(view.el)
  await view.chatWorkspace.ready
  await settle()
  host = document.createElement('div')
  document.body.appendChild(host)
  surface = view.chatWorkspace.mount(host, { nodeId })
  await settle()
  const emit = async event => {
    for (const listener of listeners) await listener({ sessionId, event: { turnId: 'reported-turn', ...event } })
    await settle(4)
  }
  const openRail = async () => {
    surface.openDetails()
    await settle()
    const rail = view.el.querySelector('.rail-chat-host .chat')
    assert.ok(rail, 'the real Controls door mounts the rail chat')
    return rail
  }
  let rail = opened === 'before-speech' ? await openRail() : null
  const prose = 'I am checking the visible reply.'
  const final = 'The answer remains visible after the tools finish.'
  await emit({ type: 'assistant_text_delta', itemId: 'commentary', text: prose })
  await emit({ type: 'assistant_text', itemId: 'commentary', text: prose })
  for (let index = 0; index < 15; index++) {
    await emit({ type: 'tool_call', itemId: 'tool-' + index, toolCallId: 'tool-' + index, tool: 'commandExecution', payload: { command: 'inspect fixture' } })
    await emit({ type: 'tool_result', itemId: 'tool-' + index, toolCallId: 'tool-' + index, tool: 'commandExecution', payload: { status: 'completed', exitCode: 0, aggregatedOutput: 'fixture verified' } })
  }
  await emit({ type: 'assistant_text_delta', itemId: 'final', text: final })
  await emit({ type: 'assistant_text', itemId: 'final', text: final })
  entries.push({ id: 'agent:' + sessionId + ':reported-turn', who: 'agent', text: prose + '\n\n' + final, turnStamp: 'reported-turn', at: 1 })
  rail ||= await openRail()
  assert.match(rail.querySelector('.chat-log').textContent, /The answer remains visible after the tools finish/, 'the reply is visible before the completion too')
  await emit({ type: 'turn_completed', status: 'completed' })
  assert.match(rail.querySelector('.chat-log').textContent, /The answer remains visible after the tools finish/, 'opening the rail after speech must still show the final answer')
  const chat = surface.root
  const answers = [...chat.querySelectorAll('.them .chat-msg-text')].map(row => row.textContent)
  assert.equal(answers.length, 1)
  assert.match(answers[0], /I am checking the visible reply/)
  assert.match(answers[0], /The answer remains visible after the tools finish/)
  assert.equal(chat.querySelectorAll('[data-action-kind="call"]').length, 15)
  assert.equal(chat.querySelector('.them').hidden, false)
  assert.equal(chat.querySelector('.them').hasAttribute('aria-busy'), false)
  const railAnswers = () => [...rail.querySelectorAll('.them .chat-msg-text')].map(row => row.textContent)
  assert.equal(railAnswers().length, 1, 'shared broadcast and rail completion must settle the same bubble')

  const next = 'A separate final-only answer.'
  entries.push({ id: 'agent:' + sessionId + ':next-turn', who: 'agent', text: next, turnStamp: 'next-turn', at: 2 })
  await emit({ type: 'assistant_text', itemId: 'final', turnId: 'next-turn', text: next })
  await emit({ type: 'turn_completed', turnId: 'next-turn', status: 'completed' })
  assert.equal(railAnswers().length, 2, 'a later turn must not write into the closed first bubble')
  assert.equal(railAnswers()[1], next)
  assert.match(railAnswers()[0], /The answer remains visible after the tools finish/)
})
