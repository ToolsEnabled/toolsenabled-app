/* ONE DRAFT STORE, TWO ACCESSOR PAIRS, ONE MAP -- THEY MUST AGREE.
 *
 * createComposerDraftStore (src/home-chat-composer-draft.js) exposes two pairs
 * over the SAME Map, keyed by the same subject id:
 *   readDraft/writeDraft -- the rich record { text, attachments, start, end },
 *     which is exactly what buildChat exportDraft() hands back.
 *   read/write           -- text only, for a plain composer input.
 *
 * BOTH ARE REACHABLE ON ONE SHARED INSTANCE, which is why their disagreement
 * matters rather than being a curiosity. src/views/home.js:597 creates ONE
 * store, takeoverDrafts, and passes it at :763 as draftStore into the same
 * mountChatTakeover call that gets renderAgent mountHomeAgentWorkspace at :754.
 *   src/home-chat-takeover.js:297-298 saves through writeDraft when the mounted
 *     surface is a buildChat composer, and FALLS BACK to
 *     drafts.write(current.id, composerInput.value) when it is not.
 *   src/home-chat-takeover.js:390-391 restores the same way round.
 *   src/home-agent-workspace.js:19-20 hands computersView a chatDraft whose
 *     read/write are readDraft/writeDraft on that same store.
 *
 * So one subject id can be written through the rich pair and then through the
 * text-only pair. write REPLACES the whole record, so the attachments and caret
 * go with it, and write(id, empty) DELETES a record writeDraft deliberately
 * keeps when attachments remain. The owner complaint this sits under is
 * "theres occassionally really annoying UI redraws and they erase my typing" --
 * an attachment silently dropped by a redraw is that complaint one layer down.
 *
 * The rule pinned here: text-only write may only ever change the TEXT.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { createComposerDraftStore } = await import('../../src/home-chat-composer-draft.js')

test('text-only write keeps the attachments and caret the rich pair is holding', () => {
  const store = createComposerDraftStore()
  store.writeDraft('subject-1', { text: 'hello', attachments: [{ name: 'diagram.png' }], start: 2, end: 4 })

  store.write('subject-1', 'hello there')

  const held = store.readDraft('subject-1')
  assert.ok(held, 'the draft must still exist after a text-only write')
  assert.equal(held.text, 'hello there', 'the text-only write owns the text')
  assert.deepEqual(held.attachments, [{ name: 'diagram.png' }],
    'a text-only write must not discard the attachment the person added')
  assert.equal(held.start, 2, 'a text-only write must not discard the selection start')
  assert.equal(held.end, 4, 'a text-only write must not discard the selection end')
})

test('clearing the text keeps an attachment-only draft, the rule writeDraft already keeps', () => {
  const store = createComposerDraftStore()
  store.writeDraft('subject-2', { text: 'note', attachments: [{ name: 'log.txt' }] })

  store.write('subject-2', '')

  const held = store.readDraft('subject-2')
  assert.ok(held, 'an attachment-only draft must survive the text being cleared')
  assert.equal(held.text, '', 'the text really was cleared')
  assert.deepEqual(held.attachments, [{ name: 'log.txt' }], 'the attachment is still unsent work')
})

/* GUARDS -- these already hold today and must keep holding, so the fix cannot
   be bought by turning the store into a Map that only ever grows. */

test('a draft with no text and no attachments is dropped, not remembered as empty', () => {
  const store = createComposerDraftStore()
  store.write('subject-3', 'typing')
  store.write('subject-3', '')
  assert.equal(store.readDraft('subject-3'), null, 'nothing is held, so nothing is returned')
  assert.equal(store.read('subject-3'), '', 'and the text reader says so too')
})

test('read stays text-only and invents nothing for an unknown subject', () => {
  const store = createComposerDraftStore()
  store.writeDraft('subject-4', { text: 'words', attachments: [{ name: 'x.png' }] })
  assert.equal(store.read('subject-4'), 'words', 'read returns the text it holds')
  assert.equal(store.read('never-seen'), '', 'an unknown subject holds no text')
  assert.equal(store.readDraft('never-seen'), null, 'and no record')
  assert.equal(store.read(null), '', 'a non-string id is not a key')
})

test('readDraft hands back a copy, so a caller cannot mutate the held attachments', () => {
  const store = createComposerDraftStore()
  store.writeDraft('subject-5', { text: 'words', attachments: [{ name: 'x.png' }] })
  store.readDraft('subject-5').attachments.push({ name: 'smuggled.png' })
  assert.equal(store.readDraft('subject-5').attachments.length, 1, 'the store kept its own copy')
})
