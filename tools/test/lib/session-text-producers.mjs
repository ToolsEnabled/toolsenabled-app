// Synthetic transports exercise the actual selected engine producers and their event validator.
// No provider process, account, filesystem fixture or owner transcript is used.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { canonicalRootForTests } from '../../canonical-root.mjs'

const require = createRequire(import.meta.url)
const engine = canonicalRootForTests({ requireConfigured: true })
const { ClaudeCliAdapter } = require(join(engine, 'src/lib/agent-engine/claude-cli-adapter.js'))
const { AcpAdapter } = require(join(engine, 'src/lib/agent-engine/acp-adapter.js'))
const { validateEngineEvent } = require(join(engine, 'src/lib/agent-engine/engine-contract.js'))

export function claudeTextEvents({ blocks = ['Same.', 'Same.'], streamed = false, partial = false, streamIndexes = null } = {}) {
  let receive
  const events = []
  const adapter = new ClaudeCliAdapter({ transport: { send() { assert.fail('No provider send expected') }, onData(fn) { receive = fn }, close() {} } })
  adapter.threadId = 'fixture-thread'
  adapter.activeTurn = { turnId: 'fixture-turn', timer: setTimeout(() => {}, 5000), resolve() {}, reject() {} }
  adapter.onEvent(event => events.push(event))
  try {
    if (streamed) {
      receive({ type: 'stream_event', event: { type: 'message_start', message: { id: 'fixture-message' } } })
      for (const [blockIndex, text] of blocks.entries()) {
        const index = streamIndexes ? streamIndexes[blockIndex] : blockIndex
        const stream = event => receive({ type: 'stream_event', event })
        stream({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
        stream({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: partial ? text.slice(0, 2) : text } })
        stream({ type: 'content_block_stop', index })
      }
      receive({ type: 'stream_event', event: { type: 'message_stop' } })
    }
    const packet = { type: 'assistant', message: { id: 'fixture-message', content: blocks.map(text => ({ type: 'text', text })) } }
    receive(packet)
    receive(packet) // Transport replay must not create another pair of paragraphs.
    return events.map(validateEngineEvent)
  } finally { adapter.close() }
}

export async function acpTextEvents({ before = 'Before.', after = ['After.'] } = {}) {
  let receive, pending
  const events = []
  const reply = (request, result) => receive(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
  const adapter = new AcpAdapter({ defaultCwd: process.cwd(), mcpServers: [], transport: {
    onData(fn) { receive = fn; return () => {} }, close() {},
    write(line) {
      const request = JSON.parse(line)
      if (request.method === 'initialize') queueMicrotask(() => reply(request, { protocolVersion: 1, agentCapabilities: {}, authMethods: [] }))
      else if (request.method === 'session/new') queueMicrotask(() => reply(request, { sessionId: 'fixture-thread' }))
      else if (request.method === 'session/prompt') pending = request
      else assert.fail('Unexpected ACP request: ' + request.method)
    },
  } })
  adapter.onEvent(event => events.push(event))
  try {
    await adapter.initialize()
    await adapter.startThread({ cwd: process.cwd() })
    const turn = adapter.sendTurn({ threadId: 'fixture-thread', text: 'Synthetic fixture input.' })
    const update = value => receive(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fixture-thread', update: value } }) + '\n')
    const text = value => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } })
    text(before)
    update({ sessionUpdate: 'tool_call', toolCallId: 'fixture-call', title: 'Synthetic read', status: 'in_progress' })
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'fixture-call', status: 'completed' })
    for (const value of after) text(value)
    assert.ok(pending, 'The real sendTurn must issue session/prompt')
    reply(pending, { stopReason: 'end_turn' })
    await turn
    assert.equal(adapter.activeTurns.size, 0)
    return events.map(validateEngineEvent)
  } finally { adapter.close() }
}
