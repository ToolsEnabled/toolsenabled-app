import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_STALE_AFTER_MS,
  nodeIsBusy,
  sessionEndedWithApp,
  sessionEvidenceIsStale,
  sessionIsLive,
  treeNodeClock,
} from '../../src/tree-session-liveness.js'

/* The record shape src/fleet-trees.js writes: `runMs` is the measured sum of
   the intervals this node has run, and `runStartedAt` is the one now open. A
   node three minutes into its first run has banked nothing yet. */
const node = (overrides = {}) => ({
  sessionId: 'session-this-run',
  status: 'running',
  createdAt: '2026-08-25T10:00:00.000Z',
  updatedAt: '2026-08-25T10:03:00.000Z',
  runMs: 0,
  runStartedAt: '2026-08-25T10:00:00.000Z',
  ...overrides,
})

test('liveness asks the caller-owned collection, including an unreadable collection', () => {
  const current = node()
  assert.equal(sessionIsLive(current, new Map([[current.sessionId, 'node-1']])), true,
    'a session present in the current run collection was reported dead')
  assert.equal(sessionIsLive(current, new Set()), false,
    'a session absent from the current run collection was reported live')

  const unreadable = new Error('owned-session collection could not be read')
  const brokenCollection = { has() { throw unreadable } }
  assert.throws(() => sessionIsLive(current, brokenCollection), error => error === unreadable,
    'a could-not-read session collection collapsed into a definite liveness answer')
})

test('busy and app-ended are opposite outcomes only for busy saved records', () => {
  const current = node()
  const owned = new Set([current.sessionId])
  assert.equal(nodeIsBusy(current, owned), true,
    'a running record backed by a session from this run was not busy')
  assert.equal(sessionEndedWithApp(current, owned), false,
    'a running record backed by a session from this run was said to have ended with the app')

  assert.equal(nodeIsBusy(current, new Set()), false,
    'a running saved record without a session from this run remained busy')
  assert.equal(sessionEndedWithApp(current, new Set()), true,
    'a running saved record without a session from this run did not expose the app-ended recovery state')

  const finished = node({ status: 'finished' })
  assert.equal(sessionEndedWithApp(finished, new Set()), false,
    'a normally finished turn was misreported as ending with the app')
})

test('the clock describes live, app-ended, and terminal records with caller timestamps', () => {
  /* `runtimeEpoch` is the instant the digits count from, and for these records
     -- one run, nothing banked before it -- it lands on the run's own start.
     `runMs` is what the circle would read if it froze right now. */
  const current = node()
  assert.deepEqual(treeNodeClock(current, new Set([current.sessionId])), {
    runtimeEpoch: Date.parse(current.createdAt),
    stoppedAt: null,
    runMs: 0,
    running: true,
    terminal: false,
    endedWithApp: false,
  }, 'a live record did not retain a running clock from the start of its run')

  assert.deepEqual(treeNodeClock(current, new Set()), {
    runtimeEpoch: Date.parse(current.createdAt),
    stoppedAt: Date.parse(current.updatedAt),
    runMs: Date.parse(current.updatedAt) - Date.parse(current.createdAt),
    running: false,
    terminal: false,
    endedWithApp: true,
  }, 'an app-ended record did not freeze its clock at the last saved update')

  const interrupted = node({ status: 'interrupted' })
  assert.deepEqual(treeNodeClock(interrupted, new Set([interrupted.sessionId])), {
    runtimeEpoch: Date.parse(interrupted.createdAt),
    stoppedAt: Date.parse(interrupted.updatedAt),
    runMs: Date.parse(interrupted.updatedAt) - Date.parse(interrupted.createdAt),
    running: false,
    terminal: true,
    endedWithApp: false,
  }, 'an interrupted record was not a terminal clock even while its session remains owned')
})

test('missing sessions and unreadable dates do not invent clock facts', () => {
  assert.deepEqual(treeNodeClock(node({ sessionId: null, runStartedAt: null }), new Set()), {
    runtimeEpoch: null,
    stoppedAt: null,
    runMs: 0,
    running: false,
    terminal: false,
    endedWithApp: false,
  }, 'a record that never held a session invented runtime or an app-ended state')

  const invalidDates = node({ createdAt: 'not-a-date', updatedAt: undefined, status: 'failed' })
  assert.deepEqual(treeNodeClock(invalidDates, new Set()), {
    runtimeEpoch: null,
    stoppedAt: null,
    runMs: 0,
    running: false,
    terminal: true,
    endedWithApp: false,
  }, 'unreadable timestamps escaped as numeric clock facts')
})

/* A SESSION THAT DIES WHILE THE APP KEEPS RUNNING.
 *
 * Membership in the caller's collection never expires: an id goes in at start
 * and comes out only when an end is confirmed. Measured in
 * agent-spawn-records.jsonl (tail 1500, records dated 2026-09-18/19): 456
 * lines, 185 agent_session_start, 185 agent_session_outcome, 86
 * agent_session_end. Ninety-nine started sessions never recorded an end, and
 * each of those read busy for the rest of the app run.
 *
 * These drive the rule with values and a clock, never a spelling. */
const SESSION = 'session-this-run'
const owned = () => new Map([[SESSION, 'node-1']])
const NOW = 1_800_000_000_000

test('a session that has gone quiet past the window is not live, however long the app has been up', () => {
  const current = node()
  const fresh = { seenAt: new Map([[SESSION, NOW - 1_000]]), now: NOW, staleAfterMs: 90_000 }
  const quiet = { seenAt: new Map([[SESSION, NOW - 90_001]]), now: NOW, staleAfterMs: 90_000 }

  assert.equal(sessionIsLive(current, owned(), fresh), true,
    'a session that answered a second ago is live')
  assert.equal(sessionIsLive(current, owned(), quiet), false,
    'a session still in the collection but silent past the window must stop counting as live')

  /* The whole complaint, in one line: the circle stops reading busy. */
  assert.equal(nodeIsBusy(current, owned(), fresh), true)
  assert.equal(nodeIsBusy(current, owned(), quiet), false,
    'a session that died without an end record kept the circle busy forever')

  /* And it reads as what it actually is, which is the state the remedy path
     acts on -- not as `finished`, which would claim a turn completed. */
  assert.equal(sessionEndedWithApp(current, owned(), quiet), true)
  assert.equal(sessionEndedWithApp(current, owned(), fresh), false)
})

test('the boundary is the window itself, and the default is used when none is given', () => {
  const current = node()
  const at = age => ({ seenAt: new Map([[SESSION, NOW - age]]), now: NOW, staleAfterMs: 90_000 })
  assert.equal(sessionIsLive(current, owned(), at(90_000)), true, 'exactly at the window is still live')
  assert.equal(sessionIsLive(current, owned(), at(90_001)), false, 'one millisecond past it is not')

  /* No staleAfterMs supplied: the module's own default decides, and it is a
     real number of milliseconds rather than something that never expires. */
  assert.ok(Number.isFinite(DEFAULT_STALE_AFTER_MS) && DEFAULT_STALE_AFTER_MS > 0)
  const byDefault = age => ({ seenAt: new Map([[SESSION, NOW - age]]), now: NOW })
  assert.equal(sessionIsLive(current, owned(), byDefault(DEFAULT_STALE_AFTER_MS - 1)), true)
  assert.equal(sessionIsLive(current, owned(), byDefault(DEFAULT_STALE_AFTER_MS + 1)), false)
})

test('absent evidence still means live, so a caller that records nothing is never told its sessions died', () => {
  const current = node()
  assert.equal(sessionIsLive(current, owned(), null), true, 'no evidence source at all')
  assert.equal(sessionIsLive(current, owned(), {}), true, 'an evidence object with no seenAt')
  assert.equal(sessionIsLive(current, owned(), { seenAt: new Map(), now: NOW }), true,
    'a lookup that has no stamp for THIS session has not started recording for it')
  assert.equal(sessionIsLive(current, owned(), { seenAt: new Map([[SESSION, 'soon']]), now: NOW }), true,
    'an unreadable stamp is not evidence of silence')

  /* A clock that ran backwards is not silence either. Marking a live session
     dead because the machine's clock moved is the wrong direction to fail. */
  assert.equal(sessionIsLive(current, owned(), { seenAt: new Map([[SESSION, NOW + 60_000]]), now: NOW }), true,
    'a stamp from the future must not read as stale')

  /* And absence of MEMBERSHIP still wins regardless of a fresh stamp: a
     session this run never owned is not live because it answered. */
  assert.equal(sessionIsLive(current, new Set(), { seenAt: new Map([[SESSION, NOW]]), now: NOW }), false)
})

test('sessionEvidenceIsStale answers for a bare session id, so a remedy can name the quiet one', () => {
  assert.equal(sessionEvidenceIsStale(SESSION, { seenAt: new Map([[SESSION, NOW - 90_001]]), now: NOW, staleAfterMs: 90_000 }), true)
  assert.equal(sessionEvidenceIsStale(SESSION, { seenAt: new Map([[SESSION, NOW - 1]]), now: NOW, staleAfterMs: 90_000 }), false)
  assert.equal(sessionEvidenceIsStale(SESSION, null), false, 'no evidence is not staleness')
  assert.equal(sessionEvidenceIsStale('never-seen', { seenAt: new Map(), now: NOW }), false)
})

test('the clock stops over a session that went quiet, instead of ticking on the canvas', () => {
  const current = node()
  const quiet = { seenAt: new Map([[SESSION, NOW - 600_000]]), now: NOW, staleAfterMs: 90_000 }
  const live = treeNodeClock(current, owned(), { seenAt: new Map([[SESSION, NOW]]), now: NOW })
  const dead = treeNodeClock(current, owned(), quiet)

  assert.equal(live.running, true)
  assert.equal(live.endedWithApp, false)
  assert.equal(dead.running, false, 'a clock over a silent session was still counting up')
  assert.equal(dead.endedWithApp, true)
  assert.equal(dead.terminal, false, 'a session that went quiet did not finish its turn, and must not claim it did')
  assert.notEqual(dead.stoppedAt, null, 'a stopped clock needs the instant it stopped, or it cannot be drawn')
})
