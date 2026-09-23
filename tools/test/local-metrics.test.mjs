/* THE METRICS PAGE MUST READ THIS COMPUTER, NOT THE COMPUTER IT WAS BUILT ON.
 *
 * THE DEFECT, MEASURED ON THE OWNER'S OWN INSTALL. Every tile on #/metrics read
 * "unavailable · No local agent fleet host detected on this machine.", and he
 * asked whether it was his account. It was not, and no amount of use would ever
 * have changed it: dist/data/metrics.json is written by tools/gen-metrics.mjs at
 * BUILD time out of the builder's own checkout, ships with ok:false and a 1970
 * timestamp, and no process on a customer's machine rewrites it. The page was
 * reporting the absence of something that is never present.
 *
 * WHAT THIS FILE PINS. Two halves, and they fail for different reasons on
 * purpose.
 *
 *   1. src/local-metrics.js as a function. Every reading it can return is walked
 *      for the properties that make the page honest: three different absences
 *      stay three different sentences, an unrecorded outcome is never counted as
 *      a success, no refusal code reaches a person as an identifier, and nothing
 *      it produces carries the refusal that used to be the whole page.
 *
 *   2. The view's contract, as source text -- the style
 *      tools/test/research-view.test.mjs established for exactly this, and which
 *      that file already applies to src/views/metrics.js. A pure module can be
 *      perfect and unreferenced; the original defect was a page reading the
 *      wrong source, so what the page reads is the thing to pin.
 *
 * PROVEN TO FAIL ON THE OLD CODE in a detached worktree at 8efbaa3: half 1
 * cannot resolve the module at all, and half 2's clauses match the projection
 * wiring that shipped.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { readLocalSessions } from '../../src/local-activity.js'
import {
  ACTIVITY_DAYS,
  LOCAL_METRICS_COPY,
  UNMEASURED,
  activityGrid,
  describeLocalMetrics,
  outcomeBreakdown,
  readLocalRuns,
  refusalBreakdown,
  refusalSentenceFor,
  runRows,
  sourceLine,
  statTiles,
} from '../../src/local-metrics.js'

const ROOT = resolve(import.meta.dirname, '..', '..')
const read = path => readFileSync(resolve(ROOT, path), 'utf8')

/* The sentence the whole repair exists to remove. It must not appear in any
   reading this module can produce, in any state, ever again. */
const THE_OLD_REFUSAL = 'No local agent fleet host detected on this machine'

/* An upper-case identifier in front of a person -- the shape src/refusal-copy.js
   and tools/check-plain-language.mjs both exist to keep off the glass. */
const CODE_SHAPED = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/

const NOW = Date.parse('2026-08-18T05:00:00.000Z')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/* A ledger in the shape shell/spawn-record.cjs history() actually returns:
   newest first, a start and its resolving outcome as two separate records. Built
   rather than fixtured so the timestamps can be placed relative to a fixed NOW. */
function ledger(runs, { verified = true, total = null, outcomes = null } = {}) {
  const entries = []
  let sequence = 0
  for (const run of runs) {
    sequence += 1
    const start = sequence
    entries.push({
      sequence: start,
      at: new Date(run.atMs).toISOString(),
      action: 'agent_session_start',
      sessionId: run.sessionId || `chat-${start}`,
      principal: 'account:00000000000000000000000000000000',
    })
    if (run.result) {
      sequence += 1
      entries.push({
        sequence,
        at: new Date(run.atMs + 3000).toISOString(),
        action: 'agent_session_outcome',
        sessionId: run.sessionId || `chat-${start}`,
        principal: 'account:00000000000000000000000000000000',
        outcome: { result: run.result, resolves: start, reason: run.reason ?? null },
      })
    }
  }
  entries.reverse()
  return {
    ok: true,
    total: total ?? sequence,
    entries,
    verified,
    ...(outcomes ? { outcomes } : {}),
  }
}

const sessionsFrom = (runs, options) => readLocalSessions(ledger(runs, options))

/* Nineteen runs across five days, four of them refused with two distinct codes
   and one refusal with no code at all -- the shape of the owner's own record on
   2026-08-18, which is what this page has to be able to draw. */
const REAL_SHAPE = [
  { atMs: NOW - 5 * DAY - 2 * HOUR, result: 'refused', reason: 'AGENT_TIER_NO_LAUNCHER' },
  { atMs: NOW - 5 * DAY - 1 * HOUR, result: 'started' },
  { atMs: NOW - 4 * DAY - 6 * HOUR, result: 'started' },
  { atMs: NOW - 4 * DAY - 5 * HOUR, result: 'refused', reason: 'AGENT_TIER_NO_LAUNCHER' },
  { atMs: NOW - 4 * DAY - 4 * HOUR, result: 'started' },
  { atMs: NOW - 4 * DAY - 4 * HOUR + 60_000, result: 'started' },
  { atMs: NOW - 2 * DAY - 3 * HOUR, result: 'refused', reason: 'AGENT_TOOLS_ALL_DISABLED' },
  { atMs: NOW - 1 * DAY - 2 * HOUR, result: 'started' },
  { atMs: NOW - 3 * HOUR, result: 'started' },
]

/* ------------------------------------------------------------------ reading -- */

test('the record is read through the same three cases the home screen distinguishes', async () => {
  /* No channel at all: a plain browser. There is no computer here keeping a
     record, and saying "could not be read" would be a fault claim about a
     machine that is not in the conversation. */
  const browser = await readLocalRuns({ agent: undefined })
  assert.equal(browser.supported, false)
  assert.equal(sourceLine(browser).absence, LOCAL_METRICS_COPY.noChannel)

  /* A shell without the channel -- an installed copy older than it. There IS a
     computer and this copy cannot read its record. A different sentence. */
  const older = await readLocalRuns({ agent: {} })
  assert.equal(older.supported, true)
  assert.equal(older.readable, false)
  assert.equal(sourceLine(older).absence, LOCAL_METRICS_COPY.unreadable)

  /* The channel is there and threw. Still "could not be read", never a claim
     that nothing has run. */
  const threw = await readLocalRuns({ agent: { history: async () => { throw new Error('boom') } } })
  assert.equal(sourceLine(threw).absence, LOCAL_METRICS_COPY.unreadable)

  /* And the ordinary case, with the request the writer's own cap allows. */
  let asked = null
  const live = await readLocalRuns({
    agent: { history: async request => { asked = request; return ledger(REAL_SHAPE) } },
  })
  assert.equal(asked.limit, 200, 'the read must ask for the largest window the writer allows')
  assert.equal(live.readable, true)
  assert.equal(live.runs.length, REAL_SHAPE.length)
})

test('the three absences are three different sentences, and none of them is the old refusal', () => {
  const absences = [
    sourceLine(readLocalSessions(undefined)).absence,
    sourceLine(readLocalSessions({ ok: false })).absence,
    sourceLine(sessionsFrom([])).absence,
  ]
  assert.equal(new Set(absences).size, 3, 'collapsing these is the defect being repaired')
  for (const sentence of absences) {
    assert.ok(sentence.length > 40, `an absence must be a sentence, not a status: ${sentence}`)
    assert.doesNotMatch(sentence, /No local agent fleet host/)
    assert.doesNotMatch(sentence, /^unavailable/i)
  }
})

/* ------------------------------------------------------------------- tiles -- */

test('the stat strip counts this computer, and every slot keeps its DOM identity', () => {
  const tiles = statTiles(sessionsFrom(REAL_SHAPE), NOW)
  assert.deepEqual(tiles.map(tile => tile.id), ['agents', 'tasks', 'fail', 'tokens', 'ckpt', 'gates'],
    'the six slot ids are the page’s protected stat-strip DOM and may not be renamed')

  const by = id => tiles.find(tile => tile.id === id)
  assert.equal(by('agents').value, 9, 'every start in the record is a run')
  assert.equal(by('tasks').value, 6)
  assert.equal(by('fail').value, 3)
  /* Every one of these runs is inside the window, which is the point of the
     window: seven days is what the panel heading has always promised. */
  assert.equal(by('tokens').value, 9)
  assert.equal(by('ckpt').value, 1, 'only the run three hours ago is inside a day')
  assert.equal(by('gates').value, 5, 'five distinct local days carry a run')

  /* None of the six labels may name the builder's own checkout. "Requests",
     "Open requests" and "Queue" were readings of a BUILD-QUEUE.md and an owner
     request ledger that exist on exactly one machine in the world. */
  for (const tile of tiles) {
    assert.doesNotMatch(tile.label, /request|queue|service/i, `a tile still names the builder’s checkout: ${tile.label}`)
  }
})

/* THREE FIGURES IN A STRIP OF SIX COUNTED A DIFFERENT SET OF RUNS FROM THE
 * OTHER THREE, AND NOTHING ON SCREEN SAID SO.
 *
 * MEASURED on the owner's own record 2026-09-03: 158 runs written, 411 ledger
 * lines, so the 200-line window this page may read held 82 of those runs -- and
 * every one of the 158 was started inside the last seven days. The strip read
 * "Agent runs 158" three tiles above "Last 7 days 82", "Days used 3" for a
 * record covering five days, and "since 2 Sep" for a record beginning 29 Aug.
 * The sentence under it promised "the totals cover all of them".
 *
 * The fixture below is that shape in miniature: a writer's tally of thirty runs
 * over a window carrying nine, every one of the nine inside seven days. */
const SAMPLED = { total: 90, outcomes: { starts: 30, started: 21, refused: 9 } }

test('a figure counted over the window says so, and never wears the whole record’s label', () => {
  const sessions = sessionsFrom(REAL_SHAPE, SAMPLED)
  const tiles = statTiles(sessions, NOW)
  const by = id => tiles.find(tile => tile.id === id)

  /* The three run counts still cover the whole chain -- the tally is what they
     read, and nothing about this repair may narrow them to the window. */
  assert.equal(by('agents').value, 30, 'the run count stopped covering the whole record')
  assert.equal(by('tasks').value, 21)
  assert.equal(by('fail').value, 9)

  /* And the three measured over time say which runs they counted. */
  for (const id of ['tokens', 'ckpt']) {
    assert.equal(by(id).unit, 'of the 9 most recent runs',
      `${by(id).label} presents a count over nine runs as a count over thirty`)
  }
  assert.equal(by('gates').unit, 'across the 9 most recent runs',
    'the days figure presents days seen in the window as days in the record')
  assert.doesNotMatch(by('gates').unit, /since/,
    'the window’s own first run is still stated as the date the record begins')

  /* The sentence under the strip has to agree with the strip. It used to say
     the totals covered every run, beside three tiles that did not. */
  const note = sourceLine(sessions).note
  assert.ok(note, 'a sampled reading must say it is a sample')
  assert.doesNotMatch(note, /the totals cover all of them/,
    'the page still claims every figure covers the whole record')
  assert.match(note, /9 of 30 runs/, 'the sentence lost the size of the sample')
  assert.match(note, /cover all 30/, 'the sentence no longer says which figures cover the record')
  assert.match(note, /cover these 9/, 'the sentence no longer says which figures cover the sample')
})

/* A RECORD THAT FITS INSIDE THE WINDOW IS UNTOUCHED, word for word. The whole
   point of qualifying these three is that the qualification is TRUE; adding it
   where the window holds everything would be a caveat about nothing. */
test('a record the window holds whole keeps the unit lines it has always had', () => {
  const tiles = statTiles(sessionsFrom(REAL_SHAPE), NOW)
  const by = id => tiles.find(tile => tile.id === id)
  assert.equal(by('tokens').unit, 'runs')
  assert.equal(by('ckpt').unit, 'run', 'a unit line still has to read correctly at one')
  assert.match(by('gates').unit, /^since /, 'the record’s own first run is still named when it is known')
  assert.equal(sourceLine(sessionsFrom(REAL_SHAPE)).note, null,
    'a reading that is not a sample must not say it is one')
})

test('a tile with no reading carries the absence and never a zero', () => {
  for (const sessions of [readLocalSessions(undefined), readLocalSessions({ ok: false }), sessionsFrom([])]) {
    for (const tile of statTiles(sessions, NOW)) {
      assert.equal(tile.value, null, 'a zero is a claim; an absence is not')
      assert.equal(tile.unit, null)
      assert.ok(tile.absence, 'every empty tile must be able to say why')
    }
  }
})

/* ---------------------------------------------------------------- activity -- */

test('the activity grid draws real runs by hour, shaded against the busiest real hour', () => {
  const grid = activityGrid(sessionsFrom(REAL_SHAPE), NOW)
  assert.equal(grid.ok, true)
  assert.equal(grid.days.length, ACTIVITY_DAYS)
  assert.equal(grid.days.every(day => day.hours.length === 24), true)
  const drawn = grid.days.reduce((sum, day) => sum + day.hours.reduce((a, b) => a + b, 0), 0)
  assert.equal(drawn, grid.total)
  assert.equal(grid.total, REAL_SHAPE.length, 'every run in the window is on the grid exactly once')
  assert.equal(grid.max, 2, 'the two runs a minute apart share one cell and set the ceiling')
})

test('a record with runs but none this week says so, and does not claim the record is empty', () => {
  const grid = activityGrid(sessionsFrom([{ atMs: NOW - 40 * DAY, result: 'started' }]), NOW)
  assert.equal(grid.ok, false)
  assert.equal(grid.absence, LOCAL_METRICS_COPY.emptyWindow)
  assert.notEqual(grid.absence, LOCAL_METRICS_COPY.empty,
    'a quiet week over a full record must not read as a machine that has never run anything')
  /* The grid itself is still returned so the panel can draw seven empty days
     rather than collapsing to a paragraph that hides the shape of the week. */
  assert.equal(grid.days.length, ACTIVITY_DAYS)
})

/* This machine's own clock, not a fake one: 2026-03-08 is when clocks in this
   zone spring forward (a 23-hour day). A machine whose zone never observes
   daylight saving finds every day here an ordinary 24 hours and the same
   assertions hold there too -- they pin what a correct week of real calendar
   days looks like, not a fact only a shifting clock can supply. */
test('a run late on a short daylight-saving day is not pushed onto the day before it', () => {
  const nowMs = new Date(2026, 2, 12, 9, 0, 0, 0).getTime() // five days after the change
  const runLateOnTheShortDay = { atMs: new Date(2026, 2, 8, 23, 0, 0, 0).getTime(), result: 'started' }
  const grid = activityGrid(sessionsFrom([runLateOnTheShortDay]), nowMs)
  assert.equal(grid.ok, true)
  assert.deepEqual(grid.days.map(day => day.dateLabel),
    ['Mar 6', 'Mar 7', 'Mar 8', 'Mar 9', 'Mar 10', 'Mar 11', 'Mar 12'])
  assert.equal(grid.total, 1)
  const withARun = grid.days.filter(day => day.hours.some(count => count > 0))
  assert.equal(withARun.length, 1)
  assert.equal(withARun[0].dateLabel, 'Mar 8', 'a run at 23:00 on Mar 8 belongs to Mar 8')
})

/* ---------------------------------------------------------------- outcomes -- */

test('an outcome nobody recorded is its own segment and is never counted as a success', () => {
  const sessions = sessionsFrom([
    { atMs: NOW - HOUR, result: 'started' },
    { atMs: NOW - 2 * HOUR, result: 'refused', reason: 'AGENT_TIER_NO_LAUNCHER' },
    { atMs: NOW - 3 * HOUR },
  ])
  const outcomes = outcomeBreakdown(sessions)
  const by = key => outcomes.segments.find(segment => segment.key === key).count
  assert.equal(outcomes.total, 3)
  assert.equal(by('started'), 1)
  assert.equal(by('refused'), 1)
  assert.equal(by('unrecorded'), 1, 'silence read as success is the defect readLocalSessions exists to prevent')
  assert.equal(outcomes.segments.reduce((sum, segment) => sum + segment.count, 0), outcomes.total)
})

test('the whole-chain tally wins over the window it can see, and says the window is a sample', () => {
  const sessions = readLocalSessions({
    ...ledger(REAL_SHAPE, { total: 400, outcomes: { starts: 190, started: 150, refused: 40 } }),
  })
  const outcomes = outcomeBreakdown(sessions)
  assert.equal(outcomes.segments.find(segment => segment.key === 'started').count, 150)
  assert.equal(outcomes.segments.find(segment => segment.key === 'refused').count, 40)
  const source = sourceLine(sessions)
  assert.equal(source.sampled, true)
  assert.match(source.note, /most recent 9 of 190 runs/)
})

/* ---------------------------------------------------------------- refusals -- */

test('a refusal reaches a person as the sentence this product already gives, never as a code', () => {
  const refusals = refusalBreakdown(sessionsFrom(REAL_SHAPE))
  assert.equal(refusals.total, 3)
  assert.deepEqual(refusals.rows.map(row => row.count), [2, 1], 'most common first')
  for (const row of refusals.rows) {
    assert.doesNotMatch(row.sentence, CODE_SHAPED, `a bare identifier reached the page: ${row.sentence}`)
    assert.ok(row.share > 0 && row.share <= 1)
  }
  /* The one the SHORT table has no entry for. Before this module read the agent
     page's fuller table too, a run the owner could have fixed in one click read
     "the record does not say why" -- about a record that said exactly why. */
  assert.match(refusalSentenceFor('AGENT_TOOLS_ALL_DISABLED'), /every tool is switched off/i)
  assert.doesNotMatch(refusalSentenceFor('AGENT_TOOLS_ALL_DISABLED'), CODE_SHAPED)
  /* And a code nobody has written a sentence for gets an honest placeholder
     rather than a guess at the cause. */
  assert.equal(refusalSentenceFor('AGENT_SOMETHING_NOBODY_WROTE'), LOCAL_METRICS_COPY.reasonUnknown)
  assert.equal(refusalSentenceFor(null), LOCAL_METRICS_COPY.reasonUnrecorded)
})

/* EVERY REASON THE SHELL CAN RECORD REACHES A PERSON AS A SENTENCE.
 *
 * refusalSentenceFor() asks the short table, then the agent page's fuller one,
 * and falls back to "The record does not say why". That fallback is honest for a
 * code nobody has written a sentence for -- and a LIE for a code the shell
 * records every day, because it reports an absence about a record that is not
 * absent. This file's own note beside AGENT_TOOLS_ALL_DISABLED records the first
 * time that happened, and src/local-activity.js records two more.
 *
 * MEASURED 2026-09-19 on a private candidate: a refused run carrying
 * OWNER_HOST_MODULE_INVALID was shown on the Metrics Start-issues panel as "The
 * record does not say why" while its own signed record held the code. Reading
 * the family out of the shell instead of trusting the tables then found FIVE of
 * ten OWNER_HOST_* codes with no sentence anywhere.
 *
 * So this asks the SHELL which codes exist rather than listing them here: a list
 * in this file would go stale the moment a new refusal is added, which is the
 * whole failure mode. Each one is then put through the real resolver, by value.
 */
test('every refusal reason the session authority can record has a sentence, not a placeholder', () => {
  const sources = ['shell/capability-layer.cjs', 'shell/agent-host.cjs', 'shell/agent-command-surface.cjs']
  const codes = new Set()
  for (const file of sources) {
    for (const match of read(file).matchAll(/'(OWNER_HOST_[A-Z0-9_]+)'/g)) codes.add(match[1])
  }
  assert.ok(codes.size >= 5, `the shell should record several session-authority refusals; found ${codes.size}`)

  const unnamed = []
  for (const code of codes) {
    const sentence = refusalSentenceFor(code)
    if (sentence === LOCAL_METRICS_COPY.reasonUnknown) unnamed.push(code)
    assert.doesNotMatch(sentence, CODE_SHAPED, `a bare identifier reached the page for ${code}`)
  }
  assert.deepEqual(unnamed, [],
    `these codes are recorded by the shell and read on Metrics as "${LOCAL_METRICS_COPY.reasonUnknown}", which is a claim the record contradicts`)
})

test('nothing refused is a result, not an absence', () => {
  const refusals = refusalBreakdown(sessionsFrom([{ atMs: NOW - HOUR, result: 'started' }]))
  assert.equal(refusals.ok, true)
  assert.equal(refusals.rows.length, 0)
  assert.equal(refusals.sentence, 'The one run recorded here started.')
})

test('the refusal breakdown reports the same whole-chain count the outcomes panel does, and says its groups only cover the window', () => {
  /* MEASURED against the live ledger 2026-09-03: outcomeBreakdown() said "17
     did not start" (the writer's whole-chain tally) while refusalBreakdown(),
     reading only sessions.runs, said "5 runs did not start" -- two different
     answers to one question on one page. This fixture reproduces that shape:
     a whole-chain refused count (40) larger than what the window can name a
     reason for (REAL_SHAPE's 3). */
  const sessions = readLocalSessions({
    ...ledger(REAL_SHAPE, { total: 400, outcomes: { starts: 190, started: 150, refused: 40 } }),
  })
  const outcomes = outcomeBreakdown(sessions)
  const refusals = refusalBreakdown(sessions)
  assert.equal(
    refusals.total,
    outcomes.segments.find(segment => segment.key === 'refused').count,
    'the outcomes panel and the refusals panel must never print two different answers to how many runs refused',
  )
  assert.equal(refusals.total, 40)
  assert.equal(refusals.rows.reduce((sum, row) => sum + row.count, 0), 3,
    'the groups can only name a reason for what the window actually holds')
  assert.equal(refusals.sampled, true)
  assert.equal(refusals.sentence, '40 runs did not start. This page can currently read the reason for 3 of them.')
})

test('a refusal entirely outside the window is never reported as "every run started"', () => {
  /* The zero-rows branch used to say "Every run recorded here started" for ANY
     window with no refused run in it -- true when the whole record agrees, and
     a confident, wrong reassurance when it does not, sitting right below a
     panel already showing a nonzero refused count. */
  const sessions = readLocalSessions({
    ...ledger([{ atMs: NOW - HOUR, result: 'started' }], { total: 50, outcomes: { starts: 20, started: 19, refused: 1 } }),
  })
  const refusals = refusalBreakdown(sessions)
  assert.equal(refusals.rows.length, 0)
  assert.equal(refusals.total, 1)
  assert.equal(refusals.sampled, true)
  assert.doesNotMatch(refusals.sentence, /every run recorded here started/i)
  assert.equal(refusals.sentence, 'One run did not start, but this page cannot currently read why.')
})

/* -------------------------------------------------------------------- runs -- */

test('the run list carries what happened and why, and stays silent about what it does not know', () => {
  const reading = runRows(sessionsFrom(REAL_SHAPE), { nowMs: NOW })
  const rows = reading.rows
  assert.equal(rows[0].result, 'started', 'newest first')
  const refused = rows.find(row => row.result === 'refused')
  assert.equal(refused.resultWord, 'did not start')
  assert.doesNotMatch(refused.why, CODE_SHAPED)
  /* A record the window holds whole: the run list's own headline count must
     still agree with the strip and the outcomes panel, word for value. */
  assert.equal(reading.total, REAL_SHAPE.length)

  const unrecorded = runRows(sessionsFrom([{ atMs: NOW - HOUR }]), { nowMs: NOW }).rows[0]
  assert.equal(unrecorded.result, null)
  assert.equal(unrecorded.resultWord, '', 'a run nobody recorded gets no word at all, never a reassuring one')
  assert.equal(unrecorded.why, '')
})

/* THE RUN TABLE'S OWN HEADLINE COUNTED THE WINDOW AND WORE THE RECORD'S LABEL --
 * THE SAME DEFECT ALREADY REPAIRED THREE TILES OVER, MISSED HERE.
 *
 * MEASURED against the live ledger 2026-09-03: 194 runs in the writer's
 * whole-chain tally, 84 of them inside the 200-line window this page can
 * read. The Agents section read "84 runs recorded on the computer you are
 * driving" directly under the Review verdicts panel, whose own caption --
 * built from the identical "${n} runs recorded on ..." sentence, over
 * outcomeBreakdown()'s corrected total -- said "194" two sections above it.
 * One page, one record, two counts for "how many runs has this computer
 * recorded", the same shape sourceLine()'s and refusalBreakdown()'s own
 * `sampled` repairs exist to prevent.
 *
 * This fixture reproduces that shape: a writer's tally of thirty runs over a
 * window carrying REAL_SHAPE's nine, the same SAMPLED shape the stat-strip
 * test above pins. */
test('the run table’s headline count is the record’s, not the window’s', () => {
  const sessions = sessionsFrom(REAL_SHAPE, SAMPLED)
  const reading = runRows(sessions, { nowMs: NOW })
  /* The rows themselves can only ever be what the window actually holds --
     this reader never invents a row for a run it was not sent. */
  assert.equal(reading.rows.length, REAL_SHAPE.length)
  /* The headline count is the same whole-chain figure the outcomes panel
     reports for the identical record, not the length of the list under it. */
  assert.equal(reading.total, outcomeBreakdown(sessions).total,
    'the run table and the outcomes panel must never print two different answers to how many runs this computer has recorded')
  assert.equal(reading.total, 30)
})

/* ------------------------------------------------------------ the whole page -- */

test('no reading this module can produce carries the refusal that used to be the whole page', () => {
  const states = [
    readLocalSessions(undefined),
    readLocalSessions(null),
    readLocalSessions({ ok: false }),
    sessionsFrom([]),
    sessionsFrom(REAL_SHAPE),
    sessionsFrom(REAL_SHAPE, { verified: false }),
    sessionsFrom([{ atMs: NOW - 40 * DAY, result: 'started' }]),
  ]
  for (const sessions of states) {
    const text = JSON.stringify(describeLocalMetrics(sessions, { nowMs: NOW }))
    assert.doesNotMatch(text, new RegExp(THE_OLD_REFUSAL))
    assert.doesNotMatch(text, /aggregate projection/)
    assert.doesNotMatch(text, /fleet supervisor unavailable/)
  }
})

test('a record that no longer checks out is still shown, and says so', () => {
  const broken = sourceLine(sessionsFrom(REAL_SHAPE, { verified: false }))
  assert.equal(broken.ok, true, 'the runs happened; a failed check is not a refusal to show them')
  assert.equal(broken.verified, false)
  assert.equal(broken.sentence, LOCAL_METRICS_COPY.sourceUnverified)
  assert.notEqual(sourceLine(sessionsFrom(REAL_SHAPE)).sentence, broken.sentence)
})

test('a panel this copy does not measure says so plainly and offers no remedy', () => {
  for (const [name, sentence] of Object.entries(UNMEASURED)) {
    assert.ok(sentence.length > 60, `${name} must explain, not label`)
    assert.doesNotMatch(sentence, /^unavailable/i)
    assert.doesNotMatch(sentence, /No local agent fleet host/)
    assert.doesNotMatch(sentence, CODE_SHAPED)
    /* The rule src/first-run-needs.js sets out at length: a false remedy costs a
       reader an afternoon, and there is no setting that turns any of these on. */
    assert.doesNotMatch(sentence, /turn (it|this) on|in Settings|switch it on/i,
      `${name} offers a remedy that does not exist`)
  }
})

/* ------------------------------------------------------------ the view wiring -- */

test('the metrics page reads this computer’s record, not the build-time projection', () => {
  const view = read('src/views/metrics.js')

  assert.match(view, /from '\.\.\/local-metrics\.js'/, 'the view must read the local record module')
  assert.match(view, /readLocalRuns\(\)/, 'the view must actually ask for the record')
  assert.match(view, /describeLocalMetrics\(sessions, \{ conversations, usage \}\)/)
  /* BOTH records. The turn-usage record is a second signed chain in a second
     file, and a page that asked for only one of them could not tell "no agent
     has run here" apart from "this shell is too old to have recorded what they
     used" -- which is the same conflation the top of this file exists to end. */
  assert.match(view, /readLocalUsage\(\)/)

  /* The six tiles used to be six readings of the builder's own checkout. */
  assert.doesNotMatch(view, /label: 'Codex sessions'/)
  assert.doesNotMatch(view, /label: 'Open requests'/)
  assert.doesNotMatch(view, /field: 'queue'/)

  /* And nine panels used to print one refusal each, through one helper. */
  assert.doesNotMatch(view, /setProjectionUnavailable/,
    'the helper that wrote a projection refusal into nine panels is gone')
  assert.doesNotMatch(view, /aggregate projection has no/,
    'no panel may describe the shape of a file that is absent on every install')
  assert.doesNotMatch(view, /the live totals could not be read/)

  /* The four panels that now draw the record. */
  for (const renderer of ['renderActivity()', 'renderOutcomes()', 'renderRefusals()', 'renderRunTable()']) {
    assert.ok(view.includes(renderer), `the live branch must draw ${renderer}`)
  }
  /* THE FOUR TOKEN PANELS MOVED FROM "not measured" TO MEASURED, and this is
     the assertion that says so. They said, in the product's own voice, that a
     token count never passes through here; both engines report one on every
     turn and nothing wrote it down. shell/usage-record.cjs writes it, and these
     four draw it. */
  for (const renderer of ['renderTokenRouting()', 'renderTokenFlow()', 'renderPools()', 'renderBurn()']) {
    assert.ok(view.includes(renderer), `the live branch must draw ${renderer}`)
  }
  assert.doesNotMatch(view, /UNMEASURED\.tokenRouting/,
    'the token-routing panel no longer describes this product as unable to see a token count')
  assert.doesNotMatch(view, /UNMEASURED\.tokenFlow/)
  assert.doesNotMatch(view, /UNMEASURED\.burn/)

  /* And the two that genuinely are not measured, each said once from the shared
     table so two hand-written versions cannot drift apart. `pools` stays with
     them because MONEY is still not measured here -- it is now printed beside
     the token figures rather than instead of them. */
  assert.match(view, /UNMEASURED\.heartbeat/)
  assert.match(view, /UNMEASURED\.pools/)
  assert.match(view, /UNMEASURED\.gates/)
})

test('the demonstration engine is gone from the page: one render, fed by the source axis', () => {
  const view = read('src/views/metrics.js')
  /* This clause used to slice the live boot branch and assert the
     demonstration's chart engine stayed out of it. There is no branch left to
     slice: the owner's ruling -- "all simulated pages ARE the UI pages, just
     mock data" -- removed the second render, so what is pinned now is
     stronger than the old guard. The demonstration's option builders and the
     simulation itself are not imported AT ALL; the only engine on the page is
     the measured one, whose import graph tools/test/metrics-live-charts.test.mjs
     walks on every run. */
  assert.doesNotMatch(view, /metrics-charts\.js/)
  assert.doesNotMatch(view, /createCharts\b/)
  assert.doesNotMatch(view, /from '\.\.\/sim\.js'/)
  assert.doesNotMatch(view, /\bsim\.on\(/)
  /* dataset.liveMode stays -- the packaged drives read that attribute and the
     one render IS the live render -- but the per-view FLAG and its switch are
     what selected a second page, and those may not return. */
  assert.doesNotMatch(view, /isLiveView|setLiveView|live-flags/,
    'the per-view flag machinery is back; which world shows is the source axis’s decision now')

  /* And the example is the SAME render over the product's own example
     ledgers: the raw sample replies go through the same parsers a bridge
     reply does, so the page downstream cannot tell -- which is why the badge
     is keyed to the resolved source and never to the look of the data. */
  assert.match(view, /resolveDataSource\(/)
  assert.match(view, /sourceIsBadged\(/)
  assert.match(view, /DATA_SOURCE_EVENT/)
  assert.match(view, /sampleSessionsRaw\(/)
  assert.match(view, /sampleUsageRaw\(/)
  assert.match(view, /readLocalRuns\(\{ agent: sample \}\)/,
    'the example record must go through the same run parser as a real reply')
  assert.match(view, /readLocalUsage\(\{ agent: sample \}\)/,
    'the example record must go through the same usage parser as a real reply')
  assert.match(view, /dataset\.face = .*'demonstration' : 'this-computer'/,
    'the face attribute must be stamped from the source axis')
})
