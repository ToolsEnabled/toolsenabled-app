/* WHAT THE METRICS PAGE IS ALLOWED TO SAY ON A COMPUTER THAT HAS ONE.
 *
 * THE DEFECT THIS EXISTS TO CLOSE, in the owner's own words, about his own
 * install: "Metrics not connected? ... why does it not have any data is it also
 * my account like have i just not been able to use it or is something not
 * working?" Every tile on #/metrics read:
 *
 *     unavailable · No local agent fleet host detected on this machine.
 *
 * It was not his account, and no amount of use would ever have changed it. The
 * page reads dist/data/metrics.json, which tools/gen-metrics.mjs writes AT BUILD
 * TIME from the builder's own checkout -- tools/agent-preflight.js, an owner
 * request ledger, a BUILD-QUEUE.md. None of those exist on a customer machine,
 * so every installed copy ships that file with ok:false and a 1970 timestamp,
 * and no process on the machine ever rewrites it. src/first-run-needs.js has
 * said so in plain words for months. The page was reporting the absence of a
 * thing that is never present.
 *
 * WHAT IT READS INSTEAD, AND WHY THAT SOURCE AND NOT ANOTHER. This computer DOES
 * keep a record of agent work: shell/spawn-record.cjs writes a signed,
 * hash-chained, append-only line for every agent session this app starts and a
 * second one for what became of it. It is already exposed to the renderer
 * (mcAgent.history), already the substance behind the home screen, and it is
 * the only agent-activity record on the machine that is BOTH complete and
 * verifiable. So the metrics page reads the same record the home screen does,
 * and this module is the one place that decides what can honestly be said about
 * it.
 *
 * IT DOES NOT PARSE THE LEDGER ITSELF. readLocalSessions() in ./local-activity.js
 * already rejoins start records with their outcome records, already refuses to
 * read an unrecorded outcome as success, and is already walked exhaustively by
 * tools/test/home-screen.test.mjs. A second parser would be a second opinion
 * that can disagree with the first, on the same bytes, on two screens of the
 * same product. This module takes that function's OUTPUT and derives readings
 * from it.
 *
 * THE THREE ABSENCES ARE DIFFERENT AND ARE NEVER COLLAPSED, because the whole
 * defect was one absence printed for all of them:
 *
 *   no record channel   the page is open in a plain web browser. There is no
 *                       computer here keeping a record. Nothing is wrong.
 *   record unreadable   there IS a record and this copy could not open it.
 *                       That is a real fault and says so.
 *   record empty        the record opened and nothing has run here yet. That is
 *                       the ordinary first-day state and it says what to do.
 *
 * AND THE FOURTH STATE, WHICH IS THE ONE THAT MADE THE OLD PAGE A LIE: a panel
 * whose subject this product does not measure at all. Token spend, account
 * balances and machine vitals are not recorded anywhere on a customer's
 * computer, and no setting turns them on. Those panels get a sentence saying so
 * plainly -- not "unavailable", which reads as a fault the reader could clear,
 * and not a zero, which is a claim. See UNMEASURED below.
 *
 * NOTHING HERE TOUCHES THE DOM, fetch, storage or a global, so the whole of the
 * page's judgement is a pure function of one record and one clock, and
 * tools/test/local-metrics.test.mjs can walk it.
 */

import { COPY, ENGINE_REASON, historyDisabled, readLocalSessions, whenWords } from './local-activity.js'
/* THE SECOND REASON TABLE, AND WHY BOTH ARE READ RATHER THAN ONE BEING COPIED.
   ./local-activity.js keeps the short home-screen wording; ./agent-availability-copy.js
   keeps the fuller agent-page wording, and each holds codes the other does not
   -- measured on the owner's own record, where AGENT_TOOLS_ALL_DISABLED has a
   sentence in the second table and none in the first, so a run he could have
   fixed in one click read "the record does not say why". Asked in that order,
   never merged into a third copy that can drift from both. */
import { UNAVAILABLE_TEXT } from './agent-availability-copy.js'
import { currentDataSource } from './data-source.js'
import { readerRemedy } from './refusal-copy.js'
/* The one table that says which assistant a model row belongs to. Imported
   rather than restated: see PROVIDER_LABELS below. */
import { LAUNCH_TIERS } from './orchestration-controls.js'
/* The allowlist of words the two engines use for a turn that WORKED, read
   rather than restated: codex says "completed" and the Claude CLI says
   "success", and a fourth copy of that pair is how a page comes to paint a
   correct answer red. See sessionTurnSucceeded's own note. */
import { sessionTurnSucceeded } from './agent-session-events.js'
import { PROVIDERS } from './vocab.js'

/* The window the time-shaped panels cover. Seven days because that is what the
   activity panel's own heading has always promised, and changing the heading to
   match a different number would be changing the page to fit the code. */
export const ACTIVITY_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

/* How many ledger lines are asked for. The writer caps a history() request at
   200 (shell/spawn-record.cjs), so this is the largest honest window; when the
   whole chain is longer than it, `sampled` below says so rather than letting a
   bounded reading pass itself off as a total. */
export const HISTORY_LIMIT = 200

/**
 * WHAT EACH ABSENCE SAYS. Values, not sentences buried in a render function,
 * for the same reason ./local-activity.js keeps its copy this way: a test can
 * walk values.
 */
export const LOCAL_METRICS_COPY = Object.freeze({
  /* No mcAgent at all. A plain browser, or a build older than the channel. */
  noChannel: 'This page is open in a web browser, so there is no computer here keeping a record of agent runs. Open ToolsEnabled on a computer and this fills in as you use it.',
  /* The channel is there and the record would not open. This one IS a fault. */
  unreadable: 'ToolsEnabled could not open its own record of what has run on the computer you are driving. Nothing there has been lost; this page simply cannot read it right now.',
  /* Activity auditing is OFF (owner direction 2026-09-20, T782 / BUG08; root
     narrowing 2026-09-21). The person's own setting, the Basic default. Scoped
     to NEW operations and to this record: work already admitted to the audit
     may still finish recording after the toggle, and this page cannot vouch for
     the whole machine -- so no "nothing is broken and nothing was lost". */
  disabled: 'Activity auditing is off for new operations, so ToolsEnabled is not adding new records of what runs on the computer you are driving. Saved history is preserved. Turn on Signed activity audit under Advanced settings to record new runs.',
  /* The record opened and is empty. The ordinary first-day state. */
  empty: 'Nothing has been started on the computer you are driving yet, so there is nothing to measure. Start an agent and it is written down there before it begins, and this page fills in.',
  /* The record opened, has runs, and this particular window of it has none. */
  emptyWindow: 'Nothing has run on the computer you are driving in the last seven days. The totals above cover everything ever run there.',
  /* Under the filter row, in place of "demonstration fleet". */
  sourceLive: 'read from the signed record of what has run on the computer you are driving',
  sourceVerified: 'read from the record of what has run on the computer you are driving, and the record checks out',
  sourceUnverified: 'read from the record of what has run on the computer you are driving. That record no longer checks out, so treat these numbers as a report of the file rather than of the machine.',
  /* WHICH FIGURES COVER WHICH RUNS, because they do not all cover the same
     ones and the sentence used to say they did.
   *
   * MEASURED on the owner's own record 2026-09-03: 158 runs written, 411 ledger
   * lines, so the 200-line window this page may read holds 82 of those runs --
   * and every one of the 158 was started inside the last seven days. The strip
   * showed "Agent runs 158" three tiles above "Last 7 days 82", and this
   * sentence sat under both of them promising "the totals cover all of them".
   * The three run COUNTS do: they come from the writer's whole-chain tally.
   * The three figures measured over time cannot -- they need a timestamp per
   * run and only the window carries those -- so they count the runs shown. */
  sampled: (shown, total) => `Showing the most recent ${shown} of ${total} runs. The run counts cover all ${total}; the figures measured over time cover these ${shown}.`,
  /* The same fact on the tile itself, because a person reads one figure at a
     time and a strip-wide caveat is not attached to the number it qualifies.
     Only ever rendered when the window really is a sample -- a record that fits
     inside it keeps the unit lines it has always had, word for word. */
  overRecent: shown => `of the ${shown} most recent runs`,
  acrossRecent: shown => `across the ${shown} most recent runs`,
  /* A refusal the shell recorded with no sentence written for its code, and a
     refusal recorded before reasons were kept. Never a guess at the cause. */
  reasonUnknown: 'The record does not say why',
  reasonUnrecorded: 'Recorded before this copy kept outcomes',
  /* THE SAME "run counts cover the whole chain" PROMISE `sampled` ABOVE MAKES,
     applied to why runs refused. A reason code lives only on the run record
     itself, and only the WINDOW carries those -- so unlike the three run
     counts on the strip, this panel cannot literally list a reason for a
     refusal outside the window. What it must never do is go quiet about that
     and let its own total read as the whole answer next to a strip that just
     promised the count does cover everything. */
  refusalsSampled: (shown, total) => {
    const who = total === 1 ? 'One run' : `${total} runs`
    return shown === 0
      ? `${who} did not start, but this page cannot currently read why.`
      : `${who} did not start. This page can currently read the reason for ${shown} of them.`
  },
})

/* THE PANELS THIS PRODUCT DOES NOT MEASURE, said once each.
 *
 * Every sentence here was checked against what the machine actually holds
 * before it was written. ToolsEnabled starts agents on the person's OWN
 * assistant sign-in and never proxies their traffic, so it never sees a token
 * count or a bill; it declares an organisation of agents rather than watching a
 * fleet of machines, so it has no vitals to trace. Those are properties of the
 * product, not gaps in this page, and a person who is told so stops looking for
 * the switch.
 *
 * NONE OF THESE MAY SAY "unavailable", and none may offer a remedy. There is no
 * setting that turns any of them on, and inventing one would cost the reader an
 * afternoon -- the exact rule src/first-run-needs.js sets out at length.
 */
/* THREE OF THESE HAVE BEEN WITHDRAWN, AND WITHDRAWING THEM IS THE POINT.
 *
 * `tokenRouting`, `tokenFlow` and `burn` used to say that a word count never
 * passes through this product. Each was written carefully, each was believed,
 * and each was wrong: both engines report token usage on every turn, the adapter
 * re-emits it, and it has crossed mc-agent:event since the first day. What was
 * missing was a writer, not a measurement -- so those three panels are now drawn
 * from this computer's own signed record of what each turn used (see
 * LOCAL_USAGE_COPY and readLocalUsage below), and the sentences that described
 * the product as unable to see them have been removed rather than softened. A
 * sentence that teaches a person to stop looking for a broken thing is worse
 * than an empty panel.
 *
 * THE THREE THAT REMAIN ARE STILL TRUE, and each was re-checked against what the
 * machine holds before this edit was made. `pools` stays because MONEY is still
 * not measured here: this product holds no prices and no balances, so no
 * arrangement of token counts is a cost, and that sentence is now printed BESIDE
 * the token figures rather than instead of them. */
export const UNMEASURED = Object.freeze({
  pools: 'ToolsEnabled holds no accounts and no balances for you. What a session costs is settled between you and whoever you signed in with.',
  heartbeat: 'There is one computer being measured: the computer you are driving. There is no second machine reporting vitals to draw a trace for.',
  gates: 'Nothing on the computer you are driving holds a run back for a decision, so there is no waiting to show. Decisions you are asked for appear in the Ledger.',
})

/* One label per outcome the ledger can record. `unrecorded` is deliberately its
   own segment rather than folded into either of the others: the whole point of
   readLocalSessions is that an unrecorded outcome is not a success, and a chart
   that hid it would put the defect back in a different shape. */
export const OUTCOME_SEGMENTS = Object.freeze([
  Object.freeze({ key: 'started', label: 'Started' }),
  Object.freeze({ key: 'refused', label: 'Did not start' }),
  Object.freeze({ key: 'unrecorded', label: 'Not recorded' }),
])

const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : null)

/**
 * The plain sentence for one recorded refusal code, or the honest placeholder.
 *
 * The agent page's table holds sentence FRAGMENTS -- they are composed after
 * "Nothing was started." on that page -- so the first letter is raised here.
 * Nothing else about the wording is touched: the remedy inside it is the one
 * that screen already gives, and two screens must not offer a person two
 * different fixes for one code.
 *
 * unavailableReason() from that module is deliberately NOT used: its fallback
 * invents "this copy could not work out why", which is a claim about a run
 * rather than an absence of one -- the distinction ./local-activity.js records
 * at length beside COPY.runReason, and the reason this function has its own
 * last resort.
 */
export function refusalSentenceFor(code) {
  if (typeof code !== 'string' || code.length === 0) return LOCAL_METRICS_COPY.reasonUnrecorded
  const short = COPY.runReason(code)
  if (short) return readerRemedy(short, { viaRelay: currentDataSource() === 'relay' })
  if (Object.prototype.hasOwnProperty.call(UNAVAILABLE_TEXT, code)) {
    const fragment = UNAVAILABLE_TEXT[code]
    const sentence = fragment.charAt(0).toUpperCase() + fragment.slice(1)
    return readerRemedy(sentence, { viaRelay: currentDataSource() === 'relay' })
  }
  return LOCAL_METRICS_COPY.reasonUnknown
}

/**
 * Read the signed record, through exactly the three cases the home screen
 * distinguishes -- see loadSessions() in src/views/home.js for why conflating
 * the last two would make a screen lie to somebody sitting in front of the
 * application.
 *
 * `agent` is injected so a test never needs a global, matching the
 * `{ postAction = postBridgeAction }` shape every research client module uses.
 */
export async function readLocalRuns({ agent = globalThis.mcAgent, limit = HISTORY_LIMIT } = {}) {
  let raw
  if (!agent) raw = undefined
  else if (typeof agent.history !== 'function') raw = null
  else {
    try { raw = await agent.history({ limit }) } catch { raw = null }
  }
  return readLocalSessions(raw)
}

/* HOW MANY RUNS THE WHOLE RECORD HOLDS, WHICH IS NOT WHAT `sessions.total` IS.
 *
 * MEASURED, NOT ASSUMED, and it would have shipped a doubled number on every
 * tile. readLocalSessions().total is the count of LEDGER LINES when the writer
 * supplies no whole-chain tally -- and every run is two lines, a start and the
 * outcome that resolves it. Nine runs would have been reported as eighteen.
 * When the writer DOES supply a tally, `starts` is already a run count and that
 * is the number to trust, because it covers runs older than the 200-line window
 * this page can see.
 *
 * So the two cases are told apart by whether the tally is there at all, and the
 * bounded window is the floor in both: a total below the number of runs already
 * on the page would be a total contradicted by the list under it.
 */
function runTotals(sessions) {
  const started = count(sessions.started)
  const refused = count(sessions.refused)
  const windowRuns = Array.isArray(sessions.runs) ? sessions.runs.length : 0
  const tallied = started !== null && refused !== null
  const chainRuns = tallied ? count(sessions.total) : null
  const total = Math.max(chainRuns ?? 0, windowRuns, (started ?? 0) + (refused ?? 0))
  return {
    total,
    windowRuns,
    started: started ?? (Array.isArray(sessions.runs) ? sessions.runs.filter(run => run.result === 'started').length : 0),
    refused: refused ?? (Array.isArray(sessions.runs) ? sessions.runs.filter(run => run.result === 'refused').length : 0),
  }
}

/** Which of the three absences a reading is in, or null when there is data. */
function absenceOf(sessions) {
  if (!sessions || sessions.supported !== true) return LOCAL_METRICS_COPY.noChannel
  if (sessions.disabled === true) return LOCAL_METRICS_COPY.disabled
  if (sessions.readable !== true) return LOCAL_METRICS_COPY.unreadable
  if (!Array.isArray(sessions.runs) || sessions.runs.length === 0) return LOCAL_METRICS_COPY.empty
  return null
}

/* Local calendar days, newest last, so a row of them reads left to right the
   way the week does. Local rather than UTC deliberately: a person reading "when
   did I run things" means their own midnight, and a chart drawn on UTC days
   puts a late-evening run on tomorrow. */
function dayStart(ms) {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/* A CALENDAR day added to a local midnight, not a fixed DAY_MS added to one.
   The two agree except on the two days a year this clock does not hold 24
   hours, where stepping by DAY_MS drifts an hour into the wrong day for
   every day beyond the one it crossed -- see activityGrid and usageByDay,
   the two calendars below that used to step that way. */
function addDays(ms, days) {
  const date = new Date(ms)
  date.setDate(date.getDate() + days)
  return date.getTime()
}

const DAY_LABEL = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
const DATE_LABEL = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

/**
 * Runs by hour of the day across the last seven days -- the shape the "Fleet
 * activity · by hour · 7 days" panel has always drawn, now from runs that
 * genuinely happened on this computer.
 *
 * `max` travels with it so a caller shades against the busiest real hour rather
 * than against an invented ceiling. A grid whose busiest cell is one run is a
 * true picture of a quiet week, and normalising it to look full would be the
 * same class of lie as a zero.
 */
export function activityGrid(sessions, nowMs = Date.now()) {
  const absence = absenceOf(sessions)
  const today = dayStart(nowMs)
  const days = []
  for (let offset = ACTIVITY_DAYS - 1; offset >= 0; offset -= 1) {
    const startMs = addDays(today, -offset)
    days.push({
      startMs,
      label: DAY_LABEL.format(new Date(startMs)),
      dateLabel: DATE_LABEL.format(new Date(startMs)),
      hours: new Array(24).fill(0),
    })
  }
  if (absence) return Object.freeze({ ok: false, absence, days: Object.freeze([]), max: 0, total: 0 })

  const earliest = days[0].startMs
  let total = 0
  let max = 0
  for (const run of sessions.runs) {
    if (!Number.isFinite(run?.atMs) || run.atMs < earliest) continue
    /* Rounded, not floored: `dayStart(run.atMs) - earliest` is an exact
       multiple of DAY_MS only when no daylight-saving change fell between
       them, and floor would place a run a day early the one time a year
       that gap runs a little short of DAY_MS instead of exactly meeting it. */
    const index = Math.round((dayStart(run.atMs) - earliest) / DAY_MS)
    if (index < 0 || index >= days.length) continue
    const hour = new Date(run.atMs).getHours()
    days[index].hours[hour] += 1
    total += 1
    if (days[index].hours[hour] > max) max = days[index].hours[hour]
  }
  const frozen = Object.freeze(days.map(day => Object.freeze({ ...day, hours: Object.freeze(day.hours) })))
  /* An empty WINDOW is not an empty record, and saying "nothing has run here"
     over a page whose tiles show nineteen runs would be the contradiction the
     home screen's own test exists to prevent. */
  if (total === 0) {
    return Object.freeze({ ok: false, absence: LOCAL_METRICS_COPY.emptyWindow, days: frozen, max: 0, total: 0 })
  }
  return Object.freeze({ ok: true, absence: null, days: frozen, max, total })
}

/**
 * What became of every run this record holds. Whole-chain counts where the
 * writer supplies them (they cover runs older than the window this page reads),
 * falling back to the window itself when it does not.
 */
export function outcomeBreakdown(sessions) {
  const absence = absenceOf(sessions)
  if (absence) return Object.freeze({ ok: false, absence, segments: Object.freeze([]), total: 0 })

  const { total, started, refused } = runTotals(sessions)
  const unrecorded = Math.max(0, total - started - refused)
  const values = { started, refused, unrecorded }
  return Object.freeze({
    ok: true,
    absence: null,
    total,
    segments: Object.freeze(OUTCOME_SEGMENTS.map(segment => Object.freeze({
      key: segment.key,
      label: segment.label,
      count: values[segment.key],
      /* A share of nothing is not zero percent, it is no share at all. */
      share: total > 0 ? values[segment.key] / total : null,
    }))),
    /* The sentence ./local-activity.js already writes for this exact tally, so
       two screens of one product cannot summarise one record differently. */
    sentence: COPY.runOutcomes(started, refused, total),
  })
}

/**
 * Why runs did not start, grouped, most common first -- the panel that used to
 * be "Failure by lane" over a fleet that does not exist here.
 *
 * The reason is rendered as the SENTENCE the shell's own code maps to, never as
 * the bare code: an upper-case identifier in front of a person is the thing
 * src/refusal-copy.js and tools/check-plain-language.mjs both exist to stop. A
 * code nobody has written a sentence for gets an honest placeholder rather than
 * a guess, exactly as COPY.runReason does on the home screen.
 *
 * `total` IS THE SAME WHOLE-CHAIN FIGURE outcomeBreakdown() REPORTS, not a
 * second count of its own: a reason code only ever lives on the window's run
 * records, so the groups below can cover no more than that window holds, but
 * this panel's headline must still be the number the outcomes panel above it
 * already gave for "how many did not start". `sampled` says when the two
 * diverge, the same way sourceLine()'s and usageTotals()'s own `sampled` do.
 */
export function refusalBreakdown(sessions) {
  const absence = absenceOf(sessions)
  if (absence) return Object.freeze({ ok: false, absence, rows: Object.freeze([]), total: 0 })

  const refused = sessions.runs.filter(run => run.result === 'refused')
  /* THE SAME WHOLE-CHAIN COUNT outcomeBreakdown() ALREADY TRUSTS, via the same
     runTotals() -- not a second reading of sessions.refused that could drift
     from the first. A reason code lives only on the run record itself, and
     only the WINDOW carries those, so the groups below can never cover a
     refusal outside it -- but the headline this function reports must still
     be the number outcomeBreakdown() just put on the strip two tiles up.
   *
   * MEASURED against the live ledger 2026-09-03: 17 refused in the whole-chain
   * tally, 5 of them inside the 200-line window this function used to be the
   * only one still counting from. The outcomes panel said "17 did not start";
   * this one, right below it on the same page, said "5 runs did not start,
   * grouped by what the record says about them" -- two different answers to
   * one question, on one screen, both sourced from the one `sessions` object.
   * A ledger with no refusal at all inside the window read worse: this
   * function said "Every run recorded here started" while the panel above it
   * showed a nonzero refused count -- confident, and wrong. */
  const { refused: wholeChainRefused } = runTotals(sessions)
  const sampled = wholeChainRefused > refused.length
  if (refused.length === 0) {
    return Object.freeze({
      ok: true, absence: null, rows: Object.freeze([]), total: wholeChainRefused, sampled,
      sentence: sampled
        ? LOCAL_METRICS_COPY.refusalsSampled(0, wholeChainRefused)
        : (sessions.runs.length === 1
          ? 'The one run recorded here started.'
          : 'Every run recorded here started.'),
    })
  }
  const groups = new Map()
  for (const run of refused) {
    const code = typeof run.reason === 'string' && run.reason ? run.reason : null
    const key = code || 'no code recorded'
    const sentence = refusalSentenceFor(code)
    const existing = groups.get(key)
    if (existing) existing.count += 1
    else groups.set(key, { sentence, count: 1 })
  }
  const rows = [...groups.values()]
    .sort((a, b) => b.count - a.count || a.sentence.localeCompare(b.sentence))
    .map(row => Object.freeze({
      sentence: row.sentence,
      count: row.count,
      share: row.count / refused.length,
    }))
  return Object.freeze({
    ok: true, absence: null, total: wholeChainRefused, rows: Object.freeze(rows), sampled,
    sentence: sampled
      ? LOCAL_METRICS_COPY.refusalsSampled(refused.length, wholeChainRefused)
      : (refused.length === 1
        ? 'One run did not start, and this is what the record says about it.'
        : `${refused.length} runs did not start, grouped by what the record says about them.`),
  })
}

/**
 * The runs themselves, newest first -- what the agent table shows on a page
 * about one computer. `conversations` is the same optional join the home screen
 * makes (session id to what was asked); an unmatched run simply renders without
 * it, which is why this is a join and never a required field on disk.
 *
 * `total` IS THE SAME WHOLE-CHAIN FIGURE outcomeBreakdown() REPORTS, not the
 * length of the window this function had to build rows from -- the exact
 * repair statTiles(), outcomeBreakdown() and refusalBreakdown() already made,
 * missed here.
 *
 * MEASURED against the live ledger 2026-09-03: 194 runs in the writer's
 * whole-chain tally, 84 of them inside the 200-line window this function
 * reads. The Agents section read "84 runs recorded on the computer you are
 * driving" -- the caption outcomeBreakdown()'s own panel builds from the
 * identical template ("${total} runs recorded on ...") said "194" two
 * sections above it, on the same page, about the same record. `rows` still
 * shows only what the window holds -- it cannot show a run this page never
 * received -- but the count in the sentence above the table is the count of
 * runs, not the count of lines this reader could open.
 */
export function runRows(sessions, { nowMs = Date.now(), conversations = null, limit = 40 } = {}) {
  const absence = absenceOf(sessions)
  if (absence) return Object.freeze({ ok: false, absence, rows: Object.freeze([]), total: 0 })

  const rows = sessions.runs.slice(0, limit).map(run => {
    const said = run.sessionId && conversations && typeof conversations.get === 'function'
      ? conversations.get(run.sessionId)
      : null
    return Object.freeze({
      sequence: run.sequence,
      when: whenWords(nowMs - run.atMs) || COPY.runWhenUnknown,
      at: Number.isFinite(run.atMs) ? new Date(run.atMs).toLocaleString() : '',
      atMs: run.atMs,
      result: run.result,
      /* '' for a run whose outcome was never recorded. The empty string is
         load-bearing here for the same reason it is in COPY.runResult: silence
         must never be rendered as success. */
      resultWord: COPY.runResult(run.result),
      why: run.result === 'refused' ? refusalSentenceFor(run.reason) : '',
      asked: said && typeof said.asked === 'string' ? said.asked : '',
      agent: said && typeof said.role === 'string' ? said.role : '',
    })
  })
  return Object.freeze({ ok: true, absence: null, total: runTotals(sessions).total, rows: Object.freeze(rows) })
}

/* THE SIX NUMBERS IN THE STAT STRIP, in the strip's own fixed slot ids.
 *
 * The ids are the page's existing DOM identities (src/views/metrics.js
 * TILE_DEFS) and are kept so the strip's protected markup, its sparkline nodes
 * and its edit-layout registry are untouched by this repair. Only what they
 * MEAN changed, and every one of them now means something this computer wrote
 * down.
 *
 * A count is a count and never a rate: the strip used to carry "Failure rate ·
 * %", which over 19 runs would print a decisive-looking 21% that is four
 * events. Whole numbers, with the denominator beside them in the unit line.
 *
 * AND THE SIX DO NOT ALL COUNT THE SAME RUNS, which is the repair below.
 *
 * Three of them are run COUNTS and come from outcomeBreakdown, which reads the
 * writer's whole-chain tally: they cover every run the record holds, however
 * long it is. The other three are measured over TIME -- how many in seven days,
 * how many in a day, how many days used and since when -- and a timestamp
 * exists only on a run this page could actually read, which is the last
 * HISTORY_LIMIT ledger lines and nothing before them.
 *
 * MEASURED on the owner's own record 2026-09-03. 158 runs, 411 ledger lines
 * (a run is a start, an outcome, and now an end), so the 200-line window held
 * 82 runs -- and every one of the 158 was started inside the last seven days.
 * The strip read:
 *
 *     Agent runs 158 · Ran 145 · Did not start 13
 *     Last 7 days 82 · Last 24 hours 52 · Days used 3 since 2 Sep
 *
 * Three figures wrong in one strip of six: seven days that holds all 158 runs
 * reported 82 of them, five days of use reported three, and a record that
 * begins on 29 August said it begins on 2 September. Each was the window's
 * answer wearing the record's label, and the sentence under the strip
 * (LOCAL_METRICS_COPY.sampled) told the reader the totals covered all of them.
 *
 * THE WINDOW CANNOT BE WIDENED -- shell/spawn-record.cjs history() caps a read
 * at 200 lines, so 200 is the largest honest reading and these three figures
 * genuinely cannot see further. What they CAN do is say which runs they
 * counted, in the unit line this file already reserves for the denominator, and
 * only when the window really is a sample. A record that fits inside it is
 * untouched: same figures, same unit lines, word for word.
 */
export function statTiles(sessions, nowMs = Date.now()) {
  const absence = absenceOf(sessions)
  const outcomes = outcomeBreakdown(sessions)
  const runs = absence ? [] : sessions.runs
  const since = (windowMs) => runs.filter(run => Number.isFinite(run.atMs) && nowMs - run.atMs <= windowMs).length
  const distinctDays = new Set(runs.filter(run => Number.isFinite(run.atMs)).map(run => dayStart(run.atMs)))
  const earliest = runs.reduce((low, run) => (Number.isFinite(run.atMs) && run.atMs < low ? run.atMs : low), Infinity)
  /* The same pair sourceLine() reads, asked here so the strip and the sentence
     under it cannot disagree about whether this reading is a sample. */
  const { total: chainRuns, windowRuns } = absence ? { total: 0, windowRuns: 0 } : runTotals(sessions)
  const partial = chainRuns > windowRuns

  const tile = (id, label, value, unit) => Object.freeze({
    id, label, value: absence ? null : value, unit: absence ? null : unit, absence,
  })
  /* A UNIT LINE HAS TO READ CORRECTLY AT ZERO AND AT ONE, and the first version
     of these did not: with nothing refused, "Did not start · 0 · and the record
     says why" promises a reason for a thing that did not happen, and "1 · runs"
     is simply wrong. Both were caught by driving the page on a fresh profile
     rather than by reading the code. */
  const runWord = value => (value === 1 ? 'run' : 'runs')
  const last7 = since(ACTIVITY_DAYS * DAY_MS)
  const last1 = since(DAY_MS)
  return Object.freeze([
    /* "recorded", not "started" -- the value is outcomes.total, which counts
       every run in the record INCLUDING the ones that never started. The tile
       three lines below this one is "Did not start", so the old unit line
       contradicted its own neighbour and counted refusals as successes, which
       is the exact defect readLocalSessions exists to prevent. */
    tile('agents', 'Agent runs', outcomes.ok ? outcomes.total : 0, 'recorded on the computer you are driving'),
    tile('tasks', 'Ran', outcomes.ok ? outcomes.segments[0].count : 0, 'of those runs'),
    tile('fail', 'Did not start', outcomes.ok ? outcomes.segments[1].count : 0, 'of those runs'),
    tile('tokens', 'Last 7 days', last7,
      partial ? LOCAL_METRICS_COPY.overRecent(windowRuns) : runWord(last7)),
    tile('ckpt', 'Last 24 hours', last1,
      partial ? LOCAL_METRICS_COPY.overRecent(windowRuns) : runWord(last1)),
    /* THE DATE GOES WHEN IT IS THE WINDOW'S DATE RATHER THAN THE RECORD'S.
       `earliest` is the oldest run this page could read, and on a sampled
       record printing it after the word "since" states the record began then.
       On the owner's own machine that turned 29 August into 2 September. */
    tile('gates', 'Days used', distinctDays.size, partial
      ? LOCAL_METRICS_COPY.acrossRecent(windowRuns)
      : (Number.isFinite(earliest) ? `since ${DATE_LABEL.format(new Date(earliest))}` : 'so far')),
  ])
}

/**
 * What the line under the filter row says about where these numbers came from,
 * including whether the signed chain still checks out.
 *
 * A BROKEN CHAIN IS NOT A REFUSAL. The runs still happened and the person should
 * still see them, beside the fact that the file no longer verifies -- the same
 * decision shell/spawn-record.cjs history() makes about its own return value,
 * and for the same reason.
 */
export function sourceLine(sessions) {
  const absence = absenceOf(sessions)
  if (absence) return Object.freeze({ ok: false, absence, verified: null, sampled: false, note: null })
  const { total, windowRuns: shown } = runTotals(sessions)
  const sampled = total > shown
  return Object.freeze({
    ok: true,
    absence: null,
    verified: sessions.verified === true ? true : (sessions.verified === false ? false : null),
    sampled,
    note: sampled ? LOCAL_METRICS_COPY.sampled(shown, total) : null,
    sentence: sessions.verified === true
      ? LOCAL_METRICS_COPY.sourceVerified
      : (sessions.verified === false ? LOCAL_METRICS_COPY.sourceUnverified : LOCAL_METRICS_COPY.sourceLive),
  })
}

/**
 * Everything the page needs, from one record and one clock. Callers render;
 * they do not decide.
 */
export function describeLocalMetrics(sessions, { nowMs = Date.now(), conversations = null, usage = null } = {}) {
  return Object.freeze({
    source: sourceLine(sessions),
    tiles: statTiles(sessions, nowMs),
    activity: activityGrid(sessions, nowMs),
    outcomes: outcomeBreakdown(sessions),
    refusals: refusalBreakdown(sessions),
    runs: runRows(sessions, { nowMs, conversations }),
    /* WHAT THE TURNS COST, from the second record this computer keeps. Passed in
       rather than read here for the same reason `sessions` is: this module is a
       pure function of records and a clock, and the caller owns the channel. A
       page that has not asked for it yet gets the honest absence rather than a
       zero -- readLocalUsage(null) and this both land on the same sentence. */
    usage: describeLocalUsage(usage, { nowMs, conversations }),
    unmeasured: UNMEASURED,
  })
}


/* ==================================================================
   WHAT THE TURNS ON THIS COMPUTER COST.
   ==================================================================

   THE DEFECT THIS CLOSES, and it is the second half of the one at the top of
   this file. Four panels on #/metrics -- token routing, token flow, account
   pools and pool burn -- said, in the product's own voice, that a token count
   never passes through here. That sentence was written carefully and it was
   wrong: BOTH engines report token usage on every turn, the adapter re-emits it
   as a `usage` event, and that event has crossed mc-agent:event since the first
   day. Nothing wrote it down. The absence was a missing writer, and a page that
   describes a missing writer as a property of the product teaches a person to
   stop looking for the thing that is broken.

   shell/usage-record.cjs now writes each turn into its own signed, hash-chained
   record beside the run ledger. This half decides what may honestly be said
   about it, under the same rules the run readings above follow:

     - the absences stay different from each other, and one of them is NEW: a
       copy whose shell predates the usage channel is not a copy whose record is
       broken, and telling somebody their record will not open when their build
       simply has no such record would send them to fix nothing.
     - absent is never zero. A turn that reported no total HAS no total, and the
       page says how many of the figures it added up were derived from parts
       rather than reported whole.
     - a cumulative reading is never summed. See `basis` in
       shell/usage-record.cjs: adding one running total per turn multiplies a
       session's spend by its number of turns.

   AND WHAT IS STILL NOT MEASURED HERE, which is money. This product holds no
   prices and no balances, so no arrangement of these counts is a cost. UNMEASURED
   .pools keeps saying exactly that, beside panels that now have real figures in
   them, because a token count wearing a currency symbol would be the same class
   of lie the counts themselves were introduced to end. */

export const USAGE_HISTORY_LIMIT = 200

export const LOCAL_USAGE_COPY = Object.freeze({
  /* No mcAgent at all -- a plain browser. The same absence the run reading has,
     said again here so a caller never has to pair the two readings up. */
  noChannel: 'This page is open in a web browser, so there is no computer here keeping a record of what your agents use. Open ToolsEnabled on a computer and this fills in as you use it.',
  /* THE NEW ONE. An mcAgent with no usage() -- a build older than this record.
     It is NOT "unreadable": there is nothing to read, nothing is broken, and an
     update is the whole remedy. */
  noUsageChannel: 'This copy of ToolsEnabled was made before it kept a record of what each turn uses, so there is nothing here to show yet. A newer copy starts writing one the first time an agent answers.',
  /* NOT-READ-YET IS NOT UNREADABLE, and the page paints once before the record
     answers. applyLiveProjection() runs at mount and loadLocalMetrics() resolves
     after it, so without this sentence the first frame of a perfectly healthy
     install accuses itself of a fault the reader would then go looking for. The
     note under the filter row already distinguishes the two ("reading this
     computer's record..."); these panels now do too. */
  waiting: 'Reading the record of what your agents have used on the computer you are driving.',
  unreadable: 'ToolsEnabled could not open its own record of what your agents have used on the computer you are driving. Nothing there has been lost; this page simply cannot read it right now.',
  /* Activity auditing is OFF: the same normal state the run reading has, and
     the same NEW-operations narrowing (root 2026-09-21). */
  disabled: 'Activity auditing is off for new operations, so ToolsEnabled is not adding new records of what your agents use on the computer you are driving. Saved history is preserved. Turn on Signed activity audit under Advanced settings to record new turns.',
  empty: 'No turn on the computer you are driving has reported a token count yet. Ask an agent something and what it used is written down there as the answer finishes.',
  emptyWindow: 'No turn in the last seven days reported a token count. The totals above cover everything the computer you are driving has recorded.',
  sourceLive: 'read from the signed record of what each turn used on the computer you are driving',
  sourceUnverified: 'read from the record of what each turn used on the computer you are driving. That record no longer checks out, so treat these numbers as a report of the file rather than of the machine.',
  sampled: (shown, total) => `Showing the most recent ${shown} of ${total} recorded turns.`,
  /* A turn whose record does not name a model row. Never guessed from anything. */
  providerUnrecorded: 'Not recorded',
  /* A turn whose record does not name a SIGN-IN, said in the sign-in panel's own
     words rather than borrowing the model panel's.
   *
   * THE TWO ABSENCES ARE DIFFERENT QUESTIONS, and while they shared one sentence
   * a real attribution defect was indistinguishable from an ordinary gap. The
   * account label used to be bounded to an ASCII-identifier shape far narrower
   * than the one shell/account-registry.cjs add() admits, so every turn on a
   * sign-in whose name held a space or an @ arrived with account:null -- and
   * collected under a row reading "Not recorded", the same three words this page
   * prints when a record honestly predates the model column. The writer's shape
   * is fixed. What was not fixed is that the sign-in column still cannot say
   * which of the two a reader is looking at. It can now. */
  accountUnrecorded: 'Sign-in not recorded',
  /* A run this page holds no conversation for, so it cannot say which agent it
     was. The tokens are still that run's and are still counted. */
  agentUnnamed: 'Not named on the computer you are driving',
  derived: (count, turns) => (count === 1
    ? `One of these ${turns} turns reported no total, so its figure is its own reported parts added together.`
    : `${count} of these ${turns} turns reported no total, so their figures are their own reported parts added together.`),
  /* WHAT A CACHED READ IS DOING IN A TOTAL, said out loud once. A person who
     knew the old page's figure would otherwise read a number two hundred times
     larger as a fault rather than as the same turns, counted whole. */
  cacheCounted: (count) => (count === 1
    ? 'One of those figures includes the tokens the provider served from its cache, which are part of what that turn used.'
    : `${count} of those figures include the tokens the provider served from its cache, which are part of what those turns used.`),
  /* THE ANSWER THAT IS NOT A NUMBER. See turnTotalOf(): the record holds the
     turn's parts but not whether the cached reading is inside the input figure
     or beside it, and the two readings differ, so there is no total to print. */
  unknown: 'unknown',
  unknownTurns: (count, turns) => (count === 1
    ? `One of these ${turns} turns reported figures this record cannot add into a total, so it is left out of the counts above rather than counted as nothing.`
    : `${count} of these ${turns} turns reported figures this record cannot add into a total, so they are left out of the counts above rather than counted as nothing.`),
  /* WHY A ZERO IS A ZERO, WHICH THIS PAGE COULD NOT SAY.
   *
   * MEASURED 2026-09-03 on the owner's computer: five claude-fable turns in a
   * row from 01:49:05Z wrote status "error" with every token figure zero, while
   * claude-opus wrote 160 successes in the same window on the same install. The
   * page's only sentence for that shape was "no turn reported a token count",
   * which is what it says for a quiet week -- so a tier that had stopped
   * working entirely read as a tier nobody had used, and the provider's own
   * explanation, which the engine did deliver, appeared nowhere a person could
   * reach after the live bubble closed.
   *
   * TWO SENTENCES, NOT ONE, BECAUSE THEY ARE DIFFERENT ANSWERS. "The record
   * kept no reason" is a gap in the record; a quoted sentence is the provider
   * speaking. Collapsing them would let a missing reason read as no reason. */
  failedTurns: ({ count, model, sentence }) => {
    const what = count === 1 ? 'One recorded turn' : `${count} recorded turns`
    const whose = model ? ` on ${model}` : ''
    return sentence
      ? `${what}${whose} ended with a problem. The most recent one said: “${sentence}”`
      : `${what}${whose} ended with a problem, and the record does not say why.`
  },
})

/* Every figure the record can hold, and the name this page uses for it. The
   record's own field names are kept rather than renamed, so a number on a screen
   can be traced to a line in the ledger without a translation table. */
const TOKEN_FIELDS = Object.freeze({
  input: 'inputTokens',
  cachedInput: 'cachedInputTokens',
  cacheCreation: 'cacheCreationInputTokens',
  output: 'outputTokens',
  reasoning: 'reasoningOutputTokens',
})

/* PROVIDER_LABELS answers a model row's assistant from LAUNCH_TIERS, imported at
   the top of this file: a fourth copy of that mapping is how a page comes to
   disagree with the control that started the session. */

const PROVIDER_LABELS = Object.freeze({
  ...Object.fromEntries(PROVIDERS.map(({ id, label }) => [id, label])),
  local: 'On the computer you are driving',
})

function providerOf(tier) {
  if (typeof tier !== 'string' || tier.length === 0) return null
  const row = LAUNCH_TIERS.find(candidate => candidate.id === tier)
  return row ? row.provider : null
}

function modelOf(tier) {
  if (typeof tier !== 'string' || tier.length === 0) return null
  const row = LAUNCH_TIERS.find(candidate => candidate.id === tier)
  return row ? row.label : null
}

const usageNumber = value => (Number.isSafeInteger(value) && value >= 0 ? value : null)

/* WHAT A TURN TOTALLED WHEN THE ENGINE DID NOT SAY -- and the one question that
 * has to be answered before its parts can be added up at all.
 *
 * THE DEFECT THIS EXISTS TO CLOSE. The rule here was `input + output`, and it
 * dropped every token the provider served from its cache. MEASURED 2026-09-03
 * over the whole of the owner's own agent-turn-usage-records.jsonl -- 488 rows,
 * 403 of them reporting no total: this page showed 3,668,392 tokens for those
 * turns where the figures the engine actually reported sum to 857,520,354. Two
 * hundred and thirty-four times low, on figures that were in the record, signed,
 * the whole time. A cached read is a token the provider served and charged for;
 * pricing it at zero is not caution, it is the same invented number this file
 * exists to refuse, pointing the other way.
 *
 * WHY IT WAS NOT A SIMPLE SUM. The two engines mean different things by
 * `inputTokens`, and the record does not carry a sentence saying which:
 *   codex     `cachedInputTokens` is a SUBSET of `inputTokens`. MEASURED: all 85
 *             rows in that ledger that report a total satisfy
 *             total === input + output exactly, with cached ≤ input on every one.
 *   Anthropic `cache_read_input_tokens` and `cache_creation_input_tokens` are
 *             BESIDE `input_tokens`, which counts only the uncached remainder --
 *             6 tokens against 64,647 cached on a real claude-sonnet turn.
 * Adding the cache figures to a codex reading would DOUBLE its input; not adding
 * them to an Anthropic reading is the 234x understatement above. Guessing by
 * tier name would be the fourth copy of a mapping this file refuses to keep, and
 * guessing by "cached looks big" is resemblance, which this record's writer
 * names as the thing it does not do.
 *
 * THE THREE ANSWERS, IN THE ORDER THEY ARE ASKED, none of which is a guess:
 *
 *   1. `inputBasis` -- the writer's own statement, from the SPELLING the engine
 *      used, of whether its input figure already contains the cache. See
 *      turnUsageFrom() in shell/usage-record.cjs. Recorded for the same reason
 *      `basis` is: a composition a reader has to guess is a composition a reader
 *      will eventually guess wrong.
 *
 *   2. ARITHMETIC, for the rows written before that field existed -- every row
 *      on this machine today. Two of them settle it outright:
 *        - the cache figures sum to zero, so both compositions give the same
 *          number and the question does not arise;
 *        - a cache figure EXCEEDS the input figure, which proves it is not
 *          inside it, because a subset cannot be larger than its set.
 *      MEASURED over the same 488 rows: 85 reported, 25 settled by the first,
 *      378 by the second, 0 left over. This is a proof about the figures in
 *      front of it, not a story about which engine wrote them.
 *
 *   3. UNKNOWN. A turn reporting cache figures that could be inside the input
 *      figure or beside it has a total this page cannot compute, and the two
 *      readings differ, so there is no number to print. It says so -- `unknown`,
 *      never 0. "The record does not state it" and "it cost nothing" are
 *      different answers and a zero tells the wrong one.
 *
 * `reasoningOutputTokens` is never added to anything. Codex reports it as a
 * subset of `outputTokens` (MEASURED: 85 of 85 reported-total rows have
 * reasoning ≤ output) and Anthropic does not report it at all, so adding it
 * would double-count the thinking on every codex turn.
 */
function turnTotalOf(figures, reported, inputBasis) {
  if (reported !== null) return { total: reported, reported: true, derived: false, unknown: false, cacheCounted: false }
  const input = figures.input
  const output = figures.output
  const cacheSum = (figures.cachedInput ?? 0) + (figures.cacheCreation ?? 0)
  const parts = input === null || output === null
  // A missing input or output is not zero. Even with known cache semantics,
  // a partial reading cannot establish the complete turn total.
  if (parts) return { total: null, reported: false, derived: false, unknown: true, cacheCounted: false }

  const withCache = () => ({ total: (input ?? 0) + cacheSum + (output ?? 0), reported: false, derived: true, unknown: false, cacheCounted: cacheSum > 0 })
  const withoutCache = () => ({ total: (input ?? 0) + (output ?? 0), reported: false, derived: true, unknown: false, cacheCounted: false })

  if (inputBasis === 'excludes-cache') return withCache()
  if (inputBasis === 'includes-cache') return withoutCache()
  if (cacheSum === 0) return withoutCache()
  /* A figure larger than the input figure cannot be a part of it. Compared
     against 0 rather than skipped when the input figure is absent, because a
     turn that reports cache reads and no input at all is a turn whose input
     figure contains nothing, cache included. */
  if ((figures.cachedInput ?? 0) > (input ?? 0) || (figures.cacheCreation ?? 0) > (input ?? 0)) return withCache()
  return { total: null, reported: false, derived: false, unknown: true, cacheCounted: false }
}

/**
 * Read the signed usage record, through the FOUR cases this page distinguishes.
 *
 * The fourth -- `tooOld` -- is the one that did not exist for the run reading
 * and has to exist here: this channel is newer than some shipped shells, and
 * "your record will not open" is a fault a person would go looking for a cause
 * of, while "this copy does not keep one yet" is a fact with an obvious next
 * step. Conflating them would repeat, in a smaller size, the exact defect the
 * top of this file records.
 *
 * `agent` is injected so a test never needs a global.
 */
export async function readLocalUsage({ agent = globalThis.mcAgent, limit = USAGE_HISTORY_LIMIT } = {}) {
  if (!agent) return Object.freeze({ supported: false, tooOld: false, readable: false, verified: null, total: 0, turns: Object.freeze([]) })
  if (typeof agent.usage !== 'function') {
    return Object.freeze({ supported: false, tooOld: true, readable: false, verified: null, total: 0, turns: Object.freeze([]) })
  }
  let raw
  try { raw = await agent.usage({ limit }) } catch { raw = null }
  if (historyDisabled(raw)) {
    return Object.freeze({ supported: true, tooOld: false, readable: false, disabled: true, verified: null, total: 0, turns: Object.freeze([]) })
  }
  if (!raw || typeof raw !== 'object' || raw.ok !== true || !Array.isArray(raw.entries)) {
    return Object.freeze({ supported: true, tooOld: false, readable: false, disabled: false, verified: null, total: 0, turns: Object.freeze([]) })
  }

  const turns = []
  for (const entry of raw.entries) {
    if (!entry || typeof entry !== 'object' || !entry.usage || typeof entry.usage !== 'object') continue
    const atMs = Date.parse(entry.at)
    const record = entry.usage
    const figures = {}
    for (const [name, field] of Object.entries(TOKEN_FIELDS)) figures[name] = usageNumber(record[field])
    const reported = usageNumber(record.totalTokens)
    /* DERIVED, AND MARKED AS DERIVED. A turn that reported no total still has
       parts the engine did say, and adding those is arithmetic over reported
       figures rather than an invented number -- but a reader is entitled to know
       which of the two it is looking at, so the flag travels with the row and the
       page prints the count. WHICH parts may be added, and when none may be, is
       turnTotalOf()'s question; the row carries its answer rather than a second
       opinion about it. */
    const inputBasis = record.inputBasis === 'includes-cache' || record.inputBasis === 'excludes-cache'
      ? record.inputBasis
      : null
    const totalling = turnTotalOf(figures, reported, inputBasis)
    turns.push(Object.freeze({
      sequence: Number.isSafeInteger(entry.sequence) ? entry.sequence : null,
      atMs: Number.isFinite(atMs) ? atMs : null,
      sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : null,
      turnId: typeof record.turnId === 'string' ? record.turnId : null,
      tier: typeof record.tier === 'string' ? record.tier : null,
      account: typeof record.account === 'string' ? record.account : null,
      status: typeof record.status === 'string' ? record.status : null,
      /* The provider's own sentence for a turn that ended badly, when the
         record kept one. Absent on every line written before the writer had the
         field, and absent whenever the sentence did not survive the host's
         bounding -- both of which are "the record does not say why", which is a
         different answer from "it did not fail". */
      failure: typeof record.failure === 'string' && record.failure.length > 0 ? record.failure : null,
      basis: record.basis === 'session-total' ? 'session-total' : 'turn',
      ...figures,
      totalTokens: totalling.total,
      reportedTotal: totalling.reported,
      derivedTotal: totalling.derived,
      /* THE ROW THIS PAGE MUST NOT PRINT A NUMBER FOR. Carried rather than left
         as a bare null so every panel below can tell "the record does not state
         this turn's total" from "this turn used nothing", which a null summed
         into a running figure silently collapses into the same zero. */
      unknownTotal: totalling.unknown,
      /* Whether the cache the provider served was counted INTO this turn's
         total, so the page can say that the figure includes it rather than
         leaving a reader to assume the 234x-smaller reading is still what they
         are looking at. */
      cacheCounted: totalling.cacheCounted,
      inputBasis,
      contextWindow: usageNumber(record.contextWindow),
      sessionTotalTokens: usageNumber(record.sessionTotalTokens),
    }))
  }

  return Object.freeze({
    supported: true,
    tooOld: false,
    readable: true,
    verified: raw.verified === true ? true : (raw.verified === false ? false : null),
    total: Number.isSafeInteger(raw.total) ? raw.total : turns.length,
    turns: Object.freeze(turns),
  })
}

/** Which of the four absences a usage reading is in, or null when there is data. */
function usageAbsenceOf(usage) {
  if (!isRecord(usage)) return LOCAL_USAGE_COPY.unreadable
  if (usage.tooOld === true) return LOCAL_USAGE_COPY.noUsageChannel
  if (usage.supported !== true) return LOCAL_USAGE_COPY.noChannel
  if (usage.disabled === true) return LOCAL_USAGE_COPY.disabled
  if (usage.readable !== true) return LOCAL_USAGE_COPY.unreadable
  if (!Array.isArray(usage.turns) || usage.turns.length === 0) return LOCAL_USAGE_COPY.empty
  return null
}

/* THE ONE PLACE A CUMULATIVE READING IS COLLAPSED, so that no grouping below
   can forget to.
 *
 * A `session-total` row is the engine's running total for that session, so the
 * session's contribution is the LARGEST such row it has, not the sum of them.
 * Turn rows are summed as they are. A session that somehow has both is counted
 * from its turn rows, because those are the finer reading and the running total
 * is a check on them rather than a second helping. */
function collapseSessions(turns) {
  const sessions = new Map()
  for (const turn of turns) {
    const key = turn.sessionId || `turn:${turn.sequence}`
    let row = sessions.get(key)
    if (!row) {
      row = { key, sessionId: turn.sessionId, turns: 0, unknownTurns: 0, cumulative: null, figures: {}, newestMs: null, tiers: new Set(), accounts: new Set() }
      for (const name of Object.keys(TOKEN_FIELDS)) row.figures[name] = null
      row.figures.total = null
      sessions.set(key, row)
    }
    if (turn.tier) row.tiers.add(turn.tier)
    if (turn.account) row.accounts.add(turn.account)
    if (turn.atMs !== null && (row.newestMs === null || turn.atMs > row.newestMs)) row.newestMs = turn.atMs
    if (turn.basis === 'session-total') {
      if (turn.totalTokens !== null && (row.cumulative === null || turn.totalTokens > row.cumulative)) row.cumulative = turn.totalTokens
      continue
    }
    row.turns += 1
    /* COUNTED EVEN THOUGH IT CANNOT BE ADDED. A turn whose total the record does
       not state still happened, and a session that quietly dropped it would
       report a smaller figure with no sign that anything was left out -- which
       is the zero this file refuses, wearing a session's name. */
    if (turn.unknownTotal) row.unknownTurns += 1
    for (const name of Object.keys(TOKEN_FIELDS)) {
      if (turn[name] === null) continue
      row.figures[name] = (row.figures[name] ?? 0) + turn[name]
    }
    if (turn.totalTokens !== null) row.figures.total = (row.figures.total ?? 0) + turn.totalTokens
  }
  for (const row of sessions.values()) {
    if (row.turns === 0 && row.cumulative !== null) {
      row.figures.total = row.cumulative
      row.turns = 1
    }
  }
  return sessions
}

const sumField = (sessions, name) => {
  let total = null
  for (const row of sessions.values()) {
    if (row.figures[name] === null) continue
    total = (total ?? 0) + row.figures[name]
  }
  return total
}

/* THE TURNS THAT ENDED BADLY, AND THE LAST THING ONE OF THEM SAID.
 *
 * A turn that reported figures of zero is not a turn that cost nothing to
 * explain: it is usually a turn the provider refused. This reads the status the
 * record kept -- through sessionTurnSucceeded, so codex's "completed" and the
 * Claude CLI's "success" are both a success and nothing else is -- and the
 * sentence beside it, so a page can say WHY instead of printing a zero.
 *
 * A TURN WITH NO STATUS IS NOT COUNTED AS A FAILURE, and that direction is
 * deliberate: every line written before the writer kept a status carries null,
 * and calling those failures would invent a wave of problems out of an old
 * record. Unknown is unknown.
 *
 * THE MODEL IS NAMED ONLY WHEN EVERY FAILURE IS THE SAME ONE. "A dead tier says
 * why" is a claim about one tier; naming a tier while a second was also failing
 * would point a person at the wrong row. */
function failureReading(turns) {
  const failed = turns.filter(turn => typeof turn.status === 'string' && !sessionTurnSucceeded(turn.status))
  if (failed.length === 0) return { count: 0, model: null, sentence: null }
  const tiers = new Set(failed.map(turn => turn.tier).filter(tier => typeof tier === 'string' && tier.length > 0))
  /* Newest first is the order the record is read in, so the first sentence
     found is the most recent one -- see readLocalUsage's caller contract. */
  const spoken = failed.find(turn => typeof turn.failure === 'string' && turn.failure.length > 0)
  return {
    count: failed.length,
    model: tiers.size === 1 ? modelOf([...tiers][0]) : null,
    sentence: spoken ? spoken.failure : null,
  }
}

/**
 * The headline: how many turns, and what they used, over the whole record this
 * page can see -- and, since a zero is only half an answer, how many of them
 * ended with a problem and what the last one of those said.
 */
export function usageTotals(usage) {
  const absence = usageAbsenceOf(usage)
  if (absence) {
    return Object.freeze({ ok: false, absence, turns: 0, tokens: null, sessions: 0, derivedTotals: 0, cacheCountedTurns: 0, cacheSentence: null, unknownTurns: 0, unknownSentence: null, failedTurns: 0, failureSentence: null, verified: null, sampled: false, note: null })
  }
  const sessions = collapseSessions(usage.turns)
  /* NOT `?? 0`. A record whose every total is one this page cannot compute has
     an unknown headline, and printing 0 there would say those turns cost
     nothing -- the exact claim the empty-record case a few lines up already
     refuses to make. */
  const tokens = { total: sumField(sessions, 'total') }
  for (const name of Object.keys(TOKEN_FIELDS)) tokens[name] = sumField(sessions, name)
  const derivedTotals = usage.turns.filter(turn => turn.derivedTotal).length
  const cacheCountedTurns = usage.turns.filter(turn => turn.cacheCounted).length
  const unknownTurns = usage.turns.filter(turn => turn.unknownTotal).length
  const failures = failureReading(usage.turns)
  /* The record holds one line per turn, so the whole-chain line count IS a turn
     count here -- unlike the run ledger, where a run is two lines. */
  const sampled = Number.isSafeInteger(usage.total) && usage.total > usage.turns.length
  return Object.freeze({
    ok: true,
    absence: null,
    turns: usage.turns.length,
    sessions: sessions.size,
    tokens: Object.freeze(tokens),
    derivedTotals,
    derivedSentence: derivedTotals > 0 ? LOCAL_USAGE_COPY.derived(derivedTotals, usage.turns.length) : null,
    cacheCountedTurns,
    cacheSentence: cacheCountedTurns > 0 ? LOCAL_USAGE_COPY.cacheCounted(cacheCountedTurns) : null,
    unknownTurns,
    unknownSentence: unknownTurns > 0 ? LOCAL_USAGE_COPY.unknownTurns(unknownTurns, usage.turns.length) : null,
    failedTurns: failures.count,
    failureSentence: failures.count > 0 ? LOCAL_USAGE_COPY.failedTurns(failures) : null,
    verified: usage.verified,
    sampled,
    note: sampled ? LOCAL_USAGE_COPY.sampled(usage.turns.length, usage.total) : null,
    sentence: usage.verified === false ? LOCAL_USAGE_COPY.sourceUnverified : LOCAL_USAGE_COPY.sourceLive,
  })
}

/* One grouping engine for the three "by something" panels, so they cannot
   disagree about what a session's tokens are. `keyOf` answers a key and a label
   for one collapsed session row; a null key means the record does not say, which
   is a row in its own right and never a row that is dropped. */
function groupSessions(usage, keyOf) {
  const absence = usageAbsenceOf(usage)
  if (absence) return Object.freeze({ ok: false, absence, rows: Object.freeze([]), total: 0 })
  const sessions = collapseSessions(usage.turns)
  const groups = new Map()
  let total = 0
  for (const row of sessions.values()) {
    const { key, label } = keyOf(row)
    const existing = groups.get(key) || { key, label, tokens: null, turns: 0, unknownTurns: 0, runs: 0 }
    /* `null + n` IS THE BUG THIS SHAPE PREVENTS. A group is a number only once
       something summable has landed in it; a group holding nothing but turns
       whose totals the record does not state stays null, so the row prints
       "unknown" instead of a 0 indistinguishable from a group that ran for
       free. Its turn and run counts are still real and still shown. */
    if (row.figures.total !== null) {
      existing.tokens = (existing.tokens ?? 0) + row.figures.total
      total += row.figures.total
    }
    existing.turns += row.turns
    existing.unknownTurns += row.unknownTurns
    existing.runs += 1
    groups.set(key, existing)
  }
  const rows = [...groups.values()]
    .sort((a, b) => (b.tokens ?? -1) - (a.tokens ?? -1) || a.label.localeCompare(b.label))
    .map(row => Object.freeze({ ...row, share: row.tokens !== null && total > 0 ? row.tokens / total : null }))
  return Object.freeze({ ok: true, absence: null, total, rows: Object.freeze(rows) })
}

/** Tokens per assistant -- Codex, Claude, or a row that says the record does not name one. */
export function usageByProvider(usage) {
  return groupSessions(usage, (row) => {
    const tier = row.tiers.size === 1 ? [...row.tiers][0] : null
    const provider = providerOf(tier)
    if (!provider) return { key: 'unrecorded', label: LOCAL_USAGE_COPY.providerUnrecorded }
    return { key: provider, label: PROVIDER_LABELS[provider] || provider }
  })
}

/** Tokens per model row -- Luna, Sonnet, and so on. */
export function usageByModel(usage) {
  return groupSessions(usage, (row) => {
    const tier = row.tiers.size === 1 ? [...row.tiers][0] : null
    const label = modelOf(tier)
    if (!label) return { key: 'unrecorded', label: LOCAL_USAGE_COPY.providerUnrecorded }
    return { key: tier, label }
  })
}

/** Tokens per sign-in, for a person who runs agents on more than one account. */
export function usageByAccount(usage) {
  return groupSessions(usage, (row) => {
    const account = row.accounts.size === 1 ? [...row.accounts][0] : null
    if (!account) return { key: 'unrecorded', label: LOCAL_USAGE_COPY.accountUnrecorded }
    return { key: account, label: account }
  })
}

/**
 * Tokens per agent.
 *
 * WHICH agent a session was is not in the record and deliberately is not: the
 * ledger is about this machine, and the role a person gave a node lives in the
 * page's own saved conversation, keyed by session. So this is a JOIN, exactly
 * like runRows() above, and an unmatched run gets a row saying the record cannot
 * name it rather than being dropped or given a made-up name.
 */
export function usageByAgent(usage, { conversations = null } = {}) {
  return groupSessions(usage, (row) => {
    const said = row.sessionId && conversations && typeof conversations.get === 'function'
      ? conversations.get(row.sessionId)
      : null
    const role = said && typeof said.role === 'string' && said.role ? said.role : null
    if (!role) return { key: 'unnamed', label: LOCAL_USAGE_COPY.agentUnnamed }
    return { key: role, label: role }
  })
}

/** Tokens per run, newest first, with what the run was asked when the page knows it. */
export function usageByRun(usage, { conversations = null, limit = 40 } = {}) {
  const absence = usageAbsenceOf(usage)
  if (absence) return Object.freeze({ ok: false, absence, rows: Object.freeze([]), total: 0 })
  const sessions = [...collapseSessions(usage.turns).values()]
    .sort((a, b) => (b.newestMs ?? 0) - (a.newestMs ?? 0))
  const rows = sessions.slice(0, limit).map(row => {
    const said = row.sessionId && conversations && typeof conversations.get === 'function'
      ? conversations.get(row.sessionId)
      : null
    const tier = row.tiers.size === 1 ? [...row.tiers][0] : null
    return Object.freeze({
      sessionId: row.sessionId,
      turns: row.turns,
      /* Null, not 0, for the same reason the group rows above are: this table
         puts one run on one line, and a line reading 0 beside four turns is
         this page asserting the run was free. */
      tokens: row.figures.total,
      unknownTurns: row.unknownTurns,
      atMs: row.newestMs,
      at: Number.isFinite(row.newestMs) ? new Date(row.newestMs).toLocaleString() : '',
      model: modelOf(tier) || '',
      asked: said && typeof said.asked === 'string' ? said.asked : '',
      agent: said && typeof said.role === 'string' ? said.role : '',
    })
  })
  return Object.freeze({ ok: true, absence: null, total: sessions.length, rows: Object.freeze(rows) })
}

/**
 * Tokens per local calendar day, over the same seven-day window the activity
 * panel already promises -- and local rather than UTC for the same reason that
 * panel is: a person reading "what did I use" means their own midnight.
 *
 * A CUMULATIVE ROW IS NOT PLACED ON A DAY. Its figure belongs to a whole session
 * rather than to the moment it happened to be reported, so putting it on one day
 * would spike that day with tokens spent across several. Those sessions are in
 * the totals and are counted out of the chart, which `outsideWindow` says.
 */
export function usageByDay(usage, nowMs = Date.now()) {
  const absence = usageAbsenceOf(usage)
  const today = dayStart(nowMs)
  const days = []
  for (let offset = ACTIVITY_DAYS - 1; offset >= 0; offset -= 1) {
    const startMs = addDays(today, -offset)
    days.push({
      startMs,
      label: DAY_LABEL.format(new Date(startMs)),
      dateLabel: DATE_LABEL.format(new Date(startMs)),
      tokens: 0,
      turns: 0,
    })
  }
  if (absence) return Object.freeze({ ok: false, absence, days: Object.freeze([]), max: 0, windowTokens: 0, outsideWindow: 0 })

  const earliest = days[0].startMs
  let windowTokens = 0
  let outsideWindow = 0
  let max = 0
  for (const turn of usage.turns) {
    if (turn.basis === 'session-total') { outsideWindow += 1; continue }
    if (!Number.isFinite(turn.atMs) || turn.atMs < earliest || turn.totalTokens === null) {
      if (turn.totalTokens !== null) outsideWindow += 1
      continue
    }
    /* Rounded, not floored -- see the matching note in activityGrid above. */
    const index = Math.round((dayStart(turn.atMs) - earliest) / DAY_MS)
    if (index < 0 || index >= days.length) continue
    days[index].tokens += turn.totalTokens
    days[index].turns += 1
    windowTokens += turn.totalTokens
    if (days[index].tokens > max) max = days[index].tokens
  }
  const frozen = Object.freeze(days.map(day => Object.freeze({ ...day })))
  if (windowTokens === 0) {
    return Object.freeze({ ok: false, absence: LOCAL_USAGE_COPY.emptyWindow, days: frozen, max: 0, windowTokens: 0, outsideWindow })
  }
  return Object.freeze({ ok: true, absence: null, days: frozen, max, windowTokens, outsideWindow })
}

/** Everything the token panels need, from one usage record and one clock. */
export function describeLocalUsage(usage, { nowMs = Date.now(), conversations = null } = {}) {
  return Object.freeze({
    totals: usageTotals(usage),
    byProvider: usageByProvider(usage),
    byModel: usageByModel(usage),
    byAccount: usageByAccount(usage),
    byAgent: usageByAgent(usage, { conversations }),
    byRun: usageByRun(usage, { conversations }),
    byDay: usageByDay(usage, nowMs),
  })
}

/* Exported for the view's own guard: a reading that is not ok must never be
   rendered as an empty chart, so the view asks this rather than testing
   `.rows.length` and getting the wrong answer for an unreadable record. */
export function readingAbsence(reading) {
  if (!isRecord(reading)) return LOCAL_METRICS_COPY.unreadable
  return reading.ok === true ? null : (reading.absence || LOCAL_METRICS_COPY.unreadable)
}

/* Re-exported so the view has one import for everything it prints, and so a
   future caller cannot reach for a second copy of the reason table. */
export { ENGINE_REASON }
