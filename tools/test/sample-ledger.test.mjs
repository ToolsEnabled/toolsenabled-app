// THE SAMPLE REGISTER MUST BE SHAPED LIKE THE LIVE ONE, EXACTLY.
//
// src/sample-ledger.js feeds the ledger page's one render path when the
// example is on screen, in the shape src/ledger-live.js produces from the
// installed application's request ledger. The R half is therefore held to the
// feed's own row shape (rowOf), field for field; the Q half is still the
// build-time report's observation and is held to the projection schema the
// report is validated against. Plus the demonstration's own promises: every
// summary tile lit, one proposed row an agent filed, one removed row for
// "Show removed", the picker fed, an open question to answer, determinism.
//
// THE FIELD LISTS BELOW ARE THE FEED'S. If a failure lands here after an edit
// to src/ledger-live.js rowOf(), the repair is to move BOTH the sample and
// these lists together -- not to widen the assertion.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateAgainstSchema } from '../gen-projection-lib.mjs'
import { sampleLedgerData } from '../../src/sample-ledger.js'
import { rowOf, stateOf } from '../../src/ledger-live.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = relative => readFileSync(path.join(REPO, relative), 'utf8')

/* A fixed clock. Determinism is the point: no test here may call Date.now()
   to build an expectation. */
const NOW_MS = Date.parse('2026-08-21T17:30:00.000Z')

/* Every field the feed puts on a REQUEST row, and no others -- taken from a
   real rowOf() call rather than retyped, so the two cannot drift. */
const REQUEST_FIELDS = Object.keys(rowOf({ id: 'R1', status: 'open' })).sort()

/* Every field the live branch reads from a QUESTION row, and no others.
   Matches the schema's $defs.question. */
const QUESTION_FIELDS = ['id', 'packageId', 'status', 'statusClass', 'title']

/* The questions observation envelope. The Q tab reads .value, .ok and
   .reason; observedAt is required by the schema the report is validated
   against, so it is load-bearing even though no pixel shows it. */
const OBSERVATION_FIELDS = ['observedAt', 'ok', 'reason', 'value']

/* The rail glyphs the page paints for a request, minus 'unknown' -- the
   fall-through for a status nobody classified. A demonstration must not
   demonstrate the unclassified glyph. THE OWNER'S RESOLVE ACTION
   (2026-09-07): 'blocked-external' is now its own rail mark (see
   src/ledger-live.js stateOf), the way 'gated' already stands apart from
   plain 'open' -- and the ledger's own status vocabulary
   (LEDGER_STATUSES below) has no bare 'blocked' status left to produce the
   old generic mark from, so this list names the one it actually reaches
   now, in R3's place.
   THIS LIST IS THE RAIL'S OWN, NOT THE SUMMARY STRIP'S. Controller's
   second ruling the same day keeps the six-tile strip coarse
   (src/views/ledger.js summaryTileOf): for COUNTING only,
   'blocked-external' folds back into the 'blocked' tile and 'partial'
   folds into 'in-progress', so R3 still lights the strip's 'blocked' tile
   even though this list, correctly, no longer names bare 'blocked' as a
   rail mark. SUMMARY_STATES itself was not extended for the four
   newly-distinct statuses (partial, blocked-external, not-possible-as-asked,
   superseded), the same scoping T's own recurring/answered/approved states
   already have -- see REPORT-ledger-r-resolve-action-20260907.md. 'removed'
   is the seventh, behind "Show removed". */
const RENDERABLE_REQUEST_STATES = ['open', 'in-progress', 'gated', 'proposed', 'done', 'blocked-external', 'removed']

/* The ledger's own status vocabulary, which every row's status must be in. */
const LEDGER_STATUSES = ['proposed', 'open', 'in-progress', 'partial', 'blocked-external', 'done', 'not-possible-as-asked', 'declined', 'removed']
/* The task and ask vocabularies (the store's TASK_ and ASK_STATUS_VOCABULARY). */
const TASK_STATUSES = ['open', 'in-progress', 'blocked-external', 'done', 'recurring', 'superseded', 'removed']
const ASK_STATUSES = ['open', 'answered', 'declined', 'removed']
/* The rules, where the rules-only promises below apply (T1416 added tasks and
   asks beside them). */
const rulesOf = data => data.requests.filter(item => item.kind === 'R')

/* Question statusClass values: the schema's enum minus 'unknown'. */
const RENDERABLE_QUESTION_CLASSES = ['open', 'in-progress', 'blocked', 'done']

const schema = JSON.parse(read('public/data/schema/ledger.schema.json'))

/* The Q half is the `questions` member of a projection's data; the schema
   describes the whole envelope. Wrap it in the smallest valid envelope, with
   the R half emptied (the feed's rows are not the projection's), so the
   questions path is validated the way the report is. */
function questionsEnvelope(data, nowMs) {
  return {
    schemaVersion: 1,
    domain: 'ledger',
    generatedAt: new Date(nowMs).toISOString(),
    ok: true,
    reason: null,
    sources: [],
    data: { requests: [], questions: data.questions },
  }
}

test('the questions half validates against the shipped ledger projection schema', () => {
  const errors = validateAgainstSchema(questionsEnvelope(sampleLedgerData(NOW_MS), NOW_MS), schema)
  assert.deepEqual(errors, [])
})

test('the top-level shape is the feed\'s, nothing more', () => {
  const data = sampleLedgerData(NOW_MS)
  assert.deepEqual(Object.keys(data).sort(), ['chain', 'exists', 'questions', 'requests', 'revision', 'updatedAt'])
  assert.ok(Array.isArray(data.requests))
  assert.deepEqual(Object.keys(data.questions).sort(), OBSERVATION_FIELDS)
  assert.equal(data.questions.ok, true)
  assert.equal(data.questions.reason, null)
  assert.ok(Array.isArray(data.questions.value))
  assert.deepEqual(Object.keys(data.chain).sort(), ['code', 'drift', 'events', 'ok', 'unchained'])
  assert.equal(data.chain.ok, true)
  assert.equal(data.exists, true)
  assert.ok(Number.isSafeInteger(data.revision) && data.revision > 0)
  assert.match(data.updatedAt, /^\d{4}-\d{2}-\d{2}$/)
})

test('every request field is one the feed produces -- no more, no fewer -- and every row survives rowOf unchanged', () => {
  for (const item of sampleLedgerData(NOW_MS).requests) {
    assert.deepEqual(Object.keys(item).sort(), REQUEST_FIELDS, `request ${item.id}`)
    /* The feed's own shaping is the identity on a row already in its shape:
       that is what "exactly the live feed's row shape" means. */
    assert.deepEqual(rowOf(item), item, `request ${item.id} is reshaped by the feed`)
    assert.equal(item.state, stateOf(item), `request ${item.id} wears a glyph the feed would not give it`)
    assert.equal(typeof item.words, 'string')
    assert.ok(item.words.length > 0, `request ${item.id} has no words`)
    assert.ok(({ R: LEDGER_STATUSES, T: TASK_STATUSES, A: ASK_STATUSES })[item.kind]?.includes(item.status), `unknown ${item.kind} status: ${item.status}`)
    assert.ok(['global', 'tree', 'session', 'thread'].includes(item.scope), `unknown scope: ${item.scope}`)
    if (item.scope === 'global') assert.equal(item.scopeKey, null, `${item.id} is global with a key`)
    else assert.match(item.scopeKey, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, `${item.id} has no key`)
    if (item.parentId) assert.equal(item.id.startsWith(`${item.parentId}.`), true, `${item.id} names a parent it is not under`)
    assert.ok(Array.isArray(item.history) && item.history.length >= 1, `${item.id} has no history`)
    assert.equal(item.history[0].kind, 'file')
    assert.equal(item.history[0].actor, item.filedBy)
    assert.equal(item.removed, item.removedAt !== null)
  }
})

test('every question field is one the live markup reads -- no more, no fewer', () => {
  for (const item of sampleLedgerData(NOW_MS).questions.value) {
    assert.deepEqual(Object.keys(item).sort(), QUESTION_FIELDS, `question ${item.id}`)
  }
})

test('request states cover every glyph the register can paint, and each is one it can', () => {
  const states = rulesOf(sampleLedgerData(NOW_MS)).map(item => item.state)
  for (const state of states) {
    assert.ok(RENDERABLE_REQUEST_STATES.includes(state), `unrenderable state: ${state}`)
  }
  /* All seven, so no summary tile sits at zero and "Show removed" has a row. */
  assert.deepEqual(
    [...new Set(states)].sort(),
    [...RENDERABLE_REQUEST_STATES].sort(),
  )
})

test('one row is a proposal an agent filed, and every person-filed row says so', () => {
  const rows = sampleLedgerData(NOW_MS).requests
  const proposed = rows.filter(item => item.status === 'proposed')
  assert.equal(proposed.length, 1, 'exactly one row waits for approval')
  assert.notEqual(proposed[0].filedBy, 'owner', 'a proposal is filed by an agent, never by the person')
  assert.match(proposed[0].filedBy, /^[a-z0-9][a-z0-9_-]{0,63}$/, 'an agent is named by its own name')
  for (const item of rows.filter(item => item.filedBy === 'owner')) {
    assert.notEqual(item.status, 'proposed', `${item.id} is the person's own and cannot be waiting for their approval`)
  }
  const removed = rows.filter(item => item.state === 'removed')
  assert.equal(removed.length, 1)
  assert.ok(removed[0].removedAt, 'a removed row carries when it was removed')
  assert.ok(removed[0].history.some(entry => entry.kind === 'remove'), 'a removed row carries the removal in its history')
})

test('question statusClasses stay inside the schema enum, and one is open', () => {
  const items = sampleLedgerData(NOW_MS).questions.value
  for (const item of items) {
    assert.ok(RENDERABLE_QUESTION_CLASSES.includes(item.statusClass),
      `unrenderable statusClass: ${item.statusClass}`)
  }
  /* The Q register's counter is "N questions · M open" and the page exists
     to surface undecided questions; a sample with zero open would
     demonstrate a register with nothing to decide. */
  assert.ok(items.some(item => item.statusClass === 'open'))
})

test('the register and picker both have something to show', () => {
  const data = sampleLedgerData(NOW_MS)
  assert.ok(rulesOf(data).length >= 6 && rulesOf(data).length <= 8)
  assert.ok(data.questions.value.length >= 2 && data.questions.value.length <= 3)
  /* The Approve/Decline picker is built as `${id} · ${status}` keyed by id:
     ids must be unique and both fields non-empty, and every id must be one the
     ledger would mint. */
  const ids = data.requests.map(item => item.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const item of data.requests) {
    assert.match(item.id, new RegExp(`^${item.kind}(?:0\\d|[1-9]\\d{0,3})(?:\\.[1-9]\\d*)*$`), `${item.id} is not a ledger id`)
    assert.ok(item.status.length > 0)
  }
})

test('gate arithmetic is coherent: unmet never exceeds declared gates', () => {
  for (const item of sampleLedgerData(NOW_MS).requests) {
    assert.ok(Number.isInteger(item.gateCount) && item.gateCount >= 0, item.id)
    assert.ok(Number.isInteger(item.unmetGateCount) && item.unmetGateCount >= 0, item.id)
    assert.ok(item.unmetGateCount <= item.gateCount,
      `${item.id} shows "gates ${item.gateCount} · unmet ${item.unmetGateCount}"`)
  }
})

test('one question exercises the null packageId path', () => {
  const values = sampleLedgerData(NOW_MS).questions.value.map(item => item.packageId)
  assert.ok(values.includes(null))
  for (const value of values) {
    if (value !== null) assert.ok(typeof value === 'string' && value.length > 0)
  }
})

test('same nowMs, same record -- deterministic to deep equality', () => {
  assert.deepEqual(sampleLedgerData(NOW_MS), sampleLedgerData(NOW_MS))
})

test('nowMs actually feeds the record, and calls do not share mutable state', () => {
  const earlier = sampleLedgerData(NOW_MS - 60 * 60_000)
  const now = sampleLedgerData(NOW_MS)
  assert.notEqual(earlier.questions.observedAt, now.questions.observedAt)
  assert.notEqual(earlier.requests[0].filedAt, now.requests[0].filedAt)

  /* Fresh objects per call: a caller mutating its copy must not poison the
     next render. */
  const first = sampleLedgerData(NOW_MS)
  first.requests[0].status = 'vandalized'
  first.requests[0].history[0].kind = 'vandalized'
  first.questions.value[0].statusClass = 'vandalized'
  assert.deepEqual(sampleLedgerData(NOW_MS), now)
})

test('every timestamp in the record is a valid date-time at or before nowMs', () => {
  /* Walk every string in the payload rather than naming the fields, so a
     future timestamp field is caught the day it is added. A timestamp after
     nowMs would render as a record from the future. */
  const stamps = []
  const walk = value => {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) stamps.push(value)
    else if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === 'object') Object.values(value).forEach(walk)
  }
  walk(sampleLedgerData(NOW_MS))
  assert.ok(stamps.length >= 9, 'expected the questions observedAt plus one filedAt per row')
  for (const stamp of stamps) {
    const ms = Date.parse(stamp)
    assert.ok(Number.isFinite(ms), `unparseable date-time: ${stamp}`)
    assert.ok(ms <= NOW_MS, `timestamp after nowMs: ${stamp}`)
  }
})

test('the module never imports the modules being deleted', () => {
  const source = read(path.join('src', 'sample-ledger.js'))
  assert.doesNotMatch(source, /from\s+['"][^'"]*\b(sim|vocab|ledger-data)\.js['"]/,
    'src/sim.js, src/vocab.js and src/ledger-data.js are being deleted; the sample must not lean on them')
})

/* Values only, never key names: the shared row shape now carries a field
   literally named `purchase` for every kind (null on every sample here,
   since the fleet's examples are all R) -- see src/sample-ledger.js. That
   field existing is the owner's own fold-in, not a leak; what must never
   leak is a money WORD in something the page actually renders. */
function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) value.forEach(entry => collectStrings(entry, out))
  else if (value && typeof value === 'object') for (const entry of Object.values(value)) collectStrings(entry, out)
  return out
}

test('the sample world is the example fleet\'s, not anybody\'s spending', () => {
  /* The prose surface -- the person's words, question titles and statuses --
     renders as English. Everything must stay in the sample fleet's own
     vocabulary; money words would read as a real machine's decisions. */
  const values = collectStrings(sampleLedgerData(NOW_MS)).join('\n')
  assert.doesNotMatch(values, /\$|\bUSD\b|price|invoice|payment|purchase/i)
})

/* THE OTHER SUBSETS HAVE SOMETHING TO SHOW (T1416): the example's Tasks and
   Asks tabs used to say there were none. */
test('the example carries tasks and asks in their own statuses, with the details their rows show', () => {
  const rows = sampleLedgerData(NOW_MS).requests
  const tasks = rows.filter(item => item.kind === 'T')
  const asks = rows.filter(item => item.kind === 'A')
  assert.deepEqual(tasks.map(item => item.status).sort(), ['blocked-external', 'done', 'in-progress', 'recurring'])
  assert.deepEqual(asks.map(item => item.status).sort(), ['answered', 'open'])
  assert.ok(tasks.find(item => item.status === 'recurring').recurrence.completions.length >= 1, 'the repeating task has no runs to show')
  assert.equal(tasks.find(item => item.status === 'blocked-external').latestDecision?.decision, 'progress', 'the blocked task does not say what it waits on')
  assert.equal(typeof asks.find(item => item.status === 'answered').answer?.words, 'string', 'the answered ask has no answer')
  assert.ok(asks.find(item => item.status === 'open').filedBy !== 'owner', 'an ask is filed by an agent')
  assert.equal(rows.filter(item => item.kind === 'P').length, 0, 'the example keeps clear of money')
})
