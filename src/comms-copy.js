/* THE WORDS THE AGENT COMMS PAGE USES, IN THE ONE FILE THAT HAS NO BROWSER IN IT.
 *
 * WHY THESE STRINGS LEFT THE VIEW. src/views/comms.js imports a stylesheet, so
 * a plain `node` run cannot load it, and every sentence the page shows was
 * composed inside closures in there -- which is how the page came to say the
 * same fact four to six times at once ("on record", "declared", "separate
 * records", "services on record" for ONE count, in ONE header row) and how one
 * thirty-three-word refusal got stamped into every tile, the topic bar and the
 * rail foot (N+1 copies of one failure). Every sentence, read on its own, was
 * defensible; the panel as a whole was not readable, and a gate that reads
 * string literals one at a time cannot see that. So the strings live here,
 * where tools/check-composed-output.mjs can build the WHOLE panel for a state
 * and measure it as one thing (tools/lib/composed-panels.mjs), the same move
 * src/ledger-copy.js made for the ledger.
 *
 * ONE NAME. The page had six -- "message board", "watch board", "Ops
 * projection", Watch/Channels, the `.ch-*`/`.wb-*` class families and the
 * route `comms`. The only name printed now is COMMS_NAME, the name the
 * navigation rail uses: the heading here, and the Back/Forward arrows, the
 * window title and the screen announcement in src/main.js (T1242). The route
 * id keeps the word "comms" (tools/test/research-view.test.mjs pins the ring),
 * and the mode switch says what each face IS -- a board of tiles, a list of
 * channels -- rather than naming the page twice more.
 *
 * WHAT THE PAGE IS FOR, in one sentence, because the owner's finding was that
 * nobody could say: Messages shows the messages your agents send each
 * other, channel by channel, and which services and channels exist on this
 * computer.
 *
 * EACH FACT ONCE. The inventory (how many services, channels, messages, tool
 * links) is said in the one line under the title and nowhere else. A
 * channel's state and detail are said by `describe`, and the tile line and the
 * topic bar both read it, so the two can never drift the way `desc` and
 * `topic` had ("Service on record · relay · :61411" beside "… · port 61411").
 *
 * NO JARGON. "projection", "envelope", "payload", "renderer" are on the gate's
 * list (tools/check-plain-language.mjs JARGON) and none of them is a word a
 * person who has never read this codebase would have. The thing the page reads
 * is "the comms report"; the thing that reads it is "this copy of the program".
 *
 * DOM-FREE ON PURPOSE: imported by node tests and by the composed-output gate.
 * Nothing in here may touch `document` or `window`, and nothing may import a
 * module that does (src/vocab.js resolves the whole fleet profile at load).
 * Sender accents below are theme tokens, not a copy of mutable role colors. */

export const COMMS_NAME = 'Messages'

/* The two faces. `watch` and `channels` stay as the data-wmode values (the
   stylesheet's [data-mode] rules key on them); only the words a person reads
   changed. "Board | Channels" says what each face shows. */
export const MODE_LABELS = Object.freeze({ watch: 'Board', channels: 'Channels' })

/* The two groups in the rail, in the order they are drawn. Services are not
   channels -- a service on record is a thing this computer is configured to
   run; a channel is a place messages land -- so they are listed apart and the
   service rows are not buttons (there is nothing to open on one). */
export const RAIL_GROUPS = Object.freeze({ services: 'Services', channels: 'Channels' })
export const NO_SERVICES = 'No services on record.'

/* The word beside the dot in the header. One word per state, the same five
   states the root's data-projection-state carries, so the word and the
   attribute can never disagree. */
export const READ_STATE_WORDS = Object.freeze({
  loading: 'reading',
  ready: 'live',
  'partial-unavailable': 'partial',
  unavailable: 'could not be read',
  simulated: 'example',
})
export function readStateWord(state) {
  return READ_STATE_WORDS[state] || READ_STATE_WORDS.loading
}

export const EXAMPLE_BADGE = 'Example, not your data'

/* The icon-only tile control has no visible words to contribute to its
   accessible name. Keep the name here with the rest of this page's words so
   the view and its accessibility contract cannot invent separate labels. */
export const RESTACK_LABEL = 'Return to stack'

/* Shown while the first read is in flight -- not a failure and not an empty
   answer, the third thing, and it is on screen for a moment. It is named
   because the view has to recognise it: a read that has not answered yet is
   not a computer with nothing to say. */
export const LOADING_LINE = 'Reading messages from the computer you are driving…'

/* The one line under the title when the whole read failed. Never a count: a
   page whose every readout says "could not be read" must not also claim a
   number of anything (tools/offline-routes-qa.mjs pins the contradiction). */
export const UNREADABLE_SUB = 'The comms report could not be read.'

const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`

/**
 * ABSENT AND BROKEN ARE DIFFERENT FACTS, AND THIS LINE CALLED BOTH BROKEN.
 *
 * The inventory printed one fixed sentence whenever a segment was missing:
 * "tool links could not be read". That names a FAULT. But the ordinary reason
 * on a customer's machine is not a fault at all -- the tool-link inventory is
 * written into the release report, and a computer that did not cut the release
 * has no such report to hold. That is every customer, always. So the page whose
 * whole job is to say what is working told all of them, permanently, that
 * something had gone wrong with their tool links.
 *
 * THE DISTINCTION IS A SHARED CONSTANT, NOT A FREE STRING. The obvious fix is
 * to render the segment's own `reason`, since one is already carried -- but
 * those reasons come from several producers and are written for a log, not for
 * this position in a sentence. Piping them to the glass is how a person ends up
 * reading an internal refusal code. So the producer sets exactly this value
 * when it means "absent here", and the copy answers with a sentence it owns.
 * Anything else stays "could not be read", which is the safe wrong answer of
 * the two.
 */
export const NOT_RECORDED_HERE = 'not recorded on this computer'

/* This phrase is assembled inside the inventory's joined list, so the
   whole-sentence REMOTE_TWIN lookup in refusal-copy.js can never see it. Keep
   the desk and relay readings paired here, at the composition site, instead
   of applying a blanket replacement to the finished inventory line. */
const NOT_RECORDED_COPY = Object.freeze({
  desk: (noun) => `${noun} are not recorded on this computer`,
  relay: (noun) => `${noun} are not recorded on the computer you are driving`,
})

function unreadable(segment, noun, { viaRelay = false } = {}) {
  return segment?.reason === NOT_RECORDED_HERE
    ? NOT_RECORDED_COPY[viaRelay ? 'relay' : 'desk'](noun)
    : `${noun} could not be read`
}

/**
 * The inventory, said once. `data` is the `$defs/data` layer of the comms
 * report: { declaredServices, channels, mcp, messages }. A part that could not
 * be read says so in its own segment; the messages segment is left out when
 * messages.ok is false, because the notice above the card already says it and
 * the same failure in two places is the defect this file exists to remove.
 */
export function inventoryLine(data, { viaRelay = false } = {}) {
  /* A COUNT IS A DEFINITE ANSWER, SO IT MAY ONLY COME FROM A SECTION THAT WAS
     READ. This used to print "0 services" whenever declaredServices was not an
     array -- which is every machine that did not cut the release, because the
     services list lives in the same unreadable report the tool links do. "0
     services" is not a hedge; it is a manufactured fact, and it is the one this
     module's own header forbids. The segment is now OMITTED when the list was
     never read, exactly as the messages segment already is a few lines down. */
  const services = Array.isArray(data?.declaredServices) ? data.declaredServices.length : null
  const channels = data?.channels?.ok && Array.isArray(data.channels.value) ? data.channels.value : null
  const messages = data?.messages?.ok && Array.isArray(data.messages.value) ? data.messages.value : null
  const mcp = data?.mcp?.ok && data.mcp.value ? data.mcp.value : null
  const parts = services === null ? [] : [plural(services, 'service')]
  parts.push(channels ? plural(channels.length, 'channel') : unreadable(data?.channels, 'channels', { viaRelay }))
  if (messages) parts.push(plural(messages.length, 'message'))
  parts.push(mcp
    ? `tool links: ${(mcp.live || []).length} live, ${(mcp.dead || []).length} not answering`
    : unreadable(data?.mcp, 'tool links', { viaRelay }))
  return parts.join(' · ')
}

/** "{state} · {detail}" -- the one sentence a tile and the topic bar share. */
export function describe(channel) {
  const state = typeof channel?.state === 'string' && channel.state ? channel.state : 'unknown'
  const detail = typeof channel?.detail === 'string' && channel.detail.trim() ? channel.detail.trim() : ''
  return detail ? `${state} · ${detail}` : state
}

/** A service row in the rail. Prose, not a button. */
export function serviceLine(service) {
  return `${service?.displayName || service?.id || 'service'} · ${service?.transport || 'transport not named'} · port ${service?.port ?? '—'}`
}

/* Empty is an ANSWER, not a failure -- the read worked and found nothing.
   These two never say "could not". They are also deliberately distinct from
   the host-absent and quiet notices in src/first-run-needs.js, which explain a
   whole page with nothing on it; these are for one channel, or one board,
   when the rest of the page is fine. */
export const emptyLine = () => 'No messages on this channel yet.'
export const boardEmptyLine = () => 'No channels to show yet.'

/* EVERY FAILURE NAMES A NEXT STEP. A sentence that ends at the failure is what
   the owner filed as a finding in its own right ("passive dead ends"). Each
   reason below is at most 25 words a sentence, names what did not happen, and
   says the one thing that would tell the reader whether their agents are
   silent or the page is. The reader is the bridge on window.mcAgent
   (shell `mc-agent:local-messages`). */
export const READER_REFUSALS = Object.freeze({
  NO_READER: 'This copy of the program cannot read messages between agents yet. Update it. Until then, each agent’s own conversation is on the Computers page.',
  NO_ANSWER: 'The program did not answer when asked for messages between agents. Start an agent from the tree; if this keeps happening, restart the program.',
  READ_THREW: (error) => `Messages between agents could not be read (${errorText(error)}). This page will try again in a few seconds. The Computers page still shows each agent’s own conversation.`,
})

/** The whole read fell over (the request itself, not one part of it). */
export const LOAD_FAILED = (error) => `This page could not read the comms report (${errorText(error)}). It will try again in a few seconds.`

function errorText(error) {
  const text = error && typeof error === 'object' && 'message' in error ? error.message : error
  const trimmed = String(text ?? '').trim()
  return trimmed || 'no reason given'
}

/* ---------------------------------------------------------------- rows -- */

/* Short paragraphs and structured updates stay open. Long reports use the
   shared chat disclosure so they do not overwhelm the conversation. */
export const FOLD_CHARS = 800
export const FOLD_BREAKS = 10
export function shouldFold(text) {
  const value = String(text ?? '')
  if (value.length > FOLD_CHARS) return true
  return (value.match(/\n/g) || []).length > FOLD_BREAKS
}

/* THE CLOSED LINE says what is inside in the message's own first words and
   how much of it there is -- the size in WORDS because that is the unit a
   person reads in (the rule src/fleet-tree-copy.js treeContextSummary holds).
   The sender is NOT repeated here: every surface this fold sits on already
   names the sender on the line above it, and saying it twice on one row is
   the restating this page was cleared of. */
export function foldSummary(text) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  const words = value ? value.split(' ').length : 0
  const stop = value.search(/[.!?…](\s|$)/)
  let first = stop >= 0 ? value.slice(0, stop + 1) : value
  if (first.length > 90) first = `${first.slice(0, 90).trimEnd()}…`
  else if (first.length < value.length) first = `${first.replace(/[.!?…]$/, '')}…`
  return `${first} · ${plural(words, 'word')}`
}

// Previews stay in the sender's own words. Short reports remain readable in
// full; longer messages offer enough context before the reader opens them.
export function messagePreview(text, limit = 320) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (value.length <= limit) return value
  const prefix = value.slice(0, limit)
  const boundary = prefix.lastIndexOf(' ')
  return `${prefix.slice(0, boundary > limit / 2 ? boundary : limit).trimEnd()}…`
}

/* One voice stays recognisable down a channel. Sender identity is not a role:
   changing a Manager's saved color must not recolor an unrelated sender. CSS
   keeps already-mounted rows legible when the theme changes, without a reread. */
export const SENDER_HUES = Object.freeze(Array.from({ length: 6 }, (_, index) => `var(--message-voice-${index + 1}, var(--ink-2))`))

/** sender -> CSS color, stable by first appearance in `messages` (oldest first). */
export function senderHues(messages) {
  const hues = new Map()
  for (const message of messages || []) {
    const sender = String(message?.sender ?? '')
    if (!sender || hues.has(sender)) continue
    hues.set(sender, SENDER_HUES[hues.size % SENDER_HUES.length])
  }
  return hues
}

export const KINDS = Object.freeze(['ask', 'answer', 'notice'])
export const KIND_TAGS = Object.freeze({ ask: 'asked', answer: 'answered' })
export const NO_ANSWER_YET = 'no reply in loaded history, open the thread'
export const replyingTo = (name) => `replying to ${name}`
export const toRecipient = (name) => `→ ${name}`

/**
 * One row, for all three surfaces (the log, the expanded tile, the preview).
 * `byId` is the channel's messages keyed by id, oldest first. Everything that
 * is not on the message is simply absent from the model -- a notice prints no
 * tag, a message with no recipient prints no arrow, a reply whose parent is
 * not in this channel prints no "replying to" (it would be a link to nowhere).
 * The owner journal carries routing and delivery metadata. Legacy messages
 * can omit those fields; the model leaves them absent. An unanswered request
 * is scoped to the loaded history because a reply can sit outside that window.
 */
export function rowModel(message, byId) {
  const map = byId instanceof Map ? byId : new Map()
  const kind = KINDS.includes(message?.kind) ? message.kind : 'notice'
  const parentId = typeof message?.causalParent === 'string' && map.has(message.causalParent) ? message.causalParent : ''
  const parent = parentId ? map.get(parentId) : null
  let noAnswer = false
  if (kind === 'ask') {
    noAnswer = true
    for (const other of map.values()) {
      if (other?.kind === 'answer' && other.causalParent === message.id) { noAnswer = false; break }
    }
  }
  return Object.freeze({
    id: String(message?.id ?? ''),
    sender: String(message?.sender ?? ''),
    recipient: typeof message?.recipient === 'string' && message.recipient ? message.recipient : '',
    kind,
    tag: KIND_TAGS[kind] || '',
    parentId,
    replyTo: parent ? replyingTo(String(parent.sender ?? '')) : '',
    replyPreview: parent ? messagePreview(parent.text, 140) : '',
    noAnswer,
    machine: typeof message?.senderMachine === 'string' && message.senderMachine ? message.senderMachine : '',
    at: Number.isFinite(Date.parse(message?.at)) ? Date.parse(message.at) : 0,
    text: String(message?.text ?? ''),
    deliveryState: ['available', 'unconfirmed'].includes(message?.deliveryState) ? message.deliveryState : '',
    deliveryLabel: message?.deliveryState === 'available' ? 'In inbox' : message?.deliveryState === 'unconfirmed' ? 'Delivery unconfirmed' : '',
    deliveryDetail: message?.deliveryState === 'available'
      ? 'Saved in the recipient’s inbox. This does not confirm the agent has read or acted on it.'
      : 'Recorded by the sender, but its recipient inbox write could not be confirmed.',
  })
}

/* ---------------------------------------------------------------- days -- */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const dayStart = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() }

/** "Today" / "Yesterday" / "21 Aug", measured on the reader's local calendar. */
export function dayLabel(at, now = Date.now()) {
  const days = Math.round((dayStart(now) - dayStart(at)) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  const d = new Date(at)
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`
}

/** Same local calendar day? The log draws a divider where this flips. */
export function sameDay(a, b) {
  return dayStart(a) === dayStart(b)
}
