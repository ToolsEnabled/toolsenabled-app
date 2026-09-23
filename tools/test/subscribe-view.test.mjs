import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const VIEW = readFileSync(new URL('../../src/views/subscribe.js', import.meta.url), 'utf8')
const MAIN = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8')
const absent = VIEW.slice(VIEW.indexOf('function unavailableMarkup'), VIEW.indexOf('export function subscribeView'))

test('the catalog-absence face states coming soon instead of a malfunction', () => {
  assert.ok(absent.length > 0, 'the catalog-absence renderer was not found')
  assert.match(absent, /<h1>Subscriptions are not open yet<\/h1>/)
  assert.match(absent, /<p class="sub-refusal-title">Nothing was started and nothing was charged\.<\/p>/)
  assert.match(absent, /\$\{esc\(SUBSCRIPTION_DISABLED_HINT\)\}/)
  assert.match(absent, /The product itself is unaffected: it is free, and it does not need this page or\s+any subscription to run\./)
  assert.doesNotMatch(absent, /Plans cannot be shown right now/)
  assert.doesNotMatch(absent, /\$\{esc\(reason\)\}/, 'the technical catalog failure is still printed to visitors')
})

test('the interim and route labels do not advertise an open subscribe action', () => {
  assert.match(VIEW, /Checking subscription availability…/)
  assert.doesNotMatch(VIEW, /Loading plans…/)
  assert.match(MAIN, /case 'subscribe': return `\$\{base\} \/ subscriptions \/ coming soon`/)
})
