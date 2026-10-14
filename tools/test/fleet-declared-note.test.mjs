/* A PANEL THAT COUNTED TEN AGENTS AND DENIED A HOST IN THE SAME VIEW.
 *
 * Owner-visible defect, quoted from their own capture: the fleet overview read
 * "Trees 3 / Agents in trees 10 / Working 4 / Needs review 3" and then, a few
 * lines below, "Check the fleet connection / No local agent fleet host detected
 * on this machine."
 *
 * NEITHER HALF WAS A LIE, which is why it survived. src/views/computers.js
 * reads the fleet projection; when that read fails it falls back to
 * declaredFleetData(), and carries the failure's reason into the panel as
 * declaredOnlyReason. The counts come from the fallback, which is built from
 * this machine's own org record. So the numbers were real and local, and the
 * sentence was about a fleet-wide report that was genuinely absent.
 *
 * THE HEADING WAS THE DEFECT. "Check the fleet connection" names an action
 * that does not exist -- there is no setting that connects a fleet host and no
 * command that installs one -- so a reader goes looking for one and finds
 * nothing. The heading now describes what the panel is showing.
 *
 * WHAT THIS PINS, and why the third one is the load-bearing check: the copy
 * asserts the counts are THIS COMPUTER'S, and that is only true because
 * declaredFleetData() returns exactly one computer. If that shape ever changes,
 * the sentence becomes the new false statement, so it is asserted here by
 * calling the function rather than by trusting the comment beside it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { FLEET_DECLARED_NOTE } from '../../src/fleet-tree-copy.js'
import { declaredFleetData } from '../../src/declared-fleet.js'

const note = () => `${FLEET_DECLARED_NOTE.title} ${FLEET_DECLARED_NOTE.body}`

test('the declared-state note does not send the reader after a connection that does not exist', () => {
  assert.doesNotMatch(note(), /check the [a-z ]*connection/i,
    'there is no setting that connects a fleet host and no command that installs one, so a heading telling somebody to check one sends them hunting')
  assert.doesNotMatch(FLEET_DECLARED_NOTE.title, /\bconnect(ion)?\b/i)
})

test('the note explains why real counts sit beside an absent host', () => {
  /* The contradiction the owner saw was numbers next to a denial with nothing
     reconciling them. The note has to do that reconciling, in words. */
  assert.match(note(), /this computer/i, 'the note must say whose the counts are')
  assert.match(note(), /fleet host/i, 'the note must name what is absent')
  assert.ok(FLEET_DECLARED_NOTE.title.trim().length > 0 && FLEET_DECLARED_NOTE.body.trim().length > 0)
})

test('declaredFleetData really returns one computer, which is what makes that sentence true', () => {
  const org = {
    agents: [
      { id: 'a1', name: 'One', role: 'manager' },
      { id: 'a2', name: 'Two', role: 'worker' },
    ],
    relationships: [{ type: 'manages', from: 'a1', to: 'a2' }],
  }
  const data = declaredFleetData(org)
  assert.ok(data, 'a declared org with agents must project')
  assert.ok(Array.isArray(data.computers))
  assert.equal(data.computers.length, 1,
    'the note says "these counts are this computer only"; if the declared projection ever covers more than one computer that sentence is the next false statement on this panel')
})

test('an org with no declared agents projects nothing, so the note cannot appear over an empty panel', () => {
  assert.equal(declaredFleetData({ agents: [] }), null)
  assert.equal(declaredFleetData(null), null)
})
