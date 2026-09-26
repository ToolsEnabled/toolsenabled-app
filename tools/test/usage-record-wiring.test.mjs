/* THE WIRING, WHICH IS THE HALF A UNIT TEST CANNOT REACH.
 *
 * shell/usage-record.cjs can be exercised directly and is. What no direct test
 * can see is whether anything ever CALLS it -- and a perfectly tested writer
 * that nothing feeds is exactly the shape of the defect being repaired here: the
 * `usage` event has crossed mc-agent:event since the first day and every reader
 * dropped it. So these assertions are about the seams: the one fan-out where
 * every session's events pass, the channel the page reads back through, and the
 * bridge that carries it.
 *
 * Source-text assertions, in the same style as tools/test/tree-reply-surface.mjs
 * and for the same reason: the Electron main process cannot be booted in a unit
 * test, and a wiring guard that cannot run is a guard that does not exist.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { USAGE_STRING_FIELDS } from '../../shell/spawn-record.cjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (relative) => readFileSync(path.join(REPO_ROOT, relative), 'utf8')

test('the main process writes a usage record from the event fan-out', () => {
  const main = read('shell/main.cjs')
  assert.match(main, /require\('\.\/usage-record\.cjs'\)/, 'main does not load the usage recorder at all')
  assert.match(main, /noteAgentTurnUsage\(session, packet\)/,
    'the one place every session event passes does not offer them to the recorder')
  /* The forward comes FIRST. A screen must not wait on an fsync for its text.
     Measured inside the listener itself rather than over the whole file, because
     the function's own DEFINITION carries the same call text and sits earlier. */
  const listener = main.slice(main.indexOf('removeAgentEventListener = host.onEvent('))
  const block = listener.slice(0, listener.indexOf('agentHost = host'))
  const forward = block.indexOf('session.owner.send(AGENT_EVENT_CHANNEL, packet)')
  const record = block.indexOf('noteAgentTurnUsage(session, packet)')
  assert.ok(forward > -1 && record > forward, 'the record is written before the event reaches the page')
})

test('a turn is recorded once, when the engine says the turn is over', () => {
  const main = read('shell/main.cjs')
  const start = main.indexOf('function noteAgentTurnUsage')
  const end = main.indexOf('function spawnRecordAvailability')
  const body = main.slice(start, end)
  assert.ok(start > -1 && end > start, 'noteAgentTurnUsage is not where this test thinks it is')

  /* THE DEFECT THIS PINS. Codex emits a usage event several times per turn, each
     carrying the session's running total. One record per EVENT would put the
     same tokens on the page as many times as the engine happened to report
     them. */
  assert.match(body, /event\.type === 'usage'/)
  assert.match(body, /event\.type !== 'turn_completed'/)
  assert.match(body, /recordTurnAsync\(/)
  assert.ok(
    body.indexOf('recordTurnAsync(') > body.indexOf("event.type !== 'turn_completed'"),
    'a record is written before the turn is known to be over',
  )
  /* Held readings are dropped once written, so one turn can never be counted
     twice, and the map is bounded so an interrupted session cannot grow it. */
  assert.match(body, /usageByTurn\.delete\(turnId\)/)
  assert.match(body, /MAX_PENDING_TURN_USAGE/)
})

/* MEASURED 2026-09-03: this file kept its own copy of the four label patterns,
   and the `account` copy had no `@` in it, so every email-shaped sign-in was
   nulled here -- 433 of the 488 rows in agent-turn-usage-records.jsonl said
   nothing about which account paid. The repair is not a wider pattern in two
   places; it is one table, in shell/spawn-record.cjs, read through usageLabel().
   A regular expression reappearing in this file is that defect coming back, so
   the guard is on the COPY, not on the spelling of the class. */
test('the labels are bounded by the writer\'s own table, not by a copy kept in main', () => {
  const main = read('shell/main.cjs')
  const start = main.indexOf('function noteAgentTurnUsage')
  const body = main.slice(start, main.indexOf('function spawnRecordAvailability'))
  assert.ok(start > -1, 'noteAgentTurnUsage is not where this test thinks it is')
  assert.match(main, /require\('\.\/usage-record\.cjs'\)/)
  assert.match(main, /usageLabel/, 'main does not bound its labels at all')
  for (const field of ['turnId', 'tier', 'account', 'status']) {
    assert.match(body, new RegExp(`usageLabel\\('${field}'`),
      `${field} is not bounded by the shared table before the write`)
  }
  assert.doesNotMatch(main.slice(0, start), /const USAGE_(TURN|TIER|ACCOUNT|STATUS)_PATTERN/,
    'a second copy of the writer\'s patterns is back; the two can drift again')
})

test('the identity on a usage record is read in main, never accepted from the page', () => {
  const main = read('shell/main.cjs')
  const start = main.indexOf('function noteAgentTurnUsage')
  const body = main.slice(start, main.indexOf('function spawnRecordAvailability'))
  assert.match(body, /principal: session\.metricsPrincipal \|\| null/,
    'an identity a page can choose is not an identity -- the same rule the run record follows')
})

test('the channel that reads the usage record checks its sender like every other agent channel', () => {
  const main = read('shell/main.cjs')
  const handler = main.slice(main.indexOf("ipcMain.handle('mc-agent:usage'"))
  assert.match(handler.slice(0, 400), /assertTrustedAgentSender\(event\)/,
    'any frame that happened to be loaded could ask what this computer has used')
})

test('the bridge carries it, and the page can therefore ask', () => {
  const preload = read('shell/fleet-profile-preload.cjs')
  assert.match(preload, /usage: request => ipcRenderer\.invoke\('mc-agent:usage', request \|\| \{\}\)/)
})

test('the new record is carried across an install rename, WITH the key that signs it', () => {
  const adoption = read('shell/userdata-adoption.cjs')
  assert.match(adoption, /'agent-turn-usage-records\.jsonl'/, 'a rename would strand the token history')
  const bound = adoption.slice(adoption.indexOf('ENTRIES_BOUND_TO_SEALED_KEY'))
  assert.match(bound.slice(0, 200), /agent-turn-usage-records\.jsonl/,
    'the usage chain would be adopted without the key whose signatures it is under')
})

/* ------------------------------------------------------------------
   A DEAD TIER SAYS WHY, AND IT SAYS IT THROUGH ONE RULE.

   MEASURED 2026-09-03: five claude-fable turns in a row wrote status "error"
   with every token figure zero while claude-opus wrote 160 successes in the
   same window on the same install. The engine had put the provider's own
   sentence on `turn_completed.text` and this listener dropped it.
   ------------------------------------------------------------------ */

/* Through the default export: node's named-export detection does not read this
   module's exports list, and the point of these tests is to run the REAL rule
   rather than a re-implementation of it. */
import agentHost from '../../shell/agent-host.cjs'

const { TURN_FAILURE_SENTENCE_MAX, turnFailureSentence } = agentHost

test('the recorded turn carries the completion\'s own sentence, sanitised by the host\'s rule', () => {
  const main = read('shell/main.cjs')
  const start = main.indexOf('function noteAgentTurnUsage')
  const end = main.indexOf('function spawnRecordAvailability')
  const body = main.slice(start, end)
  assert.ok(start > -1 && end > start, 'noteAgentTurnUsage is not where this test thinks it is')
  assert.match(body, /failure: usageLabel\('failure', turnFailureSentence\(event\.text\)\)/,
    'the completion\'s sentence is not carried into the record, so a zero-token turn keeps no reason')
  /* ONE RULE, NOT A SECOND COPY. A private sanitiser here is how a sentence
     comes to be safe on one surface and a path on another. */
  assert.match(main, /require\('\.\/agent-host\.cjs'\)/)
  assert.match(main, /turnFailureSentence/)
})

test('the host\'s sentence rule holds on raw engine text, which has been through no checks', () => {
  /* Both measured off the real CLI. Neither carries a path, so both survive. */
  const refusal = "There's an issue with the selected model (claude-fable-5-1). It may not exist or you may not have access to it."
  assert.equal(turnFailureSentence(refusal), refusal)
  assert.equal(turnFailureSentence("You're out of usage credits \u00b7 resets Aug 25, 12am"),
    "You're out of usage credits \u00b7 resets Aug 25, 12am")

  /* WHAT MAY NOT CROSS, whatever it would have explained. */
  assert.equal(turnFailureSentence('ENOENT: no such file, open X:\\SyntheticProfile\\a'), null)
  assert.equal(turnFailureSentence('TypeError: x is not a function'), null)
  assert.equal(turnFailureSentence('ECONNRESET'), null)
  /* A real V8 frame, which is the shape that actually arrives: it carries a
     path, and the path is what the rule refuses. */
  assert.equal(turnFailureSentence('    at handleResult (C:\\app\\shell\\agent-host.cjs:481:12)'), null)
  assert.equal(turnFailureSentence('at handleResult(agent-host.cjs:481)'), null)
  assert.equal(turnFailureSentence(undefined), null)
  assert.equal(turnFailureSentence(null), null)
  assert.equal(turnFailureSentence(42), null)
  assert.equal(turnFailureSentence('   '), null)

  /* A long sentence is clipped rather than dropped, and the clip is marked. */
  const long = turnFailureSentence('a'.repeat(TURN_FAILURE_SENTENCE_MAX + 50))
  assert.equal(long.length, TURN_FAILURE_SENTENCE_MAX)
  assert.ok(long.endsWith('\u2026'))

  /* A second line cannot ride along behind the first. */
  assert.equal(turnFailureSentence('the model was refused\nsecret second line'), 'the model was refused')
})

test('every sentence the host lets through is one the usage ledger can hold', () => {
  /* THE FAILURE THIS FORBIDS is the one usage-record.test.mjs already names for
     labels, in the direction that costs tokens: caller LOOSER than the writer
     means boundedUsage() throws, shell/main.cjs swallows it by design, and the
     whole turn goes unrecorded -- a lost reason becomes lost tokens. */
  const pattern = new Map(USAGE_STRING_FIELDS).get('failure')
  assert.ok(pattern, 'the usage ledger has no bounded shape for a failure sentence')
  const measured = [
    "There's an issue with the selected model (claude-fable-5-1). It may not exist or you may not have access to it.",
    "You're out of usage credits \u00b7 resets Aug 25, 12am",
    'The Claude program stopped before finishing the turn (exit 1).',
    'The Claude program did not finish this turn in time.',
    'a'.repeat(TURN_FAILURE_SENTENCE_MAX + 50),
    'ENOENT: no such file, open X:\\SyntheticProfile\\a',
    'read of /etc/passwd failed',
    'first line\nsecond line',
  ]
  for (const raw of measured) {
    const sentence = turnFailureSentence(raw)
    if (sentence === null) continue
    assert.ok(pattern.test(sentence),
      `the host passed ${JSON.stringify(sentence.slice(0, 40))}, which the ledger then refuses -- that turn's tokens would be lost`)
  }
})
