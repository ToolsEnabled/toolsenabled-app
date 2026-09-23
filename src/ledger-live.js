/* THE LEDGER PAGE'S FEED: the person's requests from the installed
 * application, and the questions from the build-time report.
 *
 * TWO SOURCES, ONE ANSWER. The R rows come from the canonical request ledger
 * the installed application keeps (window.mcAgent.ledger, a read that creates
 * nothing). The Q rows still come from the report written when ToolsEnabled
 * itself is built (src/live-status.js fetchLedger), because nothing in the
 * shipped program writes a question. The two halves fail independently and
 * say so independently: an install that has no report file must show only
 * the Q tab's own notice, never flip the R tab to "could not be read".
 *
 * EVERY ROW IS SHAPED HERE, ONCE. src/sample-ledger.js produces rows in
 * exactly this shape for the example register, so the view cannot tell the two
 * apart and never needs to -- the badge, not the code path, separates them.
 */

import { fetchLedger } from './live-status.js'

/* The one refusal this module writes itself: a browser with no installed
   application behind it has nowhere to read the ledger from. The sentence
   rides as data on the register; the view paints its own notice. */
export const NO_HOST_REASON = 'This copy has no installed application to read your requests from.'

/* Which glyph a record wears on the page's left rail. The status vocabulary is
   the ledger's own (proposed, open, in-progress, partial, blocked-external,
   done, not-possible-as-asked, superseded, declined, removed).
   THE OWNER'S RESOLVE ACTION (2026-09-07): the owner's own Resolve control
   (src/views/ledger.js) moves a standing row to one of RESOLUTION_STATUSES --
   in-progress, partial, blocked-external, done, not-possible-as-asked,
   superseded -- and four of those used to collapse into a neighbour here
   (partial into in-progress, blocked-external and not-possible-as-asked both
   into the one generic 'blocked', superseded into 'unknown' since nothing
   wrote it before this feature). Each now reads its own rail mark, so
   "partly done" cannot be mistaken for "still going" and "blocked on
   someone else" cannot be mistaken for "not possible at all". */
export function stateOf(record) {
  const status = typeof record?.status === 'string' ? record.status : ''
  if (status === 'proposed') return 'proposed'
  if (status === 'removed' || status === 'declined') return 'removed'
  if (status === 'done') return 'done'
  if (status === 'superseded') return 'superseded'
  if (status === 'blocked-external') return 'blocked-external'
  if (status === 'not-possible-as-asked') return 'not-possible-as-asked'
  /* Any other 'blocked*' shape (legacy or future) still reads as the
     generic mark; only the two named statuses above earned their own. */
  if (status.startsWith('blocked')) return 'blocked'
  const unmet = Number.isSafeInteger(record?.unmetGateCount) ? record.unmetGateCount : 0
  if (status === 'open' || status === 'in-progress' || status === 'partial') {
    if (unmet > 0) return 'gated'
    if (status === 'open') return 'open'
    if (status === 'partial') return 'partial'
    return 'in-progress'
  }
  return 'unknown'
}

const text = value => (typeof value === 'string' ? value : '')
const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : 0)
/* T's recurrence, A's answer and P's purchase: the engine's own small plain
   objects, passed through shallow-frozen. Never a string, so `text()` above
   is the wrong tool for them; see canonical-ledger-read.cjs's own copy of
   this same rule for why they are not picked apart field by field. */
const plainObject = value => (value && typeof value === 'object' && !Array.isArray(value) ? Object.freeze({ ...value }) : null)
/* The latest decision's own words (shell/canonical-ledger-read.cjs
   latestDecisionOf), or null. Every field a string or null. */
const decisionOf = value => (value && typeof value === 'object' && typeof value.decision === 'string'
  ? Object.freeze({
      decision: value.decision,
      status: text(value.status) || null,
      reason: text(value.reason).slice(0, 2048) || null,
      at: text(value.at) || null,
      actor: text(value.actor) || null,
    })
  : null)

/* THE OWNER'S FOUR SUBSETS (2026-09-07): R for rules, T for tasks, A for
   asks, P for purchases. The engine lane (L1) is adding a `kind` field to
   every stored record; until it lands, a record carries none, and the ONLY
   honest thing this reader can do is what the shared interface says --
   derive it from the id's own letter, and call a record with no letter it
   recognises 'R', because every record before this feature was an R. This
   must never guess 'T', 'A' or 'P': a record whose id does not start with
   one of those letters is R, full stop, matching the ids this ledger has
   always minted (R1, R00, R12.3). */
const KIND_LETTERS = new Set(['R', 'T', 'A', 'P'])
export function kindOf(record) {
  const source = record && typeof record === 'object' ? record : {}
  if (typeof source.kind === 'string' && KIND_LETTERS.has(source.kind)) return source.kind
  const id = typeof source.id === 'string' ? source.id : ''
  const letter = id.slice(0, 1).toUpperCase()
  return KIND_LETTERS.has(letter) ? letter : 'R'
}

/** One ledger record as the page draws it. Every field the view reads. */
export function rowOf(record) {
  const source = record && typeof record === 'object' ? record : {}
  const history = Array.isArray(source.history)
    ? source.history
      .filter(entry => entry && typeof entry === 'object')
      .map(entry => ({ seq: count(entry.seq), kind: text(entry.kind), at: text(entry.at), actor: text(entry.actor) }))
    : []
  return {
    id: text(source.id),
    kind: kindOf(source),
    difficulty: ['easy', 'medium', 'hard'].includes(source.difficulty) ? source.difficulty : null,
    failedReviewCount: Number.isSafeInteger(source.failedReviewCount) && source.failedReviewCount >= 0 ? source.failedReviewCount : null,
    recurrence: plainObject(source.recurrence),
    completedAt: text(source.completedAt) || null,
    completedBy: text(source.completedBy) || null,
    /* T's terminal superseded pair: which task this one replaces, and which
       task replaced it, once the store has both. */
    supersedes: text(source.supersedes) || null,
    supersededBy: text(source.supersededBy) || null,
    answer: plainObject(source.answer),
    purchase: plainObject(source.purchase),
    parentId: text(source.parentId) || null,
    scope: text(source.scope) || 'global',
    scopeKey: text(source.scopeKey) || null,
    scopeLabel: text(source.scopeLabel) || null,
    status: text(source.status) || 'unknown',
    state: stateOf(source),
    words: text(source.words),
    filedBy: text(source.filedBy) || 'owner',
    filedAt: text(source.filedAt) || null,
    gateCount: count(source.gateCount),
    unmetGateCount: count(source.unmetGateCount),
    decisions: count(source.decisions),
    latestDecision: decisionOf(source.latestDecision),
    history,
    removedAt: text(source.removedAt) || null,
    removed: Boolean(source.removedAt) || source.status === 'removed' || source.status === 'declined',
  }
}

/* The questions half, in the observation shape the Q tab reads:
   { ok, reason, observedAt, value }. A report that answered -- even with
   "there is no fleet here" -- is an answered empty list; a read that fell
   over is not. */
async function questionsObservation() {
  let result
  try {
    result = await fetchLedger()
  } catch (error) {
    return { ok: false, reason: error?.message || String(error), observedAt: null, value: [] }
  }
  if (result?.ok && result.data?.data?.questions && typeof result.data.data.questions === 'object') {
    const questions = result.data.data.questions
    return {
      ok: questions.ok !== false,
      reason: questions.reason ?? null,
      observedAt: questions.observedAt ?? null,
      value: Array.isArray(questions.value) ? questions.value : [],
    }
  }
  if (result?.data && typeof result.data === 'object') {
    return { ok: true, reason: result.reason ?? null, observedAt: null, value: [] }
  }
  return { ok: false, reason: result?.reason || 'the questions report did not answer', observedAt: null, value: [] }
}

/**
 * Read the register.
 *
 * Returns { ok: true, data: { requests, questions, revision, updatedAt, exists,
 * chain } } or { ok: false, reason, code?, questions }. An answered list with
 * no rows is ok: true with an empty `requests` -- the ordinary state of a fresh
 * install, never a failure.
 *
 * THE QUESTIONS HALF RIDES ON EVERY REPLY, the failed ones included. A browser
 * reading over the relay has no window.mcAgent, and an older installed
 * application has no ledger verb; either way the requests half cannot be
 * read, but the questions report is a build-time file that is read the same
 * way whether or not a ledger answers. Start both independent reads together;
 * every success or failure still waits for and carries the questions result.
 * The view keeps the two apart.
 */
export async function fetchLiveLedger({ scope = 'all', removed = false } = {}) {
  const questionsPending = questionsObservation()
  const bridge = typeof window === 'undefined' ? null : window.mcAgent
  if (!bridge || typeof bridge.ledger !== 'function') {
    return { ok: false, reason: NO_HOST_REASON, code: 'AGENT_LEDGER_UNAVAILABLE', questions: await questionsPending }
  }
  let reply
  try {
    reply = await bridge.ledger({ scope, key: null, removed: removed === true })
  } catch (error) {
    return { ok: false, reason: error?.message || String(error), code: 'AGENT_LEDGER_UNREADABLE', questions: await questionsPending }
  }
  const questions = await questionsPending
  if (!reply || reply.ok !== true) {
    return {
      ok: false,
      reason: text(reply?.reason) || 'the installed application did not answer',
      code: text(reply?.code) || 'AGENT_LEDGER_UNREADABLE',
      /* A damaged ledger file with a usable backup beside it (T1382). */
      ...(reply?.code === 'AGENT_LEDGER_DAMAGED' ? { backup: reply.backup === true } : {}),
      questions,
    }
  }
  const records = Array.isArray(reply.records) ? reply.records : []
  const chain = reply.chain && typeof reply.chain === 'object'
    ? {
        checked: reply.chain.checked !== false,
        ok: reply.chain.checked === false ? null : reply.chain.ok === true,
        events: count(reply.chain.events),
        drift: Array.isArray(reply.chain.drift) ? reply.chain.drift.map(text).filter(Boolean) : [],
        missing: Array.isArray(reply.chain.missing) ? reply.chain.missing.map(text).filter(Boolean) : [],
        unchained: Array.isArray(reply.chain.unchained) ? reply.chain.unchained.map(text).filter(Boolean) : [],
        code: text(reply.chain.code) || null,
      }
    : { ok: false, events: 0, drift: [], missing: [], unchained: [], code: 'AGENT_LEDGER_UNREADABLE' }
  return {
    ok: true,
    data: {
      requests: records.map(rowOf),
      questions,
      revision: count(reply.revision),
      updatedAt: text(reply.updatedAt) || null,
      exists: reply.exists !== false,
      chain,
    },
  }
}
