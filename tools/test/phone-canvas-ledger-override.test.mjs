import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { phoneCanvasDecision, readPhoneCanvasEnvironment } from '../../src/phone-canvas.js'

const CANVAS_SOURCE = readFileSync(new URL('../../src/phone-canvas.js', import.meta.url), 'utf8')

/* THE LEDGER LINK'S OWN OVERRIDE (M2, owner-approved).
 *
 * /app/?ledger=1 is ITSELF the deliberate act — someone followed the mobile
 * page's own link, asking for the phone surface by name — so ledgerRoute
 * ALONE bypasses the pointer:coarse gate, with no need for `choice` to also
 * be explicitly stored as 'on' first. A conjunction of the two was tried
 * here first and rejected: nothing in the shipped product writes choice='on'
 * today, so requiring it as well would have meant the override could never
 * fire in practice on any build that exists right now — caught by mutation-
 * testing the conjunction and finding it structurally dead code (deleting it
 * changed no test's outcome), not by inspection.
 *
 * This is the genuinely NEW half of the disjunction: `choice === 'on'`
 * (phoneCanvasDecision, above this branch) already bypasses everything
 * unconditionally, from any route, and stays exactly as it is — untouched by
 * this addition, so a future settings control that writes it keeps working
 * exactly as it does today. No width or height floor on the ledgerRoute
 * branch either: following the link is a deliberate act, never an
 * incidentally narrow browser window, so there is nothing for a floor to
 * protect against. */

const DESKTOP = Object.freeze({
  installed: false,
  coarsePointer: false,
  canHover: true,
  width: 1440,
  height: 900,
})

test('ledgerRoute ALONE bypasses the gate on a full desktop signature — the load-bearing case', () => {
  assert.equal(
    phoneCanvasDecision({ ...DESKTOP, choice: 'auto', ledgerRoute: true }),
    true,
    '?ledger=1 with no stored choice, on a fine-pointer, hovering, 1440-wide desktop, must still get the phone dress — this is the whole point of the override, and the one case a conjunction with choice==="on" could never satisfy since nothing writes that choice today',
  )
})

test('the gate still gates when neither signal is present', () => {
  assert.equal(
    phoneCanvasDecision({ ...DESKTOP, choice: 'auto', ledgerRoute: false }),
    false,
    'a fine-pointer desktop with no ledger route and no stored choice must stay gated — the override must not leak into the ordinary case',
  )
})

test('choice=on alone, off the ledger route, still bypasses everything — the existing branch is untouched', () => {
  assert.equal(
    phoneCanvasDecision({ ...DESKTOP, choice: 'on', ledgerRoute: false }),
    true,
    'choice=on alone must still bypass unconditionally — this pin is unrelated to the ledgerRoute addition and must not regress alongside it',
  )
})

test('an explicit off still wins over the ledger override', () => {
  assert.equal(
    phoneCanvasDecision({ ...DESKTOP, choice: 'off', ledgerRoute: true }),
    false,
    '"an explicit no is final, including on a phone" — the ledger override must not read past an explicit off, which is checked first in the function',
  )
})

test('readPhoneCanvasEnvironment reads ledgerRoute from location.search, the same param src/phone-ledger.js reads', () => {
  const env = search => readPhoneCanvasEnvironment({ location: { search }, matchMedia: () => ({ matches: false }) })
  assert.equal(env('?ledger=1').ledgerRoute, true, 'a real ?ledger=1 search string was not read as the ledger route')
  assert.equal(env('?foo=1&ledger=1').ledgerRoute, true, 'ledger=1 as a SECOND query param (after "&", not "?") was not read as the ledger route')
  assert.equal(env('?foo=1').ledgerRoute, false, 'an unrelated query string was read as if it were the ledger route')
  assert.equal(env('?ledger=10').ledgerRoute, false, 'ledger=10 (a different, longer value) was read as ledger=1 — the word-boundary check is missing or wrong')
  assert.equal(env('').ledgerRoute, false, 'no search string at all was read as the ledger route')
})

/* SOURCE-LEVEL PIN, NOT JUST A BEHAVIOURAL ONE (coordinator completeness
 * check, 2026-08-28): the four cases above prove readPhoneCanvasEnvironment
 * behaves correctly for the inputs THIS suite happened to choose. This pins
 * the actual mechanism instead — that ledgerRoute is derived from
 * `location.search`, read with the SAME regex family src/phone-ledger.js's
 * adoptLedgerEntryFlag() already uses for the identical URL flag — so a
 * change that swapped in a different-looking but coincidentally-similar
 * pattern (or read the wrong property, or read a value nothing on the real
 * page ever sets) cannot pass by accident just because the four chosen
 * inputs above still happened to resolve correctly. */
test('ledgerRoute is derived from location.search with the same regex family adoptLedgerEntryFlag uses, as source', () => {
  const reader = CANVAS_SOURCE.slice(
    CANVAS_SOURCE.indexOf('export function readPhoneCanvasEnvironment'),
    CANVAS_SOURCE.indexOf('export function readPhoneCanvasEnvironment') + 1200,
  )
  assert.match(reader, /win\?\.location\?\.search/,
    'readPhoneCanvasEnvironment no longer reads location.search at all — ledgerRoute would be sourced from somewhere the real ?ledger=1 link never touches')
  assert.match(reader, /\/\[\?&\]ledger=1\\b\//,
    'the ledgerRoute derivation no longer uses the [?&]ledger=1\\b pattern — it has drifted from src/phone-ledger.js\'s adoptLedgerEntryFlag, which reads the identical URL flag')
})
