import assert from 'node:assert/strict'
import test from 'node:test'

import { formatExactAmount } from '../../src/exact-amount.js'

/* These are the shapes passed by purchase-cart-view.js and owner-popup.js:
 * non-negative integer minor units and an uppercase ISO-style currency code.
 * Test the resulting money claims directly; this module is pure and needs no
 * DOM stand-in. */

test('caller-shaped amounts retain their smallest unit instead of being read as major units', () => {
  assert.deepEqual(
    [formatExactAmount(973, 'USD'), formatExactAmount(0, 'USD')],
    ['$9.73', '$0.00'],
    'USD minor units, including zero, must retain their cent scale',
  )
})

test('currency metadata, not an assumed two decimals, determines the minor-unit scale', () => {
  assert.deepEqual(
    [formatExactAmount(973, 'JPY'), formatExactAmount(973, 'BHD')],
    ['¥973', 'BHD 0.973'],
    'zero- and three-decimal currencies must use their own minor-unit scales',
  )
})

test('unreadable amounts fail rather than becoming a definite price', () => {
  for (const [amount, currency] of [
    [1.5, 'USD'],
    [-1, 'USD'],
    [Number.MAX_SAFE_INTEGER + 1, 'USD'],
    [100, 'usd'],
    [100, 'US'],
    [100, null],
  ]) {
    assert.throws(
      () => formatExactAmount(amount, currency),
      /amount is malformed/,
      `an unreadable amount (${String(amount)}, ${String(currency)}) must not become a definite price`,
    )
  }
})
