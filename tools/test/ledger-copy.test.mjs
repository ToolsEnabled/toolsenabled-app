// THE LEDGER PAGE TELLS ONE STORY PER STATE, AND THE STATES ARE NOT THE SAME.
//
// The owner: the R-ledger panel "is a mess (not human friendly)". What he was
// looking at was one state told three ways at once -- "could not be read" in
// the register's accessible name and in its counter, a calm "this copy does not
// keep one, so there is nothing here to show" in the paragraph between them,
// and below that two forms whose fields described themselves in terms of a list
// that was not on the screen.
//
// The cause was a half-applied repair. Commit 1bdcce7 rewrote ONE line -- the
// body paragraph -- and left the failure chrome around it alone. Nothing could
// catch that, because nothing could see the paragraph and the chrome at the
// same time: they were both composed inside a closure in a view that imports a
// stylesheet.
//
// So this suite holds the two things that had to become true:
//   1. EMPTY and UNREADABLE are different states with different words, and the
//      page can tell them apart from what src/live-status.js already returns;
//   2. every part of one state comes from ONE object, so the paragraph, the
//      accessible name, the counter and the totals cannot disagree again.
//
// The composed panel as a whole is measured by tools/check-composed-output.mjs.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/* The same extractor the plain-language gate uses: comments blanked, template
   literals split at their values. A comment in this codebase QUOTES the
   sentence it replaced, so a raw text search finds the defect inside the note
   explaining that the defect was removed. */
import { visibleTextFrom } from '../lib/user-visible-strings.mjs'

import {
  CHAIN_NOTE,
  DECIDE_ROW,
  DECISION_FORM,
  DECISION_OFF,
  DELETE_ROW,
  EMPTY_LIST,
  EXAMPLE_WRITE_NOTE,
  EXAMPLE_WRITE_NOTE_CHOSEN,
  FILE_BOX,
  HIDE_ROW,
  LEDGER_EMPTY,
  LEDGER_LOADING,
  LEDGER_UNREADABLE,
  PROPOSED_NOTE,
  QUESTIONS_EMPTY,
  QUESTIONS_UNREADABLE,
  QUEUE_FORM,
  REGISTER_NOTICE_STATES,
  REMOVED_TOGGLE,
  LEDGER_LIMITS,
  LEDGER_REFUSAL,
  LEDGER_DAMAGED,
  FILE_BOX_OFF,
  ledgerRefusalSentence,
  COMPLETE_ROW,
  ANSWER_ROW,
  RESOLVE_NOTE,
  RESOLVE_ROW,
  RESOLVE_STATUSES,
  ROW_ACTIONS,
  SCOPE_CHIP,
  SCOPE_FILTER,
  SUPERSEDED_NOTE,
  decisionOff,
  queueSnapshotLine,
  registerNotice,
} from '../../src/ledger-copy.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = relative => readFileSync(path.join(REPO, relative), 'utf8')

const FAILURE_WORDS = /\b(could not|cannot|unavailable|refused|failed|went wrong)\b/i
const EMPTY_WORDS = /\b(nothing here to show|there is nothing|there are none)\b/i

test('every declared no-rows state has a notice, and every notice is declared', () => {
  for (const kind of REGISTER_NOTICE_STATES) {
    const notice = registerNotice({ kind })
    assert.ok(notice, `no notice for the declared state ${kind}`)
    assert.equal(notice.state, kind, `${kind} answers with a notice for ${notice.state}`)
  }
  assert.equal(registerNotice({ kind: 'live' }), null, 'a register with rows draws rows, not a notice')
  assert.equal(registerNotice({ kind: 'simulated' }), null,
    'so does the example register — it goes through the same render path and draws the same rows')
  assert.equal(registerNotice(null), null)
})

test('an empty register and an unreadable one do not share a single word of their verdict', () => {
  assert.ok(EMPTY_WORDS.test(LEDGER_EMPTY.body), 'the empty state must say there is nothing')
  /* THE EMPTY STATE IS A DOOR NOW, NOT A VERDICT. The installed application
     keeps the person's own ledger since 2026-09-02, so "this copy does not
     keep one" stopped being true; the sentence names the two ways to file. */
  /* The file box sits above the list (owner, 2026-09-15), so "below"
     pointed away from it (T1262). */
  assert.match(LEDGER_EMPTY.body, /File a request above/, 'the empty state must point at the file box')
  assert.match(LEDGER_EMPTY.body, /\/Request/, 'and at the chat command')
  assert.doesNotMatch(LEDGER_EMPTY.body, /does not keep one|being built/, 'the old verdict about a copy with no ledger is no longer true')
  assert.equal(LEDGER_EMPTY.door, false, 'a fresh install with nothing on file has no problem for the guide to solve')
  assert.ok(!FAILURE_WORDS.test(LEDGER_EMPTY.body), `the empty state must not read as a failure: ${LEDGER_EMPTY.body}`)
  assert.ok(!FAILURE_WORDS.test(LEDGER_EMPTY.label), `the accessible name too: ${LEDGER_EMPTY.label}`)
  assert.ok(!FAILURE_WORDS.test(LEDGER_EMPTY.count), `and the counter: ${LEDGER_EMPTY.count}`)
  assert.equal(LEDGER_EMPTY.tone, 'note', 'nothing is wrong, so nothing is painted as wrong')
  assert.equal(LEDGER_EMPTY.countsKnown, true, 'the totals for an empty list are known, and they are zero')

  assert.ok(FAILURE_WORDS.test(LEDGER_UNREADABLE.body), 'the unreadable state must say so')
  assert.ok(!EMPTY_WORDS.test(LEDGER_UNREADABLE.body), 'and must not also claim there is simply nothing')
  assert.equal(LEDGER_UNREADABLE.tone, 'refused')
  assert.equal(LEDGER_UNREADABLE.countsKnown, false, 'a read that failed knows no totals')
})

test('the loading state is neither of the other two', () => {
  assert.ok(!FAILURE_WORDS.test(LEDGER_LOADING.body), `a read in flight is not a failure: ${LEDGER_LOADING.body}`)
  assert.ok(!FAILURE_WORDS.test(LEDGER_LOADING.label), LEDGER_LOADING.label)
  assert.equal(LEDGER_LOADING.tone, 'note')
  assert.equal(LEDGER_LOADING.door, false, 'a “what this copy needs” link under a spinner sends somebody to solve a problem they may not have')
})

test('every notice answers with a whole set, so nothing can be drawn from a different state', () => {
  const keys = ['state', 'tone', 'label', 'className', 'body', 'count', 'countsKnown', 'door']
  for (const notice of [LEDGER_LOADING, LEDGER_EMPTY, LEDGER_UNREADABLE, QUESTIONS_EMPTY, QUESTIONS_UNREADABLE]) {
    for (const key of keys) {
      assert.ok(Object.hasOwn(notice, key), `${notice.state} has no ${key}`)
    }
    assert.ok(Object.isFrozen(notice), `${notice.state} is not frozen`)
  }
})

test('the questions half speaks the same two states, not a third vocabulary of its own', () => {
  assert.equal(registerNotice({ kind: 'empty' }, { mode: 'q' }), QUESTIONS_EMPTY)
  assert.equal(registerNotice({ kind: 'unreadable' }, { mode: 'q' }), QUESTIONS_UNREADABLE)
  assert.ok(!FAILURE_WORDS.test(QUESTIONS_EMPTY.body), QUESTIONS_EMPTY.body)
  assert.ok(FAILURE_WORDS.test(QUESTIONS_UNREADABLE.body), QUESTIONS_UNREADABLE.body)
})

test('no notice, label or hint sends the reader to a list', () => {
  const pointsAtAList = /\b(as shown in the (list|table|register)|in the list above|from the list)\b/i
  const strings = [
    ...[LEDGER_LOADING, LEDGER_EMPTY, LEDGER_UNREADABLE, QUESTIONS_EMPTY, QUESTIONS_UNREADABLE]
      .flatMap(notice => [notice.body, notice.label, notice.count]),
    ...Object.values(DECISION_FORM),
    ...Object.values(QUEUE_FORM),
    ...Object.values(DECISION_OFF).map(entry => entry.text),
  ]
  for (const value of strings) {
    assert.ok(!pointsAtAList.test(String(value)), `still points at a list: ${value}`)
  }
})

test('the Approve/Decline form is off for a reason, and the reason names the state', () => {
  assert.equal(decisionOff({ kind: 'loading', items: [] }), DECISION_OFF.loading)
  assert.equal(decisionOff({ kind: 'empty', items: [] }), DECISION_OFF.empty)
  assert.equal(decisionOff({ kind: 'unreadable', items: [] }), DECISION_OFF.unreadable)
  assert.equal(decisionOff({ kind: 'live', items: [] }), DECISION_OFF.empty, 'a live read with no rows is empty, not broken')
  assert.equal(decisionOff({ kind: 'live', items: [{ id: 'R1' }] }), null, 'with rows it simply works')
  /* The example register never turns the control off: the picker fills from
     the example rows so a person can see what this surface does. What keeps a
     press from becoming a write is the view's own fence (src/views/ledger.js
     stops it before the surface's handler runs), not a disabled control --
     so the OFF table must stay out of the way in both example states. */
  assert.equal(decisionOff({ kind: 'simulated', items: [] }), null,
    'the example register does not turn the control off')
  assert.equal(decisionOff({ kind: 'simulated', items: [{ id: 'R1' }] }), null,
    'and stays out of the way with the example rows in the picker')

  /* THE COLOUR COMES WITH THE SENTENCE. "There is nothing to approve" is not a
     failure, and painting it as one is the register's own defect one level
     down: words that say nothing is here inside chrome that says something went
     wrong. Only the unreadable case has earned the failure colour. */
  assert.equal(DECISION_OFF.empty.tone, 'note')
  assert.equal(DECISION_OFF.loading.tone, 'note')
  assert.equal(DECISION_OFF.unreadable.tone, 'unavailable')
  for (const entry of Object.values(DECISION_OFF)) {
    assert.ok(entry.text.length >= 40, `too short to act on: ${entry.text}`)
    assert.match(entry.text, /[.!?]$/, `not a sentence: ${entry.text}`)
  }
})

test('the queue line says what is off and what to do, and carries the layer’s own words when there are any', () => {
  const ready = queueSnapshotLine({ ok: true, hash: 'a'.repeat(64) })
  assert.equal(ready.ready, true)
  assert.equal(ready.tone, 'ready')
  assert.ok(!FAILURE_WORDS.test(ready.text), ready.text)

  const refused = queueSnapshotLine({ ok: false, reason: 'That folder has no work list to read' })
  assert.equal(refused.ready, false)
  assert.match(refused.text, /Claim and Close are off/)
  assert.match(refused.text, /That folder has no work list to read\./, 'the layer’s own reason is shown, and punctuated')
  assert.match(refused.text, /Choose another folder, or press Retry above\./, 'and there is always something to do')

  /* THE SIX WORDS THAT USED TO BE HERE, EVERY TIME. Before the engine's
     typedError() kept the real message, this line ended in "The audited
     dependency refused the action." whatever had actually happened. A reason
     that is not English is dropped rather than pasted in. */
  const noReason = queueSnapshotLine({ ok: false })
  assert.match(noReason.text, /Claim and Close are off/)
  assert.match(noReason.text, /Choose another folder, or press Retry above\./)
  assert.ok(!/undefined|null/.test(noReason.text), noReason.text)
  const codeReason = queueSnapshotLine({ ok: false, reason: 'BRIDGE_GUARD_REFUSED' })
  assert.ok(!/BRIDGE_GUARD_REFUSED/.test(codeReason.text), `an identifier reached the glass: ${codeReason.text}`)

  /* A hash that is not a hash is not a read list. */
  assert.equal(queueSnapshotLine({ ok: true, hash: 'short' }).ready, false)
  assert.equal(queueSnapshotLine(undefined).ready, false)
})

test('the view and the surface read their words from here rather than keeping their own', () => {
  const view = read('src/views/ledger.js')
  const surface = read('src/write-surfaces.js')
  assert.match(view, /from '\.\.\/ledger-copy\.js'/, 'the view must import the copy module')
  assert.match(surface, /from '\.\/ledger-copy\.js'/, 'so must the write surface')
  /* The two modules the person's hand goes through, and the feed. */
  assert.match(view, /from '\.\.\/ledger-live\.js'/, 'the view must read the register through the live feed')
  assert.doesNotMatch(view, /from '\.\.\/live-status\.js'/, 'the R rows no longer come from the build-time report')
  assert.match(view, /from '\.\.\/ledger-row-actions\.js'/, 'the row controls live in their own module')
  assert.match(view, /from '\.\.\/ledger-file-box\.js'/, 'so does the file box')
  for (const file of ['src/ledger-row-actions.js', 'src/ledger-file-box.js']) {
    assert.match(read(file), /from '\.\/ledger-copy\.js'/, `${file} must read its words from the copy module`)
  }
  assert.doesNotMatch(view, /const EXAMPLE_WRITE_NOTE =/, 'the example note is shared copy now, not the view\'s own')
  /* The two sentences the owner was shown, gone from the source that drew them.
     Asserted against the FILES because a constant can be replaced while the
     view goes on composing its own string beside it -- which is exactly how the
     half-applied repair happened. */
  const spoken = source => visibleTextFrom(source).visible.map(entry => entry.text).join(' | ')
  const viewSays = spoken(view)
  const surfaceSays = spoken(surface)
  assert.ok(!viewSays.includes('the ledger could not be read yet'), 'the old loading line is still drawn by the view')
  assert.ok(!viewSays.includes('the questions could not be read'), 'the questions half still has its own accent')
  assert.ok(!surfaceSays.includes('its number, as shown in the list'), 'the old placeholder is still drawn by the surface')
  assert.ok(!surfaceSays.includes('Observed queue SHA-256'), 'the hash field is still asking a person to read a hash')
})

/* THE × ON A ROW HIDES IT ON THIS SCREEN, AND EVERY WORD AROUND IT SAYS SO.
   Plan O6 measured the three lists for an honest "delete" and found none (an
   append-only overlay; a planning file with no writer), so the control's copy
   must never promise more than a hide and must never be painted as a failure
   -- the :214-219 rule one level down. */
test('the hide-row copy is exported, says it is a hide on this screen only, and is never a failure', () => {
  assert.ok(HIDE_ROW && Object.isFrozen(HIDE_ROW), 'HIDE_ROW must be exported and frozen')
  assert.equal(HIDE_ROW.tone, 'note', 'a row a person hid is not a failure')
  const spoken = [
    HIDE_ROW.aria('R3'), HIDE_ROW.title, HIDE_ROW.putBack('R3'), HIDE_ROW.putBackTitle,
    HIDE_ROW.armed('R3'), HIDE_ROW.hiddenR('R3'), HIDE_ROW.hiddenQ('Q7'), HIDE_ROW.restored('R3'),
    HIDE_ROW.count(2), HIDE_ROW.show, HIDE_ROW.hideAgain, HIDE_ROW.undo,
  ]
  for (const sentence of spoken) {
    assert.equal(typeof sentence, 'string')
    assert.ok(sentence.length > 0)
    assert.ok(!FAILURE_WORDS.test(sentence), `reads as a failure: ${sentence}`)
    assert.ok(!/\b(delete|deleted|removed|remove)\b/i.test(sentence), `promises a delete it cannot keep: ${sentence}`)
  }
  assert.equal(HIDE_ROW.aria('R3'), 'Hide R3 from this list')
  assert.match(HIDE_ROW.armed('R3'), /^Hide R3\? Press × again\./, 'the first press must name the second')
  assert.match(HIDE_ROW.armed('R3'), /hidden on this screen only; nothing else changes/)
  assert.match(HIDE_ROW.hiddenR('R3'), /^R3 hidden\./)
  assert.match(HIDE_ROW.hiddenR('R3'), /still in your records/, 'an R row is still in the records')
  assert.match(HIDE_ROW.hiddenQ('Q7'), /still in the work list/, 'a Q row is still in the work list')
  assert.equal(HIDE_ROW.count(2), '2 hidden')
})

/* THE ANCHORS BELOW USED TO POINT AT THE SIMULATED RENDER, which is gone: one
   render path, fed by a fetched register or by src/sample-ledger.js, per the
   owner's ruling that the simulated pages ARE the UI pages with mock data.
   What this suite can hold without a browser is the wiring: the view draws
   its data through the source axis, its example marking follows the axis's
   one badge rule, and nothing leans on the modules being deleted. */
test('the view draws through the source axis, and its example marking follows the one badge rule', () => {
  const view = read('src/views/ledger.js')
  assert.match(view, /from '\.\.\/data-source\.js'/, 'the view must resolve where its data comes from')
  assert.match(view, /resolveDataSource\(/, 'and actually ask, in its load path')
  assert.match(view, /DATA_SOURCE_EVENT/, 'and re-resolve when the host announces the world changed')
  assert.match(view, /from '\.\.\/sample-ledger\.js'/, 'the example register feeds the same render path')
  assert.match(view, /sourceIsBadged/,
    'the badge is keyed to the axis in one place; a view deriving its own is how a screen disagrees with its neighbour')
  assert.doesNotMatch(view, /live-flags/, 'the per-view flag is being deleted; nothing here may lean on it')
  assert.doesNotMatch(view, /ledger-data/, 'so is the simulated data module')
  /* The marking a person actually sees, in home’s exact words -- the one
     phrasing the product uses for data that is not theirs. */
  assert.match(view, /Example, not your data/, 'the example register must be unmistakably labelled')
})

/* THE LIVE REGISTER'S COPY (2026-09-02): the reach filter, the reach chip, the
   row controls, Delete and Decline armed sentences, the proposed-row note, the
   removed toggle, the history note and the file box. Every object is frozen,
   nothing that is not a failure wears a failure word, no sentence sends the
   reader to a list, and every sentence is short enough to read once. */
const SHORT_ENOUGH = sentence => sentence.split(/\s+/).filter(Boolean).length <= 25
/* A sentence function takes an id, or -- CHAIN_NOTE.drift -- a list of them. */
const spokenOf = value => {
  if (typeof value !== 'function') return value
  try { return value('R3') } catch { return value(['R3']) }
}
const sentencesOf = object => Object.values(object).flatMap(value =>
  (value && typeof value === 'object' ? Object.values(value) : [value]).map(spokenOf).filter(entry => typeof entry === 'string'))

test('the live-register copy is frozen, plain, and never paints a person\'s own act as a failure', () => {
  for (const [name, object] of Object.entries({ SCOPE_FILTER, SCOPE_CHIP, ROW_ACTIONS, DELETE_ROW, DECIDE_ROW, PROPOSED_NOTE, SUPERSEDED_NOTE, RESOLVE_ROW, RESOLVE_NOTE, REMOVED_TOGGLE, CHAIN_NOTE, FILE_BOX, EMPTY_LIST })) {
    assert.ok(Object.isFrozen(object), `${name} is not frozen`)
    for (const sentence of sentencesOf(object)) {
      assert.ok(sentence.length > 0, `${name} carries an empty string`)
      assert.ok(!/[A-Z]{2,}_[A-Z]/.test(sentence), `${name} carries a code: ${sentence}`)
      for (const piece of sentence.split(/(?<=[.!?…])\s+/)) assert.ok(SHORT_ENOUGH(piece), `${name}: too long to read once: ${piece}`)
      assert.ok(!/\b(as shown in the (list|table|register)|in the list above|from the list)\b/i.test(sentence), `${name} points at a list: ${sentence}`)
    }
  }
  /* A row the person is deleting, declining or filing is not a failure. */
  assert.equal(DELETE_ROW.tone, 'note')
  assert.equal(DECIDE_ROW.tone, 'note')
  assert.equal(PROPOSED_NOTE.tone, 'note')
  assert.equal(SUPERSEDED_NOTE.tone, 'note')
  assert.equal(RESOLVE_NOTE.tone, 'note')
  for (const sentence of [DELETE_ROW.armed('R3'), DECIDE_ROW.declineArmed('R3'), PROPOSED_NOTE.text('codex'), SUPERSEDED_NOTE.text('T9'), RESOLVE_NOTE.text('R3'), REMOVED_TOGGLE.show, REMOVED_TOGGLE.hide, REMOVED_TOGGLE.count(2), ...Object.values(SCOPE_FILTER), ...Object.values(SCOPE_CHIP), FILE_BOX.title, FILE_BOX.wordsHint, ...Object.values(FILE_BOX.reach), EMPTY_LIST.r, EMPTY_LIST.q]) {
    assert.ok(!FAILURE_WORDS.test(sentence), `reads as a failure: ${sentence}`)
  }
  /* The armed sentences name the second press and say what really happens:
     kept as deleted, agents stop reading it; a reason kept with a decision. */
  assert.match(DELETE_ROW.armed('R3'), /^Delete R3\? Press Delete again\./)
  assert.match(DELETE_ROW.armed('R3'), /stays in your records as deleted/)
  assert.match(DELETE_ROW.armed('R3'), /agents stop reading it at their next start/)
  assert.doesNotMatch(DELETE_ROW.armed('R3'), /hidden on this screen/, 'a delete must not borrow the ×\'s sentence')
  assert.match(DECIDE_ROW.declineArmed('R3'), /^Decline R3\? Press Decline again\./)
  assert.match(DECIDE_ROW.gone('R3'), /^R3 is not waiting for a decision any more/)
  assert.match(PROPOSED_NOTE.text('codex'), /^Your agent codex filed this from your words\./)
  assert.match(SUPERSEDED_NOTE.text('T9'), /^Superseded by T9\.$/)
  assert.match(RESOLVE_NOTE.text('R3'), /^Resolve R3 to move it off the open list without deleting it\./)
  assert.match(RESOLVE_ROW.gone('R3'), /^R3 is not standing any more, so nothing was changed\.$/,
    'the same shape of surprise as DECIDE_ROW.gone, said in Resolve\'s own words')
  /* Every failure sentence says what to do next. */
  for (const sentence of [DELETE_ROW.failed, DECIDE_ROW.failed, RESOLVE_ROW.failed, FILE_BOX.failed, FILE_BOX.empty, FILE_BOX.noTarget, CHAIN_NOTE.broken, CHAIN_NOTE.drift(['R3'])]) {
    assert.match(sentence, /\b(try|type|pick|check|file|start|add)\b/i, `no next step: ${sentence}`)
  }
  assert.match(CHAIN_NOTE.drift(['R3', 'R4']), /^R3, R4 do not match the available history/)
  /* The example note is one sentence set, shared by the fence, the row
     controls and the file box. */
  assert.match(EXAMPLE_WRITE_NOTE, /^Nothing was sent\./)
  assert.match(EXAMPLE_WRITE_NOTE, /example records, not yours/)
  /* The reach filter's five choices and the chip's four words. */
  assert.deepEqual(Object.keys(SCOPE_FILTER), ['label', 'all', 'global', 'tree', 'session', 'thread'])
  assert.deepEqual(Object.keys(SCOPE_CHIP), ['global', 'tree', 'session', 'thread'])
  assert.deepEqual(Object.keys(FILE_BOX.reach), ['global', 'session', 'tree', 'thread'])
  assert.deepEqual(Object.keys(FILE_BOX.nothingToPick), ['tree', 'thread', 'session'])
  /* The list sentence for a narrowed-to-nothing register is an answer, not a
     failure, and names the door. */
  assert.ok(EMPTY_WORDS.test(EMPTY_LIST.r) || /no requests/.test(EMPTY_LIST.r))
  assert.match(EMPTY_LIST.r, /File one above/)
})

/* THE SIX RESOLUTION STATUSES, IN THE STORE'S OWN ORDER (owner's Resolve
   action, 2026-09-07). Worker's engine export names them
   in-progress, partial, blocked-external, done, not-possible-as-asked,
   superseded; this is that same order, in the register's own words, for
   the picker the Resolve control opens. */
test('RESOLVE_STATUSES names the store\'s own six statuses, in order, each with a plain label', () => {
  assert.ok(Object.isFrozen(RESOLVE_STATUSES), 'RESOLVE_STATUSES must be frozen')
  assert.deepEqual(RESOLVE_STATUSES.map(entry => entry.value),
    ['in-progress', 'partial', 'blocked-external', 'done', 'not-possible-as-asked', 'superseded'])
  for (const entry of RESOLVE_STATUSES) {
    assert.ok(Object.isFrozen(entry), `${entry.value} is not frozen`)
    assert.equal(typeof entry.label, 'string')
    assert.ok(entry.label.length > 0, `${entry.value} has no label`)
    assert.ok(!FAILURE_WORDS.test(entry.label), `${entry.value} reads as a failure: ${entry.label}`)
    assert.ok(!/[A-Z]{2,}_[A-Z]/.test(entry.label), `${entry.value} carries a code: ${entry.label}`)
  }
})

/* DELETE SAYS WHAT IT REMOVES, FOR EACH KIND, AND WHAT HAPPENED AFTERWARDS.
   Only a rule is read to agents at their next start, so only a rule's
   sentence may promise that; a rule's live refinements go with it and are
   named before the second press; and after a Delete or a Decline the page
   says which ids went and where they are kept (T1286, T1347, T1524). */
test('Delete and Decline words are true for each kind and say where the rows went', () => {
  assert.equal(SCOPE_FILTER.label, 'Who it is for', 'the reach filter narrows tasks and asks too, so it cannot be named "Which rules"')
  for (const id of ['T4', 'A6']) {
    assert.match(DELETE_ROW.armed(id), new RegExp(`^Delete ${id}\\? Press Delete again\\. It stays in your records as deleted`))
    assert.doesNotMatch(DELETE_ROW.armed(id), /agents stop reading/, `${id} is not read to agents, so deleting it cannot stop that`)
  }
  assert.equal(DELETE_ROW.failedFor('T4'), 'That task was not deleted. Try once more.')
  assert.equal(DELETE_ROW.failedFor('A6'), 'That ask was not deleted. Try once more.')
  assert.equal(DELETE_ROW.failedFor('R3'), DELETE_ROW.failed)
  assert.equal(DELETE_ROW.armed('R3', []), DELETE_ROW.armed('R3'), 'a rule with no refinements keeps its sentence')
  assert.equal(DELETE_ROW.armed('R202', ['R202.1', 'R202.2']),
    'Delete R202 and its 2 refinements, R202.1 and R202.2? Press Delete again. They stay in your records as deleted, and agents stop reading them at their next start.')
  assert.equal(DELETE_ROW.armed('R202', ['R202.1']),
    'Delete R202 and its refinement, R202.1? Press Delete again. They stay in your records as deleted, and agents stop reading them at their next start.')
  assert.equal(DELETE_ROW.deleted(['T4']), 'T4 deleted. It is kept in your records as deleted; Show removed lists it.')
  assert.equal(DELETE_ROW.deleted(['R202', 'R202.1', 'R202.2']), 'R202, R202.1 and R202.2 deleted. They are kept in your records as deleted; Show removed lists them.')
  assert.equal(DECIDE_ROW.declined('A5'), 'A5 declined. It is kept in your records as declined; Show removed lists it.')
  for (const sentence of [DELETE_ROW.armed('T4'), DELETE_ROW.armed('R202', ['R202.1', 'R202.2']), DELETE_ROW.deleted(['R202', 'R202.1', 'R202.2']), DECIDE_ROW.declined('A5')]) {
    assert.ok(!FAILURE_WORDS.test(sentence), `reads as a failure: ${sentence}`)
    for (const piece of sentence.split(/(?<=[.!?…])\s+/)) assert.ok(SHORT_ENOUGH(piece), `too long to read once: ${piece}`)
  }
})

/* REFUSALS NO RETRY CAN FIX ARE NEVER "TRY ONCE MORE" (T1296, T1418, T1273,
   T1539). The history that needs review names the control that reviews it;
   text over the store's limit says the limit; a task that is not open and an
   ask that is not waiting say so. */
test('refusals no retry can fix say what they are, in both code families', () => {
  for (const code of ['AGENT_REQUEST_CHAIN_APPEND_UNCONFIRMED', 'R_LEDGER_CHAIN_APPEND_UNCONFIRMED']) {
    assert.equal(ledgerRefusalSentence(code), LEDGER_REFUSAL.historyUnconfirmed)
  }
  assert.match(LEDGER_REFUSAL.historyUnconfirmed, /Review unconfirmed history/, 'the only way out must be named')
  for (const code of ['AGENT_REQUEST_CHAIN_BROKEN', 'R_LEDGER_CHAIN_BROKEN']) assert.equal(ledgerRefusalSentence(code), LEDGER_REFUSAL.historyDamaged)
  assert.equal(ledgerRefusalSentence('R_LEDGER_WORDS_TOO_LONG'), LEDGER_REFUSAL.wordsTooLong)
  for (const code of ['R_LEDGER_REASON_INVALID', 'AGENT_REQUEST_REASON_INVALID']) assert.equal(ledgerRefusalSentence(code), LEDGER_REFUSAL.reasonTooLong)
  assert.equal(ledgerRefusalSentence('AGENT_REQUEST_REFUSED'), null)
  assert.equal(ledgerRefusalSentence(''), null)
  assert.match(LEDGER_REFUSAL.wordsTooLong, /16,384 bytes/)
  assert.match(LEDGER_REFUSAL.reasonTooLong, /2,048 bytes/)
  assert.deepEqual({ ...LEDGER_LIMITS }, { wordsBytes: 16384, reasonBytes: 2048 }, 'the limits must be the store\'s own')
  for (const sentence of [...Object.values(LEDGER_REFUSAL), COMPLETE_ROW.blocked('T3'), COMPLETE_ROW.gone('T3'), ANSWER_ROW.gone('A68')]) {
    assert.doesNotMatch(sentence, /try once more/i, `a retry cannot fix this: ${sentence}`)
    assert.ok(!/[A-Z]{2,}_[A-Z]/.test(sentence), `carries a code: ${sentence}`)
    for (const piece of sentence.split(/(?<=[.!?…])\s+/)) assert.ok(SHORT_ENOUGH(piece), `too long to read once: ${piece}`)
  }
  assert.match(ANSWER_ROW.gone('A68'), /^A68 is not waiting for an answer any more/)
  assert.match(ANSWER_ROW.gone('A68'), /still in the box/)
  assert.match(COMPLETE_ROW.blocked('T3'), /^T3 needs something from you before it can go on, so Complete is off\./)
})

/* WHERE THE BOX IS, WHERE THE EXAMPLE SWITCH IS (T1262, T1415). */
test('empty lists point where filing really is, and an example press on the desktop names the switch that ends it', () => {
  for (const sentence of [LEDGER_EMPTY.body, EMPTY_LIST.r, EMPTY_LIST.all]) assert.doesNotMatch(sentence, /\bbelow\b/, `points away from the box: ${sentence}`)
  assert.match(EMPTY_LIST.all, /^There are no records in this list\. Choose Rules or Tasks to file one/, 'the All tab has no box, so it names where one is')
  assert.match(EXAMPLE_WRITE_NOTE_CHOSEN, /^Nothing was sent\./)
  assert.match(EXAMPLE_WRITE_NOTE_CHOSEN, /Turn off “Show the example fleet” in Settings, under What the screens show/)
  assert.doesNotMatch(EXAMPLE_WRITE_NOTE_CHOSEN, /Connect your own computers/, 'this computer is already connected')
  for (const sentence of [EMPTY_LIST.all, EXAMPLE_WRITE_NOTE_CHOSEN]) {
    for (const piece of sentence.split(/(?<=[.!?…])\s+/)) assert.ok(SHORT_ENOUGH(piece), `too long to read once: ${piece}`)
  }
})

/* A DAMAGED FILE GETS THE REPAIR THAT WORKS (T1382). */
test('a damaged Ledger file names the backup that repairs it, and never says to restart or retry', () => {
  const withBackup = registerNotice({ kind: 'damaged', backup: true })
  const without = registerNotice({ kind: 'damaged', backup: false })
  assert.equal(withBackup.state, 'damaged')
  assert.match(withBackup.body, /OWNER-REQUEST-LEDGER\.json/)
  assert.match(withBackup.body, /\.bak/)
  assert.match(without.body, /from a backup of this computer/)
  assert.doesNotMatch(without.body, /\.bak/, 'a backup that is not there is not named')
  for (const sentence of [withBackup.body, without.body, FILE_BOX_OFF.damaged, FILE_BOX_OFF.unreadable]) {
    assert.doesNotMatch(sentence, /Close ToolsEnabled and open it again|try once more|needs attention/i, sentence)
    for (const piece of sentence.split(/(?<=[.!?…])\s+/)) assert.ok(SHORT_ENOUGH(piece), `too long to read once: ${piece}`)
  }
  assert.equal(withBackup.door, false, 'the Settings link about installed programs does not repair a Ledger file')
  assert.equal(withBackup.countsKnown, false)
  assert.equal(registerNotice({ kind: 'damaged', backup: true }, { mode: 't' }).state, 'damaged', 'the other tabs say the same')
})

/* NO ADVICE THAT CANNOT BE FOLLOWED (T1472): with one folder there is none
   other to choose, and the queue form has no Retry of its own. */
test('the queue line only points at another folder when there is one, and never at a Retry that is not there', () => {
  const one = queueSnapshotLine({ ok: false, reason: 'The root queue could not be read' }, { folders: 1 })
  assert.doesNotMatch(one.text, /Choose another folder|press Retry/)
  assert.match(one.text, /There is no other folder to choose, so this computer may have no queued work\.$/)
  const many = queueSnapshotLine({ ok: false, reason: 'The root queue could not be read' }, { folders: 3 })
  assert.match(many.text, /Choose another folder\.$/)
  assert.doesNotMatch(many.text, /Retry/)
  for (const sentence of [one.text, many.text]) for (const piece of sentence.split(/(?<=[.!?…])\s+/)) assert.ok(SHORT_ENOUGH(piece), piece)
})
