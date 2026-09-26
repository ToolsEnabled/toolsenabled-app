import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseRoute } from '../../src/route-parse.js'
import { START_PANEL, RESUME_PANEL } from '../../src/fleet-tree-copy.js'
import { CHIP_HALT_LABEL, QUEUE_SEND_NOW, QUEUE_SEND_NEXT, QUEUE_UNQUEUE } from '../../src/chat-copy.js'
import { AUTONOMY_CHOICES } from '../../src/setup-profile.js'
import { TIER_CHOICES, DEFAULT_TIER } from '../../src/setup-state.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const help = readFileSync(path.join(root, 'public/help/getting-started.html'), 'utf8')
const setupView = readFileSync(path.join(root, 'src/views/setup.js'), 'utf8')
const text = help.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ')

test('guide covers every first-class page', () => {
  for (const label of ['Home', 'Computers', 'Metrics', 'Research', 'Comms', 'Ledger', 'Checkout', 'Settings', 'Tools', 'Setup', 'Account', 'Subscription information']) {
    assert.match(text, new RegExp(`\\b${label}\\b`), `missing page label: ${label}`)
  }
  for (const route of ['#/computers', '#/research', '#/ledger?tab=t']) assert.ok(help.includes(route), `missing route example ${route}`)
})

test('guide documents all four destructive Ledger resets and their warnings', () => {
  for (const label of ['Tasks (T)', 'Rules (R)', 'Asks (A)', 'Purchases (P)', 'Reset', 'warning']) {
    assert.match(text, new RegExp(label.replace(/[()]/g, '\\$&'), 'i'), `missing Ledger detail: ${label}`)
  }
})

test('guide preserves the roleless start, cloud confirmation and honest unknown outcomes', () => {
  assert.match(text, /role is optional/i)
  assert.match(text, /blank role is valid/i)
  assert.match(text, /Codex Cloud/i)
  assert.match(text, /cannot be cancelled after acceptance/i)
  assert.match(text, /unknown.*not converted to idle, closed or done/i)
})

test('guide gives real-input and lag diagnostics without recommending DOM shortcuts', () => {
  assert.match(text, /real pointer and keyboard events/i)
  assert.match(text, /do not assign .value or call a hidden .click/i)
  assert.match(text, /page, control, exact sentence, elapsed time/i)
})


test('each routed page has its own guide row, including pages outside the arrow loop', () => {
  const router = readFileSync(path.join(root, 'src/route-parse.js'), 'utf8')
  const routeNames = [...new Set([...router.matchAll(/name: '([a-z]+)'/g)].map(match => match[1]))].sort()
  const rows = [...help.matchAll(/<tr data-guide-route="([a-z]+)">([\s\S]*?)<\/tr>/g)]
  assert.deepEqual(rows.map(match => match[1]).sort(), routeNames, 'an added or removed route needs its own guide review')
  for (const [, name, row] of rows) {
    assert.equal(parseRoute(`#/${name}`).name, name)
    assert.equal((row.match(/<td>/g) || []).length, 3, `${name} needs purpose and usable controls`)
  }
  assert.equal(parseRoute('#/guide').name, 'settings')
  assert.match(text, /#\/guide.*opens the in-app guide within Settings/)
})

test('guide names the real start and resume controls and distinguishes turn from session stops', () => {
  for (const label of [START_PANEL.rolePrompt, START_PANEL.submitSet, START_PANEL.submitStart, RESUME_PANEL.action]) {
    assert.ok(text.includes(label), `guide has lost a current control label: ${label}`)
  }
  assert.match(text, /Set this agent saves an unstarted draft/)
  /* THE LABEL, NOT A PARAPHRASE OF IT. This line used to assert the sentence
     "the composer's Stop control interrupts the running turn", which was prose
     no component owns: the composer draws CHIP_HALT_LABEL ("Halt") and there
     has never been a composer control whose visible word is "Stop". A reader
     who went looking for Stop found "Stop this agent", one line below, which
     closes the session and drops the queue -- the opposite of what they
     wanted. Assert the constants the composer actually renders, so the next
     rename fails here instead of on a customer. */
  for (const label of [CHIP_HALT_LABEL, QUEUE_SEND_NOW, QUEUE_SEND_NEXT, QUEUE_UNQUEUE]) {
    assert.ok(text.includes(label), `guide does not name the composer control "${label}"`)
  }
  assert.doesNotMatch(text, /composers?['’]?s? Stop control/i)
  assert.match(text, /Send does not interrupt/i)
  assert.match(text, /Stop this agent[\s\S]{0,40}closes the session and drops queued messages/)
})

test('guide states actual permission and persistence limits rather than promising isolation or purchases', () => {
  assert.match(text, /Guided requests read-only work/)
  assert.match(text, /Files elsewhere.*may still be readable/)
  assert.doesNotMatch(text, /cannot (?:read|reach) anything (?:outside|else)/i)
  assert.match(text, /Confirm and save my decision saves a local note.*does not charge a card, place an order or contact a vendor/)
  assert.match(text, /Review pending edits, then Save settings or Discard/)
  assert.match(text, /Changes affect assistants started afterwards; running sessions keep their existing tools/)
})


/* THE SETUP WALKTHROUGH NAMES BUTTONS THE SETUP SCREENS DRAW, AND THE ANSWER
 * THEY ACTUALLY LAND ON.
 *
 * Measured on the installed 1.0.46 Linux build, 2026-09-24, walking a fresh
 * profile: question 3's forward button reads "Continue" (data-setup-next=
 * "review"). The page claimed it "is not called Continue -- it says See what
 * that sets", a string that appears nowhere in src/ or in the shipped bundle.
 * The same walk showed "Act on its own" carrying the Recommended note with
 * aria-pressed="true", while the page said "Act when I start it" was the
 * recommended one. Both drifts pointed the same way: the only document written
 * for a stranger promised a more cautious machine than the defaults build.
 *
 * Derived from the product's own constants rather than restated, so the next
 * change to a label or a default fails here.
 */
test('the setup walkthrough names real buttons and the answers the defaults land on', () => {
  const clicks = text.match(/takes five clicks from the first question to a working first page: ([^.]+)\./)
  assert.ok(clicks, 'the five-click summary is missing')
  const labels = clicks[1].split(',').map(part => part.trim()).filter(Boolean)
  assert.equal(labels.length, 5, 'five clicks means five named buttons')
  for (const label of labels) {
    assert.ok(setupView.includes(label), `setup draws no button called "${label}"`)
  }

  const recommendedAutonomy = AUTONOMY_CHOICES.find(choice => choice.note === 'Recommended')
  assert.ok(recommendedAutonomy, 'one autonomy answer carries the Recommended note')
  assert.match(text, new RegExp(`${recommendedAutonomy.label}\\.? Marked Recommended`),
    `the guide must say which autonomy answer is recommended: ${recommendedAutonomy.label}`)

  const defaultTier = TIER_CHOICES.find(choice => choice.tier === DEFAULT_TIER)
  assert.ok(defaultTier, 'the default tier is one of the offered choices')
  assert.ok(text.includes(defaultTier.label),
    `the guide must name the pre-selected permission level: ${defaultTier.label}`)
  assert.doesNotMatch(text, /you get the most cautious of the three/i)

  // Question 1 carries a skip of its own (data-setup-skip-first).
  assert.ok(setupView.includes('data-setup-skip-first'), 'question 1 still has its own skip')
  assert.doesNotMatch(text, /there is no Skip here/i)
})
