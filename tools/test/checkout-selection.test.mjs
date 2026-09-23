// Selection, the two totals, the spend cap, persistence, and the sign-in gate.
//
// Every assertion here is about a number or a refusal the owner would act on.
// The two that matter most:
//
//   1. Cash today and the recurring annual commitment are computed separately
//      and are allowed to disagree. Conflating them is how somebody agrees to
//      "$9.99" and finds out it was $9.99 a month.
//   2. confirm() refuses without a named principal. That is the owner's own
//      condition -- "if i am not logged in as a real user ... i refuse to
//      finish the form" -- and it is enforced in the store, not only by a
//      disabled button, so a caller that skips the UI gets the same answer.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizeCatalog } from '../../src/checkout-catalog.js'
import {
  SELECTION_STORAGE_KEY,
  capAssessment,
  createSelectionStore,
  lineCost,
  reconcileStoredSelections,
  safeStorage,
} from '../../src/checkout-selection.js'

const PRINCIPAL = Object.freeze({
  id: 'account:0123456789abcdef0123456789abcdef',
  displayName: 'The owner',
  vault: { verified: false, summary: 'Signing in names you on this record. It does not check your vault.' },
})

function item(overrides = {}) {
  return {
    id: 'thing',
    name: 'Thing',
    vendor: 'Vendor',
    category: 'required-to-ship',
    cadence: 'one-off',
    firstYearUsd: 10,
    renewalUsd: null,
    priceVerified: false,
    priceVerifiedDate: null,
    quantityMax: 1,
    defaultSelected: false,
    whatItIs: 'What it is.',
    whatBreaksWithout: 'What breaks.',
    whyHeWantedIt: 'Why.',
    sourceUrl: null,
    warning: null,
    blockers: [],
    notes: null,
    ...overrides,
  }
}

function catalogOf(items, dailyLimitUsd = 100) {
  return normalizeCatalog({
    version: 2,
    generatedAt: '2026-08-11T00:00:00.000Z',
    currency: 'USD',
    spendPolicy: { dailyLimitUsd, source: 'src/lib/providers/pay.js limits.defaultDailySpendUsd', readAt: null },
    categories: [
      { id: 'required-to-ship', label: 'Needed to ship', blurb: 'Cannot launch without these.' },
      { id: 'do-not-buy', label: 'Do not buy yet', blurb: 'Ruled out for now.' },
    ],
    items,
  })
}

/** An in-memory localStorage that behaves like the real one, including JSON round-tripping. */
function memoryStorage(seed = null) {
  const map = new Map()
  if (seed !== null) map.set(SELECTION_STORAGE_KEY, JSON.stringify(seed))
  return {
    backing: {
      getItem: key => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => { map.set(key, String(value)) },
    },
    raw: () => (map.has(SELECTION_STORAGE_KEY) ? JSON.parse(map.get(SELECTION_STORAGE_KEY)) : null),
  }
}

function storeOn(catalog, seed = null) {
  const memory = memoryStorage(seed)
  const store = createSelectionStore({
    catalog,
    storage: safeStorage(memory.backing),
    now: () => '2026-08-11T12:00:00.000Z',
  })
  return { store, memory }
}

/* ---------- the two totals are two different commitments ---------- */

test('a one-off costs cash today and nothing every year after', () => {
  const catalog = catalogOf([item({ cadence: 'one-off', firstYearUsd: 109 })])
  assert.deepEqual(lineCost(catalog.items[0], 1), { cashTodayCents: 10_900, recurringAnnualCents: 0 })
})

test('an annual item recurs at its renewal price, not at its first-year price', () => {
  const catalog = catalogOf([item({ cadence: 'annual', firstYearUsd: 28.12, renewalUsd: 51.8 })])
  assert.deepEqual(lineCost(catalog.items[0], 1), { cashTodayCents: 2_812, recurringAnnualCents: 5_180 })
})

test('an annual item with no separate renewal recurs at the same price', () => {
  const catalog = catalogOf([item({ cadence: 'annual', firstYearUsd: 50, renewalUsd: null })])
  assert.deepEqual(lineCost(catalog.items[0], 1), { cashTodayCents: 5_000, recurringAnnualCents: 5_000 })
})

test('a monthly item charges one month today and twelve across a year', () => {
  // This is the case that must never be flattened: $9.99 today, $119.88 a year.
  const catalog = catalogOf([item({ cadence: 'monthly', firstYearUsd: 9.99 })])
  assert.deepEqual(lineCost(catalog.items[0], 1), { cashTodayCents: 999, recurringAnnualCents: 11_988 })
})

test('quantity multiplies both figures', () => {
  const catalog = catalogOf([item({ cadence: 'annual', firstYearUsd: 11.08, quantityMax: 4 })])
  assert.deepEqual(lineCost(catalog.items[0], 4), { cashTodayCents: 4_432, recurringAnnualCents: 4_432 })
})

test('an unpriced item contributes nothing to either total', () => {
  const catalog = catalogOf([item({ firstYearUsd: null })])
  assert.deepEqual(lineCost(catalog.items[0], 1), { cashTodayCents: 0, recurringAnnualCents: 0 })
})

test('the two totals are kept apart and are allowed to disagree', () => {
  const catalog = catalogOf([
    item({ id: 'once', cadence: 'one-off', firstYearUsd: 109 }),
    item({ id: 'yearly', cadence: 'annual', firstYearUsd: 50 }),
    item({ id: 'monthly-thing', cadence: 'monthly', firstYearUsd: 9.99 }),
  ])
  const { store } = storeOn(catalog)
  for (const id of ['once', 'yearly', 'monthly-thing']) store.setSelected(id, true)
  const state = store.summary()
  assert.equal(state.cashTodayCents, 16_899, '$168.99 today')
  assert.equal(state.recurringAnnualCents, 16_988, '$169.88 every year after')
  assert.notEqual(state.cashTodayCents, state.recurringAnnualCents,
    'these two figures are different commitments and the screen shows both')
})

/* ---------- the spend cap, applied the way the engine applies it ---------- */

test('a single line over the cap is named, and the refusable and recordable halves are split', () => {
  // The exact case in the shipped catalogue: $109 against a $100/day cap.
  const catalog = catalogOf([
    item({ id: 'delaware', cadence: 'one-off', firstYearUsd: 109 }),
    item({ id: 'agent', cadence: 'annual', firstYearUsd: 50 }),
  ])
  const { store } = storeOn(catalog)
  store.setSelected('delaware', true)
  store.setSelected('agent', true)
  const { cap } = store.summary()

  assert.equal(cap.known, true)
  assert.equal(cap.limitCents, 10_000)
  assert.deepEqual([...cap.overCapLineIds], ['delaware'],
    'the cap is per amount, so the $109 line is over it and the $50 line is not')
  assert.equal(cap.refusableCents, 10_900)
  assert.equal(cap.recordableCents, 5_000,
    'the smaller line would still be recorded, which is what makes this read as partial success')
  assert.equal(cap.totalOverCap, true)
})

test('a basket can cross the cap with no single line over it', () => {
  const catalog = catalogOf([
    item({ id: 'line-a', firstYearUsd: 60 }),
    item({ id: 'line-b', firstYearUsd: 60 }),
  ])
  const { store } = storeOn(catalog)
  store.setSelected('line-a', true)
  store.setSelected('line-b', true)
  const { cap } = store.summary()
  assert.equal(cap.totalOverCap, true)
  assert.deepEqual([...cap.overCapLineIds], [], 'neither line is individually refusable')
})

test('an unreadable cap is reported as unknown, never as no cap', () => {
  const catalog = catalogOf([item({ firstYearUsd: 900 })], null)
  const assessment = capAssessment(catalog, [{ id: 'x', cashTodayCents: 90_000 }])
  assert.equal(assessment.known, false)
  assert.equal(assessment.limitCents, null)
  assert.equal(assessment.totalOverCap, false, 'an unknown cap must not be rendered as a passed check')
})

test('a line exactly at the cap is not over it', () => {
  const catalog = catalogOf([item({ id: 'exact', firstYearUsd: 100 })])
  const { store } = storeOn(catalog)
  store.setSelected('exact', true)
  assert.deepEqual([...store.summary().cap.overCapLineIds], [])
  assert.equal(store.summary().cap.totalOverCap, false)
})

/* ---------- selection rules ---------- */

test('an unpriced item is refused by the store, not only by a disabled control', () => {
  const catalog = catalogOf([item({ id: 'unpriced', firstYearUsd: null })])
  const { store } = storeOn(catalog)
  store.setSelected('unpriced', true)
  assert.equal(store.summary().count, 0)
  assert.equal(store.isSelected('unpriced'), false)
})

test('a blocked item CAN be chosen, and is counted separately so it cannot travel quietly', () => {
  const catalog = catalogOf([
    item({ id: 'clear-line', firstYearUsd: 10 }),
    item({
      id: 'blocked-line',
      firstYearUsd: 11.08,
      blockers: [{ code: 'NAME_NOT_DECIDED', summary: 'The name is not settled.', severity: 'blocking' }],
    }),
  ])
  const { store } = storeOn(catalog)
  store.setSelected('clear-line', true)
  store.setSelected('blocked-line', true)
  const state = store.summary()
  assert.equal(state.count, 2)
  assert.deepEqual(state.blockedLines.map(line => line.id), ['blocked-line'])
  assert.equal(state.cashTodayCents, 2_108, 'a blocked line still costs what it costs')
})

test('a confirmed record hoists the blocked ids to the top level, not only onto lines', () => {
  // The caveat has to survive a consumer that reads summary fields and acts.
  // Anything that turns a saved record into a purchase must be able to refuse
  // on one check rather than on a loop somebody remembers to write.
  const catalog = catalogOf([
    item({ id: 'clear-line', firstYearUsd: 10 }),
    item({
      id: 'blocked-line',
      firstYearUsd: 11.08,
      blockers: [{ code: 'NAME_NOT_DECIDED', summary: 'The name is not settled.', severity: 'blocking' }],
    }),
  ])
  const { store, memory } = storeOn(catalog)
  store.setSelected('clear-line', true)
  store.setSelected('blocked-line', true)
  store.confirm({ principal: PRINCIPAL })

  const record = store.summary().confirmed
  assert.deepEqual(record.blockedLineIds, ['blocked-line'])
  assert.deepEqual(memory.raw().confirmed.blockedLineIds, ['blocked-line'],
    'the caveat has to survive the round trip through storage, not just the in-memory object')
})

test('a record with nothing blocked says so with an empty list, not a missing field', () => {
  // An absent field reads as "no information"; an empty array reads as "asked
  // and the answer was none". A consumer must not have to tell those apart.
  const catalog = catalogOf([item({ id: 'clear-line', firstYearUsd: 10 })])
  const { store } = storeOn(catalog)
  store.setSelected('clear-line', true)
  store.confirm({ principal: PRINCIPAL })
  assert.deepEqual(store.summary().confirmed.blockedLineIds, [])
})

test('a confirmed record marks which lines were blocked, with the reason', () => {
  const catalog = catalogOf([item({
    id: 'blocked-line',
    firstYearUsd: 11.08,
    blockers: [{ code: 'NAME_NOT_DECIDED', summary: 'The name is not settled.', severity: 'blocking' }],
  })])
  const { store } = storeOn(catalog)
  store.setSelected('blocked-line', true)
  store.confirm({ principal: PRINCIPAL })
  const line = store.summary().confirmed.lines[0]
  assert.equal(line.blocked, true)
  assert.equal(line.blockedReason, 'The name is not settled.')
})

test('a do-not-buy item cannot be selected through the store either', () => {
  const catalog = catalogOf([item({ id: 'ruled-out', category: 'do-not-buy', firstYearUsd: 350 })])
  const { store } = storeOn(catalog)
  store.setSelected('ruled-out', true)
  assert.equal(store.summary().count, 0)
})

test('quantity is clamped to the item maximum in both directions', () => {
  const catalog = catalogOf([item({ id: 'many', quantityMax: 4 })])
  const { store } = storeOn(catalog)
  store.setSelected('many', true)
  store.setQuantity('many', 99)
  assert.equal(store.quantityOf('many'), 4)
  store.setQuantity('many', 0)
  assert.equal(store.quantityOf('many'), 1, 'zero is a deselect, not a quantity')
})

test('selecting the recommended items in a group skips the ones that cannot be bought', () => {
  const catalog = catalogOf([
    item({ id: 'good', defaultSelected: true }),
    item({ id: 'recommended-but-unpriced', defaultSelected: false, firstYearUsd: null }),
    item({ id: 'not-recommended' }),
  ])
  const { store } = storeOn(catalog)
  store.selectRecommendedIn('required-to-ship')
  assert.deepEqual(store.summary().lines.map(line => line.id), ['good'])
})

test('the cart starts empty even when items are marked recommended', () => {
  // A running total he did not assemble is the one number here he might act on
  // while believing he chose it.
  const catalog = catalogOf([item({ id: 'line-a', defaultSelected: true }), item({ id: 'line-b', defaultSelected: true })])
  const { store } = storeOn(catalog)
  assert.equal(store.summary().count, 0)
  assert.equal(store.summary().cashTodayCents, 0)
})

/* ---------- persistence, and what survives a catalogue change ---------- */

test('a selection is written to storage as it is made, with no save button', () => {
  const catalog = catalogOf([item({ id: 'thing', firstYearUsd: 109 })])
  const { store, memory } = storeOn(catalog)
  store.setSelected('thing', true)
  assert.deepEqual(memory.raw().selections, [{ id: 'thing', qty: 1, pricedAtCents: 10_900 }])
})

test('a stored selection is restored on the next launch', () => {
  const catalog = catalogOf([item({ id: 'thing', firstYearUsd: 109, quantityMax: 3 })])
  const seed = { v: 1, selections: [{ id: 'thing', qty: 2, pricedAtCents: 10_900 }], confirmed: null }
  const { store } = storeOn(catalog, seed)
  assert.equal(store.quantityOf('thing'), 2)
  assert.equal(store.summary().cashTodayCents, 21_800)
})

test('an item that has since lost its price is dropped and reported, not silently totalled', () => {
  const catalog = catalogOf([item({ id: 'thing', firstYearUsd: null })])
  const seed = { v: 1, selections: [{ id: 'thing', qty: 1, pricedAtCents: 1_000 }], confirmed: null }
  const { store, memory } = storeOn(catalog, seed)
  const state = store.summary()
  assert.equal(state.count, 0)
  assert.equal(state.dropped.length, 1)
  assert.match(state.dropped[0].reason, /No quote yet/)
  assert.deepEqual(memory.raw().selections, [], 'the drop is persisted, so it cannot come back next launch')
})

test('an item that has since acquired a blocker is KEPT, because he can still choose it', () => {
  // The mirror of the test above, and the distinction matters: losing a price
  // makes a line impossible to total, which is a drop. Acquiring a blocker
  // makes it inadvisable, which is a warning he must read rather than a
  // silent removal of a choice he made.
  const catalog = catalogOf([item({
    id: 'thing',
    firstYearUsd: 10,
    blockers: [{ code: 'NAME_NOT_DECIDED', summary: 'The name is not settled.', severity: 'blocking' }],
  })])
  const seed = { v: 1, selections: [{ id: 'thing', qty: 1, pricedAtCents: 1_000 }], confirmed: null }
  const { store } = storeOn(catalog, seed)
  assert.equal(store.summary().count, 1)
  assert.equal(store.summary().dropped.length, 0)
  assert.equal(store.summary().blockedLines.length, 1)
})

test('an item that vanished from the catalogue is dropped and reported', () => {
  const catalog = catalogOf([item({ id: 'still-here' })])
  const seed = { v: 1, selections: [{ id: 'gone', qty: 1, pricedAtCents: 500 }], confirmed: null }
  const { store } = storeOn(catalog, seed)
  assert.equal(store.summary().dropped.length, 1)
  assert.equal(store.summary().dropped[0].id, 'gone')
})

test('a price that moved under a saved choice is KEPT and reported, never silently re-totalled', () => {
  // The cheap-first-year trap in miniature: the choice stands, the new price is
  // used, and he is told the number changed.
  const catalog = catalogOf([item({ id: 'thing', firstYearUsd: 51.8 })])
  const seed = { v: 1, selections: [{ id: 'thing', qty: 1, pricedAtCents: 2_812 }], confirmed: null }
  const { store } = storeOn(catalog, seed)
  const state = store.summary()
  assert.equal(state.count, 1, 'the choice is kept')
  assert.equal(state.cashTodayCents, 5_180, 'the total uses the current price')
  assert.deepEqual(state.priceChanges, [{ id: 'thing', name: 'Thing', wasCents: 2_812, nowCents: 5_180 }])
})

test('corrupt or foreign stored state is ignored rather than partially trusted', () => {
  const catalog = catalogOf([item({ id: 'thing' })])
  for (const seed of [
    { v: 99, selections: [{ id: 'thing', qty: 1 }] },
    { v: 1, selections: 'not an array' },
    { nonsense: true },
    [],
  ]) {
    const reconciled = reconcileStoredSelections(catalog, seed)
    assert.equal(reconciled.selections.size, 0, `trusted ${JSON.stringify(seed)}`)
  }
})

test('a busy storage read is not reported or latched as an absent selection', () => {
  let reads = 0
  const storage = safeStorage({
    getItem() {
      reads += 1
      if (reads === 1) throw Object.assign(new Error('machine is busy'), { code: 'EBUSY' })
      return JSON.stringify({ v: 1, selections: [{ id: 'thing', qty: 1, pricedAtCents: 1_000 }] })
    },
  })

  assert.throws(
    () => storage.read(SELECTION_STORAGE_KEY),
    error => error.code === 'CHECKOUT_SELECTION_READ_FAILED'
      && /not claiming that it is absent/.test(error.message)
      && error.cause?.code === 'EBUSY',
  )
  assert.equal(storage.read(SELECTION_STORAGE_KEY).selections[0].id, 'thing',
    'the failed answer is not cached: recovery performs a fresh read and returns the saved choice')
  assert.equal(reads, 2)

  const absent = safeStorage({ getItem: () => null })
  assert.equal(absent.read(SELECTION_STORAGE_KEY), null,
    'the one genuine absent result keeps its existing answer')
})

test('storage that refuses to write is reported instead of pretending to have saved', () => {
  const catalog = catalogOf([item({ id: 'thing' })])
  const store = createSelectionStore({
    catalog,
    storage: safeStorage({
      getItem: () => null,
      setItem: () => { throw new Error('quota exceeded') },
    }),
  })
  store.setSelected('thing', true)
  assert.equal(store.summary().persistenceFailed, true)
  assert.equal(store.summary().count, 1, 'the selection is still correct for right now')
})

/* ---------- the sign-in gate on confirm ---------- */

test('confirming without a principal records nothing at all', () => {
  const catalog = catalogOf([item({ id: 'thing' })])
  const { store, memory } = storeOn(catalog)
  store.setSelected('thing', true)
  for (const attempt of [undefined, {}, { principal: null }, { principal: {} }, { principal: { id: '' } }, { principal: { id: '   ' } }]) {
    store.confirm(attempt)
    assert.equal(store.summary().confirmed, null, `recorded for ${JSON.stringify(attempt)}`)
  }
  assert.equal(memory.raw().confirmed, null)
})

test('confirming an empty cart records nothing', () => {
  const catalog = catalogOf([item({ id: 'thing' })])
  const { store } = storeOn(catalog)
  store.confirm({ principal: PRINCIPAL })
  assert.equal(store.summary().confirmed, null)
})

test('a confirmed decision names the principal and carries both totals', () => {
  const catalog = catalogOf([
    item({ id: 'once', cadence: 'one-off', firstYearUsd: 109 }),
    item({ id: 'monthly-thing', cadence: 'monthly', firstYearUsd: 9.99 }),
  ])
  const { store, memory } = storeOn(catalog)
  store.setSelected('once', true)
  store.setSelected('monthly-thing', true)
  store.confirm({ principal: PRINCIPAL })

  const record = store.summary().confirmed
  assert.equal(record.at, '2026-08-11T12:00:00.000Z')
  assert.equal(record.approvedBy.id, PRINCIPAL.id)
  assert.equal(record.approvedBy.displayName, 'The owner')
  assert.equal(record.cashTodayCents, 11_899)
  assert.equal(record.recurringAnnualCents, 11_988)
  assert.deepEqual(record.overCapLineIds, ['once'])
  assert.equal(record.recordKind, 'local-decision-note')
  assert.deepEqual(memory.raw().confirmed, record, 'the record survives a relaunch')
})

test('the record states that the vault was never verified rather than omitting it', () => {
  const catalog = catalogOf([item({ id: 'thing' })])
  const { store } = storeOn(catalog)
  store.setSelected('thing', true)
  store.confirm({ principal: PRINCIPAL })
  const record = store.summary().confirmed
  assert.equal(record.vaultVerified, false)
  assert.match(record.vaultNote, /does not check your vault/)
})

test('nothing in a confirmed record resembles a receipt or a transaction', () => {
  const catalog = catalogOf([item({ id: 'thing' })])
  const { store } = storeOn(catalog)
  store.setSelected('thing', true)
  store.confirm({ principal: PRINCIPAL })
  const serialized = JSON.stringify(store.summary().confirmed).toLowerCase()
  for (const forbidden of ['receipt', 'orderid', 'order_id', 'transaction', 'paid', 'charge', 'card', 'invoice', 'purchased']) {
    assert.doesNotMatch(serialized, new RegExp(forbidden),
      `a decision record must carry nothing that reads as proof of payment (${forbidden})`)
  }
})

test('changing the selection clears a previous confirmation', () => {
  // A record saying he approved one line must not survive him adding a second.
  const catalog = catalogOf([item({ id: 'line-a' }), item({ id: 'line-b' })])
  const { store } = storeOn(catalog)
  store.setSelected('line-a', true)
  store.confirm({ principal: PRINCIPAL })
  assert.notEqual(store.summary().confirmed, null)

  store.setSelected('line-b', true)
  assert.equal(store.summary().confirmed, null, 'the record no longer matches the selection, so it is gone')
})

test('clearing the cart clears the confirmation too', () => {
  const catalog = catalogOf([item({ id: 'line-a' })])
  const { store } = storeOn(catalog)
  store.setSelected('line-a', true)
  store.confirm({ principal: PRINCIPAL })
  store.clearAll()
  assert.equal(store.summary().confirmed, null)
})
