/* The comms board's quiet state: readable record, nothing in it, and a door.
 *
 * WHY THIS STATE EXISTS AT ALL. The board's message pane is read at run time
 * from this computer's own journal (shell `mc-agent:local-messages` ->
 * capability agent-comms-local.js ownerJournal()). On a payload that carries
 * that reader, a sterile profile answers ok:true with zero messages -- so the
 * board takes its live branch and the host-absent notice, which used to carry
 * the explanation and the guide door for this screen, never renders. Measured
 * on the 2026-08-19 re-cut confirming run (tools/first-run-recovery-qa.mjs,
 * 45/47): the board said "No services are on record for this computer. No
 * messages have been seen for this exact channel." and offered no way to the
 * guide -- the only ring screen without one. The staged copy of the PREVIOUS
 * cut (Temp\first-run-recovery-t9LvJB) has no agent-comms-local.js in its
 * capability payload, which is why the same driver was green there: its shell
 * refused the read and the board fell back to the host-absent notice.
 *
 * So the quiet board now says why it is quiet in the copy module's words and
 * carries the same door every other empty screen carries. These tests pin the
 * module half; the packaged driver reads the same values off the glass.
 *
 * Run: node --test tools/test/comms-quiet-notice.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  GUIDE_ACTION,
  GUIDE_HREF,
  commsQuietMarkup,
  commsQuietNotice,
} from '../../src/first-run-needs.js'

/* The clause tools/first-run-recovery-qa.mjs slices out of the live value. It
   is asserted HERE as well so a rewrite of the copy that drops it fails a unit
   test in the same commit, not only the packaged driver an hour later. */
const DRIVER_CLAUSE = 'no agent here has sent another agent a message'

test('the quiet notice explains the empty board without promising a remedy', () => {
  const notice = commsQuietNotice()
  assert.equal(typeof notice.title, 'string')
  assert.ok(notice.title.length > 0, 'the notice has a title')
  assert.ok(notice.body.includes(DRIVER_CLAUSE),
    `the body carries the clause the packaged driver looks for: ${JSON.stringify(DRIVER_CLAUSE)}`)
  /* The record was READ. This state must never describe itself as a failure:
     "could not be read" here would be the product blaming a working read. */
  assert.ok(!/could not be read/i.test(notice.body), 'a successful read is not described as a failed one')
  assert.ok(!/unavailable/i.test(notice.body), 'a successful read is not described as unavailable')
  /* One door, the shared one -- not a fifth wording of it. */
  assert.equal(notice.action, GUIDE_ACTION)
})

test('the quiet notice is frozen data, like every other export of the module', () => {
  const notice = commsQuietNotice()
  assert.ok(Object.isFrozen(notice), 'the notice object is frozen')
})

test('the markup carries the door and the words, and is DOM-free string output', () => {
  const markup = commsQuietMarkup()
  assert.ok(markup.includes('data-comms-quiet="true"'), 'the board can find and toggle the notice by its data attribute')
  assert.ok(markup.includes(`href="${GUIDE_HREF}"`), 'the door leads to the guide')
  assert.ok(markup.includes(GUIDE_ACTION.label), 'the door is named, not bare')
  assert.ok(markup.includes(DRIVER_CLAUSE), 'the explanation is in the markup, not only in the data')
})

test('the quiet painter keeps the desk voice and has a registered relay twin', () => {
  const local = commsQuietNotice()
  const remote = commsQuietNotice({ viaRelay: true })
  assert.equal(local.body, 'This board shows the messages agents on this computer send each other, read from this computer’s own record. That record was read and it is empty: no agent here has sent another agent a message yet. Nothing on this computer is broken, and nothing is missing from the install.')
  assert.equal(remote.body, 'This board shows the messages agents on the computer you are driving send each other, read from that computer’s own record. That record was read and it is empty: no agent there has sent another agent a message yet. Nothing on that computer is broken, and nothing is missing from the install.')
  assert.ok(commsQuietMarkup().includes(local.body))
  assert.ok(commsQuietMarkup({ viaRelay: true }).includes(remote.body))
})
