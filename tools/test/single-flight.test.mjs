/* ONE RESUME PER NODE, PROVEN BY RUNNING IT RATHER THAN BY READING IT.
 *
 * THE DEFECT this guards, measured in src/views/computers.js: resumeNodeSession
 * had no in-flight guard, and the only thing gating its palette row was
 * nodeBusy() -- which reads the node's STATUS, and a dead node's status stays
 * 'finished'/'failed' for the whole resume, until the new session opens. So the
 * Resume row stayed enabled through the entire window. Press it, reopen the
 * palette, press it again, and two bridge.start calls ran: both sessions
 * registered against the same node, the later one won node.sessionId, and the
 * earlier kept running -- and spending -- while Stop and Interrupt both
 * addressed the winner. Nothing on screen could reach it; it ended when the app
 * did.
 *
 * Its two siblings in the same file (startingNodeIds, recoveringNodes) already
 * had the guard, hand-rolled; the resume path simply never got one. That is the
 * argument for one tested helper rather than a fourth Set: the shape is three
 * lines and the mistake is never in the lines, it is in omitting them.
 *
 * These tests drive createSingleFlight directly, with real overlapping async
 * work, because the view's own copy is closure-private inside a 9,000-line
 * module -- which is exactly why the previous resume test could only pin
 * wiring at the source level and said so.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createSingleFlight } from '../../src/single-flight.js'

/** A promise plus its resolver, so a test can hold work open across an await. */
function deferred () {
  let settle
  const promise = new Promise((resolve) => { settle = resolve })
  return { promise, settle }
}

test('a second run for the same key is refused while the first is in flight', async () => {
  const flight = createSingleFlight()
  const first = deferred()
  let runs = 0

  const a = flight.run('node-1', async () => { runs += 1; await first.promise; return 'A' })
  /* The bad value this catches: the pre-fix behaviour, where the second press
     ran its own bridge.start. If the guard is absent this reads runs === 2. */
  const b = await flight.run('node-1', async () => { runs += 1; return 'B' })

  assert.equal(b.ran, false, 'the second press ran a second time -- two agents would now be live on one node')
  assert.equal(runs, 1, 'the guarded work executed twice')
  assert.equal(flight.busy('node-1'), true, 'the slot is not held while the first run is still going')

  first.settle()
  const settled = await a
  assert.deepEqual(settled, { ran: true, value: 'A' }, 'the first run must still deliver its own result')
  assert.equal(flight.busy('node-1'), false, 'the slot was never released')
})

test('the refusal is distinguishable from work that ran and returned false', async () => {
  const flight = createSingleFlight()
  /* resumeNodeSession returns false on its own honest refusals (no bridge, the
     start control off). A caller that could not tell those from "did not run"
     would report a correct refusal as a failure. */
  const ranAndFailed = await flight.run('node-1', async () => false)
  assert.deepEqual(ranAndFailed, { ran: true, value: false })

  const held = deferred()
  const busy = flight.run('node-1', async () => { await held.promise; return true })
  const refused = await flight.run('node-1', async () => true)
  assert.equal(refused.ran, false)
  assert.equal('value' in refused, false, 'a refusal must carry no value to be mistaken for a result')
  held.settle()
  await busy
})

test('the slot is released when the work throws, not held forever', async () => {
  const flight = createSingleFlight()
  await assert.rejects(flight.run('node-1', async () => { throw new Error('start refused by the engine') }))
  assert.equal(flight.busy('node-1'), false, 'a throw left the node permanently un-resumable')

  /* And the next press works: a transient guard that becomes permanent is the
     failure mode a hand-written finally forgets. */
  const after = await flight.run('node-1', async () => 'recovered')
  assert.deepEqual(after, { ran: true, value: 'recovered' })
})

test('different keys do not block each other', async () => {
  const flight = createSingleFlight()
  const held = deferred()
  const one = flight.run('node-1', async () => { await held.promise; return 1 })
  const two = await flight.run('node-2', async () => 2)
  assert.deepEqual(two, { ran: true, value: 2 }, 'resuming one node refused a resume on another')
  held.settle()
  await one
})

test('an unidentifiable subject is never collapsed onto one shared slot', async () => {
  const flight = createSingleFlight()
  const held = deferred()
  /* A node with no id cannot be told apart from another node with no id.
     Guarding them together would refuse unrelated work; both must run. */
  const first = flight.run(null, async () => { await held.promise; return 'first' })
  const second = await flight.run(null, async () => 'second')
  assert.deepEqual(second, { ran: true, value: 'second' })
  held.settle()
  assert.deepEqual(await first, { ran: true, value: 'first' })
})

test('the view routes its resume through this helper rather than a fourth hand-rolled Set', async () => {
  const { readFileSync } = await import('node:fs')
  const { dirname, join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const view = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'views', 'computers.js'), 'utf8')

  assert.match(view, /import \{ createSingleFlight \} from '\.\.\/single-flight\.js'/,
    'the view no longer imports the guard; the resume path may be unguarded again')
  const resume = view.slice(view.indexOf('async function resumeNodeSession'))
  const guarded = resume.slice(0, resume.indexOf('async function resumeNodeSessionUnguarded'))
  /* nodeReplacementFlight, not a private resumeFlight of its own: it is the
     SAME lock freshStartExistingNode holds, so a resume and a "start over" on
     the same node refuse each other too, not only a doubled press of either
     one alone -- see tools/test/node-session-start-shared-lock.test.mjs. */
  assert.match(guarded, /nodeReplacementFlight\.run\(/, 'resumeNodeSession stopped running through the single-flight guard')
  assert.match(guarded, /RESUME_PANEL\.underway/,
    'the refusal no longer says anything -- a second press would look like nothing happened')
})
