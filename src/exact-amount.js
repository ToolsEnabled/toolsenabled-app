/* ONE PLACE THAT TURNS AN AMOUNT OF MONEY INTO WORDS ON A SCREEN.
 *
 * It was inside src/owner-popup.js, which is a drawing module that reaches the
 * audited connection. src/purchase-cart-view.js needs the same formatting and
 * must stay free of both, so the function moved here and owner-popup.js now
 * passes it straight through. Every existing import of it is unchanged.
 *
 * WHY IT TAKES WHOLE MINOR UNITS AND NOTHING ELSE. An amount that has been
 * through a fraction is an amount that can be off by a cent, and this is the
 * surface a person approves spending on. So it is an integer count of the
 * smallest unit the currency has, and the number of decimal places comes from
 * the currency itself rather than from an assumption that there are two: yen
 * has none, and Bahraini dinar has three.
 */

const CURRENCY_RE = /^[A-Z]{3}$/

function currencyDigits(currency) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits
}

/** Format an exact whole-minor-unit amount, including zero-decimal currencies. */
export function formatExactAmount(amountCents, currency) {
  if (!Number.isSafeInteger(amountCents) || amountCents < 0 || !CURRENCY_RE.test(String(currency || ''))) {
    throw new Error('amount is malformed')
  }
  const digits = currencyDigits(currency)
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits,
  }).format(amountCents / (10 ** digits))
}
