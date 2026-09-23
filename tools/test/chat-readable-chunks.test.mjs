/* THE RULE THIS FILE HOLDS.
 *
 * Ordinary prose is never withheld: what has arrived is what is shown. Only an
 * UNCLOSED FENCE is held, until its closing fence lands.
 *
 * It used to hold unfinished prose too -- until a sentence ended AND a space
 * followed it -- and the owner's requirement is the opposite: a live reply has
 * to be visible while it streams. That hold made a short or sentence-final
 * answer paint nothing for its entire live turn, and it cost six tests in four
 * suites (desktop-sessions-renderer, chat-stream-code-blocks,
 * chat-working-row-step, tree-chat-resume-stream). The assertions that pinned
 * the hold are replaced below with assertions of the new rule. EVERY FENCE
 * CASE FROM THE OLD FILE IS KEPT, unchanged, because the fence half was never
 * the defect: a partial fence would reach the reader as literal punctuation
 * and then change shape into a bounded element when it closed.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createReadableTextBuffer } from '../../src/chat-readable-stream.js'

test('every token arrival is shown as it arrives, and the final flush is idempotent', () => {
  const buffer = createReadableTextBuffer()
  let source = '', previous = '', changes = 0, everyStepShownWhole = true
  for (const character of 'A complete sentence. Another complete sentence. Final fragment') {
    source += character
    const visible = buffer.push(source)
    if (visible !== source) everyStepShownWhole = false
    if (visible !== previous) changes += 1
    previous = visible
  }
  assert.equal(everyStepShownWhole, true, 'a token arrived and the reader was not shown it')
  assert.equal(changes, source.length, 'some arrivals painted nothing new')
  assert.equal(buffer.finish(), source)
  assert.equal(buffer.finish(), source)
})

test('a reply with no sentence stop at all is still readable while it streams', () => {
  /* The defect case, stated directly: two deltas, no punctuation anywhere. */
  const buffer = createReadableTextBuffer()
  assert.equal(buffer.push('Streaming '), 'Streaming ')
  assert.equal(buffer.push('Streaming words'), 'Streaming words')
})

test('a whole short answer whose only stop ends the text is shown before it settles', () => {
  /* The old rule needed whitespace AFTER the stop, so this text -- an entire
     answer -- was invisible for the whole live turn. */
  const buffer = createReadableTextBuffer()
  assert.equal(buffer.push('The first response.'), 'The first response.')
})

test('paragraphs appear as they arrive, and unfinished fenced code stays together', () => {
  const buffer = createReadableTextBuffer()
  assert.equal(buffer.push('A whole paragraph\n'), 'A whole paragraph\n')
  assert.equal(buffer.push('A whole paragraph\n\n'), 'A whole paragraph\n\n')
  // KEPT: the opening fence stops the reveal exactly at the paragraph before it.
  assert.equal(buffer.push('A whole paragraph\n\n```js\nconst answer = 42.0;\n'), 'A whole paragraph\n\n')
  // KEPT: the closing fence releases the block whole.
  const complete = 'A whole paragraph\n\n```js\nconst answer = 42.0;\n```\n'
  assert.equal(buffer.push(complete), complete)
})

test('a decimal point mid-number is shown like any other character and ends nothing', () => {
  /* This used to assert '' at every step, which is how a person watching a
     number being typed was shown an empty bubble instead. What matters is
     that the buffer never invents a boundary, not that it hides the text. */
  const buffer = createReadableTextBuffer()
  for (const text of ['Value 3.', 'Value 3.14', 'Value 3.14 is expected', 'Value 3.14 is expected.']) {
    assert.equal(buffer.push(text), text)
  }
  assert.equal(buffer.push('Value 3.14 is expected. Next'), 'Value 3.14 is expected. Next')
})

test('visible text is never withdrawn, and corrections and reset retain the exact source', () => {
  const buffer = createReadableTextBuffer('Already visible')
  const grown = buffer.push('Already visible and still arriving')
  assert.equal(grown.startsWith('Already visible'), true, 'text already on screen was taken back')
  assert.equal(grown, 'Already visible and still arriving')
  assert.equal(buffer.finish('Corrected final text'), 'Corrected final text')
  buffer.reset()
  assert.equal(buffer.push('New unfinished'), 'New unfinished')
  assert.equal(buffer.finish(), 'New unfinished')
})

test('text without inter-word spaces streams too, and fenced blocks keep their boundary', () => {
  const buffer = createReadableTextBuffer()
  assert.equal(buffer.push('一句完整的话。下'), '一句完整的话。下')
  buffer.reset()
  // KEPT, unchanged: a partial block is held back to the line before the fence.
  assert.equal(buffer.push('An introduction\n```text\nA partial block'), 'An introduction\n')
  // KEPT, unchanged: the turn's end still shows everything that arrived.
  assert.equal(buffer.finish(), 'An introduction\n```text\nA partial block')
})

test('a tilde fence and an indented fence are held on the same rule as a backtick fence', () => {
  /* Not in the old file. The fence half is now the only thing this module
     holds, so its edges are worth asserting rather than assuming. */
  const buffer = createReadableTextBuffer()
  assert.equal(buffer.push('Before\n~~~\nstill open'), 'Before\n')
  assert.equal(buffer.push('Before\n~~~\nstill open\n~~~\n'), 'Before\n~~~\nstill open\n~~~\n')
  buffer.reset()
  assert.equal(buffer.push('Before\n   ```\nstill open'), 'Before\n')
})
