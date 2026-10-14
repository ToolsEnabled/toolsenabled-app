// The purchase catalogue boundary.
//
// This suite exists because everything downstream of it is arithmetic about
// the owner's money. If a malformed price reaches normalizeCatalog and comes
// out looking plausible, every total on the checkout screen is wrong in a way
// nobody can see. So the assertions here are mostly REFUSALS: the shapes that
// must not be accepted, and the exact reason each one is dangerous.
//
// The last tests in the file validate the real catalogue -- the one a person
// actually put in front of this module -- rather than only the fixtures above.
//
// IT IS NO LONGER "THE SHIPPED CATALOGUE", AND THE RENAME IS THE POINT. The file
// used to live at public/data/purchase-catalog.json and therefore travelled
// inside app.asar to every installer: the operator's own shopping list, internal
// paths, internal request ids, second-person deliberations and all, one click
// back from home on a stranger's fresh install. It now lives at
// private/purchase-catalog.owner.json, is copied to <userData> on the machines
// that want the screen, and is in no payload.
//
// A machine with no operator catalogue is therefore a NORMAL machine, not a
// broken one -- so these tests skip there, by name, rather than passing quietly.
// A green line for a check that had nothing to check is how a suite starts
// reporting on a file that is no longer there.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  CatalogError,
  itemsInCategory,
  normalizeCatalog,
  toMinorUnits,
} from '../../src/checkout-catalog.js'

const OPERATOR_CATALOG = 'private/purchase-catalog.owner.json'
const OPERATOR = readOperatorCatalog()
const SCHEMA = JSON.parse(readFileSync(new URL('../../public/data/schema/purchase-catalog.schema.json', import.meta.url), 'utf8'))

/* Present-and-broken and absent are different answers and must not collapse
   into one. Absent skips; unreadable or unparseable fails here and now. */
function readOperatorCatalog() {
  let source
  try {
    source = readFileSync(new URL(`../../${OPERATOR_CATALOG}`, import.meta.url), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  return JSON.parse(source)
}

function baseItem(overrides = {}) {
  return {
    id: 'a-thing',
    name: 'A thing',
    vendor: 'A vendor',
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
    whyHeWantedIt: 'Why he wanted it.',
    sourceUrl: null,
    warning: null,
    blockers: [],
    notes: null,
    ...overrides,
  }
}

function baseCatalog(items, overrides = {}) {
  return {
    version: 2,
    generatedAt: '2026-08-11T00:00:00.000Z',
    currency: 'USD',
    spendPolicy: { dailyLimitUsd: 100, source: 'src/lib/providers/pay.js limits.defaultDailySpendUsd', readAt: null },
    categories: [
      { id: 'required-to-ship', label: 'Needed to ship', blurb: 'Cannot launch without these.' },
      { id: 'do-not-buy', label: 'Do not buy yet', blurb: 'Ruled out for now.' },
    ],
    items,
    ...overrides,
  }
}

const rejects = (value, why) => assert.throws(() => normalizeCatalog(value), CatalogError, why)

/* ---------- money is exact or it is refused ---------- */

test('dollars become exact minor units for the currency, not an assumed two decimals', () => {
  assert.equal(toMinorUnits(109, 'USD', 'x'), 10_900)
  assert.equal(toMinorUnits(9.99, 'USD', 'x'), 999)
  assert.equal(toMinorUnits(0, 'USD', 'x'), 0)
  // JPY has no minor unit at all. A hardcoded *100 would make every yen price
  // a hundred times too large, and it would look like a plausible number.
  assert.equal(toMinorUnits(1200, 'JPY', 'x'), 1200)
})

test('a third decimal place is refused rather than rounded into the total', () => {
  assert.throws(() => toMinorUnits(10.005, 'USD', 'price'), CatalogError)
  assert.throws(() => toMinorUnits(0.001, 'USD', 'price'), CatalogError)
})

test('a price that is not a finite number is refused', () => {
  for (const bad of ['10', null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, {}]) {
    assert.throws(() => toMinorUnits(bad, 'USD', 'price'), CatalogError, `accepted ${String(bad)}`)
  }
})

test('floating point noise is caught instead of becoming a plausible wrong price', () => {
  // 0.1 + 0.2 is 0.30000000000000004. Rounding it silently would be fine here,
  // but the same tolerance is what lets a genuinely wrong authored number in,
  // so the check is on exactness rather than on prettiness.
  assert.equal(toMinorUnits(0.1 + 0.2, 'USD', 'x'), 30)
  assert.throws(() => toMinorUnits(0.30001, 'USD', 'x'), CatalogError)
})

/* ---------- the shape is exact ---------- */

test('an unknown field is refused, because it means the file and this build disagree', () => {
  rejects(baseCatalog([baseItem({ discountUsd: 5 })]))
})

test('a missing required field is refused, one at a time', () => {
  for (const key of Object.keys(baseItem())) {
    const item = baseItem()
    delete item[key]
    rejects(baseCatalog([item]), `accepted an item with no ${key}`)
  }
})

test('the schema and this module require the same item fields', () => {
  // Drift between the build gate and the runtime boundary is how a field ships
  // that nothing validates. Compared as sets, with estimateUsd excluded because
  // it is the one deliberately optional field.
  const schemaRequired = new Set(SCHEMA.$defs.item.required)
  const moduleRequired = new Set(Object.keys(baseItem()))
  assert.deepEqual([...schemaRequired].sort(), [...moduleRequired].sort())
})

test('a duplicate item id is refused rather than silently collapsing two lines into one', () => {
  rejects(baseCatalog([baseItem({ id: 'same' }), baseItem({ id: 'same', name: 'Other' })]))
})

test('a version this build does not read is refused by name', () => {
  assert.throws(() => normalizeCatalog(baseCatalog([baseItem()], { version: 3 })), /version 3/)
})

test('an item naming a category the file never declared is refused', () => {
  rejects(baseCatalog([baseItem({ category: 'optional-defensive' })]))
})

test('control characters in an authored string are refused', () => {
  rejects(baseCatalog([baseItem({ name: `A\0thing` })]))
  // ...but a newline inside a sentence is legal, because sentences have them.
  assert.doesNotThrow(() => normalizeCatalog(baseCatalog([baseItem({ whatItIs: 'Line one.\nLine two.' })])))
})

/* ---------- the cross-field rules that keep a claim falsifiable ---------- */

test('a verified price claim without a price or a date is refused', () => {
  rejects(baseCatalog([baseItem({ priceVerified: true, priceVerifiedDate: null })]))
  rejects(baseCatalog([baseItem({ priceVerified: true, priceVerifiedDate: '2026-08-01', firstYearUsd: null })]))
  assert.doesNotThrow(() => normalizeCatalog(baseCatalog([
    baseItem({ priceVerified: true, priceVerifiedDate: '2026-08-01' }),
  ])))
})

test('a renewal price without a first-year price is refused', () => {
  rejects(baseCatalog([baseItem({ cadence: 'annual', firstYearUsd: null, renewalUsd: 40 })]))
})

test('a one-off purchase cannot carry a renewal price', () => {
  rejects(baseCatalog([baseItem({ cadence: 'one-off', renewalUsd: 40 })]))
})

test('an item cannot carry both a quoted price and an estimate', () => {
  rejects(baseCatalog([baseItem({
    firstYearUsd: 10,
    estimateUsd: { lowUsd: 5, highUsd: 20, basis: 'a range' },
  })]))
})

test('an estimate whose high is below its low is refused', () => {
  rejects(baseCatalog([baseItem({
    firstYearUsd: null,
    estimateUsd: { lowUsd: 30, highUsd: 20, basis: 'a range' },
  })]))
})

test('an estimate survives on an unpriced item and never becomes a price', () => {
  const catalog = normalizeCatalog(baseCatalog([baseItem({
    firstYearUsd: null,
    estimateUsd: { lowUsd: 8000, highUsd: 30000, basis: 'no vendor has quoted this' },
  })]))
  const item = catalog.items[0]
  assert.equal(item.firstYearCents, null)
  assert.deepEqual({ ...item.estimate }, { lowCents: 800_000, highCents: 3_000_000, basis: 'no vendor has quoted this' })
  assert.equal(item.selectable, false, 'an estimate must never make an item buyable')
})

/* ---------- selectability, and the ORDER of its reasons ---------- */

test('an item with no price cannot be selected, and is not shown as zero', () => {
  const item = normalizeCatalog(baseCatalog([baseItem({ firstYearUsd: null })])).items[0]
  assert.equal(item.firstYearCents, null)
  assert.equal(item.selectable, false)
  assert.equal(typeof item.unselectableReason, 'string', 'an unpriced item explains why it cannot be selected')
  assert.ok(item.unselectableReason.length > 0, 'an unpriced item gives a non-empty explanation')
})

test('a blocking blocker marks an item loudly WITHOUT taking the choice away', () => {
  // Deliberately the opposite of the first design. Choosing something here does
  // not buy it, so refusing the click prevented nothing real while making 30 of
  // the 35 real catalogue items untouchable. The blocker now has to be carried
  // and shown instead of enforced.
  const item = normalizeCatalog(baseCatalog([baseItem({
    blockers: [{ code: 'NAME_NOT_DECIDED', summary: 'The company name is not settled.', severity: 'blocking' }],
  })])).items[0]
  assert.equal(item.selectable, true, 'he can put it in the list; nothing here buys it')
  assert.equal(item.blocked, true)
  assert.equal(item.blockedReason, 'The company name is not settled.')
  assert.equal(item.unselectableReason, null)
})

test('an item with no blockers is not marked blocked', () => {
  const item = normalizeCatalog(baseCatalog([baseItem()])).items[0]
  assert.equal(item.blocked, false)
  assert.equal(item.blockedReason, null)
})

test('a caution does not mark an item blocked', () => {
  const item = normalizeCatalog(baseCatalog([baseItem({
    blockers: [{ code: 'PICK_ONE', summary: 'Choose one of these.', severity: 'caution' }],
  })])).items[0]
  assert.equal(item.blocked, false, 'blocked is about blocking severity only')
  assert.equal(item.selectable, true)
})

test('an unpriced item is blocked AND unselectable, and both facts survive', () => {
  const item = normalizeCatalog(baseCatalog([baseItem({
    firstYearUsd: null,
    blockers: [{ code: 'NO_QUOTE_OBTAINED', summary: 'Nobody has quoted this.', severity: 'blocking' }],
  })])).items[0]
  assert.equal(item.selectable, false, 'there is no number to add to a total')
  assert.equal(item.blocked, true)
  assert.equal(typeof item.unselectableReason, 'string', 'a blocked unpriced item still explains why it cannot be selected')
  assert.ok(item.unselectableReason.length > 0, 'a blocked unpriced item keeps a non-empty selection explanation')
})

test('a caution leaves the item selectable, because it is a warning and not a gate', () => {
  const item = normalizeCatalog(baseCatalog([baseItem({
    blockers: [{ code: 'CHECK_FIRST', summary: 'Confirm the plan tier.', severity: 'caution' }],
  })])).items[0]
  assert.equal(item.selectable, true)
  assert.equal(item.cautions.length, 1)
  assert.equal(item.blocking.length, 0)
})

test('a do-not-buy item can never be selected even with a price and no blockers', () => {
  const item = normalizeCatalog(baseCatalog([baseItem({ category: 'do-not-buy', firstYearUsd: 350 })])).items[0]
  assert.equal(item.selectable, false)
  assert.equal(typeof item.unselectableReason, 'string', 'a ruled-out item explains why it cannot be selected')
  assert.ok(item.unselectableReason.length > 0, 'a ruled-out item gives a non-empty explanation')
})

test('the most fundamental reason wins when an item is unselectable for several', () => {
  // On the do-not-buy list AND unpriced: he is told it was ruled out, which is
  // the settled answer, rather than the narrower "nobody quoted it".
  const item = normalizeCatalog(baseCatalog([baseItem({
    category: 'do-not-buy',
    firstYearUsd: null,
  })])).items[0]
  const ruledOutOnly = normalizeCatalog(baseCatalog([
    baseItem({ category: 'do-not-buy', firstYearUsd: 10 }),
  ])).items[0]
  assert.equal(
    item.unselectableReason,
    ruledOutOnly.unselectableReason,
    'an unpriced ruled-out item gives the ruled-out reason, not the missing-price reason',
  )
})

/* ---------- the renewal callout ---------- */

test('renewalDiffers is true only when there is a real difference to show', () => {
  const differs = normalizeCatalog(baseCatalog([baseItem({ cadence: 'annual', firstYearUsd: 12, renewalUsd: 48 })])).items[0]
  assert.equal(differs.renewalDiffers, true)

  const same = normalizeCatalog(baseCatalog([baseItem({ cadence: 'annual', firstYearUsd: 48, renewalUsd: 48 })])).items[0]
  assert.equal(same.renewalDiffers, false, 'stating "then $48" under "$48" is noise')

  const unstated = normalizeCatalog(baseCatalog([baseItem({ cadence: 'annual', firstYearUsd: 48, renewalUsd: null })])).items[0]
  assert.equal(unstated.renewalDiffers, false)
})

/* ---------- grouping ---------- */

test('items keep the order the file lists them in, within their group', () => {
  const catalog = normalizeCatalog(baseCatalog([
    baseItem({ id: 'first', name: 'First' }),
    baseItem({ id: 'ruled-out', category: 'do-not-buy' }),
    baseItem({ id: 'second', name: 'Second' }),
  ]))
  assert.deepEqual(itemsInCategory(catalog, 'required-to-ship').map(item => item.id), ['first', 'second'])
  assert.deepEqual(itemsInCategory(catalog, 'do-not-buy').map(item => item.id), ['ruled-out'])
})

/* ---------- the operator's own file, on the machines that have one ---------- */

const noCatalogHere = `no operator catalogue on this machine (${OPERATOR_CATALOG}); nothing to validate`

test('the operator catalogue passes the same boundary the screen puts it through', (t) => {
  if (!OPERATOR) return t.skip(noCatalogHere)
  const catalog = normalizeCatalog(OPERATOR)
  assert.ok(catalog.items.length > 0, 'a checkout with no items is not a checkout')
  for (const item of catalog.items) {
    assert.ok(item.whyHeWantedIt.length > 0, `${item.id} has no provenance, which is the point of the screen`)
    assert.ok(item.whatItIs.length > 0, `${item.id} does not say what it is`)
  }
})

test('the operator catalogue carries a readable spend cap, so the screen can cite one', (t) => {
  if (!OPERATOR) return t.skip(noCatalogHere)
  const catalog = normalizeCatalog(OPERATOR)
  assert.equal(typeof catalog.spendPolicy.source, 'string')
  assert.ok(catalog.spendPolicy.source.length > 0)
  // No absolute path: this string is rendered on the screen, so a drive-rooted
  // one would put the operator's own directory layout in front of whoever is
  // reading it. The rest of the sentence is the operator's own note about their
  // own machine, which is precisely why the file is not in the payload.
  assert.doesNotMatch(catalog.spendPolicy.source, /^[A-Za-z]:[\\/]/)
})

test('every operator category id is one the screen knows how to render', (t) => {
  if (!OPERATOR) return t.skip(noCatalogHere)
  const catalog = normalizeCatalog(OPERATOR)
  const known = new Set(['required-to-ship', 'required-before-charging', 'optional-defensive', 'do-not-buy'])
  for (const category of catalog.categories) assert.ok(known.has(category.id), `unrenderable category ${category.id}`)
  for (const item of catalog.items) {
    assert.ok(catalog.categories.some(category => category.id === item.category), `${item.id} is in no rendered group`)
  }
})
