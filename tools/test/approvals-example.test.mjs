/* The approvals view calls approvalsFace() at mount and exampleOwnerPrompts(now)
 * when it paints the demonstration.  Keep this test on that public seam: a
 * mistaken face can mislabel a real decision queue, while an actionable
 * example card can make a visitor believe a decision was actually recorded. */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import {
  APPROVALS_EXAMPLE_MARKING,
  approvalsFace,
  exampleOwnerPrompts,
} from '../../src/approvals-example.js'

const savedWindow = globalThis.window
const savedLocalStorage = globalThis.localStorage

afterEach(() => {
  if (savedWindow === undefined) delete globalThis.window
  else globalThis.window = savedWindow
  if (savedLocalStorage === undefined) delete globalThis.localStorage
  else globalThis.localStorage = savedLocalStorage
})

function storageWithExample(value) {
  return { getItem: key => key === 'mc.example' ? value : null }
}

test('the inputs used at view mount distinguish chosen examples from a real desktop queue', () => {
  globalThis.localStorage = storageWithExample('on')
  globalThis.window = {}
  assert.equal(approvalsFace(), 'demonstration',
    'the chosen example was not identified as a demonstration')

  globalThis.localStorage = storageWithExample(null)
  globalThis.window = { mcShell: { getBridgeProof() {} } }
  assert.equal(approvalsFace(), 'this-computer',
    'a real desktop approval queue was labelled as example data')
})

test('an unreadable source is not collapsed into a claim that the queue is example data', () => {
  for (const unreadable of [null, undefined]) {
    assert.equal(approvalsFace({ source: () => unreadable }), 'this-computer',
      `the ${String(unreadable)} source was labelled as a demonstration`)
  }
})

test('example requests preserve denial, accounting, and deadline safety properties', () => {
  const now = Date.UTC(2026, 7, 26, 12)
  const prompts = exampleOwnerPrompts(now)
  const purchase = prompts.find(prompt => prompt.kind === 'purchase_batch')
  const confirmation = prompts.find(prompt => prompt.kind === 'confirmation')

  assert.equal(prompts.length, 2, 'the example no longer covers both caller-rendered request kinds')
  assert.equal(purchase?.defaultDecision, 'deny', 'the purchase example no longer fails closed')
  assert.equal(confirmation?.defaultDecision, 'deny', 'the confirmation example no longer fails closed')
  assert.equal(purchase.items.reduce((sum, item) => sum + item.amountCents, 0), purchase.totalCents,
    'the displayed purchase total differs from the amounts a person reviews')
  for (const prompt of prompts) {
    assert.ok(Date.parse(prompt.createdAt) < now, `${prompt.id} does not read as already requested`)
    assert.ok(Date.parse(prompt.expiresAt) > now, `${prompt.id} is already expired when painted`)
  }
})

test('the disabled example controls carry the reason they cannot succeed', () => {
  assert.match(APPROVALS_EXAMPLE_MARKING.cardStatus, /example request, not yours/i,
    'the card does not identify whose request it is')
  assert.match(APPROVALS_EXAMPLE_MARKING.cardStatus, /controls stay off/i,
    'the card does not disclose that its controls are disabled')
  assert.match(APPROVALS_EXAMPLE_MARKING.cardStatus, /nothing can be approved/i,
    'the disabled controls do not carry their reason')
})
