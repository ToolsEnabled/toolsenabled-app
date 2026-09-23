import { createTranscriptStore } from '../../src/session-transcript-store.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { acceptRemoteSequence, readRemoteSessionHistory, remoteHistoryReplay } from '../../src/remote-session-history.js'
import { sessionEventText } from '../../src/agent-session-events.js'
const row = (seq, type, turnId, rest = {}) => ({ seq, packet: { sessionId: 'session', event: { type, turnId, ...rest } } })

test('reads all bounded pages and retains the gap signal', async () => {
  const requests = []
  const a = row(2, 'assistant_text_delta', 'turn', { text: 'a' })
  const b = row(7, 'turn_completed', 'turn')
  const result = await readRemoteSessionHistory(async r => {
    requests.push(r)
    return r.after === 0 ? { ok: true, seq: 9, events: [a], dropped: true, truncated: true, next: 3 }
      : { ok: true, seq: 9, events: [b], dropped: false }
  }, 'session')
  assert.deepEqual(requests, [{ sessionId: 'session', after: 0 }, { sessionId: 'session', after: 3 }])
  assert.deepEqual(result, { events: [a, b], seq: 9, dropped: true })
})

test('a journal growing across pages keeps the newest bounded history and reports its gap', async () => {
  const requests = []
  const result = await readRemoteSessionHistory(async ({ after }) => {
    requests.push(after)
    const seq = after === 0 ? 2000 : 2100
    const next = Math.min(after + 300, seq)
    const events = Array.from({ length: next - after }, (_, i) => {
      const at = after + i + 1
      return at === 2100 ? row(at, 'turn_completed', 'new')
        : at === 2099 ? row(at, 'assistant_text', 'new', { text: 'Newest reply' })
          : row(at, 'usage', 'old')
    })
    return { ok: true, seq, next, events, truncated: next < seq, dropped: false }
  }, 'session')
  assert.deepEqual(requests, [0, 300, 600, 900, 1200, 1500, 1800])
  assert.equal(result.events.length, 2048)
  assert.equal(result.events[0].seq, 53)
  assert.equal(result.events.at(-1).seq, 2100)
  assert.equal(result.dropped, true)
  const replay = remoteHistoryReplay(result.events)
  assert.equal(replay.status, 'completed')
  assert.equal(replay.packets.map(p => sessionEventText(p, 'session') || '').join(''), 'Newest reply')
})

test('a single oversized host page and endless pagination still refuse', async () => {
  await assert.rejects(readRemoteSessionHistory(async () => ({
    ok: true, seq: 2049, events: Array.from({ length: 2049 }, (_, i) => row(i + 1, 'usage', 'turn')),
  }), 'session'), /unavailable/)
  let calls = 0
  await assert.rejects(readRemoteSessionHistory(async ({ after }) => {
    calls += 1
    return { ok: true, seq: after + 1, next: after + 1, events: [], truncated: true }
  }, 'session'), /page bound/)
  assert.equal(calls, 128)
})

test('large legal events retain a bounded text tail and make its eviction visible', async () => {
  const result = await readRemoteSessionHistory(async ({ after }) => ({
    ok: true, seq: 80, next: after + 1, truncated: after + 1 < 80,
    events: [row(after + 1, 'assistant_text', 'turn', { text: 'x'.repeat(65536) })],
  }), 'session')
  assert.ok(result.events.length > 0 && result.events.length < 80)
  assert.ok(result.events.reduce((size, event) => size + JSON.stringify(event).length, 0) <= 4 * 1024 * 1024)
  assert.equal(result.events.at(-1).seq, 80)
  assert.equal(result.dropped, true)
})

test('refuses nonadvancing pages, a different session, and a restarted host', async () => {
  for (const bad of [
    { ok: true, seq: 1, events: [], truncated: true, next: 0 },
    { ok: true, seq: 1, events: [{ seq: 1, packet: { sessionId: 'foreign' } }] },
    { ok: false, seq: 0, events: [] },
  ]) await assert.rejects(readRemoteSessionHistory(async () => bad, 'session'))
  let calls = 0
  await assert.rejects(readRemoteSessionHistory(async () => ++calls === 1
    ? { ok: true, seq: 9, events: [], truncated: true, next: 9 }
    : { ok: true, seq: 0, events: [] }, 'session'))
})

test('recorded completed turns are not duplicated, but still settle stale running state', () => {
  const events = [row(1, 'assistant_text_delta', 'old', { text: 'kept' }), row(2, 'turn_completed', 'old', { status: 'completed' })]
  const result = remoteHistoryReplay(events, [{ who: 'agent', text: 'kept', turnStamp: 'old' }])
  assert.deepEqual(result.packets, [])
  assert.equal(result.status, 'completed')
})

test('a full message recovers missing initial deltas exactly once', () => {
  const events = [row(1, 'assistant_text_delta', 'turn', { itemId: 'message', text: 'world' }),
    row(2, 'assistant_text', 'turn', { itemId: 'message', text: 'Hello world' }), row(3, 'turn_completed', 'turn')]
  const result = remoteHistoryReplay(events)
  assert.equal(result.packets.map(p => sessionEventText(p, 'session') || '').join(''), 'Hello world')
  assert.equal(result.status, 'completed')
})

test('a previous completion cannot make the later streaming turn idle', () => {
  const result = remoteHistoryReplay([row(1, 'turn_completed', 'old'), row(2, 'assistant_text_delta', 'new', { text: 'working' })])
  assert.equal(result.latestTurnId, 'new')
  assert.equal(result.status, null)
  assert.equal(result.ended, false)
})

test('multiple complete messages retain separate boundaries and a real session end', () => {
  const result = remoteHistoryReplay([row(1, 'assistant_text', 'turn', { itemId: 'a', text: 'one' }),
    row(2, 'assistant_text', 'turn', { itemId: 'b', text: 'two' }), row(3, 'turn_completed', 'turn'),
    row(4, 'session_ended', undefined, { reason: 'exited' })])
  assert.deepEqual(result.packets.filter(p => p.event.type === 'assistant_text').map(p => p.event.text), ['one', 'two'])
  assert.equal(result.ended, true)
})


test('a late completion for the older turn cannot settle a newer active turn', () => {
  const result = remoteHistoryReplay([row(1, 'assistant_text_delta', 'old', { text: 'old' }),
    row(2, 'assistant_text_delta', 'new', { text: 'new' }), row(3, 'turn_completed', 'old')])
  assert.equal(result.latestTurnId, 'new')
  assert.equal(result.status, null)
})


test('the live poll cannot append history packets a second time after reconnect', () => {
  const sequences = new Map([['session', 100]])
  const delivered = [95, 99, 100, 101, 102, 102, 103].filter(sequence => acceptRemoteSequence(sequences, 'session', sequence))
  assert.deepEqual(delivered, [101, 102, 103])
  assert.equal(acceptRemoteSequence(sequences, 'another-session', 99), true)
  assert.equal(acceptRemoteSequence(sequences, 'native-session', undefined), true)
})


test('saved turn identities survive the real store and prevent replay on the next page load', () => {
  const values = new Map()
  const storage = { read: key => values.get(key) || null, write: (key, value) => { values.set(key, JSON.parse(JSON.stringify(value))); return true } }
  const store = createTranscriptStore({ computerId: 'computer', storage })
  store.save('node', { lines: [{ who: 'agent', text: 'reply', at: 1, turnStamp: 'turn' }] })
  const reopened = createTranscriptStore({ computerId: 'computer', storage })
  const result = remoteHistoryReplay([row(1, 'assistant_text', 'turn', { text: 'reply' }), row(2, 'turn_completed', 'turn')], reopened.get('node').lines)
  assert.equal(reopened.get('node').lines[0].turnStamp, 'turn')
  assert.deepEqual(result.packets, [])
})

test('legacy repeated equal excerpts each match one real completed turn and acquire its identity', () => {
  const events = [row(1, 'assistant_text', 'one', { text: 'same' }), row(2, 'turn_completed', 'one'),
    row(3, 'assistant_text', 'two', { text: 'same' }), row(4, 'turn_completed', 'two')]
  const result = remoteHistoryReplay(events, [{ who: 'agent', text: 'same', at: 1 }])
  assert.equal(result.migratedLines[0].turnStamp, 'one')
  assert.ok(result.packets.every(packet => packet.event.turnId === 'two'))
  const again = remoteHistoryReplay(events, [...result.migratedLines, { who: 'agent', text: 'same', at: 2, turnStamp: 'two' }])
  assert.deepEqual(again.packets, [])
})
