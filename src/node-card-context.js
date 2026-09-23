import { chatPreviewText } from './chat-markdown.js'

export const NODE_CARD_OUTPUT_CHARS = 1600

/* A compact card is a window onto the most recent work, not the opening of a
   reply that may now be several screens old. Keep the cap explicit so a noisy
   stream cannot grow the canvas without bound, and mark truncation rather than
   presenting a mid-sentence tail as the whole answer. */
export function latestNodeOutput(value, maxChars = NODE_CARD_OUTPUT_CHARS) {
  const text = value == null ? '' : String(value).trim()
  const limit = Number.isInteger(maxChars) && maxChars > 1 ? maxChars : NODE_CARD_OUTPUT_CHARS
  if (text.length <= limit) return text
  const hardCut = text.slice(-(limit - 1))
  /* THE WINDOW OPENS ON A WHOLE WORD, NOT WHEREVER THE BUDGET RAN OUT. A hard
     character cut reads as a fragment ("…ders await the grouped admission
     path") -- measured on the person's own card, evidence\w16d-cardroom.json.
     Drop forward to the window's first whitespace, the same "mid-word only as
     a last resort" rule src/tree-graph.css's overflow-wrap: break-word rules
     already use, and for the same reason: when the window is one token with
     no whitespace in it at all (a long path, a long id), there is nowhere to
     drop forward to without emptying the excerpt, so this keeps the hard cut
     rather than doing that. This can only ever shorten the excerpt, never
     lengthen it past `limit` -- it never reopens the "grow without bound"
     defect this cap exists to close. */
  const boundary = hardCut.search(/\s/)
  const wordSafe = boundary === -1 ? '' : hardCut.slice(boundary + 1)
  return `…${wordSafe || hardCut}`
}

// Parse complete public response Markdown before taking a bounded preview tail.
// Cutting raw source first can strand a closing link or fence in the excerpt.
export function latestNodeResponse(value) {
  return latestNodeOutput(chatPreviewText(typeof value === 'string' ? value : ''))
}
