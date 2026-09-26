import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionTextReader } from '../../src/agent-session-events.js'

function fixture(reader = createSessionTextReader(), sessionId = 'session-a') {
  let text = ''
  const read = (type, value = '', extra = {}) => {
    const result = reader.read({ sessionId, event: { type, text: value, turnId: 'turn-a', ...extra } }, sessionId)
    if (result?.text) text += (result.breakBefore && text ? '\n\n' : '') + result.text
    return result
  }
  return { reader, read, text: () => text, reset: () => { text = '' } }
}
const delta = (f, text, extra = {}) => f.read('assistant_text_delta', text, extra)
const whole = (f, text, extra = {}) => f.read('assistant_text', text, extra)

test('whole-only text is admitted without a delta', () => {
  const f = fixture()
  assert.deepEqual(whole(f, 'A complete answer.', { itemId: 'one' }), { text: 'A complete answer.', breakBefore: false })
})

test('a final extending a streamed prefix contributes only its suffix', () => {
  const f = fixture()
  delta(f, 'A partial', { itemId: 'one' })
  assert.deepEqual(whole(f, 'A partial answer.', { itemId: 'one' }), { text: ' answer.', breakBefore: false })
  whole(f, 'A partial answer.', { itemId: 'one' })
  assert.equal(f.text(), 'A partial answer.')
})

test('identical words in distinct identified messages survive', () => {
  const f = fixture()
  for (const itemId of ['one', 'two']) { delta(f, 'Same.', { itemId }); whole(f, 'Same.', { itemId }) }
  assert.equal(f.text(), 'Same.\n\nSame.')
})

test('repeated tokens within one message are retained', () => {
  const f = fixture()
  delta(f, 'ha', { itemId: 'one' }); delta(f, 'ha', { itemId: 'one' })
  whole(f, 'haha', { itemId: 'one' })
  assert.equal(f.text(), 'haha')
})

test('a duplicate whole packet does not become a new message at a tool boundary', () => {
  const f = fixture()
  whole(f, 'Before.', { itemId: 'one' })
  f.read('tool_call', '', { toolCallId: 'call' })
  whole(f, 'Before.', { itemId: 'one' })
  f.read('tool_result', '', { toolCallId: 'call' })
  whole(f, 'After.', { itemId: 'two' })
  assert.equal(f.text(), 'Before.\n\nAfter.')
})

test('unkeyed adjacent stream and final reconcile without swallowing legitimate repeated whole messages', () => {
  const f = fixture()
  delta(f, 'Same.'); whole(f, 'Same.'); whole(f, 'Same.')
  assert.equal(f.text(), 'Same.\n\nSame.')
})

test('an unkeyed message after a tool boundary is preserved even when it equals the previous stream', () => {
  const f = fixture()
  delta(f, 'Same.')
  f.read('tool_call', '', { toolCallId: 'call' })
  whole(f, 'Same.')
  assert.equal(f.text(), 'Same.\n\nSame.')
})

test('a late echo for an older message cannot split the current unkeyed stream', () => {
  const f = fixture()
  whole(f, 'Before.', { itemId: 'one' })
  delta(f, 'A partial')
  whole(f, 'Before.', { itemId: 'one' })
  delta(f, ' answer.')
  whole(f, 'A partial answer.')
  assert.equal(f.text(), 'Before.\n\nA partial answer.')
})

test('completion retains named echo identity until a new turn begins', () => {
  const f = fixture()
  whole(f, 'Same.', { itemId: 'one' })
  f.read('turn_completed', '', { status: 'completed' })
  whole(f, 'Same.', { itemId: 'one' })
  assert.equal(f.text(), 'Same.')
  f.reset()
  whole(f, 'Same.', { itemId: 'one', turnId: 'turn-b' })
  assert.equal(f.text(), 'Same.')
})

test('an inconsistent final remains visible instead of deleting either observed version', () => {
  const f = fixture()
  delta(f, 'First version.', { itemId: 'one' })
  whole(f, 'Different final.', { itemId: 'one' })
  whole(f, 'Different final.', { itemId: 'one' })
  assert.equal(f.text(), 'First version.\n\nDifferent final.')
})

test('retirement and disposal release identity without affecting another consumer', () => {
  const reader = createSessionTextReader()
  const a = fixture(reader), b = fixture(reader, 'session-b'), independent = fixture()
  whole(a, 'One.', { itemId: 'one' }); whole(b, 'One.', { itemId: 'one' })
  whole(independent, 'One.', { itemId: 'one' })
  reader.clear('session-a'); a.reset()
  whole(a, 'One.', { itemId: 'one' })
  whole(b, 'One.', { itemId: 'one' })
  assert.equal(a.text(), 'One.'); assert.equal(b.text(), 'One.'); assert.equal(independent.text(), 'One.')
  reader.clear(); b.reset()
  whole(b, 'One.', { itemId: 'one' })
  assert.equal(b.text(), 'One.')
})

test('foreign, malformed and tree-delivery packets cannot poison owned message identity', () => {
  const f = fixture()
  const foreign = { sessionId: 'other', event: { type: 'assistant_text', turnId: 'turn-a', itemId: 'one', text: 'Hidden.' } }
  assert.equal(f.reader.read(foreign, 'session-a'), null)
  assert.equal(f.reader.read(null, 'session-a'), null)
  assert.equal(f.reader.read({ sessionId: 'session-a', event: { type: 'assistant_text', text: 9 } }, 'session-a'), null)
  assert.equal(whole(f, 'Hidden.', { itemId: 'one', treeDelivery: true }), null)
  whole(f, 'Visible.', { itemId: 'one' })
  assert.equal(f.text(), 'Visible.')
})

import { claudeTextEvents, acpTextEvents } from './lib/session-text-producers.mjs'

function renderEvents(events) {
  const f = fixture()
  for (const { type, text, ...extra } of events) f.read(type, text, extra)
  return f.text()
}

test('actual Claude whole content blocks retain equal text while repeated packets reconcile', () => {
  const events = claudeTextEvents()
  assert.equal(events.filter(event => event.type === 'assistant_text').length, 4)
  assert.equal(renderEvents(events), 'Same.\n\nSame.')
})

test('actual Claude streamed block identities reconcile their own finals and preserve equal blocks', () => {
  const events = claudeTextEvents({ streamed: true })
  assert.equal(events.filter(event => event.type === 'assistant_text_delta').length, 2)
  assert.equal(renderEvents(events), 'Same.\n\nSame.')
})

test('actual Claude one streamed prefix receives its final suffix only once', () => {
  assert.equal(renderEvents(claudeTextEvents({ blocks: ['Partial answer.'], streamed: true, partial: true })), 'Partial answer.')
})

test('actual ACP text resumes across a tool seam and the aggregate final remains an echo', async () => {
  const events = await acpTextEvents()
  const final = events.find(event => event.type === 'assistant_text')
  assert.equal(final.text, 'Before.After.')
  assert.equal(renderEvents([...events, final]), 'Before.\n\nAfter.')
})

test('actual ACP legitimate repeated deltas after a tool remain visible exactly once', async () => {
  assert.equal(renderEvents(await acpTextEvents({ after: ['After.', 'After.'] })), 'Before.\n\nAfter.After.')
})

test('a same-item final suffix after a tool preserves the seam and later aggregate echoes add nothing', () => {
  const f = fixture()
  delta(f, 'Before.', { itemId: 'one' })
  f.read('tool_call', '', { toolCallId: 'call' })
  whole(f, 'Before.After.', { itemId: 'one' })
  whole(f, 'Before.After.', { itemId: 'one' })
  assert.equal(f.text(), 'Before.\n\nAfter.')
})

test('successive whole refinements of one closed item keep their contiguous text', () => {
  const f = fixture()
  whole(f, 'Partial', { itemId: 'one' })
  whole(f, 'Partial answer.', { itemId: 'one' })
  whole(f, 'Partial answer.', { itemId: 'one' })
  assert.equal(f.text(), 'Partial answer.')
})

test('Claude absent or malformed stream block indexes cannot manufacture a stable block identity', () => {
  for (const index of [undefined, -1, 0.5]) {
    const events = claudeTextEvents({ blocks: ['Same.'], streamed: true, streamIndexes: [index] })
    assert.equal(events.find(event => event.type === 'assistant_text_delta').itemId, undefined)
    assert.equal(renderEvents(events), 'Same.')
  }
})
