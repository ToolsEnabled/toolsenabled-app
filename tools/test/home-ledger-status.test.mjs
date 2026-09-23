import test from 'node:test'
import assert from 'node:assert/strict'
import { homeLedgerStatus, readHomeLedger } from '../../src/home-ledger-status.js'

const nowMs = Date.parse('2026-09-16T12:00:00Z')
const read = (records = [], prompts = []) => homeLedgerStatus({ ledger: { ok: true, records, chain: { ok: true } }, prompts: { ok: true, prompts }, nowMs })
const record = (id, status, extra = {}) => ({ id, status, ...extra })

test('clear means a successful empty read, not missing or unverified data', () => {
  assert.equal(read().status, 'clear')
  assert.equal(homeLedgerStatus().status, 'unknown')
  for (const ledger of [{ ok: false, records: [] }, { ok: true }, { ok: true, records: [], chain: { ok: false } }]) {
    assert.equal(homeLedgerStatus({ ledger, prompts: { ok: true, prompts: [] } }).status, 'unknown')
  }
  assert.equal(homeLedgerStatus({ ledger: { ok: true, records: [] } }).status, 'unknown')
  assert.equal(read([record('T1', 'future-status')]).status, 'unknown')
})

test('unanswered asks and proposals are yellow; unfinished work and unmet gates are not owner blockers', () => {
  for (const item of [record('A1', 'open'), record('R1', 'proposed'), record('P1', 'proposed')]) {
    assert.equal(read([item]).status, 'attention')
  }
  assert.equal(read([record('T1', 'open'), record('T2', 'in-progress'), record('T3', 'recurring'), record('R1', 'partial', { unmetGateCount: 4 })]).status, 'clear')
  assert.equal(read([record('T1', 'open', { words: 'Blocked! Red! Owner is waiting!', lastError: true })]).status, 'clear')
})

test('explicit ledger blockers win over asks and resolved blockers stop being red', () => {
  for (const status of ['blocked-external', 'blocked']) {
    assert.equal(read([record('A1', 'open'), record('T1', status)]).status, 'blocked')
  }
  for (const status of ['done', 'superseded', 'not-possible-as-asked']) {
    assert.equal(read([record('T1', status)]).status, 'clear')
  }
  const changed = record('T1', 'blocked-external')
  assert.equal(read([changed]).blockers, 1)
  changed.status = 'in-progress'
  assert.equal(read([changed]).status, 'clear')
})

test('answered, approved, recorded, declined, removed and duplicate entries do not inflate attention', () => {
  const closed = ['answered', 'approved', 'recorded', 'declined', 'removed', 'done', 'superseded']
  assert.equal(read(closed.map((status, index) => record(`A${index + 1}`, status))).status, 'clear')
  assert.equal(read([record('T1', 'blocked-external', { removedAt: '2026-09-16' })]).status, 'clear')
  assert.equal(read([record('A1', 'open'), record('A1', 'open')]).asks, 1)
})

test('pending public decisions count, but notices, expired and settled prompts do not', () => {
  const pending = { id: 'decision', kind: 'confirmation', state: 'pending', expiresAt: new Date(nowMs + 60_000).toISOString() }
  assert.equal(read([], [pending]).status, 'attention')
  assert.equal(read([], [{ ...pending, kind: 'purchase_batch' }]).status, 'attention')
  for (const extra of [{ kind: 'notice' }, { state: 'settled' }, { expiresAt: new Date(nowMs).toISOString() }]) {
    assert.equal(read([], [{ ...pending, ...extra }]).status, 'clear')
  }
  assert.equal(read([record('decision', 'open', { kind: 'A' })], [pending]).asks, 1)
})

test('known attention survives a partial read without pretending the whole ledger is clear', () => {
  const result = homeLedgerStatus({ ledger: { ok: true, records: [record('A1', 'open')] }, prompts: { ok: false } })
  assert.equal(result.status, 'attention')
  assert.equal(result.complete, false)
})

test('Home reads the canonical all-scope ledger and contains missing or failed bridge reads', async () => {
  let calls = 0
  const reply = { ok: true, records: [record('A1', 'open')] }
  assert.equal(await readHomeLedger({ async ledger(options) { calls++; assert.deepEqual(options, { scope: 'all', key: null, removed: false }); return reply } }), reply)
  assert.equal(calls, 1)
  assert.deepEqual(await readHomeLedger(null), { ok: false })
  assert.deepEqual(await readHomeLedger({ ledger() { throw new Error('unavailable') } }), { ok: false })
})

/* HOME'S LINE OPENS THE RECORDS IT COUNTS (T1344). */
test('the ledger line links to the Ledger narrowed to what it counts, and a clear or unknown line to the whole Ledger', async () => {
  const { ledgerStatusHref } = await import('../../src/home-ledger-status.js')
  assert.equal(ledgerStatusHref('blocked'), '#/ledger?waiting=blocked')
  assert.equal(ledgerStatusHref('attention'), '#/ledger?waiting=attention')
  assert.equal(ledgerStatusHref('clear'), '#/ledger')
  assert.equal(ledgerStatusHref('unknown'), '#/ledger')
})

/* T1478: Home opens with the empty summary and replaces it when the reads
   return. On a busy app that took seconds, and the row said 'Could not read the
   ledger. Open Ledger to check.' the whole time. Before any read has answered
   it says it is still checking; a read that answered badly (or threw, which
   Home turns into null) still says it could not read the ledger. */
test('before the first read returns, Home says it is checking, not that the read failed', () => {
  const waiting = homeLedgerStatus()
  assert.equal(waiting.status, 'unknown', 'the ring keeps its neutral colour while it waits')
  assert.doesNotMatch(waiting.label, /could not/i, `the not-yet-read state is labelled as a failure: ${waiting.label}`)
  assert.match(waiting.label, /checking/i)
  assert.doesNotMatch(String(waiting.title), /could not/i, `the row's tooltip calls the wait a failure: ${waiting.title}`)
  for (const failed of [
    { ledger: { ok: false }, prompts: null },
    { ledger: { ok: false }, prompts: { ok: false } },
    { ledger: { ok: true, records: [], chain: { ok: false } }, prompts: { ok: true, prompts: [] } },
  ]) {
    const answer = homeLedgerStatus({ ...failed, nowMs })
    assert.equal(answer.label, 'Could not read the ledger. Open Ledger to check.')
    assert.match(answer.title, /could not be read/)
  }
  assert.equal(read().title, 'Open Ledger')
})

test('Home paints the row tooltip from the summary, so a wait is never titled a failure', async () => {
  const { readFileSync } = await import('node:fs')
  const home = readFileSync(new URL('../../src/views/home.js', import.meta.url), 'utf8')
  assert.match(home, /ledgerFact\.title = ledger\.title\n/)
})
