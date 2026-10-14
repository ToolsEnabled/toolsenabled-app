/* A REFUSED START MUST SAY WHICH SINK REFUSED IT.
 *
 * MEASURED, 2026-09-07, on this installation's own signed action log: two
 * agent.restart calls were refused at 05:53:08.379Z and 05:54:31.530Z with
 *
 *   "The application could not restart that circle (AGENT_SESSION_FAILED).
 *    Error invoking remote method 'mc-agent:start': Error: The agent session
 *    was not started because it could not be recorded: AUDIT_UNAVAILABLE"
 *
 * and that is the whole of what anybody was told. The canonical ledger was
 * healthy 23 seconds either side of both -- controller.meter.tool_batch rows
 * carry an advancing auditSequence across the entire window -- so the cause was
 * transient, and which sink went transient is exactly the fact the sentence
 * withheld.
 *
 * It was not withheld because nobody knows it. shell/canonical-audit.cjs
 * answers `{ ok: false, code, reason }` (its own JSDoc), and src/lib/audit.js
 * composes the classification and the next action INTO that reason: "Run the
 * audit.status tool to see which sink is failing and repair that sink". The
 * gate in shell/main.cjs read `.code` and dropped `.reason`.
 *
 * WHAT THIS SUITE DOES NOT DO: it does not touch whether a start should refuse
 * when the audit cannot record. That gate is deliberate and its reasoning is
 * written above it. This is about the sentence, not the decision.
 *
 * Behaviour, called with values -- no source-text pin, because a sentence
 * assembled a better way must still pass.
 *
 *   node --test tools/test/session-start-audit-reason.test.mjs
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { sessionStartRefusalSentence, FALLBACK_AUDIT_CODE } =
  require('../../shell/session-start-refusal.cjs')

/* The real sentence src/lib/audit.js hands back, abbreviated only in the middle.
   Used as a VALUE so this suite never depends on how that module spells it. */
const REAL_REASON = 'Durable audit intent could not be recorded (SQLITE_BUSY), so the external '
  + 'mutation was not started. Run the audit.status tool to see which sink is failing and repair '
  + 'that sink, then retry; every external write stays refused until durable recording returns.'

test('the refusal carries the reason the audit writer gave, not only its code (bad value: the bare code)', () => {
  const said = sessionStartRefusalSentence({ ok: false, code: 'AUDIT_UNAVAILABLE', reason: REAL_REASON })

  assert.ok(said.includes('AUDIT_UNAVAILABLE'),
    `the code must survive; got: ${said}`)
  assert.ok(said.includes('audit.status'),
    'bad value "The agent session was not started because it could not be recorded: AUDIT_UNAVAILABLE" '
    + '— the writer said which tool names the failing sink and the refusal dropped it, so an owner whose '
    + `agents stopped is told a code and no next step. Got: ${said}`)
  assert.ok(said.includes('SQLITE_BUSY'),
    'the writer classified this refusal and the classification must reach the person; without it a busy '
    + `ledger, a full disk and a poisoned anchor are one sentence. Got: ${said}`)
})

test('a refusal that carried no reason still reads exactly as it always did (bad value: a dangling separator)', () => {
  const said = sessionStartRefusalSentence({ ok: false, code: 'AUDIT_DISABLED' })
  assert.equal(said, 'The agent session was not started because it could not be recorded: AUDIT_DISABLED',
    'a writer that named no reason must not gain punctuation, an empty tail, or the word undefined')
})

test('a thrown Error is accepted where a refusal object is, since the record path throws one (bad value: undefined)', () => {
  const error = Object.assign(new Error(REAL_REASON), { code: 'SPAWN_RECORD_UNAVAILABLE' })
  const said = sessionStartRefusalSentence(error, 'SPAWN_RECORD_UNAVAILABLE')
  assert.ok(said.includes('SPAWN_RECORD_UNAVAILABLE'), `the code must survive; got: ${said}`)
  assert.ok(said.includes('audit.status'),
    `an Error carries its words in .message and they must travel too; got: ${said}`)
})

test('a refusal with no code at all falls back to the audit contract\'s own name (bad value: undefined)', () => {
  const said = sessionStartRefusalSentence({ ok: false })
  assert.ok(said.includes(FALLBACK_AUDIT_CODE),
    `a refusal that named no code must still name the contract it failed; got: ${said}`)
  assert.ok(!said.includes('undefined'), `no sentence may print the word undefined; got: ${said}`)
})

/* REACHABILITY, and the only honest way to ask it here. shell/main.cjs needs
   Electron and cannot be required -- all 34 suites that touch it read it as
   text, and so does this one. A sentence composed correctly by a module nothing
   calls is a sentence nobody reads, so this asserts the wiring exists and that
   the old inline composition is GONE rather than duplicated beside it. It is a
   reachability check, not a spelling pin on the behaviour above. */
test('shell/main.cjs actually composes its refusal through this module (bad value: an orphaned helper)', () => {
  const main = readFileSync(new URL('../../shell/main.cjs', import.meta.url), 'utf8')
  assert.match(main, /require\('\.\/session-start-refusal\.cjs'\)/,
    'main.cjs does not require the module that composes this sentence, so the fix exists only in the diff')
  assert.match(main, /sessionStartRefusalSentence\(/,
    'main.cjs requires the module but never calls it')
  const inlined = main.split('The agent session was not started because it could not be recorded: ').length - 1
  assert.equal(inlined, 0,
    `main.cjs still composes that sentence inline in ${inlined} place(s); two spellings of one sentence is how `
    + 'one of them keeps the defect after the other is fixed')
})

test('a non-string reason is ignored rather than printed (bad value: [object Object])', () => {
  const said = sessionStartRefusalSentence({ code: 'AUDIT_UNAVAILABLE', reason: { sink: 'anchor' } })
  assert.ok(!said.includes('[object Object]'), `got: ${said}`)
  assert.ok(!said.includes('undefined'), `got: ${said}`)
  assert.equal(said, 'The agent session was not started because it could not be recorded: AUDIT_UNAVAILABLE')
})
