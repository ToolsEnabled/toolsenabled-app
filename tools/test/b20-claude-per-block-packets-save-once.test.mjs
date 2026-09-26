// B20 (found by hand on the 1.0.48 candidate, 2026-09-26): a Claude reply whose text came after a
// thinking block in the same provider message was saved twice ("KIWIKIWI") and shown twice in the
// live bubble ("KIWI\n\nKIWI"). Claude 2.1.283 sends each content block of one provider message as its
// own assistant packet under the same message id (measured in the CLI's own session files), and the
// engine adapter named the streamed text and its final with different block numbers, so the capture
// and the renderer each kept the final as new speech.
//
// This runs the real engine adapter (MC_CANONICAL_ROOT) into the real transcript capture, a disk
// reopen, and the real renderer text reader, with the packet shape the CLI writes.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { canonicalRootForTests } from '../canonical-root.mjs'
import { createNodeTranscriptClient } from '../../src/node-transcript-client.js'
import { createSessionTextReader } from '../../src/agent-session-events.js'

const require = createRequire(import.meta.url)
const engineRoot = canonicalRootForTests({ requireConfigured: true })
const { ClaudeCliAdapter } = require(path.join(engineRoot, 'src/lib/agent-engine/claude-cli-adapter.js'))
const { createNodeTranscriptStore } = require('../../shell/node-transcript-store.cjs')
const { createNodeTranscriptCapture } = require('../../shell/node-transcript-capture.cjs')
const binding = { sessionId: 'synthetic-session', computerId: 'synthetic-computer', nodeId: 'synthetic-node' }

function adapterEvents(t, script) {
  let receive
  const events = []
  const adapter = new ClaudeCliAdapter({ transport: { send() {}, onData(next) { receive = next }, close() {} } })
  adapter.threadId = 'synthetic-thread'
  adapter.activeTurn = { turnId: 'synthetic-turn', timer: setTimeout(() => {}, 5000), resolve() {}, reject() {} }
  adapter.onEvent(event => events.push(event))
  t.after(() => { clearTimeout(adapter.activeTurn?.timer); adapter.close() })
  const io = {
    stream: event => receive({ type: 'stream_event', event, session_id: 'synthetic-thread' }),
    assistant: (id, content) => receive({ type: 'assistant', message: { id, role: 'assistant', content }, session_id: 'synthetic-thread' }),
    user: content => receive({ type: 'user', message: { role: 'user', content }, session_id: 'synthetic-thread' }),
  }
  script(io)
  return events
}

// One provider message streamed block by block, each block then finalised as its own packet.
function message(io, id, blocks) {
  io.stream({ type: 'message_start', message: { id } })
  blocks.forEach((block, index) => {
    if (block.kind === 'thinking') {
      io.stream({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } })
      io.stream({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'SIG' } })
      io.stream({ type: 'content_block_stop', index })
      io.assistant(id, [{ type: 'thinking', thinking: '', signature: 'SIG' }])
    } else if (block.kind === 'text') {
      io.stream({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      for (const piece of block.text.match(/.{1,7}/gs)) io.stream({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } })
      io.stream({ type: 'content_block_stop', index })
      io.assistant(id, [{ type: 'text', text: block.text }])
    } else {
      io.stream({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: 'Read', input: {} } })
      io.stream({ type: 'content_block_stop', index })
      io.assistant(id, [{ type: 'tool_use', id: block.id, name: 'Read', input: {} }])
    }
  })
  io.stream({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })
  io.stream({ type: 'message_stop' })
}

async function savedAgentLines(t, events) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'te-b20-transcript-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const store = createNodeTranscriptStore({ directory })
  const capture = createNodeTranscriptCapture({ store })
  capture.bind(binding)
  for (const event of events) capture.packet({ sessionId: binding.sessionId, event })
  capture.packet({ sessionId: binding.sessionId, event: { type: 'turn_completed', turnId: 'synthetic-turn', status: 'success' } })
  await capture.shutdown()
  await store.shutdown()
  const reopened = createNodeTranscriptStore({ directory })
  t.after(() => reopened.shutdown())
  const client = createNodeTranscriptClient({ computerId: binding.computerId, bridge: reopened })
  await client.ready
  t.after(() => client.dispose())
  return ((await client.readLatest(binding.nodeId))?.lines || []).filter(line => line.who === 'agent').map(line => line.text)
}

function liveBubble(events) {
  const reader = createSessionTextReader()
  let shown = ''
  for (const event of events) {
    const read = reader.read({ sessionId: binding.sessionId, event }, binding.sessionId)
    if (read?.text) shown += (read.breakBefore ? '\n\n' : '') + read.text
  }
  return shown
}

const cases = [
  ['a Haiku worker: a signature-only thinking block, then the text', io =>
    message(io, 'msg-kiwi', [{ kind: 'thinking' }, { kind: 'text', text: 'KIWI' }]),
  ['KIWI']],
  ['a Controller: thinking, text and two tools, then a text-only message', io => {
    message(io, 'msg-a', [{ kind: 'thinking' }, { kind: 'text', text: "I'll check the task records." }, { kind: 'tool', id: 't1' }, { kind: 'tool', id: 't2' }])
    io.user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }, { type: 'tool_result', tool_use_id: 't2', content: 'ok' }])
    message(io, 'msg-b', [{ kind: 'text', text: 'Nothing unfinished.' }])
  }, ["I'll check the task records.\n\nNothing unfinished."]],
  ['a Controller: text and a tool, then thinking and text', io => {
    message(io, 'msg-1', [{ kind: 'text', text: "I'll start one Worker." }, { kind: 'tool', id: 't1' }])
    io.user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }])
    message(io, 'msg-2', [{ kind: 'thinking' }, { kind: 'text', text: 'Worker started; waiting for its reply.' }])
  }, ["I'll start one Worker.\n\nWorker started; waiting for its reply."]],
  ['a text-first reply (the case that was already right)', io =>
    message(io, 'msg-p', [{ kind: 'text', text: 'PINEAPPLE' }]),
  ['PINEAPPLE']],
]

for (const [name, script, expected] of cases) {
  test(`B20: ${name} is saved once and shown once`, async t => {
    const events = adapterEvents(t, script)
    assert.deepEqual(await savedAgentLines(t, events), expected, 'the saved reply repeats the provider text')
    assert.equal(liveBubble(events), expected[0], 'the live bubble repeats the provider text')
  })
}
