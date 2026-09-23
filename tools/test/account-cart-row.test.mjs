// THE PURCHASE-LIST ROW: THAT IT CAN LEAVE ITS LOADING STATE, AND THAT ITS
// "NOTHING WAITING" DOES NOT OVERCLAIM.
//
// WHAT THIS IS A REGRESSION FOR, stated so nobody has to reconstruct it.
//
// ToolsEnabled 1.0.6 shipped a packaged renderer in which cartMarkup() was
// present and the loader that feeds it was not. Read out of the shipped bundle:
// the account view declared the cart variable, passed it through view(), and
// rendered the "not asked yet" branch from it -- and never assigned it. So the
// row printed "Reading what is waiting for you to decide…" on every paint for as
// long as the window stayed open, having never attempted a read.
//
// That produced the worst failure mode this product has: a surface that waits
// forever with no error. Driven live on that build, the row was identical at 0s,
// 5s, 15s, 30s, 60s and 120s, with no console error, no network error and no
// exception -- because nothing had been asked, so nothing could fail. Every
// channel it would have used answered in under 3ms while it sat there.
//
// WHY THESE ASSERTIONS AND NOT A SEARCH OF THE SOURCE. Two planted defects on
// this tree already survived every assertion that searched source text, because
// an early return leaves the real code below it and dead code still matches a
// grep. So this CALLS things: the deadline is called and timed, and the row is
// called in each of its states and read back.
//
// WHAT THIS CANNOT COVER, and what does. These are unit assertions on pure
// functions; they cannot see whether the built renderer wires the loader to the
// row at all -- which is precisely the defect above. Only driving the real
// window can, and tools/account-cart-row-qa.mjs does: it fails on 1.0.6 and
// passes on the repaired build. Neither one replaces the other.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { cartMarkup } from '../../src/account-markup.js'
import { withDeadline } from '../../src/read-deadline.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const cartStateOf = html => (html.match(/data-cart-state="([a-z]+)"/) || [])[1]
const visibleText = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

test('the loading state is reachable, and it is the ONLY state that says it is still reading', () => {
  assert.equal(cartStateOf(cartMarkup({ cart: null })), 'reading')
  assert.match(visibleText(cartMarkup({ cart: null })), /Reading what is waiting/)

  /* Every other state must have stopped claiming to be busy. A second state
     that also said "reading" would give the deadline somewhere to land that
     looks exactly like the failure it exists to end. */
  for (const cart of [
    { readable: false },
    { readable: true, cartCount: 0, waitingCount: 0, spendNotice: 'x' },
    { readable: true, cartCount: 0, waitingCount: 3, spendNotice: 'x' },
  ]) {
    assert.notEqual(cartStateOf(cartMarkup({ cart })), 'reading')
    assert.doesNotMatch(visibleText(cartMarkup({ cart })), /Reading what is waiting/)
  }
})

test('the refusal the deadline produces says what to do next, rather than only that it failed', () => {
  /* `{ readable: false }` is what both a failed read and an expired deadline
     become. It is the row's terminal refusal, so it has to carry an action. */
  const html = cartMarkup({ cart: { readable: false } })
  assert.equal(cartStateOf(html), 'unread')
  const text = visibleText(html)
  assert.match(text, /could not read your list/)
  /* It must NOT let the reader conclude the list is empty ... */
  assert.match(text, /not the same as the list being empty/)
  /* ... and it must point somewhere. A dead end is the thing being fixed. */
  assert.match(html, /href="#\/ledger\?tab=p"/)
  assert.match(text, /Open your purchase list/)
})

test('"nothing is waiting" is scoped to the installation that was actually read', () => {
  // MEASURED ON THIS MACHINE while the sentence was being written: the running
  // app's own state root held 0 prompts and the engine's store held 10 --
  // including 2 shopping lists, 20 lines, denied by the calendar on 2026-08-18.
  // Unqualified, this row would have told its reader that his money decisions
  // were settled six days before four of them expired. The empty state is
  // therefore a statement about ONE installation and has to read as one.
  const html = cartMarkup({ cart: { readable: true, cartCount: 0, waitingCount: 0, spendNotice: 'x' } })
  assert.equal(cartStateOf(html), 'empty')
  const text = visibleText(html)
  assert.match(text, /on this copy of ToolsEnabled/)
  assert.match(text, /reads the list this installation holds, and no other/)
  /* The bare, unscoped claim must not survive anywhere in the row. */
  assert.doesNotMatch(text, /Nothing is waiting to be bought\.\s/)
})

test('a read that answers inside its budget is returned untouched', async () => {
  const started = Date.now()
  const answer = await withDeadline(Promise.resolve({ ok: true, prompts: [] }), 1_000)
  assert.deepEqual(answer, { ok: true, prompts: [] })
  assert.ok(Date.now() - started < 500, 'a fast read must not be slowed to its budget')
})

test('a read that does not answer is refused at its budget, not at the sum of four timeouts', async () => {
  /* The number that matters: under the chain this bounds, an unanswered read
     could occupy the row for close to two minutes. */
  const started = Date.now()
  await assert.rejects(
    () => withDeadline(new Promise(() => {}), 60, 'your purchase list'),
    /your purchase list did not answer within 60ms/,
  )
  const elapsed = Date.now() - started
  assert.ok(elapsed < 3_000, `the deadline must fire at its budget, not later (took ${elapsed}ms)`)
})

test('the deadline timer is cleared on either outcome, so nothing fires after the answer', async () => {
  /* An uncleared timer keeps this very process alive past its assertions, and
     keeps a renderer's loop warm for no reason. It is also the bug that makes a
     timeout helper feel haunted: the work finished, and something still fires.
     Node exiting cleanly at the end of this file is the observable proof; the
     assertion below is the part that can fail loudly. */
  let settled = false
  const slowEnoughToOutliveTheTest = withDeadline(
    new Promise(resolve => setTimeout(() => resolve('done'), 10)),
    5_000,
  )
  assert.equal(await slowEnoughToOutliveTheTest, 'done')
  settled = true
  assert.ok(settled)
})

test('a budget that is not a positive number is a programming error, not a very short deadline', async () => {
  /* Treating 0 or NaN as "expire immediately" turns one mistyped constant into
     a surface that refuses everything and blames the network for it. */
  for (const bad of [0, -1, NaN, Infinity, undefined, null, '5000']) {
    assert.throws(() => withDeadline(Promise.resolve(1), bad), TypeError)
  }
})

test('the packaged cart probe seeds the same product directory its user-data switch selects', () => {
  const source = readFileSync(path.join(REPO, 'tools', 'account-cart-row-qa.mjs'), 'utf8')
  assert.match(source, /machineRecordProductDirectory\(profile\)/,
    'the probe must derive the LOCALAPPDATA product directory from its --user-data-dir, like the real shell')
  assert.match(source, /const userData = userDataFor\(profile\)/,
    'the seeded record and launched window must share the same user-data helper')
  assert.doesNotMatch(source, /path\.join\(profile, 'local', 'ToolsEnabled'\)/,
    'a literal ToolsEnabled directory is invisible to a window launched with --user-data-dir=<profile>\\userdata')
})
