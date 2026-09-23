/* THE SETTINGS VAULT PAGE'S MAIN-PROCESS SEAM, DRIVEN.
 *
 * WHAT THIS SUITE IS FOR. Three claims are made by the row
 * `vault_credentials` in src/views/settings.js, and each one is worth nothing
 * unless something calls the code with values and looks at what comes back:
 *
 *   1  LISTING SHOWS NAMES AND NOTHING THAT NARROWS A VALUE. Not the value, not
 *      a masked prefix, and not a length -- a length turns a password into a
 *      much smaller search space, so "14 characters" is a disclosure dressed as
 *      a reassurance. The fake store below HOLDS values, and the assertions
 *      hunt for each value AND for each value's length in the answer.
 *   2  ADDING GOES THROUGH THE FLOW THE PRODUCT ALREADY HAS. The seam calls the
 *      same two payload functions `system.credential_request` calls and sends a
 *      choice and a name; it is never given a value and never writes one.
 *   3  NOTHING IS REMOVED UNTIL THE OWNER APPROVES THAT EXACT REMOVAL. Active
 *      Ledger rule R1225. Five separate refusals are driven, each counting the
 *      remover's calls, because "it refuses" is only true if the destructive
 *      function was not reached.
 *
 * NO REAL CREDENTIAL IS IN THIS FILE. The fake store's values are the obviously
 * synthetic placeholders below; they are not credentials for anything and are
 * not derived from any record in any vault.
 *
 * WHY THE PAYLOAD MODULES ARE FAKED AND WHAT KEEPS THE FAKES HONEST. The owner
 * prompt store and the credential queue ship in the capability payload, which
 * is not in this repository (.gitignore names `/capability/`), so requiring
 * them here would need a path this suite is not allowed to hardcode. The fakes
 * therefore model the contract, and the LAST test in this file checks the model
 * against the real modules whenever MC_TEST_CAPABILITY_PAYLOAD names a payload
 * -- and SKIPS BY NAME, saying so, when it does not. A silent skip is the
 * defect this codebase keeps re-finding.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { ownedFixtureTempRoot } from './lib/owned-fixture-temp.mjs'

const require_ = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const seam = require_(path.join(ROOT, 'shell', 'vault-credential-page.cjs'))
const vaultPresence = require_(path.join(ROOT, 'shell', 'vault-presence.cjs'))

/* A FAKE STORE THAT CONTAINS VALUES, so "no value came out" is a measurement
   rather than a tautology. Deliberately synthetic: each one says what it is. */
const FAKE_STORE = Object.freeze({
  provider_api_key: 'SYNTHETIC-PLACEHOLDER-NOT-A-CREDENTIAL-0001',
  google_oauth_client_id: 'SYNTHETIC-PLACEHOLDER-NOT-A-CREDENTIAL-000000002',
  legacy_token: 'SYNTHETIC-PLACEHOLDER-NOT-A-CREDENTIAL-3',
})
const FAKE_NAMES = Object.freeze(Object.keys(FAKE_STORE).sort())

/* WHAT tools/secrets.ps1's 'list' VERB PRINTS: one key per line, and no value,
   because that verb never calls Unprotect-CipherText. */
function listingStub({ record = [] } = {}) {
  return (file, args, options) => {
    record.push({ file, args, options })
    return `${Object.keys(FAKE_STORE).join('\r\n')}\r\n`
  }
}

/* A capability root shaped like the real one: the seam STATS
   <capabilityRoot>/tools/secrets.ps1 before it spawns anything, and that check
   is real behaviour worth exercising rather than routing around. The file's
   CONTENTS are never read here -- the spawn itself is the stub above -- so it
   is deliberately empty and holds nothing. */
function fakeCapabilityRoot(name, { linuxReader = false } = {}) {
  const root = path.join(ownedFixtureTempRoot(), `mc-cap-${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true })
  fs.writeFileSync(path.join(root, 'tools', 'secrets.ps1'), '')
  if (linuxReader) {
    /* The seam STATS this file before it asks the loader for it, so a Linux
       case without it would land on VAULT_TOOLING_ABSENT and never reach the
       reader shape the test is actually about. Empty, and never read: the
       loader is injected. */
    fs.mkdirSync(path.join(root, 'src', 'lib'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src', 'lib', 'vault-linux.js'), '')
  }
  return root
}

function stateRoot(name) {
  const root = path.join(ownedFixtureTempRoot(), `mc-${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(path.join(root, 'state'), { recursive: true })
  return root
}

/* Every string anywhere in an answer, so a value hiding in a nested field or a
   sentence is still caught. */
function everyString(value, found = []) {
  if (typeof value === 'string') found.push(value)
  else if (Array.isArray(value)) for (const item of value) everyString(item, found)
  else if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) { found.push(key); everyString(value[key], found) }
  }
  return found
}

function assertNoValueEscaped(answer, where) {
  const strings = everyString(answer)
  const blob = strings.join('\n')
  for (const [name, value] of Object.entries(FAKE_STORE)) {
    assert.ok(!blob.includes(value), `${where} carried the value stored under ${name}`)
    /* A PREFIX IS A DISCLOSURE TOO. Any run of the value long enough to be a
       real head start must not appear either -- this is what catches a "ghp_ab…"
       style mask that a plain equality check would walk straight past. */
    assert.ok(!blob.includes(value.slice(0, 8)), `${where} carried a prefix of the value stored under ${name}`)
    /* AND SO IS A LENGTH. Asserted as a number in any field and as digits in
       any sentence, because both are the same disclosure. */
    assert.ok(!strings.includes(String(value.length)), `${where} carried the length of the value stored under ${name}`)
    assert.ok(!blob.includes(` ${value.length} `), `${where} narrates the length of the value stored under ${name}`)
  }
}

test('the vault listing answers with record names and nothing that narrows a value', async () => {
  const record = []
  const answer = await seam.listCredentialNames({
    capabilityRoot: fakeCapabilityRoot('names'), stateRoot: stateRoot('names'), platform: 'win32', run: listingStub({ record }),
  })
  assert.equal(answer.ok, true, answer.reason)
  /* POSITIVE FIRST. Without this the suite would pass on an answer that carried
     nothing at all, which is how a check over a stand-in becomes a no-op. */
  assert.deepEqual([...answer.names], FAKE_NAMES)
  assertNoValueEscaped(answer, 'the name listing')

  /* IT ASKED THE VERB THAT CANNOT PRINT A VALUE. Asserted as an absence over
     the real argv rather than by pinning a spelling: a better implementation
     may reach the names another way, but no implementation of THIS question
     has any business spawning a verb that decrypts. */
  assert.equal(record.length, 1, 'the listing asked the vault exactly once')
  const spawned = record[0].args.map(String)
  for (const verb of vaultPresence.VALUE_RETURNING_VAULT_VERBS) {
    assert.ok(!spawned.includes(verb), `the name listing spawned the value-returning verb "${verb}"`)
  }
  /* And it did not smuggle a key or a value in through the environment or
     stdin: no input is supplied at all on this path. */
  assert.equal(record[0].options.input, undefined, 'the name listing wrote something to the vault process stdin')
})

test('a vault that could not be read is unknown, never an empty vault', async () => {
  for (const [label, fail] of [
    ['a vault process that would not start', { code: 'ENOENT' }],
    ['a vault that did not answer in time', { code: 'ETIMEDOUT' }],
    ['a vault process that stopped without answering', { code: 'EPERM' }],
  ]) {
    const attempts = []
    const answer = await seam.listCredentialNames({
      capabilityRoot: fakeCapabilityRoot('unreadable'),
      stateRoot: stateRoot('unreadable'),
      platform: 'win32',
      run: (...args) => { attempts.push(args); throw Object.assign(new Error('the message is never carried'), fail) },
    })
    assert.equal(attempts.length, 1, `${label} never reached the vault at all, so this case proves nothing`)
    assert.equal(answer.ok, false, `${label} was reported as a successful read`)
    assert.ok(!('names' in answer), `${label} answered with a name list`)
    assert.ok(answer.code && answer.reason, `${label} refused without naming itself`)
    /* THE DISTINCTION THIS WHOLE PATH EXISTS FOR: a file error must not read as
       "you have no credentials". */
    assert.doesNotMatch(answer.reason, /\bno credentials\b|\bholds none\b/i,
      `${label} told the owner his vault is empty`)
  }
})

test('a reader that answers with more than names is refused, not rendered', async () => {
  /* THE SHAPE FENCE, DRIVEN. This is the shape a future "just show a hint of
     it" change would arrive in, and it must not reach a window. */
  const answer = await seam.listCredentialNames({
    capabilityRoot: ROOT,
    stateRoot: stateRoot('surplus'),
    readNames: async () => ({
      readable: true, code: 'VAULT_NAMES_READ', detail: 'read', store: null,
      names: FAKE_NAMES, values: { ...FAKE_STORE },
    }),
  })
  assert.equal(answer.ok, false, 'a value-bearing answer was passed through to the page')
  assert.equal(answer.code, 'VAULT_NAME_ANSWER_UNEXPECTED_FIELD')
  assertNoValueEscaped(answer, 'the refusal of a value-bearing answer')
})

test('adding a credential reaches the product\'s own request flow and writes nothing', async () => {
  const enqueued = []
  const answer = seam.requestCredentialAdd({ credential: 'custom', customName: 'provider_api_key' }, {
    credentialCatalogue: {
      resolveCredentialRequest: ({ credential, customName }) => {
        assert.equal(credential, 'custom', 'the seam did not use the catalogue\'s custom path')
        return { key: `custom.${customName}`, label: 'Provider api key' }
      },
    },
    ownerPromptQueue: { enqueue: request => { enqueued.push(request); return { requestId: 'owner-prompt-x', replayed: false } } },
  })
  assert.equal(answer.ok, true, answer.reason)
  assert.equal(enqueued.length, 1, 'the add path did not queue the owner\'s entry form exactly once')
  const request = enqueued[0]
  /* THE QUEUE'S OWN CONTRACT, so this fails if the seam starts sending
     something that queue would refuse. */
  assert.equal(request.kind, 'credential')
  assert.equal(request.vaultKey, 'custom.provider_api_key')
  assert.equal(request.requester, seam.SETTINGS_REQUESTER)
  assert.deepEqual(Object.keys(request.requestContext).sort(), ['lifetime', 'purpose', 'scope'])
  /* AND THE THING THAT MAKES IT NOT A SECOND WRITER: no value went anywhere. */
  assert.ok(!('value' in request), 'the add path sent a value to the prompt queue')
  assert.ok(!everyString(request).some(text => Object.values(FAKE_STORE).includes(text)),
    'the add path carried a stored value')
})

/* A PROMPT STORE THAT BEHAVES LIKE THE REAL ONE: enqueue hands back an id, and
   a decision is readable only once the owner has made one. Nothing this fake
   exposes lets a caller decide on the owner's behalf, which is the property the
   real store has and the reason the gate below is worth anything. */
function promptStoreStub() {
  const settled = new Map()
  let next = 0
  return {
    enqueue(input) {
      assert.equal(input.kind, 'confirmation', 'the removal asked for something other than a confirmation')
      assert.ok(input.title && input.message, 'the removal asked the owner to confirm nothing in particular')
      const promptId = `00000000-0000-4000-8000-00000000000${next++}`
      return { promptId, kind: 'confirmation', expiresAt: new Date(Date.now() + 3600_000).toISOString() }
    },
    settledDecision(promptId) { return settled.get(promptId) ?? null },
    /* The test's stand-in for the owner pressing a button on #/approvals. */
    ownerDecides(promptId, decision, kind = 'confirmation') {
      settled.set(promptId, {
        id: promptId, kind, settledReason: 'decided',
        settledAt: new Date().toISOString(), decision: { decision, decidedAt: new Date().toISOString() },
      })
    },
    ownerNeverSawIt(promptId) {
      settled.set(promptId, { id: promptId, kind: 'confirmation', settledReason: 'superseded', settledAt: new Date().toISOString(), decision: null })
    },
  }
}

test('nothing is removed until the owner approves that exact removal', async () => {
  const prompts = promptStoreStub()
  const removed = []
  const options = () => ({ ownerPrompts: prompts, removeCredential: request => { removed.push(request); return { status: 'cleared' } } })
  const root = stateRoot('removal')

  /* 1  NO APPROVAL WAS EVER ASKED FOR. A page that skipped straight to the
        second channel gets nothing. */
  const unasked = await seam.completeCredentialRemoval(
    { name: 'legacy_token', promptId: '00000000-0000-4000-8000-000000000000' },
    { ...options(), stateRoot: root })
  assert.equal(unasked.ok, false)
  assert.equal(unasked.code, 'OWNER_APPROVAL_NOT_REQUESTED')
  assert.equal(removed.length, 0, 'a credential was removed with no approval ever requested')

  /* 2  ASKED, NOT YET ANSWERED. This is the state the owner is in for as long
        as the prompt sits on his approvals screen, and it must not remove. */
  const asked = seam.requestCredentialRemoval({ name: 'legacy_token' }, { ...options(), stateRoot: root })
  assert.equal(asked.ok, true, asked.reason)
  assert.equal(asked.approvalHref, '#/approvals', 'the removal did not point at the product\'s approvals surface')
  assert.equal(removed.length, 0, 'asking for approval removed the credential')
  const pending = await seam.completeCredentialRemoval({ name: 'legacy_token', promptId: asked.promptId }, { ...options(), stateRoot: root })
  assert.equal(pending.code, 'OWNER_APPROVAL_PENDING')
  assert.equal(pending.removed, false)
  assert.equal(removed.length, 0, 'a credential was removed while the approval was still pending')

  /* 3  ANSWERED "NO". */
  prompts.ownerDecides(asked.promptId, 'deny')
  const denied = await seam.completeCredentialRemoval({ name: 'legacy_token', promptId: asked.promptId }, { ...options(), stateRoot: root })
  assert.equal(denied.code, 'OWNER_APPROVAL_NOT_GIVEN')
  assert.equal(denied.removed, false)
  assert.equal(removed.length, 0, 'a credential was removed after the owner said no')

  /* 4  ANSWERED "YES" -- and only now does the remover run, once, for the name
        the owner was actually shown. */
  const second = seam.requestCredentialRemoval({ name: 'legacy_token' }, { ...options(), stateRoot: root })
  prompts.ownerDecides(second.promptId, 'approve')
  const done = await seam.completeCredentialRemoval(
    { name: 'legacy_token', promptId: second.promptId, reason: 'provider_revoked' },
    { ...options(), stateRoot: root })
  assert.equal(done.ok, true, done.reason)
  assert.equal(done.removed, true)
  /* THE REMOVER IS TOLD WHICH DECISION AUTHORISED IT. Without this the remover
     cannot carry the owner's approval to a tool that asks for one of its own,
     and any grant it minted would be untraceable to a decision -- which
     shell/vault-credential-approval.cjs refuses outright. */
  assert.deepEqual(removed, [{ vaultKey: 'legacy_token', reason: 'provider_revoked', ownerPromptId: second.promptId }])

  /* 5  AN APPROVAL IS SPENT ONCE. Pressing again must not delete a record the
        owner has since re-entered under the same name. */
  const replay = await seam.completeCredentialRemoval({ name: 'legacy_token', promptId: second.promptId }, { ...options(), stateRoot: root })
  assert.equal(replay.ok, false)
  assert.equal(replay.code, 'OWNER_APPROVAL_NOT_REQUESTED')
  assert.equal(removed.length, 1, 'one approval removed a credential twice')
})

test('asking twice about one record reuses the owner question, and a refusal does not', () => {
  /* THE DEFECT, FOUND ON SCREEN. One Remove made one binding and one approvals
   * card; the owner approved it; back on the vault page the only control was
   * Remove again -- which minted a SECOND promptId and ORPHANED the approved
   * one. The decision was spent, the credential stayed, and a person following
   * the screen exactly could never finish a removal.
   *
   * REUSE THE BINDING, NOT THE GRANT: the approval returned here is still spent
   * exactly once by completeCredentialRemoval, still bound to this name, and
   * still refused on replay. The five refusals above are untouched by it. */
  const prompts = promptStoreStub()
  const removed = []
  const options = { ownerPrompts: prompts, removeCredential: request => { removed.push(request) }, stateRoot: stateRoot('reuse') }

  const first = seam.requestCredentialRemoval({ name: 'legacy_token' }, options)
  assert.equal(first.ok, true, first.reason)
  assert.equal(first.code, 'OWNER_APPROVAL_REQUESTED')
  assert.ok(!first.reused, 'the first ask reported itself as a reuse')

  /* 1  ASKED AGAIN WHILE UNANSWERED -- the same question, and it says so. */
  const again = seam.requestCredentialRemoval({ name: 'legacy_token' }, options)
  assert.equal(again.promptId, first.promptId, 'asking twice raised a second prompt and orphaned the first')
  assert.equal(again.code, 'OWNER_APPROVAL_ALREADY_REQUESTED')
  assert.equal(again.reused, true, 'the reused binding did not say it was reused')

  /* 2  ASKED AGAIN AFTER APPROVAL -- still the one the owner answered, because
        this is the exact press that used to throw the approval away. */
  prompts.ownerDecides(first.promptId, 'approve')
  const afterApproval = seam.requestCredentialRemoval({ name: 'legacy_token' }, options)
  assert.equal(afterApproval.promptId, first.promptId, 'pressing Remove after approving orphaned the approval')

  /* 3  A DIFFERENT RECORD IS A DIFFERENT QUESTION. */
  const other = seam.requestCredentialRemoval({ name: 'provider_api_key' }, options)
  assert.notEqual(other.promptId, first.promptId, 'two records were given one prompt')
  assert.ok(!other.reused)

  /* 4  ANSWERED NO, AND ASKED AGAIN -- a NEW question. Reusing here would tell
        the owner his answer was "still waiting" when it was no, and hand back a
        prompt that can only ever refuse. */
  prompts.ownerDecides(other.promptId, 'deny')
  const afterDeny = seam.requestCredentialRemoval({ name: 'provider_api_key' }, options)
  assert.notEqual(afterDeny.promptId, other.promptId, 'pressing Remove after a refusal replayed the refused prompt')
  assert.ok(!afterDeny.reused, 'a refused binding was reported as still waiting')

  /* AND NOTHING WAS REMOVED BY ANY OF THAT. Asking is not removing, however
     many times it is asked. */
  assert.equal(removed.length, 0, 'asking about a removal removed something')

  /* ONE LIVE BINDING PER RECORD through four asks, rather than a pile of them:
     the reuse above takes the first live match, so a stale entry for the same
     record would shadow the prompt the owner is actually looking at. */
  const pending = seam.pendingCredentialRemovals(options)
  assert.equal(pending.ok, true, pending.reason)
  assert.equal(pending.pending.filter(entry => entry.name === 'legacy_token').length, 1,
    'one record accumulated more than one live binding')
  assert.equal(pending.pending.filter(entry => entry.name === 'provider_api_key').length, 1,
    'the refused binding was left behind the new one')
})

test('the page can read back what is waiting for the owner, and what he answered', async () => {
  /* WHY THIS EXISTS. Approving a removal means LEAVING the vault page for
   * #/approvals, which destroys the panel and its memory of which prompt it
   * raised. The binding was always durable; nothing read it back. So the
   * approved decision became unreachable from the screen.
   *
   * No end-to-end caught it because every one drove request and complete IN ONE
   * PROCESS -- the navigation never happened, so the memory never cleared.
   *
   * THE THREE ANSWERS ARE KEPT APART, because a page that knew only "you asked
   * about this" would still have to guess whether to offer completion. */
  const prompts = promptStoreStub()
  const root = stateRoot('pending-read')
  const options = { ownerPrompts: prompts, removeCredential: () => ({ status: 'cleared' }), stateRoot: root }

  assert.deepEqual(seam.pendingCredentialRemovals(options).pending, [],
    'a state root with no bindings reported something waiting')

  const waiting = seam.requestCredentialRemoval({ name: 'legacy_token' }, options)
  const approved = seam.requestCredentialRemoval({ name: 'provider_api_key' }, options)
  const refused = seam.requestCredentialRemoval({ name: 'google_oauth_client_id' }, options)
  prompts.ownerDecides(approved.promptId, 'approve')
  prompts.ownerDecides(refused.promptId, 'deny')

  const read = seam.pendingCredentialRemovals(options)
  assert.equal(read.ok, true, read.reason)
  assert.equal(read.code, 'VAULT_REMOVALS_PENDING_READ')
  assert.deepEqual(
    [...read.pending].sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: 'google_oauth_client_id', promptId: refused.promptId, decision: 'refused' },
      { name: 'legacy_token', promptId: waiting.promptId, decision: 'waiting' },
      { name: 'provider_api_key', promptId: approved.promptId, decision: 'approved' },
    ],
    'the three answers were not reported apart')

  /* NO VALUE AND NO TOKEN ON THIS PATH. It carries names, prompt ids and one
     word. The fake store HOLDS values, so this is a measurement rather than a
     restatement of the code -- and a length is hunted too, because "14
     characters" is a disclosure dressed as a reassurance.

     THE PROMPT IDS ARE PINNED RATHER THAN SEARCHED, and this is the one place
     in this suite where that distinction matters. A prompt id is minted by the
     owner-prompt store when the question is asked, before any value has been
     looked at, so it cannot encode one -- and being uuid-shaped it is full of
     digits, so hunting a two-digit length inside it reports a hit by
     coincidence (00000000-0000-4000-8000-... contains "40", and one placeholder
     here is 40 characters long). A coincidence is not a disclosure and a check
     that cannot tell them apart measures nothing.

     So each id is asserted EQUAL to the one the store handed back -- nothing
     can hide in a field that must match a known string exactly -- and every
     other string in the answer is hunted for values and for lengths. */
  const minted = new Map([
    ['legacy_token', waiting.promptId],
    ['provider_api_key', approved.promptId],
    ['google_oauth_client_id', refused.promptId],
  ])
  for (const entry of read.pending) {
    assert.equal(entry.promptId, minted.get(entry.name),
      'the pending read reported an id the owner-prompt store never minted for ' + entry.name)
  }
  const text = JSON.stringify(read.pending.map(({ promptId, ...rest }) => rest))
  for (const [name, value] of Object.entries(FAKE_STORE)) {
    assert.ok(!text.includes(value), 'the pending read carried a stored value for ' + name)
    assert.ok(!text.includes(String(value.length)), 'the pending read narrowed ' + name + ' to a length')
  }
  /* And the whole answer, ids included, still never carries a VALUE. A value is
     long and specific enough that a substring hit is not a coincidence. */
  for (const [name, value] of Object.entries(FAKE_STORE)) {
    assert.ok(!JSON.stringify(read).includes(value), 'the pending read carried a stored value for ' + name)
  }

  /* AN UNREADABLE ANSWER IS 'unknown', NOT 'approved'. A delete path must never
     round an unknown answer up, and the page draws no completion control for
     one. Driven by a store whose reader throws. */
  const blind = {
    ...options,
    ownerPrompts: { enqueue: prompts.enqueue, settledDecision() { throw new Error('the prompt store is unreadable') } },
  }
  const unknown = seam.pendingCredentialRemovals(blind)
  assert.equal(unknown.ok, true, unknown.reason)
  assert.ok(unknown.pending.length > 0, 'nothing was read back to be judged')
  assert.deepEqual([...new Set(unknown.pending.map(entry => entry.decision))], ['unknown'],
    'an unreadable answer was reported as something other than unknown')

  /* AND A SURFACE THAT CANNOT BE REACHED AT ALL REFUSES BY NAME rather than
     reporting an empty list, which a page would draw as "nothing waiting".
     "Could not look" and "nothing there" are different answers. */
  const surfaceless = seam.pendingCredentialRemovals({ ...options, ownerPrompts: {} })
  assert.equal(surfaceless.ok, false)
  assert.equal(surfaceless.code, 'OWNER_PROMPT_SURFACE_UNAVAILABLE')
  const rootless = seam.pendingCredentialRemovals({ ...options, stateRoot: '' })
  assert.equal(rootless.ok, false)
  assert.equal(rootless.code, 'VAULT_STATE_ROOT_REQUIRED')

  /* READING WHAT IS WAITING DOES NOT ANSWER IT: the approved one still
     completes, and the one the owner has not answered still refuses. */
  const done = await seam.completeCredentialRemoval({ name: 'provider_api_key', promptId: approved.promptId }, options)
  assert.equal(done.removed, true, done.reason)
  const still = await seam.completeCredentialRemoval({ name: 'legacy_token', promptId: waiting.promptId }, options)
  assert.equal(still.code, 'OWNER_APPROVAL_PENDING')
})

test('an approval is bound to the record it was shown for', async () => {
  const prompts = promptStoreStub()
  const removed = []
  const options = { ownerPrompts: prompts, removeCredential: request => { removed.push(request); return null }, stateRoot: stateRoot('binding') }

  const asked = seam.requestCredentialRemoval({ name: 'legacy_token' }, options)
  prompts.ownerDecides(asked.promptId, 'approve')

  /* THE SAME APPROVED PROMPT, POINTED AT A DIFFERENT RECORD. The prompt store's
     settled decision names no subject, so without this seam's own binding the
     owner's "yes" about one credential would delete another. */
  const crossed = await seam.completeCredentialRemoval({ name: 'provider_api_key', promptId: asked.promptId }, options)
  assert.equal(crossed.ok, false, 'an approval shown for one credential was accepted for another')
  assert.equal(crossed.code, 'OWNER_APPROVAL_NOT_REQUESTED', 'the wrong (approval, record) pair was not refused by name')
  assert.equal(removed.length, 0, 'an approval for one credential removed another')

  /* And the approval it WAS for still works, so the binding refuses the wrong
     pair rather than breaking the right one. */
  const right = await seam.completeCredentialRemoval({ name: 'legacy_token', promptId: asked.promptId }, options)
  assert.equal(right.removed, true, right.reason)
  assert.deepEqual(removed, [{ vaultKey: 'legacy_token', reason: 'no_longer_needed', ownerPromptId: asked.promptId }])
})

test('only a decided confirmation authorises a deletion', async () => {
  for (const [label, arrange] of [
    ['a purchase approval', (prompts, promptId) => prompts.ownerDecides(promptId, 'approve', 'purchase_batch')],
    ['a notice acknowledgement', (prompts, promptId) => prompts.ownerDecides(promptId, 'acknowledge', 'notice')],
    ['a prompt retired without an answer', (prompts, promptId) => prompts.ownerNeverSawIt(promptId)],
  ]) {
    const prompts = promptStoreStub()
    const removed = []
    const options = { ownerPrompts: prompts, removeCredential: request => { removed.push(request) }, stateRoot: stateRoot('kind') }
    const asked = seam.requestCredentialRemoval({ name: 'legacy_token' }, options)
    arrange(prompts, asked.promptId)
    const answer = await seam.completeCredentialRemoval({ name: 'legacy_token', promptId: asked.promptId }, options)
    assert.equal(answer.ok, false, `${label} was accepted as approval to delete a credential`)
    assert.equal(removed.length, 0, `${label} removed a credential`)
  }
})

/* ------------------------------------------------------------------------
 * THE REMOVER IS ASYNC IN THE PRODUCT, AND FOR A WHILE THIS SUITE COULD NOT
 * SEE THAT.
 *
 * Every case above injects a SYNCHRONOUS remover. The remover the shell
 * actually supplies is tool-registry.js#executeTool, which is `async` and which
 * REJECTS with PERMISSION_SESSION_REQUIRED when no permission ceiling is
 * stated. A synchronous stub cannot fail the way the product fails, so the
 * suite stayed green while the seam answered { removed: true } with a Promise
 * sitting in its payload -- a reply that then failed structuredClone on the way
 * to the renderer, whose rejection is voided, with the owner's approval already
 * spent and the record still in the vault.
 *
 * Measured before the fix, against the real registry: executeTool with no
 * context returned a Promise that rejected PERMISSION_SESSION_REQUIRED; the
 * seam answered CREDENTIAL_REMOVED; structuredClone of that answer threw
 * DataCloneError; and the approval binding was gone.
 *
 * These three tests are the ones that would have caught it.
 */
test('a remover that rejects reports failure and does not spend the approval', async () => {
  const prompts = promptStoreStub()
  const attempts = []
  const rejecting = {
    ownerPrompts: prompts,
    stateRoot: stateRoot('rejecting'),
    /* THE PRODUCT'S OWN FAILURE, MODELLED: async, and it rejects. The code is
       the one tool-registry.js throws for a dispatch with no stated ceiling. */
    removeCredential: async request => {
      attempts.push(request)
      throw Object.assign(new Error('Tool cannot be dispatched without a stated permission ceiling.'),
        { code: 'PERMISSION_SESSION_REQUIRED' })
    },
  }
  const asked = seam.requestCredentialRemoval({ name: 'legacy_token' }, rejecting)
  prompts.ownerDecides(asked.promptId, 'approve')

  const failed = await seam.completeCredentialRemoval({ name: 'legacy_token', promptId: asked.promptId }, rejecting)
  assert.equal(attempts.length, 1, 'the remover was never reached, so this case proves nothing')
  /* 1  IT REPORTS FAILURE. Never removed: true for a removal that did not
        happen -- the page has no other way to know. */
  assert.equal(failed.ok, false, 'a rejected removal was reported as a success')
  assert.equal(failed.removed, false, 'a rejected removal reported removed: true')
  assert.ok(failed.code && failed.reason, 'a rejected removal refused without naming itself')

  /* 2  THE APPROVAL SURVIVES. The owner said yes and the product failed;
        making him approve again would blame him for that. Proven by retrying
        with a working remover and having it succeed on the SAME approval. */
  const retried = await seam.completeCredentialRemoval({ name: 'legacy_token', promptId: asked.promptId },
    { ...rejecting, removeCredential: async () => ({ status: 'cleared' }) })
  assert.equal(retried.removed, true, retried.reason
    || 'the approval was spent by a failure, so the owner would have to approve again')
})

test('removed: true is only said after the removal has actually resolved', async () => {
  /* THE ORDERING, OBSERVED. The remover is async and does not settle until this
     test lets it, so if the seam answered early `settled` would still be false
     when the answer arrived. This is what "await it" means, asserted as
     behaviour rather than by looking for the word in the source. */
  const prompts = promptStoreStub()
  let settled = false
  const options = {
    ownerPrompts: prompts,
    stateRoot: stateRoot('ordering'),
    /* SETTLES ON A LATER TICK, the way a spawned vault process does. A remover
       that resolved in the same microtask would hide an un-awaited call,
       because the value would already be there by the time anything looked. */
    removeCredential: () => new Promise(resolve => setTimeout(() => {
      settled = true
      resolve({ status: 'cleared' })
    }, 10)),
  }
  const asked = seam.requestCredentialRemoval({ name: 'legacy_token' }, options)
  prompts.ownerDecides(asked.promptId, 'approve')

  /* NOT awaited yet, on purpose: this is the instant an un-awaited seam would
     already have answered `removed: true`. */
  const pending = seam.completeCredentialRemoval({ name: 'legacy_token', promptId: asked.promptId }, options)
  assert.equal(settled, false, 'the removal settled immediately, so the ordering this test exists for is untested')
  const answer = await pending
  assert.equal(settled, true,
    'the seam answered before the removal had settled -- removed: true for a removal that had not happened')
  assert.equal(answer.removed, true, answer.reason)
})

test('every answer this seam can give survives the IPC boundary', async () => {
  /* structuredClone IS THE IPC BOUNDARY. A Promise, a class instance or a
     function anywhere in one of these answers means the reply never reaches the
     renderer -- it throws DataCloneError in the main process and the page sees
     a rejection it has no words for. That is exactly how the broken removal
     went unnoticed: the failure was in the transport, not in the logic.

     Driven over every terminal state this function has, not a sample. */
  const prompts = promptStoreStub()
  const root = stateRoot('clonable')
  const base = { ownerPrompts: prompts, stateRoot: root }
  const answers = []

  answers.push(['no remover', await seam.completeCredentialRemoval(
    { name: 'legacy_token', promptId: '00000000-0000-4000-8000-000000000000' }, base)])

  const asked = seam.requestCredentialRemoval({ name: 'legacy_token' }, base)
  answers.push(['asked', asked])
  answers.push(['pending', await seam.completeCredentialRemoval({ name: 'legacy_token', promptId: asked.promptId }, base)])

  prompts.ownerDecides(asked.promptId, 'deny')
  answers.push(['denied', await seam.completeCredentialRemoval({ name: 'legacy_token', promptId: asked.promptId }, base)])

  const second = seam.requestCredentialRemoval({ name: 'legacy_token' }, base)
  prompts.ownerDecides(second.promptId, 'approve')
  answers.push(['rejected remover', await seam.completeCredentialRemoval(
    { name: 'legacy_token', promptId: second.promptId },
    { ...base, removeCredential: async () => { throw new Error('no') } })])
  /* The remover's own answer is a shape this seam does not control, so the
     success case is driven with one that could NOT be cloned. If any of it were
     carried through, this is where it would show. */
  answers.push(['removed', await seam.completeCredentialRemoval(
    { name: 'legacy_token', promptId: second.promptId },
    { ...base, removeCredential: async () => ({ status: 'cleared', when: () => Date.now(), pending: Promise.resolve(1) }) })])

  answers.push(['listing', await seam.listCredentialNames({
    capabilityRoot: fakeCapabilityRoot('clonable'), stateRoot: root, platform: 'win32', run: listingStub(),
  })])

  assert.equal(answers.length, 7, 'not every terminal state of this seam was exercised')
  for (const [label, answer] of answers) {
    assert.doesNotThrow(() => structuredClone(answer),
      `the "${label}" answer cannot cross the IPC boundary, so the page would see a rejection instead of it`)
  }
})

test('on a platform whose vault cannot be enumerated, the page is told why', async () => {
  /* R1226 -- this product ships Linux and Windows. The engine candidate's
     src/lib/vault-linux.js createReader() returns { presence, getMany } and no
     name verb, so this answer is currently the Linux answer, and it must not be
     a bare "unknown" or an empty list. It has to say which question could not
     be asked and what still works. */
  const answer = await seam.listCredentialNames({
    capabilityRoot: fakeCapabilityRoot('linux', { linuxReader: true }),
    stateRoot: stateRoot('linux'),
    platform: 'linux',
    /* THE CANDIDATE'S REAL READER SHAPE: createReader() returns exactly
       { presence, getMany }. Measured against the engine candidate's
       src/lib/vault-linux.js, not invented. */
    loadLinuxVault: () => ({ createReader: () => ({ presence: async () => 'absent', getMany: async () => new Map() }) }),
  })
  assert.equal(answer.ok, false, 'a platform with no name verb reported a successful listing')
  assert.ok(!('names' in answer), 'a platform with no name verb answered with a name list')
  /* Behaviour, not spelling: the sentence must distinguish "cannot ask" from
     "your vault is empty", and must not leave the person thinking the whole
     page is dead. */
  assert.doesNotMatch(answer.reason, /\byour vault is\b.*\bempty\b/i,
    'the refusal reads as a claim that the vault is empty')
  assert.match(answer.reason, /cannot|could not/i, 'the refusal does not say that the question could not be asked')
  assert.match(answer.reason, /still work|still available|Adding and removing/i,
    'the refusal does not say what still works, so the page reads as entirely dead')
})

test('a payload with no working remover says so instead of reporting a removal', async () => {
  const prompts = promptStoreStub()
  const options = { ownerPrompts: prompts, stateRoot: stateRoot('noremover') }
  const asked = seam.requestCredentialRemoval({ name: 'legacy_token' }, options)
  prompts.ownerDecides(asked.promptId, 'approve')
  const answer = await seam.completeCredentialRemoval({ name: 'legacy_token', promptId: asked.promptId }, options)
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'CREDENTIAL_REMOVER_UNAVAILABLE')
  /* The owner's approval survives, because he gave it and the product failed --
     making him approve again would blame him for an installation fault. */
  const recovered = await seam.completeCredentialRemoval({ name: 'legacy_token', promptId: asked.promptId },
    { ...options, removeCredential: () => ({ status: 'cleared' }) })
  assert.equal(recovered.removed, true, recovered.reason)
})

/* ------------------------------------------------------------------------
 * THE FAKES ABOVE, CHECKED AGAINST THE REAL MODULES.
 *
 * A model of a contract is worth exactly as much as the evidence that the
 * contract still looks like that. This test does that check when a payload is
 * named and REFUSES BY NAME when one is not, rather than passing quietly.
 */
test('the modelled payload contract still matches the real payload', t => {
  const payload = process.env.MC_TEST_CAPABILITY_PAYLOAD
  if (!payload) {
    /* A NAMED SKIP WITH ITS REASON. The capability payload is not in this
       repository -- .gitignore names `/capability/` -- so there is no path this
       file may resolve on its own. Name one in MC_TEST_CAPABILITY_PAYLOAD to
       run this. */
    t.skip('MC_TEST_CAPABILITY_PAYLOAD is not set, so the real owner-prompt store and credential queue could not be inspected. This is "could not look", not "the contract is fine".')
    return
  }
  const prompts = require_(path.join(payload, 'src', 'lib', 'mission-bridge', 'owner-prompts.js'))
  assert.ok(prompts.KINDS.includes('confirmation'), 'the prompt store no longer has a confirmation kind for this page to raise')
  assert.equal(typeof prompts.enqueue, 'function', 'the prompt store no longer offers enqueue')
  assert.equal(typeof prompts.settledDecision, 'function', 'the prompt store no longer offers settledDecision')

  const queue = require_(path.join(payload, 'src', 'lib', 'providers', 'owner-prompt-queue.js'))
  assert.ok(queue.QUEUEABLE_KINDS.includes('credential'), 'the owner-prompt queue no longer takes a credential request')
  assert.ok(queue.REQUESTERS.includes(seam.SETTINGS_REQUESTER),
    `the owner-prompt queue no longer accepts "${seam.SETTINGS_REQUESTER}" as a requester`)
  assert.deepEqual([...queue.REQUEST_CONTEXT_KEYS].sort(), Object.keys(seam.SETTINGS_REQUEST_CONTEXT).sort(),
    'the owner-prompt queue asks for different public context than this page sends')

  const catalogue = require_(path.join(payload, 'src', 'lib', 'credential-metadata.js'))
  assert.equal(typeof catalogue.resolveCredentialRequest, 'function', 'the credential catalogue no longer resolves a request')
  /* THE CUSTOM PATH THE ADD CONTROL USES, EXERCISED, so a change to the custom
     key rule fails here rather than at an owner's keyboard. */
  const resolved = catalogue.resolveCredentialRequest({ credential: 'custom', customName: 'provider_api_key' })
  assert.ok(seam.VAULT_KEY_RE.test(resolved.key), 'the catalogue\'s custom key is no longer a key this seam will send')
  assert.ok(seam.LABEL_RE.test(resolved.label), 'the catalogue\'s custom label is no longer a label the prompt queue accepts')
})
