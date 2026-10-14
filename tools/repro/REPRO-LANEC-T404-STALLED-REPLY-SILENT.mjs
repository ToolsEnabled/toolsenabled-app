/* T404 -- a reply that stops mid-answer stops SILENTLY.
 *
 * src/chat-readable-stream.js holds unfinished markup at the streaming tail so
 * it is painted once rather than flickering into shape (T384). The held text is
 * revealed by finish(), which the chat surface calls when the turn COMPLETES.
 * When the turn does not complete -- a stalled session, a truncated reply --
 * the held text is text that ARRIVED and that the person is never shown, behind
 * a row that still says it is working and says nothing about the gap.
 *
 * THE TWO CAUSES ARE DIFFERENT AND THIS SCRIPT SEPARATES THEM.
 *   (a) STALL: no further packet arrives and no completion is ever sent. The
 *       transport is the cause. Nothing here can fix that, but the glass must
 *       say what it is looking at instead of showing an answer that just ends.
 *   (b) RENDER: text that already arrived is withheld, and how much is withheld
 *       is unbounded -- a hold that opened on a table row withheld the whole
 *       block. That is this file's business, and it is measured below.
 *
 * Usage: node tools/repro/REPRO-LANEC-T404-STALLED-REPLY-SILENT.mjs
 * Exit 0 = GREEN, exit 1 = RED.
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const { createReadableTextBuffer } = await import(
  pathToFileURL(path.resolve('src/chat-readable-stream.js')).href)

const failures = []
const check = (name, actual, expected) => {
  const ok = typeof expected === 'function' ? expected(actual) : actual === expected
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}`)
  if (!ok) failures.push(name)
}

/* THE SHAPES A STALL ACTUALLY LEAVES BEHIND, each held by a different rule in
   unfinishedMarkupStart. The inline rules already bounded themselves to
   INLINE_HOLD_REACH; the table rules did not, so the amount withheld grew with
   whatever had arrived. The paragraph above each one is finished text and is
   not the point. MEASURED on 400 real replies from the owner's LIVE
   transcripts replayed as 8-character deltas and cut at every delta boundary:
   337 withheld arrived text at some point, the worst 327 characters. */
const ANSWER = 'Here is the comparison you asked for.\n\n'
const cell = n => `| ${'a measured cell of the answer '.repeat(n)}`
const STALLS = [
  ['a table row still being written when the stream stopped', ANSWER + cell(20)],
  ['a table head line finished, its delimiter row never sent', `${ANSWER + cell(20)}|\n`],
  ['a table head line finished, a partial delimiter row', `${ANSWER + cell(20)}|\n| --`],
]

console.log('# a live reply, streamed and then stopped with no completion')
for (const [name, source] of STALLS) {
  const buffer = createReadableTextBuffer()
  const withheld = source.length - buffer.push(source).length
  console.log(`#   ${name}: ${source.length} chars arrived, ${withheld} withheld`)
  check(`a stall withholds no more than one reach: ${name}`, withheld, held => held <= 240)
}

console.log('\n# the surface can ask how much is being withheld')
const stalled = createReadableTextBuffer()
const stalledSource = STALLS[0][1]
const painted = stalled.push(stalledSource)
check('heldChars is reported while a hold is in force', stalled.heldChars, held => typeof held === 'number' && held > 0)
check('heldChars is exactly what arrived and was not painted', stalled.heldChars,
  stalledSource.length - painted.length)

console.log('\n# a completed turn holds nothing back and reports nothing held')
const completed = createReadableTextBuffer()
completed.push(STALLS[0][1])
const finished = completed.finish(STALLS[0][1])
check('every arrived character is painted on completion', finished, STALLS[0][1])
check('nothing is reported held after completion', completed.heldChars, 0)

console.log('\n# the flicker the hold exists to prevent is still prevented')
const growing = createReadableTextBuffer()
check('a table head alone is not painted as a paragraph of pipes',
  growing.push('Intro.\n\n| Left | Right |'), 'Intro.\n\n')
check('the table appears once its delimiter row lands',
  growing.push('Intro.\n\n| Left | Right |\n| --- | --- |\n'), 'Intro.\n\n| Left | Right |\n| --- | --- |\n')
const link = createReadableTextBuffer()
check('an unclosed link is not painted as literal punctuation',
  link.push('See [the page](https://'), 'See ')
check('and is painted once it closes',
  link.push('See [the page](https://example.invalid/x)'), 'See [the page](https://example.invalid/x)')

console.log('\n# ordinary prose is never held (the streaming rule is unchanged)')
const prose = createReadableTextBuffer()
check('a token arrival is shown as it arrives', prose.push('Streaming '), 'Streaming ')
check('a short answer with no trailing space is shown', prose.push('Streaming words'), 'Streaming words')

console.log(`\n${failures.length ? `RED  ${failures.length} check(s) failed: ${failures.join('; ')}` : 'GREEN  all checks passed'}`)
process.exit(failures.length ? 1 : 0)
