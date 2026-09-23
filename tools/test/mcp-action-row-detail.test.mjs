/* AN MCP TOOL CALL MUST SAY WHICH TOOL, NOT WHICH SERVER.
 *
 * MEASURED 2026-08-19, live, by a read-only tap on window.mcAgent.onEvent
 * during a real luna turn in the packaged app: the engine event carries
 * everything a person needs —
 *
 *   event.tool = 'mcpToolCall'
 *   event.payload = { server: 'toolsenabled', tool: 'task.submit', arguments: {...} }
 *
 * — and the chat row showed "toolsenabled · finished". The loss was entirely in
 * this module: DETAIL_KEYS listed 'server' BEFORE 'tool', so detailFrom()
 * returned the server name for every MCP call, and 'arguments' was not a key at
 * all. Every product tool call therefore rendered as the same anonymous line.
 *
 * Why that is a defect and not a nit: the action rows are the context window
 * the owner asked for (his finding 1). A row that cannot say which tool ran
 * cannot tell a person WHICH call failed, and it makes the rows worthless as
 * evidence — the sweep that found this had to fall back to the signed ledger
 * for tool identity because the glass would not say.
 *
 * The fix keeps the guess-nothing rule: named keys only, no shape inference,
 * and a payload with none of them still says nothing.
 *
 * Run: node --test tools/test/mcp-action-row-detail.test.mjs
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createActionBuffer, sessionActivityEvent } from '../../src/agent-session-events.js'
import { actionRowWords } from '../../src/fleet-tree-copy.js'

const call = payload => sessionActivityEvent({
  sessionId: 's1',
  event: { type: 'tool_call', tool: 'mcpToolCall', toolCallId: 't1', payload },
}, 's1')

test('an MCP call names the tool, never the server it lives on', () => {
  const row = call({ server: 'toolsenabled', tool: 'task.submit', arguments: { title: 'x' } })
  assert.equal(row.kind, 'call')
  assert.ok(row.detail.includes('task.submit'),
    `the row says ${JSON.stringify(row.detail)} — a person cannot tell which tool ran`)
  assert.ok(!/^toolsenabled$/.test(row.detail),
    'the row still shows only the server name')
})

test('the call carries its arguments, because a tool name without them is half a fact', () => {
  const row = call({ server: 'toolsenabled', tool: 'memory.set', arguments: { key: 'drive-check', value: 391 } })
  assert.match(row.detail, /drive-check/,
    'the arguments never reach the row, so two calls to one tool are indistinguishable')
})

test('the older shapes still win where they are the real subject', () => {
  /* codex puts a shell line on `command`; the Claude CLI passes the tool's own
     input. Those remain the most specific thing to say, so they still lead. */
  assert.match(call({ command: 'ls -la' }).detail, /ls -la/)
  assert.match(call({ file_path: 'C:/x/notes.txt' }).detail, /notes\.txt/)
})

test('a payload with nothing named says nothing, rather than guessing at its shape', () => {
  assert.equal(call({ mystery: 'value' }).detail, '')
  assert.equal(call({}).detail, '')
})

test('the detail stays inside the row budget', () => {
  const row = call({ server: 'toolsenabled', tool: 'http.request', arguments: { body: 'z'.repeat(5_000) } })
  assert.ok(row.detail.length <= 240, `detail is ${row.detail.length} chars`)
})

// Shape captured from a real Antigravity host.exec turn in the Linux tree.
// Its result wraps the same parameters one level deeper than its call.
const agyParameters = { ServerName: 'toolsenabled-research', ToolName: 'host.exec', Arguments: { command: 'wc -l fixture.txt' } }
const agyActivity = (type, payload, extra = {}) => sessionActivityEvent({
  sessionId: 's1', event: { type, tool: 'call_mcp_tool', toolCallId: '128', payload, ...extra },
}, 's1')

test('Antigravity call and result retain the actual tool and command in one completed row', () => {
  const buffer = createActionBuffer()
  const started = agyActivity('tool_call', agyParameters)
  assert.equal(started.detail, 'host.exec · command: wc -l fixture.txt')
  buffer.add(started, { turnId: 'turn-agy', at: 100 })
  buffer.add(agyActivity('tool_result', { name: 'call_mcp_tool', parameters: agyParameters, output: '128 fixture.txt' }, { status: 'ok' }), { turnId: 'turn-agy', at: 200 })
  const rows = buffer.list()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].state, 'done')
  assert.equal(rows[0].detail, started.detail)
  assert.equal(rows[0].output, '128 fixture.txt')
  assert.equal(actionRowWords(rows[0]).tool, 'Tool')
})

test('Antigravity result-first errors remain errors and retain their named parameters', () => {
  const buffer = createActionBuffer()
  buffer.add(agyActivity('tool_result', { parameters: agyParameters, error: 'Command refused' }, { status: 'error' }), { turnId: 'turn-agy', at: 200 })
  const row = buffer.list()[0]
  assert.equal(row.detail, 'host.exec · command: wc -l fixture.txt')
  assert.equal(row.state, 'undone')
  assert.equal(row.output, 'Command refused')
})

test('Antigravity display accepts named parameters only and bounds argument context', () => {
  for (const payload of [{}, { ToolName: {} }, { ToolName: 4 }, { parameters: agyParameters }]) {
    assert.equal(agyActivity('tool_call', payload).detail, '')
  }
  assert.equal(agyActivity('tool_result', { output: JSON.stringify(agyParameters) }).detail, '', 'output text cannot become a tool identity')
  assert.equal(agyActivity('tool_call', { ToolName: 'host.exec', Arguments: '{"command":"unparsed"}' }).detail, 'host.exec')
  assert.equal(agyActivity('tool_call', { ...agyParameters, Arguments: { command: 'x'.repeat(5000) } }).detail.length, 240)
  assert.equal(call(agyParameters).detail, '', 'native aliases apply only to the matching provider event')
})
