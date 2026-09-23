/* The resume boundary chooses which conversation a person sees after returning
 * to a tree node. These are the three shapes the view passes: its saved rows
 * plus a restored engine thread, saved rows after restoration failed, or an
 * engine thread when this computer has no saved excerpt. */

import assert from 'node:assert/strict'
import test from 'node:test'

import { resumedTranscriptLines } from '../../src/tree-resume-transcript.js'

const saved = () => [
  { who: 'you', text: 'Inspect the release checklist.', at: 10 },
  { who: 'action', tool: 'Read', text: 'release.md', state: 'finished', at: 11 },
  { who: 'agent', text: 'Two checklist items remain.', at: 12 },
]

const restored = {
  turns: [{
    said: [
      { who: 'you', text: 'Engine projection of the request' },
      { who: 'agent', text: 'Engine projection of the answer' },
    ],
  }],
}

test('a restored thread keeps the product transcript, including actions and timestamps', () => {
  const before = saved()
  const lines = resumedTranscriptLines({
    engineResumed: restored,
    savedLines: before,
    marker: 'A fresh agent read the conversation above.',
    now: 99,
  })

  assert.deepEqual(lines, before,
    'a successful resume replaced the product transcript with the engine speech-only projection')
  assert.notStrictEqual(lines, before,
    'a successful resume returned the caller-owned array instead of a safe copy')
})

test('a failed restore retains the saved conversation and explains that a fresh agent read it', () => {
  const before = saved()
  const marker = 'A fresh agent read the conversation above.'
  const lines = resumedTranscriptLines({ engineResumed: null, savedLines: before, marker, now: 99 })

  assert.deepEqual(lines.slice(0, -1), before,
    'a could-not-restore result discarded or rewrote the conversation the fresh agent was given')
  const notice = lines.at(-1)
  assert.equal(notice?.who, 'you',
    'the fresh-agent explanation is not presented as conversation context')
  assert.equal(notice?.at, 99,
    'the fresh-agent explanation lost the resume timestamp supplied by the caller')
  assert.match(notice?.text || '', /fresh agent/i,
    'the fallback does not explain that this is a fresh agent')
  assert.match(notice?.text || '', /read/i,
    'the fallback does not explain what the fresh agent did with the prior conversation')
})

test('without a saved excerpt, a restored thread exposes all readable speech in order', () => {
  const engineResumed = {
    turns: [
      { said: [{ who: 'you', text: 'First question' }, { who: 'agent', text: 'First answer' }] },
      null,
      { otherPayload: 'not readable as speech' },
      { said: [{ who: 'you', text: 'Follow-up' }] },
    ],
  }
  const lines = resumedTranscriptLines({ engineResumed, savedLines: [] })

  assert.deepEqual(lines, [
    { who: 'you', text: 'First question', at: null },
    { who: 'agent', text: 'First answer', at: null },
    { who: 'you', text: 'Follow-up', at: null },
  ], 'a thread with no local excerpt did not preserve every readable engine line in order')
})

test('an unreadable engine result does not manufacture a definite conversation', () => {
  for (const engineResumed of [null, {}, { turns: null }, { turns: [{ said: null }] }]) {
    assert.deepEqual(resumedTranscriptLines({ engineResumed, savedLines: [] }), [],
      'a could-not-read engine result was collapsed into a conversation the caller never supplied')
  }
})
