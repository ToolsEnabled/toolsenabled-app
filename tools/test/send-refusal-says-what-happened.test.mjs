/* A SEND THAT NEVER HAPPENED MUST NOT BE REPORTED AS A DELIVERY NOBODY CAN
 * VERIFY.
 *
 * T18, cycle 2, measured on 2026-09-16 in the owner's own shape. The owner's
 * LIVE profile holds four pasted pictures under `paste-attachments` and, across
 * 24 045 files in `node-transcripts`, ZERO rows carrying an `attachments` key --
 * `attachmentSummaries` always pushes at least `{ name }`, so a picture that
 * rode an accepted turn would always leave one. No picture has ever ridden a
 * recorded turn there. The owner's report was "sending images doesnt work".
 *
 * THE SEAM. `shell/agent-command-surface.cjs`'s `'agent:send'` body checks every
 * `request.images` path against the session's own allowlist, and for a path that
 * session never issued it raises -- BEFORE `sendTurn` is called at all, so
 * nothing is written and no turn exists:
 *
 *     agentIpcError('MC_AGENT_ATTACHMENT_UNKNOWN',
 *       'An attached file was not picked in this session, so nothing was sent')
 *
 * The window disagreed with the shell about what had just happened. The tree
 * conversation and the right rail both refuse through
 * `src/views/computers.js` treeCardSend's rejection branch:
 *
 *     fail(queuedSendRefusalSentence(code),
 *          { code, unconfirmed: sendFailureIsUnconfirmed(code), restoreDraft: true })
 *
 * and with no row in `PICTURE_REFUSALS` this code fell through to the generic
 * branch: the person read "This message's delivery could not be confirmed.
 * Check the conversation before trying again." -- about a message that never
 * entered a conversation -- and the send was marked unconfirmed, which
 * `sendFailureIsUnconfirmed`'s own note says "would pause automatic sending".
 * Neither sentence named a picture. `restoreDraft` puts the same chip back, so
 * the advised retry refuses identically for ever.
 *
 * WHAT THIS SUITE HOLDS. Not one code: the RULE. Every refusal code that
 * `'agent:send'` raises in its own body is read out of the shell source at run
 * time, so a refusal added tomorrow is held by this gate on the day it is
 * added rather than on the day someone remembers to list it here. For each one:
 *
 *   1. it survives the IPC boundary with its code intact, or the window can
 *      never tell it apart from anything else;
 *   2. the composer's sentence for it is NOT either catch-all -- both catch-alls
 *      are obtained by CALLING the product with codes chosen to land on them,
 *      never by writing their words here, so this suite cannot be satisfied by
 *      editing a string;
 *   3. it is not reported as delivery-unconfirmed, because the shell raised it
 *      before any transport write;
 *   4. the sentence offers a next step and shows no MC_AGENT_ identifier.
 *
 * Run alone with:
 *   node --test tools/test/send-refusal-says-what-happened.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { refusalCode } from '../../src/agent-availability-copy.js'
import { sendFailureIsUnconfirmed, sendRefusalSentence } from '../../src/fleet-tree-copy.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/* The codes `'agent:send'` raises itself, read out of the shell rather than
   listed here. The slice runs from the handler to the next handler key at the
   same indentation, so a code raised by a neighbouring command cannot drift in
   and a code added to this one cannot drift out. */
function codesRaisedByAgentSend() {
  const source = readFileSync(path.join(ROOT, 'shell', 'agent-command-surface.cjs'), 'utf8')
  const opens = source.indexOf("    'agent:send': async (")
  assert.notEqual(opens, -1,
    "the 'agent:send' handler could not be found in shell/agent-command-surface.cjs, so this gate is reading nothing")
  const rest = source.slice(opens + 1)
  const nextKey = rest.search(/\n {4}'agent:[a-z-]+': /)
  const body = nextKey === -1 ? rest : rest.slice(0, nextKey)
  const codes = [...body.matchAll(/agentIpcError\('([A-Z0-9_]+)'/g)].map(match => match[1])
  return [...new Set(codes)]
}

/* THE TWO CATCH-ALLS, OBTAINED BY ASKING RATHER THAN BY QUOTING.
   A code no table can know lands on the "delivery could not be confirmed"
   branch; a code the tables classify as preflight-but-unremarkable lands on the
   "was not sent, check the agent is available" branch. Comparing against these
   values means this suite still fails if someone reinstates the defect by
   copying a catch-all sentence into the picture table. */
const UNCONFIRMED_CATCH_ALL = sendRefusalSentence('A_CODE_NO_TABLE_IN_THIS_PRODUCT_KNOWS')
const NOT_SENT_CATCH_ALL = sendRefusalSentence('MC_AGENT_UNKNOWN_SESSION')

test('the catch-all sentences this gate compares against are really distinct', () => {
  assert.notEqual(UNCONFIRMED_CATCH_ALL, NOT_SENT_CATCH_ALL,
    'the two fallback branches answer identically, so this gate cannot tell a specific sentence from a generic one')
  assert.ok(UNCONFIRMED_CATCH_ALL.length > 20 && NOT_SENT_CATCH_ALL.length > 20,
    'a fallback sentence is empty, so every comparison below would pass vacuously')
})

test("every refusal 'agent:send' raises itself reaches the composer as its own sentence", () => {
  const codes = codesRaisedByAgentSend()
  assert.ok(codes.length >= 1,
    "no refusal code was read out of the 'agent:send' body; the reader has drifted from the source")

  for (const code of codes) {
    assert.equal(refusalCode(new Error(code)), code,
      `${code} does not survive the IPC boundary, so the window shows a different refusal than the one that happened`)

    const sentence = sendRefusalSentence(code)
    assert.notEqual(sentence, UNCONFIRMED_CATCH_ALL,
      `${code} is raised before any transport write, and the composer tells the person their delivery could not be confirmed`)
    assert.notEqual(sentence, NOT_SENT_CATCH_ALL,
      `${code} reaches the composer as the generic "check that this agent is still available", which names nothing the person can act on`)
    assert.doesNotMatch(sentence, /MC_AGENT_|[A-Z]{3,}_[A-Z_]{3,}/,
      `${code} leaked an identifier into the sentence a person reads: ${sentence}`)
    assert.ok(sentence.split(/(?<=[.!?])\s/).length >= 2,
      `the sentence for ${code} states a problem and offers no next step: ${sentence}`)
  }
})

test("a send refusal raised before sendTurn is not reported as delivery-unconfirmed", () => {
  for (const code of codesRaisedByAgentSend()) {
    assert.equal(sendFailureIsUnconfirmed(code), false,
      `${code} is raised before sendTurn is called, so nothing was written; marking it unconfirmed pauses automatic sending and sends the person to check a conversation their message never entered`)
  }
})

/* THE ONE THE OWNER CAN HIT, ASSERTED AS BEHAVIOUR RATHER THAN AS WORDS.
   A picture that is no longer the session's own is the only thing that raises
   this, so the sentence has to be about a picture and about this send being
   over -- not about a delivery to go and look for. Checked by asking whether
   the sentence distinguishes itself from every OTHER send refusal the product
   can produce, which no amount of re-wording can fake. */
test('a picture the session does not own refuses with a sentence of its own', () => {
  const mine = sendRefusalSentence('MC_AGENT_ATTACHMENT_UNKNOWN')
  const others = [
    'MC_AGENT_UNKNOWN_SESSION', 'MC_AGENT_SESSION_ENDED', 'AGENT_TURN_ACTIVE',
    'AGENT_SESSION_UNKNOWN', 'MC_AGENT_FOREIGN_SESSION', 'MC_AGENT_NOT_OWNER',
    'A_CODE_NO_TABLE_IN_THIS_PRODUCT_KNOWS',
  ].map(code => sendRefusalSentence(code))
  for (const other of others) {
    assert.notEqual(mine, other,
      'the refusal only a picture can cause is worded exactly like a refusal that has nothing to do with a picture')
  }
  assert.equal(sendFailureIsUnconfirmed('MC_AGENT_ATTACHMENT_UNKNOWN'), false,
    'a picture the session does not own is refused before anything is written, and the composer still calls the send unconfirmed')
})
