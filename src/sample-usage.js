/* WHAT THE EXAMPLE FLEET'S TURNS USED.
 *
 * The other half of src/sample-activity.js, and it follows that file's rules to
 * the letter. The metrics page's measured face reads two raw host replies: the
 * spawn history (mocked by sampleSessionsRaw) and the turn-usage record this
 * file mocks. Substitution, not suppression -- the demonstration gets a usage
 * record of its own, badged as an example, so the token panels can show their
 * shape without a single real figure reaching an example-badged screen.
 *
 * IT IS BUILT AS A RAW LEDGER REPLY AND PARSED BY readLocalUsage, never
 * hand-assembled in the parsed shape, for the reason sample-activity.js states:
 * the real parser decides what a turn is, marks a derived total as derived, and
 * refuses to sum a running total -- and a hand-built record would drift from
 * those rules the first time they changed. The entry shape below mirrors what
 * shell/usage-record.cjs actually appends: one line per turn, action
 * `agent_turn_usage`, every figure inside the bounded `usage` field.
 *
 * THE JOIN KEYS ARE IMPORTED, NOT MIRRORED. Every sessionId here comes out of
 * sampleSessionsRaw(nowMs) itself -- this module reads that reply's start
 * entries rather than restating the `sample/<agent>/NN` scheme -- so the two
 * halves of the example cannot drift apart: a renamed run over there is a
 * renamed run here on the same render.
 *
 * TIER IDS ARE COPIED LITERALS, ON PURPOSE. A usage row's `tier` resolves
 * against LAUNCH_TIERS in src/orchestration-controls.js (that is how the page
 * names an assistant and a model), but this module keeps its import list to
 * sample-activity.js alone and copies the few ids it needs. The suite pins each
 * literal to the real table, so a renamed tier fails a test instead of quietly
 * rendering as "Not recorded". src/fleet-profile.js is deliberately not
 * consulted: the measured face's import graph is fenced against it
 * (tools/test/metrics-live-charts.test.mjs), and nothing it declares is the
 * shape this record carries anyway.
 *
 * DETERMINISTIC ON PURPOSE. No Math.random and no persisted state: every
 * timestamp is derived from nowMs and fixed tables, so the same nowMs produces
 * the same reply every render, and a screenshot stays comparable to the next.
 */

import { sampleSessionsRaw, liveSessionIds } from './sample-activity.js'

/* Which assistant tier each example agent runs on. The ids are LAUNCH_TIERS
 * ids (src/orchestration-controls.js), copied as literals -- see the header --
 * and chosen to spread the example across all three providers that table
 * declares: codex (luna / terra / sol), claude (sonnet / fable), and a model on
 * the computer you are driving (local). */
const TIER_FOR_AGENT = Object.freeze({
  'codex': 'luna',
  'claude': 'claude-sonnet',
  'luna-02': 'luna',
  'terra-01': 'terra',
  'shadow-mgr': 'sol',
  'gem-lane-1': 'local',
  'gem-lane-2': 'local',
  'gem-lane-3': 'local',
  'terra-02': 'claude-fable',
})

/* Which sign-in a tier's turns bill to. `local` is null on purpose: a model on
 * the GPU in the computer you are driving has no sign-in, and the record
 * honestly not saying one is a row the routing panel draws in its own right.
 * Shapes bounded the way the `account` row of USAGE_STRING_FIELDS in
 * shell/spawn-record.cjs bounds a real one. */
const ACCOUNT_FOR_TIER = Object.freeze({
  'luna': 'sample-codex-seat',
  'terra': 'sample-codex-seat',
  'sol': 'sample-codex-seat',
  'claude-sonnet': 'sample-claude-seat',
  'claude-fable': 'sample-claude-seat',
  'local': null,
})

/* Base figures per tier, before the per-turn variety below. Null is "this
 * engine does not report that figure" -- the claude rows carry cache-creation
 * and no reasoning split, the codex rows the reverse, the local row almost
 * nothing -- so the panels exercise the absent-is-not-zero rule with data. */
const FIGURES_FOR_TIER = Object.freeze({
  'luna': Object.freeze({ inputTokens: 1900, cachedInputTokens: 750, cacheCreationInputTokens: null, outputTokens: 720, reasoningOutputTokens: 340, contextWindow: 272000 }),
  'terra': Object.freeze({ inputTokens: 3400, cachedInputTokens: 1200, cacheCreationInputTokens: null, outputTokens: 1150, reasoningOutputTokens: 880, contextWindow: 272000 }),
  'sol': Object.freeze({ inputTokens: 5200, cachedInputTokens: 2400, cacheCreationInputTokens: null, outputTokens: 1600, reasoningOutputTokens: 1550, contextWindow: 400000 }),
  'claude-sonnet': Object.freeze({ inputTokens: 2600, cachedInputTokens: 1500, cacheCreationInputTokens: 420, outputTokens: 880, reasoningOutputTokens: null, contextWindow: 200000 }),
  'claude-fable': Object.freeze({ inputTokens: 4100, cachedInputTokens: 2100, cacheCreationInputTokens: 610, outputTokens: 1300, reasoningOutputTokens: null, contextWindow: 200000 }),
  'local': Object.freeze({ inputTokens: 900, cachedInputTokens: null, cacheCreationInputTokens: null, outputTokens: 380, reasoningOutputTokens: null, contextWindow: 32768 }),
})

/* How many turns each run answered, cycled by run index. Uneven on purpose,
 * for the reason sample-activity.js gives about its own gaps: evenly sized
 * sessions look generated. */
const TURNS_BY_ROW = Object.freeze([3, 2, 4, 1, 2, 3, 2])

/* Minutes after a run's start that each of its turns finished. The newest run
 * starts 14 minutes ago, so the largest offset stays inside it. */
const OFFSET_MINUTES = Object.freeze([2, 5, 9, 12])

/* Per-turn variety, in percent, cycled so no two sessions repeat a rhythm.
 * Fixed table rather than arithmetic noise: deterministic, and uneven enough
 * that the bands read as work rather than as a waveform. */
const SCALE_PERCENT = Object.freeze([100, 62, 145, 80, 190, 55, 115, 70, 130])

/* THE DELIBERATE IRREGULARS, each a state the real record produces and the
 * panels must keep telling apart.
 *
 * DERIVED_AT: this one turn reports no totalTokens, so readLocalUsage derives
 * its figure from input + output and flags it, and the totals panel prints the
 * "reported no total" sentence over real data.
 *
 * UNRECORDED_TIER_AT: every turn of this run (the terra-02 run whose OUTCOME was
 * also never recorded, fittingly) carries no tier and no account, so the
 * provider, model and sign-in groupings each draw their honest "Not recorded"
 * row.
 *
 * CUMULATIVE_ONLY_AT: this run's engine reported only a running total, so its
 * single row is basis `session-total` -- counted once in the totals by the
 * collapse rule, and counted OUT of every time series, which is the rule
 * usageByDay and turnsInWindow both state at length. */
const DERIVED_AT = Object.freeze({ run: 2, turn: 1 })
const UNRECORDED_TIER_AT = 6
const CUMULATIVE_ONLY_AT = 15
/* Two turns' worth of the terra profile, as the running total that session's
 * engine reported. A literal, so the arithmetic above cannot quietly turn a
 * check on the collapse rule into a function of it. */
const CUMULATIVE_TOTAL = 13260

const iso = (ms) => new Date(ms).toISOString()

const scaled = (value, percent) => (value === null ? null : Math.round((value * percent) / 100))

/**
 * A raw usage-ledger reply describing what the example fleet's turns used, in
 * exactly the shape `readLocalUsage` parses (the reply shell/usage-record.cjs
 * usage() returns). Pass it through that function; do not read these fields
 * directly.
 */
export function sampleUsageRaw(nowMs = Date.now()) {
  const sessions = sampleSessionsRaw(nowMs)

  /* THE LIVE HEAD FILES NO USAGE, and that is the truthful reading rather than a
     convenience. Usage is recorded when a turn finishes; the head runs started
     inside the last few slots and the newest is still in flight. Their turn
     times here are the run start plus a FIXED offset table (2, 5, 9, 12
     minutes), so a run that began forty seconds ago would file rows dated
     minutes into the future -- which is what
     "turn sample-turn-01-3 is timestamped in the future" was reporting.

     Skipping the whole run rather than the un-elapsed turns inside it: a first
     attempt dropped individual turns and turned one failing assertion into
     three, because a partially-filed run changes the totals every metrics and
     irregulars check in this suite is written against. A run either has filed
     its usage or it has not. */
  const live = liveSessionIds(nowMs)

  /* Rejoin outcomes to starts the way readLocalSessions does, to find the runs
   * that were REFUSED: a refused run never answered, so it used nothing, and a
   * usage row for it would be the record contradicting itself. Derived from the
   * reply rather than from a copied index list, so a re-cast refusal over in
   * sample-activity.js moves the gap here on the same render. */
  const refusedStarts = new Set()
  for (const entry of sessions.entries) {
    if (entry.action !== 'agent_session_outcome') continue
    if (entry.outcome && entry.outcome.result === 'refused') refusedStarts.add(entry.outcome.resolves)
  }
  /* THE LIVE HEAD IS EXCLUDED HERE, BEFORE ANYTHING IS INDEXED, and the ordering
     of those two things is the whole fix.
     Every per-run table below is keyed by POSITION in this list -- which tier,
     which account, which run carries a deliberate irregular. sample-activity.js
     now puts the live head at the front, so positions 0..7 stopped meaning what
     those tables were written to mean. A first attempt skipped live runs inside
     the loop and left the indexing alone; that removed the irregulars (they sit
     at low positions) and turned one failing assertion into four. Filtering
     first restores the original meaning of every index. */
  const starts = sessions.entries
    .filter(entry => entry.action === 'agent_session_start')
    .filter(entry => !live.has(entry.sessionId))

  /* Built newest-run-first, matching the reply order the recorder answers with;
   * runs are far enough apart that per-run newest-first is global newest-first. */
  const rows = []
  starts.forEach((start, index) => {
    if (refusedStarts.has(start.sequence)) return
    const startMs = Date.parse(start.at)
    const runLabel = String(index + 1).padStart(2, '0')
    const baseTier = TIER_FOR_AGENT[start.agent] ?? 'local'
    const unrecorded = index === UNRECORDED_TIER_AT
    const tier = unrecorded ? null : baseTier
    const account = unrecorded ? null : ACCOUNT_FOR_TIER[baseTier]
    const base = FIGURES_FOR_TIER[baseTier]
    const codexTier = baseTier === 'luna' || baseTier === 'terra' || baseTier === 'sol'

    if (index === CUMULATIVE_ONLY_AT) {
      rows.push({
        atMs: startMs + 8 * 60_000,
        sessionId: start.sessionId,
        usage: {
          turnId: `sample-turn-${runLabel}-1`,
          tier,
          account,
          status: 'completed',
          basis: 'session-total',
          totalTokens: CUMULATIVE_TOTAL,
          sessionTotalTokens: CUMULATIVE_TOTAL,
          contextWindow: base.contextWindow,
        },
      })
      return
    }

    const turnCount = TURNS_BY_ROW[index % TURNS_BY_ROW.length]
    const runRows = []
    let runningTotal = 0
    for (let turn = 0; turn < turnCount; turn += 1) {
      const percent = SCALE_PERCENT[(index * 3 + turn) % SCALE_PERCENT.length]
      const figures = {
        inputTokens: scaled(base.inputTokens, percent),
        cachedInputTokens: scaled(base.cachedInputTokens, percent),
        cacheCreationInputTokens: scaled(base.cacheCreationInputTokens, percent),
        outputTokens: scaled(base.outputTokens, percent),
        reasoningOutputTokens: scaled(base.reasoningOutputTokens, percent),
      }
      // Report totals using the same composition as the engine: cached input
      // is already inside Codex input, and reasoning is already inside output.
      const total = figures.inputTokens + figures.outputTokens
        + (codexTier ? 0 : (figures.cachedInputTokens ?? 0) + (figures.cacheCreationInputTokens ?? 0))
      const derived = index === DERIVED_AT.run && turn === DERIVED_AT.turn
      /* WHAT THE DERIVED TURN WILL READ AS, computed by the reader's own rule
         rather than restated. readLocalUsage adds a cached reading into the
         total when the record says the input figure does not already hold it,
         and does not when it says it does -- see turnTotalOf() in
         ../local-metrics.js. Spelling a different sum here would make the
         running total this example checks against disagree with the figure the
         page draws from it, which is the one thing this row exists to catch. */
      const derivedTotal = codexTier
        ? (figures.inputTokens ?? 0) + (figures.outputTokens ?? 0)
        : (figures.inputTokens ?? 0) + (figures.cachedInputTokens ?? 0) + (figures.cacheCreationInputTokens ?? 0) + (figures.outputTokens ?? 0)
      runningTotal += derived ? derivedTotal : total
      const usage = {
        turnId: `sample-turn-${runLabel}-${turn + 1}`,
        tier,
        account,
        status: 'completed',
        basis: 'turn',
        /* WHERE THE CACHE SITS, said by the example for the same reason a real
           record now says it: codex reports its cached reading INSIDE
           `inputTokens` and Anthropic reports it beside `input_tokens`, and an
           example that stated neither would exercise the reader's "the record
           does not say" path on every row instead of the two real ones. */
        inputBasis: codexTier ? 'includes-cache' : 'excludes-cache',
        ...figures,
        contextWindow: base.contextWindow,
      }
      if (!derived) usage.totalTokens = total
      /* The codex engines report a session running total beside every turn;
         the claude and local rows do not. Both shapes are real, so both are
         demonstrated. */
      if (codexTier && !unrecorded) usage.sessionTotalTokens = runningTotal
      runRows.push({ atMs: startMs + OFFSET_MINUTES[turn] * 60_000, sessionId: start.sessionId, usage })
    }
    runRows.reverse()
    rows.push(...runRows)
  })

  /* Sequences descend with age, the way an append-only ledger reads back. */
  const entries = rows.map((row, position) => ({
    at: iso(row.atMs),
    sequence: rows.length - position,
    action: 'agent_turn_usage',
    sessionId: row.sessionId,
    usage: row.usage,
  }))

  return {
    ok: true,
    entries,
    /* One line per turn, so the whole-chain count IS the entry count -- equal
       on purpose, so the example never claims to be a sample of a longer
       record that does not exist. */
    total: entries.length,
    /* The demonstration shows a record that checks out, for the reason
       sample-activity.js gives: the broken-chain screen deserves its own
       demonstration rather than being the default one. */
    verified: true,
  }
}
