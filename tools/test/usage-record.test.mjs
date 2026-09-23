import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createUsageRecorder, turnUsageFrom, usageLabel, USAGE_LEDGER_FILE } from '../../shell/usage-record.cjs'

/* THE SAME FAKE KEYSTORE tools/test/spawn-record.test.mjs uses, and for the same
   reason: these run without Electron, and it genuinely transforms the bytes so a
   test that asserts the key is not plain on disk is testing the module rather
   than a passthrough. */
function keystore({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (text) => Buffer.from(`enc:${Buffer.from(text, 'utf8').toString('base64')}`, 'utf8'),
    decryptString: (buffer) => {
      const stored = buffer.toString('utf8')
      if (!stored.startsWith('enc:')) throw new Error('not encrypted by this keystore')
      return Buffer.from(stored.slice(4), 'base64').toString('utf8')
    },
  }
}

function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), 'usage-record-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

/* ------------------------------------------------------------------
   THE READER: what a `usage` event from each engine actually means.

   Both shapes below are the MEASURED ones -- the codex app-server capture
   recorded in src/agent-session-events.js, and the Claude CLI `result` packet
   whose usage the adapter re-emits (shell/../claude-cli-adapter.js handleResult).
   Nothing here is an invented shape.
   ------------------------------------------------------------------ */

test('a codex usage record reads the LAST turn, and carries the session total beside it', () => {
  const reading = turnUsageFrom({
    total: { inputTokens: 12000, cachedInputTokens: 9000, outputTokens: 800, reasoningOutputTokens: 300, totalTokens: 12800 },
    last: { inputTokens: 4000, cachedInputTokens: 3000, outputTokens: 200, reasoningOutputTokens: 100, totalTokens: 4200 },
    modelContextWindow: 272000,
  })
  assert.equal(reading.basis, 'turn')
  assert.equal(reading.inputTokens, 4000)
  assert.equal(reading.cachedInputTokens, 3000)
  assert.equal(reading.outputTokens, 200)
  assert.equal(reading.reasoningOutputTokens, 100)
  assert.equal(reading.totalTokens, 4200)
  assert.equal(reading.contextWindow, 272000)
  /* The cumulative reading is kept so a screen can CHECK the turns it summed
     against what the engine says the session spent, rather than assert them. */
  assert.equal(reading.sessionTotalTokens, 12800)
})

test('a flat Claude CLI usage record is that turn, under its own field names', () => {
  const reading = turnUsageFrom({
    input_tokens: 6,
    output_tokens: 412,
    cache_creation_input_tokens: 18000,
    cache_read_input_tokens: 32000,
  })
  assert.equal(reading.basis, 'turn')
  assert.equal(reading.inputTokens, 6)
  assert.equal(reading.outputTokens, 412)
  assert.equal(reading.cacheCreationInputTokens, 18000)
  assert.equal(reading.cachedInputTokens, 32000)
  /* NOT INVENTED. The CLI reports no total, so there is none -- a sum written
     here would be this module's number wearing the engine's name. */
  assert.equal(reading.totalTokens, null)
})

/* WHICH FIGURE THE INPUT FIGURE ALREADY CONTAINS, which only this module can
   see. One line further on the record is five numbers with no provenance, and a
   reader that guessed wrong either doubled a codex turn's input or -- as the
   metrics page did, measured over 403 rows on the owner's machine -- dropped
   every cached token an Anthropic turn was served. The engine's own SPELLING is
   the evidence, so it is read here and written down. */

test('a codex reading says its input figure already holds the cached reading', () => {
  const reading = turnUsageFrom({
    last: { inputTokens: 32839, cachedInputTokens: 31488, outputTokens: 523, reasoningOutputTokens: 465, totalTokens: 33362 },
  })
  assert.equal(reading.inputBasis, 'includes-cache')
})

test("a Claude CLI reading says its input figure does NOT hold the cache beside it", () => {
  const reading = turnUsageFrom({
    input_tokens: 6,
    output_tokens: 1314,
    cache_read_input_tokens: 64647,
    cache_creation_input_tokens: 29716,
  })
  assert.equal(reading.inputBasis, 'excludes-cache')
})

test('a reading with no cache figure makes no claim about where the cache would be', () => {
  /* Both compositions give the same total here, so a stamped answer would be a
     statement about an engine made from a record that named no cache at all. */
  assert.equal(turnUsageFrom({ input_tokens: 900, output_tokens: 100 }).inputBasis, null)
  assert.equal(turnUsageFrom({ last: { inputTokens: 900, outputTokens: 100 } }).inputBasis, null)
})

test('the composition belongs to the reading that was chosen, not to the one beside it', () => {
  /* The turn is what gets recorded, so a cumulative sibling in another dialect
     must not label it. Here `last` names no cache and `total` does. */
  const reading = turnUsageFrom({
    total: { inputTokens: 12000, cachedInputTokens: 9000, outputTokens: 800, totalTokens: 12800 },
    last: { inputTokens: 4000, outputTokens: 200, totalTokens: 4200 },
  })
  assert.equal(reading.basis, 'turn')
  assert.equal(reading.inputBasis, null)
})

test('a record with only a cumulative total says so, so nothing sums it twice', () => {
  const reading = turnUsageFrom({ total: { inputTokens: 900, outputTokens: 100, totalTokens: 1000 } })
  assert.equal(reading.basis, 'session-total')
  assert.equal(reading.totalTokens, 1000)
})

test('prose, paths, nested objects and non-finite numbers never survive the reader', () => {
  const reading = turnUsageFrom({
    input_tokens: 10,
    note: 'this is prose',
    cwd: 'C:\\Users\\somebody\\secret',
    nested: { a: 1 },
    broken: Infinity,
    negative: -5,
  })
  assert.equal(reading.inputTokens, 10)
  for (const key of Object.keys(reading)) {
    assert.ok(!['note', 'cwd', 'nested', 'broken', 'negative'].includes(key), `${key} reached the record`)
  }
})

test('a usage record with no token figure at all is not a reading', () => {
  assert.equal(turnUsageFrom({ note: 'nothing here' }), null)
  assert.equal(turnUsageFrom(null), null)
  assert.equal(turnUsageFrom('42'), null)
  assert.equal(turnUsageFrom([1, 2]), null)
})

/* ------------------------------------------------------------------
   THE RECORD: signed, chained, durable, and its own file.
   ------------------------------------------------------------------ */

test('the composition survives the write, so the page reading it back never has to guess', (t) => {
  const directory = workspace(t)
  const recorder = createUsageRecorder({ safeStorage: keystore(), directory })
  recorder.recordTurn({
    sessionId: 'chat-1',
    turnId: 'turn-1',
    tier: 'claude-sonnet',
    status: 'success',
    usage: turnUsageFrom({ input_tokens: 6, output_tokens: 1314, cache_read_input_tokens: 64647, cache_creation_input_tokens: 29716 }),
  })
  const [entry] = recorder.usage({ limit: 20 }).entries
  assert.equal(entry.usage.inputBasis, 'excludes-cache')
  assert.equal(entry.usage.cachedInputTokens, 64647)
  /* Still not invented. The composition says how the parts add up; it does not
     become a total the engine never reported. */
  assert.equal(entry.usage.totalTokens, null)
})

test('a line written before the writer kept a composition reads back as not saying one', (t) => {
  const directory = workspace(t)
  const recorder = createUsageRecorder({ safeStorage: keystore(), directory })
  /* Every one of the 488 rows on the owner's machine is this shape. Null here,
     never a default, is what lets src/local-metrics.js tell "the record does not
     say" from "the record says includes-cache". */
  recorder.recordTurn({ sessionId: 'chat-1', turnId: 'turn-1', usage: { basis: 'turn', inputTokens: 6, outputTokens: 1314 } })
  const [entry] = recorder.usage({ limit: 20 }).entries
  assert.equal(entry.usage.inputBasis, null)
})

test('a composition outside the two this record admits is refused, not stored', (t) => {
  const directory = workspace(t)
  const recorder = createUsageRecorder({ safeStorage: keystore(), directory })
  assert.throws(
    () => recorder.recordTurn({ sessionId: 'chat-1', usage: { basis: 'turn', inputBasis: 'C:\\Users\\somebody', inputTokens: 6 } }),
    /bounded shape/,
  )
})

test('a recorded turn is signed, chained and readable back', (t) => {
  const directory = workspace(t)
  const recorder = createUsageRecorder({ safeStorage: keystore(), directory })

  assert.deepEqual(recorder.availability(), { ok: true, code: 'SPAWN_RECORD_READY' })

  const receipt = recorder.recordTurn({
    sessionId: 'chat-1',
    principal: 'unauthenticated',
    turnId: 'turn-1',
    tier: 'luna',
    account: 'personal',
    status: 'completed',
    usage: turnUsageFrom({ last: { inputTokens: 4000, outputTokens: 200, totalTokens: 4200 }, modelContextWindow: 272000 }),
  })
  assert.equal(receipt.sequence, 1)
  assert.equal(receipt.durable, true)
  assert.equal(receipt.signed, true)

  const read = recorder.usage({ limit: 20 })
  assert.equal(read.ok, true)
  assert.equal(read.verified, true)
  assert.equal(read.total, 1)
  const [entry] = read.entries
  assert.equal(entry.sessionId, 'chat-1')
  assert.equal(entry.usage.turnId, 'turn-1')
  assert.equal(entry.usage.tier, 'luna')
  assert.equal(entry.usage.account, 'personal')
  assert.equal(entry.usage.totalTokens, 4200)
  assert.equal(entry.usage.basis, 'turn')
})

test('the usage ledger is its OWN file, so turns cannot crowd runs out of the run record', (t) => {
  const directory = workspace(t)
  const recorder = createUsageRecorder({ safeStorage: keystore(), directory })
  recorder.recordTurn({
    sessionId: 'chat-1', turnId: 'turn-1', tier: 'luna',
    usage: turnUsageFrom({ last: { totalTokens: 10 } }),
  })
  const lines = readFileSync(join(directory, USAGE_LEDGER_FILE), 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
  assert.notEqual(USAGE_LEDGER_FILE, 'agent-spawn-records.jsonl')
  assert.equal(JSON.parse(lines[0]).action, 'agent_turn_usage')
})

test('an edited figure breaks verification, and the turns are still returned', (t) => {
  const directory = workspace(t)
  const recorder = createUsageRecorder({ safeStorage: keystore(), directory })
  recorder.recordTurn({ sessionId: 'chat-1', turnId: 'turn-1', usage: turnUsageFrom({ last: { totalTokens: 10 } }) })
  recorder.recordTurn({ sessionId: 'chat-1', turnId: 'turn-2', usage: turnUsageFrom({ last: { totalTokens: 20 } }) })

  const ledger = join(directory, USAGE_LEDGER_FILE)
  const lines = readFileSync(ledger, 'utf8').trim().split('\n')
  const tampered = JSON.parse(lines[0])
  tampered.usage.totalTokens = 999999
  writeFileSync(ledger, [JSON.stringify(tampered), lines[1]].join('\n') + '\n')

  const reopened = createUsageRecorder({ safeStorage: keystore(), directory })
  const read = reopened.usage({ limit: 20 })
  assert.equal(read.ok, true, 'the turns are still returned')
  assert.equal(read.verified, false, 'and the record says it no longer checks out')
})

test('an unusable newest ledger row does not crowd a readable turn out of a limited result', (t) => {
  const directory = workspace(t)
  const recorder = createUsageRecorder({ safeStorage: keystore(), directory })
  recorder.recordTurn({ sessionId: 'chat-1', turnId: 'turn-1', usage: turnUsageFrom({ last: { totalTokens: 10 } }) })

  const ledger = join(directory, USAGE_LEDGER_FILE)
  const first = JSON.parse(readFileSync(ledger, 'utf8').trim())
  writeFileSync(ledger, `${JSON.stringify(first)}\n${JSON.stringify({
    ...first,
    sequence: 2,
    action: 'not_usage',
    usage: null,
  })}\n`)

  const read = recorder.usage({ limit: 1 })
  assert.equal(read.entries.length, 1)
  assert.equal(read.entries[0].usage.turnId, 'turn-1')
  assert.equal(read.verified, false, 'the unrelated row remains visible as a failed chain verdict')
})

test('a turn with no usage reading is refused rather than recorded as zero', (t) => {
  const directory = workspace(t)
  const recorder = createUsageRecorder({ safeStorage: keystore(), directory })
  assert.throws(() => recorder.recordTurn({ sessionId: 'chat-1', turnId: 'turn-1', usage: null }), /usage/i)
  assert.equal(recorder.usage({ limit: 20 }).total, 0)
})

test('a tier, account or status that is not the bounded shape becomes an absence, never a path', (t) => {
  const directory = workspace(t)
  const recorder = createUsageRecorder({ safeStorage: keystore(), directory })
  assert.throws(() => recorder.recordTurn({
    sessionId: 'chat-1', turnId: 'turn-1', tier: 'X:\\SyntheticProfile\\work',
    usage: turnUsageFrom({ last: { totalTokens: 10 } }),
  }), /tier/i)
})

test('an unavailable keystore reports it rather than writing an unsigned record', (t) => {
  const directory = workspace(t)
  const recorder = createUsageRecorder({ safeStorage: keystore({ available: false }), directory })
  assert.equal(recorder.availability().ok, false)
  assert.equal(recorder.availability().code, 'SPAWN_RECORD_KEYSTORE_UNAVAILABLE')
})

/* ------------------------------------------------------------------
   WHICH SIGN-IN PAID, for the sign-ins this product actually has.

   MEASURED 2026-09-03: the account labels were bounded by a character class
   with no `@` in it, so every email-shaped sign-in was nulled on its way to
   the ledger. 433 of the 488 rows then in agent-turn-usage-records.jsonl said
   nothing about the account, all 182 of them since 03:35Z, and the only names
   that ever reached it -- the ones with no `@` -- were a minority of the
   registry. Cost per account was unanswerable for most of the Claude sign-ins
   on a real machine.

   The six shapes below match what a real registry actually produces (see
   shell/account-registry.cjs): short bare handles and email-shaped sign-in
   names, personal and on an owned domain alike. They are placeholder values
   on reserved documentation domains (RFC 2606 example.com/.net/.org), never
   a real sign-in -- structurally identical to what shipped in this table
   before, without being anyone's real account. They are asserted by VALUE
   and read back off a signed, verified ledger, so this test fails if either
   the pre-write label check or the writer's own table stops admitting a name
   the person can actually be signed in as.
   ------------------------------------------------------------------ */

const REAL_ACCOUNT_NAMES = Object.freeze([
  'acct-legacy87',
  'acct-primary41',
  'sample.owner@example.com',
  'sample.owner12@example.net',
  'owner@example.org',
  'acct-secondary63',
])

test('every real sign-in name on this product reaches the ledger, email-shaped ones included', (t) => {
  const directory = workspace(t)
  const recorder = createUsageRecorder({ safeStorage: keystore(), directory })

  for (const [index, account] of REAL_ACCOUNT_NAMES.entries()) {
    /* Both halves of the path a live turn takes: the caller's pre-write check,
       then the writer that would otherwise refuse the whole record. */
    assert.equal(usageLabel('account', account), account, `${account} was dropped before the write`)
    recorder.recordTurn({
      sessionId: 'chat-1',
      turnId: `turn-${index + 1}`,
      tier: 'claude-opus',
      account,
      status: 'success',
      usage: turnUsageFrom({ input_tokens: 12, output_tokens: 4165 }),
    })
  }

  const read = recorder.usage({ limit: 20 })
  assert.equal(read.ok, true)
  assert.equal(read.verified, true, 'the chain must still check out with these names in it')
  assert.equal(read.total, REAL_ACCOUNT_NAMES.length, 'a refused label must never cost the reading it rode with')
  /* Newest first, so the ledger reads back in reverse. */
  assert.deepEqual(
    read.entries.map(entry => entry.usage.account),
    [...REAL_ACCOUNT_NAMES].reverse(),
    'a turn was recorded without saying which sign-in paid for it',
  )
  /* The figures are still the engine's, not a side effect of the label. */
  assert.equal(read.entries[0].usage.outputTokens, 4165)
})

test('a name the ledger cannot hold becomes a null label, never a lost turn and never a path', (t) => {
  const directory = workspace(t)
  const recorder = createUsageRecorder({ safeStorage: keystore(), directory })

  /* WHAT THE REGISTRY ADMITS, THE LEDGER NOW HOLDS. shell/account-registry.cjs
     accepts a name with spaces, another script, an address with a plus tag, a
     name with parentheses or an underscore. Until 2026-09-18 the ledger held
     none of them "by design" -- and the design was measured on a candidate:
     two real Claude turns on a sign-in labelled "sample - Oct10" wrote
     account:null, so Metrics' "Usage by sign-in" said "Not recorded" for a
     sign-in the person had named. The asymmetry the old comment called design
     was the same defect as the missing `@` measured on 2026-09-03, one
     character class later. These are asserted BY VALUE, in through the caller's
     pre-write check and out of a signed ledger. */
  const registryShapedNames = ['work (old)', 'счёт', 'sample.owner+work@example.com', 'sample - Oct10', 'friends_acct']
  for (const [index, name] of registryShapedNames.entries()) {
    assert.equal(usageLabel('account', name), name, `${name} is a name the registry stores and must reach the ledger`)
    recorder.recordTurn({
      sessionId: 'chat-1',
      turnId: `turn-${index + 1}`,
      account: usageLabel('account', name),
      usage: turnUsageFrom({ input_tokens: 12, output_tokens: 4165 }),
    })
  }
  const read = recorder.usage({ limit: 20 })
  assert.equal(read.verified, true, 'the chain must still check out with these names in it')
  assert.deepEqual(read.entries.map(entry => entry.usage.account), [...registryShapedNames].reverse())

  /* WHAT IS STILL REFUSED is the guarantee the table exists for: a value that
     could spell a path or a control sequence, or one the registry itself would
     never have stored (untrimmed, empty, over 64 characters, no letter or
     digit). A refused label still becomes null beside a real reading. */
  for (const name of ['X:\\SyntheticProfile\\work', 'a/b', 'a:b', '..\\up', ' lead', 'trail ', '!!!', '', 'x'.repeat(65), 'tab\tname', 'nl\nname', 'zero\u0000byte', 'bidi\u202Ename']) {
    assert.equal(usageLabel('account', name), null, `${JSON.stringify(name)} must not be written as an account label`)
  }
  recorder.recordTurn({
    sessionId: 'chat-1',
    turnId: 'turn-9',
    account: usageLabel('account', 'X:\\SyntheticProfile\\work'),
    usage: turnUsageFrom({ input_tokens: 12, output_tokens: 4165 }),
  })
  const [entry] = recorder.usage({ limit: 20 }).entries
  assert.equal(entry.usage.account, null)
  assert.equal(entry.usage.outputTokens, 4165, 'the reading survived a label the ledger could not hold')
})

test('the pre-write label check reads the writer\'s own table, so it can never be looser than the writer', (t) => {
  const directory = workspace(t)
  const recorder = createUsageRecorder({ safeStorage: keystore(), directory })

  /* THE FAILURE THIS FORBIDS. Two copies of these patterns can disagree in two
     directions. Caller stricter than writer is the defect measured above: a
     good name silently becomes null. Caller LOOSER than the writer is worse --
     boundedUsage() throws, shell/main.cjs swallows it by design, and the whole
     turn goes unrecorded, so a lost label becomes lost tokens. Anything
     usageLabel() passes must therefore be something the writer accepts. */
  for (const field of ['turnId', 'tier', 'account', 'status']) {
    for (const candidate of REAL_ACCOUNT_NAMES.concat(['luna', 'claude-opus', 'success', 'completed', 'turn-1', 'X:\\work', 'has space'])) {
      const label = usageLabel(field, candidate)
      if (label === null) continue
      assert.doesNotThrow(() => recorder.recordTurn({
        sessionId: 'chat-1',
        [field]: label,
        usage: turnUsageFrom({ input_tokens: 1 }),
      }), `usageLabel passed ${field}=${candidate}, which the writer then refused -- the turn's tokens would be lost`)
    }
  }

  /* And a field with no rule is named rather than waved through, because
     handing the writer an unbounded string is the one thing the table stops. */
  assert.throws(() => usageLabel('workingDirectory', 'X:\\SyntheticProfile'), /bounded shape/i)
})

/* ------------------------------------------------------------------
   WHY A ZERO-TOKEN TURN WAS A ZERO.

   MEASURED 2026-09-03 on the owner's computer: every claude-fable turn from
   01:49:05Z on wrote status:"error" with inputTokens 0 and outputTokens 0 --
   five in a row, while claude-opus wrote 160 successes and claude-sonnet 13 in
   the same window on the same install. The engine HAD the reason: the Claude
   CLI ends a refused turn with one human sentence, and
   claude-cli-adapter.js#handleResult puts it on `turn_completed.text`. This
   record kept the word "error" and dropped the sentence, so a dead tier was a
   zero with no cause anywhere a person could read.
   ------------------------------------------------------------------ */

const MODEL_REFUSAL = "There's an issue with the selected model (claude-fable-5-1). It may not exist or you may not have access to it."

test('a refused turn records the provider\'s own sentence, so a dead tier says why', (t) => {
  const directory = workspace(t)
  const recorder = createUsageRecorder({ safeStorage: keystore(), directory })
  recorder.recordTurn({
    sessionId: 'chat-6872372e', turnId: 'turn-1', tier: 'claude-fable', status: 'error',
    failure: usageLabel('failure', MODEL_REFUSAL),
    usage: turnUsageFrom({ input_tokens: 0, output_tokens: 0 }),
  })
  const [entry] = recorder.usage({ limit: 20 }).entries
  assert.equal(entry.usage.status, 'error')
  assert.equal(entry.usage.inputTokens, 0)
  assert.equal(entry.usage.failure, MODEL_REFUSAL, 'the zero-token turn was recorded with no reason beside it')
})

test('a turn that went well carries no failure sentence, so nothing invents one', (t) => {
  const directory = workspace(t)
  const recorder = createUsageRecorder({ safeStorage: keystore(), directory })
  recorder.recordTurn({ sessionId: 'chat-1', turnId: 'turn-1', tier: 'claude-opus', status: 'success', usage: turnUsageFrom({ input_tokens: 4, output_tokens: 2618 }) })
  const [entry] = recorder.usage({ limit: 20 }).entries
  assert.equal(entry.usage.failure, null)
  assert.equal(entry.usage.outputTokens, 2618)
})

test('a failure sentence that could hold a path is refused by the writer, never published', (t) => {
  const directory = workspace(t)
  const recorder = createUsageRecorder({ safeStorage: keystore(), directory })
  /* Structural, not a filter someone widens later: the class holds no
     backslash, no forward slash and no control character, so this field cannot
     spell a path or smuggle a second line however long it grows. */
  for (const smuggled of [
    'X:\\SyntheticProfile\\work\\notes.txt',
    'could not read /etc/passwd',
    'first line\nsecond line',
    'x'.repeat(241),
  ]) {
    assert.throws(() => recorder.recordTurn({
      sessionId: 'chat-1', turnId: 'turn-1', failure: smuggled,
      usage: turnUsageFrom({ input_tokens: 1 }),
    }), /failure/i, `the writer admitted ${JSON.stringify(smuggled.slice(0, 30))}`)
    /* And the pre-write check answers null for the same value, so the TURN is
       still recorded -- a lost reason must never become lost tokens. */
    assert.equal(usageLabel('failure', smuggled), null)
  }

  assert.doesNotThrow(() => recorder.recordTurn({
    sessionId: 'chat-1', turnId: 'turn-2', failure: usageLabel('failure', 'X:\\SyntheticProfile\\work'),
    usage: turnUsageFrom({ input_tokens: 1 }),
  }))
  const [entry] = recorder.usage({ limit: 20 }).entries
  assert.equal(entry.usage.failure, null, 'a sentence the ledger could not hold cost the turn its reading')
  assert.equal(entry.usage.inputTokens, 1)
})

test('the two measured refusal sentences both survive the ledger whole', (t) => {
  const directory = workspace(t)
  const recorder = createUsageRecorder({ safeStorage: keystore(), directory })
  /* Both measured off the real CLI: the credits sentence in the 2026-08-18
     walkthrough (it carries a MIDDLE DOT, which a stricter class would have
     dropped), the model sentence off claude 2.1.259 itself. */
  const measured = ["You're out of usage credits \u00b7 resets Aug 25, 12am", MODEL_REFUSAL]
  for (const sentence of measured) {
    assert.equal(usageLabel('failure', sentence), sentence, `the pre-write check dropped a real refusal: ${sentence}`)
  }
  recorder.recordTurn({
    sessionId: 'chat-1', turnId: 'turn-1', status: 'error', failure: usageLabel('failure', measured[0]),
    usage: turnUsageFrom({ input_tokens: 0 }),
  })
  assert.equal(recorder.usage({ limit: 20 }).entries[0].usage.failure, measured[0])
})
