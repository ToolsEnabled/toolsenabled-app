/* THE APPROVALS SCREEN MARKS ITS DEMONSTRATION, THE WAY EVERY OTHER SCREEN DOES.
 *
 * The paid lane's walk of the vendored simulation build (their commit 36010d5,
 * reassigned to this repository by legal's launch delivery): every landing view
 * labels its own example data -- home's "Example, not your data" badge, the
 * metrics face and its "made-up numbers" note, research's source line -- and
 * the approvals view alone carried no marking of any kind. On the simulation
 * build it showed an unreachable-service state instead, which on a marketing
 * page reads as a broken product, and on any screen leaves a visitor free to
 * read whatever it shows as somebody's real decision queue.
 *
 * WHAT "DEMONSTRATION" MEANS FOR THIS VIEW, precisely. Approvals has no
 * switch of its own, because its data is the audited queue and there is
 * nothing per-view to toggle. The one state in which this screen is part of a
 * demonstration is when the whole product is showing its built-in example --
 * which is exactly what src/data-source.js answers 'mock' for: the example
 * toggle is on, or a signed-out browser has no machine behind it. So the face
 * is derived from the source axis: a KNOWN mock source means demonstration;
 * any real source -- this computer's own, or the person's machine over the
 * relay -- means this screen reads the live queue as it always has, and a
 * source that is not yet known is never rounded to the example, because
 * badging a person's real queue is the one direction the marking must not
 * miss in.
 *
 * The view module imports the DOM-bound component layer and cannot be executed
 * under node:test (the same limit tools/test/first-run-tier-screen.test.mjs
 * records for setup), so the pure half is exercised for real and the view's
 * wiring is source-asserted; the behaviour itself is driven on the packaged
 * build by tools/approvals-example-qa.mjs, in both states, with screenshots.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  APPROVALS_EXAMPLE_MARKING,
  APPROVALS_FACES,
  approvalsFace,
  exampleOwnerPrompts,
} from '../../src/approvals-example.js'
import { cartSummary } from '../../src/purchase-cart-view.js'
import { sentencesOf, wordsOf } from '../lib/user-visible-strings.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const VIEW = readFileSync(path.join(REPO_ROOT, 'src', 'ledger-prompt-queue.js'), 'utf8')

/* ---------- the face ---------- */

/* The input axis moved from "are all seven view flags simulated" to "what is
   the data source" when the per-view flags collapsed into the one example
   toggle. The DERIVATION INVARIANTS these three tests hold are unchanged:
   only the whole-product example state wears the demonstration face, any
   real data keeps the live queue, and no ambiguity is ever rounded toward
   an unmarked example or a badged real queue. */

test('the mock source means the approvals screen is part of the demonstration', () => {
  assert.equal(approvalsFace({ source: () => 'mock' }), 'demonstration')
})

test('any real source keeps approvals on the live queue', () => {
  for (const real of ['local', 'relay']) {
    assert.equal(approvalsFace({ source: () => real }), 'this-computer',
      `the ${real} source read as a demonstration, which would badge a person's real queue`)
  }
})

test('a source not yet known is never rounded to the demonstration, and the face is always a declared one', () => {
  /* currentDataSource() is null before the first resolution completes. The
     honest face for "not yet known" is the live one: the poll reports its own
     failure in its own words, while a wrongly-badged real queue would tell a
     person their actual decisions are invented. */
  for (const unknown of [null, undefined, '']) {
    const face = approvalsFace({ source: () => unknown })
    assert.equal(face, 'this-computer', `${String(unknown)} was rounded to the demonstration`)
    assert.ok(APPROVALS_FACES.includes(face))
  }
  assert.ok(APPROVALS_FACES.includes(approvalsFace({ source: () => 'mock' })))
})

/* ---------- the words ---------- */

test('the marking uses the words the other screens already use, and every sentence is plain', () => {
  assert.equal(APPROVALS_EXAMPLE_MARKING.badge, 'Example, not your data',
    'the badge does not carry the exact words home uses, so the product would label one thing two ways')
  assert.match(APPROVALS_EXAMPLE_MARKING.source, /^example data — switch off the example fleet in settings/,
    'the source line does not follow the research page’s shape, or still names the retired per-view Live data switch')
  assert.match(APPROVALS_EXAMPLE_MARKING.queueNote, /example/i)
  assert.match(APPROVALS_EXAMPLE_MARKING.cardStatus, /example/i)
  assert.doesNotMatch(APPROVALS_EXAMPLE_MARKING.cardStatus, /unavailable|error|failed/i,
    'an example is a chosen state, not a failure')
  for (const text of Object.values(APPROVALS_EXAMPLE_MARKING)) {
    assert.equal(typeof text, 'string')
    for (const sentence of sentencesOf(text)) {
      assert.ok(wordsOf(sentence).length <= 25, `${wordsOf(sentence).length} words: "${sentence}"`)
    }
  }
})

/* ---------- the example queue ---------- */

test('every example prompt is shaped like the wire’s own prompts, and says it is an example', () => {
  const now = Date.UTC(2026, 7, 18, 12, 0, 0)
  const prompts = exampleOwnerPrompts(now)
  assert.ok(prompts.length >= 2, 'fewer than two example requests cannot show a purchase and a confirmation')
  const ids = new Set()
  for (const prompt of prompts) {
    assert.match(prompt.id, /^example-/, 'an example id that could collide with a real request id')
    assert.ok(!ids.has(prompt.id)); ids.add(prompt.id)
    assert.ok(['purchase_batch', 'confirmation', 'notice'].includes(prompt.kind))
    assert.equal(prompt.state, 'pending')
    assert.equal(new Date(Date.parse(prompt.createdAt)).toISOString(), prompt.createdAt, 'createdAt is not canonical')
    assert.equal(new Date(Date.parse(prompt.expiresAt)).toISOString(), prompt.expiresAt, 'expiresAt is not canonical')
    assert.ok(Date.parse(prompt.expiresAt) > Date.parse(prompt.createdAt))
    assert.match(`${prompt.title} ${prompt.message}`, /example/i, 'a prompt that does not say it is an example')
    for (const sentence of [...sentencesOf(prompt.title), ...sentencesOf(prompt.message)]) {
      assert.ok(wordsOf(sentence).length <= 25, sentence)
    }
    if (prompt.kind === 'purchase_batch') {
      assert.equal(prompt.items.reduce((sum, item) => sum + item.amountCents, 0), prompt.totalCents,
        'the example total is not the sum of its own lines -- the defect the live screen refuses')
      assert.ok(prompt.items.every(item => item.currency === prompt.currency))
      assert.equal(prompt.defaultDecision, 'deny')
    }
  }
  assert.ok(prompts.some(prompt => prompt.kind === 'purchase_batch'))
  assert.ok(prompts.some(prompt => prompt.kind !== 'purchase_batch'))
})

test('the example queue is stable for a given clock, so the screen cannot invent data on every paint', () => {
  const now = Date.UTC(2026, 7, 18, 12, 0, 0)
  assert.deepEqual(exampleOwnerPrompts(now), exampleOwnerPrompts(now))
})

test('the derived layer the live screen uses digests the example queue whole', () => {
  const now = Date.UTC(2026, 7, 18, 12, 0, 0)
  const summary = cartSummary(exampleOwnerPrompts(now), now)
  assert.equal(summary.readable, true)
  assert.ok(summary.cartCount >= 1)
  assert.ok(summary.soonest !== null, 'no deadline tile could be painted from the example queue')
  assert.ok(Number.isSafeInteger(summary.totalCents) && summary.totalCents > 0)
})

/* ---------- the view’s wiring, which cannot be executed here ---------- */

test('the view derives its face from the one module and stamps it, the metrics way', () => {
  assert.match(VIEW, /from '\.\/approvals-example\.js'/, 'src/ledger-prompt-queue.js does not import the example module')
  assert.match(VIEW, /approvalsFace\(/, 'the view never asks which face it is showing')
  assert.match(VIEW, /dataset\.face = face/, 'the view does not stamp data-face the way metrics does')
})

test('the demonstration face never touches the bridge, the stores, or the theme call', () => {
  assert.ok(VIEW.includes('function paintExample'), 'there is no paintExample')
  const mount = VIEW.slice(VIEW.lastIndexOf('themeObserver.observe'))
  assert.match(mount, /face === 'demonstration'\s*\)\s*\{?\s*paintExample\(\)/, 'the demonstration face does not paint the example')
  assert.match(mount, /else\s*\{[\s\S]*?void poll\(\)[\s\S]*?setInterval/, 'the live face no longer polls')
  const example = VIEW.slice(VIEW.indexOf('function paintExample'), VIEW.indexOf('async function poll'))
  for (const forbidden of ['ownerPromptSnapshot', 'markOwnerPromptPresented', 'decideOwnerPrompt', 'recordCartReading', 'recordUndeliveredDecision', 'applyOwnerPopupTheme']) {
    assert.ok(!example.includes(forbidden), `the example painter reaches ${forbidden}, which files or fetches real state`)
  }
})

test('the marking is painted visibly: badge, source line, and disabled example cards', () => {
  assert.match(VIEW, /data-approvals-badge/, 'no badge element exists for the marking')
  assert.match(VIEW, /data-approvals-source/, 'no source line element exists')
  assert.match(VIEW, /APPROVALS_EXAMPLE_MARKING\.badge/, 'the badge does not carry the shared words')
  assert.match(VIEW, /APPROVALS_EXAMPLE_MARKING\.source/, 'the source line does not carry the shared words')
  const example = VIEW.slice(VIEW.indexOf('function paintExample'), VIEW.indexOf('async function poll'))
  assert.match(example, /surface: 'screen'/, 'example cards are not rendered through the one card renderer')
  assert.match(example, /APPROVALS_EXAMPLE_MARKING\.cardStatus/, 'example cards do not say they are examples')
})
