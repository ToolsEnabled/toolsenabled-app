// Example snippets, shipped as ordinary content rather than as product
// structure.
//
// WHAT A SNIPPET IS HERE. A snippet is one of four things -- a reason to buy,
// how to buy (buy details), a reason to sell, how to sell (sell details). Every
// bundle below is one of those four, carries exactly one label naming which,
// and carries nothing else in `labels`. Provenance lives in `source`, never in
// a label.
//
// WHOSE WORDS THESE ARE. The wording is synthetic: it was written for this
// example set and describes no real study.
//
// STILL DATA, NOT SCHEMA. Nothing here is privileged. Every bundle is an
// ordinary catalog entry with the shape any snippet has, and the labels are
// text on those bundles, so the category strip reads them exactly as it reads a
// label somebody typed. No code anywhere reads an identifier, a label, a role
// or a slot name out of this file -- delete every one of them and the page
// behaves as it did before they were loaded.
//
// They reach the library through exportSnippetLibrary/importSnippetLibrary, the
// same path a person's own exported file takes, so an example set cannot
// acquire any capability an imported file does not have.
//
// 4 snippets: Reason to buy 1, Buy details 1, Reason to sell 1, Sell details 1.

const SOURCE_ROOT = 'examples'

const EXAMPLES = [
  {"id":"ex-reason-to-buy-01","version":"1","kind":"atom","role":"reason_to_buy","title":"Reason to buy — SPY's close crosses above its 50-day simple moving average.","labels":["Reason to buy"],"text":"SPY's close crosses above its 50-day simple moving average.","parameters":{},"semantics":{"kind":"prompt"},"source":"synthetic.txt"},
  {"id":"ex-buy-details-01","version":"1","kind":"atom","role":"buy_details","title":"Buy details — invest 25% of total portfolio value in SPY.","labels":["Buy details"],"text":"invest 25% of total portfolio value in SPY.","parameters":{},"semantics":{"kind":"prompt"},"source":"synthetic.txt"},
  {"id":"ex-reason-to-sell-01","version":"1","kind":"atom","role":"reason_to_sell","title":"Reason to sell — SPY's close crosses below its 50-day simple moving average.","labels":["Reason to sell"],"text":"SPY's close crosses below its 50-day simple moving average.","parameters":{},"semantics":{"kind":"prompt"},"source":"synthetic.txt"},
  {"id":"ex-sell-details-01","version":"1","kind":"atom","role":"sell_details","title":"Sell details — liquidate Strategy A's entire lot.","labels":["Sell details"],"text":"liquidate Strategy A's entire lot.","parameters":{},"semantics":{"kind":"prompt"},"source":"synthetic.txt"},
]

export const EXAMPLE_SNIPPET_IDS = Object.freeze(EXAMPLES.map(bundle => bundle.id))

// The provenance note each bundle carries, under the examples folder. Kept so
// a line in the library can always be traced back to where it came from.
export const EXAMPLE_SOURCES = Object.freeze(Object.fromEntries(
  EXAMPLES.map(bundle => [bundle.id, `${SOURCE_ROOT}/${bundle.source}`])))

// The same file shape Export snippets writes and Import snippets reads. The
// source note travels with each bundle, so a person who exports the library
// still holds the provenance of every line in it.
export function exampleSnippetLibrary() {
  return { format: 'benchmark-snippet-library', version: 1, catalog: structuredClone(EXAMPLES) }
}

// True only of a bundle this file shipped and that nobody has edited since.
// Used to describe the library, never to grant an example anything.
export function isExampleSnippet(bundle) {
  const source = EXAMPLES.find(item => item.id === bundle?.id)
  if (!source || !bundle) return false
  const { review, ...content } = bundle
  return JSON.stringify(sorted(source)) === JSON.stringify(sorted(content))
}

function sorted(value) {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(sorted)
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]))
}
