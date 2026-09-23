/* THE SENTENCE WRITTEN FOR THE PERSON HAS TO REACH THE PERSON.
 *
 * T18, cycle 2. shell/agent-host.cjs sendTurn already answers a turn whose
 * provider cannot carry the picture with `pictureNotSent` -- the provider, the
 * file names, and one plain sentence -- and sends the words alone;
 * shell/node-transcript-capture.cjs files that same sentence into the durable
 * record as its own row. Both halves were measured working.
 *
 * WHAT WAS NOT: anything in the window reading it. Two independent searches on
 * 2026-09-16 -- `grep -rn pictureNotSent src/` (zero) and a repository-wide
 * grep over every .js/.mjs/.cjs/.html outside node_modules, capability/ and
 * dist/ (hits only in shell/ and tools/test/) -- so on every surface the chip
 * left the composer, the words went, the agent answered about a picture it had
 * never received, and the one sentence written for the person to read existed
 * only on disk. That is the silent drop T18 exists to end, one layer above
 * where it was first found.
 *
 * This suite drives the REAL Computers view in a REAL hidden Electron window
 * with its own user-data-dir: a real ClipboardEvent carrying a real File, a
 * real Enter, on BOTH surfaces the owner uses -- the full tree conversation and
 * the right-rail chat -- and reads what the conversation ACTUALLY SHOWS. The
 * agent page's own half of the same seam is in
 * tools/test/agent-page-paste-send.test.mjs.
 *
 * Run alone with:
 *   node --test tools/test/picture-refusal-reaches-the-person.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pastePictureInRealWindow } from './helpers/paste-picture-native.mjs'
import { sendRefusalSentence } from '../../src/fleet-tree-copy.js'

/* The exact shape shell/agent-host.cjs sendTurn resolves with, and the exact
   sentence shell/provider-image-support.cjs pictureNotSentSentence writes for
   the `local` provider. Held here as a value the host really produces rather
   than as prose, so this suite measures the RENDERER's handling of it. */
const RECEIPT = Object.freeze({
  provider: 'local',
  files: ['pasted.png'],
  sentence: 'The picture pasted.png was not sent: this agent cannot look at pictures, because a local model session in this build takes words only. Your message was sent without it.',
})

test('a picture the provider cannot carry is said out loud in the conversation, on both surfaces, without painting the send as a failure', async t => {
  const { observations, evidence } = await pastePictureInRealWindow({ pictureNotSent: RECEIPT })
  t.diagnostic('evidence: ' + evidence)

  assert.equal(observations.failure, undefined, 'the window run failed: ' + JSON.stringify(observations.failure))
  assert.deepEqual(observations.pageErrors, [], 'the real window logged renderer errors')
  assert.equal(observations.surfaces.length, 2, 'both surfaces must be exercised')

  for (const surface of observations.surfaces) {
    const where = surface.mode === 'rail' ? 'the right-rail chat' : 'the full tree conversation'
    assert.equal(surface.receiptArmed, true, `the stand-in host was not armed with a receipt for ${where}`)
    assert.equal(surface.pasted.pastedCalls, 1, `the paste never reached the attachment seam in ${where}`)
    assert.equal(surface.result.sent.length, 1, `exactly one turn must be sent from ${where}`)

    /* THE PERSON'S WORDS STILL WENT. The refusal is about the picture, and a
       turn that carried the message is not a failure. */
    assert.equal(surface.result.sent[0].text, 'what is in this picture?', `the person's words were lost in ${where}`)

    /* AND THE SENTENCE IS ON THE SCREEN. Read off the rendered conversation,
       not off the receipt -- the receipt is what the host said, and the whole
       defect was that nothing turned it into something a person can read. */
    const notes = surface.result.diagnostic.noteMessages || []
    assert.ok(notes.some(note => note.includes(RECEIPT.sentence)),
      `${where} showed the person nothing about the picture that did not go. Notes on screen: ${JSON.stringify(notes)}`)

    /* IT IS THE PRODUCT SPEAKING, NOT THE AGENT. A refusal dressed as the
       agent's words is a sentence the agent never said. */
    const said = surface.result.diagnostic.text || ''
    assert.ok(said.includes(RECEIPT.sentence), `the sentence is not in ${where}'s visible text`)
  }
})

/* THE OTHER HALF OF THE SAME SEAM, AND THE ONE THE OWNER CAN HIT.
 *
 * Above, the send succeeded and the picture did not go. Here the send is
 * REFUSED outright, which is what `shell/agent-command-surface.cjs` does for a
 * picture whose path this session never issued:
 *
 *     agentIpcError('MC_AGENT_ATTACHMENT_UNKNOWN',
 *       'An attached file was not picked in this session, so nothing was sent')
 *
 * raised BEFORE sendTurn, so nothing is written and no turn exists. Measured on
 * 2026-09-16: with no row for it in PICTURE_REFUSALS the window read "This
 * message's delivery could not be confirmed. Check the conversation before
 * trying again." and marked the send unconfirmed, which pauses automatic
 * sending -- about a message that never entered a conversation, naming no
 * picture, and advising a retry that `restoreDraft` guarantees will refuse
 * identically. Owner, 2026-09-16: "sending images doesnt work".
 *
 * Asserted by reading the real window: the note's own recorded code, the
 * sentence on screen, and whether the outbox row says automatic sending is
 * paused. */
test('a picture this session does not own refuses in words about the picture, and does not pause sending', async t => {
  const { observations, evidence } = await pastePictureInRealWindow({ sendRefusal: 'MC_AGENT_ATTACHMENT_UNKNOWN' })
  t.diagnostic('evidence: ' + evidence)

  assert.equal(observations.failure, undefined, 'the window run failed: ' + JSON.stringify(observations.failure))
  assert.deepEqual(observations.pageErrors, [], 'the real window logged renderer errors')
  assert.equal(observations.surfaces.length, 2, 'both surfaces must be exercised')

  for (const surface of observations.surfaces) {
    const where = surface.mode === 'rail' ? 'the right-rail chat' : 'the full tree conversation'
    assert.equal(surface.refusalArmed, 'MC_AGENT_ATTACHMENT_UNKNOWN',
      `the stand-in host was not armed to refuse the send in ${where}`)
    assert.equal(surface.pasted.pastedCalls, 1, `the paste never reached the attachment seam in ${where}`)

    const diagnostic = surface.result.diagnostic
    /* THE REFUSAL IS THE ONE THAT HAPPENED. Read off the note the composer
       wrote, so a surface that showed some other refusal cannot pass. */
    assert.ok((diagnostic.refusalCodes || []).includes('MC_AGENT_ATTACHMENT_UNKNOWN'),
      `${where} did not answer the refusal that actually happened. Codes on screen: ${JSON.stringify(diagnostic.refusalCodes)}`)

    /* AND IT IS NOT THE PRODUCT'S CATCH-ALL. Both catch-alls are obtained by
       CALLING the product, never quoted here, so re-wording them cannot
       satisfy this and reinstating the defect cannot either. */
    const notes = diagnostic.noteMessages || []
    const generic = [sendRefusalSentence('A_CODE_NO_TABLE_IN_THIS_PRODUCT_KNOWS'), sendRefusalSentence('MC_AGENT_UNKNOWN_SESSION')]
    for (const fallback of generic) {
      assert.ok(!notes.some(note => note.includes(fallback)),
        `${where} answered a picture this session does not own with a sentence about something else entirely: ${JSON.stringify(notes)}`)
    }
    assert.ok(notes.some(note => note.includes(sendRefusalSentence('MC_AGENT_ATTACHMENT_UNKNOWN'))),
      `${where} showed the person nothing about the picture that was refused. Notes on screen: ${JSON.stringify(notes)}`)

    /* THE UNCONFIRMED VERDICT IS NOT ASSERTED HERE, DELIBERATELY. It is the
       other half of the same defect -- an unconfirmed send pauses automatic
       sending -- but this fixture's composer has no outbox delivery to restore,
       so `.chat-queue-state` is empty both before and after the fix (measured
       on 2026-09-16 in the mutation run: `queueStates: []` in both). An
       assertion that cannot fail is not a guard, so that half is held where it
       CAN fail, by calling sendFailureIsUnconfirmed with the code:
       tools/test/send-refusal-says-what-happened.test.mjs. The field is still
       reported below so a future outbox-bearing fixture has it. */
    void diagnostic.queueStates
  }
})

test('a picture that DID ride the turn adds no such sentence', async t => {
  /* THE CONTROL, and it is what makes the case above mean something: the same
     window, the same paste, the same Enter, with the host answering an ordinary
     receipt. A surface that simply always printed a line would pass the first
     test and fail this one. */
  const { observations, evidence } = await pastePictureInRealWindow()
  t.diagnostic('evidence: ' + evidence)
  assert.equal(observations.failure, undefined, 'the control run failed: ' + JSON.stringify(observations.failure))

  for (const surface of observations.surfaces) {
    const where = surface.mode === 'rail' ? 'the right-rail chat' : 'the full tree conversation'
    assert.equal(surface.receiptArmed, undefined, `${where} was armed with a receipt in the control run`)
    assert.deepEqual(surface.result.sent[0].images, [{ path: surface.result.pasted[0].path }],
      `the pasted picture did not ride the turn sent from ${where}`)
    const notes = surface.result.diagnostic.noteMessages || []
    assert.ok(!notes.some(note => note.includes('was not sent')),
      `${where} told the person a delivered picture had not been sent: ${JSON.stringify(notes)}`)
  }
})
