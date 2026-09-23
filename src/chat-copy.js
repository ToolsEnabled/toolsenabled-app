/* THE WORDS src/components.js's CHAT SURFACES USE, IN THE ONE FILE THAT HAS
 * NO BROWSER IN IT.
 *
 * WHY THIS EXISTS. src/components.js builds the panel three surfaces mount
 * (the rail's Chat tab, the compact card on the fleet-tree canvas, the
 * uptime ring) and every sentence it shows was written inline inside the
 * builder closures -- which put the words outside tools/check-plain-
 * language.mjs's reach for the same reason src/comms-copy.js's header gives:
 * a scan over source text finds the defect quoted in the comment that
 * removed it, and it cannot see a string embedded inside a template
 * literal's markup. Moving the words here, following the pattern
 * src/comms-copy.js and src/ledger-copy.js already set, puts them where the
 * gate actually scans (this file is in src/, so it is) and keeps
 * components.js itself the thing every one of this app's copy rules calls
 * DOM-free: no `document`, no `window`, importable by a plain `node` test.
 *
 * ONE EXCEPTION, NAMED RATHER THAN SILENT: the two-button words on the
 * inline approval strip (Allow once / Refuse) are NOT re-declared here.
 * They come from APPROVAL_PANEL.words in src/fleet-tree-copy.js, which
 * views/computers.js already uses for the same decision elsewhere in this
 * product. A second "Deny / Approve once" vocabulary next to that one would
 * be the defect "one path per thing" exists to prevent, not a feature.
 */

import { NODE_STATUS_WORDS } from './fleet-tree-copy.js'

/* ------------------------------------------------------- source-proved header */

const recordObject = record => Boolean(record) && typeof record === 'object' && !Array.isArray(record)

export function chatWorkspaceLabel(value) {
  const full = String(value || '').trim()
  const name = full.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || full
  return `Workspace · ${name}`
}

export function chatHeaderPathCopy(record) {
  try {
    if (!recordObject(record)
        || (record.source !== 'profile-cwd' && record.source !== 'session-workspace')
        || typeof record.value !== 'string') return null
    const text = record.value.trim()
    if (!text) return null
    return Object.freeze({ text, ariaLabel: `Workspace path: ${text}` })
  } catch {
    return null
  }
}

export function chatHeaderStatusCopy(record) {
  try {
    if (!recordObject(record)
        || record.source !== 'session-node-status'
        || !Object.hasOwn(NODE_STATUS_WORDS, record.key)) return null
    const text = NODE_STATUS_WORDS[record.key]
    return Object.freeze({ text, ariaLabel: `Session status: ${text}` })
  } catch {
    return null
  }
}

export function chatHeaderBranchCopy(record) {
  try {
    if (!recordObject(record)
        || record.source !== 'git'
        || typeof record.name !== 'string'
        || typeof record.dirty !== 'boolean') return null
    const name = record.name.trim()
    if (!name) return null
    const text = `${name}${record.dirty ? ' *' : ''}`
    const ariaLabel = record.dirty
      ? `Git branch: ${name}, uncommitted changes`
      : `Git branch: ${name}`
    return Object.freeze({ text, ariaLabel })
  } catch {
    return null
  }
}

export function chatHeaderContextCopy(record) {
  try {
    if (!recordObject(record)
        || record.source !== 'current-context'
        || !Number.isFinite(record.usedTokens)
        || !Number.isInteger(record.usedTokens)
        || record.usedTokens < 0
        || !Number.isFinite(record.capacityTokens)
        || !Number.isInteger(record.capacityTokens)
        || record.capacityTokens <= 0
        || record.usedTokens > record.capacityTokens) return null
    const text = `${record.usedTokens} / ${record.capacityTokens}`
    return Object.freeze({
      text,
      ariaLabel: `Current context: ${record.usedTokens} of ${record.capacityTokens} tokens`,
    })
  } catch {
    return null
  }
}

/* ---------------------------------------------------------- message timestamps */

export function chatMessageTimeCopy(at) {
  try {
    if (!Number.isFinite(at)) return null
    const date = new Date(at)
    if (!Number.isFinite(date.getTime())) return null
    const text = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    return Object.freeze({
      text,
      dateTime: date.toISOString(),
      ariaLabel: `Message time ${text}`,
    })
  } catch {
    return null
  }
}

/* ------------------------------------------------ inline file-change metadata */

export function chatDiffStatusText(status) {
  return status === 'A' || status === 'M' || status === 'D' || status === 'R' || status === 'C' ? status : ''
}

export function chatDiffPathText(path) {
  return typeof path === 'string' && path.length <= 4096 && path.trim() !== '' ? path : ''
}

export function chatDiffAddedText(added) {
  return Number.isFinite(added) && Number.isInteger(added) && added >= 0 ? `+${added}` : ''
}

export function chatDiffRemovedText(removed) {
  return Number.isFinite(removed) && Number.isInteger(removed) && removed >= 0 ? `-${removed}` : ''
}

export function chatDiffPositionText(activeIndex, total) {
  return Number.isInteger(activeIndex) && activeIndex >= 0
    && Number.isInteger(total) && total > 0 && activeIndex < total
    ? `${activeIndex + 1} of ${total}`
    : ''
}

export const CHAT_DIFF_OPEN_TEXT = 'Open diff'
export const CHAT_THINKING = 'Thinking'
export const CHAT_RESPONDING = 'Writing a reply'
export const CHAT_WAITING = 'Waiting for your approval'
export const chatUsingToolText = tool => tool ? `Using ${tool}` : 'Using a tool'
export const COMPOSER_SEND_HINT = 'Enter to send'

export function chatDiffOpenLabel(path) {
  const eligiblePath = chatDiffPathText(path)
  return eligiblePath ? `${CHAT_DIFF_OPEN_TEXT}: ${eligiblePath}` : CHAT_DIFF_OPEN_TEXT
}

/* ---------------------------------------------------------------- uptimeRing */

export const UPTIME_CAPTION = 'Server Uptime'

export const UPTIME_UNITS = Object.freeze({
  days: 'Days',
  hours: 'Hours',
  minutes: 'Minutes',
  seconds: 'Seconds',
})

/* ---------------------------------------------------------------- the composer */

export const NO_SENDER_WIRED = 'Nothing is connected to this box, so nothing typed here is sent.'

export const CANNOT_SEND_PLACEHOLDER = 'You cannot send a message here'
export const messagePlaceholder = title => `Message ${title}…`
export const messageAriaLabel = title => `Message ${title}`
export const SEND_LABEL = 'Send'
export const STOP_LABEL = 'Stop this reply'
export const STOP_TITLE = 'Stop what it is writing now — the session stays open'
export const STOP_FAILED = 'Nothing was stopped; the turn may already be over.'
export const DISCARDED_REPLY = 'Reply discarded.'
/* The guide's local-model stop uses the same truthful distinction: a stop
   request can succeed while finding no running work. Keep that outcome out of
   the renderer, and keep it separate from both a person-killed process and a
   process that failed. */
export const GUIDE_LOCAL_MODEL_STOP_IDLE = 'Nothing was stopped; the install or download may already be over.'
/* "this screen was not told why" was true when it was written and stopped being
   true once the send door began recording the refusal identifier on its note:
   the screen IS told, and deliberately does not put a machine code in front of a
   person. A product claiming an ignorance it no longer has is a sentence that
   survives into a support conversation and misdirects it.

   It also has to resolve what the person can see. A rejected send leaves their
   words on screen as their own bubble -- deliverTurn paints it optimistically
   and the .catch does not retract it -- so "that did not send" alone reads
   against a message sitting right there, and the one thing they need to know is
   whether it arrived. */
export const SEND_FAILED = 'That did not send, so the agent did not receive it. Your message is still shown above. Try once more; if it keeps happening, reload the page.'
/* ONE SENTENCE PER DOOR, BECAUSE ONE SENTENCE WAS ONLY TRUE AT ONE OF THEM.

   All three queue doors showed "That was not queued." It is true when an
   enqueue fails. At the Send next door and the Send-now hold door the message
   was ALREADY queued and it is the move that failed, so that sentence told the
   person their message was not queued while they were looking at it waiting in
   the strip -- the product contradicting the screen.

   Only the enqueue door can promise the words are still in the composer, and
   there it is worth saying: send() does not clear input.value when the enqueue
   fails, and nothing else on screen says so. */
export const QUEUE_FAILED = 'That was not queued, and your message is still in the box. Try again in a moment.'
export const QUEUE_PROMOTE_FAILED = 'That did not move. The message is still waiting where it was.'
export const QUEUE_HOLD_FAILED = 'Send now did not start. The message is still waiting where it was.'

/* ---------------------------------------------------------------- header controls */

export const SEARCH_TOGGLE_LABEL = 'Search this conversation'
export const SEARCH_BUTTON_TEXT = 'Search'
export const SEARCH_INPUT_LABEL = 'Search messages'
export const SEARCH_INPUT_PLACEHOLDER = 'Search messages…'
export const EXPAND_LABEL = 'Expand to fill the tree'
export const COLLAPSE_LABEL = 'Collapse'

/* ---------------------------------------------------------------- the tool buttons */

export const ATTACH_LABEL = 'Attach an image'
export const ATTACH_TITLE = 'Attach an image — it rides with your next message'
export const ATTACH_RIDES_SUFFIX = ' — rides with your next message.'
export const ATTACHMENT_REMOVE_TEXT = 'Remove'
export const attachmentFilenameText = path => typeof path === 'string'
  ? path.split(/[\\/]/).filter(Boolean).pop() || ''
  : ''
export const attachmentRemoveLabel = filename => `Remove ${filename} from this message`
export function attachmentSizeText(size) {
  if (!Number.isFinite(size) || !Number.isInteger(size) || size < 0) return ''
  if (size < 1024) return `${size} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = size / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`
}
export const MENTION_LABEL = 'Mention a file'
export const MENTION_TITLE = 'Mention a file — its path is written into your message'
export const mentionInsertText = path => `Read ${path} and use it for what I ask next.`
export const ACTIONS_LABEL = 'Actions'
export const ACTIONS_TITLE = 'Actions for this agent — stop, thinking depth, model, rewind and more'
export const ACTIONS_FILTER_PLACEHOLDER = 'Filter actions, or type a /command…'
/* THE PALETTE IS ALSO THE COMMAND LINE (owner, 2026-09-15: "i want to be able
   to manually add on the page as well as manually direct"). The slash key
   opens this palette from an empty box, which meant a typed "/Request keep it
   short" had nowhere to land: the slash was swallowed and the words only
   filtered a list that has no such row. Now the slash lands in the filter,
   what follows it is a command line, and Enter runs it exactly as if it had
   been sent from the box. */
export const ACTIONS_TYPED_RUN = command => `Run ${command}`
export const ACTIONS_TYPED_HINT = 'Enter sends it as a typed command. /Request files a standing rule. /RequestTree covers this circle and everything under it. /goal records a goal, /queue queues words, /interrupt stops the turn, /help lists them all.'
export const ACTIONS_TYPED_EMPTY = 'Keep typing the command: /Request, /RequestTree, /RequestSession, /RequestThread, /goal, /queue, /interrupt, /help…'
export const ACTIONS_FILTER_LABEL = 'Filter actions'
export const ACTIONS_BACK = '‹ Back'
export const ACTIONS_NO_MATCH = 'No action matches that. Clear the filter to see them all.'
export const ACTION_RUN_FAILED = 'That did not happen. Try it again.'
/* AN EMPTY MENU AND A MENU THAT COULD NOT BE BUILT ARE DIFFERENT ANSWERS.
 *
 * MEASURED 2026-09-03 over the outside-control port: pressing Actions on a
 * tree circle and reading the popup back reported `rows: []` on every circle,
 * and the driver turned that into "no Resume row on this circle's palette" --
 * a claim about the product that nothing had established. The popup's builder
 * had thrown and the catch put an empty list on the glass, so "the list could
 * not be built" and "this agent has nothing you can do" looked identical to a
 * person and to a driver. These two are the words for the first of those; the
 * row carrying them is never filtered away, because a refusal that a filter
 * can hide is a refusal that comes back as an empty list. */
export const ACTIONS_BUILD_FAILED = 'These actions could not be listed'
export const actionsBuildFailedWhy = detail => 'Nothing was changed. Close this menu and open it again; '
  + `if it keeps happening, this is what stopped it: ${detail || 'it gave no reason'}.`

/* ---------------------------------------------------------------- the queue strip */

/* THREE DOORS, THREE HONEST ACTS -- not one button wearing two faces.
 *
 * It used to be one button that repainted itself: "Send now ... into the
 * running turn" in both states, and the engine refuses an overlapping send BY
 * DESIGN (AGENT_TURN_ACTIVE, shell/agent-host.cjs sendTurn) -- so while a
 * turn ran, that sentence named something no press could ever produce.
 * MEASURED 2026-09-03 on the real composer: the press re-queued the same
 * words at the BACK and printed a you-bubble for a message that had not gone
 * anywhere.
 *
 * The owner, 2026-09-04 (R14, verbatim): "the send now button just says send
 * and then the send next button just moves it around we need a thrid button
 * there for send now also." Three separate, always-present doors instead:
 * Send is the ordinary drain, live only while nothing is running. Send next
 * puts a row at the head of the queue -- unchanged from the old busy face.
 * Send now (R17, verbatim: "the user needs to be able to send a send now
 * that actually interrrupts the agent") is the one door that may stop a
 * running turn to deliver its row -- see components.js paintQueueStrip for
 * the cancel-then-halt-then-deliver sequence, which runs through the
 * composer's own runStop(), never a second stop implementation. */
/* QUEUE_SEND and QUEUE_SEND_LABEL are gone with the door they named (W18c,
   the owner: "in the qued items, no need for an additional send button it is
   already sent at that point"). Copy for a control nobody can press is worse
   than no copy: the next reader has to work out whether it is dead or merely
   unused. */
export const QUEUE_SEND_NOW = 'Send now'
export const QUEUE_SEND_NOW_LABEL = 'Send this message now, even if that means stopping what the agent is writing to do it'
export const QUEUE_SEND_NEXT = 'Send next'
export const QUEUE_SEND_NEXT_LABEL = 'Move this to the front — it goes the moment this turn finishes'
/* THE SAME BUTTON AT AN IDLE AGENT. A queued row is drawn when no turn is
   running too (a refused resume, an ended session), and "this turn" then
   names nothing. sendNextLabel picks by the composer's own busy reading. */
export const QUEUE_SEND_NEXT_LABEL_IDLE = 'Move this to the front — it goes as soon as this agent is back'
export function sendNextLabel({ turnRunning = false } = {}) {
  return turnRunning === true ? QUEUE_SEND_NEXT_LABEL : QUEUE_SEND_NEXT_LABEL_IDLE
}
export const QUEUE_UNQUEUE = 'Unqueue'
export const QUEUE_UNQUEUE_LABEL = 'Put this waiting message back in the box, unsent'
/* The up-arrow walk (src/composer-queue-recall.js) could not write the rewrite
   back. Said once, out loud, because a swallowed edit looks exactly like a
   saved one until the message sends with the old words in it. It names what
   the queue still holds so the person knows which copy is real. */
export const RECALL_EDIT_NOT_KEPT = 'Your change was not saved. The waiting message still says what it said before.'
export const RECALL_EDIT_ALREADY_SENT = 'The message you were editing was already sent as it was. Your edit is still in the box: press Enter to send it as a new message.'
export const WORKING_CANCEL = 'Cancel'

const imageMessageFailureReasons = Object.freeze({
  IMAGE_OUTBOX_FULL: 'The saved message history is full.',
  AGENT_TURN_ACTIVE: 'The agent was busy when this message tried to send.',
  IMAGE_OUTBOX_CLEANUP_REQUIRED: 'The saved message history needs repair.',
  IMAGE_OUTBOX_DESTINATION_STALE: 'This message is still attached to an earlier agent session.',
  MC_AGENT_UNKNOWN_SESSION: 'The agent session is no longer available.',
  IMAGE_QUEUE_SELECTION_CHANGED: 'The agent settings changed before this message could send.',
  IMAGE_CUSTODY_FULL: 'Saved image storage is full.',
  IMAGE_QUEUE_RESEND_UNAVAILABLE: 'This saved image message cannot be resent with the current settings.',
  IMAGE_QUEUE_READMISSION_UNCONFIRMED: 'The replacement message could not be confirmed.',
  IMAGE_OUTBOX_STALE: 'The saved image message changed before it could be resent.',
  AGENT_IMAGE_UNSUPPORTED: 'This agent could not accept the image.',
})
const imageMessageFailureReason = code => Object.hasOwn(imageMessageFailureReasons, code)
  ? imageMessageFailureReasons[code] : ''

// Retry eligibility does not prove that a retry is scheduled. A retained busy
// result can outlive its timers, and a held queue can still contain that result.
export function imageMessageStatusCopy(entry = {}, view = {}) {
  if (entry.state === 'unknown') return {
    label: 'Delivery unconfirmed',
    detail: 'The app cannot confirm whether the agent received this message. It will not be sent again automatically. Refresh to check its status.',
  }
  if (entry.state === 'dispatching') return {
    label: 'Checking delivery', detail: 'The app is checking whether the agent received this message.',
  }
  if (entry.state !== 'not-sent') return {
    label: 'Delivery unconfirmed', detail: 'Refresh to check whether the agent received this message.',
  }
  const code = view.state !== 'ready' && view.code ? view.code : entry.failure?.code || entry.code
  const reason = imageMessageFailureReason(code)
  const explain = text => [reason, text].filter(Boolean).join(' ')
  if (code === 'IMAGE_QUEUE_SELECTION_CHANGED') return {
    label: 'Saved · not sent',
    detail: explain('Send with current settings to retry, or Remove.'),
  }
  if (entry.reconcile === true) return {
    label: 'Saved · not sent',
    detail: explain('This attempt did not send, but its saved status still needs checking. Refresh to check its status. It will not be sent again automatically.'),
  }
  if (view.state !== 'ready') return {
    label: 'Saved · not sent',
    detail: explain(code === 'IMAGE_OUTBOX_CLEANUP_REQUIRED'
      ? 'Send again to retry the repair, or Remove.'
      : 'Sending is paused. Refresh to check its status.'),
  }
  if (entry.failure?.retryable === false || entry.retryable === false || code === 'IMAGE_OUTBOX_FULL') return {
    label: 'Saved · not sent',
    detail: explain('Send again to retry, or Remove.'),
  }
  if (entry.retryExhausted === true) return {
    label: 'Not sent · retries paused',
    detail: explain('Automatic retries are paused until the agent’s status changes. Send again to retry, or Remove.'),
  }
  if (entry.retryScheduled === true) return {
    label: 'Not sent · retry scheduled',
    detail: explain('Another send attempt is scheduled. The agent has not received this message yet.'),
  }
  if (entry.retryable === true && code === 'AGENT_TURN_ACTIVE') return {
    label: 'Not sent · waiting for agent',
    detail: explain('The message is saved while the agent becomes ready. Send again to retry, or Remove.'),
  }
  return {
    label: 'Saved · not sent',
    detail: explain('The message is saved and has not been sent. Send again to retry, or Remove.'),
  }
}

export function imageMessageActionFailureCopy(result, action) {
  const reason = imageMessageFailureReason(result?.code)
  const outcome = action === 'remove'
    ? 'Removal was not confirmed. Your image message is still saved. Refresh to check its status.'
    : result?.state === 'not-sent'
      ? 'Your image message is saved and was not sent. Refresh to check its status.'
      : 'Your image message is saved, but delivery was not confirmed. Refresh to check its status.'
  return [reason, outcome].filter(Boolean).join(' ')
}

export function imageDeliveryNotice(state = {}) {
  if (state.state === 'accepted') return 'Image message accepted by the agent.'
  if (state.state === 'cancelled') return 'Image message removed from the queue.'
  if (['not-sent', 'unknown', 'dispatching'].includes(state.state)) {
    const copy = imageMessageStatusCopy(state, { state: 'ready' })
    return `${copy.label}. ${copy.detail}`
  }
  return [imageMessageFailureReason(state.code),
    'Your image message is saved. Sending is paused. Refresh to check its status.'].filter(Boolean).join(' ')
}

const workingCounterSnapshot = (snapshot) => {
  const admitted = {}
  try {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return admitted
  } catch {
    return admitted
  }
  for (const key of ['tools', 'files', 'added', 'removed']) {
    try {
      if (!Object.hasOwn(snapshot, key)) continue
      const value = snapshot[key]
      if (Number.isFinite(value) && Number.isInteger(value) && value >= 0) admitted[key] = value
    } catch { /* one unreadable datum does not invent or erase another */ }
  }
  return admitted
}

export function chatWorkingCountersText(snapshot) {
  const admitted = workingCounterSnapshot(snapshot)
  const segments = []
  if (Object.hasOwn(admitted, 'tools')) {
    segments.push(admitted.tools === 1 ? '1 tool' : `${admitted.tools} tools`)
  }
  if (Object.hasOwn(admitted, 'files')) {
    segments.push(admitted.files === 1 ? '1 file' : `${admitted.files} files`)
  }
  const lines = []
  if (Object.hasOwn(admitted, 'added')) lines.push(`+${admitted.added}`)
  if (Object.hasOwn(admitted, 'removed')) lines.push(`−${admitted.removed}`)
  if (lines.length) segments.push(lines.join(' '))
  return segments.join(' · ')
}

export function chatWorkingCountersLabel(snapshot) {
  const admitted = workingCounterSnapshot(snapshot)
  const segments = []
  if (Object.hasOwn(admitted, 'tools')) {
    segments.push(admitted.tools === 1 ? '1 tool used' : `${admitted.tools} tools used`)
  }
  if (Object.hasOwn(admitted, 'files')) {
    segments.push(admitted.files === 1 ? '1 file touched' : `${admitted.files} files touched`)
  }
  if (Object.hasOwn(admitted, 'added')) {
    segments.push(admitted.added === 1 ? '1 line added' : `${admitted.added} lines added`)
  }
  if (Object.hasOwn(admitted, 'removed')) {
    segments.push(admitted.removed === 1 ? '1 line removed' : `${admitted.removed} lines removed`)
  }
  return segments.join(', ')
}

/* ---------------------------------------------------------------- the transcript */

export const EMPTY_LOG_NOTE = 'Nothing has been said here yet.'
/* WHAT A LIVE ROW SAYS BEFORE ANYTHING CLASSIFIED HAS ARRIVED. A turn can
   be accepted seconds before its first packet, and until one lands nothing
   is known about what this row will hold -- an answer, a run of tool calls,
   or nothing at all. It must therefore not claim to be the reply: it says
   the turn is running and where the words will appear, and it is replaced
   by the real content the moment the first classified event arrives. There
   is nothing for the person to do here but read the next line when it
   comes, and this says so rather than leaving a blank. */
export const STREAM_PENDING_NOTE = 'Working. The first words appear here as they arrive.'
/* T404. A REPLY THAT STOPS MID-ANSWER MUST NOT STOP SILENTLY.
   src/chat-readable-stream.js holds an unfinished table, link or code span at
   the tail so it is painted once rather than flickering into shape. That bet
   is right while packets keep coming and wrong the moment they stop: the
   person is then reading an answer that ends mid-sentence, with a row that
   still says it is working and nothing anywhere saying why. This names the
   state instead. It says what is true -- more of this reply has arrived than
   is shown, and it is waiting on the rest of a piece of formatting -- and it
   does not promise the turn will finish, because this row cannot know that.
   It is shown only once the wait outlasts a normal gap between packets; the
   delay lives in src/chat-presentation.css so an ordinary sub-frame hold
   never draws it. */
export const STREAM_HELD_NOTE = 'More of this reply has arrived and is waiting on the rest of a table, link or code block.'
export const newBelowCountLabel = n => `${n} new below`
export const NEW_BELOW_FALLBACK = 'New below'
export const resumedAtLabel = time => `Conversation resumed at ${time}`
export const typingLabel = title => `${title} is thinking`

/* Fallback words when the caller's own live-activity reader has nothing to
   say -- the seeded reply templates in src/vocab.js fill {{context}} with
   these when normalizeChatContext() comes back empty. Kept apart by role the
   templates already distinguish (coordinator vs. lane), same as before. */
export const CHAT_CONTEXT_FALLBACK = Object.freeze({
  coordinator: 'the directive queue is checked and no gate or territory change is pending',
  lane: 'the assigned task is moving through its current sweep',
})

/* ---------------------------------------------------------------- composer chips */

/* The always-visible chip row (design/chat/picked-card.png, "Dense —
   light-mode palette"). AGENT and the model chip show the CALLER's own
   words (a real tier label, a real model name) -- this module owns only the
   three chips whose text this component decides for itself. */
export const CHIP_EFFORT_LABEL = 'Effort'
export const CHIP_HALT_LABEL = 'Halt'
/* THE QUEUE AND SEND CHIPS ARE GONE, W18c, and so is their copy -- the count
   label, the three queue hints, and the SEND label. The owner: "under the
   arrow is a send and a que button. The arrow should send, the button below
   should be for send now." Both chips called the composer's own send(): SEND
   was the arrow spelled twice, and QUEUE was the arrow's busy branch spelled
   twice, since send() at a busy agent IS the queue. What no chip could do was
   interrupt, so the pair became one Send now, whose words are QUEUE_SEND_NOW
   above -- one label for one act, wherever it is offered. The waiting count
   those hints explained is still on screen: the queue strip lists every
   waiting row, above the composer, and unhides itself the moment one exists. */
export const CHIP_HALT_DISABLED_HINT = 'Nothing is running to stop.'
export const COMPOSER_PLACEHOLDER = 'Ask a follow-up or describe the next change…'

/* ---------------------------------------------------------------- the approval strip */

/* Only the STRUCTURE words -- what the strip itself says, not the decision.
   The decision words (Allow once / Refuse / …) stay in APPROVAL_PANEL, see
   the header. */
export const APPROVAL_STRIP_LABEL = 'Approval required'
export const APPROVAL_RETRY_HINT = 'That answer did not land. Press a choice again.'
