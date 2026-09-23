/* THE PURCHASE LIST, AS A THING A PERSON CAN READ.
 *
 * The owner asked for his cart to be in front of him in his signed-in account,
 * readable, current, and honest about what happens if he does nothing. These
 * assertions are about the five ways that goes wrong, and every one of them was
 * a real state of this tree before the code under test existed:
 *
 *   1. THE DEADLINE WAS INVISIBLE. `expiresAt` has been on every request since
 *      the beginning and src/owner-popup.js validated it and drew it nowhere.
 *      Both of his live shopping lists expire on 2026-08-18.
 *
 *   2. DOING NOTHING LOOKED NEUTRAL. The engine refuses a request the moment its
 *      date passes. The card said "leaving this screen decides nothing", which
 *      is true about the button and silent about the calendar.
 *
 *   3. AN INTERNAL REFERENCE NUMBER WAS ON HIS MONEY SCREEN. The engine stamps
 *      "[From your words: R1234] " onto the front of a description and the row
 *      printed the whole string.
 *
 *   4. A CHANGE WAS INVISIBLE. The queue is re-read every two seconds and
 *      reconciled in silence, so a line appearing showed up only as a different
 *      number on a tile.
 *
 *   5. AN UNREADABLE QUEUE COULD READ AS AN EMPTY ONE. That is the worst of the
 *      five: it would tell him his money decisions were settled on the day four
 *      of them expire.
 *
 * NOTHING HERE SPENDS, DECIDES, OR ENQUEUES. Every function under test is pure,
 * and the two that read the owner's real queue read it and print counts.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  AGENT_LINE,
  OWNER_LINE,
  RENEWAL_NOT_RECORDED,
  UNSTAMPED_LINE,
  YEAR_COST_UNKNOWN,
  cartSummary,
  deadlineText,
  doNothingText,
  expiryOf,
  readProvenance,
  viewPrompt,
} from '../../src/purchase-cart-view.js'
import { describeCartChanges, cartChanges, recordCartReading, resetCartChanges } from '../../src/purchase-cart-changes.js'
import { cartMarkup, signedInMarkup } from '../../src/account-markup.js'
import { describeHome } from '../../src/local-activity.js'
import { renderOwnerPrompt } from '../../src/owner-popup.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')
const NOW = Date.parse('2026-08-12T12:00:00.000Z')

const line = (over = {}) => ({
  id: 'line-com',
  description: '[From your words: R1234] toolsenabled.com - first-year registration',
  amountCents: 1_108,
  currency: 'USD',
  merchant: 'Porkbun',
  purpose: 'The address the product is reached at.',
  ...over,
})

const batch = (over = {}) => ({
  id: 'batch-1',
  kind: 'purchase_batch',
  title: 'ToolsEnabled launch',
  message: 'Approve or deny each line.',
  createdAt: '2026-08-11T16:00:00.000Z',
  expiresAt: '2026-08-18T16:36:57.941Z',
  state: 'pending',
  defaultDecision: 'deny',
  currency: 'USD',
  totalCents: 1_108,
  items: [line()],
  ...over,
})

const question = (over = {}) => ({
  id: 'confirm-1',
  kind: 'confirmation',
  title: 'Payment path',
  message: 'Use Stripe to collect money.',
  createdAt: '2026-08-11T16:00:00.000Z',
  expiresAt: '2026-08-17T00:00:00.000Z',
  state: 'pending',
  defaultDecision: 'deny',
  ...over,
})

/* ---- 1. calendar labels agree with the displayed local date ---- */

test('deadline labels use local calendar days while elapsed whole days round down', () => {
  const now = new Date(2026, 7, 12, 12).getTime()
  const expiresAt = new Date(2026, 7, 13, 11).toISOString()
  const hoursLeft = expiryOf({ expiresAt }, now)
  assert.equal(hoursLeft.remainingDays, 0, '23 hours left is not "1 day"')
  assert.equal(deadlineText(hoursLeft), 'Expires tomorrow.')
  assert.equal(hoursLeft.expiresAt, expiresAt)
  assert.equal(hoursLeft.expiresAtMs, Date.parse(expiresAt))

  const today = expiryOf({ expiresAt: new Date(2026, 7, 12, 13).toISOString() }, now)
  assert.equal(deadlineText(today), 'Expires today.')

  const dayLeft = expiryOf({ expiresAt: new Date(2026, 7, 13, 13).toISOString() }, now)
  assert.equal(deadlineText(dayLeft), 'Expires tomorrow.')

  const real = expiryOf(batch(), NOW)
  assert.equal(real.remainingDays, 6)
  assert.equal(deadlineText(real), 'Expires in 6 days.')

  const gone = expiryOf({ expiresAt: '2026-08-01T00:00:00.000Z' }, NOW)
  assert.equal(gone.expired, true)
  assert.equal(gone.remainingDays, 0)
  assert.match(deadlineText(gone), /no longer waiting for you/)
})

test('crossing local midnight changes tomorrow to today without changing the expiry instant', () => {
  const expiresAt = new Date(2026, 8, 9, 14, 5, 29).toISOString()
  const before = expiryOf({ expiresAt }, new Date(2026, 8, 8, 23, 59, 59).getTime())
  const after = expiryOf({ expiresAt }, new Date(2026, 8, 9, 0, 0, 0).getTime())
  assert.equal(deadlineText(before), 'Expires tomorrow.')
  assert.equal(deadlineText(after), 'Expires today.')
  assert.equal(before.expiresAtMs, after.expiresAtMs)
  const view = viewPrompt({ ...question(), expiresAt }, new Date(2026, 8, 8, 23, 59, 59).getTime())
  assert.equal(view.deadlineDate, new Date(expiresAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }))
  assert.equal(cartSummary([{ ...question(), expiresAt }], new Date(2026, 8, 8, 23, 59, 59).getTime()).soonest.remainingCalendarDays, 1)
})

/* ---- 2. doing nothing is never described as neutral ---- */

test('what happens if he does nothing is stated, and differs by kind', () => {
  assert.match(doNothingText('purchase_batch'), /every line here is denied/,
    'the engine refuses a shopping list at its expiry; a surface that implied otherwise would be wrong about his money')
  assert.match(doNothingText('confirmation'), /this is denied on that date/)
  /* A notice is acknowledged, never refused. Calling that a refusal would be
     alarming and false, and the engine files it with a different decision. */
  assert.match(doNothingText('notice'), /marked as read/)
  assert.doesNotMatch(doNothingText('notice'), /denied/)
})

test('every kind of request carries the deadline and the consequence on its card', () => {
  for (const prompt of [batch(), question(), { ...question(), kind: 'notice', defaultDecision: 'acknowledge' }]) {
    const view = viewPrompt(prompt, NOW)
    assert.ok(view.deadline.length > 0, `${prompt.kind} has no deadline sentence`)
    assert.ok(view.deadlineDate.length > 0, `${prompt.kind} does not spell its date out`)
    assert.ok(view.doNothing.length > 0, `${prompt.kind} does not say what silence does`)
  }
})

/* ---- 3. no reference number of ours reaches his screen ---- */

test('the provenance stamp becomes a sentence, and the reference number is dropped', () => {
  const owned = readProvenance('[From your words: R1234, R1203] Azure Artifact Signing')
  assert.equal(owned.provenance, 'owner')
  assert.equal(owned.text, 'Azure Artifact Signing', 'the stamp is still on the front of the name he reads')
  assert.equal(owned.label, OWNER_LINE)
  assert.doesNotMatch(`${owned.text} ${owned.label}`, /R1234|R1203/,
    'a record number of ours on the screen where he decides about money')

  const agent = readProvenance('[AGENT-PROPOSED - not traceable to your words] Weekly automated backups')
  assert.equal(agent.provenance, 'agent')
  assert.equal(agent.text, 'Weekly automated backups')
  assert.equal(agent.label, AGENT_LINE)

  /* NEITHER STAMP IS `unknown`, NEVER `agent`. "We could not tell" and "we
     checked, and this was not your idea" are different claims about his own
     words and only one of them would be true. */
  const bare = readProvenance('Something with no stamp at all')
  assert.equal(bare.provenance, 'unknown')
  assert.equal(bare.label, UNSTAMPED_LINE)
  assert.equal(bare.text, 'Something with no stamp at all')
})

test('the drawn card shows the thing being bought, not our stamp', () => {
  const { text, dialog } = renderCard(batch())
  assert.match(text, /toolsenabled\.com/)
  assert.doesNotMatch(text, /R1234/, 'the reference number is on the owner-facing card')
  assert.doesNotMatch(text, /From your words/, 'the raw stamp is on the owner-facing card')
  assert.match(text, new RegExp(OWNER_LINE.replace('.', '\\.')), 'the fact the stamp carried was dropped along with the number')
  assert.match(text, /Expires in 6 days/, 'the card still does not say when it dies')
  assert.match(text, /every line here is denied/, 'the card still does not say what silence does')
  assert.match(text, new RegExp(RENEWAL_NOT_RECORDED.replace(/\./g, '\\.')))
  assert.match(text, /twelve-month cost is not shown/)
  assert.equal(dialog.find(node => node.className === 'owner-popup-deadline')?.dataset.expired, 'false')
})

test('an agent-proposed line says so on the card, in words', () => {
  const { text } = renderCard(batch({
    items: [line({ description: '[AGENT-PROPOSED - not traceable to your words] Weekly automated backups', amountCents: 480 })],
    totalCents: 480,
  }))
  assert.match(text, new RegExp(AGENT_LINE.replace('.', '\\.')))
  assert.doesNotMatch(text, /AGENT-PROPOSED/, 'an identifier in capitals is not a sentence a person is owed')
})

/* ---- 4. what changed, not just a new total ---- */

test('a first reading files no changes, and says it is the first reading', () => {
  resetCartChanges()
  const reading = recordCartReading([viewPrompt(batch(), NOW)], NOW)
  assert.equal(reading.firstReading, true)
  assert.equal(reading.added.length, 0, 'a first look must not report every line as new on every launch')
  assert.equal(cartChanges().length, 0)
})

test('a line appearing, moving price, or leaving is named, not counted', () => {
  resetCartChanges()
  recordCartReading([viewPrompt(batch(), NOW)], NOW)
  const grown = recordCartReading([viewPrompt(batch({
    items: [line(), line({ id: 'line-ai', description: '[From your words: R1234] toolsenabled.ai', amountCents: 16_540 })],
    totalCents: 17_648,
  }), NOW)], NOW)
  assert.equal(grown.added.length, 1)
  assert.match(grown.added[0].text, /Added to ToolsEnabled launch: toolsenabled\.ai, at \$165\.40\./)

  const repriced = recordCartReading([viewPrompt(batch({
    items: [line({ amountCents: 1_200 }), line({ id: 'line-ai', description: '[From your words: R1234] toolsenabled.ai', amountCents: 16_540 })],
    totalCents: 17_740,
  }), NOW)], NOW)
  assert.equal(repriced.added.length, 1)
  assert.match(repriced.added[0].text, /was \$11\.08 and it is now \$12\.00/,
    'a changed amount must say what it was, or he is comparing against his own memory')

  const shrunk = recordCartReading([viewPrompt(batch({ items: [line({ amountCents: 1_200 })], totalCents: 1_200 }), NOW)], NOW)
  assert.equal(shrunk.added.length, 1)
  assert.match(shrunk.added[0].text, /Taken off ToolsEnabled launch: toolsenabled\.ai/)

  /* Newest first, so the thing that just happened is the thing he reads. */
  assert.match(cartChanges()[0].text, /Taken off/)
  assert.equal(cartChanges().length, 3)
  resetCartChanges()
})

test('a whole list leaving names both reasons, because nothing on the wire says which', () => {
  resetCartChanges()
  recordCartReading([viewPrompt(batch(), NOW)], NOW)
  const gone = recordCartReading([], NOW)
  assert.equal(gone.added.length, 1)
  assert.match(gone.added[0].text, /Either you decided it, or its date passed/,
    'a decided list and an expired list leave the queue identically, and guessing between them would be a claim we cannot make')
  resetCartChanges()
})

test('a deadline that moves is reported, because it decides everything under it', () => {
  const before = new Map([['batch-1', { id: 'batch-1', kind: 'purchase_batch', title: 'ToolsEnabled launch', expiresAt: '2026-08-18T16:36:57.941Z', deadlineDate: 'August 18, 2026', totalCents: 1_108, totalText: '$11.08', lines: new Map() }]])
  const after = new Map([['batch-1', { ...before.get('batch-1'), expiresAt: '2026-08-14T16:36:57.941Z', deadlineDate: 'August 14, 2026', lines: new Map() }]])
  const found = describeCartChanges(before, after, NOW)
  assert.equal(found.length, 1)
  assert.match(found[0].text, /The date on ToolsEnabled launch moved\. It is now August 14, 2026\./)
})

/* ---- 5. an absence is never rendered as a decision ---- */

test('a queue that could not be read is not a queue that is empty', () => {
  const unread = cartSummary(null, NOW)
  assert.equal(unread.readable, false)
  assert.equal(unread.cartCount, null, 'a count of zero over an unread queue is the one wrong thing this can say')
  assert.equal(unread.lineCount, null)
  assert.equal(unread.totalCents, null)

  const html = cartMarkup({ cart: unread })
  assert.match(html, /data-cart-state="unread"/)
  assert.match(html, /not the same as the list being empty/)
  assert.doesNotMatch(html, /Nothing is waiting to be bought/)
})

test('the account row draws four states, and never invents one', () => {
  assert.match(cartMarkup({ cart: null }), /data-cart-state="reading"/)
  assert.match(cartMarkup({ cart: cartSummary([], NOW) }), /data-cart-state="empty"/)

  const waiting = cartMarkup({ cart: cartSummary([batch(), question()], NOW) })
  assert.match(waiting, /data-cart-state="waiting"/)
  assert.match(waiting, /\$11\.08 if you approve every one/)
  assert.match(waiting, /1 line across 1 list/)
  /* The soonest thing on his real queue is a question, not a cart. A screen
     that clocked only the shopping lists would let the first deadline pass. */
  assert.match(waiting, /Payment path/)
  assert.match(waiting, /Expires in 4 days/)
  assert.match(waiting, /this is denied on that date/)
  assert.match(waiting, /does not spend/)
  assert.match(waiting, /href="#\/ledger\?tab=p"/, 'the row reports a cart it cannot be opened from')
  assert.doesNotMatch(waiting, /R1234/)
})

/* THE ROW IS ON THE SCREEN, not merely written.
 *
 * This file exists in the shape it does because two planted defects on this
 * tree survived every assertion that searched source text: dead code still
 * matches a search. So the signed-in screen is RENDERED and the row is looked
 * for in what came out. */
test('the cart row is actually on the signed-in account screen', () => {
  const signedIn = {
    available: true, signedIn: true, username: 'josh', displayName: 'Josh P',
    accountId: 'a1', accountCount: 1, signInMethod: 'local', canPersistSession: true,
  }
  const html = signedInMarkup({ state: signedIn, cart: cartSummary([batch(), question()], NOW) })
  assert.match(html, /data-account-cart\b/, 'the signed-in account screen does not show his purchase list')
  assert.match(html, /data-cart-state="waiting"/)
  assert.match(html, /\$11\.08/)
  assert.match(html, /href="#\/ledger\?tab=p"/)
  /* Not asked yet renders as not asked yet, on the real screen too. */
  assert.match(signedInMarkup({ state: signedIn }), /data-cart-state="reading"/)
})

/* TWO PRESSES OR FEWER FROM A SIGNED-IN HOME SCREEN, measured rather than
 * claimed. Home offers the queue directly, so it is one; the account screen
 * offers it as well, because that is where he asked for it to be. */
test('home offers the purchase list without going through anything else', () => {
  const home = describeHome({
    fleetConfigured: false,
    approvals: { readable: true, count: 10, undelivered: 0 },
    nowMs: NOW,
  })
  const row = home.facts.find(fact => fact.id === 'approvals')
  assert.ok(row, 'home no longer says anything about decisions waiting')
  assert.equal(row.href, '#/ledger?tab=p', 'the row on home does not go to the queue')
  assert.match(row.text, /10 decisions waiting for you/)
})

test('two currencies get a count and no invented exchange rate', () => {
  const mixed = cartSummary([batch(), batch({ id: 'batch-2', currency: 'JPY', totalCents: 973, items: [line({ id: 'line-jpy', currency: 'JPY', amountCents: 973 })] })], NOW)
  assert.equal(mixed.totalCents, null)
  assert.equal(mixed.mixedCurrency, true)
  assert.match(cartMarkup({ cart: mixed }), /more than one currency/)
})

test('a total that is not the sum of its own lines is refused, not re-added', () => {
  assert.throws(() => viewPrompt(batch({ totalCents: 99 }), NOW), /not bound to its line items/,
    'quietly re-totalling would make a drifted cart look correct on the one screen where correctness is the product')
})

test('no line claims a renewal cost, and the reason is a sentence rather than a blank', () => {
  const view = viewPrompt(batch(), NOW)
  assert.equal(view.lines[0].renewalCents, null)
  assert.match(view.lines[0].renewalUnknownReason, /not recorded as a number anywhere/)
  assert.equal(view.yearCostUnknownReason, YEAR_COST_UNKNOWN)
})

/* ---- the engine's own copy of these answers ---- */

/* THE SAME QUESTIONS ARE ANSWERED TWICE, IN TWO REPOSITORIES.
 *
 * The engine's src/lib/purchase-cart-view.js answers them for readers holding
 * the store file; this repo's src/purchase-cart-view.js answers them for the
 * two screens. They cannot import each other -- different repository, different
 * module system -- so the only thing standing between them and a slow drift is
 * a comparison, and a comparison that quietly passes when it cannot find the
 * other file is not one. This SAYS SO when the engine checkout is not here,
 * which is the same rule tools/check-test-inputs.mjs applies to every other
 * input this suite needs and git does not carry. */
function engineRoot() {
  const setting = path.join(REPO_ROOT, 'private', 'capability-source.owner.json')
  if (!existsSync(setting)) return null
  try {
    const configured = JSON.parse(readFileSync(setting, 'utf8'))?.path
    return typeof configured === 'string' && existsSync(configured) ? configured : null
  } catch {
    return null
  }
}

test('the engine answers the same questions the same way', async t => {
  const root = engineRoot()
  const module = root === null ? null : path.join(root, 'src', 'lib', 'purchase-cart-view.js')
  if (module === null || !existsSync(module)) {
    t.skip('the engine checkout named in private/capability-source.owner.json is not on this machine, so the two copies were NOT compared')
    return
  }
  const { createRequire } = await import('node:module')
  const engine = createRequire(import.meta.url)(module)

  /* The two split the same stamp the same way. */
  assert.equal(engine.readProvenance(line().description).text, readProvenance(line().description).text)
  assert.equal(engine.readProvenance('[AGENT-PROPOSED - not traceable to your words] x').provenance, 'agent-proposed')
  assert.equal(readProvenance('[AGENT-PROPOSED - not traceable to your words] x').provenance, 'agent')

  /* The two round the same deadline to the same whole day, which is the number
     his decision is actually made against. */
  for (const expiresAt of ['2026-08-13T11:00:00.000Z', '2026-08-13T13:00:00.000Z', '2026-08-18T16:36:57.941Z', '2026-08-01T00:00:00.000Z']) {
    const mine = expiryOf({ expiresAt }, NOW)
    const theirs = engine.viewPrompt({ ...question(), expiresAt }, NOW)
    assert.equal(mine.remainingDays, theirs.remainingDays, `the two disagree about how long is left on ${expiresAt}`)
    assert.equal(mine.expired, theirs.expired)
  }

  /* Both refuse a total that is not bound to its lines, rather than one of them
     printing a number the other would not. */
  assert.throws(() => engine.viewPrompt(batch({ totalCents: 99 }), NOW))
  assert.throws(() => viewPrompt(batch({ totalCents: 99 }), NOW))

  /* Neither invents a renewal figure. */
  assert.equal(engine.viewPrompt(batch(), NOW).items[0].recurrence, null)
  assert.equal(viewPrompt(batch(), NOW).lines[0].renewalCents, null)
})

test('the owner’s real queue projects without inventing anything', async t => {
  const root = engineRoot()
  const store = root === null ? null : path.join(root, 'state', 'owner-public-prompts.json')
  if (store === null || !existsSync(store)) {
    t.skip('the engine checkout named in private/capability-source.owner.json is not on this machine, so the live queue was NOT read')
    return
  }
  const { createRequire } = await import('node:module')
  const prompts = createRequire(import.meta.url)(path.join(root, 'src', 'lib', 'mission-bridge', 'owner-prompts.js'))
  const wire = typeof prompts.snapshot === 'function' ? prompts.snapshot() : null
  if (!wire || wire.ok !== true || !Array.isArray(wire.prompts)) {
    t.skip('the engine did not offer a queue in the expected shape, so the live queue was NOT read')
    return
  }
  const summary = cartSummary(wire.prompts, Date.now())
  assert.equal(summary.readable, true)
  for (const cart of summary.carts) {
    assert.equal(cart.totalCents, cart.lines.reduce((sum, item) => sum + item.amountCents, 0))
    for (const item of cart.lines) {
      assert.doesNotMatch(item.text, /^\[/, 'a stamp survived onto the name he reads')
      assert.doesNotMatch(item.text, /\bR\d{3,4}\b/, 'a record number of ours survived onto his money surface')
      assert.equal(item.renewalCents, null)
    }
  }
  /* Printed rather than asserted: the queue is his and it moves. What is
     asserted above is that whatever is in it adds up and carries no stamp. */
  t.diagnostic(`live queue: ${summary.waitingCount} waiting, ${summary.cartCount} list(s), ${summary.lineCount} line(s), soonest ${summary.soonest ? summary.soonest.deadline : 'none'}`)
})

/* ---- the small fake document these cards are drawn into ---- */

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName
    this.children = []
    this.attributes = new Map()
    this.dataset = {}
    this.className = ''
    this._text = ''
    this.disabled = false
  }
  set textContent(value) { this._text = String(value); this.children = [] }
  get textContent() { return this.children.length ? this.children.map(child => `${child.textContent} `).join('') : this._text }
  append(...nodes) { for (const node of nodes) this.children.push(node) }
  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null }
  addEventListener() {}
  walk(visit) { visit(this); for (const child of this.children) child.walk?.(visit) }
  find(predicate) {
    let hit = null
    this.walk(node => { if (!hit && predicate(node)) hit = node })
    return hit
  }
}

function renderCard(prompt) {
  const documentRef = { createElement: tag => new FakeElement(tag) }
  const rendered = renderOwnerPrompt(documentRef, prompt, { dismiss() {}, submit() {} }, { surface: 'screen', now: NOW })
  return { text: rendered.dialog.textContent, dialog: rendered.dialog }
}
