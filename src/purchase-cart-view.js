/* THE CART, TURNED INTO THE SENTENCES A PERSON READS.
 *
 * WHAT THE CART IS. There is exactly one, and this file does not hold it. It is
 * state/owner-public-prompts.json inside the engine, served over the audited
 * connection as GET /v1/owner-prompts, and every surface in this product is a
 * renderer of that one list. Nothing here caches a line, invents a line, or
 * totals anything the engine did not already total.
 *
 * WHY IT EXISTS ANYWAY. Four facts the owner asked to see were on the wire the
 * whole time and were never drawn:
 *
 *   1. WHEN IT DIES. Every request carries `expiresAt`. src/owner-popup.js
 *      validates it -- and then never renders it. His two live carts expire on
 *      2026-08-18 and no screen in the product says so.
 *
 *   2. THAT DYING IS DENIAL. The engine's own live() drops a record the moment
 *      its expiry passes, and settle() files it with the default decision,
 *      which is deny. So doing nothing is not neutral. The card today says
 *      "leaving this screen submits nothing and decides nothing", which is true
 *      about the button and silent about the calendar.
 *
 *   3. WHOSE IDEA A LINE WAS. The engine folds that into a text stamp on the
 *      front of `description` -- "[From your words: R1234] " -- and the screen
 *      renders the whole string raw. That prints an internal reference number
 *      on the owner's money surface. The fact is worth keeping; the number is
 *      not his to have to read. This splits them.
 *
 *   4. WHAT IT COSTS THE SECOND TIME. Several lines renew. See below.
 *
 * WHAT THIS FILE REFUSES TO ANSWER, AND WHY THAT IS THE POINT.
 *
 * Domains renew, the relay machine is monthly, the signing certificate is
 * monthly. None of that is a number anywhere on the wire: a purchase line has a
 * description, a merchant, a purpose and one amount, and the only statement of
 * renewal in the whole payload is English prose inside the purpose text.
 * Turning prose into a dollar figure on the screen where a person decides about
 * money is inventing a number. So every line reports a renewal cost of null and
 * carries the reason as a sentence, and the surface prints the sentence.
 *
 * THIS FILE IS PURE. It reads no file, opens no connection and touches no
 * document, so a test can call every function in it directly. That is the same
 * rule src/account-markup.js is built on, and for the same reason: two planted
 * defects on this tree survived every assertion that searched source text.
 *
 * IT HAS A SIBLING IN THE ENGINE. src/lib/purchase-cart-view.js there answers
 * the same questions for readers that hold the store file rather than the wire.
 * The two cannot import each other -- different repository, different module
 * system -- so tools/test/purchase-cart-view.test.mjs compares them line for
 * line whenever the engine checkout is reachable, and says so out loud when it
 * is not, rather than passing quietly.
 */

import { formatExactAmount } from './exact-amount.js'

const MS_PER_DAY = 86_400_000

/* The two stamps the engine writes onto the front of a description. They are
   matched here and removed, so what a person reads is the thing being bought
   and the badge is a sentence beside it. */
const OWNER_STAMP_RE = /^\[From your words: [^\]]+\] /
const AGENT_STAMP = '[AGENT-PROPOSED - not traceable to your words] '

/** Said on every line, short, because it is repeated once per line. */
export const RENEWAL_NOT_RECORDED = 'Not recorded on this line.'

/** Said once under a list, where there is room for the reason. */
export const RENEWAL_UNKNOWN =
  'Whether this repeats, and what it would cost the next time, is not recorded as a number anywhere. '
  + 'Read the purpose line above: where a line does repeat, it says so there in words.'

/** Said once at the foot of a cart, for the same reason. */
export const YEAR_COST_UNKNOWN =
  'A twelve-month cost is not shown here. Several of these renew and none of them carries a renewal amount, '
  + 'so a year figure would be a guess rather than a total.'

/** Restated wherever a total appears. Approving is a decision, not a payment. */
export const APPROVING_IS_NOT_BUYING =
  'Approving records your decision. It does not spend, does not use a card, and does not contact a merchant.'

export const OWNER_LINE = 'You asked for this.'
export const AGENT_LINE = 'Nobody asked for this. An agent suggested it.'
export const UNSTAMPED_LINE = 'Where this line came from is not recorded, so this does not claim either way.'

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Split "[From your words: R1234] Buy the thing" into the thing and the badge.
 *
 * A description carrying NEITHER stamp reports `unknown`, never `agent`. "We
 * could not tell" and "we checked, and this was not your idea" are different
 * claims about the owner's own words, and only one of them would be true.
 */
export function readProvenance(description) {
  if (typeof description !== 'string') throw new Error('purchase item description is malformed')
  if (description.startsWith(AGENT_STAMP)) {
    return Object.freeze({ provenance: 'agent', label: AGENT_LINE, text: description.slice(AGENT_STAMP.length) })
  }
  const owned = OWNER_STAMP_RE.exec(description)
  if (owned) {
    /* The reference number inside the stamp is deliberately dropped rather than
       shown. It means something in our records and nothing on his screen, and
       this product's rule is that a person is owed the label and never the key. */
    return Object.freeze({ provenance: 'owner', label: OWNER_LINE, text: description.slice(owned[0].length) })
  }
  return Object.freeze({ provenance: 'unknown', label: UNSTAMPED_LINE, text: description })
}

/**
 * How long is left, measured rather than described.
 *
 * Elapsed whole days round down. Calendar words use the same local dates as
 * the displayed expiry date: 23 hours can end tomorrow. UTC date keys keep
 * calendar distance independent of daylight-saving changes in elapsed hours.
 */
export function expiryOf(prompt, nowMs = Date.now()) {
  if (!plainObject(prompt)) throw new Error('owner prompt is malformed')
  const expiresAtMs = Date.parse(prompt.expiresAt)
  if (!Number.isFinite(expiresAtMs)) throw new Error('owner prompt expiry is malformed')
  const remainingMs = expiresAtMs - nowMs
  const expired = remainingMs <= 0
  const localDay = value => {
    const date = new Date(value)
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / MS_PER_DAY
  }
  return Object.freeze({
    expiresAt: prompt.expiresAt,
    expiresAtMs,
    expired,
    remainingMs: expired ? 0 : remainingMs,
    remainingDays: expired ? 0 : Math.floor(remainingMs / MS_PER_DAY),
    remainingCalendarDays: expired ? 0 : localDay(expiresAtMs) - localDay(nowMs),
  })
}

/** The deadline, as one short sentence. */
export function deadlineText(expiry) {
  if (expiry.expired) return 'The date on this has passed, so it is no longer waiting for you.'
  if (expiry.remainingCalendarDays === 0) return 'Expires today.'
  if (expiry.remainingCalendarDays === 1) return 'Expires tomorrow.'
  return `Expires in ${expiry.remainingCalendarDays} days.`
}

/** The date itself, spelled out, so the sentence above is checkable. */
export function deadlineDateText(expiry, locale = undefined) {
  if (!Number.isFinite(expiry.expiresAtMs)) return ''
  try {
    return new Date(expiry.expiresAtMs).toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' })
  } catch {
    return ''
  }
}

/**
 * What happens if he does nothing, which is different for each kind and must
 * not be softened into one sentence that covers all three. A shopping list and
 * a yes-or-no question are both refused at the deadline; a notice is only
 * marked as read, and calling that a refusal would be alarming and wrong.
 */
export function doNothingText(kind) {
  if (kind === 'purchase_batch') {
    return 'If you do nothing, every line here is denied on that date, and this list goes away. '
      + 'Nothing is bought either way, and nothing keeps waiting for you either.'
  }
  if (kind === 'notice') {
    return 'If you do nothing, this is marked as read on that date. Nothing else about it changes.'
  }
  return 'If you do nothing, this is denied on that date, and it stops being offered to you.'
}

/**
 * One line of a shopping list, ready to draw.
 *
 * `renewalCents` is null on every line and always will be until a line on the
 * wire can state one. It is present, and null, rather than absent, so a surface
 * has to decide what to print for an unknown instead of quietly omitting it.
 */
export function viewLine(item) {
  if (!plainObject(item)) throw new Error('purchase item is malformed')
  if (!Number.isSafeInteger(item.amountCents) || item.amountCents < 0) throw new Error('purchase item amount is malformed')
  const from = readProvenance(item.description)
  return Object.freeze({
    id: String(item.id),
    text: from.text,
    provenance: from.provenance,
    provenanceLabel: from.label,
    amountCents: item.amountCents,
    currency: String(item.currency),
    amountText: formatExactAmount(item.amountCents, item.currency),
    merchant: String(item.merchant),
    purpose: String(item.purpose),
    renewalCents: null,
    renewalUnknownReason: RENEWAL_UNKNOWN,
  })
}

/** One request -- a shopping list, a question, or a notice -- ready to draw. */
export function viewPrompt(prompt, nowMs = Date.now()) {
  if (!plainObject(prompt)) throw new Error('owner prompt is malformed')
  const expiry = expiryOf(prompt, nowMs)
  const base = {
    id: String(prompt.id),
    kind: String(prompt.kind),
    title: String(prompt.title),
    expiresAt: expiry.expiresAt,
    expiresAtMs: expiry.expiresAtMs,
    expired: expiry.expired,
    remainingDays: expiry.remainingDays,
    remainingCalendarDays: expiry.remainingCalendarDays,
    deadline: deadlineText(expiry),
    deadlineDate: deadlineDateText(expiry),
    doNothing: doNothingText(prompt.kind),
  }
  if (prompt.kind !== 'purchase_batch') {
    return Object.freeze({ ...base, lines: Object.freeze([]), totalCents: null, currency: null, totalText: null })
  }
  if (!Array.isArray(prompt.items)) throw new Error('purchase batch has no items')
  const lines = prompt.items.map(viewLine)
  const summed = lines.reduce((sum, line) => sum + line.amountCents, 0)
  /* The renderer already refuses a total that is not the sum of its lines. This
     repeats the refusal because a second surface will trust THIS, and a view
     that quietly re-added the lines itself would make a drifted cart look
     correct on the one screen where correctness is the product. */
  if (summed !== prompt.totalCents) throw new Error('purchase total is not bound to its line items')
  return Object.freeze({
    ...base,
    lines: Object.freeze(lines),
    totalCents: prompt.totalCents,
    currency: String(prompt.currency),
    totalText: formatExactAmount(prompt.totalCents, prompt.currency),
    yearCostUnknownReason: YEAR_COST_UNKNOWN,
    ownerLineCount: lines.filter(line => line.provenance === 'owner').length,
    agentLineCount: lines.filter(line => line.provenance === 'agent').length,
    unknownLineCount: lines.filter(line => line.provenance === 'unknown').length,
  })
}

/**
 * The whole queue, summarised for a screen that has room for a few lines.
 *
 * `readable` is false whenever the queue could not be read, and then every
 * count is null rather than zero. "Nothing is waiting" and "I could not look"
 * are different sentences, and a summary that reported the second as the first
 * would tell somebody his money decisions were settled when they are not.
 */
export function cartSummary(prompts, nowMs = Date.now()) {
  if (!Array.isArray(prompts)) {
    return Object.freeze({
      readable: false, cartCount: null, lineCount: null, waitingCount: null,
      totalCents: null, currency: null, totalText: null, soonest: null,
      mixedCurrency: false, spendNotice: APPROVING_IS_NOT_BUYING,
    })
  }
  const views = prompts.map(prompt => viewPrompt(prompt, nowMs))
  const carts = views.filter(view => view.kind === 'purchase_batch')
  const currencies = new Set(carts.map(cart => cart.currency))
  /* Only add up what is genuinely comparable. Two currencies get no invented
     exchange rate; the total goes away and the count stands in its place. */
  const single = currencies.size === 1 ? [...currencies][0] : null
  const totalCents = single === null ? null : carts.reduce((sum, cart) => sum + cart.totalCents, 0)
  const soonest = views.reduce((earliest, view) => (
    earliest === null || view.expiresAtMs < earliest.expiresAtMs ? view : earliest
  ), null)
  return Object.freeze({
    readable: true,
    prompts: Object.freeze(views),
    carts: Object.freeze(carts),
    cartCount: carts.length,
    lineCount: carts.reduce((sum, cart) => sum + cart.lines.length, 0),
    waitingCount: views.length,
    totalCents,
    currency: single,
    totalText: totalCents === null ? null : formatExactAmount(totalCents, single),
    mixedCurrency: carts.length > 0 && single === null,
    soonest: soonest === null ? null : Object.freeze({
      title: soonest.title,
      deadline: soonest.deadline,
      deadlineDate: soonest.deadlineDate,
      doNothing: soonest.doNothing,
      remainingDays: soonest.remainingDays,
      remainingCalendarDays: soonest.remainingCalendarDays,
    }),
    spendNotice: APPROVING_IS_NOT_BUYING,
  })
}
