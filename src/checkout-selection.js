// What he chose, what it costs, and what the engine's spend cap would do to it.
//
// This module holds no DOM and imports nothing, so every rule below is
// exercised by tools/test/checkout-selection.test.mjs in plain node rather
// than being reasoned about through a screenshot.
//
// TWO TOTALS, BECAUSE THEY ARE TWO DIFFERENT COMMITMENTS.
//
// "Cash today" is what leaves the account if he buys the selection now.
// "Every year after" is what he is signed up for annually once the first year
// is behind him. Adding those together, or showing only one, is how somebody
// agrees to a $9.99 charge and finds out later it was $9.99 a month. They are
// computed separately from the same lines and never summed.
//
// EVERY FIGURE IS INTEGER MINOR UNITS. src/checkout-catalog.js converts the
// authored dollars exactly, once; nothing here ever multiplies a float.

export const SELECTION_STORAGE_KEY = 'mc.checkout.v1'
const RECORD_VERSION = 1
const MONTHS_PER_YEAR = 12

/**
 * What one selected line costs now, and what it costs every year after.
 *
 * The cadence is the whole of the rule and it is deliberately explicit rather
 * than clever:
 *   one-off   paid once. Costs nothing next year.
 *   annual    firstYear now; renewal (or the same price again) every year after.
 *   monthly   the authored price IS the monthly charge, so one month leaves the
 *             account now and twelve are owed across a year.
 */
export function lineCost(item, quantity) {
  const units = Number.isSafeInteger(quantity) && quantity > 0 ? quantity : 0
  if (item.firstYearCents === null || units === 0) return { cashTodayCents: 0, recurringAnnualCents: 0 }
  const cashTodayCents = item.firstYearCents * units
  if (item.cadence === 'one-off') return { cashTodayCents, recurringAnnualCents: 0 }
  if (item.cadence === 'monthly') {
    return { cashTodayCents, recurringAnnualCents: item.firstYearCents * units * MONTHS_PER_YEAR }
  }
  const renewalUnit = item.renewalCents === null ? item.firstYearCents : item.renewalCents
  return { cashTodayCents, recurringAnnualCents: renewalUnit * units }
}

/**
 * The spend cap, applied the way the engine would actually apply it.
 *
 * src/lib/providers/pay.js checks ONE amount at a time against the daily
 * limit, so a batch containing a line above the cap does not fail as a batch:
 * that line is refused and the cheaper ones are recorded. The UI has to say
 * that in those terms, because "some of it worked" is the failure a person
 * misreads as success.
 */
export function capAssessment(catalog, lines) {
  const limitCents = catalog.spendPolicy.dailyLimitCents
  if (limitCents === null) {
    return Object.freeze({
      known: false, limitCents: null, overCapLineIds: Object.freeze([]),
      cashTodayCents: lines.reduce((sum, line) => sum + line.cashTodayCents, 0),
      totalOverCap: false, refusableCents: 0, recordableCents: 0,
    })
  }
  const overCapLines = lines.filter(line => line.cashTodayCents > limitCents)
  const cashTodayCents = lines.reduce((sum, line) => sum + line.cashTodayCents, 0)
  return Object.freeze({
    known: true,
    limitCents,
    overCapLineIds: Object.freeze(overCapLines.map(line => line.id)),
    cashTodayCents,
    // The cart total can exceed a per-item cap without any single line doing
    // so. That is a different fact and gets its own sentence on screen.
    totalOverCap: cashTodayCents > limitCents,
    refusableCents: overCapLines.reduce((sum, line) => sum + line.cashTodayCents, 0),
    recordableCents: lines.filter(line => line.cashTodayCents <= limitCents)
      .reduce((sum, line) => sum + line.cashTodayCents, 0),
  })
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Read persisted state, keeping only what is still true.
 *
 * Reconciliation is not tidying. Between two launches an item can vanish from
 * the catalogue, acquire a blocker, lose its price, or change price. The first
 * three mean the line is no longer choosable and is dropped -- carrying it
 * would put an amount in his total that the catalogue no longer stands behind.
 * The fourth is NOT dropped: it is kept and reported, because a price that
 * moved under a choice he already made is the single thing on this screen he
 * would most want to be told about, and silently re-totalling is how the
 * cheap-first-year trap works.
 */
export function reconcileStoredSelections(catalog, stored) {
  const empty = { selections: new Map(), priceChanges: [], dropped: [] }
  if (!plainObject(stored) || stored.v !== RECORD_VERSION || !Array.isArray(stored.selections)) return empty

  const selections = new Map()
  const priceChanges = []
  const dropped = []
  for (const entry of stored.selections) {
    if (!plainObject(entry) || typeof entry.id !== 'string') continue
    const item = catalog.byId.get(entry.id)
    if (!item) { dropped.push({ id: entry.id, name: null, reason: 'It is no longer on the list.' }); continue }
    if (!item.selectable) { dropped.push({ id: item.id, name: item.name, reason: item.unselectableReason }); continue }
    const quantity = Number.isSafeInteger(entry.qty) && entry.qty > 0
      ? Math.min(entry.qty, item.quantityMax)
      : 1
    selections.set(item.id, quantity)
    if (Number.isSafeInteger(entry.pricedAtCents) && entry.pricedAtCents !== item.firstYearCents) {
      priceChanges.push({
        id: item.id, name: item.name,
        wasCents: entry.pricedAtCents, nowCents: item.firstYearCents,
      })
    }
  }
  return { selections, priceChanges, dropped }
}

/**
 * A storage face whose read result never confuses "absent" with "could not read".
 * localStorage throws in private mode and on quota; only its null result means
 * the key is absent. A failed read is deliberately not cached, so a later read
 * can succeed when a transiently busy machine recovers.
 */
export function safeStorage(backing) {
  return Object.freeze({
    read(key) {
      try {
        const raw = backing?.getItem(key)
        return typeof raw === 'string' ? JSON.parse(raw) : null
      } catch (cause) {
        const error = new Error(
          'The saved checkout selection could not be read; this is not claiming that it is absent.',
          { cause },
        )
        error.code = 'CHECKOUT_SELECTION_READ_FAILED'
        throw error
      }
    },
    write(key, value) {
      try { backing?.setItem(key, JSON.stringify(value)); return true }
      catch { return false }
    },
  })
}

/**
 * The selection store.
 *
 * `onChange` fires after every mutation with a fresh immutable summary, and a
 * write to storage happens on the same beat: there is no save button on this
 * screen, so a choice that is on screen and not on disk is a lie the next
 * launch tells.
 */
export function createSelectionStore({ catalog, storage, now = () => new Date().toISOString(), onChange = () => {} }) {
  const stored = storage.read(SELECTION_STORAGE_KEY)
  const reconciled = reconcileStoredSelections(catalog, stored)
  const selections = reconciled.selections
  let confirmed = plainObject(stored) && plainObject(stored.confirmed) ? stored.confirmed : null
  // Reported once, on the visit that discovers them, then cleared by the
  // acknowledge below. A permanent banner about a change he has already read
  // is noise that trains him to ignore the banner that matters.
  let priceChanges = reconciled.priceChanges
  let dropped = reconciled.dropped
  // Persist immediately when reconciliation actually changed the stored set,
  // so a dropped line cannot come back on the next launch.
  let persistedFailed = false

  function serialize() {
    return {
      v: RECORD_VERSION,
      catalogGeneratedAt: catalog.generatedAt,
      selections: [...selections].map(([id, qty]) => ({
        id, qty, pricedAtCents: catalog.byId.get(id).firstYearCents,
      })),
      confirmed,
    }
  }

  function persist() {
    persistedFailed = !storage.write(SELECTION_STORAGE_KEY, serialize())
    return !persistedFailed
  }

  function selectedLines() {
    const lines = []
    for (const [id, quantity] of selections) {
      const item = catalog.byId.get(id)
      if (!item) continue
      lines.push({ id, item, quantity, ...lineCost(item, quantity) })
    }
    return lines
  }

  function summary() {
    const lines = selectedLines()
    return Object.freeze({
      lines: Object.freeze(lines),
      count: lines.length,
      unitCount: lines.reduce((sum, line) => sum + line.quantity, 0),
      cashTodayCents: lines.reduce((sum, line) => sum + line.cashTodayCents, 0),
      recurringAnnualCents: lines.reduce((sum, line) => sum + line.recurringAnnualCents, 0),
      // Chosen, but not safely buyable yet. Surfaced on the running bar and
      // given its own section on the review step: a blocked line is choosable
      // precisely BECAUSE nothing here buys it, and the compensating duty is
      // that it can never be quietly carried through to a confirmed decision.
      blockedLines: Object.freeze(lines.filter(line => line.item.blocked)),
      cap: capAssessment(catalog, lines),
      priceChanges: Object.freeze([...priceChanges]),
      dropped: Object.freeze([...dropped]),
      confirmed,
      persistenceFailed: persistedFailed,
    })
  }

  function announce() {
    persist()
    onChange(summary())
  }

  if (reconciled.dropped.length > 0) persist()

  return Object.freeze({
    summary,
    quantityOf(id) { return selections.get(id) || 0 },
    isSelected(id) { return selections.has(id) },

    setSelected(id, selected) {
      const item = catalog.byId.get(id)
      // An unselectable item is refused HERE and not only in the markup. A
      // disabled control is a presentation fact; this is the rule.
      if (!item || !item.selectable) return summary()
      if (selected) selections.set(id, selections.get(id) || 1)
      else selections.delete(id)
      // Any change to the basket invalidates a previous confirmation: a record
      // that says he approved four lines must not survive him adding a fifth.
      confirmed = null
      announce()
      return summary()
    },

    setQuantity(id, quantity) {
      const item = catalog.byId.get(id)
      if (!item || !item.selectable || !selections.has(id)) return summary()
      const bounded = Math.max(1, Math.min(item.quantityMax, Number.isSafeInteger(quantity) ? quantity : 1))
      selections.set(id, bounded)
      confirmed = null
      announce()
      return summary()
    },

    selectRecommendedIn(categoryId) {
      for (const item of catalog.items) {
        if (item.category !== categoryId || !item.recommended || !item.selectable) continue
        if (!selections.has(item.id)) selections.set(item.id, 1)
      }
      confirmed = null
      announce()
      return summary()
    },

    clearAll() {
      selections.clear()
      confirmed = null
      announce()
      return summary()
    },

    acknowledgeNotices() {
      priceChanges = []
      dropped = []
      onChange(summary())
      return summary()
    },

    /**
     * Write the durable decision record.
     *
     * This is NOT a receipt and the shape deliberately does not resemble one:
     * no order id, no payment method, no merchant reference, nothing that
     * could later be mistaken for evidence that money moved.
     *
     * IT REFUSES WITHOUT A NAMED PRINCIPAL, and that check lives here rather
     * than only in the view. The owner's condition is that a decision he did
     * not make must never be recorded in his name, and a disabled button is a
     * presentation fact -- this is the rule. A caller that skips the UI gets
     * the same refusal: the record stays null and nothing is written.
     *
     * WHAT THIS RECORD IS NOT. It is composed and stored in the renderer, so
     * it is a durable note of what he chose, for him. It is not an audit
     * record and nothing here calls it one; an identity a page can choose is
     * not an identity. The vault half of his condition is carried explicitly
     * as unverified rather than omitted, so the record cannot read as though
     * both halves passed.
     */
    confirm({ principal = null } = {}) {
      const current = summary()
      if (current.count === 0) return current
      if (!principal || typeof principal.id !== 'string' || principal.id.trim().length === 0) {
        return current
      }
      confirmed = {
        at: now(),
        recordKind: 'local-decision-note',
        approvedBy: {
          id: principal.id,
          displayName: typeof principal.displayName === 'string' && principal.displayName
            ? principal.displayName
            : principal.id,
        },
        vaultVerified: principal.vault?.verified === true,
        vaultNote: typeof principal.vault?.summary === 'string' ? principal.vault.summary : null,
        currency: catalog.currency,
        catalogGeneratedAt: catalog.generatedAt,
        lines: current.lines.map(line => ({
          id: line.id,
          name: line.item.name,
          vendor: line.item.vendor,
          cadence: line.item.cadence,
          quantity: line.quantity,
          unitCents: line.item.firstYearCents,
          cashTodayCents: line.cashTodayCents,
          recurringAnnualCents: line.recurringAnnualCents,
          blocked: line.item.blocked,
          blockedReason: line.item.blockedReason,
        })),
        cashTodayCents: current.cashTodayCents,
        recurringAnnualCents: current.recurringAnnualCents,
        capLimitCents: current.cap.limitCents,
        overCapLineIds: current.cap.overCapLineIds,
        // THE CAVEAT IS ALSO HOISTED TO THE TOP LEVEL, next to overCapLineIds
        // and for the same reason. Every line already carries `blocked` and
        // `blockedReason`, but a future consumer that turns a saved record into
        // an action is most likely to read the summary fields and act -- and a
        // record that says "yes" is only safe while something reads the second
        // half of the sentence. A caveat reachable only by iterating lines is a
        // caveat waiting to be skipped, so refusing on a non-empty list here
        // takes one check rather than a loop nobody remembers to write.
        //
        // This is not enforcement: nothing consumes these records today, and
        // this module cannot bind a consumer that does not exist. It is the
        // most legible shape to refuse on, put there deliberately.
        blockedLineIds: current.blockedLines.map(line => line.id),
      }
      announce()
      return summary()
    },
  })
}
