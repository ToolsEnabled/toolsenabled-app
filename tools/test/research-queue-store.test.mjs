import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OWN_PROVENANCE,
  advanceItem,
  buildOwnItem,
  mergeQueueForRender,
  nextStatus,
  parseQueueRow,
  removeOwnItem,
  serializeQueueRow,
} from '../../src/research-queue-store.js'

const NOTE = Object.freeze({
  title: '  Checkpoint tokenizer drift  ',
  observation: '  Two checkpoints split the same sample differently.  ',
  researchQuestion: '  Does that difference change the reported score?  ',
})

const EMPTY = Object.freeze({ items: [], statusOverrides: {}, damaged: false })

test('stored-row uncertainty remains visible while valid caller data is recovered safely', () => {
  assert.equal(parseQueueRow('{not JSON').damaged, true,
    'an unreadable settings row must remain distinguishable from a definitely empty queue')
  assert.equal(parseQueueRow(null).damaged, false,
    'a missing settings row is a fresh queue, not evidence of damaged data')

  const parsed = parseQueueRow(JSON.stringify({
    v: 1,
    items: [
      { id: 'own-good', title: 'Good', status: 'queued', observation: 'Observed', researchQuestion: 'Why?' },
      { id: 'own-bad', title: 'Bad', status: 'invented', observation: 'Observed', researchQuestion: 'Why?' },
    ],
    statusOverrides: { shipped: 'complete', bad: 'invented' },
  }))
  assert.deepEqual(parsed.items.map(item => item.id), ['own-good'],
    'a damaged item must not prevent the usable notes in the row from loading')
  assert.deepEqual(parsed.statusOverrides, { shipped: 'complete' },
    'only lifecycle statuses that the UI can render may be restored')
})

test('a real form submission is normalized, bounded, and produces a persistable own note', () => {
  const built = buildOwnItem(NOTE, EMPTY)
  assert.equal(built.ok, true, 'a complete note from the research form must be accepted')
  assert.equal(built.item.title, 'Checkpoint tokenizer drift',
    'form whitespace must not become part of the saved title')
  assert.equal(built.item.status, 'queued', 'a newly written note must enter the queue')
  assert.equal(built.item.provenance, OWN_PROVENANCE, 'a written note must retain its removable ownership marker')
  assert.match(built.item.id, /^own-\S+$/, 'a written note must receive an own-note identifier')
  assert.deepEqual(parseQueueRow(built.serialized).items, [built.item],
    'the value sent to account settings must restore the note that was built')

  const refused = buildOwnItem({ ...NOTE, researchQuestion: ' '.repeat(4) }, EMPTY)
  assert.equal(refused.ok, false, 'a blank required research question must not create a note')
  assert.match(refused.sentence, /research question/i,
    'the refusal must tell the researcher which required field needs action')
  assert.match(refused.sentence, /up to\s+1000\s+characters/i,
    'the refusal must give the actionable research-question limit')
})

test('serialization preserves the settings-store absence convention', () => {
  assert.equal(serializeQueueRow({ items: [], statusOverrides: {} }), null,
    'an empty queue must remove the bounded settings row rather than save empty JSON')
})

test('the caller-visible lifecycle advances without mutating its prior state', () => {
  assert.deepEqual(['queued', 'in-progress', 'complete'].map(nextStatus), ['in-progress', 'complete', null],
    'the three UI lifecycle states must advance in order and stop at completion')

  const own = { id: 'own-1', title: 'T', status: 'queued', observation: 'O', researchQuestion: 'Q' }
  const state = { items: [own], statusOverrides: { earlier: 'complete' } }
  const advancedOwn = advanceItem(state, { id: own.id, own: true, currentStatus: own.status })
  assert.equal(advancedOwn.next.items[0].status, 'in-progress',
    'advancing an own note must update that note to the next visible status')
  assert.equal(state.items[0].status, 'queued', 'advancing must not mutate the state currently being rendered')

  const advancedAuthored = advanceItem(state, { id: 'shipped-1', own: false, currentStatus: 'in-progress' })
  assert.deepEqual(advancedAuthored.next.statusOverrides, { earlier: 'complete', 'shipped-1': 'complete' },
    'advancing shipped research must preserve existing overrides and save the new one')

  const refused = advanceItem(state, { id: own.id, own: true, currentStatus: 'complete' })
  assert.equal(refused.ok, false, 'a complete item must not wrap around to another status')
  assert.match(refused.sentence, /already\s+complete/i,
    'the terminal-state refusal must explain why no advance occurred')
})

test('render merging applies overrides and exposes ownership without changing catalog records', () => {
  const authored = [{ id: 'shipped-1', title: 'Catalog', status: 'queued' }]
  const own = [{ id: 'own-1', title: 'Mine', status: 'queued' }]
  const merged = mergeQueueForRender(authored, { items: own, statusOverrides: { 'shipped-1': 'complete' } })
  assert.deepEqual(merged.map(item => item.id), ['own-1', 'shipped-1'],
    'the bench must render personal notes before the shipped catalog')
  assert.equal(merged[0].own, true, 'personal notes must be marked for the caller ownership controls')
  assert.equal(merged[1].status, 'complete', 'a saved shipped-item status must win when the queue renders')
  assert.deepEqual(authored, [{ id: 'shipped-1', title: 'Catalog', status: 'queued' }],
    'render merging must not rewrite the authored catalog object')
})

test('removal deletes only a matching own note and leaves an actionable refusal otherwise', () => {
  const state = {
    items: [{ id: 'own-1', title: 'Mine', status: 'queued', observation: 'O', researchQuestion: 'Q' }],
    statusOverrides: { shipped: 'in-progress' },
  }
  const removed = removeOwnItem(state, 'own-1')
  assert.equal(removed.ok, true, 'a matching own note must be removable')
  assert.deepEqual(removed.next.statusOverrides, state.statusOverrides,
    'removing a note must retain the shipped-item lifecycle choices')

  const refused = removeOwnItem(state, 'shipped')
  assert.equal(refused.ok, false, 'an authored or unknown identifier must not delete a personal note')
  assert.match(refused.sentence, /not yours to remove/i,
    'the removal refusal must explain the ownership boundary')
  assert.match(refused.sentence, /shipped items stay/i,
    'the removal refusal must explain what happens to catalog research')
})
