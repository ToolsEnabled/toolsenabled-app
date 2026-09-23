/* openStream REPAINTED innerHTML ON EVERY PUSH WITH NO HEIGHT HOLD.
 *
 * push() REPLACES the streaming bubble's whole text every delta (the caller
 * owns accumulation -- see openStream's own header). A delta that renders
 * even fractionally shorter than the one before it -- formatting settling
 * mid-word, an aside folding away -- shrank the bubble and grew it back on
 * the very next frame, which reads as the transcript flinching while a
 * person is mid-read rather than as an answer arriving. This pins that the
 * bubble's own min-height is ratcheted up (never down) across repaints
 * within one stream, and released the moment the stream closes.
 *
 * Source pins, deliberately: buildChat needs a DOM to run, and the harness
 * here has none. */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
const components = readFileSync(join(SRC, 'components.js'), 'utf8')
const chat = components.slice(components.indexOf('export function buildChat'))
const openStream = chat.slice(chat.indexOf(`'openStream'`), chat.indexOf(`'openActions'`))

test('a push never sets minHeight lower than what this stream already reached', () => {
  assert.match(openStream, /let heldHeight = 0/,
    'the ratchet variable is gone -- without it there is nothing to compare a new height against')
  assert.match(openStream, /if \(m\.offsetHeight > heldHeight\)/,
    'the hold only ever tightens upward if this guard exists -- without it a shorter repaint would lower minHeight and the bubble could shrink again')
  assert.match(openStream, /heldHeight = m\.offsetHeight/,
    'the ratchet is never updated, so it would freeze at 0 and never actually hold anything')
  assert.match(openStream, /m\.style\.minHeight = `\$\{heldHeight\}px`/,
    'the measured height is never written to the element, so nothing is actually held')
})

test('the hold is measured and applied on every push, inside paint, not once at open', () => {
  const paint = openStream.slice(openStream.indexOf('const paint = (source, complete = false)'), openStream.indexOf('return {'))
  /* renderChatMarkdown, not formatInlineText, since this bubble is always an
     agent turn -- see components.js's own note beside this line for why. The
     assertion's intent (paint still repaints the bubble body from incoming
     text on every call) is unchanged by which renderer draws it. */
  assert.match(paint, /setChatMessageBody\(body, text\)/, 'paint no longer repaints the bubble body')
  assert.match(paint, /m\.offsetHeight > heldHeight/, 'the height check moved out of paint -- a push that skips it cannot grow the hold')
})

test('close() releases the hold so a shorter final answer settles to its true height', () => {
  const closeStart = openStream.indexOf('close: (finalText')
  const close = openStream.slice(closeStart, openStream.indexOf(`m.removeAttribute('aria-busy')`, closeStart) + 40)
  assert.match(close, /m\.style\.minHeight = ''/,
    "close() no longer clears minHeight -- a stream that ends would leave dead space below a shorter final answer forever")
  /* The clear happens AFTER the final paint, not before it -- clearing first
     would let the final (possibly shorter) paint render without the hold,
     which is fine, but clearing BEFORE a still-in-flight paint would defeat
     the point of holding at all during that last repaint. */
  const clearAt = close.indexOf(`m.style.minHeight = ''`)
  const paintCallAt = close.indexOf('paint(finalText ?? readable.text, true)')
  assert.ok(paintCallAt !== -1 && paintCallAt < clearAt,
    'close() clears the height hold before its own final paint runs')
})
