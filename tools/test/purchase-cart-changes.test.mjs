import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CART_CHANGE_EVENT,
  cartChangeCount,
  cartChanges,
  describeCartChanges,
  noteResetClears,
  recordCartReading,
  resetCartChanges,
} from '../../src/purchase-cart-changes.js'

const AT = 1_780_000_000_000

function line(overrides = {}) {
  return {
    id: 'line-coffee',
    text: 'Coffee for the client meeting',
    amountCents: 1_200,
    amountText: '$12.00',
    ...overrides,
  }
}

function view(overrides = {}) {
  return {
    id: 'prompt-trip',
    kind: 'purchase_batch',
    title: 'Client trip supplies',
    expiresAt: AT + 60_000,
    deadlineDate: 'May 27',
    totalCents: 1_200,
    totalText: '$12.00',
    lines: [line()],
    ...overrides,
  }
}

function snapshot(...views) {
  return new Map(views.map(item => [item.id, {
    ...item,
    lines: new Map(item.lines.map(entry => [entry.id, entry])),
  }]))
}

test.beforeEach(() => resetCartChanges())

test('the first real caller-shaped reading is only a baseline', () => {
  const result = recordCartReading([view()], AT)

  assert.equal(result.firstReading, true,
    'the initial reading must identify itself as a baseline, not a definite no-change result')
  assert.deepEqual(result.added, [],
    'the initial cart must not be announced as newly added purchases')
  assert.equal(cartChangeCount(), 0,
    'establishing a baseline must not add visible change history')
})

test('an unreadable reading does not replace the baseline or claim a definite answer', () => {
  recordCartReading([view()], AT)

  const unreadable = recordCartReading(null, AT + 1)
  assert.deepEqual(unreadable, { firstReading: false, added: [] },
    'a could-not-read result must be distinguishable from both a first reading and reported changes')

  const recovered = recordCartReading([], AT + 2)
  assert.equal(recovered.added.length, 1,
    'a failed read must preserve the prior baseline so recovery still reports a disappeared request')
})

test('the comparison names visible line, price, date, and queue changes without inventing a reason', () => {
  const before = snapshot(view())
  const after = snapshot(view({
    expiresAt: AT + 120_000,
    deadlineDate: 'May 28',
    lines: [
      line({ amountCents: 1_500, amountText: '$15.00' }),
      line({ id: 'line-taxi', text: 'Taxi to the client', amountCents: 2_000, amountText: '$20.00' }),
    ],
  }))
  const changed = describeCartChanges(before, after, AT)

  assert.ok(changed.some(entry => entry.text.includes('May 28')),
    'a moved deadline must name the new displayed date')
  assert.ok(changed.some(entry => entry.text.includes('$12.00') && entry.text.includes('$15.00')),
    'a price change must name both the previous and current displayed amounts')
  assert.ok(changed.some(entry => entry.text.includes('Taxi to the client') && entry.text.includes('$20.00')),
    'an added line must name the displayed purchase and amount')

  const removed = describeCartChanges(after, new Map(), AT + 1)
  assert.ok(removed[0].text.includes('Client trip supplies'),
    'a request leaving the queue must still identify the request')
  assert.match(removed[0].text, /Either\b.*\bor\b/i,
    'a disappeared request must offer both possible causes rather than assert approval or expiry')
})

test('recorded changes are newest-first, bounded, announced, and returned as protected copies', () => {
  const events = []
  const oldWindow = globalThis.window
  const oldCustomEvent = globalThis.CustomEvent
  globalThis.window = { dispatchEvent: event => events.push(event) }
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, options) { this.type = type; this.detail = options.detail }
  }
  try {
    recordCartReading([view()], AT)
    for (let index = 1; index <= 45; index += 1) {
      recordCartReading([view({
        lines: [line({ amountCents: 1_200 + index, amountText: `$${12 + index / 100}` })],
      })], AT + index)
    }

    const history = cartChanges()
    assert.equal(history.length, 40,
      'visible cart history must remain bounded to the documented forty newest changes')
    assert.ok(history[0].atMs > history.at(-1).atMs,
      'the history shown to the caller must be newest-first')
    assert.equal(events.at(-1).type, CART_CHANGE_EVENT,
      'a new recorded change must announce the exported cart-change event')
    assert.equal(events.at(-1).detail.count, 40,
      'the announcement must carry the bounded visible history count')
    assert.throws(() => { history[0].text = 'silently rewritten' }, TypeError,
      'a caller must not be able to rewrite a returned history entry')
  } finally {
    if (oldWindow === undefined) delete globalThis.window
    else globalThis.window = oldWindow
    if (oldCustomEvent === undefined) delete globalThis.CustomEvent
    else globalThis.CustomEvent = oldCustomEvent
  }
})

test('reset removes both account history and its comparison baseline', () => {
  recordCartReading([view()], AT)
  recordCartReading([], AT + 1)
  resetCartChanges()

  assert.equal(cartChangeCount(), 0,
    'sign-out reset must remove the previous account cart history')
  assert.equal(recordCartReading([view()], AT + 2).firstReading, true,
    'sign-out reset must make the next account cart a fresh baseline')
})

/* A LIST THE PERSON'S OWN RESET CLEARED IS NOT "DECIDED OR EXPIRED" (T1532). */
test('a request a purchases reset cleared is said to be cleared by the reset, and only that one', () => {
  resetCartChanges()
  const other = view({ id: 'prompt-other', title: 'Printer paper' })
  recordCartReading([view(), other], AT)
  assert.deepEqual(noteResetClears(['prompt-other']), ['prompt-trip'])
  const after = recordCartReading([other], AT + 1)
  assert.deepEqual(after.added.map(entry => entry.text), ['Client trip supplies was cleared by your purchases reset.'])
  assert.doesNotMatch(after.added[0].text, /Either you decided it, or its date passed/)
  /* The next list that leaves for its own reasons keeps the honest either-or. */
  const later = recordCartReading([], AT + 2)
  assert.deepEqual(later.added.map(entry => entry.text), ['Printer paper is no longer waiting for you. Either you decided it, or its date passed.'])
  resetCartChanges()
  assert.deepEqual(noteResetClears([]), [], 'with no reading there is nothing to attribute')
})
