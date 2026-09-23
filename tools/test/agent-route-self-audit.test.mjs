/* THE GUARD ON THE GUARD.
 *
 * tools/agent-route-reachability.mjs earns the word "reachability" by refusing
 * to navigate with `location.hash = ...` -- it clicks, the way a person does --
 * and it enforces that against its OWN SOURCE so the instrument cannot quietly
 * start cheating. That self-audit is therefore load-bearing, and it was just
 * changed, which is exactly when a guard silently stops guarding.
 *
 * The change: the old predicate was /location\.hash\s*=/ and could not tell
 * ASSIGNMENT (navigation, banned) from COMPARISON (observation, required). It
 * fired on `location.hash === '#/setup'`, so the suite could not check where it
 * had arrived. The new predicate excludes `==`/`===`/`!==` and still catches
 * `=` and `+=`.
 *
 * A narrowed guard is indistinguishable from a broken one unless you feed it
 * the thing it exists to catch, so this feeds it both forms and pins BOTH
 * verdicts. If someone widens the exclusion until real navigation slips past,
 * the first two cases here go red.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { offendingHashAssignments } from '../agent-route-reachability.mjs'

const HARNESS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'agent-route-reachability.mjs')

/* ---------- it still catches what it exists to catch ---------- */

test('a bare hash assignment is caught', () => {
  const found = offendingHashAssignments(`  location.hash = '#/agent/c1/codex'\n`)
  assert.equal(found.length, 1, 'plain assignment must be reported')
})

test('a spaced-out hash assignment is caught', () => {
  assert.equal(offendingHashAssignments(`location.hash   =   "#/x"\n`).length, 1)
})

test('an appending hash assignment is caught, because it navigates too', () => {
  assert.equal(offendingHashAssignments(`location.hash += '/more'\n`).length, 1)
})

test('an assignment inside a template expression is caught', () => {
  assert.equal(offendingHashAssignments('await evaluate(`location.hash = "#/nope"`)\n').length, 1)
})

/* ---------- and it no longer fires on reading where you are ---------- */

test('strict comparison is not navigation', () => {
  assert.equal(offendingHashAssignments(`if (location.hash === '#/setup') return true\n`).length, 0)
})

test('loose comparison is not navigation', () => {
  assert.equal(offendingHashAssignments(`location.hash == '#/setup'\n`).length, 0)
})

test('negated comparison is not navigation', () => {
  assert.equal(offendingHashAssignments(`location.hash !== '#/setup'\n`).length, 0)
})

/* ---------- the exemptions the rule always had ---------- */

test('the tagged deep-link state check is exempt, and only when tagged', () => {
  const tagged = `await evaluate(\`location.hash = '#/agent/nobody/nobody'\`) // DEEP-LINK-STATE-CHECK\n`
  assert.equal(offendingHashAssignments(tagged).length, 0, 'the tagged line is the one permitted deep link')
  assert.equal(
    offendingHashAssignments(tagged.replace(' // DEEP-LINK-STATE-CHECK', '')).length,
    1,
    'remove the tag and the very same line must be reported',
  )
})

test('prose about the rule is not a breach of the rule', () => {
  assert.equal(offendingHashAssignments(`  // it never does location.hash = something\n`).length, 0)
  assert.equal(offendingHashAssignments(`   * and assigning location.hash = x would be cheating\n`).length, 0)
})

/* ---------- and the real file passes its own rule ----------
 * Not a restatement of the harness's own startup check: this one runs in the
 * ordinary test battery, where a regression is seen without anyone launching
 * a packaged Electron build. */

test('the shipped harness assigns location.hash nowhere but the tagged state check', () => {
  const offenders = offendingHashAssignments(readFileSync(HARNESS, 'utf8'))
  assert.deepEqual(
    offenders.map(entry => `${entry.at}: ${entry.line.trim()}`),
    [],
    'the reachability suite must reach every page by clicking',
  )
})

/* ---------- the vacuity guard ----------
 * If the harness ever stops mentioning location.hash at all, every test above
 * still passes while checking nothing about the real file. */

test('the harness really does contain the deep-link state check this guards', () => {
  const source = readFileSync(HARNESS, 'utf8')
  assert.match(source, /DEEP-LINK-STATE-CHECK/, 'the marker must still exist to be exempted')
  assert.ok(
    source.split('\n').some(line => /location\.hash\s*=(?!=)/.test(line) && line.includes('DEEP-LINK-STATE-CHECK')),
    'there must still be exactly the one tagged assignment, or this suite is guarding nothing',
  )
})
