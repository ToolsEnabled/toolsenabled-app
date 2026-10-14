// The purchase catalogue, normalized once at load.
//
// WHY THIS IS AS STRICT AS THE OWNER-PROMPT BOUNDARY -- AND WHY IT GOT STRICTER
// STILL WHEN THE FILE STOPPED SHIPPING.
//
// The catalogue is no longer part of the payload. It used to be authored at
// public/data/purchase-catalog.json, which meant every installer carried the
// operator's own shopping list to strangers; it now lives at
// <userData>/purchase-catalog.json and is served to the app window and to
// nothing else (shell/main.cjs, and src/checkout-visibility.js for why the
// screen does not exist at all without one).
//
// That MOVES the risk this module answers, it does not remove it. Nothing
// validates the file at build time any more -- there is no build for a file the
// operator drops on their own disk -- so a malformed or hand-edited catalogue
// reaches this module having been checked by nobody. tools/check-data-
// schemas.mjs still validates the authored copy when this machine has one, and
// this module is what stands between the HTTP response and a screen about
// somebody's money. So it revalidates everything the schema declares, in the
// same house style src/owner-popup.js uses for the prompt boundary, and throws
// rather than rendering a partial catalogue. A screen that silently drops the
// two items it could not parse is worse than a screen that says it could not
// read the list, because he would be choosing from a list he believes is
// complete.
//
// MONEY IS CONVERTED EXACTLY, ONCE, HERE.
//
// The file is authored in major units because a human writes it and 109 is
// legible where 10900 is a typo waiting to happen. Everything downstream --
// selection, totals, the spend-cap comparison, the decision record -- is
// integer minor units, so no total is ever the sum of floats. The conversion
// refuses anything that is not exact in the file's own currency, which is the
// same rule the engine's pay provider applies to an amount before it will
// record a spend (src/lib/providers/pay.js usdToCents).

const CATEGORY_IDS = Object.freeze(['required-to-ship', 'required-before-charging', 'optional-defensive', 'do-not-buy'])
const CADENCES = Object.freeze(['one-off', 'annual', 'monthly'])
const SEVERITIES = Object.freeze(['blocking', 'caution'])
const CURRENCY_RE = /^[A-Z]{3}$/
const ITEM_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/
const BLOCKER_CODE_RE = /^[A-Z][A-Z0-9_]{2,47}$/
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/
const MAX_MONEY_MAJOR = 1_000_000

export class CatalogError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CatalogError'
  }
}

function fail(message) {
  throw new CatalogError(message)
}

function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Exactly these keys, no more and no fewer. An unexpected key is a schema drift, not a nicety. */
function exactKeys(value, keys, name) {
  if (!plain(value)) fail(`${name} is malformed`)
  const allowed = new Set(keys)
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.has(key))) {
    fail(`${name} carries a field this build does not recognize`)
  }
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${name} is missing ${key}`)
  return value
}

/**
 * Control characters would let authored data smuggle layout into a label.
 * Tab, newline and carriage return are deliberately allowed -- they are legal
 * inside an authored sentence -- and every one of these strings reaches the page
 * through textContent, so none of them can become markup either way.
 *
 * Written as a code scan rather than a regex literal on purpose: a character
 * class of control characters is exactly the kind of source line that arrives
 * carrying the real bytes instead of their escapes, and a source file with a NUL
 * in it is a hazard for every tool that later reads this repo.
 */
function hasControlCharacters(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 9 || code === 10 || code === 13) continue
    if (code < 32 || code === 127) return true
  }
  return false
}

function text(value, name, maximum) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum
      || hasControlCharacters(value)) {
    fail(`${name} is malformed`)
  }
  return value
}

function optionalText(value, name, maximum) {
  return value === null ? null : text(value, name, maximum)
}

/**
 * Minor units per major unit for a currency, from the platform's own tables
 * rather than an assumption that every currency has cents. USD 2, JPY 0,
 * BHD 3. formatExactAmount in src/owner-popup.js resolves the same way, so a
 * figure this module totals and a figure that module prints cannot disagree.
 */
export function currencyMinorDigits(currency) {
  if (!CURRENCY_RE.test(String(currency || ''))) fail('currency is malformed')
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits
}

/**
 * Major units -> exact integer minor units, or a refusal.
 *
 * The epsilon compare is what catches 19.999999999999998 -- a number that
 * rounds to a plausible total and is not the price anybody wrote down.
 */
export function toMinorUnits(amountMajor, currency, name) {
  const digits = currencyMinorDigits(currency)
  if (typeof amountMajor !== 'number' || !Number.isFinite(amountMajor)
      || amountMajor < 0 || amountMajor > MAX_MONEY_MAJOR) {
    fail(`${name} is not a usable amount`)
  }
  const scale = 10 ** digits
  const minor = Math.round(amountMajor * scale)
  if (!Number.isSafeInteger(minor) || Math.abs(amountMajor * scale - minor) > 1e-6) {
    fail(`${name} is not an exact ${currency} amount`)
  }
  return minor
}

function optionalMinorUnits(amountMajor, currency, name) {
  return amountMajor === null ? null : toMinorUnits(amountMajor, currency, name)
}

function normalizeBlocker(value, index) {
  const name = `blocker ${index + 1}`
  exactKeys(value, ['code', 'summary', 'severity'], name)
  if (!BLOCKER_CODE_RE.test(String(value.code || ''))) fail(`${name} code is malformed`)
  if (!SEVERITIES.includes(value.severity)) fail(`${name} severity is malformed`)
  return Object.freeze({
    code: value.code,
    summary: text(value.summary, `${name} summary`, 400),
    severity: value.severity,
  })
}

function normalizeEstimate(value, currency) {
  if (value === null || value === undefined) return null
  exactKeys(value, ['lowUsd', 'highUsd', 'basis'], 'estimate')
  const lowCents = toMinorUnits(value.lowUsd, currency, 'estimate low')
  const highCents = toMinorUnits(value.highUsd, currency, 'estimate high')
  if (highCents < lowCents) fail('estimate high is below its low')
  return Object.freeze({ lowCents, highCents, basis: text(value.basis, 'estimate basis', 600) })
}

const ITEM_KEYS = Object.freeze([
  'id', 'name', 'vendor', 'category', 'cadence',
  'firstYearUsd', 'renewalUsd', 'priceVerified', 'priceVerifiedDate',
  'quantityMax', 'defaultSelected',
  'whatItIs', 'whatBreaksWithout', 'whyHeWantedIt',
  'sourceUrl', 'warning', 'blockers', 'notes',
])

function normalizeItem(value, currency, categoryIds, seenIds) {
  // estimateUsd is the one optional field; accept the item with or without it
  // and normalize the absent case to null so nothing downstream branches on
  // "missing" versus "null".
  const keys = Object.hasOwn(value ?? {}, 'estimateUsd') ? [...ITEM_KEYS, 'estimateUsd'] : ITEM_KEYS
  exactKeys(value, keys, 'catalogue item')

  if (!ITEM_ID_RE.test(String(value.id || ''))) fail('catalogue item id is malformed')
  if (seenIds.has(value.id)) fail(`catalogue item id ${value.id} appears twice`)
  seenIds.add(value.id)
  const label = `item ${value.id}`

  if (!categoryIds.has(value.category)) fail(`${label} names a category the catalogue does not declare`)
  if (!CADENCES.includes(value.cadence)) fail(`${label} cadence is malformed`)
  if (typeof value.priceVerified !== 'boolean') fail(`${label} priceVerified is malformed`)
  if (typeof value.defaultSelected !== 'boolean') fail(`${label} defaultSelected is malformed`)
  if (!Number.isSafeInteger(value.quantityMax) || value.quantityMax < 1 || value.quantityMax > 99) {
    fail(`${label} quantityMax is malformed`)
  }
  if (value.priceVerifiedDate !== null && !DATE_RE.test(String(value.priceVerifiedDate || ''))) {
    fail(`${label} priceVerifiedDate is malformed`)
  }
  if (value.sourceUrl !== null && (typeof value.sourceUrl !== 'string' || !value.sourceUrl.startsWith('https://') || value.sourceUrl.length > 300)) {
    fail(`${label} sourceUrl must be null or an https address`)
  }
  if (!Array.isArray(value.blockers) || value.blockers.length > 6) fail(`${label} blockers is malformed`)

  const firstYearCents = optionalMinorUnits(value.firstYearUsd, currency, `${label} first-year price`)
  const renewalCents = optionalMinorUnits(value.renewalUsd, currency, `${label} renewal price`)
  const estimate = normalizeEstimate(value.estimateUsd ?? null, currency)

  // The same cross-field rules the schema declares, enforced again here. The
  // schema stops them shipping; this stops them rendering, and the two must
  // agree or the build gate is decorative.
  if (value.priceVerified && (firstYearCents === null || value.priceVerifiedDate === null)) {
    fail(`${label} claims a verified price without a price and a date to verify`)
  }
  if (firstYearCents === null && renewalCents !== null) {
    fail(`${label} has a renewal price but no first-year price`)
  }
  if (value.cadence === 'one-off' && renewalCents !== null) {
    fail(`${label} is a one-off purchase and cannot have a renewal price`)
  }
  if (estimate && firstYearCents !== null) {
    fail(`${label} carries both a quoted price and an estimate; an estimate is only for an unpriced item`)
  }

  const blockers = Object.freeze(value.blockers.map(normalizeBlocker))
  const blocking = blockers.filter(blocker => blocker.severity === 'blocking')

  // WHY AN ITEM CANNOT BE CHOSEN -- and note what is NOT in this list.
  //
  // A blocking blocker does NOT make an item unchoosable, and that is a
  // deliberate reversal. It used to. Measured against the real catalogue that
  // left 5 of 35 items pickable: the domain he needs most, and every company
  // option, could not be touched. The owner asked for a checkout he can "pick
  // and choose" from with "all options", and a shop where 86% of the shelf is
  // untouchable does not answer that.
  //
  // The reversal is safe because of what this screen actually does. Choosing
  // something here does not buy it -- confirming records a decision and moves
  // no money -- so refusing the click prevents nothing real. What a blocker
  // has to do is be impossible to miss, and it now is: it renders as a loud
  // band at the point of choice, it is counted on the running total bar, it
  // gets its own section above the totals on the review step, and every
  // blocked line is marked in the saved record. He engages with the reason
  // instead of being unable to reach the item and never reading it.
  //
  // Two things genuinely cannot be chosen, and both are about arithmetic
  // rather than advice:
  //   - an item with no price, because there is no number to add to a total;
  //   - the do-not-buy group, which exists to argue AGAINST buying, and where
  //     a checkbox would contradict the whole point of the group.
  let unselectableReason = null
  if (value.category === 'do-not-buy') {
    unselectableReason = 'This is on the do-not-buy list. It is here so you can see it was considered and why it was ruled out.'
  } else if (firstYearCents === null) {
    unselectableReason = estimate
      ? 'No quote yet. The range below is an estimate, not a price, so this cannot be added to a total.'
      : 'No quote yet. Nobody has priced this, so it cannot be added to a total.'
  }

  return Object.freeze({
    id: value.id,
    name: text(value.name, `${label} name`, 120),
    vendor: text(value.vendor, `${label} vendor`, 120),
    category: value.category,
    cadence: value.cadence,
    currency,
    firstYearCents,
    renewalCents,
    // A renewal only "differs" if there is something to differ from. This is
    // the flag the first-year-versus-renewal callout hangs on, and the owner's
    // stated reason for wanting it is that vendors advertise a cheap first
    // year and renew at several times the price.
    renewalDiffers: firstYearCents !== null && renewalCents !== null && renewalCents !== firstYearCents,
    estimate,
    priceVerified: value.priceVerified,
    priceVerifiedDate: value.priceVerifiedDate,
    quantityMax: value.quantityMax,
    recommended: value.defaultSelected,
    whatItIs: text(value.whatItIs, `${label} whatItIs`, 400),
    whatBreaksWithout: text(value.whatBreaksWithout, `${label} whatBreaksWithout`, 1000),
    whyHeWantedIt: text(value.whyHeWantedIt, `${label} whyHeWantedIt`, 900),
    sourceUrl: value.sourceUrl,
    warning: optionalText(value.warning, `${label} warning`, 1200),
    notes: optionalText(value.notes, `${label} notes`, 1500),
    blockers,
    blocking: Object.freeze(blocking),
    cautions: Object.freeze(blockers.filter(blocker => blocker.severity === 'caution')),
    selectable: unselectableReason === null,
    unselectableReason,
    // Choosable, but not safely buyable yet. Carried as its own flag rather
    // than inferred from `blocking.length` at each call site, so that every
    // surface -- the row, the bar, the review step, the saved record -- agrees
    // about which lines are blocked.
    blocked: blocking.length > 0,
    blockedReason: blocking.length > 0 ? blocking[0].summary : null,
  })
}

function normalizeCategory(value, seen) {
  exactKeys(value, ['id', 'label', 'blurb'], 'catalogue category')
  if (!CATEGORY_IDS.includes(value.id)) fail('catalogue category id is not one this build renders')
  if (seen.has(value.id)) fail(`catalogue category ${value.id} appears twice`)
  seen.add(value.id)
  return Object.freeze({
    id: value.id,
    label: text(value.label, 'category label', 80),
    blurb: text(value.blurb, 'category blurb', 300),
  })
}

function normalizeSpendPolicy(value, currency) {
  exactKeys(value, ['dailyLimitUsd', 'source', 'readAt'], 'spend policy')
  const dailyLimitCents = value.dailyLimitUsd === null
    ? null
    : toMinorUnits(value.dailyLimitUsd, currency, 'daily spend limit')
  if (value.readAt !== null && (typeof value.readAt !== 'string' || !Number.isFinite(Date.parse(value.readAt)))) {
    fail('spend policy readAt is malformed')
  }
  return Object.freeze({
    dailyLimitCents,
    source: text(value.source, 'spend policy source', 200),
    readAt: value.readAt,
  })
}

/**
 * Validate and normalize a parsed catalogue. Throws CatalogError with a reason
 * the screen can show; never returns a partial catalogue.
 */
export function normalizeCatalog(value) {
  exactKeys(value, ['version', 'generatedAt', 'currency', 'spendPolicy', 'categories', 'items'], 'purchase catalogue')
  if (value.version !== 2) fail(`purchase catalogue is version ${JSON.stringify(value.version)}, and this build reads version 2`)
  if (typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt))) {
    fail('purchase catalogue generatedAt is malformed')
  }
  if (!CURRENCY_RE.test(String(value.currency || ''))) fail('purchase catalogue currency is malformed')
  if (!Array.isArray(value.categories) || value.categories.length < 1 || value.categories.length > 8) {
    fail('purchase catalogue categories are malformed')
  }
  if (!Array.isArray(value.items) || value.items.length > 200) fail('purchase catalogue items are malformed')

  const seenCategories = new Set()
  const categories = value.categories.map(entry => normalizeCategory(entry, seenCategories))
  const seenIds = new Set()
  const items = value.items.map(entry => normalizeItem(entry, value.currency, seenCategories, seenIds))

  return Object.freeze({
    version: value.version,
    generatedAt: value.generatedAt,
    currency: value.currency,
    spendPolicy: normalizeSpendPolicy(value.spendPolicy, value.currency),
    categories: Object.freeze(categories),
    items: Object.freeze(items),
    byId: Object.freeze(new Map(items.map(item => [item.id, item]))),
  })
}

/** Items of one category, in the order the file lists them. */
export function itemsInCategory(catalog, categoryId) {
  return catalog.items.filter(item => item.category === categoryId)
}

/**
 * Fetch and normalize. The two failure modes are reported separately because
 * they mean different things to whoever has to fix it: "the list is not there"
 * is a packaging problem, "the list is not readable" is a data problem.
 */
export async function loadCatalog(url = 'data/purchase-catalog.json', fetchImpl = fetch) {
  let response
  try {
    response = await fetchImpl(url, { cache: 'no-store' })
  } catch (error) {
    throw new CatalogError(`The purchase list could not be reached (${error?.message || 'no response'}).`)
  }
  if (!response.ok) throw new CatalogError(`The purchase list is not installed with this build (${response.status}).`)
  let parsed
  try {
    parsed = await response.json()
  } catch {
    throw new CatalogError('The purchase list is not readable JSON, so it is not being shown rather than shown wrongly.')
  }
  return normalizeCatalog(parsed)
}
