import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  OWN_PROVENANCE,
  RESEARCH_QUEUE_ROW_KEY,
  advanceItem,
  buildOwnItem,
  mergeQueueForRender,
  nextStatus,
  parseQueueRow,
  removeOwnItem,
  serializeQueueRow,
} from '../../src/research-queue-store.js'

/* The writable half of the research queue: the researcher's own notes and
   the status overrides that finally give the shipped items a lifecycle. One
   bounded account row; every refusal a sentence. */

const EMPTY = Object.freeze({ items: [], statusOverrides: {}, damaged: false })

const NOTE = Object.freeze({
  title: 'Tokenizer drift between checkpoints',
  observation: 'Two checkpoints disagree on 3% of tokenizations.',
  researchQuestion: 'Does the drift move scores, or only token counts?',
})

test('a note is built with the shipped field caps, and refusals are sentences', () => {
  const built = buildOwnItem(NOTE, EMPTY)
  assert.equal(built.ok, true)
  assert.equal(built.item.status, 'queued')
  assert.equal(built.item.provenance, OWN_PROVENANCE)
  assert.ok(built.item.id.startsWith('own-'))
  for (const missing of ['title', 'observation', 'researchQuestion']) {
    const refused = buildOwnItem({ ...NOTE, [missing]: '   ' }, EMPTY)
    assert.equal(refused.ok, false)
    assert.match(refused.sentence, /Write/, `the ${missing} refusal lost its sentence`)
  }
  const over = buildOwnItem({ ...NOTE, title: 'x'.repeat(241) }, EMPTY)
  assert.equal(over.ok, false, 'a title past the shipped cap must refuse, not truncate')
})

test('the row round-trips, damage degrades stated, and absence serializes as null', () => {
  const built = buildOwnItem(NOTE, EMPTY)
  const parsed = parseQueueRow(built.serialized)
  assert.equal(parsed.items.length, 1)
  assert.equal(parsed.items[0].title, NOTE.title)
  assert.equal(parsed.damaged, false)
  assert.equal(parseQueueRow('not json').damaged, true, 'a broken row must say it is broken')
  assert.equal(parseQueueRow(null).damaged, false, 'absence is a fresh queue, not damage')
  assert.equal(serializeQueueRow({ items: [], statusOverrides: {} }), null,
    'an empty queue stores as row absence, the settings-store default idiom')
})

test('the lifecycle advances one step at a time and ends at complete', () => {
  assert.equal(nextStatus('queued'), 'in-progress')
  assert.equal(nextStatus('in-progress'), 'complete')
  assert.equal(nextStatus('complete'), null)
  const built = buildOwnItem(NOTE, EMPTY)
  const advanced = advanceItem(built.next, { id: built.item.id, own: true, currentStatus: 'queued' })
  assert.equal(advanced.ok, true)
  assert.equal(advanced.next.items[0].status, 'in-progress')
  const done = advanceItem(advanced.next, { id: built.item.id, own: true, currentStatus: 'complete' })
  assert.equal(done.ok, false)
  assert.match(done.sentence, /already complete/)
})

test('advancing a shipped item stores an override; the shipped item itself is never edited', () => {
  const advanced = advanceItem(EMPTY, { id: 'shipped-1', own: false, currentStatus: 'queued' })
  assert.equal(advanced.ok, true)
  assert.deepEqual(advanced.next.statusOverrides, { 'shipped-1': 'in-progress' })
  assert.equal(advanced.next.items.length, 0)
  const merged = mergeQueueForRender(
    [{ id: 'shipped-1', title: 'Shipped', status: 'queued', provenance: 'run-report', observation: 'o', researchQuestion: 'q' }],
    { ...EMPTY, statusOverrides: advanced.next.statusOverrides },
  )
  assert.equal(merged[0].status, 'in-progress', 'the override must win at render')
  assert.notEqual(merged[0].own, true, 'a shipped item must never read as removable')
})

test('only own notes can be removed, and the bench renders own notes first', () => {
  const built = buildOwnItem(NOTE, EMPTY)
  const removedShipped = removeOwnItem(built.next, 'shipped-1')
  assert.equal(removedShipped.ok, false)
  assert.match(removedShipped.sentence, /not yours to remove/)
  const removed = removeOwnItem(built.next, built.item.id)
  assert.equal(removed.ok, true)
  assert.equal(removed.serialized, null, 'removing the last note returns the row to absence')
  const merged = mergeQueueForRender(
    [{ id: 'shipped-1', title: 'Shipped', status: 'queued', provenance: 'run-report', observation: 'o', researchQuestion: 'q' }],
    built.next,
  )
  assert.equal(merged[0].own, true, 'your own notes lead the bench')
  assert.equal(merged[1].id, 'shipped-1')
})

test('the view wires the row the store names, and the two halves fail independently', () => {
  const ROOT = resolve(import.meta.dirname, '..', '..')
  const view = readFileSync(resolve(ROOT, 'src/views/research.js'), 'utf8')
  assert.match(view, /RESEARCH_QUEUE_ROW_KEY/, 'the view lost the settings row key')
  assert.equal(RESEARCH_QUEUE_ROW_KEY, 'research_queue')
  assert.match(view, /data-queue-form/, 'the add form is gone')
  assert.match(view, /data-queue-advance/, 'the status-advance control is gone')
  assert.match(view, /data-queue-remove/, 'the remove control is gone')
  assert.match(view, /Sign in to write notes here/, 'signed-out lost its stated sentence')
  assert.match(view, /New notes will overwrite the unreadable ones/, 'a damaged row lost its stated consequence')
  /* THE × ON EVERY QUEUE ITEM (plan P-O6): two presses, and the first says
     which of two things the second does -- your own note is deleted from your
     account's row, a shipped item is hidden on this screen only, through its
     own hidden set. */
  assert.match(view, /research-queue-x/, 'the × control is gone from the queue')
  assert.match(view, /mc\.research\.queue-hidden/, 'shipped items have nowhere to be hidden')
  assert.match(view, /Press × again/, 'the first press no longer says what the second does')
  assert.match(view, /deleted from your account's notes; the shipped queue is unchanged/, 'an own note must be told it is really deleted')
  assert.match(view, /hidden on this screen only — shipped items stay in the catalog/, 'a shipped item must be told it is only hidden')
})
