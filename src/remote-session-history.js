import { TRANSCRIPT_LIMITS } from './session-transcript-store.js'

/* Read the host's existing bounded event journal. Its cursor is global even
 * when the response is filtered to one session. Never silently accept a
 * clipped response, a changed host, or an unbounded pagination loop. */
export async function readRemoteSessionHistory(read, sessionId) {
  let after = 0
  let dropped = false
  const events = []
  const sizes = []
  let retainedChars = 0
  for (let page = 0; page < 128; page += 1) {
    const answer = await read({ sessionId, after })
    if (!answer || answer.ok !== true || !Number.isSafeInteger(answer.seq)
        || answer.seq < after || !Array.isArray(answer.events)
        || answer.events.length > 2048) throw new Error('Session history unavailable')
    for (const row of answer.events) {
      if (!Number.isSafeInteger(row?.seq) || row.seq <= after || row.seq > answer.seq
          || (events.length && row.seq <= events.at(-1).seq)
          || row.packet?.sessionId !== sessionId) throw new Error('Session history changed')
      events.push(row)
      const size = JSON.stringify(row).length
      sizes.push(size)
      retainedChars += size
    }
    // The host can emit and evict old events between pages. Keep its newest
    // bounded tail instead of treating a moving, full journal as a dead session.
    // Count and text bounds remain fixed; every local eviction reports a gap.
    while (events.length > 2048 || retainedChars > 4 * 1024 * 1024) {
      events.shift()
      retainedChars -= sizes.shift()
      dropped = true
    }
    dropped ||= answer.dropped === true
    if (answer.truncated !== true) return { events, seq: answer.seq, dropped }
    if (!Number.isSafeInteger(answer.next) || answer.next <= after || answer.next > answer.seq) {
      throw new Error('Session history cursor did not advance')
    }
    after = answer.next
  }
  throw new Error('Session history exceeded its page bound')
}

/* The live poll and a history read can overlap. Once history has applied a
 * sequence, the same packet arriving through the poll is already consumed. */
export function acceptRemoteSequence(sequences, sessionId, sequence) {
  if (!Number.isSafeInteger(sequence)) return true
  if (sequence <= (sequences.get(sessionId) ?? -1)) return false
  sequences.set(sessionId, sequence)
  return true
}

/* Full message records repair a reload in the middle of a streamed answer.
 * Completed turns already in the durable transcript must not be appended
 * twice. Status is returned separately because even a recorded completion can
 * repair a stale running flag. No command or queue operation happens here. */
export function remoteHistoryReplay(events, savedLines = []) {
  const saved = new Set(savedLines.filter(line => line?.who === 'agent' && line.turnStamp)
    .map(line => line.turnStamp))
  // Earlier transcript stores discarded turnStamp. Match each old excerpt to
  // at most one completed host turn, in order, and retain the recovered stamp.
  // Repeated equal replies remain separate turns; matching never creates a
  // session or adds a line to the saved conversation.
  const completed = new Map()
  for (const { packet } of events) {
    const event = packet?.event
    if (!event?.turnId) continue
    const turn = completed.get(event.turnId) || { id: event.turnId, full: new Map(), delta: '', done: false }
    if (event.type === 'assistant_text' && typeof event.text === 'string') turn.full.set(event.itemId || turn.full.size, event.text)
    if (event.type === 'assistant_text_delta' && typeof event.text === 'string') turn.delta += event.text
    if (event.type === 'turn_completed') turn.done = true
    completed.set(event.turnId, turn)
  }
  const legacy = [...completed.values()].filter(turn => turn.done)
    .map(turn => ({ id: turn.id, text: (turn.full.size ? [...turn.full.values()].join('\n\n') : turn.delta)
      .trim().slice(0, TRANSCRIPT_LIMITS.maxLineChars) }))
  let migrated = false
  const migratedLines = savedLines.map(line => {
    if (line?.who !== 'agent' || line.turnStamp) return line
    const match = legacy.find(turn => !saved.has(turn.id) && turn.text && turn.text === line.text)
    if (!match) return line
    saved.add(match.id); migrated = true
    return { ...line, turnStamp: match.id }
  })
  const full = new Set(events.filter(row => row.packet.event?.type === 'assistant_text'
    && typeof row.packet.event.text === 'string')
    .map(row => `${row.packet.event.turnId}/${row.packet.event.itemId || ''}`))
  const packets = []
  const seenTurns = new Set()
  let latestTurnId = null
  let status = null
  let ended = false
  for (const row of events) {
    const { packet } = row
    const event = packet?.event
    if (!event) continue
    if (event.type === 'session_ended') ended = true
    if (typeof event.turnId !== 'string' || !event.turnId) continue
    if (!seenTurns.has(event.turnId)) {
      // A late completion must not settle a different turn already streaming.
      if (event.type !== 'turn_completed' || !latestTurnId || status !== null) {
        latestTurnId = event.turnId; status = null
      }
      seenTurns.add(event.turnId)
    }
    if (event.type === 'turn_completed' && event.turnId === latestTurnId) status = event.status || 'completed'
    if (saved.has(event.turnId)) continue
    const key = `${event.turnId}/${event.itemId || ''}`
    if (event.type === 'assistant_text_delta' && full.has(key)) continue
    if (event.type === 'assistant_text' && typeof event.text === 'string') {
      packets.push({ ...packet, event: { ...event, type: 'assistant_text_delta' } })
    }
    packets.push(packet)
  }
  return { packets, latestTurnId, status, ended, migratedLines: migrated ? migratedLines : null }
}
