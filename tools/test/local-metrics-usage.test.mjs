/* WHAT THE METRICS PAGE MAY SAY ABOUT TOKENS, now that this computer keeps a
 * record of them.
 *
 * The panels under test used to print one sentence: that this product never
 * sees a token count. That was true of the RECORD and false of the PRODUCT --
 * both engines report usage per turn, the main process has always had it, and
 * nothing wrote it down. shell/usage-record.cjs writes it down; these are the
 * rules for reading it back, and every one of them is about not turning a
 * measured figure into a claim.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  LOCAL_USAGE_COPY,
  UNMEASURED,
  describeLocalMetrics,
  readLocalUsage,
  usageByAccount,
  usageByAgent,
  usageByDay,
  usageByProvider,
  usageByRun,
  usageTotals,
} from '../../src/local-metrics.js'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/* A reply in the exact shape mc-agent:usage returns -- entries newest first,
   each carrying the bounded `usage` object the writer admits. */
function reply(turns, { verified = true, ok = true, total = null } = {}) {
  const entries = turns.map((turn, index) => ({
    sequence: turns.length - index,
    at: new Date(turn.atMs).toISOString(),
    action: 'agent_turn_usage',
    principal: 'unauthenticated',
    sessionId: turn.sessionId,
    outcome: null,
    usage: {
      turnId: turn.turnId || `turn-${index}`,
      tier: turn.tier === undefined ? 'luna' : turn.tier,
      account: turn.account === undefined ? null : turn.account,
      status: turn.status === undefined ? 'completed' : turn.status,
      /* Absent on every line written before the writer kept the field, which is
         why the default is null rather than a string: "the record does not say
         why" has to remain reachable by value. */
      failure: turn.failure === undefined ? null : turn.failure,
      basis: turn.basis || 'turn',
      /* Absent on every line written before the writer kept it -- which is every
         line on the owner's machine today -- so the default is null and the
         reader's fallback path stays the one most of the record takes. */
      inputBasis: turn.inputBasis ?? null,
      inputTokens: turn.inputTokens ?? null,
      cachedInputTokens: turn.cachedInputTokens ?? null,
      cacheCreationInputTokens: turn.cacheCreationInputTokens ?? null,
      outputTokens: turn.outputTokens ?? null,
      reasoningOutputTokens: turn.reasoningOutputTokens ?? null,
      totalTokens: turn.totalTokens ?? null,
      contextWindow: turn.contextWindow ?? null,
      sessionTotalTokens: turn.sessionTotalTokens ?? null,
    },
  }))
  return { ok, total: total ?? entries.length, verified, entries }
}

const agentWith = (value) => ({ usage: async () => value, history: async () => ({ ok: true, total: 0, entries: [], verified: true }) })

/* ------------------------------------------------------------------
   THE THREE ABSENCES, WHICH ARE NOT ONE ABSENCE.
   ------------------------------------------------------------------ */

test('a plain web browser is told there is no computer here keeping a record', async () => {
  const reading = await readLocalUsage({ agent: undefined })
  assert.equal(reading.supported, false)
  assert.equal(usageTotals(reading).absence, LOCAL_USAGE_COPY.noChannel)
})

test('a build older than the usage channel says THAT, not that the record is broken', async () => {
  const reading = await readLocalUsage({ agent: { history: async () => ({ ok: true }) } })
  assert.equal(reading.supported, false)
  assert.equal(reading.tooOld, true)
  assert.equal(usageTotals(reading).absence, LOCAL_USAGE_COPY.noUsageChannel)
})

test('a record that will not open is a fault and says so', async () => {
  const reading = await readLocalUsage({ agent: agentWith({ ok: false, code: 'SPAWN_RECORD_UNAVAILABLE' }) })
  assert.equal(reading.supported, true)
  assert.equal(reading.readable, false)
  assert.equal(usageTotals(reading).absence, LOCAL_USAGE_COPY.unreadable)
})

test('an empty record is the ordinary first-day state, never a zero', async () => {
  const reading = await readLocalUsage({ agent: agentWith(reply([])) })
  const totals = usageTotals(reading)
  assert.equal(totals.ok, false)
  assert.equal(totals.absence, LOCAL_USAGE_COPY.empty)
  /* THE DEFECT THIS PINS. A page that printed 0 here would be claiming the
     turns on this computer cost nothing, which is a different statement from
     "no turn has reported a figure yet". */
  assert.equal(totals.tokens, null)
})

/* ------------------------------------------------------------------
   THE FIGURES.
   ------------------------------------------------------------------ */

test('turn figures are summed, and the engine is never credited with arithmetic it did not do', async () => {
  const now = Date.UTC(2026, 7, 18, 12)
  const reading = await readLocalUsage({
    agent: agentWith(reply([
      { atMs: now - HOUR, sessionId: 'chat-1', inputTokens: 4000, outputTokens: 200, totalTokens: 4200 },
      { atMs: now - 2 * HOUR, sessionId: 'chat-1', inputTokens: 1000, outputTokens: 100, totalTokens: 1100 },
    ])),
  })
  const totals = usageTotals(reading)
  assert.equal(totals.ok, true)
  assert.equal(totals.turns, 2)
  assert.equal(totals.tokens.total, 5300)
  assert.equal(totals.tokens.input, 5000)
  assert.equal(totals.tokens.output, 300)
  assert.equal(totals.derivedTotals, 0, 'both turns reported their own total')
})

test('a turn that reported no total has one derived from its own parts, and the page is told how many', async () => {
  const now = Date.UTC(2026, 7, 18, 12)
  const reading = await readLocalUsage({
    agent: agentWith(reply([
      { atMs: now - HOUR, sessionId: 'chat-1', tier: 'claude-sonnet', inputTokens: 6, outputTokens: 412, cacheCreationInputTokens: 18000, cachedInputTokens: 32000 },
    ])),
  })
  const totals = usageTotals(reading)
  /* THE FIGURE THIS ASSERTION USED TO PIN WAS 418 -- "the input and output the
     engine reported, and nothing else" -- which threw away the 50,000 tokens
     beside them. 32,000 cached reads cannot be a part of a 6-token input figure,
     so they are not inside it and they are not free. See turnTotalOf(). */
  assert.equal(totals.tokens.total, 50_418)
  assert.equal(totals.derivedTotals, 1)
  assert.equal(totals.tokens.cacheCreation, 18000)
  assert.equal(totals.tokens.cachedInput, 32000)
})

/* ------------------------------------------------------------------
   WHAT A CACHED READ COSTS, AND WHAT AN UNCOMPUTABLE TOTAL SAYS.

   MEASURED 2026-09-03 over the whole of
   <state>/agent-turn-usage-records.jsonl on the owner's own machine: 488 rows,
   403 of them reporting no total at all. This page showed 3,668,392 tokens for
   those turns; the figures the engine reported for them sum to 857,520,354. The
   difference is every token the provider served from its cache, priced at zero
   because `input + output` was written for codex's dialect, where the cached
   reading is INSIDE the input figure, and applied to Anthropic's, where it is
   beside it.

   The turn objects below are copied field for field from real lines in that
   file, not composed for the test.
   ------------------------------------------------------------------ */

/* Sequence 4 of the owner's ledger, verbatim. */
const REAL_CLAUDE_TURN = Object.freeze({
  sessionId: 'chat-744d7a70-ff51-480d-a58e-deca17f05741',
  tier: 'claude-sonnet',
  status: 'success',
  inputTokens: 6,
  cachedInputTokens: 64_647,
  cacheCreationInputTokens: 29_716,
  outputTokens: 1_314,
  reasoningOutputTokens: null,
  totalTokens: null,
  contextWindow: null,
})

/* Sequence 1 of the same file, verbatim -- the other dialect, where the engine
   totalled the turn itself and its cached reading is part of its input. */
const REAL_CODEX_TURN = Object.freeze({
  sessionId: 'chat-967ac622-ff38-47a5-914a-cbfb6deb6852',
  tier: 'sol',
  status: 'completed',
  inputTokens: 32_839,
  cachedInputTokens: 31_488,
  cacheCreationInputTokens: 0,
  outputTokens: 523,
  reasoningOutputTokens: 465,
  totalTokens: 33_362,
  contextWindow: 258_400,
})

test('a cached read is part of what a turn used, not a token served for free', async () => {
  const now = Date.UTC(2026, 8, 3, 12)
  const reading = await readLocalUsage({ agent: agentWith(reply([{ atMs: now - HOUR, ...REAL_CLAUDE_TURN }])) })
  const turn = reading.turns[0]
  /* 6 + 64,647 + 29,716 + 1,314. The old rule answered 1,320 for this line. */
  assert.equal(turn.totalTokens, 95_683)
  assert.equal(turn.derivedTotal, true)
  assert.equal(turn.unknownTotal, false)
  assert.equal(turn.cacheCounted, true)
  const totals = usageTotals(reading)
  assert.equal(totals.tokens.total, 95_683)
  assert.equal(totals.cacheCountedTurns, 1)
  assert.ok(totals.cacheSentence.includes('cache'), 'the page says the figure includes the cache')
})

test('a cached read that its engine already counted inside the input figure is not counted twice', async () => {
  const now = Date.UTC(2026, 8, 3, 12)
  const reading = await readLocalUsage({ agent: agentWith(reply([{ atMs: now - HOUR, ...REAL_CODEX_TURN }])) })
  const turn = reading.turns[0]
  /* The engine totalled this one itself: 32,839 + 523. Adding its 31,488 cached
     reads on top would report 64,850 for a turn the engine says was 33,362. */
  assert.equal(turn.totalTokens, 33_362)
  assert.equal(turn.reportedTotal, true)
  assert.equal(turn.cacheCounted, false)
  assert.equal(usageTotals(reading).tokens.total, 33_362)
})

test('a turn whose engine says its input figure already holds the cache is not inflated by it', async () => {
  const now = Date.UTC(2026, 8, 3, 12)
  const reading = await readLocalUsage({
    agent: agentWith(reply([
      /* Same shape as a codex turn, minus the total the engine usually sends --
         so the composition, not the reported figure, is what settles it. */
      { atMs: now - HOUR, tier: 'sol', sessionId: 'chat-1', inputBasis: 'includes-cache', inputTokens: 32_839, cachedInputTokens: 31_488, outputTokens: 523 },
    ])),
  })
  assert.equal(reading.turns[0].totalTokens, 33_362)
  assert.equal(reading.turns[0].derivedTotal, true)
})

/* A first turn against a cold cache: the cache write is real and SMALLER than
   the input figure, so nothing in the record proves whether it is inside it.
   Common, and the one shape the arithmetic cannot settle. */
const AMBIGUOUS_TURN = Object.freeze({
  sessionId: 'chat-cold', tier: 'claude-opus', status: 'success',
  inputTokens: 12_000, cachedInputTokens: 0, cacheCreationInputTokens: 3_000, outputTokens: 400, totalTokens: null,
})

test('a total this record cannot compute is unknown, and unknown is never printed as zero', async () => {
  const now = Date.UTC(2026, 8, 3, 12)
  const reading = await readLocalUsage({ agent: agentWith(reply([{ atMs: now - HOUR, ...AMBIGUOUS_TURN }])) })
  const turn = reading.turns[0]
  assert.equal(turn.totalTokens, null, 'no number is invented for a composition the record does not state')
  assert.equal(turn.unknownTotal, true)
  assert.equal(turn.derivedTotal, false)

  const totals = usageTotals(reading)
  /* THE DEFECT THIS PINS. `?? 0` here said this turn used nothing, which is a
     claim; the record makes none. */
  assert.equal(totals.tokens.total, null)
  assert.equal(totals.unknownTurns, 1)
  assert.ok(totals.unknownSentence.includes('rather than counted as nothing'))
  /* The parts the engine DID report are still reported. Unknown is unknown
     about the total, not about the reading. */
  assert.equal(totals.tokens.input, 12_000)
  assert.equal(totals.tokens.cacheCreation, 3_000)

  const runs = usageByRun(reading)
  assert.equal(runs.rows[0].tokens, null, 'the run line says nothing rather than 0')
  assert.equal(runs.rows[0].turns, 1, 'the turn still happened and is still counted')
  assert.equal(runs.rows[0].unknownTurns, 1)

  const providers = usageByProvider(reading)
  assert.equal(providers.rows[0].tokens, null)
  assert.equal(providers.rows[0].unknownTurns, 1)
  assert.equal(providers.rows[0].share, null, 'no share of a total nothing is known about')
})

test('the same turn is computed exactly once a shell records which composition it used', async () => {
  const now = Date.UTC(2026, 8, 3, 12)
  const reading = await readLocalUsage({
    agent: agentWith(reply([{ atMs: now - HOUR, ...AMBIGUOUS_TURN, inputBasis: 'excludes-cache' }])),
  })
  assert.equal(reading.turns[0].totalTokens, 15_400)
  assert.equal(reading.turns[0].unknownTotal, false)
  assert.equal(usageTotals(reading).unknownTurns, 0)
})

test('a known turn beside an unknown one is still added up, and the unknown one is still said', async () => {
  const now = Date.UTC(2026, 8, 3, 12)
  const reading = await readLocalUsage({
    agent: agentWith(reply([
      { atMs: now - HOUR, ...REAL_CLAUDE_TURN, sessionId: 'chat-known' },
      { atMs: now - 2 * HOUR, ...AMBIGUOUS_TURN, sessionId: 'chat-unknown' },
    ])),
  })
  const totals = usageTotals(reading)
  assert.equal(totals.tokens.total, 95_683, 'the turn that can be added is added')
  assert.equal(totals.unknownTurns, 1)
  const runs = usageByRun(reading)
  const rows = new Map(runs.rows.map(row => [row.sessionId, row.tokens]))
  assert.equal(rows.get('chat-known'), 95_683)
  assert.equal(rows.get('chat-unknown'), null)
})

test('a turn with no cache figure at all is added up exactly as it always was', async () => {
  const now = Date.UTC(2026, 8, 3, 12)
  const reading = await readLocalUsage({
    agent: agentWith(reply([
      { atMs: now - HOUR, sessionId: 'chat-1', tier: 'claude-opus', inputTokens: 900, outputTokens: 100 },
    ])),
  })
  assert.equal(reading.turns[0].totalTokens, 1_000)
  assert.equal(reading.turns[0].derivedTotal, true)
  assert.equal(usageTotals(reading).unknownTurns, 0)
})

test('reasoning tokens are never added on top of the output they are part of', async () => {
  const now = Date.UTC(2026, 8, 3, 12)
  const reading = await readLocalUsage({
    agent: agentWith(reply([
      /* Codex reports its reasoning as part of its output: 465 of these 523.
         Adding it would report 988 for a turn that wrote 523. */
      { atMs: now - HOUR, sessionId: 'chat-1', tier: 'sol', inputTokens: 1_000, outputTokens: 523, reasoningOutputTokens: 465 },
    ])),
  })
  assert.equal(reading.turns[0].totalTokens, 1_523)
})

test('a cumulative reading is taken ONCE per session, never added up per turn', async () => {
  const now = Date.UTC(2026, 7, 18, 12)
  const reading = await readLocalUsage({
    agent: agentWith(reply([
      { atMs: now - HOUR, sessionId: 'chat-1', basis: 'session-total', totalTokens: 900 },
      { atMs: now - 2 * HOUR, sessionId: 'chat-1', basis: 'session-total', totalTokens: 500 },
      { atMs: now - 3 * HOUR, sessionId: 'chat-1', basis: 'session-total', totalTokens: 100 },
    ])),
  })
  /* Adding these would print 1,500 for a session the engine says spent 900. */
  assert.equal(usageTotals(reading).tokens.total, 900)
})

/* ------------------------------------------------------------------
   THE FOUR GROUPINGS THE PAGE DRAWS.
   ------------------------------------------------------------------ */

test('per provider, from the model row each session was started under', async () => {
  const now = Date.UTC(2026, 7, 18, 12)
  const reading = await readLocalUsage({
    agent: agentWith(reply([
      { atMs: now - HOUR, sessionId: 'chat-1', tier: 'luna', totalTokens: 4000 },
      { atMs: now - 2 * HOUR, sessionId: 'chat-2', tier: 'claude-sonnet', totalTokens: 1000 },
      { atMs: now - 3 * HOUR, sessionId: 'chat-3', tier: null, totalTokens: 500 },
    ])),
  })
  const rows = usageByProvider(reading)
  assert.equal(rows.ok, true)
  assert.deepEqual(rows.rows.map(row => [row.key, row.tokens]), [
    ['codex', 4000],
    ['claude', 1000],
    ['unrecorded', 500],
  ])
  assert.equal(rows.rows[0].label, 'Codex')
  assert.equal(rows.rows[2].label, LOCAL_USAGE_COPY.providerUnrecorded)
})

test('per run, newest first, with what the run was asked when the page knows it', async () => {
  const now = Date.UTC(2026, 7, 18, 12)
  const reading = await readLocalUsage({
    agent: agentWith(reply([
      { atMs: now - HOUR, sessionId: 'chat-1', totalTokens: 4000 },
      { atMs: now - 2 * HOUR, sessionId: 'chat-1', totalTokens: 200 },
      { atMs: now - 3 * HOUR, sessionId: 'chat-2', totalTokens: 900 },
    ])),
  })
  const conversations = new Map([['chat-1', { role: 'planner', asked: 'read the file' }]])
  const rows = usageByRun(reading, { conversations })
  assert.equal(rows.rows.length, 2)
  assert.equal(rows.rows[0].sessionId, 'chat-1')
  assert.equal(rows.rows[0].tokens, 4200)
  assert.equal(rows.rows[0].turns, 2)
  assert.equal(rows.rows[0].asked, 'read the file')
  assert.equal(rows.rows[1].asked, '', 'a run the page has no conversation for renders without one')
})

/* PER SIGN-IN, WHICH HAD NO COVERAGE ON THIS SIDE OF THE CHANNEL AT ALL.
   tools/test/usage-record.test.mjs walks the shape the WRITER admits; nothing
   walked what the page then does with the name. The panel this feeds is the one
   a person opens to ask "which of my sign-ins is this costing", so a wrong
   grouping here is the whole answer being wrong. */
test('per sign-in, under the name the account list stores, however it is spelt', async () => {
  const now = Date.UTC(2026, 8, 19, 12)
  /* Names shell/account-registry.cjs add() admits: it trims, cuts at
     MAX_NAME_LENGTH and refuses only an empty name, so a space, a bracket and a
     letter outside ASCII are all ordinary. Folding any of them into the
     "does not say" row would tell a person their own sign-in was not recorded. */
  const reading = await readLocalUsage({
    agent: agentWith(reply([
      { atMs: now - HOUR, sessionId: 'chat-1', account: 'work - october', totalTokens: 4000 },
      { atMs: now - 2 * HOUR, sessionId: 'chat-2', account: 'personal (old)', totalTokens: 900 },
      { atMs: now - 3 * HOUR, sessionId: 'chat-3', account: 'счёт', totalTokens: 300 },
      { atMs: now - 4 * HOUR, sessionId: 'chat-4', account: null, totalTokens: 100 },
    ])),
  })
  const rows = usageByAccount(reading)
  assert.equal(rows.ok, true)
  assert.deepEqual(rows.rows.map(row => [row.label, row.tokens]), [
    ['work - october', 4000],
    ['personal (old)', 900],
    ['счёт', 300],
    [LOCAL_USAGE_COPY.accountUnrecorded, 100],
  ])
  assert.equal(rows.total, 5300, 'every recorded turn is counted, attributed or not')
})

test('a sign-in the record cannot name is said in the sign-in panel’s own words', async () => {
  const now = Date.UTC(2026, 8, 19, 12)
  const reading = await readLocalUsage({
    agent: agentWith(reply([
      { atMs: now - HOUR, sessionId: 'chat-1', tier: null, account: null, totalTokens: 400 },
    ])),
  })
  /* One turn, two panels, two different questions: the model panel does not know
     which model row served and the sign-in panel does not know which sign-in
     did. Answering both with one sentence is how an attribution defect hid
     behind an ordinary absence -- while the account label was bounded to an
     ASCII-identifier shape, every turn on a sign-in with a space in its name
     read exactly like a record that predates the model column. Read from the
     module rather than spelt out here, so a better sentence still passes. */
  const modelLabel = usageByProvider(reading).rows[0].label
  const accountLabel = usageByAccount(reading).rows[0].label
  assert.notEqual(accountLabel, modelLabel)
  assert.match(accountLabel, /sign-in/i, 'the sign-in absence names the thing it could not measure')
  assert.notEqual(accountLabel.trim(), '', 'an absence is never a blank')
  assert.notEqual(accountLabel.trim(), '0', 'an absence is never a zero')
})

test('per agent, and a record that cannot name the agent says so instead of inventing one', async () => {
  const now = Date.UTC(2026, 7, 18, 12)
  const reading = await readLocalUsage({
    agent: agentWith(reply([
      { atMs: now - HOUR, sessionId: 'chat-1', totalTokens: 4000 },
      { atMs: now - 2 * HOUR, sessionId: 'chat-2', totalTokens: 900 },
    ])),
  })
  const named = usageByAgent(reading, { conversations: new Map([['chat-1', { role: 'planner' }]]) })
  assert.deepEqual(named.rows.map(row => [row.label, row.tokens]), [
    ['planner', 4000],
    [LOCAL_USAGE_COPY.agentUnnamed, 900],
  ])
})

test('per day, across the window the activity panel already promises', async () => {
  const now = new Date(2026, 7, 18, 12).getTime()
  const reading = await readLocalUsage({
    agent: agentWith(reply([
      { atMs: now, sessionId: 'chat-1', totalTokens: 400 },
      { atMs: now - DAY, sessionId: 'chat-1', totalTokens: 300 },
      { atMs: now - 30 * DAY, sessionId: 'chat-1', totalTokens: 999 },
    ])),
  })
  const days = usageByDay(reading, now)
  assert.equal(days.days.length, 7)
  assert.equal(days.days[6].tokens, 400, 'today is the last column')
  assert.equal(days.days[5].tokens, 300)
  assert.equal(days.max, 400)
  /* A run older than the window is still in the totals above the chart and is
     simply not in the chart -- the same rule activityGrid already follows. */
  assert.equal(days.windowTokens, 700)
})

/* This machine's own clock, not a fake one: 2026-03-08 is when clocks in this
   zone spring forward (a 23-hour day). A machine whose zone never observes
   daylight saving finds every day here an ordinary 24 hours and the same
   assertions hold there too -- they pin what a correct week of real calendar
   days looks like, not a fact only a shifting clock can supply. */
test('a turn late on a short daylight-saving day is not priced onto the day before it', async () => {
  const now = new Date(2026, 2, 12, 9, 0, 0, 0).getTime() // five days after the change
  const reading = await readLocalUsage({
    agent: agentWith(reply([
      { atMs: new Date(2026, 2, 8, 23, 0, 0, 0).getTime(), sessionId: 'chat-1', totalTokens: 111 },
      { atMs: new Date(2026, 2, 9, 0, 30, 0, 0).getTime(), sessionId: 'chat-1', totalTokens: 222 },
    ])),
  })
  const days = usageByDay(reading, now)
  assert.deepEqual(days.days.map(day => day.dateLabel),
    ['Mar 6', 'Mar 7', 'Mar 8', 'Mar 9', 'Mar 10', 'Mar 11', 'Mar 12'])
  const byLabel = label => days.days.find(day => day.dateLabel === label).tokens
  assert.equal(byLabel('Mar 8'), 111, 'a turn at 23:00 on Mar 8 belongs to Mar 8')
  assert.equal(byLabel('Mar 9'), 222)
  assert.equal(days.windowTokens, 333)
})

/* ------------------------------------------------------------------
   WHAT THE PAGE IS STILL NOT ALLOWED TO CLAIM.
   ------------------------------------------------------------------ */

test('a record that no longer verifies is shown, and said to be a report of the file', async () => {
  const now = Date.UTC(2026, 7, 18, 12)
  const reading = await readLocalUsage({
    agent: agentWith(reply([{ atMs: now, sessionId: 'chat-1', totalTokens: 10 }], { verified: false })),
  })
  assert.equal(usageTotals(reading).verified, false)
  assert.equal(usageTotals(reading).ok, true, 'the turns happened; the page still shows them')
})

test('money is still not measured here, and the token panels do not pretend otherwise', () => {
  /* The product holds no prices and no balances, so no arrangement of token
     counts becomes a cost. This sentence must survive the panels being lit. */
  assert.match(UNMEASURED.pools, /balances/i)
  assert.ok(!/token/i.test(UNMEASURED.pools) || /cost|spend|balance/i.test(UNMEASURED.pools))
})

test('describeLocalMetrics carries the usage reading, so the view decides nothing', async () => {
  const now = Date.UTC(2026, 7, 18, 12)
  const usage = await readLocalUsage({ agent: agentWith(reply([{ atMs: now, sessionId: 'chat-1', totalTokens: 4200 }])) })
  const described = describeLocalMetrics({ supported: true, readable: true, runs: [], started: 0, refused: 0, total: 0 }, { usage, nowMs: now })
  assert.equal(described.usage.totals.tokens.total, 4200)
  assert.equal(described.usage.byProvider.rows[0].key, 'codex')
  assert.equal(described.usage.byDay.days.length, 7)
  assert.ok(described.usage.byRun.rows.length >= 1)
})

/* ------------------------------------------------------------------
   A DEAD TIER SAYS WHY.

   MEASURED 2026-09-03 on the owner's computer: from 01:49:05Z every
   claude-fable turn wrote status "error" with every token figure zero -- five
   in a row -- while claude-opus wrote 160 successes and claude-sonnet 13 in the
   same window on the same install, so the tier was dead and the account was
   not. The provider had said why every time (the Claude CLI ends a refused
   turn with one human sentence, carried on `turn_completed.text`), and the
   only sentence this page had for that shape was the one it prints for a quiet
   week: "No turn reported a token count". A tier that had stopped working
   entirely read as a tier nobody had used.
   ------------------------------------------------------------------ */

const MODEL_REFUSAL = "There's an issue with the selected model (claude-fable-5-1). It may not exist or you may not have access to it."

const deadTier = (now) => reply([
  { atMs: now - HOUR, sessionId: 'chat-a', tier: 'claude-fable', status: 'error', failure: MODEL_REFUSAL, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  { atMs: now - 2 * HOUR, sessionId: 'chat-b', tier: 'claude-fable', status: 'error', failure: MODEL_REFUSAL, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
])

test('a tier whose every turn failed reports how many, which model, and the provider\'s own sentence', async () => {
  const now = Date.parse('2026-09-03T03:30:00.000Z')
  const totals = usageTotals(await readLocalUsage({ agent: agentWith(deadTier(now)) }))
  assert.equal(totals.ok, true)
  assert.equal(totals.failedTurns, 2)
  assert.ok(totals.failureSentence.includes(MODEL_REFUSAL), 'the provider\'s own sentence never reached the page')
  assert.match(totals.failureSentence, /Fable/, 'the sentence does not name the tier that is dead')
  assert.match(totals.failureSentence, /2 recorded turns/)
})

test('a failed turn whose reason the record never kept says so, rather than saying nothing', async () => {
  const now = Date.parse('2026-09-03T03:30:00.000Z')
  const usage = await readLocalUsage({ agent: agentWith(reply([
    { atMs: now - HOUR, sessionId: 'chat-a', tier: 'claude-fable', status: 'error', inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  ])) })
  const totals = usageTotals(usage)
  assert.equal(totals.failedTurns, 1)
  assert.equal(usage.turns[0].failure, null)
  assert.match(totals.failureSentence, /does not say why/, '"could not look" and "not there" are the same answer here')
  assert.ok(!totals.failureSentence.includes('\u201c'), 'a reason was quoted that nothing recorded')
})

test('turns that all succeeded report no failure at all, so nothing paints a good week red', async () => {
  const now = Date.parse('2026-09-03T03:30:00.000Z')
  const totals = usageTotals(await readLocalUsage({ agent: agentWith(reply([
    { atMs: now - HOUR, sessionId: 'chat-a', tier: 'claude-opus', status: 'success', inputTokens: 4, outputTokens: 2618, totalTokens: 2622 },
    { atMs: now - 2 * HOUR, sessionId: 'chat-b', tier: 'luna', status: 'completed', inputTokens: 2, outputTokens: 620, totalTokens: 622 },
  ])) }))
  /* Each engine's own success word, and BOTH are a success: reading
     status === 'completed' would have called every Claude turn a failure. */
  assert.equal(totals.failedTurns, 0)
  assert.equal(totals.failureSentence, null)
})

test('a turn the old record kept no status for is unknown, never counted as a failure', async () => {
  const now = Date.parse('2026-09-03T03:30:00.000Z')
  const totals = usageTotals(await readLocalUsage({ agent: agentWith(reply([
    { atMs: now - HOUR, sessionId: 'chat-a', tier: 'claude-opus', status: null, inputTokens: 4, outputTokens: 100, totalTokens: 104 },
  ])) }))
  assert.equal(totals.failedTurns, 0, 'every line written before the writer kept a status became a problem')
  assert.equal(totals.failureSentence, null)
})

test('two different tiers failing names neither, because a dead tier is a claim about one tier', async () => {
  const now = Date.parse('2026-09-03T03:30:00.000Z')
  const totals = usageTotals(await readLocalUsage({ agent: agentWith(reply([
    { atMs: now - HOUR, sessionId: 'chat-a', tier: 'claude-fable', status: 'error', failure: MODEL_REFUSAL, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    { atMs: now - 2 * HOUR, sessionId: 'chat-b', tier: 'claude-opus', status: 'error', inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  ])) }))
  assert.equal(totals.failedTurns, 2)
  assert.ok(!/ on Fable/.test(totals.failureSentence), 'a person was pointed at one tier while two were failing')
  assert.ok(totals.failureSentence.includes(MODEL_REFUSAL))
})

test('an unreadable record still answers no failures, so an absence never reads as a problem', () => {
  const totals = usageTotals({ supported: true, tooOld: false, readable: false, verified: null, total: 0, turns: [] })
  assert.equal(totals.ok, false)
  assert.equal(totals.failedTurns, 0)
  assert.equal(totals.failureSentence, null)
})

/* THE SENTENCE REACHES THE GLASS. The two token panels both compose their
   window-absence line through usageWindowAbsence(); a reading nothing renders
   is the defect this whole lane is about, one layer up. */
test('the metrics view prefers the failure sentence over the quiet-week sentence', () => {
  const view = readFileSync(new URL('../../src/views/metrics.js', import.meta.url), 'utf8')
  const start = view.indexOf('const usageWindowAbsence')
  assert.ok(start > -1, 'usageWindowAbsence is not where this test thinks it is')
  const body = view.slice(start, view.indexOf('\n  }', start))
  assert.match(body, /totals\.failureSentence/,
    'the window-absence sentence does not read the failure reading, so a dead tier still reads as a quiet week')
  assert.ok(body.indexOf('totals.failureSentence') < body.indexOf('Pick a longer range'),
    'the quiet-week sentence is answered before the reason, so the reason can never be reached')
})
