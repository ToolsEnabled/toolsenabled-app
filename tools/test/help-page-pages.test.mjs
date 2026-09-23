import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseRoute } from '../../src/route-parse.js'
import { START_PANEL, RESUME_PANEL } from '../../src/fleet-tree-copy.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const help = readFileSync(path.join(root, 'public/help/getting-started.html'), 'utf8')
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
  assert.match(text, /composers?['’]?s? Stop control interrupts the running turn and keeps the session open/i)
  assert.match(text, /Stop this agent closes the session and drops queued messages/)
})

test('guide states actual permission and persistence limits rather than promising isolation or purchases', () => {
  assert.match(text, /Guided requests read-only work/)
  assert.match(text, /Files elsewhere.*may still be readable/)
  assert.doesNotMatch(text, /cannot (?:read|reach) anything (?:outside|else)/i)
  assert.match(text, /Confirm and save my decision saves a local note.*does not charge a card, place an order or contact a vendor/)
  assert.match(text, /Review pending edits, then Save settings or Discard/)
  assert.match(text, /Changes affect assistants started afterwards; running sessions keep their existing tools/)
})
