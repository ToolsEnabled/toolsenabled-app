// Presentation only: transport and durable history retain every arriving byte.
//
// TWO SURFACES, TWO RULES, AND THEY ARE NOT INTERCHANGEABLE. Collapsing them
// back to one rule breaks one side or the other, and it has now happened in
// both directions. Read this before "simplifying" the default away.
//
// THE SUMMARY SURFACES HOLD AN UNFINISHED READABLE UNIT: an unclosed fence,
// and prose that has not yet ended a sentence. This is what a THINKING row, a
// tree card and any other summarised feed want. Their reader glances at a line
// that stands in for a whole run, and a half-sentence there reads as the text --
// 'A complete sentence. Pending' is not a thing anyone meant to say. Withheld
// at ec82f690 by the hold, MEASURED at 3876f46b once the hold was removed:
// five tests across four suites went red, tree-card-thinking-slot and
// thinking-transcript-pipeline quoting exactly that shape.
//
// THE LIVE REPLY BODY MUST NOT HOLD PROSE, and that is the opposite rule for
// a good reason. Its reader is watching an answer arrive, so the words a
// person is waiting for are the words that have arrived. MEASURED at
// ec82f690, six cases across four suites when the hold applied here: a reply
// streamed as 'Streaming ' then 'words' painted an empty bubble
// (desktop-sessions-renderer); a whole short answer, 'The first response.',
// painted an empty bubble for its entire live turn because its stop had no
// trailing space (chat-stream-code-blocks); a growing markdown list drew zero
// of its three items; chat-working-row-step and tree-chat-resume-stream lost
// their live rows the same way. A person watching an agent answer saw nothing
// at all until the turn completed.
//
// WHICH WAY ROUND THE DEFAULT SITS IS DECIDED BY THE SUITES, NOT BY TASTE.
// tools/test/chat-readable-chunks.test.mjs pins the STREAMING rule on the bare
// createReadableTextBuffer() -- "every token arrival is shown as it arrives",
// "a reply with no sentence stop at all is still readable while it streams",
// "a whole short answer whose only stop ends the text is shown before it
// settles". So the buffer streams, and the surface that summarises opts IN to
// holding: readableTextPrefix. Making the hold the blanket default instead
// turns those seven assertions red, and the only way green from there is to
// edit them -- which is the defect, not the fix. Measured, not reasoned: with
// the hold as the default, chat-readable-chunks goes 1/8 and chat-message-body
// 4/5, both of which are 8/8 and 5/5 at 3876f46b.
//
// THE THINKING ACTION ROW IS DELIBERATELY NOT CHANGED HERE, and that is a
// reported conflict rather than an oversight. Two suites drive the SAME
// .chat-thinking-body through the components.js action-row buffer and assert
// opposite things:
//   chat-readable-stream, "native thinking streams readable units in one group"
//     pins stages ['A thought', 'A thought arrives.', 'A thought arrives. Next
//     fragment'] -- every fragment visible as it lands. Its own header records
//     that these assertions were rewritten when the rule changed.
//   thinking-transcript-pipeline pins the opposite on the same element: given
//     'A complete sentence. The final supplied fragment' it requires that the
//     trailing fragment is NOT shown while the item is live.
// Both cannot hold. Switching that buffer to the holding rule fixes the
// pipeline's two assertions and breaks chat-readable-stream's, which is 6/6 at
// 3876f46b. Deciding which yields is a product call, so it is escalated and
// neither test is touched.
//
// A PARTIAL FENCE IS HELD ON BOTH PATHS, and is the one case both agree on:
// three backticks with one line under them is not yet a code block, and
// revealing it draws literal punctuation that then changes shape into a
// bounded element when the closing fence lands. That flicker is worth a delay.
const sentences = new Intl.Segmenter(undefined, { granularity: 'sentence' })
const terminal = /[.!?。！？…][\p{Pe}\p{Pf}"']*\s+$/u
const unspacedTerminal = /[。！？][\p{Pe}\p{Pf}"']*$/u

function readableEnd(text, { holdUnfinishedProse = false } = {}) {
  let boundary = 0, offset = 0, fence = null, proseStart = 0
  for (const line of text.split(/(?<=\n)/)) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (fence) {
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length && /^\s*$/.test(line.slice(match[0].length))) {
        fence = null
        boundary = offset + line.length
        proseStart = boundary
      }
    } else if (match) {
      // Everything before the opening fence is finished text and stays visible.
      boundary = offset
      fence = match[1]
      proseStart = offset
    } else if (/^\s*\n$/.test(line)) {
      boundary = offset + line.length
      proseStart = boundary
    }
    offset += line.length
  }
  // A partial fence must not appear as a paragraph and then change shape.
  // This applies to both rules: it is held even when prose is not.
  if (fence) return boundary
  // An unfinished construct at the tail is held for the same reason as a
  // fence, on both rules: it is markup, not prose, and it is about to change
  // shape. See unfinishedMarkupStart for what is measured.
  //
  /* T404: AND NEVER MORE THAN ONE REACH OF IT. A hold is a bet that the next
   * packet is about to arrive. When it does not -- a stalled session, a
   * truncated reply -- everything held is text that ARRIVED and that the person
   * is not being shown, with the row still claiming to be working. The inline
   * holds already bound themselves to INLINE_HOLD_REACH; the table holds did
   * not, so a block that opened with a table row could withhold the whole
   * block. MEASURED by replaying 400 real replies from the owner's LIVE
   * transcripts as 8-character deltas and cutting the stream at every delta
   * boundary: 337 withheld arrived text at some point and the worst withheld
   * 327 characters, 8 replies withholding more than one reach. Clamped here the
   * worst case is one reach, and the surface names what is still held.
   *
   * THE OPEN FENCE IS DELIBERATELY NOT CLAMPED. Revealing a partial fence draws
   * literal punctuation that then changes shape, which both rules above exist
   * to prevent, and it is returned before this line. That case is covered by
   * the named state instead, not by painting half a code block. */
  const markup = Math.max(
    unfinishedMarkupStart(text, Math.max(boundary, proseStart)),
    Math.min(text.length, Math.max(boundary, proseStart, text.length - INLINE_HOLD_REACH)))
  // The live reply body stops here: everything outside an open fence is shown.
  if (!holdUnfinishedProse) return markup
  const prose = text.slice(proseStart)
  for (const part of sentences.segment(prose)) {
    const end = proseStart + part.index + part.segment.length
    if (terminal.test(part.segment) || (end < text.length && unspacedTerminal.test(part.segment))) boundary = end
  }
  return Math.min(boundary, markup)
}

/* MARKUP THAT HAS NOT FINISHED ARRIVING IS HELD, NOT SHOWN AS PUNCTUATION.
 *
 * MEASURED (T384, 2026-09-18) on a real Claude reply captured as stream-json
 * (141 text deltas) and replayed through this buffer: 16 of 141 frames painted
 * markdown punctuation as words that the next frame took back. The table's
 * head line "| Left | Center | Right |" sat on screen as a paragraph of pipes
 * for four frames until its delimiter row landed and it snapped into a table;
 * "[https link](https://" was shown literally for two frames before the ")"
 * arrived and it became a link; an opening backtick, "**" and "~~" each drew
 * their marks for a frame. The fence hold above already exists for exactly
 * this class of defect; this is the same hold for the constructs a token
 * stream also splits.
 *
 * WHAT IS HELD, and only this:
 *   - a block whose first line begins with "|" until its second line has
 *     ended: it is a table once the delimiter row lands, and a paragraph
 *     otherwise, and it should be painted as one thing, once;
 *   - inside a table, the last row while it is still unterminated, so a row
 *     appears whole rather than cell by cell;
 *   - an inline code span, "**" strong span, "~~" strikethrough span or
 *     "[link](target" whose closing mark has not arrived, held from its
 *     opening mark;
 *   - a last line that is nothing but a heading or list marker ("#", "-",
 *     "1."), until its first word says what it is.
 *
 * WHAT IS NOT HELD. Single "*" and "_" are arithmetic and identifiers far
 * more often than they are emphasis, and holding on them would withhold
 * ordinary prose. A construct opened more than INLINE_HOLD_REACH characters
 * back is treated as prose and shown: a "[" or "`" the model never closes must
 * not hide the rest of its answer until the turn ends. The hold is decided
 * BEFORE painting, so the monotonic guard in createReadableTextBuffer never
 * has to withdraw anything: text shown stays shown.
 *
 * NEVER FOR PROSE. tools/test/chat-readable-chunks.test.mjs pins that every
 * plain token is shown as it arrives; nothing here fires on text without one
 * of the marks above, so that rule is unchanged. */
const INLINE_HOLD_REACH = 240
const TABLE_ROW = /^ {0,3}\|/
const TABLE_DELIMITER = /^ {0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const TABLE_DELIMITER_PREFIX = /^ {0,3}\|?[\s:|-]*$/
const BARE_MARKER = /^ {0,3}(#{1,6}|[-*+]|\d{1,9}[.)]?)$/

function unfinishedMarkupStart(text, from) {
  // The tail block: what follows the last blank line, and never anything
  // before a settled fence or boundary.
  let blockStart = from
  const blank = text.slice(from).search(/\n[ \t]*\n(?![\s\S]*\n[ \t]*\n)/)
  if (blank >= 0) blockStart = from + blank + text.slice(from + blank).match(/^\n[ \t]*\n/)[0].length
  const block = text.slice(blockStart)
  if (!block) return text.length
  const lines = block.split('\n')
  if (TABLE_ROW.test(lines[0])) {
    // Head line only, or a delimiter row still arriving: not yet a table.
    // MEASURED live (local model on the candidate): the head line arrived
    // WITH its newline and nothing after it, and painted as a paragraph for
    // one frame. A terminated head line with no second line is still held.
    if (lines.length === 1 || (lines.length === 2 && (lines[1] === '' || TABLE_DELIMITER_PREFIX.test(lines[1])))) return blockStart
    if (TABLE_DELIMITER.test(lines[1])) {
      // A table. The last row is held while it is still being written.
      const last = lines.at(-1)
      if (last !== '' && lines.length > 2) return text.length - last.length
      return text.length
    }
    return text.length
  }
  // A last line that is only a would-be marker ("#", "##", "-", "1.") has
  // not said whether it is a heading, a bullet, a numbered item or a word yet.
  // MEASURED on a local model (one token per delta): "#" alone painted an
  // empty heading, "1" a paragraph that became a list on the next token.
  const last = lines.at(-1)
  if (lines.length > 0 && last !== '' && BARE_MARKER.test(last)) return text.length - last.length
  const reach = Math.max(blockStart, text.length - INLINE_HOLD_REACH)
  let hold = text.length
  const consider = index => { if (index >= reach && index < hold) hold = index }
  // Code span: an odd count of backticks leaves the last one open, and an
  // open code span swallows every other mark after it.
  const ticks = [...block.matchAll(/`+/g)]
  if (ticks.length % 2 === 1) { consider(blockStart + ticks.at(-1).index); return hold }
  for (const mark of ['**', '~~']) {
    const marks = block.split(mark).length - 1
    if (marks % 2 === 1) consider(blockStart + block.lastIndexOf(mark))
  }
  // A link: "[" with no "]" yet, or "](" with no ")" yet, held from its "[".
  const open = block.lastIndexOf('[')
  if (open >= 0) {
    const rest = block.slice(open)
    const close = rest.indexOf(']')
    if (close < 0) consider(blockStart + open)
    else if (rest[close + 1] === '(' && rest.indexOf(')', close) < 0) consider(blockStart + open)
  }
  return hold
}

export const readableTextPrefix = value => {
  const text = String(value ?? '')
  return text.slice(0, readableEnd(text, { holdUnfinishedProse: true }))
}

export function createReadableTextBuffer(initialText = '', { holdUnfinishedProse = false } = {}) {
  let source = String(initialText), visible = source
  return {
    push(value) {
      const next = String(value ?? '')
      const prior = next.startsWith(source) ? visible.length : 0
      source = next
      // The monotonic guard: visible text is never withdrawn once painted.
      visible = source.slice(0, Math.max(prior, readableEnd(source, { holdUnfinishedProse })))
      return visible
    },
    finish(value = source) { source = String(value ?? ''); visible = source; return visible },
    reset() { source = ''; visible = '' },
    get text() { return source },
    /* T404: HOW MUCH ARRIVED TEXT IS NOT ON THE GLASS RIGHT NOW.
       While packets keep coming this is a sub-frame detail nobody needs. When
       they stop it is the difference between "the agent has said this much" and
       what the person can actually read, and a surface that cannot ask cannot
       say anything about it -- which is what made a stalled reply look like a
       reply that simply ended mid-sentence. */
    get heldChars() { return Math.max(0, source.length - visible.length) },
  }
}

// `holdUnfinishedProse` is kept on createReadableTextBuffer with no product
// caller on purpose: it is the seam the thinking action row needs the moment
// the conflict recorded above is decided, and putting it here now means that
// decision costs one argument rather than another rewrite of this file.
// It is exercised by readableEnd through readableTextPrefix, so it is not
// untested code.
