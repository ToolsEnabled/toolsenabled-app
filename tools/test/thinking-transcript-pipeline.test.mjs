import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createNodeTranscriptStore } from '../../shell/node-transcript-store.cjs'
import { createNodeTranscriptCapture } from '../../shell/node-transcript-capture.cjs'
import { createNodeTranscriptClient } from '../../src/node-transcript-client.js'
import { parseTranscriptRow, TRANSCRIPT_LIMITS } from '../../src/session-transcript-store.js'
import { createActionBuffer, sessionActivityEvent } from '../../src/agent-session-events.js'
import { sessionActionChatRow } from '../../src/agent-session.js'
import { actionRowWords } from '../../src/fleet-tree-copy.js'
import { declaredFunctionSource } from './lib/declared-function-source.mjs'
import { installDomStandIn } from './lib/dom-stand-in.mjs'
import { THINKING_UNAVAILABLE_NOTICE } from '../../shell/thinking-transcript.mjs'
import { THINKING_TEXT_LIMIT, thinkingTranscriptId } from '../../shell/thinking-transcript.mjs'

const source = await fs.readFile(new URL('../../src/views/computers.js', import.meta.url), 'utf8')
const declaration = name => declaredFunctionSource(source.replace(/^export function /gm, 'function '), name)
const timing = new Function(declaration('actionTimingFields') + '; return actionTimingFields')()
const project = new Function('actionRowWords', 'actionTimingFields', declaration('actionChatRow') + '; return actionChatRow')(actionRowWords, timing)
const restoreRow = new Function('actionRowWords', 'actionTimingFields', 'THINKING_UNAVAILABLE_NOTICE', declaration('savedActionRow') + '; return savedActionRow')(actionRowWords, timing, THINKING_UNAVAILABLE_NOTICE)
const { document, restore } = installDomStandIn(globalThis)
globalThis.requestAnimationFrame = callback => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = clearTimeout
const { buildChat } = await import('../../src/components.js')
after(restore)
const flush = () => new Promise(resolve => setTimeout(resolve, 35))
const thinking = (text, status = 'inProgress', itemId = 'summary') => sessionActivityEvent({ sessionId: 'session', event: {
  type: 'thinking', turnId: 'turn', itemId, text, status,
} }, 'session')

test('provider summary snapshots update one stable activity and preserve text beyond the tool-output cap', () => {
  const buffer = createActionBuffer()
  assert.equal(buffer.add(thinking(''), { turnId: 'turn', at: 1 }).row, null)
  const first = buffer.add(thinking('A complete sentence. Pending'), { turnId: 'turn', at: 2 }).row
  assert.ok(first, 'a supplied streaming summary was dropped')
  const text = 'A complete sentence. '.repeat(250) + 'Final fragment'
  const final = buffer.add(thinking(text, 'completed'), { turnId: 'turn', at: 3 }).row
  assert.equal(final === first, true)
  assert.equal(buffer.list().length, 1)
  assert.equal(final.output, text)
  assert.equal(final.at, 2)
  assert.equal(final.state, 'done')
  assert.deepEqual(buffer.metrics('turn'), {})
  const other = buffer.add(thinking('Separate turn', 'completed'), { turnId: 'other', at: 3 }).row
  assert.notEqual(other.id, first.id)
})

test('actual persistence and restore retain supplied summary body and identify unavailable older excerpts', () => {
  const writes = []
  const persist = new Function('actionChatRow', 'actionTimingFields', 'transcriptAppend', declaration('persistActionRow') + '; return persistActionRow')(
    project, timing, (session, entry) => writes.push(entry))
  const row = { id: 'stable', kind: 'thinking', output: 'A supplied summary. '.repeat(300), state: 'done', at: 2 }
  persist('session', row)
  const restored = restoreRow(writes[0], 0)
  assert.equal(writes[0].state, 'done', 'the current Computers writer must keep the supplied completion state')
  assert.equal(restored.state, 'finished')
  assert.equal(restored.body, row.output, 'the durable thinking body was discarded')
  assert.equal(restored.detail, '')
  const old = restoreRow({ who: 'action', kind: 'thinking', text: 'Thinking', tool: 'Thinking', state: 'done', at: 1 }, 0)
  assert.match(old.detail, /summary unavailable/i)
  assert.equal(old.body, '')
  assert.equal(old.state, '')
})

test('restored actions with absent or unrecognized state do not invent a finished result', async t => {
  const chat = buildChat({ title: 'Restored result uncertainty', seed: 0 })
  document.documentElement.appendChild(chat)
  t.after(() => { chat.dispose(); chat.remove() })
  let index = 0
  for (const kind of ['thinking', 'call']) {
    for (const state of [undefined, null, '', 'future-terminal', 'constructor', '__proto__']) {
      const entry = { who: 'action', id: `restored-${index++}`, kind,
        tool: kind === 'thinking' ? 'Thinking' : 'Read', text: 'Recorded step', body: 'Retained supplied fragment',
        ...(state === undefined ? {} : { state }) }
      const row = restoreRow(entry, index)
      assert.equal(row.state, 'no result came back', `${kind} ${String(state)} invented completion`)
      assert.notEqual(row.stateKey, 'done')
      assert.equal(row.body, kind === 'thinking' ? entry.body : '')
      chat.addAction(row)
    }
  }
  await flush()
  const states = [...chat.querySelectorAll('.chat-action-state')].map(node => node.textContent)
  assert.equal(states.length, index)
  assert.ok(states.every(state => state === 'no result came back'))
  assert.equal(restoreRow({ who: 'action', tool: 'Read', state: 'done' }, index).state, 'finished')
})

test('thinking stays inside one tool group, streams fragments as they arrive, and is not counted as a tool', async t => {
  const chat = buildChat({ title: 'Synthetic transcript', seed: 0 })
  document.documentElement.appendChild(chat)
  t.after(() => { chat.dispose(); chat.remove() })
  const add = row => chat.addAction(row)
  add({ id: 'tool-one', kind: 'call', tool: 'Read', stateKey: 'done', state: 'finished', body: 'Read result' })
  add({ id: 'summary', kind: 'thinking', tool: 'Thinking', stateKey: 'working', state: 'thinking', body: 'A complete sentence. Unfinished' })
  add({ id: 'tool-two', kind: 'call', tool: 'Command', stateKey: 'done', state: 'finished', body: 'Command result' })
  await flush()
  assert.equal(chat.querySelectorAll('.chat-action-run').length, 1, 'thinking split the tool group')
  const run = chat.querySelector('.chat-action-run')
  assert.match(run.querySelector('.chat-action-detail').textContent, /2 tool calls/)
  const summary = chat.querySelector('[data-action-kind="thinking"]')
  assert.ok(summary)
  assert.equal(summary.open, true, 'supplied thinking must be readable while it streams')
  assert.match(summary.querySelector('.chat-action-body').textContent, /A complete sentence/)
  // Live display streams the supplied fragment. Recording completion is a
  // separate contract, exercised below without treating this display as proof.
  assert.equal(summary.querySelector('.chat-action-body').textContent, 'A complete sentence. Unfinished')
  add({ id: 'summary', kind: 'thinking', tool: 'Thinking', stateKey: 'done', state: 'finished', body: 'A complete sentence. Unfinished final fragment' })
  await flush()
  assert.equal(chat.querySelectorAll('[data-action-kind="thinking"]').length, 1)
  assert.match(summary.querySelector('.chat-action-body').textContent, /Unfinished final fragment/)
  assert.equal(run.open, false)
  add({ id: 'tool-one', kind: 'call', tool: 'Read', stateKey: 'undone', state: 'did not finish', body: 'Failure result' })
  add({ id: 'tool-two', kind: 'call', tool: 'Command', stateKey: 'refused', state: 'refused', body: 'Refused result' })
  await flush()
  assert.match(run.querySelector('.chat-action-detail').textContent, /2 tool calls.*1 did not finish.*1 refused/)
  add({ id: 'approval', kind: 'approval', tool: 'Approval', stateKey: 'waiting', state: 'needs permission', body: 'Allow read?' })
  add({ id: 'outcome', kind: 'turn', tool: 'Turn', stateKey: 'undone', state: 'did not finish', body: '' })
  await flush()
  assert.equal(chat.querySelector('[data-action-kind="approval"]').closest('.chat-action-run'), null)
  assert.equal(chat.querySelector('[data-action-kind="turn"]').closest('.chat-action-run'), null)
})

test('the actual Agent page uses stable action snapshots live, and flushes a stopped fragment without duplicating it as speech', async () => {
  const source = await fs.readFile(new URL('../../src/views/agent.js', import.meta.url), 'utf8')
  const rows = []
  const chat = { addAction: row => rows.push(structuredClone(row)) }
  const methods = ['paintChatThinking', 'settleChatThinking'].map(name => declaredFunctionSource(source, name)).join('\n')
  const route = new Function('createActionBuffer', 'sessionActivityEvent', 'sessionActionChatRow', 'chatSessionId', 'chat',
    'let chatThinkingActions = createActionBuffer();' + methods + '; return { paint: paintChatThinking, settle: settleChatThinking }')(
    createActionBuffer, sessionActivityEvent, sessionActionChatRow, 'session', chat)
  const packet = text => ({ sessionId: 'session', event: { type: 'thinking', turnId: 'turn', itemId: 'item', status: 'inProgress', text } })
  assert.equal(route.paint(packet('')), true)
  assert.equal(rows.length, 0)
  route.paint(packet('A summary. Pending'))
  route.paint(packet('A summary. Pending fragment'))
  assert.equal(rows.length, 2)
  assert.equal(rows[0].id, rows[1].id)
  assert.equal(rows[1].body, 'A summary. Pending fragment')
  route.settle()
  assert.equal(rows.at(-1).body, 'A summary. Pending fragment')
  assert.equal(rows.at(-1).stateKey, 'unknown')
  assert.equal(route.paint({ sessionId: 'session', event: { type: 'assistant_text', text: 'Actual reply' } }), false)
  route.paint({ ...packet('Next summary'), event: { ...packet('Next summary').event, turnId: 'next-turn' } })
  assert.notEqual(rows.at(-1).id, rows[0].id)
})

test('host capture preserves full supplied summary without a mounted renderer; stale excerpts cannot overwrite it', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'te-thinking-history-'))
  const store = createNodeTranscriptStore({ directory })
  const capture = createNodeTranscriptCapture({ store })
  const binding = { sessionId: 'session', computerId: 'computer', nodeId: 'node' }
  capture.bind(binding)
  const send = (text, status = 'inProgress') => capture.packet({ sessionId: 'session', event: { type: 'thinking', turnId: 'turn', itemId: 'summary', text, status } })
  const text = 'A supplied readable summary. '.repeat(250)
  send('A supplied readable ')
  send(text, 'completed')
  capture.packet({ sessionId: 'session', event: { type: 'turn_completed', turnId: 'turn', status: 'completed' } })
  await capture.flushNode(binding)
  const id = thinkingTranscriptId('session', 'turn', 'summary')
  let saved = await store.read(binding)
  assert.equal(saved.entries.length, 1)
  assert.equal(saved.entries[0].id, id)
  assert.equal(saved.entries[0].body, text)
  assert.equal(saved.entries[0].state, 'done')
  const client = createNodeTranscriptClient({ computerId: 'computer', bridge: { ...store, bind: args => capture.bind(args) } })
  t.after(async () => { client.dispose(); await capture.shutdown(); await store.shutdown(); await fs.rm(directory, { recursive: true, force: true }) })
  await client.ready
  await client.capture('node', { ...saved.entries[0], body: 'Old excerpt', truncated: true })
  await client.save('node', { lines: [{ ...saved.entries[0], body: 'Old excerpt', truncated: true }] })
  saved = await createNodeTranscriptStore({ directory }).read(binding)
  assert.equal(saved.entries.length, 1)
  assert.equal(restoreRow(saved.entries[0], 0).body, text)
  capture.packet({ sessionId: 'session', event: { type: 'thinking', turnId: 'next-turn', itemId: 'summary', text: 'Interrupted summary', status: 'inProgress' } })
  capture.packet({ sessionId: 'session', event: { type: 'session_ended' } })
  await capture.flushNode(binding)
  assert.equal((await store.read(binding)).entries.at(-1).state, 'unknown')
})

test('Computers terminal recording flushes the last supplied fragment when the thinking item never completes', async t => {
  // A provider can end a turn without its thinking item terminal. The turn
  // boundary still settles the existing row; its supplied body and final
  // presentation fragment remain available without inventing a completion.
  const buffer = createActionBuffer()
  const text = 'A complete sentence. The final supplied fragment'
  const row = buffer.add(thinking(text), { turnId: 'turn', at: 2 }).row
  const chat = buildChat({ title: 'Terminal summary fixture', seed: 0 })
  document.documentElement.appendChild(chat)
  t.after(() => { chat.dispose(); chat.remove() })
  chat.addAction(project(row))
  await flush()
  assert.equal(chat.querySelector('.chat-thinking-body').textContent, text, 'the fragment is visible before terminal recording')
  const writes = []
  const persist = new Function('actionChatRow', 'actionTimingFields', 'transcriptAppend', declaration('persistActionRow') + '; return persistActionRow')(
    project, timing, (sessionId, entry) => writes.push(entry))
  const record = new Function('sessionActions', 'broadcastAction', 'actionChatRow', 'TRANSCRIPT_LIMITS', 'persistActionRow', 'persistTranscript',
    declaration('recordTurnActions') + '; return recordTurnActions')(
    new Map([['session', buffer]]), (sessionId, projected) => chat.addAction(projected), project, TRANSCRIPT_LIMITS, persist, () => {})
  record('session')
  await flush()
  assert.equal(row.state, 'unknown', 'a missing completed summary is not proof of a successful summary completion')
  assert.match(chat.querySelector('.chat-thinking-body').textContent, /final supplied fragment/)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].state, 'unknown', 'the current Computers writer must keep the unsettled result unknown')
  assert.equal(restoreRow(writes[0], 0).state, 'no result came back')
  assert.equal(writes[0].body, text)
  assert.equal(restoreRow(writes[0], 0).body, text)
})

test('real size bounds carry explicit truncation metadata and visible notice, while empty markers stay empty', async t => {
  const activity = thinking('x'.repeat(THINKING_TEXT_LIMIT + 1), 'completed')
  assert.equal(activity.output.length, THINKING_TEXT_LIMIT)
  assert.equal(activity.truncated, true)
  const buffer = createActionBuffer()
  const row = buffer.add(activity, { turnId: 'turn', at: 1 }).row
  const chat = buildChat({ title: 'Bounded summary', seed: 0 })
  document.documentElement.appendChild(chat)
  t.after(() => { chat.dispose(); chat.remove() })
  chat.addAction({ ...project(row), body: 'Retained summary.' })
  await flush()
  assert.match(chat.querySelector('.chat-thinking-body').textContent, /Summary shortened at the transcript size limit/)
  const lines = [{ id: 'summary-id', who: 'action', kind: 'thinking', tool: 'Thinking', state: 'done', text: 'Thinking', body: 'Summary. '.repeat(800), at: 1 }]
  const parsed = parseTranscriptRow({ v: 1, nodes: { node: { savedAt: 1, lines } } })
  const excerpt = parsed.nodes.node.lines[0]
  assert.equal(excerpt.body.length, TRANSCRIPT_LIMITS.maxLineChars)
  assert.equal(excerpt.truncated, true)
  assert.equal(excerpt.id, 'summary-id')
})
