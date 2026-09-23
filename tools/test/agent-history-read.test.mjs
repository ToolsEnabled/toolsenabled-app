/* The read side of the app's own agent record.
 *
 * The home screen shows a person what has run on their computer, and this is
 * the only path by which that reaches the renderer -- which is to say, the DOM.
 * So the interesting assertions here are not about what it returns but about
 * what it MUST NOT: the working directory of every session it recorded, the
 * signing key's signatures, and the chain hashes. Each is present in the file
 * it reads, each would be trivial to pass along, and each is either a path out
 * of this machine's filesystem or a credential-shaped value that a page has no
 * use for and no way to check.
 *
 * The whole-chain verification result travels instead, computed here, where the
 * key is.
 */
import assert from 'node:assert/strict'
/* Recomputing the commitment by hand is the only way to assert the
   SERIALISATION rather than this process's agreement with itself; see the
   seven-field test below for what that distinction cost. */
import { createHash } from 'node:crypto'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createSpawnRecorder, OUTCOME_DETAIL_WITHHELD } from '../../shell/spawn-record.cjs'

function keystore() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`enc:${Buffer.from(text, 'utf8').toString('base64')}`, 'utf8'),
    decryptString: (buffer) => {
      const stored = buffer.toString('utf8')
      if (!stored.startsWith('enc:')) throw new Error('not encrypted by this keystore')
      return Buffer.from(stored.slice(4), 'base64').toString('utf8')
    },
  }
}

function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-history-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

/* A path that is unmistakable in any output it leaks into. */
const SECRET_CWD = 'C:\\Users\\someone\\Documents\\A Private Folder'

test('an empty machine reports no runs rather than an error', (t) => {
  const recorder = createSpawnRecorder({ safeStorage: keystore(), directory: workspace(t) })
  const history = recorder.history()
  assert.equal(history.ok, true)
  assert.equal(history.total, 0)
  assert.deepEqual([...history.entries], [])
  assert.equal(history.verified, true, 'an empty chain is an intact chain')
})

test('runs come back newest first, with a whole-chain verdict', (t) => {
  const recorder = createSpawnRecorder({ safeStorage: keystore(), directory: workspace(t) })
  recorder.record({ action: 'agent_session_start', sessionId: 'one', details: { cwd: SECRET_CWD } })
  recorder.record({ action: 'agent_session_start', sessionId: 'two', details: { cwd: SECRET_CWD } })
  recorder.record({ action: 'agent_session_start', sessionId: 'three', details: { cwd: SECRET_CWD } })

  const history = recorder.history()
  assert.equal(history.ok, true)
  assert.equal(history.total, 3)
  assert.deepEqual(history.entries.map(entry => entry.sequence), [3, 2, 1])
  assert.equal(history.verified, true)
})

test('no working directory reaches the renderer, though every record holds one', (t) => {
  const directory = workspace(t)
  const recorder = createSpawnRecorder({ safeStorage: keystore(), directory })
  recorder.record({ action: 'agent_session_start', sessionId: 'one', details: { cwd: SECRET_CWD } })

  /* Proof the path really is in the file, so the assertion below is testing
     removal and not the absence of an input. */
  assert.match(readFileSync(recorder.ledgerPath, 'utf8'), /A Private Folder/)

  const serialized = JSON.stringify(recorder.history())
  assert.doesNotMatch(serialized, /A Private Folder/)
  assert.doesNotMatch(serialized, /someone/)
  assert.equal(serialized.includes('details'), false, 'the details object is dropped whole, not filtered')
})

test('no signature or chain hash reaches the renderer', (t) => {
  const recorder = createSpawnRecorder({ safeStorage: keystore(), directory: workspace(t) })
  const receipt = recorder.record({ action: 'agent_session_start', sessionId: 'one' })

  const serialized = JSON.stringify(recorder.history())
  assert.doesNotMatch(serialized, /signature/i)
  assert.doesNotMatch(serialized, /eventHash/i)
  assert.doesNotMatch(serialized, /previousHash/i)
  assert.equal(serialized.includes(receipt.eventHash), false)

  /* FIVE fields have joined this list, and each one had to earn it.
     `outcome` exists because the reply could not otherwise distinguish a run
     that worked from a run that refused, and the screen built on it told people
     three failed starts "still check out".
     `principal` exists because the page could not otherwise tell WHICH of the
     runs on this computer were the signed-in person's -- the ledger is one file
     per device on purpose (splitting it would let an account delete its own
     history and break everyone else's chain), so showing somebody their own
     history is a filter, and a filter needs the field.
     `sessionId` exists because the screen could otherwise say only "Agent run
     37 · started". The owner's report was exactly that: the list has no agent
     context. WHAT it was asked and WHICH agent was asked live in the page's own
     saved conversation, keyed by session -- so the join key is the whole
     difference between a row that means something and a row that does not. It
     is NOT in `details`' class: the renderer minted the id before the start was
     requested and already holds every one of its own, whereas `details` carries
     a working directory, which is a path out of this machine and stays dropped.
     `usage` is the FOURTH, and it earned it the same way `outcome` did: what a
     turn cost arrives on this computer, per turn, from both engines, and until
     it was written down the metrics page could only say the product never sees
     a token count -- true of the RECORD and false of the PRODUCT. It is not in
     `details`' class either: every field inside it is a non-negative whole
     number or a string matching a pattern with no backslash, no colon and no
     space, so it structurally cannot hold a path, and boundedUsage() re-imposes
     that shape on the way out. It is null on every record in THIS ledger, which
     has never carried one; the turns live in their own file (see
     shell/usage-record.cjs) so they cannot crowd the runs out of this window.
     `end` is the FIFTH, and it earned it the way `outcome` did: this ledger
     wrote two lines per run -- the intent, then started/refused -- and never a
     line when the session ENDED, so no screen could truthfully say a run had
     finished or how long it ran. The end record joins its start by `resolves`
     exactly as the outcome does. It is not in `details`' class: a closed set of
     four reasons, a whole number of turns, and the provider's own bare word for
     the last turn, each re-imposed by boundedEnd() on the way out; it carries
     no duration, because a span the shell computed is a claim the chain cannot
     check. It is null on every record that is not an end record, and null on a
     start with no end record -- which reads as "does not say", never as
     finished and never as still running.
     None of the five is safe on trust: `outcome` is pinned by the
     writer-refusal test below, `principal` and `sessionId` by the shape tests
     after it, `usage` by tools/test/usage-record.test.mjs, and `end` by
     tools/test/agent-session-end-record.test.mjs. */
  for (const entry of recorder.history().entries) {
    assert.deepEqual(Object.keys(entry).sort(), ['action', 'at', 'end', 'outcome', 'principal', 'sequence', 'sessionId', 'usage'])
  }
  assert.equal(recorder.history().entries[0].usage, null, 'a run record carries no turn figures')
  assert.equal(recorder.history().entries[0].outcome, null, 'a start on its own has no outcome to report')
  assert.equal(recorder.history().entries[0].end, null, 'a start on its own has no ending to report, and none is invented')
})

/* THE JOIN KEY IS BOUNDED FOR THE SAME REASON THE PRINCIPAL IS.
 *
 * history() deliberately still returns records when the chain does NOT verify,
 * so an unverified line reaches the reader by design -- which means anything
 * that could append to this file could otherwise put an arbitrary string where
 * a screen expects a session id. It goes on to look that value up in the
 * person's own saved conversations, so a value shaped like a path, a key, or a
 * lookup expression must never survive the trip.
 *
 * The admitted shape is the shape the app writes: lower-case ASCII, digits and
 * dashes, at most 128 characters. Everything else is null, which downstream
 * already has to handle -- an unmatched run simply shows what it always showed.
 */
test('the session id on a record is bounded, and anything else reads as unsaid', (t) => {
  const directory = workspace(t)
  const recorder = createSpawnRecorder({ safeStorage: keystore(), directory })
  recorder.record({ action: 'agent_session_start', sessionId: 'chat-1127f295-8406-4623-8490-b7387f017ca2' })

  const first = recorder.history().entries[0]
  assert.equal(first.sessionId, 'chat-1127f295-8406-4623-8490-b7387f017ca2',
    'the id the app really writes did not survive the trip')

  const forged = [
    'C:\\Users\\someone\\.codex\\auth.json',
    '../../../etc/passwd',
    '<img src=x onerror=alert(1)>',
    'chat-UPPER-CASE',
    `chat-${'a'.repeat(200)}`,
    'chat id with spaces',
  ]
  const ledger = readFileSync(recorder.ledgerPath, 'utf8').trim().split('\n')
  const template = JSON.parse(ledger[0])
  writeFileSync(recorder.ledgerPath, `${forged
    .map((sessionId, index) => JSON.stringify({ ...template, sequence: index + 1, sessionId }))
    .join('\n')}\n`)

  for (const entry of recorder.history().entries) {
    assert.equal(entry.sessionId, null, `a record carrying ${JSON.stringify(entry)} was handed to the page as an id`)
  }
})

/* The principal is the one field on this reply that names a PERSON, so the
 * shapes it may take are exactly two and everything else is "this record does
 * not say". Narrow on purpose: a screen filters on this value to decide which
 * runs are the signed-in person's, and a name rendered next to somebody's own
 * history is an accusation. Anything that could write a line into the ledger
 * must not be able to write itself a name.
 */
test('the principal on a record is one of two shapes, and anything else reads as unsaid', (t) => {
  const directory = workspace(t)
  const recorder = createSpawnRecorder({ safeStorage: keystore(), directory })
  const accountPrincipal = `account:${'a1b2c3d4'.repeat(4)}`
  recorder.record({ action: 'agent_session_start', sessionId: 'one', principal: accountPrincipal })
  recorder.record({ action: 'agent_session_start', sessionId: 'two', principal: 'unauthenticated' })

  const entries = recorder.history().entries
  assert.equal(entries.find(entry => entry.sequence === 1).principal, accountPrincipal)
  assert.equal(entries.find(entry => entry.sequence === 2).principal, 'unauthenticated')

  /* Bytes off disk that the writer would never have produced. The ledger is
     signed, but history() deliberately still returns records when the chain
     does NOT verify, so an unverified line reaches the reader by design. */
  const forged = [
    'C:\\Users\\someone\\.codex',
    'account:not-hex',
    'account:',
    'ACCOUNT:A1B2C3D4A1B2C3D4A1B2C3D4A1B2C3D4',
    'Josh (the owner, definitely)',
    `account:${'a'.repeat(31)}`,
    `account:${'a'.repeat(33)}`,
  ]
  const ledger = readFileSync(recorder.ledgerPath, 'utf8').trim().split('\n')
  const template = JSON.parse(ledger[0])
  writeFileSync(recorder.ledgerPath, `${forged
    .map((principal, index) => JSON.stringify({ ...template, sequence: index + 1, principal }))
    .join('\n')}\n`)

  for (const entry of recorder.history().entries) {
    assert.equal(entry.principal, null, `a record carrying ${JSON.stringify(entry)} was rendered as a name`)
  }
  assert.doesNotMatch(JSON.stringify(recorder.history()), /someone|definitely/)
})

test('an outcome cannot carry anything but a bare code, so it is safe to render', (t) => {
  const recorder = createSpawnRecorder({ safeStorage: keystore(), directory: workspace(t) })
  const start = recorder.record({ action: 'agent_session_start', sessionId: 'one' })

  /* The whole promise of this field is that it can never hold a path. It is
     kept by the WRITER refusing, not by a reader filtering -- so these are the
     shapes an incautious caller would reach for, and each one must throw. */
  for (const reason of [
    'C:\\Users\\someone\\.codex',
    'Unable to run codex --version: C:\\Program Files\\nope',
    'lower_case_code',
    'HAS SPACES',
  ]) {
    assert.throws(
      () => recorder.record({
        action: 'agent_session_outcome',
        sessionId: 'one',
        outcome: { result: 'refused', resolves: start.sequence, reason },
      }),
      /outcome/i,
      `a reason of ${JSON.stringify(reason)} must be refused, not written`,
    )
  }

  assert.throws(() => recorder.record({
    action: 'agent_session_outcome',
    sessionId: 'one',
    outcome: { result: 'probably', resolves: start.sequence, reason: null },
  }), /outcome/i, 'the result is a closed vocabulary')

  recorder.record({
    action: 'agent_session_outcome',
    sessionId: 'one',
    outcome: { result: 'refused', resolves: start.sequence, reason: 'CODEX_CLI_NOT_FOUND' },
  })

  const reply = recorder.history()
  const outcome = reply.entries.find(entry => entry.outcome)?.outcome
  assert.deepEqual(outcome, { result: 'refused', resolves: start.sequence, reason: 'CODEX_CLI_NOT_FOUND' })
  assert.deepEqual(reply.outcomes, { starts: 1, started: 0, refused: 1 }, 'and the run counts as one run, not two')
  assert.equal(recorder.verify().ok, true, 'a record carrying an outcome still verifies')
})

test('a record with no outcome still commits to exactly the seven fields it always did', (t) => {
  const directory = workspace(t)
  const recorder = createSpawnRecorder({ safeStorage: keystore(), directory })
  const first = recorder.record({ action: 'agent_session_start', sessionId: 'one' })
  recorder.record({
    action: 'agent_session_outcome',
    sessionId: 'one',
    outcome: { result: 'started', resolves: first.sequence, reason: null },
  })

  /* THE CROSS-VERSION PROPERTY, ASSERTED AGAINST THE BYTES rather than against
     this process's own agreement with itself.
   *
   * The first version of this test wrote records and re-verified them in one
   * run, which is a tautology: a canonicalJson that appends `outcome ?? null`
   * unconditionally hashes AND re-hashes over eight fields, so the chain agrees
   * with itself perfectly and the test stays green. A planted mutation proved
   * exactly that -- it went green, and the property everybody cared about was
   * unmeasured.
   *
   * What actually matters is what happens to a ledger written by the version
   * BEFORE outcomes existed, which is every ledger already on a customer's
   * disk. Those lines committed to seven fields. So this recomputes the
   * commitment the old code would have made and requires the stored eventHash
   * to equal it -- pinning the serialisation itself, not the round trip. If the
   * eighth field ever becomes unconditional, this goes red here, and the
   * symptom in the product would be every existing user being told their record
   * no longer checks out. */
  const lines = readFileSync(join(directory, 'agent-spawn-records.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(line => JSON.parse(line))
  const withoutOutcome = lines.find(line => line.outcome === undefined)
  assert.ok(withoutOutcome, 'this test needs a record that carries no outcome')

  const sevenFields = JSON.stringify([
    withoutOutcome.sequence,
    withoutOutcome.at,
    withoutOutcome.action,
    withoutOutcome.sessionId,
    withoutOutcome.principal,
    withoutOutcome.details,
    withoutOutcome.previousHash,
  ])
  assert.equal(
    createHash('sha256').update(sevenFields, 'utf8').digest('hex'),
    withoutOutcome.eventHash,
    'a record with no outcome must hash over seven fields, exactly as it did before outcomes existed',
  )

  /* And the record that DOES carry one commits to eight, so presence is part of
     the commitment and stripping the field cannot go unnoticed. */
  const withOutcome = lines.find(line => line.outcome !== undefined)
  assert.ok(withOutcome, 'this test needs a record that carries an outcome')
  const eightFields = JSON.stringify([
    withOutcome.sequence, withOutcome.at, withOutcome.action, withOutcome.sessionId,
    withOutcome.principal, withOutcome.details, withOutcome.previousHash, withOutcome.outcome,
  ])
  assert.equal(
    createHash('sha256').update(eightFields, 'utf8').digest('hex'),
    withOutcome.eventHash,
    'a record carrying an outcome must commit to it',
  )

  assert.equal(recorder.verify().ok, true)
  assert.deepEqual(recorder.history().outcomes, { starts: 1, started: 1, refused: 0 })
})

test('a tampered chain is reported, and the runs are still shown', (t) => {
  const directory = workspace(t)
  const recorder = createSpawnRecorder({ safeStorage: keystore(), directory })
  recorder.record({ action: 'agent_session_start', sessionId: 'one' })
  recorder.record({ action: 'agent_session_start', sessionId: 'two' })

  const lines = readFileSync(recorder.ledgerPath, 'utf8').split('\n').filter(Boolean)
  const first = JSON.parse(lines[0])
  first.sessionId = 'someone-elses-session'
  writeFileSync(recorder.ledgerPath, `${JSON.stringify(first)}\n${lines[1]}\n`)

  const reopened = createSpawnRecorder({ safeStorage: keystore(), directory })
  const history = reopened.history()
  assert.equal(history.ok, true)
  assert.equal(history.verified, false, 'an edited record must not report as intact')
  assert.equal(history.entries.length, 2, 'and the evidence that something ran is not destroyed')
})

test('a garbled line is skipped rather than taking the whole screen down', (t) => {
  const directory = workspace(t)
  const recorder = createSpawnRecorder({ safeStorage: keystore(), directory })
  recorder.record({ action: 'agent_session_start', sessionId: 'one' })
  appendFileSync(recorder.ledgerPath, 'this is not json\n')

  const reopened = createSpawnRecorder({ safeStorage: keystore(), directory })
  const history = reopened.history()
  assert.equal(history.ok, true)
  assert.equal(history.entries.length, 1)
  assert.equal(history.verified, false, 'an unparsable line is a broken chain, and is reported as one')
})

test('the returned tail is bounded however large the record grows', (t) => {
  const recorder = createSpawnRecorder({ safeStorage: keystore(), directory: workspace(t) })
  for (let index = 0; index < 40; index += 1) {
    recorder.record({ action: 'agent_session_start', sessionId: `session-${index}` })
  }

  assert.equal(recorder.history({ limit: 5 }).entries.length, 5)
  assert.equal(recorder.history({ limit: 5 }).total, 40, 'the total still describes the whole record')
  assert.equal(recorder.history().entries.length, 20, 'a caller that names no bound gets a bounded answer')
  assert.equal(recorder.history({ limit: 10_000 }).entries.length, 40, 'and an absurd bound is clamped, not honoured')
  for (const limit of [0, -1, 1.5, Number.NaN, 'twenty', null]) {
    assert.equal(recorder.history({ limit }).entries.length, 20, `a nonsense limit falls back: ${String(limit)}`)
  }
})

/* ------------------------------------------------------------------
   Not re-checking bytes already checked.

   The screen asks this question repeatedly, on the Electron main process, which
   is also what forwards output for every live agent session -- so the cost is
   not the home screen's, it is every running agent's. The cache exists for
   that. These tests exist because a cache over a tamper-evidence check is
   exactly the kind of optimisation that quietly turns the property into
   decoration, and because "it got faster" is not evidence that it still works.
   ------------------------------------------------------------------ */

/* COUNTED, NOT TIMED. The first version of this asserted that the repeat read
   was three times faster, and it was flaky: during a mutation round it went red
   after a byte-identical restore, which means it accused correct code. A test
   that can do that is worse than no test. What is actually being claimed is
   "the signature work is not repeated", so that is what is measured. */
test('an unchanged record is not re-verified, and a changed one always is', (t) => {
  const directory = workspace(t)
  const recorder = createSpawnRecorder({ safeStorage: keystore(), directory })
  for (let index = 0; index < 40; index += 1) {
    recorder.record({ action: 'agent_session_start', sessionId: `session-${index}` })
  }

  const first = recorder.history({ limit: 5 })
  assert.equal(first.verified, true)
  assert.equal(recorder.stats().signatureChecks, 40, 'the first read checks every signature once')

  const second = recorder.history({ limit: 5 })
  assert.equal(second.verified, true)
  assert.equal(second.total, 40)
  assert.equal(recorder.stats().signatureChecks, 40, 'and the second read checks none of them again')

  /* Appending does NOT serve the old answer, and does NOT re-check the old
     records either: one new record, one new signature check. */
  recorder.record({ action: 'agent_session_start', sessionId: 'session-40' })
  const third = recorder.history({ limit: 5 })
  assert.equal(third.total, 41)
  assert.equal(third.verified, true)
  assert.equal(recorder.stats().signatureChecks, 41, 'an append costs one check, not another whole pass')
})

test('SECURITY: a same-length edit to an old record is caught, not served from the cache', (t) => {
  const directory = workspace(t)
  const recorder = createSpawnRecorder({ safeStorage: keystore(), directory })
  for (let index = 0; index < 20; index += 1) {
    recorder.record({ action: 'agent_session_start', sessionId: `aaaaaaaa-${index}` })
  }

  assert.equal(recorder.history().verified, true, 'the chain checks out and the verdict is now cached')

  /* The attack a size-and-timestamp cache key cannot see: one old record edited
     in place, the file's length unchanged, the timestamp put back. Every field
     such a key compares is identical to what was verified a moment ago. */
  const before = readFileSync(recorder.ledgerPath)
  const stat = statSync(recorder.ledgerPath)
  const lines = before.toString('utf8').split('\n').filter(Boolean)
  const target = JSON.parse(lines[3])
  assert.equal(target.sessionId.length, 'aaaaaaaa-3'.length)
  target.sessionId = 'zzzzzzzz-3'
  lines[3] = JSON.stringify(target)
  const after = Buffer.from(`${lines.join('\n')}\n`, 'utf8')
  assert.equal(after.length, before.length, 'the tampered file is the same length, or this tests nothing')
  writeFileSync(recorder.ledgerPath, after)
  utimesSync(recorder.ledgerPath, stat.atime, stat.mtime)

  /* The SIZE is asserted and the timestamp is not, and that is a correction
     rather than a shortcut. An earlier draft asserted the restored mtime
     equalled the original to the millisecond; it failed roughly two runs in
     five, because utimesSync loses the sub-millisecond fraction and the
     filesystem rounds where the assertion floored. A test that accuses correct
     code two times in five is worse than no test, and it cost a mutation round
     to find.
     Dropping it costs nothing, because the timestamp was never the point: the
     cache does not read it. It compares the file's bytes, so an attacker with a
     PERFECT mtime restore gains nothing either -- a stronger claim than this
     assertion was making, and one proved by planting the size-keyed cache and
     watching this test go red. */
  assert.equal(statSync(recorder.ledgerPath).size, stat.size, 'the tampered file is the same size on disk')

  assert.equal(recorder.history().verified, false, 'an edited record must not be reported as intact')
  assert.equal(recorder.verify().ok, false, 'and the independent check agrees')
})

test('SECURITY: a rewritten prefix under an appended record takes the full check', (t) => {
  const directory = workspace(t)
  const recorder = createSpawnRecorder({ safeStorage: keystore(), directory })
  for (let index = 0; index < 10; index += 1) {
    recorder.record({ action: 'agent_session_start', sessionId: `bbbbbbbb-${index}` })
  }
  assert.equal(recorder.history().verified, true)

  /* The file GROWS, which is the shape the incremental path is for, and its
     prefix is NOT the prefix that was verified. Chaining onto the remembered
     head here would check the new record and wave the edited one through.
     THE EDIT MUST PRESERVE THE PREFIX'S LENGTH, or this proves nothing: a
     length-changing edit moves the append boundary, the incremental split lands
     mid-record, and the read fails as corrupt for an entirely different reason.
     A first version of this test did exactly that and passed while the prefix
     check was planted out -- green over the hole it was written to guard. */
  const before = readFileSync(recorder.ledgerPath)
  const lines = before.toString('utf8').split('\n').filter(Boolean)
  const target = JSON.parse(lines[2])
  assert.equal(target.sessionId, 'bbbbbbbb-2')
  target.sessionId = 'cccccccc-2'
  lines[2] = JSON.stringify(target)
  const tampered = Buffer.from(`${lines.join('\n')}\n`, 'utf8')
  assert.equal(tampered.length, before.length, 'the rewritten prefix is the same length, or this tests nothing')
  writeFileSync(recorder.ledgerPath, tampered)

  recorder.record({ action: 'agent_session_start', sessionId: 'bbbbbbbb-10' })

  assert.equal(
    recorder.history().verified, false,
    'a record edited underneath an append must not be waved through by the incremental path',
  )
})

/* Ported from the performance lane's independent attack harness, because a
   scratchpad harness is not coverage: it proves the property today and is gone
   tomorrow. This is the attack aimed squarely at the INCREMENTAL branch -- the
   one that exists to avoid re-checking old records -- and it asks whether that
   branch actually checks the NEW ones or merely counts them. */
test('SECURITY: a forged record appended onto a genuine prefix is caught on the incremental path', (t) => {
  const directory = workspace(t)
  const recorder = createSpawnRecorder({ safeStorage: keystore(), directory })
  for (let index = 0; index < 6; index += 1) {
    recorder.record({ action: 'agent_session_start', sessionId: `session-${index}` })
  }
  assert.equal(recorder.history().verified, true, 'the verdict is cached, so the next read takes the incremental path')
  const checksWhenWarm = recorder.stats().signatureChecks

  /* A replay: a genuine record's own eventHash and signature, carried onto a
     body that has been moved to the end of the chain. The sequence and the
     predecessor link are both correct -- an attacker gets those for free -- so
     the only thing standing between this and `verified: true` is the commitment
     actually being recomputed over the body it claims to cover. */
  const lines = readFileSync(recorder.ledgerPath, 'utf8').split('\n').filter(Boolean)
  const genuine = JSON.parse(lines[0])
  const head = JSON.parse(lines[lines.length - 1])
  const forged = { ...genuine, sequence: head.sequence + 1, previousHash: head.eventHash }
  appendFileSync(recorder.ledgerPath, `${JSON.stringify(forged)}\n`)

  assert.equal(
    recorder.history().verified, false,
    'a replayed hash and signature over a different body is not a record, and the incremental path must not take it',
  )
  assert.ok(
    recorder.stats().signatureChecks >= checksWhenWarm,
    'and the appended bytes were genuinely examined rather than counted',
  )
})

test('SECURITY: a truncated record is caught rather than read as a shorter chain', (t) => {
  const directory = workspace(t)
  const recorder = createSpawnRecorder({ safeStorage: keystore(), directory })
  for (let index = 0; index < 8; index += 1) {
    recorder.record({ action: 'agent_session_start', sessionId: `session-${index}` })
  }
  assert.equal(recorder.history().verified, true)

  const lines = readFileSync(recorder.ledgerPath, 'utf8').split('\n').filter(Boolean)
  writeFileSync(recorder.ledgerPath, `${lines.slice(0, 4).join('\n')}\n`)

  const history = recorder.history()
  assert.equal(history.total, 4, 'the shorter file is read as it is')
  assert.equal(history.verified, true, 'a prefix of a valid chain is itself a valid chain, and saying otherwise would be false')

  /* But the records that were removed are gone from the count, which is the
     evidence a reader actually has. Stated here so nobody later mistakes the
     line above for "deletion is undetectable and we do not care". Deletion of a
     TAIL is not detectable by a self-contained chain -- only an external anchor
     can do that, and shell/spawn-record.cjs says plainly that it is not one. */
  assert.equal(recorder.verify().count, 4)
})

test('the independent check is never answered from the cache', (t) => {
  const directory = workspace(t)
  const recorder = createSpawnRecorder({ safeStorage: keystore(), directory })
  recorder.record({ action: 'agent_session_start', sessionId: 'one' })
  assert.equal(recorder.history().verified, true, 'the verdict is cached')

  const lines = readFileSync(recorder.ledgerPath, 'utf8').split('\n').filter(Boolean)
  const target = JSON.parse(lines[0])
  target.at = new Date(Date.parse(target.at) + 60_000).toISOString()
  writeFileSync(recorder.ledgerPath, `${JSON.stringify(target)}\n`)

  assert.equal(recorder.verify().ok, false, 'verify() re-reads and re-checks every time it is called')
})

/* The assertions about the IPC channel itself live in
   tools/test/agent-history-channel.test.mjs, which lands with the two shell
   files it describes. Keeping them here would have made this suite red in any
   tree that has the recorder but not yet the channel. */

/* T393. The signed record keeps the measured reason beside the code, so two
   refusals that share a code but mean opposite things stay distinguishable
   in the log. Driven with the host's real sentences for
   AGENT_ACCOUNT_RECOVERY_NO_ALTERNATE (resolver absent versus resolver ran
   and refused); nothing pins the spelling. */
test('an outcome keeps the measured reason beside the code, and two producers of one code stay tellable apart', (t) => {
  const recorder = createSpawnRecorder({ safeStorage: keystore(), directory: workspace(t) })
  const unwired = recorder.record({ action: 'agent_session_start', sessionId: 'unwired' })
  const measured = recorder.record({ action: 'agent_session_start', sessionId: 'measured' })
  const code = 'AGENT_ACCOUNT_RECOVERY_NO_ALTERNATE'
  recorder.record({ action: 'agent_session_outcome', sessionId: 'unwired',
    outcome: { result: 'refused', resolves: unwired.sequence, reason: code, detail: `${code}: Account selection is unavailable; no replacement was started.` } })
  recorder.record({ action: 'agent_session_outcome', sessionId: 'measured',
    outcome: { result: 'refused', resolves: measured.sequence, reason: code, detail: 'No other eligible account is available for this program.' } })
  const outcomes = recorder.history().entries.filter(entry => entry.outcome).map(entry => entry.outcome)
  assert.equal(outcomes.length, 2)
  assert.ok(outcomes.every(outcome => outcome.reason === code), 'both rows carry the same code')
  assert.ok(outcomes.every(outcome => typeof outcome.detail === 'string' && outcome.detail.length > 10), 'both rows carry a detail')
  assert.notEqual(outcomes[0].detail, outcomes[1].detail, 'the two producers must not collapse into one word')
  assert.ok(!outcomes.some(outcome => outcome.detail.startsWith(code)), 'the detail does not repeat the code beside it')
  assert.equal(recorder.verify().ok, true, 'a record carrying a detail still verifies')
})
test('a detail can never carry a path or an address, and a refused detail says so rather than vanishing', (t) => {
  const recorder = createSpawnRecorder({ safeStorage: keystore(), directory: workspace(t) })
  const start = recorder.record({ action: 'agent_session_start', sessionId: 'one' })
  const rows = [
    ['C:\\Users\\someone\\.codex is not a folder', OUTCOME_DETAIL_WITHHELD],
    ['Unable to run codex --version: /usr/local/bin/codex', OUTCOME_DETAIL_WITHHELD],
    ['The home ~/.claude could not be read', OUTCOME_DETAIL_WITHHELD],
    ['Signed in as someone@example.test on the subscription; the first turn proves it can serve.', null],
    ['x'.repeat(400), OUTCOME_DETAIL_WITHHELD],
  ]
  for (const [detail] of rows) recorder.record({ action: 'agent_session_outcome', sessionId: 'one',
    outcome: { result: 'refused', resolves: start.sequence, reason: 'AGENT_ACCOUNT_UNAVAILABLE', detail } })
  const details = recorder.history({ limit: 10 }).entries.filter(entry => entry.outcome).map(entry => entry.outcome.detail).reverse()
  assert.equal(details.length, rows.length)
  rows.forEach(([offered, expected], index) => {
    if (expected !== null) assert.equal(details[index], expected, `offered ${JSON.stringify(offered.slice(0, 40))}`)
    else {
      assert.notEqual(details[index], OUTCOME_DETAIL_WITHHELD, 'an address is redacted, not the whole sentence withheld')
      assert.ok(!details[index].includes('@'), 'the address itself must not be recorded')
      assert.ok(details[index].includes('first turn proves'), 'the rest of the sentence survives')
    }
  })
  for (const detail of details) assert.doesNotMatch(detail, /[\\/~@]/)
  const plain = recorder.record({ action: 'agent_session_start', sessionId: 'two' })
  recorder.record({ action: 'agent_session_outcome', sessionId: 'two', outcome: { result: 'refused', resolves: plain.sequence, reason: 'CODEX_CLI_NOT_FOUND' } })
  const bare = recorder.history({ limit: 1 }).entries[0].outcome
  assert.deepEqual(Object.keys(bare), ['result', 'resolves', 'reason'], 'a record offered no detail carries no detail field at all')
  assert.equal(recorder.verify().ok, true)
})
