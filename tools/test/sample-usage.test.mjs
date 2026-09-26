/* THE EXAMPLE USAGE RECORD, WALKED THROUGH THE REAL READERS.
 *
 * src/sample-usage.js is the token half of the demonstration: a raw usage-ledger
 * reply, in the exact shape shell/usage-record.cjs answers with, that the
 * metrics page's example face can hand to the same readLocalUsage every real
 * machine goes through. This suite holds it to the promises that make that
 * honest:
 *
 *   - the REAL parser accepts every row it authors -- no silent drops, so the
 *     example can never claim more turns than the page will show;
 *   - every turn joins to a run in sampleSessionsRaw and lands after that run
 *     started, and a refused run has no turns, so the two halves of the example
 *     cannot contradict each other;
 *   - the tier ids it copies as literals still resolve against the real
 *     LAUNCH_TIERS table, so a renamed tier fails here instead of quietly
 *     rendering as "Not recorded";
 *   - the same nowMs produces the same reply, so a screenshot stays comparable
 *     to the next one;
 *   - and the derived readings -- describeLocalMetrics and the measured-face
 *     chart feeders -- carry real values where the example provides them.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { sampleSessionsRaw, liveSessionIds } from '../../src/sample-activity.js'
import { sampleUsageRaw } from '../../src/sample-usage.js'
import { describeLocalMetrics, readLocalRuns, readLocalUsage } from '../../src/local-metrics.js'
import { LAUNCH_TIERS } from '../../src/orchestration-controls.js'
import {
  activityMatrix,
  liveWindow,
  routingFlows,
  tokenBands,
  turnCounts,
  turnsInWindow,
} from '../../src/metrics-live-charts.js'

/* A fixed clock, so every assertion below is about the module and not about
   when the suite happened to run. Mid-day, so no run or turn straddles a local
   midnight differently from render to render of THIS suite. */
const NOW = Date.UTC(2026, 5, 15, 12, 30, 0)

/* Parse both halves the way the view does: through the real readers, with the
   raw replies standing in for the host channel. */
async function readBoth(nowMs = NOW) {
  const usage = await readLocalUsage({ agent: { usage: async () => sampleUsageRaw(nowMs) } })
  const sessions = await readLocalRuns({ agent: { history: async () => sampleSessionsRaw(nowMs) } })
  return { usage, sessions }
}

/* The optional join the view holds: sessionId -> what was asked and of whom,
   built from the activity reply's own start entries. */
function conversationsFrom(nowMs = NOW) {
  const map = new Map()
  for (const entry of sampleSessionsRaw(nowMs).entries) {
    if (entry.action !== 'agent_session_start') continue
    map.set(entry.sessionId, { asked: entry.asked, role: entry.agent })
  }
  return map
}

test('the real readLocalUsage accepts every authored row -- no silent drops', async () => {
  const raw = sampleUsageRaw(NOW)
  assert.equal(raw.ok, true)
  assert.equal(raw.verified, true)
  assert.ok(Array.isArray(raw.entries) && raw.entries.length > 0)
  /* One line per turn, and the whole-chain count says exactly that, so the
     totals panel never prints a "showing N of M" note about a longer record
     that does not exist. */
  assert.equal(raw.total, raw.entries.length)

  const { usage } = await readBoth()
  assert.equal(usage.supported, true)
  assert.equal(usage.readable, true)
  assert.equal(usage.verified, true)
  /* THE NO-SILENT-DROPS CLAUSE. Every entry authored above came out of the
     parser as a turn. If this ever fails, a row's shape has drifted from what
     readLocalUsage accepts, and the fix belongs in sample-usage.js. */
  assert.equal(usage.turns.length, raw.entries.length)
  assert.equal(usage.total, usage.turns.length)
})

test('every turn joins to a sample run and lands after that run started', async () => {
  const { usage, sessions } = await readBoth()
  assert.equal(sessions.readable, true)

  const runBySession = new Map(sessions.runs.map(run => [run.sessionId, run]))
  for (const turn of usage.turns) {
    assert.equal(typeof turn.sessionId, 'string', 'every sample turn names its session')
    const run = runBySession.get(turn.sessionId)
    assert.ok(run, `turn ${turn.turnId} names ${turn.sessionId}, which sampleSessionsRaw does not hold`)
    assert.ok(turn.atMs > run.atMs, `turn ${turn.turnId} is timestamped before its run started`)
    assert.ok(turn.atMs <= NOW, `turn ${turn.turnId} is timestamped in the future`)
  }

  /* A refused run never answered, so it used nothing -- the two halves of the
     example must not contradict each other about that. */
  const refused = sessions.runs.filter(run => run.result === 'refused')
    /* AT LEAST ONE, not exactly three. The count was pinned at 3, which was true
       while every run came from the fixed ladder. The example fleet now has a
       LIVE HEAD derived from the clock, and one of those runs can itself be
       refused -- so the total moves between renders, legitimately. Pinning the
       number would force the simulation to stop varying in order to keep a test
       green, which is the wrong way round.

       The floor stays because it is a POSITIVE CONTROL: the real invariant is the
       loop below, and with zero refusals that loop would pass over an empty list
       and prove nothing. */
    assert.ok(refused.length >= 1,
      `the example fleet recorded no refusal at all, so the check below -- that a refused run files no usage -- would pass over an empty list and prove nothing (runs: ${sessions.runs.length})`)
  const touched = new Set(usage.turns.map(turn => turn.sessionId))
  for (const run of refused) {
    assert.ok(!touched.has(run.sessionId), `refused run ${run.sessionId} has usage rows`)
  }
  /* And every run that DID start has something to show for it. */
    /* EVERY SETTLED RUN THAT ANSWERED FILED USAGE, and nothing else did.
       This used to read `sessions.runs.length - refused.length`, which assumed
       every run that was not refused had filed its usage. That was true while
       every run came from the fixed ladder. It is not true now: the example
       fleet has a LIVE HEAD, the newest of which is still in flight, and usage
       is recorded when a turn finishes. So the live runs are subtracted too --
       from the same exported source sample-usage.js reads, rather than a second
       copy of the rule that could drift from it. */
    const liveRuns = sessions.runs.filter(run => liveSessionIds(NOW).has(run.sessionId))
    assert.ok(liveRuns.length > 0,
      'the example fleet has no live runs at all, so the live head is not being rendered and this check is measuring nothing')
    assert.equal(touched.size, sessions.runs.length - refused.length - liveRuns.filter(run => run.result !== 'refused').length,
      'a settled run that answered filed no usage, or a run in flight filed some')
})

test('deterministic: the same nowMs answers the same reply', () => {
  assert.deepEqual(sampleUsageRaw(NOW), sampleUsageRaw(NOW))
  /* And the clock genuinely drives it: a different nowMs moves the record. */
  assert.notDeepEqual(sampleUsageRaw(NOW), sampleUsageRaw(NOW + 60_000))
})

test('the deliberate irregulars are present, marked, and singular', async () => {
  const { usage } = await readBoth()

  /* Exactly one turn reported no total, so the parser derived one and said so,
     and the totals panel has a real sentence to print. */
  const derived = usage.turns.filter(turn => turn.derivedTotal)
  assert.equal(derived.length, 1)
  assert.equal(derived[0].reportedTotal, false)
  /* Parsed turns carry the page's short names (input, output), not the raw
     ledger field names -- the TOKEN_FIELDS mapping in local-metrics.js. */
  assert.equal(derived[0].totalTokens, derived[0].input + derived[0].output)

  /* Exactly one session reported only a running total. It carries the mark
     that keeps it out of every time series. */
  const cumulative = usage.turns.filter(turn => turn.basis === 'session-total')
  assert.equal(cumulative.length, 1)
  assert.ok(cumulative[0].totalTokens > 0)

  /* One run's rows carry no tier and no sign-in, so the provider, model and
     account groupings each get their honest "Not recorded" row from data. */
  const unrecorded = usage.turns.filter(turn => turn.basis === 'turn' && turn.tier === null)
  assert.ok(unrecorded.length >= 1)
  assert.equal(new Set(unrecorded.map(turn => turn.sessionId)).size, 1, 'the unrecorded rows belong to one run')
  for (const turn of unrecorded) assert.equal(turn.account, null)
})

test('tier ids resolve against the real LAUNCH_TIERS and span the providers', async () => {
  const { usage } = await readBoth()
  const tiers = new Set(usage.turns.map(turn => turn.tier).filter(tier => tier !== null))
  assert.ok(tiers.size >= 4, 'the example spreads across several model rows')
  const providers = new Set()
  for (const tier of tiers) {
    const row = LAUNCH_TIERS.find(candidate => candidate.id === tier)
    /* The copied literal in sample-usage.js has drifted from the real table if
       this fails -- which would render as "Not recorded" instead of erroring. */
    assert.ok(row, `sample tier "${tier}" is not a LAUNCH_TIERS id`)
    providers.add(row.provider)
  }
  for (const provider of ['codex', 'claude', 'local']) {
    assert.ok(providers.has(provider), `no sample turns ran on the ${provider} provider`)
  }
})

test('describeLocalMetrics carries the example into every tile and token panel', async () => {
  const { usage, sessions } = await readBoth()
  const conversations = conversationsFrom()
  const local = describeLocalMetrics(sessions, { nowMs: NOW, conversations, usage })

  /* The stat strip: six tiles, none absent, every value a number. */
  assert.equal(local.tiles.length, 6)
  for (const tile of local.tiles) {
    assert.equal(tile.absence, null, `tile ${tile.id} reports an absence over full sample data`)
    assert.ok(Number.isSafeInteger(tile.value), `tile ${tile.id} carries no value`)
    assert.equal(typeof tile.unit, 'string')
  }
  assert.equal(local.tiles[0].value, sessions.runs.length)

  /* The token panels, from the usage half. */
  const totals = local.usage.totals
  assert.equal(totals.ok, true)
  assert.equal(totals.turns, usage.turns.length)
  assert.ok(totals.tokens.total > 0)
  assert.ok(totals.tokens.input > 0)
  assert.equal(totals.derivedTotals, 1)
  assert.equal(typeof totals.derivedSentence, 'string')
  assert.equal(totals.sampled, false)
  assert.equal(totals.sessions, new Set(usage.turns.map(turn => turn.sessionId)).size)

  const providerKeys = new Set(local.usage.byProvider.rows.map(row => row.key))
  for (const key of ['codex', 'claude', 'local', 'unrecorded']) {
    assert.ok(providerKeys.has(key), `byProvider has no ${key} row`)
  }
  assert.ok(local.usage.byModel.rows.length >= 4)
  const accountKeys = new Set(local.usage.byAccount.rows.map(row => row.key))
  for (const key of ['sample-codex-seat', 'sample-claude-seat', 'unrecorded']) {
    assert.ok(accountKeys.has(key), `byAccount has no ${key} row`)
  }
  for (const reading of [local.usage.byProvider, local.usage.byModel, local.usage.byAccount]) {
    for (const row of reading.rows) assert.ok(row.tokens >= 0 && row.share !== undefined)
  }

  /* The agent grouping is a JOIN on the shared session ids; with the sample
     conversations supplied, real agent names come through. */
  const agents = new Set(local.usage.byAgent.rows.map(row => row.key))
  assert.ok(agents.has('codex') && agents.has('claude') && agents.has('terra-02'))

  const byDay = local.usage.byDay
  assert.equal(byDay.ok, true)
  assert.ok(byDay.windowTokens > 0)
  /* The cumulative session is in the totals and counted out of the chart. */
  assert.ok(byDay.outsideWindow >= 1)

  const byRun = local.usage.byRun
  assert.equal(byRun.ok, true)
  assert.equal(byRun.total, totals.sessions)
  assert.ok(byRun.rows.some(row => row.asked && row.agent), 'no run row carries its conversation join')
})

test('the measured-face chart feeders draw real shape from it', async () => {
  const { usage, sessions } = await readBoth()
  const raw = sampleUsageRaw(NOW)
  const conversations = conversationsFrom()

  for (const range of ['24h', '7d']) {
    const window = liveWindow(range, NOW)
    const bands = tokenBands(usage.turns, window)
    assert.equal(bands.ok, true, `tokenBands has nothing to draw over ${range}`)
    assert.ok(bands.total > 0)
    const counts = turnCounts(usage.turns, window)
    assert.equal(counts.ok, true)
    const matrix = activityMatrix(sessions.runs, window)
    assert.equal(matrix.ok, true)
    const flows = routingFlows(turnsInWindow(usage.turns, window), { conversations })
    assert.equal(flows.ok, true, `routingFlows has nothing to draw over ${range}`)
    assert.ok(flows.links.length > 0)
  }

  /* Over the widest window the whole record is visible: every turn-basis row
     the module authored lands in a bucket, split across all the assistants. */
  const week = liveWindow('7d', NOW)
  const bands = tokenBands(usage.turns, week)
  assert.ok(bands.bands.length >= 4, 'fewer than four assistant bands (codex, claude, local, not recorded)')
  const authoredTurnRows = raw.entries.filter(entry => entry.usage.basis === 'turn').length
  assert.equal(turnCounts(usage.turns, week).total, authoredTurnRows)
  assert.equal(activityMatrix(sessions.runs, week).total, sessions.runs.length)
  const flows = routingFlows(turnsInWindow(usage.turns, week), { conversations })
  const depths = new Set(flows.nodes.map(node => node.depth))
  assert.deepEqual([...depths].sort(), [0, 1, 2], 'the routing loses a column')
})
