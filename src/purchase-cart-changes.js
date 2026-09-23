/* WHAT CHANGED IN THE CART, RATHER THAN JUST A NEW TOTAL.
 *
 * THE DEFECT THIS ENDS. The approvals screen polls every two seconds and
 * reconciles in silence: src/ledger-prompt-queue.js removes the cards that are gone
 * and appends the ones that are new, and the only visible trace is that the
 * total on the tile is a different number than it was a moment ago. A person
 * watching his own money list therefore learns THAT something moved and never
 * WHAT moved. That is the difference between a screen he can trust and a screen
 * he has to re-read from the top every time he looks at it.
 *
 * SO THIS COMPARES TWO READINGS AND WRITES THE DIFFERENCE IN SENTENCES. Lines
 * added, lines gone, an amount that is not what it was, a deadline that moved, a
 * whole list that appeared or left. Each one names the thing, not a count.
 *
 * WHAT IT IS NOT, STATED RATHER THAN DISCOVERED.
 *
 *   IT IS NOT A HISTORY. It lives in this window's memory and is empty again
 *   when the program is reopened, exactly like src/approval-outcomes.js and for
 *   the same reason: owner decisions are the engine's to keep, and a renderer
 *   that wrote its own durable copy of his money list would be the second list
 *   this whole design exists to prevent. The screen says this out loud.
 *
 *   IT DOES NOT KNOW WHY. A list that leaves the queue either was decided or
 *   ran out of time, and nothing on the wire distinguishes those two. So the
 *   sentence names both possibilities instead of picking one.
 *
 *   IT COMPARES WHAT WAS DRAWN, NOT WHAT WAS SENT. Both readings are the
 *   projected shape from src/purchase-cart-view.js, so a change in a field no
 *   screen shows cannot produce a line here claiming something a person can see
 *   is different.
 */

const MAX_REMEMBERED = 40

/** Fired on `window` when the set of changes grows, so a screen already on the
 *  glass does not have to wait out its own poll to say what moved. */
export const CART_CHANGE_EVENT = 'mc:cart-changed'

/* promptId -> the last drawn shape of that request. */
let previous = null
/* Prompt ids a purchases reset has just cleared: when they leave the queue,
   the sentence says the reset cleared them (T1532). */
let clearedByReset = new Set()
/* Newest first. Renderer memory; see the header. */
let changes = []

function indexLines(view) {
  const byId = new Map()
  for (const line of view.lines) byId.set(line.id, line)
  return byId
}

function snapshotOf(views) {
  const byId = new Map()
  for (const view of views) {
    byId.set(view.id, {
      id: view.id,
      kind: view.kind,
      title: view.title,
      expiresAt: view.expiresAt,
      deadlineDate: view.deadlineDate,
      totalCents: view.totalCents,
      totalText: view.totalText,
      lines: indexLines(view),
    })
  }
  return byId
}

/**
 * Compare two readings and say what moved, in sentences.
 *
 * @param {Map} before  the previous reading, or null for the first one
 * @param {Map} after   this reading
 * @returns {Array} newest-last list of {id, tone, text}; empty on a first
 *          reading, because there is genuinely nothing to compare against and
 *          inventing "everything is new" would flood the screen on every launch.
 */
export function describeCartChanges(before, after, atMs = Date.now(), cleared = new Set()) {
  if (!(before instanceof Map) || !(after instanceof Map)) return []
  const found = []
  const say = (tone, text) => found.push({ id: `${atMs}-${found.length}`, tone, text, atMs })

  for (const [id, now] of after) {
    const was = before.get(id)
    if (!was) {
      say('warn', now.kind === 'purchase_batch'
        ? `A new list is waiting for you: ${now.title}.`
        : `A new request is waiting for you: ${now.title}.`)
      continue
    }
    if (was.expiresAt !== now.expiresAt) {
      say('warn', `The date on ${now.title} moved. It is now ${now.deadlineDate}.`)
    }
    for (const [lineId, line] of now.lines) {
      const previousLine = was.lines.get(lineId)
      if (!previousLine) {
        say('warn', `Added to ${now.title}: ${line.text}, at ${line.amountText}.`)
        continue
      }
      if (previousLine.amountCents !== line.amountCents) {
        say('warn', `The amount for ${line.text} changed. It was ${previousLine.amountText} and it is now ${line.amountText}.`)
      }
      if (previousLine.text !== line.text) {
        say('warn', `A line on ${now.title} was reworded. It now reads: ${line.text}.`)
      }
    }
    for (const [lineId, line] of was.lines) {
      if (!now.lines.has(lineId)) say('good', `Taken off ${now.title}: ${line.text}.`)
    }
  }

  for (const [id, was] of before) {
    if (after.has(id)) continue
    /* NOT "approved" and not "expired". Both leave the queue the same way and
       nothing on the wire says which happened, so the sentence names both. */
    if (cleared.has(id)) { say('good', `${was.title} was cleared by your purchases reset.`); continue }
    say('good', `${was.title} is no longer waiting for you. Either you decided it, or its date passed.`)
  }
  return found
}

/**
 * File this reading and return what changed since the last one.
 *
 * The first call establishes the baseline and reports nothing, which is why
 * `firstReading` is on the result: the screen has to be able to say "this is the
 * first look" rather than showing an empty list that reads as "nothing has
 * changed since you last checked".
 */
export function recordCartReading(views, atMs = Date.now()) {
  if (!Array.isArray(views)) return Object.freeze({ firstReading: false, added: Object.freeze([]) })
  const next = snapshotOf(views)
  const firstReading = previous === null
  const added = firstReading ? [] : describeCartChanges(previous, next, atMs, clearedByReset)
  for (const id of clearedByReset) if (!next.has(id)) clearedByReset.delete(id)
  previous = next
  if (added.length > 0) {
    changes = [...added.reverse(), ...changes].slice(0, MAX_REMEMBERED)
    announce()
  }
  return Object.freeze({ firstReading, added: Object.freeze(added) })
}

function announce() {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
  try { window.dispatchEvent(new CustomEvent(CART_CHANGE_EVENT, { detail: { count: changes.length } })) }
  catch { /* a window that cannot take an event still has the list below */ }
}

/** Newest first. A copy, so a screen cannot edit the record it is reading. */
export function cartChanges() {
  return changes.map(entry => Object.freeze({ ...entry }))
}

export function cartChangeCount() {
  return changes.length
}

/** Used by the tests, and by src/main.js on every DATA_SOURCE_EVENT (which a
 *  sign-in or sign-out on the website always fires -- see that module's own
 *  header), because a sign-out must not leave one account's money list on the
 *  screen of the next person to sign in. */
export function resetCartChanges() {
  previous = null
  changes = []
  clearedByReset = new Set()
}

/**
 * A purchases reset has just finished, and `remaining` is the queue as read
 * right after it. Every request last drawn that is not in it was cleared by
 * the reset -- not decided, not expired -- and the next reading says so
 * (T1532). Answers the ids it attributed.
 */
export function noteResetClears(remaining) {
  if (!(previous instanceof Map)) return []
  const still = new Set(Array.isArray(remaining) ? remaining.map(String) : [])
  const cleared = [...previous.keys()].filter(id => !still.has(id))
  for (const id of cleared) clearedByReset.add(id)
  return cleared
}
