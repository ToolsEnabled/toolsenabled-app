/* The coordinator feed adapter, driven with a recording surface. Each test
 * asserts which DOOR of the shared chat surface a polled turn went through,
 * because that is the whole job: the 2026-08-27 failure was a live coordinator
 * with no data path into buildChat, and a reroute alone reproduces it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCoordinatorFeed, createCoordinatorSender, toHistory, historyEntry } from '../../src/home-coordinator-chat.js'

function recorder() {
  const calls = []
  const streams = []
  const chat = {
    addOwnerMessage: (text) => { calls.push(['owner', text]); return { text } },
    confirmOwnerMessage: (message, receipt) => { calls.push(['confirm', message.text, receipt]) },
    addNote: (text) => { calls.push(['note', text]) },
    openStream: ({ turnStamp, entryId = null } = {}) => {
      const stream = { turnStamp, entryId, pushes: [], closed: null }
      streams.push(stream)
      calls.push(['open', turnStamp])
      stream.push = (text) => { stream.pushes.push(text); calls.push(['push', text]) }
      stream.close = (text) => { stream.closed = text; calls.push(['close', text]) }
      return stream
    },
  }
  return { chat, calls, streams }
}

test('history entries: the person is "you", an action is a note, anything else is the agent', () => {
  assert.deepEqual(historyEntry({ who: 'you', text: 'hello' }), { who: 'you', text: 'hello' })
  assert.deepEqual(historyEntry({ sender: 'action', text: 'ran a tool' }), { who: 'note', text: 'ran a tool' })
  assert.deepEqual(historyEntry({ sender: 'coordinator', id: 7, text: 'hi' }), { who: 'agent', text: 'hi', id: '7' })
  assert.equal(historyEntry({ sender: 'coordinator', text: '' }), null)
  assert.equal(toHistory([{ who: 'you', text: 'a' }, null, { who: 'x', text: '' }]).length, 1)
})

test('the first snapshot is history; a later person line goes through addOwnerMessage', () => {
  const { chat, calls } = recorder()
  const initial = [{ sender: 'coordinator', id: '1', text: 'Welcome' }]
  const feed = createCoordinatorFeed({ chat, initial })
  assert.equal(calls.length, 0, 'history is the caller\'s door; the feed paints nothing at mount')
  const r = feed.apply([...initial, { sender: 'you', text: 'Start the build' }])
  assert.deepEqual(r, { ok: true, added: 1 })
  assert.deepEqual(calls, [['owner', 'Start the build']])
  assert.equal(feed.status.busy(), true, 'the person spoke last: the surface must show it is waiting')
})

test('an agent line opens a stream, GROWS while polls extend it, and closes when a poll leaves it unchanged', () => {
  const { chat, calls, streams } = recorder()
  const feed = createCoordinatorFeed({ chat, initial: [{ sender: 'you', text: 'Go' }] })
  feed.apply([{ sender: 'you', text: 'Go' }, { sender: 'coordinator', id: 'a', text: 'Starting' }], { snapshot: 1 })
  assert.deepEqual(calls, [['open', 'a'], ['push', 'Starting']])
  assert.equal(feed.status.busy(), true)
  assert.equal(feed.streaming, true, 'a growing answer keeps its stream open, which the surface shows as responding')
  feed.apply([{ sender: 'you', text: 'Go' }, { sender: 'coordinator', id: 'a', text: 'Starting the build now' }], { snapshot: 2 })
  assert.deepEqual(calls.at(-1), ['push', 'Starting the build now'])
  assert.equal(streams[0].closed, null, 'still growing: the stream stays open')
  /* A REPAINT of the same snapshot is not a poll and must not settle it. */
  feed.apply([{ sender: 'you', text: 'Go' }, { sender: 'coordinator', id: 'a', text: 'Starting the build now' }], { snapshot: 2 })
  assert.equal(streams[0].closed, null, 'the same snapshot painted again is not news')
  feed.apply([{ sender: 'you', text: 'Go' }, { sender: 'coordinator', id: 'a', text: 'Starting the build now' }], { snapshot: 3 })
  assert.equal(streams[0].closed, 'Starting the build now', 'unchanged across a NEW poll: settled and closed')
  assert.equal(feed.status.busy(), false)
  assert.equal(feed.streaming, false)
})

test('a new line after an open stream closes the stream first', () => {
  const { chat, calls, streams } = recorder()
  const feed = createCoordinatorFeed({ chat, initial: [] })
  feed.apply([{ sender: 'coordinator', id: 'a', text: 'One' }])
  feed.apply([{ sender: 'coordinator', id: 'a', text: 'One' }, { sender: 'coordinator', id: 'b', text: 'Two' }])
  assert.equal(streams[0].closed, 'One')
  assert.deepEqual(calls.slice(-3), [['close', 'One'], ['open', 'b'], ['push', 'Two']])
})

test('the poll\'s echo of a line the person sent HERE is not painted twice', () => {
  const { chat, calls } = recorder()
  const feed = createCoordinatorFeed({ chat, initial: [] })
  feed.sentByPerson('hello there')
  assert.equal(feed.status.busy(), true, 'sent and unanswered: busy')
  feed.apply([{ sender: 'you', text: 'hello there' }])
  assert.deepEqual(calls, [], 'the surface already painted its optimistic bubble')
  assert.equal(feed.painted.length, 1)
})

test('a snapshot that rewrites painted history is refused, never silently repainted', () => {
  const { chat } = recorder()
  const feed = createCoordinatorFeed({ chat, initial: [{ sender: 'you', text: 'a' }, { sender: 'coordinator', id: '1', text: 'b' }] })
  const r = feed.apply([{ sender: 'you', text: 'a' }, { sender: 'coordinator', id: '2', text: 'c' }])
  assert.deepEqual(r, { ok: false, reason: 'rewritten', at: 1 })
})

test('subscribe wakes on every applied snapshot and unsubscribes cleanly', () => {
  const { chat } = recorder()
  const feed = createCoordinatorFeed({ chat, initial: [] })
  let woke = 0
  const off = feed.status.subscribe(() => { woke += 1 })
  feed.apply([{ sender: 'you', text: 'x' }])
  off()
  feed.apply([{ sender: 'you', text: 'x' }, { sender: 'you', text: 'y' }])
  assert.equal(woke, 1)
})

test('the sender posts the audited thread-reply and confirms the bubble on a receipt', async () => {
  const posted = []
  const post = async (verb, body) => { posted.push([verb, body]); return { ok: true, receipt: { actor: 'human' } } }
  const { chat } = recorder()
  const feed = createCoordinatorFeed({ chat, initial: [] })
  const send = createCoordinatorSender({ post, feed, copy: { replyRefused: 'no' }, newId: () => 'k1' })
  const doors = { accepted: null, note: null }
  await send('  Ship it  ', { accepted: r => { doors.accepted = r }, note: (t, o) => { doors.note = [t, o] } })
  assert.deepEqual(posted, [['thread-reply', { idempotencyKey: 'k1', threadId: 'owner-thread', message: 'Ship it' }]])
  assert.deepEqual(doors.accepted, { actor: 'human' })
  assert.equal(doors.note, null)
  assert.equal(feed.status.busy(), true, 'sent, awaiting the echo and the answer')
})

test('a refused send retracts the optimistic bubble and forgets the pending echo', async () => {
  const post = async () => ({ ok: false })
  const { chat } = recorder()
  const feed = createCoordinatorFeed({ chat, initial: [] })
  const send = createCoordinatorSender({ post, feed, copy: { replyRefused: 'The message was not sent.' } })
  const notes = []
  await send('Ship it', { note: (t, o) => notes.push([t, o]) })
  assert.deepEqual(notes, [['The message was not sent.', { retract: true }]])
  assert.equal(feed.status.busy(), false, 'nothing is pending after a refusal')
})

test('a sender that throws is a refusal, not an unhandled rejection', async () => {
  const post = async () => { throw new Error('bridge down') }
  const { chat } = recorder()
  const feed = createCoordinatorFeed({ chat, initial: [] })
  const send = createCoordinatorSender({ post, feed, copy: { replyRefused: 'no' } })
  const notes = []
  const result = await send('x', { note: (t, o) => notes.push([t, o]) })
  assert.equal(result.ok, false)
  assert.equal(notes.length, 1)
})

test('a line the feed already settled cannot be regrown in place; the caller is told to remount', () => {
  const { chat } = recorder()
  const feed = createCoordinatorFeed({ chat, initial: [] })
  feed.apply([{ sender: 'coordinator', id: 'a', text: 'One' }], { snapshot: 1 })
  feed.apply([{ sender: 'coordinator', id: 'a', text: 'One' }], { snapshot: 2 })
  assert.equal(feed.streaming, false)
  const r = feed.apply([{ sender: 'coordinator', id: 'a', text: 'One and then some' }], { snapshot: 3 })
  assert.deepEqual(r, { ok: false, reason: 'regrown', at: 0 })
})

test('a history row that grows is resumed through the entryId door of the surface', () => {
  const { chat, calls } = recorder()
  const feed = createCoordinatorFeed({ chat, initial: [{ sender: 'coordinator', id: 'h', text: 'Was here' }] })
  feed.apply([{ sender: 'coordinator', id: 'h', text: 'Was here and grew' }], { snapshot: 1 })
  assert.deepEqual(calls.slice(0, 2), [['open', 'h'], ['push', 'Was here and grew']])
})
