/* THE SAVE THAT DELETED SOMEBODY ELSE'S CONVERSATION, AND SAID IT WORKED.
 *
 * src/session-transcript-store.js declares two caps that were never reconciled:
 * `maxNodes: 24` -- how many circles keep a conversation -- and
 * `maxSerializedChars: 120_000` -- how big the whole saved blob may get. One
 * record at the store's OWN per-record bounds (40 lines of 600 characters)
 * serialises to 25,453 characters, so the size cap bound at FOUR records and
 * the record cap never bound at all.
 *
 * MEASURED against the code as it stood, saving eight full records in a row:
 *
 *     save n0 true   records now: 1
 *     save n1 true   records now: 2
 *     save n2 true   records now: 3
 *     save n3 true   records now: 4
 *     save n4 true   records now: 4      <- n0's whole conversation is gone
 *     save n5 true   records now: 4
 *     save n6 true   records now: 4
 *     save n7 true   records now: 4
 *
 * Every one of those saves returned `true`. Saving node 4's transcript
 * destroyed node 0's entire conversation, and nothing anywhere was told. On a
 * research machine a lost transcript is destroyed research data, so the rules
 * pinned below are: the two caps agree; degrading drops the OLDEST LINES and
 * keeps every conversation; a whole record goes only when there is nothing
 * left to trim; and a save that loses anything says so.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  TRANSCRIPT_LIMITS,
  createTranscriptStore,
  transcriptSeedText,
} from '../../src/session-transcript-store.js'

const COMPUTER = 'c1'

/* The same face safeTreeStorage presents, deep-copied both ways so a test
   cannot pass by mutating the store's own memory. */
function fakeSeam() {
  const held = new Map()
  return {
    read: key => (held.has(key) ? JSON.parse(JSON.stringify(held.get(key))) : null),
    write: (key, value) => { held.set(key, JSON.parse(JSON.stringify(value))); return true },
    held,
  }
}

const line = (who, text, at = 1000) => ({ who, text, at })

/* One record at exactly the per-record cap: the biggest thing the store's own
   line bounds admit. */
const fullLines = (fill = 'w') => Array.from(
  { length: TRANSCRIPT_LIMITS.maxLines },
  (_, i) => line(i % 2 ? 'you' : 'agent', fill.repeat(TRANSCRIPT_LIMITS.maxLineChars), 1000 + i),
)

test('every conversation the record cap admits survives the size cap', () => {
  /* NOT "24 full records fit": the envelope is the storage's own 64KB ceiling
     (shell/renderer-prefs.cjs MAX_VALUE_LENGTH, measured on a staged build),
     and 24 records at their per-record ceiling are far larger than that. What
     the two caps now agree about is the thing that matters -- every
     conversation the record cap admits is still THERE afterwards, shorter
     rather than deleted. */
  const seam = fakeSeam()
  const store = createTranscriptStore({ computerId: COMPUTER, storage: seam })
  for (let i = 0; i < TRANSCRIPT_LIMITS.maxNodes; i += 1) {
    assert.equal(store.save(`n${i}`, { lines: fullLines() }), true, `n${i} was refused`)
  }
  let kept = 0
  for (let i = 0; i < TRANSCRIPT_LIMITS.maxNodes; i += 1) if (store.has(`n${i}`)) kept += 1
  assert.equal(
    kept,
    TRANSCRIPT_LIMITS.maxNodes,
    'the size cap binds before the record cap, so the hidden bound decides how many conversations survive',
  )
})

test('a save never deletes another node whole conversation to make room for itself', () => {
  const store = createTranscriptStore({ computerId: COMPUTER, storage: fakeSeam() })
  for (let i = 0; i < 8; i += 1) assert.equal(store.save(`n${i}`, { lines: fullLines() }), true)
  const missing = []
  for (let i = 0; i < 8; i += 1) if (!store.has(`n${i}`)) missing.push(`n${i}`)
  assert.deepEqual(missing, [], `these conversations were destroyed by a different node save: ${missing.join(', ')}`)
})

test('when the size cap really binds, the OLDEST LINES go and every conversation stays', () => {
  /* JSON escaping is how the size cap is reached even after the two are
     reconciled: a line of 600 quote characters serialises to 1,200. So this is
     the real degrading path, driven rather than imagined. */
  const store = createTranscriptStore({ computerId: COMPUTER, storage: fakeSeam() })
  for (let i = 0; i < TRANSCRIPT_LIMITS.maxNodes; i += 1) {
    assert.equal(store.save(`n${i}`, { lines: fullLines('"') }), true, `n${i} was refused`)
  }
  let kept = 0
  let lines = 0
  for (let i = 0; i < TRANSCRIPT_LIMITS.maxNodes; i += 1) {
    const record = store.get(`n${i}`)
    if (!record) continue
    kept += 1
    lines += record.lines.length
  }
  assert.equal(kept, TRANSCRIPT_LIMITS.maxNodes, 'a whole conversation was deleted while other records still had lines to give up')
  assert.ok(lines < TRANSCRIPT_LIMITS.maxNodes * TRANSCRIPT_LIMITS.maxLines, 'nothing was trimmed, so the size cap was not really reached')
  /* The newest words are where the work stands, so those are the survivors. */
  const survivor = store.get('n0')
  assert.equal(
    survivor.lines[survivor.lines.length - 1].at,
    1000 + TRANSCRIPT_LIMITS.maxLines - 1,
    'the newest line was trimmed instead of the oldest',
  )
})

test('a save that loses anything says so; a save that loses nothing stays quiet', () => {
  const losses = []
  const store = createTranscriptStore({
    computerId: COMPUTER,
    storage: fakeSeam(),
    onLoss: report => losses.push(report),
  })
  assert.equal(store.save('n0', { lines: [line('you', 'hello')] }), true)
  assert.deepEqual(losses, [], 'an ordinary save reported a loss that did not happen')
  for (let i = 0; i < TRANSCRIPT_LIMITS.maxNodes; i += 1) store.save(`f${i}`, { lines: fullLines('"') })
  assert.ok(losses.length > 0, 'lines were dropped and nothing was told; that is silent data loss')
  assert.ok(losses.some(report => report.trimmedLines > 0), 'the report does not say how many lines went')
  assert.ok(losses.every(report => typeof report.nodeId === 'string'), 'the report does not name the save that caused it')
})

test('the record remembers that it was trimmed, so the screen can say so', () => {
  const store = createTranscriptStore({ computerId: COMPUTER, storage: fakeSeam() })
  for (let i = 0; i < TRANSCRIPT_LIMITS.maxNodes; i += 1) store.save(`n${i}`, { lines: fullLines('"') })
  const trimmed = []
  for (let i = 0; i < TRANSCRIPT_LIMITS.maxNodes; i += 1) {
    const record = store.get(`n${i}`)
    if (record && record.trimmed > 0) trimmed.push(`n${i}`)
  }
  assert.ok(trimmed.length > 0, 'a trimmed record does not carry the count, so no surface can admit the loss')
})

/* ---------------------------------------------------------------
   The third line kind: what the agent DID, saved beside what it SAID.
   --------------------------------------------------------------- */

test('an action line is kept, under its own bound, beside the conversation', () => {
  const store = createTranscriptStore({ computerId: COMPUTER, storage: fakeSeam() })
  const spoken = [line('you', 'run the tests'), line('agent', 'they pass')]
  const actions = Array.from(
    { length: TRANSCRIPT_LIMITS.maxActionLines + 9 },
    (_, i) => ({ who: 'action', text: `npm test ${i}`, at: 2000 + i, state: 'done' }),
  )
  assert.equal(store.save('n1', { lines: [...spoken, ...actions] }), true)
  const record = store.get('n1')
  const kept = record.lines.filter(entry => entry.who === 'action')
  const said = record.lines.filter(entry => entry.who !== 'action')
  assert.equal(kept.length, TRANSCRIPT_LIMITS.maxActionLines, 'action lines are not bounded on their own')
  assert.equal(said.length, 2, 'the actions pushed the conversation out; the two bounds are not separate')
  assert.equal(kept[kept.length - 1].text, `npm test ${TRANSCRIPT_LIMITS.maxActionLines + 8}`, 'the newest action was dropped')
  assert.equal(kept[0].state, 'done', 'an action line loses what became of it')
})

test('an action line is cut at its own character bound, not the conversation one', () => {
  const store = createTranscriptStore({ computerId: COMPUTER, storage: fakeSeam() })
  store.save('n1', { lines: [line('you', 'hi'), { who: 'action', text: 'x'.repeat(4000), at: 5 }] })
  const action = store.get('n1').lines.find(entry => entry.who === 'action')
  assert.equal(action.text.length, TRANSCRIPT_LIMITS.maxActionChars)
})

test('the seed a resuming agent reads is the conversation, not the tool list', () => {
  /* An agent taking over is owed what was SAID. Feeding it a list of commands
     framed as "the agent before you said" would put words in a mouth. */
  const seed = transcriptSeedText([
    line('you', 'first ask'),
    { who: 'action', text: 'npm test', at: 5, state: 'done' },
    line('agent', 'first answer'),
  ])
  assert.ok(seed.includes('The person said: first ask'))
  assert.ok(seed.includes('The agent before you said: first answer'))
  assert.ok(!seed.includes('The agent before you said: npm test'), 'a command is being quoted as something the agent said')
})
