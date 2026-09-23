/* THE EXAMPLE FLEET'S OWN REQUEST REGISTER, IN THE LIVE SHAPE.
 *
 * The ledger page has one render path, and this module is what feeds it when
 * the demonstration is on screen. So the data here must be in EXACTLY the
 * shape src/ledger-live.js produces -- one row per request as rowOf() shapes
 * it, and the questions half as the observation the Q tab reads -- so that
 * from the assignment onward the render cannot tell the two apart and never
 * needs to. The badge, not the code path, is what separates them.
 *
 * WHAT A ROW CARRIES, mirrored from src/ledger-live.js rowOf():
 *
 *   - id, parentId, scope, scopeKey, scopeLabel: who the rule reaches. The
 *     scope words are the ledger's own (global, tree, session, thread); a
 *     label is the name the person saw when filing (a node's name); a key is
 *     the anchor id, shaped like the fleet-tree ids this window mints.
 *   - status, state: the ledger's status word and the rail glyph the page
 *     draws for it. R3's `state` reads 'blocked-external', its own exact
 *     rail mark since the owner's Resolve action (2026-09-07) gave that
 *     status its own glyph -- but the six-tile SUMMARY STRIP stays coarse
 *     by Controller's ruling the same day (src/views/ledger.js
 *     summaryTileOf): a blocked-external row still counts in the existing
 *     'blocked' tile, so R3 lights it again by a real status even though
 *     its rail glyph is no longer literally 'blocked'. Every one of the six
 *     summary tiles is lit, because a demonstration with tiles stuck at
 *     zero reads as a worse product, and one row is removed so "Show
 *     removed" has something to show.
 *   - words: the person's own sentence, verbatim. The example keeps to the
 *     sample fleet's world -- connecting THIS install, describing machines,
 *     deciding gates -- so nothing here reads as a real machine's decisions.
 *   - filedBy, filedAt: 'owner' for the person; an agent's own name (codex,
 *     claude) for a rule it filed from something the person said. R7 is the
 *     one proposed row, filed by an agent and waiting for approval.
 *   - gateCount, unmetGateCount, decisions, history, removedAt, removed.
 *
 *   - Question statuses are TWO fields, not one: a free-text `status` a
 *     person reads, and a machine `statusClass` the page branches on. The
 *     enum is open | in-progress | blocked | done | unknown, and the
 *     register's "N open" counter keys on statusClass === 'open'.
 *
 * DETERMINISTIC ON PURPOSE, same convention as src/sample-activity.js: no
 * Math.random and no persisted state -- the same nowMs produces deep-equal
 * output every call, so screenshots compare and the register does not
 * reshuffle itself on navigation. Objects are built fresh per call so no
 * caller's mutation can poison the next render. Every timestamp is derived
 * from nowMs and lands before it.
 */

const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS

const iso = (ms) => new Date(ms).toISOString()

/* Eight requests, seven distinct glyphs. Ids and gates follow the old sample
 * outline's roots: R1 connect-this-install (LOCAL-WORK, met, underway),
 * R1.1 detect-a-host (finished; a refinement filed by an agent), R2
 * describe-your-machines (two gates, one still unmet, moving on the ungated
 * parts), R3 decide-what-runs-unasked (IRREVERSIBLE gate unmet, so blocked),
 * R4 point-at-your-own-register (nothing gates it; nobody has picked it up),
 * R5 (deleted by the person, kept as deleted), R6 review-what-leaves-this-
 * machine (OUTWARD gate unmet, waiting at it), R7 (an agent's proposal,
 * waiting for approval). unmetGateCount never exceeds gateCount, because
 * "gates 1 · unmet 2" reads as a broken register. `agoMs` is how long before
 * nowMs each was filed. */
const SAMPLE_LIVE_REQUESTS = Object.freeze([
  Object.freeze({
    id: 'R1', parentId: null, scope: 'global', scopeKey: null, scopeLabel: null,
    status: 'in-progress', state: 'in-progress',
    words: 'Connect this install to the example fleet before anything else runs.',
    filedBy: 'owner', agoMs: 9 * DAY_MS, gateCount: 1, unmetGateCount: 0, decisions: 0, removed: false,
  }),
  Object.freeze({
    id: 'R1.1', parentId: 'R1', scope: 'tree', scopeKey: 'node-1-2f6a9c3e', scopeLabel: 'Coordinator',
    status: 'done', state: 'done',
    words: 'Detect a host on this machine before asking the person to name one.',
    filedBy: 'claude', agoMs: 8 * DAY_MS, gateCount: 0, unmetGateCount: 0, decisions: 1, removed: false,
  }),
  Object.freeze({
    id: 'R2', parentId: null, scope: 'session', scopeKey: 'chat-7c1d0e5b', scopeLabel: 'Coordinator · session',
    status: 'in-progress', state: 'gated',
    words: 'Describe each of my machines in one line before you change anything on it.',
    filedBy: 'owner', agoMs: 6 * DAY_MS, gateCount: 2, unmetGateCount: 1, decisions: 0, removed: false,
  }),
  Object.freeze({
    id: 'R3', parentId: null, scope: 'thread', scopeKey: 'node-3-9b4e1d20', scopeLabel: 'Manager 2',
    status: 'blocked-external', state: 'blocked-external',
    words: 'Decide what may run without asking, and never widen that list on your own.',
    filedBy: 'owner', agoMs: 5 * DAY_MS, gateCount: 1, unmetGateCount: 1, decisions: 0, removed: false,
  }),
  Object.freeze({
    id: 'R4', parentId: null, scope: 'global', scopeKey: null, scopeLabel: null,
    status: 'open', state: 'open',
    words: 'Point every report at my own register, not at the example one.',
    filedBy: 'owner', agoMs: 4 * DAY_MS, gateCount: 0, unmetGateCount: 0, decisions: 0, removed: false,
  }),
  Object.freeze({
    id: 'R5', parentId: null, scope: 'global', scopeKey: null, scopeLabel: null,
    status: 'removed', state: 'removed',
    words: 'Keep the old machine list; it is out of date.',
    filedBy: 'owner', agoMs: 3 * DAY_MS, gateCount: 0, unmetGateCount: 0, decisions: 0, removed: true,
  }),
  Object.freeze({
    id: 'R6', parentId: null, scope: 'global', scopeKey: null, scopeLabel: null,
    status: 'open', state: 'gated',
    words: 'Review what leaves this machine with me before it goes anywhere.',
    filedBy: 'owner', agoMs: 2 * DAY_MS, gateCount: 1, unmetGateCount: 1, decisions: 0, removed: false,
  }),
  Object.freeze({
    id: 'R7', parentId: null, scope: 'tree', scopeKey: 'node-1-2f6a9c3e', scopeLabel: 'Coordinator',
    status: 'proposed', state: 'proposed',
    words: 'Ask me before installing anything on a machine I have not named.',
    filedBy: 'codex', agoMs: 5 * HOUR_MS, gateCount: 0, unmetGateCount: 0, decisions: 0, removed: false,
  }),
])

/* THE OWNER'S OTHER SUBSETS, DEMONSTRATED (T1416). The example used to hold
 * rules only, so its Tasks and Asks tabs showed "There are no tasks" to the
 * very person the example exists to show them to. A handful of tasks and asks
 * in their own statuses -- one in progress, one repeating with its runs, one
 * blocked on the owner with the reason, one done, one ask waiting and one
 * answered -- in the feed's exact row shape. No purchases: the example fleet's
 * words stay clear of money. */
const SAMPLE_TASKS_AND_ASKS = Object.freeze([
  Object.freeze({
    id: 'T21', state: 'in-progress', kind: 'T', parentId: null, scope: 'tree', scopeKey: 'node-1-2f6a9c3e', scopeLabel: 'Coordinator',
    status: 'in-progress', words: 'Draft a one-page summary of what each machine did this week.',
    filedBy: 'claude', agoMs: 2 * DAY_MS, gateCount: 0, unmetGateCount: 0, decisions: 0, removed: false,
  }),
  Object.freeze({
    id: 'T22', state: 'unknown', kind: 'T', parentId: null, scope: 'global', scopeKey: null, scopeLabel: null,
    status: 'recurring', words: 'Check that last night\'s backup finished, every morning.',
    filedBy: 'owner', agoMs: 6 * DAY_MS, gateCount: 0, unmetGateCount: 0, decisions: 0, removed: false,
    runsAgoMs: [2 * DAY_MS, 1 * DAY_MS],
  }),
  Object.freeze({
    id: 'T23', state: 'blocked-external', kind: 'T', parentId: null, scope: 'global', scopeKey: null, scopeLabel: null,
    status: 'blocked-external', words: 'Copy the design folder to the shared drive.',
    filedBy: 'codex', agoMs: 3 * DAY_MS, gateCount: 0, unmetGateCount: 0, decisions: 1, removed: false,
    progress: { reason: 'needs you to sign in to the shared drive once', agoMs: 20 * HOUR_MS },
  }),
  Object.freeze({
    id: 'T24', state: 'done', kind: 'T', parentId: null, scope: 'global', scopeKey: null, scopeLabel: null,
    status: 'done', words: 'Rename the laptop to match the fleet list.',
    filedBy: 'owner', agoMs: 7 * DAY_MS, gateCount: 0, unmetGateCount: 0, decisions: 0, removed: false,
    doneAgoMs: 5 * DAY_MS,
  }),
  Object.freeze({
    id: 'A11', state: 'open', kind: 'A', parentId: null, scope: 'tree', scopeKey: 'node-1-2f6a9c3e', scopeLabel: 'Coordinator',
    status: 'open', words: 'May I restart the build machine tonight to finish the update?',
    filedBy: 'codex', agoMs: 3 * HOUR_MS, gateCount: 0, unmetGateCount: 0, decisions: 0, removed: false,
  }),
  Object.freeze({
    id: 'A12', state: 'unknown', kind: 'A', parentId: null, scope: 'global', scopeKey: null, scopeLabel: null,
    status: 'answered', words: 'Should old chat logs older than a month be kept?',
    filedBy: 'claude', agoMs: 4 * DAY_MS, gateCount: 0, unmetGateCount: 0, decisions: 0, removed: false,
    answered: { words: 'Keep them; I will tidy them myself.', agoMs: 3 * DAY_MS },
  }),
])

/* Three questions, keeping the old sample's numbering where a question
 * survives (Q1, Q2, Q7), so anyone comparing the two sets can see the
 * lineage. The free-text status is written as English because it renders in
 * the row's meta slot; the statusClass beside it is what the page branches
 * on. Q1 is the required open one -- an unanswered question is the state the
 * Q register exists for -- and it carries the null packageId. */
const SAMPLE_LIVE_QUESTIONS = Object.freeze([
  Object.freeze({
    id: 'Q1',
    title: 'Which machines should this install treat as one fleet?',
    status: 'waiting on an owner decision',
    statusClass: 'open',
    packageId: null,
  }),
  Object.freeze({
    id: 'Q2',
    title: 'Should idle lanes be reaped automatically, or held for review?',
    status: 'answered — reap them automatically',
    statusClass: 'done',
    packageId: 'sample/lane-policy',
  }),
  Object.freeze({
    id: 'Q7',
    title: 'Which actions may never run without a decision first?',
    status: 'being drafted into the gate policy',
    statusClass: 'in-progress',
    packageId: 'sample/gate-policy',
  }),
])

/* How long before nowMs the sample's question sweep "ran". Small and fixed:
 * recent enough to read as a live record, non-zero so observedAt and any
 * caller's own clock visibly disagree the way two real clocks do. */
const QUESTIONS_OBSERVED_AGO_MS = 4 * 60_000

/* One row in the feed's shape. The history is the one line every record
   carries -- its filing -- plus a removal line for the deleted one, with the
   sequence numbers the chain would have handed out in filing order. */
function rowOf(item, index, nowMs) {
  const { agoMs, ...fields } = item
  const filedAt = iso(nowMs - agoMs)
  const removedAt = fields.removed ? iso(nowMs - agoMs + 6 * HOUR_MS) : null
  const history = [{ seq: index + 1, kind: 'file', at: filedAt, actor: fields.filedBy }]
  if (fields.removed) history.push({ seq: SAMPLE_LIVE_REQUESTS.length + 1, kind: 'remove', at: removedAt, actor: 'owner' })
  /* THE OWNER'S FOUR SUBSETS (2026-09-07): every sample here is an R, and
     src/ledger-live.js rowOf() answers 'R' for a record with no kind field
     and an id starting with a letter it does not mint T/A/P from -- see its
     own KIND_LETTERS comment. The five kind-specific fields (recurrence,
     completedAt, completedBy, answer, purchase) all answer null for an R,
     the same as they would for any real rule this window has ever filed. */
  return { kind: 'R', recurrence: null, completedAt: null, completedBy: null, supersedes: null, supersededBy: null, answer: null, purchase: null, latestDecision: null, ...fields, filedAt, history, removedAt }
}

/**
 * The example fleet's R/Q register, in exactly the shape the ledger page's
 * feed produces: `{ requests, questions: { ok, reason, observedAt, value },
 * revision, updatedAt, exists, chain }`. Hand it to the same render path a
 * real read feeds; add a field here only when src/ledger-live.js rowOf()
 * produces it too.
 */
/* One task or ask in the feed's shape, the way rowOf() above shapes a rule. */
function kindRowOf(item, index, nowMs) {
  const { agoMs, runsAgoMs, progress, doneAgoMs, answered, ...fields } = item
  const filedAt = iso(nowMs - agoMs)
  const seq = SAMPLE_LIVE_REQUESTS.length + 2 + index
  const history = [{ seq, kind: 'file', at: filedAt, actor: fields.filedBy }]
  const recurrence = runsAgoMs ? { interval: 'daily', completions: runsAgoMs.map(ago => ({ at: iso(nowMs - ago), actor: 'owner' })) } : null
  const completedAt = doneAgoMs ? iso(nowMs - doneAgoMs) : runsAgoMs ? iso(nowMs - runsAgoMs.at(-1)) : null
  const answer = answered ? { words: answered.words, at: iso(nowMs - answered.agoMs) } : null
  if (answered) history.push({ seq: seq + 100, kind: 'answer', at: answer.at, actor: 'owner' })
  const latestDecision = progress ? { decision: 'progress', status: fields.status, reason: progress.reason, at: iso(nowMs - progress.agoMs), actor: fields.filedBy } : null
  return {
    recurrence, completedAt, completedBy: completedAt ? 'owner' : null, supersedes: null, supersededBy: null, answer, purchase: null, latestDecision,
    /* `state` is the rule rail's reading of the status (src/ledger-live.js
       stateOf), written out so this module stays free of imports; the page
       draws tasks and asks from their status. */
    ...fields, filedAt, history, removedAt: null,
  }
}

export function sampleLedgerData(nowMs = Date.now()) {
  return {
    requests: [
      ...SAMPLE_LIVE_REQUESTS.map((item, index) => rowOf(item, index, nowMs)),
      ...SAMPLE_TASKS_AND_ASKS.map((item, index) => kindRowOf(item, index, nowMs)),
    ],
    /* The observation envelope exists because the questions half can fail
       independently of the requests half; the demonstration shows the
       ordinary case -- a sweep that worked -- because the failure faces are
       different screens that deserve their own demonstrations. */
    questions: {
      ok: true,
      reason: null,
      observedAt: iso(nowMs - QUESTIONS_OBSERVED_AGO_MS),
      value: SAMPLE_LIVE_QUESTIONS.map(item => ({ ...item })),
    },
    revision: SAMPLE_LIVE_REQUESTS.length + 1,
    updatedAt: iso(nowMs - 5 * HOUR_MS).slice(0, 10),
    exists: true,
    chain: { ok: true, events: SAMPLE_LIVE_REQUESTS.length + 1, drift: [], unchained: [], code: null },
  }
}
